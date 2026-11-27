"use strict";
// Rețetele de fabricație: scrierea lor, cu istoric.
//
// CEREREA LUI VALI, 27.11.2026: „În producție, rețete: vreau să se poată adăuga
// rețetă nouă, să se poată modifica, dar să rămână istoric etc., să se poată
// alege rețeta la produs nou etc."
//
// CE ERA. Rețeta = rândurile din `retete_componente` (produs, componentă,
// cantitate pe o bucată). Se scria din cinci locuri (pagina rețetei, fișa
// produsului, importul din fișier, sincronizarea SmartBill), fiecare cu
// UPDATE-ul lui, și nicăieri nu rămânea ce fusese înainte. O cantitate greșită
// corectată de om era rescrisă la următoarea sincronizare din SmartBill.
//
// CE E ACUM. Orice schimbare de rețetă trece pe aici:
//   • `pune`, `scoate`, `copiaza` schimbă rândul ȘI scriu în `retete_istoric`
//     ce era, ce a rămas, cine, când și de unde (om, SmartBill, import, copiere);
//   • o rețetă schimbată de OM devine „ținută de mână"
//     (`produse.reteta_de_mana = 1`): importurile n-o mai ating, până când omul
//     îi dă voie din nou (`dezleaga`). Ce ar fi schimbat importul se numără, nu
//     se scrie.
//
// Istoricul nu se șterge. Din el se vede cum arăta rețeta la orice dată.
//
// Partea de sus e fără bază de date, ca să se poată verifica într-un test.

const EPS = 1e-9;
const PRAG_ISTORIC_IMPORT = 0.01;
const SURSE = { om: "scris de om", smartbill: "SmartBill", import: "import din fișier", copiere: "copiat din altă rețetă" };
const FELURI = { adaugat: "adăugat", modificat: "modificat", scos: "scos" };

const nr = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const acum = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19);
const scrisCantitate = (v) => (v == null ? "—" : Number(v).toLocaleString("ro-RO", { maximumFractionDigits: 9 }));

// Ce vine din formular pentru o componentă. Întoarce { ok, cantitate } sau { ok: false, eroare }.
function cantitateScrisa(v) {
  const n = nr(v);
  if (!Number.isFinite(n) || !(n > 0)) return { ok: false, eroare: "Scrie o cantitate mai mare ca zero (pe o bucată de produs finit)." };
  if (n > 1e9) return { ok: false, eroare: "Cantitatea e prea mare." };
  return { ok: true, cantitate: n };
}

// Ce s-ar schimba dacă rețeta `tinta` ar lua componentele din `sursa`.
//   sursa, tinta: [{ componenta_id, cantitate }]
//   inlocuieste: true = rețeta țintă devine exact sursa (ce are în plus se scoate)
// Întoarce [{ fel, componenta_id, veche, noua }]. Produsul țintă nu intră în propria rețetă.
function planCopiere(sursa, tinta, { inlocuieste, tintaId } = {}) {
  const are = new Map((tinta || []).map((r) => [Number(r.componenta_id), Number(r.cantitate)]));
  const plan = [];
  const dinSursa = new Set();
  for (const r of sursa || []) {
    const c = Number(r.componenta_id);
    if (!c || c === Number(tintaId)) continue;
    dinSursa.add(c);
    const noua = Number(r.cantitate);
    if (!(noua > 0)) continue;
    if (!are.has(c)) plan.push({ fel: "adaugat", componenta_id: c, veche: null, noua });
    else if (Math.abs(are.get(c) - noua) > EPS) plan.push({ fel: "modificat", componenta_id: c, veche: are.get(c), noua });
  }
  if (inlocuieste) for (const [c, veche] of are) if (!dinSursa.has(c)) plan.push({ fel: "scos", componenta_id: c, veche, noua: null });
  return plan;
}

// ---- cu bază ---------------------------------------------------------------

async function numeComponenta(db, id) {
  const p = await db.prepare("SELECT denumire, COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod FROM produse WHERE id = ?").get(id).catch(() => null);
  return p ? `${p.denumire || "#" + id}${p.cod ? " [" + p.cod + "]" : ""}` : "#" + id;
}

async function scrieIstoric(db, { produsId, componentaId, fel, veche, noua, sursa, nota, user }) {
  await db
    .prepare(
      `INSERT INTO retete_istoric (produs_id, componenta_id, componenta_nume, fel, cantitate_veche, cantitate_noua, sursa, nota, utilizator_id, utilizator_nume, la)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(produsId, componentaId, await numeComponenta(db, componentaId), fel, veche == null ? null : veche, noua == null ? null : noua, sursa || "om", nota || null, user ? user.id || null : null, user ? user.nume || user.email || null : null, acum());
}

// Rețeta e ținută de mână? (importurile n-o ating)
async function eDeMana(db, produsId) {
  const p = await db.prepare("SELECT COALESCE(reteta_de_mana, 0) AS m FROM produse WHERE id = ?").get(produsId).catch(() => null);
  return Boolean(p && Number(p.m) === 1);
}
async function marcheazaDeMana(db, produsId, user) {
  await db
    .prepare("UPDATE produse SET reteta_de_mana = 1, reteta_de_mana_la = ?, reteta_de_mana_de = ? WHERE id = ? AND COALESCE(reteta_de_mana, 0) = 0")
    .run(acum(), user ? user.nume || user.email || null : null, produsId)
    .catch(() => null);
}

// Pune o componentă în rețetă (o adaugă sau îi schimbă cantitatea).
//   sursa: „om" (din pagină), „smartbill", „import", „copiere"
// Întoarce { schimbat: „adaugat" | „modificat" | null, sarit: true când rețeta e ținută de mână și sursa e un import }.
async function pune({ produsId, componentaId, cantitate, sursa, nota, user }) {
  const db = require("./db");
  const P = Number(produsId), C = Number(componentaId), q = Number(cantitate);
  const s = sursa || "om";
  if (!P || !C || P === C || !(q > 0)) return { schimbat: null };
  const dinAfara = s === "smartbill" || s === "import";
  const existent = await db.prepare("SELECT id, cantitate FROM retete_componente WHERE produs_id = ? AND componenta_id = ?").get(P, C);
  if (existent && Math.abs(Number(existent.cantitate) - q) <= Math.max(EPS, Math.abs(q) * 1e-7)) return { schimbat: null };
  if (dinAfara && (await eDeMana(db, P))) return { schimbat: null, sarit: true };
  if (existent) await db.prepare("UPDATE retete_componente SET cantitate = ? WHERE id = ?").run(q, existent.id);
  else await db.prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)").run(P, C, q);
  const fel = existent ? "modificat" : "adaugat";
  // Sincronizarea din SmartBill reface rețeta ca medie pe toate bonurile, deci
  // cantitatea se mișcă puțin la fiecare bon nou. Mișcările sub 1% se scriu în
  // rețetă, dar nu umplu istoricul.
  const marunt = dinAfara && existent && Math.abs(Number(existent.cantitate) - q) < Math.abs(Number(existent.cantitate)) * PRAG_ISTORIC_IMPORT;
  if (!marunt) await scrieIstoric(db, { produsId: P, componentaId: C, fel, veche: existent ? Number(existent.cantitate) : null, noua: q, sursa: s, nota, user });
  if (!dinAfara) await marcheazaDeMana(db, P, user);
  return { schimbat: fel };
}

async function scoate({ produsId, componentaId, sursa, nota, user }) {
  const db = require("./db");
  const P = Number(produsId), C = Number(componentaId);
  const existent = await db.prepare("SELECT id, cantitate FROM retete_componente WHERE produs_id = ? AND componenta_id = ?").get(P, C);
  if (!existent) return { schimbat: null };
  await db.prepare("DELETE FROM retete_componente WHERE id = ?").run(existent.id);
  await scrieIstoric(db, { produsId: P, componentaId: C, fel: "scos", veche: Number(existent.cantitate), noua: null, sursa: sursa || "om", nota, user });
  await marcheazaDeMana(db, P, user);
  return { schimbat: "scos" };
}

// Copiază rețeta unui produs pe altul. Întoarce { ok, schimbari } sau { ok: false, eroare }.
async function copiaza({ dinId, inId, inlocuieste, user }) {
  const db = require("./db");
  const D = Number(dinId), I = Number(inId);
  if (!D || !I) return { ok: false, eroare: "Alege produsul de la care se ia rețeta." };
  if (D === I) return { ok: false, eroare: "Rețeta nu se poate copia de la același produs." };
  const sursaP = await db.prepare("SELECT id, denumire FROM produse WHERE id = ?").get(D);
  if (!sursaP) return { ok: false, eroare: "Produsul de la care se ia rețeta nu mai există." };
  const sursa = await db.prepare("SELECT componenta_id, cantitate FROM retete_componente WHERE produs_id = ?").all(D);
  if (!sursa.length) return { ok: false, eroare: `„${sursaP.denumire}” n-are rețetă: nu e nimic de copiat.` };
  const tinta = await db.prepare("SELECT componenta_id, cantitate FROM retete_componente WHERE produs_id = ?").all(I);
  const plan = planCopiere(sursa, tinta, { inlocuieste: Boolean(inlocuieste), tintaId: I });
  const nota = `din rețeta produsului „${sursaP.denumire}”`;
  for (const x of plan) {
    if (x.fel === "scos") await scoate({ produsId: I, componentaId: x.componenta_id, sursa: "copiere", nota, user });
    else await pune({ produsId: I, componentaId: x.componenta_id, cantitate: x.noua, sursa: "copiere", nota, user });
  }
  if (plan.length) await marcheazaDeMana(db, I, user);
  return { ok: true, schimbari: plan.length, dinNume: sursaP.denumire };
}

// Omul dă voie din nou importului să refacă rețeta.
async function dezleaga({ produsId, user }) {
  const db = require("./db");
  await db.prepare("UPDATE produse SET reteta_de_mana = 0, reteta_de_mana_la = NULL, reteta_de_mana_de = NULL WHERE id = ?").run(Number(produsId));
  await db
    .prepare("INSERT INTO retete_istoric (produs_id, componenta_id, componenta_nume, fel, sursa, nota, utilizator_id, utilizator_nume, la) VALUES (?, NULL, NULL, 'dezlegat', 'om', ?, ?, ?, ?)")
    .run(Number(produsId), "rețeta poate fi refăcută din nou de importul din SmartBill", user ? user.id || null : null, user ? user.nume || null : null, acum());
}

async function istoric(produsId, limita) {
  const db = require("./db");
  return await db
    .prepare("SELECT * FROM retete_istoric WHERE produs_id = ? ORDER BY id DESC LIMIT " + (Number(limita) > 0 ? Math.min(Number(limita), 1000) : 300))
    .all(Number(produsId))
    .catch(() => []);
}

module.exports = { SURSE, FELURI, cantitateScrisa, planCopiere, scrisCantitate, pune, scoate, copiaza, dezleaga, eDeMana, istoric };
