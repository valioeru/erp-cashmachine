"use strict";
// „Stoc la zi" pe produse și rezervările agenților (Vali, 09.11.2026):
//
//   „o pagină la agenții de vânzări și nu numai cu stoc la zi … stocul de
//    produse finite, materii prime etc. din depozit, cu filtre pe categorii …
//    marcate produsele ce sunt comandate și urmează să ajungă în stoc, inclusiv
//    data, sau cele care sunt în producție … la fiecare produs agenții să poată
//    rezerva pentru 3 zile, obligatoriu cu nume client, cantitate … să nu poată
//    rezerva pentru clienții cu facturi restante … rezervat de agentul Y pentru
//    clientul X … dacă nu se pune comanda, se eliberează automat după cele 3
//    zile … doar admin-ul sau un agent poate debloca rezervarea înainte, cu un
//    motiv ce se va putea vedea ulterior în produse rezervate și nefructificate"
//   „asta cu stocul să fie în Depozit, în principal, și userii să aibă acces la
//    această pagină, nu la tot depozitul."
//
// Pe baza Postgres locală (port 5433), cu paginile adevărate, plus Chromium
// pentru butonul „Rezervă" și căsuța de client.
const fs = require("fs");
const path = require("path");
const qs = require("querystring");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, { PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp" });
const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
function csv(t) {
  const R = []; let c = "", r = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n") { r.push(c); R.push(r); r = []; c = ""; }
    else if (ch !== "\r") c += ch;
  }
  if (c !== "" || r.length) { r.push(c); R.push(r); }
  return R;
}
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  // Niciun email nu pleacă din test.
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});
const auth = require(path.join(RAD, "lib", "auth.js"));
const render = require(path.join(RAD, "lib", "render.js"));
const SP = require(path.join(RAD, "lib", "stoc-produse.js"));
const RA = require(path.join(RAD, "lib", "rezervari-agenti.js"));
const SLZ = require(path.join(RAD, "modules", "stoc-la-zi.js"));

const rute = { get: {}, post: {} };
const reg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; } };
SLZ.register(reg);
require(path.join(RAD, "modules", "ct-park.js")).register(reg);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { query, body, params } = {}) {
  const r = res();
  let h = rute[metoda][cale];
  let par = params || {};
  if (!h) {
    for (const [tipar, fn] of Object.entries(rute[metoda])) {
      const re = new RegExp("^" + tipar.replace(/:[^/]+/g, "([^/]+)") + "$");
      const m = re.exec(cale);
      if (m) {
        const nume = (tipar.match(/:[^/]+/g) || []).map((x) => x.slice(1));
        par = Object.fromEntries(nume.map((n, i) => [n, m[i + 1]]));
        h = fn;
        break;
      }
    }
  }
  if (!h) throw new Error("nicio rută pentru " + metoda + " " + cale);
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase() } });
  return r;
}
const unde = (r) => decodeURIComponent(String((r.antet && r.antet.Location) || "")).replace(/\+/g, " ");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
function egal(descriere, a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  bine(descriere + " = " + y, x === y, x);
}

// ---- oamenii ------------------------------------------------------------
const ADMIN = { id: 1, nume: "Vali Test", rol: "admin", sectiuni: "" };
const AG1 = { id: 98921, nume: "Agent Unu", rol: "vanzari", sectiuni: "/crm" };
const AG2 = { id: 98922, nume: "Agent Doi", rol: "vanzari", sectiuni: "" };
const DEPOZIT = { id: 98923, nume: "Om Depozit", rol: "depozit", sectiuni: "/depozit" };
const FINANCIAR = { id: 98924, nume: "Om Financiar", rol: "financiar", sectiuni: "/financiar" };
const PRODUCTIE = { id: 98925, nume: "Om Productie", rol: "productie", sectiuni: "/productie" };

// ---- datele de test ------------------------------------------------------
const P_A = 98901, P_B = 98902, P_C = 98903, P_D = 98904, P_E = 98905;
const C_OK = 98911, C_RESTANT = 98912, C_ALT = 98913, F_1 = 98914, C_X = 98915;
const CF1 = 98931, CF2 = 98932;
const CP1 = 98941, CP2 = 98942, CP3 = 98943, CP4 = 98944, CP5 = 98945;
const R1 = 98951, R2 = 98952, R3 = 98953;
const P_G = 98907, CP6 = 98946;
const P_H = 98908, R4 = 98954;
// Finalizările parțiale (10.11.2026): un produs făcut de trei comenzi de producție.
const P_I = 98909, CPP1 = 98961, CPP2 = 98962, CPP3 = 98963, CPP4 = 98964;
const R5 = 98955, R6 = 98956, R7 = 98957, R8 = 98958, R9 = 98959, R10 = 98960, R11 = 98961;
const FURNIZOR_SECRET = "TSR Furnizorul Secret SRL";

function curata() {
  const paleti = q("SELECT id FROM ct_paleti WHERE cod LIKE 'TSR-%'").map((r) => Number(r.id));
  if (paleti.length) {
    const l = paleti.join(",");
    q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${l}))`);
    q(`DELETE FROM ct_iesiri WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_ocupari WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_paleti WHERE id IN (${l})`);
  }
  q("DELETE FROM rezervari_agenti WHERE produs_id BETWEEN 98901 AND 98909 OR partener_id BETWEEN 98911 AND 98919");
  q("DELETE FROM receptii_linii WHERE receptie_id BETWEEN 98951 AND 98961");
  q("DELETE FROM receptii WHERE id BETWEEN 98951 AND 98961");
  q("DELETE FROM miscari_stoc WHERE produs_id BETWEEN 98901 AND 98909");
  q("DELETE FROM comenzi_productie_linii WHERE comanda_id BETWEEN 98941 AND 98949 OR comanda_id BETWEEN 98961 AND 98969");
  q("DELETE FROM comenzi_productie WHERE id BETWEEN 98941 AND 98949 OR id BETWEEN 98961 AND 98969");
  q("DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 98911 AND 98919)");
  q("DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 98911 AND 98919)");
  q("DELETE FROM comenzi WHERE partener_id BETWEEN 98911 AND 98919");
  q("DELETE FROM comenzi_furnizor_linii WHERE comanda_id BETWEEN 98931 AND 98939");
  q("DELETE FROM comenzi_furnizor WHERE id BETWEEN 98931 AND 98939");
  q("DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 98911 AND 98919)");
  q("DELETE FROM facturi WHERE partener_id BETWEEN 98911 AND 98919");
  q("DELETE FROM interactiuni WHERE partener_id BETWEEN 98911 AND 98919");
  q("DELETE FROM produse WHERE id BETWEEN 98901 AND 98909");
  q("DELETE FROM alias_parteneri WHERE partener_id BETWEEN 98911 AND 98919");
  q("DELETE FROM parteneri WHERE id BETWEEN 98911 AND 98919");
}

let nrPalet = 0;
function palet({ produs, cant, um, categorie, lot, furnizor_text, receptie, iesit, data }) {
  nrPalet++;
  const id = Number(q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, categorie, lot, data_intrare, data_iesire, furnizor_text, receptie_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ["TSR-" + nrPalet, produs, cant, um, categorie || null, lot || null, data || "2026-11-02", iesit || null, furnizor_text || null, receptie || null])[0].id);
  q("INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um, lot) VALUES (?, ?, ?, ?, ?)", [id, produs, cant, um, lot || null]);
  return id;
}
function comanda(partener, status, linii) {
  const id = Number(q("INSERT INTO comenzi (partener_id, numar, status) VALUES (?, ?, ?) RETURNING id", [partener, "TSR-" + Math.random().toString(36).slice(2, 7), status])[0].id);
  q("UPDATE comenzi SET numar = ? WHERE id = ?", ["CMD-TSR-" + id, id]);
  for (const [produs, cant, um] of linii) {
    q("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (?, ?, ?, 1, ?)", [id, produs, cant, um || null]);
  }
  return id;
}

function pregateste() {
  curata();
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, categorie, activ) VALUES
      (${P_A}, 'TSR-A', 'TSR Folie A', 'kg', 'Folie stretch', 1),
      (${P_B}, 'TSR-B', 'TSR Cutie B', 'buc', 'Cutii', 1),
      (${P_C}, 'TSR-C', 'TSR Granule C', 'kg', 'Granule', 1),
      (${P_D}, 'TSR-D', 'TSR Sac D', 'buc', 'Saci', 1),
      (${P_E}, 'TSR-E', 'TSR Banda E', 'rola', 'Benzi', 1)`);
  q(`INSERT INTO parteneri (id, tip, nume) VALUES
      (${C_OK}, 'client', 'TSR Client Bun SRL'),
      (${C_RESTANT}, 'client', 'TSR Client Restant SRL'),
      (${C_ALT}, 'ambele', 'TSR Client Alt SRL'),
      (${F_1}, 'furnizor', 'TSR Furnizor Comandat SRL'),
      (${C_X}, 'client', 'TSR Client Productie SRL')`);

  // Factura trecută de scadență a clientului restant (scadențarul e viu de la 23.10.2026).
  const fr = Number(q(`INSERT INTO facturi (partener_id, directie, status, data_emiterii, data_scadenta, activ, intercompany)
      VALUES (${C_RESTANT}, 'vanzare', 'emisa', '2026-10-25', '2026-10-30', 1, 0) RETURNING id`)[0].id);
  q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${fr}, 'test', 1, 100, 21)`);
  // Clientul bun are o factură, dar încă nescadentă: nu e restanță.
  const fb = Number(q(`INSERT INTO facturi (partener_id, directie, status, data_emiterii, data_scadenta, activ, intercompany)
      VALUES (${C_OK}, 'vanzare', 'emisa', '2026-11-05', '2099-12-31', 1, 0) RETURNING id`)[0].id);
  q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${fb}, 'test', 1, 500, 21)`);

  // P_A: 200 kg pe doi paleți, plus unul ieșit întreg pe comanda O1.
  palet({ produs: P_A, cant: 120, um: "kg", categorie: "materie primă", lot: "L-A1", furnizor_text: FURNIZOR_SECRET, data: "2026-11-01" });
  palet({ produs: P_A, cant: 80, um: "kg", categorie: "materie primă", lot: "L-A2", data: "2026-11-03" });
  // P_B: 100 buc, scris o dată „bucata", o dată „buc".
  palet({ produs: P_B, cant: 60, um: "bucata", categorie: "produse finite", lot: "L-B1" });
  palet({ produs: P_B, cant: 40, um: "buc", categorie: "produse finite", lot: "L-B2" });
  // P_E: 7 role, și 2 kg scrise greșit în altă unitate.
  palet({ produs: P_E, cant: 7, um: "rola", categorie: "consumabile" });
  palet({ produs: P_E, cant: 2, um: "kg", categorie: "consumabile" });
  // Un palet vechi, fără linii (de dinainte de liniile pe palet): intră cu
  // coloanele lui, ca în vederea pe paleți.
  q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, categorie, data_intrare) VALUES ('TSR-VECHI', ${P_E}, 3, 'role', 'consumabile', '2026-10-01')`);

  // O1: comanda deschisă a lui C_ALT, 70 kg din P_A. Au ieșit 20 kg parțial
  // și un palet întreg de 10 kg; 15 kg se mai produc pentru ea.
  const O1 = comanda(C_ALT, "in_stoc_depozit", [[P_A, 50, "kg"], [P_A, 20, "kg"]]);
  const pPartial = Number(q("SELECT id FROM ct_paleti WHERE cod = 'TSR-1'")[0].id);
  const iesP = Number(q(`INSERT INTO ct_iesiri (palet_id, destinatie, comanda_id, data, partiala) VALUES (${pPartial}, 'client', ${O1}, '2026-11-04', 1) RETURNING id`)[0].id);
  q(`INSERT INTO ct_iesiri_linii (iesire_id, produs_id, cantitate, um) VALUES (${iesP}, ${P_A}, 20, 'kg')`);
  const pIntreg = palet({ produs: P_A, cant: 10, um: "kg", categorie: "materie primă", iesit: "2026-11-04" });
  q(`INSERT INTO ct_iesiri (palet_id, destinatie, comanda_id, data) VALUES (${pIntreg}, 'client', ${O1}, '2026-11-04')`);
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, data_livrare, comanda_id)
      VALUES (${CP1}, 'CP-TSR-1', 'in_productie', ${P_A}, '15', 'kg', '2026-11-12', ${O1})`);
  // Comenzile închise nu contează.
  comanda(C_ALT, "anulata", [[P_A, 500, "kg"]]);
  comanda(C_ALT, "livrata", [[P_A, 500, "kg"]]);
  comanda(C_ALT, "ciorna", [[P_A, 500, "kg"]]);
  // O comandă pentru ceva ce nu e nici pe stoc, nici în drum, nu face rând.
  q("INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (98906, 'TSR-F', 'TSR Doar Cerut', 'buc', 1)");
  comanda(C_ALT, "noua", [[98906, 5, "buc"]]);

  // Comenzi la furnizor: CF1 trimisă (60 kg rămase din P_A, 300 kg P_C), CF2 ciornă.
  q(`INSERT INTO comenzi_furnizor (id, numar, furnizor_id, data_solicitata, status) VALUES
      (${CF1}, 'CF-TSR-1', ${F_1}, '2026-11-18', 'trimisa'), (${CF2}, 'CF-TSR-2', ${F_1}, '2026-11-15', 'ciorna')`);
  q(`INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, cantitate_primita, um) VALUES
      (${CF1}, ${P_A}, 'TSR Folie A', 100, 40, 'kg'),
      (${CF1}, ${P_C}, 'TSR Granule C', 300, 0, 'kg'),
      (${CF2}, ${P_A}, 'TSR Folie A', 999, 0, 'kg')`);

  // P_D: făcut în producția CP2 pentru C_X (fără comandă în ERP), intrat în
  // depozit; C_X are și o comandă de 30.
  q(`INSERT INTO receptii (id, numar, sursa, comanda_productie_id, stare) VALUES (${R1}, 'REC-TSR-1', 'productie', ${CP2}, 'finalizata')`);
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, partener_id, trimisa_depozit_la, receptie_id)
      VALUES (${CP2}, 'CP-TSR-2', 'finalizata', ${P_D}, '50', 'buc', ${C_X}, '2026-11-05', ${R1})`);
  palet({ produs: P_D, cant: 50, um: "buc", categorie: "produse finite", receptie: R1 });
  comanda(C_X, "noua", [[P_D, 30, "buc"]]);

  // P_G: rămas din producția comenzii lui C_ALT, care s-a livrat deja. Producția
  // cu comandă în ERP nu face marfă „dedicată": o ține comanda cât e deschisă,
  // iar după livrare ce a rămas e liber.
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${P_G}, 'TSR-G', 'TSR Folie G', 'buc', 1)`);
  const OG = comanda(C_ALT, "livrata", [[P_G, 100, "buc"]]);
  q(`INSERT INTO receptii (id, numar, sursa, comanda_productie_id, stare) VALUES (${R3}, 'REC-TSR-3', 'productie', ${CP6}, 'finalizata')`);
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, partener_id, comanda_id, trimisa_depozit_la, receptie_id)
      VALUES (${CP6}, 'CP-TSR-6', 'finalizata', ${P_G}, '120', 'buc', ${C_ALT}, ${OG}, '2026-11-06', ${R3})`);
  palet({ produs: P_G, cant: 20, um: "buc", categorie: "produse finite", receptie: R3 });

  // P_H: recepție finalizată de 12 buc, din care 5 puse pe un palet; 7 încă
  // n-au raft, dar sunt în depozit.
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${P_H}, 'TSR-H', 'TSR Receptionat H', 'buc', 1)`);
  q(`INSERT INTO receptii (id, numar, sursa, partener_id, stare, finalizata_la) VALUES (${R4}, 'REC-TSR-4', 'furnizor', ${F_1}, 'finalizata', '2026-11-08 10:00:00')`);
  const rl = Number(q(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie)
      VALUES (${R4}, ${P_H}, 12, 12, 'buc', 'primita', 'bun') RETURNING id`)[0].id);
  const pH = palet({ produs: P_H, cant: 5, um: "buc", categorie: "produse finite", receptie: R4 });
  q(`UPDATE ct_paleti SET receptie_linie_id = ${rl} WHERE id = ${pH}`);
  // Producția scrisă „de gură" pentru C_X se scade din comanda lui: o dată după
  // nume („S.C. … S.R.L."), o dată după aliasul pus de om. Un nume pe care îl
  // poartă doi parteneri nu se leagă de niciunul.
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (98916, 'client', 'TSR Dublu SRL'), (98917, 'client', 'TSR Dublu S.A.')`);
  q(`INSERT INTO alias_parteneri (alias, partener_id) VALUES ('TSR Poreclă', ${C_X})`);
  comanda(C_X, "noua", [[P_H, 10, "buc"]]);
  comanda(98916, "noua", [[P_H, 2, "buc"]]);
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, client_text) VALUES
      (98947, 'CP-TSR-7', 'noua', ${P_H}, '4', 'buc', 'S.C. TSR Client Productie S.R.L.'),
      (98948, 'CP-TSR-8', 'noua', ${P_H}, '3', 'buc', 'TSR Porecla'),
      (98949, 'CP-TSR-9', 'noua', ${P_H}, '2', 'buc', 'TSR Dublu')`);
  // Un rând respins nu intră în stoc.
  q(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie)
      VALUES (${R4}, ${P_H}, 3, 3, 'buc', 'primita', 'deteriorat')`);

  // P_C: în producție pentru stoc (fără client), cu linii; 1.250,5 kg.
  q(`INSERT INTO comenzi_productie (id, numar, status, data_propusa) VALUES (${CP3}, 'CP-TSR-3', 'noua', '2026-11-25')`);
  q(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um) VALUES (${CP3}, ${P_C}, 'TSR Granule C', '1.250,5', 'kg')`);
  // CP4: din registrul vechi, finalizată și netrimisă în depozit — nu „intră".
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um) VALUES (${CP4}, 'CP-TSR-4', 'finalizata', ${P_C}, '777', 'kg')`);
  // CP5: gata, trimisă în depozit, recepția încă așteaptă; pentru C_X.
  q(`INSERT INTO receptii (id, numar, sursa, comanda_productie_id, stare) VALUES (${R2}, 'REC-TSR-2', 'productie', ${CP5}, 'asteptata')`);
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, partener_id, trimisa_depozit_la, receptie_id, data_livrare)
      VALUES (${CP5}, 'CP-TSR-5', 'finalizata', ${P_C}, '40', 'kg', ${C_X}, '2026-11-08', ${R2}, '2026-11-10')`);

  // P_I: finalizări parțiale. Ce a intrat deja în depozit e stoc; „urmează să
  // intre" doar ce n-a fost încă preluat.
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${P_I}, 'TSR-I', 'TSR Partial I', 'buc', 1)`);
  const receptie = (id, cp, stare, partiala, cant, primit, linieStare, conditie) => {
    q(`INSERT INTO receptii (id, numar, sursa, comanda_productie_id, stare, partiala, finalizata_la)
        VALUES (${id}, 'REC-TSR-${id}', 'productie', ${cp}, '${stare}', ${partiala}, ${stare === "finalizata" ? "'2026-11-09 10:00:00'" : "NULL"})`);
    q(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie)
        VALUES (${id}, ${P_I}, ${cant}, ${primit === null ? "NULL" : primit}, 'buc', '${linieStare || (primit === null ? "de_primit" : "primita")}', '${conditie || "bun"}')`);
  };
  // CPP1, în lucru, „1,000" buc (virgulă la mii, ca în registru): producția a
  // anunțat 300, depozitul a primit 320 (Vali, 10.11.2026: „se salvează
  // cantitatea din recepție"); alte 200 așteaptă preluarea. Mai vin 680 — nici
  // 1.000, nici 700. O trimitere primită deteriorată (60) și una respinsă, cu
  // cantitatea rămasă scrisă pe ea (40), n-au intrat: tot de făcut rămân.
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, data_propusa) VALUES (${CPP1}, 'CP-TSR-P1', 'in_productie', ${P_I}, '1,000', 'buc', '2026-11-20')`);
  receptie(R5, CPP1, "finalizata", 1, 300, 320);
  receptie(R6, CPP1, "asteptata", 1, 200, null);
  receptie(R10, CPP1, "finalizata", 1, 60, 60, "primita", "deteriorat");
  receptie(R11, CPP1, "finalizata", 1, 40, 40, "respinsa", "bun");
  // CPP2, finalizată, 500 buc: totul a plecat pe o recepție parțială, deja
  // preluată; „Finalizată" n-a mai deschis alta. Nu mai vine nimic.
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, trimisa_depozit_la) VALUES (${CPP2}, 'CP-TSR-P2', 'finalizata', ${P_I}, '500', 'buc', '2026-11-09')`);
  receptie(R7, CPP2, "finalizata", 1, 500, 500);
  // CPP3, finalizată, 400 buc: restul (250) a fost preluat, dar o finalizare
  // parțială de 150 încă așteaptă. Mai vin 150.
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, trimisa_depozit_la, receptie_id) VALUES (${CPP3}, 'CP-TSR-P3', 'finalizata', ${P_I}, '400', 'buc', '2026-11-09', ${R8})`);
  receptie(R8, CPP3, "finalizata", 0, 250, 250);
  receptie(R9, CPP3, "asteptata", 1, 150, null);
  // CPP4: pornită dintr-o cerere a depozitului, cu cantitatea scrisă de ERP
  // („847.625", cu punct la zecimale), la kg: sunt 847,625 kg, nu 847.625.
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, data_propusa) VALUES (${CPP4}, 'CP-TSR-P4', 'noua', ${P_C}, '847.625', 'kg', '2026-11-28')`);
}

const rand = (randuri, id) => randuri.find((r) => r.produs_id === id) || null;
const fara = (s) => String(s || "").replace(/<script[\s\S]*?<\/script>/g, "");

(async () => {
  // ------------------------------------------------------------------------
  console.log("\n1. Socoteala, fără bază de date");
  {
    egal("unitățile: buc/bucată/Buc./pcs sunt aceeași", ["buc", "bucata", "Bucăți", "Buc.", "pcs", "Rolă", "role", "KG", "m"].map(SP.normUm), ["buc", "buc", "buc", "buc", "buc", "rola", "rola", "kg", "m"]);
    // Citirea e cea comună (lib/cantitate-text.js, cu testul ei): „67,200" și
    // „26.148" sunt mii, ca în registru; la kg punctul urmat de trei cifre e
    // zecimală, fiindcă așa scrie ERP-ul cantitățile cerute de depozit.
    egal("cantitățile scrise ca text", ["240", "2,5", "1.250,5", "26.148", "67,200", "360 (331)", "12 buc", "", "x", 7].map((v) => SP.numarText(v)), [240, 2.5, 1250.5, 26148, 67200, 360, 12, 0, 0, 7]);
    egal("…cu unitatea: la kg „847.625” rămâne zecimală, la buc sunt mii", [SP.numarText("847.625", "kg"), SP.numarText("847.625", "buc"), SP.numarText("67,200", "kg")], [847.625, 847625, 67200]);
    egal("cât mai vine dintr-o comandă: comandat minus ce a intrat deja", [SP.ramasDeVenit(1000, 300), SP.ramasDeVenit(1000, undefined), SP.ramasDeVenit(100, 250), SP.ramasDeVenit(0, 50)], [700, 1000, 0, 0]);
    egal("ora României (noiembrie: UTC+2), ca text comparabil", [RA.oraRo(new Date("2026-11-09T22:30:05Z")), RA.oraRo(new Date("2026-07-01T10:00:00Z"))], ["2026-11-10 00:30:05", "2026-07-01 13:00:00"]);
    egal("producția în drum", [
      { status: "noua" }, { status: "in_productie" }, { status: "anulata" },
      { status: "finalizata" }, { status: "finalizata", trimisa_depozit_la: "2026-11-01", receptie_id: 1, receptie_stare: "asteptata" },
      { status: "finalizata", trimisa_depozit_la: "2026-11-01", receptie_id: 1, receptie_stare: "finalizata" },
      { status: "facturata", trimisa_depozit_la: "2026-11-01", cerere_stare: "gata" },
      { status: "facturata", trimisa_depozit_la: "2026-11-01", cerere_stare: "primita" },
    ].map(SP.productiaInDrum), [true, true, false, false, true, false, true, false]);
    egal("producția în drum, cu finalizări parțiale", [
      // restul a fost preluat, dar o recepție parțială încă așteaptă
      { status: "finalizata", trimisa_depozit_la: "2026-11-09", receptie_id: 1, receptie_stare: "finalizata", receptii_deschise: 1, receptii_preluate: 1 },
      // totul a plecat pe recepții parțiale, toate preluate; nu există cerere a depozitului
      { status: "finalizata", trimisa_depozit_la: "2026-11-09", receptii_deschise: 0, receptii_preluate: 2 },
      // totul a plecat pe recepții parțiale, una încă așteaptă
      { status: "finalizata", trimisa_depozit_la: "2026-11-09", receptii_deschise: 1, receptii_preluate: 1 },
      // în lucru, cu o parte deja în depozit: restul tot vine
      { status: "in_productie", receptii_deschise: 0, receptii_preluate: 1 },
    ].map(SP.productiaInDrum), [true, false, true, true]);

    const produse = new Map([[1, { denumire: "Unu", cod: "U1", unitate_masura: "kg" }], [2, { denumire: "Doi", unitate_masura: "buc" }]]);
    const r = SP.construieste({
      produse,
      linii: [
        { produs_id: 1, um: "kg", cantitate: 100, palet_id: 1, categorie: "materie primă" },
        { produs_id: 1, um: "kg", cantitate: 40, palet_id: 2, categorie: "materie primă", cp_id: 9, cp_numar: "CP9", cp_client_id: 77, cp_client: "Client 77" },
        { produs_id: 2, um: "buc", cantitate: 10, palet_id: 3 },
      ],
      comenzi: [
        { comanda_id: 5, numar: "C5", partener_id: 77, client: "Client 77", produs_id: 1, cantitate: 25, um: "kg" },
        { comanda_id: 6, numar: "C6", partener_id: 88, client: "Client 88", produs_id: 1, cantitate: 30, um: "kg" },
        { comanda_id: 6, numar: "C6", partener_id: 88, client: "Client 88", produs_id: 1, cantitate: 10, um: "kg" },
      ],
      iesite: [{ comanda_id: 6, produs_id: 1, cantitate: 5 }],
      productie: [{ cp_id: 10, numar: "CP10", status: "in_productie", produs_id: 1, cantitate: 12, um: "kg", client_id: 88, client: "Client 88", data: "2026-11-20" }],
      rezervari: [{ id: 1, produs_id: 1, partener_id: 99, client: "Client 99", agent: "Ag", cantitate: 20, um: "kg", expira_la: "2026-11-12 10:00:00" }],
    });
    const u = rand(r, 1);
    // Client 77: comanda 25, făcut pentru el 40 → 40. Client 88: 40 − 5 ieșit − 12 în lucru = 23.
    egal("promisul pe clienți: max(comandă, făcut pentru el) + comandă − ieșit − în producție", [u.stoc, u.promis, u.promisPe.map((p) => [p.client, p.cantitate, p.facutPentru])], [140, 63, [["Client 77", 40, true], ["Client 88", 23, false]]]);
    egal("disponibil = stoc − promis − rezervat", [u.rezervat, u.disponibil, u.stare], [20, 57, "Rezervat parțial"]);
    egal("producția pentru un client nu e „liber în drum”", [u.inDrum, u.inDrumClienti, u.sosire], [0, 12, "2026-11-20"]);
    egal("produsul fără nimic pe el: disponibil", [rand(r, 2).disponibil, rand(r, 2).stare], [10, "Disponibil"]);
    const peste = SP.construieste({ produse, linii: [{ produs_id: 2, um: "buc", cantitate: 10 }], rezervari: [{ id: 2, produs_id: 2, cantitate: 8, um: "buc" }], comenzi: [{ comanda_id: 7, partener_id: 5, produs_id: 2, cantitate: 6, um: "buc" }] });
    egal("promis și rezervat peste stoc: disponibil 0, cu depășirea spusă", [rand(peste, 2).disponibil, rand(peste, 2).depasit, rand(peste, 2).stare], [0, 4, "Rezervat integral"]);
    const promisTot = SP.construieste({ produse, linii: [{ produs_id: 2, um: "buc", cantitate: 10 }], comenzi: [{ comanda_id: 7, partener_id: 5, produs_id: 2, cantitate: 10, um: "buc" }] });
    egal("totul promis, nimic rezervat", rand(promisTot, 2).stare, "Promis integral");
    const altaUm = SP.construieste({ produse, linii: [{ produs_id: 1, um: "kg", cantitate: 10 }, { produs_id: 1, um: "buc", cantitate: 3 }], comenzi: [{ comanda_id: 8, partener_id: 5, produs_id: 1, cantitate: 2, um: "buc" }] });
    egal("altă unitate: separat, fără să intre în cifre", [rand(altaUm, 1).um, rand(altaUm, 1).stoc, rand(altaUm, 1).alteUm, rand(altaUm, 1).promis], ["kg", 10, [{ um: "buc", cantitate: 3 }], 0]);
    const doarComanda = SP.construieste({ produse, comenzi: [{ comanda_id: 9, partener_id: 5, produs_id: 2, cantitate: 4 }] });
    egal("o comandă singură nu face rând de stoc", doarComanda.length, 0);
    const vine = SP.construieste({ produse, furnizor: [{ cf_id: 3, numar: "CF3", produs_id: 2, cantitate: 10, cantitate_primita: 4, um: "buc", data_solicitata: "2026-11-30", furnizor: "F" }] });
    egal("doar în drum: „Urmează să intre”, fără furnizor pentru cine nu-l vede", [rand(vine, 2).stare, rand(vine, 2).inDrum, rand(vine, 2).intrari[0].furnizor], ["Urmează să intre", 6, ""]);
    const vineTot = SP.construieste({ vedeTot: true, produse, furnizor: [{ cf_id: 3, numar: "CF3", produs_id: 2, cantitate: 10, cantitate_primita: 4, um: "buc", furnizor: "F" }] });
    egal("…iar cine are Depozitul vede furnizorul", rand(vineTot, 2).intrari[0].furnizor, "F");
    egal("textul scurt din căutarea de pe comandă", [
      SP.textScurt({ stoc: 1200, disponibil: 1050, um: "buc" }).text, SP.textScurt({ stoc: 7, disponibil: 7, um: "rola" }).text,
      SP.textScurt({ stoc: 50, disponibil: 0, um: "buc" }).text, SP.textScurt({ stoc: 0, inDrum: 300, um: "kg", sosireLiber: "2026-11-18" }).text,
      SP.textScurt({ stoc: 0, inDrum: 0 }).text,
    ], ["stoc 1.200 buc · liber 1.050", "stoc 7 rola", "stoc 50 buc · tot promis sau rezervat", "fără stoc · vin 300 kg pe 18.11", "fără stoc în CT-Park"]);
    egal("numele de firmă, curățat ca la alocări", ["S.C. TSR Client S.R.L.", "Delivery Solutions SA", "TSR Poreclă"].map(SP.normNume), ["tsrclient", "deliverysolutions", "tsrporecla"]);
  }

  // ------------------------------------------------------------------------
  console.log("\n2. Cine deschide pagina (toți) și ce nu deschide (restul Depozitului)");
  {
    const PAGINI = ["/stocuri/ct-park/stoc", "/stocuri/ct-park/stoc/rezervari", "/stocuri/ct-park/stoc/rezerva", "/stocuri/ct-park/stoc/rezervari/12/elibereaza"];
    const OPRITE = ["/stocuri/ct-park", "/stocuri/ct-park/intrare", "/stocuri/ct-park/tot", "/stocuri/ct-park/stoc/export.xlsx",
      "/stocuri/ct-park/stoc/altceva", "/stocuri/ct-park/stoc/rezervari/x/elibereaza", "/stocuri/ct-park/stoc/rezervari/12", "/stocuri/ct-park/iesire", "/depozit"];
    for (const [cine, u] of [["agentul", AG1], ["agentul fără bife", AG2], ["financiarul", FINANCIAR], ["producția", PRODUCTIE]]) {
      bine(`${cine}: deschide stocul, rezervările, rezervarea și eliberarea`, PAGINI.every((p) => auth.poateAccesa(u, p)), PAGINI.filter((p) => !auth.poateAccesa(u, p)).join(", "));
      bine(`${cine}: nimic altceva din Depozit`, OPRITE.every((p) => !auth.poateAccesa(u, p)), OPRITE.filter((p) => auth.poateAccesa(u, p)).join(", "));
      const dep = render.navPentru(u).find((x) => x.label === "Depozit");
      bine(`${cine}: butonul „Depozit” îl duce la „Stoc la zi”`, dep && dep.href === "/stocuri/ct-park/stoc", JSON.stringify(dep));
    }
    bine("depozitul și administratorul au tot, ca înainte", [DEPOZIT, ADMIN].every((u) => PAGINI.concat(OPRITE.slice(0, 4)).every((p) => auth.poateAccesa(u, p))));
    bine("fără utilizator nu se deschide nimic", !auth.poateAccesa(null, "/stocuri/ct-park/stoc"));
    egal("rezervă: agenții și administratorul", [ADMIN, AG1, AG2, DEPOZIT, FINANCIAR, PRODUCTIE].map(RA.poateRezerva), [true, true, true, false, false, false]);
    egal("eliberează: administratorul și agentul rezervării", [ADMIN, AG1, AG2, DEPOZIT].map((u) => RA.poateElibera(u, { utilizator_id: AG1.id })), [true, true, false, false]);
    egal("întoarcerea după formular rămâne pe paginile de stoc", ["/stocuri/ct-park/stoc?tip=x", "/stocuri/ct-park/stoc/rezervari?stare=toate", "https://rau.example/", "//rau.example", "/admin", "/stocuri/ct-park/stocuri"].map(SLZ.inapoiSigur),
      ["/stocuri/ct-park/stoc?tip=x", "/stocuri/ct-park/stoc/rezervari?stare=toate", "/stocuri/ct-park/stoc", "/stocuri/ct-park/stoc", "/stocuri/ct-park/stoc", "/stocuri/ct-park/stoc"]);
    egal("mesajul înlocuiește mesajul vechi", SLZ.cuMesaj("/stocuri/ct-park/stoc?q=a b&eroare=vechi&tip=x", "ok", "gata & bine"), "/stocuri/ct-park/stoc?q=a+b&tip=x&ok=gata+%26+bine");
  }

  // ------------------------------------------------------------------------
  console.log("\n3. Stocul din bază, pe produse");
  pregateste();
  let toate = await SP.citeste({ vedeTot: false });
  {
    const a = rand(toate, P_A);
    egal("P_A: stoc, paleți, categoria, loturile", [a.stoc, a.um, a.paleti, a.tip, a.loturi], [200, "kg", 2, "materie primă", ["L-A1", "L-A2"]]);
    // O1: 70 kg − 20 ieșit parțial − 10 ieșit cu paletul întreg − 15 în producție pentru ea = 25.
    egal("P_A: promis pe comanda deschisă, după ieșiri și producția ei", [a.promis, a.promisPe.map((p) => [p.client, p.cantitate, p.comenzi.length])], [25, [["TSR Client Alt SRL", 25, 1]]]);
    egal("P_A: comenzile anulate, livrate și ciornele nu contează; disponibil", [a.disponibil, a.stare], [175, "Disponibil"]);
    egal("P_A: în drum — 60 kg de la furnizor (ciorna nu), 15 kg producție pentru client", [a.inDrum, a.inDrumClienti, a.sosire, a.intrari.map((i) => [i.fel, i.cantitate, i.document, i.data])],
      [60, 15, "2026-11-12", [["productie", 15, "CP-TSR-1", "2026-11-12"], ["furnizor", 60, "CF-TSR-1", "2026-11-18"]]]);
    egal("P_A: furnizorul nu apare la agent (nici pe palet, nici pe comandă)", [a.furnizori, a.intrari.map((i) => i.furnizor)], [[], ["", ""]]);
    const b = rand(toate, P_B);
    egal("P_B: „bucata” și „buc” se adună", [b.stoc, b.um, b.paleti, b.alteUm], [100, "buc", 2, []]);
    const c = rand(toate, P_C);
    egal("P_C: nimic pe stoc, urmează să intre (furnizor + producție pe stoc + gata de preluat pentru client)",
      [c.stoc, c.stare, c.inDrum, c.inDrumClienti, c.intrari.map((i) => [i.fel, i.cantitate, i.liber, i.client])],
      [0, "Urmează să intre", 2398.125, 40, [["productie", 40, false, "TSR Client Productie SRL"], ["furnizor", 300, true, ""], ["productie", 1250.5, true, ""], ["productie", 847.625, true, ""]]]);
    bine("P_C: producția veche, netrimisă în depozit, nu intră", !c.intrari.some((i) => i.document === "CP-TSR-4"));
    const pi = rand(toate, P_I);
    egal("P_I: ce a intrat pe finalizări parțiale e stoc (320 primite + 500 + 250), fără palet încă", [pi.stoc, pi.um], [1070, "buc"]);
    egal("P_I: mai vine restul până la comandă, socotit din ce a primit depozitul — 680 din comanda în lucru, 150 din cea finalizată",
      [pi.inDrum, pi.intrari.map((i) => [i.fel, i.cantitate, i.document]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))],
      [830, [["productie", 680, "CP-TSR-P1"], ["productie", 150, "CP-TSR-P3"]]]);
    bine("P_I: comanda plecată toată pe recepții parțiale preluate nu mai „urmează să intre”", !pi.intrari.some((i) => i.document === "CP-TSR-P2"));
    const d = rand(toate, P_D);
    egal("P_D: făcut pentru C_X (50) + comanda lui (30) = 50 promis, nu 80", [d.stoc, d.promis, d.disponibil, d.stare, d.promisPe.map((p) => [p.client, p.cantitate, p.facutPentru, p.productii])],
      [50, 50, 0, "Promis integral", [["TSR Client Productie SRL", 50, true, ["CP-TSR-2"]]]]);
    const e = rand(toate, P_E);
    egal("P_E: unitatea scrisă greșit stă deoparte; paletul vechi, fără linii, intră", [e.stoc, e.um, e.alteUm, e.paleti, e.prima_intrare], [10, "rola", [{ um: "kg", cantitate: 2 }], 3, "2026-10-01"]);
    bine("produsul doar cerut pe o comandă nu apare", !rand(toate, 98906));
    const hh = rand(toate, P_H);
    egal("P_H: recepționat și încă fără raft intră în stoc (deteriorat nu)", [hh.stoc, hh.dePus, hh.paleti], [12, 7, 1]);
    // C_X: 10 comandate − 4 (după nume) − 3 (după alias) = 3; TSR Dublu SRL: 2,
    // fără scădere (numele „TSR Dublu" e al a doi parteneri).
    egal("P_H: producția „de gură” se leagă de client după nume și alias", [hh.promis, hh.disponibil, hh.promisPe.map((x) => [x.client, x.cantitate])],
      [5, 7, [["TSR Client Productie SRL", 3], ["TSR Dublu SRL", 2]]]);
    const g = rand(toate, P_G);
    egal("P_G: ce a rămas din producția unei comenzi livrate e liber, nu „făcut pentru client”", [g.stoc, g.promis, g.disponibil, g.stare], [20, 0, 20, "Disponibil"]);
    const admin = await SP.citeste({ vedeTot: true });
    egal("cine are Depozitul vede furnizorul paletului și al comenzii", [rand(admin, P_A).furnizori, rand(admin, P_A).intrari.map((i) => i.furnizor)], [[FURNIZOR_SECRET], ["", "TSR Furnizor Comandat SRL"]]);
  }

  // ------------------------------------------------------------------------
  console.log("\n4. Pagina, văzută de agent, de depozit și de financiar");
  {
    const r = await cer("get", "/stocuri/ct-park/stoc", AG1);
    const h = fara(r.corp);
    bine("se deschide", r.cod === 200, r.cod);
    bine("e vederea pe produse, cu legătură spre cea pe paleți", h.includes("<strong>Pe produse</strong>") && h.includes('href="/stocuri/ct-park/stoc?vedere=paleti"'));
    bine("are produsele de test, cu stocul și disponibilul", h.includes("TSR Folie A") && h.includes("200 kg") && h.includes("175 kg") && h.includes("TSR Granule C"));
    bine("marchează ce urmează să intre, cu data", h.includes("comandat la furnizor") && h.includes("sosește 18.11.2026") && h.includes("în producție") && h.includes("termen 12.11.2026"));
    bine("producția pentru un client spune pentru cine", h.includes("pentru TSR Client Productie SRL") && h.includes("gata în producție, de preluat în depozit"));
    bine("promisul spune clientul și comanda", h.includes("TSR Client Alt SRL: 25 kg") && /href="\/comenzi\/\d+">CMD-TSR-\d+</.test(h));
    bine("agentul nu vede furnizorii", !h.includes(FURNIZOR_SECRET) && !h.includes("TSR Furnizor Comandat SRL"));
    bine("agentul are butonul „Rezervă” pe produse, inactiv unde nu e nimic liber",
      /data-rezerva[\s\S]{0,80}data-produs="98902"[\s\S]{0,200}>Rezervă</.test(h) && /data-produs="98904"[^>]*disabled/.test(h) && !/data-produs="98904"[^>]*>Rezervă<\/button>[^]*?data-produs="98904"/.test(h));
    bine("are panoul de rezervare, cu clientul obligatoriu", h.includes('id="panou-rezervare"') && h.includes("client-obligatoriu") && r.corp.includes("__alegeClient"));
    bine("clientul restant e marcat în lista de clienți", r.corp.includes("TSR Client Restant SRL") && /Clientul are întârzieri la plată/.test(r.corp));
    bine("furnizorii nu sunt în lista de clienți", r.corp.includes("TSR Client Alt SRL") && !r.corp.includes("TSR Furnizor Comandat SRL"));
    bine("filtre ca în Excel pe capul tabelului", h.includes('data-filtre="stoc-la-zi"'));
    bine("filtrele de categorie, cu numărul de produse", /class="subnav-link activ"[^>]*>Toate/.test(h) && h.includes("materie primă <span") && h.includes("produse finite <span"));
    bine("submeniul: „Stoc la zi” și „Rezervări”", (() => { const t = (h.match(/<div class="subnav"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ""; return [...t.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]).join("|") === "Stoc la zi|Rezervări"; })());
    bine("„+ Intrare marfă” la vedere, inactiv", /<button type="button" class="btn secondary" disabled[^>]*>\+ Intrare marfă<\/button>/.test(h));
    bine("niciun link spre hartă, intrare sau palet", !/href="\/stocuri\/ct-park(\/intrare[^"]*|\/palet\/\d+|\/tot)?"/.test(h));
    bine("nicio cifră stricată", !/NaN|undefined/.test(h));

    const lot = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { q: "l-a2" } })).corp);
    bine("căutarea după lot merge", lot.includes("TSR Folie A") && !lot.includes("TSR Cutie B"));
    const furn = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { q: "Furnizorul Secret" } })).corp);
    bine("căutarea după furnizor nu merge la agent", !furn.includes("TSR Folie A"));
    const furnAdmin = fara((await cer("get", "/stocuri/ct-park/stoc", ADMIN, { query: { q: "Furnizorul Secret" } })).corp);
    bine("…dar merge la administrator", furnAdmin.includes("TSR Folie A"));
    const tip = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { q: "tsr", tip: "produse finite" } })).corp);
    bine("filtrul de categorie", tip.includes("TSR Cutie B") && tip.includes("TSR Sac D") && !tip.includes("TSR Folie A"));
    const intra = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { q: "tsr", arata: "intra" } })).corp);
    bine("„Urmează să intre”", intra.includes("TSR Granule C") && intra.includes("TSR Folie A") && !intra.includes("TSR Cutie B"));
    const promis = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { q: "tsr", arata: "promis" } })).corp);
    bine("„Promise pe comenzi”", promis.includes("TSR Sac D") && promis.includes("TSR Folie A") && !promis.includes("TSR Cutie B"));

    const dep = fara((await cer("get", "/stocuri/ct-park/stoc", DEPOZIT)).corp);
    bine("depozitul: vede furnizorii, n-are butonul „Rezervă”", dep.includes(FURNIZOR_SECRET) && dep.includes("TSR Furnizor Comandat SRL") && !/data-rezerva/.test(dep) && !dep.includes('id="panou-rezervare"'));
    bine("depozitul: „+ Intrare marfă” activ", dep.includes('<a class="btn secondary" href="/stocuri/ct-park/intrare">+ Intrare marfă</a>'));
    const fin = fara((await cer("get", "/stocuri/ct-park/stoc", FINANCIAR)).corp);
    bine("financiarul: vede stocul, fără furnizori și fără „Rezervă”", fin.includes("TSR Folie A") && !fin.includes(FURNIZOR_SECRET) && !/data-rezerva/.test(fin));

    const pal = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { vedere: "paleti", q: "TSR" } })).corp);
    bine("vederea pe paleți rămâne, cu lotul, și cu drum înapoi", pal.includes("L-A1") && pal.includes("<strong>Pe paleți</strong>") && pal.includes('name="vedere" value="paleti"') && !pal.includes(FURNIZOR_SECRET));
  }

  // ------------------------------------------------------------------------
  console.log("\n5. Rezervarea: reguli");
  const rezerva = async (u, body) => {
    const r = await cer("post", "/stocuri/ct-park/stoc/rezerva", u, { body: Object.assign({ inapoi: "/stocuri/ct-park/stoc?q=tsr" }, body) });
    return { cod: r.cod, loc: unde(r) };
  };
  const activa = () => q(`SELECT * FROM rezervari_agenti WHERE produs_id BETWEEN 98901 AND 98909 ORDER BY id`);
  {
    let x = await rezerva(FINANCIAR, { produs_id: P_B, partener_id: C_OK, cantitate: "5" });
    bine("financiarul nu rezervă", x.cod === 302 && /eroare=Rezervările le fac agenții/.test(x.loc) && activa().length === 0, x.loc);
    x = await rezerva(AG1, { produs_id: P_B, partener_id: "", cantitate: "5" });
    bine("fără client: refuzat", /eroare=Alege clientul/.test(x.loc), x.loc);
    for (const v of ["", "0", "abc", "-3", "1.234,5"]) {
      x = await rezerva(AG1, { produs_id: P_B, partener_id: C_OK, cantitate: v });
      bine(`cantitatea „${v}”: refuzată`, /eroare=Scrie cantitatea/.test(x.loc), x.loc);
    }
    x = await rezerva(AG1, { produs_id: P_B, partener_id: F_1, cantitate: "5" });
    bine("pe un furnizor: refuzat", /eroare=Clientul ales nu e în lista de clienți/.test(x.loc), x.loc);
    x = await rezerva(AG2, { produs_id: P_B, partener_id: C_RESTANT, cantitate: "5" });
    bine("clientul cu facturi restante: refuzat, cu suma și zilele", /eroare=Nu se poate rezerva pentru TSR Client Restant SRL: are facturi restante\. 121,00 lei cu scadența depășită/.test(x.loc) && activa().length === 0, x.loc);
    x = await rezerva(AG1, { produs_id: P_B, partener_id: C_OK, cantitate: "100,5" });
    bine("peste ce e liber: refuzat, cu cât se poate", /eroare=Se pot rezerva cel mult 100 buc din TSR Cutie B/.test(x.loc), x.loc);
    x = await rezerva(AG1, { produs_id: P_D, partener_id: C_OK, cantitate: "1" });
    bine("nimic liber: refuzat", /eroare=Din TSR Sac D nu e nimic liber de rezervat acum/.test(x.loc), x.loc);

    const maxComanda = Number(unul("SELECT COALESCE(MAX(id),0) FROM comenzi"));
    x = await rezerva(AG1, { produs_id: P_B, partener_id: C_OK, cantitate: "30,5", observatii: "vine joi" });
    const [z] = activa();
    bine("agentul rezervă: mesaj și întoarcere pe pagina de unde a plecat", x.cod === 302 && /^\/stocuri\/ct-park\/stoc\?q=tsr&ok=Rezervat 30,5 buc din TSR Cutie B pentru TSR Client Bun SRL, până la \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\.$/.test(x.loc), x.loc);
    egal("rezervarea scrisă", [Number(z.produs_id), Number(z.partener_id), Number(z.cantitate), z.um, z.stare, Number(z.utilizator_id), z.utilizator_nume, z.observatii, Number(z.comanda_maxima)],
      [P_B, C_OK, 30.5, "buc", "activa", AG1.id, "Agent Unu", "vine joi", maxComanda]);
    const ore = (Date.parse(z.expira_la.replace(" ", "T")) - Date.parse(z.creata_la.replace(" ", "T"))) / 3600000;
    bine("ține 3 zile (72 de ore), în ora României", ore === 72 && z.creata_la.slice(0, 13) === RA.acum().slice(0, 13), `${z.creata_la} → ${z.expira_la}`);

    toate = await SP.citeste({ vedeTot: false });
    egal("stocul se schimbă: rezervat 30,5, liber 69,5, „Rezervat parțial”", [rand(toate, P_B).rezervat, rand(toate, P_B).disponibil, rand(toate, P_B).stare], [30.5, 69.5, "Rezervat parțial"]);
    const pag = fara((await cer("get", "/stocuri/ct-park/stoc", AG2, { query: { q: "tsr cutie" } })).corp);
    bine("pagina spune „rezervat de agentul Y pentru clientul X”, cu termenul", /rezervat de agentul <strong>Agent Unu<\/strong> pentru clientul <strong>TSR Client Bun SRL<\/strong>: 30,5 buc, până la \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(pag) && pag.includes("vine joi"));
    bine("alt agent nu are „Eliberează” pe rezervarea colegului", !pag.includes("/elibereaza"));
    const pag1 = fara((await cer("get", "/stocuri/ct-park/stoc", AG1, { query: { q: "tsr cutie" } })).corp);
    bine("agentul ei are „Eliberează”, cu motiv obligatoriu", pag1.includes(`action="/stocuri/ct-park/stoc/rezervari/${z.id}/elibereaza"`) && /name="motiv" required/.test(pag1));

    x = await rezerva(AG2, { produs_id: P_B, partener_id: C_ALT, cantitate: "70" });
    bine("al doilea agent: doar cât a rămas liber", /eroare=Se pot rezerva cel mult 69,5 buc/.test(x.loc), x.loc);
    x = await rezerva(AG2, { produs_id: P_B, partener_id: C_ALT, cantitate: "9.5" });
    bine("al doilea agent rezervă (cu punct zecimal)", /ok=Rezervat 9,5 buc din TSR Cutie B pentru TSR Client Alt SRL/.test(x.loc), x.loc);

    // Doi agenți pe aceeași marfă, în aceeași clipă: niciodată peste stoc.
    const [a1, a2] = await Promise.all([
      RA.rezerva({ produs_id: P_B, partener_id: C_OK, cantitate: "50" }, AG1),
      RA.rezerva({ produs_id: P_B, partener_id: C_ALT, cantitate: "50" }, AG2),
    ]);
    toate = await SP.citeste({ vedeTot: false });
    bine("două rezervări simultane pe ultimele 60: cel puțin una refuzată, stocul nu e depășit",
      [a1, a2].some((y) => !y.ok) && rand(toate, P_B).depasit === 0 && rand(toate, P_B).rezervat <= 100, JSON.stringify([a1, a2, rand(toate, P_B).rezervat]));
    const retrase = q("SELECT id FROM rezervari_agenti WHERE stare = 'anulata' AND produs_id = " + P_B);
    bine("rezervarea retrasă rămâne scrisă, cu motivul", [a1, a2].filter((y) => !y.ok).length === retrase.length || retrase.length === 0);
    q("DELETE FROM rezervari_agenti WHERE stare = 'anulata' OR (stare = 'activa' AND cantitate = 50 AND produs_id = " + P_B + ")");
  }

  // ------------------------------------------------------------------------
  console.log("\n6. Eliberarea înainte de termen");
  {
    const z1 = q(`SELECT id FROM rezervari_agenti WHERE utilizator_id = ${AG1.id} AND stare = 'activa' AND produs_id = ${P_B}`)[0].id;
    const z2 = q(`SELECT id FROM rezervari_agenti WHERE utilizator_id = ${AG2.id} AND stare = 'activa' AND produs_id = ${P_B}`)[0].id;
    const elib = async (u, id, motiv) => unde(await cer("post", `/stocuri/ct-park/stoc/rezervari/${id}/elibereaza`, u, { body: { motiv, inapoi: "/stocuri/ct-park/stoc/rezervari" } }));
    let l = await elib(AG2, z1, "vreau eu marfa");
    bine("alt agent nu poate elibera", /eroare=O rezervare o poate elibera înainte de termen doar agentul care a făcut-o sau un administrator/.test(l), l);
    l = await elib(DEPOZIT, z1, "motiv bun");
    bine("nici depozitul", /eroare=O rezervare o poate elibera/.test(l), l);
    l = await elib(AG1, z1, "  ");
    bine("fără motiv: refuzat", /eroare=Scrie motivul eliberării/.test(l), l);
    egal("…și rezervarea a rămas activă", unul(`SELECT stare FROM rezervari_agenti WHERE id = ${z1}`), "activa");
    l = await elib(AG1, z1, "clientul a amânat comanda");
    bine("agentul ei o eliberează, cu motiv", /^\/stocuri\/ct-park\/stoc\/rezervari\?ok=Rezervarea a fost eliberată/.test(l), l);
    egal("scris: eliberată, cine, motivul", Object.values(q(`SELECT stare, inchisa_de, motiv FROM rezervari_agenti WHERE id = ${z1}`)[0]), ["eliberata", "Agent Unu", "clientul a amânat comanda"]);
    l = await elib(AG1, z1, "din nou");
    bine("a doua oară: nu mai e activă", /eroare=Rezervarea nu mai e activă: eliberată înainte de termen/.test(l), l);
    l = await elib(ADMIN, z2, "comanda vine pe alt cod");
    bine("administratorul eliberează rezervarea oricui", /ok=Rezervarea a fost eliberată/.test(l), l);
    l = await elib(ADMIN, 98999999, "x y z");
    bine("rezervare inexistentă", /eroare=Rezervarea nu există/.test(l), l);
    toate = await SP.citeste({ vedeTot: false });
    egal("marfa e din nou liberă", [rand(toate, P_B).rezervat, rand(toate, P_B).disponibil], [0, 100]);
  }

  // ------------------------------------------------------------------------
  console.log("\n7. Fructificarea și expirarea");
  {
    const veche = comanda(C_OK, "noua", [[P_B, 3, "buc"]]); // pusă ÎNAINTE de rezervare
    let x = await rezerva(AG1, { produs_id: P_B, partener_id: C_OK, cantitate: "10" });
    const zf = Number(q(`SELECT id FROM rezervari_agenti WHERE stare = 'activa' AND produs_id = ${P_B} ORDER BY id DESC`)[0].id);
    x = await rezerva(AG1, { produs_id: P_A, partener_id: C_OK, cantitate: "5" });
    const ze = Number(q(`SELECT id FROM rezervari_agenti WHERE stare = 'activa' AND produs_id = ${P_A} ORDER BY id DESC`)[0].id);
    await RA.actualizeaza();
    egal("comanda de dinainte nu fructifică", unul(`SELECT stare FROM rezervari_agenti WHERE id = ${zf}`), "activa");
    comanda(C_OK, "anulata", [[P_B, 10, "buc"]]);
    comanda(C_ALT, "noua", [[P_B, 10, "buc"]]);
    comanda(C_OK, "noua", [[P_C, 10, "kg"]]);
    comanda(C_OK, "ciorna", [[P_B, 10, "buc"]]);
    await RA.actualizeaza();
    egal("nici cea anulată, nici a altui client, nici alt produs, nici ciorna", unul(`SELECT stare FROM rezervari_agenti WHERE id = ${zf}`), "activa");
    const buna = comanda(C_OK, "noua", [[P_C, 1, "kg"], [P_B, 10, "buc"]]);
    // Nimeni nu apasă nimic: prima deschidere a paginii o pune la zi.
    const pag = fara((await cer("get", "/stocuri/ct-park/stoc", AG2, { query: { q: "tsr cutie" } })).corp);
    egal("comanda clientului cu produsul o fructifică", Object.values(q(`SELECT stare, comanda_id FROM rezervari_agenti WHERE id = ${zf}`)[0]).map(String), ["fructificata", String(buna)]);
    bine("…și nu mai apare ca rezervare pe stoc", !pag.includes("rezervat de agentul"));
    void veche;

    q(`UPDATE rezervari_agenti SET expira_la = '2026-01-01 00:00:00' WHERE id = ${ze}`);
    const lista = await RA.lista("nefructificate");
    egal("după 3 zile fără comandă: expirată, cu ora expirării", Object.values(q(`SELECT stare, inchisa_la FROM rezervari_agenti WHERE id = ${ze}`)[0]), ["expirata", "2026-01-01 00:00:00"]);
    egal("raportul „Nefructificate”: expirate și eliberate", lista.randuri.filter((r) => Number(r.produs_id) >= 98901 && Number(r.produs_id) <= 98909).map((r) => r.stare).sort(), ["eliberata", "eliberata", "expirata"]);

    const rap = fara((await cer("get", "/stocuri/ct-park/stoc/rezervari", FINANCIAR, { query: { stare: "nefructificate" } })).corp);
    bine("raportul se deschide pentru oricine, cu motivele", rap.includes("Rezervări de stoc") && rap.includes("clientul a amânat comanda") && rap.includes("comanda vine pe alt cod") && rap.includes("3 zile fără comandă") && rap.includes("de Agent Unu"));
    bine("taburile au numărul lor", /class="subnav-link activ">Nefructificate <span[^>]*>\(\d+\)<\/span>/.test(rap) && /Fructificate <span[^>]*>\(\d+\)/.test(rap));
    bine("raportul are filtre ca în Excel", rap.includes('data-filtre="rezervari-agenti"'));
    const fr = fara((await cer("get", "/stocuri/ct-park/stoc/rezervari", AG1, { query: { stare: "fructificate" } })).corp);
    bine("„Fructificate” arată comanda", fr.includes(`href="/comenzi/${buna}"`) && fr.includes("fructificată"));
    const act = fara((await cer("get", "/stocuri/ct-park/stoc/rezervari", AG1)).corp);
    bine("implicit: active (niciuna acum)", /class="subnav-link activ">Active/.test(act) && act.includes("Niciun rând încă."));
  }

  // ------------------------------------------------------------------------
  console.log("\n7b. Comanda vede stocul din CT-Park (Vali, comanda #70: „scrie că are stoc, dar apare cu lipsă”)");
  {
    const W = require(path.join(RAD, "modules", "warehouse.js"));
    // Tabela veche nu mai e stocul nimănui: 1000 buc scrise acolo nu contează.
    q(`INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate) VALUES (${P_B}, (SELECT MIN(id) FROM depozite), 'intrare', 1000)`);
    const st = await W.stocPeProduse();
    egal("stocul comenzii = CT-Park (+ recepționat fără raft), fără paleții ieșiți", [st.get(P_B), st.get(P_H), st.get(P_C) || 0, st.get(P_A)], [100, 12, 0, 200]);
    q(`DELETE FROM rezervari_agenti WHERE produs_id BETWEEN 98901 AND 98909 AND stare = 'activa'`);
    let x = await rezerva(AG1, { produs_id: P_B, partener_id: C_OK, cantitate: "20" });
    bine("rezervarea agentului pentru C_OK", /ok=Rezervat 20 buc/.test(x.loc), x.loc);
    const oAlt = comanda(C_ALT, "noua", [[P_B, 90, "buc"], [P_H, 12, "buc"]]);
    const pa = await W.potrivire(oAlt);
    const lb = pa.linii.find((l) => Number(l.produs_id) === P_B);
    const lh = pa.linii.find((l) => Number(l.produs_id) === P_H);
    egal("comanda altui client: rezervarea lui C_OK e blocată, restul acoperit", [lb.fizic, lb.blocat, lb.acoperit, lb.lipsa, lh.acoperit, pa.acoperiteTot], [100, 20, 80, 10, 12, false]);
    const oOk = comanda(C_OK, "noua", [[P_B, 90, "buc"]]);
    const po = await W.potrivire(oOk);
    egal("comanda clientului cu rezervarea: rezervarea lui nu-l oprește", [po.linii[0].blocat, po.linii[0].acoperit, po.acoperiteTot], [0, 90, true]);
    egal("…iar comanda lui fructifică rezervarea", unul(`SELECT stare FROM rezervari_agenti WHERE produs_id = ${P_B} AND partener_id = ${C_OK} ORDER BY id DESC LIMIT 1`), "fructificata");
    // O rezervare a clientului rămasă activă (o ciornă nu o fructifică) nu-i
    // oprește nici ciorna, nici altă comandă a lui.
    q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${oAlt}, ${oOk})`);
    q(`DELETE FROM comenzi WHERE id IN (${oAlt}, ${oOk})`);
    x = await rezerva(AG1, { produs_id: P_B, partener_id: C_OK, cantitate: "20" });
    bine("încă o rezervare pentru C_OK", /ok=Rezervat 20 buc/.test(x.loc), x.loc);
    const oCiorna = comanda(C_OK, "ciorna", [[P_B, 90, "buc"]]);
    const pc = await W.potrivire(oCiorna);
    egal("rezervarea proprie nu blochează (rămâne activă)", [pc.linii[0].blocat, pc.linii[0].acoperit, unul(`SELECT stare FROM rezervari_agenti WHERE produs_id = ${P_B} AND partener_id = ${C_OK} ORDER BY id DESC LIMIT 1`)], [0, 90, "activa"]);
    q(`DELETE FROM comenzi_linii WHERE comanda_id = ${oCiorna}`);
    q(`DELETE FROM comenzi WHERE id = ${oCiorna}`);
    q(`DELETE FROM rezervari_agenti WHERE produs_id = ${P_B} AND stare = 'activa'`);
    egal("căutarea de pe comandă: textul scurt de sub produs", [SP.textScurt(rand(await SP.citeste({}), P_B)).text, SP.textScurt(rand(await SP.citeste({}), P_C)).text, SP.textScurt(null).text],
      [rand(await SP.citeste({}), P_B).disponibil > 0 ? `stoc 100 buc · liber ${rand(await SP.citeste({}), P_B).disponibil.toLocaleString("ro-RO")}` : "stoc 100 buc · tot promis sau rezervat", "fără stoc · vin 2.398,125 kg pe 18.11", "fără stoc în CT-Park"]);
    q(`DELETE FROM miscari_stoc WHERE produs_id = ${P_B}`);
    // Comenzile de aici pleacă: partea din browser se uită la același produs.
    q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${oAlt}, ${oOk})`);
    q(`DELETE FROM comenzi WHERE id IN (${oAlt}, ${oOk})`);
  }

  // ------------------------------------------------------------------------
  console.log("\n8. În browser: butonul „Rezervă”, clientul, mesajul");
  const { chromium } = require("playwright");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const browser = await chromium.launch();
  const erori = [];
  try {
    const pagina = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
    pagina.on("pageerror", (e) => erori.push(e.message));
    await pagina.route("http://erp.test/**", async (rt) => {
      const req = rt.request();
      const u = new URL(req.url());
      if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      if (req.method() === "POST") {
        const r = await cer("post", u.pathname, AG1, { body: qs.parse(req.postData() || "") });
        // Redirecționarea serverului, făcută de pagină: Chromium nu trece prin
        // rută și cererea care urmează unui 302 fabricat aici.
        const loc = "http://erp.test" + r.antet.Location;
        return rt.fulfill({ status: 200, contentType: "text/html", body: `<script>location.replace(${JSON.stringify(loc)})</script>` });
      }
      if (u.pathname.startsWith("/stocuri/ct-park/stoc")) {
        const r = await cer("get", u.pathname, AG1, { query: Object.fromEntries(u.searchParams) });
        return rt.fulfill({ status: r.cod, contentType: "text/html", body: r.corp });
      }
      return rt.fulfill({ status: 204, body: "" });
    });
    await pagina.goto("http://erp.test/stocuri/ct-park/stoc?q=tsr");
    bine("panoul e ascuns la început", await pagina.$eval("#panou-rezervare", (p) => p.hidden));
    await pagina.click('[data-rezerva][data-produs="98902"]');
    egal("„Rezervă” deschide panoul cu produsul și cât e liber", await pagina.$eval("#panou-rezervare", (p) => [p.hidden, p.querySelector("[data-produs-nume]").textContent, p.querySelector("[data-liber]").textContent, p.querySelector('input[name="produs_id"]').value]),
      [false, "TSR Cutie B (TSR-B)", "77 buc", "98902"]);
    // Fără client ales din listă, formularul nu pleacă.
    await pagina.fill('#panou-rezervare input[name="cantitate"]', "4");
    await pagina.click('#panou-rezervare button[type="submit"]');
    await pagina.waitForTimeout(300);
    bine("fără client din listă, formularul nu pleacă", (await pagina.url()).endsWith("/stocuri/ct-park/stoc?q=tsr") && Number(unul(`SELECT COUNT(*) FROM rezervari_agenti WHERE stare = 'activa' AND produs_id = ${P_B}`)) === 0);
    await pagina.fill("#panou-rezervare .cauta-client", "TSR Client Rest");
    await pagina.waitForSelector(".rezultate-clienti div");
    await pagina.dispatchEvent(".rezultate-clienti div >> nth=0", "mousedown");
    bine("clientul restant: mențiunea apare sub căsuță", /Clientul are întârzieri la plată/.test(await pagina.$eval("#panou-rezervare .mentiune-client", (m) => m.textContent)));
    await Promise.all([pagina.waitForURL(/eroare=/), pagina.click('#panou-rezervare button[type="submit"]')]);
    const refuz = await pagina.content();
    bine("…iar serverul refuză, cu motiv", /role="alert"><strong>Nu se poate rezerva pentru TSR Client Restant SRL: are facturi restante/.test(refuz), pagina.url());
    await pagina.click('[data-rezerva][data-produs="98902"]');
    await pagina.fill("#panou-rezervare .cauta-client", "TSR Client Bun");
    await pagina.waitForSelector(".rezultate-clienti div");
    await pagina.dispatchEvent(".rezultate-clienti div >> nth=0", "mousedown");
    await pagina.fill('#panou-rezervare input[name="cantitate"]', "4");
    await Promise.all([pagina.waitForURL(/ok=/), pagina.click('#panou-rezervare button[type="submit"]')]);
    const dupa = await pagina.content();
    bine("rezervarea se face, iar pagina spune cine pentru cine", /Rezervat 4 buc din TSR Cutie B pentru TSR Client Bun SRL/.test(dupa) && /rezervat de agentul <strong>Agent Unu<\/strong> pentru clientul <strong>TSR Client Bun SRL<\/strong>: 4 buc/.test(dupa));
    bine("filtrele din capul tabelului sunt puse", (await pagina.$$("table[data-filtre=stoc-la-zi] th .filtru-btn")).length >= 9);
    // POZA=cale.png: o poză a paginii, pentru ochiul omului.
    if (process.env.POZA) await pagina.screenshot({ path: process.env.POZA, fullPage: true });
    await pagina.click('details.elibereaza summary');
    await pagina.fill('details.elibereaza input[name="motiv"]', "test din browser");
    await Promise.all([pagina.waitForURL(/ok=Rezervarea/), pagina.click('details.elibereaza button[type="submit"]')]);
    bine("eliberarea din pagină, cu motiv", /Rezervarea a fost eliberată/.test(await pagina.content()) && unul(`SELECT motiv FROM rezervari_agenti WHERE produs_id = ${P_B} ORDER BY id DESC LIMIT 1`) === "test din browser");
    await pagina.setViewportSize({ width: 390, height: 844 });
    const lat = await pagina.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth,
      [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 2 && !e.closest(".tabel-scroll"))
        .slice(0, 8).map((e) => e.tagName + "." + e.className + "#" + e.id + ":" + Math.round(e.getBoundingClientRect().right))]);
    bine("pe telefon pagina nu se lățește peste ecran (tabelul derulează în cadrul lui)", lat[0] <= lat[1] + 2, JSON.stringify(lat));
  } finally {
    await browser.close();
  }
  egal("nicio eroare de JavaScript", erori, []);

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("ESEC (crash):", e && e.stack ? e.stack : e);
  try { curata(); } catch (x) { /* nimic */ }
  process.exit(1);
});
