"use strict";
// Drumul comenzii de vânzare, mutat de ce se întâmplă în producție, în
// depozit și pe drum.
//
// CEREREA LUI VALI, 05.11.2026:
//   „Când schimbăm status în finalizată, comanda să se schimbe automat peste
//    tot în ERP. Adică în comenzi să apară producție finalizată, la depozit să
//    apară de preluat în depozit, când apare în depozit să apară în comenzi în
//    depozit, apoi când din depozit e gata de livrare etc. Adică un flux
//    complet frumos."
//
// DE CE UN FIȘIER, ȘI DE CE AICI. Starea comenzii o mută patru birouri, din
// cinci pagini: lista de producție, fișa comenzii de producție, alocarea pe
// utilaje, recepția din depozit și cursa de transport. Până acum regula stătea
// într-un singur loc — fișa de producție — iar lista, din care se lucrează de
// fapt, schimba doar producția: Mihai punea „Finalizată", agentul vedea tot
// „în producție", iar depozitul nu afla nimic. Cinci copii ale aceleiași
// reguli ar fi ajuns să spună cinci lucruri diferite. Aici e una singură.
//
// DRUMUL (lib/comenzi-stari.js, FLUX):
//   nouă → confirmată → (așteaptă marfă) → în producție → producție finalizată
//   → în stoc depozit → gata de livrare → facturată → în livrare → livrată
//
// CINE MUTĂ CE:
//   • producția: „în producție" și „producție finalizată" — ultima abia când
//     TOATE comenzile de producție ale comenzii sunt gata. O comandă cu două
//     produse, din care unul încă se face, n-are ce căuta la facturare.
//   • depozitul: „în stoc depozit" când marfa a intrat și acoperă comanda,
//     „gata de livrare" când a pregătit-o.
//   • facturarea: „facturată" (modules/facturi.js, modules/comenzi.js).
//   • logistica: „în livrare" când pleacă mașina, „livrată" când a ajuns.
//
// CE NU SE FACE NICIODATĂ AUTOMAT:
//   • înapoi peste o stare pe care a pus-o alt birou. Dacă depozitul a primit
//     marfa, o răzgândire a producției nu mai scoate comanda din depozit.
//   • anularea comenzii clientului. O comandă de producție anulată pune
//     comanda pe „așteaptă marfă", iar depozitul vede cererea refuzată și
//     decide. Clientul îl pierde un om, cu motivul scris, nu un clic din altă
//     pagină.
//
// Fiecare mutare automată se scrie în istoricul clientului (interactiuni),
// ca agentul să afle fără să sune pe nimeni.
const db = require("./db");
const STARI = require("./comenzi-stari");
const livrare = require("./livrare-partiala");

// Stările comenzii de vânzare pe care le poate muta producția. De la „în stoc
// depozit" încolo marfa e a depozitului, iar producția nu mai are ce schimba.
const ZONA_PRODUCTIE = ["noua", "confirmata", "asteapta_marfa", "in_productie", "productie_finalizata"];
// Stările comenzii de producție care înseamnă „marfa e făcută".
const PRODUCTIE_GATA = ["finalizata", "facturata"];
const PRODUCTIE_IN_LUCRU = ["noua", "in_productie"];

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
const textStare = (s) => (STARI.TEXTE[s] || String(s || "").replace(/_/g, " "));
const numarComanda = (c) => (c && c.numar) || "#" + (c && c.id);

// A ajuns marfa unei comenzi de producție terminate în depozit? Da, dacă
// recepția ei e finalizată, sau — fără recepție — dacă cererea depozitului a
// intrat în stoc pe „Intră în stoc". Altfel stă încă la producție.
//
// Cu finalizări parțiale, comanda are mai multe recepții: cât timp una din ele
// e încă de preluat (`receptii_deschise`), marfa nu e toată în depozit.
function marfaNepreluata(p) {
  if (Number(p.receptii_deschise) > 0) return true;
  if (p.receptie_id) return ["asteptata", "in_lucru"].includes(String(p.receptie_stare || ""));
  // Totul a plecat pe recepții parțiale, toate preluate: nu mai e nimic la producție.
  if (Number(p.receptii_preluate) > 0) return false;
  return String(p.cerere_stare || "") !== "primita";
}

// Starea pe care o spun comenzile de producție ale unei comenzi de vânzare.
// Rândurile: { status, receptie_id, receptie_stare, cerere_stare } (un șir
// simplu = doar starea, cu marfa socotită nepreluată).
//
//   null              — n-au nimic de spus: comanda nu trece prin producție,
//                       sau toată marfa făcută a intrat deja în depozit, iar
//                       atunci decide stocul, nu producția;
//   „așteaptă marfă"  — toate anulate: producția nu mai face nimic. NU e
//                       anulată comanda clientului; depozitul decide;
//   „în producție"    — cel puțin una încă se face;
//   „producție finalizată" — toate sunt gata, dar măcar una n-a fost preluată.
function stareDinProductie(randuri) {
  const toate = (randuri || []).map((r) => (r && typeof r === "object" ? r : { status: r }));
  if (!toate.length) return null;
  const active = toate.filter((r) => String(r.status || "") !== "anulata");
  if (!active.length) return "asteapta_marfa";
  if (active.some((r) => PRODUCTIE_IN_LUCRU.includes(String(r.status || "")))) return "in_productie";
  if (active.some((r) => PRODUCTIE_GATA.includes(String(r.status || "")) && marfaNepreluata(r))) return "productie_finalizata";
  return null;
}

async function productiaComenzii(comandaId) {
  return db
    .prepare(
      `SELECT cp.status, cp.receptie_id, r.stare AS receptie_stare, a.status AS cerere_stare,
              (SELECT COUNT(*) FROM receptii rx WHERE rx.comanda_productie_id = cp.id AND rx.stare IN ('asteptata', 'in_lucru')) AS receptii_deschise,
              (SELECT COUNT(*) FROM receptii rx WHERE rx.comanda_productie_id = cp.id AND rx.stare = 'finalizata') AS receptii_preluate
         FROM comenzi_productie cp
         LEFT JOIN receptii r ON r.id = cp.receptie_id
         LEFT JOIN aprovizionari a ON a.id = cp.aprovizionare_id
        WHERE cp.comanda_id = ?`
    )
    .all(comandaId);
}

// Pune starea pe comanda de vânzare și o scrie în istoricul clientului. Se
// schimbă doar dacă starea e încă cea citită: dacă între timp altcineva a
// mutat comanda, mutarea lui câștigă.
async function mutaComanda(c, stareNoua, { user, motiv } = {}) {
  if (!c || !stareNoua || c.status === stareNoua) return false;
  const r = await db.prepare("UPDATE comenzi SET status = ? WHERE id = ? AND status = ?").run(stareNoua, c.id, c.status);
  if (r && r.changes === 0) return false;
  try {
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(c.partener_id || null, `Comanda ${numarComanda(c)}: ${textStare(stareNoua)}`, motiv || null, (user && user.id) || null);
  } catch (e) {
    // Istoricul nu are voie să rupă mutarea: starea e deja scrisă.
    console.error("[stadiu] nu am putut scrie in istoric:", e.message);
  }
  return true;
}

async function comanda(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM comenzi WHERE id = ?").get(Number(id));
}

// Producția și-a schimbat starea: comanda de vânzare urmează.
async function dupaProductie(comandaId, { user, motiv } = {}) {
  const c = await comanda(comandaId);
  if (!c || !ZONA_PRODUCTIE.includes(c.status)) return { schimbat: false, status: c ? c.status : null };
  const tinta = stareDinProductie(await productiaComenzii(c.id));
  if (!tinta || tinta === c.status) return { schimbat: false, status: c.status };
  const schimbat = await mutaComanda(c, tinta, { user, motiv });
  return { schimbat, status: schimbat ? tinta : c.status, de: c.status };
}

// Marfa a intrat în depozit (recepție finalizată sau „Intră în stoc"). Dacă
// acum stocul acoperă comanda — sau o parte, iar clientul primește livrare
// parțială —, comanda e „în stoc depozit" și agentul poate factura. Altfel
// rămâne la producție, dacă se mai face ceva, sau așteaptă marfă.
//
// `potrivire` e funcția din modules/warehouse.js; vine ca parametru ca lib/ să
// nu ceară module/ și ca testele să-i poată da o acoperire știută.
async function dupaIntrareMarfa(comandaId, { user, motiv, potrivire } = {}) {
  const c = await comanda(comandaId);
  if (!c || !ZONA_PRODUCTIE.includes(c.status) || typeof potrivire !== "function") {
    return { schimbat: false, status: c ? c.status : null };
  }
  const { acoperiteTot, acoperitePartial } = await potrivire(c.id);
  const dupaStoc = livrare.statusDupaVerificare({ acoperiteTot, acoperitePartial, comanda: c });
  // Nu acoperă încă: rămâne la producție dacă acolo mai e ceva (în lucru,
  // sau terminat și nepreluat); altfel chiar așteaptă marfă.
  const tinta = dupaStoc === "in_stoc_depozit" ? dupaStoc : stareDinProductie(await productiaComenzii(c.id)) || "asteapta_marfa";
  if (tinta === c.status) return { schimbat: false, status: c.status };
  const schimbat = await mutaComanda(c, tinta, {
    user,
    motiv:
      (motiv ? motiv + " " : "") +
      (tinta === "in_stoc_depozit"
        ? "Marfa e în depozit; comanda se poate factura."
        : tinta === "in_productie"
          ? "Încă se produce o parte din comandă."
          : tinta === "productie_finalizata"
            ? "Mai e marfă din producție de preluat."
            : "Ce a intrat nu acoperă comanda — așteaptă marfă."),
  });
  return { schimbat, status: schimbat ? tinta : c.status, de: c.status };
}

// Depozitul a pregătit comanda: e gata de livrare. Se poate doar din „în stoc
// depozit" — înainte n-ai ce pregăti, după (facturată, în livrare) e deja
// plecată sau pe drum.
async function gataDeLivrare(comandaId, { user } = {}) {
  const c = await comanda(comandaId);
  if (!c) return { ok: false, motiv: "Comanda nu există." };
  if (c.status === "gata_livrare") return { ok: true, schimbat: false };
  if (c.status !== "in_stoc_depozit") {
    return { ok: false, motiv: `Comanda e „${textStare(c.status)}". Gata de livrare se poate pune doar când e în stoc depozit.` };
  }
  const schimbat = await mutaComanda(c, "gata_livrare", {
    user,
    motiv: `Pregătită de ${(user && user.nume) || "depozit"}; poate pleca la client.`,
  });
  if (schimbat) {
    await db
      .prepare("UPDATE comenzi SET gata_livrare_la = ?, gata_livrare_de = ? WHERE id = ?")
      .run(acum(), (user && user.nume) || null, c.id);
  }
  return { ok: true, schimbat };
}

// Cursa de transport a pornit sau a ajuns. Doar înainte: o comandă care e
// deja livrată nu se întoarce „în livrare" pentru că s-a apăsat ceva pe o
// cursă veche.
const POATE_PLECA = ["in_stoc_depozit", "gata_livrare", "facturata"];
async function dupaCursa(comandaId, stareCursa, { user, motiv } = {}) {
  const c = await comanda(comandaId);
  if (!c) return { schimbat: false, status: null };
  let tinta = null;
  if (stareCursa === "in_curs" && POATE_PLECA.includes(c.status)) tinta = "in_livrare";
  if (stareCursa === "livrata" && POATE_PLECA.concat(["in_livrare"]).includes(c.status)) {
    // A plecat doar ce s-a facturat parțial, iar restul a rămas pe comandă.
    const rest = await db
      .prepare("SELECT COALESCE(SUM(cantitate - COALESCE(cantitate_livrata, 0)), 0) AS r FROM comenzi_linii WHERE comanda_id = ?")
      .get(c.id)
      .catch(() => ({ r: 0 }));
    tinta = c.decizie_agent === "facturat_partial" && Number((rest && rest.r) || 0) > 0.0001 ? "livrata_partial" : "livrata";
  }
  if (!tinta || tinta === c.status) return { schimbat: false, status: c.status };
  const schimbat = await mutaComanda(c, tinta, { user, motiv });
  return { schimbat, status: schimbat ? tinta : c.status, de: c.status };
}

// ---- Finalizarea parțială ---------------------------------------------------
//
// CEREREA LUI VALI, 10.11.2026:
//   „Să am și opțiune de finalizare parțială, caz în care se duce spre alocare
//    partea indicată din marfa comandată, însă rămâne în producție până la
//    finalizarea completă."
//
// Partea gata pleacă în depozit pe o recepție din producție marcată „parțială"
// și apare în lista „Gata din producție — de alocat", ca orice marfă terminată.
// Comanda de producție rămâne în lucru, iar comanda clientului „în producție".
// La „Finalizată" pleacă doar restul. O recepție parțială anulată în depozit
// își întoarce cantitatea la „rămas de făcut".
const EPS = 0.0005;
const rot = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const cat = (v, um) => `${rot(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${um ? " " + um : ""}`;

// Cantitatea de pe comanda de producție e text: „700000", „67,200", „1 200 buc",
// „360 (331)". Se citește într-un singur loc, la fel peste tot.
const cantNr = require("./cantitate-text").citesteCantitate;

// Ce are de trimis în depozit o comandă de producție: câte un rând pentru
// fiecare produs de pe ea sau, la comenzile de dinainte de linii, unul singur.
async function liniiDeTrimis(cp) {
  const linii = await db
    .prepare("SELECT * FROM comenzi_productie_linii WHERE comanda_id = ? ORDER BY ordine, id")
    .all(cp.id)
    .catch(() => []);
  return linii.length
    ? linii.map((l) => ({ linie_id: Number(l.id), produs_id: l.produs_id || null, produs_text: l.denumire, cantitate: cantNr(l.cantitate, l.um), um: l.um }))
    : [{ linie_id: null, produs_id: cp.produs_id || null, produs_text: cp.tip_produs, cantitate: cantNr(cp.cantitate, cp.um), um: cp.um }];
}

// Finalizările parțiale ale unei comenzi de producție: recepțiile ei „parțiale"
// neanulate, fiecare cu ce a anunțat producția pe ea.
async function trimiteriPartiale(cpId) {
  const randuri = await db
    .prepare(
      `SELECT r.id AS receptie_id, r.numar, r.stare, r.data, r.creata_la, r.anuntata_de,
              rl.productie_linie_id, rl.cantitate_asteptata, rl.um, rl.produs_text
         FROM receptii r
         JOIN receptii_linii rl ON rl.receptie_id = r.id
        WHERE r.comanda_productie_id = ? AND COALESCE(r.partiala, 0) = 1 AND r.stare <> 'anulata'
        ORDER BY r.id, rl.id`
    )
    .all(Number(cpId))
    .catch(() => []);
  const pe = new Map();
  for (const x of randuri) {
    const k = Number(x.receptie_id);
    if (!pe.has(k)) {
      pe.set(k, {
        receptie_id: k,
        numar: x.numar || "#" + k,
        stare: x.stare,
        data: String(x.data || x.creata_la || "").slice(0, 10),
        de: x.anuntata_de || "",
        randuri: [],
      });
    }
    pe.get(k).randuri.push({
      cheie: String(Number(x.productie_linie_id) || 0),
      cantitate: rot(x.cantitate_asteptata),
      um: x.um || "",
      denumire: x.produs_text || "",
    });
  }
  return [...pe.values()];
}

// Unde e comanda de producție: pe fiecare produs, cât e comandat, cât a plecat
// deja în depozit prin finalizări parțiale și cât a rămas de făcut. `cheie` e
// id-ul liniei comenzii de producție, sau „0" la comenzile fără linii.
// O cantitate necunoscută (0) n-are rest: acolo nu se poate spune cât mai e.
async function situatiePartiala(cp) {
  const trimiteri = await trimiteriPartiale(cp.id);
  const trimis = new Map();
  for (const t of trimiteri) for (const r of t.randuri) trimis.set(r.cheie, rot((trimis.get(r.cheie) || 0) + r.cantitate));
  const linii = (await liniiDeTrimis(cp)).map((l) => {
    const cheie = String(l.linie_id || 0);
    const dus = trimis.get(cheie) || 0;
    return {
      cheie,
      linie_id: l.linie_id,
      produs_id: l.produs_id,
      denumire: l.produs_text || "",
      um: l.um || "",
      comandat: rot(l.cantitate),
      trimis: dus,
      rest: Math.max(0, rot(l.cantitate - dus)),
    };
  });
  return {
    linii,
    trimiteri,
    areTrimiteri: trimiteri.length > 0,
    restTotal: rot(linii.reduce((a, l) => a + l.rest, 0)),
  };
}

// Cererea depozitului se închide („intrată în stoc") când marfa comenzii de
// producție a intrat toată: comanda e gata și nicio recepție a ei nu mai
// așteaptă. O cheamă recepția parțială la finalizare și „Finalizată" atunci
// când totul plecase deja pe recepții parțiale.
async function inchideCerereaDacaAIntratTot(cpId) {
  const cp = await db.prepare("SELECT id, status, aprovizionare_id FROM comenzi_productie WHERE id = ?").get(Number(cpId));
  if (!cp || !cp.aprovizionare_id || !PRODUCTIE_GATA.includes(String(cp.status))) return false;
  const n = await db
    .prepare(
      `SELECT SUM(CASE WHEN stare IN ('asteptata', 'in_lucru') THEN 1 ELSE 0 END) AS deschise,
              SUM(CASE WHEN stare = 'finalizata' THEN 1 ELSE 0 END) AS preluate
         FROM receptii WHERE comanda_productie_id = ?`
    )
    .get(cp.id);
  if (Number((n && n.deschise) || 0) > 0 || !(Number((n && n.preluate) || 0) > 0)) return false;
  await db.prepare("UPDATE aprovizionari SET status = 'primita' WHERE id = ? AND status <> 'primita'").run(cp.aprovizionare_id);
  return true;
}

// Finalizarea parțială: `cantitati` = { cheia liniei: cât e gata acum }.
// Întoarce { ok, receptieId, mesaj } sau { eroare }.
async function finalizeazaPartial(cpId, cantitati, { user } = {}) {
  const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(Number(cpId));
  if (!cp) return { eroare: "Comanda de producție nu există." };
  if (!PRODUCTIE_IN_LUCRU.includes(String(cp.status))) {
    return {
      eroare:
        cp.status === "anulata"
          ? "Comanda e anulată; nu mai are ce trimite în depozit."
          : "Comanda e deja finalizată: marfa ei a plecat în depozit.",
    };
  }
  const nr = cp.numar || "#" + cp.id;
  const cine = (user && user.nume) || "producția";
  const s = await situatiePartiala(cp);
  const deTrimis = [];
  const preaMult = [];
  for (const l of s.linii) {
    const brut = (cantitati || {})[l.cheie];
    const gata = rot(Number(String(brut == null ? "" : brut).replace(/\s/g, "").replace(",", ".")));
    if (!(gata > 0)) continue;
    // Peste ce a rămas nu se trimite „parțial": dacă s-a făcut tot, comanda se
    // pune pe „Finalizată". Unde cantitatea comenzii nu se știe, nu e ce compara.
    if (l.comandat > EPS && gata > l.rest + EPS) {
      preaMult.push(`${l.denumire || "produsul"}: ai scris ${cat(gata, l.um)}, au mai rămas ${cat(l.rest, l.um)}`);
      continue;
    }
    deTrimis.push({ produs_id: l.produs_id, produs_text: l.denumire, cantitate: gata, um: l.um, productie_linie_id: l.linie_id });
  }
  if (preaMult.length) {
    return { eroare: `Mai mult decât a rămas de făcut — ${preaMult.join("; ")}. Dacă s-a terminat tot, pune comanda pe „Finalizată”.` };
  }
  if (!deTrimis.length) return { eroare: "Scrie cât s-a terminat până acum (o cantitate mai mare ca zero)." };

  // Cerut la apel, nu sus: modules/receptie.js cere la rândul lui lib/.
  const receptieId = await require("../modules/receptie").creeaza(
    {
      sursa: "productie",
      partiala: 1,
      comanda_productie_id: cp.id,
      comanda_id: cp.comanda_id || null,
      aprovizionare_id: cp.aprovizionare_id || null,
      anuntata_de: (user && user.nume) || null,
      observatii: `Finalizare parțială din comanda de producție ${nr}; restul e încă în lucru.`,
    },
    deTrimis
  );

  // O comandă „nouă" din care s-a făcut deja o parte e, de fapt, în producție.
  if (cp.status === "noua") {
    await db.prepare("UPDATE comenzi_productie SET status = 'in_productie' WHERE id = ? AND status = 'noua'").run(cp.id);
    try {
      await laSchimbareaProductiei(cp.id, "noua", "in_productie", { user });
    } catch (e) {
      console.error("[stadiu] finalizare partiala, starea comenzii:", e.message);
    }
  }

  const ceAPlecat = deTrimis.map((l) => `${cat(l.cantitate, l.um)}${deTrimis.length > 1 && l.produs_text ? " " + l.produs_text : ""}`).join(", ");
  // Agentul află din istoricul clientului că o parte din marfă e gata.
  if (cp.comanda_id) {
    try {
      const c = await comanda(cp.comanda_id);
      if (c) {
        await db
          .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
          .run(
            c.partener_id || null,
            `Comanda ${numarComanda(c)}: o parte din marfă e gata în producție`,
            `Producția (${cine}) a trimis în depozit ${ceAPlecat} din comanda de producție ${nr}. Restul e încă în lucru.`,
            (user && user.id) || null
          );
      }
    } catch (e) {
      console.error("[stadiu] finalizare partiala, istoric:", e.message);
    }
  }

  const dupa = await situatiePartiala(cp);
  return {
    ok: true,
    receptieId: Number(receptieId),
    rest: dupa.restTotal,
    mesaj:
      `Comanda ${nr}: ${ceAPlecat} au plecat în depozit, la „Gata din producție — de alocat”. ` +
      (dupa.linii.some((l) => l.comandat > EPS && l.rest > EPS)
        ? "Comanda rămâne în producție până o pui pe „Finalizată”."
        : "Nu a mai rămas nimic de făcut: pune comanda pe „Finalizată”."),
  };
}

// Producția trimite marfa în depozit: se deschide o recepție „din producție",
// pe care depozitul o preia rând cu rând. Nu scrie stoc — marfa intră pe stoc
// abia când o vede cineva din depozit.
//
// După finalizări parțiale pleacă doar restul. Dacă totul a plecat deja pe
// recepții parțiale, nu se mai deschide alta: comanda se marchează trimisă și
// întoarce null.
async function trimiteInDepozit(cp, { user } = {}) {
  if (!cp) return null;
  if (cp.trimisa_depozit_la && cp.receptie_id) return Number(cp.receptie_id);
  const s = await situatiePartiala(cp);
  const deTrimis = s.areTrimiteri
    ? s.linii
        .filter((l) => l.rest > EPS)
        .map((l) => ({ produs_id: l.produs_id, produs_text: l.denumire, cantitate: l.rest, um: l.um, productie_linie_id: l.linie_id }))
    : s.linii.map((l) => ({ produs_id: l.produs_id, produs_text: l.denumire, cantitate: l.comandat, um: l.um, productie_linie_id: l.linie_id }));
  if (s.areTrimiteri && !deTrimis.length) {
    await db.prepare("UPDATE comenzi_productie SET trimisa_depozit_la = ? WHERE id = ?").run(azi(), cp.id);
    await inchideCerereaDacaAIntratTot(cp.id).catch(() => false);
    return null;
  }
  // Cerut la apel, nu sus: modules/receptie.js cere la rândul lui lib/ și nu
  // vrem un cerc de importuri la pornire.
  const receptieId = await require("../modules/receptie").creeaza(
    {
      sursa: "productie",
      comanda_productie_id: cp.id,
      comanda_id: cp.comanda_id || null,
      aprovizionare_id: cp.aprovizionare_id || null,
      anuntata_de: (user && user.nume) || null,
      observatii:
        "Din comanda de producție " +
        (cp.numar || "#" + cp.id) +
        (s.areTrimiteri ? ` — restul, după ${s.trimiteri.length} ${s.trimiteri.length === 1 ? "finalizare parțială" : "finalizări parțiale"}` : ""),
    },
    deTrimis
  );
  await db
    .prepare("UPDATE comenzi_productie SET trimisa_depozit_la = ?, receptie_id = ? WHERE id = ?")
    .run(azi(), receptieId, cp.id);
  return Number(receptieId);
}

// Recepția deschisă singură la „Finalizată", închisă dacă producția revine.
// Doar cât n-a atins-o nimeni din depozit: o recepție începută are pe ea
// cantități numărate și locuri alese, și nu dispare pentru că s-a răzgândit
// altcineva.
//
// Recepțiile parțiale nu se retrag niciodată de aici: marfa lor chiar a plecat.
// Dacă „Finalizată" n-a mai deschis nicio recepție (totul plecase parțial), se
// șterge doar semnul că s-a trimis, ca o nouă finalizare să socotească iar.
async function retrageDinDepozit(cp) {
  if (!cp) return { retrasa: false };
  if (!cp.receptie_id) {
    if (!cp.trimisa_depozit_la) return { retrasa: false };
    await db.prepare("UPDATE comenzi_productie SET trimisa_depozit_la = NULL WHERE id = ? AND receptie_id IS NULL").run(cp.id);
    return { retrasa: true };
  }
  const r = await db.prepare("SELECT id, stare FROM receptii WHERE id = ?").get(cp.receptie_id);
  if (!r) {
    await db.prepare("UPDATE comenzi_productie SET trimisa_depozit_la = NULL, receptie_id = NULL WHERE id = ?").run(cp.id);
    return { retrasa: true };
  }
  if (r.stare !== "asteptata") return { retrasa: false, stare: r.stare };
  const atinse = await db
    .prepare("SELECT COUNT(*) AS n FROM receptii_linii WHERE receptie_id = ? AND COALESCE(stare, 'de_primit') <> 'de_primit'")
    .get(r.id);
  if (Number((atinse && atinse.n) || 0) > 0) return { retrasa: false, stare: "in_lucru" };
  await db.prepare("UPDATE receptii SET stare = 'anulata' WHERE id = ? AND stare = 'asteptata'").run(r.id);
  await db.prepare("UPDATE comenzi_productie SET trimisa_depozit_la = NULL, receptie_id = NULL WHERE id = ?").run(cp.id);
  return { retrasa: true };
}

// Comanda de producție pornită în ultimele 90 de zile, după data inițierii sau
// a scrierii ei în ERP. Fără nicio dată se socotește nouă — afară de rândurile
// aduse din registrul Excel (sursa import_…): la ele data scrierii în ERP e
// ziua importului, nu a comenzii, deci fără data inițierii sunt istorie.
function pornitaRecent(cp, astazi) {
  const importata = /^(import|registru)/i.test(String((cp && cp.sursa) || ""));
  const d = String((cp && (cp.data_initiere || (importata ? "" : cp.creat_la))) || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) || (/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d) ? [null, d.slice(6, 10), d.slice(3, 5), d.slice(0, 2)] : null);
  if (!m) return !importata;
  const zile = (Date.parse(String(astazi || azi())) - Date.parse(`${m[1]}-${m[2]}-${m[3]}`)) / 86400000;
  return !(zile > 90);
}

// Ce face o schimbare de stare a comenzii de producție, oriunde s-ar face ea:
// din listă, din fișă sau de la alocarea pe utilaje.
//
//   • data finalizării: pusă la prima finalizare, ștearsă dacă se revine;
//   • cererea depozitului (aprovizionari): confirmată ↔ gata ↔ refuzată;
//   • recepția „de preluat din producție": deschisă la finalizare, retrasă la
//     revenire dacă depozitul n-a început-o;
//   • comanda de vânzare: în producție / producție finalizată / așteaptă marfă.
async function laSchimbareaProductiei(cpId, deLa, la, { user } = {}) {
  const de = String(deLa || "");
  const spre = String(la || "");
  if (!cpId || de === spre) return { schimbat: false };
  const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(Number(cpId));
  if (!cp) return { schimbat: false };
  const cine = (user && user.nume) || "producția";
  const nr = cp.numar || "#" + cp.id;
  const rezultat = { schimbat: true, receptie: null, vanzare: null };

  const eraGata = PRODUCTIE_GATA.includes(de);
  const eGata = PRODUCTIE_GATA.includes(spre);

  if (eGata && !cp.data_finalizare) {
    await db.prepare("UPDATE comenzi_productie SET data_finalizare = ? WHERE id = ?").run(azi(), cp.id);
  } else if (eraGata && !eGata) {
    await db.prepare("UPDATE comenzi_productie SET data_finalizare = NULL WHERE id = ?").run(cp.id);
  }

  if (cp.aprovizionare_id) {
    const tintaCerere = eGata ? "gata" : spre === "anulata" ? "refuzata" : PRODUCTIE_IN_LUCRU.includes(spre) ? "confirmata" : null;
    // Doar între stările pe care le-a pus producția. „Primită" (marfa e deja
    // pe stoc) și „anulată" (de depozit) nu le mai atinge nimeni.
    if (tintaCerere === "refuzata") {
      await db
        .prepare("UPDATE aprovizionari SET status = 'refuzata', raspuns = ? WHERE id = ? AND status IN ('confirmata', 'gata')")
        .run(`comanda de producție ${nr} anulată de ${cine}`, cp.aprovizionare_id);
    } else if (tintaCerere) {
      await db
        .prepare("UPDATE aprovizionari SET status = ? WHERE id = ? AND status IN ('confirmata', 'gata', 'refuzata') AND status <> ?")
        .run(tintaCerere, cp.aprovizionare_id, tintaCerere);
    }
  }

  // Marfa terminată pleacă în depozit, unde așteaptă să fie alocată: pe raft,
  // în fulfillment sau direct la livrare (lista „Gata din producție" din
  // Intrare marfă, lib/gata-productie.js). Vali, 09.11.2026: „La finalizare
  // comandă, când schimbi statusul, să se ducă în depozit, unde va aștepta
  // alocare pe depozit, fulfillment sau livrare."
  //
  // Până atunci recepția se deschidea doar pentru comenzile legate de o
  // comandă de client sau de o cerere a depozitului, iar cele scrise direct în
  // registru (Sameday, DELIVERY SOLUTIONS…) se terminau fără să intre nicăieri.
  // A rămas o singură plasă: registrul vechi, adus din Excel, are sute de
  // comenzi făcute și livrate de luni de zile — o „Finalizată" pusă pe una din
  // ele la curățenie nu deschide recepție. Deci doar comenzile pornite în
  // ultimele 90 de zile (sau fără nicio dată).
  if (eGata && !eraGata && !cp.trimisa_depozit_la && (cp.comanda_id || cp.aprovizionare_id || pornitaRecent(cp))) {
    try {
      rezultat.receptie = await trimiteInDepozit(cp, { user });
    } catch (e) {
      console.error("[stadiu] nu am putut deschide receptia din productie:", e.message);
    }
  } else if (eraGata && !eGata && (cp.receptie_id || cp.trimisa_depozit_la)) {
    try {
      rezultat.retrasa = await retrageDinDepozit(cp);
    } catch (e) {
      console.error("[stadiu] nu am putut retrage receptia:", e.message);
    }
  }

  if (cp.comanda_id) {
    const motiv = eGata
      ? `Producția (${cine}) a terminat comanda de producție ${nr}. Marfa e de preluat în depozit.`
      : spre === "anulata"
        ? `Producția (${cine}) a anulat comanda de producție ${nr}. Depozitul vede cererea refuzată și decide.`
        : `Comanda de producție ${nr} e „${spre === "noua" ? "nouă" : "în producție"}" (${cine}).`;
    rezultat.vanzare = await dupaProductie(cp.comanda_id, { user, motiv });
  }
  return rezultat;
}

// Comenzile clienților rămase în urmă față de producția lor: toate comenzile
// de producție sunt gata, dar comanda arată încă „în producție". Așa au rămas
// cele puse pe „Finalizată" din listă înainte de 05.11.2026, când lista nu
// ducea starea mai departe. Se văd pe /productie, iar un admin le aduce la zi
// cu un buton — nu singure la pornire: e o schimbare pe comenzi reale, și
// trebuie să se vadă ce se mută înainte să se mute.
async function ramaseInUrma() {
  const randuri = await db
    .prepare(
      `SELECT c.id, c.numar, c.status, pa.nume AS client,
              cp.id AS cp_id, cp.numar AS cp_numar, cp.status AS cp_status, cp.comanda_id, cp.aprovizionare_id,
              cp.trimisa_depozit_la, cp.receptie_id, r.stare AS receptie_stare, a.status AS cerere_stare
         FROM comenzi c
         JOIN comenzi_productie cp ON cp.comanda_id = c.id
         LEFT JOIN parteneri pa ON pa.id = c.partener_id
         LEFT JOIN receptii r ON r.id = cp.receptie_id
         LEFT JOIN aprovizionari a ON a.id = cp.aprovizionare_id
        WHERE c.status IN ('noua', 'confirmata', 'asteapta_marfa', 'in_productie')
        ORDER BY c.id, cp.id`
    )
    .all()
    .catch(() => []);
  const pe = new Map();
  for (const r of randuri) {
    if (!pe.has(r.id)) pe.set(r.id, { id: r.id, numar: r.numar, status: r.status, client: r.client, productie: [] });
    pe.get(r.id).productie.push({
      id: r.cp_id, numar: r.cp_numar, status: r.cp_status, comanda_id: r.comanda_id, aprovizionare_id: r.aprovizionare_id,
      trimisa_depozit_la: r.trimisa_depozit_la, receptie_id: r.receptie_id, receptie_stare: r.receptie_stare, cerere_stare: r.cerere_stare,
    });
  }
  // Doar cele unde producția a terminat tot; cele cu ceva încă în lucru sunt
  // la locul lor.
  return [...pe.values()].filter((c) => stareDinProductie(c.productie) === "productie_finalizata");
}

// Le aduce la zi: marfa gata intră la „De preluat din producție", cererea
// depozitului devine „gata", iar comanda clientului „producție finalizată".
// Data finalizării nu se inventează: n-o știm, deci rămâne cum era.
async function aduLaZi({ user } = {}) {
  const lista = await ramaseInUrma();
  let receptii = 0;
  let comenzi = 0;
  for (const c of lista) {
    for (const p of c.productie) {
      if (!PRODUCTIE_GATA.includes(String(p.status))) continue;
      if (p.aprovizionare_id) {
        await db.prepare("UPDATE aprovizionari SET status = 'gata' WHERE id = ? AND status = 'confirmata'").run(p.aprovizionare_id);
      }
      if (!p.trimisa_depozit_la) {
        const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(p.id);
        try {
          if (await trimiteInDepozit(cp, { user })) receptii++;
        } catch (e) {
          console.error("[stadiu] adu la zi, receptie:", e.message);
        }
      }
    }
    const r = await dupaProductie(c.id, {
      user,
      motiv: `Adusă la zi de ${(user && user.nume) || "administrator"}: comenzile de producție erau deja finalizate. Marfa e de preluat în depozit.`,
    });
    if (r.schimbat) comenzi++;
  }
  return { comenzi, receptii, total: lista.length };
}

module.exports = {
  pornitaRecent,
  ramaseInUrma,
  aduLaZi,
  ZONA_PRODUCTIE,
  PRODUCTIE_GATA,
  stareDinProductie,
  dupaProductie,
  dupaIntrareMarfa,
  gataDeLivrare,
  dupaCursa,
  trimiteInDepozit,
  retrageDinDepozit,
  laSchimbareaProductiei,
  cantNr,
  situatiePartiala,
  finalizeazaPartial,
  inchideCerereaDacaAIntratTot,
};
