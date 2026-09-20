"use strict";
// Rutele se potrivesc în ordinea înregistrării, iar „/x/:id" înghite „/x/ceva"
// dacă vine primul. Bug-ul ăsta nu se vede la citit codul unui modul: se vede
// abia când două module se ceartă pe același prefix, iar pagina cere „ceva" ca
// număr și crapă cu „invalid input syntax for type integer: NaN".
//
// S-a întâmplat de trei ori până acum — cu /productie/utilaje, cu
// /productie/retete, și cu /email/domenii și /email/culegere. De fiecare dată
// remediul a fost mutarea unui rând în server.js, adică exact genul de reparație
// care se strică singură la următorul modul adăugat.
//
// Testul ăsta ia ordinea reală din server.js, înregistrează toate modulele
// într-un router de mucava și verifică un singur lucru: nicio rută cu „:" nu
// stă înaintea unei rute fixe pe care ar înghiți-o.
const fs = require("fs");
const path = require("path");
const Module = require("module");

const RAD = __dirname;

// Modulele cer „pg" și o bază la încărcare; niciunul nu atinge baza doar ca să
// își înregistreze rutele, așa că un pool care nu face nimic e destul.
process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };

// --- ordinea reală, citită din server.js ------------------------------------
const server = fs.readFileSync(path.join(RAD, "server.js"), "utf8");
const module_e = [];
for (const l of server.split("\n")) {
  const m = l.match(/^\s*require\("\.\/modules\/([\w-]+)"\)\.register\(router\)/);
  if (m) module_e.push(m[1]);
}
if (module_e.length < 30) {
  rau("citirea ordinii din server.js", "am găsit doar " + module_e.length + " module");
  process.exit(1);
}
ok(`ordinea din server.js: ${module_e.length} module`);

// --- un router de mucava, care doar notează ---------------------------------
const rute = [];
const fals = {
  get: (p) => rute.push({ metoda: "GET", cale: p, modul: curent }),
  post: (p) => rute.push({ metoda: "POST", cale: p, modul: curent }),
  options: (p) => rute.push({ metoda: "OPTIONS", cale: p, modul: curent }),
};
let curent = "";
for (const nume of module_e) {
  curent = nume;
  try {
    require(path.join(RAD, "modules", nume + ".js")).register(fals);
  } catch (e) {
    rau("modulul " + nume + " nu se încarcă", e.message);
  }
}
ok(`s-au înregistrat ${rute.length} rute`);

// --- regula: nicio rută cu „:" nu stă înaintea uneia fixe pe care o înghite --
// Se compară exact cum compară routerul: segment cu segment, „:ceva" trece
// peste orice segment, restul trebuie să fie identice.
function inghite(sablon, cale) {
  const a = sablon.split("/");
  const b = cale.split("/");
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const fixe = rute.filter((r) => !r.cale.includes(":"));
let ciocniri = 0;
for (const f of fixe) {
  const pozitie = rute.indexOf(f);
  for (let i = 0; i < pozitie; i++) {
    const r = rute[i];
    if (r.metoda !== f.metoda || !r.cale.includes(":")) continue;
    if (!inghite(r.cale, f.cale)) continue;
    ciocniri++;
    rau(
      `${f.metoda} ${f.cale} (${f.modul}) nu se mai vede`,
      `o înghite ${r.metoda} ${r.cale} din ${r.modul}, înregistrată mai devreme — mută ${f.modul} înaintea lui ${r.modul} în server.js`
    );
  }
}
if (!ciocniri) ok(`nicio rută fixă nu e înghițită de una cu „:" (${fixe.length} rute fixe verificate)`);

// --- și niciun modul nu calcă pe ruta altuia --------------------------------
// Aceeași rută înregistrată de două ori în ACELAȘI modul e voită: așa pune
// parteneri.js și angajati.js o pagină scrisă de mână în fața listei generice
// făcute de registerCrud. Două module diferite pe aceeași rută însă nu e
// niciodată voit — unul dintre ele a rămas mort și nimeni nu știe care.
const vazute = new Map();
let duble = 0;
const acoperite = [];
for (const r of rute) {
  const cheie = r.metoda + " " + r.cale;
  const primul = vazute.get(cheie);
  if (!primul) { vazute.set(cheie, r.modul); continue; }
  if (primul === r.modul) { acoperite.push(cheie + " (" + r.modul + ")"); continue; }
  duble++;
  rau(`${cheie} e revendicată de două module`, `${primul} și ${r.modul} — a doua nu se apelează niciodată`);
}
if (!duble) ok("niciun modul nu calcă pe ruta altuia");
if (acoperite.length) console.log("  notă     pagini scrise de mână peste lista generică: " + acoperite.join(", "));

console.log(`\n${rele ? rele + " probleme." : "Totul curat."}\n`);
process.exit(rele ? 1 : 0);
