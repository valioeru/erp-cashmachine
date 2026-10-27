"use strict";
// Produsul configurat pe comanda agentului: ce trimite formularul, ce arată
// ecranul, și ce se refuză.
//
// Regula codului NU e aici — e în lib/cod-produs.js. Aici e doar stratul
// dintre formular și ea: cum se citesc alegerile dintr-un corp POST, ce
// câmpuri trimitem în browser pentru fiecare familie, și ce scrie sub
// previzualizare. Pur, fără bază de date, ca să poată fi verificat de test.

// Alegerile dintr-un corp POST.
//
// Câmpurile vin ca `c_<id>` fiindcă un formular HTML trimite perechi plate,
// iar id-ul caracteristicii e singurul lucru stabil: numele se schimbă din
// configurare, ordinea la fel.
//
// Ce NU e `c_<ceva numeric>` se ignoră în tăcere: altfel `moneda` sau un
// câmp adăugat mâine ar ajunge interpretat drept caracteristica nr. NaN.
function alegeriDin(corp) {
  const out = {};
  for (const k of Object.keys(corp || {})) {
    if (k.length < 3 || k.slice(0, 2) !== "c_") continue;
    const id = Number(k.slice(2));
    if (!Number.isInteger(id) || id <= 0) continue;
    const v = corp[k];
    if (v === undefined || v === null) continue;
    // Un câmp lăsat gol înseamnă „n-am ales", nu „am ales nimic": dacă l-am
    // trimite mai departe ca string gol, caracteristica ar părea completată
    // și n-ar mai apărea în lista de lipsuri.
    if (String(v).trim() === "") continue;
    out[id] = v;
  }
  return out;
}

// Caracteristicile unei familii, pregătite pentru browser.
//
// Trimitem strict ce desenează formularul. Tabelul `cod_caracteristici` are
// coloane care n-au ce căuta în pagină (creat_la, familie_id), iar lista de
// produse e deja mare — fiecare câmp în plus se înmulțește cu opt familii.
function campuriFamiliei(caracteristici) {
  return (caracteristici || [])
    .filter((c) => Number(c.activ === undefined ? 1 : c.activ))
    .slice()
    .sort((a, b) => Number(a.ordine || 0) - Number(b.ordine || 0) || Number(a.id || 0) - Number(b.id || 0))
    .map((c) => ({
      id: Number(c.id),
      nume: String(c.nume || ""),
      fel: c.fel === "numar" ? "numar" : "lista",
      um: c.um ? String(c.um) : "",
      obligatoriu: Number(c.obligatoriu === undefined ? 1 : c.obligatoriu) ? 1 : 0,
      in_cod: Number(c.in_cod === undefined ? 1 : c.in_cod) ? 1 : 0,
      min: c.min_val == null || c.min_val === "" ? null : Number(c.min_val),
      max: c.max_val == null || c.max_val === "" ? null : Number(c.max_val),
      valori: (c.valori || []).map((v) => String(v.valoare)),
    }));
}

// Familiile cu câmpurile lor, într-un singur obiect pentru pagină.
function familiiPentruPagina(familii, caracteristiciPeFamilie) {
  return (familii || []).map((f) => ({
    id: Number(f.id),
    nume: String(f.nume || ""),
    exemplu: String(f.exemplu || ""),
    campuri: campuriFamiliei(caracteristiciPeFamilie[f.id] || []),
  }));
}

// Ce scrie sub codul previzualizat.
//
// Un singur text, construit dintr-un singur loc, fiindcă același mesaj apare
// și în browser (sub preview) și pe server (când comanda e refuzată). Dacă
// ar fi scris de două ori, ecranul ar putea spune „gata" iar salvarea
// „lipsește grosimea".
function rezumat(r) {
  if (!r) return "";
  const parti = [];
  if (r.lipsa && r.lipsa.length) parti.push("mai lipsește: " + r.lipsa.join(", "));
  if (r.gresite && r.gresite.length) parti.push(r.gresite.join("; "));
  if (r.ambiguu) parti.push("numerele n-au lungime fixă — codul se poate lovi de altul");
  if (r.exista) {
    parti.push(
      "există deja: " + (r.exista.denumire || "") + " (cod " + (r.exista.cod_generat || r.exista.cod || "—") + ")"
    );
  }
  return parti.join(" · ");
}

// Se poate pune pe comandă?
//
// „Există deja" NU e o piedică aici, spre deosebire de ecranul de produs nou:
// agentul vrea tocmai să comande produsul ăla, iar dacă l-a mai comandat
// cineva luna trecută trebuie să cadă pe ACELAȘI produs, nu pe unul nou.
function sePoateComanda(r) {
  if (!r) return false;
  if (r.exista) return true;
  return Boolean(r.ok);
}

// Motivul refuzului, scris pentru agent, nu pentru programator.
//
// Linia goală se tratează separat: un agent care a ales familia și n-a apucat
// să scrie nimic n-are nevoie de lista tuturor celor opt caracteristici care
// lipsesc, ci de drumul înapoi spre catalog.
function motivRefuz(r, numeFamilie, nimicCompletat) {
  const fam = numeFamilie ? `„${numeFamilie}"` : "produsul configurat";
  if (!r || nimicCompletat) {
    return `La ${fam} nu s-a completat nimic. Alege caracteristicile sau caută produsul în catalog.`;
  }
  const d = rezumat({ ...r, exista: null });
  return `La ${fam} nu iese încă un cod de produs — ${d || "mai lipsesc caracteristici"}.`;
}

module.exports = { alegeriDin, campuriFamiliei, familiiPentruPagina, rezumat, sePoateComanda, motivRefuz };
