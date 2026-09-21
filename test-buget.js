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
const { explicatia } = require(path.join(RAD, "lib", "conturi.js"));
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
    `CREATE TABLE IF NOT EXISTS buget_valori (
       id SERIAL PRIMARY KEY, an INTEGER NOT NULL, luna INTEGER NOT NULL,
       categorie_id INTEGER NOT NULL REFERENCES buget_categorii(id), cont TEXT, suma REAL NOT NULL DEFAULT 0)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_buget_valori_unic ON buget_valori (an, luna, categorie_id, COALESCE(cont, ''))",
    `DELETE FROM buget_valori WHERE an = ${AN}`,
    `DELETE FROM buget_conturi WHERE categorie_id IN (SELECT id FROM buget_categorii WHERE an = ${AN})`,
    `DELETE FROM buget_categorii WHERE an = ${AN}`,
    `DELETE FROM balante_snapshot WHERE eticheta LIKE 'TEST BUGET %'`,
    // 2089: an încheiat. 2090: opt luni (01.01 → 31.08), ca să testăm anualizarea.
    // ATENȚIE la fixtura asta: Conta ÎNCHIDE LUNAR clasele 6 și 7 prin 121,
    // deci pe fiecare cont debitul și creditul ajung EGALE. Dacă fixtura ar
    // avea doar o parte completată, testul ar trece și cu formula greșită
    // („credit minus debit"), care pe date reale dă zero peste tot.
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c) VALUES
       ('${E25}','2089-01-01','2089-12-31','607','Cheltuieli marfuri',100000,100000),
       ('${E25}','2089-01-01','2089-12-31','6021','Consumabile',20000,20000),
       ('${E25}','2089-01-01','2089-12-31','641','Salarii',300000,300000),
       ('${E25}','2089-01-01','2089-12-31','666','Dobanzi',50000,50000),
       ('${E25}','2089-01-01','2089-12-31','6588','Cheltuiala rara',7000,7000),
       ('${E25}','2089-01-01','2089-12-31','707','Venituri marfuri',900000,900000),
       ('${E25}','2089-01-01','2089-12-31','6','Total clasa 6',477000,477000),
       ('${E25}','2089-01-01','2089-12-31','60','Total grupa 60',120000,120000)`,
    // Balanțe LUNARE cumulate, ca să putem verifica defalcarea pe luni:
    // „la 31.01" = ianuarie, „la 28.02" = ianuarie + februarie.
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c) VALUES
       ('${E26} ian','2090-01-01','2090-01-31','607','Cheltuieli marfuri',10000,10000),
       ('${E26} ian','2090-01-01','2090-01-31','6021','Consumabile',2000,2000),
       ('${E26} ian','2090-01-01','2090-01-31','641','Salarii',25000,25000),
       ('${E26} ian','2090-01-01','2090-01-31','666','Dobanzi',5000,5000),
       ('${E26} ian','2090-01-01','2090-01-31','6588','Cheltuiala rara',400,400),
       ('${E26} ian','2090-01-01','2090-01-31','707','Venituri marfuri',70000,70000)`,
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c) VALUES
       ('${E26} feb','2090-01-01','2090-02-28','607','Cheltuieli marfuri',22000,22000),
       ('${E26} feb','2090-01-01','2090-02-28','6021','Consumabile',4200,4200),
       ('${E26} feb','2090-01-01','2090-02-28','641','Salarii',50000,50000),
       ('${E26} feb','2090-01-01','2090-02-28','666','Dobanzi',10000,10000),
       ('${E26} feb','2090-01-01','2090-02-28','6588','Cheltuiala rara',800,800),
       ('${E26} feb','2090-01-01','2090-02-28','707','Venituri marfuri',150000,150000)`,
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c) VALUES
       ('${E26}','2090-01-01','2090-08-31','607','Cheltuieli marfuri',80000,80000),
       ('${E26}','2090-01-01','2090-08-31','6021','Consumabile',16000,16000),
       ('${E26}','2090-01-01','2090-08-31','641','Salarii',200000,200000),
       ('${E26}','2090-01-01','2090-08-31','666','Dobanzi',40000,40000),
       ('${E26}','2090-01-01','2090-08-31','6588','Cheltuiala rara',3000,3000),
       ('${E26}','2090-01-01','2090-08-31','707','Venituri marfuri',600000,600000)`,
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
  egal("cheltuiala e pe debit, venitul pe credit — nu diferența dintre ele",
    [r25.get("607").val, r25.get("707").val], [100000, 900000]);
  if (r25.get("707").val === 0) rau("închiderea lunară prin 121 a anulat veniturile");
  else ok("închiderea lunară prin 121 nu anulează cifrele");

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
  // Bugetul efectiv e suma celor 12 luni, fiecare = anualul/12 — deci apare
  // zgomotul obișnuit al virgulei mobile. Se compară cu toleranță de un ban,
  // nu pe egalitate exactă.
  const aproape = (eticheta, avut, asteptat, toleranta) => {
    if (Math.abs(Number(avut) - Number(asteptat)) <= toleranta)
      ok(eticheta + " = " + Math.round(Number(avut) * 100) / 100);
    else rau(eticheta, "am " + avut + ", așteptam " + asteptat);
  };
  aproape("cifra scrisă de om ajunge în buget",
    d4.cheltuieli.find((x) => x.nume === "Mărfuri vândute").bugetat, 123456.78, 0.01);

  // --- prepopularea din anul anterior anualizat ------------------------------------
  await cer("/buget/:an/salveaza", { metoda: "post", params: { an: String(AN) }, body: { prepopuleaza: "1" } });
  const d5 = await mod.tabloul(AN);
  aproape("prepopularea pune anualizatul peste tot",
    d5.totaluri.cheltuieli.bugetat, d5.totaluri.cheltuieli.ante1Anualizat, 1);

  // --- prepopularea cu creștere ------------------------------------------------------
  // Procentul se aplică pe FIECARE linie. Dacă s-ar aplica pe total, rândurile
  // n-ar mai însuma totalul și corectarea rând cu rând ar deveni imposibilă.
  await cer("/buget/:an/salveaza", {
    metoda: "post", params: { an: String(AN) }, body: { prepopuleaza: "1", crestere: "10" },
  });
  const d6 = await mod.tabloul(AN);
  aproape("creșterea de 10% urcă totalul cu exact 10%",
    d6.totaluri.cheltuieli.bugetat, d6.totaluri.cheltuieli.ante1Anualizat * 1.1, 1);
  aproape("și se vede pe fiecare linie, nu doar pe total",
    d6.cheltuieli.find((x) => x.nume === "Salarii").bugetat,
    d6.cheltuieli.find((x) => x.nume === "Salarii").ante1Anualizat * 1.1, 1);
  // Fiecare categorie se scrie rotunjită la doi bani; însumate, pot ieși
  // câțiva bani față de produsul nerotunjit. Un leu toleranță.
  aproape("veniturile cresc și ele",
    d6.totaluri.venituri.bugetat, d6.totaluri.venituri.ante1Anualizat * 1.1, 1);

  // Procent scris cu virgulă, și unul negativ — amândouă sunt cifre.
  await cer("/buget/:an/salveaza", {
    metoda: "post", params: { an: String(AN) }, body: { prepopuleaza: "1", crestere: "-7,5" },
  });
  const d7 = await mod.tabloul(AN);
  aproape("un procent negativ scris cu virgulă scade bugetul",
    d7.totaluri.cheltuieli.bugetat, d7.totaluri.cheltuieli.ante1Anualizat * 0.925, 1);

  // Gol înseamnă zero la sută, nu „nu aplica” — butonul tot prepopulează.
  await cer("/buget/:an/salveaza", {
    metoda: "post", params: { an: String(AN) }, body: { prepopuleaza: "1", crestere: "" },
  });
  const d8 = await mod.tabloul(AN);
  aproape("fără procent scris, prepopularea pune exact anualizatul",
    d8.totaluri.cheltuieli.bugetat, d8.totaluri.cheltuieli.ante1Anualizat, 1);

  // --- realizatul pe LUNĂ, din balanțe cumulate ---------------------------------------
  // Balanțele din Conta sunt cumulate de la 1 ianuarie. Dacă s-ar citi direct,
  // februarie ar apărea cu cifra lui ianuarie inclusă — plauzibil și greșit.
  const lunar = await mod.realizatLunar(2090);
  egal("ianuarie e cât zice balanța de ianuarie", rot(lunar.peLuna.get("607")[0]), 10000);
  egal("februarie e DIFERENȚA, nu cumulatul", rot(lunar.peLuna.get("607")[1]), 12000);
  egal("la fel la venituri", rot(lunar.peLuna.get("707")[1]), 80000);
  egal("lunile fără balanță rămân necunoscute, nu zero",
    [lunar.acoperite[0], lunar.acoperite[1], lunar.acoperite[8], lunar.acoperite[11]],
    [true, true, false, false]);

  // --- BALANȚA VECHE CU PERIOADĂ LUNGĂ -------------------------------------------------
  // Cazul real din 09.2026: pe 14.09 s-a tras „01.01 → 14.09", dar august nu era
  // postat, deci conținea cifrele până la 31.07. Pe 19.09 s-a tras „01.01 → 31.08",
  // cu august închis. Sortate după perioadă, cea de pe 14.09 pare cea mai proaspătă,
  // și scădea din septembrie exact cât adusese august — un storno care nu există.
  for (const s of [
    `UPDATE balante_snapshot SET incarcat_la = '2090-02-01 08:00:00' WHERE eticheta = '${E26} ian'`,
    `UPDATE balante_snapshot SET incarcat_la = '2090-03-01 08:00:00' WHERE eticheta = '${E26} feb'`,
    `UPDATE balante_snapshot SET incarcat_la = '2090-09-19 15:15:00' WHERE eticheta = '${E26}'`,
    // Balanța veche: perioadă mai lungă (14.09), trasă mai devreme (14.09 < 19.09),
    // cu cifrele rămase la nivelul lui februarie.
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c, incarcat_la) VALUES
       ('${E26} veche','2090-01-01','2090-09-14','607','Cheltuieli marfuri',22000,22000,'2090-09-14 05:30:00'),
       ('${E26} veche','2090-01-01','2090-09-14','6021','Consumabile',4200,4200,'2090-09-14 05:30:00'),
       ('${E26} veche','2090-01-01','2090-09-14','641','Salarii',50000,50000,'2090-09-14 05:30:00'),
       ('${E26} veche','2090-01-01','2090-09-14','666','Dobanzi',10000,10000,'2090-09-14 05:30:00'),
       ('${E26} veche','2090-01-01','2090-09-14','6588','Cheltuiala rara',800,800,'2090-09-14 05:30:00'),
       ('${E26} veche','2090-01-01','2090-09-14','707','Venituri marfuri',150000,150000,'2090-09-14 05:30:00')`,
  ]) exec(s);

  const snap = await mod.snapshoturileAnului(2090);
  egal("balanța veche cu perioadă lungă e sărită",
    [snap.bune.map((x) => x.eticheta), snap.ignorate.map((x) => x.eticheta)],
    [[`${E26} ian`, `${E26} feb`, E26], [`${E26} veche`]]);
  egal("și se spune de ce, cu cifrele la vedere",
    /rulaj cumulat .* la 14\.09\.2090, sub cel de la 31\.08\.2090/.test(snap.ignorate[0].motiv),
    true);
  egal("balanța de referință rămâne cea de la 31.08, nu cea de la 14.09",
    (await mod.balantaAnului(2090)).eticheta, E26);

  const lunar2 = await mod.realizatLunar(2090);
  egal("septembrie NU inventează un storno de -450.000",
    [lunar2.peLuna.get("707")[8], lunar2.acoperite[8]], [null, false]);
  egal("august rămâne întreg", rot(lunar2.peLuna.get("707")[7]), 450000);
  egal("iar totalul anului e cel din balanța bună", rot(mod.LUNI.reduce((s, _, i) => {
    const v = lunar2.peLuna.get("707")[i];
    return v == null ? s : s + v;
  }, 0)), 600000);

  // …dar ORA tragerii nu e criteriu. Balanța anuală pe un an încheiat e trasă o
  // dată și gata; dacă după ea se mai trage una scurtă, anuala rămâne cea bună.
  // (Prima variantă a regulii compara orele și arunca anuala pe 2025 — 9,3
  // milioane în loc de 18,6.)
  for (const s of [
    `UPDATE balante_snapshot SET incarcat_la = '2090-08-20 09:00:00' WHERE eticheta = '${E25}'`,
    `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, r_d, r_c, incarcat_la) VALUES
       ('${E25} scurt','2089-01-01','2089-06-30','607','Cheltuieli marfuri',40000,40000,'2090-09-20 09:00:00'),
       ('${E25} scurt','2089-01-01','2089-06-30','6021','Consumabile',9000,9000,'2090-09-20 09:00:00'),
       ('${E25} scurt','2089-01-01','2089-06-30','641','Salarii',140000,140000,'2090-09-20 09:00:00'),
       ('${E25} scurt','2089-01-01','2089-06-30','666','Dobanzi',22000,22000,'2090-09-20 09:00:00'),
       ('${E25} scurt','2089-01-01','2089-06-30','6588','Cheltuiala rara',3000,3000,'2090-09-20 09:00:00'),
       ('${E25} scurt','2089-01-01','2089-06-30','707','Venituri marfuri',400000,400000,'2090-09-20 09:00:00')`,
  ]) exec(s);

  const snap89 = await mod.snapshoturileAnului(2089);
  egal("balanța anuală trasă mai devreme decât una scurtă NU e aruncată",
    [snap89.bune.map((x) => x.eticheta), snap89.ignorate.length],
    [[`${E25} scurt`, E25], 0]);
  egal("și ea rămâne balanța de referință pe anul încheiat",
    (await mod.balantaAnului(2089)).eticheta, E25);

  for (const s of [
    `DELETE FROM balante_snapshot WHERE eticheta = '${E26} veche'`,
    `DELETE FROM balante_snapshot WHERE eticheta = '${E25} scurt'`,
  ]) exec(s);

  // --- explicația fiecărui subcont ----------------------------------------------------
  // Denumirea din balanță („Alte cheltuieli de exploatare") nu spune ce pui acolo.
  // Lista de mai jos sunt conturile REALE din balanța firmei, la 09.2026: dacă
  // vreunul rămâne fără explicație, pagina îl lasă gol și degeaba e defalcat.
  const conturiReale = ("601 6021 6022 6024 6028 603 604 6051 6052 6058 607 609 611 6123 613 615 617 622 6231 " +
    "6232 624 625 626 627 628 635 641 6421 6422 6451 6453 6458 6461 6581 6583 6584 6588 6651 666 668 6811 691 " +
    "7015 703 704 706 707 708 709 711 7583 7588 7651").split(" ");
  const faraExplicatie = conturiReale.filter((c) => !explicatia(c));
  egal("fiecare cont din balanța reală are explicație", faraExplicatie, []);
  egal("prefixul cel mai lung câștigă și la explicații",
    [explicatia("6022").slice(0, 8), explicatia("6027").slice(0, 8)],
    ["Motorină", "Ce se co"]);
  egal("un analitic inventat de contabilă tot primește explicația grupei",
    explicatia("60712345") === explicatia("607"), true);
  egal("un cont care nu e nici 6 nici 7 n-are ce explica", explicatia("401"), "");

  // --- bugetul pe lună și pe subcont ---------------------------------------------------
  const d9 = await mod.tabloul(AN);
  const catMarfuri = d9.cheltuieli.find((x) => x.nume === "Mărfuri vândute");
  const anualMarfuri = catMarfuri.bugetatAnual;

  let v = await mod.valorileBuget(AN);
  egal("fără nimic scris, luna vine din anualul împărțit la 12",
    [rot(mod.bugetLuna(catMarfuri, 3, v).suma), mod.bugetLuna(catMarfuri, 3, v).din],
    [rot(anualMarfuri / 12), "anual/12"]);

  // Scris pe categorie, pentru o lună anume.
  await cer("/buget/:an/categorie/:id", {
    metoda: "post", params: { an: String(AN), id: String(catMarfuri.id) },
    body: { ["v__3"]: "9.000" },
  });
  v = await mod.valorileBuget(AN);
  egal("cifra scrisă pe categorie bate anualul împărțit la 12",
    [mod.bugetLuna(catMarfuri, 3, v).suma, mod.bugetLuna(catMarfuri, 3, v).din], [9000, "categorie"]);

  // Scris pe subcont: bate cifra de categorie.
  await cer("/buget/:an/categorie/:id", {
    metoda: "post", params: { an: String(AN), id: String(catMarfuri.id) },
    body: { ["v_607_3"]: "4.500" },
  });
  v = await mod.valorileBuget(AN);
  egal("suma subconturilor bate cifra de categorie",
    [mod.bugetLuna(catMarfuri, 3, v).suma, mod.bugetLuna(catMarfuri, 3, v).din], [4500, "subconturi"]);

  // Golirea celulei o șterge, iar nivelul de deasupra redevine cel care contează.
  await cer("/buget/:an/categorie/:id", {
    metoda: "post", params: { an: String(AN), id: String(catMarfuri.id) },
    body: { ["v_607_3"]: "" },
  });
  v = await mod.valorileBuget(AN);
  egal("golind subcontul, cifra de categorie redevine cea care contează",
    [mod.bugetLuna(catMarfuri, 3, v).suma, mod.bugetLuna(catMarfuri, 3, v).din], [9000, "categorie"]);

  // Un subcont care nu aparține categoriei e ignorat, nu scris aiurea.
  await cer("/buget/:an/categorie/:id", {
    metoda: "post", params: { an: String(AN), id: String(catMarfuri.id) },
    body: { ["v_641_4"]: "1000" },
  });
  v = await mod.valorileBuget(AN);
  egal("un subcont străin de categorie nu se scrie", v.has(catMarfuri.id + "|641|4"), false);

  // „Împarte pe 12" întinde o sumă anuală egal pe luni, pe rândul de categorie.
  await cer("/buget/:an/categorie/:id", {
    metoda: "post", params: { an: String(AN), id: String(catMarfuri.id) },
    body: { actiune: "imparte", imparte: "120.000" },
  });
  v = await mod.valorileBuget(AN);
  egal("împărțirea pe 12 pune aceeași cifră pe fiecare lună",
    [mod.bugetLuna(catMarfuri, 1, v).suma, mod.bugetLuna(catMarfuri, 7, v).suma, mod.bugetLuna(catMarfuri, 12, v).suma],
    [10000, 10000, 10000]);
  const d10 = await mod.tabloul(AN);
  aproape("iar totalul anual al categoriei devine suma lor",
    d10.cheltuieli.find((x) => x.nume === "Mărfuri vândute").bugetat, 120000, 1);

  // --- pagina de categorie ----------------------------------------------------------
  const pc = await cer("/buget/:an/categorie/:id", { params: { an: String(AN), id: String(catMarfuri.id) } });
  const faraPc = pc.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (pc.cod !== 200) rau("pagina de categorie nu se deschide", String(pc.cod));
  else if (/NaN|Infinity|undefined</.test(faraPc)) rau("NaN/undefined în pagina de categorie");
  else {
    const lipsa = ["Intră în buget", "Realizat", "Diferență", "ian", "dec", "Pe categorie", 'name="v_607_1"']
      .filter((x) => !faraPc.includes(x));
    if (lipsa.length) rau("lipsește din pagina de categorie", lipsa.join(", "));
    else ok("pagina de categorie arată lunile, subconturile și realizatul (" + pc.corp.length + " octeți)");
  }
  const pcg = await cer("/buget/:an/categorie/:id", { user: GABI, params: { an: String(AN), id: String(catMarfuri.id) } });
  egal("un agent nu vede pagina de categorie", pcg.cod, 403);

  // --- pagina -----------------------------------------------------------------------
  const p = await cer("/buget/:an", { params: { an: String(AN) } });
  const fara = p.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (p.cod !== 200) rau("pagina nu se deschide", String(p.cod));
  else if (/NaN|Infinity|undefined</.test(fara)) rau("NaN/undefined în pagină");
  else {
    const lipsa = ["Buget " + AN, "Venituri", "Cheltuieli", "Mărfuri vândute", "Salarii", "Conturi neprinse",
      'name="crestere"', "Salvează bugetul"]
      .filter((x) => !fara.includes(x));
    if (lipsa.length) rau("lipsește din pagină", lipsa.join(", "));
    else ok("pagina se deschide curat (" + p.corp.length + " octeți)");
  }

  const pg = await cer("/buget/:an", { user: GABI, params: { an: String(AN) } });
  egal("un agent de vânzări nu vede bugetul", pg.cod, 403);

  // --- curățenie după noi ----------------------------------------------------------
  for (const s of [
    `DELETE FROM buget_valori WHERE an = ${AN}`,
    `DELETE FROM buget_conturi WHERE categorie_id IN (SELECT id FROM buget_categorii WHERE an = ${AN})`,
    `DELETE FROM buget_categorii WHERE an = ${AN}`,
    "DELETE FROM balante_snapshot WHERE eticheta LIKE 'TEST BUGET %'",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
