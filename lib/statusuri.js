"use strict";
// Statusul facturii se recalculează din plăți — scris o singură dată.
//
// DE CE există fișierul ăsta:
//
// Statusul („emisă / încasată parțial / încasată") era recalculat DOAR de
// importul din Excel (/import/incasari). Încasările care vin prin punte —
// adică sincronizarea de noapte și butonul „Actualizează din SmartBill",
// deci drumul pe care intră astăzi aproape tot — scriau plata în tabelul
// `plati` și atât. Factura rămânea pe „emisă" oricâți bani ar fi intrat pe
// ea.
//
// Nu se vedea în cifre: „De încasat" din Financiar și scadențarul socotesc
// soldul din total minus plăți, deci ieșeau corect. Se vedea doar în coloana
// Status din lista de facturi, care arată chiar câmpul din bază — și acolo
// scria „emisă" pe facturi încasate de săptămâni.
//
// Regula, de aici încolo, într-un singur loc: după orice intrare de plăți,
// statusul se recalculează.
//
// Ce NU face: nu coboară niciodată o factură din „încasată" mai jos. La
// import, o factură marcată achitată în SmartBill primește statusul fără să i
// se nască o plată (vezi lib/solduri.js) — dacă am reseta-o fiindcă n-are
// plăți în tabel, am reînvia creanțe stinse de ani. Din același motiv nu o
// dăm nici pe „parțial" când plățile ei sunt mai mici decât totalul: flagul
// din SmartBill știe mai bine decât suma rândurilor pe care le avem noi.
// Statusul urcă, nu coboară; coborârea rămâne o decizie de om.
const db = require("./db");

const SUMA_PLATITA = `
  (SELECT factura_id, SUM(suma) s FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)`;
const TOTAL_CU_TVA = `
  (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) t FROM facturi_linii GROUP BY factura_id)`;

// Toleranța de 50 de bani: totalul se recompune din linii, iar rotunjirile
// SmartBill lasă uneori un ban-doi diferență. Fără ea, o factură încasată
// integral ar rămâne „parțial" pentru 0,01 lei.
const TOLERANTA = 0.5;

async function recalculeazaStatusFacturi() {
  const platite = await db
    .prepare(
      `UPDATE facturi SET status = 'platita'
        WHERE directie = 'vanzare' AND activ = 1 AND status NOT IN ('anulata', 'platita')
          AND inchis_istoric IS NULL
          AND id IN (
            SELECT f.id FROM (SELECT * FROM facturi WHERE activ = 1) f
            JOIN ${SUMA_PLATITA} p ON p.factura_id = f.id
            JOIN ${TOTAL_CU_TVA} l ON l.factura_id = f.id
            WHERE p.s >= l.t - ${TOLERANTA})`
    )
    .run();

  const partiale = await db
    .prepare(
      `UPDATE facturi SET status = 'platita_partial'
        WHERE directie = 'vanzare' AND activ = 1 AND status NOT IN ('anulata', 'platita', 'platita_partial')
          AND inchis_istoric IS NULL
          AND id IN (
            SELECT f.id FROM (SELECT * FROM facturi WHERE activ = 1) f
            JOIN ${SUMA_PLATITA} p ON p.factura_id = f.id
            JOIN ${TOTAL_CU_TVA} l ON l.factura_id = f.id
            WHERE p.s > ${TOLERANTA} AND p.s < l.t - ${TOLERANTA})`
    )
    .run();

  return {
    trecute_pe_incasat: Number((platite && platite.changes) || 0),
    trecute_pe_partial: Number((partiale && partiale.changes) || 0),
  };
}

module.exports = { recalculeazaStatusFacturi };
