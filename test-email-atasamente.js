"use strict";
// Trimiterea de email din ERP, cu documente din Drive.
//
// Cererea lui Vali: „oriunde văd emailuri vreau și buton de trimite email sau
// răspunde la email, după caz, care să trimită email inclusiv să atașeze
// documente din Drive-ul la care e legat ERP-ul, un folder nou acolo, oferte
// și fișe tehnice".
//
// Ce se verifică, în ordinea în care ar face rău dacă s-ar strica:
//
//   1. ATAȘAMENTUL AJUNGE ÎN MESAJ. Un email plecat fără oferta promisă arată
//      exact ca unul plecat cu ea: „trimis". Clientul află peste două zile.
//   2. NU SE POATE CERE ORICE FIȘIER. Bifele vin din browser; cine le
//      schimbă n-are voie să scoată din Drive altceva decât ce e în folderul
//      de documente — acolo sunt și atașamentele altor clienți.
//   3. RĂSPUNSUL SE COMPLETEAZĂ SINGUR: destinatar, „Re:", textul citat, și
//      căsuța în care a venit mesajul.
//   4. LIMITA DE 25 MB e prinsă în ERP, nu de Google după ce omul a așteptat
//      descărcarea a zece fișiere.
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
process.env.GOOGLE_DRIVE_FOLDER = "RADACINA-TEST";

// --- Drive fals --------------------------------------------------------------
// Fișierele din „Oferte și fișe tehnice", plus unul care NU e acolo: acela e
// capcana pentru verificarea de la punctul 2.
const DRIVE = {
  foldere: { "RADACINA-TEST/Oferte și fișe tehnice": "dosar1", "dosar1/Furnizor X": "dosar2" },
  continut: {
    dosar1: [
      { id: "f-oferta", nume: "Oferta folie 2026.pdf", mime: "application/pdf", folder: false, marime: 120000, modificat: "2026-09-01" },
      { id: "f-fisa", nume: "Fișă tehnică stretch.pdf", mime: "application/pdf", folder: false, marime: 90000, modificat: "2026-08-12" },
      { id: "dosar2", nume: "Furnizor X", mime: "application/vnd.google-apps.folder", folder: true, marime: 0, modificat: "2026-07-01" },
    ],
    dosar2: [{ id: "f-adanc", nume: "Fișă din subfolder.pdf", mime: "application/pdf", folder: false, marime: 1000, modificat: "2026-07-02" }],
    "altundeva": [{ id: "f-strain", nume: "Contract altcineva.pdf", mime: "application/pdf", folder: false, marime: 1000, modificat: "2026-01-01" }],
  },
  descarcate: [],
  marimi: {},
};

const driveFals = {
  cale: async (bucati, radacina) => {
    const cheie = [radacina, ...(Array.isArray(bucati) ? bucati : [bucati])].join("/");
    if (!DRIVE.foldere[cheie]) DRIVE.foldere[cheie] = "dosar-nou-" + Object.keys(DRIVE.foldere).length;
    return DRIVE.foldere[cheie];
  },
  listeaza: async (parinte) => DRIVE.continut[parinte] || [],
  descarca: async (id) => {
    DRIVE.descarcate.push(id);
    const marime = DRIVE.marimi[id] || 1000;
    const toate = [].concat(...Object.values(DRIVE.continut));
    const f = toate.find((x) => x.id === id) || { nume: id + ".pdf", mime: "application/pdf" };
    return { nume: f.nume, mime: f.mime, continut: Buffer.alloc(marime, 65) };
  },
  info: async () => ({ name: "x" }),
  urca: async () => ({ id: "x", nume: "x", link: "x", md5: "x", marime: 0, duplicat: false }),
  sterge: async () => {},
  linkul: (id) => "https://drive.test/" + id,
};

const orig = Module._load;
Module._load = function (req, parinte) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (req === "../lib/drive" || req === "./drive") return driveFals;
  return orig.apply(this, arguments);
};

const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const google = require(path.join(RAD, "lib", "google.js"));
google.cont = () => ({ ok: true, email: "erp@test.iam.gserviceaccount.com" });
google.folderDrive = () => "RADACINA-TEST";

// Trimiterea nu pleacă nicăieri: se prinde mesajul, cu tot cu atașamente.
const mail = require(path.join(RAD, "lib", "mail.js"));
const TRIMISE = [];
mail.trimiteDeLa = async (u, mesaj) => { TRIMISE.push(mesaj); return { prin: "gmail", expeditor: mesaj.deLa || u.email }; };
mail.configUtilizator = () => ({ expeditor: "vali@cashmachine.ro", host: "x", port: 587 });

const mod = require(path.join(RAD, "modules", "email.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, options: () => {} });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin", email: "vali@cashmachine.ro" };

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
    return rau(ce, (lipsa.length ? "lipsește „" + lipsa.join("”, „") + "”" : "") +
      (gasite.length ? (lipsa.length ? "; " : "") + "apare deși n-ar trebui „" + gasite.join("”, „") + "”" : ""));
  }
  ok(ce);
}
const cerGet = async (cale, query, user) => {
  const r = res();
  await rute.get[cale]({ user: user || VALI, params: {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
};
const cerPost = async (cale, body, user) => {
  const r = res();
  await rute.post[cale]({ user: user || VALI, params: {}, query: {}, body: body || {}, res: r, req: { url: cale } });
  return r;
};

function curatenie() {
  for (const s of [
    "DELETE FROM emailuri WHERE subiect LIKE 'ATTEST%'",
    "DELETE FROM interactiuni WHERE subiect LIKE 'ATTEST%'",
    "DELETE FROM email_mesaje WHERE gmail_id LIKE 'attest-%'",
    "DELETE FROM email_conturi WHERE adresa = 'office@attest.ro'",
    "DELETE FROM mk_contacte WHERE email LIKE '%@attestclient.ro'",
    "DELETE FROM parteneri WHERE cui = 'RO-AT-1'",
  ]) { try { exec1(s); } catch (e) {} }
}

(async () => {
console.log("Trimiterea cu documente din Drive\n");
curatenie();
exec1("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@cashmachine.ro','x','y','admin') ON CONFLICT (id) DO NOTHING");
const client = Number(q("INSERT INTO parteneri (nume, cui, tip, email) VALUES ('ATTEST CLIENT SRL','RO-AT-1','client','contact@attestclient.ro') RETURNING id")[0].id);
const cont = Number(q("INSERT INTO email_conturi (adresa, tip, activ) VALUES ('office@attest.ro','comun',1) RETURNING id")[0].id);
// ATENȚIE la textul mesajului: shim-ul de test înlocuiește FIECARE „?" din
// SQL cu următorul parametru. Un semn de întrebare în corpul emailului —
// adică exact ce scrie un client care întreabă ceva — ar fi fost luat drept
// parametru, iar rândurile ar fi ieșit amestecate fără ca nimic să crape.
// De-aia corpul se trimite ca parametru, nu scris în interogare.
const CORP_MESAJ = "Bună ziua,\nAveți folie stretch?\nMulțumesc.";
const mesaj = Number(q(
  `INSERT INTO email_mesaje (cont_id, gmail_id, data, de_la, de_la_nume, de_la_domeniu, subiect, corp, directie, partener_id, activ)
   VALUES (?, 'attest-1', '2026-09-15 10:20:00', 'ion@attestclient.ro', 'Ion Client', 'attestclient.ro',
           'Cerere de ofertă folie', ?, 'primit', ?, 1) RETURNING id`,
  [cont, CORP_MESAJ, client]
)[0].id);

// --- 1. formularul de răspuns se completează singur ------------------------
console.log("răspunsul la un email");
let p = await cerGet("/crm/email/nou", { raspunde_la: String(mesaj) });
cere("destinatarul, subiectul și citatul vin din mesaj", p.corp,
  ["ion@attestclient.ro", "Re: Cerere de ofertă folie", "&gt; Aveți folie stretch?", "Răspuns la"], []);
cere("și se vede din ce căsuță a venit", p.corp, ["office@attest.ro"], []);

// „Re:" nu se pune de două ori.
exec1(`UPDATE email_mesaje SET subiect = 'Re: deja un răspuns' WHERE id = ${mesaj}`);
p = await cerGet("/crm/email/nou", { raspunde_la: String(mesaj) });
cere("„Re:” nu se dublează", p.corp, ['value="Re: deja un răspuns"'], ["Re: Re:"]);
exec1(`UPDATE email_mesaje SET subiect = 'Cerere de ofertă folie' WHERE id = ${mesaj}`);

// --- 1b. oamenii firmei, cu funcția, ca destinatari ------------------------
// Cererea lui Vali: „la contacte pune și funcția unde o ai". Funcția era
// culeasă din semnături, dar se vedea doar în Marketing → Contacte. Aici e
// locul unde chiar folosește: alegi omul cu care vorbești, nu adresa de pe
// factură.
console.log("\noamenii firmei la trimitere");
exec1(`DELETE FROM mk_contacte WHERE partener_id = ${client}`);
q(`INSERT INTO mk_contacte (partener_id, nume, functie, email, sursa, activ) VALUES (?, 'Ion Client', 'Director Achiziții', 'ion@attestclient.ro', 'semnatura', 1) RETURNING id`, [client]);
q(`INSERT INTO mk_contacte (partener_id, nume, functie, email, sursa, activ) VALUES (?, 'Maria Fara Functie', NULL, 'maria@attestclient.ro', 'adresa', 1) RETURNING id`, [client]);
q(`INSERT INTO mk_contacte (partener_id, nume, functie, email, sursa, activ) VALUES (?, 'Fostul Angajat', 'Sef', 'fost@attestclient.ro', 'semnatura', 0) RETURNING id`, [client]);

p = await cerGet("/crm/email/nou", { partener_id: String(client) });
cere("oamenii firmei apar ca butoane, cu funcția lângă nume", p.corp,
  ["Oamenii firmei", "Ion Client", "Director Achiziții", 'data-email="ion@attestclient.ro"'], []);
cere("cine n-are funcție apare tot, fără ea", p.corp, ["Maria Fara Functie"], []);
cere("cine a fost scos din contacte nu mai apare", p.corp, [], ["Fostul Angajat"]);

// Butonul „scrie-i" de pe fișa firmei pune omul direct în „Către".
p = await cerGet("/crm/email/nou", { partener_id: String(client), catre: "ion@attestclient.ro" });
cere("adresa cerută bate adresa firmei", p.corp,
  ['name="catre" id="catre" required value="ion@attestclient.ro"'], []);

// --- 2. folderul de documente și lista lui --------------------------------
console.log("\ndocumentele din Drive");
p = await cerGet("/crm/email/nou", { partener_id: String(client) });
cere("folderul apare cu numele cerut", p.corp, ["Oferte și fișe tehnice"], []);
cere("documentele din el se pot bifa", p.corp,
  ["Oferta folie 2026.pdf", "Fișă tehnică stretch.pdf", 'name="drive" value="f-oferta"'], []);
cere("subfolderele se pot deschide", p.corp, ["📁 Furnizor X", "dosar=dosar2"], []);
cere("dar fișierele din alt folder nu apar", p.corp, [], ["Contract altcineva.pdf"]);

p = await cerGet("/crm/email/nou", { partener_id: String(client), dosar: "dosar2" });
cere("în subfolder se văd fișierele lui", p.corp, ["Fișă din subfolder.pdf", "înapoi la"], ["Oferta folie 2026.pdf"]);

// --- 3. trimiterea chiar duce fișierele -----------------------------------
console.log("\ntrimiterea");
TRIMISE.length = 0;
DRIVE.descarcate.length = 0;
await cerPost("/crm/email", {
  partener_id: String(client), catre: "contact@attestclient.ro",
  subiect: "ATTEST cu oferta", corp: "Vă atașez oferta.", drive: ["f-oferta", "f-fisa"],
});
egal("mesajul a plecat", TRIMISE.length, 1);
egal("cu două atașamente", (TRIMISE[0].atasamente || []).length, 2);
egal("cu numele lor adevărate",
  (TRIMISE[0].atasamente || []).map((a) => a.nume), ["Oferta folie 2026.pdf", "Fișă tehnică stretch.pdf"]);
egal("și cu conținut, nu goale", (TRIMISE[0].atasamente || []).every((a) => a.continut && a.continut.length > 0), true);
egal("s-au descărcat exact cele bifate", DRIVE.descarcate.slice().sort(), ["f-fisa", "f-oferta"]);
egal("emailul e scris în istoric ca trimis",
  q("SELECT status FROM emailuri WHERE subiect = 'ATTEST cu oferta'")[0].status, "trimis");

// Un fișier din subfolder tot e al nostru: are voie.
TRIMISE.length = 0;
await cerPost("/crm/email", {
  partener_id: String(client), catre: "contact@attestclient.ro",
  subiect: "ATTEST din subfolder", corp: "x", drive: "f-adanc",
});
egal("și un fișier din subfolder se poate trimite", (TRIMISE[0].atasamente || []).length, 1);

// --- 4. nu se poate cere un fișier din afara folderului -------------------
console.log("\nce nu se poate cere");
TRIMISE.length = 0;
await cerPost("/crm/email", {
  partener_id: String(client), catre: "contact@attestclient.ro",
  subiect: "ATTEST furat", corp: "x", drive: "f-strain",
});
egal("mesajul NU pleacă", TRIMISE.length, 0);
const esuat = q("SELECT status, eroare FROM emailuri WHERE subiect = 'ATTEST furat'")[0];
egal("se scrie în istoric ca eșuat", esuat.status, "esuat");
egal("cu motivul pe față", /nu e în folderul/.test(String(esuat.eroare || "")), true);

// --- 5. limita de 25 MB e prinsă aici, nu de Google -----------------------
DRIVE.marimi["f-oferta"] = 20 * 1024 * 1024;
DRIVE.marimi["f-fisa"] = 20 * 1024 * 1024;
TRIMISE.length = 0;
await cerPost("/crm/email", {
  partener_id: String(client), catre: "contact@attestclient.ro",
  subiect: "ATTEST prea mare", corp: "x", drive: ["f-oferta", "f-fisa"],
});
egal("peste 25 MB nu pleacă", TRIMISE.length, 0);
egal("și ți se spune de ce",
  /25 MB/.test(String(q("SELECT eroare FROM emailuri WHERE subiect = 'ATTEST prea mare'")[0].eroare || "")), true);
DRIVE.marimi = {};

curatenie();
console.log("\n" + interogari + " interogări SQL reale.");
console.log(rele ? rele + " probleme." : "Totul curat.");
process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); curatenie(); process.exit(1); });
