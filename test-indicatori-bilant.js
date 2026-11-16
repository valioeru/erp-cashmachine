"use strict";
// Test pentru lib/indicatori-bilant.js: estimarea de final de an pe toți
// indicatorii (cererea lui Vali, 16.11.2026) și cazurile ei de margine.
//
// Pagina e testată în test-indicatori.js, pe balanțe în PostgreSQL. Aici sunt
// cazurile pe care fixtura de acolo nu le atinge: un profit mai mare decât
// datoriile de exploatare, o pierdere, anul bisect, un reper fără solduri.
// Toate sumele sunt socotite de mână, în comentarii.
const IB = require("./lib/indicatori-bilant");

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const aproape = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.005;
function egal(eticheta, real, asteptat) {
  const gresite = Object.keys(asteptat).filter((k) => !aproape(real[k], asteptat[k]));
  if (gresite.length) return rau(eticheta, gresite.map((k) => `${k} = ${real[k]} în loc de ${asteptat[k]}`).join("; "));
  ok(eticheta);
}

// Bilanțul se închide: activ = capitaluri + datorii.
function seInchide(eticheta, e) {
  const dif = e.totalActiv - (e.capitaluri + e.totalDatorii);
  if (Math.abs(dif) < 0.005) ok(eticheta);
  else rau(eticheta, "diferență " + dif);
}

// Un reper la 30 iunie. Soldurile sunt pe grupe, ca din `soldurile()`.
//   F: imobilizări 100; circulante 900 = stocuri 300 + cash 100 + creanțe 500
//      capitaluri 750; credit 519 de 200; datorii curente 250 (din care 50 de
//      exploatare, restul e creditul) ⇒ 1.000 = 750 + 250
//   I: imobilizări 100; circulante 800 = stocuri 300 + cash 50 + creanțe 450
//      capitaluri 600; credit 519 de 200; datorii curente 300 ⇒ 900 = 600 + 300
const F = { capitaluri: 750, datoriiTL: 0, credite519: 200, datoriiCurente: 250, activeImob: 100, activeCirc: 900, stocuri: 300, cash: 100 };
const I = { capitaluri: 600, datoriiTL: 0, credite519: 200, datoriiCurente: 300, activeImob: 100, activeCirc: 800, stocuri: 300, cash: 50 };
const reper = (fl, extra) =>
  Object.assign(IB.indicatoriDin(F, I, fl, 181), { an: 2026, luna: "06", pana: "2026-06-30" }, extra || {});

console.log("\n── Indicatori de bilanț și estimarea de final de an ─────────");

// ---- 1. profitul rămas trece de datoriile de exploatare ---------------------
// Fără ani încheiați ⇒ pro-rata liniară, 12 ÷ 6 = 2.
//   profitul anului = 150 × 2 = 300 ⇒ rămas 150; amortizare 0
//   datoriile de exploatare sunt doar 50 ⇒ se plătesc 50, iar 100 rămân în cash
//   capitaluri 900; datorii curente 200 (rămâne doar creditul); cash 200;
//   circulante 1.000; activ 1.100 = 900 + 200
{
  const ref = reper({ ca: 1000, profit: 150, amortizare: 0, dobanzi: 10, impozit: 0, consumStocuri: 400 });
  const e = IB.estimeazaAnul(ref, [], []);
  egal("profitul care trece de datoriile de exploatare rămâne în cash", e, {
    factor: 2, profitRamas: 150, platit: 50, inCash: 100,
    capitaluri: 900, datoriiCurente: 200, cash: 200, activeCirc: 1000, totalActiv: 1100, totalDatorii: 200,
  });
  seInchide("…și bilanțul se închide", e);
  if (e.liniar === true && e.estimat === true && e.an === 2026) ok("e marcată estimată, pe pro-rata liniară");
  else rau("e marcată estimată, pe pro-rata liniară");
  // Fluxurile de cash se leagă cu variația de cash la fel de bine ca la reper:
  // ce s-a mișcat în bilanț se vede și în cash flow.
  if (aproape(e.nepotrivireCash, ref.nepotrivireCash) && aproape(e.variatieCash, ref.variatieCash + 100)) ok("cash flow-ul estimat se leagă, cu cei 100 rămași în cash");
  else rau("cash flow-ul estimat se leagă", `nepotrivire ${e.nepotrivireCash} față de ${ref.nepotrivireCash}, variație ${e.variatieCash}`);
}

// ---- 2. pierdere pe restul anului -------------------------------------------
//   profitul anului = −60 × 2 = −120 ⇒ rămas −60
//   capitaluri 750 − 60 = 690; pierderea se acoperă din datorii curente: 310
//   activ neschimbat 1.000 = 690 + 310
{
  const e = IB.estimeazaAnul(reper({ ca: 1000, profit: -60, amortizare: 0, dobanzi: 10, impozit: 0, consumStocuri: 400 }), [], []);
  egal("o pierdere scade capitalurile și se acoperă din datorii curente", e, {
    profitRamas: -60, platit: -60, inCash: 0, capitaluri: 690, datoriiCurente: 310, totalActiv: 1000, cash: 100,
  });
  seInchide("…și bilanțul se închide", e);
}

// ---- 3. factorul de sezon, amortizarea și indicatorii băncii ----------------
// Anul trecut, la 30 iunie se făcuse 400 din 1.200 ⇒ factor 3.
//   profit 100 × 3 = 300 ⇒ rămas 200; amortizare 20 × 3 = 60 ⇒ rămasă 40
//   banii făcuți = 240, dar datoriile de exploatare sunt 50 ⇒ plătite 50, 190 în cash
//   imobilizări 100 − 40 = 60; cash 290; circulante 1.090; activ 1.150
//   capitaluri 950; datorii curente 200 ⇒ 1.150 = 950 + 200
//   EBITDA = (100 + 0 + 10 + 20) × 3 = 390; zile = 365 ⇒ EBITDA anualizat = 390
//   acoperirea dobânzii = (100 + 10) × 3 / (10 × 3) = 11, ca la reper
{
  const ref = reper({ ca: 1000, profit: 100, amortizare: 20, dobanzi: 10, impozit: 0, consumStocuri: 400 });
  const e = IB.estimeazaAnul(ref, [{ an: 2025, ca: 1200 }], [{ an: 2025, luna: "06", ca: 400 }]);
  egal("factorul de sezon se aplică tuturor fluxurilor", e, {
    factor: 3, ca: 3000, profit: 300, amortizare: 60, dobanzi: 30, consumStocuri: 1200, ebitda: 390, ebitdaAnual: 390, zile: 365,
    acoperireDobanda: 11,
  });
  egal("amortizarea rămasă scade imobilizările; activele nu cresc decât cu cash-ul de peste datorii", e, {
    amortizareRamasa: 40, platit: 50, inCash: 190, activeImob: 60, cash: 290, activeCirc: 1090, totalActiv: 1150, capitaluri: 950, datoriiCurente: 200,
  });
  seInchide("…și bilanțul se închide", e);
  if (e.liniar === false && e.aniFactor.join() === "2025") ok("spune pe ce ani e măsurat sezonul");
  else rau("spune pe ce ani e măsurat sezonul", JSON.stringify(e.aniFactor));
  if (aproape(e.nepotrivireCash, ref.nepotrivireCash)) ok("cash flow-ul se leagă la fel ca la reper");
  else rau("cash flow-ul se leagă la fel ca la reper", `${e.nepotrivireCash} față de ${ref.nepotrivireCash}`);
}

// ---- 3b. câștigul din vânzarea de active ------------------------------------
// Vali, 16.11.2026: „da, scoate de peste tot”. Profitul 300 are în el un câștig
// de 200 din vânzarea unui activ: e în profit, dar nu în EBITDA, nu în EBIT și
// nu în cash flow-ul din exploatare (banii din vânzare sunt la investiții).
//   EBITDA = 300 + 0 + 10 + 20 − 200 = 130; EBIT = 110
//   CFO = 300 − 200 + 20 − 50 (creanțe) − 0 (stocuri) − 50 (furnizori) = 20
//   CFI = −(0 + 20) + 200 = 180; CFF = (750 − 300 − 600) = −150; variația 50 = 20 + 180 − 150
// La final de an, cu factorul 2: profitul = (300 − 200) × 2 + 200 = 400 (câștigul
// o singură dată); EBITDA = 130 × 2 = 260; câștigul rămâne 200.
{
  const flC = { ca: 1000, profit: 300, amortizare: 20, dobanzi: 10, impozit: 0, consumStocuri: 400, castigActive: 200 };
  const x = IB.indicatoriDin(F, I, flC, 181);
  egal("câștigul din vânzarea de active nu e EBITDA, nici EBIT, nici exploatare", x, { ebitda: 130, ebit: 110, cfo: 20, cfi: 180, cff: -150, variatieCash: 50, nepotrivireCash: 0, castigActive: 200, profit: 300 });
  const e = IB.estimeazaAnul(Object.assign(x, { an: 2026, luna: "06", pana: "2026-06-30" }), [], []);
  egal("la final de an câștigul intră o singură dată", e, { profit: 400, profitRamas: 100, ebitda: 260, castigActive: 200, factor: 2 });
  seInchide("…și bilanțul se închide", e);
}

// ---- 4. zilele anului întreg ------------------------------------------------
if (IB.zileInAn(2026) === 365 && IB.zileInAn(2028) === 366 && IB.zileInAn(2100) === 365 && IB.zileInAn(2000) === 366) ok("anul bisect are 366 de zile");
else rau("anul bisect are 366 de zile", [2026, 2028, 2100, 2000].map(IB.zileInAn).join(", "));

// ---- 5. fără reper sau fără solduri nu se inventează nimic ------------------
if (IB.estimeazaAnul(null, [], []) === null && IB.estimeazaAnul({ an: 2026, luna: "06", ca: 1, profit: 1 }, [], []) === null) ok("fără reper sau fără solduri, nicio estimare");
else rau("fără reper sau fără solduri, nicio estimare");

console.log(`\n${rele ? rele + " probleme" : "Totul curat."}\n`);
process.exit(rele ? 1 : 0);
