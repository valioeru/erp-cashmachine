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
    "DELETE FROM email_mesaje WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro')",
    "DELETE FROM email_conturi WHERE adresa LIKE '%@test-inbox.ro'",
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

  curatenie();
  console.log(`\n${rele ? rele + " probleme" : "Totul curat."}  (${interogari} interogări SQL)\n`);
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error(e); curatenie(); process.exit(2); });
