"use strict";
// Clientul scris pe loc, din formularul de comandă.
//
// Cererea lui Vali, 27.10.2026: agentul e la client, firma nu e în bază, iar
// până acum trebuia să plece din comandă, să facă partenerul, să se întoarcă
// și s-o ia de la capăt. Acum îl scrie acolo.
//
// Aici e partea care trebuie să fie corectă: CE SE CERE și CUM SE RECUNOAȘTE
// o firmă care există deja. Fără bază de date, ca să poată fi verificată de
// test.
//
// DE CE E CUI-UL OBLIGATORIU, deși baza nu-l cere:
//   E singurul lucru care identifică o firmă. Fără el intră „Sameday”,
//   „Sameday Courier” și „SAMEDAY SRL” ca trei parteneri, fiecare cu
//   scadențele și comenzile lui, iar peste o lună nimeni nu mai poate spune
//   cât ne datorează de fapt. Un formular rapid fără CUI nu e o scurtătură, e
//   o fabrică de dubluri.

// CUI-ul, curățat: fără „RO”, fără spații, puncte sau cratime.
function curataCui(v) {
  return String(v == null ? "" : v)
    .toUpperCase()
    .replace(/\s|\.|-/g, "")
    .replace(/^RO/, "")
    .replace(/[^0-9]/g, "");
}

// E un cod fiscal din altă țară?
//
// „HU12345678" sau „DE811234567" nu se verifică cu cifra de control
// românească — algoritmul e al nostru. Dacă n-am recunoaște prefixul, am
// curăța literele, am aplica formula noastră peste cifrele străine și am
// refuza un client adevărat spunându-i că a tastat greșit. Deci: cod străin
// se cere, dar nu se verifică.
function eStrain(v) {
  const t = String(v == null ? "" : v).toUpperCase().replace(/\s|\.|-/g, "");
  const m = t.match(/^([A-Z]{2})[0-9A-Z]/);
  return Boolean(m) && m[1] !== "RO";
}

// Cifra de control a CUI-ului românesc.
//
// Nu e o rafinărie: e singurul mod de a prinde o cifră tastată greșit ÎNAINTE
// ca firma să intre în bază. Cheia 753217532 se aplică de la dreapta spre
// stânga peste cifrele dinaintea ultimei; suma × 10, restul la 11, iar 10
// înseamnă 0.
function cuiValid(v) {
  const c = curataCui(v);
  if (c.length < 2 || c.length > 10) return false;
  const CHEIE = "753217532";
  const control = Number(c[c.length - 1]);
  const corp = c.slice(0, -1);
  let suma = 0;
  for (let i = 0; i < corp.length; i++) {
    // Se aliniază la dreapta: ultima cifră a corpului cu ultima cifră a cheii.
    const k = Number(CHEIE[CHEIE.length - corp.length + i]);
    suma += Number(corp[i]) * k;
  }
  let rest = (suma * 10) % 11;
  if (rest === 10) rest = 0;
  return rest === control;
}

// Numele, curățat pentru comparație: fără diacritice, fără formele juridice,
// fără punctuație. „S.C. Sameday Courier S.R.L.” și „Sameday Courier” trebuie
// să se recunoască una pe alta.
function cheieNume(v) {
  return String(v == null ? "" : v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(s\.?c\.?|s\.?r\.?l\.?|s\.?a\.?|p\.?f\.?a\.?|i\.?i\.?|srl|sa|pfa)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Câmpurile formularului, cu ce e obligatoriu și ce nu.
//
// Lista stă aici, nu în pagină: ecranul o desenează, serverul o verifică, și
// amândouă citesc ACELAȘI rând. Scrise de două ori, s-ar despărți la prima
// schimbare, iar formularul ar cere altceva decât acceptă serverul.
const CAMPURI = [
  { nume: "nume", eticheta: "Denumirea firmei", obligatoriu: true, exemplu: "Sameday Courier SRL" },
  // Exemplul NU e un număr: orice CUI pe care l-am pune aici ar fi ori
  // inventat (și atunci cade la verificarea cifrei de control, exact pe omul
  // care îl copiază), ori al unei firme adevărate, care n-are ce căuta în
  // formularul nostru.
  { nume: "cui", eticheta: "CUI / CIF", obligatoriu: true, exemplu: "RO… sau cod din altă țară" },
  { nume: "telefon", eticheta: "Telefon", obligatoriu: false, exemplu: "0722 000 000" },
  { nume: "email", eticheta: "Email", obligatoriu: false, exemplu: "comenzi@firma.ro" },
  { nume: "persoana_contact", eticheta: "Persoană de contact", obligatoriu: false, exemplu: "" },
  { nume: "adresa", eticheta: "Adresa", obligatoriu: false, exemplu: "" },
];

// Ce vine din formular, verificat. Întoarce ce s-ar scrie în bază, sau
// greșelile — pe toate deodată, nu una câte una: cine completează un formular
// vrea să le vadă pe toate, nu să-l trimită de cinci ori.
function verifica(corp) {
  const b = corp || {};
  const date = {};
  for (const c of CAMPURI) date[c.nume] = String(b[c.nume] == null ? "" : b[c.nume]).trim();
  const gresite = [];

  for (const c of CAMPURI) {
    if (c.obligatoriu && !date[c.nume]) gresite.push(`${c.eticheta} lipsește.`);
  }
  if (date.nume && date.nume.length < 3) gresite.push("Denumirea firmei e prea scurtă.");

  if (date.cui && eStrain(date.cui)) {
    // Se păstrează cum l-a scris omul, cu tot cu prefixul de țară: ăla e
    // identitatea firmei în afara României.
    date.cui = String(date.cui).toUpperCase().replace(/\s|\.|-/g, "");
  } else if (date.cui) {
    const c = curataCui(date.cui);
    if (!c) gresite.push("CUI-ul nu conține nicio cifră.");
    else if (!cuiValid(c)) {
      gresite.push(
        `CUI-ul ${date.cui} nu trece verificarea cifrei de control — e aproape sigur o cifră tastată greșit.`
      );
    } else date.cui = c;
  }
  // Emailul nu e obligatoriu, dar dacă e scris trebuie să fie un email: unul
  // stricat se descoperă abia când nu pleacă confirmarea comenzii.
  if (date.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(date.email)) {
    gresite.push(`„${date.email}” nu arată a adresă de email.`);
  }
  return { date, gresite, ok: gresite.length === 0 };
}

// Firma există deja?
//
// Întâi după CUI, fiindcă ăla e identitatea. Abia apoi după nume, pentru
// firmele vechi intrate fără CUI. Căutarea pe nume e pe cheia curățată, altfel
// „S.C. Sameday S.R.L.” ar trece drept firmă nouă lângă „Sameday”.
function gaseste(existenti, date) {
  if (eStrain(date.cui)) {
    const t = String(date.cui).toUpperCase().replace(/\s|\.|-/g, "");
    const dupaCuiStrain = (existenti || []).find(
      (p) => String(p.cui || "").toUpperCase().replace(/\s|\.|-/g, "") === t
    );
    if (dupaCuiStrain) return { partener: dupaCuiStrain, dupa: "CUI" };
  }
  const cui = eStrain(date.cui) ? "" : curataCui(date.cui);
  if (cui) {
    const dupaCui = (existenti || []).find((p) => curataCui(p.cui) === cui);
    if (dupaCui) return { partener: dupaCui, dupa: "CUI" };
  }
  const k = cheieNume(date.nume);
  if (k) {
    const dupaNume = (existenti || []).find((p) => cheieNume(p.nume) === k);
    if (dupaNume) return { partener: dupaNume, dupa: "nume" };
  }
  return null;
}

module.exports = { CAMPURI, curataCui, cuiValid, eStrain, cheieNume, verifica, gaseste };
