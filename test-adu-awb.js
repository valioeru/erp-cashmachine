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
//   • TIPĂRIREA (Vali, 11.11.2026: „se deschide fereastra de print, însă nu
//     imprimă"; apoi: „merge foarte rău, a doua, a treia oară printează, și
//     doar dacă în fereastra de print apăs eu butonul. Ori lași fereastra
//     deschisă și apăsăm print, ori fă-l să meargă"). Greșeala era a paginii:
//     la un PDF print() se întoarce pe loc, iar pagina trecea teancul ca
//     printat și se reîncărca la 1,2 secunde, închizând fereastra de tipărire.
//     Acum teancul se deschide la vedere, în cadrul lui; nimic nu se notează
//     și pagina nu se reîncarcă până nu spune omul „Am printat"; cadrul din
//     care s-a tipărit rămâne în pagină; rândul se schimbă pe loc. Mai multe
//     teancuri merg unul câte unul, cu „Oprește aici". Automatul așteaptă
//     între teancuri și reîncarcă lista doar în liniște.
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
  // Teancurile vin imediat după miezul nopții: în UTC ar purta ziua de ieri.
  egal("ziua și ora României ale unui teanc: cel de la 00:15 e de azi, nu de ieri de la 22:15", [FF.ziOraRo("2026-11-10 22:15:09"), FF.ziOraRo("2026-07-01T21:30:00.000Z"), FF.ziOraRo("2026-11-11 10:05:00"), FF.ziOraRo(""), FF.ziOraRo(null)], [{ zi: "2026-11-11", ora: "00:15" }, { zi: "2026-07-02", ora: "00:30" }, { zi: "2026-11-11", ora: "12:05" }, { zi: "", ora: "" }, { zi: "", ora: "" }]);

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

  console.log("\n7. În browser: tipărirea");
  {
    // Destule teancuri ca fiecare probă să aibă rândul ei.
    for (let i = 4; i <= 9; i++) { mesajFals("s" + i, awb("as" + i)); GMAIL.atasamente.set("as" + i, Buffer.from("PDF teanc " + i)); }
    // Unul venit ieri la 22:15 UTC, adică după miezul nopții la noi.
    const noaptea = new Date(); noaptea.setUTCDate(noaptea.getUTCDate() - 1); noaptea.setUTCHours(22, 15, 0, 0);
    GMAIL.mesaje.get("s9").data = noaptea.toISOString();
    GMAIL.listate = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    await cer("post", "/fulfillment/etichete/adu");
    const pagina = (await cer("get", "/fulfillment/etichete")).corp;
    {
      const ro = noaptea.toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }); // „2026-11-11 00:15:00"
      const scris = `${ro.slice(8, 10)}.${ro.slice(5, 7)}.${ro.slice(0, 4)} ${ro.slice(11, 16)}`;
      bine("teancul venit noaptea apare cu ziua și ora României: " + scris, pagina.includes(`data-zi="${scris}"`) && pagina.includes(`<strong>${scris.slice(0, 10)}</strong> <span style="color:var(--text-muted)">${scris.slice(11)}</span>`), (pagina.match(/data-zi="[^"]*"/g) || []).join(" "));
    }
    const fs = require("fs");
    // Pentru proba într-un Chrome adevărat, cu PDF adevărat (stubul de mai jos
    // nu poate arăta fereastra de tipărire): SALVEAZA_PAGINA=/cale/pagina.html
    if (process.env.SALVEAZA_PAGINA) fs.writeFileSync(process.env.SALVEAZA_PAGINA, pagina);
    const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    const pdf = (id) => `/fulfillment/etichete/${id}/pdf`;
    try {
      const deschide = async (agent, { noi = [], pauza = 0, reincarca = 0 } = {}) => {
        const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: agent });
        // print() nu are ce tipări într-un browser fără imprimantă: îl înlocuim
        // în fiecare cadru și ținem minte din ce cadru a fost cerut și când.
        // Ca și cel adevărat la un PDF, se întoarce pe loc.
        await ctxB.addInitScript(() => {
          window.print = function () { try { window.top.__printari = (window.top.__printari || []).concat([{ u: location.pathname + location.hash, t: Date.now() }]); } catch (e) {} };
        });
        const pg = await ctxB.newPage();
        const st = { trimise: [], erori: [], incarcari: 0, notate: new Set(), cade: new Set() };
        pg.on("pageerror", (e) => st.erori.push(String(e.message || e)));
        pg.on("framenavigated", (f) => { if (f === pg.mainFrame()) st.incarcari++; });
        let corp = pagina;
        if (pauza) corp = corp.replace('data-pauza-automat="30000"', `data-pauza-automat="${pauza}"`);
        if (reincarca) corp = corp.replace('data-reincarca-dupa="180000"', `data-reincarca-dupa="${reincarca}"`);
        if ((pauza || reincarca) && corp === pagina) throw new Error("pagina nu mai are atributele de pauză");
        await pg.route("http://erp.test/**", async (rt) => {
          const rq = rt.request();
          const u = new URL(rq.url());
          if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
          if (/\/etichete\/\d+\/pdf$/.test(u.pathname)) return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>teanc</body></html>" });
          if (/\/etichete\/\d+\/printat$/.test(u.pathname)) {
            const id = u.pathname.match(/\/(\d+)\/printat$/)[1];
            const b = JSON.parse(rq.postData() || "{}");
            st.trimise.push(Object.assign({ id }, b));
            if (st.cade.has(id)) return rt.fulfill({ status: 500, contentType: "text/plain", body: "căzut" });
            if (!b.eroare) st.notate.add(id);
            return rt.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: !b.eroare }) });
          }
          if (u.pathname.endsWith("/noi.json")) {
            return rt.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fisiere: noi.filter((id) => !st.notate.has(id)).map((id) => ({ id, nume: "awbs.pdf", zi: "2026-11-11" })) }) });
          }
          return rt.fulfill({ status: 200, contentType: "text/html", body: corp });
        });
        await pg.goto("http://erp.test/fulfillment/etichete");
        return Object.assign(st, { ctxB, pg });
      };
      const stare = (pg) => pg.evaluate(() => {
        const cadre = [].slice.call(document.querySelectorAll("iframe.cadru-teanc"));
        const sursa = (c) => (c.getAttribute("src") || "").replace(location.origin, "");
        const seVede = (c) => { const r = c.getBoundingClientRect(); return r.width > 50 && r.height > 50 && r.left >= 0 && getComputedStyle(c).visibility === "visible"; };
        return {
          laVedere: getComputedStyle(document.getElementById("tipar-vazut")).visibility === "visible",
          titlu: document.getElementById("tipar-vazut-titlu").textContent,
          stop: getComputedStyle(document.getElementById("tipar-vazut-stop")).display !== "none",
          cadre: cadre.map(sursa),
          cadreLaVedere: cadre.filter(seVede).map(sursa),
          printari: (window.__printari || []).map((x) => x.u),
          timpi: (window.__printari || []).map((x) => x.t),
          neprintate: Number((document.getElementById("cate-neprintate").textContent.match(/\d+/) || [0])[0]),
          rezultat: document.getElementById("rezultat-tipar").textContent,
          auto: { bifat: document.getElementById("auto").checked, oprit: document.getElementById("auto").disabled, text: document.getElementById("stare-auto").textContent },
        };
      });
      const rand = (pg, id) => pg.evaluate((id) => {
        const b = document.querySelector('.bif-teanc[data-id="' + id + '"]');
        const r = b.closest("tr");
        const buton = r.querySelector("[data-print]");
        return { printat: b.getAttribute("data-printat"), bifat: b.checked, stare: r.querySelector(".stare-teanc").textContent.trim(), buton: buton.textContent, oprit: buton.disabled };
      }, id);
      const butonAlese = (pg) => pg.$eval("#printeaza-alese", (b) => [b.textContent, b.disabled]);
      const panaLa = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return cond(); };
      const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
      const EDGE = CHROME + " Edg/141.0.0.0";

      // --- un teanc, cu butonul de pe rând ---------------------------------
      const c = await deschide(CHROME);
      const iduri = await c.pg.$$eval("[data-print]", (bs) => bs.map((b) => b.getAttribute("data-print")));
      bine("sunt destule teancuri pentru probă", iduri.length >= 9, iduri.length);
      const [t1, t2, t3, t4, t5, t6] = iduri;
      let s = await stare(c.pg);
      const laInceput = s.neprintate;
      egal("la deschidere: fereastra de tipărit e ascunsă și nu există niciun cadru", [s.laVedere, s.cadre, laInceput >= 9], [false, [], true]);
      await c.pg.click(`[data-print="${t1}"]`);
      await c.pg.waitForTimeout(500);
      s = await stare(c.pg);
      egal("„Printează”: teancul se deschide la vedere, în cadrul lui", [s.laVedere, s.cadreLaVedere, s.stop, /^Teancul de etichete · din \d{2}\.\d{2}\.\d{4}/.test(s.titlu)], [true, [pdf(t1)], false, true]);
      egal("…fără ca tipărirea să fie cerută înainte să apară PDF-ul", s.printari, []);
      await c.pg.waitForTimeout(1200);
      s = await stare(c.pg);
      egal("…apoi e cerută o singură dată, din cadrul la vedere", s.printari, [pdf(t1)]);
      // AICI ERA GREȘEALA (Vali, 11.11.2026): pagina trecea teancul ca printat
      // și se reîncărca la 1,2 secunde, iar reîncărcarea închidea fereastra de
      // tipărire înainte ca omul să apese Print.
      await c.pg.waitForTimeout(3500);
      s = await stare(c.pg);
      egal("după încă 3,5 secunde: nimic notat, pagina nereîncărcată, teancul tot pe ecran, tipărirea cerută o dată", [c.trimise, c.incarcari, s.laVedere, s.cadreLaVedere, s.printari.length], [[], 1, true, [pdf(t1)], 1]);
      await c.pg.click("#tipar-vazut-iar");
      egal("„Deschide iar fereastra de tipărire” o cere din nou, din același cadru", (await stare(c.pg)).printari, [pdf(t1), pdf(t1)]);
      await c.pg.click("#tipar-vazut-da");
      await c.pg.waitForTimeout(400);
      egal("„Am printat”: abia acum se scrie că a ieșit, fără eroare", c.trimise, [{ id: t1, automat: 0, eroare: "" }]);
      s = await stare(c.pg);
      egal("…fereastra se închide, dar cadrul din care s-a tipărit rămâne în pagină, cu PDF-ul lui", [s.laVedere, s.cadre, s.cadreLaVedere], [false, [pdf(t1)], []]);
      egal("…rândul se schimbă pe loc", await rand(c.pg, t1), { printat: "1", bifat: false, stare: "printat acum", buton: "Printează din nou", oprit: false });
      egal("…și numărul de teancuri neprintate scade cu unu", s.neprintate, laInceput - 1);
      await c.pg.waitForTimeout(2500);
      egal("…iar pagina nu se reîncarcă nici după aceea", c.incarcari, 1);

      await c.pg.click(`[data-print="${t2}"]`);
      await c.pg.waitForTimeout(300);
      await c.pg.click("#tipar-vazut-nu");
      await c.pg.waitForTimeout(400);
      egal("„Nu l-am printat”: teancul nu e trecut ca printat, iar motivul se scrie", c.trimise.slice(1), [{ id: t2, automat: 0, eroare: "nu a fost printat" }]);
      egal("…rândul rămâne neprintat, butonul spune că n-a mers și se poate apăsa din nou", await rand(c.pg, t2), { printat: "0", bifat: false, stare: "neprintat", buton: "N-a mers", oprit: false });
      await c.pg.waitForTimeout(1400);
      egal("…și tipărirea nu mai e cerută după ce fereastra s-a închis", (await stare(c.pg)).printari, [pdf(t1), pdf(t1)]);

      // --- mai multe teancuri bifate ---------------------------------------
      for (const id of [t3, t4, t5]) await c.pg.check(`.bif-teanc[data-id="${id}"]`);
      egal("trei bifate: butonul le numără", await butonAlese(c.pg), ["Printează acum cele 3 teancuri", false]);
      await c.pg.click("#printeaza-alese");
      await c.pg.waitForTimeout(300);
      s = await stare(c.pg);
      egal("mai multe: primul la vedere, cu numărul lui și cu „Oprește aici”", [s.laVedere, s.cadreLaVedere, /^Teancul 1 din 3 · din /.test(s.titlu), s.stop], [true, [pdf(t3)], true, true]);
      await c.pg.click("#tipar-vazut-da");
      await c.pg.waitForTimeout(500);
      s = await stare(c.pg);
      egal("…al doilea se deschide abia după „Am printat” la primul, în alt cadru", [s.laVedere, s.cadreLaVedere, /^Teancul 2 din 3 · din /.test(s.titlu), s.cadre], [true, [pdf(t4)], true, [pdf(t1), pdf(t2), pdf(t3), pdf(t4)]]);
      await c.pg.click("#tipar-vazut-stop");
      await c.pg.waitForTimeout(500);
      s = await stare(c.pg);
      egal("„Oprește aici”: al doilea nu e trecut ca printat, iar al treilea nici nu se deschide", [c.trimise.slice(2), s.laVedere, s.cadre.length], [[{ id: t3, automat: 0, eroare: "" }, { id: t4, automat: 0, eroare: "nu a fost printat" }], false, 4]);
      egal("…spune câte au ieșit, iar cele rămase sunt tot bifate", [s.rezultat, (await rand(c.pg, t3)).bifat, (await rand(c.pg, t4)).bifat, (await rand(c.pg, t5)).bifat], ["Au ieșit 1 din 3. Cele rămase sunt tot bifate.", false, true, true]);
      egal("…și butonul numără ce a rămas", await butonAlese(c.pg), ["Printează acum cele 2 teancuri", false]);
      await c.pg.click("#printeaza-alese");
      await c.pg.waitForTimeout(300);
      await c.pg.click("#tipar-vazut-da");
      await c.pg.waitForTimeout(500);
      s = await stare(c.pg);
      egal("ultimul din rând nu mai are „Oprește aici”", [/^Teancul 2 din 2 · din /.test(s.titlu), s.stop, s.cadreLaVedere], [true, false, [pdf(t5)]]);
      await c.pg.click("#tipar-vazut-da");
      await c.pg.waitForTimeout(500);
      s = await stare(c.pg);
      egal("toate ieșite: o spune și închide fereastra", [s.rezultat, s.laVedere, s.neprintate], ["Gata, toate cele 2 teancuri au ieșit.", false, laInceput - 4]);

      // --- ERP-ul nu poate nota --------------------------------------------
      c.cade.add(t6);
      await c.pg.click(`[data-print="${t6}"]`);
      await c.pg.waitForTimeout(300);
      await c.pg.click("#tipar-vazut-da");
      await panaLa(() => c.trimise.filter((x) => x.id === t6).length >= 3, 6000);
      await c.pg.waitForTimeout(600);
      egal("ERP-ul nu poate nota: încearcă de trei ori", c.trimise.filter((x) => x.id === t6).length, 3);
      egal("…și spune că a ieșit, dar nu e notat — nu că n-a mers, ca să nu fie scos a doua oară", [(await rand(c.pg, t6)).buton, (await rand(c.pg, t6)).oprit, (await rand(c.pg, t6)).printat, (await stare(c.pg)).rezultat], ["Printat, dar nenotat", true, "0", "Etichetele au ieșit, dar ERP-ul n-a putut nota asta. Verifică internetul și reîncarcă pagina; nu scoate teancul a doua oară."]);
      egal("de la un capăt la altul: pagina nu s-a reîncărcat niciodată și n-a dat nicio eroare de JavaScript", [c.incarcari, c.erori], [1, []]);
      await c.ctxB.close();

      // --- „printează singur" ----------------------------------------------
      const a = await deschide(CHROME, { noi: [t1, t2], pauza: 600, reincarca: 3000 });
      egal("Chrome: „printează singur” rămâne la îndemână", [(await stare(a.pg)).auto.oprit, (await stare(a.pg)).auto.text], [false, ""]);
      await a.pg.evaluate(() => { try { localStorage.setItem("ff-print-auto", "1"); } catch (x) {} });
      await a.pg.reload();
      await panaLa(() => a.trimise.length >= 2, 8000);
      s = await stare(a.pg);
      egal("automatul: fiecare teanc din cadrul lui ascuns, nimic la vedere", [s.printari, s.cadre, s.cadreLaVedere, s.laVedere], [[pdf(t1) + "#toolbar=0", pdf(t2) + "#toolbar=0"], [pdf(t1) + "#toolbar=0", pdf(t2) + "#toolbar=0"], [], false]);
      bine("…al doilea teanc nu intră peste primul: așteaptă pauza dintre ele", s.timpi[1] - s.timpi[0] >= 600, s.timpi[1] - s.timpi[0]);
      egal("…le trece ca printate automat", a.trimise, [{ id: t1, automat: 1, eroare: "" }, { id: t2, automat: 1, eroare: "" }]);
      bine("…și spune câte a trimis", /^Am trimis la imprimantă 2 din 2 la /.test(s.auto.text), s.auto.text);
      egal("…fără să reîncarce pagina imediat după", a.incarcari, 2);
      bine("…o reîncarcă abia după câteva minute de liniște (aici, 3 secunde)", await panaLa(() => a.incarcari === 3, 7000), a.incarcari);
      egal("automatul: nicio eroare de JavaScript", a.erori, []);
      await a.ctxB.close();

      // Reîncărcarea de după automat nu are voie să cadă peste un teanc
      // deschis de om și nici imediat după ce omul a apăsat „Am printat".
      const m = await deschide(CHROME, { noi: [t3], pauza: 300, reincarca: 2500 });
      await m.pg.evaluate(() => { try { localStorage.setItem("ff-print-auto", "1"); } catch (x) {} });
      await m.pg.reload();
      await panaLa(() => m.trimise.length >= 1, 8000);
      await m.pg.click(`[data-print="${t4}"]`);
      await m.pg.waitForTimeout(5500);
      s = await stare(m.pg);
      egal("cu un teanc deschis de om, lista nu se reîncarcă, oricât ar trece", [m.incarcari, s.laVedere, s.cadreLaVedere], [2, true, [pdf(t4)]]);
      await m.pg.click("#tipar-vazut-da");
      await m.pg.waitForTimeout(1200);
      egal("…și nici imediat după „Am printat”", [m.incarcari, m.trimise.slice(1)], [2, [{ id: t4, automat: 0, eroare: "" }]]);
      bine("…ci abia după ce s-a făcut liniște", await panaLa(() => m.incarcari === 3, 9000), m.incarcari);
      await m.ctxB.close();

      // --- Edge -------------------------------------------------------------
      const e = await deschide(EDGE);
      await e.pg.evaluate(() => { try { localStorage.setItem("ff-print-auto", "1"); } catch (x) {} });
      await e.pg.reload();
      s = await stare(e.pg);
      egal("Edge: „printează singur” e oprit, chiar dacă fusese bifat pe calculatorul ăsta", [s.auto.bifat, s.auto.oprit, /În Edge n-a fost încercată/.test(s.auto.text)], [false, true, true]);
      await e.pg.click(`[data-print="${t1}"]`);
      await e.pg.waitForTimeout(1700);
      s = await stare(e.pg);
      egal("Edge: cu butonul se tipărește la fel, la vedere", [s.laVedere, s.cadreLaVedere, s.printari, e.trimise], [true, [pdf(t1)], [pdf(t1)], []]);
      await e.pg.click("#tipar-vazut-da");
      await e.pg.waitForTimeout(400);
      egal("…și „Am printat” îl notează", [e.trimise, (await stare(e.pg)).laVedere, e.erori], [[{ id: t1, automat: 0, eroare: "" }], false, []]);
      await e.ctxB.close();
    } finally {
      await browser.close();
    }
  }

  console.log("\n8. Fără cont și fără căsuțe");
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
