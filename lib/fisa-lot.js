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
  titlu: "Raw material receipt",
  titluEn: "Recepție materie primă",
  post: "Warehouse / Magazie",
  um: "kg",
  parametri: [{ nume: "Supplier material lot", um: "" }, { nume: "Delivery note / invoice", um: "" }],
};
const IESIRE = [
  { titlu: "Final lot inspection", titluEn: "Control final lot", post: "Quality control / QC", qc: true,
    parametri: [{ nume: "Dimensions checked", um: "" }, { nume: "Seal / strength", um: "" }, { nume: "Print appearance", um: "" }] },
  { titlu: "Counting, packing, labelling", titluEn: "Numărare, ambalare, etichetare", post: "Packing / Ambalare",
    parametri: [{ nume: "Pcs / box", um: "" }, { nume: "No. of parcels", um: "" }, { nume: "Lot label applied", um: "" }] },
  { titlu: "Lot release & dispatch", titluEn: "Eliberare și livrare", post: "Dispatch / Expediție",
    parametri: [{ nume: "Delivery note / AWB", um: "" }, { nume: "Consignee", um: "" }] },
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
      // Operatia vine din flux scrisa in romana. Pe fisa, engleza trece in
      // fata: hala e plina de oameni care nu citesc romana, iar hartia asta se
      // citeste la 6 dimineata, nu se studiaza.
      titlu: engleza(p.operatie) || String(p.operatie || "Operation").trim(),
      titluEn: engleza(p.operatie) ? String(p.operatie || "").trim() : "",
      post: [p.utilaj_cod, p.utilaj_denumire].filter(Boolean).join(" · "),
      tip: String(p.tip_pas || "OBLIGATORIU").toUpperCase(),
      conditie: p.conditie || "",
      parametri: parametri(p.parametri),
      // Utilajul pe care s-a alocat efectiv comanda, când există. Fluxul spune
      // „UT10|UT11" — pe hârtie, în hală, asta nu ajută pe nimeni: omul trebuie
      // să știe pe care din două merge lotul lui.
      ales: p.ales || null,
      // Cine ȘTIE să lucreze utilajul ăsta, și cine e deja pus pe el. Fără
      // lista asta, fișa ajunge la un post unde nu e nimeni calificat și se
      // descoperă la 6 dimineața.
      alocati: p.alocati || [],
      operatori: p.operatori || [],
      altiiCalificati: Number(p.altiiCalificati) || 0,
    });
  }
  for (const x of IESIRE) brute.push(Object.assign({}, x, { tip: "OBLIGATORIU" }));

  // Unitatea de măsură se schimbă o dată pe fișă: până la confecționare se
  // lucrează folie (kg), după aceea bucăți. Dacă s-ar scrie „buc" la extruder,
  // operatorul ar trece acolo numărul de pungi pe care nu le-a făcut încă.
  let dupaConfectie = false;
  return brute.map((x, i) => {
    // Se caută în AMÂNDOUĂ titlurile, nu doar în cel afișat. De când fișa e în
    // engleză, titlul afișat e „Bag making", iar o potrivire scrisă doar pe
    // cuvintele românești n-ar mai fi găsit nimic: toată fișa ar fi rămas în
    // kilograme, inclusiv la numărat pungi. Românescul rămâne în titluEn, iar
    // pașii de flux fără traducere rămân cu românescul în titlu — ambele cazuri
    // sunt acoperite dacă le lipim.
    const sursa = [x.titlu, x.titluEn].filter(Boolean).join(" ");
    if (/confec|pungi|saci|plicuri|t[ăa]iere|debitare plicuri|ambalare|numarare|num[ăa]rare|control final|eliberare/i.test(sursa) ||
        /bag making|sack making|pouch|cutting|packing|counting|final lot inspection|release|dispatch/i.test(sursa)) {
      dupaConfectie = true;
    }
    // Toate operațiile ies cu aceeași formă, și cele de capăt (recepție,
    // control, ambalare, eliberare) care n-au utilaj. Altfel desenul ar trebui
    // să întrebe de fiecare dată dacă există câmpul, iar un „undefined" scăpat
    // ajunge scris pe hârtie.
    return Object.assign({ ales: null, alocati: [], operatori: [], altiiCalificati: 0 }, x, {
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

// Unitățile se scriu în engleză pe fișă, fiindcă restul hârtiei e în engleză.
// „BUC" cu majuscule vine din datele comenzii — nu-l corectăm acolo, doar îl
// arătăm cum trebuie aici.
const UM_EN = { buc: "pcs", bucata: "pcs", bucati: "pcs", kg: "kg", g: "g", m: "m", ml: "m", mp: "m2", l: "l", rola: "rolls", role: "rolls", set: "sets", cutie: "boxes", cutii: "boxes", palet: "pallets", paleti: "pallets" };
function um(v) {
  const s = String(v == null ? "" : v).trim();
  return UM_EN[s.toLowerCase()] || s;
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
            <tr><th class="cap-p">Parameter</th><th class="cap-p">Specified</th><th class="cap-p">Actual</th></tr>
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
        ${
          op.ales
            ? `<div class="post"><b>${esc(op.ales)}</b> <span class="ales">machine assigned</span></div>`
            : op.post
              ? `<div class="post">${esc(op.post)}${/\|/.test(op.post) ? ' <span class="neales">not assigned yet</span>' : ""}</div>`
              : ""
        }
        ${
          (op.alocati && op.alocati.length) || (op.operatori && op.operatori.length)
            ? `<div class="cine">${
                op.alocati && op.alocati.length ? `<b>Assigned:</b> ${esc(op.alocati.join(", "))}` : ""
              }${op.alocati && op.alocati.length && op.operatori && op.operatori.length ? " · " : ""}${
                op.operatori && op.operatori.length
                  ? `Qualified: ${esc(op.operatori.join(", "))}${op.altiiCalificati ? ` +${op.altiiCalificati}` : ""}`
                  : ""
              }</div>`
            : ""
        }
        ${op.tip === "OPTIONAL" ? `<div class="optional">applies only if: ${esc(op.conditie || "—")} · otherwise N/A</div>` : ""}
        ${blocParametri(op, caracteristici)}
      </td>
      <td class="bar">${codbare.svg(cod, { inalt: 8, modul: 0.28 })}</td>
      <td class="semn"></td>
      <td class="ora"></td>
      <td class="cant">
        <div>Good (${esc(um(op.um))}):</div>
        <div class="rebut">Scrap (${esc(um(op.um))}):</div>
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
        <td class="cant-mare">${esc(numar(l.cantitate))} ${esc(um(l.um || c.um || "buc"))}</td>
      </tr>`;
    })
    .join("");

  const alocari = d.alocari || [];
  const alocHtml = alocari.length
    ? `<table class="t-mic">
         <tr><th>Date</th><th>Time</th><th>Machine</th><th>Quantity</th><th>Team</th></tr>
         ${alocari
           .map(
             (a) => `<tr><td>${esc(a.data || "")}</td><td>${esc(a.interval || "")}</td><td>${esc(a.utilaj || "—")}</td>
                     <td>${esc(numar(a.cantitate))}</td><td>${esc(a.oameni || "")}</td></tr>`
           )
           .join("")}
       </table>`
    : `<p class="gol">Lot not scheduled on a machine yet — schedule it from Producție → Planificare.</p>`;

  return `<!doctype html>
<html lang="ro"><head><meta charset="utf-8">
<title>Lot traveler ${esc(lot)}</title>
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
  .t-op .ales { font-size: 6.5pt; border: 0.4pt solid #000; padding: 0 2pt; }
  .t-op .neales { font-size: 6.5pt; font-style: italic; }
  .t-op .cine { font-size: 7pt; margin-top: 1.5pt; }
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
        <div class="iso">Quality Management System<br>SR EN ISO 9001:2015</div>
      </td>
      <td class="titlu">
        PRODUCTION TRAVELER
        <div class="en">FIȘĂ ÎNSOȚITOARE LOT</div>
        <div class="mic">Process: ${esc(procesEn)} / Proces: ${esc(proces)}</div>
      </td>
      <td style="width:40mm" class="mic">
        Document code: <b>F-PR-01</b><br>
        Edition: <b>1</b> &nbsp; Revision: <b>0</b><br>
        Printed: <b>${esc(d.tiparitLa || "")}</b>
      </td>
    </tr>
  </table>

  <table class="ident">
    <tr>
      <th>Lot code<div class="mic">Cod lot</div></th>
      <td><span class="lot">${esc(lot)}</span></td>
      <th>Order<div class="mic">Comandă</div></th>
      <td>${esc(c.numar || String(c.id || ""))}${c.data_initiere ? ` <span class="mic">· placed ${esc(c.data_initiere)}</span>` : ""}</td>
      <td class="cod-lot" rowspan="3" style="width:56mm">${codbare.svg(lot, { inalt: 13, modul: 0.34 })}</td>
    </tr>
    <tr>
      <th>Customer<div class="mic">Client</div></th>
      <td>${esc(c.partener_nume || c.client_text || "—")}</td>
      <th>Due date<div class="mic">Termen</div></th>
      <td>${esc(c.data_livrare || c.data_solicitata || "—")}</td>
    </tr>
    <tr>
      <th>Route<div class="mic">Flux</div></th>
      <td colspan="3">${esc(d.fluxText || "—")}</td>
    </tr>
  </table>

  <table class="ident" style="margin-top:2mm">
    <tr><th class="mic" style="width:auto">Product / Produs</th><th class="mic" style="width:34mm">Product code</th><th class="mic" style="width:34mm">Quantity</th></tr>
    ${randuriProdus}
  </table>

  <div class="banda">OPERATIONS / OPERAȚII <span>Scan the operation barcode when starting work at the station</span></div>
  <table class="t-op">
    <thead><tr>
      <th class="cap nr">Op</th>
      <th class="cap ce">Operation / station · parameters</th>
      <th class="cap bar">Barcode — scan at station</th>
      <th class="cap semn">Operator / signature</th>
      <th class="cap ora">Date, time</th>
      <th class="cap cant">Quantity</th>
      <th class="cap qc">QC</th>
    </tr></thead>
    <tbody>
      ${ops.map((op) => randOperatie(op, c.id, carac)).join("")}
    </tbody>
  </table>

  <div class="banda" style="margin-top:3mm">MACHINE SCHEDULE / ALOCARE PE UTILAJ</div>
  ${alocHtml}

  ${c.observatii ? `<div class="nota"><b>Lot notes:</b> ${esc(c.observatii)}</div>` : ""}

  <div class="nota">
    <b>Instructions</b> — Scan the operation barcode when starting work at the station. Record good quantity, scrap
    and actual parameters at key operations; checks and non-conformities are reported in the ERP. The traveler stays
    with the lot until dispatch and is archived with the lot file.<br>
    <span class="mic"><i>Scanează codul operației la începutul lucrului la post. Se notează cantitatea bună, rebutul
    și parametrii realizați la operațiile cheie; verificările și neconformitățile se raportează în ERP. Fișa
    însoțește lotul până la expediție și se arhivează cu dosarul lotului.</i></span>
  </div>

  <table class="semnaturi">
    <tr>
      <td>Issued by / Production manager<div class="mic">Name / Signature / Date</div></td>
      <td>Lot release — Quality control<div class="mic">Name / Signature / Date</div></td>
    </tr>
  </table>

  <div class="subsol">
    CASH MACHINE SRL — quality record per SR EN ISO 9001:2015 (cl. 7.5.3, 8.5.2 identification and traceability)
    — internal use / înregistrare a calității — uz intern · Lot ${esc(lot)}
  </div>
</div>
</body></html>`;
}

module.exports = { fisa, operatii, codLot, codOperatie, parametri, specificat, cheie, engleza, procesEnglez, numar, um, PROCES_EN };
