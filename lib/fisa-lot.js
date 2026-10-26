"use strict";
// FIȘA ÎNSOȚITOARE DE LOT — hârtia care merge cu marfa prin hală.
//
// Până acum, din ERP ieșea o „comandă de producție": ce se face, pentru cine,
// până când. Bună ca să știi ce ai de făcut, inutilă după aceea — nu rămânea
// nimic scris despre CUM a ieșit. Cine a stat la extruder, ce grosime a ieșit
// de fapt, câte kilograme au mers la rebut, cine a eliberat lotul. Când un
// client reclamă o pungă care se rupe, întrebarea „din ce lot e și ce grosime
// a avut" n-avea unde să fie căutată.
//
// Fișa asta e înregistrarea aia. Trei lucruri o fac să funcționeze în hală, nu
// doar pe hârtie:
//
//   • UN COD DE BARE PE FIECARE OPERAȚIE. Operatorul scanează la începutul
//     lucrului la post. Ora de start nu se mai scrie de mână (deci nu se mai
//     rotunjește „pe la 8"), iar trecerea lotului de la un post la altul se
//     vede în ERP fără ca cineva să raporteze ceva.
//
//   • SPECIFICAT LÂNGĂ REALIZAT. Pe operațiile cheie, parametrul cerut e deja
//     tipărit, iar lângă el e caseta goală. Diferența sare în ochi la post, nu
//     peste o săptămână în raport. Ce parametri se măsoară NU e scris aici —
//     stă pe pasul de flux, ca să-i poată schimba Vali din pagina Fluxuri.
//
//   • BUNE ȘI REBUT, SEPARAT, LA FIECARE POST. Un rebut scris doar la final nu
//     spune pe ce mașină s-a pierdut materialul.
//
// Operațiile nu sunt scrise de-a gata în cod. Mijlocul fișei e fluxul
// tehnologic al produsului (F-PUNGA, F-AWB, F-SAC-SGR...), iar fișa pune în
// jurul lui patru operații pe care le are orice lot, indiferent de produs:
// recepția materiei prime la început, controlul final, ambalarea și eliberarea
// lotului la sfârșit. Așa, un produs nou nu cere cod nou — cere un flux.
const codbare = require("./codbare");
const esc = codbare.esc;

// ---- Normalizarea numelor -------------------------------------------------
// „Lățime folie", „Latime folie (mm)" și „LATIME FOLIE" sunt același parametru.
// Dacă n-ar fi, coloana „Specificat" ar rămâne goală exact la produsele la care
// cineva a scris caracteristica cu altă diacritică.
function cheie(v) {
  return String(v == null ? "" : v)
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// „Grosime|µm;Lățime folie|mm;Tratament corona" → listă de parametri.
function parametri(text) {
  return String(text || "")
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const p = x.split("|");
      return { nume: (p[0] || "").trim(), um: (p[1] || "").trim() };
    })
    .filter((p) => p.nume)
    .slice(0, 12);
}

// Valoarea cerută pentru un parametru, căutată printre caracteristicile
// comenzii. Întâi potrivire exactă pe nume normalizat, apoi prefix — „Grosime"
// prinde „Grosime folie", fiindcă omul care a scris fluxul și omul care a scris
// caracteristica produsului n-au vorbit niciodată între ei.
function specificat(nume, caracteristici) {
  const k = cheie(nume);
  if (!k) return null;
  const lista = caracteristici || [];
  let g = lista.find((c) => cheie(c.denumire) === k);
  if (!g) g = lista.find((c) => cheie(c.denumire).startsWith(k) || k.startsWith(cheie(c.denumire)));
  if (!g) return null;
  const val = String(g.valoare == null ? "" : g.valoare).trim();
  if (!val) return null;
  return val + (g.unitate ? " " + g.unitate : "");
}

// ---- Codul lotului --------------------------------------------------------
// CM-261026-142: firma, ziua, comanda. Se citește cu ochiul liber și se scanează
// la fel de bine. Numărul comenzii intră curățat, fiindcă un „/" sau un spațiu
// într-un cod de bare se citește, dar nu se mai poate căuta înapoi în ERP.
function codLot(comanda) {
  const c = comanda || {};
  const zi = String(c.data_initiere || c.creat_la || "").slice(0, 10).replace(/-/g, "");
  const scurt = zi.length === 8 ? zi.slice(2) : "";
  return ["CM", scurt, String(c.id || "0")].filter(Boolean).join("-");
}

// Codul scanat la post. Scurt intenționat: la 0,26 mm pe modul, un cod de 20 de
// caractere trece de 60 mm și nu mai încape în coloana lui pe A4.
function codOperatie(comandaId, nr) {
  return "CMP" + String(comandaId) + "." + String(nr);
}

// ---- Operațiile -----------------------------------------------------------
// Capetele fișei: aceleași la orice produs. Traducerea stă lângă fiecare,
// fiindcă fișa pleacă și la clienți care cer documentația în engleză.
const INTRARE = {
  titlu: "Recepție materie primă",
  titluEn: "Raw material receipt",
  post: "Magazie / Warehouse",
  um: "kg",
  parametri: [{ nume: "Lot material furnizor", um: "" }, { nume: "Aviz / factură", um: "" }],
};
const IESIRE = [
  { titlu: "Control final lot", titluEn: "Final lot inspection", post: "Control calitate / QC", qc: true,
    parametri: [{ nume: "Dimensiuni verificate", um: "" }, { nume: "Sudură / rezistență", um: "" }, { nume: "Aspect imprimare", um: "" }] },
  { titlu: "Numărare, ambalare, etichetare", titluEn: "Counting, packing, labelling", post: "Ambalare / Packing",
    parametri: [{ nume: "Buc./cutie", um: "" }, { nume: "Nr. colete", um: "" }, { nume: "Etichetă lot aplicată", um: "" }] },
  { titlu: "Eliberare și livrare", titluEn: "Lot release & dispatch", post: "Expediție / Dispatch",
    parametri: [{ nume: "Aviz / AWB", um: "" }, { nume: "Destinatar", um: "" }] },
];

// Puținele cuvinte de care are nevoie un cititor străin. Nu e un traducător —
// e o listă scurtă, și ce nu e în ea rămâne doar în română, ceea ce e corect:
// mai bine fără traducere decât cu una inventată.
const EN = [
  [/extrudare/i, "Film extrusion"],
  [/debitare la l[ăa]/i, "Slitting to width"],
  [/debitare/i, "Slitting"],
  [/imprimare flexo|flexo/i, "Flexo printing"],
  [/imprimare/i, "Printing"],
  [/laminare/i, "Lamination"],
  [/confec[țt]ionare pungi/i, "Bag making"],
  [/confec[țt]ionare saci/i, "Sack making"],
  [/confec[țt]ionare/i, "Converting"],
  [/lipire/i, "Sealing"],
  [/ambalare/i, "Packing"],
  [/t[ăa]iere/i, "Cutting"],
];
function engleza(operatie) {
  for (const [rx, en] of EN) if (rx.test(String(operatie || ""))) return en;
  return "";
}

// Numele procesului în engleză, pentru antet. Clienții de curierat cer
// documentația bilingvă; restul fișei o are, antetul ar fi arătat prost fără.
const PROCES_EN = {
  "F-PUNGA": "COURIER BAGS",
  "F-SAC-SGR": "SGR SACKS",
  "F-AWB": "AWB POUCHES",
  "F-CUTIE-AM": "CARTON BOXES",
  "F-CUTIE-SIMPLA": "CARTON BOXES",
  "F-SAC-MENAJ": "REFUSE SACKS",
  "F-BANDA": "ADHESIVE TAPE",
  "F-STRETCH-PRE": "PRE-STRETCH FILM",
  "F-STRETCH-MAN": "HAND STRETCH FILM",
  "F-STRETCH-AUT": "MACHINE STRETCH FILM",
  "F-FOLIE-DEBITATA": "SLIT FILM",
  "F-ETICHETE": "SELF-ADHESIVE LABELS",
};
function procesEnglez(flux) {
  return (flux && PROCES_EN[String(flux.cod || "").toUpperCase()]) || "PRODUCTION";
}

// Lista completă de operații a unei fișe: recepția, pașii fluxului, închiderea.
// Numerotate din zece în zece (010, 020, 030...) ca să se poată insera o
// operație între două fără să se renumeroteze hârtiile deja tipărite.
function operatii(pasi, optiuni) {
  const o = optiuni || {};
  const umFinal = String(o.um || "buc").trim() || "buc";
  const brute = [];
  brute.push(Object.assign({}, INTRARE, { tip: "OBLIGATORIU" }));
  for (const p of pasi || []) {
    brute.push({
      titlu: String(p.operatie || "Operație").trim(),
      titluEn: engleza(p.operatie),
      post: [p.utilaj_cod, p.utilaj_denumire].filter(Boolean).join(" · "),
      tip: String(p.tip_pas || "OBLIGATORIU").toUpperCase(),
      conditie: p.conditie || "",
      parametri: parametri(p.parametri),
    });
  }
  for (const x of IESIRE) brute.push(Object.assign({}, x, { tip: "OBLIGATORIU" }));

  // Unitatea de măsură se schimbă o dată pe fișă: până la confecționare se
  // lucrează folie (kg), după aceea bucăți. Dacă s-ar scrie „buc" la extruder,
  // operatorul ar trece acolo numărul de pungi pe care nu le-a făcut încă.
  let dupaConfectie = false;
  return brute.map((x, i) => {
    if (/confec|pungi|saci|plicuri|t[ăa]iere|debitare plicuri|ambalare|numarare|num[ăa]rare|control final|eliberare/i.test(x.titlu)) {
      dupaConfectie = true;
    }
    return Object.assign({}, x, {
      nr: String((i + 1) * 10).padStart(3, "0"),
      um: x.um || (dupaConfectie ? umFinal : "kg"),
    });
  });
}

// 100000 se citește greu de pe o hârtie ținută în mână lângă o mașină. Nu
// folosim helperul din lib/render tocmai ca fișa să rămână desenabilă fără
// bază de date; regula e aceeași: punct la mii, virgulă la zecimale.
function numar(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return s;
  const semn = s.startsWith("-") ? "-" : "";
  const bucati = s.replace("-", "").replace(",", ".").split(".");
  return semn + bucati[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (bucati[1] ? "," + bucati[1] : "");
}

// ---- Desenul fișei --------------------------------------------------------
const randParam = (p, caracteristici) => {
  const cerut = specificat(p.nume, caracteristici);
  return `<tr>
      <th>${esc(p.nume)}${p.um ? ` <span class="um">(${esc(p.um)})</span>` : ""}</th>
      <td class="spec">${cerut ? esc(cerut) : ""}</td>
      <td class="real"></td>
    </tr>`;
};

function blocParametri(op, caracteristici) {
  if (!op.parametri || !op.parametri.length) return "";
  const jum = Math.ceil(op.parametri.length / 2);
  const coloane = [op.parametri.slice(0, jum), op.parametri.slice(jum)].filter((c) => c.length);
  return `<div class="param">
      ${coloane
        .map(
          (col) => `<table class="t-param">
            <tr><th class="cap-p">Parametru</th><th class="cap-p">Specificat</th><th class="cap-p">Realizat</th></tr>
            ${col.map((p) => randParam(p, caracteristici)).join("")}
          </table>`
        )
        .join("")}
    </div>`;
}

function randOperatie(op, comandaId, caracteristici) {
  const cod = codOperatie(comandaId, op.nr);
  return `<tr class="op">
      <td class="nr">${esc(op.nr)}</td>
      <td class="ce">
        <b>${esc(op.titlu)}</b>${op.titluEn ? `<div class="en">${esc(op.titluEn)}</div>` : ""}
        ${op.post ? `<div class="post">${esc(op.post)}</div>` : ""}
        ${op.tip === "OPTIONAL" ? `<div class="optional">se aplică doar dacă: ${esc(op.conditie || "—")} · altfel N/A</div>` : ""}
        ${blocParametri(op, caracteristici)}
      </td>
      <td class="bar">${codbare.svg(cod, { inalt: 8, modul: 0.28 })}</td>
      <td class="semn"></td>
      <td class="ora"></td>
      <td class="cant">
        <div>Bune (${esc(op.um)}):</div>
        <div class="rebut">Rebut (${esc(op.um)}):</div>
      </td>
      <td class="qc"></td>
    </tr>`;
}

// Fișa întreagă. „date" aduce comanda, liniile, caracteristicile, operațiile și
// alocarea; desenul nu mai atinge baza de date, ca să se poată tipări o fișă de
// probă dintr-un test, fără Postgres.
function fisa(date) {
  const d = date || {};
  const c = d.comanda || {};
  const linii = d.linii || [];
  const carac = d.caracteristici || [];
  const ops = d.operatii || [];
  const lot = d.lot || codLot(c);
  const proces = d.proces || "PRODUCȚIE";
  const procesEn = d.procesEn || "PRODUCTION";

  const produse = linii.length
    ? linii
    : [{ denumire: c.tip_produs, produs_cod: null, cantitate: c.cantitate, um: c.um, id: null }];

  const randuriProdus = produse
    .map((l) => {
      const ale = carac.filter((x) => l.id != null && String(x.linie_id) === String(l.id));
      const text = (ale.length ? ale : l.id == null ? carac : [])
        .map((x) => `${esc(x.denumire)}: <b>${esc(x.valoare)}</b>${x.unitate ? " " + esc(x.unitate) : ""}`)
        .join(" · ");
      return `<tr>
        <td><b>${esc(l.denumire || "—")}</b>${text ? `<div class="en">${text}</div>` : ""}</td>
        <td class="mono">${esc(l.produs_cod || "—")}</td>
        <td class="cant-mare">${esc(numar(l.cantitate))} ${esc(l.um || c.um || "buc")}</td>
      </tr>`;
    })
    .join("");

  const alocari = d.alocari || [];
  const alocHtml = alocari.length
    ? `<table class="t-mic">
         <tr><th>Data</th><th>Interval</th><th>Utilaj</th><th>Cantitate</th><th>Echipa</th></tr>
         ${alocari
           .map(
             (a) => `<tr><td>${esc(a.data || "")}</td><td>${esc(a.interval || "")}</td><td>${esc(a.utilaj || "—")}</td>
                     <td>${esc(numar(a.cantitate))}</td><td>${esc(a.oameni || "")}</td></tr>`
           )
           .join("")}
       </table>`
    : `<p class="gol">Lotul nu e încă alocat pe utilaj — se alocă din Producție → Planificare.</p>`;

  return `<!doctype html>
<html lang="ro"><head><meta charset="utf-8">
<title>Fișă lot ${esc(lot)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; color: #000; margin: 0; background: #e9edf1; font-size: 9.5pt; }
  .bara { padding: 10px 16px; background: #fff; border-bottom: 1px solid #ccd5de; font-size: 13px; position: sticky; top: 0; z-index: 5; }
  .bara button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #2f5f92; background: #2f5f92; color: #fff; cursor: pointer; }
  .bara a { color: #2f5f92; margin-left: 12px; }
  /* Pe hartie foaia e A4 si scrisul e de 9,5 pt — corect pentru tipar, dar prea
     mic pe un monitor lat, unde A4 ocupa o treime din ecran. De-aia foaia se
     mareste pe ecran, atat cat incape, si revine la 1:1 cand se tipareste.
     Daca ajunge pe un browser fara „zoom", nu se strica nimic: ramane la fel
     de citibila ca pana acum. */
  .foaie { width: 210mm; margin: 14px auto; padding: 10mm; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
  @media screen and (min-width: 1150px) { .foaie { zoom: 1.25; } }
  @media screen and (min-width: 1500px) { .foaie { zoom: 1.5; } }

  table { width: 100%; border-collapse: collapse; }
  td, th { border: 0.6pt solid #000; padding: 2.4pt 4pt; vertical-align: top; text-align: left; }

  .antet td { padding: 3pt 5pt; }
  .firma { font-size: 12pt; font-weight: bold; letter-spacing: .4pt; }
  .iso { font-size: 7.5pt; }
  .titlu { text-align: center; font-size: 12.5pt; font-weight: bold; letter-spacing: .3pt; }
  .titlu .en { font-weight: normal; font-size: 8.5pt; letter-spacing: 0; }
  .mic { font-size: 7.5pt; }

  .ident { margin-top: 3mm; }
  .ident th { width: 26mm; background: #f1f4f7; font-size: 8pt; }
  .ident .mono, .mono { font-family: "Courier New", monospace; }
  .lot { font-family: "Courier New", monospace; font-size: 11.5pt; font-weight: bold; letter-spacing: .5pt; }
  .cant-mare { font-size: 11pt; font-weight: bold; white-space: nowrap; }
  .cod-lot { text-align: center; border-left: 0.6pt solid #000; }

  .banda { background: #000; color: #fff; font-weight: bold; letter-spacing: 1.2pt; font-size: 9pt; padding: 3pt 5pt; margin-top: 4mm; }
  .banda span { float: right; font-weight: normal; letter-spacing: 0; font-size: 7.5pt; }

  .t-op th.cap { background: #e8edf2; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .3pt; vertical-align: middle; }
  .t-op .nr { width: 9mm; text-align: center; font-weight: bold; font-family: "Courier New", monospace; }
  .t-op .ce { width: 76mm; }
  .t-op .bar { width: 38mm; text-align: center; vertical-align: middle; }
  .t-op .semn { width: 27mm; }
  .t-op .ora { width: 17mm; }
  .t-op .cant { width: 24mm; font-size: 7.5pt; }
  .t-op .qc { width: 9mm; }
  .t-op .cant div { border-bottom: 0.4pt dotted #666; padding-bottom: 5pt; margin-bottom: 3pt; }
  .t-op .cant .rebut { border-bottom: 0; margin-bottom: 0; }
  .t-op .en { font-size: 7.5pt; font-style: italic; }
  .t-op .post { font-size: 7.5pt; margin-top: 1pt; }
  .t-op .optional { font-size: 7pt; margin-top: 1.5pt; padding: 1pt 3pt; border: 0.4pt dashed #000; display: inline-block; }
  .cod-bare { display: block; margin: 0 auto; }

  .param { display: flex; gap: 2mm; margin-top: 2pt; }
  .param .t-param { flex: 1; }
  .t-param th, .t-param td { border: 0.4pt solid #8a8a8a; padding: 1pt 3pt; font-size: 7.5pt; font-weight: normal; }
  .t-param .cap-p { background: #f1f4f7; font-size: 6.8pt; text-transform: uppercase; white-space: nowrap; }
  .t-param th { width: 46%; }
  .t-param .spec { width: 27%; font-weight: bold; }
  .t-param .real { width: 27%; background: #fcfcfc; }
  .t-param .um { font-weight: normal; }

  .t-mic td, .t-mic th { font-size: 8pt; padding: 1.8pt 4pt; }
  .t-mic th { background: #f1f4f7; }
  .gol { font-size: 8pt; font-style: italic; margin: 2pt 0 0; }
  .nota { margin-top: 3mm; border: 0.6pt solid #000; padding: 3pt 5pt; font-size: 7.5pt; }
  .nota b { text-transform: uppercase; letter-spacing: .3pt; }
  .semnaturi { margin-top: 3mm; }
  .semnaturi td { height: 17mm; font-size: 8pt; }
  .subsol { margin-top: 2.5mm; font-size: 7pt; text-align: center; }

  @media print {
    .bara { display: none; }
    body { background: #fff; }
    .foaie { margin: 0; padding: 0; width: auto; box-shadow: none; }
    .t-op tr.op { page-break-inside: avoid; }
    thead { display: table-header-group; }
  }
</style></head>
<body>
<div class="bara">
  <button onclick="window.print()">Tipărește fișa de lot</button>
  <a href="/productie/${esc(String(c.id || ""))}">← Înapoi la comandă</a>
  <a href="/fluxuri">Operațiile vin din fluxul tehnologic →</a>
</div>
<div class="foaie">

  <table class="antet">
    <tr>
      <td style="width:52mm">
        <div class="firma">CASH MACHINE SRL</div>
        <div class="iso">Sistem de Management al Calității<br>SR EN ISO 9001:2015</div>
      </td>
      <td class="titlu">
        FIȘĂ ÎNSOȚITOARE LOT
        <div class="en">PRODUCTION TRAVELER</div>
        <div class="mic">Proces: ${esc(proces)} / Process: ${esc(procesEn)}</div>
      </td>
      <td style="width:40mm" class="mic">
        Cod document: <b>F-PR-01</b><br>
        Ediția: <b>1</b> &nbsp; Revizia: <b>0</b><br>
        Tipărită: <b>${esc(d.tiparitLa || "")}</b>
      </td>
    </tr>
  </table>

  <table class="ident">
    <tr>
      <th>Cod lot<div class="mic">Lot code</div></th>
      <td><span class="lot">${esc(lot)}</span></td>
      <th>Comandă<div class="mic">Order</div></th>
      <td>${esc(c.numar || String(c.id || ""))}${c.data_initiere ? ` <span class="mic">· plasată ${esc(c.data_initiere)}</span>` : ""}</td>
      <td class="cod-lot" rowspan="3" style="width:56mm">${codbare.svg(lot, { inalt: 13, modul: 0.34 })}</td>
    </tr>
    <tr>
      <th>Client<div class="mic">Customer</div></th>
      <td>${esc(c.partener_nume || c.client_text || "—")}</td>
      <th>Termen<div class="mic">Due date</div></th>
      <td>${esc(c.data_livrare || c.data_solicitata || "—")}</td>
    </tr>
    <tr>
      <th>Flux<div class="mic">Route</div></th>
      <td>${esc(d.fluxText || "—")}</td>
      <th>Reprezentant<div class="mic">Sales</div></th>
      <td>${esc(c.agent_nume || c.reprezentant || "—")}</td>
    </tr>
  </table>

  <table class="ident" style="margin-top:2mm">
    <tr><th class="mic" style="width:auto">Produs / Product</th><th class="mic" style="width:34mm">Cod produs</th><th class="mic" style="width:34mm">Cantitate</th></tr>
    ${randuriProdus}
  </table>

  <div class="banda">OPERAȚII / OPERATIONS <span>Se scanează codul operației la începerea lucrului la post</span></div>
  <table class="t-op">
    <thead><tr>
      <th class="cap nr">Op</th>
      <th class="cap ce">Operație / Post · parametri</th>
      <th class="cap bar">Cod de bare — scanează la post</th>
      <th class="cap semn">Operator / semnătura</th>
      <th class="cap ora">Data, ora</th>
      <th class="cap cant">Cantitate</th>
      <th class="cap qc">QC</th>
    </tr></thead>
    <tbody>
      ${ops.map((op) => randOperatie(op, c.id, carac)).join("")}
    </tbody>
  </table>

  <div class="banda" style="margin-top:3mm">ALOCARE PE UTILAJ / MACHINE SCHEDULE</div>
  ${alocHtml}

  ${c.observatii ? `<div class="nota"><b>Observații la lot:</b> ${esc(c.observatii)}</div>` : ""}

  <div class="nota">
    <b>Instrucțiuni</b> — Scanează codul operației la începutul lucrului la post. Se notează cantitatea bună, rebutul
    și parametrii realizați la operațiile cheie; verificările și neconformitățile se raportează în ERP. Fișa
    însoțește lotul până la expediție și se arhivează cu dosarul lotului.<br>
    <span class="mic"><i>Scan the operation barcode when starting work at the station. Record good quantity, scrap and
    actual parameters at key operations; checks and non-conformities are reported in the ERP. The traveler stays with
    the lot until dispatch and is archived with the lot file.</i></span>
  </div>

  <table class="semnaturi">
    <tr>
      <td>Emis de / Responsabil producție<div class="mic">Nume / Semnătură / Data</div></td>
      <td>Eliberare lot — Control calitate<div class="mic">Nume / Semnătură / Data</div></td>
    </tr>
  </table>

  <div class="subsol">
    CASH MACHINE SRL — înregistrare a calității conform SR EN ISO 9001:2015 (cap. 7.5.3, 8.5.2 identificare și
    trasabilitate) — uz intern / quality record — internal use · Lot ${esc(lot)}
  </div>
</div>
</body></html>`;
}

module.exports = { fisa, operatii, codLot, codOperatie, parametri, specificat, cheie, engleza, procesEnglez, numar, PROCES_EN };
