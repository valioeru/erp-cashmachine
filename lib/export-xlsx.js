"use strict";
// Scrierea unui fișier Excel, fără nicio dependență.
//
// De ce nu folosim pachetul „xlsx": în ERP-ul ăsta el există doar pentru
// CITIRE, și chiar și acolo printr-un try/catch, fiindcă pe serverul vechi nu
// se instala (vezi comentariul din lib/xls-biff.js). Un buton de export care
// uneori dă fișier și uneori dă eroare, în funcție de ce s-a instalat la
// ultimul deploy, e mai rău decât niciun buton: omul descoperă asta exact
// când are nevoie de el, în fața băncii sau a contabilei.
//
// De ce .xlsx și nu .xls: un .xls adevărat e un container OLE binar (BIFF8),
// adică încă o mie de linii de cod de scris și de ținut. Un .xlsx e un ZIP cu
// câteva fișiere XML, iar Node are deja zlib — deci se scrie cinstit, în
// câteva zeci de linii, și se deschide fără niciun avertisment în Excel,
// LibreOffice, Google Sheets și Numbers. Cealaltă variantă ieftină,
// SpreadsheetML 2003 salvat ca .xls, deschide Excel-ul cu avertismentul
// „formatul nu se potrivește cu extensia" de fiecare dată.
//
// Ce NU face: formule, mai multe foi cu referințe între ele, grafice. Face
// exact ce-i trebuie unui export de tabel — antet îngroșat și înghețat, text,
// numere ca NUMERE (nu text, ca să se poată aduna în Excel), sume cu două
// zecimale și separator de mii, date, și lățimi de coloană rezonabile.
const zlib = require("zlib");

// ---------- ZIP (doar ce trebuie: deflate, fără directoare) ---------------
const TABEL_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABEL_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(fisiere) {
  const bucati = [];
  const centrale = [];
  let pozitie = 0;
  for (const f of fisiere) {
    const date = Buffer.isBuffer(f.date) ? f.date : Buffer.from(f.date, "utf8");
    const stors = zlib.deflateRawSync(date, { level: 9 });
    const nume = Buffer.from(f.nume, "utf8");
    const suma = crc32(date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versiunea minimă
    local.writeUInt16LE(0, 6); // fără steaguri
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // ora — fixă, ca două exporturi identice să dea fișiere identice
    local.writeUInt16LE(0x21, 12); // data — 1 ianuarie 1980
    local.writeUInt32LE(suma, 14);
    local.writeUInt32LE(stors.length, 18);
    local.writeUInt32LE(date.length, 22);
    local.writeUInt16LE(nume.length, 26);
    local.writeUInt16LE(0, 28);
    bucati.push(local, nume, stors);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(suma, 16);
    central.writeUInt32LE(stors.length, 20);
    central.writeUInt32LE(date.length, 24);
    central.writeUInt16LE(nume.length, 28);
    central.writeUInt32LE(0, 38); // atribute externe
    central.writeUInt32LE(pozitie, 42);
    centrale.push(central, nume);

    pozitie += local.length + nume.length + stors.length;
  }
  const corp = Buffer.concat(bucati);
  const director = Buffer.concat(centrale);
  const final = Buffer.alloc(22);
  final.writeUInt32LE(0x06054b50, 0);
  final.writeUInt16LE(fisiere.length, 8);
  final.writeUInt16LE(fisiere.length, 10);
  final.writeUInt32LE(director.length, 12);
  final.writeUInt32LE(corp.length, 16);
  return Buffer.concat([corp, director, final]);
}

// ---------- XML -----------------------------------------------------------
// Excel refuză fișierul întreg dacă o singură celulă conține un caracter de
// control. Un „\u0001" rămas dintr-un import strică exportul, nu doar celula.
function x(v) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Coloana 1 → „A", 27 → „AA".
function litera(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Datele se scriu ca număr de zile de la 1900, cum le ține Excel. Altfel
// „26.10.2026" rămâne text și nu se poate sorta cronologic — exact lucrul
// pentru care omul deschide exportul.
function serieData(v) {
  const s = String(v || "").slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) || s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [an, luna, zi] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
  const t = Date.UTC(an, luna - 1, zi);
  if (Number.isNaN(t)) return null;
  // 25569 = zilele dintre 01.01.1900 (serie 1) și 01.01.1970, cu tot cu ziua
  // de 29 februarie 1900 pe care Excel o crede reală.
  return Math.round(t / 86400000) + 25569;
}

// Stilurile: 0 implicit, 1 antet îngroșat pe fond gri, 2 sumă cu două
// zecimale, 3 întreg, 4 dată.
const STILURI = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/></numFmts>
<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F5F92"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function celula(ref, val, tip) {
  if (val === null || val === undefined || val === "") return "";
  if (tip === "bani" || tip === "numar") {
    const n = Number(val);
    if (!Number.isFinite(n)) return `<c r="${ref}" t="inlineStr"><is><t>${x(val)}</t></is></c>`;
    return `<c r="${ref}" s="${tip === "bani" ? 2 : 3}"><v>${n}</v></c>`;
  }
  if (tip === "data") {
    const s = serieData(val);
    if (s === null) return `<c r="${ref}" t="inlineStr"><is><t>${x(val)}</t></is></c>`;
    return `<c r="${ref}" s="4"><v>${s}</v></c>`;
  }
  // Textele se scriu „inline", nu printr-un tabel de șiruri partajate: fără
  // tabelul ăla fișierul e cu câțiva kilobytes mai mare și cu o sursă de
  // greșeli mai puțin.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${x(val)}</t></is></c>`;
}

// O foaie: coloane [{titlu, cheie, tip, latime}] și rânduri (obiecte).
function foaieXml(coloane, randuri) {
  const latimi = coloane
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, Math.min(70, Number(c.latime) || 16))}" customWidth="1"/>`)
    .join("");

  let r = 1;
  const linii = [];
  linii.push(
    `<row r="${r}" ht="26" customHeight="1">` +
      coloane.map((c, i) => `<c r="${litera(i + 1)}${r}" s="1" t="inlineStr"><is><t>${x(c.titlu)}</t></is></c>`).join("") +
      `</row>`
  );
  for (const rand of randuri) {
    r++;
    const celule = coloane.map((c, i) => celula(litera(i + 1) + r, rand[c.cheie], c.tip)).join("");
    linii.push(`<row r="${r}">${celule}</row>`);
  }
  const ultima = litera(coloane.length) + r;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${ultima}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="13"/>
<cols>${latimi}</cols>
<sheetData>${linii.join("")}</sheetData>
<autoFilter ref="A1:${ultima}"/>
</worksheet>`;
}

// Numele foii: Excel refuză fișierul dacă trece de 31 de caractere sau dacă
// are : \ / ? * [ ].
function numeFoaie(v) {
  const s = String(v || "Date").replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return s || "Date";
}

// Cartea întreagă. „foi" = [{ nume, coloane, randuri }].
function carte(foi) {
  const lista = (Array.isArray(foi) ? foi : [foi]).filter(Boolean);
  if (!lista.length) throw new Error("Exportul n-are nicio foaie.");

  const fisiere = [
    {
      nume: "[Content_Types].xml",
      date:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        lista
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join("") +
        `</Types>`,
    },
    {
      nume: "_rels/.rels",
      date:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      nume: "xl/workbook.xml",
      date:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>` +
        lista.map((f, i) => `<sheet name="${x(numeFoaie(f.nume))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    },
    {
      nume: "xl/_rels/workbook.xml.rels",
      date:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        lista
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join("") +
        `<Relationship Id="rId${lista.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    { nume: "xl/styles.xml", date: STILURI },
  ];
  lista.forEach((f, i) => {
    fisiere.push({ nume: `xl/worksheets/sheet${i + 1}.xml`, date: foaieXml(f.coloane || [], f.randuri || []) });
  });
  return zip(fisiere);
}

// Numele fișierului descărcat. Diacriticele și spațiile din el ajung să
// semene a gunoi în unele browsere, deci se curăță aici o singură dată.
function numeFisier(baza) {
  const curat = String(baza || "export")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return (curat || "export") + ".xlsx";
}

// Antetele de răspuns, ca să nu le scrie fiecare rută de export altfel.
function antete(nume, lungime) {
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${numeFisier(nume)}"`,
    "Content-Length": String(lungime),
    "Cache-Control": "no-store",
  };
}

module.exports = { carte, antete, numeFisier, serieData, litera };
