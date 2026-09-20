"use strict";
// Test pentru verificarea „Facturi încasate peste valoarea lor".
//
// De ce există: verificarea raporta 455 de facturi și 5,7 milioane de lei, iar
// cifra aia nu se putea repara — pentru că nu însemna un singur lucru. Într-o
// grămadă stăteau la un loc:
//   • stornouri, care au total negativ prin definiție, deci orice încasare pe
//     ele arată ca „plătit în plus" — și nu e nicio greșeală;
//   • facturi fără linii, care valorează zero în bază fiindcă importul n-a adus
//     liniile — banii sunt buni, valoarea lipsește;
//   • plăți chiar importate de două ori — singurele de șters;
//   • încasări chiar mai mari decât factura — de verificat una câte una.
//
// Dacă cele patru se numără împreună, nimeni nu repară nimic: nu știi câte din
// cele 455 sunt greșeli. Testul ăsta verifică despărțirea pe cauze, pe date
// reale, în PostgreSQL. Se pornește din rădăcina repo-ului, cu baza pe 5433.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
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

const ver = require(path.join(RAD, "modules", "verificari.js"));
const rute = { get: {}, post: {} };
ver.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(ce, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(ce, "am " + a + ", așteptam " + b); else ok(ce + " = " + b);
}
function cere(ce, corp, treb = [], interzis = []) {
  const lipsa = treb.filter((t) => !corp.includes(t));
  const gasite = interzis.filter((t) => corp.includes(t));
  if (lipsa.length || gasite.length) {
    rau(ce, (lipsa.length ? "lipsește „" + lipsa.join("”, „") + "”" : "") +
      (gasite.length ? (lipsa.length ? "; " : "") + "apare deși n-ar trebui „" + gasite.join("”, „") + "”" : ""));
  } else ok(ce);
}
function sectiune(corp, cheie) {
  const i = corp.indexOf('<h2 id="' + cheie + '"');
  if (i < 0) return "";
  const j = corp.indexOf('<h2 id="', i + 8);
  return corp.slice(i, j < 0 ? corp.length : j);
}

function curatenie() {
  for (const s of [
    `DELETE FROM plati WHERE factura_id IN (SELECT id FROM facturi WHERE serie = 'INCTEST')`,
    `DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE serie = 'INCTEST')`,
    `DELETE FROM facturi WHERE serie = 'INCTEST'`,
    `DELETE FROM parteneri WHERE cui = 'RO-INC-1'`,
  ]) { try { exec1(s); } catch (e) {} }
}

(async () => {
console.log("Facturi încasate peste valoarea lor — cauzele, separat\n");
curatenie();

const client = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('INCASARI TEST SRL','RO-INC-1','client') RETURNING id`)[0].id);

// Patru facturi, câte una de fiecare cauză. Sumele sunt alese ca fiecare să
// intre în filtrul „plătit > total + 1" și niciuna să nu poată fi confundată
// cu alta la citit.
function factura(numar, status) {
  return Number(
    q(
      `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, intercompany, activ)
       VALUES ('INCTEST', ?, ?, 'vanzare', '2026-03-10', '2026-04-10', ?, 0, 1) RETURNING id`,
      [numar, client, status || "emisa"]
    )[0].id
  );
}
const linie = (fid, cant, pret) =>
  q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, 'marfa', ?, ?, 0) RETURNING id`, [fid, cant, pret]);
const plata = (fid, suma, data) =>
  q(`INSERT INTO plati (factura_id, suma, data, metoda, activ) VALUES (?, ?, ?, 'banca', 1) RETURNING id`, [fid, suma, data]);

// 1. fără nicio linie, dar cu încasare
const fFaraLinii = factura("9001");
plata(fFaraLinii, 1000, "2026-03-20");

// 2. storno: total negativ, cu o încasare pe el
const fStorno = factura("9002");
linie(fStorno, -1, 4000);
plata(fStorno, 500, "2026-03-21");

// 3. plată importată de două ori: surplusul e exact plata dublată
const fDubla = factura("9003");
linie(fDubla, 1, 2000);
plata(fDubla, 2000, "2026-03-22");
plata(fDubla, 2000, "2026-03-25");

// 4. chiar s-a încasat mai mult: plăți diferite, fără duplicat
const fInPlus = factura("9004");
linie(fInPlus, 1, 1000);
plata(fInPlus, 1000, "2026-03-23");
plata(fInPlus, 750, "2026-03-24");

// 5 și 6. aceeași încasare pusă întreagă pe două facturi ale aceluiași client:
// tiparul de la DELIVERY SOLUTIONS, unde 123.126,66 lei stăteau la bănuț pe
// patru facturi diferite, fiecare cu o singură plată.
const fImp1 = factura("9005");
linie(fImp1, 1, 700);
plata(fImp1, 12345.67, "2026-03-26");
const fImp2 = factura("9006");
linie(fImp2, 1, 900);
plata(fImp2, 12345.67, "2026-03-26");

// --- 1. interogarea aduce ce trebuie ca să se poată clasifica --------------
console.log("interogarea");
const toate = await db.prepare(ver.SQL_INCASARI_PESTE).all();
const ale = new Map(toate.filter((r) => String(r.serie) === "INCTEST").map((r) => [String(r.numar).replace(/\.0+$/, ""), r]));
egal("toate șase intră în filtru", [...ale.keys()].sort(), ["9001", "9002", "9003", "9004", "9005", "9006"]);
egal("factura fără linii are linii = 0", Number(ale.get("9001").linii), 0);
egal("stornoul are total negativ", Number(ale.get("9002").total) < 0, true);
egal("plata dublată e văzută ca dublată", Number(ale.get("9003").dublat), 2000);
egal("încasarea în plus nu are nimic dublat", Number(ale.get("9004").dublat), 0);
egal("plata împrăștiată e văzută pe prima factură", Number(ale.get("9005").imprastiat), 12345.67);
egal("și pe a doua", Number(ale.get("9006").imprastiat), 12345.67);
egal("se spune pe câte facturi stă", Number(ale.get("9005").pe_cate), 2);
egal("plata dublată pe ACEEAȘI factură nu se confundă cu una împrăștiată",
  Number(ale.get("9003").imprastiat), 0);

// --- 2. clasificarea -------------------------------------------------------
console.log("\nclasificarea");
egal("fără linii", ver.clasificaIncasare(ale.get("9001")), "fara-linii");
egal("storno", ver.clasificaIncasare(ale.get("9002")), "storno");
egal("plăți duplicate", ver.clasificaIncasare(ale.get("9003")), "plati-duplicate");
egal("chiar încasat în plus", ver.clasificaIncasare(ale.get("9004")), "incasat-in-plus");
egal("aceeași încasare pe mai multe facturi", ver.clasificaIncasare(ale.get("9005")), "plata-imprastiata");
egal("și pe cealaltă factură a ei", ver.clasificaIncasare(ale.get("9006")), "plata-imprastiata");

// Cazurile de la margine, pe rânduri făcute de mână — aici nu ne trebuie bază.
console.log("\nmarginile");
egal("fără linii bate totul, chiar dacă are și plăți duplicate",
  ver.clasificaIncasare({ linii: 0, total: 0, platit: 900, dublat: 900 }), "fara-linii");
egal("storno cu plăți duplicate rămâne storno",
  ver.clasificaIncasare({ linii: 2, total: -500, platit: 300, dublat: 300 }), "storno");
egal("duplicat care NU explică tot surplusul nu e pus pe seama duplicatelor",
  ver.clasificaIncasare({ linii: 1, total: 1000, platit: 4000, dublat: 1000 }), "incasat-in-plus");
egal("duplicat care explică exact surplusul e pus pe seama lui",
  ver.clasificaIncasare({ linii: 1, total: 1000, platit: 2000, dublat: 1000 }), "plati-duplicate");
egal("un ban în minus la rotunjire tot duplicat rămâne",
  ver.clasificaIncasare({ linii: 1, total: 1000, platit: 2001, dublat: 1000 }), "plati-duplicate");
egal("total zero cu linii pe el nu e storno, e încasare în plus",
  ver.clasificaIncasare({ linii: 1, total: 0, platit: 50, dublat: 0 }), "incasat-in-plus");
egal("încasarea împrăștiată bate duplicatul, fiind explicația mai bună",
  ver.clasificaIncasare({ linii: 1, total: 100, platit: 1000, dublat: 900, imprastiat: 900 }), "plata-imprastiata");
egal("o încasare împrăștiată care nu explică surplusul nu ia vina",
  ver.clasificaIncasare({ linii: 1, total: 100, platit: 9000, imprastiat: 500, dublat: 0 }), "incasat-in-plus");

// --- 2b. banii se numără altfel la fiecare cauză ---------------------------
console.log("\nbanii, pe cauze");
egal("la storno nu e nimic de recuperat", ver.CAUZE_INCASARI.storno.bani({ platit: 500, total: -4000 }), 0);
egal("la plăți duplicate se numără exact ce e dublat",
  ver.CAUZE_INCASARI["plati-duplicate"].bani({ platit: 4000, total: 2000, dublat: 2000 }), 2000);
egal("la factura fără linii se numără încasarea de pe ea",
  ver.CAUZE_INCASARI["fara-linii"].bani({ platit: 1000, total: 0 }), 1000);
egal("stornoul nu e strigat ca greșeală", ver.CAUZE_INCASARI.storno.real, false);
egal("încasarea împrăștiată e", ver.CAUZE_INCASARI["plata-imprastiata"].real, true);

// --- 3. pagina ------------------------------------------------------------
console.log("\npagina de verificări");
const r = res();
await rute.get["/admin/date"]({ user: VALI, params: {}, query: {}, body: {}, res: r, req: { url: "/admin/date" } });
const s = sectiune(r.corp, "plati-peste-factura");
cere("tabelul e pe cauze, nu pe facturi", s,
  ["Cauza", "Banii", "Verdict", "Factură fără nicio linie", "Storno (total negativ)",
   "Plăți identice, importate de două ori", "Chiar s-a încasat mai mult", "Aceeași încasare, pusă pe mai multe facturi"], []);
cere("cauzele care nu-s greșeli sunt spuse pe față", s, ["nu e greșeală", "de reparat"], []);
cere("sumarul separă ce e de reparat de tot ce pare", s, ["de reparat,"], []);
if (/NaN|undefined/.test(s)) rau("secțiunea are NaN sau undefined în ea");
else ok("nicio cifră stricată în secțiune");

// --- 4. scoaterea unui document de test din bază ---------------------------
// Tiparul real: două facturi de la BSI A/S, cu numere tastate la întâmplare,
// țineau 19,2 milioane în „de plătit". Nicio regulă automată nu le poate
// deosebi de un utilaj adevărat de un milion, așa că butonul e pe rând, apăsat
// de cine recunoaște documentul — și nu șterge, ci scoate din calcule.
console.log("\nscoaterea unui document de test");
exec1(`DELETE FROM curatari_duplicate WHERE directie LIKE '%-test' AND suma = 9999000`);
const fTest = factura("9009");
linie(fTest, 1, 9999000);
exec1(`UPDATE facturi SET directie = 'achizitie' WHERE id = ${fTest}`);

let rr = res();
await rute.get["/admin/date/document/:id/scoate"](
  { user: VALI, params: { id: String(fTest) }, query: {}, body: {}, res: rr, req: { url: "/x" } });
cere("pagina de confirmare spune ce document e și cât ține", rr.corp,
  ["INCTEST9009", "INCASARI TEST SRL", "nu se șterge", "Renunță"], []);

rr = res();
await rute.get["/admin/date/document/:id/scoate"](
  { user: { id: 9, nume: "Agentul", rol: "vanzari" }, params: { id: String(fTest) }, query: {}, body: {}, res: rr, req: { url: "/x" } });
egal("cine nu e admin nu ajunge la pagină", rr.antet && rr.antet.Location, "/admin/date");

await rute.post["/admin/date/document/:id/scoate"](
  { user: VALI, params: { id: String(fTest) }, query: {}, body: {}, res: res(), req: { url: "/x" } });
egal("fără confirmare nu se scoate nimic",
  q(`SELECT id, activ FROM facturi WHERE id = ${fTest}`)[0].activ, "1");

await rute.post["/admin/date/document/:id/scoate"](
  { user: { id: 9, rol: "vanzari" }, params: { id: String(fTest) }, query: {}, body: { da: "1" }, res: res(), req: { url: "/x" } });
egal("nici agentul, chiar cu confirmare",
  q(`SELECT id, activ FROM facturi WHERE id = ${fTest}`)[0].activ, "1");

await rute.post["/admin/date/document/:id/scoate"](
  { user: VALI, params: { id: String(fTest) }, query: {}, body: { da: "1" }, res: res(), req: { url: "/x" } });
egal("documentul iese din calcule", q(`SELECT id, activ FROM facturi WHERE id = ${fTest}`)[0].activ, "0");
egal("dar rândul rămâne în bază", q(`SELECT COUNT(*) AS n FROM facturi WHERE id = ${fTest}`)[0].n, "1");

const ist = q(`SELECT id, directie, nr_documente, suma, ids FROM curatari_duplicate ORDER BY id DESC LIMIT 1`)[0];
egal("s-a scris în istoric ca document de test", ist.directie, "achizitie-test");
egal("cu suma lui", Math.round(Number(ist.suma)), 9999000);
egal("și cu id-ul lui, ca să se poată readuce", JSON.parse(ist.ids), [fTest]);

await rute.post["/admin/date/duplicate/:id/anuleaza"](
  { user: VALI, params: { id: String(ist.id) }, query: {}, body: {}, res: res(), req: { url: "/x" } });
egal("„Anulează” îl pune la loc", q(`SELECT id, activ FROM facturi WHERE id = ${fTest}`)[0].activ, "1");

exec1(`DELETE FROM curatari_duplicate WHERE id = ${ist.id}`);

curatenie();
console.log("\n" + interogari + " interogări SQL reale.");
console.log(rele ? rele + " probleme." : "Totul curat.");
process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); curatenie(); process.exit(1); });
