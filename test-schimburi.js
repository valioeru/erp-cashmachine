"use strict";
// Schimburile și „cine e în tură la ora asta". Aritmetică pură, fără bază de date.
//
// CE APĂRĂ:
//
//   • SCHIMBUL DE NOAPTE TRECE PESTE MIEZUL NOPȚII. O alocare la 2 dimineața
//     trebuie să găsească schimbul 3 pornit CU O ZI ÎNAINTE. Dacă regula se
//     strică, tura de noapte dispare din listă exact în orele în care e
//     singura în hală.
//
//   • MARGINILE. Omul care intră la 14 nu e acolo la 13:59, dar e la 14:00.
//     Un „≥" scris „>" face ca schimbul 2 să nu poată fi alocat la ora lui de
//     început — și nimeni nu înțelege de ce lipsește.
//
//   • CODURILE SCRISE DE MÂNĂ. Planul vine din Excel, scris de oameni
//     diferiți: „S1", „s 1", „tura 1", „day". Un cod nerecunoscut înseamnă un
//     om care dispare din planificare fără ca cineva să afle de ce.
const S = require("./lib/schimburi");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 200) : "")); esecuri++; }
}

// ---- 1. Citirea codurilor --------------------------------------------------
console.log("Codurile de schimb");
for (const [scris, asteptat] of [
  ["S1", "S1"], ["s1", "S1"], ["S 1", "S1"], ["tura 1", "S1"], ["Shift 1", "S1"],
  ["S2", "S2"], ["schimb 2", "S2"], ["3", "S3"], ["S3", "S3"],
  ["zi", "zi"], ["day", "zi"], ["Day shift", "zi"], ["tura zi", "zi"],
]) bine(`„${scris}" → ${asteptat}`, S.normalizeaza(scris) === asteptat, S.normalizeaza(scris));
bine("ce nu se recunoaște nu se ghicește", S.normalizeaza("liber") === null, S.normalizeaza("liber"));
bine("gol nu dă schimb", S.normalizeaza("") === null && S.normalizeaza(null) === null);

// ---- 2. Intervalele --------------------------------------------------------
console.log("\nIntervalele");
bine("S1 ține o singură bucată, în aceeași zi",
  JSON.stringify(S.interval("S1", "2026-10-26")) === JSON.stringify([{ data: "2026-10-26", de: 6, la: 14 }]),
  S.interval("S1", "2026-10-26"));
bine("S3 se rupe în două, a doua bucată e a doua zi",
  JSON.stringify(S.interval("S3", "2026-10-26")) ===
    JSON.stringify([{ data: "2026-10-26", de: 22, la: 24 }, { data: "2026-10-27", de: 0, la: 6 }]),
  S.interval("S3", "2026-10-26"));
bine("un cod inexistent n-are interval", S.interval("S9", "2026-10-26").length === 0);

// ---- 3. Acoperirea ---------------------------------------------------------
console.log("\nCine e în tură");
bine("S2 e acolo fix la ora de început (14)", S.acopera("S2", "2026-10-26", "2026-10-26", 14));
bine("S2 NU e acolo la 13:59 (ora 13)", !S.acopera("S2", "2026-10-26", "2026-10-26", 13));
bine("S2 NU mai e la 22 — atunci intră schimbul 3", !S.acopera("S2", "2026-10-26", "2026-10-26", 22));
bine("S1 e acolo la 6", S.acopera("S1", "2026-10-26", "2026-10-26", 6));
bine("S1 nu e acolo la 5", !S.acopera("S1", "2026-10-26", "2026-10-26", 5));
bine("S3 pornit luni e în hală luni la 23", S.acopera("S3", "2026-10-26", "2026-10-26", 23));
bine("S3 pornit luni e în hală MARȚI la 2 dimineața", S.acopera("S3", "2026-10-26", "2026-10-27", 2));
bine("S3 pornit luni nu mai e marți la 6", !S.acopera("S3", "2026-10-26", "2026-10-27", 6));
bine("S3 pornit luni nu e marți la 10", !S.acopera("S3", "2026-10-26", "2026-10-27", 10));
bine("tura de zi acoperă 8–16", S.acopera("zi", "2026-10-26", "2026-10-26", 8) && S.acopera("zi", "2026-10-26", "2026-10-26", 15));
bine("tura de zi nu acoperă 16", !S.acopera("zi", "2026-10-26", "2026-10-26", 16));
bine("o oră care nu e număr nu acoperă nimic", !S.acopera("S1", "2026-10-26", "2026-10-26", "aiurea"));

// ---- 4. Lista de disponibili ----------------------------------------------
console.log("\nLista de la alocare");
const PROGRAM = [
  { resursa_id: 1, data: "2026-10-26", schimb: "S1" },   // Florin, zi de lucru
  { resursa_id: 2, data: "2026-10-26", schimb: "S2" },   // Giri
  { resursa_id: 3, data: "2026-10-26", schimb: "S3" },   // Karki
  { resursa_id: 4, data: "2026-10-26", schimb: "zi" },   // Vlad
  { resursa_id: 5, data: "2026-10-27", schimb: "S1" },   // altcineva, a doua zi
];
const laOra = (zi, ora) => [...S.disponibili(PROGRAM, zi, ora)].sort((a, b) => a - b).join(",");
bine("luni la 7 dimineața e doar schimbul 1", laOra("2026-10-26", 7) === "1", laOra("2026-10-26", 7));
bine("luni la 9 sunt schimbul 1 și tura de zi", laOra("2026-10-26", 9) === "1,4", laOra("2026-10-26", 9));
bine("luni la 15 sunt schimbul 2 și tura de zi", laOra("2026-10-26", 15) === "2,4", laOra("2026-10-26", 15));
bine("luni la 23 e doar schimbul 3", laOra("2026-10-26", 23) === "3", laOra("2026-10-26", 23));
bine("marți la 3 noaptea e tot schimbul 3 de luni", laOra("2026-10-27", 3) === "3", laOra("2026-10-27", 3));
bine("marți la 7 e doar omul planificat marți", laOra("2026-10-27", 7) === "5", laOra("2026-10-27", 7));
bine("duminică, fără nimeni planificat, lista e goală", laOra("2026-11-01", 10) === "", laOra("2026-11-01", 10));
bine("un rând cu schimb necitibil nu bagă pe nimeni în listă",
  S.disponibili([{ resursa_id: 9, data: "2026-10-26", schimb: "liber" }], "2026-10-26", 10).size === 0);
bine("fără niciun rând de program nu crapă", S.disponibili(null, "2026-10-26", 10).size === 0);

console.log("\nEtichete");
bine("eticheta lui S2 spune și orele", S.eticheta("S2") === "S2 · 14–22", S.eticheta("S2"));
bine("eticheta merge și pe scrisul de mână", S.eticheta("tura 3") === "S3 · 22–06", S.eticheta("tura 3"));

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
