"use strict";
// Costul unei role stretch făcute din jumbo — aceleași formule ca în
// „Calculator_cost_rola_stretch_2.xlsx" (Vali, 09.11.2026: „Urcă apoi și
// calculatorul — asta, unde sunt și celelalte").
//
// LANȚUL, pe o rolă:
//   lungimea foliei   = kg ÷ (lățime × grosime × densitate)
//   timpul de ciclu   = lungime ÷ viteza mașinii + accelerare/decelerare
//                       + manipulare
//   role pe oră       = 3600 ÷ timpul de ciclu
//   materialul        = jumbo teoretic (kg plătite) × preț ÷ role dintr-un jumbo,
//                       unde role dintr-un jumbo = jumbo util ÷ kg pe rolă
//                       (întregi, dacă restul din jumbo e capăt pierdut)
//   electricitatea    = RON/kWh × kW × timpul de ciclu
//   manopera          = salariu × (1 + contribuții) ÷ ore pe lună × operatori
//                       ÷ role pe oră
//   cost pe rolă      = material + core + electricitate + manoperă + alte costuri
//   preț de vânzare   = cost × (1 + adaos)
// Prețurile sunt fără TVA.
//
// Ce e altfel decât în Excel: prețul jumbo „din stoc" nu se mai lipește dintr-un
// export într-o foaie, ci se citește din CT-Park (modules/calculator-stretch.js):
// media ponderată a paleților de jumbo stretch care au preț, sau un produs ales.
//
// Aici e doar socoteala, fără bază de date — ca să se poată verifica cifră cu
// cifră față de foaia de calcul (test-calculator-stretch.js).

const CORE = [
  { cheie: "manual", nume: "Rolă manuală simplă", pret: 0.92, kg: 0.2, utilizare: "Role manuale simple" },
  { cheie: "prestretch", nume: "Prestretch manual", pret: 1.63, kg: 0.325, utilizare: "Prestretch manual (300–350 g)" },
  { cheie: "automat", nume: "Rolă automată", pret: 5, kg: 1.64, utilizare: "Role automate prestretch sau normal (1,64–2 kg)" },
];

// „Stretch normală" e mașina de stretch manual, „Stretch / prestretch" e
// rebobinatorul de prestretch — numele din hală sunt în paranteză.
const MASINI = [
  { cheie: "normala", nume: "Stretch normală", utilaj: "Stretch manual", viteza: 500, kw: 5, accel: 5, produse: "Doar role manuale simple" },
  { cheie: "prestretch", nume: "Stretch / prestretch", utilaj: "Rebobinare stretch (prestretch)", viteza: 1000, kw: 5, accel: 15, produse: "Orice tip de produs" },
];

// Parametrii de producție. De la Mihai: salariul, orele, prețul energiei.
// De confirmat: puterea, timpii de accelerare și manipulare.
const PARAMETRI = {
  energie: 1, // RON/kWh
  salariu: 7500, // RON pe lună, operator
  contributii: 0, // % peste salariu
  ore_luna: 160,
  operatori: 1, // pe mașină
  densitate: 0.92, // g/cm³
  manipulare: 180, // secunde pe rolă
};

const INTRARI = {
  kg: 14.4, // greutatea cerută de client, net, fără core
  grosime: 23, // µm
  latime: 500, // mm
  core: "automat",
  masina: "prestretch",
  sursa: "manual", // manual | medie | produs
  pret_eur: 1.69, // EUR/kg, la sursa manuală
  produs_id: "",
  curs: 5.35,
  jumbo_teoretic: 50, // kg plătite
  jumbo_util: 48.4, // kg care ies în role
  alte: 0, // RON pe rolă: ambalare, transport
  adaos: 0, // %
  role: 1, // cantitatea comenzii
  intregi: "NU", // DA = restul din jumbo e capăt pierdut
};

const nr = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const imparte = (a, b) => (b ? a / b : 0); // IFERROR(a/b, 0) din foaie

// x = intrările, p = parametrii, core și masina = rândurile alese, pretRonKg =
// prețul jumbo folosit (RON/kg), deja hotărât din sursă.
function calculeaza(x, p, core, masina, pretRonKg) {
  const kg = nr(x.kg);
  const curs = nr(x.curs);
  const pret = nr(pretRonKg);

  // PRODUCȚIE
  const lungime = imparte(kg, (nr(x.latime) / 1000) * (nr(x.grosime) / 1e6) * nr(p.densitate) * 1000);
  const viteza = nr(masina && masina.viteza);
  const kw = nr(masina && masina.kw);
  const bobinare = imparte(lungime, viteza) * 60;
  const accel = nr(masina && masina.accel);
  const manipulare = nr(p.manipulare);
  const ciclu = bobinare + accel + manipulare;
  const rolePeOra = imparte(3600, ciclu);
  const atentie =
    masina && masina.cheie === "normala" && core && core.cheie !== "manual"
      ? "ATENȚIE: mașina normală face doar role manuale simple"
      : "";

  // COST PE ROLĂ
  const costJumbo = nr(x.jumbo_teoretic) * pret;
  const roleDinJumbo = String(x.intregi).toUpperCase() === "DA" ? Math.floor(imparte(nr(x.jumbo_util), kg)) : imparte(nr(x.jumbo_util), kg);
  const material = imparte(costJumbo, roleDinJumbo);
  const pretCore = nr(core && core.pret);
  const electricitate = (nr(p.energie) * kw * ciclu) / 3600;
  const manopera = imparte(imparte((nr(p.salariu) * (1 + nr(p.contributii) / 100)), nr(p.ore_luna)) * nr(p.operatori), rolePeOra);
  const alte = nr(x.alte);
  const costRola = material + pretCore + electricitate + manopera + alte;
  const pretRola = costRola * (1 + nr(x.adaos) / 100);

  // INDICATORI
  const materialFaraPierderi = kg * pret;
  const kgCore = nr(core && core.kg);

  // TOTAL COMANDĂ
  const role = nr(x.role);
  const costTotal = role * costRola;
  const vanzare = role * pretRola;

  return {
    pretRonKg: pret,
    pretEurKg: imparte(pret, curs),
    lungime,
    viteza,
    kw,
    bobinare,
    accel,
    manipulare,
    ciclu,
    rolePeOra,
    atentie,
    costJumbo,
    roleDinJumbo,
    material,
    core: pretCore,
    electricitate,
    manopera,
    alte,
    costRola,
    costRolaEur: imparte(costRola, curs),
    pretRola,
    pretRolaEur: imparte(pretRola, curs),
    materialFaraPierderi,
    costPierderi: material - materialFaraPierderi,
    pierdere: imparte(material, materialFaraPierderi) - (materialFaraPierderi ? 1 : 0),
    costPeKg: imparte(costRola, kg),
    kgCore,
    kgBrut: kg + kgCore,
    jumboNecesare: roleDinJumbo ? Math.ceil(role / roleDinJumbo - 1e-12) : 0,
    netLivrat: role * kg,
    brutComanda: role * (kg + kgCore),
    oreMasina: imparte(role, rolePeOra),
    costTotal,
    vanzare,
    vanzareEur: imparte(vanzare, curs),
    profit: vanzare - costTotal,
  };
}

// Prețul folosit, după sursă. Manual: EUR/kg × curs. Din stoc: RON/kg, cum
// e pe paleți. Întoarce și de unde vine, ca pagina să-l poată spune.
function pretFolosit(x, stoc) {
  const sursa = String(x.sursa || "manual");
  if (sursa === "medie") {
    const m = stoc && stoc.medie;
    return m && m.pret > 0
      ? { pret: m.pret, text: `media ponderată a paleților de jumbo cu preț din CT-Park (${m.kgCuPret.toLocaleString("ro-RO", { maximumFractionDigits: 1 })} kg)` }
      : { pret: 0, text: "niciun palet de jumbo stretch din CT-Park n-are preț", lipsa: true };
  }
  if (sursa === "produs") {
    const p = ((stoc && stoc.produse) || []).find((y) => String(y.cheie) === String(x.produs_id));
    if (!p) return { pret: 0, text: "alege jumbo-ul din stoc", lipsa: true };
    return p.pret > 0 ? { pret: p.pret, text: `${p.denumire}, media paleților cu preț` } : { pret: 0, text: `${p.denumire} n-are preț pe paleți`, lipsa: true };
  }
  return { pret: nr(x.pret_eur) * nr(x.curs), text: "preț scris de mână, în EUR/kg × curs" };
}

module.exports = { CORE, MASINI, PARAMETRI, INTRARI, calculeaza, pretFolosit };
