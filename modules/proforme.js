"use strict";
// Proformele: emiterea din comandă, lista, foaia tipărită, anularea.
//
// CE A CERUT VALI, 18.11.2026: „Fă meniu «emite proformă» și emite proformă de
// către agenți pentru clienții lor, să o poată emite direct din comandă, cu
// preluare la toate datele și pus pe el. La număr incrementat, indiferent cine
// face proforma."
//
// CINE. Agentul emite proforma pentru comenzile lui și ale clienților lui:
// e agentul de pe comandă, a scris el comanda, e agentul de pe fișa clientului
// sau are clientul alocat. Administratorul, financiarul și cine are bifa
// „Facturare" emit pentru oricine. Aceeași regulă hotărăște cine VEDE o proformă.
//
// CE IA DIN COMANDĂ. Clientul (cu datele de pe fișă: CUI, Reg. Com., adresă,
// persoană de contact, telefon, email), liniile cu cantitate, unitate și preț,
// TVA-ul fiecărui produs, moneda și cursul comenzii, termenul de plată, modul
// de livrare, data de livrare cerută, numărul comenzii și mențiunea de unitate
// protejată, dacă e bifată. Toate se COPIAZĂ pe proformă: o comandă sau o fișă
// schimbată mai târziu nu rescrie hârtia deja trimisă clientului.
//
// NUMEROTAREA. Un singur contor pentru toată lumea, în setari_app
// (proforma_serie, proforma_urmator), ca la avize: numărul se ia și proforma
// se scrie în ACEEAȘI instrucțiune SQL, deci doi agenți care apasă în aceeași
// secundă primesc numere diferite, iar o proformă care nu se poate scrie nu
// consumă un număr. Indexul unic (serie, numar) e plasa de siguranță.
//
// O proformă emisă nu se modifică și nu se șterge. Dacă comanda s-a schimbat,
// se emite alta (cu numărul următor); cea veche se anulează, cu motiv, și
// rămâne în listă cu ANULATĂ pe ea. Aceeași comandă, neschimbată, nu primește
// două numere: a doua apăsare deschide proforma deja emisă.
const db = require("../lib/db");
const PF = require("../lib/proforma");
const AV = require("../lib/aviz");
const UPA = require("../lib/upa");
const TP = require("../lib/termen-plata");
const CC = require("../lib/curs-comanda");
const LM = require("../lib/livrare-mod");
const { esc, layout, table, subnavComenzi } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { areProforme } = require("../lib/auth");

const SERIE_IMPLICITA = "PF";
const URMATORUL_IMPLICIT = 1;

function aziRo() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
}
const nr = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const eAdmin = (u) => Boolean(u && u.rol === "admin");
// Vede și emite pentru oricine: administratorul, cine poate factura și cine
// are bifa „Proforme” (lib/auth.js, areProforme).
const peToti = (u) => eAdmin(u) || areProforme(u);

// Condiția SQL „comanda e a omului ăsta". Trei semne de întrebare … de fapt patru.
const SQL_A_LUI = (c, p) =>
  `(${c}.agent_id = ? OR ${c}.creata_de = ? OR ${p}.agent_id = ?
     OR EXISTS (SELECT 1 FROM alocari_clienti ac WHERE ac.partener_id = ${p}.id AND ac.utilizator_id = ?))`;
const patru = (id) => [id, id, id, id];

// Are omul voie să emită proforma comenzii?
async function poateEmite(user, comandaId) {
  if (!user || !nr(comandaId)) return false;
  if (peToti(user)) return true;
  const id = Number(user.id);
  if (!(id > 0)) return false;
  const r = await db
    .prepare(`SELECT c.id FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ? AND ${SQL_A_LUI("c", "p")}`)
    .get(nr(comandaId), ...patru(id))
    .catch(() => null);
  return Boolean(r);
}

// Are omul voie să vadă proforma? A lui (a emis-o sau e agentul de pe ea) ori
// a unui client de-al lui.
async function poateVedea(user, pf) {
  if (!user || !pf) return false;
  if (peToti(user)) return true;
  const id = Number(user.id);
  if (!(id > 0)) return false;
  if (Number(pf.creat_de_id) === id || Number(pf.agent_id) === id) return true;
  const r = await db
    .prepare(
      `SELECT p.id FROM parteneri p WHERE p.id = ? AND (p.agent_id = ?
          OR EXISTS (SELECT 1 FROM alocari_clienti a WHERE a.partener_id = p.id AND a.utilizator_id = ?))`
    )
    .get(pf.partener_id, id, id)
    .catch(() => null);
  return Boolean(r);
}

async function contor() {
  const r = await db.prepare("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('proforma_serie', 'proforma_urmator')").all();
  const m = {};
  for (const x of r || []) m[x.cheie] = x.valoare;
  return { serie: String(m.proforma_serie || SERIE_IMPLICITA), urmator: Number(m.proforma_urmator) || URMATORUL_IMPLICIT };
}

// Datele proformei, citite din comandă. Aruncă o eroare cu mesaj de om.
async function dinComanda(comandaId) {
  const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(nr(comandaId));
  if (!c) throw new Error("Comanda nu există.");
  if (String(c.status) === "anulata") throw new Error("Comanda e anulată; nu se emite proformă pe ea.");
  const p = await db
    .prepare("SELECT id, nume, cui, reg_com, adresa, judet, localitate, tara, telefon, email, persoana_contact, termen_plata_zile FROM parteneri WHERE id = ?")
    .get(c.partener_id);
  if (!p) throw new Error("Clientul comenzii nu există în ERP.");
  const linii = (
    await db
      .prepare(
        `SELECT cl.id, cl.produs_id, cl.cantitate, cl.pret_unitar, cl.um, pr.denumire, pr.unitate_masura, pr.cota_tva,
                COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS cod
           FROM comenzi_linii cl JOIN produse pr ON pr.id = cl.produs_id
          WHERE cl.comanda_id = ? ORDER BY cl.id`
      )
      .all(c.id)
  )
    .filter((l) => Number(l.cantitate) > 0)
    .map((l) => ({
      produs_id: Number(l.produs_id),
      denumire: String(l.denumire || "").trim(),
      cod: l.cod || null,
      um: String(l.um || l.unitate_masura || "").trim() || null,
      cantitate: Number(l.cantitate),
      pret_unitar: Number(l.pret_unitar) || 0,
      cota_tva: l.cota_tva == null ? 0 : Number(l.cota_tva),
    }));
  if (!linii.length) throw new Error("Comanda n-are nicio linie cu cantitate; n-am ce pune pe proformă.");
  const faraPret = linii.filter((l) => !(l.pret_unitar > 0));
  if (faraPret.length) {
    throw new Error(
      `Proforma cere preț pe fiecare linie. Fără preț pe comandă: ${faraPret.map((l) => l.denumire).slice(0, 4).join("; ")}${faraPret.length > 4 ? "…" : ""}. Scrie prețul în „Modifică comanda".`
    );
  }
  const moneda = PF.moneda(c.moneda);
  const curs = moneda !== "RON" && Number(c.curs_bnr) > 0 ? Number(c.curs_bnr) : null;
  const termen = TP.efectiv(c, { termen_plata_zile: p.termen_plata_zile });
  const upa = UPA.eUpa(c);
  return {
    comanda: c,
    partener: p,
    linii,
    doc: {
      partener_id: Number(p.id),
      comanda_id: Number(c.id),
      comanda_numar: String(c.numar || "").trim() || "#" + c.id,
      client_nume: p.nume,
      client_cui: p.cui || null,
      client_regcom: String(p.reg_com || "").trim() || null,
      client_adresa: AV.adresaClient(p) || null,
      client_contact: String(p.persoana_contact || "").trim() || null,
      client_telefon: String(p.telefon || "").trim() || null,
      client_email: String(p.email || "").trim() || null,
      moneda,
      curs,
      curs_nota: curs ? (Number(c.curs_manual) === 1 ? "pus pe comandă" : "BNR" + (c.curs_bnr_data ? " din " + AV.dataAviz(c.curs_bnr_data) : "")) : null,
      termen_plata_zile: termen == null ? null : Number(termen),
      livrare: LM.valid(c.livrare_mod) ? LM.text(c) : null,
      data_livrare: String(c.data_livrare_ceruta || "").slice(0, 10) || null,
      upa: upa ? 1 : 0,
      mentiune: upa ? UPA.mentiune(p.nume) : null,
      agent_id: nr(c.agent_id),
    },
  };
}

// Emite proforma comenzii. Întoarce { id, serie, numar, existenta }.
// `existenta: true` = comanda nu s-a schimbat de la ultima proformă neanulată,
// deci n-a primit alt număr.
async function emite(comandaId, user, { observatii } = {}) {
  const { doc, linii } = await dinComanda(comandaId);
  const obs = String(observatii || "").trim().slice(0, 500) || null;
  const amprenta = PF.amprenta(doc, linii);
  const ultima = await db
    .prepare("SELECT id, serie, numar, amprenta, observatii FROM proforme WHERE comanda_id = ? AND anulat = 0 ORDER BY id DESC LIMIT 1")
    .get(doc.comanda_id);
  if (ultima && ultima.amprenta === amprenta && String(ultima.observatii || "") === String(obs || "")) {
    return { id: Number(ultima.id), serie: ultima.serie, numar: Number(ultima.numar), existenta: true };
  }

  const azi = aziRo();
  await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('proforma_serie', ?, ?) ON CONFLICT (cheie) DO NOTHING").run(SERIE_IMPLICITA, azi);
  await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('proforma_urmator', ?, ?) ON CONFLICT (cheie) DO NOTHING").run(String(URMATORUL_IMPLICIT), azi);
  const { serie } = await contor();
  const T = PF.totaluri(linii);

  let rand;
  try {
    rand = await db
      .prepare(
        `WITH nr AS (
           UPDATE setari_app SET valoare = CAST(CAST(valoare AS INTEGER) + 1 AS TEXT), actualizat_la = ?
            WHERE cheie = 'proforma_urmator'
            RETURNING CAST(valoare AS INTEGER) - 1 AS numar
         )
         INSERT INTO proforme (serie, numar, data, partener_id, comanda_id, comanda_numar, client_nume, client_cui, client_regcom, client_adresa,
                               client_contact, client_telefon, client_email, furnizor, moneda, curs, curs_nota, termen_plata_zile, livrare, data_livrare,
                               upa, mentiune, observatii, subtotal, tva, total, amprenta, agent_id, agent_email, creat_de, creat_de_id)
         SELECT ?, nr.numar, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM nr
         RETURNING id, serie, numar`
      )
      .get(
        azi, serie, azi, doc.partener_id, doc.comanda_id, doc.comanda_numar, doc.client_nume, doc.client_cui, doc.client_regcom, doc.client_adresa,
        doc.client_contact, doc.client_telefon, doc.client_email, JSON.stringify(AV.FURNIZOR), doc.moneda, doc.curs, doc.curs_nota, doc.termen_plata_zile,
        doc.livrare, doc.data_livrare, doc.upa, doc.mentiune, obs, T.subtotal, T.tva, T.total, amprenta, doc.agent_id,
        String((user && (user.email_expeditor || user.email)) || "").trim() || null, (user && user.nume) || null, nr(user && user.id)
      );
  } catch (e) {
    if (/ux_proforme_serie_numar|duplicate key/i.test(String(e.message))) {
      const { urmator } = await contor().catch(() => ({ urmator: "?" }));
      throw new Error(`Numărul ${urmator} din seria ${serie} e deja folosit pe altă proformă. Un administrator trebuie să corecteze contorul din Proforme.`);
    }
    throw e;
  }
  if (!rand || !rand.id) throw new Error("Proforma n-a primit număr: contorul de proforme lipsește.");

  const valori = [];
  const semne = linii
    .map((l) => {
      valori.push(rand.id, l.produs_id || null, l.denumire, l.cod || null, l.um || null, l.cantitate, l.pret_unitar, l.cota_tva);
      return "(?, ?, ?, ?, ?, ?, ?, ?)";
    })
    .join(", ");
  await db.prepare(`INSERT INTO proforme_linii (proforma_id, produs_id, denumire, cod, um, cantitate, pret_unitar, cota_tva) VALUES ${semne}`).run(...valori);
  await db
    .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
    .run(doc.partener_id, `Proformă ${rand.serie} ${rand.numar} din comanda ${doc.comanda_numar}`, `Total ${PF.bani(T.total)} ${PF.SIMBOL[doc.moneda]}.`, nr(user && user.id))
    .catch((e) => console.error("[proforme] interacțiunea nu s-a scris:", e.message));
  console.log(`[proforme] ${rand.serie} ${rand.numar} pentru ${doc.client_nume}, comanda ${doc.comanda_numar}, de ${(user && user.nume) || "?"}`);
  return { id: Number(rand.id), serie: rand.serie, numar: Number(rand.numar), existenta: false };
}

async function citeste(id) {
  const pf = await db.prepare("SELECT * FROM proforme WHERE id = ?").get(nr(id));
  if (!pf) return null;
  const linii = await db.prepare("SELECT * FROM proforme_linii WHERE proforma_id = ? ORDER BY id").all(pf.id);
  return { pf, linii };
}

// Proformele unei comenzi, pentru pagina comenzii.
async function aleComenzii(comandaId) {
  return db
    .prepare("SELECT id, serie, numar, data, anulat, total, moneda FROM proforme WHERE comanda_id = ? ORDER BY id")
    .all(nr(comandaId))
    .catch(() => []);
}

const nuAiVoie = (ctx, titlu, text) =>
  send(
    ctx.res,
    403,
    layout({
      user: ctx.user,
      title: titlu,
      active: "/comenzi",
      body: `${subnavComenzi("/proforme", ctx.user)}<h1>${esc(titlu)}</h1><p style="max-width:620px">${esc(text)}</p>
        <a class="btn secondary" href="/proforme">Înapoi la proforme</a>`,
    })
  );

function register(router) {
  // ---- Lista -----------------------------------------------------------------
  router.get("/proforme", async (ctx) => {
    const toti = peToti(ctx.user);
    const id = Number(ctx.user && ctx.user.id) || 0;
    const lista = await db
      .prepare(
        `SELECT f.* FROM proforme f LEFT JOIN parteneri p ON p.id = f.partener_id
          WHERE ${toti ? "1 = 1" : `(f.creat_de_id = ? OR f.agent_id = ? OR p.agent_id = ?
                 OR EXISTS (SELECT 1 FROM alocari_clienti ac WHERE ac.partener_id = f.partener_id AND ac.utilizator_id = ?))`}
          ORDER BY f.id DESC LIMIT 300`
      )
      .all(...(toti ? [] : patru(id)));
    const c = await contor();
    const q = ctx.query || {};
    const mesaj = q.ok ? `<div class="flash">${esc(q.ok)}</div>` : "";
    const eroare = q.eroare ? `<p style="color:var(--danger);max-width:760px" data-eroare>${esc(q.eroare)}</p>` : "";
    // Unde e SmartBill pe aceeași serie (lib/serii-smartbill.js).
    const SS = require("../lib/serii-smartbill");
    const stSb = SS.stare(c, await require("./punte-rute").seriaVazuta(db, "proforma"), "proforma");
    const blocSb = `<p data-smartbill-serie="${stSb.fel}" style="max-width:820px;font-size:13px;${
      stSb.fel === "in-urma" ? "border-left:4px solid var(--warn);padding:8px 12px;background:var(--surface-2,#faf7ef)" : "color:var(--text-muted)"
    }">${esc(stSb.text)}</p>`;

    const formContor = eAdmin(ctx.user)
      ? `<details style="margin-top:22px;max-width:760px">
           <summary style="cursor:pointer;font-weight:600">Seria și numărul următor (doar administratorul)</summary>
           <form method="post" action="/proforme/contor" class="form" style="margin-top:10px">
             <div style="display:grid;grid-template-columns:160px 200px auto;gap:12px;align-items:end">
               <label class="field"><span>Seria</span><input name="serie" value="${esc(c.serie)}" maxlength="10" required></label>
               <label class="field"><span>Următorul număr</span><input name="urmator" type="number" min="1" step="1" value="${esc(String(c.urmator))}" required></label>
               <div><button class="btn" type="submit">Salvează</button></div>
             </div>
             <p class="ajutor" style="margin-top:8px">Un singur șir de numere pentru toți cei care emit proforme. Dacă mai emiteți proforme și din
               SmartBill, folosiți aici altă serie decât acolo, ca numerele să nu se dubleze. Un număr deja folosit în seria aleasă nu se poate pune.</p>
           </form>
         </details>`
      : "";

    const body = `
      ${subnavComenzi("/proforme", ctx.user)}
      <h1>Proforme</h1>
      ${mesaj}${eroare}
      ${blocSb}
      <div class="toolbar">
        <a class="btn" href="/proforme/emite" data-emite-proforma>Emite proformă</a>
        <span style="color:var(--text-muted);font-size:13px;margin-left:8px">Următoarea proformă: <strong>${esc(c.serie)} ${esc(String(c.urmator))}</strong>
          · ${toti ? "vezi proformele tuturor" : "vezi proformele tale și ale clienților tăi"}</span>
      </div>
      ${
        lista.length
          ? table(
              ["Proformă", "Data", "Client", "Comanda", "Total", "Emisă de", "Stare"],
              lista.map((f) => [
                `<a href="/proforme/${f.id}" target="_blank" data-proforma="${f.id}"><strong>${esc(f.serie)} ${esc(String(f.numar))}</strong></a>`,
                esc(AV.dataAviz(f.data)),
                esc(f.client_nume || "—"),
                f.comanda_id ? `<a href="/comenzi/${f.comanda_id}">${esc(f.comanda_numar || "#" + f.comanda_id)}</a>` : esc(f.comanda_numar || "—"),
                `${esc(PF.bani(f.total))} ${esc(PF.SIMBOL[PF.moneda(f.moneda)])}`,
                esc(f.creat_de || "—"),
                Number(f.anulat) === 1 ? `<span class="badge rosu">anulată</span>` : `<span class="badge verde">emisă</span>`,
              ])
            )
          : `<p style="color:var(--text-muted)">Nicio proformă încă. Apasă „Emite proformă" și alege comanda, sau deschide comanda și apasă „Emite proformă" acolo.</p>`
      }
      ${formContor}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Proforme", active: "/comenzi", body }));
  });

  // ---- Meniul „Emite proformă": alegi comanda ---------------------------------
  router.get("/proforme/emite", async (ctx) => {
    const toti = peToti(ctx.user);
    const id = Number(ctx.user && ctx.user.id) || 0;
    const comenzi = await db
      .prepare(
        `SELECT c.id, c.numar, c.data, c.status, c.moneda, p.nume AS client, u.nume AS agent,
                COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total,
                (SELECT COUNT(*) FROM comenzi_linii cl WHERE cl.comanda_id = c.id) AS nr_linii,
                (SELECT f.id FROM proforme f WHERE f.comanda_id = c.id AND f.anulat = 0 ORDER BY f.id DESC LIMIT 1) AS pf_id,
                (SELECT f.serie || ' ' || f.numar FROM proforme f WHERE f.comanda_id = c.id AND f.anulat = 0 ORDER BY f.id DESC LIMIT 1) AS pf_nume
           FROM comenzi c JOIN parteneri p ON p.id = c.partener_id LEFT JOIN utilizatori u ON u.id = c.agent_id
          WHERE c.status <> 'anulata' AND ${toti ? "1 = 1" : SQL_A_LUI("c", "p")}
          ORDER BY c.id DESC LIMIT 300`
      )
      .all(...(toti ? [] : patru(id)));
    const q = ctx.query || {};
    const eroare = q.eroare ? `<p style="color:var(--danger);max-width:760px" data-eroare>${esc(q.eroare)}</p>` : "";
    const body = `
      ${subnavComenzi("/proforme/emite", ctx.user)}
      <h1>Emite proformă</h1>
      ${eroare}
      <p style="max-width:760px;color:var(--text-muted)">Alege comanda. Proforma ia din ea clientul, produsele, cantitățile, prețurile, moneda, termenul de plată
        și livrarea, primește numărul următor și se deschide gata de tipărit sau de salvat ca PDF.
        ${toti ? "Vezi comenzile tuturor." : "Vezi comenzile tale și ale clienților tăi."}</p>
      <div class="toolbar"><input type="search" id="cauta-comanda" placeholder="Caută după client sau număr de comandă…" style="max-width:420px;width:100%"></div>
      ${
        comenzi.length
          ? table(
              ["Comanda", "Data", "Client", "Agent", "Total fără TVA", "Proformă", ""],
              comenzi.map((c) => [
                `<a href="/comenzi/${c.id}"><strong>${esc(c.numar || "#" + c.id)}</strong></a>`,
                esc(String(c.data || "").slice(0, 10)),
                esc(c.client || "—"),
                esc(c.agent || "—"),
                `${esc(PF.bani(c.total))} ${esc(PF.SIMBOL[PF.moneda(c.moneda)])}`,
                c.pf_id ? `<a href="/proforme/${c.pf_id}" target="_blank">${esc(c.pf_nume)}</a>` : `<span style="color:var(--text-muted)">—</span>`,
                Number(c.nr_linii) > 0
                  ? `<form method="post" action="/comenzi/${c.id}/proforma" class="inline-form"><button class="btn" type="submit" data-emite="${c.id}">${c.pf_id ? "Emite din nou" : "Emite proformă"}</button></form>`
                  : `<span style="color:var(--text-muted);font-size:12px">comandă fără linii</span>`,
              ])
            )
          : `<p style="color:var(--text-muted)">Nicio comandă pe care să poți emite proformă. Scrie întâi comanda, din „Comandă nouă".</p>`
      }
      <script>
        (function () {
          var c = document.getElementById('cauta-comanda');
          if (!c) return;
          c.addEventListener('input', function () {
            var t = c.value.toLowerCase().trim();
            document.querySelectorAll('table tbody tr').forEach(function (r) {
              r.style.display = !t || r.textContent.toLowerCase().indexOf(t) !== -1 ? '' : 'none';
            });
          });
        })();
      </script>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Emite proformă", active: "/comenzi", body }));
  });

  // ---- Contorul (doar admin) -----------------------------------------------------
  router.post("/proforme/contor", async (ctx) => {
    const inapoi = (t) => redirect(ctx.res, "/proforme?eroare=" + encodeURIComponent(t));
    if (!eAdmin(ctx.user)) return inapoi("Doar administratorul poate schimba seria și numărul.");
    const serie = String(ctx.body.serie || "").trim().toUpperCase();
    const urmator = nr(ctx.body.urmator);
    if (!/^[A-Z0-9-]{1,10}$/.test(serie)) return inapoi("Seria: litere, cifre sau cratimă, cel mult 10.");
    if (!urmator) return inapoi("Următorul număr trebuie să fie un întreg mai mare ca 0.");
    const max = await db.prepare("SELECT MAX(numar) AS m FROM proforme WHERE serie = ?").get(serie);
    const ultim = Number((max && max.m) || 0);
    if (urmator <= ultim) return inapoi(`În seria ${serie} există deja proforme până la nr. ${ultim}. Următorul poate fi cel puțin ${ultim + 1}.`);
    const azi = aziRo();
    const pune = "INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?) ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, actualizat_la = EXCLUDED.actualizat_la";
    await db.prepare(pune).run("proforma_serie", serie, azi);
    await db.prepare(pune).run("proforma_urmator", String(urmator), azi);
    console.log(`[proforme] contor schimbat: ${serie} ${urmator} de ${ctx.user.nume}`);
    redirect(ctx.res, "/proforme?ok=" + encodeURIComponent(`Următoarea proformă va fi ${serie} ${urmator}.`));
  });

  // ---- Emiterea din comandă ---------------------------------------------------------
  router.post("/comenzi/:id/proforma", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const id = nr(ctx.params.id);
    if (!id) return redirect(ctx.res, "/comenzi");
    if (!(await poateEmite(ctx.user, id))) {
      return nuAiVoie(ctx, "Comanda nu e a unui client de-al tău", "Poți emite proforme pentru comenzile tale și ale clienților alocați ție. Pentru celelalte, vorbește cu agentul comenzii, cu financiarul sau cu administratorul.");
    }
    try {
      const r = await emite(id, ctx.user, { observatii: ctx.body && ctx.body.observatii });
      return redirect(ctx.res, `/proforme/${r.id}${r.existenta ? "?nou=0" : "?nou=1"}`);
    } catch (e) {
      console.error("[proforme] emitere:", e.message);
      return redirect(ctx.res, `/comenzi/${id}?eroare_proforma=` + encodeURIComponent(e.message));
    }
  });

  // ---- Foaia ------------------------------------------------------------------------
  router.get("/proforme/:id", async (ctx) => {
    const r = await citeste(ctx.params.id);
    if (!r) return send(ctx.res, 404, layout({ user: ctx.user, title: "Proformă inexistentă", active: "/comenzi", body: `<p>Proforma nu există.</p><a class="btn secondary" href="/proforme">Înapoi la proforme</a>` }));
    const { pf, linii } = r;
    if (!(await poateVedea(ctx.user, pf))) {
      return nuAiVoie(ctx, "Proforma altui client", "Poți deschide proformele tale și ale clienților alocați ție.");
    }
    const q = ctx.query || {};
    const anulat = Number(pf.anulat) === 1;
    const poateAnula = !anulat && (peToti(ctx.user) || Number(pf.creat_de_id) === Number(ctx.user && ctx.user.id));
    const bara = [
      q.eroare ? `<span class="eroare">${esc(q.eroare)}</span>` : "",
      q.nou === "1" ? `<strong>Proforma ${esc(pf.serie)} ${esc(String(pf.numar))} a fost emisă.</strong>` : "",
      q.nou === "0" ? `<strong>Comanda nu s-a schimbat: e aceeași proformă, ${esc(pf.serie)} ${esc(String(pf.numar))}.</strong>` : "",
      `<button onclick="window.print()">Tipărește</button>`,
      `<button onclick="window.print()" title="În fereastra de tipărire alege „Salvează ca PDF”">Descarcă PDF</button>`,
      pf.comanda_id ? `<a href="/comenzi/${pf.comanda_id}">Comanda ${esc(pf.comanda_numar || "")}</a>` : "",
      `<a href="/proforme">Toate proformele</a>`,
      poateAnula
        ? `<form method="post" action="/proforme/${pf.id}/anuleaza" style="display:inline" onsubmit="var m=prompt('De ce se anulează proforma? (numărul ei rămâne folosit)');if(!m||!m.trim())return false;this.motiv.value=m;return true;">
             <input type="hidden" name="motiv"><button type="submit">Anulează</button></form>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    send(ctx.res, 200, PF.pagina(pf, linii, { bara }));
  });

  // ---- Anularea ---------------------------------------------------------------------
  router.post("/proforme/:id/anuleaza", async (ctx) => {
    const r = await citeste(ctx.params.id);
    if (!r) return redirect(ctx.res, "/proforme");
    const { pf } = r;
    const mine = Number(pf.creat_de_id) === Number(ctx.user && ctx.user.id);
    if (!(peToti(ctx.user) || mine)) return redirect(ctx.res, `/proforme/${pf.id}?eroare=` + encodeURIComponent("O proformă o anulează cine a emis-o, financiarul sau administratorul."));
    const motiv = String((ctx.body && ctx.body.motiv) || "").trim().slice(0, 300);
    if (!motiv) return redirect(ctx.res, `/proforme/${pf.id}?eroare=` + encodeURIComponent("Scrie de ce se anulează."));
    await db
      .prepare("UPDATE proforme SET anulat = 1, motiv_anulare = ?, anulat_de = ?, anulat_la = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ? AND anulat = 0")
      .run(motiv, (ctx.user && ctx.user.nume) || null, pf.id);
    console.log(`[proforme] ${pf.serie} ${pf.numar} anulată de ${(ctx.user && ctx.user.nume) || "?"}: ${motiv}`);
    redirect(ctx.res, `/proforme/${pf.id}`);
  });
}

module.exports = { SQL_A_LUI, patru, peToti, register, emite, dinComanda, citeste, aleComenzii, poateEmite, poateVedea, contor, SERIE_IMPLICITA, URMATORUL_IMPLICIT };
