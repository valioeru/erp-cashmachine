"use strict";
// Importul din Monday CRM: potrivirea firmelor și regula „doar golurile".
//
// CE APĂRĂ:
//
//   • POTRIVIREA FIRMELOR. „S.C. AQUILA B.V." și „Aquila BV" sunt aceeași
//     firmă. Fără normalizare ar intra de două ori în parteneri, iar de
//     acolo încolo jumătate din facturi ar sta pe un rând și jumătate pe
//     celălalt. Prima variantă a regexului nu prindea punctele din forma
//     juridică, deci exact perechea asta scăpa.
//
//   • FORMA JURIDICĂ SE TAIE DOAR DE LA COADĂ. „if", „ii", „sa" sunt bucăți
//     de cuvinte obișnuite — „Ifantis", „Iisus", „Casa". Căutate oriunde în
//     nume, ar ciopârți firme care n-au nicio treabă cu ele.
//
//   • SE COMPLETEAZĂ GOLURILE, NU SE SUPRASCRIE. Regula lui Vali, cuvânt cu
//     cuvânt. Monday e sistemul părăsit; ce a scris un om pe fișa din ERP
//     bate ce era acolo.
//
//   • BOARDUL SE RECUNOAȘTE DUPĂ COLOANE, nu după numele fișierului — omul
//     îl poate redenumi, coloanele nu mint.
//
// Rulează fără bază de date: lib/monday-import.js e logică pură.
const path = require("path");
const m = require(path.join(__dirname, "lib", "monday-import.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

console.log("\nPotrivirea firmelor:");
const perechi = [
  ["S.C. AQUILA B.V.", "Aquila BV"],
  ["NEGRU & NEGRU BIO S.R.L.", "Negru si Negru Bio SRL"],
  ["TERAPLAST S.A.", "Teraplast SA"],
  ["PET PRODUCT SRL", "Pet Product"],
  ["SOLINA ROMANIA SRL", "  solina   romania  "],
  ["Depanero S.R.L.-D.", "Depanero"],
];
for (const [a, b] of perechi) {
  if (m.cheieFirma(a) !== m.cheieFirma(b)) rau("nu se potrivesc", `${a} ~ ${b} → ${m.cheieFirma(a)} | ${m.cheieFirma(b)}`);
  else ok(`${a}  ~  ${b}`);
}

console.log("\nFirme care NU trebuie lipite:");
const diferite = [
  ["Sameday", "Sameday Courier"],
  ["Cargus", "Cargus International"],
  ["Pet Product", "Pet Factory"],
];
for (const [a, b] of diferite) {
  if (m.cheieFirma(a) === m.cheieFirma(b)) rau("s-au lipit două firme diferite", `${a} ~ ${b}`);
  else ok(`${a}  ≠  ${b}`);
}

console.log("\nForma juridică se taie doar de la coadă:");
egal("Ifantis rămâne întreg", m.cheieFirma("Ifantis Romania"), "ifantisromania");
egal("Iisus rămâne întreg", m.cheieFirma("Iisus Trans"), "iisustrans");
egal("Casa rămâne întreagă", m.cheieFirma("Casa Alba Impex"), "casaalbaimpex");
egal("dar SA de la coadă pleacă", m.cheieFirma("Saltul SA"), "saltul");
egal("și SRL de la coadă pleacă", m.cheieFirma("Saltul SRL"), "saltul");

console.log("\nRecunoașterea boardului, după coloane:");
egal("Leads", m.detecteazaBoard(["Name", "Status", "Create a contact", "Company", "Email", "Phone"]), "leads");
egal("Accounts", m.detecteazaBoard(["Name", "Subitems", "Domain", "Contacts", "Industry"]), "accounts");
egal("Contacts", m.detecteazaBoard(["Name", "Email", "Accounts", "Phone", "Title"]), "contacts");
egal("altceva nu se ghicește", m.detecteazaBoard(["Coloana", "Alta"]), null);

console.log("\nStadiul lead-ului:");
egal("New Lead", m.stadiuDinStatus("New Lead"), "nou");
egal("Qualified", m.stadiuDinStatus("Qualified"), "calificat");
egal("Won", m.stadiuDinStatus("Won"), "castigat");
egal("Lost", m.stadiuDinStatus("Lost"), "pierdut");
egal("gol", m.stadiuDinStatus(""), "nou");

console.log("\nDoar golurile, niciodată peste:");
egal("completează ce lipsește",
  m.doarGolurile({ email: "", telefon: "0722" }, { email: "nou@x.ro", telefon: "0733" }, ["email", "telefon"]),
  { email: "nou@x.ro" });
egal("nu scrie nimic când e totul plin",
  m.doarGolurile({ email: "a@b.ro", telefon: "0722" }, { email: "nou@x.ro", telefon: "0733" }, ["email", "telefon"]),
  {});
egal("nu scrie gol peste gol",
  m.doarGolurile({ email: "" }, { email: "" }, ["email"]), {});
egal("spațiile nu trec drept valoare",
  m.doarGolurile({ email: "   " }, { email: "bun@x.ro" }, ["email"]), { email: "bun@x.ro" });

console.log("\nCurățarea datelor:");
egal("telefon cu prefix și spații", m.telefonCurat("+40 724 089 122"), "+40724089122");
egal("telefon prea scurt se aruncă", m.telefonCurat("12"), "");
egal("email valid", m.emailValid("a.b@c.ro"), true);
egal("email invalid", m.emailValid("nu e email"), false);

console.log("\nNormalizarea rândurilor:");
const lead = m.normalizeaza("leads", { Name: "Raluca Nicula", Status: "Qualified", Company: "RENANIA", Email: "raluca@renania.ro", Phone: "724089122", "Last interaction": "2025-04-03" });
egal("lead-ul ia stadiul și firma", [lead.fel, lead.stadiu, lead.firma, lead.telefon], ["lead", "calificat", "RENANIA", "724089122"]);
const pers = m.normalizeaza("contacts", { Name: "Ana Maria Labib", Email: "ANAMARIA@lecom.ro", Accounts: "Lecombirotica, Altceva", Phone: "737007718", Title: "Director" });
egal("contactul ia prima firmă și emailul în litere mici", [pers.firma, pers.email, pers.functie], ["Lecombirotica", "anamaria@lecom.ro", "Director"]);
const comp = m.normalizeaza("accounts", { Name: "SOLINA ROMANIA SRL", Domain: "solina.ro", "Headquarters location": "Alba Iulia" });
egal("compania ia sediul", [comp.fel, comp.sediu, comp.cheie], ["companie", "Alba Iulia", "solinaromania"]);
egal("rândul fără nume nu produce nimic", m.normalizeaza("accounts", { Name: "" }), null);

console.log("\nAgentul, când există coloana:");
egal("Owner", m.agentDinRand({ Owner: "Gabriela Tudor" }), "Gabriela Tudor");
egal("Created by, dacă Owner lipsește", m.agentDinRand({ "Created by": "Mihai M" }), "Mihai M");
egal("primul dintre mai mulți", m.agentDinRand({ Owner: "Ana P, Radu I" }), "Ana P");
egal("fără coloană, fără agent", m.agentDinRand({ Name: "X" }), "");

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
