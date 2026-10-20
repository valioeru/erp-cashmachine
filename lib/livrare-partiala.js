"use strict";
// Livrarea parțială: întrebarea pusă agentului la plasarea comenzii, și ce
// face depozitul cu răspunsul.
//
// De ce trăiește aici și nu în modules/comenzi.js: regula o folosesc și
// comenzile (agentul), și depozitul (operatorul). modules/comenzi.js cere
// deja modules/warehouse.js; dacă aș pune regula acolo și aș cere-o din
// depozit, importul s-ar închide în cerc și unul dintre module ar primi un
// obiect gol la pornire. Un fișier mic în lib/ nu cere nimic înapoi, deci
// nu are cum să se încurce.
//
// Cele trei răspunsuri, nu două:
//   "da"   — clientul acceptă să primească ce e pe stoc acum, restul mai târziu
//   "nu"   — clientul vrea comanda întreagă sau nimic
//   null   — nimeni n-a întrebat (comenzi de dinainte de coloana asta)
//
// NULL se tratează ca „nu", dar nu se afișează ca „nu". Diferența contează:
// un „nu" e o decizie a clientului, iar NULL e o întrebare pe care am uitat
// s-o punem. Dacă le-aș arăta la fel, nimeni n-ar mai pune întrebarea.

const DA = "da";
const NU = "nu";

function raspuns(comanda) {
  const v = String((comanda && comanda.livrare_partiala) || "").trim().toLowerCase();
  return v === DA || v === NU ? v : null;
}

function valid(valoare) {
  const v = String(valoare || "").trim().toLowerCase();
  return v === DA || v === NU ? v : null;
}

// Are voie depozitul să trimită doar o parte din comandă?
// Fără răspuns, nu are. Marfa plecată pe jumătate la un client care voia
// totul se întoarce, iar transportul îl plătim noi.
function acceptaPartial(comanda) {
  return raspuns(comanda) === DA;
}

function eticheta(comanda) {
  const r = raspuns(comanda);
  if (r === DA) return '<span class="badge verde">acceptă livrare parțială</span>';
  if (r === NU) return '<span class="badge rosu">doar comanda completă</span>';
  return '<span class="badge galben">nu s-a întrebat</span>';
}

function text(comanda) {
  const r = raspuns(comanda);
  if (r === DA) return "acceptă livrare parțială";
  if (r === NU) return "doar comanda completă";
  return "nu s-a întrebat";
}

// Unde ajunge comanda după ce depozitul se uită la stoc.
//
//   tot pe stoc                      → în stoc depozit (pleacă spre livrare)
//   parțial, iar clientul acceptă    → în stoc depozit (pleacă cât e, restul rămâne pe comandă)
//   parțial sau nimic, fără acceptul → așteaptă marfă (drumul continuă prin aprovizionare)
//
// „Așteaptă marfă" nu e o fundătură: comanda rămâne în lista depozitului,
// aprovizionarea sau producția o alimentează, iar când stocul acoperă tot,
// warehouse.js o trece singură pe „în stoc depozit".
function statusDupaVerificare({ acoperiteTot, acoperitePartial, comanda }) {
  if (acoperiteTot) return "in_stoc_depozit";
  if (acoperitePartial && acceptaPartial(comanda)) return "in_stoc_depozit";
  return "asteapta_marfa";
}

module.exports = { DA, NU, raspuns, valid, acceptaPartial, eticheta, text, statusDupaVerificare };
