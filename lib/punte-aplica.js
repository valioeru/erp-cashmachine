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
async function aplicaTot(HANDLERE) {
  const loturi = await db.prepare("SELECT * FROM punte_staging WHERE aplicat_la IS NULL ORDER BY id").all();
  loturi.sort((a, b) => rang(a.tip) - rang(b.tip) || a.id - b.id);
  const rezultate = [];
  for (const l of loturi) rezultate.push({ id: l.id, tip: l.tip, rez: await aplicaLot(HANDLERE, l) });
  return rezultate;
}

// Numerele pe care le vrea omul după ce apasă butonul: câte facturi noi, câte
// încasări, câte rânduri sărite. Fiecare handler întoarce alt obiect, așa că
// adunăm după numele cheilor, nu după o formă fixă.
function rezumat(rezultate) {
  const total = { loturi: rezultate.length, adaugate: 0, actualizate: 0, sarite: 0, erori: 0 };
  const peTip = new Map();
  for (const r of rezultate) {
    const o = r.rez || {};
    if (o.eroare) total.erori++;
    const a = Number(o.adaugate || o.importate || o.noi || 0);
    const u = Number(o.actualizate || o.modificate || 0);
    const s = Number(o.sarite || o.ignorate || o.duplicate || 0);
    total.adaugate += a;
    total.actualizate += u;
    total.sarite += s;
    const p = peTip.get(r.tip) || { adaugate: 0, actualizate: 0, sarite: 0 };
    p.adaugate += a;
    p.actualizate += u;
    p.sarite += s;
    peTip.set(r.tip, p);
  }
  return { total, peTip };
}

module.exports = { aplicaLot, aplicaTot, rezumat, ORDINE };
