"use strict";
// Codul nou, propus din denumirea unui produs vechi. Fără bază de date.
//
// CEREREA LUI VALI, 18.11.2026: „La «cod nou sau id» sugerează tu codul, în
// funcție de denumire și de convenția noastră nouă."
//
// Convenția nouă e configuratorul: familia și caracteristicile ei, din care
// codul iese singur. Deci „a sugera codul" înseamnă a ghici, din denumirea
// veche, FAMILIA și VALORILE caracteristicilor. Codul îl face tot
// configuratorul, din ele — aici nu se scrie niciun cod.
//
// Regula de bază: se completează doar ce se citește limpede. Ce nu se poate
// ști din denumire rămâne gol și îl alege omul; un câmp ghicit greșit ar da un
// cod greșit, care arată la fel de sigur ca unul bun.
const U = require("./unificare-coduri");

const cuvinte = (t) => U.cheie(t).split(" ").filter(Boolean);

// Aceeași vorbă scrisă altfel, la potrivirea valorilor dintr-o listă.
const LA_FEL = {
  manuala: "manual", manuale: "manual", automata: "automat", automate: "automat",
  transparenta: "transparent", transp: "transparent", tr: "transparent",
  neagra: "negru", black: "negru", alba: "alb", white: "alb", brown: "maro",
  reciclata: "reciclat", regranulat: "reciclat", virgina: "virgin",
  neimprimata: "neimprimat", imprimata: "imprimat", nepersonalizata: "nepersonalizat", personalizata: "personalizat",
  americana: "american", simpla: "simplu", benzi: "banda", adeziva: "adeziv", pungi: "punga", cutii: "cutie", plicuri: "plic",
  saci: "sac", folii: "folie", hartii: "hartie", noisy: "noise", debitata: "debitat", debitate: "debitat",
};
const norm = (w) => LA_FEL[w] || w;
const vorbe = (t) => cuvinte(t).map(norm);

// Cuvintele care nu deosebesc o familie de alta.
const GOALE = new Set(["cu", "de", "la", "si", "pentru", "tip"]);

// Familia produsului, după denumire (și cod). `familii`: [{ id, nume }].
// Întoarce id-ul sau 0 când nu se poate spune sau când două familii se
// potrivesc la fel de bine.
function ghicesteFamilia(denumire, cod, familii) {
  const v = new Set(vorbe(`${denumire == null ? "" : denumire} ${/[a-z]/i.test(String(cod || "")) ? cod : ""}`));
  // „jumbo" și „prestretch" sunt tot folie stretch, chiar fără cuvântul „stretch".
  if (v.has("jumbo") || v.has("prestretch")) v.add("stretch");
  if (v.has("stretch")) v.add("folie");
  // Câte familii poartă fiecare cuvânt: „folie" e în mai multe, deci cântărește puțin.
  const cate = new Map();
  const peFamilie = (familii || []).map((f) => {
    const w = [...new Set(vorbe(f.nume).filter((x) => !GOALE.has(x)))];
    for (const x of w) cate.set(x, (cate.get(x) || 0) + 1);
    return { f, w };
  });
  let bun = null;
  let egal = false;
  for (const { f, w } of peFamilie) {
    if (!w.length) continue;
    const gasite = w.filter((x) => v.has(x));
    // Fără un cuvânt care e doar al ei, familia nu se alege („folie" singur nu spune care folie).
    if (!gasite.some((x) => cate.get(x) === 1)) continue;
    const scor = gasite.reduce((a, x) => a + 1 / cate.get(x), 0) / w.length;
    if (!bun || scor > bun.scor) {
      bun = { f, scor };
      egal = false;
    } else if (scor === bun.scor) egal = true;
  }
  return bun && !egal ? Number(bun.f.id) : 0;
}

const eNumeDe = (c, ...ce) => ce.some((x) => U.cheie(c.nume).split(" ").some((w) => w.startsWith(x)));
const umLui = (c) => U.cheie(c.um);
const eGrosime = (c) => eNumeDe(c, "grosime", "micron") || /^(my|mic|micron|microni)$/.test(umLui(c));
const eGreutate = (c) => eNumeDe(c, "greutate") || umLui(c) === "kg";
const eDimensiune = (c) => eNumeDe(c, "latime", "lungime", "inaltime") && !eGrosime(c);

const inLimite = (c, n) => Number.isFinite(n) && n > 0 && (c.min_val == null || n >= Number(c.min_val)) && (c.max_val == null || n <= Number(c.max_val));

// Valorile caracteristicilor, citite din denumire.
//   caracteristici: [{ id, nume, fel: 'lista'|'numar'|'text', um, min_val, max_val, valori: [{ valoare }] }], în ordinea lor
// Întoarce { [id]: valoare } doar pentru ce s-a citit limpede.
function completeaza(denumire, cod, caracteristici) {
  const brut = U.faraSemne(`${denumire == null ? "" : denumire}`);
  const t = U.trasaturi(denumire, cod);
  const v = new Set(vorbe(`${denumire == null ? "" : denumire} ${/[a-z]/i.test(String(cod || "")) ? cod : ""}`));
  for (const c of t.culori) v.add(c);
  const out = {};

  // Măsurile scrise cu „x": 48mm x 60m, 485X295X335. Merg, în ordine, la
  // caracteristicile de dimensiune (lățime, lungime, înălțime), tot în ordinea lor.
  const masura = (t.masuri[0] || "").split("x").filter(Boolean).map(Number);
  const dimensiuni = (caracteristici || []).filter((c) => c.fel === "numar" && eDimensiune(c));
  if (masura.length >= 2 && masura.length <= dimensiuni.length) {
    masura.forEach((n, i) => {
      if (inLimite(dimensiuni[i], n)) out[dimensiuni[i].id] = String(n);
    });
  }

  for (const c of caracteristici || []) {
    if (out[c.id] !== undefined) continue;
    if (c.fel === "lista") {
      const optiuni = (c.valori || []).map((x) => ({ valoare: x.valoare, w: [...new Set(vorbe(x.valoare))] })).filter((x) => x.w.length);
      // O singură valoare în listă (Tip: „Bandă adezivă"): n-are ce alege omul.
      if (optiuni.length === 1) {
        out[c.id] = optiuni[0].valoare;
        continue;
      }
      // Se potrivește valoarea ale cărei cuvinte sunt toate în denumire. Dacă
      // se potrivesc mai multe, câștigă cea mai lungă („Low noise" bate
      // „Normal"); la egalitate nu se alege nimic.
      const bune = optiuni.filter((o) => o.w.every((x) => v.has(x))).sort((a, b) => b.w.length - a.w.length);
      if (bune.length && (bune.length === 1 || bune[0].w.length > bune[1].w.length)) out[c.id] = bune[0].valoare;
      continue;
    }
    if (c.fel !== "numar") continue; // textul liber îl scrie omul
    let n = null;
    if (eGrosime(c)) n = t.grosime;
    else if (eGreutate(c)) {
      const m = /(\d+(?:[.,]\d+)?)\s*kg(?![a-z])/.exec(brut);
      n = m ? Number(m[1].replace(",", ".")) : null;
    } else if (eDimensiune(c)) {
      // Fără măsuri cu „x": numărul cu unitatea caracteristicii lipită de el
      // („2000 m", „500mm"). Doar dacă e unul singur în denumire.
      const um = umLui(c) === "metri" ? "m" : umLui(c);
      if (um === "m" || um === "mm" || um === "cm") {
        const gasite = [...brut.matchAll(new RegExp(`(?<![a-z0-9.,])(\\d+(?:[.,]\\d+)?)\\s?${um}(?![a-z0-9])`, "g"))].map((m) => Number(m[1].replace(",", ".")));
        if (gasite.length === 1 && dimensiuni.filter((d) => (umLui(d) === "metri" ? "m" : umLui(d)) === um).length === 1) n = gasite[0];
      }
    }
    if (n !== null && inLimite(c, n)) out[c.id] = String(n);
  }
  return out;
}

module.exports = { ghicesteFamilia, completeaza, vorbe };
