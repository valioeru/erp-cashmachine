"use strict";
// Rezultatul perioadei, citit din contul 121 — corect.
//
// CUM AM AJUNS AICI. Pe 21.10.2026 am raportat profitul pe nouă luni ca
// 150.078,73 lei. Vali s-a uitat în balanță și a spus: „121 profit e mai mare,
// pare peste 500K, tu îmi dai mai puțin, ești sigur?". Avea dreptate, iar
// greșeala merită scrisă aici, fiindcă arată exact de unde vine:
//
//   soldul inițial al lui 121 la 01.01.2026 era 373.792,17 lei creditor —
//   rezultatul lui 2025, nerepartizat încă. Formula de până acum scădea
//   soldul ăsta din rezultat, ca să nu numere profitul anului trecut în anul
//   curent. Sună corect. Dar contabilul ÎL MUTASE DEJA: în cursul lui 2026 a
//   dat 121 = 1171, iar 1171 are în balanță rulaj creditor exact 373.792,17.
//   După mutare, în 121 nu mai era nimic din 2025. Scăzându-l încă o dată,
//   îl scădeam de două ori — și profitul ieșea exact cu 373.792,17 mai mic.
//
// CE NU MERGE, ȘI DE CE:
//
//   • „rulaj creditor 121 minus rulaj debitor 121" — exact greșeala de mai
//     sus. Rulajul debitor al lui 121 conține și virarea rezultatului vechi
//     în 1171, care nu e o cheltuială.
//
//   • „venituri închise în 121 minus rulajul debitor al conturilor 6xx" —
//     dă 336.205,14 lei, și nu e nici el bun. Clasele 6 și 7 au, pe lângă
//     închideri, și mișcări interne (stornări, treceri dintr-un cont în
//     altul). Rulajul brut le numără pe toate: pe nouă luni, Σ7xx creditor
//     era 20.666.093,74 dar în 121 s-au închis doar 15.874.666,43. Diferența
//     nu e profit și nu e pierdere, e zgomot contabil.
//
// CE MERGE: soldul lui 121, după ce te-ai asigurat că soldul inițial a plecat.
// Soldul e o poziție, nu o sumă de mișcări, deci nu-l poate umfla nicio
// mișcare internă. Verificat pe nouă luni 2026 pe un drum complet separat —
// mișcarea capitalurilor proprii:
//
//   variația capitalurilor   +395.276,75
//   − aport de capital        −49.800,00   (1012, rulaj creditor)
//   + dividende repartizate  +171.533,00   (1171, rulaj debitor)
//   + corecție de erori        +6.861,15   (1174, nu trece prin 121)
//   ------------------------------------
//   = 523.870,90 lei          exact soldul lui 121. La leu.

const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const BANI = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
};

// RULAJUL DE LA 1 IANUARIE, nu cel al perioadei alese la export.
//
// Asta nu e un amănunt, e chiar miezul: virarea rezultatului vechi din 121 în
// 1171 s-a făcut o dată, undeva în primăvară. Pe balanța cumulată 01.01–30.09
// se vede în rulajul lui 1171. Pe balanța pe septembrie singur, 1171 are rulaj
// ZERO — dovada e în afara perioadei. Dacă m-aș uita doar la rulaj, aș trage
// concluzia că virarea nu s-a făcut și aș scădea rezultatul vechi încă o dată:
// exact greșeala de la care a pornit tot fișierul ăsta, doar că pe altă ușă.
//
// „Total sume" e cumulat de la 1 ianuarie în amândouă, deci scăzând soldurile
// inițiale iese cumulatul anului indiferent ce perioadă a ales omul. Aceeași
// regulă ca în rapoarte.js. Balanțele vechi, trase prin punte, n-au coloanele
// de total sume — la ele rulajele sunt oricum cumulate pe an.
function areTotaluri(conturi) {
  return (conturi || []).some((c) => nr(c.ts_d) !== 0 || nr(c.ts_c) !== 0);
}

function ytd(c, cuTotaluri) {
  return cuTotaluri
    ? { d: nr(c.ts_d) - nr(c.si_d), c: nr(c.ts_c) - nr(c.si_c) }
    : { d: nr(c.r_d), c: nr(c.r_c) };
}

// Cât din soldul inițial al lui 121 a fost virat în rezultatul reportat de la
// începutul anului. Se citește din rulajul CREDITOR al conturilor 117x: acolo
// aterizează profitul anului trecut (121 = 117 la profit, deci creditul lui
// 117x e chiar suma venită din 121).
//
// Se ia minimul dintre cele două, nu rulajul brut: 117x mai primește și
// altceva (acoperiri de pierdere, ajustări), iar o sumă mai mare de acolo
// n-ar însemna că s-a virat mai mult din 121 decât avea.
function viratInReportat(conturi) {
  const cuTot = areTotaluri(conturi);
  let rulajC117 = 0;
  let soldInitial121 = 0;
  for (const c of conturi || []) {
    const cont = String((c && c.cont) || "");
    if (cont.startsWith("117")) rulajC117 += ytd(c, cuTot).c;
    if (cont === "121") soldInitial121 = nr(c.si_c) - nr(c.si_d);
  }
  if (soldInitial121 <= 0) return { soldInitial121: BANI(soldInitial121), viratC: BANI(rulajC117), virat: 0 };
  return { soldInitial121: BANI(soldInitial121), viratC: BANI(rulajC117), virat: BANI(Math.min(soldInitial121, rulajC117)) };
}

// Rezultatul perioadei. Întoarce null când balanța n-are 121 — nu zero: zero
// ar însemna „firma a ieșit pe nul", ceea ce e cu totul altceva decât „nu știu".
//
// `rest` e partea din rezultatul anului trecut rămasă încă în 121. Se scade,
// fiindcă aia chiar nu e din perioada asta.
function rezultatPerioadei(conturi) {
  const c121 = (conturi || []).find((c) => String((c && c.cont) || "") === "121");
  if (!c121) return null;
  const sold = BANI(nr(c121.sf_c) - nr(c121.sf_d));
  const v = viratInReportat(conturi);
  const rest = BANI(Math.max(0, v.soldInitial121 - v.virat));
  return {
    rezultat: BANI(sold - rest),
    sold,
    soldInitial121: v.soldInitial121,
    viratInReportat: v.virat,
    ramasDinAnulTrecut: rest,
    // Pentru raport: de unde vine cifra, în cuvintele cuiva care se uită la
    // balanță, nu la cod.
    explicatie:
      v.soldInitial121 === 0
        ? "soldul contului 121; nu era nimic de anul trecut în el"
        : rest === 0
          ? `soldul contului 121; rezultatul anului trecut (${v.soldInitial121.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei) fusese deja virat în 117x`
          : `soldul contului 121 minus ${rest.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei rămași din rezultatul anului trecut, încă nevirați în 117x`,
  };
}

// Verificarea pe capitaluri proprii — drumul care nu trece deloc prin 121.
//
// Δ(capitaluri proprii) = rezultatul perioadei + aport de capital
//                         − dividende repartizate + corecții de erori
//
// Se întoarce diferența, ca raportul s-o poată arăta când nu se potrivește.
// Nu se „netezește" nimic: dacă cele două drumuri nu duc în același loc,
// înseamnă că mai e ceva în balanță pe care nu l-am prins, și asta trebuie
// spus, nu ascuns.
function verificarePeCapitaluri(conturi) {
  const cuTot = areTotaluri(conturi);
  let siCap = 0, sfCap = 0, aport = 0, dividende = 0, corectii = 0;
  for (const c of conturi || []) {
    const cont = String((c && c.cont) || "");
    const r = ytd(c, cuTot);
    if (/^(101|106|117|121)/.test(cont)) {
      siCap += nr(c.si_c) - nr(c.si_d);
      sfCap += nr(c.sf_c) - nr(c.sf_d);
    }
    if (cont.startsWith("101")) aport += r.c;
    if (cont.startsWith("117") && !cont.startsWith("1174")) dividende += r.d;
    if (cont.startsWith("1174")) corectii += r.d - r.c;
  }
  const variatie = BANI(sfCap - siCap);
  const implicat = BANI(variatie - aport + dividende + corectii);
  const r = rezultatPerioadei(conturi);
  const dinSold = r ? r.rezultat : 0;
  return {
    variatieCapitaluri: variatie,
    aport: BANI(aport),
    dividende: BANI(dividende),
    corectii: BANI(corectii),
    rezultatImplicat: implicat,
    rezultatDinSold: dinSold,
    diferenta: BANI(implicat - dinSold),
  };
}

module.exports = { rezultatPerioadei, verificarePeCapitaluri, viratInReportat, BANI };
