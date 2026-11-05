"use strict";
// Comanda către furnizor, pe hârtie — foaia din care iese PDF-ul.
//
// CE A CERUT VALI, 05.11.2026: „buton de export pdf" pe comanda către furnizor.
//
// PDF-ul îl face browserul („Tipărește → Salvează ca PDF"), ca la aviz și la
// fișa de lot: fără o bibliotecă de PDF pe server, care ar trebui ținută la zi
// și ar avea nevoie de fonturi cu ș și ț. Titlul paginii devine numele
// fișierului salvat, de-aia are numărul comenzii și furnizorul în el.
//
// DOUĂ LIMBI. Furnizorii de materie primă sunt și afară — prima comandă din
// ERP a plecat spre WBV, în Germania — iar o comandă pe care furnizorul n-o
// poate citi se întoarce cu întrebări, nu cu marfă.
//
// Desen pur, fără bază de date, ca lib/aviz.js: se poate verifica într-un test.
const L = require("./comenzi-furnizor-logica");
const { FURNIZOR: FIRMA_NOASTRA } = require("./aviz");

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
const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

const TEXTE = {
  ro: {
    titlu: "COMANDĂ DE ACHIZIȚIE",
    nr: "Nr.",
    data: "Data",
    moneda: "Moneda",
    livrare: "Livrare solicitată",
    furnizor: "Furnizor",
    obs: "Livrare / observații",
    nrCrt: "Nr.",
    denumire: "Denumire",
    cod: "Cod",
    cant: "Cantitate",
    um: "UM",
    pu: "Preț unitar",
    val: "Valoare",
    total: "Total comandă",
    totalPartial: "Total pe pozițiile cu preț",
    deConfirmat: "de confirmat",
    echivRon: "Echivalent în lei",
    echivEur: "Echivalent în euro",
    laCursul: "la cursul de",
    informativ: "informativ",
    lei: "lei",
    fara1: "poziție fără preț — vă rugăm să ni-l confirmați.",
    faraN: "poziții fără preț — vă rugăm să ni-l confirmați.",
    rugaminte: "Vă rugăm să confirmați primirea comenzii și termenul de livrare.",
    intocmit: "Întocmit",
    confirmare: "Confirmare furnizor (nume, semnătură, dată)",
    generat: "emisă din ERP Cash Machine",
    anulata: "ANULATĂ",
    tipar: "Tipărește / salvează PDF",
    inapoi: "← Înapoi la comandă",
    altaLimba: "English",
    cif: "CIF",
    regCom: "Reg. com.",
    tel: "Tel.",
    numeFisier: "Comanda",
  },
  en: {
    titlu: "PURCHASE ORDER",
    nr: "No.",
    data: "Date",
    moneda: "Currency",
    livrare: "Requested delivery",
    furnizor: "Supplier",
    obs: "Delivery / notes",
    nrCrt: "No.",
    denumire: "Description",
    cod: "Code",
    cant: "Quantity",
    um: "Unit",
    pu: "Unit price",
    val: "Amount",
    total: "Order total",
    totalPartial: "Total of the items with a price",
    deConfirmat: "to be confirmed",
    echivRon: "Equivalent in RON",
    echivEur: "Equivalent in EUR",
    laCursul: "at the rate of",
    informativ: "for reference",
    lei: "RON",
    fara1: "item without a price — please confirm the price.",
    faraN: "items without a price — please confirm the price.",
    rugaminte: "Please confirm receipt of this order and the delivery date.",
    intocmit: "Prepared by",
    confirmare: "Supplier confirmation (name, signature, date)",
    generat: "issued from ERP Cash Machine",
    anulata: "CANCELLED",
    tipar: "Print / save as PDF",
    inapoi: "← Back to the order",
    altaLimba: "Română",
    cif: "VAT ID",
    regCom: "Trade reg. no.",
    tel: "Phone",
    numeFisier: "Purchase order",
  },
};

// „2026-11-05" → „05.11.2026". Ziua întâi, ca în România și ca în Germania.
function dataScrisa(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
}

// Numerele se scriu după limba foii: în engleză 84,672 și 0.23, în română
// 84.672 și 0,23. Un document englezesc cu „84.672" ar fi citit 84 virgulă
// ceva — vezi `scrieNumar` din lib/comenzi-furnizor-logica.js.
const suma = (v, limba) => L.scrieNumar(v, limba, 2, 2);
const pret = (v, limba) => L.scrieNumar(v, limba, 2, 4);
const cantitate = (v, limba) => L.scrieNumar(v, limba, 0, 3);
// Cursul are mereu sub o mie de lei: în engleză se schimbă doar virgula.
const curs_ = (v, limba) => (limba === "en" ? L.scrieCurs(v).replace(",", ".") : L.scrieCurs(v));

// Adresa firmei pe foaia în engleză: fără „Jud." și cu țara la coadă —
// furnizorul din Germania n-are de unde ști că Voluntari e în România.
function adresaPentru(adresa, limba) {
  const a = String(adresa || "").trim();
  if (limba !== "en" || !a) return a;
  const fara = a.replace(/\bJud\.\s*/i, "");
  return /rom[aâ]nia/i.test(fara) ? fara : fara + ", Romania";
}

// Rândurile cu echivalentul: în lei la orice comandă care nu e în lei, în euro
// la orice comandă care nu e în euro. Unde lipsește cursul, lipsește și
// rândul — pe o hârtie care pleacă afară nu se pune o cifră ghicită.
function randuriEchivalent(total, comanda, t, limba) {
  const { moneda, curs, cursEur } = L.cursurile(comanda);
  const e = L.echivalente(total, comanda);
  const out = [];
  if (moneda !== "RON" && e.ron !== null) {
    out.push(`${t.echivRon}: ${suma(e.ron, limba)} ${t.lei}, ${t.laCursul} ${curs_(curs, limba)} ${t.lei}/${moneda} (${t.informativ})`);
  }
  if (moneda !== "EUR" && e.eur !== null) {
    out.push(`${t.echivEur}: ${suma(e.eur, limba)} EUR, ${t.laCursul} ${curs_(cursEur, limba)} ${t.lei}/EUR (${t.informativ})`);
  }
  return out;
}

// Foaia întreagă.
//
// o.comanda  — capul comenzii, cu furnizorul alăturat (furnizor, furnizor_cui,
//              furnizor_adresa, furnizor_email)
// o.linii    — pozițiile ({ denumire, produs_cod, cantitate, um, pret_unitar })
// o.limba    — "ro" (implicit) sau "en"
// o.tipar    — true: deschide singur fereastra de tipar, din care se salvează PDF-ul
// o.emitent  — { nume, email } — cine a întocmit comanda
// o.inapoi   — adresa paginii comenzii, pentru bara de sus (care nu se tipărește)
// o.alta     — adresa aceleiași foi în cealaltă limbă
// o.generatLa — data și ora, pentru subsol
function pagina(o) {
  const opt = o || {};
  const limba = opt.limba === "en" ? "en" : "ro";
  const t = TEXTE[limba];
  const c = opt.comanda || {};
  const firma = Object.assign({}, FIRMA_NOASTRA, opt.firma || {});
  const linii = Array.isArray(opt.linii) ? opt.linii : [];
  const moneda = String(c.moneda || "RON").toUpperCase();
  const tot = L.totalComanda(linii);
  const anulata = c.status === "anulata";
  const numar = c.numar || "#" + (c.id || "");
  const titlu = `${t.numeFisier} ${numar}${c.furnizor ? " - " + c.furnizor : ""}`;

  // Coloana de cod doar dacă măcar o poziție are cod: la materie primă
  // cumpărată prima dată nu are niciuna, iar o coloană goală i-ar lua locul
  // denumirii, care e tocmai ce citește furnizorul.
  const cuCod = linii.some((l) => text(l.produs_cod) !== "");
  const randuri = linii
    .map((l, i) => {
      const v = L.valoareLinie(l);
      return `<tr>
        <td class="nr">${i + 1}</td>
        <td class="den">${esc(l.denumire)}</td>
        ${cuCod ? `<td class="cod">${esc(l.produs_cod || "")}</td>` : ""}
        <td class="num">${esc(cantitate(l.cantitate, limba))}</td>
        <td class="um">${esc(L.umInLimba(l.um, limba))}</td>
        <td class="num">${v === null ? `<span class="slab">${esc(t.deConfirmat)}</span>` : esc(pret(l.pret_unitar, limba))}</td>
        <td class="num">${v === null ? "—" : esc(suma(v, limba))}</td>
      </tr>`;
    })
    .join("");

  const echiv = tot.total > 0 ? randuriEchivalent(tot.total, c, t, limba) : [];
  const orar = L.ORAR_DESCARCARE[limba];
  const furnizorRand = (eticheta, valoare) => (valoare ? `<div>${eticheta ? esc(eticheta) + ": " : ""}${esc(valoare)}</div>` : "");

  const bara = [
    `<button type="button" class="principal" onclick="window.print()">${esc(t.tipar)}</button>`,
    opt.alta ? `<a href="${esc(opt.alta)}">${esc(t.altaLimba)}</a>` : "",
    opt.inapoi ? `<a href="${esc(opt.inapoi)}">${esc(t.inapoi)}</a>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `<!doctype html><html lang="${limba}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titlu)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eceff3; color:#111; font-family: Arial, "Helvetica Neue", "DejaVu Sans", sans-serif; font-size:10pt; }
  .bara { position:sticky; top:0; display:flex; flex-wrap:wrap; gap:10px; justify-content:center; align-items:center; padding:10px; background:#fff; border-bottom:1px solid #ccc; font-size:14px; }
  .bara button, .bara a { padding:8px 14px; border:1px solid #c9ced6; border-radius:6px; background:#fff; color:#111; text-decoration:none; font:inherit; cursor:pointer; }
  .bara .principal { background:#1f3a68; border-color:#1f3a68; color:#fff; font-weight:600; }
  .foaie { position:relative; width:186mm; min-height:270mm; margin:8mm auto; background:#fff; padding:10mm; box-shadow:0 1px 4px rgba(0,0,0,.12); }
  .antet { display:grid; grid-template-columns: 1fr 78mm; gap:8mm; align-items:start; padding-bottom:5mm; border-bottom:1.5pt solid #1f3a68; }
  .firma { font-size:13pt; font-weight:700; margin-bottom:1.5mm; }
  .antet .noi div { line-height:1.45; }
  .titlu { font-size:15pt; font-weight:800; letter-spacing:.02em; color:#1f3a68; text-align:right; margin-bottom:2mm; }
  table.meta { width:100%; border-collapse:collapse; }
  table.meta th { text-align:left; font-weight:400; color:#555; padding:1mm 2mm 1mm 0; white-space:nowrap; }
  table.meta td { text-align:right; font-weight:700; padding:1mm 0; }
  .parti { display:grid; grid-template-columns: 1fr 1fr; gap:6mm; margin:6mm 0 5mm; }
  .cutie { border:1pt solid #c9ced6; border-radius:2mm; padding:3mm 4mm; line-height:1.45; overflow-wrap:anywhere; }
  .eticheta { font-size:8pt; text-transform:uppercase; letter-spacing:.06em; color:#555; margin-bottom:1mm; }
  .cutie .nume { font-weight:700; }
  table.linii { width:100%; border-collapse:collapse; table-layout:fixed; }
  table.linii th { background:#eef1f6; font-size:8.5pt; font-weight:700; text-align:left; padding:2mm 1.5mm; border-bottom:1pt solid #8a94a6; vertical-align:bottom; }
  table.linii td { padding:2mm 1.5mm; border-bottom:.6pt solid #d7dbe2; vertical-align:top; }
  table.linii .nr { width:9mm; text-align:center; }
  table.linii .cod { width:22mm; font-size:8.5pt; color:#444; overflow-wrap:anywhere; }
  table.linii .um { width:16mm; }
  table.linii .num { text-align:right; white-space:nowrap; }
  table.linii th.num { text-align:right; }
  table.linii .den { overflow-wrap:anywhere; }
  .slab { color:#777; font-style:italic; }
  .orar { margin-top:2mm; padding-top:1.5mm; border-top:.6pt dashed #c9ced6; }
  .totaluri { margin-top:4mm; margin-left:auto; width:110mm; text-align:right; line-height:1.55; }
  .totaluri .total { font-size:12pt; }
  .totaluri .total strong { font-size:13pt; }
  .totaluri .echiv { font-size:8.5pt; color:#444; }
  .totaluri .fara { font-size:9pt; color:#8a4b00; }
  .observatii { margin-top:6mm; }
  .rugaminte { margin-top:6mm; }
  .semnaturi { display:grid; grid-template-columns: 1fr 1fr; gap:10mm; margin-top:10mm; line-height:1.5; }
  .semnaturi .loc { margin-top:12mm; border-top:.8pt solid #555; }
  .subsol { margin-top:10mm; font-size:7.5pt; color:#777; text-align:center; }
  .anulata { position:absolute; top:110mm; left:0; right:0; text-align:center; font-size:60pt; font-weight:900; color:rgba(179,38,30,.22); transform:rotate(-24deg); letter-spacing:.1em; pointer-events:none; }
  @media print {
    body { background:#fff; }
    .bara { display:none; }
    .foaie { width:auto; min-height:0; margin:0; padding:0; box-shadow:none; }
    table.linii tr { break-inside: avoid; }
  }
  @media screen and (max-width: 760px) {
    .foaie { width:auto; margin:0; padding:16px; min-height:0; }
    .linii-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
    table.linii { min-width:600px; }
    .antet, .parti, .semnaturi { grid-template-columns: 1fr; }
    .titlu { text-align:left; }
    .totaluri { width:auto; }
  }
</style></head><body>
${bara ? `<div class="bara">${bara}</div>` : ""}
<div class="foaie">
  ${anulata ? `<div class="anulata">${esc(t.anulata)}</div>` : ""}
  <div class="antet">
    <div class="noi">
      <div class="firma">${esc(firma.nume)}</div>
      ${furnizorRand(t.cif, firma.cif)}
      ${furnizorRand(t.regCom, firma.regCom)}
      ${furnizorRand("", adresaPentru(firma.adresa, limba))}
      ${furnizorRand(t.tel, firma.telefon)}
      ${furnizorRand("Email", opt.emitent && opt.emitent.email ? opt.emitent.email : firma.email)}
    </div>
    <div>
      <div class="titlu">${esc(t.titlu)}</div>
      <table class="meta">
        <tr><th>${esc(t.nr)}</th><td>${esc(numar)}</td></tr>
        <tr><th>${esc(t.data)}</th><td>${esc(dataScrisa(c.data))}</td></tr>
        <tr><th>${esc(t.moneda)}</th><td>${esc(moneda)}</td></tr>
        ${c.data_solicitata ? `<tr><th>${esc(t.livrare)}</th><td>${esc(dataScrisa(c.data_solicitata))}</td></tr>` : ""}
      </table>
    </div>
  </div>

  <div class="parti">
    <div class="cutie">
      <div class="eticheta">${esc(t.furnizor)}</div>
      <div class="nume">${esc(c.furnizor || "—")}</div>
      ${furnizorRand(t.cif, c.furnizor_cui)}
      ${furnizorRand("", c.furnizor_adresa)}
      ${furnizorRand("Email", c.furnizor_email)}
    </div>
    <div class="cutie">
      <div class="eticheta">${esc(t.obs)}</div>
      ${c.observatii ? `<div>${esc(c.observatii).replace(/\n/g, "<br>")}</div>` : ""}
      <div class="orar"><strong>${esc(orar[0])}:</strong> ${esc(orar[1]).replace(/ – /g, "&nbsp;–&nbsp;")}</div>
    </div>
  </div>

  <div class="linii-scroll">
  <table class="linii">
    <colgroup><col style="width:9mm"><col>${cuCod ? '<col style="width:22mm">' : ""}<col style="width:20mm"><col style="width:16mm"><col style="width:24mm"><col style="width:26mm"></colgroup>
    <thead><tr>
      <th class="nr">${esc(t.nrCrt)}</th><th>${esc(t.denumire)}</th>${cuCod ? `<th>${esc(t.cod)}</th>` : ""}
      <th class="num">${esc(t.cant)}</th><th>${esc(t.um)}</th>
      <th class="num">${esc(t.pu)}<br>(${esc(moneda)})</th><th class="num">${esc(t.val)}<br>(${esc(moneda)})</th>
    </tr></thead>
    <tbody>${randuri}</tbody>
  </table>
  </div>

  <div class="totaluri">
    <div class="total">${esc(tot.faraPret ? t.totalPartial : t.total)}: <strong>${esc(suma(tot.total, limba))} ${esc(moneda)}</strong></div>
    ${echiv.map((x) => `<div class="echiv">${esc(x)}</div>`).join("")}
    ${tot.faraPret ? `<div class="fara">${tot.faraPret} ${esc(tot.faraPret === 1 ? t.fara1 : t.faraN)}</div>` : ""}
  </div>

  <p class="rugaminte">${esc(t.rugaminte)}</p>

  <div class="semnaturi">
    <div>${esc(t.intocmit)},<br><strong>${esc((opt.emitent && opt.emitent.nume) || firma.nume)}</strong><br>${esc(firma.nume)}</div>
    <div>${esc(t.confirmare)}<div class="loc"></div></div>
  </div>

  <div class="subsol">${esc(numar)} · ${esc(t.generat)}${opt.generatLa ? " · " + esc(dataScrisa(opt.generatLa) + String(opt.generatLa).slice(10, 16)) : ""}</div>
</div>
${opt.tipar ? `<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 350); });</script>` : ""}
</body></html>`;
}

module.exports = { pagina, TEXTE, dataScrisa };
