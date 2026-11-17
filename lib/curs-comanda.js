"use strict";
// Cursul unei comenzi de client: BNR-ul zilei sau cel pus de om, fixat pe comandă.
//
// Cererea lui Vali, 17.11.2026: „La orice comandă, preț etc., din orice loc în
// tot sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul
// introdus sau BNR; odată plasat, așa rămâne în istoric și doar cele noi se
// schimbă."
//
// Comanda de client fixa deja cursul BNR din ziua plasării. Ce lipsea: să poți
// scrie cursul vostru (cel convenit cu clientul) și să se vadă de unde e.
//
// REGULILE:
//
//   • Comandă în lei: fără curs.
//   • Câmpul gol → BNR-ul zilei. Scris → exact ce s-a scris, marcat „pus pe
//     comandă". Scris la fel ca BNR-ul zilei → rămâne BNR (cu data lui).
//   • La modificare, cursul NU se mișcă singur: o corectură de cantitate pe o
//     comandă de acum trei săptămâni n-are voie să-i schimbe suma în lei. Se
//     schimbă doar dacă omul scrie alt curs, golește câmpul (atunci cere
//     BNR-ul zilei) sau schimbă moneda.
//   • Moneda schimbată, cu câmpul rămas pe cursul monedei vechi → BNR-ul
//     monedei noi (cursul euro n-are ce căuta pe o comandă în dolari).
//
// Fără bază de date: cursul BNR al zilei vine ca parametru.
const L = require("./comenzi-furnizor-logica");
const BNR = require("./curs-bnr");

const MESAJ_CURS = "Cursul nu e un număr pozitiv. Scrie-l ca la BNR, de exemplu 5,0912 — sau lasă câmpul gol și se ia cursul BNR.";

// Ce a scris omul în câmpul de curs: { ok, valoare } (valoare null = gol).
function citeste(brut) {
  return L.cursDinCamp(brut);
}

const pozitiv = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// Două cursuri sunt același dacă nu diferă la a patra zecimală — atât arată câmpul.
const acelasi = (a, b) => pozitiv(a) !== null && pozitiv(b) !== null && Math.abs(Number(a) - Number(b)) < 0.00005;

// Cursul de scris pe o comandă NOUĂ. `bnr` = { valoare, data } pentru moneda ei, azi.
function laPlasare({ moneda, scris, bnr }) {
  const m = String(moneda || "RON").toUpperCase();
  if (m === "RON") return { curs: null, data: null, manual: 0 };
  const b = bnr && pozitiv(bnr.valoare) ? { valoare: Number(bnr.valoare), data: bnr.data || null } : null;
  const s = pozitiv(scris);
  if (s !== null && !(b && acelasi(s, b.valoare))) return { curs: s, data: null, manual: 1 };
  if (b) return { curs: b.valoare, data: b.data, manual: 0 };
  return { curs: null, data: null, manual: 0 };
}

// Cursul de scris pe o comandă MODIFICATĂ. `golit` = omul a șters ce era în
// câmp (câmpul a venit, gol) — altceva decât un formular care nu l-a trimis.
function laModificare({ comanda, moneda, scris, bnr, golit }) {
  const c = comanda || {};
  const m = String(moneda || "RON").toUpperCase();
  if (m === "RON") return { curs: null, data: null, manual: 0 };
  const vechi = pozitiv(c.curs_bnr);
  const monedaSchimbata = m !== String(c.moneda || "RON").toUpperCase();
  let s = pozitiv(scris);
  if (!monedaSchimbata && vechi !== null) {
    const ramane = { curs: Number(c.curs_bnr), data: c.curs_bnr_data || null, manual: Number(c.curs_manual) === 1 ? 1 : 0 };
    // Câmpul golit cere BNR-ul zilei. Dacă BNR-ul nu răspunde, cursul comenzii
    // rămâne: unul bun nu se șterge pentru nimic.
    if (s === null && golit) {
      const b = laPlasare({ moneda: m, scris: null, bnr });
      return b.curs !== null ? b : ramane;
    }
    if (s === null || acelasi(s, vechi)) return ramane;
  }
  // Câmpul rămas pe cursul monedei de dinainte nu e un curs ales de om.
  if (monedaSchimbata && s !== null && vechi !== null && acelasi(s, vechi)) s = null;
  return laPlasare({ moneda: m, scris: s, bnr });
}

// Ziua, cum se scrie la noi. Textul ăsta ajunge și în istoricul comenzii și
// pe factură, deci nu se bizuie pe pagină ca să întoarcă data.
const ziRo = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d || "");
};

// „5,0912 lei/EUR · BNR din 17.11.2026" sau „5,1000 lei/EUR · pus pe comandă".
function eticheta(c) {
  const m = String((c && c.moneda) || "RON").toUpperCase();
  const curs = pozitiv(c && c.curs_bnr);
  if (m === "RON" || curs === null) return "";
  const sursa = Number(c.curs_manual) === 1 ? "pus pe comandă" : "BNR" + (c.curs_bnr_data ? " din " + ziRo(c.curs_bnr_data) : "");
  return `${L.scrieCurs(curs)} lei/${m} · ${sursa}`;
}

// Textul de sub totalul unei comenzi în altă monedă.
function explica(total, c) {
  const m = String((c && c.moneda) || "RON").toUpperCase();
  if (m === "RON") return "";
  const curs = pozitiv(c && c.curs_bnr);
  if (curs === null || Number(c.curs_manual) !== 1) return BNR.explica(total, m, c && c.curs_bnr, c && c.curs_bnr_data);
  return `≈ ${BNR.scrieSuma(BNR.inLei(total, m, curs))} lei, la cursul pus pe comandă ${L.scrieCurs(curs)}`;
}

// Prețul unei linii în lei, la cursul comenzii, cu patru zecimale — atât ține
// un preț unitar. Null când comanda e în altă monedă și n-are curs.
function pretInLei(pret, c) {
  const m = String((c && c.moneda) || "RON").toUpperCase();
  const p = Number(pret);
  if (!Number.isFinite(p)) return null;
  if (m === "RON") return p;
  const curs = pozitiv(c && c.curs_bnr);
  if (curs === null) return null;
  return Math.round(Number((p * curs * 1e4).toPrecision(14))) / 1e4;
}

// Cursul, cum se scrie în câmp și pe pagină: 4 zecimale, 6 dacă le are.
const scrie = (v) => L.scrieCurs(v);

module.exports = { MESAJ_CURS, citeste, acelasi, laPlasare, laModificare, eticheta, explica, pretInLei, scrie };
