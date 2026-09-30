"use strict";
// Aplicarea loturilor venite prin punte — scrisă o singură dată.
//
// Loturile sosesc de la browser (vezi punte/sincronizare.js) și stau în
// `punte_staging` până le aprobă cineva. Aprobarea se putea face doar din
// /import/punte, care e o pagină de administrator. Butonul de „actualizează"
// de la facturare face exact același lucru, deci trebuie să fie exact același
// cod: dacă ordinea de aplicare ar diferi între cele două locuri, o dată ar
// intra încasările înaintea facturilor pe care le sting, și s-ar pierde.
//
// HANDLERE se dă ca parametru, nu se cere prin require, ca să nu se închidă
// un cerc: punte.js cheamă punte-rute.js, care cheamă fișierul ăsta.
const db = require("./db");
const { recalculeazaStatusFacturi } = require("./statusuri");

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Ordinea de aplicare. Contează, și nu puțin:
//   partenerii înaintea facturilor (factura are nevoie de client),
//   facturile înaintea liniilor și a încasărilor (plata stinge o factură
//   care trebuie să existe deja),
//   produsele înaintea stocului și a producției (rețeta caută produsul).
// Ce nu e în listă se aplică la urmă, nu la început — de-aia -1 devine 99,
// altfel `indexOf` ar fi pus tipurile noi (facturi, încasări) în frunte.
const ORDINE = [
  "parteneri",
  "produse",
  "cost_produse",
  "stoc",
  "facturi",
  "facturi_linii",
  "incasari",
  "plati_furnizori",
  "productie",
  "consum",
];

function rang(tip) {
  const i = ORDINE.indexOf(String(tip));
  return i === -1 ? 99 : i;
}

async function aplicaLot(HANDLERE, l) {
  const handler = HANDLERE[l.tip];
  if (!handler) return { eroare: `tip necunoscut: ${l.tip}` };
  let randuri = [];
  try {
    randuri = JSON.parse(l.continut) || [];
  } catch (e) {
    return { eroare: "conținut ilizibil" };
  }
  try {
    const rez = await handler(randuri);
    await db
      .prepare("UPDATE punte_staging SET aplicat_la = ?, rezultat = ? WHERE id = ?")
      .run(acum(), JSON.stringify(rez), l.id);
    return rez;
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await db.prepare("UPDATE punte_staging SET rezultat = ? WHERE id = ?").run("EROARE: " + msg, l.id);
    return { eroare: msg };
  }
}

// Aplică tot ce stă în așteptare și întoarce lista rezultatelor, în ordinea
// în care s-au aplicat.
//
// La final recalculează statusul facturilor. Fără pasul ăsta, o încasare
// venită prin punte intra în tabelul de plăți, dar factura rămânea pe
// „emisă" — soldurile ieșeau corecte peste tot, doar coloana Status mințea.
// Recalcularea trece peste TOATE facturile, nu doar peste cele din lot: așa
// se repară din mers și cele rămase în urmă de la sincronizările vechi.
async function aplicaTot(HANDLERE) {
  const loturi = await db.prepare("SELECT * FROM punte_staging WHERE aplicat_la IS NULL ORDER BY id").all();
  loturi.sort((a, b) => rang(a.tip) - rang(b.tip) || a.id - b.id);
  const rezultate = [];
  for (const l of loturi) rezultate.push({ id: l.id, tip: l.tip, rez: await aplicaLot(HANDLERE, l) });
  const statusuri = await recalculeazaStatusFacturi();
  return { rezultate, statusuri };
}

// Numerele pe care le vrea omul după ce apasă butonul.
//
// Fiecare handler întoarce alt obiect, cu alte nume de chei — de-aia e
// tabelul de mai jos, în loc de o ghicire pe nume generice. Ghicirea a și
// fost încercată („adaugate", „importate", „noi") și a ieșit „0 rânduri noi"
// pe un import care adusese 16 facturi și 34 de încasări: niciun handler nu
// folosește numele alea. Un tip nou care nu e aici apare cu 0 — se adaugă o
// linie, nu se rescrie funcția.
const CHEI = {
  facturi: { noi: ["facturi"], sarite: ["sarite"] },
  facturi_linii: { noi: ["linii"], sarite: ["negasite"] },
  incasari: { noi: ["incasari_scrise"], sarite: ["dubluri_sarite", "inchise_istoric_ignorate", "facturi_negasite"] },
  plati_furnizori: { noi: ["plati_scrise"], sarite: ["negasite"] },
  parteneri: { noi: ["Parteneri noi"], sarite: ["Rânduri fără nume"] },
  produse: { noi: ["noi"], sarite: ["sarite"] },
  stoc: { noi: ["scrise"], sarite: ["sarite"] },
  cost_produse: { noi: ["completate"], sarite: ["aveau_deja_cost", "nepotrivite", "costuri_aberante_sarite"] },
  productie: { noi: ["retete"], sarite: [] },
  consum: { noi: ["linii"], sarite: ["sarite"] },
  profit_produs: { noi: ["scrise"], sarite: [] },
  registru_comenzi: { noi: ["comenzi", "adaugate"], sarite: ["sarite"] },
  balante: { noi: [], sarite: [] }, // întoarce un rezumat în text, n-are ce număra
  angajati: { noi: ["adaugati"], sarite: [] },
  salarii: { noi: ["state_scrise"], sarite: [] },
  sugestii: { noi: ["adaugate"], sarite: ["sarite"] },
};

const aduna = (obiect, chei) =>
  (chei || []).reduce((s, k) => s + (Number(obiect[k]) || 0), 0);

function rezumat(rezultate) {
  const lista = Array.isArray(rezultate) ? rezultate : (rezultate && rezultate.rezultate) || [];
  const total = { loturi: lista.length, noi: 0, sarite: 0, erori: 0 };
  const peTip = new Map();
  for (const r of lista) {
    const o = r.rez || {};
    if (o.eroare) total.erori++;
    const harta = CHEI[r.tip] || { noi: ["adaugate"], sarite: ["sarite"] };
    const n = aduna(o, harta.noi);
    const s = aduna(o, harta.sarite);
    total.noi += n;
    total.sarite += s;
    const p = peTip.get(r.tip) || { noi: 0, sarite: 0 };
    p.noi += n;
    p.sarite += s;
    peTip.set(r.tip, p);
  }
  return { total, peTip };
}

module.exports = { aplicaLot, aplicaTot, rezumat, ORDINE, CHEI };
