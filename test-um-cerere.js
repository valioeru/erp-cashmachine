"use strict";
// Unitatea de măsură a cererii din depozit (lib/um-cerere.js).
//
// CE A CERUT VALI, 16.11.2026, cu poza comenzii #107 (Folie stretch, 160 kg):
//   „Dacă a cerut kg, în comandă de ce apare în producție 160 rolă?"
//   „Ar trebui corectat aici."
//
// CE APĂRĂ:
//   • cererea depozitului pentru o linie se scrie în unitatea liniei din
//     comanda clientului (kg), nu în cea a produsului din nomenclator (rola);
//     cererea pentru stoc, în unitatea produsului;
//   • lista „Cereri din depozit" a producției, comanda de producție făcută la
//     confirmare și linia ei au unitatea cererii;
//   • pagina comenzii (Aprovizionare cerută, În producție) și pagina din
//     depozit (linia clientului, „comandat …") arată aceeași unitate;
//   • o cerere veche, fără unitate scrisă, ia unitatea liniei; fără linie, a
//     produsului;
//   • paleții puși din cerere (lib/gata-productie.js) iau unitatea cererii;
//   • corectura din 16.11.2026 (lib/db.js, ALTERARI) trece comenzile de
//     producție greșite pe unitatea liniei, o singură dată, și nu atinge ce
//     are recepție sau altă unitate.
//
// Pe PostgreSQL real (port 5433), prin psql.
const path = require("path");
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
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); }, trimiteDeLa: async () => { throw new Error("test: fără email"); } };
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
      const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "gata-productie.js")).register(router);
require(path.join(RAD, "modules", "comenzi.js")).register(router);
require(path.join(RAD, "modules", "productie.js")).register(router);
require(path.join(RAD, "modules", "receptie.js")).register(router);
require(path.join(RAD, "modules", "warehouse.js")).register(router);
const GP = require(path.join(RAD, "lib", "gata-productie.js"));
const UMC = require(path.join(RAD, "lib", "um-cerere.js"));
q("ALTER TABLE aprovizionari ADD COLUMN IF NOT EXISTS um TEXT");

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query } = {}) {
  let h = rute[metoda][cale];
  let par = {};
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
  const r = res();
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase(), headers: {} } });
  return r;
}
const unde = (r) => String((r.antet && (r.antet.Location || r.antet.location)) || "");
const parametri = (r) => Object.fromEntries(new URL(unde(r), "http://erp.test").searchParams);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
const cate = (text, ce) => (String(text).match(new RegExp(ce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
// ---- datele de test ------------------------------------------------------
const PREFIX = "TUMC";
const PARTENER = 96711;
const P1 = 96721;
const ADMIN = { id: 96731, nume: "Vali Admin", rol: "admin", sectiuni: "" };
const CP_FIX = 1578; // id din corectura de pe 16.11.2026 (lib/db.js)
const LIBER = () => !q(`SELECT id FROM comenzi_productie WHERE id = ${CP_FIX}`).length || q(`SELECT id FROM comenzi_productie WHERE id = ${CP_FIX} AND numar LIKE '${PREFIX}-%'`).length;

function curata() {
  const cmd = q(`SELECT id FROM comenzi WHERE partener_id = ${PARTENER}`).map((x) => Number(x.id));
  const cps = q(`SELECT id FROM comenzi_productie WHERE produs_id = ${P1} OR numar LIKE '${PREFIX}-%'`).map((x) => Number(x.id));
  if (cps.length) {
    q(`DELETE FROM comenzi_productie_caracteristici WHERE comanda_id IN (${cps.join(",")})`);
    q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${cps.join(",")})`);
    q(`UPDATE receptii SET comanda_productie_id = NULL WHERE comanda_productie_id IN (${cps.join(",")}) AND numar LIKE '${PREFIX}-%'`);
    q(`DELETE FROM receptii WHERE numar LIKE '${PREFIX}-%'`);
    q(`DELETE FROM comenzi_productie WHERE id IN (${cps.join(",")})`);
  }
  q(`DELETE FROM aprovizionari WHERE produs_id = ${P1}`);
  if (cmd.length) {
    q(`DELETE FROM comenzi_istoric WHERE comanda_id IN (${cmd.join(",")})`);
    q(`DELETE FROM rezervari_stoc WHERE comanda_id IN (${cmd.join(",")})`);
    q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${cmd.join(",")})`);
    q(`DELETE FROM comenzi WHERE id IN (${cmd.join(",")})`);
  }
  q(`DELETE FROM produse WHERE id = ${P1}`);
  q(`DELETE FROM parteneri WHERE id = ${PARTENER}`);
}
const cuData = (zile) => { const d = new Date(Date.now() + zile * 86400000); return d.toISOString().slice(0, 10); };

(async () => {
  curata();

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${PARTENER}, 'client', '${PREFIX} Client SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P1}, 'TUMC-FOLIE', '${PREFIX} Folie stretch 23 microni 16 kg', 'rola')`);
  const C = Number(q(`INSERT INTO comenzi (partener_id, numar, data, status) VALUES (${PARTENER}, '${PREFIX}-107', '2026-11-16', 'confirmata') RETURNING id`)[0].id);
  const L = Number(q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (${C}, ${P1}, 160, 10, 'kg') RETURNING id`)[0].id);

  console.log("1. Regula");
  egal("cererea, apoi linia, apoi produsul", [UMC.umCerere({ um: "kg" }, { um: "rolă" }, { unitate_masura: "rola" }), UMC.umCerere({ um: " " }, { um: "kg" }, { unitate_masura: "rola" }), UMC.umCerere(null, { um: "" }, { unitate_masura: "rola" }), UMC.umCerere(null, null, null)], ["kg", "kg", "rola", "buc"]);

  console.log("\n2. Depozitul cere de la producție cât lipsește din linie");
  let r = await cer("get", `/depozit/comanda/${C}`, ADMIN);
  bine("pe pagina din depozit, linia clientului e în kg (unitatea liniei), nu în rola", r.cod === 200 && />160 kg</.test(r.corp) && !/>160 rola</.test(r.corp), (r.corp.match(/>160 [^<]*</) || [""])[0]);
  r = await cer("post", `/depozit/comanda/${C}/aprovizionare`, ADMIN, { body: { linie_id: String(L), cantitate: "160", sursa: "productie", termen_cerut: cuData(3) } });
  const A = q(`SELECT * FROM aprovizionari WHERE comanda_id = ${C}`)[0] || {};
  egal("cererea se scrie în unitatea liniei", [Number(A.cantitate), A.um, Number(A.linie_id)], [160, "kg", L]);
  r = await cer("get", `/depozit/comanda/${C}`, ADMIN);
  bine("…și sub linie scrie „comandat 160 kg din producție”", r.corp.includes("comandat 160 kg din producție"), (r.corp.match(/comandat [^·<]*/) || [""])[0]);
  r = await cer("get", "/productie/cereri", ADMIN);
  const randCerere = (r.corp.match(new RegExp(`${PREFIX} Folie stretch[\\s\\S]*?</tr>`)) || [""])[0];
  bine("producția vede în lista ei „160 kg”", r.cod === 200 && randCerere.includes("160 kg") && !randCerere.includes("160 rola"), randCerere.slice(0, 200));
  r = await cer("get", "/depozit/aprovizionare", ADMIN);
  const randAprov = (r.corp.match(new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*${PREFIX}-107(?:(?!</tr>)[\\s\\S])*</tr>`)) || [""])[0];
  bine("…la fel lista „De aprovizionat”", randAprov.includes("<td>160 kg</td>"), randAprov.slice(0, 300));

  console.log("\n3. Producția confirmă: comanda de producție are unitatea cererii");
  r = await cer("post", `/productie/cereri/${A.id}/confirma`, ADMIN, { body: { termen: cuData(3) } });
  const CP = q(`SELECT * FROM comenzi_productie WHERE aprovizionare_id = ${A.id}`)[0] || {};
  egal("comanda de producție: 160 kg", [CP.cantitate, CP.um], ["160", "kg"]);
  egal("…și linia ei: 160 kg", q(`SELECT cantitate, um FROM comenzi_productie_linii WHERE comanda_id = ${CP.id || 0}`).map((x) => [Number(x.cantitate), x.um]), [[160, "kg"]]);
  r = await cer("get", `/comenzi/${C}`, ADMIN);
  bine("pagina comenzii: „Aprovizionare cerută” 160 kg și „În producție” 160 kg", r.cod === 200 && /<td>160 kg<\/td>/.test(r.corp) && (r.corp.match(/<td>160 kg<\/td>/g) || []).length >= 2 && !r.corp.includes("160 rola"), (r.corp.match(/<td>160[^<]*<\/td>/g) || []).join(" "));

  console.log("\n4. Cererile vechi, fără unitate scrisă");
  q(`UPDATE aprovizionari SET um = NULL WHERE id = ${A.id}`);
  r = await cer("get", "/productie/cereri", ADMIN);
  bine("cererea pentru o linie ia unitatea liniei", (r.corp.match(new RegExp(`${PREFIX} Folie stretch[\\s\\S]*?</tr>`)) || [""])[0].includes("160 kg"));
  r = await cer("post", "/depozit/aprovizionare", ADMIN, { body: { produs_id: String(P1), cantitate: "5", sursa: "productie", termen_cerut: cuData(5) } });
  const S = q(`SELECT * FROM aprovizionari WHERE produs_id = ${P1} AND comanda_id IS NULL`)[0] || {};
  egal("cererea pentru stoc se scrie în unitatea produsului", [Number(S.cantitate), S.um], [5, "rola"]);
  q(`UPDATE aprovizionari SET um = NULL WHERE id = ${S.id || 0}`);
  r = await cer("get", "/productie/cereri", ADMIN);
  bine("…iar una veche fără linie ia unitatea produsului", /<td>5 rola<\/td>/.test(r.corp));

  console.log("\n5. Paleții puși din cerere iau unitatea ei");
  q(`UPDATE aprovizionari SET status = 'gata' WHERE id = ${A.id}`);
  const unu = await GP.cerere(A.id);
  egal("cererea pentru paleți: kg", unu && unu.um, "kg");
  const lista = (await GP.cereri()).filter((x) => x.cheie === "c" + A.id);
  egal("…și în lista „De alocat pe raft”", lista.map((x) => x.um), ["kg"]);
  q(`UPDATE aprovizionari SET status = 'confirmata' WHERE id = ${A.id}`);

  console.log("\n6. Corectura din 16.11.2026 (o singură dată, doar unde se potrivește)");
  const sursa = require("fs").readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
  const bucata = sursa.slice(sursa.indexOf("ALTER TABLE aprovizionari ADD COLUMN IF NOT EXISTS um TEXT;"), sursa.indexOf("`;", sursa.indexOf("ALTER TABLE aprovizionari ADD COLUMN IF NOT EXISTS um TEXT;")));
  const corecturi = bucata.split(";").map((x) => x.replace(/--[^\n]*/g, "").trim()).filter((x) => /^UPDATE /.test(x));
  egal("două corecturi: liniile și comanda de producție", corecturi.length, 2);
  if (LIBER()) {
    const ruleaza = () => corecturi.forEach((x) => q(x));
    q(`DELETE FROM comenzi_productie_linii WHERE comanda_id = ${CP.id}`);
    q(`UPDATE comenzi_productie SET id = ${CP_FIX}, numar = '${PREFIX}-CP', um = 'rola' WHERE id = ${CP.id}`);
    q(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um, ordine) VALUES (${CP_FIX}, ${P1}, 'x', 160, 'rola', 10)`);
    const stare = () => [unul(`SELECT um FROM comenzi_productie WHERE id = ${CP_FIX}`), unul(`SELECT um FROM comenzi_productie_linii WHERE comanda_id = ${CP_FIX}`)];
    const rec = Number(q(`INSERT INTO receptii (numar, sursa, stare, comanda_productie_id) VALUES ('${PREFIX}-REC', 'productie', 'asteptata', ${CP_FIX}) RETURNING id`)[0].id);
    ruleaza();
    egal("cu o recepție deschisă, nu se atinge", stare(), ["rola", "rola"]);
    q(`DELETE FROM receptii WHERE id = ${rec}`);
    q(`UPDATE comenzi_productie_linii SET um = 'buc' WHERE comanda_id = ${CP_FIX}`);
    q(`UPDATE comenzi_productie SET um = 'buc' WHERE id = ${CP_FIX}`);
    ruleaza();
    egal("cu altă unitate decât cea greșită de atunci, nu se atinge", stare(), ["buc", "buc"]);
    q(`UPDATE comenzi_productie_linii SET um = 'rola' WHERE comanda_id = ${CP_FIX}`);
    q(`UPDATE comenzi_productie SET um = 'ROLA ' WHERE id = ${CP_FIX}`);
    ruleaza();
    egal("cu „rola” de atunci și fără recepție: trece pe unitatea liniei", stare(), ["kg", "kg"]);
    q(`UPDATE comenzi_linii SET um = 'rolă' WHERE id = ${L}`);
    ruleaza();
    egal("a doua oară nu mai schimbă nimic (nici dacă linia s-a schimbat între timp)", stare(), ["kg", "kg"]);
  } else {
    console.log(`  (comanda de producție ${CP_FIX} există în baza de test — sar peste)`);
  }

  curata();
  console.log(esecuri ? `\n${esecuri} ESEC(URI)` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
