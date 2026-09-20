"use strict";
// Test pentru legarea emailurilor de firme.
//
// De ce există, în cifre: din 1.805 mesaje intrate în ERP, 1.789 erau „de
// atribuit". Nouăzeci și nouă la sută. Tot ce e construit deasupra —
// semnături, taskuri, comenzi, oferte — cere un partener legat, deci lucra
// practic pe nimic.
//
// Ce se verifică aici e exact ce face diferența între „merge" și „pare că
// merge":
//   1. miezul unui domeniu și numele unei firme, potrivite fără diacritice și
//      fără forma juridică — „euroink.it" cu „EUROINK DISTRIBUTION SRL";
//   2. ce NU se leagă niciodată: gmail, yahoo, domeniul nostru;
//   3. un domeniu revendicat de două firme nu se leagă de niciuna;
//   4. un clic de atribuire leagă tot domeniul, nu doar mesajul;
//   5. nimic nu suprascrie un mesaj legat deja de un om.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

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
const exec1 = (sql) =>
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

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

const L = require(path.join(RAD, "modules", "legare.js"));

let rele = 0;
function egal(ce, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) { rele++; console.log("  PROBLEMĂ " + ce + ": am " + a + ", așteptam " + b); }
  else console.log("  ok       " + ce + " = " + b);
}

console.log("Legarea emailurilor de firme\n");

// --- 1. miezul domeniului --------------------------------------------------
console.log("miezul domeniului");
for (const [d, n] of [
  ["euroink.it", "euroink"],
  ["mail.euroink.it", "euroink"],
  ["apacargo.ro", "apacargo"],
  ["aectra.ro", "aectra"],
  ["rotapack.hu", "rotapack"],
  ["work-finder.eu", "work-finder"],
  ["ctp.eu", "ctp"],
  ["some.firma.com.tr", "firma"],
  ["nume.co.uk", "nume"],
]) egal(`  ${d}`, L.nucleu(d), n);

// --- 2. numele firmei, strâns ----------------------------------------------
console.log("\nnumele firmei");
for (const [nume, strans] of [
  ["EUROINK DISTRIBUTION SRL", "euroinkdistribution"],
  ["AECTRA PLASTICS S.R.L.", "aectraplastics"],
  ["CARMANGERIA GODAC SRL", "carmangeriagodac"],
  ["Uniglass Glassworks SRL", "uniglassglassworks"],
  ["ASOCIAȚIA SPORTIVĂ ȘOIMII", "asociatiasportivasoimii"],
]) egal(`  ${nume}`, L.numeStrans(nume), strans);

// --- 3. ce nu se leagă niciodată -------------------------------------------
console.log("\ndomenii pe care nu le legăm");
for (const [d, ok] of [
  ["gmail.com", false],
  ["yahoo.ro", false],
  ["cashmachine.ro", false],
  ["mail.cashmachine.ro", false],
  ["euroink.it", true],
  ["", false],
  ["fara-punct", false],
]) egal(`  ${d || "(gol)"}`, L.eFolositor(d), ok);

egal("  domeniul se scoate din adresă", L.domeniulDin("Comercial <COMERCIAL@Euroink.IT>"), "euroink.it");

// --- 4. pe bază reală -------------------------------------------------------
(async () => {
  console.log("\npe bază reală");
  exec1(`DELETE FROM email_domenii WHERE domeniu LIKE '%legtest%'`);
  exec1(`DELETE FROM email_mesaje WHERE gmail_id LIKE 'legtest-%'`);
  exec1(`DELETE FROM email_conturi WHERE adresa = 'legtest@cashmachine.ro'`);
  exec1(`DELETE FROM mk_contacte WHERE partener_id IN (SELECT id FROM parteneri WHERE cui LIKE 'RO-LEG-%')`);
  exec1(`DELETE FROM parteneri WHERE cui LIKE 'RO-LEG-%'`);

  const cont = Number(q(`INSERT INTO email_conturi (adresa, tip, activ) VALUES ('legtest@cashmachine.ro','comun',1) RETURNING id`)[0].id);
  const euroink = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('EUROINK LEGTEST DISTRIBUTION SRL','RO-LEG-1','furnizor') RETURNING id`)[0].id);
  const aectra = Number(q(`INSERT INTO parteneri (nume, cui, tip, email) VALUES ('AECTRA LEGTEST PLASTICS SRL','RO-LEG-2','furnizor','office@aectralegtest.ro') RETURNING id`)[0].id);
  // două firme cu același domeniu pe fișă: nu trebuie legat niciuna
  const geam1 = Number(q(`INSERT INTO parteneri (nume, cui, tip, email) VALUES ('GEAMURI UNU SRL','RO-LEG-3','client','a@geamlegtest.ro') RETURNING id`)[0].id);
  const geam2 = Number(q(`INSERT INTO parteneri (nume, cui, tip, email) VALUES ('GEAMURI DOI SRL','RO-LEG-4','client','b@geamlegtest.ro') RETURNING id`)[0].id);

  const ieri = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace("T", " ");
  function mesaj(gid, deLa, domeniu) {
    return Number(q(
      `INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, corp, directie, activ)
       VALUES (?,?,?,?,'Cineva',?,'test','text','primit',1) RETURNING id`,
      [cont, gid, ieri, deLa, domeniu]
    )[0].id);
  }

  const e1 = mesaj("legtest-1", "comercial@euroinklegtest.it", "euroinklegtest.it");
  const e2 = mesaj("legtest-2", "vanzari@euroinklegtest.it", "euroinklegtest.it");
  const e3 = mesaj("legtest-3", "andreea@aectralegtest.ro", "aectralegtest.ro");
  const e4 = mesaj("legtest-4", "cineva@gmail.com", "gmail.com");
  const e5 = mesaj("legtest-5", "x@geamlegtest.ro", "geamlegtest.ro");

  // --- harta: doar fișele, deocamdată
  let h = await L.hartaDomenii();
  egal("  domeniul din fișă intră în hartă", h.harta.has("aectralegtest.ro"), true);
  egal("  domeniul revendicat de două firme e marcat ambiguu", h.ambigue.has("geamlegtest.ro"), true);
  egal("  și NU e în hartă", h.harta.has("geamlegtest.ro"), false);
  egal("  domeniul necunoscut nu e în hartă", h.harta.has("euroinklegtest.it"), false);

  // --- legarea în masă, doar pe ce știm
  let r = await L.releagaTot();
  egal("  s-a legat un singur mesaj (cel de la AECTRA)",
    Number(q(`SELECT COUNT(*) AS n FROM email_mesaje WHERE gmail_id LIKE 'legtest-%' AND partener_id IS NOT NULL`)[0].n), 1);
  egal("  și e legat de firma corectă",
    Number(q(`SELECT id, partener_id FROM email_mesaje WHERE id = ${e3}`)[0].partener_id), aectra);
  egal("  scrie de unde știe", q(`SELECT id, legat_cum FROM email_mesaje WHERE id = ${e3}`)[0].legat_cum, "domeniul aectralegtest.ro");

  // --- propunerile după nume
  const props = await L.sugestii({ minim: 1 });
  const pEuroink = props.find((x) => x.domeniu === "euroinklegtest.it");
  egal("  se propune EUROINK pentru euroinklegtest.it",
    pEuroink && pEuroink.propus ? Number(pEuroink.propus.id) : null, euroink);
  egal("  gmail.com nu apare deloc în propuneri", props.some((x) => x.domeniu === "gmail.com"), false);

  // --- un clic ține minte domeniul și leagă tot
  await L.tineMinte("euroinklegtest.it", euroink, null, "om");
  r = await L.releagaTot();
  egal("  după un singur clic, ambele mesaje de pe domeniu sunt legate",
    Number(q(`SELECT COUNT(*) AS n FROM email_mesaje WHERE id IN (${e1},${e2}) AND partener_id = ${euroink}`)[0].n), 2);

  // --- ce a pus un om nu se atinge
  exec1(`UPDATE email_mesaje SET partener_id = ${aectra}, legat_cum = 'pus de om' WHERE id = ${e1}`);
  await L.releagaTot();
  egal("  un mesaj pus de om rămâne unde l-a pus omul",
    Number(q(`SELECT id, partener_id FROM email_mesaje WHERE id = ${e1}`)[0].partener_id), aectra);

  // --- gmail nu se leagă niciodată
  // Se cer DOUĂ coloane dinadins: psql --csv scrie un rând gol pentru un
  // singur câmp NULL, iar filtrul de linii goale din harnașamentul testului
  // l-ar înghiți cu totul, și am compara cu undefined fără să știm de ce.
  egal("  mesajul de pe gmail a rămas nelegat",
    q(`SELECT id, partener_id FROM email_mesaje WHERE id = ${e4}`)[0].partener_id, null);
  egal("  și cel de pe domeniul ambiguu la fel",
    q(`SELECT id, partener_id FROM email_mesaje WHERE id = ${e5}`)[0].partener_id, null);

  // --- dinDomeniu
  egal("  dinDomeniu găsește ce s-a învățat", await L.dinDomeniu("euroinklegtest.it"), euroink);
  egal("  dinDomeniu citește și fișa", await L.dinDomeniu("aectralegtest.ro"), aectra);
  egal("  dinDomeniu refuză gmail", await L.dinDomeniu("gmail.com"), null);

  // --- o a doua rulare nu schimbă nimic
  const inainte = q(`SELECT id, partener_id FROM email_mesaje WHERE gmail_id LIKE 'legtest-%' ORDER BY id`);
  await L.releagaTot();
  const dupa = q(`SELECT id, partener_id FROM email_mesaje WHERE gmail_id LIKE 'legtest-%' ORDER BY id`);
  egal("  a doua rulare nu mișcă nimic", JSON.stringify(dupa), JSON.stringify(inainte));

  // --- curățenie
  exec1(`DELETE FROM email_domenii WHERE domeniu LIKE '%legtest%'`);
  exec1(`DELETE FROM email_mesaje WHERE gmail_id LIKE 'legtest-%'`);
  exec1(`DELETE FROM email_conturi WHERE id = ${cont}`);
  exec1(`DELETE FROM parteneri WHERE cui LIKE 'RO-LEG-%'`);

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
