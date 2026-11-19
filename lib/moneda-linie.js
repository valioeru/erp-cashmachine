"use strict";
// Moneda pe fiecare articol al comenzii.
//
// CEREREA LUI VALI, 19.11.2026 (cu poza formularului de comandă): „Aici pune
// moneda pe fiecare articol, te rog. Nu generală, sus." Întrebat cum să iasă
// totalul și proforma la o comandă cu articole în monede diferite, a ales:
// „Totul în lei".
//
// CUM MERGE
//   • Prețul se scrie în moneda articolului (lei, euro, dolari). Comanda
//     rămâne în lei: prețul în valută se trece în lei la cursul BNR al zilei,
//     iar linia ține minte ce s-a scris — moneda, prețul în valută și cursul.
//   • Totalul, proforma și factura ies în lei. Restul ERP-ului (depozit,
//     producție, rapoarte) vede, ca până acum, un preț în lei pe linie.
//   • Cursul se îngheață pe linie. La o modificare, linia al cărei preț în
//     valută n-a fost atins rămâne cu cursul și cu leii de la plasare — o
//     corectură de cantitate n-are voie să schimbe suma sub mână. Cursul nou
//     se ia doar când se schimbă prețul sau moneda liniei.
//
// Fără bază de date: cursul vine ca funcție, ca să se poată verifica în test.

const MONEDE = ["RON", "EUR", "USD"];
const valid = (m) => {
  const s = String(m == null ? "" : m).trim().toUpperCase();
  return MONEDE.includes(s) ? s : "RON";
};
const rot4 = (x) => Math.round((Number(x) + Number.EPSILON) * 1e4) / 1e4;
const acelasi = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

// preturi : [{ ok, valoare }]  — prețul citit din fiecare rând, în moneda rândului
// monede  : [text]             — moneda aleasă pe rând
// produse : [id]               — produsul rândului (după el se găsește linia veche)
// vechi   : Map produs_id → { moneda, pret_valuta, curs, pret_unitar } (la modificare)
// cursAzi : async (moneda) → { valoare, data } | null
//
// Întoarce { preturi, extra, eroare }: `preturi` = aceleași rânduri, cu
// valoarea în LEI; `extra[i]` = { moneda, pret_valuta, curs } de scris pe linie.
async function inLei({ preturi, monede, produse, vechi, cursAzi }) {
  const iesire = [];
  const extra = [];
  const cache = new Map();
  for (let i = 0; i < (preturi || []).length; i++) {
    const p = preturi[i];
    const m = valid((monede || [])[i]);
    if (m === "RON" || !p || !p.ok || !(Number(p.valoare) > 0)) {
      iesire.push(p);
      extra.push({ moneda: "RON", pret_valuta: null, curs: null });
      continue;
    }
    const v = vechi ? vechi.get(Number((produse || [])[i])) : null;
    if (v && valid(v.moneda) === m && Number(v.curs) > 0 && Number(v.pret_valuta) > 0 && acelasi(v.pret_valuta, p.valoare)) {
      iesire.push({ ...p, valoare: Number(v.pret_unitar) });
      extra.push({ moneda: m, pret_valuta: Number(v.pret_valuta), curs: Number(v.curs) });
      continue;
    }
    if (!cache.has(m)) cache.set(m, await cursAzi(m));
    const c = cache.get(m);
    if (!c || !(Number(c.valoare) > 0)) {
      return { preturi: iesire, extra, eroare: `Nu am cursul BNR pentru ${m}, deci nu pot trece în lei prețul de pe rândul ${i + 1}. Scrie prețul în lei sau încearcă din nou mai târziu.` };
    }
    iesire.push({ ...p, valoare: rot4(Number(p.valoare) * Number(c.valoare)) });
    extra.push({ moneda: m, pret_valuta: Number(p.valoare), curs: Number(c.valoare) });
  }
  return { preturi: iesire, extra, eroare: "" };
}

// Lista de monede a unui rând din formular.
function camp(aleasa, esc) {
  const a = valid(aleasa);
  return `<select name="moneda_linie[]" class="moneda-linie" title="Moneda prețului de pe rândul ăsta" style="width:74px">${MONEDE.map(
    (m) => `<option value="${m}"${m === a ? " selected" : ""}>${m === "RON" ? "lei" : esc ? esc(m) : m}</option>`
  ).join("")}</select>`;
}

// Ce se scrie sub prețul în lei, pe pagina comenzii: „18,67 EUR · curs 5,0912".
function nota(linie) {
  const m = valid(linie && linie.moneda);
  if (m === "RON" || !(Number(linie.pret_valuta) > 0)) return "";
  const nr = (x, z) => Number(x).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: z });
  return `${nr(linie.pret_valuta, 4)} ${m}${Number(linie.curs) > 0 ? ` · curs ${nr(linie.curs, 4)}` : ""}`;
}

module.exports = { MONEDE, valid, rot4, inLei, camp, nota };
