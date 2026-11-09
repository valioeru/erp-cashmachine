"use strict";
// Codurile de bare pe aviz și etichete, și scanarea lor. PostgreSQL real + Chromium.
//
// CEREREA LUI VALI, 05.11.2026: „Să fie și cod de bare pe orice aviz sau
// etichetă, să poți scana produsul. Codul de bare e asociat cu fiecare cod de
// produs, comandă, AWB etc." Și, tot atunci: „E doar CT-Park, un singur
// depozit, și o gestiune separată în fulfillment. Niciun alt depozit separat."
//
// CE APĂRĂ:
//   • FORMELE: fiecare document are forma lui de cod (CMD-142, CHMA-1389, …),
//     iar un text scanat e recunoscut ca tot ce poate fi.
//   • CODURILE SE CITESC: barele de pe aviz, etichete, comanda la furnizor și
//     fișa produsului se decodează (Code 128-B, cu suma de control) exact în
//     textul așteptat — nu doar „există un SVG".
//   • AVIZUL de un rând rămâne pe o foaie, chiar și cu AWB; cu nume lungi
//     încap mai multe rânduri decât înainte, nu mai puține.
//   • ETICHETA DE 100 × 150 nu se revarsă pe eticheta următoare.
//   • SCANAREA găsește fiecare lucru, deschide direct când e unul singur, dă
//     lista când sunt mai multe și nu deschide ce omul n-are voie să vadă.
//   • CITITORUL e recunoscut după viteză pe orice pagină, dar nu când omul
//     scrie într-un câmp sau tastează încet.
//   • CAMERA: butonul apare doar unde există BarcodeDetector și duce la ce a
//     văzut camera.
//   • STOCUL de pe fișa produsului e CT-Park + fulfillment, nu „pe depozite".
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
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
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => {
    const s = String(sql);
    if (/^\s*(UPDATE|DELETE)/i.test(s) && !/RETURNING/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const SCAN = require(path.join(RAD, "lib", "scan.js"));
const CB = require(path.join(RAD, "lib", "codbare.js"));
const AV = require(path.join(RAD, "lib", "aviz.js"));
const PO = require(path.join(RAD, "lib", "comanda-furnizor-pdf.js"));
const R = require(path.join(RAD, "lib", "render.js"));
const auth = require(path.join(RAD, "lib", "auth.js"));

const rute = { get: {}, post: {} };
const inreg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "scan.js")).register(inreg);
require(path.join(RAD, "modules", "avize.js")).register(inreg);
require(path.join(RAD, "modules", "ct-park.js")).register(inreg);
require(path.join(RAD, "modules", "produse.js")).register(inreg);
const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, user, params, query) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipseste: GET " + cale);
  const r = res();
  await h({ user, params: params || {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
}
const loc = (r) => decodeURIComponent(String((r.antet && r.antet.Location) || ""));
const scan = (cod, user) => cer("/scan", user, {}, { cod });

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- Cititorul de coduri, scris de mână -------------------------------------
// Din SVG înapoi în text: modulul din zona albă din stânga (10 module), apoi
// fiecare simbol de 11 module → tiparul lui de lățimi → valoarea, apoi suma
// de control. Dacă desenul ar fi greșit cu un singur modul, textul nu iese.
function decodeaza(svg) {
  const dr = [...String(svg).matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)" height="[\d.]+"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (!dr.length) return { eroare: "fără bare" };
  const m = dr[0][0] / 10;
  let biti = "";
  for (const [x, w] of dr) {
    const start = Math.round(x / m) - 10;
    const lung = Math.round(w / m);
    if (start < biti.length) return { eroare: "bare suprapuse" };
    biti += "0".repeat(start - biti.length) + "1".repeat(lung);
  }
  if ((biti.length - 13) % 11 !== 0) return { eroare: "lungime " + biti.length };
  const tipar = (bucata) => {
    const t = [];
    let i = 0;
    while (i < bucata.length) { let j = i; while (j < bucata.length && bucata[j] === bucata[i]) j++; t.push(j - i); i = j; }
    return t.join("");
  };
  const valori = [];
  for (let i = 0; i + 11 <= biti.length - 13; i += 11) valori.push(CB.TIPARE.indexOf(tipar(biti.slice(i, i + 11))));
  if (tipar(biti.slice(-13)) !== CB.TIPARE[106]) return { eroare: "fără STOP" };
  if (valori[0] !== 104) return { eroare: "fără START B" };
  if (valori.some((v) => v < 0)) return { eroare: "simbol necunoscut" };
  const date = valori.slice(1, -1);
  const suma = date.reduce((s, v, i) => s + v * (i + 1), 104) % 103;
  if (suma !== valori[valori.length - 1]) return { eroare: "suma de control" };
  const latime = Number((String(svg).match(/viewBox="0 0 ([\d.]+)/) || [])[1]);
  if (!(latime + 0.01 >= (biti.length + 20) * m)) return { eroare: "zona albă din dreapta" };
  return { text: date.map((v) => String.fromCharCode(v + 32)).join(""), modul: m };
}
const coduri = (html) => [...String(html).matchAll(/<svg class="cod-bare"[\s\S]*?<\/svg>/g)].map((x) => decodeaza(x[0]).text || "?");

// ---- Datele de probă ---------------------------------------------------------
const ZI_SD = "2026-11-04";
function curata() {
  q(`DELETE FROM ff_retururi WHERE awb LIKE 'TSTSCN%'`);
  q(`DELETE FROM ff_stare WHERE awb LIKE 'TSTSCN%'`);
  q(`DELETE FROM ff_miscari WHERE produs_id BETWEEN 98601 AND 98609`);
  q(`DELETE FROM consumabile_awb_linii WHERE awb_id IN (SELECT id FROM consumabile_awb WHERE awb LIKE 'TSTSCN%')`);
  q(`DELETE FROM consumabile_awb WHERE awb LIKE 'TSTSCN%'`);
  q(`DELETE FROM consumabile_produse WHERE cod LIKE 'TSTSCN%'`);
  q(`DELETE FROM consumabile_clienti WHERE cheie LIKE 'tstscn%'`);
  q(`DELETE FROM consumabile_zile WHERE client = 'TSTSCN'`);
  q(`DELETE FROM transport_curse WHERE awb LIKE 'TSTSCN%' OR comanda_id = 98621`);
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id BETWEEN 98651 AND 98659)`);
  q(`DELETE FROM ct_iesiri WHERE palet_id BETWEEN 98651 AND 98659`);
  q(`DELETE FROM ct_ocupari WHERE palet_id BETWEEN 98651 AND 98659`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id BETWEEN 98651 AND 98659`);
  q(`DELETE FROM ct_paleti WHERE id BETWEEN 98651 AND 98659`);
  q(`DELETE FROM avize_linii WHERE aviz_id BETWEEN 98641 AND 98649`);
  q(`DELETE FROM avize WHERE id BETWEEN 98641 AND 98649`);
  q(`DELETE FROM comenzi_productie WHERE id = 98661`);
  q(`DELETE FROM comenzi_furnizor WHERE id IN (98631, 98632)`);
  q(`DELETE FROM comenzi WHERE id = 98621`);
  q(`UPDATE produse SET fuzionat_in = NULL WHERE id BETWEEN 98601 AND 98609`);
  q(`DELETE FROM produse WHERE id BETWEEN 98601 AND 98609`);
  q(`DELETE FROM parteneri WHERE id IN (98611, 98612)`);
}

(async () => {
  curata();
  const uid = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const VALI = { id: uid, nume: "Vali Test", rol: "admin" };
  const DEP = { id: uid, nume: "Depozit Test", rol: "depozit", sectiuni: "/depozit" };
  const FF = { id: uid, nume: "Fulfillment Test", rol: "depozit", sectiuni: "/fulfillment" };
  const GABI = { id: uid, nume: "Gabi Test", rol: "financiar", sectiuni: "/rapoarte/comenzi-la-zi" };
  const STRAIN = { id: uid, nume: "Marketing Test", rol: "productie", sectiuni: "/marketing" };

  console.log("\n1. Formele codurilor");
  egal("produsul cu cod: codul lui, curățat de spații", SCAN.codProdus("  VPK-120 ", 7), "VPK-120");
  egal("produsul fără cod: P-<id>", SCAN.codProdus("", 7), "P-7");
  egal("linia fără produs: niciun cod", SCAN.codProdus(null, null), "");
  egal("comanda: CMD-<id>", SCAN.codComanda(142), "CMD-142");
  egal("comanda fără id: niciun cod", SCAN.codComanda(0), "");
  egal("avizul: serie-număr, seria doar litere mari și cifre", SCAN.codAviz(" ch ma", 1389), "CHMA-1389");
  egal("avizul cu diacritice în serie", SCAN.codAviz("ĂB", 7), "AB-7");
  egal("avizul fără număr: niciun cod", SCAN.codAviz("CHMA", null), "");
  egal("prefixul de simbologie și caracterele de control se scot", SCAN.curataScanat("]C0CT261105-0012\r\n"), "CT261105-0012");
  const fel = (t) => SCAN.interpreteaza(t).forme.map((f) => f.fel);
  bine("CMD-142 e întâi comanda", SCAN.interpreteaza("cmd-142").forme[0].fel === "comanda" && SCAN.interpreteaza("cmd-142").forme[0].id === 142);
  bine("…și scris de mână fără cratimă, tot comanda", SCAN.interpreteaza("CMD142").forme[0].fel === "comanda" && SCAN.interpreteaza("CMD142").forme[0].id === 142);
  bine("CT261105-0012 e un palet", fel("CT261105-0012").includes("palet"));
  bine("CF-2026-0001 e o comandă la furnizor", fel("CF-2026-0001").includes("comanda_furnizor"));
  egal("CM-261026-142 e lotul producției 142", SCAN.interpreteaza("CM-261026-142").forme.find((f) => f.fel === "productie").id, 142);
  egal("CMP142.030 e operația 30 a producției 142", [SCAN.interpreteaza("CMP142.030").forme[0].id, SCAN.interpreteaza("CMP142.030").forme[0].operatie], [142, 30]);
  egal("CHMA-1389, CHMA1389 și „CHMA 1389” sunt același aviz",
    ["CHMA-1389", "chma1389", "CHMA 1389"].map((t) => { const f = SCAN.interpreteaza(t).forme.find((x) => x.fel === "aviz"); return f && f.serie + "/" + f.numar; }),
    ["CHMA/1389", "CHMA/1389", "CHMA/1389"]);
  bine("P-12 e produsul 12", SCAN.interpreteaza("P-12").forme.some((f) => f.fel === "produs_id" && f.id === 12));
  bine("orice text poate fi un cod de produs, un număr de comandă și un lot",
    ["produs", "numar_comanda", "lot"].every((x) => fel("VPK-120").includes(x)));
  const awb = SCAN.interpreteaza("1sdy96799999001001").forme.find((f) => f.fel === "awb");
  egal("AWB-ul de pe colet se caută și fără numărul coletului", [awb.awb, awb.expeditie], ["1SDY96799999001001", "1SDY96799999001"]);
  bine("un text cu cratimă nu e AWB", !fel("VPK-120-ABC").includes("awb"));
  bine("un text gol nu e nimic", SCAN.interpreteaza("  \r\n").forme.length === 0);

  console.log("\n2. Desenul codului se citește înapoi");
  egal("CHMA-1389 se citește CHMA-1389", decodeaza(CB.svg("CHMA-1389")).text, "CHMA-1389");
  const lat = CB.svg("VPK-STR-23-001-LUNG", { modul: 0.3, latimeMax: 40 });
  egal("un cod lung își îngustează modulul, dar nu sub 0,25 mm", Math.round(decodeaza(lat).modul * 1000) / 1000, 0.25);
  egal("…și tot se citește", decodeaza(lat).text, "VPK-STR-23-001-LUNG");
  egal("un cod scurt cu loc destul își păstrează modulul cerut", Math.round(decodeaza(CB.svg("P-7", { modul: 0.4, latimeMax: 90 })).modul * 1000) / 1000, 0.4);
  const ingust = CB.svg("WBVFOL01", { modul: 0.4, latimeMax: 50 });
  bine("cu loc puțin, modulul scade exact cât să încapă", Math.abs(Number((ingust.match(/viewBox="0 0 ([\d.]+)/) || [])[1]) - 50) < 0.02, ingust.slice(0, 120));

  console.log("\n3. Avizul are codurile lui, pe o foaie");
  const avizP = { serie: "CHMA", numar: 1389, data: "2026-11-05", client_nume: "CLIENT PROBA SRL", client_adresa: "Str. X 1", comanda_id: 142, comanda_numar: "PO-77" };
  const liniiP = [
    { produs_id: 5, denumire: "Folie stretch", cod: "VPK-120", um: "rolă", cantitate: 10 },
    { produs_id: 6, denumire: "Cutie fără cod", cod: null, um: "buc", cantitate: 3 },
    { produs_id: null, denumire: "Paleți EURO", cod: null, um: "buc", cantitate: 2 },
  ];
  const fAv = AV.pagina(avizP, liniiP, { awb: ["1SDY96799999001", " 1SDY96799999001 ", ""] });
  egal("codurile de pe aviz: avizul, comanda, AWB-ul (o dată), apoi liniile cu produs", coduri(fAv), ["CHMA-1389", "CMD-142", "1SDY96799999001", "VPK-120", "P-6"]);
  bine("linia scrisă de mână, fără produs, n-are cod de bare", !/Paleți EURO<\/div><div class="den-cod">/.test(fAv));
  bine("titlurile codurilor din antet", fAv.includes(">Cod comandă<") && fAv.includes(">AWB<"));
  const fAv2 = AV.pagina(Object.assign({}, avizP, { comanda_id: null, comanda_numar: null }), liniiP.slice(0, 1), {});
  egal("fără comandă și fără AWB: doar avizul și produsul", coduri(fAv2), ["CHMA-1389", "VPK-120"]);
  bine("…și niciun titlu de cod rămas gol", !fAv2.includes("Cod comandă") && !fAv2.includes(">AWB<"));
  const FARA_PRET = ["Pret", "Preț", "Valoare", "Valoarea", "TVA", "Total", "lei", "Lei"];
  bine("codurile nu aduc pe aviz cuvinte de preț", !FARA_PRET.some((c) => fAv.slice(fAv.indexOf("<body>")).includes(c)));
  const golN = (h) => (h.match(/<tr class="gol">/g) || []).length;
  egal("rândurile goale țin cont de codurile de bare (3 linii, 1 AWB)", golN(fAv), AV.RANDURI_MINIME - (2 + 2 + 1) - 3);
  egal("…iar cu multe linii nu scad sub zero", golN(AV.pagina(avizP, Array.from({ length: 12 }, (_, i) => ({ produs_id: i + 1, denumire: "P" + i, cod: "C" + i, um: "buc", cantitate: 1 })), {})), 0);

  console.log("\n4. Comanda la furnizor are numărul ca cod de bare");
  const po = PO.pagina({ comanda: { id: 3, numar: "CF-2026-0003", data: "2026-11-05", moneda: "EUR", furnizor: "WBV GmbH" }, linii: [] });
  egal("codul de pe comandă", coduri(po), ["CF-2026-0003"]);
  egal("ciorna fără număr n-are cod", coduri(PO.pagina({ comanda: { id: 3, data: "2026-11-05", furnizor: "WBV" }, linii: [] })), []);

  // ---- Fixturi în bază ---------------------------------------------------------
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (98611, 'client', 'TEST-SCN Client SRL'), (98612, 'furnizor', 'TEST-SCN Furnizor SRL')`);
  q(`INSERT INTO produse (id, cod, cod_generat, denumire, unitate_masura, activ) VALUES
       (98601, 'TSTSCN-01', NULL, 'TEST-SCN Folie stretch', 'rola', 1),
       (98602, NULL, NULL, 'TEST-SCN Fara cod', 'buc', 1),
       (98603, 'TSTSCN-VECHI', NULL, 'TEST-SCN Folie veche', 'rola', 0),
       (98604, 'TȘ-SCN-Ă', NULL, 'TEST-SCN Cu diacritice', 'buc', 1),
       (98605, NULL, 'TSTSCNGEN01', 'TEST-SCN Doar generat', 'buc', 1),
       (98606, 'CMD-98621', NULL, 'TEST-SCN Cod ca o comanda', 'buc', 1)`);
  q(`UPDATE produse SET fuzionat_in = 98601 WHERE id = 98603`);
  q(`INSERT INTO comenzi (id, partener_id, numar, status) VALUES (98621, 98611, 'PO-TSTSCN-7', 'noua')`);
  q(`INSERT INTO comenzi_furnizor (id, numar, furnizor_id, status) VALUES (98631, 'CF-2099-0007', 98612, 'trimisa'), (98632, 'PO VECHI TSTSCN', 98612, 'receptionata')`);
  q(`INSERT INTO comenzi_productie (id, numar, partener_id, tip_produs, status) VALUES (98661, 'PR-TSTSCN', 98611, 'Folie', 'noua')`);
  q(`INSERT INTO avize (id, serie, numar, data, partener_id, comanda_id, comanda_numar, client_nume, sursa) VALUES
       (98641, 'TSCN', 5, '2026-11-05', 98611, 98621, 'PO-TSTSCN-7', 'TEST-SCN Client SRL', 'depozit'),
       (98642, 'TSCN', 6, '2026-11-05', 98611, 98621, 'PO-TSTSCN-7', 'TEST-SCN Client SRL', 'manual')`);
  q(`INSERT INTO avize_linii (aviz_id, produs_id, denumire, cod, um, cantitate) VALUES
       (98641, 98601, 'TEST-SCN Folie stretch', 'TSTSCN-01', 'rola', 10),
       (98641, 98602, 'TEST-SCN Fara cod', NULL, 'buc', 2),
       (98641, NULL, 'TEST-SCN Text liber', NULL, 'buc', 1),
       (98642, 98601, 'TEST-SCN Folie stretch', 'TSTSCN-01', 'rola', 4)`);
  const locuri = q(`SELECT id, adresa FROM ct_locuri WHERE id NOT IN (SELECT loc_id FROM ct_ocupari) ORDER BY id LIMIT 2`);
  const NUME_LUNG = "TEST-SCN Folie stretch manuală transparentă 23 microni, 50 cm lățime, rolă de 2,5 kg, pentru paletizare automată";
  q(`UPDATE produse SET denumire = ? WHERE id = 98601`, [NUME_LUNG]);
  q(`INSERT INTO ct_paleti (id, cod, produs_id, cantitate, um, lot, categorie, data_intrare) VALUES
       (98651, 'CT991105-9901', 98601, 40, 'rola', 'LOT-TSTSCN', 'Materie primă', '2026-11-05'),
       (98652, 'CT991105-9902', 98601, 10, 'rola', 'LOT-TSTSCN', 'Materie primă', '2026-11-05')`);
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um, lot) VALUES (98651, 98601, 40, 'rola', 'LOT-TSTSCN'), (98652, 98601, 10, 'rola', 'LOT-TSTSCN')`);
  for (const l of locuri) q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (98651, ?)`, [Number(l.id)]);
  q(`UPDATE ct_paleti SET data_iesire = '2026-11-05' WHERE id = 98652`);
  const iesId = Number(unul(`INSERT INTO ct_iesiri (palet_id, destinatie, comanda_id, client, comanda_numar, data, aviz_id, creat_de)
       VALUES (98652, 'comanda', 98621, 'TEST-SCN Client SRL', 'PO-TSTSCN-7', '2026-11-05', 98641, 'Test') RETURNING id`));
  const cursaId = Number(unul(`INSERT INTO transport_curse (sursa, comanda_id, iesire_id, client, awb, stare) VALUES ('depozit', 98621, ?, 'TEST-SCN Client SRL', 'TSTSCNAWB0001', 'alocata') RETURNING id`, [iesId]));
  q(`INSERT INTO ff_miscari (produs_id, cantitate, fel, data) VALUES (98601, 7, 'intrare', '2026-11-05'), (98601, 100, 'intrare', '2026-11-05')`);
  q(`UPDATE ff_miscari SET test = 1 WHERE produs_id = 98601 AND cantitate = 100`);
  const ziId = Number(unul(`INSERT INTO consumabile_zile (client, data, sursa) VALUES ('TSTSCN', ?, 'test') RETURNING id`, [ZI_SD]));
  const clId = Number(unul(`INSERT INTO consumabile_clienti (nume, cheie, oras, judet) VALUES ('TEST-SCN Destinatar', 'tstscn-dest', 'Craiova', 'Dolj') RETURNING id`));
  const cpId = Number(unul(`INSERT INTO consumabile_produse (cod, denumire, um) VALUES ('TSTSCN-C1', 'TEST-SCN Plic', 'buc') RETURNING id`));
  const awbId = Number(unul(`INSERT INTO consumabile_awb (awb, zi_id, client_id, data_awb, kg, colete) VALUES ('TSTSCN0000001', ?, ?, ?, 1.5, 1) RETURNING id`, [ziId, clId, ZI_SD]));
  q(`INSERT INTO consumabile_awb_linii (awb_id, produs_id, cantitate, pret) VALUES (?, ?, 3, 1)`, [awbId, cpId]);
  q(`INSERT INTO ff_stare (awb, zi, stare) VALUES ('TSTSCN0000001', ?, 'pregatita')`, [ZI_SD]);
  q(`INSERT INTO ff_retururi (awb, produs_id, cantitate, stare, scanat_la) VALUES ('TSTSCN0000001001', 98601, 1, 'de_decis', '2026-11-05 10:00')`);
  // Un retur pe un AWB străin (nu e în raport, nici în fulfillment), scanat
  // atunci de pe colet, cu numărul coletului la coadă.
  q(`INSERT INTO ff_retururi (awb, produs_id, cantitate, stare, scanat_la) VALUES ('TSTSCN7777777001', 98601, 2, 'in_stoc', '2026-11-05 11:00')`);

  console.log("\n5. Scanarea deschide direct lucrul găsit");
  const merge = async (cod, user, unde, desc) => {
    const r = await scan(cod, user);
    bine(`${desc}: „${cod}” → ${unde}`, r.cod === 302 && loc(r) === unde, r.cod + " " + loc(r) + " " + r.corp.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200));
  };
  await merge("PO-TSTSCN-7", VALI, "/comenzi/98621", "numărul clientului de pe comandă");
  await merge("CT991105-9901", VALI, "/stocuri/ct-park/palet/98651", "paletul");
  await merge("]C0ct991105-9901", VALI, "/stocuri/ct-park/palet/98651", "paletul, cu prefix de cititor și litere mici");
  await merge("LOT-TSTSCN", VALI, "/stocuri/ct-park/palet/98651", "lotul: doar paletul încă în depozit");
  await merge("CF-2099-0007", VALI, "/procurement/comenzi/98631", "comanda la furnizor");
  await merge("po vechi tstscn", VALI, "/procurement/comenzi/98632", "comanda la furnizor cu un număr vechi, scris de mână");
  await merge("CM-261105-98661", VALI, "/productie/98661", "lotul de pe fișa de producție");
  await merge("CMP98661.030", VALI, "/productie/98661", "operația de pe fișa de producție");
  await merge("TSCN-5", VALI, "/avize/98641", "avizul");
  await merge("tscn5", VALI, "/avize/98641", "avizul scris fără cratimă");
  await merge("TSCN-5", DEP, "/stocuri/ct-park/aviz/98641", "avizul, pentru depozit (fără bifa Avize)");
  await merge("TSTSCN-01", VALI, "/produse/98601", "produsul");
  await merge("tstscn-01", DEP, "/stocuri/ct-park/stoc?q=TSTSCN-01", "produsul, pentru depozit: stocul din CT-Park");
  await merge("P-98602", VALI, "/produse/98602", "produsul fără cod");
  await merge("TSTSCN-VECHI", VALI, "/produse/98601", "codul unui produs unificat duce la cel păstrat");
  await merge("TS-SCN-A", VALI, "/produse/98604", "codul cu diacritice, citit fără ele");
  await merge("TSTSCNGEN01", VALI, "/produse/98605", "codul generat");
  await merge("TSTSCN0000001001", VALI, "/scan/awb/TSTSCN0000001", "AWB-ul de pe colet");
  await merge("TSTSCN0000001", FF, "/scan/awb/TSTSCN0000001", "AWB-ul, pentru fulfillment");
  await merge("TSTSCN0000001", GABI, "/scan/awb/TSTSCN0000001", "AWB-ul, pentru raportul Sameday");
  await merge("TSTSCNAWB0001", VALI, `/logistica/cursa/${cursaId}`, "AWB-ul transportului");
  await merge("TSTSCN7777777", FF, "/scan/awb/TSTSCN7777777", "AWB-ul unui retur străin, scanat fără numărul coletului");

  console.log("\n6. Mai multe potriviri, nicio potrivire, fără acces");
  let r = await scan("CMD-98621", VALI);
  bine("CMD-98621 e și comanda, și codul unui produs: lista, nu ghicit", r.cod === 200 && r.corp.includes("Comanda #98621") && r.corp.includes("TEST-SCN Cod ca o comanda") && r.corp.includes("2 lucruri"), r.cod + " " + loc(r));
  bine("…cu „Deschide” spre fiecare", r.corp.includes('href="/comenzi/98621"') && r.corp.includes('href="/produse/98606"'));
  r = await scan("NUEXISTA-TSTSCN-404", VALI);
  bine("codul necunoscut: spus, cu codul citit sub ochi", r.cod === 200 && r.corp.includes("Nu am găsit nimic") && r.corp.includes("NUEXISTA-TSTSCN-404"));
  r = await scan("TSTSCN-01", STRAIN);
  // De pe 09.11.2026 „Stoc la zi" e a tuturor celor logați (lib/auth,
  // PAGINI_AGENT): cine n-are fișa produsului ajunge la stocul lui.
  bine("produsul, pentru cine n-are fișa: stocul la zi, căutat după cod", r.cod === 302 && loc(r) === "/stocuri/ct-park/stoc?q=TSTSCN-01", r.cod + " " + loc(r));
  r = await scan("TSTSCN0000001", STRAIN);
  bine("AWB-ul, pentru cine n-are fulfillment sau raportul: nu intră", r.cod === 200 && r.corp.includes("n-ai acces"));
  r = await cer("/scan", VALI, {}, {});
  bine("fără cod: pagina cu câmpul de scanare", r.cod === 200 && r.corp.includes('id="scan-cod"') && r.corp.includes("autofocus") && r.corp.includes('id="scan-camera" hidden'));
  bine("/scan e deschisă oricui e logat", auth.poateAccesa(STRAIN, "/scan") && auth.poateAccesa(STRAIN, "/scan/awb/X"));

  console.log("\n7. Fișa AWB-ului");
  r = await cer("/scan/awb/:awb", FF, { awb: "TSTSCN0000001001" });
  const tAwb = r.corp.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // Ziua apare în formatul românesc: layout-ul traduce datele din text.
  const asteptate = ["TEST-SCN Destinatar, Craiova, Dolj", "04.11.2026", "TEST-SCN Plic", "3 buc", "pregatita", "de_decis"];
  bine("clientul, ziua, ce cere, starea și returul", r.cod === 200 && asteptate.every((x) => tAwb.includes(x)), asteptate.filter((x) => !tAwb.includes(x)).join(" | "));
  egal("codul de bare de pe fișă e AWB-ul fără colet", coduri(r.corp), ["TSTSCN0000001"]);
  bine("linkurile spre ziua din fulfillment și retururi", r.corp.includes(`/fulfillment?zi=${ZI_SD}`) && r.corp.includes('href="/fulfillment/retururi"'));
  bine("fulfillment-ul fără raport nu primește linkul spre raport", !r.corp.includes("/rapoarte/comenzi-la-zi?zi="));
  r = await cer("/scan/awb/:awb", FF, { awb: "TSTSCN7777777" });
  bine("fișa returului străin: returul, fără client și fără linii", r.cod === 200 && r.corp.includes("in_stoc") && !r.corp.includes("Ce cere AWB-ul"), r.cod);
  r = await cer("/scan/awb/:awb", STRAIN, { awb: "TSTSCN0000001" });
  egal("fără drept: 403", r.cod, 403);
  r = await cer("/scan/awb/:awb", VALI, { awb: "TSTSCNNIMIC00" });
  bine("AWB necunoscut: spus", r.cod === 200 && r.corp.includes("nu e în ERP"));

  console.log("\n8. Avizul din ERP poartă AWB-ul transportului");
  r = await cer("/avize/:id", VALI, { id: "98641" });
  egal("avizul de la ieșire: aviz, comandă, AWB-ul cursei ieșirii, produsele", coduri(r.corp), ["TSCN-5", "CMD-98621", "TSTSCNAWB0001", "TSTSCN-01", "P-98602"]);
  r = await cer("/avize/:id", VALI, { id: "98642" });
  egal("avizul fără ieșire: AWB-ul singurei curse a comenzii", coduri(r.corp).slice(0, 3), ["TSCN-6", "CMD-98621", "TSTSCNAWB0001"]);
  q(`INSERT INTO transport_curse (sursa, comanda_id, client, awb, stare) VALUES ('depozit', 98621, 'TEST-SCN', 'TSTSCNAWB0002', 'alocata')`);
  r = await cer("/avize/:id", VALI, { id: "98642" });
  bine("două curse cu AWB pe comandă: nu ghicim, avizul rămâne fără AWB", !coduri(r.corp).some((c) => c.startsWith("TSTSCNAWB")), coduri(r.corp));
  r = await cer("/avize/:id", VALI, { id: "98641" });
  bine("…dar avizul ieșirii își păstrează AWB-ul ei", coduri(r.corp).includes("TSTSCNAWB0001") && !coduri(r.corp).includes("TSTSCNAWB0002"));
  q(`UPDATE transport_curse SET stare = 'anulata' WHERE awb = 'TSTSCNAWB0002'`);
  r = await cer("/avize/:id", VALI, { id: "98642" });
  bine("cursa anulată nu se mai socotește", coduri(r.corp).includes("TSTSCNAWB0001"));
  r = await cer("/stocuri/ct-park/aviz/:id", DEP, { id: "98641" }, {});
  bine("aceeași foaie și pe adresa depozitului", coduri(r.corp).includes("TSTSCNAWB0001"));

  console.log("\n9. Etichetele din CT-Park");
  r = await cer("/stocuri/ct-park/etichete", DEP, {}, { paleti: "98651" });
  const etDep = r.corp;
  egal("eticheta de depozit: codul produsului și al paletului", coduri(etDep), ["TSTSCN-01", "CT991105-9901"]);
  r = await cer("/stocuri/ct-park/etichete", DEP, {}, { paleti: "98652" });
  const etIes = r.corp;
  egal("eticheta de ieșire: produsul, paletul, iar lângă el comanda și avizul", coduri(etIes), ["TSTSCN-01", "CT991105-9902", "CMD-98621", "TSCN-5"]);
  bine("…comanda și avizul stau jos, lângă codul paletului", /class="et-jos-doc">[\s\S]*Cod comandă[\s\S]*Aviz TSCN 5/.test(etIes));
  bine("…cu titlul avizului lângă codul lui", etIes.includes("Aviz TSCN 5"));
  q(`UPDATE ct_iesiri SET destinatie = 'productie', comanda_id = NULL, aviz_id = NULL WHERE id = ?`, [iesId]);
  r = await cer("/stocuri/ct-park/etichete", DEP, {}, { paleti: "98652" });
  egal("ieșirea spre producție: fără comandă și fără aviz", coduri(r.corp), ["TSTSCN-01", "CT991105-9902"]);
  q(`UPDATE ct_iesiri SET destinatie = 'comanda', comanda_id = 98621, aviz_id = 98641 WHERE id = ?`, [iesId]);

  console.log("\n10. Fișa produsului: stocul e CT-Park și fulfillment");
  r = await cer("/produse/:id", VALI, { id: "98601" });
  const tPr = r.corp.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("stocul CT-Park = doar paletul încă în depozit (40)", /Stoc CT-Park 40 rola/.test(tPr), (tPr.match(/Stoc CT-Park[^S]{0,30}/) || [""])[0]);
  bine("stocul fulfillment = mișcările adevărate (7), fără cele de probă", /Stoc fulfillment 7 rola/.test(tPr), (tPr.match(/Stoc fulfillment[^E]{0,30}/) || [""])[0]);
  bine("paletul, cu link și cu locul lui", r.corp.includes('href="/stocuri/ct-park/palet/98651">CT991105-9901</a>') && (!locuri.length || tPr.includes(locuri[0].adresa)));
  bine("fără tabelul vechi pe depozite", !tPr.includes("Stoc pe depozite") && !tPr.includes("Stoc total curent"));
  egal("codul de bare de pe fișă", coduri(r.corp), ["TSTSCN-01"]);
  bine("butonul spre eticheta produsului", r.corp.includes('href="/produse/98601/eticheta"'));
  r = await cer("/produse/:id", VALI, { id: "98605" });
  egal("produsul cu doar cod generat: îl arată și îl desenează", coduri(r.corp), ["TSTSCNGEN01"]);
  r = await cer("/produse/:id/eticheta", VALI, { id: "98602" });
  egal("eticheta produsului fără cod: P-<id>", coduri(r.corp), ["P-98602"]);
  bine("eticheta e de 100 × 150", r.corp.includes("@page { size: 100mm 150mm"));
  const etProdus = (await cer("/produse/:id/eticheta", VALI, { id: "98601" })).corp;

  console.log("\n11. Bara de sus și scriptul cititorului");
  const pag = R.layout({ title: "Probă", active: "/comenzi", body: '<p>x</p><input id="camp"><a id="leg" href="/comenzi">leg</a>', user: VALI });
  bine("„Scanează” e în bara de sus", pag.includes('href="/scan" class="userbox-scan"'));
  bine("scriptul cititorului e pe pagină", pag.includes("/scan?cod="));
  bine("…dar nu pe ecranul fără om logat", !R.layout({ title: "Login", active: "/", body: "", user: null }).includes("/scan?cod="));

  // ---- În browser --------------------------------------------------------------
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const pagini = (buf) => (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  try {
    console.log("\n12. Pe hârtie");
    const p = await browser.newPage();
    const lungi = (n) => Array.from({ length: n }, (_, i) => ({ produs_id: 100 + i, denumire: "Folie stretch manuală transparentă 23 microni 50 cm lățime rolă de 2,5 kg nr " + i, cod: "VPK-STR-23-" + String(i).padStart(3, "0"), um: "rolă", cantitate: 120 + i }));
    const avizL = Object.assign({}, avizP, { client_adresa: "Str. Exemplu nr. 10, bl. A, sc. 2, ap. 34, Sector 3, București, Jud. București, Tara Romania", client_regcom: "J40/1/2020", client_cui: "RO123" });
    await p.setContent(AV.pagina(avizL, lungi(1), { awb: ["1SDY96799999001", "1SDY96799999002"] }));
    egal("avizul de un rând, cu două AWB-uri: o foaie", pagini(await p.pdf({ preferCSSPageSize: true, printBackground: true })), 1);
    await p.setContent(AV.pagina(avizL, lungi(8), {}));
    egal("avizul cu 8 rânduri cu nume lungi: o foaie (înainte încăpeau 4)", pagini(await p.pdf({ preferCSSPageSize: true, printBackground: true })), 1);
    const randAv = await p.evaluate(() => document.querySelector("tr.linie").getBoundingClientRect().height / 3.7795);
    bine("rândul cu cod rămâne sub 16 mm", randAv < 16, randAv.toFixed(1));

    await p.setContent(etDep);
    const dep = await p.evaluate(() => { const e = document.querySelector(".et"); return { h: e.clientHeight, s: e.scrollHeight }; });
    bine("eticheta de 100 × 150 cu nume lung și două locuri nu se revarsă", dep.s <= dep.h + 1, JSON.stringify(dep));
    egal("…și iese pe o singură etichetă", pagini(await p.pdf({ preferCSSPageSize: true, printBackground: true })), 1);
    await p.setContent(etIes);
    egal("eticheta de ieșire, cu codurile comenzii și avizului: o foaie A4", pagini(await p.pdf({ preferCSSPageSize: true, printBackground: true })), 1);
    await p.setContent(etProdus);
    const etP = await p.evaluate(() => { const e = document.querySelector(".et"); return { h: e.clientHeight, s: e.scrollHeight }; });
    bine("eticheta produsului cu nume lung încape", etP.s <= etP.h + 1, JSON.stringify(etP));
    egal("…pe o singură etichetă", pagini(await p.pdf({ preferCSSPageSize: true, printBackground: true })), 1);
    await p.close();

    console.log("\n13. Cititorul, pe orice pagină");
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const cereri = [];
    await pg.route("http://erp.test/**", (rt) => {
      const u = rt.request().url();
      if (u.includes("/scan")) { cereri.push(decodeURIComponent(u.replace("http://erp.test", ""))); return rt.fulfill({ status: 200, contentType: "text/html", body: "<p>scan</p>" }); }
      return rt.fulfill({ status: 200, contentType: "text/html", body: pag });
    });
    const deschide = async () => { await pg.goto("http://erp.test/comenzi"); await pg.waitForLoadState("domcontentloaded"); };
    await deschide();
    await pg.keyboard.type("CMD-142", { delay: 4 });
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(400);
    egal("codul venit repede, cu Enter, deschide /scan", cereri.slice(-1)[0], "/scan?cod=CMD-142");
    await deschide();
    const inainte = cereri.length;
    await pg.keyboard.type("CMD-142", { delay: 160 });
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(400);
    egal("omul care tastează încet nu e luat drept cititor", cereri.length, inainte);
    await deschide();
    // Fiecare tastă sub pragul dintre taste (100 ms), dar media peste cea a
    // unui cititor: un om care scrie repede tot nu e cititor.
    await pg.keyboard.type("CMD-142", { delay: 80 });
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(400);
    egal("nici omul care tastează repede (80 ms pe tastă)", cereri.length, inainte);
    await deschide();
    await pg.click("#camp");
    await pg.keyboard.type("CMD-142", { delay: 4 });
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(400);
    egal("în câmp, codul intră în câmp, nu pleacă nicăieri", [cereri.length, await pg.inputValue("#camp")], [inainte, "CMD-142"]);
    await deschide();
    await pg.keyboard.type("AB", { delay: 4 });
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(300);
    egal("două caractere nu fac un cod", cereri.length, inainte);
    await pg.focus("#leg");
    await pg.keyboard.type("CT261105-0012", { delay: 3 });
    await pg.keyboard.press("Tab");
    await pg.waitForTimeout(400);
    egal("cititorul setat cu Tab la final merge la fel, și de pe un link", cereri.slice(-1)[0], "/scan?cod=CT261105-0012");
    await ctx.close();

    console.log("\n14. Camera telefonului");
    const paginaScan = (await cer("/scan", VALI, {}, {})).corp;
    // Cu foaia de stil adevărată: .btn are display-ul lui, care bătea „hidden".
    const STIL = require("fs").readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const serveste = (rt, extra) => {
      const u = rt.request().url();
      if (u.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      if (extra && extra(u)) return rt.fulfill({ status: 200, contentType: "text/html", body: "<p>gata</p>" });
      return rt.fulfill({ status: 200, contentType: "text/html", body: paginaScan });
    };
    const fara = await browser.newPage();
    await fara.route("http://localhost:8999/**", (rt) => serveste(rt));
    await fara.goto("http://localhost:8999/scan");
    await fara.waitForTimeout(200);
    bine("fără BarcodeDetector, butonul de cameră nu se vede", !(await fara.isVisible("#scan-camera")));
    bine("…nici cutia camerei", !(await fara.isVisible("#scan-video-cutie")));
    await fara.close();
    const farFormate = await browser.newContext();
    await farFormate.addInitScript(() => {
      window.BarcodeDetector = function () { this.detect = () => Promise.resolve([]); };
      window.BarcodeDetector.getSupportedFormats = () => Promise.resolve([]);
    });
    const pc = await farFormate.newPage();
    await pc.route("http://localhost:8999/**", (rt) => serveste(rt));
    await pc.goto("http://localhost:8999/scan");
    await pc.waitForTimeout(200);
    bine("unde BarcodeDetector există, dar nu citește Code 128, butonul nu apare", !(await pc.isVisible("#scan-camera")));
    await farFormate.close();
    const cuCam = await browser.newContext();
    await cuCam.addInitScript(() => {
      window.BarcodeDetector = function () { this.detect = () => Promise.resolve(window.__vazut ? [{ rawValue: window.__vazut }] : []); };
      window.BarcodeDetector.getSupportedFormats = () => Promise.resolve(["code_128", "ean_13", "qr_code"]);
      // Un „aparat foto" din canvas, care chiar dă cadre: fără cadre, video.play()
      // nu pornește niciodată.
      const c = document.createElement("canvas");
      c.width = 64; c.height = 48;
      const g = c.getContext("2d");
      let k = 0;
      setInterval(() => { g.fillStyle = k++ % 2 ? "#333" : "#999"; g.fillRect(0, 0, 64, 48); }, 40);
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(c.captureStream(25));
      setTimeout(() => { window.__vazut = "CT991105-9901"; }, 500);
    });
    const tel = await cuCam.newPage();
    const vazute = [];
    // Camera cere o pagină sigură (HTTPS, ca ERP-ul de pe Render, sau
    // localhost): pe http obișnuit browserul nici nu are navigator.mediaDevices.
    await tel.route("http://localhost:8999/**", (rt) =>
      serveste(rt, (u) => {
        if (!u.includes("/scan?cod=")) return false;
        vazute.push(decodeURIComponent(u.replace("http://localhost:8999", "")));
        return true;
      })
    );
    await tel.goto("http://localhost:8999/scan");
    await tel.waitForTimeout(200);
    bine("cu BarcodeDetector care citește Code 128, butonul se vede", await tel.isVisible("#scan-camera"));
    await tel.click("#scan-camera");
    await tel.waitForTimeout(1500);
    egal("ce vede camera se deschide ca o scanare", vazute[0], "/scan?cod=CT991105-9901");
    await cuCam.close();
  } finally {
    await browser.close();
  }

  curata();
  console.log(esecuri ? `\n${esecuri} verificări au căzut.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
