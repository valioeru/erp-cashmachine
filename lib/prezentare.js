"use strict";
// Prezentarea mărfii la recepție: câți paleți au venit și cât e pe un palet.
//
// CE A CERUT VALI, 13.11.2026:
//   „La recepție marfă să se scrie și prezentarea mărfii, nr. de paleți și
//    buc. pe paleți, iar apoi marfa să aștepte alocarea pe rafturi în depozit,
//    ca și marfa venită din producție, în aceeași listă."
//
// Prezentarea e „N paleți, Q pe un palet plin": toți paleții sunt plini, în
// afară de ultimul, care poate fi mai gol. 1.000 buc pe 3 paleți a câte 400 =
// 400 + 400 + 200. Din ea se fac apoi, dintr-o apăsare, paleții și etichetele
// lor (lib/ct-scaner.js, faPaleti), fără să mai scrie cineva cantitățile.
//
// Fără bază de date: aceleași reguli la recepția din Procurement, la cea din
// depozit și în lista „De alocat pe raft".

const EPS = 0.0005;
// Câți paleți poate avea un rând: „N x Q" se scrie cu cel mult două cifre
// (lib/ct-scaner.js, cantitatiDinText).
const MAX_PALETI = 99;
// Câți paleți face o apăsare pe „Fă paleții și etichetele" (lib/ct-scaner.js,
// faPaleti). La o prezentare mai lungă se fac întâi atâția, plini; restul
// rămâne în listă cu prezentarea lui (pentruRest).
const MAX_ODATA = 60;
const rot = (v) => Math.round(Number(v) * 1000) / 1000;

// Un număr scris de om: „400", „12,5". Gol → null; altceva → NaN.
function numar(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  if (!/^\d+(?:[.,]\d+)?$/.test(s)) return NaN;
  return Number(s.replace(",", "."));
}

const fmt = (v) => Number(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
const paleti = (n) => (Number(n) === 1 ? "un palet" : `${n} paleți`);

// Citește prezentarea scrisă pentru `cantitate` (cât s-a primit).
//   { gol: true }                — n-a scris nimic
//   { eroare }                   — scris greșit sau nu se potrivește cu cantitatea
//   { nr, pe, ultim, cantitati } — cantitati = câte un număr pe palet
function citeste(nrPaleti, pePalet, cantitate) {
  const n = numar(nrPaleti);
  const pe = numar(pePalet);
  const cant = rot(cantitate);
  if (n === null && pe === null) return { gol: true };
  if (n === null || pe === null) return { eroare: "Scrie amândouă: câți paleți și cât e pe un palet plin." };
  if (!Number.isInteger(n) || n < 1) return { eroare: "Numărul de paleți e un număr întreg, de la 1 în sus." };
  if (n > MAX_PALETI) return { eroare: `Cel mult ${MAX_PALETI} de paleți pe un rând.` };
  if (!(pe > EPS)) return { eroare: "Cât e pe un palet trebuie să fie mai mult ca zero." };
  if (!(cant > EPS)) return { eroare: "Prezentarea se scrie doar pentru marfa primită." };
  const incap = rot(n * pe);
  if (cant > incap + EPS) {
    return { eroare: `Pe ${paleti(n)} a câte ${fmt(pe)} încap ${fmt(incap)}, dar s-au primit ${fmt(cant)}. Mai e un palet, sau pe un palet e mai mult.` };
  }
  if (n > 1 && rot((n - 1) * pe) >= cant - EPS) {
    return { eroare: `${fmt(cant)} încap pe ${paleti(n - 1)} a câte ${fmt(pe)}: al ${n}-lea palet ar rămâne gol. Verifică numărul de paleți.` };
  }
  const ultim = rot(cant - (n - 1) * pe);
  return { nr: n, pe: rot(pe), ultim, cantitati: Array(n - 1).fill(rot(pe)).concat([ultim]) };
}

// Prezentarea salvată pe un rând de recepție, dacă e întreagă și se potrivește
// cu `cantitate`; altfel null.
function dinRand(rand, cantitate) {
  if (!rand || rand.paleti_nr == null || rand.paleti_pe == null) return null;
  const p = citeste(String(rand.paleti_nr), String(rand.paleti_pe), cantitate);
  return p.gol || p.eroare ? null : p;
}

// Ce a mai rămas de pus, pe paleți la fel de plini ca la recepție: 1.200 în
// paleți de 400, din care s-a pus deja unul → „2 x 400" pentru restul de 800.
function pentruRest(pePalet, ramas) {
  const pe = Number(pePalet);
  const r = rot(ramas);
  if (!(pe > EPS) || !(r > EPS)) return null;
  const p = citeste(String(Math.max(1, Math.ceil((r - EPS) / pe))), String(pe), r);
  return p.gol || p.eroare ? null : p;
}

// „3 paleți × 400 buc" sau „3 paleți: 2 × 400 + 200 buc".
function text(p, um) {
  if (!p) return "";
  const u = um ? " " + um : "";
  if (p.nr === 1) return `un palet cu ${fmt(p.ultim)}${u}`;
  if (Math.abs(p.ultim - p.pe) <= EPS) return `${p.nr} paleți × ${fmt(p.pe)}${u}`;
  return `${p.nr} paleți: ${p.nr - 1} × ${fmt(p.pe)} + ${fmt(p.ultim)}${u}`;
}

// Cum se scrie în căsuța „Fă paleții și etichetele" (lib/ct-scaner.js,
// cantitatiDinText): „3 x 400", „2 x 400 + 200", „400 + 200" sau „200".
// Peste MAX_ODATA paleți: doar primii, plini.
function pentruFormular(p) {
  if (!p) return "";
  const s = (v) => String(rot(v)).replace(".", ",");
  if (p.nr > MAX_ODATA) return `${MAX_ODATA} x ${s(p.pe)}`;
  if (p.nr === 1) return s(p.ultim);
  if (Math.abs(p.ultim - p.pe) <= EPS) return `${p.nr} x ${s(p.pe)}`;
  if (p.nr === 2) return `${s(p.pe)} + ${s(p.ultim)}`;
  return `${p.nr - 1} x ${s(p.pe)} + ${s(p.ultim)}`;
}

module.exports = { EPS, MAX_PALETI, MAX_ODATA, numar, citeste, dinRand, pentruRest, text, pentruFormular };
