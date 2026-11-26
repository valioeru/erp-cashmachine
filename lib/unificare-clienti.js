"use strict";
// Unificarea clienților: cine cu cine pare a fi același partener.
//
// CEREREA LUI VALI, 26.11.2026: „Fă te rog și pagina de unificare […] care să
// fie validată manual, cu sugestie, ca la produse. Vreau unificare pe clienți."
//
// De ce apar dubluri: același partener intră în ERP pe mai multe căi — din
// facturile SmartBill (cu CUI), scris de un agent la o comandă (fără CUI),
// dintr-un lead, dintr-un import vechi. Rezultatul: comenzile sunt pe unul,
// facturile pe altul, iar fișa clientului arată jumătate din istoric.
//
// Fișierul ăsta doar PROPUNE perechi și spune de ce. Nu unifică nimic: pagina
// (modules/unificare-clienti.js) arată propunerile, omul validează fiecare
// pereche, iar mutarea o face lib/parteneri-fuziune.js.
//
// Fără bază de date, ca să se poată verifica într-un test.

const faraDiacritice = (v) => String(v == null ? "" : v).normalize("NFD").replace(/[̀-ͯ]/g, "");
const simplu = (v) => faraDiacritice(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// CUI-ul, doar cifrele: „RO 123456", „ro123456" și „123456" sunt același.
function cuiCurat(cui) {
  const c = String(cui == null ? "" : cui).replace(/[^0-9]/g, "").replace(/^0+/, "");
  return c.length >= 4 ? c : "";
}

// Formele juridice de la capetele numelui nu deosebesc două firme:
// „SC Elhor Trade SRL" și „Elhor Trade" sunt același nume.
const FORME = /^(?:s c|sc|s c m|scm)\s+|\s+(?:s r l d|s r l|srl d|srld|srl|s a|sa|s c s|scs|s n c|snc|p f a|pfa|i i|ii|i f|ltd|gmbh|llc|inc|kft|eood|ood|d o o|doo|s r o|sro|s p a|spa|b v|bv|a g|ag)$/;
function cheieNume(nume) {
  let t = simplu(nume);
  for (let i = 0; i < 4; i++) {
    const u = t.replace(FORME, "").trim();
    if (u === t) break;
    t = u;
  }
  return t;
}

const emailCurat = (v) => {
  const e = String(v == null ? "" : v).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : "";
};
// Telefonul: ultimele 9 cifre (fără prefixul de țară).
const telefonCurat = (v) => {
  const c = String(v == null ? "" : v).replace(/[^0-9]/g, "");
  return c.length >= 9 ? c.slice(-9) : "";
};

function levenshtein(a, b, prag) {
  if (Math.abs(a.length - b.length) > prag) return prag + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < min) min = cur[j];
    }
    if (min > prag) return prag + 1;
    prev = cur;
  }
  return prev[b.length];
}

const cheiePereche = (x, y) => (Number(x) < Number(y) ? `${Number(x)}:${Number(y)}` : `${Number(y)}:${Number(x)}`);

// Un cuvânt care apare la mai mult de atâția parteneri nu mai deosebește pe
// nimeni („trade", „impex", „prod", „com").
const PREA_DES = 25;
const MAX_PROPUNERI = 400;

// Perechile de parteneri care par același.
//   parteneri: [{ id, nume, cui, email, telefon, ... }]
//   opt.respinse: Set cu „a:b" (a < b) — perechile despre care un om a spus „nu e același"
//   opt.fuziuni: [{ pastrat_id, inghitit_nume, inghitit_cui, facut_la }] — unificări deja făcute
// Întoarce [{ a, b, scor, motive: [text], atentie: [text] }], cele mai sigure întâi.
function propuneri(parteneri, opt) {
  const o = opt || {};
  const respinse = o.respinse || new Set();
  const lista = (parteneri || []).map((p) => ({
    p,
    id: Number(p.id),
    cui: cuiCurat(p.cui),
    nume: cheieNume(p.nume),
    email: emailCurat(p.email),
    telefon: telefonCurat(p.telefon),
  })).filter((x) => x.id > 0);
  const dupaId = new Map(lista.map((x) => [x.id, x]));
  const perechi = new Map();
  const pune = (x, y, scor, motiv) => {
    if (!x || !y || x.id === y.id) return;
    const k = cheiePereche(x.id, y.id);
    if (respinse.has(k)) return;
    let r = perechi.get(k);
    if (!r) {
      const [a, b] = x.id < y.id ? [x, y] : [y, x];
      r = { a: a.p, b: b.p, scor: 0, motive: [], atentie: [], _a: a, _b: b };
      perechi.set(k, r);
    }
    if (!r.motive.includes(motiv)) r.motive.push(motiv);
    if (scor > r.scor) r.scor = scor;
  };
  const grupeaza = (camp) => {
    const m = new Map();
    for (const x of lista) if (x[camp]) (m.get(x[camp]) || m.set(x[camp], []).get(x[camp])).push(x);
    return [...m.values()].filter((g) => g.length > 1 && g.length <= 12);
  };
  const toate = (g, scor, motiv) => {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) pune(g[i], g[j], scor, typeof motiv === "function" ? motiv(g[i]) : motiv);
  };
  for (const g of grupeaza("cui")) toate(g, 100, (x) => `același CUI (${x.cui})`);
  for (const g of grupeaza("nume")) toate(g, 90, "același nume");
  for (const g of grupeaza("email")) toate(g, 70, (x) => `același email (${x.email})`);
  for (const g of grupeaza("telefon")) toate(g, 65, "același telefon");

  // Un partener scris din nou după ce a fost unificat (un import l-a adus
  // înapoi sub numele vechi): se propune spre cel în care a intrat atunci.
  for (const f of o.fuziuni || []) {
    const tinta = dupaId.get(Number(f.pastrat_id));
    if (!tinta) continue;
    const n = cheieNume(f.inghitit_nume);
    const c = cuiCurat(f.inghitit_cui);
    for (const x of lista) {
      if (x.id === tinta.id) continue;
      if ((n && x.nume === n) || (c && x.cui === c)) pune(x, tinta, 95, `a mai fost unificat în acesta${f.facut_la ? " pe " + String(f.facut_la).slice(0, 10) : ""} și a apărut din nou`);
    }
  }

  // Nume asemănătoare: un nume cuprins în celălalt, sau scrise aproape la fel.
  const dupaCuvant = new Map();
  for (const x of lista) {
    x.cuvinte = [...new Set(x.nume.split(" ").filter((c) => c.length >= 3))];
    for (const c of x.cuvinte) (dupaCuvant.get(c) || dupaCuvant.set(c, []).get(c)).push(x);
  }
  const vazute = new Set();
  for (const [, g] of dupaCuvant) {
    if (g.length < 2 || g.length > PREA_DES) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const x = g[i], y = g[j];
        const k = cheiePereche(x.id, y.id);
        if (vazute.has(k) || x.nume === y.nume) continue;
        vazute.add(k);
        // Două firme cu CUI-uri diferite și nume doar asemănătoare sunt, cel
        // mai des, două firme diferite (grupuri, puncte de lucru cu alt CUI).
        if (x.cui && y.cui && x.cui !== y.cui) continue;
        const comune = x.cuvinte.filter((c) => y.cuvinte.includes(c));
        const rare = comune.filter((c) => (dupaCuvant.get(c) || []).length <= PREA_DES);
        const lungime = rare.join("").length;
        const mic = Math.min(x.cuvinte.length, y.cuvinte.length);
        const reuniune = new Set(x.cuvinte.concat(y.cuvinte)).size;
        if (comune.length === mic && lungime >= 5) pune(x, y, 50, "un nume îl cuprinde pe celălalt");
        else if (reuniune && comune.length / reuniune >= 0.6 && lungime >= 5) pune(x, y, 45, "nume asemănătoare");
      }
    }
  }
  // Aceeași scriere, cu o literă-două diferență („Elhor Trade" / „Elhor Trde").
  const lipite = lista.filter((x) => x.nume.replace(/ /g, "").length >= 7).map((x) => ({ x, t: x.nume.replace(/ /g, "") }));
  const dupaInceput = new Map();
  for (const l of lipite) (dupaInceput.get(l.t.slice(0, 3)) || dupaInceput.set(l.t.slice(0, 3), []).get(l.t.slice(0, 3))).push(l);
  for (const [, g] of dupaInceput) {
    if (g.length < 2 || g.length > 200) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const x = g[i].x, y = g[j].x;
        if (g[i].t === g[j].t || (x.cui && y.cui && x.cui !== y.cui)) continue;
        if (levenshtein(g[i].t, g[j].t, 2) <= 2) pune(x, y, 55, "nume scrise aproape la fel");
      }
    }
  }

  const out = [...perechi.values()];
  for (const r of out) {
    if (r._a.cui && r._b.cui && r._a.cui !== r._b.cui) {
      r.atentie.push(`CUI diferit: ${r._a.cui} și ${r._b.cui} — pot fi două firme diferite`);
      r.scor = Math.min(r.scor, 40);
    }
    delete r._a;
    delete r._b;
  }
  out.sort((p, q) => q.scor - p.scor || String(p.a.nume || "").localeCompare(String(q.a.nume || ""), "ro") || p.a.id - q.a.id || p.b.id - q.b.id);
  return out.slice(0, MAX_PROPUNERI);
}

// Pe care îl păstrăm, din doi: cel cu CUI, apoi cel cu mai multe documente,
// apoi cel mai vechi. E doar propunerea; omul poate alege invers.
//   documente: Map id → număr de comenzi + facturi
function alegePastrat(a, b, documente) {
  const d = (p) => Number((documente && documente.get(Number(p.id))) || 0);
  const areCui = (p) => (cuiCurat(p.cui) ? 1 : 0);
  if (areCui(a) !== areCui(b)) return areCui(a) ? a : b;
  if (d(a) !== d(b)) return d(a) > d(b) ? a : b;
  return Number(a.id) <= Number(b.id) ? a : b;
}

// Ce primește partenerul păstrat de la cel care dispare: doar câmpurile pe
// care păstratul le are goale. Ce are scris nu se calcă.
const CAMPURI_COMPLETATE = ["cui", "reg_com", "email", "telefon", "persoana_contact", "adresa", "localitate", "judet", "tara", "termen_plata_zile", "agent_id", "firma_grup_id", "data_nastere", "sursa"];
const gol = (v) => v === null || v === undefined || String(v).trim() === "";
function completari(pastrat, inghitit) {
  const out = {};
  for (const c of CAMPURI_COMPLETATE) if (gol(pastrat[c]) && !gol(inghitit[c])) out[c] = inghitit[c];
  // Client la unul, furnizor la celălalt: păstratul devine „ambele".
  const tp = String(pastrat.tip || ""), ti = String(inghitit.tip || "");
  if (tp && ti && tp !== ti && tp !== "ambele") out.tip = "ambele";
  // Un lead unificat cu un client activ rămâne client activ.
  if (String(pastrat.stare || "") === "lead" && !gol(inghitit.stare) && inghitit.stare !== "lead") out.stare = inghitit.stare;
  return out;
}

module.exports = { cuiCurat, cheieNume, emailCurat, telefonCurat, cheiePereche, levenshtein, propuneri, alegePastrat, completari, CAMPURI_COMPLETATE, MAX_PROPUNERI };
