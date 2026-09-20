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
  { nume: "Marian Radu", email: "marian.radu@godac.ro", functie: "Director Achiziții", telefon: "0722351929", fel: "persoana" });

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

// Regula veche era „fără nume de om nu se culege nimic". S-a schimbat la
// cererea lui Vali: adresa de birou rămâne contact — marcat ca rol, nu ca om —
// pentru că ai unde trimite oferta chiar dacă nu știi cine o citește.
egal("  fără nume de om rămâne biroul, marcat ca rol",
  c.culegeDinMesaj({
    de_la: "office@godac.ro", de_la_nume: "GODAC SRL", de_la_domeniu: "godac.ro",
    partener_nume: "GODAC SRL", corp: "Bună ziua,\n\nVă rog oferta.\n\nGODAC SRL\n0722351929",
  }),
  { nume: "Office", email: "office@godac.ro", functie: null, telefon: "0722351929", fel: "rol" });

egal("  mesaj fără semnătură: omul intră, fără telefon",
  c.culegeDinMesaj({
    de_la: "ana@acme.ro", de_la_nume: "Ana Popescu", de_la_domeniu: "acme.ro",
    partener_nume: "ACME SRL", corp: "ok, mulțumesc",
  }),
  { nume: "Ana Popescu", email: "ana@acme.ro", functie: null, telefon: null, fel: "persoana" });

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
// de la o adresă de birou, fără om în semnătură: intră ca rol, nu ca om
mesaj("culegere-test-4", "office@godactest.ro", "GODAC TEST SRL", "godactest.ro", furnizor, "Vă rog confirmarea.\n\nGODAC TEST SRL");
// de pe gmail: se sare
mesaj("culegere-test-5", "vasile@gmail.com", "Vasile Ionescu", "gmail.com", client, cuSeparator);

let r = await c.culegeSemnaturi({ zile: 3 });
egal("  contacte noi", r.adaugati, 3);
egal("  nimic completat la prima rulare", r.completati, 0);

const gasite = q(`SELECT nume, functie, telefon, email, sursa, partener_id FROM mk_contacte WHERE partener_id IN (${furnizor},${client}) ORDER BY nume`);
egal("  s-au scris doi oameni și un birou", gasite.length, 3);
egal("  Ana, cu funcția din semnătură",
  { nume: gasite[0].nume, functie: gasite[0].functie, telefon: gasite[0].telefon, sursa: gasite[0].sursa },
  { nume: "Ana Popescu", functie: "Manager Vânzări", telefon: "0733444474", sursa: "semnatura" });
egal("  Marian, legat de furnizorul lui",
  { nume: gasite[1].nume, functie: gasite[1].functie, partener: Number(gasite[1].partener_id) },
  { nume: "Marian Radu", functie: "Director Achiziții", partener: furnizor });
egal("  biroul, cu adresa pe el și sursa „adresa”",
  { nume: gasite[2].nume, email: gasite[2].email, sursa: gasite[2].sursa, partener: Number(gasite[2].partener_id) },
  { nume: "Office", email: "office@godactest.ro", sursa: "adresa", partener: furnizor });

// a doua rulare: același om nu se dublează
r = await c.culegeSemnaturi({ zile: 3 });
egal("  a doua rulare nu mai adaugă pe nimeni", r.adaugati, 0);
egal("  și nici nu are ce completa", r.completati, 0);
egal("  tot trei contacte sunt", q(`SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id IN (${furnizor},${client})`)[0].n, "3");

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


// --- 9. ce fel de mesaj e --------------------------------------------------
console.log("\nfelul mesajului");
const fel = (subiect, corp, deLa) => c.felulMesajului({ subiect, corp, de_la: deLa || "client@acme.ro" });

egal("  cerere de ofertă", fel("Solicitare ofertă", "Bună ziua, ne puteți trimite o ofertă pentru cutii?"), "cerere");
egal("  cerere în engleză", fel("RFQ", "Please quote 200 boxes"), "cerere");
egal("  „ce preț aveți”", fel("Întrebare", "Ce preț aveți la pungi 345x410?"), "cerere");
egal("  comandă cu cantitate", fel("Comanda", "Vă rugăm să ne livrați 200 buc cutii D10."), "comanda");
egal("  comandă fără cantitate rămâne cerere",
  fel("Comanda", "Dorim să comandăm, vă rugăm confirmați disponibilitatea."), "cerere");
egal("  o simplă mulțumire nu e nici una, nici alta", fel("Re: factura", "Mulțumim, am primit."), null);
egal("  roboții se sar — expeditor",
  c.felulMesajului({ subiect: "Solicitare ofertă", corp: "trimiteți ofertă", de_la: "noreply@sistem.ro" }), null);
egal("  roboții se sar — subiect",
  fel("Out of office", "Sunt plecat, vă rog trimiteți oferta la colegul meu"), null);
egal("  e-factura nu e cerere", fel("Factura electronica SPV", "Ce preț aveți"), null);

// --- 10. liniile de comandă din text ---------------------------------------
console.log("\nliniile de comandă");
egal("  cantitate + UM + denumire",
  c.liniiDinText("Vă rugăm:\n200 buc Cutie D10\n15 kg folie neagra"),
  [
    { denumire: "Cutie D10", cantitate: 200, um: "buc", linie: "200 buc Cutie D10" },
    { denumire: "folie neagra", cantitate: 15, um: "kg", linie: "15 kg folie neagra" },
  ]);
egal("  un număr fără unitate de măsură nu e linie", c.liniiDinText("Comanda 12345 de la noi"), []);
egal("  denumirea prea scurtă se sare", c.liniiDinText("200 buc x"), []);
egal("  mii cu punct", (c.liniiDinText("1.500 buc Punga curier")[0] || {}).cantitate, 1500);

// --- 11. scadența la 24 de ore ---------------------------------------------
console.log("\nscadența");
egal("  24 de ore mai târziu", c.scadentaLa24h("2026-09-20 09:14:00").moment, "2026-09-21 09:14:00");
egal("  și ziua pentru coloana veche", c.scadentaLa24h("2026-09-20 09:14:00").zi, "2026-09-21");
egal("  peste noapte, trece în ziua următoare", c.scadentaLa24h("2026-09-20 23:50:00").zi, "2026-09-21");

// --- 12. clasificarea pe bază reală ----------------------------------------
console.log("\nclasificarea");
exec1(`DELETE FROM utilizatori WHERE id = 99001`);
const agent = Number(q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol, activ) VALUES (99001,'Agent Test','agent-test@cashmachine.ro','x','y','vanzari',1) RETURNING id`)[0].id);
const clientAlocat = Number(q(`INSERT INTO parteneri (nume, cui, tip, agent_id) VALUES ('CLIENT ALOCAT SRL','RO-CUL-3','client',${agent}) RETURNING id`)[0].id);
const produs = q(`SELECT id, denumire FROM produse ORDER BY id LIMIT 1`)[0];

function mesajNou(gid, subiect, corp) {
  return Number(q(
    `INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, snippet, corp, directie, partener_id, activ)
     VALUES (?, ?, ?, 'ion@clientalocat.ro', 'Ion Client', 'clientalocat.ro', ?, ?, ?, 'primit', ?, 1) RETURNING id`,
    [cont, gid, new Date().toISOString().slice(0, 19).replace("T", " "), subiect, corp.slice(0, 120), corp, clientAlocat]
  )[0].id);
}

const idCerere = mesajNou("culegere-test-10", "Solicitare ofertă cutii", "Bună ziua,\n\nNe puteți trimite o ofertă pentru cutii?\n\nMulțumesc");
const idComanda = mesajNou("culegere-test-11", "Comanda cutii", `Bună ziua,\n\nVă rugăm să ne livrați:\n200 buc ${produs ? produs.denumire : "Cutie"}\n\nMulțumim`);
const idNimic = mesajNou("culegere-test-12", "Re: multumim", "Am primit factura, mulțumim.");

const k = await c.clasificaMesaje({ zile: 2 });
egal("  o cerere și o comandă", { cereri: k.cereri, comenzi: k.comenzi }, { cereri: 1, comenzi: 1 });
egal("  două taskuri", k.taskuri, 2);
egal("  toate trei au fost citite", k.citite, 3);

const tCerere = q(`SELECT t.* FROM taskuri t JOIN email_mesaje m ON m.task_id = t.id WHERE m.id = ${idCerere}`)[0];
egal("  taskul e al agentului clientului", Number(tCerere.atribuit_lui), agent);
egal("  taskul e legat de client", Number(tCerere.partener_id), clientAlocat);
egal("  tipul e email", tCerere.tip, "email");
egal("  are scadență la 24 de ore", Boolean(tCerere.scadenta_la && tCerere.scadenta), true);
egal("  titlul spune ce e", tCerere.titlu.startsWith("Cerere pe email:"), true);

const comanda = q(`SELECT * FROM comenzi WHERE email_mesaj_id = ${idComanda}`)[0];
egal("  comanda s-a născut", Boolean(comanda), true);
egal("  și e CIORNĂ, nu nouă", comanda.status, "ciorna");
egal("  cu agentul clientului pe ea", Number(comanda.agent_id), agent);
egal("  marcată ca venită din email", comanda.sursa, "email");
if (produs) {
  egal("  linia recunoscută a intrat",
    q(`SELECT cantitate FROM comenzi_linii WHERE comanda_id = ${comanda.id}`).map((x) => Number(x.cantitate)), [200]);
}
egal("  mesajul care nu e nici una, nici alta e marcat ca văzut",
  q(`SELECT fel, clasificat_la FROM email_mesaje WHERE id = ${idNimic}`)[0].clasificat_la !== null, true);

// a doua rulare nu trebuie să facă nimic de două ori
const k2 = await c.clasificaMesaje({ zile: 2 });
egal("  a doua rulare nu recitește nimic", k2.citite, 0);
egal("  și nu face al doilea task", q(`SELECT COUNT(*) AS n FROM taskuri WHERE partener_id = ${clientAlocat}`)[0].n, "2");
egal("  nici a doua comandă", q(`SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ${clientAlocat}`)[0].n, "1");

exec1(`DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = ${clientAlocat})`);
exec1(`DELETE FROM taskuri WHERE partener_id = ${clientAlocat}`);
exec1(`DELETE FROM comenzi WHERE partener_id = ${clientAlocat}`);
exec1(`DELETE FROM email_mesaje WHERE partener_id = ${clientAlocat}`);
exec1(`DELETE FROM mk_contacte WHERE partener_id = ${clientAlocat}`);
exec1(`DELETE FROM parteneri WHERE id = ${clientAlocat}`);
exec1(`DELETE FROM utilizatori WHERE id = ${agent}`);


// --- 13. prețurile din text ------------------------------------------------
console.log("\noferte: prețurile din text");
egal("  număr românesc", c.numarRo("1.234,56"), 1234.56);
egal("  număr englezesc", c.numarRo("1,234.56"), 1234.56);
egal("  număr simplu", c.numarRo("12,50"), 12.5);
egal("  fără separatori", c.numarRo("450"), 450);

const p1 = c.preturiDinText("Punga curier 345x410 - 0,42 lei/buc");
egal("  preț cu monedă și UM",
  { pret: p1[0].pret, moneda: p1[0].moneda, um: p1[0].um }, { pret: 0.42, moneda: "RON", um: "buc" });
egal("  denumirea rămâne curată", p1[0].textProdus, "Punga curier 345x410");

egal("  euro se recunoaște", (c.preturiDinText("Folie stretch 1.250 EUR/to")[0] || {}).moneda, "EUR");
egal("  simbolul € se recunoaște", (c.preturiDinText("Carton 890 €")[0] || {}).moneda, "EUR");
egal("  moneda înaintea cifrei", (c.preturiDinText("Pret: EUR 45,00")[0] || {}).pret, 45);
egal("  un număr fără monedă nu e preț", c.preturiDinText("Comanda 12345 va fi livrata"), []);
egal("  rândurile citate din fir se sar", c.preturiDinText("> anul trecut era 10 lei"), []);

// --- 14. potrivirea cu articolele ------------------------------------------
console.log("\noferte: potrivirea cu articolele");
const ART = [
  { id: 1, nume: "Folie stretch 23 mic", um: "kg" },
  { id: 2, nume: "Punga curier 345x410", um: "buc" },
  { id: 3, nume: "Carton", um: "kg" },
];
egal("  exact, cu diacritice ignorate",
  c.potrivesteArticol("Punga curier 345x410", ART), { articol: ART[1], cum: "exact" });
egal("  exact, cu majuscule și punctuație",
  c.potrivesteArticol("FOLIE STRETCH 23 MIC.", ART).cum, "exact");
egal("  doar conținut → posibil, nu exact",
  c.potrivesteArticol("oferta noastra pentru Folie stretch 23 mic livrata", ART).cum, "posibil");
egal("  nimic nu se potrivește", c.potrivesteArticol("Ceva cu totul altceva", ART).articol, null);
egal("  denumirile scurte nu se potrivesc pe bucăți",
  c.potrivesteArticol("Transport si manipulare", ART).articol, null);

// --- 15. ce e ofertă și ce nu ----------------------------------------------
console.log("\noferte: poarta dinspre vânzări");
const oferta = (m, furnizor) => c.pareOferta(Object.assign({ de_la: "x@furnizor.ro" }, m), { furnizor });

egal("  ofertă de la furnizor",
  oferta({ subiect: "Oferta folie", corp: "Vă transmitem oferta: Folie stretch 23 mic - 12,50 lei/kg", partener_id: 5 }, true), true);
egal("  aceeași ofertă, dar partenerul e CLIENT → nu intră în Procurement",
  oferta({ subiect: "Oferta folie", corp: "Vă transmitem oferta: 12,50 lei/kg", partener_id: 5 }, false), false);
egal("  cuvinte de ofertă fără niciun preț → nu e ofertă",
  oferta({ subiect: "Oferta", corp: "Vă trimitem oferta atașată.", partener_id: 5 }, true), false);
egal("  prețuri fără cuvinte de ofertă → nu e ofertă",
  oferta({ subiect: "Re: factura", corp: "Am plătit 1.200 lei ieri.", partener_id: 5 }, true), false);
egal("  furnizor necunoscut (fără partener) tot se ia",
  oferta({ subiect: "Quotation", corp: "our prices: Carton 890 EUR", partener_id: null }, false), true);

// --- 16. culegerea ofertelor pe bază reală ---------------------------------
console.log("\noferte: culegerea");
exec1(`DELETE FROM email_oferte WHERE mesaj_id IN (SELECT id FROM email_mesaje WHERE gmail_id LIKE 'culegere-test-%')`);
const furn = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('FURNIZOR OFERTA SRL','RO-CUL-4','furnizor') RETURNING id`)[0].id);
const catArt = q(`SELECT id FROM ach_categorii ORDER BY id LIMIT 1`)[0];
const art1 = Number(q(`INSERT INTO ach_articole (nume, categorie_id, um, activ) VALUES ('Folie stretch test 23', ${catArt ? catArt.id : "NULL"}, 'kg', 1) RETURNING id`)[0].id);

const corpOferta = [
  "Bună ziua,",
  "",
  "Ca urmare a solicitării dumneavoastră, vă transmitem oferta:",
  "Folie stretch test 23 - 12,50 lei/kg",
  "Ceva ce nu avem in articole - 8,20 lei/kg",
  "",
  "Cu stimă,",
].join("\n");

const idOferta = Number(q(
  `INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, snippet, corp, directie, partener_id, activ)
   VALUES (?, 'culegere-test-20', ?, 'vanzari@furnizoroferta.ro', 'Ion Furnizor', 'furnizoroferta.ro', 'Oferta folie', 'oferta', ?, 'primit', ?, 1) RETURNING id`,
  [cont, new Date().toISOString().slice(0, 19).replace("T", " "), corpOferta, furn]
)[0].id);

const ro = await c.culegeOferte({ zile: 2 });
egal("  un mesaj recunoscut ca ofertă", ro.oferte, 1);
egal("  o linie pusă singură în oferte", ro.puse, 1);
egal("  una lăsată de confirmat", ro.de_confirmat, 1);

const achPus = q(`SELECT * FROM ach_oferte WHERE articol_id = ${art1} AND sursa = 'email'`)[0];
egal("  oferta din ach_oferte are prețul corect", Number(achPus.pret), 12.5);
egal("  și moneda", achPus.moneda, "RON");
egal("  și furnizorul", Number(achPus.furnizor_id), furn);
egal("  și trimiterea la email", achPus.email_id, String(idOferta));

const deConf = q(`SELECT * FROM email_oferte WHERE mesaj_id = ${idOferta} AND stare = 'de_confirmat'`);
egal("  rândul nepotrivit așteaptă un om", deConf.length, 1);
egal("  cu prețul citit", Number(deConf[0].pret), 8.2);
egal("  fără articol ghicit", deConf[0].articol_id, null);

egal("  mesajul e marcat ca ofertă", q(`SELECT fel FROM email_mesaje WHERE id = ${idOferta}`)[0].fel, "oferta");

// a doua rulare nu duplică
const ro2 = await c.culegeOferte({ zile: 2 });
egal("  a doua rulare nu mai ia mesajul", ro2.oferte, 0);
egal("  și nu face a doua ofertă", q(`SELECT COUNT(*) AS n FROM ach_oferte WHERE articol_id = ${art1} AND sursa = 'email'`)[0].n, "1");

// o ofertă NU trebuie să nască task de răspuns pentru agentul clientului
const k3 = await c.clasificaMesaje({ zile: 2 });
egal("  oferta nu naște task de cerere",
  q(`SELECT COUNT(*) AS n FROM taskuri WHERE partener_id = ${furn}`)[0].n, "0");

exec1(`DELETE FROM email_oferte WHERE mesaj_id = ${idOferta}`);
exec1(`DELETE FROM ach_oferte WHERE articol_id = ${art1}`);
exec1(`DELETE FROM email_mesaje WHERE id = ${idOferta}`);
exec1(`DELETE FROM ach_articole WHERE id = ${art1}`);
exec1(`DELETE FROM mk_contacte WHERE partener_id = ${furn}`);
exec1(`DELETE FROM taskuri WHERE partener_id = ${furn}`);
exec1(`DELETE FROM parteneri WHERE id = ${furn}`);


// --- 17. numele scos din adresă --------------------------------------------
// Cerința lui Vali: „în adresa de email ai de obicei compania, așa că alocă
// mailul la acea companie, contactul la acea companie cu cel puțin adresa de
// email". Deci nu mai renunțăm când semnătura nu dă un nume — coborâm la ce
// scrie înainte de @.
console.log("\nnumele din adresă");
for (const [email, asteptat] of [
  ["andreea.cernea@aectra.ro", { nume: "Andreea Cernea", fel: "persoana" }],
  ["ion_popescu@firma.ro", { nume: "Ion Popescu", fel: "persoana" }],
  ["maria-elena.radu@firma.ro", { nume: "Maria Elena Radu", fel: "persoana" }],
  ["comercial@euroink.it", { nume: "Comercial", fel: "rol" }],
  ["office@firma.ro", { nume: "Office", fel: "rol" }],
  ["export2@rotapack.hu", { nume: "Export2", fel: "rol" }],
  ["vlad@firma.ro", { nume: "Vlad", fel: "persoana" }],
  ["a@firma.ro", null],
  ["", null],
]) egal(`  ${email || "(gol)"}`, c.numeDinAdresa(email), asteptat);

// --- 18. mesajul fără semnătură tot dă contact -----------------------------
console.log("\nmesaj fără semnătură");
egal("  omul se ia din adresă",
  c.culegeDinMesaj({
    de_la: "andreea.cernea@aectratest.ro", de_la_nume: "AECTRA TEST SRL",
    de_la_domeniu: "aectratest.ro", partener_nume: "AECTRA TEST SRL", corp: "Buna ziua, va trimit avizul.",
  }),
  { nume: "Andreea Cernea", email: "andreea.cernea@aectratest.ro", functie: null, telefon: null, fel: "persoana" });

egal("  adresa de birou devine contact de rol",
  (c.culegeDinMesaj({
    de_la: "comercial@euroinktest.it", de_la_nume: "EUROINK TEST", de_la_domeniu: "euroinktest.it",
    partener_nume: "EUROINK TEST SRL", corp: "ok",
  }) || {}).fel, "rol");

egal("  gmail rămâne sărit, chiar și cu adresă bună",
  c.culegeDinMesaj({
    de_la: "ion.popescu@gmail.com", de_la_nume: "Ion Popescu", de_la_domeniu: "gmail.com",
    partener_nume: "X", corp: "ok",
  }), null);

// --- 19. același om, trei scrieri, un singur contact ------------------------
console.log("\nacelași om nu se scrie de trei ori");
exec1(`DELETE FROM mk_contacte WHERE partener_id IN (SELECT id FROM parteneri WHERE cui = 'RO-CUL-5')`);
exec1(`DELETE FROM email_mesaje WHERE gmail_id LIKE 'culegere-adr-%'`);
exec1(`DELETE FROM parteneri WHERE cui = 'RO-CUL-5'`);
const firmaAdr = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('AECTRA ADRTEST SRL','RO-CUL-5','furnizor') RETURNING id`)[0].id);
const acumStr = new Date().toISOString().slice(0, 19).replace("T", " ");
for (const [gid, numeDeLa] of [
  ["culegere-adr-1", "Andreea Cernea"],
  ["culegere-adr-2", "CERNEA ANDREEA"],
  ["culegere-adr-3", "AECTRA ADRTEST SRL"],
]) {
  q(
    `INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, corp, directie, partener_id, activ)
     VALUES (?,?,?,'andreea.cernea@aectraadrtest.ro',?,'aectraadrtest.ro','test','Buna ziua.','primit',?,1)`,
    [cont, gid, acumStr, numeDeLa, firmaAdr]
  );
}
const rAdr = await c.culegeSemnaturi({ zile: 2 });
egal("  un singur contact, deși numele e scris în trei feluri",
  Number(q(`SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id = ${firmaAdr}`)[0].n), 1);
egal("  și are adresa pe el",
  q(`SELECT id, email FROM mk_contacte WHERE partener_id = ${firmaAdr}`)[0].email, "andreea.cernea@aectraadrtest.ro");

exec1(`DELETE FROM mk_contacte WHERE partener_id = ${firmaAdr}`);
exec1(`DELETE FROM email_mesaje WHERE gmail_id LIKE 'culegere-adr-%'`);
exec1(`DELETE FROM parteneri WHERE id = ${firmaAdr}`);

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
