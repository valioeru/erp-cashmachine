"use strict";
// Împărțirea orelor unei comenzi pe zilele libere ale utilajului.
//
// CEREREA LUI VALI, 10.11.2026:
//   „La planificare comandă în producție trebuie să aloc orele pentru comandă
//    manual, dar să le distribuie pe parcursul zilelor, pe acea mașină, care
//    sunt libere."
//
// Până acum o alocare era un singur rând: 30 de ore scrise pe o zi intrau toate
// în ziua aia, iar planificarea o arăta roșie, peste capacitate. Acum omul
// scrie totalul de ore, iar ele se așază zi după zi, începând cu ziua aleasă,
// în ce a rămas liber pe utilaj: capacitatea zilei („ore pe zi", scris pe
// utilaj) minus ce e deja alocat pe el. Zilele pline se sar. Sâmbăta și
// duminica se sar și ele, dacă nu s-a cerut altfel — afară de ziua de pornire,
// pe care a ales-o omul.
//
// Aici e doar socoteala, fără bază de date, ca s-o poată verifica un test și
// ca previzualizarea din pagină și scrierea alocărilor să folosească aceeași
// regulă (modules/utilaje.js).

// Sub un sfert de oră nu se pune o bucată pe o zi: ar umple planificarea cu
// resturi pe care nu le lucrează nimeni.
const PAS = 0.25;
const ORIZONT = 180; // câte zile se caută loc, cel mult
const rot = (v) => Math.round((Number(v) || 0) * 100) / 100;

function ziPlus(data, n) {
  const d = new Date(String(data).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(data);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function eWeekend(data) {
  const z = new Date(String(data).slice(0, 10) + "T00:00:00Z").getUTCDay();
  return z === 0 || z === 6;
}

// `ore`      — totalul de împărțit;
// `data`     — ziua de pornire (aaaa-ll-zz), `oraStart` — ora de pornire;
// `capZi`    — câte ore lucrează utilajul într-o zi;
// `ocupat`   — { zi: ore deja alocate pe utilaj };
// `sfarsit`  — { zi: ora la care se termină ultima alocare din zi } (opțional);
// `weekend`  — se lucrează și sâmbăta și duminica.
//
// Întoarce { bucati, sarite, rest, cap }:
//   bucati — [{ data, ore, ora_start, ocupat, liber }], în ordinea zilelor;
//   sarite — [{ data, motiv: "weekend" | "plina" }], zilele peste care s-a trecut;
//   rest   — ce n-a mai încăput în orizontul de căutare (0, de regulă).
function imparte(intrare) {
  const d = intrare || {};
  const total = rot(d.ore);
  const capBrut = Number(d.capZi);
  const cap = Math.min(24, capBrut > 0 ? capBrut : 8);
  const ocupat = d.ocupat || {};
  const sfarsit = d.sfarsit || {};
  const oraBruta = Number(d.oraStart);
  const oraStart = Number.isFinite(oraBruta) ? Math.min(23, Math.max(0, oraBruta)) : 8;
  const maxZile = Math.max(1, Math.min(ORIZONT, Math.round(Number(d.maxZile) || ORIZONT)));
  const iesire = { bucati: [], sarite: [], rest: 0, cap };
  if (!(total > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.data || ""))) return iesire;

  let rest = total;
  for (let i = 0; i < maxZile && rest > 0.001; i++) {
    const zi = ziPlus(d.data, i);
    // Ziua de pornire a ales-o omul: rămâne, chiar dacă e sâmbătă.
    if (i > 0 && !d.weekend && eWeekend(zi)) {
      iesire.sarite.push({ data: zi, motiv: "weekend" });
      continue;
    }
    const dejaOcupat = rot(ocupat[zi]);
    const liber = rot(cap - dejaOcupat);
    if (liber < PAS) {
      iesire.sarite.push({ data: zi, motiv: "plina" });
      continue;
    }
    const ore = rot(Math.min(rest, liber));
    // În zilele următoare lucrul pornește la ora aleasă sau, dacă utilajul e
    // deja prins dimineața, după ce se termină ce era pe el.
    const dupa = Number(sfarsit[zi]);
    const ora = i === 0 || !(dupa > oraStart) ? oraStart : Math.min(23, Math.floor(dupa));
    iesire.bucati.push({ data: zi, ore, ora_start: ora, ocupat: dejaOcupat, liber });
    rest = rot(rest - ore);
  }
  iesire.rest = rest > 0.001 ? rest : 0;
  return iesire;
}

// Cantitatea comenzii, împărțită pe bucăți după orele fiecăreia. Ultima bucată
// ia restul rotunjirilor, ca suma să fie exact cantitatea scrisă.
function imparteCantitate(cantitate, bucati) {
  const total = Number(cantitate);
  const lista = bucati || [];
  if (!(total > 0) || !lista.length) return lista.map(() => null);
  const ore = lista.reduce((s, b) => s + (Number(b.ore) || 0), 0);
  if (!(ore > 0)) return lista.map(() => null);
  const out = [];
  let dat = 0;
  for (let i = 0; i < lista.length; i++) {
    const parte = i === lista.length - 1 ? rot(total - dat) : rot((total * (Number(lista[i].ore) || 0)) / ore);
    out.push(parte);
    dat = rot(dat + parte);
  }
  return out;
}

module.exports = { PAS, ORIZONT, ziPlus, eWeekend, imparte, imparteCantitate };
