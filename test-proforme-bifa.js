"use strict";
// Bifa „Proforme": cine vede toate proformele și emite pentru orice comandă.
// Fără bază — doar socoteala drepturilor.
//
// CE A CERUT VALI, 18.11.2026: Gabriela Tecuceanu să aibă facturare, avize și
// proforme; „vreau să fie și aia bifată”. Până acum proformele n-aveau bifă:
// le avea pe toate doar cine putea factura.
//
// CE APĂRĂ:
//   • BIFA apare în formularul de utilizatori.
//   • CU BIFĂ: omul are toate proformele, dar NU capătă dreptul de a factura
//     și nici paginile de facturi.
//   • FĂRĂ BIFĂ: rămâne cu ale lui — pagina se deschide, dar nu „pe toți”.
//   • CA PÂNĂ ACUM: administratorul, rolul financiar și bifa „Facturare” au
//     toate proformele.
const path = require("path");
const Module = require("module");
process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const auth = require(path.join(__dirname, "lib", "auth.js"));
const PFM = require(path.join(__dirname, "modules", "proforme.js"));

let rele = 0;
function egal(e, avut, asteptat) {
  if (avut === asteptat) console.log("  ok       " + e + " = " + asteptat);
  else { console.log("  PROBLEMĂ " + e + ": am " + avut + ", așteptam " + asteptat); rele++; }
}

const ADMIN = { id: 1, rol: "admin" };
const FIN = { id: 2, rol: "financiar" };
const AGENT = { id: 3, rol: "vanzari" };
const CU_FACTURARE = { id: 4, rol: "achizitii", sectiuni: "/procurement,/facturi" };
const CU_PROFORME = { id: 5, rol: "achizitii", sectiuni: "/procurement,/proforme" };
const CU_ALTELE = { id: 6, rol: "achizitii", sectiuni: "/procurement,/avize" };
const GABI = { id: 7, rol: "achizitii", sectiuni: "/procurement,/avize,/facturi,/proforme" };

console.log("── Bifa în formular ─────────────────────────────────────────");
egal("bifa Proforme apare la utilizatori", auth.ZONE.some((z) => z.cheie === "/proforme"), true);

console.log("── Cine are toate proformele ────────────────────────────────");
egal("administratorul", auth.areProforme(ADMIN), true);
egal("rolul financiar", auth.areProforme(FIN), true);
egal("bifa Facturare", auth.areProforme(CU_FACTURARE), true);
egal("bifa Proforme", auth.areProforme(CU_PROFORME), true);
egal("agent fără bifă", auth.areProforme(AGENT), false);
egal("alte bife, fără Proforme", auth.areProforme(CU_ALTELE), false);
egal("fără utilizator", auth.areProforme(null), false);

console.log("── Modulul de proforme ascultă de bifă ──────────────────────");
egal("peToti cu bifa Proforme", PFM.peToti(CU_PROFORME), true);
egal("peToti agent fără bifă", PFM.peToti(AGENT), false);
egal("peToti cu alte bife", PFM.peToti(CU_ALTELE), false);

console.log("── Bifa Proforme nu dă facturile ────────────────────────────");
egal("nu poate valida facturi", auth.areFacturare(CU_PROFORME), false);
egal("nu deschide lista de facturi", auth.poateAccesa(CU_PROFORME, "/facturi"), false);
egal("nu deschide Financiarul", auth.poateAccesa(CU_PROFORME, "/financiar"), false);
egal("pagina proformelor se deschide", auth.poateAccesa(CU_PROFORME, "/proforme"), true);
egal("și fără bifă se deschide (ale lui)", auth.poateAccesa(CU_ALTELE, "/proforme"), true);

console.log("── Gabriela, cu cele trei bife ──────────────────────────────");
egal("facturează", auth.areFacturare(GABI), true);
egal("avize pe toți clienții", auth.areAvize(GABI), true);
egal("toate proformele", auth.areProforme(GABI), true);
egal("banca rămâne închisă", auth.poateAccesa(GABI, "/banca"), false);
egal("salariile rămân închise", auth.poateAccesa(GABI, "/salarii"), false);

console.log(rele ? "\n" + rele + " PROBLEME" : "\nToate verificările au trecut.");
process.exit(rele ? 1 : 0);
