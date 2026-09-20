"use strict";
// Test pentru culegerea din emailuri — serviciul de noapte de la 02:00.
//
// De ce există: un contact pus la firma greșită, cu telefonul altcuiva, e mai
// rău decât un contact lipsă. Omul care sună nu află niciodată de ce nu
// răspunde cine trebuie. Așa că regulile sunt verificate aici, pe semnături
// scrise cum se scriu în realitate — cu diacritice lipsă, cu „Mobil:", cu
// separator de semnătură, cu antet de răspuns dedesubt.
//
// Se verifică, în ordinea în care lucrurile se strică:
//   1. citirea semnăturii — unde începe, ce e telefon, ce e funcție;
//   2. ce se sare — firme în loc de oameni, gmail.com, numere care nu-s
//      telefoane românești;
//   3. scrierea în Contacte — nu se suprascrie nimic pus de un om, nu se
//      adaugă același om de două ori.
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

const c = require(path.join(RAD, "modules", "culegere.js"));

let rele = 0;
function egal(ce, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) { rele++; console.log("  PROBLEMĂ " + ce + ": am " + a + ", așteptam " + b); }
  else console.log("  ok       " + ce + " = " + b);
}

console.log("Culegerea din emailuri\n");

// --- 1. telefoane ----------------------------------------------------------
console.log("telefoane");
for (const [brut, asteptat] of [
  ["0722 351 929", "0722351929"],
  ["+40 722 351 929", "0722351929"],
  ["0040722351929", "0722351929"],
  ["0722.351.929", "0722351929"],
  ["0722-351-929", "0722351929"],
  ["(0)722 351 929", "0722351929"],
  ["021 320 1122", "0213201122"],
  ["0236 414 123", "0236414123"],
  ["12345", null],
  ["RO6484554", null],
  ["2026-09-20", null],
  ["", null],
]) egal(`  „${brut}”`, c.curataTelefon(brut), asteptat);

egal("  mobilul bate fixul",
  c.telefoaneDin("Tel fix: 021 320 1122\nMobil: 0722 351 929"),
  { mobil: "0722351929", fix: "0213201122" });
egal("  fără telefon deloc", c.telefoaneDin("Nimic aici"), { mobil: null, fix: null });

// --- 2. unde începe semnătura ----------------------------------------------
console.log("\nblocul semnăturii");
const cuSeparator = `Bună ziua,

Vă trimit oferta cerută.

--
Marian Radu
Director Achiziții
CARMANGERIA GODAC SRL
Mobil: 0722 351 929`;
egal("  separatorul „--” taie exact",
  c.bloculSemnaturii(cuSeparator)[0], "Marian Radu");

const cuIncheiere = `Bună ziua,

Prețul e 12,50 lei/kg.

Cu stimă,
Ana Popescu
Manager Vânzări
0733 444 474`;
egal("  „Cu stimă,” taie exact",
  c.bloculSemnaturii(cuIncheiere)[0], "Ana Popescu");

egal("  fără niciun semn, ia coada mesajului",
  c.bloculSemnaturii("rand1\nrand2\nrand3").length, 3);
// „\b" din JavaScript nu vede diacriticele ca litere, deci /stim[ăa]\b/ NU
// prinde „stimă,". A trecut de citit și l-a prins doar testul — de-aia rămâne
// aici, cu ambele scrieri.
egal("  „Cu stimă,” cu diacritice", c.bloculSemnaturii("a\nCu stimă,\nAna Popescu")[0], "Ana Popescu");
egal("  „Cu stima,” fără diacritice", c.bloculSemnaturii("a\nCu stima,\nAna Popescu")[0], "Ana Popescu");
egal("  încheiere în engleză", c.bloculSemnaturii("a\nBest regards,\nJohn Smith")[0], "John Smith");

// --- 3. funcția ------------------------------------------------------------
console.log("\nfuncția");
egal("  o recunoaște", c.functiaDin(["Marian Radu", "Director Achiziții", "0722351929"]), "Director Achiziții");
egal("  nu confundă „Mobil: 0722…” cu o funcție", c.functiaDin(["Mobil: 0722 351 929"]), null);
egal("  sare peste adrese", c.functiaDin(["sales@firma.ro", "Sales Manager"]), "Sales Manager");
egal("  sare peste site-uri", c.functiaDin(["www.firma.ro", "Agent vânzări"]), "Agent vânzări");
egal("  taie decorațiunile", c.functiaDin(["| Key Account Manager |"]), "Key Account Manager");
egal("  fără funcție nu inventează", c.functiaDin(["Ceva", "Altceva"]), null);
egal("  funcție cu diacritice la început", c.functiaDin(["Șef achiziții"]), "Șef achiziții");
egal("  funcție cu diacritice la sfârșit", c.functiaDin(["Responsabil logistică"]), "Responsabil logistică");
egal("  „Director Vânzări”", c.functiaDin(["Director Vânzări"]), "Director Vânzări");

// --- 4. numele din semnătură ------------------------------------------------
console.log("\nnumele");
egal("  nume de om", c.numeDin(["Marian Radu", "Director"]), "Marian Radu");
egal("  nu ia firma drept om", c.numeDin(["CARMANGERIA GODAC SRL", "0722351929"]), null);
egal("  nu ia funcția drept nume", c.numeDin(["Director Achiziții"]), null);
egal("  nu ia rândul cu cifre", c.numeDin(["Str Fabricii 12"]), null);
egal("  nu ia un singur cuvânt", c.numeDin(["Marian"]), null);

// --- 5. mesajul întreg ------------------------------------------------------
console.log("\nmesajul întreg");
egal("  antetul „De la” bate semnătura",
  c.culegeDinMesaj({
    de_la: "marian.radu@godac.ro", de_la_nume: "Marian Radu", de_la_domeniu: "godac.ro",
    partener_nume: "CARMANGERIA GODAC SRL", corp: cuSeparator,
  }),
  { nume: "Marian Radu", email: "marian.radu@godac.ro", functie: "Director Achiziții", telefon: "0722351929" });

egal("  când „De la” e numele firmei, caută omul în semnătură",
  (c.culegeDinMesaj({
    de_la: "office@godac.ro", de_la_nume: "CARMANGERIA GODAC SRL", de_la_domeniu: "godac.ro",
    partener_nume: "CARMANGERIA GODAC SRL", corp: cuSeparator,
  }) || {}).nume,
  "Marian Radu");

egal("  gmail.com se sare — domeniul nu spune nimic",
  c.culegeDinMesaj({
    de_la: "cineva@gmail.com", de_la_nume: "Ion Popescu", de_la_domeniu: "gmail.com",
    partener_nume: "X SRL", corp: cuSeparator,
  }), null);

egal("  fără nume de om, nu se culege nimic",
  c.culegeDinMesaj({
    de_la: "office@godac.ro", de_la_nume: "GODAC SRL", de_la_domeniu: "godac.ro",
    partener_nume: "GODAC SRL", corp: "Bună ziua,\n\nVă rog oferta.\n\nGODAC SRL\n0722351929",
  }), null);

egal("  mesaj fără semnătură: omul intră, fără telefon",
  c.culegeDinMesaj({
    de_la: "ana@acme.ro", de_la_nume: "Ana Popescu", de_la_domeniu: "acme.ro",
    partener_nume: "ACME SRL", corp: "ok, mulțumesc",
  }),
  { nume: "Ana Popescu", email: "ana@acme.ro", functie: null, telefon: null });

// --- 6. scrierea în Contacte (pe bază reală) --------------------------------
(async () => {
console.log("\nscrierea în Contacte");
exec1(`DELETE FROM mk_contacte WHERE partener_id IN (SELECT id FROM parteneri WHERE cui LIKE 'RO-CUL-%')`);
exec1(`DELETE FROM email_mesaje WHERE gmail_id LIKE 'culegere-test-%'`);
exec1(`DELETE FROM email_conturi WHERE adresa = 'test-culegere@cashmachine.ro'`);
exec1(`DELETE FROM parteneri WHERE cui LIKE 'RO-CUL-%'`);
exec1(`DELETE FROM culegere_istoric WHERE rulat_la >= '2000-01-01'`);

const furnizor = Number(q(`INSERT INTO parteneri (nume, cui, tip, email) VALUES ('GODAC TEST SRL','RO-CUL-1','furnizor','office@godactest.ro') RETURNING id`)[0].id);
const client = Number(q(`INSERT INTO parteneri (nume, cui, tip, email) VALUES ('ACME TEST SRL','RO-CUL-2','client','office@acmetest.ro') RETURNING id`)[0].id);
const cont = Number(q(`INSERT INTO email_conturi (adresa, tip, activ) VALUES ('test-culegere@cashmachine.ro','comun',1) RETURNING id`)[0].id);

const ieri = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
function mesaj(gid, deLa, numeDeLa, domeniu, partenerId, corp) {
  q(
    `INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, corp, directie, partener_id, activ)
     VALUES (?, ?, ?, ?, ?, ?, 'test', ?, 'primit', ?, 1)`,
    [cont, gid, ieri, deLa, numeDeLa, domeniu, corp, partenerId]
  );
}

mesaj("culegere-test-1", "marian.radu@godactest.ro", "Marian Radu", "godactest.ro", furnizor, cuSeparator);
mesaj("culegere-test-2", "ana.popescu@acmetest.ro", "Ana Popescu", "acmetest.ro", client, cuIncheiere);
// al doilea mesaj de la același om: nu trebuie să-l adauge iar
mesaj("culegere-test-3", "marian.radu@godactest.ro", "Marian  Radu", "godactest.ro", furnizor, cuSeparator);
// de la o adresă de firmă, fără om în semnătură: nu trebuie cules nimic
mesaj("culegere-test-4", "office@godactest.ro", "GODAC TEST SRL", "godactest.ro", furnizor, "Vă rog confirmarea.\n\nGODAC TEST SRL");
// de pe gmail: se sare
mesaj("culegere-test-5", "vasile@gmail.com", "Vasile Ionescu", "gmail.com", client, cuSeparator);

let r = await c.culegeSemnaturi({ zile: 3 });
egal("  contacte noi", r.adaugati, 2);
egal("  nimic completat la prima rulare", r.completati, 0);

const gasite = q(`SELECT nume, functie, telefon, email, sursa, partener_id FROM mk_contacte WHERE partener_id IN (${furnizor},${client}) ORDER BY nume`);
egal("  s-au scris exact doi oameni", gasite.length, 2);
egal("  Ana, cu funcția din semnătură",
  { nume: gasite[0].nume, functie: gasite[0].functie, telefon: gasite[0].telefon, sursa: gasite[0].sursa },
  { nume: "Ana Popescu", functie: "Manager Vânzări", telefon: "0733444474", sursa: "semnatura" });
egal("  Marian, legat de furnizorul lui",
  { nume: gasite[1].nume, functie: gasite[1].functie, partener: Number(gasite[1].partener_id) },
  { nume: "Marian Radu", functie: "Director Achiziții", partener: furnizor });

// a doua rulare: același om nu se dublează
r = await c.culegeSemnaturi({ zile: 3 });
egal("  a doua rulare nu mai adaugă pe nimeni", r.adaugati, 0);
egal("  și nici nu are ce completa", r.completati, 0);
egal("  tot doi oameni sunt", q(`SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id IN (${furnizor},${client})`)[0].n, "2");

// --- 7. nu suprascrie ce a pus un om ---------------------------------------
console.log("\nrespectul pentru ce a scris omul");
exec1(`UPDATE mk_contacte SET functie = 'Șef achiziții (pus de mână)', telefon = '0700000000' WHERE nume = 'Marian Radu'`);
await c.culegeSemnaturi({ zile: 3 });
const marian = q(`SELECT functie, telefon FROM mk_contacte WHERE nume = 'Marian Radu'`)[0];
egal("  funcția scrisă de om rămâne", marian.functie, "Șef achiziții (pus de mână)");
egal("  telefonul scris de om rămâne", marian.telefon, "0700000000");

// și invers: golurile se completează
exec1(`UPDATE mk_contacte SET telefon = NULL, functie = NULL WHERE nume = 'Ana Popescu'`);
r = await c.culegeSemnaturi({ zile: 3 });
const ana = q(`SELECT functie, telefon FROM mk_contacte WHERE nume = 'Ana Popescu'`)[0];
egal("  golurile se completează", { f: ana.functie, t: ana.telefon }, { f: "Manager Vânzări", t: "0733444474" });
egal("  și se raportează ca atare", r.completati, 1);

// --- 8. rularea completă scrie în istoric ----------------------------------
console.log("\nistoricul");
const rez = await c.ruleaza({ zile: 3 });
egal("  rularea întoarce un rezumat", typeof rez.semnaturi.citite, "number");
egal("  s-a scris în istoric", q(`SELECT COUNT(*) AS n FROM culegere_istoric`)[0].n !== "0", true);
egal("  ora de rulare e cea cerută", c.ORA_RULARE, 2);

// --- curățenie --------------------------------------------------------------
exec1(`DELETE FROM mk_contacte WHERE partener_id IN (${furnizor},${client})`);
exec1(`DELETE FROM email_mesaje WHERE gmail_id LIKE 'culegere-test-%'`);
exec1(`DELETE FROM email_conturi WHERE id = ${cont}`);
exec1(`DELETE FROM parteneri WHERE id IN (${furnizor},${client})`);
exec1(`DELETE FROM culegere_istoric WHERE rulat_la >= '2000-01-01'`);

console.log("\n" + interogari + " interogări SQL reale.");
console.log(rele ? rele + " probleme." : "Totul curat.");
process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
