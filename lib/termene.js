"use strict";
// Termenul cerut si termenul raspuns, pe orice cerere interna.
//
// Trei fluxuri au aceeasi forma: depozitul cere productiei, depozitul cere
// unui furnizor, productia cere materie prima depozitului. De fiecare data
// cineva CERE un termen si cineva RASPUNDE cu unul — il confirma sau da
// altul. Pana acum:
//
//   • termenul cerut putea fi gol. In depozit se lua din comanda
//     (data_livrare_ceruta), iar daca aceasta era necompletata, cererea
//     pleca fara niciun termen. O cerere fara termen nu e o cerere, e o
//     speranta: nu se poate intarzia, deci nu se poate urmari.
//
//   • productia scria termen_confirmat, dar nimeni nu era anuntat cand
//     acesta era ALTUL decat cel cerut. Diferenta se vedea doar daca te
//     uitai la doua coloane alaturate si le comparai cu ochiul.
//
//   • pe fluxul spre furnizor nu exista deloc pas de confirmare: doar
//     „primita" si „anulata". Deci termen_confirmat ramanea gol la toate
//     cererile catre terti, iar ce a promis furnizorul nu se scria nicaieri.
//
// Aici stau regulile comune. Partea care conteaza cel mai mult nu e
// compararea celor doua termene interne, ci `fataDeClient`: un termen
// confirmat dupa data promisa clientului inseamna ca cineva trebuie sa sune
// clientul, si asta trebuie sa tipe, nu sa stea intr-o coloana.

const ZI = 86400000;

function esteData(s) {
  const t = String(s == null ? "" : s).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(t + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}

function zile(de_la, pana_la) {
  const a = new Date(String(de_la).slice(0, 10) + "T00:00:00Z").getTime();
  const b = new Date(String(pana_la).slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((b - a) / ZI);
}

// Termenul cerut e obligatoriu. Nu „se completeaza daca stim" — fara el
// cererea nu se poate urmari, iar cel care o primeste n-are ce confirma.
function validareTermenCerut(termen, optiuni) {
  const o = optiuni || {};
  const t = String(termen == null ? "" : termen).trim().slice(0, 10);
  if (!t) {
    return { eroare: "Scrie termenul cerut. Fără el, cererea nu poate fi urmărită și nimeni n-are ce confirma." };
  }
  if (!esteData(t)) return { eroare: "Termenul cerut nu e o dată validă (se scrie ca 2026-11-25)." };
  if (o.azi && esteData(o.azi) && zile(o.azi, t) < 0) {
    return { eroare: "Termenul cerut e în trecut (" + t + "). Scrie o dată de azi înainte." };
  }
  return { termen: t };
}

// Ce a raspuns cel care executa, fata de ce i s-a cerut.
function compara(cerut, confirmat) {
  const c = String(cerut || "").slice(0, 10);
  const r = String(confirmat || "").slice(0, 10);
  if (!esteData(c)) return { fel: "fara_cerut", zile: 0, eticheta: "fără termen cerut", culoare: "rosu" };
  if (!esteData(r)) return { fel: "fara_raspuns", zile: 0, eticheta: "așteaptă răspuns", culoare: "galben" };
  const d = zile(c, r);
  if (d === 0) return { fel: "confirmat", zile: 0, eticheta: "termen confirmat", culoare: "verde" };
  if (d > 0) return { fel: "amanat", zile: d, eticheta: "amânat cu " + d + (d === 1 ? " zi" : " zile"), culoare: "rosu" };
  return { fel: "devansat", zile: -d, eticheta: "mai devreme cu " + -d + (-d === 1 ? " zi" : " zile"), culoare: "verde" };
}

// Verificarea care conteaza cu adevarat: termenul raspuns, fata de ce i s-a
// promis CLIENTULUI. Doua termene interne care se bat cap in cap sunt o
// problema de planificare; un termen intern dupa data promisa clientului e
// un telefon pe care trebuie sa-l dea cineva azi.
function fataDeClient(confirmat, dataLivrareClient) {
  const r = String(confirmat || "").slice(0, 10);
  const client = String(dataLivrareClient || "").slice(0, 10);
  if (!esteData(client)) return { fel: "fara_data_client", intarziere: 0, eticheta: "comanda n-are dată de livrare", culoare: "galben" };
  if (!esteData(r)) return { fel: "fara_raspuns", intarziere: 0, eticheta: "așteaptă răspuns", culoare: "galben" };
  const d = zile(client, r);
  if (d <= 0) return { fel: "in_termen", intarziere: 0, eticheta: "intră în termenul clientului", culoare: "verde" };
  return {
    fel: "depaseste_clientul",
    intarziere: d,
    eticheta: "DEPĂȘEȘTE termenul clientului cu " + d + (d === 1 ? " zi" : " zile") + " — sună clientul",
    culoare: "rosu",
  };
}

// Raspunsul celui care executa: ori confirma ce i s-a cerut, ori da altul.
// Nu exista „am citit". Daca da alt termen, motivul e obligatoriu — altfel
// peste doua saptamani nimeni nu mai stie de ce s-a mutat.
function validareRaspuns(brut, cerut) {
  const b = brut || {};
  const t = String(b.termen == null ? "" : b.termen).trim().slice(0, 10);
  if (!t) return { eroare: "Alege un termen: confirmă-l pe cel cerut sau scrie altul." };
  if (!esteData(t)) return { eroare: "Termenul nu e o dată validă (se scrie ca 2026-11-25)." };
  const cmp = compara(cerut, t);
  const motiv = String(b.motiv == null ? "" : b.motiv).trim();
  if (cmp.fel === "amanat" && !motiv) {
    return { eroare: "Ai dat un termen mai târziu decât cel cerut. Scrie motivul — altfel nimeni nu mai știe peste două săptămâni de ce s-a mutat." };
  }
  return { termen: t, motiv: motiv || null, comparatie: cmp };
}

module.exports = { esteData, zile, validareTermenCerut, compara, fataDeClient, validareRaspuns };
