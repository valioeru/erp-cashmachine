"use strict";
// Mai multe adrese de livrare pe același client.
//
// CEREREA LUI VALI, 26.11.2026: „Un client să poată avea mai multe adrese de
// livrare, iar la comandă selectezi adresa de livrare."
//
// CUM SE ȚIN. Adresa de livrare de pe fișă (`parteneri.adresa_livrare`, goală
// = aceeași cu adresa firmei; lib/adresa-livrare.js) rămâne cea la care se
// livrează de obicei. Celelalte stau în `parteneri_adrese_livrare`, câte un
// rând: un nume scurt („Depozit Cluj", „Magazin Unirii"), ca omul să le
// deosebească la alegere, și adresa. O adresă scoasă nu se șterge (`activ = 0`):
// comenzile vechi au textul ei copiat, iar rândul rămâne ca urmă.
//
// La comandă se alege dintr-o listă (lib/livrare-la.js); pe comandă rămâne
// TEXTUL adresei, nu o legătură — o adresă schimbată mâine nu mută comanda de ieri.
//
// Partea de sus e fără bază de date, ca să se poată verifica într-un test.
const AL = require("./adresa-livrare");

const MAX_DENUMIRE = 60;
const MAX_ADRESA = 400;

const unRand = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

// Ce vine din formularul „adaugă o adresă".
//   existente: textele adreselor pe care clientul le are deja (toate felurile)
// Întoarce { ok, denumire, adresa } sau { ok: false, eroare }.
function dinFormular(corp, existente) {
  const b = corp || {};
  const denumire = unRand(b.denumire);
  const adresa = unRand(b.adresa);
  if (!adresa) return { ok: false, eroare: "Scrie adresa de livrare: strada, numărul, localitatea, județul." };
  if (adresa.length > MAX_ADRESA) return { ok: false, eroare: `Adresa de livrare e prea lungă (cel mult ${MAX_ADRESA} de semne).` };
  if (denumire.length > MAX_DENUMIRE) return { ok: false, eroare: `Numele adresei e prea lung (cel mult ${MAX_DENUMIRE} de semne).` };
  if (eDeja(adresa, existente)) return { ok: false, eroare: "Clientul are deja adresa asta de livrare." };
  return { ok: true, denumire, adresa };
}

// Aceeași adresă scrisă puțin altfel (diacritice, virgule, majuscule) e tot ea.
function eDeja(adresa, existente) {
  const k = AL.cheie(adresa);
  if (!k) return false;
  return (existente || []).some((x) => AL.cheie(x) === k);
}

// Cum se numește o adresă în liste: numele ei, altfel „adresă de livrare".
const numeAfisat = (r) => unRand(r && r.denumire) || "adresă de livrare";

// ---- cu bază ---------------------------------------------------------------

async function alePartenerului(partenerId) {
  const db = require("./db");
  return await db
    .prepare("SELECT id, denumire, adresa FROM parteneri_adrese_livrare WHERE partener_id = ? AND COALESCE(activ, 1) = 1 ORDER BY id")
    .all(partenerId)
    .catch(() => []);
}

// Adaugă o adresă. `existente` = textele celorlalte adrese ale clientului
// (adresa firmei și cea de livrare de pe fișă), ca să nu intre de două ori.
async function adauga({ partenerId, corp, existente, userId }) {
  const db = require("./db");
  const avute = (await alePartenerului(partenerId)).map((r) => r.adresa).concat(existente || []);
  const v = dinFormular(corp, avute);
  if (!v.ok) return v;
  const r = await db
    .prepare("INSERT INTO parteneri_adrese_livrare (partener_id, denumire, adresa, creat_la, creat_de, activ) VALUES (?, ?, ?, ?, ?, 1) RETURNING id")
    .get(partenerId, v.denumire || null, v.adresa, new Date().toISOString(), userId || null);
  return { ok: true, id: r && r.id, denumire: v.denumire, adresa: v.adresa };
}

async function scoate({ partenerId, id }) {
  const db = require("./db");
  await db.prepare("UPDATE parteneri_adrese_livrare SET activ = 0 WHERE id = ? AND partener_id = ?").run(id, partenerId);
}

module.exports = { MAX_DENUMIRE, MAX_ADRESA, dinFormular, eDeja, numeAfisat, alePartenerului, adauga, scoate };
