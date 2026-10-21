"use strict";
// Importul din Monday CRM — cel pe care firma nu-l mai folosește.
//
// Trei boarduri, trei destinații în ERP:
//   Accounts  (companii)  → parteneri
//   Contacts  (oameni)    → mk_contacte, legate de partener
//   Leads     (lead-uri)  → leaduri, cu stadiul din Monday
//
// REGULA, cuvânt cu cuvânt de la Vali: „dacă există deja fă update la ei doar
// la datele care nu există la noi în bază, sau dacă nu e asociat cuiva
// asociază-l așa cum e în Monday."
//
// Deci: se COMPLETEAZĂ golurile, nu se suprascrie nimic. Ce a scris un om pe
// fișă bate ce era în Monday — Monday e sistemul părăsit, fișa din ERP e cea
// la care se uită lumea azi. La fel și agentul: dacă partenerul are deja un
// agent alocat, rămâne al lui; se completează doar unde e gol.
//
// DE CE SE POTRIVEȘTE PE NUME, NU PE CUI: exporturile Monday nu au CUI pe
// nicio coloană. Rămân numele firmei și domeniul din email. Potrivirea pe
// nume e mai moale decât pe CUI, de-aia se normalizează dur (fără diacritice,
// fără forma juridică, fără punctuație) și de-aia importul raportează câte a
// potrivit și câte a creat — ca să se vadă dacă numărul arată a adevăr.
//
// AGENTUL POATE LIPSI. Dacă exportul n-are coloana Owner, nu se inventează
// nimic: partenerii se creează fără agent și se raportează câți au rămas așa.
// Mai bine neatribuit decât atribuit greșit — un client pus pe agentul
// nepotrivit se vede abia la comision, peste trei luni.

const DIACRITICE = /[̀-ͯ]/g;

// Forma juridică, ANCORATĂ LA COADĂ și tolerantă la puncte sau spații între
// litere: „S.R.L.", „S R L" și „SRL" sunt același lucru.
//
// De ce la coadă și nu oriunde: „if", „ii", „sa" sunt bucăți de cuvinte
// obișnuite. Căutate oriunde în nume, ar ciopârți firme care n-au nicio
// treabă cu ele. La coadă, unde stau de fapt, nu pot face rău.
const FORMA_JURIDICA =
  /[\s.,-]*\b(s[\s.]*r[\s.]*l(?:[\s.-]*d)?|s[\s.]*a|p[\s.]*f[\s.]*a|s[\s.]*n[\s.]*c|s[\s.]*c[\s.]*s|i[\s.]*i|i[\s.]*f|b[\s.]*v|n[\s.]*v|gmbh|ltd|inc|llc)[\s.]*$/;
const PREFIX_SC = /^\s*s[\s.]*c[\s.]+/;

function curat(v) {
  return String(v === null || v === undefined ? "" : v).trim();
}

// Cheia pe care se potrivesc firmele. „S.C. AQUILA B.V." și „Aquila BV" sunt
// aceeași firmă; fără pasul ăsta ar fi două rânduri în parteneri.
// Ordinea pașilor contează, și am aflat-o greșind-o:
//
//   1. „&" DEVINE „si", nu dispare. „NEGRU & NEGRU BIO" și „Negru si Negru
//      Bio" sunt aceeași firmă; dacă aș tăia legătura cu totul, aș lipi și
//      firme care chiar se numesc diferit.
//   2. Prefixul „S.C." pleacă, apoi forma juridică de la coadă — de două
//      ori, fiindcă se scrie și „SRL SA" la firme reînregistrate.
//   3. Abia la final rămân doar literele și cifrele.
//
// Ce NU rezolvă: „Sameday" față de „SAMEDAY COURIER SRL". „Courier" e un
// cuvânt adevărat din nume, nu o formă juridică, iar dacă l-aș tăia aș lipi
// firme diferite. Astea rămân două rânduri, iar importul le raportează ca
// nepotrivite — se leagă de mână, o dată.
function cheieFirma(nume) {
  let s = curat(nume)
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICE, "")
    .replace(/&/g, " si ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(PREFIX_SC, "");
  for (let i = 0; i < 2; i++) s = s.replace(FORMA_JURIDICA, "");
  return s.replace(/[^a-z0-9]/g, "");
}

function cheiePersoana(nume) {
  return curat(nume).toLowerCase().normalize("NFD").replace(DIACRITICE, "").replace(/[^a-z0-9]/g, "");
}

const emailValid = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(curat(v));

// Telefoanele din Monday vin ca „724089122" sau „+40 724 089 122”. Le ducem
// la cifre, ca să nu intre același om de două ori cu două scrieri.
function telefonCurat(v) {
  const c = curat(v).replace(/[^\d+]/g, "");
  return c.length >= 6 ? c : "";
}

// Pe ce coloană stă agentul. Monday le numește diferit după cum a fost
// construit boardul, deci le încercăm pe toate, în ordinea în care au sens:
// proprietarul bate creatorul (proprietarul e cine lucrează contul acum).
const COLOANE_AGENT = ["Owner", "Owners", "Account owner", "Lead owner", "Contact owner", "Created by", "Creator"];

function agentDinRand(rand) {
  for (const c of COLOANE_AGENT) {
    const v = curat(rand && rand[c]);
    if (v) return v.split(",")[0].trim();
  }
  return "";
}

// Ce board e, după coloanele din fișier. Nu după numele fișierului: omul
// poate să-l redenumească, iar coloanele nu mint.
function detecteazaBoard(coloane) {
  const set = new Set((coloane || []).map((c) => curat(c).toLowerCase()));
  if (set.has("status") && set.has("company")) return "leads";
  if (set.has("domain") || set.has("industry") || set.has("headquarters location")) return "accounts";
  if (set.has("accounts") || set.has("title")) return "contacts";
  return null;
}

// Stadiul lead-ului: Monday are text liber, ERP-ul are un set scurt.
function stadiuDinStatus(status) {
  const s = curat(status).toLowerCase();
  if (/qualified|calificat/.test(s)) return "calificat";
  if (/won|c[aâ]știgat|castigat/.test(s)) return "castigat";
  if (/lost|pierdut|unqualified/.test(s)) return "pierdut";
  if (/contact/.test(s)) return "contactat";
  return "nou";
}

// Normalizarea unui rând, pe fiecare fel de board. Întoarce null pentru ce nu
// are nume — un rând fără nume nu e nici firmă, nici om.
function normalizeaza(fel, r) {
  const nume = curat(r.Name);
  if (!nume) return null;
  const agent = agentDinRand(r);
  if (fel === "accounts") {
    return {
      fel: "companie",
      nume,
      domeniu: curat(r.Domain),
      industrie: curat(r.Industry),
      sediu: curat(r["Headquarters location"]),
      descriere: curat(r.Description),
      agent,
      cheie: cheieFirma(nume),
    };
  }
  if (fel === "contacts") {
    return {
      fel: "persoana",
      nume,
      email: emailValid(r.Email) ? curat(r.Email).toLowerCase() : "",
      telefon: telefonCurat(r.Phone),
      functie: curat(r.Title),
      firma: curat(r.Accounts).split(",")[0].trim(),
      observatii: curat(r.Comments),
      agent,
      cheie: cheiePersoana(nume),
    };
  }
  if (fel === "leads") {
    return {
      fel: "lead",
      nume,
      email: emailValid(r.Email) ? curat(r.Email).toLowerCase() : "",
      telefon: telefonCurat(r.Phone),
      firma: curat(r.Company),
      stadiu: stadiuDinStatus(r.Status),
      statusMonday: curat(r.Status),
      ultimaActivitate: curat(r["Last interaction"]).slice(0, 10) || null,
      agent,
      cheie: cheiePersoana(nume),
    };
  }
  return null;
}

// Ce se scrie peste un rând care există deja: NUMAI câmpurile goale la noi.
// Întoarce un obiect doar cu ce chiar se schimbă, ca apelantul să știe dacă
// mai are rost un UPDATE și ce anume a completat.
function doarGolurile(existent, nou, campuri) {
  const de = {};
  for (const c of campuri) {
    const acum = curat(existent && existent[c]);
    const vine = curat(nou && nou[c]);
    if (!acum && vine) de[c] = vine;
  }
  return de;
}

module.exports = {
  curat, cheieFirma, cheiePersoana, telefonCurat, emailValid,
  agentDinRand, detecteazaBoard, stadiuDinStatus, normalizeaza, doarGolurile,
  COLOANE_AGENT,
};
