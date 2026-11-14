"use strict";
// Etichetele de produs, pe loturi: ce scrie pe ele, cum arată și cum se
// numerotează. Fără bază de date, ca să se poată verifica într-un test;
// paginile și tabelele sunt în modules/etichete-produs.js.
//
// CE A CERUT VALI, 13.11.2026:
//   „Un generator de etichete de produs cu denumire, caracteristici, număr lot
//    etc., configurabil, cu sigla Cash Machine, adresa, tel. și emailul de
//    office. Să alegi ce câmpuri adaugi pe etichetă și formatul 100×150 sau
//    100×50. Alegi la final câte să printezi cu acel nr. de lot; ulterior mai
//    poți printa suplimentar. Și cu cod de bare pe fiecare produs, ca să le
//    poți urca pe raft ușor cu scanerul. În zona de producție."
//   „Să țină minte fiecare lot de etichete imprimate, data și cine le-a
//    imprimat."
//   „Grafica să rămână mereu la fel, doar conținutul se va modifica în funcție
//    de parametri, de «printează din nou» etc. Se schimbă data etc."
//
// GRAFICA E FIXĂ. Fiecare format are zonele lui, cu înălțimi și poziții fixe:
// antetul cu sigla și firma, produsul, caracteristicile, căsuțele cu date,
// numărul etichetei și codurile de bare. Un câmp nebifat își lasă căsuța goală,
// nu mută restul: codul de bare stă mereu în același loc, iar două etichete ale
// aceluiași lot arată la fel, oricând ar fi tipărite. Se schimbă doar textul:
// numărul etichetei, data tipăririi și ce s-a scris altfel la o tipărire.
//
// CODUL DE BARE e codul produsului (lib/scan.js, codProdus), același ca pe
// eticheta de palet: scanerul din CT-Park îl recunoaște la intrare și găsește
// marfa de pus pe raft (lib/ct-scaner.js, potrivesteRand). Al doilea cod, al
// lotului, găsește paleții cu lotul ăsta; lotul unei comenzi de producție e
// codul fișei ei de lot (CM-aallzz-id, lib/fisa-lot.js), pe care scanerul îl
// știe deja.

const codbare = require("./codbare");
const SCAN = require("./scan");

const FORMATE = {
  "100x150": { latime: 100, inaltime: 150, nume: "100 × 150 mm" },
  "100x50": { latime: 100, inaltime: 50, nume: "100 × 50 mm" },
};
const FORMAT_IMPLICIT = "100x150";

// Câmpurile, în ordinea în care se aleg. `mereu`: nu se poate scoate
// (eticheta e a unui produs, dintr-un lot, cu codul lui de bare).
const CAMPURI = [
  { cheie: "sigla", nume: "Sigla" },
  { cheie: "firma", nume: "Numele firmei" },
  { cheie: "adresa", nume: "Adresa" },
  { cheie: "telefon", nume: "Telefon" },
  { cheie: "email", nume: "Email" },
  { cheie: "denumire", nume: "Denumirea produsului", mereu: true },
  { cheie: "cod", nume: "Codul produsului" },
  { cheie: "caracteristici", nume: "Caracteristici" },
  { cheie: "lot", nume: "Lot", mereu: true },
  { cheie: "data_productiei", nume: "Data producției" },
  { cheie: "cantitate", nume: "Cantitate pe ambalaj" },
  { cheie: "greutate_neta", nume: "Greutate netă" },
  { cheie: "greutate_bruta", nume: "Greutate brută" },
  { cheie: "client", nume: "Client" },
  { cheie: "comanda", nume: "Comanda" },
  { cheie: "valabilitate", nume: "Valabil până la" },
  { cheie: "operator", nume: "Operator" },
  { cheie: "observatii", nume: "Observații" },
  { cheie: "numar", nume: "Numărul etichetei" },
  { cheie: "data_tiparirii", nume: "Data tipăririi" },
  { cheie: "cod_bare", nume: "Cod de bare al produsului", mereu: true },
  { cheie: "cod_bare_lot", nume: "Cod de bare al lotului" },
];
const NUME_CAMP = Object.fromEntries(CAMPURI.map((c) => [c.cheie, c.nume]));
const MEREU = CAMPURI.filter((c) => c.mereu).map((c) => c.cheie);

// Pe 100 × 50 nu încape tot: căsuțele de acolo sunt lotul, data și cantitatea,
// iar codul lotului n-are loc lângă cel al produsului.
const CAMPURI_FORMAT = {
  "100x150": CAMPURI.map((c) => c.cheie),
  "100x50": ["sigla", "firma", "adresa", "telefon", "email", "denumire", "cod", "caracteristici", "lot", "data_productiei", "cantitate", "numar", "data_tiparirii", "cod_bare"],
};
const IMPLICITE = {
  "100x150": ["sigla", "firma", "adresa", "telefon", "email", "denumire", "cod", "caracteristici", "lot", "data_productiei", "cantitate", "client", "numar", "data_tiparirii", "cod_bare", "cod_bare_lot"],
  "100x50": ["sigla", "firma", "adresa", "telefon", "email", "denumire", "cod", "lot", "data_productiei", "cantitate", "numar", "cod_bare"],
};

// Câte etichete dintr-o tipărire. Zebra le scoate repede, dar o pagină cu mii
// de coduri de bare se mișcă greu în browser — mai multe se fac în mai multe
// tipăriri, care se văd toate în istoric.
const MAX_TIPAR = 300;
// Pe căsuța de caracteristici încap atâtea rânduri.
const MAX_CARAC = { "100x150": 6, "100x50": 1 };

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const scurt = (v, n) => text(v).replace(/\s+/g, " ").slice(0, n);
const esc = (s) =>
  String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const eData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(text(v));
const dataRo = (v) => (eData(v) ? text(v).split("-").reverse().join(".") : text(v));

function format(f) {
  return FORMATE[text(f)] ? text(f) : FORMAT_IMPLICIT;
}

// Câmpurile alese, curățate: doar ce are formatul, plus cele obligatorii, în
// ordinea din CAMPURI.
function campuriAlese(fmt, alese) {
  const f = format(fmt);
  // O listă de chei sau „a,b,c" (așa vin din previzualizare: un parametru
  // repetat în adresă ar rămâne doar cu ultima valoare).
  const lista = (Array.isArray(alese) ? alese : [alese]).flatMap((x) => text(x).split(",")).map(text).filter(Boolean);
  const permise = new Set(CAMPURI_FORMAT[f]);
  const vrute = new Set(lista.filter((c) => permise.has(c)).concat(MEREU.filter((c) => permise.has(c))));
  return CAMPURI.map((c) => c.cheie).filter((c) => vrute.has(c));
}

// Lotul: litere mari, cifre și „-./", fără spații — se scanează și se caută
// înapoi la fel. Diacriticele ies (Code 128 nu le are).
function curataLot(t) {
  const s = text(t)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, "-");
  if (!s) return { eroare: "Scrie lotul." };
  if (!/^[A-Z0-9][A-Z0-9./-]*$/.test(s)) return { eroare: "Lotul se scrie cu litere, cifre și „-”, „.”, „/” (de exemplu CM-261113-1553 sau L261113-01)." };
  if (s.length > 30) return { eroare: "Lotul are cel mult 30 de caractere." };
  return { lot: s };
}

// Lotul propus. La o comandă de producție, codul fișei ei de lot
// (lib/fisa-lot.js) — scanerul îl recunoaște ca pe comanda de producție. Fără
// comandă, L<aallzz>-<nn>, următorul liber în ziua aceea. Nu „CM-…": acela ar
// fi citit la scanare drept comanda de producție cu numărul de la sfârșit.
function lotPropus({ codLotProductie, zi, existente } = {}) {
  if (text(codLotProductie)) return curataLot(codLotProductie).lot || "";
  const z = eData(zi) ? zi : new Date().toISOString().slice(0, 10);
  const prefix = "L" + z.slice(2).replace(/-/g, "") + "-";
  const luate = new Set((existente || []).map((x) => text(x).toUpperCase()));
  for (let i = 1; i < 1000; i++) {
    const l = prefix + String(i).padStart(2, "0");
    if (!luate.has(l)) return l;
  }
  return prefix + "X";
}

// Ce scrie pe etichetă, din ce a ales omul. Se păstrează la lot: tipăririle de
// mai târziu scot aceleași etichete.
function continut(scris) {
  const s = scris || {};
  const carac = (Array.isArray(s.caracteristici) ? s.caracteristici : text(s.caracteristici).split(/\r?\n/))
    .map((x) => scurt(x, 80))
    .filter(Boolean)
    .slice(0, 12);
  return {
    denumire: scurt(s.denumire, 200),
    cod: scurt(s.cod, 60),
    cod_scan: scurt(s.cod_scan, 60),
    caracteristici: carac,
    data_productiei: eData(s.data_productiei) ? text(s.data_productiei) : scurt(s.data_productiei, 20),
    cantitate: scurt(s.cantitate, 40),
    greutate_neta: scurt(s.greutate_neta, 30),
    greutate_bruta: scurt(s.greutate_bruta, 30),
    client: scurt(s.client, 80),
    comanda: scurt(s.comanda, 60),
    valabilitate: eData(s.valabilitate) ? text(s.valabilitate) : scurt(s.valabilitate, 30),
    operator: scurt(s.operator, 60),
    observatii: scurt(s.observatii, 120),
  };
}

// Ce se poate scrie altfel doar la o tipărire (ultima cutie are mai puțin,
// alt operator, altă zi): restul etichetei rămâne al lotului.
const MODIFICABILE = ["data_productiei", "cantitate", "greutate_neta", "greutate_bruta", "operator", "observatii"];
function modificari(scris) {
  const s = scris || {};
  const out = {};
  for (const k of MODIFICABILE) {
    const v = text(s[k]);
    if (v) out[k] = continut({ [k]: v })[k];
  }
  return out;
}

// Numerele etichetelor dintr-o tipărire. „Suplimentar" continuă numerotarea;
// „din nou" scoate aceleași numere (o etichetă ruptă, un teanc pierdut).
function interval({ fel, tiparite, cate, de, pana } = {}) {
  const t = Math.max(0, Math.round(Number(tiparite) || 0));
  if (fel === "din_nou") {
    const a = Math.round(Number(de));
    const b = Math.round(Number(pana));
    if (!t) return { eroare: "Din lotul ăsta nu s-a tipărit încă nimic." };
    if (!(a >= 1) || !(b >= a)) return { eroare: "Scrie de la ce număr până la ce număr tipărești din nou (de exemplu de la 7 la 9)." };
    if (b > t) return { eroare: `Din lot s-au tipărit numerele 1–${t}. Peste ${t} e „suplimentar”, nu „din nou”.` };
    if (b - a + 1 > MAX_TIPAR) return { eroare: `Cel mult ${MAX_TIPAR} de etichete odată.` };
    return { de_la: a, pana_la: b, cate: b - a + 1 };
  }
  const n = Math.round(Number(cate));
  if (!(n >= 1)) return { eroare: "Scrie câte etichete tipărești (cel puțin una)." };
  if (n > MAX_TIPAR) return { eroare: `Cel mult ${MAX_TIPAR} de etichete odată. Pentru mai multe, tipărește încă o dată: numerotarea continuă.` };
  return { de_la: t + 1, pana_la: t + n, cate: n };
}

// Mărimea literei pentru denumire, după lungime: căsuța ei e fixă.
function marimeDenumire(den, fmt) {
  const n = text(den).length;
  if (format(fmt) === "100x50") return n <= 38 ? 11 : n <= 70 ? 9.5 : 8;
  return n <= 28 ? 20 : n <= 52 ? 16 : n <= 90 ? 13 : n <= 140 ? 11 : 9.5;
}

// Adresa, telefonul și emailul de pe etichetă, cât timp în Setări nu s-a scris
// altceva. Vali, 14.11.2026:
//   „Pune te rog adresa cu Vila Ana pe etichetă, nu sediul social."
//   „Telefon fix îl vreau și email de office. +40 (741) 162 460 asta e tel."
// Adresa e a depozitului și a biroului, ca în semnătura office@. Sediul social
// rămâne pe aviz și pe facturi (lib/aviz.js); de acolo se ia doar numele firmei.
const FIRMA_IMPLICITA = {
  adresa: "Str. Vila Ana nr. 6, Depozit B2, CTPark Bucharest North, Afumați, Ilfov",
  telefon: "+40 (741) 162 460",
  email: "office@cashmachine.ro",
};

// Sigla implicită: „CM" pe pătrat negru, ca semnul aplicației, dar în negru —
// imprimanta termică nu tipărește albastru. Sigla adevărată se încarcă din
// Setări (data URL, tipărită ca imagine).
const SIGLA_CM =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cash Machine">' +
  '<rect x="2" y="2" width="96" height="96" rx="18" fill="#000"/>' +
  '<text x="50" y="60" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="42" fill="#fff">CM</text>' +
  '<rect x="33" y="70" width="34" height="5" rx="2.5" fill="#fff"/></svg>';

//
// Sigla încărcată stă o singură dată pe pagină (siglaDefs, pus de pagina()),
// iar fiecare etichetă trimite la ea. Altfel o tipărire de 300 de etichete ar
// purta de 300 de ori o imagine de până la 300 KB — o pagină de peste 100 MB,
// care blochează browserul înainte de tipar.
const SIGLA_DATA = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const SIGLA_REF = '<svg class="sigla-inc" viewBox="0 0 100 100" role="img" aria-label="sigla"><use href="#sigla-inc"/></svg>';
const siglaValida = (sigla) => SIGLA_DATA.test(text(sigla));
function siglaHtml(sigla) {
  return siglaValida(sigla) ? SIGLA_REF : SIGLA_CM;
}
function siglaDefs(sigla) {
  if (!siglaValida(sigla)) return "";
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="sigla-inc" viewBox="0 0 100 100"><image href="${text(
    sigla
  )}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"/></symbol></defs></svg>`;
}

// O căsuță cu date: eticheta mică și valoarea. Nebifată: căsuța rămâne, goală.
function casuta(cheie, eticheta, valoare, ales, clasa) {
  const plina = ales && text(valoare);
  return `<div class="c${clasa ? " " + clasa : ""}${plina ? "" : " gol"}" data-camp="${cheie}"><span>${plina ? esc(eticheta) : ""}</span><b>${plina ? esc(valoare) : ""}</b></div>`;
}

function greutate(c, alese) {
  const n = alese.has("greutate_neta") ? text(c.greutate_neta) : "";
  const b = alese.has("greutate_bruta") ? text(c.greutate_bruta) : "";
  if (n && b) return { eticheta: "Greutate netă / brută", valoare: `${n} / ${b}` };
  if (n) return { eticheta: "Greutate netă", valoare: n };
  if (b) return { eticheta: "Greutate brută", valoare: b };
  return { eticheta: "", valoare: "" };
}

// O etichetă. `c` = conținutul lotului (cu modificările tipăririi peste el),
// `campuri` = cheile alese, `firma` = { nume, adresa, telefon, email },
// `opt` = { numar, tiparitLa, sigla }.
function eticheta(c, campuri, fmt, firma, opt) {
  const f = format(fmt);
  const alese = new Set(campuriAlese(f, campuri));
  const o = opt || {};
  const fi = firma || {};
  const are = (k) => alese.has(k);
  const lot = text(c.lot);
  const codScan = text(c.cod_scan) || SCAN.codProdus(c.cod, c.produs_id);
  const nrText = are("numar") && o.numar ? `Nr. ${o.numar}` : "";
  const tiparit = are("data_tiparirii") && o.tiparitLa ? `tipărit ${dataRo(text(o.tiparitLa).slice(0, 10))}` : "";
  const contact = [are("telefon") && text(fi.telefon) ? "Tel. " + text(fi.telefon) : "", are("email") ? text(fi.email) : ""].filter(Boolean);
  const carac = are("caracteristici") ? (c.caracteristici || []).slice(0, MAX_CARAC[f]) : [];
  const g = greutate(c, alese);
  const den = text(c.denumire);
  const marime = marimeDenumire(den, f);
  const bareProdus = codScan ? codbare.svg(codScan, f === "100x50" ? { inalt: 9.5, modul: 0.4, latimeMax: 62 } : { inalt: 14, modul: 0.45, latimeMax: 88 }) : "";
  const bareLot = f === "100x150" && are("cod_bare_lot") && lot ? codbare.svg(lot, { inalt: 6, modul: 0.33, latimeMax: 70 }) : "";

  if (f === "100x50") {
    return `<div class="et et-100x50">
  <div class="z antet"><div class="sigla">${are("sigla") ? siglaHtml(o.sigla) : ""}</div><div class="firma"><div class="f-sus"><div class="f-nume">${are("firma") ? esc(fi.nume) : ""}</div><div class="f-ct">${esc(
      // Sus: numele, iar în dreapta lui telefonul și emailul; dedesubt, adresa
      // pe un rând întreg — așa încape toată adresa din CTPark (Vila Ana nr. 6).
      contact.join(" · ")
    )}</div></div><div class="f-adr">${are("adresa") ? esc(fi.adresa) : ""}</div></div></div>
  <div class="z produs"><div class="den" style="font-size:${marime}pt">${esc(den)}</div></div>
  <div class="z carac">${esc(carac.join(" · "))}</div>
  <div class="z date">${casuta("lot", "Lot", lot, true, "lot")}${casuta("data_productiei", "Data producției", dataRo(c.data_productiei), are("data_productiei"))}${casuta(
      "cantitate",
      "Cantitate",
      c.cantitate,
      are("cantitate")
    )}</div>
  <div class="z jos"><div class="bare">${bareProdus}</div><div class="info"><div class="cod">${are("cod") && text(c.cod) ? "Cod " + esc(c.cod) : ""}</div><div class="nr">${esc(nrText)}</div><div class="tiparit">${esc(tiparit)}</div></div></div>
</div>`;
  }

  return `<div class="et et-100x150">
  <div class="z antet"><div class="sigla">${are("sigla") ? siglaHtml(o.sigla) : ""}</div><div class="firma"><div class="f-nume">${are("firma") ? esc(fi.nume) : ""}</div><div class="f-adr">${
    are("adresa") ? esc(fi.adresa) : ""
  }</div><div class="f-ct">${esc(contact.join(" · "))}</div></div></div>
  <div class="z produs"><div class="den" style="font-size:${marime}pt">${esc(den)}</div><div class="cod">${are("cod") && text(c.cod) ? "Cod produs: " + esc(c.cod) : ""}</div></div>
  <div class="z carac"><div class="titlu">${carac.length ? "Caracteristici" : ""}</div><div class="lista">${carac.map((x) => `<div>${esc(x)}</div>`).join("")}</div></div>
  <div class="z date">${casuta("lot", "Lot", lot, true, "lot")}${casuta("data_productiei", "Data producției", dataRo(c.data_productiei), are("data_productiei"))}${casuta(
    "cantitate",
    "Cantitate pe ambalaj",
    c.cantitate,
    are("cantitate")
  )}${casuta("greutate", g.eticheta, g.valoare, Boolean(g.valoare))}${casuta("client", "Client", c.client, are("client"))}${casuta("comanda", "Comanda", c.comanda, are("comanda"))}${casuta(
    "valabilitate",
    "Valabil până la",
    dataRo(c.valabilitate),
    are("valabilitate")
  )}${casuta("operator", "Operator", c.operator, are("operator"))}</div>
  <div class="z obs"><div class="o">${are("observatii") ? esc(c.observatii) : ""}</div><div class="nr">${esc([nrText, tiparit].filter(Boolean).join(" · "))}</div></div>
  <div class="z bare"><div class="b-produs">${bareProdus}</div><div class="b-lot">${bareLot}</div></div>
</div>`;
}

// Stilul: zonele au înălțimi fixe în milimetri, iar ce nu încape se taie
// (cel mult atâtea rânduri), nu împinge restul etichetei.
const STIL = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; background: #eceff3; }
  .et { background: #fff; margin: 0 auto 8px; border: 1px solid #bbb; overflow: hidden; position: relative; page-break-after: always; break-after: page; }
  .et:last-child { page-break-after: auto; break-after: auto; }
  .et .z { overflow: hidden; }
  .et .c span { display: block; font-size: 6.5pt; text-transform: uppercase; letter-spacing: .03em; color: #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et .c b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et .sigla svg, .et .sigla img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .et .cod-bare { display: block; max-width: 100%; height: auto; margin: 0 auto; }

  .et-100x150 { width: 100mm; height: 150mm; padding: 3mm; }
  .et-100x150 .antet { height: 19mm; display: flex; gap: 3mm; align-items: center; border-bottom: 1.2pt solid #000; padding-bottom: 1.5mm; }
  .et-100x150 .sigla { width: 16mm; height: 16mm; flex: none; }
  .et-100x150 .firma { min-width: 0; flex: 1; line-height: 1.25; }
  .et-100x150 .f-nume { font-size: 11pt; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x150 .f-adr { font-size: 7.5pt; line-height: 1.2; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
  .et-100x150 .f-ct { font-size: 7.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x150 .produs { height: 27mm; padding-top: 2mm; display: flex; flex-direction: column; }
  .et-100x150 .den { font-weight: 700; line-height: 1.12; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow-wrap: anywhere; }
  .et-100x150 .cod { margin-top: auto; font-size: 9pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x150 .carac { height: 24mm; border-top: .8pt solid #000; padding-top: 1.2mm; }
  .et-100x150 .carac .titlu { font-size: 6.5pt; text-transform: uppercase; letter-spacing: .03em; height: 3mm; }
  .et-100x150 .carac .lista { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(3, 6mm); column-gap: 3mm; }
  .et-100x150 .carac .lista div { font-size: 8.5pt; line-height: 6mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x150 .date { height: 34mm; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(4, 8.5mm); border-top: 1.2pt solid #000; }
  .et-100x150 .date .c { padding: .8mm 1.2mm 0; border-bottom: .5pt solid #888; min-width: 0; }
  .et-100x150 .date .c:nth-child(odd) { border-right: .5pt solid #888; }
  .et-100x150 .date .c b { font-size: 9.5pt; }
  .et-100x150 .date .lot b { font-size: 12pt; }
  .et-100x150 .obs { height: 8mm; display: flex; align-items: center; gap: 2mm; font-size: 7.5pt; }
  .et-100x150 .obs .o { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x150 .obs .nr { flex: none; font-weight: 700; font-size: 8.5pt; }
  .et-100x150 .bare { height: 32mm; border-top: 1.2pt solid #000; padding-top: 1.2mm; display: flex; flex-direction: column; align-items: center; gap: .5mm; }
  .et-100x150 .b-produs { height: 18.8mm; width: 100%; display: flex; justify-content: center; }
  .et-100x150 .b-lot { height: 10.8mm; width: 100%; display: flex; justify-content: center; }

  .et-100x50 { width: 100mm; height: 50mm; padding: 2.5mm 3mm; }
  .et-100x50 .antet { height: 7.5mm; display: flex; gap: 2mm; align-items: center; border-bottom: .8pt solid #000; padding-bottom: .8mm; }
  .et-100x50 .sigla { width: 6.5mm; height: 6.5mm; flex: none; }
  .et-100x50 .firma { min-width: 0; flex: 1; line-height: 1.15; }
  .et-100x50 .f-sus { display: flex; align-items: baseline; gap: 2mm; min-width: 0; }
  .et-100x50 .f-nume { flex: 0 1 auto; min-width: 0; font-size: 7.5pt; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x50 .f-ct { flex: 0 1 auto; min-width: 0; margin-left: auto; font-size: 5.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x50 .f-adr { font-size: 5.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x50 .produs { height: 10mm; padding-top: .8mm; }
  .et-100x50 .den { font-weight: 700; line-height: 1.1; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
  .et-100x50 .carac { height: 4mm; font-size: 7pt; line-height: 4mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x50 .date { height: 7mm; display: grid; grid-template-columns: 1.4fr 1fr 1fr; border-top: .8pt solid #000; border-bottom: .8pt solid #000; }
  .et-100x50 .date .c { padding: .4mm 1mm 0; min-width: 0; }
  .et-100x50 .date .c + .c { border-left: .5pt solid #888; }
  .et-100x50 .date .c span { font-size: 5pt; }
  .et-100x50 .date .c b { font-size: 8pt; }
  .et-100x50 .jos { height: 15.5mm; display: flex; gap: 2mm; padding-top: 1mm; }
  .et-100x50 .jos .bare { width: 64mm; flex: none; display: flex; align-items: center; }
  .et-100x50 .jos .info { flex: 1; min-width: 0; font-size: 7pt; line-height: 1.3; display: flex; flex-direction: column; justify-content: center; }
  .et-100x50 .jos .info div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .et-100x50 .jos .nr { font-weight: 700; font-size: 8pt; }

  .bara { text-align: center; padding: 10px; background: #fff; border-bottom: 1px solid #ccc; font-family: system-ui, sans-serif; font-size: 14px; }
  .bara button { font-size: 15px; padding: 6px 16px; }
  @media print { .bara { display: none; } .et { border: 0; margin: 0; } body { background: #fff; } }
`;

// Pagina de tipărit: o etichetă pe foaie, foaia cât eticheta.
// `sigla`: sigla încărcată în Setări; stă o dată pe pagină, dacă vreo
// etichetă o cere.
function pagina(etichete, fmt, { titlu, bara, sigla } = {}) {
  const f = FORMATE[format(fmt)];
  const cuSigla = etichete.some((e) => String(e).includes('href="#sigla-inc"'));
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titlu || "Etichete")}</title>
<style>@page { size: ${f.latime}mm ${f.inaltime}mm; margin: 0; }${STIL}</style></head><body>
${cuSigla ? siglaDefs(sigla) : ""}
${bara ? `<div class="bara">${bara}</div>` : ""}
${etichete.join("\n")}
</body></html>`;
}

module.exports = {
  FORMATE,
  FORMAT_IMPLICIT,
  CAMPURI,
  CAMPURI_FORMAT,
  IMPLICITE,
  NUME_CAMP,
  MEREU,
  MAX_TIPAR,
  MAX_CARAC,
  MODIFICABILE,
  SIGLA_CM,
  FIRMA_IMPLICITA,
  STIL,
  format,
  campuriAlese,
  curataLot,
  lotPropus,
  continut,
  modificari,
  interval,
  marimeDenumire,
  siglaHtml,
  siglaDefs,
  eticheta,
  pagina,
  dataRo,
  esc,
};
