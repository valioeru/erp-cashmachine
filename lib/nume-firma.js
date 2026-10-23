"use strict";
// „S.C." din fața numelui de firmă.
//
// Aproape toți partenerii din bază sunt scriși „SC CEVA SRL". Prefixul nu
// spune nimic — e pe toți — dar strică două lucruri în fiecare zi:
//
//   • SORTAREA. Lista alfabetică începe cu 400 de „S" și se termină cu
//     „Zamolxe". Nu se poate ajunge la o firmă derulând.
//   • CĂUTAREA DUPĂ PRIMELE LITERE. Scrii „a" ca să ajungi la Aquila și
//     primești tot ce conține un „a" oriunde, adică toată baza.
//
// CE TREBUIE SĂ NU SE STRICE, și e partea care contează:
//
// Importul de facturi potrivește partenerii întâi pe CUI și, dacă lipsește,
// pe NUMELE scris cu litere mici (vezi modules/import.js). Dacă tai „SC" din
// bază dar factura de luna viitoare vine tot cu „SC AQUILA SRL", potrivirea
// pe nume cade și se creează un partener nou — adică exact duplicatul pe
// care am încercat ani de zile să-l evităm. De-aia aici sunt DOUĂ funcții,
// nu una:
//
//   faraSC()      — pentru ce se AFIȘEAZĂ și se scrie în bază
//   cheieNume()   — pentru ce se COMPARĂ; ignoră prefixul în ambele sensuri,
//                   deci „SC Aquila SRL" și „Aquila SRL" dau aceeași cheie
//
// Cât timp potrivirile folosesc cheia, numele se poate scrie oricum.

// „SC", „S.C.", „S.C", „Soc.", cu sau fără punct final, urmate de spațiu.
// Se taie DOAR de la început: „Prod SC Ceva" nu se atinge, fiindcă acolo
// „SC" e parte din nume.
const PREFIX = /^(?:s\s*\.?\s*c\s*\.?|soc(?:ietatea)?\s*\.?)\s+/i;

// Numele unei firme care CHIAR se cheamă „SC" și atât n-ar mai rămâne cu
// nimic. Nu se taie în gol.
function faraSC(nume) {
  const s = String(nume == null ? "" : nume).trim().replace(/\s+/g, " ");
  if (!s) return s;
  const taiat = s.replace(PREFIX, "").trim();
  return taiat ? taiat : s;
}

// Se schimbă ceva dacă tăiem? Folosit ca să nu scriem în bază degeaba.
function areSC(nume) {
  const s = String(nume == null ? "" : nume).trim();
  return s !== faraSC(s);
}

// Cheia pe care se compară două nume de firmă. Fără diacritice, fără
// prefixul „SC", fără spații duble, litere mici. NU taie forma juridică de
// la coadă — asta o face lib/monday-import.js, care are nevoie de o potrivire
// mai agresivă; aici vrem doar ca prefixul să nu mai conteze.
function cheieNume(nume) {
  return faraSC(nume)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Textul după care caută căsuța de căutare. Conține și forma cu „SC", și cea
// fără: cine scrie din obișnuință „sc aquila" tot trebuie să găsească.
function textCautare(nume, cui) {
  const intreg = String(nume == null ? "" : nume).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const scurt = cheieNume(nume);
  const c = String(cui == null ? "" : cui).toLowerCase().trim();
  return [scurt, intreg !== scurt ? intreg : "", c].filter(Boolean).join(" ");
}

module.exports = { PREFIX, faraSC, areSC, cheieNume, textCautare };
