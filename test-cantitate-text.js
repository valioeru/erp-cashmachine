"use strict";
// Cantitatea comenzii de producție, citită ca număr — într-un singur loc.
//
// `comenzi_productie.cantitate` e text, scris de mână în registru. La
// 10.11.2026, pe cele 428 de comenzi din listă, 74 aveau virgulă la mii
// („67,200", „700,000"), una punct la mii („10.368"), patru o notă după număr
// („360 (331)", „205(65 DONE)") și una unitatea în text („2000 kg"). Fiecare
// loc le citea altfel: costul comenzii lua „700,000" drept 700 și „4000 (3300)"
// drept 40.003.300; recepția din producție primea 0; estimarea pe utilaj ieșea
// de o mie de ori mai scurtă. Finalizarea parțială are nevoie de cantitatea
// adevărată („cât a mai rămas de făcut"), așa că citirea s-a mutat în
// lib/cantitate-text.js și o folosesc toate.
//
// Ce se verifică:
//   1. fiecare formă care apare în registru;
//   2. punctul urmat de trei cifre: mii la bucăți, zecimală la kg;
//   3. locurile care citesc cantitatea folosesc toate aceeași regulă.
//
// Se rulează din rădăcina repo-ului. Nu are nevoie de bază de date.
const path = require("path");
const fs = require("fs");
const Module = require("module");

const RAD = __dirname;
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5433/erp";
const origLoad = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return origLoad.apply(this, arguments);
};

const { citesteCantitate, eMasurata } = require(path.join(RAD, "lib", "cantitate-text.js"));

let esecuri = 0;
function egal(nume, primit, asteptat) {
  const a = JSON.stringify(primit);
  const b = JSON.stringify(asteptat);
  if (a === b) console.log(`  ok     ${nume} = ${a}`);
  else {
    esecuri++;
    console.log(`  ESEC   ${nume} = ${b}  -> ${a}`);
  }
}
const citeste = (lista, um) => lista.map((t) => citesteCantitate(t, um));

console.log("\n1. Formele din registru");
egal("cifre simple", citeste(["700000", "12", " 240 ", "0", "007"]), [700000, 12, 240, 0, 7]);
egal("virgulă la mii — 74 de comenzi din 428", citeste(["67,200", "700,000", "1,625", "1,000", "138,800", "5,760"]), [67200, 700000, 1625, 1000, 138800, 5760]);
egal("punct la mii — aceeași comandă e scrisă „10.368” și „10,368”", citeste(["10.368", "10,368", "1.200", "100.000"]), [10368, 10368, 1200, 100000]);
egal("mai multe grupuri de mii", citeste(["1.200.000", "1,200,000", "12.345.678"]), [1200000, 1200000, 12345678]);
egal("spațiu la mii", citeste(["1 200", "1 200 buc", "100 000", "5 000 000", "1 200"]), [1200, 1200, 100000, 5000000, 1200]);
egal("cantitatea, apoi o notă: se citește doar cantitatea", citeste(["360 (331)", "4000 (3300)", "205(65 DONE)", "360 (262)"]), [360, 4000, 205, 360]);
egal("cantitatea, apoi unitatea", citeste(["2000 kg", "12 buc", "500buc", "1,500 kg", "3 role"]), [2000, 12, 500, 1500, 3]);
egal("zecimale", citeste(["12,5", "0,75", "3.5", "0,500", "0.125", "1234,567", "100,00", "2.25"]), [12.5, 0.75, 3.5, 0.5, 0.125, 1234.567, 100, 2.25]);
egal("punct și virgulă: ultimul semn e zecimala", citeste(["1.250,5", "1,250.5", "1.200.000,75", "1,200,000.75"]), [1250.5, 1250.5, 1200000.75, 1200000.75]);
egal("spațiu la mii și zecimală", citeste(["1 200,5", "1 200.5"]), [1200.5, 1200.5]);
egal("ce nu are niciun număr e zero, nu o ghicitoare", citeste(["", "   ", "x", "Bandă adezivă", "niciun utilaj potrivit", null, undefined]), [0, 0, 0, 0, 0, 0, 0]);
egal("un număr primit ca număr rămâne el; negativ sau stricat e zero", [citesteCantitate(7), citesteCantitate(12.5), citesteCantitate(-3), citesteCantitate(NaN), citesteCantitate(Infinity)], [7, 12.5, 0, 0, 0]);
egal("text în față", citeste(["aprox. 5000", "cca 1,5 t", "~ 300 buc"]), [5000, 1.5, 300]);
egal("o dată sau un cod nu se citesc ca mii", citeste(["10.11.2026", "1.2.3"]), [10.11, 1.2]);
egal("cifrele despărțite de spațiu care nu sunt grupuri de trei nu se lipesc", citeste(["2000 300", "12 34", "5 x 100"]), [2000, 12, 5]);

console.log("\n2. Punctul urmat de trei cifre: mii la ce se numără, zecimală la ce se măsoară");
egal("la bucăți, role, cutii: mii", [citesteCantitate("10.368", "buc"), citesteCantitate("10.368", "BUC"), citesteCantitate("2.500", "role"), citesteCantitate("1.200", "Bucăți")], [10368, 10368, 2500, 1200]);
egal("la kg, metri, litri: zecimală — așa scrie ERP-ul cantitatea cerută de depozit", [citesteCantitate("847.625", "kg"), citesteCantitate("152.375", "KG"), citesteCantitate("12.125", "m"), citesteCantitate("3.500", "l")], [847.625, 152.375, 12.125, 3.5]);
egal("fără unitate: mii, ca în registru", [citesteCantitate("26.148"), citesteCantitate("26.148", ""), citesteCantitate("26.148", null)], [26148, 26148, 26148]);
egal("virgula urmată de trei cifre e de mii și la kg", [citesteCantitate("67,200", "kg"), citesteCantitate("1,500", "kg")], [67200, 1500]);
egal("unitatea scrisă în text bate coloana", [citesteCantitate("26.148 kg", "buc"), citesteCantitate("26.148 buc", "kg"), citesteCantitate("26.148 KG.", "buc")], [26.148, 26148, 26.148]);
egal("o notă după număr nu e unitate: rămâne coloana", [citesteCantitate("26.148 (10 gata)", "kg"), citesteCantitate("26.148 (10 gata)", "buc")], [26.148, 26148]);
egal("mai mult de trei cifre în față nu pot fi mii", [citesteCantitate("1234.567", "buc"), citesteCantitate("1250.5", "buc")], [1234.567, 1250.5]);
egal("se măsoară sau se numără", [eMasurata(" kg", "buc"), eMasurata("", "kg"), eMasurata(" buc", "kg"), eMasurata("", "buc"), eMasurata(" (nota)", "m²"), eMasurata("", "")], [true, true, false, false, true, false]);

console.log("\n3. Toate locurile citesc la fel");
const forme = [["67,200", "buc"], ["700,000", "BUC"], ["10.368", "buc"], ["4000 (3300)", "buc"], ["205(65 DONE)", "buc"], ["2000 kg", "buc"], ["1 200 buc", null], ["12,5", "kg"], ["847.625", "kg"], ["", "buc"]];
const asteptat = [67200, 700000, 10368, 4000, 205, 2000, 1200, 12.5, 847.625, 0];
const COST = require(path.join(RAD, "lib", "cost.js"));
const STADIU = require(path.join(RAD, "lib", "stadiu-comanda.js"));
const STOC = require(path.join(RAD, "lib", "stoc-produse.js"));
const UTILAJE = require(path.join(RAD, "modules", "utilaje.js"));
egal("costul comenzii (lib/cost.js)", forme.map(([t, u]) => COST.cantitateComanda(t, u)), asteptat);
egal("recepția din producție și finalizarea parțială (lib/stadiu-comanda.js)", forme.map(([t, u]) => STADIU.cantNr(t, u)), asteptat);
egal("marfa care urmează să intre (lib/stoc-produse.js)", forme.map(([t, u]) => STOC.numarText(t, u)), asteptat);
egal("estimarea și alocarea pe utilaj (modules/utilaje.js)", forme.map(([t, u]) => UTILAJE.cantitateDin(t, u)), asteptat);
// Costul marfă al comenzilor deschise: „700,000" bucăți a 0,01 lei fac 7.000 de
// lei, nu 7; „4000 (3300)" a 2 lei fac 8.000, nu 80 de milioane.
const card = COST.costMarfaComenzi(
  [
    { cantitate: "700,000", um: "buc", cost_reteta: 0.01, pret_vanzare: 0.02, produs_id: 1 },
    { cantitate: "4000 (3300)", um: "buc", cost_reteta: 2, pret_vanzare: 3, produs_id: 2 },
    // scrisă de ERP dintr-o cerere a depozitului, la kg: 847,625 kg a 2 lei
    { cantitate: "847.625", um: "kg", cost_reteta: 2, pret_vanzare: 3, produs_id: 3 },
  ],
  new Map()
);
egal("cardul „Cost marfă, comenzi deschise”", [card.deschise, card.cuCost, Math.round(card.cost * 100) / 100], [3, 3, 16695.25]);
// Necesarul de materie primă al comenzii citește aceeași cantitate.
const retete = fs.readFileSync(path.join(RAD, "modules", "retete.js"), "utf8");
egal("necesarul comenzii (modules/retete.js) folosește cititorul comun, cu unitatea", /citesteCantitate\(c\.cantitate, c\.um\)/.test(retete), true);
egal("…și nu a rămas nicio citire făcută pe loc", /c\.cantitate \|\| ""\)\.replace\(/.test(retete), false);

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
