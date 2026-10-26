"use strict";
// Familiile de produse si atributele lor, ca date pure.
//
// Stau separat de modul fiindca modulul atarna de baza de date, iar lista asta
// trebuie sa poata fi verificata fara ea: testul ii da fiecarei familii
// alegerile din exemplu si se uita daca iese exact codul promis. Fara testul
// ala, o litera schimbata din greseala la „Imprimare" ar trece neobservata
// pana cand cineva cauta un produs dupa cod si nu-l gaseste.
//
// Forma unui rand de caracteristica:
//   [nume, fel, um, ordine, cifre, valori, min, max, inCod, obligatoriu]
// „valori" e lista [eticheta, bucata de cod] la caracteristicile de tip lista.
// „inCod" si „obligatoriu" lipsesc cand sunt 1 — adica in majoritatea cazurilor.

// Punem familiile si atributele agreate cu Vali pe
// 26.10.2026 (vezi Atribute_produse_propunere.xlsx). Dimensiunile si grosimile
// nu sunt inventate — vin din fisa tehnica (lib/utilaje-date.js, PRODUSE_FISA),
// adica din ce se produce acum.
//
// Se pun o singura data, la o baza goala. Daca el le schimba sau le sterge, nu
// se mai intorc — altfel fiecare pornire de server ar da inapoi corecturile
// facute de om, care e cel mai bun mod de a-l convinge ca aplicatia e stricata.
const START = [
  ["Folie stretch", "FSMA10200", [
    ["Tip", "lista", null, 1, 0, [["Folie Stretch", "FS"], ["Folie Prestretch", "FP"]]],
    ["Aplicare", "lista", null, 2, 0, [["Manuală", "M"], ["Automată", "A"]]],
    ["Culoare", "lista", null, 3, 0, [["Transparent", "T"], ["Alb", "A"], ["Negru", "N"]]],
    ["Grosime", "numar", "microni", 4, 2, null, 4, 23],
    ["Lungime", "numar", "m", 5, 3, null],
  ]],
  ["Pungă curier", "PCIA35045045", [
    ["Tip", "lista", null, 1, 0, [["Pungă curier", "PC"]]],
    ["Imprimare", "lista", null, 2, 0, [["Neimprimată", "N"], ["Imprimată", "I"]]],
    ["Culoare folie", "lista", null, 3, 0, [["Alb", "A"], ["Transparent", "T"], ["Negru", "N"], ["Gri", "G"]]],
    ["Lățime", "numar", "mm", 4, 3, null],
    ["Lungime fără clapetă", "numar", "mm", 5, 3, null],
    ["Grosime", "numar", "microni", 6, 2, null],
    ["Clapetă", "numar", "mm", 7, 0, null, null, null, 0],
    ["Nr. culori", "numar", null, 8, 0, null, 0, 6, 0, 0],
    ["Tip închidere", "lista", null, 9, 0, [["Bandă adezivă", "B"], ["Sudată", "S"]], null, null, 0],
    ["Buc./cutie", "numar", null, 10, 0, null, null, null, 0, 0],
  ]],
  ["Sac SGR", "SSIA80075045", [
    ["Tip", "lista", null, 1, 0, [["Sac SGR", "SS"]]],
    ["Imprimare", "lista", null, 2, 0, [["Neimprimat", "N"], ["Imprimat", "I"]]],
    ["Culoare folie", "lista", null, 3, 0, [["Alb", "A"], ["Transparent", "T"], ["Negru", "N"]]],
    ["Lățime", "numar", "mm", 4, 3, null],
    ["Lungime", "numar", "mm", 5, 3, null],
    ["Grosime", "numar", "microni", 6, 2, null],
    ["Folie pliată", "lista", null, 7, 0, [["Da", "D"], ["Nu", "N"]], null, null, 0],
    ["Nr. culori", "numar", null, 8, 0, null, 0, 6, 0, 0],
  ]],
  ["Plic AWB", "PA17524025", [
    ["Tip", "lista", null, 1, 0, [["Plic AWB", "PA"]]],
    ["Lățime", "numar", "mm", 2, 3, null],
    ["Lungime", "numar", "mm", 3, 3, null],
    ["Grosime CPE", "numar", "microni", 4, 2, null],
    ["Buzunar documente", "lista", null, 5, 0, [["Da", "D"], ["Nu", "N"]], null, null, 0],
    ["Buc./pungă", "numar", null, 6, 0, null, null, null, 0, 0],
  ]],
  ["Sac menajer", "SMN1000120070", [
    ["Tip", "lista", null, 1, 0, [["Sac menajer", "SM"]]],
    ["Culoare", "lista", null, 2, 0, [["Negru", "N"], ["Alb", "A"], ["Transparent", "T"]]],
    ["Lățime", "numar", "mm", 3, 4, null],
    ["Lungime", "numar", "mm", 4, 4, null],
    ["Grosime", "numar", "microni", 5, 2, null],
    ["Fel", "lista", null, 6, 0, [["Tub", "T"], ["Pliat", "P"], ["Cu șnur", "S"]], null, null, 0],
    ["Buc./rolă", "numar", null, 7, 0, null, null, null, 0, 0],
  ]],
  ["Bandă adezivă", "BALT4890045", [
    ["Tip", "lista", null, 1, 0, [["Bandă adezivă", "BA"]]],
    ["Zgomot", "lista", null, 2, 0, [["Low noise", "L"], ["Normal", "N"]]],
    ["Culoare", "lista", null, 3, 0, [["Transparent", "T"], ["Maro", "M"], ["Alb", "A"], ["Negru", "N"]]],
    ["Lățime", "numar", "mm", 4, 2, null],
    ["Lungime rolă", "numar", "m", 5, 3, null],
    ["Grosime", "numar", "microni", 6, 2, null],
    ["Diametru core", "numar", "mm", 7, 0, null, null, null, 0],
  ]],
  ["Cutie carton", "CCA4003002003", [
    ["Tip", "lista", null, 1, 0, [["Cutie carton", "CC"]]],
    ["Fel", "lista", null, 2, 0, [["Americană", "A"], ["Simplă", "S"]]],
    ["Lungime", "numar", "mm", 3, 3, null],
    ["Lățime", "numar", "mm", 4, 3, null],
    ["Înălțime", "numar", "mm", 5, 3, null],
    ["Straturi carton", "numar", null, 6, 1, null, 3, 5],
    ["Imprimare", "lista", null, 7, 0, [["Neimprimată", "N"], ["Imprimată", "I"]], null, null, 0],
  ]],
  ["Folie debitată", "FDRT23500", [
    ["Tip", "lista", null, 1, 0, [["Folie debitată", "FD"]]],
    ["Material", "lista", null, 2, 0, [["Virgin", "V"], ["Reciclat", "R"], ["Mixt", "M"]]],
    ["Culoare", "lista", null, 3, 0, [["Transparent", "T"], ["Alb", "A"], ["Negru", "N"]]],
    ["Grosime", "numar", "microni", 4, 2, null],
    ["Lățime", "numar", "mm", 5, 3, null],
    ["Folie pliată", "lista", null, 6, 0, [["Da", "D"], ["Nu", "N"]], null, null, 0],
  ]],
];


module.exports = { START };
