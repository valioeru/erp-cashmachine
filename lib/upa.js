"use strict";
// Factura pe unitate protejată autorizată (UPA).
//
// CEREREA LUI VALI, 17.11.2026: „Comanda trebuie să conțină și o bifă dacă
// factura va fi sau nu pe unitate protejată. Dacă va fi, va avea serie cu UPA;
// dacă nu, seria normală. Numărul va fi următorul la rând, iar seriile cu UPA
// sau nu le vezi în facturi. Totodată, facturile cu UPA trebuie să conțină
// detaliile speciale." — „Sunt scrise pe facturile cu UPA deja."
//
// CE S-A LUAT DIN FACTURILE EXISTENTE (citit din SmartBill, CSHMUPA0084):
//   • seria: CSHMUPA (cea normală e CSHM);
//   • mențiunea de sub total, aceeași pe fiecare factură UPA, cu numele
//     clientului în ea. Textul de mai jos e cel de pe factură, literă cu literă.
//
// Numărul nu-l dă ERP-ul: SmartBill pune următorul număr din seria cerută.
// Fără bază de date.

const SERIE_UPA_IMPLICITA = "CSHMUPA";

const eUpa = (doc) => Number(doc && doc.upa) === 1;

// Seria cu care pleacă factura în SmartBill. Cea normală vine din mediu
// (SMARTBILL_SERIE); dacă lipsește, SmartBill o alege pe cea implicită a lui.
function serie(factura, env) {
  const e = env || process.env;
  if (eUpa(factura)) return String(e.SMARTBILL_SERIE_UPA || "").trim() || SERIE_UPA_IMPLICITA;
  return String(e.SMARTBILL_SERIE || "").trim() || undefined;
}

function mentiune(numeClient) {
  const client = String(numeClient || "").trim() || "client";
  return (
    `Produsele livrate catre ${client} sunt realizate prin activitatea proprie a personalului angajat al CASH MACHINE SRL, ` +
    "in cadrul Unitatii Protejate Autorizate, cu implicarea persoanelor cu dizabilitati/handicap angajate, acestea reprezentand " +
    "minimum 50% din personalul implicat in activitatea aferenta a companiei, conform art. 78 alin. (3) lit. b) din Legea nr. 448/2006 " +
    "privind protectia si promovarea drepturilor persoanelor cu handicap, cu modificarile si completarile ulterioare."
  );
}

// Ce se scrie pe pagină lângă comandă sau factură.
const eticheta = (doc) => (eUpa(doc) ? "unitate protejată (UPA)" : "serie normală");

module.exports = { SERIE_UPA_IMPLICITA, eUpa, serie, mentiune, eticheta };
