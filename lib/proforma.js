"use strict";
// Proforma — foaia tipărită și socotelile ei. Desen pur, fără bază de date,
// ca lib/aviz.js, ca să se poată verifica într-un test.
//
// CE A CERUT VALI, 18.11.2026: „Fă meniu «emite proformă» și emite proformă de
// către agenți pentru clienții lor, să o poată emite direct din comandă, cu
// preluare la toate datele și pus pe el. La număr incrementat, indiferent cine
// face proforma." · „Când e gata văd factura emisă și o pot inclusiv downloada
// sau printa."
//
// Foaia e aceeași și pentru factura emisă (`optiuni.titlu`): furnizorul în
// stânga, titlul cu seria și numărul la mijloc, clientul în dreapta; tabelul
// cu preț, valoare și TVA; totalul; mențiunile. PDF-ul îl face browserul
// („Tipărește → Salvează ca PDF"), ca la aviz și la comanda către furnizor;
// titlul paginii devine numele fișierului.
//
// MONEDA. Proforma e în moneda comenzii — prețurile convenite cu clientul. La
// o comandă în valută cu curs fixat, sub total stă și echivalentul în lei la
// cursul comenzii: în lei se scrie factura (vezi facturaInLei, modules/comenzi.js).
const { FURNIZOR, dataAviz, cantitate } = require("./aviz");

const SIMBOL = { RON: "lei", EUR: "EUR", USD: "USD" };

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const nr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const rot2 = (v) => Math.round((nr(v) + Number.EPSILON) * 100) / 100;

// Valoarea unei linii se rotunjește la bani, apoi se adună: totalul de pe
// foaie e suma rândurilor pe care le vede clientul, nu o cifră cu un ban în plus.
function totaluri(linii) {
  let subtotal = 0;
  let tva = 0;
  const peCota = new Map();
  for (const l of Array.isArray(linii) ? linii : []) {
    const v = rot2(nr(l.cantitate) * nr(l.pret_unitar));
    const cota = nr(l.cota_tva);
    const t = rot2((v * cota) / 100);
    subtotal += v;
    tva += t;
    const c = peCota.get(cota) || { cota, baza: 0, tva: 0 };
    c.baza = rot2(c.baza + v);
    c.tva = rot2(c.tva + t);
    peCota.set(cota, c);
  }
  subtotal = rot2(subtotal);
  tva = rot2(tva);
  return { subtotal, tva, total: rot2(subtotal + tva), peCota: [...peCota.values()].sort((a, b) => a.cota - b.cota) };
}

const bani = (v) => nr(v).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Prețul unitar ține până la patru zecimale (o pungă la 0,4235 lei).
const pret = (v) => nr(v).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const moneda = (m) => {
  const x = String(m || "RON").toUpperCase();
  return SIMBOL[x] ? x : "RON";
};

// Amprenta conținutului: aceeași comandă, neschimbată, nu primește două
// numere de proformă la un dublu click. Se schimbă la orice schimbare de
// client, monedă, curs, termen, linie, cantitate sau preț.
function amprenta(doc, linii) {
  const crypto = require("crypto");
  const t = JSON.stringify([
    Number(doc.partener_id) || 0,
    moneda(doc.moneda),
    nr(doc.curs) || 0,
    doc.termen_plata_zile == null ? "" : String(doc.termen_plata_zile),
    Number(doc.upa) === 1 ? 1 : 0,
    (Array.isArray(linii) ? linii : []).map((l) => [Number(l.produs_id) || 0, String(l.denumire || ""), String(l.um || ""), nr(l.cantitate), nr(l.pret_unitar), nr(l.cota_tva)]),
  ]);
  return crypto.createHash("sha1").update(t).digest("hex");
}

// Foaia. `optiuni.bara` = HTML-ul barei de sus (nu se tipărește);
// `optiuni.titlu` = „FACTURĂ PROFORMĂ" dacă lipsește.
// `optiuni.numeFisier` = începutul titlului paginii (numele PDF-ului salvat);
// `optiuni.filigran` = cuvântul scris pieziș peste foaie (ciorna unei facturi);
// `optiuni.subsol` = rândul de jos.
function pagina(doc, linii, optiuni) {
  const o = optiuni || {};
  const f = (() => {
    try {
      return Object.assign({}, FURNIZOR, typeof doc.furnizor === "string" ? JSON.parse(doc.furnizor || "{}") : doc.furnizor || {});
    } catch (e) {
      return FURNIZOR;
    }
  })();
  const rand = (eticheta, valoare) => (valoare ? `<div>${esc(eticheta)}: ${esc(valoare)}</div>` : "");
  const lista = Array.isArray(linii) ? linii : [];
  const m = moneda(doc.moneda);
  const sim = SIMBOL[m];
  const T = totaluri(lista);
  const titluMare = o.titlu || "FACTURĂ PROFORMĂ";
  const titluPagina = `${o.numeFisier || "Proforma"} ${doc.serie} ${doc.numar} - ${doc.client_nume || ""}`.trim();
  const anulat = Number(doc.anulat) === 1;
  const curs = nr(doc.curs);
  const inLei = m !== "RON" && curs > 0 ? rot2(T.total * curs) : null;
  const termen = doc.termen_plata_zile == null || doc.termen_plata_zile === "" ? null : Number(doc.termen_plata_zile);

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<title>${esc(titluPagina)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eceff3; color:#000; font-family: Verdana, "DejaVu Sans", Arial, sans-serif; font-size:9.5pt; }
  .foaie { position:relative; width:190mm; min-height:277mm; margin:8mm auto; background:#fff; padding:0; display:flex; flex-direction:column; }
  .antet { border:1.2pt solid #000; display:grid; grid-template-columns: 1fr 58mm 1fr; gap:3mm; padding:3mm; line-height:1.35; }
  .titlu { text-align:center; font-weight:800; font-size:15pt; line-height:1.15; }
  .serie { border:1pt solid #000; margin-top:3mm; padding:2mm 1mm; text-align:center; line-height:1.45; }
  table.linii { width:100%; border-collapse:collapse; margin-top:3mm; border:1.2pt solid #000; table-layout:fixed; }
  table.linii th { font-weight:700; padding:1.6mm 1mm; border:1pt solid #000; text-align:center; vertical-align:middle; font-size:8.5pt; }
  table.linii td { border:1pt solid #000; padding:1.4mm 1.5mm; vertical-align:top; }
  table.linii td.c { text-align:center; }
  table.linii td.d { text-align:right; white-space:nowrap; }
  table.linii td.den { overflow-wrap:anywhere; }
  .cod { color:#444; font-size:8pt; font-family: Consolas, "DejaVu Sans Mono", monospace; }
  .jos { display:grid; grid-template-columns: 1fr 74mm; gap:4mm; margin-top:3mm; align-items:start; }
  table.total { width:100%; border-collapse:collapse; border:1.2pt solid #000; }
  table.total td { padding:1.6mm 2mm; border:1pt solid #000; }
  table.total td.d { text-align:right; white-space:nowrap; }
  table.total tr.plata td { font-weight:800; font-size:11pt; }
  .note { line-height:1.45; }
  .note > div { margin-bottom:1.5mm; }
  .mentiune { margin-top:3mm; border:1pt solid #000; padding:2mm; font-size:8.5pt; line-height:1.4; }
  .subsol { margin-top:auto; padding-top:4mm; font-size:8.5pt; color:#333; line-height:1.4; }
  .anulat { position:absolute; top:95mm; left:0; right:0; text-align:center; font-size:64pt; font-weight:900; color:rgba(179,38,30,.25);
            transform:rotate(-24deg); letter-spacing:.1em; pointer-events:none; }
  .bara { text-align:center; padding:10px; background:#fff; border-bottom:1px solid #ccc; font-family: system-ui, "Segoe UI", Arial, sans-serif; font-size:14px; }
  .bara a, .bara button { margin:0 6px; }
  .bara .eroare { color:#b3261e; font-weight:600; }
  @media print { .bara { display:none; } body { background:#fff; } .foaie { margin:0; } }
</style></head><body>
${o.bara ? `<div class="bara">${o.bara}</div>` : ""}
<script>
/* Venit de pe un buton „PDF" (…?pdf=1): fereastra de salvare se deschide
   singură, cu „Salvează ca PDF". Titlul paginii e numele fișierului. */
if (/[?&]pdf=1(&|$)/.test(location.search)) window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 350); });
</script>
<div class="foaie">
  ${anulat ? `<div class="anulat">${esc(o.textAnulat || "ANULATĂ")}</div>` : o.filigran ? `<div class="anulat" data-filigran>${esc(o.filigran)}</div>` : ""}
  <div class="antet">
    <div>
      <div>Furnizor: <strong>${esc(f.nume)}</strong></div>
      ${rand("Reg. com.", f.regCom)}
      ${rand("CIF", f.cif)}
      ${rand("Adresa", f.adresa)}
      ${rand("IBAN", f.iban)}
      ${rand("Banca", f.banca)}
      ${rand("Tel.", f.telefon)}
      ${rand("Email", f.email)}
      ${rand("Capital social", f.capital)}
    </div>
    <div>
      <div class="titlu">${esc(titluMare)}</div>
      <div class="serie" data-numar-document="${esc(doc.serie)}-${esc(doc.numar)}">
        Seria ${esc(doc.serie)} nr. ${esc(doc.numar)}<br>
        Data (zi/luna/an): ${esc(dataAviz(doc.data))}${doc.data_scadenta ? `<br>Scadentă: ${esc(dataAviz(doc.data_scadenta))}` : ""}
      </div>
    </div>
    <div>
      <div>Client: <strong>${esc(doc.client_nume || "—")}</strong></div>
      ${rand("Reg. com.", doc.client_regcom)}
      ${rand("CIF", doc.client_cui)}
      ${rand("Adresa", doc.client_adresa)}
      ${rand("Persoană de contact", doc.client_contact)}
      ${rand("Tel.", doc.client_telefon)}
      ${rand("Email", doc.client_email)}
      ${doc.comanda_numar ? `<div style="margin-top:2mm;font-weight:700">Comanda nr.: ${esc(doc.comanda_numar)}</div>` : ""}
    </div>
  </div>

  <table class="linii">
    <colgroup><col style="width:10mm"><col><col style="width:14mm"><col style="width:22mm"><col style="width:26mm"><col style="width:28mm"><col style="width:13mm"><col style="width:24mm"></colgroup>
    <thead>
      <tr><th>Nr. crt</th><th>Denumirea produselor sau a serviciilor</th><th>U.M.</th><th>Cant.</th><th>Preț unitar<br>(fără TVA)<br>-${esc(sim)}-</th><th>Valoare<br>-${esc(sim)}-</th><th>TVA %</th><th>Valoare TVA<br>-${esc(sim)}-</th></tr>
    </thead>
    <tbody>
      ${lista
        .map((l, i) => {
          const v = rot2(nr(l.cantitate) * nr(l.pret_unitar));
          return `<tr data-linie>
        <td class="c">${i + 1}</td>
        <td class="den">${esc(l.denumire)}${l.cod ? `<div class="cod">${esc(l.cod)}</div>` : ""}</td>
        <td class="c">${esc(l.um || "")}</td>
        <td class="d">${esc(cantitate(l.cantitate))}</td>
        <td class="d">${esc(pret(l.pret_unitar))}</td>
        <td class="d">${esc(bani(v))}</td>
        <td class="c">${esc(String(nr(l.cota_tva)))}</td>
        <td class="d">${esc(bani(rot2((v * nr(l.cota_tva)) / 100)))}</td>
      </tr>`;
        })
        .join("")}
    </tbody>
  </table>

  <div class="jos">
    <div class="note">
      ${termen !== null && Number.isFinite(termen) ? `<div data-termen>Termen de plată: <strong>${termen === 0 ? "la emiterea facturii" : termen + (termen === 1 ? " zi" : termen >= 20 && !(termen % 100 >= 1 && termen % 100 <= 19) ? " de zile" : " zile")}</strong></div>` : ""}
      ${doc.livrare ? `<div>Livrare: ${esc(doc.livrare)}</div>` : ""}
      ${doc.data_livrare ? `<div>Livrare cerută: ${esc(dataAviz(doc.data_livrare))}</div>` : ""}
      ${m !== "RON" && curs > 0 ? `<div data-curs>Curs ${esc(m)}: ${esc(curs.toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 4 }))} lei${doc.curs_nota ? ` (${esc(doc.curs_nota)})` : ""}. Factura se emite în lei, la cursul acesta.</div>` : ""}
      ${doc.observatii ? `<div>Observații: ${esc(doc.observatii)}</div>` : ""}
      <div>Întocmit de: ${esc(doc.creat_de || "")}${doc.agent_email ? `, ${esc(doc.agent_email)}` : ""}</div>
      ${anulat && doc.motiv_anulare ? `<div><strong>Anulată:</strong> ${esc(doc.motiv_anulare)}</div>` : ""}
    </div>
    <table class="total">
      <tr><td>Total fără TVA</td><td class="d" data-subtotal>${esc(bani(T.subtotal))} ${esc(sim)}</td></tr>
      ${T.peCota.map((c) => `<tr><td>TVA ${esc(String(c.cota))}%</td><td class="d">${esc(bani(c.tva))} ${esc(sim)}</td></tr>`).join("")}
      <tr class="plata"><td>Total de plată</td><td class="d" data-total>${esc(bani(T.total))} ${esc(sim)}</td></tr>
      ${inLei !== null ? `<tr><td>Echivalent în lei</td><td class="d" data-total-lei>${esc(bani(inLei))} lei</td></tr>` : ""}
    </table>
  </div>

  ${doc.mentiune ? `<div class="mentiune" data-mentiune>${esc(doc.mentiune)}</div>` : ""}

  <div class="subsol">${esc(o.subsol == null ? "Proforma nu este document fiscal și nu ține loc de factură. Plata se face în contul de mai sus, cu numărul proformei la detalii." : o.subsol)}</div>
</div>
</body></html>`;
}

module.exports = { SIMBOL, totaluri, amprenta, pagina, bani, pret, moneda, rot2, esc };
