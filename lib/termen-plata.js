"use strict";
// Termenul de plată: stă pe partener, se copiază pe comandă, ajunge pe factură
// ca dată scadentă și de acolo în SmartBill.
//
// Cererea lui Vali, 17.11.2026: „Vreau la orice client sau furnizor să se
// poată defini termen de plată. Orice comandă preia implicit termenul de plată
// al partenerului, dar se poate modifica punctual la fiecare comandă; facturile
// emise și transmise către SmartBill să preia automat și acest termen de plată."
//
// REGULILE, pe scurt:
//
//   • Pe partener e un număr de zile, între 0 și 365. Gol = nedefinit.
//     0 e un termen adevărat: plata în ziua facturii.
//   • Comanda îl COPIAZĂ în clipa în care se face. Dacă se schimbă apoi pe
//     fișa partenerului, comenzile deja plasate rămân cu termenul lor — la fel
//     ca prețul sau cursul, ce s-a convenit pe o comandă nu se mută singur.
//   • Pe comandă, câmpul gol înseamnă „cel din fișa partenerului". Așa se
//     poate scrie altul punctual, iar cine nu atinge nimic primește termenul
//     obișnuit al firmei.
//   • Comenzile de dinainte de 17.11 n-au termen copiat; pentru ele contează
//     ce scrie pe fișa partenerului în ziua facturii (`efectiv`).
//   • Factura primește scadența = data facturii + termen. O scadență scrisă
//     de mână pe factură nu se rescrie.
//
// Fără bază de date aici, în afară de cele două funcții de la final, ca restul
// să poată fi verificat de un test simplu.

const MAX_ZILE = 365;

// Ce a scris omul în câmp. Întoarce { ok, zile } sau { ok: false, eroare }.
//
// Doar cifre: „30 zile", „30,5" sau „-5" sunt refuzate, nu ghicite. Un termen
// ghicit greșit mută scadența în tăcere, iar asta se vede abia când clientul
// e trecut la restanțe pe nedrept.
function citeste(brut) {
  const t = brut == null ? "" : String(brut).trim();
  if (t === "") return { ok: true, zile: null };
  if (!/^\d{1,3}$/.test(t)) return { ok: false, eroare: mesajEroare() };
  const n = Number(t);
  if (n > MAX_ZILE) return { ok: false, eroare: mesajEroare() };
  return { ok: true, zile: n };
}

function mesajEroare() {
  return `Termenul de plată e un număr întreg de zile, între 0 și ${MAX_ZILE} (de exemplu 30). Gol = cel din fișa partenerului.`;
}

// Valoarea citită din bază (text, număr sau NULL) ca număr de zile sau null.
function normal(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ZILE ? n : null;
}

// „1 zi", „15 zile", „30 de zile", „101 zile". În română, de la 20 încolo
// numărul cere „de" — mai puțin când ultimele două cifre sunt 01–19.
// `en` = pentru comanda trimisă în engleză („30 days").
function zileText(v, en) {
  const n = normal(v);
  if (n === null) return "—";
  if (en) return n === 0 ? "0 days (payment on the invoice date)" : n === 1 ? "1 day" : `${n} days`;
  if (n === 0) return "0 zile (plată la data facturii)";
  if (n === 1) return "1 zi";
  const rest = n % 100;
  return rest === 0 || rest >= 20 ? `${n} de zile` : `${n} zile`;
}

// Data scadentă: data facturii + termen. Calculul e pe zile calendaristice, în
// UTC, ca trecerea la ora de vară să nu mute rezultatul cu o zi.
// Fără termen sau fără dată validă: șir gol (factura pleacă fără scadență,
// exact ca până acum).
function scadenta(dataFacturii, zile) {
  const n = normal(zile);
  const m = String(dataFacturii || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (n === null || !m) return "";
  const an = Number(m[1]);
  const luna = Number(m[2]) - 1;
  const zi = Number(m[3]);
  const t = Date.UTC(an, luna, zi);
  // 2026-02-30 trece de regex, dar Date.UTC îl mută în martie: o dată care
  // nu există nu dă scadență.
  const z = new Date(t);
  if (z.getUTCFullYear() !== an || z.getUTCMonth() !== luna || z.getUTCDate() !== zi) return "";
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

// Termenul care se aplică unei comenzi: cel copiat pe ea, altfel cel de pe
// fișa partenerului (pentru comenzile de dinainte de 17.11).
function efectiv(comanda, partener) {
  const peComanda = normal(comanda && comanda.termen_plata_zile);
  if (peComanda !== null) return peComanda;
  return normal(partener && partener.termen_plata_zile);
}

// Cele două tabele de comenzi și coloana lor de partener. Lista e închisă:
// numele de tabel nu vine niciodată din afară.
const COMENZI = { comenzi: "partener_id", comenzi_furnizor: "furnizor_id" };

// Termenul de pe fișa partenerului.
async function alPartenerului(db, partenerId) {
  const id = Number(partenerId);
  if (!(id > 0)) return null;
  const p = await db.prepare("SELECT termen_plata_zile FROM parteneri WHERE id = ?").get(id);
  return normal(p && p.termen_plata_zile);
}

// Pentru comenzile făcute pe alte drumuri decât formularul (din ofertă, din
// contract, din calculator, din emailul zilei): copiază pe comandă termenul
// partenerului, dacă ea nu are deja unul.
async function copiazaPeComanda(db, tabel, id) {
  const col = COMENZI[tabel];
  if (!col || !(Number(id) > 0)) return;
  await db
    .prepare(
      `UPDATE ${tabel} SET termen_plata_zile = (SELECT p.termen_plata_zile FROM parteneri p WHERE p.id = ${tabel}.${col})
        WHERE id = ? AND termen_plata_zile IS NULL`
    )
    .run(Number(id));
}

// ---- câmpul din formularele de comandă -------------------------------------
//
// `valoare` e ce stă pe comandă (sau ce a scris omul, dacă formularul s-a
// întors cu o eroare). `atins` = valoarea a fost scrisă de om: alegerea altui
// partener nu o mai suprascrie.
function camp({ valoare, atins, cine } = {}) {
  const v = valoare === null || valoare === undefined ? "" : String(valoare);
  const c = cine || "clientului";
  return `<label class="field"><span>Termen de plată (zile)</span>
      <input type="text" inputmode="numeric" name="termen_plata_zile" value="${escAttr(v)}" maxlength="3"
             placeholder="din fișa ${escAttr(c)}" data-termen-plata${atins ? ' data-atins="1"' : ""} style="width:100%">
      <small data-termen-nota style="display:block;color:var(--text-muted);font-size:12px;margin-top:3px">gol = cel din fișa ${escAttr(c)}</small>
    </label>`;
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Scriptul care pune termenul partenerului în câmp când se alege partenerul.
// `termene` = { idPartener: zile } doar pentru partenerii care au termen.
// Clientul se alege din căsuța de căutare (evenimentul „client-ales", din
// lib/render.js); furnizorul, dintr-o listă `select[name=furnizor_id]`.
function scriptCamp(termene, { cine } = {}) {
  const date = JSON.stringify(termene || {}).replace(/</g, "\\u003c");
  const c = JSON.stringify(cine || "clientului");
  return `<script>
    (function () {
      var T = ${date}, CINE = ${c};
      function zile(n) {
        if (n === 0) return "0 zile (plată la data facturii)";
        if (n === 1) return "1 zi";
        var r = n % 100;
        return (r === 0 || r >= 20) ? n + " de zile" : n + " zile";
      }
      function aplica(id) {
        var camp = document.querySelector("[data-termen-plata]");
        if (!camp) return;
        var nota = document.querySelector("[data-termen-nota]");
        var t = Object.prototype.hasOwnProperty.call(T, String(id)) ? T[String(id)] : null;
        var atins = camp.getAttribute("data-atins") === "1";
        if (!atins) camp.value = t === null ? "" : String(t);
        if (nota) {
          nota.textContent = t === null
            ? "fișa " + CINE + " n-are termen de plată — scrie-l aici, dacă e cazul"
            : "din fișa " + CINE + ": " + zile(t) + (atins ? " · pe comandă rămâne ce ai scris" : "");
        }
      }
      document.addEventListener("client-ales", function (e) { aplica(e.detail && e.detail.id); });
      var sel = document.querySelector('select[name="furnizor_id"]');
      if (sel) sel.addEventListener("change", function () { aplica(sel.value); });
      var camp = document.querySelector("[data-termen-plata]");
      if (camp) camp.addEventListener("input", function () { camp.setAttribute("data-atins", "1"); });
    })();
  </script>`;
}

// { idPartener: zile } din rândurile de parteneri, doar cei cu termen.
function hartaTermene(parteneri) {
  const h = {};
  for (const p of parteneri || []) {
    const n = normal(p.termen_plata_zile);
    if (n !== null) h[p.id] = n;
  }
  return h;
}

// Termenul de scris pe o comandă MODIFICATĂ.
//   • scris în câmp → acela;
//   • gol, cu partenerul schimbat → cel din fișa noului partener;
//   • gol, pe o comandă care avea termen → omul l-a șters: cel din fișă;
//   • gol, pe o comandă veche fără termen → rămâne fără (altfel istoricul ar
//     scrie o schimbare pe care n-a făcut-o nimeni).
function laModificare({ citit, vechi, partenerSchimbat, alFisei }) {
  if (citit !== null && citit !== undefined) return citit;
  if (partenerSchimbat) return normal(alFisei);
  if (normal(vechi) !== null) return normal(alFisei);
  return null;
}

module.exports = {
  MAX_ZILE,
  citeste,
  normal,
  zileText,
  scadenta,
  efectiv,
  alPartenerului,
  copiazaPeComanda,
  camp,
  scriptCamp,
  hartaTermene,
  laModificare,
};
