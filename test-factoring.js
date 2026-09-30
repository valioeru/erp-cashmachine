"use strict";
// Factoringul: clienții cesionați, banca, procentul și — cel mai important —
// textul care trebuie să ajungă pe factură.
//
// De ce există testul: dacă un client e în factoring și factura lui pleacă
// FĂRĂ clauza de cesiune, clientul plătește în contul nostru, banca nu-și
// recuperează avansul și rămânem noi datori. Greșeala nu se vede pe ecran —
// se vede peste 60 de zile, la reconciliere. Deci se prinde aici.
//
// Ce se verifică, pe PostgreSQL real (portul 5433):
//   1. clauza se compune corect: {IBAN} se înlocuiește, contractul stă în față;
//   2. nota proprie a unui client bate clauza băncii;
//   3. schimbarea IBAN-ului băncii schimbă textul la toți clienții ei;
//   4. un client nu poate intra de două ori în factoring;
//   5. pagina se deschide și arată clienții, procentele și textele;
//   6. scoaterea din factoring taie textul, nu șterge istoricul;
//   7. cei cinci clienți și clauza BRD sunt chiar în semințele bazei;
//   8. butonul de actualizare din SmartBill e pe pagina de facturi și
//      pagina lui se deschide;
//   9. ordinea de aplicare a loturilor pune facturile înaintea încasărilor.
//
// Se rulează din rădăcina repo-ului.
const path = require("path");
const fs = require("fs");
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
function q(sql, p) {
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

const MARCA = "TESTFACT";
let picate = 0;
function bine(nume, conditie, detaliu) {
  if (conditie) console.log(`  ok   ${nume}`);
  else { picate++; console.log(`  PICAT ${nume}${detaliu ? ": " + detaliu : ""}`); }
}

// Tabelele noi nu sunt în baza de test (care e o copie a producției de
// dinainte). Le creăm din CHIAR textul din lib/db.js, nu dintr-o copie scrisă
// aici — altfel testul ar trece pe o schemă care nu e cea livrată.
function creeazaTabelele() {
  const sursa = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
  for (const tabel of ["factoring_banci", "factoring_clienti"]) {
    const m = sursa.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tabel} \\([\\s\\S]*?\\n\\);`));
    if (!m) { picate++; console.log(`  PICAT nu găsesc CREATE TABLE ${tabel} în lib/db.js`); continue; }
    exec1(m[0]);
  }
  exec1(`CREATE UNIQUE INDEX IF NOT EXISTS idx_factoring_client_o_data ON factoring_clienti (partener_id) WHERE activ = 1`);
  for (const t of ["factoring_banci", "factoring_clienti"]) {
    exec1(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1))`);
  }
  for (const t of ["parteneri", "utilizatori", "facturi", "facturi_linii", "plati"]) {
    exec1(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1))`);
  }
}

function curata() {
  exec1(`DELETE FROM factoring_clienti WHERE partener_id IN (SELECT id FROM parteneri WHERE nume LIKE '${MARCA}%')`);
  exec1(`DELETE FROM factoring_banci WHERE nume LIKE '${MARCA}%'`);
  exec1(`DELETE FROM plati WHERE factura_id IN (SELECT id FROM facturi WHERE observatii = '${MARCA}')`);
  exec1(`DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE observatii = '${MARCA}')`);
  exec1(`DELETE FROM facturi WHERE observatii = '${MARCA}'`);
  exec1(`DELETE FROM parteneri WHERE nume LIKE '${MARCA}%'`);
  exec1(`DELETE FROM utilizatori WHERE nume LIKE '${MARCA}%'`);
}

const res = () => {
  const o = { cod: 0, corp: "", antet: null };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || null; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const undeDuce = (r) => String(((r.antet || {}).Location) || ((r.antet || {}).location) || "");

(async () => {
  console.log("Factoring: clienți cesionați, procent și textul de pe factură\n");
  creeazaTabelele();
  curata();

  const factoring = require(path.join(RAD, "modules", "factoring.js"));

  // ---- 1. compunerea textului ------------------------------------------
  console.log("textul care se pune pe factură se compune corect:");
  const CLAUZA = "Plata se face exclusiv în contul IBAN nr. {IBAN}, deschis la BRD Factoring.";
  const IBAN = "RO37BRDE428SV00000884280";

  const doarClauza = factoring.compuneNota({ clauza: CLAUZA, iban: IBAN, contract_nr: null, nota_proprie: null });
  bine("{IBAN} se înlocuiește cu IBAN-ul real", doarClauza.includes(IBAN), doarClauza);
  bine("nu mai rămâne niciun {IBAN} nelocuit", !/\{IBAN\}/.test(doarClauza), doarClauza);

  const cuContract = factoring.compuneNota({
    clauza: CLAUZA, iban: IBAN, contract_nr: "Contract nr. 03 din 10.09.2020 Sameday ROMANIA", nota_proprie: null,
  });
  bine("contractul stă ÎNAINTEA clauzei", cuContract.indexOf("Contract nr. 03") === 0, cuContract.slice(0, 60));
  bine("clauza vine după contract", cuContract.indexOf(IBAN) > cuContract.indexOf("Contract nr. 03"));

  const proprie = factoring.compuneNota({
    clauza: CLAUZA, iban: IBAN, contract_nr: "Contract nr. 99", nota_proprie: "Text cerut anume de bancă.",
  });
  bine("nota proprie bate tot", proprie === "Text cerut anume de bancă.", proprie);

  const gol = factoring.compuneNota({ clauza: "", iban: "", contract_nr: null, nota_proprie: null });
  bine("fără clauză iese text gol, nu „undefined”", gol === "", JSON.stringify(gol));

  // ---- 2. pe date reale în bază -----------------------------------------
  console.log("\npe date reale în bază:");
  const banca = q(
    `INSERT INTO factoring_banci (nume, iban, procent_implicit, clauza, activ) VALUES (?, ?, 85, ?, 1) RETURNING id`,
    [MARCA + " BRD", IBAN, CLAUZA]
  )[0];
  const bancaId = Number(banca.id);

  const clientId = Number(
    q(`INSERT INTO parteneri (tip, nume) VALUES ('client', ?) RETURNING id`, [MARCA + " EMAG"])[0].id
  );
  const client2Id = Number(
    q(`INSERT INTO parteneri (tip, nume) VALUES ('client', ?) RETURNING id`, [MARCA + " DELIVERY"])[0].id
  );
  const userId = Number(
    q(`INSERT INTO utilizatori (nume, email, rol, activ, parola_hash, parola_salt) VALUES (?, ?, 'admin', 1, 'x', 'x') RETURNING id`,
      [MARCA + " Admin", MARCA.toLowerCase() + "@test.local"])[0].id
  );

  const rute = { get: {}, post: {} };
  const inreg = {
    get: (c, h) => { if (!rute.get[c]) rute.get[c] = h; },
    post: (c, h) => { if (!rute.post[c]) rute.post[c] = h; },
    options: () => {},
  };
  factoring.register(inreg);
  require(path.join(RAD, "modules", "facturi.js")).register(inreg);
  const ADMIN = { id: userId, nume: MARCA + " Admin", rol: "admin" };
  const cere = async (metoda, cale, intrebari, corp, params) => {
    const h = rute[metoda][cale];
    if (!h) { picate++; console.log(`  PICAT ruta ${metoda.toUpperCase()} ${cale} nu e înregistrată`); return res(); }
    const r = res();
    await h({ user: ADMIN, params: params || {}, query: intrebari || {}, body: corp || {}, res: r, req: { headers: { host: "test.local" } } });
    return r;
  };

  let r = await cere("post", "/financiar/factoring/client", {}, { partener: String(clientId), banca: String(bancaId), procent: "85" });
  let randuri = q(`SELECT * FROM factoring_clienti WHERE partener_id = ? AND activ = 1`, [clientId]);
  bine("clientul a intrat în factoring", randuri.length === 1 && Number(randuri[0].procent_finantare) === 85,
    JSON.stringify(randuri));

  // a doua oară nu se mai poate
  await cere("post", "/financiar/factoring/client", {}, { partener: String(clientId), banca: String(bancaId), procent: "85" });
  randuri = q(`SELECT * FROM factoring_clienti WHERE partener_id = ? AND activ = 1`, [clientId]);
  bine("nu poate intra de două ori", randuri.length === 1, `${randuri.length} rânduri`);

  // al doilea client, cu contract
  await cere("post", "/financiar/factoring/client", {}, {
    partener: String(client2Id), banca: String(bancaId), procent: "90",
    contract: "Contract nr. 03 din 10.09.2020 Sameday ROMANIA",
  });

  let nota = await factoring.notaPentruPartener(client2Id);
  bine("nota clientului cu contract începe cu contractul",
    nota && nota.nota.indexOf("Contract nr. 03") === 0, nota && nota.nota.slice(0, 50));
  bine("nota clientului cu contract conține IBAN-ul", nota && nota.nota.includes(IBAN));
  bine("procentul lui e 90, nu implicitul 85", nota && nota.procent === 90, nota && String(nota.procent));

  nota = await factoring.notaPentruPartener(clientId);
  bine("clientul fără contract are doar clauza", nota && nota.nota.indexOf("Plata se face") === 0, nota && nota.nota.slice(0, 40));

  // ---- 3. IBAN-ul schimbat la bancă schimbă textul la toți --------------
  console.log("\nIBAN-ul se ține într-un singur loc:");
  const IBAN2 = "RO99BRDE000TESTIBAN00001";
  await cere("post", "/financiar/factoring/banca/:id", {}, {
    nume: MARCA + " BRD", iban: IBAN2, procent: "85", clauza: CLAUZA,
  }, { id: String(bancaId) });
  const dupa1 = await factoring.notaPentruPartener(clientId);
  const dupa2 = await factoring.notaPentruPartener(client2Id);
  bine("IBAN-ul nou a ajuns la primul client", dupa1 && dupa1.nota.includes(IBAN2), dupa1 && dupa1.nota);
  bine("IBAN-ul nou a ajuns și la al doilea", dupa2 && dupa2.nota.includes(IBAN2));
  bine("IBAN-ul vechi a dispărut de peste tot", dupa1 && !dupa1.nota.includes(IBAN) && dupa2 && !dupa2.nota.includes(IBAN));

  // ---- 4. pagina --------------------------------------------------------
  console.log("\npagina /financiar/factoring:");
  r = await cere("get", "/financiar/factoring", {});
  bine("se deschide", r.cod === 200, "cod " + r.cod);
  bine("arată primul client", r.corp.includes(MARCA + " EMAG"));
  bine("arată al doilea client", r.corp.includes(MARCA + " DELIVERY"));
  bine("arată IBAN-ul băncii", r.corp.includes(IBAN2));
  bine("arată textul de inserat, pe rând", r.corp.includes("Plata se face exclusiv"));
  bine("are coloana cu textul de pe factură", /Textul care se pune pe factură/.test(r.corp));
  bine("are câmp de procent editabil", /name="procent"/.test(r.corp));
  bine("are căutare pentru un client nou", /name="cauta"/.test(r.corp));
  bine("are șablonul clauzei, editabil", /name="clauza"/.test(r.corp));
  bine("spune de ce contează clauza", /cesiunea nu se|nu se stinge/i.test(r.corp));

  // căutarea nu propune un client care e deja în factoring
  r = await cere("get", "/financiar/factoring", { cauta: MARCA });
  const de = r.corp.indexOf("Adaugă un client în factoring");
  const panou = de >= 0 ? r.corp.slice(de) : "";
  bine("căutarea nu propune un client deja cesionat", !panou.includes(MARCA + " EMAG</td>") && !/>\s*TESTFACT EMAG\s*</.test(panou.split("Băncile")[0]),
    panou.replace(/\s+/g, " ").slice(0, 200));

  // ---- 5. procentul se poate schimba ------------------------------------
  console.log("\nprocentul și contractul se pot schimba:");
  const randEmag = q(`SELECT id FROM factoring_clienti WHERE partener_id = ? AND activ = 1`, [clientId])[0];
  await cere("post", "/financiar/factoring/client/:id", {}, {
    banca: String(bancaId), procent: "70", contract: "Contract nr. 7", nota_proprie: "",
  }, { id: String(randEmag.id) });
  const schimbat = await factoring.notaPentruPartener(clientId);
  bine("procentul e acum 70", schimbat && schimbat.procent === 70, schimbat && String(schimbat.procent));
  bine("contractul a intrat în text", schimbat && schimbat.nota.indexOf("Contract nr. 7") === 0, schimbat && schimbat.nota.slice(0, 30));

  // un procent aberant se taie la 100
  await cere("post", "/financiar/factoring/client/:id", {}, {
    banca: String(bancaId), procent: "480", contract: "", nota_proprie: "",
  }, { id: String(randEmag.id) });
  const plafonat = await factoring.notaPentruPartener(clientId);
  bine("un procent peste 100 se taie la 100", plafonat && plafonat.procent === 100, plafonat && String(plafonat.procent));

  // ---- 6. scoaterea din factoring ---------------------------------------
  console.log("\nscoaterea din factoring:");
  await cere("post", "/financiar/factoring/client/:id/scoate", {}, {}, { id: String(randEmag.id) });
  bine("clientul scos nu mai are notă", (await factoring.notaPentruPartener(clientId)) === null);
  bine("celălalt client a rămas", (await factoring.clientulEInFactoring(client2Id)) === true);
  const istoric = q(`SELECT activ FROM factoring_clienti WHERE id = ?`, [randEmag.id]);
  bine("rândul nu s-a șters, doar s-a dezactivat", istoric.length === 1 && Number(istoric[0].activ) === 0,
    JSON.stringify(istoric));
  // și poate fi pus la loc
  await cere("post", "/financiar/factoring/client", {}, { partener: String(clientId), banca: String(bancaId), procent: "85" });
  bine("poate fi pus la loc după ce a fost scos", (await factoring.clientulEInFactoring(clientId)) === true);

  // ---- 7. semințele: cei cinci clienți și clauza BRD --------------------
  console.log("\nsemințele din lib/db.js:");
  const sursaDb = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
  for (const nume of ["emag retail", "delivery solutions", "beko romania", "cargus", "kandia"]) {
    bine(`${nume} e în lista de pornire`, sursaDb.includes(nume));
  }
  bine("IBAN-ul BRD e cel de pe facturile din SmartBill", sursaDb.includes("RO37BRDE428SV00000884280"));
  bine("clauza spune „Pentru a fi liberatoare”", sursaDb.includes("Pentru a fi liberatoare"));
  bine("clauza pomenește Direcția Factoring", sursaDb.includes("Direcția Factoring"));
  bine("Delivery Solutions are numărul lui de contract",
    sursaDb.includes("Contract nr. 03 din 10.09.2020 Sameday ROMANIA"));
  bine("semănatul se face doar pe gol", /areClienti[\s\S]{0,120}return;/.test(sursaDb));

  // ---- 8. butonul de actualizare din SmartBill --------------------------
  console.log("\nbutonul de actualizare din SmartBill:");
  r = await cere("get", "/facturi", {});
  bine("butonul e pe pagina de facturi", /href="\/facturi\/actualizare"/.test(r.corp));
  r = await cere("get", "/facturi/actualizare", {});
  bine("pagina lui se deschide", r.cod === 200, "cod " + r.cod);
  bine("explică de ce nu poate trage serverul singur", /API-ul lor e pentru emitere|nu pentru citire/i.test(r.corp));
  bine("are semnul de carte de tras în favorite", /javascript:\(function\(\)\{fetch/.test(r.corp));
  // esc() transformă apostroful în &#39; — browserul îl citește la loc când
  // parsează atributul, deci semnul de carte funcționează. Căutăm forma scăpată.
  bine("semnul de carte arată spre gazda curentă",
    /fetch\(&#39;https?:\/\/test\.local\/punte\/sincronizare\.js&#39;\)/.test(r.corp),
    (r.corp.match(/fetch\([^)]{0,90}/) || [""])[0]);
  bine("spune când a fost ultima culegere", /Ultima culegere/.test(r.corp));
  r = await cere("post", "/facturi/actualizare/aplica", {}, {});
  bine("apăsat pe gol, nu crapă și spune că n-a avut ce aplica",
    /mesaj=/.test(undeDuce(r)) && /nimic/i.test(decodeURIComponent(undeDuce(r))), undeDuce(r));

  // ---- 9. ordinea de aplicare a loturilor -------------------------------
  console.log("\nordinea în care se aplică loturile:");
  const aplicare = require(path.join(RAD, "lib", "punte-aplica.js"));
  const o = aplicare.ORDINE;
  const dupaTip = (t) => { const i = o.indexOf(t); return i === -1 ? 99 : i; };
  bine("partenerii înaintea facturilor", dupaTip("parteneri") < dupaTip("facturi"));
  bine("facturile înaintea încasărilor", dupaTip("facturi") < dupaTip("incasari"));
  bine("facturile înaintea liniilor lor", dupaTip("facturi") < dupaTip("facturi_linii"));
  bine("produsele înaintea stocului", dupaTip("produse") < dupaTip("stoc"));
  bine("un tip necunoscut se aplică la urmă, nu la început", dupaTip("ceva_nou") > dupaTip("consum"));
  // vechiul cod sorta cu indexOf brut, deci -1 punea facturile în frunte
  bine("nu mai sortează cu indexOf brut",
    !/ordine\.indexOf\(a\.tip\) - ordine\.indexOf\(b\.tip\)/.test(fs.readFileSync(path.join(RAD, "modules", "punte-rute.js"), "utf8")));
  bine("aplicarea e scrisă într-un singur loc",
    /require\("\.\.\/lib\/punte-aplica"\)/.test(fs.readFileSync(path.join(RAD, "modules", "punte-rute.js"), "utf8")) &&
    /require\("\.\.\/lib\/punte-aplica"\)/.test(fs.readFileSync(path.join(RAD, "modules", "facturi.js"), "utf8")));

  curata();
  console.log(picate ? `\n${picate} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(picate ? 1 : 0);
})().catch((e) => {
  console.error("Testul a crăpat:", e.message);
  process.exit(2);
});
