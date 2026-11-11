"use strict";
// „Adu AWB-urile acum" din Fulfillment → Etichete AWB. PostgreSQL real, Gmail
// și Drive false (ca în test-inbox.js).
//
// CE A CERUT VALI, 11.11.2026, după o noapte în care etichetele n-au mai
// intrat în ERP: „să le sincronizez iar dimineața, dacă nu a rulat
// sincronizarea noaptea: în Fulfillment să am buton «adu AWB-uri» și să se
// populeze manual atunci, ca să le pot imprima apoi".
//
// CE APĂRĂ:
//   • PAGINA are butonul, spune când s-a citit emailul ultima dată (ora
//     României) și arată cu roșu căsuța care nu se citește.
//   • BUTONUL citește pe loc căsuțele în care vin etichetele și spune câte
//     teancuri noi au venit; teancul apare în listă, de printat.
//   • NIMIC NOU, CĂSUȚĂ CU EROARE, CĂSUȚĂ CARE SE CITEA DEJA, EMAIL LENT:
//     fiecare cu mesajul ei, niciodată o pagină căzută.
//   • O CĂSUȚĂ SE CITEȘTE DE UN SINGUR FIR ODATĂ, dar două căsuțe diferite pot
//     fi citite una lângă alta; sincronizarea de la 5 minute ia întâi căsuțele
//     comune.
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
const GMAIL = { mesaje: new Map(), listate: [], atasamente: new Map(), cade: new Set() };
const DRIVE = { fisiere: [], foldere: [], erori: new Set() };

const gmailFals = {
  listeazaDupaCautare: async (casuta) => { if (GMAIL.asteapta) await GMAIL.asteapta(casuta); return GMAIL.listate; },
  listeazaDupaIstoric: async (casuta) => { if (GMAIL.asteapta) await GMAIL.asteapta(casuta); return { iduri: GMAIL.listate, historyId: "999", pierdut: false }; },
  profil: async (casuta) => ({ adresa: casuta, mesaje: 10, fire: 5, historyId: "999" }),
  // Un id din GMAIL.cade dă eroare (Gmail căzut); unul necunoscut nu mai există.
  mesaj: async (casuta, id) => {
    if (GMAIL.cade.has(id)) throw new Error("Gmail a răspuns 500");
    return GMAIL.mesaje.get(id);
  },
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
const FF = require(path.join(RAD, "modules", "fulfillment.js"));

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {}, options: () => {} };
FF.register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "", locatie: null };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; if (h && h.Location) o.locatie = h.Location; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin", email: "vali@cashmachine.ro" };
async function cer(metoda, cale, { user = VALI, query = {}, body = {} } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params: {}, query, body, res: r, req: { url: cale } });
  return r;
}
const mesajDin = (r) => Object.fromEntries(new URL(String(r.locatie || ""), "http://erp.test").searchParams);

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const egal = (eticheta, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(`${eticheta} = ${JSON.stringify(b)}`) : rau(eticheta, `am ${JSON.stringify(a)}, așteptam ${JSON.stringify(b)}`));
const bine = (eticheta, cond, detaliu) => (cond ? ok(eticheta) : rau(eticheta, detaliu === undefined ? "" : String(detaliu).slice(0, 300)));
const rulaj = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

const DOM = "test-adu.ro";
function curatenie() {
  for (const s of [
    `DELETE FROM ff_printari WHERE atasament_id IN (SELECT a.id FROM email_atasamente a JOIN email_mesaje m ON m.id = a.mesaj_id JOIN email_conturi c ON c.id = m.cont_id WHERE c.adresa LIKE '%@${DOM}')`,
    `DELETE FROM email_atasamente WHERE mesaj_id IN (SELECT id FROM email_mesaje WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@${DOM}'))`,
    `DELETE FROM email_mesaje WHERE cont_id IN (SELECT id FROM email_conturi WHERE adresa LIKE '%@${DOM}')`,
    `DELETE FROM email_conturi WHERE adresa LIKE '%@${DOM}'`,
    "DELETE FROM email_blocate",
  ]) {
    try { rulaj(s); } catch (e) {}
  }
}
function mesajFals(id, x) {
  GMAIL.mesaje.set(id, Object.assign({
    id, firId: "f" + id, historyId: "1", data: new Date().toISOString(),
    etichete: "INBOX", snippet: "…", de_la: "Sameday <noreply@sameday.ro>", catre: `sameday@${DOM}`, cc: "", subiect: "AWB-uri comenzi consumabile", text: "…", html: "",
    atasamente: [],
  }, x));
}
const awb = (aid) => ({ atasamente: [{ nume: "awbs.pdf", mime: "application/pdf", marime: 1000, atasamentId: aid, inline: false }] });
const cont = (adresa) => q(`SELECT * FROM email_conturi WHERE adresa = '${adresa}'`)[0];
const teancuri = () => q(`SELECT a.id FROM email_atasamente a JOIN email_mesaje m ON m.id = a.mesaj_id JOIN email_conturi c ON c.id = m.cont_id WHERE c.adresa LIKE '%@${DOM}' AND a.nume ILIKE 'awbs%.pdf' AND a.drive_id IS NOT NULL`).length;

(async () => {
  curatenie();
  const altele = Number(q("SELECT COUNT(*) AS n FROM email_conturi WHERE activ = 1")[0].n);
  if (altele) { console.log(`Baza de test are deja ${altele} căsuțe pornite; testul are nevoie să fie singur.`); process.exit(1); }
  process.env.GOOGLE_SA_JSON = JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n", project_id: "p" });
  google.reseteaza();
  rulaj(`INSERT INTO email_conturi (adresa, eticheta, tip, utilizator_id) VALUES ('office@${DOM}','birou','comun',NULL), ('sameday@${DOM}','etichete','comun',NULL), ('om@${DOM}','personala','personal',NULL)`);
  // Ordinea id-urilor: personala ÎNAINTEA celor comune, ca testul ordinii să aibă ce arăta.
  rulaj(`UPDATE email_conturi SET id = id + 100000 WHERE adresa IN ('office@${DOM}', 'sameday@${DOM}')`);

  console.log("\n1. Pagina, înainte să fi venit vreo etichetă");
  let p = await cer("get", "/fulfillment/etichete");
  bine("butonul „Adu AWB-urile acum” e pe pagină, într-un formular al lui", /<form method="post" action="\/fulfillment\/etichete\/adu"[\s\S]{0,200}<button class="btn" type="submit" id="adu-awb">Adu AWB-urile acum<\/button>/.test(p.corp));
  bine("…și spune din ce căsuțe citește: cele comune, cât n-a venit încă nicio etichetă", p.corp.includes(`office@${DOM}, sameday@${DOM}`) && !p.corp.includes(`om@${DOM}`));
  egal("căsuțele din care vin etichetele, înainte de primul awbs.pdf: cele comune", (await FF.casuteAwb()).map((c) => c.adresa), [`office@${DOM}`, `sameday@${DOM}`]);

  console.log("\n2. Butonul aduce teancurile");
  mesajFals("s1", awb("as1"));
  GMAIL.atasamente.set("as1", Buffer.from("PDF teanc 1"));
  GMAIL.listate = ["s1"];
  let r = await cer("post", "/fulfillment/etichete/adu");
  egal("se întoarce pe pagină, cu ce a venit", [String(r.locatie).split("?")[0], mesajDin(r).ok], ["/fulfillment/etichete", "A venit un teanc nou de etichete."]);
  // Același email ajunge în două căsuțe: e un singur fișier în Drive, deci un singur teanc.
  egal("același email din două căsuțe = un singur teanc în listă", [teancuri(), new Set(q(`SELECT a.drive_id FROM email_atasamente a JOIN email_mesaje m ON m.id = a.mesaj_id JOIN email_conturi c ON c.id = m.cont_id WHERE c.adresa LIKE '%@${DOM}'`).map((x) => x.drive_id)).size], [2, 1]);
  p = await cer("get", "/fulfillment/etichete", { query: mesajDin(r) });
  bine("teancul e în listă, neprintat, cu butonul lui", p.corp.includes("A venit un teanc nou de etichete.") && />awbs\.pdf<\/a>/.test(p.corp) && p.corp.includes("neprintat") && /data-print="\d+"/.test(p.corp));
  egal("de acum, căsuțele cu etichete sunt cele care au primit una — cea cu mai puține mesaje întâi", (await FF.casuteAwb()).map((c) => c.adresa).sort(), [`office@${DOM}`, `sameday@${DOM}`]);
  bine("pagina spune când s-a citit emailul, cu ora României", new RegExp(`ultima dată la <strong>${FF.oraRo(cont(`sameday@${DOM}`).ultima_sincronizare)}</strong>`).test(p.corp), FF.oraRo(cont(`sameday@${DOM}`).ultima_sincronizare));
  egal("ora României dintr-un timp ținut în UTC (iarnă +2, vară +3)", [FF.oraRo("2026-11-11 07:24:48"), FF.oraRo("2026-07-01 21:30:00"), FF.oraRo(""), FF.oraRo(null)], ["09:24", "00:30", "", ""]);

  mesajFals("s2", awb("as2"));
  mesajFals("s3", awb("as3"));
  GMAIL.atasamente.set("as2", Buffer.from("PDF teanc 2"));
  GMAIL.atasamente.set("as3", Buffer.from("PDF teanc 3"));
  GMAIL.listate = ["s1", "s2", "s3"];
  r = await cer("post", "/fulfillment/etichete/adu");
  egal("două teancuri noi: le numără", mesajDin(r).ok, "Au venit 2 teancuri noi de etichete.");

  console.log("\n3. Nimic nou");
  r = await cer("post", "/fulfillment/etichete/adu");
  bine("spune că a citit și că n-a venit nimic, cu data ultimului teanc", /^Am citit emailul: nu a venit niciun teanc nou\. Ultimul e din \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\.$/.test(mesajDin(r).ok || ""), JSON.stringify(mesajDin(r)));
  egal("…și nu dublează nimic", teancuri(), 6);

  console.log("\n4. O căsuță care nu se citește");
  GMAIL.cade.add("s4");
  mesajFals("s4", awb("as4"));
  mesajFals("s5", awb("as5"));
  GMAIL.atasamente.set("as5", Buffer.from("PDF teanc 5"));
  GMAIL.listate = ["s4", "s5"];
  r = await cer("post", "/fulfillment/etichete/adu");
  bine("teancul de după mesajul căzut tot vine, iar eroarea se spune", /^A venit un teanc nou de etichete\. (office|sameday)@test-adu\.ro nu s-a citit: 1 mesaj nu s-a putut salva/.test(mesajDin(r).eroare || ""), JSON.stringify(mesajDin(r)));
  p = await cer("get", "/fulfillment/etichete");
  bine("pagina arată cu roșu căsuța care nu se citește, cu motivul", new RegExp(`<strong>sameday@${DOM} nu se citește:</strong> 1 mesaj nu s-a putut salva`).test(p.corp) && p.corp.includes("border-left:4px solid var(--danger)") && p.corp.includes("etichetele noi din căsuța ei nu ajung aici"));
  GMAIL.cade.clear();
  GMAIL.atasamente.set("as4", Buffer.from("PDF teanc 4"));
  r = await cer("post", "/fulfillment/etichete/adu");
  egal("după ce trece, vine și teancul rămas", mesajDin(r).ok, "A venit un teanc nou de etichete.");
  p = await cer("get", "/fulfillment/etichete");
  bine("…și roșul dispare de pe pagină", !p.corp.includes("nu se citește:") && !/class="card" style="[^"]*var\(--danger\)/.test(p.corp));

  console.log("\n5. O căsuță se citește de un singur fir odată");
  // Gmail ține în loc citirea căsuței sameday@ până îi dăm drumul.
  let daDrumul;
  const poarta = new Promise((ok2) => { daDrumul = ok2; });
  const listeazaBun = gmailFals.listeazaDupaIstoric;
  GMAIL.asteapta = async (casuta) => { if (casuta === `sameday@${DOM}`) await poarta; };
  mesajFals("s6", awb("as6"));
  GMAIL.atasamente.set("as6", Buffer.from("PDF teanc 6"));
  GMAIL.listate = ["s6"];
  const primul = inbox.sincronizeazaCont(cont(`sameday@${DOM}`));
  await new Promise((r2) => setTimeout(r2, 50));
  const alDoilea = await inbox.sincronizeazaCont(cont(`sameday@${DOM}`));
  egal("a doua citire a aceleiași căsuțe, pornită cât prima e în lucru: nu face nimic", [alDoilea.ocupat, alDoilea.noi, alDoilea.eroare], [true, 0, null]);
  const alta = await inbox.sincronizeazaCont(cont(`office@${DOM}`));
  egal("…dar altă căsuță se citește în același timp", [Boolean(alta.ocupat), alta.noi], [false, 1]);
  // Butonul, cât sameday@ e încă în lucru: office@ e la zi, sameday@ ocupată.
  r = await cer("post", "/fulfillment/etichete/adu");
  bine("butonul apăsat acum nu se încurcă: spune ce a găsit", Boolean(mesajDin(r).ok) && !mesajDin(r).eroare, JSON.stringify(mesajDin(r)));
  daDrumul();
  const rezPrimul = await primul;
  egal("prima citire se termină cu bine", [rezPrimul.eroare, Boolean(rezPrimul.ocupat)], [null, false]);
  GMAIL.asteapta = null;
  const dupa = await inbox.sincronizeazaCont(cont(`sameday@${DOM}`));
  egal("…iar după ea căsuța se poate citi din nou", [Boolean(dupa.ocupat), dupa.eroare], [false, null]);
  void listeazaBun;

  // Toate căsuțele cu etichete se citeau deja: butonul o spune.
  let daDrumul2;
  const poarta2 = new Promise((ok2) => { daDrumul2 = ok2; });
  GMAIL.asteapta = async () => { await poarta2; };
  const inMers = [inbox.sincronizeazaCont(cont(`sameday@${DOM}`)), inbox.sincronizeazaCont(cont(`office@${DOM}`))];
  await new Promise((r2) => setTimeout(r2, 50));
  r = await cer("post", "/fulfillment/etichete/adu");
  egal("toate se citeau deja: mesajul spune să reîncarci", mesajDin(r).ok, "Emailul se citea deja chiar acum. Reîncarcă pagina peste un minut.");
  daDrumul2();
  await Promise.all(inMers);
  GMAIL.asteapta = null;

  console.log("\n6. Sincronizarea de la 5 minute: căsuțele comune întâi");
  const ordine = [];
  GMAIL.asteapta = async (casuta) => { ordine.push(casuta); };
  await inbox.sincronizeazaTot();
  GMAIL.asteapta = null;
  egal("comunele înaintea celei personale, deși aceea are id-ul mai mic", ordine, [`office@${DOM}`, `sameday@${DOM}`, `om@${DOM}`]);

  console.log("\n7. Fără cont și fără căsuțe");
  r = await cer("post", "/fulfillment/etichete/adu", { user: null });
  egal("fără cont: afară", r.locatie, "/");
  rulaj(`UPDATE email_conturi SET activ = 0 WHERE adresa LIKE '%@${DOM}'`);
  r = await cer("post", "/fulfillment/etichete/adu");
  bine("nicio căsuță pornită: spune unde se pornesc", /Nu e nicio căsuță de email pornită/.test(mesajDin(r).eroare || ""), JSON.stringify(mesajDin(r)));
  p = await cer("get", "/fulfillment/etichete");
  bine("…și pagina la fel, cu legătura spre Căsuțe", p.corp.includes('Nu e nicio căsuță de email pornită din care să vină etichete') && p.corp.includes('href="/email/conturi"'));

  curatenie();
  console.log(rele ? `\n${rele} probleme` : "\nToate verificările trec.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curatenie(); } catch (_) {}
  process.exit(1);
});
