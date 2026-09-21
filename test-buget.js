"use strict";
// Test pentru bugetul de venituri și cheltuieli.
//
// Ce apără, în ordinea în care doare dacă se strică:
//   • UN CONT ÎNTR-O SINGURĂ CATEGORIE. Numărat de două ori, totalul iese mai
//     mare decât realitatea și nimic nu pare stricat — cea mai urâtă formă de
//     greșeală, fiindcă arată credibil;
//   • CONTURILE NEPRINSE SE VĂD. Un buget „complet" din care lipsesc 200.000
//     de lei dintr-un cont uitat e mai rău decât unul evident incomplet;
//   • sinteticul nu se adună peste analiticele lui (607 peste 6071);
//   • prefixul cel mai lung câștigă: 607 e „Mărfuri vândute", nu „Materii
//     prime" doar fiindcă începe cu 60;
//   • cheltuiala se ia pe debit, venitul pe credit. Inversate, bugetul arată
//     profit unde e pierdere.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
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
let interogari = 0;
function q(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const mod = require(path.join(RAD, "modules", "buget.js"));
const rute = { get: {}, post: {} };
mod.register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const GABI = { id: 3, nume: "Gabriela", rol: "vanzari" };
async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const rot = (v) => Math.round(Number(v));

const AN = 2091; // an de test, ca să nu atingem bugetele reale
const E25 = "TEST BUGET 2089";
const E26 = "TEST BUGET 2090";

(async () => {
  for (const s of [
    `CREATE TABLE IF NOT EXISTS buget_categorii (
       id SERIAL PRIMARY KEY, an INTEGER NOT NULL, fel TEXT NOT NULL, nume TEXT NOT NULL,
       ordine INTEGER NOT NULL DEFAULT 100, bugetat REAL NOT NULL DEFAULT 0, nota TEXT,
       creat_la TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS buget_conturi (
       id SERIAL PRIMARY KEY, categorie_id INTEGER NOT NULL REFERENCES buget_categorii(id), cont TEXT NOT NULL)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_buget_conturi_unic ON buget_conturi (categorie_id, cont)",
    `DELETE FROM buget_conturi WHERE categorie_id IN (SELECT id FROM buget_categorii WHERE an = ${AN})`,
    `DELETE FROM buget_categorii WHERE an = ${AN}`,
    `DELETE FROM balante_snapshot WHERE eticheta IN ('${E25}','${E26}')`,
    // 2089: an încheiat. 2090: opt luni (01.01 → 31.08), ca să testăm anualizarea.
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c) VALUES
       ('${E25}','2089-01-01','2089-12-31','607','Cheltuieli marfuri',100000,0),
       ('${E25}','2089-01-01','2089-12-31','6021','Consumabile',20000,0),
       ('${E25}','2089-01-01','2089-12-31','641','Salarii',300000,0),
       ('${E25}','2089-01-01','2089-12-31','666','Dobanzi',50000,0),
       ('${E25}','2089-01-01','2089-12-31','6588','Cheltuiala rara',7000,0),
       ('${E25}','2089-01-01','2089-12-31','707','Venituri marfuri',0,900000),
       ('${E25}','2089-01-01','2089-12-31','6','Total clasa 6',477000,0),
       ('${E25}','2089-01-01','2089-12-31','60','Total grupa 60',120000,0)`,
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c) VALUES
       ('${E26}','2090-01-01','2090-08-31','607','Cheltuieli marfuri',80000,0),
       ('${E26}','2090-01-01','2090-08-31','6021','Consumabile',16000,0),
       ('${E26}','2090-01-01','2090-08-31','641','Salarii',200000,0),
       ('${E26}','2090-01-01','2090-08-31','666','Dobanzi',40000,0),
       ('${E26}','2090-01-01','2090-08-31','6588','Cheltuiala rara',3000,0),
       ('${E26}','2090-01-01','2090-08-31','707','Venituri marfuri',0,600000)`,
  ]) exec(s);

  // --- regulile de bază -------------------------------------------------------
  egal("cheltuială sau venit, după prima cifră",
    [mod.felulContului("607"), mod.felulContului("707"), mod.felulContului("401")],
    ["cheltuiala", "venit", null]);
  egal("prefixul cel mai lung câștigă: 607 nu cade la „materii prime”",
    mod.categoriaImplicita("607").nume, "Mărfuri vândute");
  egal("iar 6021 cade unde trebuie", mod.categoriaImplicita("6021").nume, "Materii prime și materiale");
  egal("„1.234,50” e un număr", mod.suma("1.234,50"), 1234.5);
  egal("și „1234.5” la fel", mod.suma("1234.5"), 1234.5);

  // --- realizatul pe cont ------------------------------------------------------
  const r25 = await mod.realizatPeCont(E25);
  egal("rândurile de grup (6, 60) nu se adună peste conturile lor",
    [...r25.keys()].sort(), ["6021", "641", "6588", "666", "607", "707"].sort());
  egal("cheltuiala e pe debit, venitul pe credit",
    [r25.get("607").val, r25.get("707").val], [100000, 900000]);

  // --- tabloul ------------------------------------------------------------------
  const d = await mod.tabloul(AN);
  egal("balanța anului încheiat e găsită", d.balante.ante2 && d.balante.ante2.eticheta, E25);
  egal("și cea a anului parțial", d.balante.ante1 && d.balante.ante1.eticheta, E26);
  if (Math.abs(d.luniAnte1 - 8) > 0.3) rau("n-a socotit corect lunile acoperite", String(d.luniAnte1));
  else ok("balanța parțială e văzută ca 8 luni (" + d.luniAnte1.toFixed(1) + ")");

  egal("totalul cheltuielilor pe anul încheiat", rot(d.totaluri.cheltuieli.ante2), 477000);
  egal("totalul veniturilor pe anul încheiat", rot(d.totaluri.venituri.ante2), 900000);
  egal("anualizarea urcă cele 8 luni la 12",
    rot(d.totaluri.cheltuieli.ante1Anualizat), rot(339000 * (12 / d.luniAnte1)));

  // Categoriile s-au făcut singure, din conturile care chiar apar în balanțe.
  const numeCheltuieli = d.cheltuieli.map((x) => x.nume).sort();
  if (!numeCheltuieli.includes("Mărfuri vândute") || !numeCheltuieli.includes("Salarii"))
    rau("categoriile implicite nu s-au creat", numeCheltuieli.join(", "));
  else ok("categoriile s-au creat singure din conturile din balanță (" + numeCheltuieli.length + ")");

  egal("niciun cont neprins la prima deschidere", d.neacoperite.length, 0);
  egal("niciun cont în două categorii", d.dublate.length, 0);

  // --- scoaterea unui cont îl face vizibil ca neprins ---------------------------
  await cer("/buget/:an/salveaza", { metoda: "post", params: { an: String(AN) }, body: { scoate: "666" } });
  const d2 = await mod.tabloul(AN);
  egal("un cont scos din categoria lui apare la «neprinse»",
    d2.neacoperite.map((x) => x.cont), ["666"]);
  egal("și cu suma lui, ca să se vadă cât lipsește din total", rot(d2.neacoperite[0].ante2), 50000);
  egal("totalul scade exact cu el", rot(d2.totaluri.cheltuieli.ante2), 477000 - 50000);

  // --- mutarea într-o altă categorie NU dublează --------------------------------
  const salarii = d2.cheltuieli.find((x) => x.nume === "Salarii");
  await cer("/buget/:an/muta", {
    metoda: "post", params: { an: String(AN) },
    body: { cont: "666", categorie_id: String(salarii.id) },
  });
  const d3 = await mod.tabloul(AN);
  egal("contul mutat nu mai e neprins", d3.neacoperite.length, 0);
  egal("și nu e în două categorii deodată", d3.dublate.length, 0);
  egal("totalul se întoarce la cât era", rot(d3.totaluri.cheltuieli.ante2), 477000);
  egal("iar suma a aterizat în categoria în care am pus-o",
    rot(d3.cheltuieli.find((x) => x.nume === "Salarii").ante2), 350000);

  // --- scrierea bugetului ---------------------------------------------------------
  const marfuri = d3.cheltuieli.find((x) => x.nume === "Mărfuri vândute");
  await cer("/buget/:an/salveaza", {
    metoda: "post", params: { an: String(AN) },
    body: { ["b_" + marfuri.id]: "123.456,78" },
  });
  const d4 = await mod.tabloul(AN);
  egal("cifra scrisă de om ajunge în buget",
    d4.cheltuieli.find((x) => x.nume === "Mărfuri vândute").bugetat, 123456.78);

  // --- prepopularea din anul anterior anualizat ------------------------------------
  await cer("/buget/:an/salveaza", { metoda: "post", params: { an: String(AN) }, body: { prepopuleaza: "1" } });
  const d5 = await mod.tabloul(AN);
  egal("prepopularea pune anualizatul peste tot",
    rot(d5.totaluri.cheltuieli.bugetat), rot(d5.totaluri.cheltuieli.ante1Anualizat));

  // --- pagina -----------------------------------------------------------------------
  const p = await cer("/buget/:an", { params: { an: String(AN) } });
  const fara = p.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (p.cod !== 200) rau("pagina nu se deschide", String(p.cod));
  else if (/NaN|Infinity|undefined</.test(fara)) rau("NaN/undefined în pagină");
  else {
    const lipsa = ["Buget " + AN, "Venituri", "Cheltuieli", "Mărfuri vândute", "Salarii", "Conturi neprinse"]
      .filter((x) => !fara.includes(x));
    if (lipsa.length) rau("lipsește din pagină", lipsa.join(", "));
    else ok("pagina se deschide curat (" + p.corp.length + " octeți)");
  }

  const pg = await cer("/buget/:an", { user: GABI, params: { an: String(AN) } });
  egal("un agent de vânzări nu vede bugetul", pg.cod, 403);

  // --- curățenie după noi ----------------------------------------------------------
  for (const s of [
    `DELETE FROM buget_conturi WHERE categorie_id IN (SELECT id FROM buget_categorii WHERE an = ${AN})`,
    `DELETE FROM buget_categorii WHERE an = ${AN}`,
    `DELETE FROM balante_snapshot WHERE eticheta IN ('${E25}','${E26}')`,
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
