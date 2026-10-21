"use strict";
// Rezultatul perioadei din contul 121 — pe cifrele reale din balanțele Cash
// Machine, nu pe exemple inventate.
//
// DE CE EXISTĂ TESTUL. Pe 21.10.2026 am raportat profitul pe nouă luni ca
// 150.078,73 lei. Vali s-a uitat în balanță: „121 profit e mai mare, pare
// peste 500K, tu îmi dai mai puțin, ești sigur?". Nu eram. Adevărul e
// 523.870,90 lei — scădeam de două ori rezultatul anului trecut, o dată prin
// formulă și o dată fiindcă îl mutase deja contabilul în 1171.
//
// CE APĂRĂ:
//
//   • CIFRA, pe aceleași date pe care am greșit-o. Dacă vreodată iese iar
//     150.078,73, testul pică.
//
//   • AMBELE EXPORTURI DUC ÎN ACELAȘI LOC. Aceeași lună, două fișiere:
//     cumulat 01.01–30.09 și septembrie singur. Pe cel pe o lună, 1171 are
//     rulaj ZERO — dovada virării e în afara perioadei. Cine se uită doar la
//     rulaj trage concluzia greșită; de-aia se citește cumulatul din „Total
//     sume". Balanța pe o lună n-are voie să dea alt profit decât cea pe an.
//
//   • VERIFICAREA PE CAPITALURI, care nu trece deloc prin 121. Două drumuri
//     independente care trebuie să ducă la același leu. Dacă vreodată nu mai
//     duc, raportul trebuie s-o spună, nu să netezească.
//
//   • REZULTATUL VECHI ÎNCĂ NEVIRAT se scade. Primăvara, înainte de AGA, el
//     chiar stă în 121 — atunci scăderea e corectă. Regula trebuie să le
//     deosebească, nu să aleagă una și să greșească jumătate din an.
//
// Rulează fără bază de date: lib/rezultat-121.js e logică pură.
const path = require("path");
const R = require(path.join(__dirname, "lib", "rezultat-121.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

// Capitalurile proprii din balanța CASH MACHINE S.R.L., 01.01.2026 – 30.09.2026.
const CUMULAT = [
  { cont: "1012", si_d: 0, si_c: 200, r_d: 0, r_c: 49800, ts_d: 0, ts_c: 50000, sf_d: 0, sf_c: 50000 },
  { cont: "1061", si_d: 0, si_c: 40, r_d: 0, r_c: 0, ts_d: 0, ts_c: 40, sf_d: 0, sf_c: 40 },
  { cont: "1171", si_d: 0, si_c: 960632.31, r_d: 171533, r_c: 373792.17, ts_d: 171533, ts_c: 1334424.48, sf_d: 0, sf_c: 1162891.48 },
  { cont: "1174", si_d: 63240.58, si_c: 0, r_d: 6861.15, r_c: 0, ts_d: 70101.73, ts_c: 0, sf_d: 70101.73, sf_c: 0 },
  { cont: "121", si_d: 0, si_c: 373792.17, r_d: 15724587.7, r_c: 15874666.43, ts_d: 15724587.7, ts_c: 16248458.6, sf_d: 0, sf_c: 523870.9 },
];

// Aceeași lună, exportată pe septembrie singur. Observă 1171: rulaj zero.
const O_LUNA = [
  { cont: "1012", si_d: 0, si_c: 200, r_d: 0, r_c: 0, ts_d: 0, ts_c: 50000, sf_d: 0, sf_c: 50000 },
  { cont: "1061", si_d: 0, si_c: 40, r_d: 0, r_c: 0, ts_d: 0, ts_c: 40, sf_d: 0, sf_c: 40 },
  { cont: "1171", si_d: 0, si_c: 960632.31, r_d: 0, r_c: 0, ts_d: 171533, ts_c: 1334424.48, sf_d: 0, sf_c: 1162891.48 },
  { cont: "1174", si_d: 63240.58, si_c: 0, r_d: 0, r_c: 0, ts_d: 70101.73, ts_c: 0, sf_d: 70101.73, sf_c: 0 },
  { cont: "121", si_d: 0, si_c: 373792.17, r_d: 1977392.8, r_c: 2214557.29, ts_d: 15724587.7, ts_c: 16248458.6, sf_d: 0, sf_c: 523870.9 },
];

console.log("\nBalanța cumulată 01.01 – 30.09.2026:");
const a = R.rezultatPerioadei(CUMULAT);
egal("rezultatul pe nouă luni", a.rezultat, 523870.9);
egal("soldul lui 121", a.sold, 523870.9);
egal("rezultatul lui 2025 era deja virat în 1171", a.viratInReportat, 373792.17);
egal("deci nu mai rămâne nimic de scăzut", a.ramasDinAnulTrecut, 0);
if (a.rezultat === 150078.73) rau("a revenit exact greșeala din 21.10.2026");

console.log("\nAceeași lună, exportată pe septembrie singur:");
const b = R.rezultatPerioadei(O_LUNA);
egal("același rezultat ca pe balanța cumulată", b.rezultat, 523870.9);
egal("virarea se vede din «Total sume», deși rulajul lunii e zero", b.viratInReportat, 373792.17);

console.log("\nVerificarea pe capitaluri proprii (nu trece prin 121):");
const v = R.verificarePeCapitaluri(CUMULAT);
egal("variația capitalurilor", v.variatieCapitaluri, 395276.75);
egal("aport de capital", v.aport, 49800);
egal("dividende repartizate", v.dividende, 171533);
egal("corecții de erori (1174)", v.corectii, 6861.15);
egal("rezultatul care iese din mișcarea capitalurilor", v.rezultatImplicat, 523870.9);
egal("cele două drumuri duc la același leu", v.diferenta, 0);

const v2 = R.verificarePeCapitaluri(O_LUNA);
egal("și pe exportul pe o lună", v2.rezultatImplicat, 523870.9);
egal("tot fără diferență", v2.diferenta, 0);

console.log("\nCând rezultatul vechi CHIAR a rămas în 121 (primăvara, înainte de AGA):");
const PRIMAVARA = [
  { cont: "1171", si_d: 0, si_c: 960632.31, r_d: 0, r_c: 0, ts_d: 0, ts_c: 960632.31, sf_d: 0, sf_c: 960632.31 },
  { cont: "121", si_d: 0, si_c: 373792.17, r_d: 1000000, r_c: 1100000, ts_d: 1000000, ts_c: 1473792.17, sf_d: 0, sf_c: 473792.17 },
];
const p = R.rezultatPerioadei(PRIMAVARA);
egal("nimic virat în 117x", p.viratInReportat, 0);
egal("deci cei 373.792,17 se scad", p.ramasDinAnulTrecut, 373792.17);
egal("rezultatul perioadei", p.rezultat, 100000);

console.log("\nVirare parțială:");
const PARTIAL = [
  { cont: "1171", si_d: 0, si_c: 100000, r_d: 0, r_c: 200000, ts_d: 0, ts_c: 300000, sf_d: 0, sf_c: 300000 },
  { cont: "121", si_d: 0, si_c: 300000, r_d: 500000, r_c: 650000, ts_d: 500000, ts_c: 950000, sf_d: 0, sf_c: 450000 },
];
const pa = R.rezultatPerioadei(PARTIAL);
egal("s-a virat doar cât avea 121 în sold, nu tot creditul lui 117x", pa.viratInReportat, 200000);
egal("rămân 100.000 din anul trecut", pa.ramasDinAnulTrecut, 100000);
egal("rezultatul perioadei", pa.rezultat, 350000);

console.log("\nCazuri în care nu se răspunde cu zero:");
egal("balanță fără 121 → nu știu, nu «zero»", R.rezultatPerioadei([{ cont: "4111", si_d: 1, si_c: 0, r_d: 0, r_c: 0, ts_d: 1, ts_c: 0, sf_d: 1, sf_c: 0 }]), null);
egal("listă goală", R.rezultatPerioadei([]), null);

console.log("\nPierdere, nu profit:");
const PIERDERE = [
  { cont: "1171", si_d: 0, si_c: 0, r_d: 0, r_c: 0, ts_d: 0, ts_c: 0, sf_d: 0, sf_c: 0 },
  { cont: "121", si_d: 0, si_c: 0, r_d: 900000, r_c: 700000, ts_d: 900000, ts_c: 700000, sf_d: 200000, sf_c: 0 },
];
egal("soldul debitor dă rezultat negativ", R.rezultatPerioadei(PIERDERE).rezultat, -200000);

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
