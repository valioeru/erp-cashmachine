"use strict";
// Rezervările agenților pe stocul din CT-Park.
//
// CE A CERUT VALI, 09.11.2026:
//   „La fiecare produs agenții să poată rezerva pentru 3 zile un anume produs,
//    obligatoriu cu nume client pe el, cantitate etc. Să nu poată rezerva
//    pentru clienții cu facturi restante. Statusul se schimbă corespunzător:
//    rezervat de agentul Y pentru clientul X. Iar dacă nu se pune comanda pe
//    acel produs, se eliberează automat după cele 3 zile. De asemenea doar
//    admin-ul sau un agent poate debloca rezervarea și înainte de cele 3 zile,
//    cu completarea unui motiv ce se va putea vedea ulterior în produse
//    rezervate și nefructificate în comenzi."
//
// CUM SE CITEȘTE, CONCRET:
//   • rezervă agenții de vânzări și administratorii; clientul și cantitatea sunt
//     obligatorii, cantitatea cel mult cât e liber acum (lib/stoc-produse.js);
//   • clientul cu facturi trecute de scadență nu primește rezervare — aceeași
//     regulă de „întârziere" ca mențiunea de pe comandă (modules/scadente.js);
//   • rezervarea ține 72 de ore de la creare;
//   • se FRUCTIFICĂ singură când apare o comandă a aceluiași client cu același
//     produs, pusă după rezervare. „După" se citește pe numărul comenzii, nu pe
//     dată: comenzile se nasc din cinci locuri (comandă nouă, ofertă, contract,
//     calculator, comanda zilei Sameday), unele cu dată și oră, altele doar cu
//     ziua, iar id-ul crește la fel peste tot. La rezervare se ține minte cea
//     mai mare comandă din bază; orice comandă cu id mai mare e „după";
//   • nefructificată după 72 de ore → expiră singură, iar marfa se eliberează;
//   • înainte de termen o eliberează doar agentul care a făcut-o sau un
//     administrator — „un agent" e citit „agentul ei": dacă orice agent ar
//     putea elibera rezervarea altuia, rezervarea n-ar ține nimic;
//   • eliberarea cere motiv, iar motivul rămâne în raportul „Nefructificate".
//
// Nimic nu rulează pe ceas: starea se pune la zi (`actualizeaza`) de fiecare
// dată când cineva se uită la stoc sau la rezervări. O rezervare expirată la
// 03:00 se vede expirată la prima deschidere de după, adică exact când contează.
//
// Orele se scriu în ora României, „AAAA-LL-ZZ HH:MM:SS", ca să se poată
// compara ca text și să se citească direct pe ecran.

const db = require("./db");
const SP = require("./stoc-produse");
const { numarDinCamp } = require("./comenzi-furnizor-logica");

const ZILE = 3;
const ORE = ZILE * 24;
const ROLURI = ["admin", "vanzari"];

const STARI = {
  activa: "activă",
  fructificata: "fructificată — s-a pus comanda",
  expirata: "expirată — 3 zile fără comandă",
  eliberata: "eliberată înainte de termen",
  anulata: "retrasă de ERP — depășea stocul liber",
};

function oraRo(t) {
  const d = t instanceof Date ? t : new Date();
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).replace("T", " ").slice(0, 19);
}
const acum = () => oraRo(new Date());
const peste = (ore) => oraRo(new Date(Date.now() + ore * 3600 * 1000));

function poateRezerva(u) {
  return Boolean(u && ROLURI.includes(String(u.rol || "")));
}

function poateElibera(u, r) {
  if (!u || !r) return false;
  if (String(u.rol || "") === "admin") return true;
  return Number(r.utilizator_id) > 0 && Number(r.utilizator_id) === Number(u.id);
}

const cant = (v) => (Number(v) || 0).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
const dataOra = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : String(v || "");
};

// Comenzile care contează pentru fructificare: ale aceluiași client, cu
// produsul pe ele, puse după rezervare, neanulate. Ciorna (comanda citită
// dintr-un email, nevalidată) nu e încă o comandă.
const COMANDA_FRUCTIFICA = `FROM comenzi c JOIN comenzi_linii l ON l.comanda_id = c.id
   WHERE c.id > r.comanda_maxima AND c.partener_id = r.partener_id AND l.produs_id = r.produs_id
     AND c.status NOT IN ('anulata', 'ciorna')`;

async function actualizeaza() {
  const t = acum();
  await db
    .prepare(
      `UPDATE rezervari_agenti r
          SET stare = 'fructificata', comanda_id = (SELECT MIN(c.id) ${COMANDA_FRUCTIFICA}), inchisa_la = ?
        WHERE r.stare = 'activa' AND EXISTS (SELECT 1 ${COMANDA_FRUCTIFICA})`
    )
    .run(t);
  await db
    .prepare("UPDATE rezervari_agenti SET stare = 'expirata', inchisa_la = expira_la WHERE stare = 'activa' AND expira_la <= ?")
    .run(t);
}

async function rezerva(b, user) {
  const v = b || {};
  if (!poateRezerva(user)) return { eroare: "Rezervările le fac agenții de vânzări și administratorii." };
  const produsId = Number(v.produs_id) || 0;
  const partenerId = Number(v.partener_id) || 0;
  if (!produsId) return { eroare: "Alege produsul pe care îl rezervi." };
  if (!partenerId) return { eroare: "Alege clientul din listă: rezervarea se face obligatoriu pe numele unui client." };
  const c = numarDinCamp(v.cantitate, 3);
  if (!c.ok || !(c.valoare > 0)) return { eroare: "Scrie cantitatea de rezervat: un număr mai mare ca zero (cu virgulă sau punct)." };

  const produs = await db.prepare("SELECT id, denumire FROM produse WHERE id = ?").get(produsId);
  if (!produs) return { eroare: "Produsul nu mai există în nomenclator." };
  const client = await db.prepare("SELECT id, nume, tip FROM parteneri WHERE id = ?").get(partenerId);
  if (!client || String(client.tip || "") === "furnizor") return { eroare: "Clientul ales nu e în lista de clienți." };

  // Facturi trecute de scadență → nu. Aceeași socoteală ca mențiunea de pe
  // comandă; dacă scadențarul nu se poate citi, nu se rezervă pe ghicite.
  let mentiune = null;
  try {
    const S = require("../modules/scadente");
    mentiune = S.mentiuneIntarziere(await S.stareClient(partenerId));
  } catch (e) {
    return { eroare: "Nu am putut verifica facturile clientului. Încearcă din nou peste un minut." };
  }
  if (mentiune) {
    return {
      eroare: `Nu se poate rezerva pentru ${client.nume}: are facturi restante. ${mentiune.replace(/^Clientul are întârzieri la plată: /, "")} Rezervarea se poate face după ce le plătește.`,
      restanta: true,
    };
  }

  await actualizeaza();
  const gaseste = async () => (await SP.citeste({ vedeTot: false })).find((r) => r.produs_id === produsId) || null;
  const r = await gaseste();
  const liber = r ? r.disponibil : 0;
  const um = (r && r.um) || "";
  if (c.valoare > liber + SP.EPS) {
    return {
      eroare:
        liber > SP.EPS
          ? `Se pot rezerva cel mult ${cant(liber)} ${um} din ${produs.denumire} — atât e liber acum.`
          : `Din ${produs.denumire} nu e nimic liber de rezervat acum.`,
    };
  }

  const maxim = await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM comenzi").get();
  const creata = acum();
  const expira = peste(ORE);
  const obs = String(v.observatii || "").trim().slice(0, 300) || null;
  const ins = await db
    .prepare(
      `INSERT INTO rezervari_agenti (produs_id, partener_id, cantitate, um, observatii, utilizator_id, utilizator_nume,
                                     creata_la, expira_la, comanda_maxima, stare)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa') RETURNING id`
    )
    .run(produsId, partenerId, c.valoare, um || null, obs, Number(user.id) || null, user.nume || null, creata, expira, Number((maxim && maxim.m) || 0));
  const id = Number(ins && ins.lastInsertRowid);

  // Doi agenți pe ultimele bucăți, în aceeași secundă: amândoi au văzut marfa
  // liberă. Se verifică după scriere; cine a depășit stocul își retrage
  // rezervarea și află de ce.
  const dupa = await gaseste();
  if (dupa && dupa.depasit > SP.EPS) {
    await db.prepare("UPDATE rezervari_agenti SET stare = 'anulata', inchisa_la = ?, motiv = ? WHERE id = ?").run(acum(), "depășea stocul liber (rezervare simultană)", id);
    return { eroare: "Între timp altcineva a rezervat din același produs și nu mai ajunge cantitatea. Uită-te din nou la cât e liber." };
  }
  return {
    ok: true,
    id,
    mesaj: `Rezervat ${cant(c.valoare)} ${um} din ${produs.denumire} pentru ${client.nume}, până la ${dataOra(expira)}.`,
  };
}

async function elibereaza(id, motiv, user) {
  await actualizeaza();
  const r = await db.prepare("SELECT * FROM rezervari_agenti WHERE id = ?").get(Number(id) || 0);
  if (!r) return { eroare: "Rezervarea nu există." };
  if (String(r.stare) !== "activa") return { eroare: `Rezervarea nu mai e activă: ${STARI[r.stare] || r.stare}.` };
  if (!poateElibera(user, r)) return { eroare: "O rezervare o poate elibera înainte de termen doar agentul care a făcut-o sau un administrator." };
  const m = String(motiv || "").trim();
  if (m.length < 3) return { eroare: "Scrie motivul eliberării: rămâne în raportul rezervărilor nefructificate." };
  await db
    .prepare("UPDATE rezervari_agenti SET stare = 'eliberata', inchisa_la = ?, inchisa_de = ?, motiv = ? WHERE id = ? AND stare = 'activa'")
    .run(acum(), (user && user.nume) || null, m.slice(0, 500), Number(r.id));
  return { ok: true, mesaj: "Rezervarea a fost eliberată; marfa e din nou liberă." };
}

const FILTRE = {
  active: "r.stare = 'activa'",
  nefructificate: "r.stare IN ('expirata', 'eliberata')",
  fructificate: "r.stare = 'fructificata'",
  toate: "r.stare <> 'anulata'",
};

async function lista(filtru) {
  await actualizeaza();
  const unde = FILTRE[filtru] || FILTRE.active;
  const randuri = await db
    .prepare(
      `SELECT r.*, p.denumire AS produs, COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS cod,
              pa.nume AS client, COALESCE(u.nume, r.utilizator_nume) AS agent, c.numar AS comanda_numar
         FROM rezervari_agenti r
         LEFT JOIN produse p ON p.id = r.produs_id
         LEFT JOIN parteneri pa ON pa.id = r.partener_id
         LEFT JOIN utilizatori u ON u.id = r.utilizator_id
         LEFT JOIN comenzi c ON c.id = r.comanda_id
        WHERE ${unde}
        ORDER BY r.id DESC`
    )
    .all();
  const numar = await db
    .prepare("SELECT stare, COUNT(*) AS n FROM rezervari_agenti GROUP BY stare")
    .all();
  const cate = { active: 0, nefructificate: 0, fructificate: 0, toate: 0 };
  for (const x of numar) {
    const n = Number(x.n) || 0;
    if (x.stare === "activa") cate.active += n;
    if (x.stare === "expirata" || x.stare === "eliberata") cate.nefructificate += n;
    if (x.stare === "fructificata") cate.fructificate += n;
    if (x.stare !== "anulata") cate.toate += n;
  }
  return { randuri, cate };
}

module.exports = { ZILE, ORE, STARI, FILTRE, oraRo, acum, peste, poateRezerva, poateElibera, actualizeaza, rezerva, elibereaza, lista, dataOra };
