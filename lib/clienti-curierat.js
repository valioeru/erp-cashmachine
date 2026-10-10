"use strict";
// Clienții de pe AWB-urile curierului — cine sunt și de ce nu-i ofertăm.
//
// Pe fiecare AWB din comenzile de consumabile scrie un DESTINATAR: firma care
// primește plicurile și cutiile. Firma aia nu e clientul nostru, e clientul
// Sameday. Noi vindem către Sameday, Sameday revinde mai departe. Decizia lui
// Vali, 10.10.2026, pe scurt: „așa e fair" — nu ne ducem peste curier la
// clientul lui cu produsele pe care el i le vinde.
//
// Deci lista asta are două treburi, și a doua e mai importantă decât prima:
//   1. Să arate în raport cine comandă cel mai mult, cu oraș și adresă.
//   2. Să NU ajungă niciodată în sugestiile agenților, iar dacă un agent
//      introduce din proprie inițiativă una din firmele astea, să-i spună pe
//      loc de ce n-o poate oferta.
//
// Fișierul stă separat ca să-l poată cere și CRM-ul (modules/contacte.js,
// modules/crm.js) fără să tragă după el tot raportul de comenzi — altfel ieșea
// un import circular prin modules/rapoarte.js.

const db = require("./db");

// Un `.catch(() => null)` pe interogarile de aici ar fi cea mai liniștită
// greșeală posibilă: regula ar răspunde „nu e client Sameday" la toată lumea, și
// nimic nu s-ar vedea în pagină. S-a întâmplat exact asta la primul test, din
// cauza unei coloane inexistente. Deci erorile se STRIGĂ în log și abia apoi se
// întorc ca „nu știu".
function plangi(unde) {
  return (e) => {
    console.error(`[clienti-curierat] ${unde}: ${e && e.message}`);
    return null;
  };
}

// ---------------------------------------------------------------------------
// Numele de pe etichetă
//
// Trei lucruri strică numele venit din PDF-ul de AWB, și toate trei trebuie
// desfăcute înainte de orice comparație:
//
//   a) MOJIBAKE. Textul extras din unele etichete a trecut prin cp1252 și
//      „NICHIDUȚĂ" a ieșit „NICHIDUÅ¢Ä‚". Se repară citind octeții înapoi ca
//      latin-1 și decodându-i ca UTF-8 — dar numai dacă rezultatul chiar arată
//      a cuvânt cu diacritice, altfel lăsăm numele în pace.
//   b) TRUNCHIEREA. Eticheta are lățime fixă, așa că numele lungi se taie:
//      „WELL PROFESIONAL SOLUTIONS S.R.L. -...". Numele ăsta e un PREFIX, nu o
//      firmă nouă, și se leagă la unul întreg dacă există.
//   c) FORMA JURIDICĂ. „S.R.L." și „SRL" sunt aceeași firmă. Se scot doar
//      formele sigure: nu scoatem „AG" sau „IFN", care în numele astea sunt
//      parte din marcă („IDEAL TECHNOLOGY AG", „UNICREDIT LEASING ... IFN").

// cp1252 nu e latin-1: octeții 0x80–0x9F sunt €, ‚, „, …, Š, Ž, ', ", • și
// restul semnelor tipografice. Un „Ă" trecut prin cp1252 iese „Ä‚" — adică
// Ä (0xC4) plus ‚ (0x82), iar al doilea caracter e U+201A, nu un octet.
// Fără tabelul ăsta, Buffer.from(s, "latin1") pierde exact octeții care ne
// trebuie și numele rămâne stricat.
const CP1252 = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

function reparaMojibake(s) {
  const t = String(s || "");
  // Semnul că s-a întâmplat: o majusculă latină cu diacritic urmată imediat de
  // alt caracter non-ASCII. În română n-ai „Ãž" într-un nume de firmă.
  if (!/[À-ßĀ-ſ][^\x00-\x7F]/.test(t)) return t;
  const octeti = [];
  for (const c of t) {
    const cod = c.codePointAt(0);
    if (cod < 0x100) octeti.push(cod);
    else if (CP1252[c] != null) octeti.push(CP1252[c]);
    else return t; // caracter care nu putea veni din cp1252 — nu e mojibake
  }
  try {
    const refacut = Buffer.from(octeti).toString("utf8");
    if (refacut.includes("�")) return t;
    return /[ăâîșşțţĂÂÎȘŞȚŢ]/.test(refacut) ? refacut : t;
  } catch (e) {
    return t;
  }
}

const DIACRITICE = { ă: "a", â: "a", î: "i", ș: "s", ş: "s", ț: "t", ţ: "t", Ă: "A", Â: "A", Î: "I", Ș: "S", Ş: "S", Ț: "T", Ţ: "T" };

function faraDiacritice(s) {
  return String(s || "").replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (c) => DIACRITICE[c] || c);
}

// Formele juridice care se scot.
//
// Atenție la ordinea operațiilor: dacă normalizezi punctuația prima, „S.R.L."
// devine „S R L" și niciun `\bSRL\b` nu-l mai prinde — exact greșeala care,
// la primul test, a lăsat 142 de nume cu 142 de chei distincte, adică
// „WIFISTORE.RO S.R.L." și „WIFISTORE RO SRL" ca două firme diferite. Deci
// tăiem forma juridică ÎNAINTE, cu un șablon care tolerează puncte și spații
// între litere.
//
// Se taie numai la coadă (acolo stă forma juridică) și, pentru „S.C.", numai
// la cap. Un „SA" sau „II" în mijlocul numelui e parte din marcă și rămâne.
const FORMA_COADA = /[\s,.·-]*\b(S\s*\.?\s*R\s*\.?\s*L\s*\.?(?:\s*[-\s]\s*D\s*\.?)?|S\s*\.?\s*A\s*\.?|P\s*\.?\s*F\s*\.?\s*A\s*\.?|S\s*\.?\s*N\s*\.?\s*C\s*\.?|S\s*\.?\s*C\s*\.?\s*S\s*\.?|I\s*\.?\s*I\s*\.?|I\s*\.?\s*F\s*\.?)\s*$/;
const SC_CAP = /^\s*S\s*\.?\s*C\s*\.?\s+/;

function taieFormaJuridica(s) {
  let t = String(s || "").replace(SC_CAP, "");
  // De două ori: „... S.R.L. SRL" apare în nomenclatoare copiate de mână.
  for (let i = 0; i < 2; i++) {
    const scurt = t.replace(FORMA_COADA, "");
    if (!scurt.trim()) break; // numele era DOAR forma juridică — îl lăsăm
    if (scurt === t) break;
    t = scurt;
  }
  return t;
}

// Numele trunchiat de etichetă: „... -...", „...", „…".
function esteTrunchiat(nume) {
  return /(\.\.\.|…)\s*$/.test(String(nume || ""));
}

function curataNume(nume) {
  let s = reparaMojibake(nume);
  s = s.replace(/(\s*[-–]\s*)?(\.\.\.|…)\s*$/, "");       // coada de trunchiere
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Cheia pe care se compară două nume de firmă. Două nume dau aceeași cheie
// dacă sunt aceeași firmă scrisă altfel.
function cheieClient(nume) {
  let s = faraDiacritice(curataNume(nume)).toUpperCase();
  s = taieFormaJuridica(s);
  s = s.replace(/[^A-Z0-9]+/g, " ");                        // punctuație → spațiu
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Căutarea în listă
//
// Întâi cheie identică. Dacă numele venit e trunchiat, îl acceptăm ca prefix —
// dar numai dacă are destul text ca să nu prindă din greșeală altă firmă
// (minim 8 caractere) ȘI dacă se potrivește cu EXACT un client. Un prefix care
// se potrivește cu doi clienți nu spune nimic, deci nu leagă nimic.
const MINIM_PREFIX = 8;

async function gasesteClient(nume) {
  const cheie = cheieClient(nume);
  if (!cheie) return null;
  const exact = await db.prepare("SELECT * FROM consumabile_clienti WHERE cheie = ?").get(cheie).catch(plangi("gasesteClient"));
  if (exact) return exact;
  if (!esteTrunchiat(nume) || cheie.length < MINIM_PREFIX) return null;
  const candidati = await db
    .prepare("SELECT * FROM consumabile_clienti WHERE cheie LIKE ? LIMIT 3")
    .all(cheie + "%")
    .catch(() => []);
  return candidati.length === 1 ? candidati[0] : null;
}

// Clientul curierului? Răspunsul se dă pe cheie, deci „S.C. NOVATECH PRO
// S.R.L." nimerește același client ca „NOVATECH PRO SRL".
//
// Aici NU mergem pe prefix: un nume scurt scris de un agent n-are voie să
// blocheze un client real doar fiindcă începe la fel cu unul de pe AWB.
async function esteClientCurierat(nume) {
  const cheie = cheieClient(nume);
  if (!cheie || cheie.length < 3) return null;
  const r = await db
    .prepare(
      `SELECT id, nume, oras, judet, adresa, agentie, prima_comanda, ultima_comanda, trunchiat
         FROM consumabile_clienti WHERE cheie = ?`
    )
    .get(cheie)
    .catch(plangi("esteClientCurierat"));
  return r || null;
}

// Textul pe care-l vede agentul. Scurt, cu motivul, fără morală.
function avertisment(client) {
  const unde = [client && client.oras, client && client.judet].filter(Boolean).join(", ");
  return (
    `<strong>${(client && client.nume) || "Firma asta"}</strong> e client Sameday` +
    (unde ? ` (${unde})` : "") +
    ` — primește de la noi prin curier, pe AWB. Nu-i putem oferta produsele pe care le cumpără prin Sameday. ` +
    `Alte produse, da; consumabilele de curierat, nu.`
  );
}

// Toate cheile, pentru filtrarea unei liste întregi dintr-o singură interogare.
async function cheiLista() {
  const r = await db
    .prepare("SELECT cheie FROM consumabile_clienti")
    .all()
    .catch((e) => {
      console.error(`[clienti-curierat] cheiLista: ${e && e.message}`);
      return [];
    });
  return new Set(r.map((x) => String(x.cheie)));
}

module.exports = {
  cheieClient,
  curataNume,
  esteTrunchiat,
  reparaMojibake,
  gasesteClient,
  esteClientCurierat,
  avertisment,
  cheiLista,
};
