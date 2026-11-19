"use strict";
// Firma care emite o factură de vânzare, și numărul facturilor Warehouse All.
//
// CEREREA LUI VALI, 19.11.2026: „Fă și la facturi la fel, să alegi pe ce le
// emiți, începând cu ultimul număr din SmartBill." · „Le băgăm noi și în
// SmartBill, nu le trimite direct decât dacă poți." · „Ai grijă la ambele să
// nu le duplici când aduci facturi."
//
// CUM MERGE
//   • Cash Machine: ca până acum. Factura pleacă în SmartBill la validare, iar
//     numărul fiscal îl dă SmartBill (lib/smartbill.js).
//   • Warehouse All: ERP-ul are legătură de trimitere doar cu firma Cash
//     Machine din SmartBill (un singur CIF în mediu). O factură Warehouse All
//     NU pleacă din ERP: primește aici numărul următor din seria ei —
//     continuarea ultimului număr adus din SmartBill — și omul o introduce în
//     SmartBill cu același număr. Trimisă pe legătura Cash Machine ar ieși
//     factură fiscală pe firma greșită, de îndreptat doar prin stornare, deci
//     fiecare drum spre SmartBill o oprește (modules/facturi.js).
//   • Fără dubluri: sincronizarea din SmartBill recunoaște o factură după
//     serie și număr, indiferent de firmă (modules/punte.js). Factura
//     Warehouse All poartă în ERP exact seria și numărul cu care e introdusă
//     în SmartBill, deci când vine înapoi nu se scrie a doua oară.
//
// „Ultimul număr din SmartBill" = cel mai mare număr din seria Warehouse All
// aflat în ERP (facturile ei sunt aduse de sincronizare). Administratorul
// poate ridica numărul următor de mână, dacă SmartBill e mai departe.
const db = require("./db");
const AV = require("./aviz");

const SERIE_WA_IMPLICITA = "WHA";
const cifre = (s) => String(s == null ? "" : s).replace(/[^0-9]/g, "");

// Rândul din tabela „firme" al firmei cu cheia dată ('cm' / 'wa'), sau null.
async function idFirma(cheie) {
  const f = AV.firmaEmitenta(cheie);
  const toate = await db.prepare("SELECT id, cui FROM firme").all().catch(() => []);
  const r = (toate || []).find((x) => cifre(x.cui) === cifre(f.date.cif));
  return r ? Number(r.id) : null;
}

// Cheia firmei care emite factura: 'wa' doar când firma_id e chiar Warehouse
// All; orice altceva (gol, Cash Machine, altă firmă din grup) e 'cm'.
async function cheie(factura) {
  const id = factura && factura.firma_id != null ? Number(factura.firma_id) : 0;
  if (!id) return "cm";
  const r = await db.prepare("SELECT cui FROM firme WHERE id = ?").get(id).catch(() => null);
  if (!r) return "cm";
  const f = AV.FIRME_EMITENTE.find((x) => cifre(x.date.cif) === cifre(r.cui));
  return f ? f.cheie : "cm";
}

// Seria și numărul următor ale facturilor Warehouse All.
async function contorWa() {
  const r = await db.prepare("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('factura_serie_wa', 'factura_urmator_wa')").all().catch(() => []);
  const m = {};
  for (const x of r || []) m[x.cheie] = x.valoare;
  const serie = String(m.factura_serie_wa || SERIE_WA_IMPLICITA).trim().toUpperCase() || SERIE_WA_IMPLICITA;
  const max = await db
    .prepare("SELECT COALESCE(MAX(numar), 0) AS n FROM facturi WHERE activ = 1 AND directie = 'vanzare' AND UPPER(TRIM(COALESCE(serie, ''))) = ?")
    .get(serie)
    .catch(() => ({ n: 0 }));
  const ultim = Number((max && max.n) || 0);
  const pus = Number(m.factura_urmator_wa) || 0;
  return { serie, ultim, pus, urmator: Math.max(ultim + 1, pus, 1) };
}

// Dă facturii numărul următor din seria Warehouse All și întoarce
// { serie, numar }. Numărul se calculează în aceeași instrucțiune care îl
// scrie, ca două validări apăsate deodată să nu ia același număr.
async function numeroteazaWa(facturaId) {
  const c = await contorWa();
  const r = await db
    .prepare(
      `UPDATE facturi SET serie = ?, numar = (
          SELECT GREATEST(COALESCE(MAX(x.numar), 0) + 1, ?) FROM facturi x
           WHERE x.activ = 1 AND x.directie = 'vanzare' AND UPPER(TRIM(COALESCE(x.serie, ''))) = ? AND x.id <> ?
        )
        WHERE id = ? RETURNING serie, numar`
    )
    .get(c.serie, Math.max(c.pus, 1), c.serie, Number(facturaId), Number(facturaId));
  if (!r || r.numar == null) throw new Error("Factura Warehouse All n-a primit număr.");
  // Același „document extern" pe care îl scrie sincronizarea: seria lipită de număr.
  await db.prepare("UPDATE facturi SET document_extern = ? WHERE id = ?").run(`${r.serie}${r.numar}`, Number(facturaId));
  return { serie: String(r.serie), numar: Number(r.numar) };
}

module.exports = { SERIE_WA_IMPLICITA, idFirma, cheie, contorWa, numeroteazaWa };
