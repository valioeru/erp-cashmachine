"use strict";
// Prețul unitar din formularul de comandă: cum se arată și cum se citește.
//
// CE A RAPORTAT VALI, 29.10.2026, cu o poză: o linie de 150.000 pungi avea
// prețul 0.16005859375 — unsprezece zecimale — și „vrea doar acea valoare".
//
// Exact asta făcea. Câmpul era <input type="number" step="0.0001">, iar în
// HTML pasul se numără de la VALOAREA DE PORNIRE a câmpului, nu de la zero.
// Cu valoarea 0.16005859375 în câmp, singurele prețuri „valide" erau
// 0.16005859375 ± câte 0,0001: 0.15995859375, 0.16015859375 și tot așa.
// Omul scria 0,16 și browserul îl refuza: „cele mai apropiate valori valide
// sunt 0.15995859375 și 0.16005859375". Orice preț rotund era respins, iar
// singurul care trecea era cel urât. Am reprodus-o în Chromium, tastând.
//
// Și încă o capcană din același câmp: un câmp „number" într-un browser pe
// engleză nu primește virgula. Cine tasta „0,16" obținea „016", adică 16 lei
// pe bucată — de o sută de ori prețul. La o comandă nouă, unde câmpul n-are
// valoare de pornire, 16 trecea liniștit de validare.
//
// Ce face fișierul ăsta:
//
//   pretPentruCamp — ce se scrie în câmp: cel mult 4 zecimale, cu virgulă,
//                    fără zerouri de umplutură.
//   pretDinCamp    — ce a tastat omul, citit cu virgulă SAU punct. Ce nu e
//                    limpede un număr (de exemplu „1.234,56", unde nu se
//                    știe care e separatorul) e refuzat, nu ghicit.
//   pretDeScris    — ce ajunge în bază. Dacă omul NU a atins câmpul, rămâne
//                    prețul exact de dinainte, oricâte zecimale ar avea:
//                    formularul arată 0,1601 dar nu are voie să schimbe
//                    singur prețul de pe 150.000 de bucăți. Doar ce tastează
//                    omul se scrie, rotunjit la 4 zecimale.
//
// pretPentruCamp e scrisă fără nimic modern, fiindcă textul ei se pune ca
// atare și în pagină, pentru completarea automată a prețului din
// nomenclator. Aceeași funcție, deci același rezultat pe server și în
// browser.

function pretPentruCamp(v) {
  if (v === null || v === undefined || v === "") return "";
  var n = Number(String(v).replace(",", "."));
  // Ce nu se poate citi rămâne cum l-a scris omul, ca să-l vadă și să-l
  // îndrepte — altfel, la reafișarea formularului cu eroare, ar dispărea.
  if (!isFinite(n)) return String(v);
  if (n === 0) return "";
  var r = Math.round(n * 10000) / 10000;
  return r.toFixed(4).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

// „0,16", „0.16", „16", „,5", „16," — da. „1.234,56", „1,234.56", „abc",
// „-1" — nu. Spațiile se ignoră („0, 16").
function pretDinCamp(s) {
  var t = String(s === null || s === undefined ? "" : s).replace(/\s+/g, "");
  if (t === "") return { ok: true, valoare: 0 };
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return { ok: false, valoare: null };
  var n = Number(t.replace(",", "."));
  if (!isFinite(n)) return { ok: false, valoare: null };
  return { ok: true, valoare: Math.round(n * 10000) / 10000 };
}

// `exact` vine dintr-un câmp ascuns de pe același rând, cu prețul din bază.
// Pagina îl golește în clipa în care omul tastează ceva în câmpul de preț,
// deci „exact plin" înseamnă „neatins".
function pretDeScris(scris, exact) {
  var e = String(exact === null || exact === undefined ? "" : exact).trim();
  if (e !== "") {
    var ne = Number(e);
    if (isFinite(ne)) return { ok: true, valoare: ne };
  }
  return pretDinCamp(scris);
}

// Are prețul mai multe zecimale decât arată câmpul? Atunci, sub câmp, se
// scrie valoarea exactă — ca nimeni să nu creadă că e 0,1601 când în bază
// e 0,16005859375 și totalul liniei iese cu 6,21 lei altfel decât la mână.
function areZecimaleInPlus(v) {
  if (v === null || v === undefined || v === "") return false;
  var n = Number(v);
  if (!isFinite(n) || n === 0) return false;
  return Math.abs(Math.round(n * 10000) / 10000 - n) > 1e-12;
}

function scrieExact(v) {
  return String(Number(v)).replace(".", ",");
}

module.exports = { pretPentruCamp, pretDinCamp, pretDeScris, areZecimaleInPlus, scrieExact };
