"use strict";
// Marja unei comenzi de client și vorba care o însoțește în lista de comenzi.
// Fără bază de date.
//
// CEREREA LUI VALI, 18.11.2026: „La orice comenzi cu marja sub 5% să apară în
// lista comenzi (nu în producție) «atenție, renegociază urgent marja». La sub
// 10% același lucru, doar că nu e urgent, e prioritar; la sub 15% marjă minimă,
// încearcă peste 20%; la peste 20% ține sub observație; la peste 25% marja e
// OK; la peste 30% marjă bună; peste 35% foarte bună; la peste 40% marjă
// spectaculoasă, you are the best!"
//
// Între 15% și 20% Vali n-a spus nimic; rămâne vorba de dinainte („încearcă
// peste 20%"), fiindcă exact asta i se cere și acolo.
//
// CUM SE SOCOTEȘTE. Marja = (vânzare − cost) ÷ vânzare, pe liniile comenzii,
// în lei, fără TVA. Costul unei bucăți e cel de pe produs, în ordinea
// încrederii: rețeta, costul de producție scris de mână, prețul de achiziție.
// NU se folosește rata din contabilitate (cost ÷ vânzări): ea dă aceeași marjă
// la orice preț, deci n-ar vedea niciodată un preț negociat prea jos.
//
// O linie n-are cost cunoscut când produsul n-are niciunul din cele trei, când
// linia e vândută în altă unitate decât produsul (preț pe kg, cost pe rolă)
// sau când costul iese de peste cinci ori vânzarea (greșeală de date, nu
// marjă). Vorba se spune doar dacă liniile cu cost acoperă măcar jumătate din
// valoarea comenzii; altfel marja nu se știe și se spune asta.

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const um = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/\.$/, "");

// Treptele, de jos în sus: [de la cât la sută, vorba, culoarea insignei, urgența].
const TREPTE = [
  [-Infinity, "Atenție: renegociază urgent marja", "rosu", "urgent"],
  [5, "Renegociază marja — prioritar", "rosu", "prioritar"],
  [10, "Marjă minimă — încearcă peste 20%", "galben", "minima"],
  [20, "Ține sub observație", "albastru", "observatie"],
  [25, "Marjă OK", "verde", "ok"],
  [30, "Marjă bună", "verde", "buna"],
  [35, "Marjă foarte bună", "verde", "foarte_buna"],
  [40, "Marjă spectaculoasă — you are the best!", "verde", "spectaculoasa"],
];

// Vorba pentru o marjă dată în procente.
function treapta(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return null;
  let t = TREPTE[0];
  for (const x of TREPTE) if (p >= x[0]) t = x;
  return { text: t[1], culoare: t[2], cheie: t[3] };
}

// Costul unei bucăți, de pe produs: rețetă → producție → achiziție. Null = necunoscut.
function costBucata(l) {
  for (const k of ["cost_reteta", "pret_productie", "pret_achizitie"]) if (n(l && l[k]) > 0) return n(l[k]);
  return null;
}

// Marja unei comenzi.
//   linii: [{ cantitate, pret_unitar, um, produs_um, cost_reteta, pret_productie, pret_achizitie }]
//   curs:  cu cât se înmulțește prețul ca să fie lei (1 pentru lei; null = comandă în valută fără curs)
// Întoarce { stiuta, pct, vanzare, cost, acoperire, faraCost, motiv }.
function marja(linii, curs) {
  const c = curs === null || curs === undefined ? null : Number(curs);
  if (c === null || !(c > 0)) return { stiuta: false, motiv: "comanda e în valută și n-are curs" };
  let vanzare = 0;
  let cuCost = 0;
  let cost = 0;
  let faraCost = 0;
  for (const l of linii || []) {
    const v = n(l.cantitate) * n(l.pret_unitar) * c;
    if (!(v > 0)) continue;
    vanzare += v;
    const cb = costBucata(l);
    const altaUm = um(l.um) && um(l.produs_um) && um(l.um) !== um(l.produs_um);
    const costLinie = cb === null ? null : n(l.cantitate) * cb;
    if (costLinie === null || altaUm || costLinie > 5 * v + 100) {
      faraCost++;
      continue;
    }
    cuCost += v;
    cost += costLinie;
  }
  if (!(vanzare > 0)) return { stiuta: false, motiv: "comanda n-are valoare" };
  const acoperire = cuCost / vanzare;
  if (acoperire < 0.5) return { stiuta: false, vanzare, acoperire, faraCost, motiv: faraCost === 1 ? "un produs n-are cost" : `${faraCost} produse n-au cost` };
  return { stiuta: true, pct: ((cuCost - cost) / cuCost) * 100, vanzare, cost, acoperire, faraCost };
}

module.exports = { TREPTE, treapta, costBucata, marja };
