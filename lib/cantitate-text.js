"use strict";
// Cantitatea scrisă ca text pe o comandă de producție, citită ca număr.
//
// `comenzi_productie.cantitate` e TEXT: registrul de comenzi vine dintr-un
// Excel completat de mână. Pe cele 428 de comenzi din listă, la 10.11.2026,
// formele erau:
//   „700000", „12"                              — cifre simple (cele mai multe);
//   „67,200", „700,000", „1,625"                — virgulă la mii (74 de comenzi);
//   „10.368"                                    — punct la mii (aceeași comandă
//                                                 apare și ca „10,368");
//   „360 (331)", „4000 (3300)", „205(65 DONE)"  — cantitatea, apoi o notă;
//   „2000 kg"                                   — cantitatea, apoi unitatea.
// Pe lângă ele, comenzile pornite dintr-o cerere a depozitului au cantitatea
// scrisă de ERP, cu punct la zecimale: „1200", „12.5", „847.625".
//
// Fiecare loc o citea în felul lui și mai multe greșeau: „700,000" ieșea 700
// (virgula luată drept zecimală), „4000 (3300)" ieșea 40.003.300 (cifrele
// lipite), iar recepția din producție primea 0. Costul comenzii, necesarul de
// materie primă, estimarea pe utilaj și marfa care urmează să intre ieșeau de
// o mie de ori mai mici sau de zece mii de ori mai mari, fără nicio eroare.
// De-aia citirea stă într-un singur loc.
//
// Regula:
//   - se citește PRIMUL număr din text; ce urmează (nota, unitatea) nu se adună;
//   - spațiul între grupuri de câte trei cifre desparte miile („1 200");
//   - punct ȘI virgulă: ultimul semn e zecimala, celălalt desparte miile
//     („1.250,5" = 1250,5; „1,250.5" = 1250,5);
//   - același semn de mai multe ori, cu grupuri de trei („1.200.000"): mii;
//   - virgulă urmată de exact trei cifre („67,200"): mii — așa sunt scrise
//     miile în registru, iar o comandă nu se scrie de mână cu trei zecimale;
//   - punct urmat de exact trei cifre: mii la ce se numără („10.368 buc" — o
//     bucată nu are zecimale), zecimală la ce se cântărește sau se măsoară
//     („847.625 kg"), fiindcă așa scrie ERP-ul singur cantitățile;
//   - altfel („12,5", „0,75", „3.5", „0,500"): zecimală.
//
// Unitatea e cea scrisă în text, dacă e una cunoscută („2000 kg"), altfel cea
// din coloana `um`. Fără unitate, punctul urmat de trei cifre e de mii.
//
// Afișarea NU trece pe aici: pe ecran cantitatea rămâne scrisă cum a scris-o
// omul (lib/render.js, despartCantitate). Aici e doar numărul pentru socoteli.

const SPATII = /[   ]/g;
// Întregul: grupuri de trei despărțite prin spațiu, sau cifre legate. Apoi
// oricâte bucăți „semn + cifre".
const NUMAR = /(\d{1,3}(?: \d{3})+(?!\d)|\d+)((?:[.,]\d+)*)/;

// Ce se cântărește sau se măsoară poate avea zecimale; ce se numără, nu.
const MASURATE = new Set(["kg", "g", "gr", "t", "to", "tona", "tone", "m", "ml", "mp", "m2", "mc", "m3", "l", "litru", "litri", "km", "cm", "mm"]);
const NUMARATE = new Set([
  "buc", "bucata", "bucati", "pcs", "rola", "role", "set", "seturi", "cutie", "cutii", "palet", "paleti",
  "punga", "pungi", "sac", "saci", "top", "topuri", "pachet", "pachete", "bax", "baxuri", "coala", "coli",
]);
const normUnitate = (v) =>
  String(v == null ? "" : v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/[^a-z0-9]/g, "");

// Se măsoară (are zecimale) cantitatea asta? Întâi unitatea scrisă în text,
// imediat după număr; dacă acolo nu e una cunoscută, cea din coloană.
function eMasurata(dupaNumar, um) {
  const m = /^\s*([^\s\d()\[\]/,;:.\-+*]+)/.exec(String(dupaNumar || ""));
  const dinText = m ? normUnitate(m[1]) : "";
  if (MASURATE.has(dinText)) return true;
  if (NUMARATE.has(dinText)) return false;
  return MASURATE.has(normUnitate(um));
}

function citesteCantitate(text, um) {
  if (typeof text === "number") return Number.isFinite(text) && text > 0 ? text : 0;
  const s = String(text == null ? "" : text).replace(SPATII, " ").trim();
  if (!s) return 0;
  const m = NUMAR.exec(s);
  if (!m) return 0;
  const intreg = m[1].replace(/ /g, "");
  const bucati = m[2] ? m[2].match(/[.,]\d+/g) : [];
  if (!bucati.length) return Number(intreg);

  const semne = bucati.map((b) => b[0]);
  const cifre = bucati.map((b) => b.slice(1));
  const dinTrei = (x) => x.length === 3;
  // Un grup de mii urmează unui întreg de una până la trei cifre, care nu e „0".
  // (Un întreg scris cu spații la mii are deja cel puțin patru cifre.)
  const poateFiMii = intreg.length <= 3 && intreg !== "0";

  if (semne.includes(".") && semne.includes(",")) {
    // Ultimul semn e zecimala; tot ce e înaintea lui desparte miile.
    return Number(intreg + cifre.slice(0, -1).join("") + "." + cifre[cifre.length - 1]);
  }
  if (bucati.length > 1) {
    // Același semn de mai multe ori: mii, dacă grupurile sunt de câte trei.
    // Altfel („10.11.2026") nu e o cantitate scrisă cu mii; rămâne prima parte.
    if (poateFiMii && cifre.every(dinTrei)) return Number(intreg + cifre.join(""));
    return Number(intreg + "." + cifre[0]);
  }
  if (poateFiMii && dinTrei(cifre[0])) {
    const eMii = semne[0] === "," || !eMasurata(s.slice(m.index + m[0].length), um);
    if (eMii) return Number(intreg + cifre[0]);
  }
  return Number(intreg + "." + cifre[0]);
}

module.exports = { citesteCantitate, eMasurata };
