"use strict";
// Alegerea transportatorului.
//
// CE APARA:
//
//   • UN PALET LA TIMISOARA NU SE DUCE CU MASINA NOASTRA. Cazul pe care l-a
//     dat Vali, cu cifre reale: dubita costa de opt ori cat Palex si ajunge
//     mai tarziu. Daca testul asta pica, ERP-ul te sfatuieste sa pierzi bani.
//
//   • MASINA SE SOCOTESTE DUS-INTORS. Capcana standard: se trece doar dusul,
//     iese jumatate din pretul real si transportul propriu pare ieftin.
//
//   • O MASINA NECONFIGURATA NU COSTA ZERO. Daca ar costa zero ar castiga
//     fiecare clasament.
//
//   • MASINA REZERVATA NU E O OPTIUNE MAI SCUMPA, E UNA CARE NU EXISTA.
//
//   • O OFERTA EXPIRATA NU SE FOLOSESTE IN TACERE.
//
//   • CEL MAI IEFTIN CARE NU AJUNGE LA TIMP NU E CEL MAI IEFTIN.
const path = require("path");
const T = require(path.join(__dirname, "lib", "transport-cost.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu ? "  -> " + detaliu : "")); esecuri++; }
}

// --- Cifre reale, ca sa nu testam o fantezie -------------------------------

// Dubita de 3,5 t a firmei.
const DUBITA = {
  id: 1, nume: "Dubita 3,5t",
  consum_l_100km: 12, pret_carburant: 7.8, cost_km_uzura: 0.35,
  cost_ora_sofer: 40, diurna_zi: 150, taxe_cursa: 50,
  viteza_medie_kmh: 70, ore_incarcare: 2, ore_max_zi: 9,
  capacitate_kg: 1200, capacitate_paleti: 6,
  rezervari: [],
};

// Reteaua de paletizare: pret pe palet, 2 zile, oriunde in tara.
const PALEX = {
  id: 2, nume: "Palex",
  oferta: { id: 20, valabil_de_la: "2026-01-01", valabil_pana_la: "2026-12-31", moneda: "RON", suprataxa_combustibil_pct: 0 },
  tarife: [{ id: 200, fel: "palet", pret: 300, zile_livrare: 2, capacitate_paleti: 10 }],
};

const TIMISOARA = {
  judet: "Timis", localitate: "Timisoara", km: 550,
  greutate_kg: 400, paleti: 1,
  data_ridicare: "2026-10-26", data_livrare_ceruta: "2026-10-30",
};

console.log("\n1. Un palet la Timisoara — cazul care da tonul");
{
  const r = T.clasament({ externi: [PALEX], interne: [DUBITA] }, TIMISOARA, { azi: "2026-10-23" });
  bine("amandoua variantele intra in clasament", r.variante.length === 2, JSON.stringify(r.excluse));
  bine("castiga Palex, nu dubita", r.recomandat && r.recomandat.nume === "Palex", r.recomandat && r.recomandat.nume);

  const intern = r.variante.find((v) => v.fel === "intern");
  bine("dubita trece de 2000 lei dus-intors", intern.cost > 2000, String(intern.cost));
  bine("si e de cel putin 5 ori mai scumpa decat Palex", intern.cost > 300 * 5, String(intern.cost));
  bine("dubita are nevoie de 2 zile, Palex tot de 2", intern.zile === 2);
  bine(
    "clasamentul spune explicit ca reteaua bate masina proprie",
    r.avertismente.some((a) => /rețeaua de paletizare/.test(a)),
    JSON.stringify(r.avertismente)
  );
}

console.log("\n2. Dus-intors, nu doar dus");
{
  const c = T.costIntern(DUBITA, TIMISOARA, {});
  bine("kilometrii socotiti sunt 1100, nu 550", c.detaliu.km_total === 1100, String(c.detaliu.km_total));
  // 11 sute de km × 12 l × 7,8 lei = 1029,60
  bine("motorina e pe 1100 km", Math.abs(c.detaliu.combustibil - 1029.6) < 0.5, String(c.detaliu.combustibil));
  bine("omul e platit", c.detaliu.sofer > 600, String(c.detaliu.sofer));
  bine("diurna apare cand cursa tine mai mult de o zi", c.detaliu.diurna === 300, String(c.detaliu.diurna));

  const retur = T.costIntern(DUBITA, TIMISOARA, { retur_cu_marfa: true });
  bine("cu retur platit de altcineva se pune doar dusul", retur.detaliu.km_total === 550);
  bine("si iese mai ieftin decat dus-intors", retur.cost < c.cost);
  bine("dar se vede ca a fost o alegere", retur.detaliu.retur_cu_marfa === true);

  // O cursa scurta nu plateste diurna.
  const scurt = T.costIntern(DUBITA, { km: 40, greutate_kg: 100, paleti: 1 }, {});
  bine("cursa de o zi nu are diurna", scurt.detaliu.diurna === 0, String(scurt.detaliu.diurna));
  bine("si tot are motorina si om", scurt.cost > 0);
}

console.log("\n3. Masina neconfigurata nu costa zero");
{
  const goala = { id: 9, nume: "Camion nou", capacitate_kg: 20000, rezervari: [] };
  const r = T.clasament({ externi: [PALEX], interne: [goala] }, TIMISOARA, { azi: "2026-10-23" });
  bine("nu intra in clasament", !r.variante.some((v) => v.fel === "intern"));
  bine(
    "si se spune ce lipseste",
    r.excluse.some((e) => /consumul la sută|prețul carburantului/.test(e.motiv)),
    JSON.stringify(r.excluse)
  );
  bine("castiga tot Palex, nu masina de zero lei", r.recomandat.nume === "Palex");
}

console.log("\n4. Masina rezervata");
{
  const ocupata = Object.assign({}, DUBITA, {
    rezervari: [{ de_la: "2026-10-26", pana_la: "2026-10-27", ce: "livrare Ploiesti" }],
  });
  const r = T.clasament({ externi: [PALEX], interne: [ocupata] }, TIMISOARA, { azi: "2026-10-23" });
  bine("nu apare ca varianta", !r.variante.some((v) => v.fel === "intern"));
  bine(
    "si se spune pentru ce e luata",
    r.excluse.some((e) => /livrare Ploiesti/.test(e.motiv)),
    JSON.stringify(r.excluse)
  );

  const dupa = Object.assign({}, DUBITA, {
    rezervari: [{ de_la: "2026-11-10", pana_la: "2026-11-11", ce: "altceva" }],
  });
  const r2 = T.clasament({ externi: [PALEX], interne: [dupa] }, TIMISOARA, { azi: "2026-10-23" });
  bine("o rezervare din alta saptamana nu deranjeaza", r2.variante.some((v) => v.fel === "intern"));

  const anulata = Object.assign({}, DUBITA, {
    rezervari: [{ de_la: "2026-10-26", pana_la: "2026-10-27", ce: "x", stare: "anulata" }],
  });
  bine("rezervarea anulata nu blocheaza", T.estLiber(anulata, "2026-10-26", "2026-10-27").liber);
}

console.log("\n5. Oferta expirata");
{
  const vechi = {
    id: 3, nume: "Transporturi 2025",
    oferta: { id: 30, valabil_de_la: "2025-01-01", valabil_pana_la: "2025-12-31", moneda: "RON" },
    tarife: [{ id: 300, fel: "palet", pret: 150, zile_livrare: 2 }],
  };
  const r = T.clasament({ externi: [vechi, PALEX], interne: [] }, TIMISOARA, { azi: "2026-10-23" });
  bine("pretul de anul trecut nu castiga", r.recomandat.nume === "Palex", r.recomandat && r.recomandat.nume);
  bine(
    "se spune ca a expirat si ce sa faci",
    r.excluse.some((e) => /a expirat pe 2025-12-31.*tarif nou/.test(e.motiv)),
    JSON.stringify(r.excluse)
  );

  const viitor = {
    id: 4, nume: "Tarif 2027",
    oferta: { id: 40, valabil_de_la: "2027-01-01", moneda: "RON" },
    tarife: [{ id: 400, fel: "palet", pret: 100 }],
  };
  const r2 = T.clasament({ externi: [viitor], interne: [] }, TIMISOARA, { azi: "2026-10-23" });
  bine("nici tariful care intra in vigoare la anul", !r2.variante.length);
}

console.log("\n6. Cel mai ieftin care nu ajunge la timp");
{
  const lent = {
    id: 5, nume: "Ieftin si lent",
    oferta: { id: 50, moneda: "RON" },
    tarife: [{ id: 500, fel: "palet", pret: 120, zile_livrare: 9 }],
  };
  const urgent = Object.assign({}, TIMISOARA, { data_ridicare: "2026-10-26", data_livrare_ceruta: "2026-10-29" });
  const r = T.clasament({ externi: [lent, PALEX], interne: [] }, urgent, { azi: "2026-10-23" });
  bine("cel ieftin e primul la pret", r.variante[1].nume === "Ieftin si lent" || r.variante[0].nume === "Palex");
  bine("dar recomandarea e Palex", r.recomandat.nume === "Palex", r.recomandat && r.recomandat.nume);
  bine("si se vede ca celalalt intarzie", r.variante.find((v) => v.nume === "Ieftin si lent").in_termen === false);
  bine("cu cate zile", r.variante.find((v) => v.nume === "Ieftin si lent").intarziere === 6, String(r.variante.find((v) => v.nume === "Ieftin si lent").intarziere));

  // Daca nimeni nu prinde termenul, se spune, nu se alege in tacere.
  const imposibil = Object.assign({}, TIMISOARA, { data_ridicare: "2026-10-26", data_livrare_ceruta: "2026-10-26" });
  const r2 = T.clasament({ externi: [PALEX], interne: [] }, imposibil, { azi: "2026-10-23" });
  bine("nimeni nu prinde: nicio recomandare", r2.recomandat === null);
  bine(
    "si scrie sa suni clientul inainte sa aloci",
    r2.avertismente.some((a) => /sună clientul/.test(a)),
    JSON.stringify(r2.avertismente)
  );
}

console.log("\n7. Formele de tarif");
{
  const exp = { judet: "Timis", localitate: "Timisoara", km: 550, greutate_kg: 400, paleti: 2 };
  bine("pe cursa", T.costTarif({ fel: "cursa", pret: 900 }, exp, {}).cost === 900);
  bine("pe palet", T.costTarif({ fel: "palet", pret: 300 }, exp, {}).cost === 600);
  bine("pe kg", T.costTarif({ fel: "kg", pret: 1.2 }, exp, {}).cost === 480);
  bine("pe km", T.costTarif({ fel: "km", pret: 4.5 }, exp, {}).cost === 2475);

  const cuSupra = T.costTarif({ fel: "palet", pret: 300 }, exp, { suprataxa_combustibil_pct: 10 });
  bine("suprataxa de combustibil se adauga", cuSupra.cost === 660, String(cuSupra.cost));

  const mic = { paleti: 1, greutate_kg: 2, km: 400 };
  const cuMinim = T.costTarif({ fel: "kg", pret: 1.2, pret_minim: 250 }, mic, {});
  bine("pretul minim salveaza coletul de 2 kg", cuMinim.cost === 250);
  bine("si se vede ca s-a aplicat", cuMinim.detaliu.aplicat_minim === true);
}

console.log("\n8. Ce tarif se potriveste");
{
  const exp = { judet: "Timis", localitate: "Timisoara", km: 550, greutate_kg: 400, paleti: 1 };
  bine("fara restrictii se potriveste oricui", T.potrivire({ fel: "palet" }, exp).da);
  bine("pe judet", T.potrivire({ fel: "palet", judet: "Timis" }, exp).da);
  bine("pe alt judet, nu", !T.potrivire({ fel: "palet", judet: "Cluj" }, exp).da);
  bine("diacriticele nu strica potrivirea", T.potrivire({ fel: "palet", localitate: "Timișoara" }, exp).da);
  bine("nici literele mari", T.potrivire({ fel: "palet", localitate: "TIMISOARA" }, exp).da);
  bine("transa de greutate de sus", !T.potrivire({ fel: "kg", greutate_pana_la: 100 }, exp).da);
  bine("transa de greutate de jos", !T.potrivire({ fel: "kg", greutate_de_la: 1000 }, exp).da);
  bine("transa potrivita", T.potrivire({ fel: "kg", greutate_de_la: 100, greutate_pana_la: 500 }, exp).da);

  // Un tarif pe km fara km nu da zero, da „nu stiu”.
  bine("tarif pe km fara km nu se aplica", !T.potrivire({ fel: "km" }, { judet: "Timis" }).da);
  bine(
    "si spune de ce",
    /n-are kilometri/.test(T.potrivire({ fel: "km" }, { judet: "Timis" }).motiv)
  );

  // Randul scris anume pentru Timisoara bate randul general, chiar daca e
  // mai scump: ala e pretul negociat, celalalt e lista de pret.
  const t = {
    id: 6, nume: "Mixt",
    oferta: { id: 60, moneda: "RON" },
    tarife: [
      { id: 601, fel: "palet", pret: 250, zile_livrare: 3 },
      { id: 602, fel: "palet", pret: 280, localitate: "Timisoara", zile_livrare: 1 },
    ],
  };
  const r = T.clasament({ externi: [t], interne: [] }, exp, { azi: "2026-10-23" });
  bine("tariful specific castiga in fata celui general", r.variante[0].tarif_id === 602, String(r.variante[0].tarif_id));
}

console.log("\n9. Capacitatea taie inaintea pretului");
{
  const mult = { judet: "Timis", localitate: "Timisoara", km: 550, greutate_kg: 3000, paleti: 12 };
  const r = T.clasament({ externi: [PALEX], interne: [DUBITA] }, mult, { azi: "2026-10-23" });
  bine("dubita de 1200 kg nu duce 3000", !r.variante.some((v) => v.fel === "intern"));
  bine(
    "si se spune cu cifre, nu „nu se poate”",
    r.excluse.some((e) => /duce 1200 kg, expediția are 3000 kg/.test(e.motiv)),
    JSON.stringify(r.excluse)
  );
  bine("nici Palex, care are plafon 10 paleti", !r.variante.some((v) => v.nume === "Palex"));
  // Capcana: Palex ARE tarif pentru Timisoara, doar ca nu incape marfa.
  // Daca scrie „n-are tarif", omul cere o oferta pe care o are deja in ERP.
  bine(
    "si motivul lui Palex e capacitatea, nu lipsa tarifului",
    r.excluse.some((e) => e.nume === "Palex" && /ia 10 paleți, expediția are 12/.test(e.motiv)),
    JSON.stringify(r.excluse)
  );
  bine(
    "cu indicatia ce sa faca: doua curse sau oferta de camion",
    r.excluse.some((e) => e.nume === "Palex" && /două curse/.test(e.motiv))
  );
  bine("nicio varianta, si se spune", r.avertismente.some((a) => /Nicio variantă/.test(a)));
}

console.log("\n10. Kilometri necunoscuti");
{
  const faraKm = { judet: "Timis", localitate: "Lugoj", greutate_kg: 400, paleti: 1 };
  const r = T.clasament({ externi: [PALEX], interne: [DUBITA] }, faraKm, { azi: "2026-10-23" });
  bine("Palex merge si fara km, tariful lui e pe palet", r.variante.some((v) => v.nume === "Palex"));
  bine("dubita nu, si cere distanta", r.excluse.some((e) => /Nu știm câți kilometri/.test(e.motiv)), JSON.stringify(r.excluse));
  bine("mesajul spune ca se scrie o data si se tine minte", r.excluse.some((e) => /se ține minte/.test(e.motiv)));
}

console.log("\n11. Moneda");
{
  const inEuro = {
    id: 7, nume: "Extern EUR",
    oferta: { id: 70, moneda: "EUR" },
    tarife: [{ id: 700, fel: "palet", pret: 60, zile_livrare: 2 }],
  };
  const faraCurs = T.clasament({ externi: [inEuro, PALEX], interne: [] }, TIMISOARA, { azi: "2026-10-23" });
  bine("fara curs nu se compara cu lei", faraCurs.variante.find((v) => v.nume === "Extern EUR").cost_lei === null);
  bine("si se spune", faraCurs.avertismente.some((a) => /cursul/.test(a)));
  bine("castiga cel in lei, nu cel necomparabil", faraCurs.recomandat.nume === "Palex");

  const cuCurs = T.clasament({ externi: [inEuro, PALEX], interne: [] }, TIMISOARA, { azi: "2026-10-23", curs_eur: 5.1 });
  bine("cu curs, 60 EUR = 306 lei", cuCurs.variante.find((v) => v.nume === "Extern EUR").cost_lei === 306);
  bine("si pierde la 300 lei ai lui Palex", cuCurs.recomandat.nume === "Palex");
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
