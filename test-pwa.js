"use strict";
// ERP-ul pus cu iconiță pe ecranul telefonului. Fără browser, fără bază de date.
//
// CE APĂRĂ:
//
//   • SERVICE WORKER-UL NU ARE VOIE SĂ ȚINĂ PAGINI. Un ERP arată bani, stocuri
//     și comenzi. O pagină ținută în buzunar ar arăta soldul de acum două zile,
//     cu cifre care par bune — cea mai urâtă greșeală: tăcută, și cu aer de
//     adevăr. Dacă cineva adaugă vreodată un „/comenzi" în lista de cache, aici
//     se vede.
//
//   • FIȘIERELE PROMISE EXISTĂ CU ADEVĂRAT. Manifestul și capul paginii
//     trimit la iconițe. O iconiță lipsă nu dă nicio eroare — telefonul pune
//     pur și simplu o pătrățică goală pe ecran, și nimeni nu știe de ce.
//
//   • ADRESELE DIN MANIFEST ȘI DIN CAP SUNT ACELEAȘI. Două liste scrise de
//     mână, în două fișiere, se despart la prima redenumire.
//
//   • FOAIA DE STIL ȚINUTĂ ÎN BUZUNAR ARE O VERSIUNE. Fără ridicarea ei,
//     telefoanele care au deja aplicația rămân cu stilul vechi până curăță
//     cineva datele site-ului. Nimeni nu face asta.
const fs = require("fs");
const path = require("path");
const Module = require("module");
const PUBLIC = path.join(__dirname, "public");

// lib/render cere lib/auth, care cere lib/db, care cere `pg`. Testul ăsta
// n-are treabă cu baza de date — punem un db fals în cache înainte, ca să
// poată rula oriunde, fără Postgres instalat.
{
  const abs = require.resolve("./lib/db");
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = { prepare: () => ({ get: async () => undefined, all: async () => [], run: async () => ({}) }) };
  require.cache[abs] = m;
}

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 220) : ""));
    esecuri++;
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, "manifest.webmanifest"), "utf8"));
const sw = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8");

console.log("Manifestul");
{
  bine("e JSON valid și are nume", Boolean(manifest.name && manifest.short_name));
  bine("pornește pe tot ecranul", manifest.display === "standalone", manifest.display);
  bine("acoperă tot ERP-ul", manifest.scope === "/" && manifest.start_url === "/", manifest.scope);
  bine("are iconiță de 192 și de 512",
    [192, 512].every((n) => manifest.icons.some((i) => i.sizes === `${n}x${n}`)), manifest.icons.map((i) => i.sizes));
  // Android taie iconița rotund. Fără o variantă „maskable", pune mai întâi un
  // pătrat alb în spate și abia apoi iconița — adică un pătrat alb cu un
  // dreptunghi albastru mic la mijloc.
  bine("are variantă pentru iconița tăiată rotund (Android)",
    manifest.icons.some((i) => String(i.purpose || "").indexOf("maskable") !== -1));
  bine("scurtătura de comandă nouă duce unde trebuie",
    (manifest.shortcuts || []).some((s) => s.url === "/comenzi/nou"), manifest.shortcuts);
}

console.log("\nFișierele chiar există");
{
  const cerute = new Set();
  for (const i of manifest.icons) cerute.add(i.src);
  for (const s of manifest.shortcuts || []) for (const i of s.icons || []) cerute.add(i.src);
  const lipsa = [...cerute].filter((u) => !fs.existsSync(path.join(PUBLIC, u.replace(/^\//, ""))));
  bine("toate iconițele din manifest sunt pe disc", lipsa.length === 0, lipsa);

  const dinCap = ["/favicon-32.png", "/apple-touch-icon.png", "/manifest.webmanifest", "/sw.js", "/style.css"];
  const lipsaCap = dinCap.filter((u) => !fs.existsSync(path.join(PUBLIC, u.replace(/^\//, ""))));
  bine("tot ce trimite capul paginii e pe disc", lipsaCap.length === 0, lipsaCap);

  // O iconiță de 0 octeți trece de existsSync și tot nu se vede pe telefon.
  const goale = [...cerute, ...dinCap].filter((u) => {
    const f = path.join(PUBLIC, u.replace(/^\//, ""));
    return fs.existsSync(f) && fs.statSync(f).size === 0;
  });
  bine("niciun fișier gol", goale.length === 0, goale);
}

console.log("\nCapul paginii");
{
  const { capPwa } = require("./lib/render");
  const cap = capPwa();
  bine("leagă manifestul", cap.indexOf('rel="manifest" href="/manifest.webmanifest"') !== -1);
  bine("are iconița de iPhone", cap.indexOf('rel="apple-touch-icon"') !== -1);
  bine("are culoarea barei de sus", cap.indexOf('name="theme-color"') !== -1);
  bine("înregistrează service worker-ul", cap.indexOf('register("/sw.js")') !== -1);
  bine("nu cade pe un browser fără service worker",
    cap.indexOf('"serviceWorker" in navigator') !== -1 && cap.indexOf("try {") !== -1);

  // Pagina de autentificare e PRIMA vazuta pe un telefon pe care ERP-ul nu e
  // instalat. Fara capul asta, „Adauga pe ecranul principal" salveaza o
  // scurtatura de browser, nu aplicatia.
  const auth = fs.readFileSync(path.join(__dirname, "modules", "auth.js"), "utf8");
  bine("pagina de autentificare îl are și ea", auth.indexOf("capPwa()") !== -1);
}

console.log("\nService worker-ul nu ține pagini");
{
  const m = sw.match(/const STATICE = \[([^\]]*)\]/);
  bine("lista de fișiere ținute în buzunar se poate citi", Boolean(m));
  const statice = m ? m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  bine("conține doar fișiere, nu pagini",
    statice.every((u) => /\.(css|png|svg|ico|woff2?)$/.test(u)), statice);
  bine("nicio adresă de ERP în ea",
    !statice.some((u) => /comenzi|parteneri|stocuri|facturi|productie|dashboard/.test(u)), statice);
  bine("foaia de stil e acolo (de-aia pornește instant)", statice.indexOf("/style.css") !== -1);

  bine("are o versiune de ridicat la schimbarea stilului", /const VERSIUNE = "[^"]+"/.test(sw));
  bine("șterge versiunile vechi la activare", sw.indexOf("caches.delete") !== -1);
  bine("nu se atinge de altceva decât GET", sw.indexOf('cerere.method !== "GET"') !== -1);
  bine("nu se atinge de alt server", sw.indexOf("adresa.origin !== self.location.origin") !== -1);
  // Daca ar raspunde la tot, ar trebui sa decida pentru fiecare cerere de date
  // — si acolo se strecoara raspunsul vechi.
  bine("răspunde doar la statice și la pagini întregi", sw.indexOf('cerere.mode === "navigate"') !== -1);
  bine("pagina de «fără semnal» e scrisă în el, nu cerută de la server",
    sw.indexOf("Nu am legătură cu ERP-ul") !== -1);
}

console.log("\nServerul le trimite cum trebuie");
{
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  bine("știe tipul manifestului", server.indexOf('".webmanifest"') !== -1);
  // Daca browserul ar tine sw.js in buzunar, o versiune noua n-ar mai ajunge
  // NICIODATA pe telefoanele care au deja aplicatia — exact alea care au nevoie.
  bine("nu lasă service worker-ul să fie ținut în buzunar",
    server.indexOf('cale === "/sw.js"') !== -1 && server.indexOf('"Cache-Control"') !== -1);
  bine("taie coada de după „?” înainte să caute fișierul pe disc",
    server.indexOf("new URL(req.url") !== -1);
  bine("nu iese din folderul public", server.indexOf("PUBLIC_DIR + path.sep") !== -1);
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
