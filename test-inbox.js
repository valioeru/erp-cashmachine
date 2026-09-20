"use strict";
// Test pentru emailul adus în ERP.
//
// Rulează pe PostgreSQL adevărat, prin psql (vezi comentariul din
// test-depozit.js). Se rulează din rădăcina repo-ului, cu baza pe 5433.
//
// Partea de rețea (Gmail, Drive) NU se apelează: e înlocuită cu un Gmail fals
// și un Drive fals, definite aici. Ce se verifică e logica pe care am scris-o
// eu — legarea de partener, deduplicarea, direcția, drepturile — nu faptul că
// Google răspunde la HTTP. Pentru partea de rețea există pagina de verificare
// din Configurări, care se rulează pe date adevărate.
//
// Ce se verifică:
//   1. semnătura JWT pentru service account e RS256 valid, cu iss/scope/sub
//      la locul lor — altfel Google refuză, iar mesajul lui nu explică nimic;
//   2. un email primit se leagă de partener după adresa exactă, apoi după
//      domeniu, iar domeniile publice (gmail.com) NU leagă pe nimeni;
//   3. numărul de factură sau de ofertă din subiect leagă documentul;
//   4. un email trimis DIN căsuță e marcat „trimis", nu „primit";
//   5. atașamentele urcă în Drive sub <Partener>/<AAAA-LL>, cele inline sunt
//      sărite, iar același fișier de două ori nu face două copii;
//   6. un atașament care nu urcă nu pierde mesajul — rămâne cu eroarea pe el;
//   7. resincronizarea nu dublează mesajele;
//   8. drepturile: agentul își vede căsuța lui și pe cele comune, nu și
//      căsuța altuia; adminul le vede pe toate.
const path = require("path");
const Module = require("module");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : "'" + String(v).replace(/'/g, "''") + "'";

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

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
process.env.GOOGLE_DRIVE_FOLDER = "FOLDER-TEST";

// --- Gmail și Drive false ---------------------------------------------------
// Se pun ÎNAINTE de a încărca modulul, prin Module._load: modulul cere
// „../lib/gmail" și „../lib/drive" la încărcare, iar dacă i-am înlocui
// funcțiile după aceea ar rămâne cu cele adevărate.
const GMAIL = { mesaje: new Map(), listate: [], atasamente: new Map() };
const DRIVE = { fisiere: [], foldere: [], erori: new Set() };

const gmailFals = {
  listeazaDupaCautare: async () => GMAIL.listate,
  listeazaDupaIstoric: async () => ({ iduri: GMAIL.listate, historyId: "999", pierdut: false }),
  profil: async (casuta) => ({ adresa: casuta, mesaje: 10, fire: 5, historyId: "999" }),
  mesaj: async (casuta, id) => GMAIL.mesaje.get(id),
  atasament: async (casuta, mid, aid) => GMAIL.atasamente.get(aid) || Buffer.from("continut " + aid),
  // astea sunt funcții pure din lib/gmail.js, le luăm pe cele adevărate
  adresa: null, adrese: null, domeniu: null,
};

const driveFals = {
  cale: async (bucati, radacina) => {
    const cale = [radacina, ...bucati].join("/");
    if (!DRIVE.foldere.includes(cale)) DRIVE.foldere.push(cale);
    return cale;
  },
  urca: async ({ nume, mime, continut, parinte }) => {
    if (DRIVE.erori.has(nume)) throw new Error("Drive a refuzat fișierul");
    const md5 = crypto.createHash("md5").update(continut).digest("hex");
    const existent = DRIVE.fisiere.find((f) => f.md5 === md5 && f.parinte === parinte);
    if (existent) return { id: existent.id, nume: existent.nume, link: existent.link, md5, marime: continut.length, duplicat: true };
    const id = "drv" + (DRIVE.fisiere.length + 1);
    const f = { id, nume, mime, parinte, md5, link: "https://drive.test/" + id, marime: continut.length };
    DRIVE.fisiere.push(f);
    return { ...f, duplicat: false };
  },
  info: async () => ({ name: "Folder test" }),
  sterge: async () => {},
  linkul: (id) => "https://drive.test/" + id,
};

const orig = Module._load;
Module._load = function (req, parinte) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/[\\/]lib[\\/]?$/.test(String(req)) === false && (req === "../lib/gmail" || req === "./lib/gmail")) {
    const adevarat = orig.apply(this, [path.join(RAD, "lib", "gmail.js"), parinte]);
    return Object.assign({}, adevarat, gmailFals, { adresa: adevarat.adresa, adrese: adevarat.adrese, domeniu: adevarat.domeniu });
  }
  if (req === "../lib/drive" || req === "./lib/drive") return driveFals;
  return orig.apply(this, arguments);
};

const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});
// db.exec trimite un lot de comenzi într-o singură interogare simplă — așa îl
// rulează și pg, ca tranzacție. Fără shim, ștergerea căsuței ar „reuși" în test
// fără să șteargă nimic, pentru că pool-ul fals răspunde cu rânduri goale.
db.exec = async (sql) => {
  interogari++;
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
};

const google = require(path.join(RAD, "lib", "google.js"));
const inbox = require(path.join(RAD, "modules", "inbox.js"));

const rute = { get: {}, post: {} };
inbox.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; }, options: () => {} });

const res = () => {
  const o = { cod: 0, antet: null, corp: "", locatie: null };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; if (h && h.Location) o.locatie = h.Location; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin", email: "vali@cashmachine.ro" };
const AGENT = { id: 2, nume: "Agentul", rol: "vanzari", email: "agent@cashmachine.ro" };
const ALTUL = { id: 3, nume: "Altul", rol: "depozit", email: "altul@cashmachine.ro" };

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
const egal = (eticheta, a, b) => (String(a) === String(b) ? ok(`${eticheta} = ${a}`) : rau(eticheta, `am ${a}, așteptam ${b}`));
function cere(eticheta, corp, bucati, interzise) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined<|>undefined/.test(fara)) return rau(eticheta, "NaN/undefined în pagină");
  const lipsa = bucati.filter((b) => !fara.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => fara.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta + " (" + corp.length + " octeți)");
}

const rulaj = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

// --- fixtură ---------------------------------------------------------------
function curatenie() {
  for (const s of [
    "DELETE FROM email_atasamente WHERE mesaj_id IN (SELECT id FROM email_mesaje WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro'))",
    "DELETE FROM email_oferte WHERE mesaj_id IN (SELECT id FROM email_mesaje WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro'))",
    "UPDATE comenzi SET email_mesaj_id = NULL WHERE id = 93501",
    "DELETE FROM email_mesaje WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro')",
    "DELETE FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro'",
    // Blocații se curăță ÎNTOTDEAUNA, nu doar la final, și se curăță TOȚI: dacă
    // testul crapă la mijloc, un domeniu rămas blocat face ca rularea
    // următoare să nu mai aducă mesajele fixturii, iar eroarea arată ca
    // altceva — „prima sincronizare aduce 2 din 6", nicăieri un cuvânt despre
    // blocare. Un filtru pe nume n-ar ajunge: se blochează domeniul
    // expeditorului din fixtură, care nu seamănă cu numele testului.
    "DELETE FROM email_blocate",
    "DELETE FROM comenzi WHERE id = 93501",
    "DELETE FROM taskuri WHERE id = 93401",
    "DELETE FROM oferte_linii WHERE oferta_id = 93201",
    "DELETE FROM oferte WHERE id = 93201",
    "DELETE FROM facturi_linii WHERE factura_id = 93301",
    "DELETE FROM facturi WHERE id = 93301",
    "DELETE FROM parteneri WHERE id IN (93001, 93002)",
  ]) {
    try { rulaj(s); } catch (e) {}
  }
}

function fixture() {
  curatenie();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@cashmachine.ro','x','y','admin'), (2,'Agentul','agent@cashmachine.ro','x','y','vanzari'), (3,'Altul','altul@cashmachine.ro','x','y','depozit') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO parteneri (id, nume, cui, tip, email) VALUES (93001,'ACME PLASTIC SRL','RO-INB-1','client','contact@acme-plastic.ro') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO parteneri (id, nume, cui, tip, email) VALUES (93002,'OMUL DE PE GMAIL SRL','RO-INB-2','client','omul@gmail.com') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO oferte (id, numar, versiune, radacina_id, partener_id, status) VALUES (93201,'OF09321',1,93201,93001,'trimisa') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, intercompany, activ) VALUES (93301,'CSHM','7788',93001,'vanzare','2026-09-01','2026-10-01','emisa',0,1) ON CONFLICT (id) DO NOTHING",
    "INSERT INTO email_conturi (adresa, eticheta, tip, utilizator_id) VALUES ('office@test-inbox.ro','comuna','comun',NULL)",
    "INSERT INTO email_conturi (adresa, eticheta, tip, utilizator_id) VALUES ('agent@test-inbox.ro','a agentului','personal',2)",
  ]) rulaj(s);
}

function mesajFals(id, x) {
  GMAIL.mesaje.set(id, Object.assign({
    id, firId: "f" + id, historyId: "1", data: "2026-09-15T08:30:00.000Z",
    etichete: "INBOX", snippet: "…", de_la: "", catre: "", cc: "", subiect: "", text: "", html: "",
    atasamente: [],
  }, x));
}

(async () => {
  console.log("\n── Emailul în ERP ────────────────────────────────────────────");

  // ---- 1. JWT-ul pentru service account ----------------------------------
  const pereche = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cheiePem = pereche.privateKey.export({ type: "pkcs8", format: "pem" });
  process.env.GOOGLE_SA_JSON = JSON.stringify({
    client_email: "erp-email@proiect-test.iam.gserviceaccount.com",
    private_key: String(cheiePem).replace(/\n/g, "\\n"), // exact cum ajunge lipită într-o variabilă de mediu
    project_id: "proiect-test",
    client_id: "123456789012345678901",
  });
  google.reseteaza();
  const c = google.cont();
  egal("cheia lipită cu \\n în loc de rânduri noi e reparată", c.ok, true);

  const jwt = google.semneaza(
    { alg: "RS256", typ: "JWT" },
    { iss: c.email, scope: google.SCOPE_GMAIL, aud: google.URL_TOKEN, iat: 1, exp: 3601, sub: "office@test-inbox.ro" },
    c.cheie
  );
  const [h64, p64, s64] = jwt.split(".");
  const inc = JSON.parse(Buffer.from(p64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  egal("JWT-ul are scope-ul de citire Gmail", inc.scope, google.SCOPE_GMAIL);
  egal("JWT-ul impersonează căsuța cerută", inc.sub, "office@test-inbox.ro");
  const valid = crypto
    .createVerify("RSA-SHA256")
    .update(`${h64}.${p64}`)
    .verify(pereche.publicKey, Buffer.from(s64.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  egal("semnătura RS256 se verifică", valid, true);

  // cheie stricată -> mesaj care spune ce e de făcut, nu o urmă de stivă
  process.env.GOOGLE_SA_JSON = "{ nu e json";
  google.reseteaza();
  const stricata = google.cont();
  if (!stricata.ok && /JSON valid/.test(stricata.eroare)) ok("o cheie stricată dă un mesaj pe înțeles");
  else rau("o cheie stricată dă un mesaj pe înțeles", stricata.eroare);
  process.env.GOOGLE_SA_JSON = JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: String(cheiePem), project_id: "p" });
  google.reseteaza();

  // ---- 2..6. sincronizarea ------------------------------------------------
  fixture();
  const office = q("SELECT * FROM email_conturi WHERE adresa = 'office@test-inbox.ro'")[0];

  mesajFals("m1", {
    de_la: "Ionel <contact@acme-plastic.ro>",
    catre: "office@test-inbox.ro",
    subiect: "Oferta pentru comanda dumneavoastra",
    text: "Buna ziua, atasat oferta.",
    atasamente: [
      { nume: "oferta.pdf", mime: "application/pdf", marime: 1200, atasamentId: "a1", inline: false },
      { nume: "logo.png", mime: "image/png", marime: 900, atasamentId: "a2", inline: true },
    ],
  });
  mesajFals("m2", {
    de_la: "Vanzari <vanzari@acme-plastic.ro>",
    catre: "office@test-inbox.ro",
    subiect: "Re: factura CSHM7788 — confirmare",
    text: "Am primit factura.",
  });
  mesajFals("m3", {
    de_la: "office@test-inbox.ro",
    catre: "cineva@altundeva.ro",
    subiect: "Raspuns la OF09321",
    text: "Trimis de noi.",
  });
  mesajFals("m4", {
    de_la: "Necunoscut <habarnam@gmail.com>",
    catre: "office@test-inbox.ro",
    subiect: "Intrebare",
    text: "Salut.",
  });
  mesajFals("m5", {
    de_la: "Ionel <contact@acme-plastic.ro>",
    catre: "office@test-inbox.ro",
    subiect: "Inca o data aceeasi oferta",
    text: "Retrimit.",
    atasamente: [{ nume: "oferta.pdf", mime: "application/pdf", marime: 1200, atasamentId: "a1", inline: false }],
  });
  mesajFals("m6", {
    de_la: "Ionel <contact@acme-plastic.ro>",
    catre: "office@test-inbox.ro",
    subiect: "Cu un fisier care nu urca",
    text: "…",
    atasamente: [{ nume: "stricat.xlsx", mime: "application/vnd.ms-excel", marime: 500, atasamentId: "a9", inline: false }],
  });
  GMAIL.atasamente.set("a1", Buffer.from("PDF-UL-OFERTEI"));
  GMAIL.atasamente.set("a9", Buffer.from("x"));
  DRIVE.erori.add("stricat.xlsx");
  GMAIL.listate = ["m1", "m2", "m3", "m4", "m5", "m6"];

  const r1 = await inbox.sincronizeazaCont(office);
  egal("prima sincronizare aduce toate mesajele", r1.noi, 6);
  egal("fără erori la sincronizare", r1.eroare, "null");

  const m1 = q("SELECT * FROM email_mesaje WHERE gmail_id = 'm1'")[0];
  egal("adresa exactă leagă partenerul", m1.partener_id, "93001");
  egal("mesajul primit e marcat primit", m1.directie, "primit");

  const m2 = q("SELECT * FROM email_mesaje WHERE gmail_id = 'm2'")[0];
  egal("domeniul leagă partenerul când adresa nu se potrivește", m2.partener_id, "93001");
  egal("numărul de factură din subiect leagă factura", m2.factura_id, "93301");

  const m3 = q("SELECT * FROM email_mesaje WHERE gmail_id = 'm3'")[0];
  egal("mesajul trimis din căsuță e marcat trimis", m3.directie, "trimis");
  egal("numărul de ofertă din subiect leagă oferta", m3.oferta_id, "93201");

  const m4 = q("SELECT * FROM email_mesaje WHERE gmail_id = 'm4'")[0];
  egal("un domeniu public NU leagă niciun partener", m4.partener_id, "null");

  // atașamente
  const atasM1 = q("SELECT * FROM email_atasamente WHERE mesaj_id = " + m1.id);
  egal("atașamentul inline e sărit", atasM1.length, 1);
  egal("atașamentul e urcat în Drive", atasM1[0].drive_id !== null, true);
  const folderAsteptat = "FOLDER-TEST/ACME PLASTIC SRL/2026-09";
  if (DRIVE.foldere.includes(folderAsteptat)) ok("fișierul merge în " + folderAsteptat);
  else rau("folderul din Drive", "am " + JSON.stringify(DRIVE.foldere.slice(0, 4)));

  const m5 = q("SELECT * FROM email_mesaje WHERE gmail_id = 'm5'")[0];
  const atasM5 = q("SELECT * FROM email_atasamente WHERE mesaj_id = " + m5.id)[0];
  egal("același fișier a doua oară e recunoscut ca duplicat", atasM5.duplicat, "1");
  egal("și nu creează un al doilea fișier în Drive", DRIVE.fisiere.filter((f) => f.nume === "oferta.pdf").length, 1);

  const m6 = q("SELECT * FROM email_mesaje WHERE gmail_id = 'm6'")[0];
  const atasM6 = q("SELECT * FROM email_atasamente WHERE mesaj_id = " + m6.id)[0];
  if (atasM6 && atasM6.eroare && !atasM6.drive_id) ok("un atașament care nu urcă rămâne cu eroarea pe el, mesajul nu se pierde");
  else rau("atașamentul nereușit", JSON.stringify(atasM6));

  // ---- 7. resincronizarea nu dublează -------------------------------------
  const office2 = q("SELECT * FROM email_conturi WHERE adresa = 'office@test-inbox.ro'")[0];
  const r2 = await inbox.sincronizeazaCont(office2);
  egal("a doua sincronizare nu aduce nimic nou", r2.noi, 0);
  egal("și le recunoaște pe toate ca deja aduse", r2.sarite, 6);
  egal("nu s-au dublat mesajele", Number(q("SELECT COUNT(*) AS n FROM email_mesaje WHERE cont_id = " + office.id)[0].n), 6);

  // ---- 8. drepturile ------------------------------------------------------
  const agentCont = q("SELECT * FROM email_conturi WHERE adresa = 'agent@test-inbox.ro'")[0];
  rulaj(`INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_domeniu, subiect, directie) VALUES (${agentCont.id},'ma1','2026-09-16 10:00:00','x@y.ro','y.ro','SECRETUL AGENTULUI','primit')`);

  let p = await cer("/email", { user: VALI });
  cere("adminul vede și căsuța comună și pe a agentului", p.corp, ["Oferta pentru comanda dumneavoastra", "SECRETUL AGENTULUI"]);

  p = await cer("/email", { user: AGENT });
  cere("agentul își vede căsuța lui și pe cea comună", p.corp, ["SECRETUL AGENTULUI", "Oferta pentru comanda dumneavoastra"]);

  p = await cer("/email", { user: ALTUL });
  cere("altcineva vede doar căsuța comună, nu și pe a agentului", p.corp, ["Oferta pentru comanda dumneavoastra"], ["SECRETUL AGENTULUI"]);

  // filtre
  p = await cer("/email", { user: VALI, query: { legat: "nelegate" } });
  cere("filtrul de atribuit arată mesajul de pe gmail.com", p.corp, ["Intrebare"], ["Oferta pentru comanda dumneavoastra"]);
  p = await cer("/email", { user: VALI, query: { directie: "trimis" } });
  cere("filtrul pe trimise", p.corp, ["Raspuns la OF09321"], ["Intrebare"]);
  p = await cer("/email", { user: VALI, query: { atasamente: "cu" } });
  cere("filtrul pe atașamente", p.corp, ["Oferta pentru comanda dumneavoastra"], ["Intrebare"]);

  // fișa mesajului + atribuire manuală
  p = await cer("/email/:id", { user: VALI, params: { id: String(m4.id) } });
  cere("fișa mesajului", p.corp, ["Intrebare", "Deschide în Gmail", "Atribuie"]);
  await cer("/email/:id/leaga", { user: VALI, metoda: "post", params: { id: String(m4.id) }, body: { partener_id: "93002" } });
  egal("atribuirea manuală se salvează", q("SELECT partener_id FROM email_mesaje WHERE id = " + m4.id)[0].partener_id, "93002");
  egal("și se scrie de unde vine legătura", q("SELECT legat_cum FROM email_mesaje WHERE id = " + m4.id)[0].legat_cum, "pus de om");

  // blocul de pe fișa partenerului
  const bloc = await inbox.blocEmailuri({ user: VALI, partenerId: 93001 });
  cere("blocul de pe fișa partenerului", bloc, ["Emailuri", "Oferta pentru comanda dumneavoastra"]);
  const blocGol = await inbox.blocEmailuri({ user: ALTUL, partenerId: 93001 });
  cere("blocul respectă drepturile", blocGol, ["Oferta pentru comanda dumneavoastra"]);

  // lista de atașamente
  p = await cer("/email/atasamente", { user: VALI });
  cere("lista de atașamente", p.corp, ["oferta.pdf", "stricat.xlsx"]);
  p = await cer("/email/atasamente", { user: VALI, query: { stare: "nereusite" } });
  cere("filtrul pe atașamente nereușite", p.corp, ["stricat.xlsx"], ["oferta.pdf"]);

  // --- expeditorii blocați --------------------------------------------------
  // Cererea lui Vali: „la orice email sosit să-i împiedicăm pe viitor să mai
  // intre în ERP; odată marcate așa, în timp scăpăm de reclame".
  //
  // Ce păzește testul, în ordinea în care lucrurile s-ar strica:
  //   • blocatul chiar nu mai intră la sincronizare;
  //   • blocarea pe domeniu prinde și subdomeniile, altfel fiecare robot și-ar
  //     face alt subdomeniu și n-am termina niciodată;
  //   • domeniul NOSTRU nu se poate bloca — o apăsare greșită acolo ar opri
  //     tot emailul firmei;
  //   • deblocarea aduce înapoi mesajele scoase. Blocarea e o hotărâre, nu o
  //     ștergere.
  console.log("\nexpeditori blocați");
  rulaj("DELETE FROM email_blocate WHERE valoare LIKE '%test-inbox%' OR valoare LIKE '%reclame-test%'");

  const unMesaj = q("SELECT id, de_la, de_la_domeniu FROM email_mesaje WHERE cont_id = (SELECT id FROM email_conturi WHERE adresa = 'office@test-inbox.ro') ORDER BY id LIMIT 1")[0];
  p = await cer("/email/:id", { user: VALI, params: { id: String(unMesaj.id) } });
  cere("fișa mesajului are butonul de blocare", p.corp, ["Nu mai aduce de aici", "Blochează", "Vezi lista blocaților"]);

  // blocare pe domeniu, cu scoaterea mesajelor deja aduse
  const inainteBlocare = Number(q(`SELECT COUNT(*) AS n FROM email_mesaje WHERE activ = 1 AND lower(de_la_domeniu) = '${String(unMesaj.de_la_domeniu).toLowerCase()}'`)[0].n);
  await cer("/email/:id/blocheaza", { user: VALI, metoda: "post", params: { id: String(unMesaj.id) }, body: { fel: "domeniu", scoate: "1" } });
  egal("domeniul e trecut la blocați",
    q(`SELECT COUNT(*) AS n FROM email_blocate WHERE fel = 'domeniu' AND lower(valoare) = '${String(unMesaj.de_la_domeniu).toLowerCase()}' AND activ = 1`)[0].n, "1");
  egal("mesajele lui au ieșit din ERP",
    Number(q(`SELECT COUNT(*) AS n FROM email_mesaje WHERE activ = 1 AND lower(de_la_domeniu) = '${String(unMesaj.de_la_domeniu).toLowerCase()}'`)[0].n), 0);
  egal("dar rândurile sunt tot în bază",
    Number(q(`SELECT COUNT(*) AS n FROM email_mesaje WHERE lower(de_la_domeniu) = '${String(unMesaj.de_la_domeniu).toLowerCase()}'`)[0].n) >= inainteBlocare, true);

  egal("blocatul se recunoaște după adresă", inbox.eBlocat(
    { adrese: new Set(["reclame@reclame-test.ro"]), domenii: new Set() }, "Reclame@Reclame-Test.ro", "reclame-test.ro"), true);
  egal("și după domeniu", inbox.eBlocat(
    { adrese: new Set(), domenii: new Set(["reclame-test.ro"]) }, "x@reclame-test.ro", "reclame-test.ro"), true);
  egal("subdomeniul cade sub domeniul blocat", inbox.eBlocat(
    { adrese: new Set(), domenii: new Set(["reclame-test.ro"]) }, "x@mail.reclame-test.ro", "mail.reclame-test.ro"), true);
  egal("un domeniu care doar se termină la fel NU cade", inbox.eBlocat(
    { adrese: new Set(), domenii: new Set(["clame-test.ro"]) }, "x@reclame-test.ro", "reclame-test.ro"), false);
  egal("altcineva nu e atins", inbox.eBlocat(
    { adrese: new Set(["a@b.ro"]), domenii: new Set(["c.ro"]) }, "x@d.ro", "d.ro"), false);

  // la sincronizare, mesajul blocat nici nu intră
  rulaj("DELETE FROM email_blocate WHERE valoare LIKE '%test-inbox%'");
  rulaj("UPDATE email_mesaje SET activ = 1 WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro')");
  rulaj("INSERT INTO email_blocate (fel, valoare, activ, pus_de) VALUES ('domeniu','reclame-test.ro',1,1)");
  mesajFals("m-blocat", {
    de_la: "Reclame SRL <oferte@mail.reclame-test.ro>", catre: "office@test-inbox.ro",
    subiect: "SUPER REDUCERI", text: "cumpara acum",
  });
  GMAIL.listate = ["m-blocat"];
  rulaj("UPDATE email_conturi SET history_id = NULL WHERE adresa = 'office@test-inbox.ro'");
  await inbox.sincronizeazaTot();
  egal("mesajul de la un expeditor blocat nici nu intră",
    Number(q("SELECT COUNT(*) AS n FROM email_mesaje WHERE gmail_id = 'm-blocat'")[0].n), 0);

  p = await cer("/email/blocate", { user: VALI });
  cere("pagina de blocați îi arată", p.corp, ["Expeditori blocați", "reclame-test.ro", "tot domeniul"]);

  // deblocarea aduce mesajele înapoi
  const idBloc = Number(q("SELECT id FROM email_blocate WHERE valoare = 'reclame-test.ro'")[0].id);
  rulaj(`UPDATE email_blocate SET mesaje_scoase = 1 WHERE id = ${idBloc}`);
  rulaj(`INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, corp, directie, activ)
         VALUES ((SELECT id FROM email_conturi WHERE adresa = 'office@test-inbox.ro'), 'm-scos', '2026-09-01',
                 'oferte@mail.reclame-test.ro', 'Reclame', 'mail.reclame-test.ro', 'scos', 'x', 'primit', 0)`);
  await cer("/email/blocate/:id/comuta", { user: VALI, metoda: "post", params: { id: String(idBloc) } });
  egal("deblocat", q(`SELECT activ FROM email_blocate WHERE id = ${idBloc}`)[0].activ, "0");
  egal("și mesajul scos s-a întors, inclusiv de pe subdomeniu",
    q("SELECT id, activ FROM email_mesaje WHERE gmail_id = 'm-scos'")[0].activ, "1");

  rulaj("DELETE FROM email_mesaje WHERE gmail_id = 'm-scos'");
  rulaj("DELETE FROM email_blocate WHERE valoare LIKE '%reclame-test%' OR valoare LIKE '%test-inbox%'");

  // --- ștergerea unei căsuțe ------------------------------------------------
  // Un buton care șterge o mie de mesaje trebuie să arate întâi o mie, nu „ești
  // sigur?". Și trebuie să lase în urmă exact ce a apucat să devină muncă —
  // taskul și comanda — fără legătură către un mesaj care nu mai e.
  console.log("\nștergerea unei căsuțe");
  rulaj("INSERT INTO email_conturi (adresa, eticheta, tip, utilizator_id) VALUES ('degreseala@test-inbox.ro','pusă greșit','comun',NULL)");
  const deSters = q("SELECT id FROM email_conturi WHERE adresa = 'degreseala@test-inbox.ro'")[0];
  rulaj(`INSERT INTO taskuri (id, titlu, tip, prioritate, status) VALUES (93401,'Răspuns la cerere','raspuns','normala','deschis') ON CONFLICT (id) DO NOTHING`);
  rulaj(`INSERT INTO comenzi (id, partener_id, status) VALUES (93501, 93001, 'ciorna') ON CONFLICT (id) DO NOTHING`);
  rulaj(
    `INSERT INTO email_mesaje (id, cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, corp, directie, partener_id, activ, task_id)
     VALUES (93601, ${deSters.id}, 'g-de-sters-1', '2026-09-15', 'cineva@firma-x.ro', 'Cineva', 'firma-x.ro', 'De șters', 'text', 'primit', 93001, 1, 93401)`
  );
  rulaj(`UPDATE comenzi SET email_mesaj_id = 93601 WHERE id = 93501`);
  rulaj(`INSERT INTO email_atasamente (mesaj_id, nume, marime, duplicat) VALUES (93601, 'de-sters.pdf', 100, 0)`);
  rulaj(`INSERT INTO email_oferte (mesaj_id, text_produs, pret, stare) VALUES (93601, 'folie test', 12.5, 'de_confirmat')`);

  p = await cer("/email/conturi", { user: VALI });
  cere("lista de căsuțe are și ștergere", p.corp, [`/email/cont/${deSters.id}/sterge`, "șterge"]);
  p = await cer("/email/conturi", { user: AGENT });
  cere("cine nu e admin nu vede ștergerea", p.corp, [], ["/sterge"]);

  p = await cer("/email/cont/:id/sterge", { user: VALI, params: { id: String(deSters.id) } });
  cere("pagina de confirmare spune ce dispare", p.corp,
    ["degreseala@test-inbox.ro", "1</strong> mesaj adus în ERP", "1</strong> rânduri de atașamente", "1</strong> oferte"], []);
  cere("și ce rămâne", p.corp, ["1 taskuri și 1 comenzi", "Nu se poate da înapoi"], []);

  p = await cer("/email/cont/:id/sterge", { user: AGENT, params: { id: String(deSters.id) } });
  egal("agentul nu ajunge la pagina de ștergere", p.locatie, "/email/conturi");

  await cer("/email/cont/:id/sterge", { user: AGENT, metoda: "post", params: { id: String(deSters.id) }, body: { da: "1" } });
  egal("agentul nu poate șterge", q(`SELECT COUNT(*) AS n FROM email_conturi WHERE id = ${deSters.id}`)[0].n, "1");
  await cer("/email/cont/:id/sterge", { user: VALI, metoda: "post", params: { id: String(deSters.id) }, body: {} });
  egal("nici adminul, fără confirmare", q(`SELECT COUNT(*) AS n FROM email_conturi WHERE id = ${deSters.id}`)[0].n, "1");

  p = await cer("/email/cont/:id/sterge", { user: VALI, metoda: "post", params: { id: String(deSters.id) }, body: { da: "1" } });
  egal("după ștergere te duce înapoi la listă", p.locatie, "/email/conturi");
  egal("căsuța nu mai e", q(`SELECT COUNT(*) AS n FROM email_conturi WHERE id = ${deSters.id}`)[0].n, "0");
  egal("mesajele ei nu mai sunt", q("SELECT COUNT(*) AS n FROM email_mesaje WHERE id = 93601")[0].n, "0");
  egal("atașamentele nu mai sunt", q("SELECT COUNT(*) AS n FROM email_atasamente WHERE mesaj_id = 93601")[0].n, "0");
  egal("ofertele culese nu mai sunt", q("SELECT COUNT(*) AS n FROM email_oferte WHERE mesaj_id = 93601")[0].n, "0");
  egal("taskul rămâne", q("SELECT COUNT(*) AS n FROM taskuri WHERE id = 93401")[0].n, "1");
  egal("comanda rămâne", q("SELECT COUNT(*) AS n FROM comenzi WHERE id = 93501")[0].n, "1");
  egal("dar fără legătură către mesajul șters",
    q("SELECT id, COALESCE(email_mesaj_id::text,'taiata') AS leg FROM comenzi WHERE id = 93501")[0].leg, "taiata");
  egal("celelalte căsuțe n-au pățit nimic",
    q("SELECT COUNT(*) AS n FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro'")[0].n, "2");

  curatenie();
  console.log(`\n${rele ? rele + " probleme" : "Totul curat."}  (${interogari} interogări SQL)\n`);
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error(e); curatenie(); process.exit(2); });
