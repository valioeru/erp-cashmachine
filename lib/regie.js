"use strict";
// Ce dintr-o rețetă e marfă și ce e cost al firmei.
//
// CE A OBSERVAT VALI, 29.10.2026: „la cost marfă, comenzi din producție, din
// rețete — în rețete sunt activele firmei și nu e corect."
//
// Rețetele vin din rapoartele de producție din SmartBill, iar acolo
// contabilitatea pune pe consum, lângă materia primă, și costurile firmei
// repartizate pe lot: „Salarii - Salarii", „Transport - Transport",
// „Energie electrica - Electricitate". Puntea le citea ca pe niște
// componente oarecare, deci intrau în „costul marfă" al produsului.
//
// Pentru contabilitate e corect — costul de producție include manopera și
// regia. Pentru ce arată ERP-ul aici nu e: „cost marfă" înseamnă ce material
// intră în produs. Salariile și curentul nu se cumpără pe bucată de pungă, și
// nici nu se mișcă proporțional cu ea; amestecate în cost, fac marja de pe un
// produs să depindă de cum a repartizat contabilul regia luna aia.
//
// Deci: liniile astea NU se șterg din rețetă — rămân acolo, vizibile, ca
// „cost al firmei" — dar nu mai intră în costul marfă.
//
// Recunoașterea e după nume, și strictă: denumirea trebuie să ÎNCEAPĂ cu
// costul („Transport - Transport", „Chirie hală") și să fie scurtă. Prima
// variantă căuta cuvântul oriunde și a luat „Folie stretch transport palet"
// drept regie — o folie, adică marfă pură, ar fi ieșit din cost. Dacă un
// material ar fi totuși luat drept regie, s-ar vedea imediat pe rețetă, la
// „costuri ale firmei", nu ar dispărea în tăcere.

const CUVINTE = [
  "salarii", "salariu", "salariale", "manopera", "manoperă",
  "transport",
  "energie", "electricitate", "curent electric",
  "chirie", "chirii", "utilitati", "utilități",
  "amortizare", "amortizari", "amortizări",
  "regie", "cheltuieli indirecte",
  "gaze naturale", "apa si canal", "apă și canal",
];

function faraDiacritice(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .toLowerCase();
}

const TIPARE = CUVINTE.map((c) => new RegExp("^" + faraDiacritice(c).replace(/\s+/g, "\\s+") + "([^a-z]|$)"));
const MAX_CUVINTE = 4;

function eRegie(denumire) {
  // „Salarii - Salarii": SmartBill scrie „denumire - categorie"; contează
  // partea dinaintea liniuței.
  const cap = faraDiacritice(denumire).split(/\s+-\s+/)[0].replace(/\s+/g, " ").trim();
  if (!cap) return false;
  if (cap.split(" ").length > MAX_CUVINTE) return false;
  return TIPARE.some((re) => re.test(cap));
}

module.exports = { CUVINTE, eRegie };
