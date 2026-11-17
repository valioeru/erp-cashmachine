"use strict";
// Prețul scris în lei sau în valută, oriunde se scrie un preț de intrare.
//
// Vali, 17.11.2026: „La orice comandă, preț etc., din orice loc în tot
// sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul introdus
// sau BNR; odată plasat, așa rămâne în istoric și doar cele noi se schimbă —
// la marfa intrată în stoc sau oriunde."
//
// ERP-ul socotește în lei: stocul, costul, marja. De-aia un preț scris în euro
// se trece în lei pe loc, la cursul ales, iar lângă prețul în lei rămâne scris
// din ce s-a făcut: „1,25 EUR × 5,0912 (BNR din 17.11.2026)". Cursul nu se mai
// recalculează niciodată: ce a intrat ieri la 5,0912 rămâne la 5,0912 și mâine,
// când BNR-ul e altul.
//
// REGULILE (aceleași ca la comanda de client, lib/curs-comanda.js):
//
//   • Lei: nimic de făcut.
//   • Valută, cursul lăsat gol → BNR-ul zilei, cu data lui. Dacă BNR-ul nu
//     răspunde, cursul se cere — nu se ghicește unul.
//   • Valută, curs scris → exact acela, „pus de voi". Scris la fel ca BNR-ul
//     zilei → rămâne BNR.
//
// Formularele trimit două câmpuri, cu aceleași nume peste tot: `pret_moneda`
// și `pret_curs`. Fără ele (o pagină deschisă dinaintea actualizării), prețul
// e în lei, ca până acum.
//
// Fără bază de date: cursul BNR vine ca parametru (`laZiua` din modules/curs.js).
const L = require("./comenzi-furnizor-logica");

const MONEDE = ["RON", "EUR", "USD"];
const CAMP_MONEDA = "pret_moneda";
const CAMP_CURS = "pret_curs";

const MESAJ_CURS = "Cursul nu e un număr pozitiv. Scrie-l ca la BNR, de exemplu 5,0912 — sau lasă câmpul gol și se ia cursul BNR.";
const mesajFaraBnr = (m) => `BNR nu are acum curs pentru ${m}. Scrie cursul în câmpul de lângă monedă.`;
const mesajMoneda = (m) => `Moneda „${m}” nu e una în care se scriu prețurile (${MONEDE.join(", ")}).`;

const pozitiv = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// Două cursuri sunt același dacă nu diferă la a patra zecimală — atât arată câmpul.
const acelasi = (a, b) => pozitiv(a) !== null && pozitiv(b) !== null && Math.abs(Number(a) - Number(b)) < 0.00005;
const ziRo = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d || "");
};
const LEI = Object.freeze({ ok: true, moneda: "RON", curs: null, data: null, manual: 0 });

// Moneda scrisă în formular. Gol = lei. Null = una necunoscută.
function moneda(v) {
  const m = String(v === null || v === undefined ? "" : v).trim().toUpperCase();
  if (!m) return "RON";
  return MONEDE.includes(m) ? m : null;
}

// Ce a ales omul: { ok, moneda, curs, data, manual } sau { ok: false, eroare }.
// `curs` = textul din câmp; `bnr` = { valoare, data } pentru moneda aleasă, azi.
function alege({ moneda: m0, curs, bnr } = {}) {
  const m = moneda(m0);
  if (m === null) return { ok: false, eroare: mesajMoneda(String(m0).trim()) };
  if (m === "RON") return LEI;
  const c = L.cursDinCamp(curs);
  if (!c.ok) return { ok: false, eroare: MESAJ_CURS };
  const b = bnr && pozitiv(bnr.valoare) !== null ? { valoare: Number(bnr.valoare), data: bnr.data || null } : null;
  if (c.valoare !== null && !(b && acelasi(c.valoare, b.valoare))) return { ok: true, moneda: m, curs: c.valoare, data: null, manual: 1 };
  if (!b) return { ok: false, eroare: mesajFaraBnr(m) };
  return { ok: true, moneda: m, curs: b.valoare, data: b.data, manual: 0 };
}

// Din câmpurile formularului. BNR-ul se cere doar când e nevoie de el.
async function dinFormular(b, laZiua) {
  const corp = b || {};
  const m = moneda(corp[CAMP_MONEDA]);
  if (m === null || m === "RON") return alege({ moneda: corp[CAMP_MONEDA] });
  let bnr = null;
  if (typeof laZiua === "function") {
    bnr = await Promise.resolve(laZiua(m, new Date().toISOString().slice(0, 10))).catch(() => null);
  }
  return alege({ moneda: m, curs: corp[CAMP_CURS], bnr });
}

const eLei = (ales) => !ales || ales.moneda === "RON" || !ales.moneda;

// Prețul în lei, la cursul ales. Șase zecimale, ca prețul de intrare al
// paleților: un preț de 0,03 € pe pungă nu încape în patru fără să piardă.
function inLei(pret, ales, zecimale) {
  const p = Number(pret);
  if (!Number.isFinite(p)) return null;
  if (eLei(ales)) return p;
  const curs = pozitiv(ales.curs);
  if (curs === null) return null;
  const z = Math.pow(10, Number.isInteger(zecimale) ? zecimale : 6);
  return Math.round(Number((p * curs * z).toPrecision(14))) / z;
}

const scrieNumar = (v) => String(Math.round(Number(v) * 1e6) / 1e6).replace(".", ",");
// De unde e cursul: „BNR din 17.11.2026" sau „curs pus de voi".
function deUnde(ales) {
  if (eLei(ales)) return "";
  return Number(ales.manual) === 1 ? "curs pus de voi" : "BNR" + (ales.data ? " din " + ziRo(ales.data) : "");
}
// Ce rămâne scris lângă prețul în lei: „1,25 EUR × 5,0912 (BNR din 17.11.2026)".
function nota(pret, ales) {
  if (eLei(ales) || !Number.isFinite(Number(pret)) || pozitiv(ales.curs) === null) return "";
  return `${scrieNumar(pret)} ${ales.moneda} × ${L.scrieCurs(ales.curs)} (${deUnde(ales)})`;
}
// Sursa prețului, cu nota lipită: „scris la intrare: 1,25 EUR × 5,0912 (…)".
function sursa(baza, pret, ales) {
  const n = nota(pret, ales);
  return n ? `${baza}: ${n}` : baza;
}

const esc = (s) =>
  String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Câmpurile ascunse, pentru pașii de confirmare: duc mai departe ce s-a ales.
function ascunse(b) {
  const corp = b || {};
  const m = moneda(corp[CAMP_MONEDA]);
  if (!m || m === "RON") return "";
  return `<input type="hidden" name="${CAMP_MONEDA}" value="${esc(m)}"><input type="hidden" name="${CAMP_CURS}" value="${esc(String(corp[CAMP_CURS] || "").trim())}">`;
}

// Câmpurile ascunse ale unui formular mic dintr-o listă: primesc alegerea de
// deasupra listei (scriptul le completează).
const COPII = `<input type="hidden" name="${CAMP_MONEDA}" data-pv-copie="moneda" value=""><input type="hidden" name="${CAMP_CURS}" data-pv-copie="curs" value="">`;

// Alegerea monedei, într-un formular. `valori` = ce era scris (la întoarcerea
// cu o eroare); `compact` = pe un rând, pentru scaner și liste; `tine` = pe
// paginile scanerului, alegerea merge mai departe între scanări (data-tine).
function camp(valori, opt) {
  const v = valori || {};
  const o = opt || {};
  const m = moneda(v[CAMP_MONEDA]) || "RON";
  const curs = String(v[CAMP_CURS] === null || v[CAMP_CURS] === undefined ? "" : v[CAMP_CURS]).trim();
  const clasa = o.clasa || "field";
  return `<div class="pv" data-pv style="${o.compact ? "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap" : "display:grid;grid-template-columns:1fr 1fr;gap:14px"}">
      <label class="${clasa}" style="margin:0"><span>${esc(o.eticheta || "Prețul e scris în")}</span>
        <select name="${CAMP_MONEDA}" data-pv-moneda${o.tine ? ` data-tine="${CAMP_MONEDA}"` : ""}>${MONEDE.map((x) => `<option value="${x}"${x === m ? " selected" : ""}>${x === "RON" ? "lei (RON)" : x}</option>`).join("")}</select>
      </label>
      <label class="${clasa}" data-pv-curs style="margin:0${m === "RON" ? ";display:none" : ""}"><span>Curs — lei pentru 1 <b data-pv-m>${esc(m === "RON" ? "EUR" : m)}</b></span>
        <input type="text" inputmode="decimal" name="${CAMP_CURS}" value="${esc(curs)}" autocomplete="off" data-pv-valoare${o.tine ? ` data-tine="${CAMP_CURS}"` : ""}>
      </label>
      <small data-pv-nota style="grid-column:1 / -1;flex-basis:100%;color:var(--text-muted);font-size:12px${m === "RON" ? ";display:none" : ""}"></small>
    </div>`;
}

// Scriptul alegerii, o dată pe pagină. `bnr` = { EUR: { valoare, data }, … }.
// Lângă fiecare câmp de preț marcat `data-pv-pret` scrie cât face în lei, iar
// în etichetele marcate `data-pv-um` scrie moneda aleasă în loc de „lei".
// Câmpurile ascunse marcate `data-pv-copie` („moneda" / „curs") primesc
// alegerea — pentru listele cu câte un formular mic pe rând; lista și alegerea
// ei stau atunci într-un element marcat `data-pv-zona`.
// Fără backslash-uri în scriptul din pagină: textul ajunge acolo ca atare.
function script(bnr) {
  const date = JSON.stringify(bnr || {}).replace(/</g, "\\u003c");
  return `<script>
    (function () {
      var BNR = ${date};
      // Și pentru scripturile paginii, care socotesc valoarea în lei.
      window.PV_BNR = BNR;
      function nr(v) { var t = String(v == null ? "" : v).trim().replace(",", "."); if (!t) return null; var n = Number(t); return isFinite(n) && n > 0 ? n : NaN; }
      function scrie(x, z) { return Number(x).toLocaleString("ro-RO", { minimumFractionDigits: z, maximumFractionDigits: z, useGrouping: false }); }
      function ziRo(d) { var p = String(d || "").split("-"); return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : String(d || ""); }
      document.querySelectorAll("[data-pv]").forEach(function (cutie) {
        // Scriptul poate ajunge de două ori pe aceeași pagină (două bucăți
        // care își aduc fiecare alegerea): fiecare alegere se leagă o dată.
        if (cutie.getAttribute("data-pv-legat")) return;
        cutie.setAttribute("data-pv-legat", "1");
        var sel = cutie.querySelector("[data-pv-moneda]");
        var campCurs = cutie.querySelector("[data-pv-curs]");
        var inp = cutie.querySelector("[data-pv-valoare]");
        var nota = cutie.querySelector("[data-pv-nota]");
        // Prețurile de care ține alegerea: ale formularului ei, ale zonei
        // marcate data-pv-zona (o listă cu formulare mici), altfel ale paginii.
        var form = cutie.closest("form") || cutie.closest("[data-pv-zona]") || document;
        if (!sel || !inp) return;
        function cursul() {
          var m = sel.value;
          if (m === "RON") return 1;
          var v = nr(inp.value);
          if (v === null) return BNR[m] ? BNR[m].valoare : NaN;
          return v;
        }
        function arata() {
          var m = sel.value, valuta = m !== "RON";
          if (campCurs) campCurs.style.display = valuta ? "" : "none";
          if (nota) nota.style.display = valuta ? "" : "none";
          cutie.querySelectorAll("[data-pv-m]").forEach(function (e) { e.textContent = valuta ? m : "EUR"; });
          form.querySelectorAll("[data-pv-um]").forEach(function (e) { e.textContent = valuta ? m : "lei"; });
          // Formularele mici dintr-o listă (câte unul pe rând) își iau moneda
          // și cursul de la alegerea de deasupra lor.
          form.querySelectorAll('[data-pv-copie="moneda"]').forEach(function (e) { e.value = m; });
          form.querySelectorAll('[data-pv-copie="curs"]').forEach(function (e) { e.value = valuta ? inp.value : ""; });
          var b = BNR[m], v = nr(inp.value);
          inp.placeholder = valuta && b ? scrie(b.valoare, 4) : "";
          if (nota && valuta) {
            var t = b ? "BNR" + (b.data ? " din " + ziRo(b.data) : "") + ": " + scrie(b.valoare, 4) : "BNR nu are acum curs pentru " + m + " — scrie-l tu";
            if (b && v === null) t += " · lăsat gol, se ia BNR-ul";
            else if (v !== null && isNaN(v)) t += " · cursul scris nu e un număr";
            else if (b && v !== null && Math.abs(v - b.valoare) >= 0.00005) {
              var d = (v / b.valoare - 1) * 100;
              t += " · cursul vostru diferă cu " + (d > 0 ? "+" : "") + d.toLocaleString("ro-RO", { maximumFractionDigits: 2 }) + "%";
            }
            nota.textContent = t + ". Prețul se trece în lei la cursul ăsta și așa rămâne.";
          }
          var c = cursul();
          form.querySelectorAll("[data-pv-pret]").forEach(function (p) {
            var x = nr(p.value);
            var text = valuta && x !== null && !isNaN(x) && !isNaN(c) ? "= " + scrie(x * c, 4) + " lei" : "";
            var e = p.parentNode.querySelector("[data-pv-egal]");
            // Rândul cu leii apare doar când are ce spune: într-o listă cu
            // sute de prețuri, sute de rânduri goale ar strica așezarea.
            if (!e && !text) return;
            if (!e) { e = document.createElement("small"); e.setAttribute("data-pv-egal", "1"); e.style.cssText = "display:block;flex-basis:100%;color:var(--text-muted);font-size:12px"; p.parentNode.appendChild(e); }
            e.textContent = text;
            e.style.display = text ? "block" : "none";
          });
        }
        sel.addEventListener("change", function () { inp.value = ""; arata(); });
        inp.addEventListener("input", arata);
        form.addEventListener("input", function (ev) { if (ev.target && ev.target.hasAttribute && ev.target.hasAttribute("data-pv-pret")) arata(); });
        arata();
      });
    })();
  </script>`;
}

// Cursurile BNR de azi pentru monedele în care se poate scrie un preț.
async function bnrAzi(laZiua) {
  const azi = new Date().toISOString().slice(0, 10);
  const out = {};
  for (const m of MONEDE) {
    if (m === "RON") continue;
    const c = await Promise.resolve(typeof laZiua === "function" ? laZiua(m, azi) : null).catch(() => null);
    if (c && pozitiv(c.valoare) !== null) out[m] = { valoare: Number(c.valoare), data: c.data || "" };
  }
  return out;
}

module.exports = { MONEDE, CAMP_MONEDA, CAMP_CURS, COPII, MESAJ_CURS, LEI, moneda, alege, dinFormular, eLei, inLei, deUnde, nota, sursa, ascunse, camp, script, bnrAzi };
