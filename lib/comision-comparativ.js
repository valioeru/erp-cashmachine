"use strict";
// Comisionul agenților: regula propusă, pusă lângă cea de acum.
//
// CE A SCRIS VALI, 09.11.2026:
//   „Pentru comision agenți: dacă tot ce a facturat într-o lună calendaristică
//    un agent este sub 265.000 fără TVA pe toate acele facturi, comisionul va
//    fi 10% din marjă. Dă-mi mie doar comparativ într-un raport calculul la zi
//    pentru luna în curs, care se updatează pe măsură ce intră facturi."
//
// Deci deocamdată NU se schimbă nimic din comisionul calculat: decontul
// (modules/decont.js) merge mai departe pe regula de acum. Pagina asta doar
// arată, pentru luna în curs, cât ar ieși cu regula nouă.
//
// Regula nouă, așa cum e scrisă:
//   • baza pragului e ce a FACTURAT agentul în luna calendaristică, fără TVA —
//     nu ce a încasat, ca în decont;
//   • sub 265.000 → 10% din marja facturilor lunii (venit fără TVA minus
//     costul mărfii de pe ele);
//   • la 265.000 și peste, Vali n-a spus încă ce se întâmplă, așa că rămâne
//     regula de acum (comisionul din decont), iar diferența iese zero;
//   • marja negativă se tratează ca acum: se reportează întreagă.
//
// Aici e doar socoteala, fără bază de date, ca să poată fi verificată de test.

const PRAG = 265000;
const PCT_MARJA = 10;

const bani = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Comisionul lunii după regula nouă. `actual` = comisionul câștigat în lună
// după regula de acum, pentru agenții de peste prag.
function comisionNou(facturatNet, marjaFacturata, actual) {
  const f = Number(facturatNet) || 0;
  const m = Number(marjaFacturata) || 0;
  if (f < PRAG) {
    if (m < 0) return { valoare: bani(m), dupa: "marjă negativă, se reportează întreagă", subPrag: true };
    return { valoare: bani((m * PCT_MARJA) / 100), dupa: `${PCT_MARJA}% din marja facturată`, subPrag: true };
  }
  return { valoare: bani(actual), dupa: "peste prag: regula de acum", subPrag: false };
}

// Rândurile raportului, pe agent.
//   agenti  — [{ id, nume, rol }]
//   facturat — Map agent_id → { net, cost, fara_cost, facturi: [...] }
//   decont  — rândurile lunii din decont (calculeaza().ultima.randuri)
// Apar doar agenții care au ceva în lună: facturi, încasări sau comision.
function randuri(agenti, facturat, decont) {
  const dinDecont = new Map((decont || []).map((r) => [Number(r.agent && r.agent.id), r]));
  const out = [];
  for (const a of agenti || []) {
    const f = (facturat && facturat.get(Number(a.id))) || { net: 0, cost: 0, fara_cost: 0, facturi: [] };
    const d = dinDecont.get(Number(a.id)) || { incasat_net: 0, marja: 0, castigat: 0, dupa: "" };
    const marjaFacturata = bani((Number(f.net) || 0) - (Number(f.cost) || 0));
    const actual = bani(d.castigat);
    const nou = comisionNou(f.net, marjaFacturata, actual);
    const areCeva = Math.abs(Number(f.net) || 0) > 0.005 || Math.abs(Number(d.incasat_net) || 0) > 0.005 || Math.abs(actual) > 0.005;
    if (!areCeva) continue;
    const net = bani(f.net);
    out.push({
      agent: a,
      facturat: net,
      pana_la_prag: bani(Math.max(0, PRAG - net)),
      cost_facturat: bani(f.cost),
      marja_facturata: marjaFacturata,
      // cât din facturat are costul mărfii măsurat, nu estimat cu rata firmei
      acoperire: net > 0 ? Math.max(0, Math.min(100, ((net - (Number(f.fara_cost) || 0)) / net) * 100)) : null,
      nr_facturi: (f.facturi || []).length,
      facturi: f.facturi || [],
      incasat: bani(d.incasat_net),
      marja_incasata: bani(d.marja),
      actual,
      dupa_actual: d.dupa || "",
      nou: nou.valoare,
      dupa_nou: nou.dupa,
      sub_prag: nou.subPrag,
      diferenta: bani(nou.valoare - actual),
    });
  }
  return out.sort((x, y) => y.facturat - x.facturat || String(x.agent.nume).localeCompare(String(y.agent.nume), "ro"));
}

function totaluri(rs) {
  const s = (k) => bani((rs || []).reduce((t, r) => t + (Number(r[k]) || 0), 0));
  return {
    facturat: s("facturat"),
    marja_facturata: s("marja_facturata"),
    incasat: s("incasat"),
    actual: s("actual"),
    nou: s("nou"),
    diferenta: s("diferenta"),
  };
}

module.exports = { PRAG, PCT_MARJA, comisionNou, randuri, totaluri };
