"use strict";
// Baza de calcul a comisionului agenților — un singur loc, pentru toate paginile.
//
// Comisionul se dă din valoarea FĂRĂ TVA. TVA-ul nu e venitul firmei, e banul
// statului care doar trece prin contul nostru; un comision de 2% aplicat pe
// suma cu TVA înseamnă în realitate 2,42% din ce rămâne la noi.
//
// Problema: o încasare vine întotdeauna cu TVA cu tot, fiindcă atât plătește
// clientul. Ca să scoatem partea fără TVA dintr-o plată, o înmulțim cu
// raportul net/total al facturii pe care s-a făcut plata. Așa iese corect și
// la facturile cu linii pe cote diferite de TVA — nu presupunem nicio cotă,
// o citim din chiar liniile facturii.
//
// Plasa de siguranță: dacă factura n-are linii în ERP, raportul nu se poate
// calcula (0/0). Fără plasă, comisionul pe facturile alea ar ieși zero în
// tăcere — și sunt vreo 2.000, mai ales din 2021–2024, importate fără detaliu
// pe produse. Atunci cădem pe cota standard de la data facturii: 19% până la
// 31.07.2025, 21% de la 01.08.2025.
//
// De ce funcții și nu constante: fiecare interogare își numește altfel
// tabelele. Funcțiile primesc aliasurile folosite acolo și scriu SQL-ul
// potrivit, ca să nu fie nevoie să rescriem expresia de patru ori.

const SUB_NET =
  "(SELECT factura_id, SUM(cantitate * pret_unitar) AS net FROM facturi_linii GROUP BY factura_id)";
const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";

// Cota standard de TVA la data facturii. Se folosește DOAR când factura n-are
// linii, deci nu putem citi cota reală.
function cotaImplicita(f) {
  const a = f || "f";
  return `(CASE WHEN COALESCE(${a}.data_emiterii, '') >= '2025-08-01' THEN 21.0 ELSE 19.0 END)`;
}

// Cât din valoarea cu TVA a facturii este valoare fără TVA. Între 0 și 1.
function raportNet(f, n, t) {
  const af = f || "f";
  const an = n || "cbn";
  const at = t || "cbt";
  return `(CASE WHEN COALESCE(${at}.total, 0) > 0 THEN COALESCE(${an}.net, 0) / ${at}.total
                ELSE 1.0 / (1 + ${cotaImplicita(af)} / 100.0) END)`;
}

// Cele două LEFT JOIN de care are nevoie raportNet(). Se lipesc în interogare
// după join-ul pe facturi.
function joinRaport(f, n, t) {
  const af = f || "f";
  const an = n || "cbn";
  const at = t || "cbt";
  return `LEFT JOIN ${SUB_NET} ${an} ON ${an}.factura_id = ${af}.id
         LEFT JOIN ${SUB_TOTAL} ${at} ON ${at}.factura_id = ${af}.id`;
}

// Partea fără TVA dintr-o plată. `pl` e aliasul tabelului de plăți.
function incasatNet(pl, f, n, t) {
  return `(${pl || "pl"}.suma * ${raportNet(f, n, t)})`;
}

// Același lucru, dar în JavaScript, pentru cazurile în care avem deja
// rândurile în memorie (prognoza din facturi neîncasate).
function raportNetJs(net, total, dataEmiterii) {
  const n = Number(net || 0);
  const t = Number(total || 0);
  if (t > 0) return n / t;
  const cota = String(dataEmiterii || "") >= "2025-08-01" ? 21 : 19;
  return 1 / (1 + cota / 100);
}

// ---- facturi puse la comision cu mâna ------------------------------------
//
// Unele facturi nu ajung niciodată să producă comision pe drumul normal:
// încasarea a fost pusă pe alt agent, sau factura n-a fost încasată și totuși
// munca a fost făcută. Pentru alea există tabelul comision_manual: o linie
// care spune „factura asta intră în comisionul lui X, în luna Y, cu baza Z".
//
// Regula de aur: o factură care are linie manuală NU mai produce comision și
// din încasările ei. Altfel, când intră banii, s-ar plăti de două ori. De-aia
// fiecare interogare pe încasări primește condiția de mai jos.
function faraManual(f) {
  const a = f || "f";
  return `NOT EXISTS (SELECT 1 FROM comision_manual cm WHERE cm.factura_id = ${a}.id AND cm.activ = 1)`;
}

// Baza adăugată manual, pe agent și pe lună.
const MANUAL_PE_LUNA = `
  SELECT luna, COALESCE(SUM(baza), 0) AS baza, COUNT(*) AS facturi
    FROM comision_manual
   WHERE activ = 1 AND utilizator_id = ? AND luna >= ?
   GROUP BY luna`;

// Baza adăugată manual, pe agent, într-un interval de date de lună.
const MANUAL_PE_INTERVAL = `
  SELECT utilizator_id, COALESCE(SUM(baza), 0) AS baza
    FROM comision_manual
   WHERE activ = 1 AND luna >= ? AND luna <= ?
   GROUP BY utilizator_id`;

module.exports = {
  SUB_NET, SUB_TOTAL, cotaImplicita, raportNet, joinRaport, incasatNet, raportNetJs,
  faraManual, MANUAL_PE_LUNA, MANUAL_PE_INTERVAL,
};
