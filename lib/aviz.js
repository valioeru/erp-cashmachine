"use strict";
// Avizul de însoțire a mărfii — foaia tipărită. Desen pur, fără bază de date,
// ca să se poată verifica într-un test.
//
// CE A CERUT VALI, 03.11.2026:
//   „Când se scoate marfa din depozit pentru livrare client se generează, în
//    loc de etichetă, aviz de însoțire a mărfii, fără preț produs, doar cu
//    produse, cantități și client. Nr. în continuare la acesta și format ca
//    cel din SmartBill” (cu avizul CHMA 1388 atașat) · „Fă și pagină de
//    generare aviz manual din Financiar … ține minte aceeași numerotare” ·
//   „Avizul să aibă pe el și nr. de comandă” · „Dacă nu are nr. de comandă,
//    nu pui.”
//
// Formatul e cel din SmartBill: furnizorul în stânga, titlul și seria la
// mijloc, clientul în dreapta; tabelul Nr. crt / Denumire / U.M. / Cant., cu
// coloanele trase până jos; dedesubt semnăturile, delegatul, transportul și
// primirea în gestiune. Fără preț, valoare, TVA și total — exact ce s-a cerut.
// Fără sigla și reclama SmartBill: avizul e al nostru, nu al lor.

// Datele firmei, cum apar pe avizul din SmartBill. În ERP nu existau
// (tabela „firme” ține doar nume și CUI), iar fiecare aviz își păstrează o
// copie a lor de la emitere, ca o schimbare de adresă să nu rescrie hârtiile
// vechi.
const FURNIZOR = {
  nume: "CASH MACHINE S.R.L.",
  regCom: "J2010002107232",
  cif: "RO27244210",
  adresa: "Str. Emil Racovita 31-33, Vila F16, Voluntari, Jud. Ilfov",
  iban: "RO10BRDE450SV99442324500",
  banca: "BRD Sucursala MCC",
  telefon: "+4046404046",
  fax: "+4046404046",
  email: "office@cashmachine.ro",
  capital: "50000",
};

// Câte rânduri are tabelul cel puțin: coloanele coboară până la subsol, ca pe
// avizul din SmartBill, chiar și cu un singur produs.
const RANDURI_MINIME = 18;

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function nr(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// 1500 → „1.500", 2,5 → „2,5". Cantitatea se citește de pe hârtie de om.
function cantitate(v) {
  return nr(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
}

// „2026-11-03" → „03/11/2026", ca pe avizul din SmartBill.
function dataAviz(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}

// Liniile cu același produs și aceeași unitate se adună: doi paleți cu
// aceeași cutie sunt un singur rând pe aviz, cu cantitatea totală. Ordinea e
// cea în care au apărut. Codurile paleților rămân lângă linie, pentru urmărire.
function agrega(linii) {
  const out = [];
  const dupaCheie = new Map();
  for (const l of Array.isArray(linii) ? linii : []) {
    const denumire = String(l.denumire || l.produs || l.produs_text || "").trim();
    const cant = nr(l.cantitate);
    if (!denumire || !(cant > 0)) continue;
    const um = String(l.um || "").trim();
    const cheie = (l.produs_id ? "P" + Number(l.produs_id) : "T" + denumire.toLowerCase()) + "|" + um.toLowerCase();
    let r = dupaCheie.get(cheie);
    if (!r) {
      r = { produs_id: l.produs_id ? Number(l.produs_id) : null, denumire, cod: l.cod || l.produs_cod || null, um, cantitate: 0, paleti: [] };
      dupaCheie.set(cheie, r);
      out.push(r);
    }
    r.cantitate = Math.round((r.cantitate + cant) * 1000) / 1000;
    if (l.palet && !r.paleti.includes(l.palet)) r.paleti.push(l.palet);
  }
  return out;
}

// Adresa clientului pe aviz. Cea importată din SmartBill are deja județul în
// ea („…, Jud. Dolj, Tara Romania"); unde lipsește, se adaugă din fișă.
function adresaClient(p) {
  const adresa = String((p && p.adresa) || "").trim();
  const bucati = [adresa];
  const judet = String((p && p.judet) || "").trim();
  const loc = String((p && p.localitate) || "").trim();
  const fara = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (loc && !fara(adresa).includes(fara(loc))) bucati.push(loc);
  if (judet && !fara(adresa).includes(fara(judet))) bucati.push("Jud. " + judet);
  return bucati.filter(Boolean).join(", ");
}

// Foaia întreagă. `optiuni.bara` = HTML-ul barei de sus (butoane), care nu se
// tipărește.
function pagina(aviz, linii, optiuni) {
  const o = optiuni || {};
  const f = (() => {
    try {
      return Object.assign({}, FURNIZOR, typeof aviz.furnizor === "string" ? JSON.parse(aviz.furnizor || "{}") : aviz.furnizor || {});
    } catch (e) {
      return FURNIZOR;
    }
  })();
  const rand = (eticheta, valoare) => (valoare ? `<div>${esc(eticheta)}: ${esc(valoare)}</div>` : "");
  const lista = Array.isArray(linii) ? linii : [];
  const goale = Math.max(0, RANDURI_MINIME - lista.length);
  const titlu = `Aviz ${aviz.serie} nr. ${aviz.numar}`;
  const anulat = Number(aviz.anulat) === 1;
  const puncte = "....................";

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<title>${esc(titlu)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eceff3; color:#000; font-family: Verdana, "DejaVu Sans", Arial, sans-serif; font-size:9.5pt; }
  .foaie { position:relative; width:190mm; min-height:277mm; margin:8mm auto; background:#fff; padding:0; display:flex; flex-direction:column; }
  .antet { border:1.2pt solid #000; display:grid; grid-template-columns: 1fr 64mm 1fr; gap:3mm; padding:3mm; line-height:1.35; }
  .titlu { text-align:center; font-weight:800; font-size:16pt; line-height:1.15; letter-spacing:.01em; }
  .serie { border:1pt solid #000; margin-top:3mm; padding:2mm 1mm; text-align:center; line-height:1.4; }
  .client-titlu, .furnizor-titlu { font-weight:400; }
  table.linii { width:100%; border-collapse:collapse; margin-top:3mm; border:1.2pt solid #000; table-layout:fixed; }
  table.linii th { font-weight:700; padding:2mm 1mm; border:1pt solid #000; text-align:center; vertical-align:middle; }
  table.linii tr.index td { text-align:center; border:1pt solid #000; padding:.6mm 0; font-size:9pt; }
  table.linii td { border-left:1pt solid #000; border-right:1pt solid #000; padding:1.6mm 1.5mm; vertical-align:top; }
  table.linii tr.linie td { padding-top:2.5mm; padding-bottom:2.5mm; }
  table.linii tr.gol td { height:7.2mm; }
  table.linii td.nr, table.linii td.um { text-align:center; }
  table.linii td.cant { text-align:right; white-space:nowrap; }
  table.linii td.den { overflow-wrap:anywhere; }
  .cod { color:#444; font-size:8pt; font-family: Consolas, "DejaVu Sans Mono", monospace; }
  .subsol { border:1.2pt solid #000; border-top:0; display:grid; grid-template-columns: 34mm 1fr 62mm; }
  .subsol > div { padding:1.5mm 2mm; line-height:1.45; }
  .subsol > div + div { border-left:1pt solid #000; }
  .primire { padding:0 !important; display:grid; grid-template-rows: 1fr 1fr; }
  .primire > div { padding:1.5mm 2mm; }
  .primire > div + div { border-top:1pt solid #000; }
  .comanda { margin-top:2mm; font-weight:700; }
  .obs { margin-top:2mm; font-size:9pt; }
  .anulat { position:absolute; top:95mm; left:0; right:0; text-align:center; font-size:64pt; font-weight:900; color:rgba(179,38,30,.25);
            transform:rotate(-24deg); letter-spacing:.1em; pointer-events:none; }
  .bara { text-align:center; padding:10px; background:#fff; border-bottom:1px solid #ccc; font-family: system-ui, "Segoe UI", Arial, sans-serif; font-size:14px; }
  .bara a, .bara button { margin:0 6px; }
  .bara .eroare { color:#b3261e; font-weight:600; }
  @media print { .bara { display:none; } body { background:#fff; } .foaie { margin:0; } }
</style></head><body>
${o.bara ? `<div class="bara">${o.bara}</div>` : ""}
<div class="foaie">
  ${anulat ? `<div class="anulat">ANULAT</div>` : ""}
  <div class="antet">
    <div class="furnizor">
      <div class="furnizor-titlu">Furnizor: ${esc(f.nume)}</div>
      ${rand("Reg. com.", f.regCom)}
      ${f.cif ? `<div>CIF: ${esc(f.cif)}</div>` : ""}
      ${rand("Adresa", f.adresa)}
      ${rand("IBAN", f.iban)}
      ${rand("Banca", f.banca)}
      ${rand("Tel.", f.telefon)}
      ${rand("Fax", f.fax)}
      ${rand("Email", f.email)}
      ${rand("Capital social", f.capital)}
    </div>
    <div>
      <div class="titlu">AVIZ DE ÎNSOȚIRE<br>A MĂRFII</div>
      <div class="serie">
        Seria ${esc(aviz.serie)} nr. ${esc(aviz.numar)}<br>
        Data (zi/luna/an): ${esc(dataAviz(aviz.data))}
      </div>
    </div>
    <div class="client">
      <div class="client-titlu">Client: ${esc(aviz.client_nume || "—")}</div>
      ${aviz.client_regcom ? `<div>Reg. com.: ${esc(aviz.client_regcom)}</div>` : ""}
      ${aviz.client_cui ? `<div>CIF: ${esc(aviz.client_cui)}</div>` : ""}
      ${aviz.client_adresa ? `<div>Adresa: ${esc(aviz.client_adresa)}</div>` : ""}
      ${aviz.comanda_numar ? `<div class="comanda">Comanda nr.: ${esc(aviz.comanda_numar)}</div>` : ""}
    </div>
  </div>

  <table class="linii">
    <colgroup><col style="width:16mm"><col><col style="width:20mm"><col style="width:28mm"></colgroup>
    <thead>
      <tr><th>Nr. crt</th><th>Denumirea produselor sau a serviciilor</th><th>U.M.</th><th>Cant.</th></tr>
      <tr class="index"><td>0</td><td>1</td><td>2</td><td>3</td></tr>
    </thead>
    <tbody>
      ${lista
        .map(
          (l, i) => `<tr class="linie">
        <td class="nr">${i + 1}</td>
        <td class="den">${esc(l.denumire)}${l.cod ? ` <span class="cod">(${esc(l.cod)})</span>` : ""}</td>
        <td class="um">${esc(l.um || "")}</td>
        <td class="cant">${esc(cantitate(l.cantitate))}</td>
      </tr>`
        )
        .join("")}
      ${'<tr class="gol"><td></td><td></td><td></td><td></td></tr>'.repeat(goale)}
    </tbody>
  </table>

  <div class="subsol">
    <div>Semnătura și ștampila furnizorului</div>
    <div>
      <div>Întocmit de: ${esc(aviz.creat_de || puncte)}</div>
      <div>CNP: ${puncte}</div>
      <div>Numele delegatului: ${esc(aviz.delegat || puncte)}</div>
      <div>B.I./C.I.: ${puncte}</div>
      <div>Mijloc transport: ${esc(aviz.mijloc_transport || puncte)}</div>
      <div>Expedierea s-a efectuat în prezența noastră la data de ${puncte} ora ..........</div>
      <div>Semnăturile:</div>
      ${aviz.observatii ? `<div class="obs">Observații: ${esc(aviz.observatii)}</div>` : ""}
      ${anulat && aviz.motiv_anulare ? `<div class="obs"><strong>Anulat:</strong> ${esc(aviz.motiv_anulare)}</div>` : ""}
    </div>
    <div class="primire">
      <div>Data primirii în gestiune și semnătura</div>
      <div>Semnătura de primire:</div>
    </div>
  </div>
</div>
</body></html>`;
}

module.exports = { FURNIZOR, RANDURI_MINIME, agrega, adresaClient, cantitate, dataAviz, pagina, esc };
