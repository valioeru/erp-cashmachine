"use strict";
// Navigația: pagina există, dar nu duce niciun buton la ea.
//
// E al patrulea caz din aplicație, nu primul. Comentariile din lib/render.js
// păstrează celelalte trei: /dezvoltare avea dreptul dat tuturor și intrarea
// doar sub Management, /comenzi era atârnat de /crm și nu se vedea de la
// depozit, iar /parteneri dădea „nu ai acces" exact agenților. Acum /rfq:
// agentul SCRIE cererile de preț, are dreptul pe rută, dar lucrează în
// Vânzări — iar în subnavigația Vânzări linkul nu exista. Trebuia să iasă din
// zona lui ca să-l găsească, deci nu-l găsea.
//
// CE APĂRĂ testul, în ordinea în care doare:
//
//   • CEREREA DE PREȚ E LA ÎNDEMÂNA AGENTULUI. În Vânzări (acolo îi cere
//     clientul produsul) și în Comenzi (acolo descoperă că linia n-are ce
//     selecta). Dacă linkul dispare din oricare, agentul nu mai are de unde
//     porni o cerere și fluxul moare în tăcere — pagina rămâne funcțională,
//     doar că nu intră nimeni pe ea.
//
//   • NICIUN LINK NU E O CAPCANĂ. Orice link afișat într-o subnavigație
//     trebuie să se deschidă pentru omul căruia i se arată. Un link care dă
//     403 nu e navigație.
//
//   • CINE N-ARE TREABĂ NU VEDE. Producția și financiarul nu au /rfq în
//     drepturi, deci nu trebuie să primească linkul.
//
// Nu atinge baza de date: subnavigațiile sunt funcții pure peste drepturi.
const Module = require("module");

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};

const R = require("./lib/render.js");
const { poateAccesa } = require("./lib/auth.js");

let esecuri = 0;
function verifica(descriere, conditie) {
  if (conditie) console.log("  OK    " + descriere);
  else { console.log("  EȘEC  " + descriere); esecuri++; }
}

// Un rol fără „sectiuni" bifate cade pe împărțirea veche din ACCES_ROL —
// exact cazul oamenilor din firmă azi.
const om = (rol) => ({ id: 1, nume: "Test", rol, sectiuni: null });

// Linkurile dintr-o bucată de HTML de subnavigație, ca perechi href/text.
function linkuri(html) {
  const out = [];
  const re = /<a href="([^"]+)" class="subnav-link[^"]*">([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html))) out.push([m[1], m[2]]);
  return out;
}

const BARE = [
  ["Vânzări", R.subnavCrm, "/crm"],
  ["Comenzi", R.subnavComenzi, "/comenzi"],
  ["Depozit", R.subnavDepozit, "/depozit"],
  ["Procurement", R.subnavProcurement, "/procurement"],
  ["Financiar", R.subnavFinanciar, "/financiar"],
  ["Producție", R.subnavProductie, "/productie"],
];
const ROLURI = ["admin", "vanzari", "depozit", "financiar", "productie"];

console.log("\n1. Agentul ajunge la cererea de preț de unde lucrează");
{
  const u = om("vanzari");
  const inVanzari = linkuri(R.subnavCrm("/crm", u)).some(([h]) => h === "/rfq");
  const inComenzi = linkuri(R.subnavComenzi("/comenzi", u)).some(([h]) => h === "/rfq");
  verifica("agentul vede „Cereri de preț” în subnavigația Vânzări", inVanzari);
  verifica("agentul vede „Cereri de preț” în subnavigația Comenzi", inComenzi);
}

console.log("\n2. Achizițiile o au și ele — ele o rezolvă");
{
  const u = om("depozit");
  const inProcurement = linkuri(R.subnavProcurement("/procurement", u)).some(([h]) => h === "/rfq");
  verifica("achizițiile văd „Cereri de preț” în Procurement", inProcurement);
}

console.log("\n3. Cine n-are dreptul nu primește linkul");
for (const rol of ["financiar", "productie"]) {
  const u = om(rol);
  const apare = BARE.some(([, fn]) => linkuri(fn("/x", u)).some(([h]) => h === "/rfq"));
  verifica(rol + " nu vede „Cereri de preț” nicăieri", !apare);
}

console.log("\n4. Niciun link afișat nu duce la 403");
for (const rol of ROLURI) {
  const u = om(rol);
  const capcane = [];
  for (const [nume, fn] of BARE) {
    for (const [href, text] of linkuri(fn("/x", u))) {
      if (!poateAccesa(u, href)) capcane.push(nume + " → " + text + " (" + href + ")");
    }
  }
  verifica(rol + ": toate linkurile din subnavigații se deschid", capcane.length === 0);
  for (const c of capcane) console.log("          capcană: " + c);
}

console.log("\n5. Locul din meniu: te uiți în nomenclator, nu-l găsești, ceri prețul");
{
  const l = linkuri(R.subnavCrm("/crm", om("vanzari"))).map(([h]) => h);
  const iProduse = l.indexOf("/produse");
  const iRfq = l.indexOf("/rfq");
  const iCalc = l.indexOf("/calculator");
  verifica(
    "în Vânzări: Produse → Cereri de preț → Calculator preț",
    iProduse >= 0 && iRfq === iProduse + 1 && iCalc === iRfq + 1
  );
}

console.log(esecuri ? "\n" + esecuri + " EȘEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
