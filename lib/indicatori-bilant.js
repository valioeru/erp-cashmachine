"use strict";
// Indicatorii de bilanț din „Indicatori financiari — ochii băncii", socotiți
// din solduri și fluxuri, plus estimarea anului în curs.
//
// DE CE SUNT ÎNTR-UN FIȘIER AL LOR:
//   Aceleași formule se folosesc de două ori: pe balanțele reale din Conta
//   (modules/rapoarte.js, `analizeazaBalanta`) și pe bilanțul estimat la 31
//   decembrie. Dacă estimarea și-ar avea formulele ei, s-ar dezlipi cu timpul
//   de cele reale, iar coloana „2026 estimat" n-ar mai fi comparabilă cu 2025
//   și 2024 de lângă ea.
//
// F și I = soldurile pe grupe, finale și inițiale, cum le scoate `soldurile()`
// din modules/rapoarte.js: capitaluri, datoriiTL, credite519, datoriiCurente,
// activeImob, activeCirc, stocuri, cash.
// fl = fluxurile perioadei: ca, profit, amortizare, dobanzi, impozit,
// consumStocuri.
// zile = câte zile de an acoperă fluxurile, de la 1 ianuarie.

function indicatoriDin(F, I, fl, zile) {
  const { ca, profit, amortizare, dobanzi, impozit, consumStocuri } = fl;
  const totalActiv = F.activeImob + F.activeCirc;
  const totalDatorii = F.datoriiTL + F.datoriiCurente;
  const datoriiFin = F.datoriiTL + F.credite519;
  const datorieNeta = datoriiFin - F.cash;

  // EBITDA construit de jos în sus, din profitul net: singurul mod sigur când
  // contabilitatea închide lunar clasele de venituri și cheltuieli.
  const ebitda = profit + impozit + dobanzi + amortizare;
  const ebit = profit + impozit + dobanzi;
  const factorAn = zile && zile > 0 ? 365 / zile : 1;
  const ebitdaAnual = ebitda * factorAn;

  // Rotația stocurilor pe stoc MEDIU (inițial + final) / 2 — un stoc cumpărat
  // în ultima zi a perioadei n-ar trebui să strice rotația întregii perioade.
  const stocMediu = (F.stocuri + I.stocuri) / 2;
  const zileStoc = consumStocuri > 0 && zile ? (stocMediu / consumStocuri) * zile : null;

  // Cash flow, metoda indirectă. Creanțele = activele circulante fără cash și
  // fără stocuri; datoriile de exploatare = datoriile curente fără creditul pe
  // termen scurt.
  const creanteF = F.activeCirc - F.cash - F.stocuri;
  const creanteI = I.activeCirc - I.cash - I.stocuri;
  const explF = F.datoriiCurente - F.credite519;
  const explI = I.datoriiCurente - I.credite519;
  const cfo = profit + amortizare - (creanteF - creanteI) - (F.stocuri - I.stocuri) + (explF - explI);
  // investițiile brute = creșterea netă a imobilizărilor + amortizarea anului
  const cfi = -((F.activeImob - I.activeImob) + amortizare);
  const cff = F.datoriiTL - I.datoriiTL + (F.credite519 - I.credite519) + (F.capitaluri - profit - I.capitaluri);
  const variatieCash = F.cash - I.cash;

  return {
    zile: zile || null,
    capitaluri: F.capitaluri,
    datoriiTL: F.datoriiTL,
    credite519: F.credite519,
    datoriiFin,
    datorieNeta,
    datoriiCurente: F.datoriiCurente,
    activeImob: F.activeImob,
    activeCirc: F.activeCirc,
    stocuri: F.stocuri,
    cash: F.cash,
    stocInitial: I.stocuri,
    stocMediu,
    ca, profit, amortizare, dobanzi, impozit, consumStocuri,
    ebitda, ebit, ebitdaAnual,
    totalActiv, totalDatorii,
    capitalLucru: F.activeCirc - F.datoriiCurente,
    marja: ca > 0 ? (profit / ca) * 100 : null,
    marjaEbitda: ca > 0 ? (ebitda / ca) * 100 : null,
    lichiditate: F.datoriiCurente > 0 ? F.activeCirc / F.datoriiCurente : null,
    indatorare: totalActiv > 0 ? (totalDatorii / totalActiv) * 100 : null,
    equityRatio: totalActiv > 0 ? (F.capitaluri / totalActiv) * 100 : null,
    leverage: F.capitaluri > 0 ? totalDatorii / F.capitaluri : null,
    gearing: F.capitaluri > 0 ? (datorieNeta / F.capitaluri) * 100 : null,
    datorieNetaEbitda: ebitdaAnual > 0 ? datorieNeta / ebitdaAnual : null,
    acoperireDobanda: dobanzi > 0 ? ebit / dobanzi : null,
    zileStoc,
    rotatieStoc: zileStoc && zileStoc > 0 ? 365 / zileStoc : null,
    cfo, cfi, cff, variatieCash,
    // cât de bine se leagă fluxurile cu variația reală de cash. Dacă nu se
    // leagă, o spun în raport — nu netezesc diferența.
    nepotrivireCash: cfo + cfi + cff - variatieCash,
    // soldurile pe grupe, ca estimarea de final de an să plece de la ele
    final: F,
    initial: I,
  };
}

const zileInAn = (an) => Math.round((Date.UTC(an + 1, 0, 1) - Date.UTC(an, 0, 1)) / 86400000);

// Estimarea anului în curs.
//
// FLUXURILE. Nu le fac liniar (realizat ÷ luni × 12): firma nu vinde egal în
// fiecare lună, iar liniarul minte exact în lunile în care contează. Mă uit în
// anii trecuți cât din anul întreg se făcuse până la ACEEAȘI lună și aplic
// media raportului pe realizatul de acum. Dacă n-am cu ce compara (nu există
// aceeași lună în niciun an încheiat), cad pe liniar și o spun pe față. Toate
// fluxurile — cifra, profitul, dobânzile, amortizarea, impozitul, consumul de
// stocuri — cresc cu același factor, deci profitul păstrează marja realizată
// până acum (un raport propriu al profitului dă factori aberanți la un profit
// mic pe jumătate de an).
//
// BILANȚUL. Cererea lui Vali, 16.11.2026: „La final de an (cu estimat 2026) fă
// estimate pe toate. Menține actual, în principiu, la active și la datorii etc.,
// urcă pro-rata, dar să poți estima toți indicatorii. Activele nu mai cresc
// anul ăsta."
//   Până atunci coloana estimată avea doar rezultatele; bilanțul era gol, pe
//   motiv că un sold la 31 decembrie nu se deduce din cel de la octombrie. Acum
//   regula e cea cerută: bilanțul rămâne cel de la luna închisă, cu singurele
//   mișcări fără de care nu s-ar mai închide:
//   - profitul rămas de făcut până la 31 decembrie intră în capitaluri;
//   - amortizarea rămasă scade imobilizările — nu se mai cumpără nimic;
//   - banii din cele două (profit + amortizare, la creanțe și stocuri
//     neschimbate) se socotesc folosiți la plata datoriilor curente. Ce ar
//     trece de datoriile de exploatare rămâne în cash; o pierdere se acoperă
//     din datorii curente.
//   Creditele, stocurile, creanțele și cash-ul rămân cum sunt. Cash flow-ul
//   anului iese din bilanțul ăsta, cu aceleași formule. Fiindcă banii făcuți
//   în lunile rămase pleacă la plata datoriilor, el iese egal cu cel de până la
//   luna închisă (în afară de ce ar rămâne în cash).
function estimeazaAnul(ref, finaluri, inchise) {
  if (!ref || !ref.final || !ref.initial) return null;
  const factori = [];
  for (const f of finaluri) {
    const ytd = inchise.find((a) => a.an === f.an && a.luna === ref.luna);
    if (ytd && ytd.ca > 0 && f.ca > 0) factori.push({ an: f.an, factor: f.ca / ytd.ca });
  }
  const liniar = 12 / Math.max(1, Number(ref.luna));
  const factor = factori.length ? factori.reduce((s, x) => s + x.factor, 0) / factori.length : liniar;

  const fl = {
    ca: ref.ca * factor,
    profit: ref.profit * factor,
    amortizare: ref.amortizare * factor,
    dobanzi: ref.dobanzi * factor,
    impozit: ref.impozit * factor,
    consumStocuri: ref.consumStocuri * factor,
  };
  const profitRamas = fl.profit - ref.profit;
  const amortizareRamasa = fl.amortizare - ref.amortizare;
  const generat = profitRamas + amortizareRamasa;
  const F0 = ref.final;
  const exploatare = Math.max(0, F0.datoriiCurente - F0.credite519);
  const platit = generat > 0 ? Math.min(generat, exploatare) : generat;
  const inCash = generat - platit;
  const F = Object.assign({}, F0, {
    capitaluri: F0.capitaluri + profitRamas,
    activeImob: F0.activeImob - amortizareRamasa,
    datoriiCurente: F0.datoriiCurente - platit,
    cash: F0.cash + inCash,
    activeCirc: F0.activeCirc + inCash,
  });

  return Object.assign(indicatoriDin(F, ref.initial, fl, zileInAn(Number(ref.an))), {
    estimat: true,
    an: ref.an,
    factor,
    aniFactor: factori.map((x) => x.an),
    liniar: factori.length === 0,
    profitRamas,
    amortizareRamasa,
    platit,
    inCash,
  });
}

module.exports = { indicatoriDin, estimeazaAnul, zileInAn };
