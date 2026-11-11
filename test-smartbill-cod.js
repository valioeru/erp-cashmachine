"use strict";
// Factura trimisă în SmartBill duce și codul fiecărui produs.
//
// CE S-A ÎNTÂMPLAT, 11.11.2026: FCT-2 n-a plecat — „SmartBill a răspuns cu
// eroare (400): Produsul Folie manuala 12my rigid,1,9 kg CM nu are codul
// specificat." Vali: „Nu trimite fact in smartbil da asta care e solutia?"
// SmartBill dă eroarea asta când în cont e bifat „Utilizează coduri de
// produse" și o linie vine fără `code`. ERP-ul trimitea doar denumirea, deși
// produsul avea cod la noi („Rigid1,9", venit chiar din SmartBill).
//
// CE APĂRĂ:
//   • linia pleacă cu codul produsului: `cod`, altfel `cod_generat`, altfel
//     P-<id> — exact codul de pe aviz și de pe etichete (lib/scan.js);
//   • spațiile din jurul codului nu pleacă, iar un cod doar din spații nu e cod;
//   • linia scrisă de mână, fără produs, pleacă fără cheia `code` (nu cu un cod
//     inventat, nu cu P-<id-ul liniei>);
//   • lib/smartbill.js nu inventează singur coduri: trimite ce i se dă;
//   • la refuzul SmartBill despre cod, pagina spune care linie n-are cod și de
//     ce, sau cu ce coduri au plecat produsele; la altă eroare nu amestecă
//     lămurirea asta;
//   • factura refuzată nu rămâne trecută ca trimisă.
//
// Rulează ruta adevărată, pe PostgreSQL real, până la ușa SmartBill: `fetch`
// e prins, ca să se vadă exact ce JSON ar pleca, fără să plece nimic.
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
process.env.SMARTBILL_EMAIL = "test@exemplu.ro";
process.env.SMARTBILL_TOKEN = "x";
process.env.SMARTBILL_CIF = "RO27244210";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const SB = require(path.join(RAD, "lib", "smartbill.js"));
const SCAN = require(path.join(RAD, "lib", "scan.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
require(path.join(RAD, "modules", "facturi.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b === undefined ? "" : String(b); };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function trimite(id) {
  const h = rute.post["/facturi/:id/smartbill"];
  if (!h) throw new Error("ruta lipsește: POST /facturi/:id/smartbill");
  const r = res();
  await h({ user: VALI, params: { id: String(id) }, query: {}, body: {}, res: r, req: { url: "/facturi/" + id + "/smartbill", headers: {} } });
  return r;
}

let rele = 0, bune = 0;
const ok = (e) => { bune++; console.log("  ok       " + e); };
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
function adevarat(eticheta, v, d) { if (v) ok(eticheta); else rau(eticheta, d); }
function contine(eticheta, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !corp.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => corp.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta);
}

// Tot ce pune testul are id-uri între 982001 și 982199.
const CURATENIE = [
  "DELETE FROM facturi_linii WHERE factura_id BETWEEN 982101 AND 982199",
  "DELETE FROM facturi WHERE id BETWEEN 982101 AND 982199",
  "DELETE FROM produse WHERE id BETWEEN 982011 AND 982099",
  "DELETE FROM parteneri WHERE id BETWEEN 982001 AND 982009",
];

// Ce „aude" SmartBill. `raspuns` se schimbă de la o verificare la alta.
const plecate = [];
let raspuns = { ok: true, status: 200, corp: { series: "CSHM", number: "3401" } };
global.fetch = async (url, opt) => {
  plecate.push({ url: String(url), metoda: opt.method, brut: String(opt.body), corp: JSON.parse(opt.body) });
  return { ok: raspuns.ok, status: raspuns.status, text: async () => JSON.stringify(raspuns.corp) };
};
// Ruta scrie eroarea și în jurnalul serverului; aici ar umple ecranul degeaba.
const eroareVeche = console.error;
console.error = () => {};

(async () => {
  for (const s of CURATENIE) exec(s);

  exec(`INSERT INTO parteneri (id, tip, nume, cui, adresa, tara, judet, localitate)
        VALUES (982001, 'client', 'CLIENT COD SRL', 'RO982001', 'Str. Probei 1', 'Romania', 'Prahova', 'Ploiesti')`);
  exec(`INSERT INTO produse (id, cod, cod_generat, denumire, unitate_masura) VALUES
        (982011, 'Rigid1,9', NULL, 'Folie manuala 12my rigid,1,9 kg CM', 'buc'),
        (982012, NULL, 'FSM-12-19-T', 'Folie generata din caracteristici', 'rola'),
        (982013, '   ', NULL, 'Produs cu cod doar din spatii', 'buc'),
        (982014, '  AB 12  ', NULL, 'Produs cu spatii in jurul codului', 'kg'),
        (982015, '', '  ', 'Produs fara niciun cod', 'buc'),
        (982016, 'X-COD', 'GEN-X', 'Produs cu amandoua codurile', 'buc'),
        (982017, '', 'GEN-17', 'Produs configurat, cu codul scris gol', 'buc'),
        (982018, '   ', 'GEN-18', 'Produs configurat, cu spatii la codul scris', 'buc')`);
  const factura = (id, numar) =>
    exec(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, moneda)
          VALUES (${id}, 'FCT', ${numar}, 982001, 'vanzare', 'emisa', '2026-11-11', 'RON')`);
  const linie = (fid, pid, den, cant, pret) =>
    exec(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva)
          VALUES (${fid}, ${pid == null ? "NULL" : pid}, ${lit(den)}, ${cant}, ${pret}, 21)`);

  // 982102 = FCT-2, cum era pe live: o linie, produsul cu cod.
  factura(982102, 982102);
  linie(982102, 982011, "Folie manuala 12my rigid,1,9 kg CM", 720, 4.9);
  // 982101 = toate felurile de produs, plus o linie scrisă de mână.
  factura(982101, 982101);
  linie(982101, 982011, "Folie manuala 12my rigid,1,9 kg CM", 10, 4.9);
  linie(982101, 982012, "Folie generata din caracteristici", 2, 30);
  linie(982101, 982013, "Produs cu cod doar din spatii", 3, 1);
  linie(982101, 982014, "Produs cu spatii in jurul codului", 4, 2);
  linie(982101, 982015, "Produs fara niciun cod", 5, 3);
  linie(982101, 982016, "Produs cu amandoua codurile", 6, 4);
  linie(982101, null, "Transport", 1, 150);
  linie(982101, 982017, "Produs configurat, cu codul scris gol", 7, 5);
  linie(982101, 982018, "Produs configurat, cu spatii la codul scris", 8, 6);
  // 982103 = doar o linie scrisă de mână; 982104 = două.
  factura(982103, 982103);
  linie(982103, null, "Transport <b>urgent</b>", 1, 150);
  factura(982104, 982104);
  linie(982104, null, "Transport", 1, 150);
  linie(982104, null, "Manopera", 2, 80);

  // --- 1. FCT-2: produsul cu cod pleacă cu codul lui --------------------------------
  console.log("\n1. FCT-2: produsul cu cod");
  plecate.length = 0;
  let r = await trimite(982102);
  egal("factura e trimisă și omul e întors la ea", [r.cod, r.antet.Location || r.antet.location], [302, "/facturi/982102"]);
  egal("a plecat o singură cerere, spre emiterea de facturi", plecate.map((x) => x.metoda + " " + x.url.replace(/^.*\/api/, "")), ["POST /invoice"]);
  const p0 = plecate[0] ? plecate[0].corp.products[0] : {};
  egal("linia duce codul produsului", p0.code, "Rigid1,9");
  egal("denumirea și unitatea au rămas cum erau", [p0.name, p0.measuringUnitName], ["Folie manuala 12my rigid,1,9 kg CM", "buc"]);
  adevarat("în JSON-ul plecat cheia se numește „code”", plecate[0] && plecate[0].brut.includes('"code":"Rigid1,9"'), plecate[0] && plecate[0].brut.slice(0, 300));
  egal("factura e trecută ca trimisă, cu seria și numărul din SmartBill",
    q("SELECT smartbill_serie, smartbill_numar, (smartbill_sync_la IS NOT NULL)::int AS trimisa FROM facturi WHERE id = 982102")[0],
    { smartbill_serie: "CSHM", smartbill_numar: "3401", trimisa: "1" });

  // --- 2. Fiecare fel de produs --------------------------------------------------------
  console.log("\n2. De unde vine codul");
  plecate.length = 0;
  r = await trimite(982101);
  egal("a plecat", [r.cod, plecate.length], [302, 1]);
  const pr = plecate[0] ? plecate[0].corp.products : [];
  egal("câte linii", pr.length, 9);
  egal("ordinea liniilor e cea de pe factură", pr.map((x) => x.name), [
    "Folie manuala 12my rigid,1,9 kg CM", "Folie generata din caracteristici", "Produs cu cod doar din spatii",
    "Produs cu spatii in jurul codului", "Produs fara niciun cod", "Produs cu amandoua codurile", "Transport",
    "Produs configurat, cu codul scris gol", "Produs configurat, cu spatii la codul scris"]);
  egal("codul din nomenclator", pr[0] && pr[0].code, "Rigid1,9");
  egal("fără cod scris: codul generat din caracteristici", pr[1] && pr[1].code, "FSM-12-19-T");
  egal("cod doar din spații: nu e cod, pleacă P-<id-ul produsului>", pr[2] && pr[2].code, "P-982013");
  egal("spațiile din jurul codului nu pleacă", pr[3] && pr[3].code, "AB 12");
  egal("fără niciun cod: P-<id-ul produsului>", pr[4] && pr[4].code, "P-982015");
  egal("cu amândouă: cel scris în nomenclator, nu cel generat", pr[5] && pr[5].code, "X-COD");
  adevarat("linia scrisă de mână pleacă fără cheia „code”", pr[6] && !("code" in pr[6]), JSON.stringify(pr[6]));
  // Produsul făcut din configurator are codul scris gol („”, nu NULL) și codul
  // generat: golul nu trebuie să ascundă codul generat.
  egal("cod scris gol sau doar din spații, dar cu cod generat: pleacă cel generat", [pr[7] && pr[7].code, pr[8] && pr[8].code], ["GEN-17", "GEN-18"]);
  egal("codul e același cu cel de pe aviz și etichete (lib/scan.js)",
    [pr[0] && pr[0].code, pr[4] && pr[4].code], [SCAN.codProdus("Rigid1,9", 982011), SCAN.codProdus("", 982015)]);
  egal("unitățile de măsură au rămas ale produselor", pr.map((x) => x.measuringUnitName), ["buc", "rola", "buc", "kg", "buc", "buc", "buc", "buc", "buc"]);

  // --- 3. lib/smartbill.js trimite ce i se dă, nu inventează ----------------------------
  console.log("\n3. Biblioteca nu inventează coduri");
  const cf = (linii) => JSON.parse(JSON.stringify(SB.construiesteFactura({ partener_nume: "X", moneda: "RON" }, linii, {}))).products;
  egal("codul dat pleacă fără spațiile din jur", cf([{ denumire: "a", cod_smartbill: "  A1 " }])[0].code, "A1");
  egal("cod gol, din spații sau lipsă: fără cheia „code”",
    cf([{ denumire: "a", cod_smartbill: "" }, { denumire: "b", cod_smartbill: "   " }, { denumire: "c", cod_smartbill: null }, { denumire: "d" }]).map((x) => "code" in x),
    [false, false, false, false]);
  adevarat("o linie doar cu id de produs, fără cod pregătit, nu primește P-<id> din bibliotecă",
    !("code" in cf([{ id: 77, produs_id: 982011, denumire: "a" }])[0]));

  // --- 4. SmartBill refuză din cauza codului: linie scrisă de mână -------------------------
  console.log("\n4. Refuz despre cod, pe o linie scrisă de mână");
  raspuns = { ok: false, status: 400, corp: { errorText: "Produsul Transport <b>urgent</b> nu are codul specificat." } };
  plecate.length = 0;
  r = await trimite(982103);
  egal("pagina de eroare, nu întoarcere la factură", [r.cod, plecate.length], [200, 1]);
  contine("spune ce a răspuns SmartBill, care linie n-are cod, de ce și ce e de făcut", r.corp, [
    "Trimiterea către SmartBill a eșuat",
    "nu are codul specificat",
    "SmartBill cere cod la fiecare produs de pe factură",
    "Linia",
    "e scrisă de mână, fără produs ales din nomenclator, așa că n-are cod",
    "Factura trebuie făcută din nou, cu produsul ales din listă pe linia aceea",
    "Ploiesti, Prahova, Romania",
  ], ["Produsele au plecat cu codurile", "Liniile"]);
  contine("numele liniei e scris ca text, nu ca HTML", r.corp, ["<strong>Transport &lt;b&gt;urgent&lt;/b&gt;</strong>"], ["<strong>Transport <b>urgent</b></strong>"]);
  egal("factura refuzată nu e trecută ca trimisă", unul("SELECT (smartbill_sync_la IS NULL)::int FROM facturi WHERE id = 982103"), "1");

  raspuns = { ok: false, status: 400, corp: { errorText: "Produsul Transport nu are codul specificat." } };
  r = await trimite(982104);
  contine("două linii scrise de mână: le numește pe amândouă, la plural", r.corp, [
    "Liniile", "<strong>Transport</strong>, <strong>Manopera</strong>", "sunt scrise de mână", "așa că n-au cod", "pe liniile acelea",
  ], ["Linia\n", "n-are cod"]);

  r = await trimite(982101);
  contine("factură cu produse și o linie scrisă de mână: numește doar linia fără cod", r.corp,
    ["<strong>Transport</strong>", "e scrisă de mână"], ["<strong>Folie manuala", "Produsele au plecat cu codurile"]);

  // --- 5. SmartBill refuză din cauza codului, deși toate liniile au cod -------------------
  console.log("\n5. Refuz despre cod, cu toate liniile cu cod");
  exec("UPDATE facturi SET smartbill_sync_la = NULL, smartbill_serie = NULL, smartbill_numar = NULL WHERE id = 982102");
  raspuns = { ok: false, status: 400, corp: { errorText: "Produsul Folie manuala 12my rigid,1,9 kg CM nu are codul specificat." } };
  r = await trimite(982102);
  contine("arată cu ce cod a plecat fiecare produs și unde se corectează", r.corp, [
    "Produsele au plecat cu codurile",
    "Folie manuala 12my rigid,1,9 kg CM — <strong>Rigid1,9</strong>",
    "corectează-l în fișa produsului și trimite din nou",
  ], ["scrisă de mână", "făcută din nou"]);
  egal("și aici factura rămâne netrimisă", unul("SELECT (smartbill_sync_la IS NULL)::int FROM facturi WHERE id = 982102"), "1");

  // --- 6. Altă eroare: lămurirea despre cod nu apare ----------------------------------------
  console.log("\n6. Altă eroare de la SmartBill");
  raspuns = { ok: false, status: 400, corp: { errorText: "Codul fiscal al clientului nu este valid" } };
  r = await trimite(982102);
  contine("eroarea despre codul fiscal al clientului nu aduce lămurirea despre codul produsului", r.corp,
    ["Codul fiscal al clientului nu este valid", "Ploiesti, Prahova, Romania", "fișa clientului"],
    ["Produsele au plecat cu codurile", "SmartBill cere cod la fiecare produs"]);
  raspuns = { ok: false, status: 400, corp: { errorText: "judetul nu este valid" } };
  r = await trimite(982103);
  contine("nici la o eroare de adresă, chiar pe o factură cu linie fără cod", r.corp,
    ["judetul nu este valid"], ["SmartBill cere cod la fiecare produs", "Produsele au plecat cu codurile"]);

  // --- 7. După corectare, aceeași factură pleacă ---------------------------------------------
  console.log("\n7. Retrimiterea");
  raspuns = { ok: true, status: 200, corp: { series: "CSHM", number: "3402" } };
  plecate.length = 0;
  r = await trimite(982102);
  egal("retrimisă după refuz: pleacă, tot cu codul produsului", [r.cod, plecate[0] && plecate[0].corp.products[0].code], [302, "Rigid1,9"]);
  egal("acum e trecută ca trimisă", q("SELECT smartbill_numar, (smartbill_sync_la IS NOT NULL)::int AS trimisa FROM facturi WHERE id = 982102")[0],
    { smartbill_numar: "3402", trimisa: "1" });

  for (const s of CURATENIE) exec(s);
  console.error = eroareVeche;
  console.log(rele ? `\n${rele} PROBLEME, ${bune} verificări bune.` : `\n${bune} verificări trecute.`);
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error = eroareVeche;
  console.error("\nCĂZUT:", e && e.stack ? e.stack : e);
  try { for (const s of CURATENIE) exec(s); } catch (_) { /* curățenia se reface la următoarea rulare */ }
  process.exit(1);
});
