"use strict";

// Identitatea unui document de facturare, scrisă într-un singur loc.
//
// De ce există fișierul ăsta
//
// Puntea și importul din fișier își construiau fiecare cheia lui de „am mai
// văzut factura asta?". Amândouă puneau în cheie numărul AȘA CUM VINE din
// SmartBill, și îl comparau cu numărul RECITIT DIN BAZĂ. Sunt două lucruri
// diferite: coloana e INTEGER, deci „0052" intră în bază ca 52.
//
// Seria CSHM nu e cu zerouri, deci mergea. Seria CSHMUPA e cu zerouri, deci
// nicio factură CSHMUPA n-a fost recunoscută vreodată ca fiind deja în bază, și
// s-a reintrodus la fiecare sincronizare: 9 documente în 20 de exemplare,
// 315.159 lei de vânzări care nu există. Curățate o dată pe 20.09, reapărute a
// doua zi — fiindcă s-au curățat exemplarele, nu cauza.
//
// Regula: un număr de document e același număr indiferent câte zerouri are în
// față. „0052", „52", „ 52 " și 52 sunt unul și același.
function numarDocument(v) {
  const s = String(v === null || v === undefined ? "" : v).trim();
  if (!s) return "";
  // Numai cifre (eventual cu zerouri în față): contează valoarea.
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  // Orice altceva (numere cu literă, bonuri fiscale, serii ciudate) rămâne cum
  // e, doar normalizat ca scriere — nu inventăm o valoare care nu există.
  return s.toUpperCase();
}

// Seria contează fără diferență între litere mari și mici; firma și partenerul
// intră întregi, ca două facturi cu același număr la firme diferite să rămână
// două facturi.
function cheiaFacturii(serie, numar, contextul) {
  return `${String(serie || "").trim().toUpperCase()}|${numarDocument(numar)}|${contextul || ""}`;
}

// „CSHMUPA0052" și „cshmupa 52" sunt același document extern. Se desparte
// partea de literă de partea de cifră, ca zerourile să cadă și aici.
function cheiaDocumentExtern(doc) {
  const s = String(doc || "").trim().toUpperCase().replace(/[\s._-]+/g, "");
  if (!s) return "";
  const m = s.match(/^([A-Z][A-Z0-9]*?)(\d+)$/);
  return m ? `${m[1]}${parseInt(m[2], 10)}` : s;
}

module.exports = { numarDocument, cheiaFacturii, cheiaDocumentExtern };
