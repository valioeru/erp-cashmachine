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
//   • CURSUL se poate scrie de mână, pe fiecare articol (Vali, 19.11.2026:
//     „vreau să poți să pui tu curs, doar să sugereze automat cursul BNR").
//     Câmpul vine completat cu BNR-ul zilei; ce scrie omul în el are
//     întâietate. Lăsat gol, se ia BNR-ul.
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
// Cursul scris de om: gol → null; „5,0912" sau „5.0912" → număr; altceva → NaN.
function cursScris(v) {
  const t = String(v == null ? "" : v).trim().replace(/\s+/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : NaN;
}
// Cursul, cum se scrie în câmp și pe pagină: cu virgulă, 4–6 zecimale.
const scrieCurs = (c) => (Number(c) > 0 ? Number(c).toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 6, useGrouping: false }) : "");

// preturi : [{ ok, valoare }]  — prețul citit din fiecare rând, în moneda rândului
// monede  : [text]             — moneda aleasă pe rând
// produse : [id]               — produsul rândului (după el se găsește linia veche)
// vechi   : Map produs_id → { moneda, pret_valuta, curs, pret_unitar } (la modificare)
// cursAzi : async (moneda) → { valoare, data } | null
// cursuri : [text]             — cursul scris de om pe rând (gol = BNR-ul zilei)
//
// Întoarce { preturi, extra, eroare }: `preturi` = aceleași rânduri, cu
// valoarea în LEI; `extra[i]` = { moneda, pret_valuta, curs } de scris pe linie.
async function inLei({ preturi, monede, produse, vechi, cursAzi, cursuri }) {
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
    const scris = cursScris((cursuri || [])[i]);
    if (Number.isNaN(scris)) {
      return { preturi: iesire, extra, eroare: `Cursul de pe rândul ${i + 1} nu e un număr pozitiv. Scrie-l cu virgulă sau punct (de exemplu 5,0912) ori lasă câmpul gol, ca să se ia cursul BNR.` };
    }
    const neatins = v && valid(v.moneda) === m && Number(v.curs) > 0 && Number(v.pret_valuta) > 0 && acelasi(v.pret_valuta, p.valoare);
    // Nici prețul, nici cursul n-au fost atinse: linia rămâne exact cum era.
    if (neatins && (scris === null || Math.abs(scris - Number(v.curs)) < 5e-7)) {
      iesire.push({ ...p, valoare: Number(v.pret_unitar) });
      extra.push({ moneda: m, pret_valuta: Number(v.pret_valuta), curs: Number(v.curs) });
      continue;
    }
    // Cursul scris de om are întâietate.
    if (scris !== null) {
      iesire.push({ ...p, valoare: rot4(Number(p.valoare) * scris) });
      extra.push({ moneda: m, pret_valuta: Number(p.valoare), curs: scris });
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

// Moneda unui rând din formular și, lângă ea, cursul: ascuns la lei, completat
// de pagină cu BNR-ul zilei când se alege o valută (scriptul din
// modules/comenzi.js), schimbabil de om. `curs` = ce e scris pe linie sau ce
// a tastat omul.
function camp(aleasa, esc, curs) {
  const a = valid(aleasa);
  const e = esc || ((x) => String(x));
  const c = curs == null ? "" : typeof curs === "string" ? curs : scrieCurs(curs);
  return `<select name="moneda_linie[]" class="moneda-linie" title="Moneda prețului de pe rândul ăsta" style="width:74px" onchange="comenziMonedaLinie(this, true)">${MONEDE.map(
    (m) => `<option value="${m}"${m === a ? " selected" : ""}>${m === "RON" ? "lei" : e(m)}</option>`
  ).join("")}</select>
  <span class="curs-linie-cutie"${a === "RON" ? ' style="display:none"' : ""}>
    <input type="text" name="curs_linie[]" class="curs-linie" inputmode="decimal" autocomplete="off" value="${e(a === "RON" ? "" : c)}" placeholder="curs"
           title="Cursul: câți lei face 1 unitate din moneda rândului. Vine completat cu BNR-ul zilei; poți scrie altul." style="width:86px;margin-top:4px"
           oninput="this.removeAttribute('data-bnr'); comenziMonedaLinie(this.closest('tr').querySelector('select.moneda-linie'), false)">
    <small class="curs-linie-nota" style="display:block;color:var(--text-muted);font-size:11px"></small>
  </span>`;
}

// Ce se scrie sub prețul în lei, pe pagina comenzii: „18,67 EUR · curs 5,0912".
function nota(linie) {
  const m = valid(linie && linie.moneda);
  if (m === "RON" || !(Number(linie.pret_valuta) > 0)) return "";
  const nr = (x, z) => Number(x).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: z });
  return `${nr(linie.pret_valuta, 4)} ${m}${Number(linie.curs) > 0 ? ` · curs ${scrieCurs(linie.curs)}` : ""}`;
}

// Scriptul rândurilor: arată câmpul de curs doar la valută, îl completează cu
// BNR-ul zilei când se alege moneda (dacă omul n-a scris altul) și spune cu
// ce curs BNR se compară. `bnr` = { EUR: { valoare, data }, USD: … }.
function script(bnr) {
  const date = JSON.stringify(bnr || {}).replace(/</g, "\\u003c");
  return `<script>
    (function () {
      var BNR = ${date};
      function scrie(x) { return Number(x).toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 6, useGrouping: false }); }
      function nr(v) { var t = String(v || "").trim().replace(",", "."); if (!t) return null; var n = Number(t); return isFinite(n) && n > 0 ? n : NaN; }
      // schimbata = omul tocmai a ales altă monedă: cursul de dinainte era al celeilalte.
      window.comenziMonedaLinie = function (sel, schimbata) {
        if (!sel) return;
        var rand = sel.closest("tr"); if (!rand) return;
        var cutie = rand.querySelector(".curs-linie-cutie"), inp = rand.querySelector("input.curs-linie"), nota = rand.querySelector(".curs-linie-nota");
        if (!cutie || !inp) return;
        var m = sel.value;
        if (m === "RON") { cutie.style.display = "none"; inp.value = ""; inp.removeAttribute("data-bnr"); if (nota) nota.textContent = ""; return; }
        cutie.style.display = "";
        var b = BNR[m];
        if (schimbata || !String(inp.value).trim()) {
          if (b) { inp.value = scrie(b.valoare); inp.setAttribute("data-bnr", "1"); } else if (schimbata) { inp.value = ""; }
        }
        if (!nota) return;
        var v = nr(inp.value);
        if (!b) { nota.textContent = "BNR n-are curs pentru " + m + " — scrie-l tu"; return; }
        var t = "BNR" + (b.data ? " " + b.data : "") + ": " + scrie(b.valoare);
        if (v === null) t += " · gol = BNR";
        else if (isNaN(v)) t = "cursul nu e un număr";
        else if (Math.abs(v - b.valoare) >= 0.00005) t += " · pus de tine";
        nota.textContent = t;
      };
      function toate() { document.querySelectorAll("#linii-body select.moneda-linie").forEach(function (s) { window.comenziMonedaLinie(s, false); }); }
      toate();
      // Rândul adăugat e o copie golită a primului: moneda lui revine pe lei.
      var corp = document.getElementById("linii-body");
      if (corp && window.MutationObserver) new MutationObserver(function (l) { if (l.some(function (x) { return x.addedNodes && x.addedNodes.length; })) toate(); }).observe(corp, { childList: true });
    })();
  </script>`;
}

module.exports = { MONEDE, valid, rot4, inLei, camp, nota, script, cursScris, scrieCurs };
