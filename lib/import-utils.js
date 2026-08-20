"use strict";
// Utilitare comune pentru importul de date din fișiere Excel/CSV exportate
// din SmartBill (sau din orice alt sistem — formatul e generic). Folosite de
// modules/import.js pentru toate tipurile de import (facturi, parteneri,
// stoc, bonuri de consum, rețete).

let XLSX = null;
try {
  XLSX = require("xlsx");
} catch (e) {
  XLSX = null; // pachetul poate lipsi dacă instalarea a eșuat — degradăm elegant la CSV
}

function xlsxDisponibil() {
  return Boolean(XLSX);
}

// Citește un fișier .xlsx/.xls și îl întoarce ca listă de rânduri
// (array-of-arrays), primul rând fiind header-ul — la fel ca parseCSV, ca
// restul codului să nu trebuiască să știe din ce format a venit fișierul.
function parseXLSX(buffer) {
  if (!XLSX) {
    throw new Error(
      "Suportul pentru fișiere Excel (.xlsx) nu e disponibil pe server momentan. " +
        "Deschide fișierul în Excel/Google Sheets și salvează-l ca CSV (Fișier → Salvare ca → CSV), apoi încarcă-l din nou."
    );
  }
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: "yyyy-mm-dd", defval: "" });
}

// Parser CSV simplu (suportă câmpuri între ghilimele, virgulă SAU
// punct-virgulă ca separator — exporturile din Excel cu locale românesc
// folosesc des punct-virgulă).
function parseCSV(text) {
  text = text.replace(/^﻿/, ""); // elimină BOM dacă există
  const primaLinie = text.split(/\r?\n/, 1)[0] || "";
  const delim = primaLinie.split(";").length > primaLinie.split(",").length ? ";" : ",";

  // Notă: un "\"" e tratat ca început de câmp citat DOAR dacă apare chiar la
  // începutul câmpului (fieldHasContent == false). Un ghilimele apărut în
  // mijlocul unui câmp neîncepui cu ghilimele (ex: denumiri de produse gen
  // `Laptop 14"`, `Monitor 24"`) e păstrat ca literă normală — altfel ar
  // "înghiți" tot restul fișierului ca un singur câmp citat nchis niciodată.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldHasContent = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !fieldHasContent) {
      inQuotes = true;
      fieldHasContent = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
      fieldHasContent = false;
    } else if (c === "\r") {
      // ignorat
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldHasContent = false;
    } else {
      field += c;
      fieldHasContent = true;
    }
  }
  if (fieldHasContent || field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

// Alege parserul potrivit după numele fișierului.
function parseFisier(filename, buffer) {
  if (/\.xlsx?$/i.test(filename)) return parseXLSX(buffer);
  return parseCSV(buffer.toString("utf8"));
}

function normalizeHeader(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // scoate diacriticele
    .replace(/[^a-z0-9]/g, "");
}

// Găsește rândul de header într-un fișier care poate avea rânduri de titlu
// înaintea tabelului propriu-zis. Exporturile SmartBill încep, de exemplu, cu
// "Facturi incepand din data de 01/08/2000 pana in data de 31/08/2026",
// apoi o notă, apoi un rând gol, și abia pe rândul 4 vine header-ul real
// ("Nr. crt. | Client | CIF | ..."). Fără asta, importul citea titlul ca
// header și nu recunoștea nicio coloană.
//
// Scanează primele `maxScan` rânduri și alege rândul care conține cele mai
// multe denumiri de coloane cunoscute (din tabela de aliase primită).
// Întoarce -1 dacă niciun rând nu seamănă a header.
function gasesteRandHeader(rows, aliase, maxScan = 30) {
  const cunoscute = new Set();
  for (const cheie of Object.keys(aliase)) for (const a of aliase[cheie]) cunoscute.add(a);

  let celMaiBun = -1;
  let scorMax = 0;
  const limita = Math.min(rows.length, maxScan);
  for (let i = 0; i < limita; i++) {
    const norm = (rows[i] || []).map(normalizeHeader);
    let scor = 0;
    for (const c of norm) if (c && cunoscute.has(c)) scor++;
    if (scor > scorMax) {
      scorMax = scor;
      celMaiBun = i;
    }
  }
  // Două coloane recunoscute e pragul minim ca să considerăm că am găsit
  // header-ul (un rând de titlu nimerește accidental cel mult una).
  return scorMax >= 2 ? celMaiBun : -1;
}

function gasesteColoana(headerNorm, chei) {
  for (let i = 0; i < headerNorm.length; i++) {
    if (chei.includes(headerNorm[i])) return i;
  }
  return -1;
}

// Parsează numere în format românesc ("1.234,56") sau internațional
// ("1234.56" / "1234,56"), tolerant la spații și simboluri de monedă.
function parseNumar(v) {
  if (v === null || v === undefined || v === "") return 0;
  let s = String(v).trim().replace(/[^0-9,.\-]/g, "");
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Parsează date în format yyyy-mm-dd, dd.mm.yyyy sau dd/mm/yyyy → întoarce
// mereu yyyy-mm-dd (sau null dacă nu recunoaște formatul).
function parseData(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

module.exports = { xlsxDisponibil, parseXLSX, parseCSV, parseFisier, normalizeHeader, gasesteColoana, gasesteRandHeader, parseNumar, parseData };
