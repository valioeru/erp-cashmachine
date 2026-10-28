"use strict";
// Fișierul de planificare lunară — regulile, fără bază de date.
//
// CEREREA LUI VALI, 27.10.2026: „în producție, la planificare, fă zona de
// update fișier planificare lunară.”
//
// CE E ȘI CE NU E
//
// Nu e un import. Planificarea pe ore din ERP se face din alocări, și rămâne
// așa. Asta e locul unde stă DOCUMENTUL lunii — fișierul pe care îl face
// producția și după care se lucrează — ca să nu mai circule pe WhatsApp în
// patru versiuni și să nu mai întrebe nimeni care e cea bună.
//
// DE CE SE PĂSTREAZĂ VERSIUNILE, în loc să se suprascrie
//
// Un plan lunar se schimbă în timpul lunii; asta e normal. Dar atunci
// întrebarea „ce scria în plan pe 3, când am promis clientului" nu mai are
// răspuns dacă fișierul vechi a fost înlocuit. Deci fiecare urcare e o
// versiune nouă, cu cine și când. Versiunea de sus e cea care contează; cele
// de dedesubt sunt istoria.
//
// Regulile de aici sunt în fișierul ăsta, nu în pagină, fiindcă ecranul le
// desenează și serverul le verifică: scrise de două ori s-ar despărți la
// prima schimbare, iar formularul ar accepta ce serverul refuză.

// Tipurile pe care le primim. Lista e scurtă intenționat: un plan de
// producție e o foaie de calcul sau un PDF. Orice altceva urcat aici e o
// greșeală de fișier, și e mai bine să se vadă acum decât să descopere
// cineva peste trei săptămâni că „planul lunii" e o poză.
const TIPURI = [
  { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", eticheta: "Excel" },
  { ext: "xls", mime: "application/vnd.ms-excel", eticheta: "Excel (format vechi)" },
  { ext: "csv", mime: "text/csv", eticheta: "CSV" },
  { ext: "ods", mime: "application/vnd.oasis.opendocument.spreadsheet", eticheta: "LibreOffice Calc" },
  { ext: "pdf", mime: "application/pdf", eticheta: "PDF" },
];

// Plafonul. Corpul cererii e oprit la 25 MB în lib/router.js, iar peste
// fișier mai vine și plicul multipart; 15 MB lasă loc și e de zece ori cât
// are nevoie un plan lunar real.
const MAX_OCTETI = 15 * 1024 * 1024;

const LUNI = [
  "ianuarie", "februarie", "martie", "aprilie", "mai", "iunie",
  "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie",
];

function lunaCurenta(azi) {
  const d = azi ? new Date(azi) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// „2026-10" și atât. Nu acceptăm „2026-13" nici ca greșeală de tastare: o
// lună inventată face un raft pe care nu se uită nimeni niciodată.
function lunaValida(v) {
  const s = String(v == null ? "" : v).trim();
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const an = Number(m[1]);
  const luna = Number(m[2]);
  return an >= 2020 && an <= 2100 && luna >= 1 && luna <= 12;
}

// „2026-10” → „octombrie 2026”. Pentru ochi, nu pentru sortare: sortarea se
// face tot pe forma cu cifre, care e deja în ordine alfabetică.
function numeLuna(v) {
  if (!lunaValida(v)) return String(v || "");
  const [an, luna] = String(v).split("-");
  return `${LUNI[Number(luna) - 1]} ${an}`;
}

function extensia(numeFisier) {
  const m = String(numeFisier || "").toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? m[1] : "";
}

function marimeOmeneasca(octeti) {
  const n = Number(octeti) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

// Ce a venit din formular, verificat.
//
// Se verifică EXTENSIA, nu tipul MIME anunțat de browser. Motivul e practic:
// pe un xlsx ieșit din SmartBill sau din Numbers, browserele trimit tot felul
// de mime-uri („application/octet-stream" cel mai des), iar dacă ne-am lua
// după ele am refuza fișiere bune. Extensia o scrie omul care a salvat
// fișierul și e singurul lucru constant.
function verificaFisier(fisier, luna) {
  const gresite = [];
  const f = fisier || {};
  const nume = String(f.filename || "").trim();
  const octeti = f.data && f.data.length ? f.data.length : 0;

  if (!nume || !octeti) {
    gresite.push("N-ai ales niciun fișier.");
    return { ok: false, gresite };
  }
  if (!lunaValida(luna)) gresite.push("Luna nu e scrisă corect (se așteaptă o lună din calendar).");

  const ext = extensia(nume);
  const tip = TIPURI.find((t) => t.ext === ext);
  if (!tip) {
    gresite.push(
      `„${nume}” are extensia ${ext ? `.${ext}` : "lipsă"}. Se primesc doar ${TIPURI.map((t) => "." + t.ext).join(", ")}.`
    );
  }
  if (octeti > MAX_OCTETI) {
    gresite.push(`Fișierul are ${marimeOmeneasca(octeti)}, iar plafonul e ${marimeOmeneasca(MAX_OCTETI)}.`);
  }

  return {
    ok: gresite.length === 0,
    gresite,
    nume,
    ext,
    octeti,
    // Mime-ul pe care îl SCRIEM noi, din extensie. Cel venit de la browser nu
    // e de încredere, iar Drive-ul și descărcarea se poartă mai bine cu unul
    // corect: un xlsx trimis ca „octet-stream" se descarcă fără pictogramă și
    // uneori fără extensie.
    mime: tip ? tip.mime : String(f.contentType || "application/octet-stream"),
  };
}

// Numele sub care se pune în Drive. Începe cu luna, ca folderul să se
// sorteze singur, și poartă ora, ca a doua versiune din aceeași zi să nu
// calce peste prima. Numele original rămâne în bază, pentru afișare.
function numeInDrive(luna, numeFisier, cand) {
  const ext = extensia(numeFisier) || "dat";
  const t = (cand ? new Date(cand) : new Date()).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const baza = String(numeFisier || "plan")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "plan";
  return `${luna}-${baza}-${t}.${ext}`;
}

// Rândurile din bază, grupate pe lună: cea mai nouă versiune sus, restul ca
// istorie. Funcția nu știe SQL — primește rândurile și le aranjează — ca s-o
// poată verifica testul fără bază de date.
function grupeazaPeLuna(randuri) {
  const peLuna = new Map();
  for (const r of randuri || []) {
    const k = String(r.luna || "");
    if (!k) continue;
    if (!peLuna.has(k)) peLuna.set(k, []);
    peLuna.get(k).push(r);
  }
  const iesire = [];
  for (const [luna, lista] of peLuna) {
    // Cea mai nouă întâi. Sortăm pe id, nu pe dată: două urcări în aceeași
    // minută au aceeași dată, iar id-ul e singurul care nu se poate egala.
    const ordonate = lista.slice().sort((a, b) => Number(b.id) - Number(a.id));
    iesire.push({ luna, nume: numeLuna(luna), curent: ordonate[0], vechi: ordonate.slice(1) });
  }
  return iesire.sort((a, b) => (a.luna < b.luna ? 1 : a.luna > b.luna ? -1 : 0));
}

module.exports = {
  TIPURI,
  MAX_OCTETI,
  LUNI,
  lunaCurenta,
  lunaValida,
  numeLuna,
  extensia,
  marimeOmeneasca,
  verificaFisier,
  numeInDrive,
  grupeazaPeLuna,
};
