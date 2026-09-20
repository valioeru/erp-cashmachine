"use strict";
// Firmele noastre și domeniile lor.
//
// Până acum ERP-ul știa o singură firmă, iar „cashmachine.ro" era scris ca
// literă în cod, în trei locuri. Cererea lui Vali: agenții au adrese și pe
// warehouseall.ro, emailurile de acolo trebuie aduse exact la fel, cumulate
// pe același client, iar la trimitere se alege de pe ce adresă pleacă.
//
// De-aia „ale noastre" nu mai e o constantă, ci se deduce din căsuțele
// conectate: adaugi căsuța, și tot ce depinde de „e al nostru?" se ia după ea.
// O listă scrisă de mână ar fi rămas în urmă exact în ziua în care conta.
//
// Ce atârnă de răspunsul ăsta, și de ce contează să fie corect:
//   • legarea pe domenii NU are voie să lege mesajele de la colegi de vreun
//     client. Dacă warehouseall.ro n-ar fi recunoscut ca al nostru, ar fi
//     fost propus drept „firma WAREHOUSE ALL SRL" — și fiecare mesaj intern
//     ar fi ajuns în istoricul unui client;
//   • blocarea expeditorilor nu are voie să blocheze domeniul firmei;
//   • la trimitere, adresa de expeditor trebuie să fie una de-a noastră.
const db = require("./db");

// Domeniul cu care a început totul. Rămâne ca plasă de siguranță: dacă baza
// nu răspunde, tot nu vrem ca emailul intern să fie luat drept al unui client.
const DOMENIU_IMPLICIT = "cashmachine.ro";

let cache = null;
let cacheLa = 0;
const VIATA_CACHE = 60000;

function normDomeniu(d) {
  return String(d || "")
    .toLowerCase()
    .trim()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.\-]/g, "");
}

function domeniulDin(email) {
  const a = String(email || "").toLowerCase().trim();
  const i = a.lastIndexOf("@");
  return normDomeniu(i > 0 ? a.slice(i + 1) : a);
}

// Domeniile firmei, din căsuțele conectate. Se ține un minut în memorie: pe o
// sincronizare de o mie de mesaje ar fi fost o mie de interogări pentru
// același răspuns, iar adăugarea unei căsuțe nu e o operațiune de fiecare zi.
async function domenii({ proaspat } = {}) {
  const acum = Date.now();
  if (cache && !proaspat && acum - cacheLa < VIATA_CACHE) return cache;
  const s = new Set([DOMENIU_IMPLICIT]);
  try {
    const r = await db.prepare("SELECT DISTINCT lower(adresa) AS adresa FROM email_conturi").all();
    for (const x of r) {
      const d = domeniulDin(x.adresa);
      if (d && d.includes(".")) s.add(d);
    }
  } catch (e) {
    // Fără bază rămâne plasa de siguranță. Mai bine un domeniu în minus decât
    // emailul intern legat de un client.
  }
  cache = s;
  cacheLa = acum;
  return s;
}

function uita() {
  cache = null;
  cacheLa = 0;
}

// Varianta sincronă, pentru locurile care nu pot aștepta (filtre în bucle).
// Întoarce ce s-a încărcat ultima dată; până la prima încărcare, doar
// domeniul implicit.
function domeniiAcum() {
  return cache || new Set([DOMENIU_IMPLICIT]);
}

function eAlNostruDin(set, domeniu) {
  const d = normDomeniu(domeniu);
  if (!d) return false;
  for (const x of set) if (d === x || d.endsWith("." + x)) return true;
  return false;
}

async function eAlNostru(domeniu) {
  return eAlNostruDin(await domenii(), domeniu);
}

function eAlNostruAcum(domeniu) {
  return eAlNostruDin(domeniiAcum(), domeniu);
}

// Numele firmei, scos din domeniu: „warehouseall.ro" → „Warehouseall".
// Se folosește doar ca etichetă în interfață, ca omul să vadă de pe ce firmă
// trimite. Numele adevărat, cu formă juridică, stă pe partener, nu aici.
function eticheta(domeniu) {
  const d = normDomeniu(domeniu);
  if (!d) return "";
  const miez = d.split(".")[0] || d;
  return miez.charAt(0).toUpperCase() + miez.slice(1);
}

module.exports = {
  DOMENIU_IMPLICIT,
  domenii,
  domeniiAcum,
  domeniulDin,
  normDomeniu,
  eAlNostru,
  eAlNostruAcum,
  eticheta,
  uita,
};
