"use strict";
// Lista de clienți și furnizori de la a doua firmă din grup, și marcarea lor.
//
// Cererea lui Vali: „nu am lista de clienți și furnizori din warehouse, ar
// trebui luată și adăugată și aici, ca să le pot asocia".
//
// Două lucruri se verifică aici, fiindcă amândouă pot greși tăcut:
//
//   1. PUNTEA care aduce lista. Scriptul din browser nu știe ce coloane sunt —
//      trimite exact ce scrie în capul tabelului SmartBill. Potrivirea se face
//      pe server, după denumirea coloanei. Dacă se strică, partenerii intră
//      fără CUI sau fără email și nimeni nu observă până când cineva caută un
//      client și nu-l găsește.
//
//   2. MARCAREA pe firmă. Partenerii sunt comuni pe tot grupul (vezi
//      lib/grup.js) — nu se dublează lista pe firmă. Deci „al cui e clientul"
//      se DEDUCE din firma emitentă a facturilor, nu se scrie pe partener. Un
//      client al amândurora trebuie să apară cu amândouă.
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

const punte = require(path.join(RAD, "modules", "punte.js"));
// Routerul de mucava păstrează PRIMA înregistrare, nu ultima — exact cum face
// routerul adevărat, care se oprește la prima rută potrivită. Fără asta,
// pagina de parteneri scrisă de mână ar fi fost acoperită de lista generică a
// CRUD-ului, care se înregistrează după ea, iar testul ar fi verificat cu
// totul altă pagină decât cea din browser.
const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "parteneri.js")).register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
  options: () => {},
});

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
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined<|>undefined/.test(fara)) return rau(ce, "NaN/undefined în pagină");
  const lipsa = treb.filter((t) => !fara.includes(t));
  const gasite = interzis.filter((t) => fara.includes(t));
  if (lipsa.length || gasite.length) {
    return rau(ce, (lipsa.length ? "lipsește „" + lipsa.join("”, „") + "”" : "") +
      (gasite.length ? (lipsa.length ? "; " : "") + "apare deși n-ar trebui „" + gasite.join("”, „") + "”" : ""));
  }
  ok(ce);
}

function curatenie() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE serie IN ('PFTEST','WHTEST'))",
    "DELETE FROM facturi WHERE serie IN ('PFTEST','WHTEST')",
    "DELETE FROM parteneri WHERE cui IN ('RO-PF-1','RO-PF-2','RO-PF-3','12345678','RO12345678') OR nume LIKE 'PFTEST %'",
    "DELETE FROM firme WHERE cui IN ('PF-CM','PF-WH')",
  ]) { try { exec1(s); } catch (e) {} }
}

(async () => {
console.log("Clienți și furnizori din a doua firmă\n");
curatenie();

// --- 1. puntea: rândurile vin cum scrie pe ecran, nu cum ne-ar conveni -----
console.log("puntea pentru lista de parteneri");

// Exact forma în care le trimite scriptul: cheile sunt capetele de coloană
// din SmartBill, cu diacritice, spații și majuscule cum se nimerește.
const dinEcran = [
  { "Denumire": "PFTEST Alfa SRL", "C.I.F.": "RO 12345678", "E-mail": "office@pftestalfa.ro", "Telefon": "0722 111 222", "Adresă": "Str. Uzinei 4", "Oraș": "Buzău", "Județ": "Buzău", tip_partener: "client" },
  { "Denumire": "PFTEST Beta SRL", "C.I.F.": "", "E-mail": "", "Telefon": "", tip_partener: "client" },
  { "Denumire": "", "C.I.F.": "RO999", tip_partener: "client" },
  { "Nume furnizor": "PFTEST Gama SRL", "Cod fiscal": "44140651", "Email": "contact@pftestgama.ro", tip_partener: "furnizor" },
];

const r1 = await punte.HANDLERE.parteneri(dinEcran);
egal("trei rânduri bune intră", r1["Parteneri noi"], 3);
egal("rândul fără nume se sare", r1["Rânduri fără nume"], 1);
egal("clienții se numără separat", r1["Din care clienți"], 2);
egal("și furnizorii la fel", r1["Din care furnizori"], 1);

const alfa = q("SELECT nume, cui, email, telefon, adresa, tip FROM parteneri WHERE nume = 'PFTEST Alfa SRL'")[0];
egal("CUI-ul se ia din „C.I.F.”", alfa.cui, "RO 12345678");
egal("emailul din „E-mail”", alfa.email, "office@pftestalfa.ro");
egal("telefonul din „Telefon”", alfa.telefon, "0722 111 222");
egal("adresa se lipește din adresă + oraș + județ", alfa.adresa, "Str. Uzinei 4, Buzău, Buzău");
egal("tipul vine de pe rând", alfa.tip, "client");

const gama = q("SELECT tip, cui, email FROM parteneri WHERE nume = 'PFTEST Gama SRL'")[0];
egal("„Nume furnizor” e tot un nume", !!gama, true);
egal("furnizorul intră ca furnizor", gama.tip, "furnizor");
egal("„Cod fiscal” e tot CUI", gama.cui, "44140651");

// --- 2. a doua rulare nu dublează pe nimeni -------------------------------
console.log("\na doua rulare");
const r2 = await punte.HANDLERE.parteneri(dinEcran);
egal("nimeni nou", r2["Parteneri noi"], 0);
egal("toți trei doar actualizați", r2["Actualizați"], 3);
egal("și în bază e un singur Alfa",
  Number(q("SELECT COUNT(*) AS n FROM parteneri WHERE nume = 'PFTEST Alfa SRL'")[0].n), 1);

// Același CUI, scris altfel: „RO 12345678" vs „12345678". Fără normalizarea
// pe cifre, ar fi intrat al doilea rând și clientul ar fi avut două fișe.
const r3 = await punte.HANDLERE.parteneri([
  { "Denumire": "PFTEST Alfa S.R.L. (alt nume)", "CUI": "12345678", "Email": "nou@pftestalfa.ro", tip_partener: "client" },
]);
egal("același CUI scris altfel nu face fișă nouă", r3["Parteneri noi"], 0);
egal("tot un singur rând cu CUI-ul ăsta",
  Number(q("SELECT COUNT(*) AS n FROM parteneri WHERE regexp_replace(COALESCE(cui,''), '[^0-9]', '', 'g') = '12345678'")[0].n), 1);
egal("dar emailul lipsă s-a completat",
  q("SELECT email FROM parteneri WHERE nume = 'PFTEST Alfa SRL'")[0].email, "office@pftestalfa.ro");

// Nu suprascrie cu gol: rândul gol de mai sus n-a șters nimic.
const beta = q("SELECT cui, email FROM parteneri WHERE nume = 'PFTEST Beta SRL'")[0];
egal("un rând fără CUI nu strică nimic", beta.cui, null);

// --- 3. marcarea pe firmă, dedusă din facturi -----------------------------
console.log("\nde care firmă ține partenerul");
const fCM = Number(q("INSERT INTO firme (nume, cui, culoare, in_grup, implicita, operationala) VALUES ('PFTEST Cash SRL','PF-CM','#2f5d9c',1,0,1) RETURNING id")[0].id);
const fWH = Number(q("INSERT INTO firme (nume, cui, culoare, in_grup, implicita, operationala) VALUES ('PFTEST Warehouse SRL','PF-WH','#1a7f42',1,0,1) RETURNING id")[0].id);
const idAlfa = Number(q("SELECT id FROM parteneri WHERE nume = 'PFTEST Alfa SRL'")[0].id);
const idBeta = Number(q("SELECT id FROM parteneri WHERE nume = 'PFTEST Beta SRL'")[0].id);
const idGama = Number(q("SELECT id FROM parteneri WHERE nume = 'PFTEST Gama SRL'")[0].id);

const fact = (serie, numar, partener, firma) =>
  q(`INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, intercompany, activ, firma_id)
     VALUES (?, ?, ?, 'vanzare', '2026-06-01', '2026-07-01', 'emisa', 0, 1, ?) RETURNING id`,
    [serie, numar, partener, firma]);

// Alfa cumpără de la amândouă. Beta doar de la Warehouse. Gama n-are facturi.
fact("PFTEST", "1", idAlfa, fCM);
fact("WHTEST", "1", idAlfa, fWH);
fact("WHTEST", "2", idBeta, fWH);

const p = res();
await rute.get["/parteneri"]({ user: VALI, params: {}, query: { q: "PFTEST" }, body: {}, res: p, req: { url: "/parteneri" } });
cere("lista are coloana Firma și filtrul pe firmă", p.corp,
  ["Firma", "Firma cu care a lucrat", "PFTEST Cash", "PFTEST Warehouse"], []);

// Insigna se pune pe rândul partenerului: se caută bucata de tabel a fiecăruia.
const bucata = (nume) => {
  const i = p.corp.indexOf(nume);
  return i < 0 ? "" : p.corp.slice(i, i + 700);
};
const laAlfa = bucata("PFTEST Alfa SRL");
egal("Alfa poartă amândouă firmele",
  laAlfa.includes("PFTEST Cash") && laAlfa.includes("PFTEST Warehouse"), true);
const laBeta = bucata("PFTEST Beta SRL");
egal("Beta poartă doar Warehouse",
  laBeta.includes("PFTEST Warehouse") && !laBeta.includes("PFTEST Cash"), true);

// --- 4. filtrul pe firmă ---------------------------------------------------
const doarWH = res();
await rute.get["/parteneri"]({ user: VALI, params: {}, query: { q: "PFTEST", firma: String(fWH) }, body: {}, res: doarWH, req: { url: "/parteneri" } });
cere("filtrul pe Warehouse lasă doar cine a lucrat cu ea", doarWH.corp,
  ["PFTEST Alfa SRL", "PFTEST Beta SRL"], ["PFTEST Gama SRL"]);

const doarCM = res();
await rute.get["/parteneri"]({ user: VALI, params: {}, query: { q: "PFTEST", firma: String(fCM) }, body: {}, res: doarCM, req: { url: "/parteneri" } });
cere("și filtrul pe Cash lasă doar pe Alfa", doarCM.corp,
  ["PFTEST Alfa SRL"], ["PFTEST Beta SRL"]);

egal("un partener fără nicio factură nu dispare din lista întreagă",
  p.corp.includes("PFTEST Gama SRL"), true);

curatenie();
console.log("\n" + interogari + " interogări SQL reale.");
console.log(rele ? rele + " probleme." : "Totul curat.");
process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); curatenie(); process.exit(1); });
