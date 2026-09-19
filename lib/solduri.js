"use strict";
// Ce înseamnă „factură deschisă" — scris o singură dată, folosit peste tot.
//
// DE CE există fișierul ăsta:
//
// Fiecare modul își scria singur condiția de „mai are de plătit / de încasat",
// iar condițiile au divergat în timp. Pe 19.09.2026, aceeași bază spunea în
// trei locuri trei lucruri: scadențarul de grup 56,4 milioane de plătit,
// Financiar 51,1 milioane, iar raportul de restanțe altceva. Nu era niciun
// calcul greșit — erau trei definiții diferite ale aceluiași cuvânt.
//
// Regula, de aici încolo, într-un singur loc:
//
//   1. „platita" înseamnă achitat, indiferent ce scrie în tabelul de plăți.
//      La import, o factură marcată achitată în SmartBill primește statusul,
//      dar NU i se mai naște o plată (plata inventată pe data facturii strica
//      luna încasării). Pentru achiziții nu există deloc plăți în ERP, fiindcă
//      singura sursă de plăți e raportul de încasări, care merge doar pe
//      vânzări. Fără regula asta, orice factură de furnizor achitată vreodată
//      rămânea „de plătit" pe vecie.
//   2. O factură închisă ca istorie veche (`inchis_istoric`) e ieșită din
//      joc. Vezi /rapoarte/inchide-istoric: soldurile de dinaintea unui prag
//      ales de administrator s-au închis dintr-o dată, ca ERP-ul să arate cât
//      arată balanța. Condiția stă și aici, nu doar pe status, ca o eventuală
//      recalculare de status să nu le poată reînvia.
//
// Atenție la folosire: condiția asta se pune numai unde se calculează un
// SOLD. Acolo unde se calculează o CIFRĂ DE AFACERI (rulaj, vânzări pe 12
// luni) NU are ce căuta — o factură încasată e cu atât mai mult vânzare.
// Când o interogare scoate și sold, și rulaj, condiția intră în CASE-ul
// soldului, nu în WHERE.

const SUB_NET =
  "(SELECT factura_id, SUM(cantitate * pret_unitar) AS net FROM facturi_linii GROUP BY factura_id)";
const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT =
  "(SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)";

// Fragmentul de SQL pentru „factura asta mai are sold". `alias` e numele sub
// care e adusă tabela facturi în interogare (aproape întotdeauna „f").
function deschisa(alias) {
  const a = alias || "f";
  return `${a}.status NOT IN ('anulata','ciorna','necunoscut','platita') AND ${a}.inchis_istoric IS NULL`;
}

module.exports = { SUB_NET, SUB_TOTAL, SUB_PLATIT, deschisa };
