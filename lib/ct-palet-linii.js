"use strict";
// Paletul cu mai multe produse, si iesirea partiala din el.
//
// Pana acum un palet avea un singur produs: `ct_paleti` tinea produs_id,
// cantitate, um si lot la singular, iar iesirea era totul-sau-nimic — se
// punea data_iesire si se eliberau locurile. Depozitul lucreaza altfel: pe un
// palet stau mai multe produse, iar la o comanda pleaca o parte din ele.
//
// De-aia liniile stau acum intr-un tabel separat, iar coloanele vechi de pe
// ct_paleti raman ca REZUMAT al liniilor. Nu sunt sursa adevarului, dar tin
// in viata harta, eticheta si fisa paletului fara sa le rescriu pe toate in
// aceeasi zi. `rezumat()` de mai jos e singurul loc care le recalculeaza.
//
// Regula de numarare a fost aleasa de depozit: la iesirea partiala se scriu
// AMANDOUA cifrele — cat pleaca si cat ramane — iar suma lor trebuie sa dea
// cantitatea de pe linie. Nu e birocratie: cel care scoate marfa numara
// oricum ce ramane pe palet, iar daca cele doua cifre nu se inchid inseamna
// ca stocul din sistem nu mai e stocul din hala, si atunci nu vrem sa plece
// marfa si sa aflam peste o luna.

// Cantitatile din depozit sunt kilograme si bucati, nu bani. O toleranta
// absoluta mica e suficienta si evita ca 0.1 + 0.2 sa refuze o iesire buna.
const EPS = 0.001;

function nr(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

// Numarul scris de om: "12,5" si "12.5" sunt acelasi lucru, iar campul gol
// nu e zero — e „n-a scris nimic", si conteaza la validare.
function cifra(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const x = Number(s);
  return isFinite(x) ? x : null;
}

function egale(a, b) {
  return Math.abs(nr(a) - nr(b)) <= EPS;
}

// ---------------------------------------------------------------- iesirea

// Ce a scris omul pe o linie, verificat fata de ce zice baza ca e pe palet.
//
// O linie intra in iesire doar daca s-a scris o cantitate care pleaca. Un
// palet mixt are de obicei produse care nu fac parte din comanda asta —
// pentru ele nu se completeaza nimic si raman neatinse.
function validareLinie(linie, scris) {
  const peLinie = nr(linie && linie.cantitate);
  const pleaca = cifra(scris && scris.pleaca);
  const ramane = cifra(scris && scris.ramane);

  if (pleaca === null && ramane === null) return { sarita: true };
  if (pleaca === null) {
    return { eroare: "Scrie si cat pleaca, nu doar cat ramane." };
  }
  if (pleaca < 0 || (ramane !== null && ramane < 0)) {
    return { eroare: "Cantitatile nu pot fi negative." };
  }
  if (pleaca === 0 && (ramane === null || egale(ramane, peLinie))) {
    return { sarita: true };
  }
  if (ramane === null) {
    return { eroare: "Scrie si cat ramane pe palet. Se verifica cu ce zice sistemul." };
  }
  if (pleaca > peLinie + EPS) {
    return {
      eroare:
        "Pleaca " + pleaca + " dar pe palet sunt " + peLinie + ". Nu poti scoate mai mult decat exista.",
    };
  }
  if (!egale(pleaca + ramane, peLinie)) {
    const diferenta = Math.round((pleaca + ramane - peLinie) * 1000) / 1000;
    return {
      eroare:
        "Nu se inchide: " + pleaca + " plecate + " + ramane + " ramase = " + (pleaca + ramane) +
        ", dar sistemul are " + peLinie + " pe linie. Diferenta " + (diferenta > 0 ? "+" : "") + diferenta +
        ". Daca ai numarat bine, stocul din sistem e gresit si se corecteaza intai pe fisa paletului.",
    };
  }
  return { pleaca, ramane };
}

// Toata iesirea dintr-un palet. Intoarce fie { eroare }, fie liniile de scris
// si ce se intampla cu paletul dupa.
function validareIesire(liniiPalet, scrise) {
  const linii = Array.isArray(liniiPalet) ? liniiPalet : [];
  const dupa = [];
  const miscate = [];

  for (const linie of linii) {
    const scris = (scrise || {})[String(linie.id)];
    const v = validareLinie(linie, scris);
    if (v.eroare) return { eroare: "Linia „" + (linie.produs_text || linie.produs || "produs") + "”: " + v.eroare };
    if (v.sarita) {
      dupa.push(Object.assign({}, linie));
      continue;
    }
    miscate.push({
      linie_id: linie.id,
      produs_id: linie.produs_id || null,
      produs_text: linie.produs_text || linie.produs || null,
      um: linie.um || null,
      pret_unitar: nr(linie.pret_unitar) || null,
      pleaca: v.pleaca,
      ramane: v.ramane,
    });
    dupa.push(Object.assign({}, linie, { cantitate: v.ramane }));
  }

  if (!miscate.length) {
    return { eroare: "N-ai scris nicio cantitate care pleaca. Bifeaza paletul intreg sau scrie cantitatile." };
  }

  return {
    miscate,
    dupa,
    // Paletul pleaca din depozit doar cand nu mai ramane nimic pe el. Altfel
    // sta pe loc, cu cantitatile scazute — locurile NU se elibereaza.
    paletGol: dupa.every((l) => nr(l.cantitate) <= EPS),
    cost: miscate.reduce((s, m) => s + m.pleaca * nr(m.pret_unitar), 0),
  };
}

// ---------------------------------------------------------------- rezumatul

// Coloanele vechi de pe ct_paleti, recalculate din linii. Un singur produs pe
// palet se comporta exact ca inainte. Mai multe produse: denumirea devine un
// rezumat, iar cantitatea se aduna doar daca unitatile sunt aceleasi —
// altfel „3 produse" fara cifra e mai onest decat sa adun kilograme cu bucati.
function rezumat(linii) {
  const l = (Array.isArray(linii) ? linii : []).filter((x) => nr(x.cantitate) > EPS);
  if (!l.length) return { produs_id: null, produs_text: null, cantitate: 0, um: null, lot: null, pret_unitar: null };
  if (l.length === 1) {
    return {
      produs_id: l[0].produs_id || null,
      produs_text: l[0].produs_text || null,
      cantitate: nr(l[0].cantitate),
      um: l[0].um || null,
      lot: l[0].lot || null,
      pret_unitar: nr(l[0].pret_unitar) || null,
    };
  }
  const umuri = [...new Set(l.map((x) => String(x.um || "").trim().toLowerCase()).filter(Boolean))];
  const valoare = l.reduce((s, x) => s + nr(x.cantitate) * nr(x.pret_unitar), 0);
  const cantitate = umuri.length === 1 ? l.reduce((s, x) => s + nr(x.cantitate), 0) : 0;
  return {
    produs_id: null,
    produs_text: l.length + " produse: " + l.map((x) => x.produs_text || "?").join(", "),
    cantitate,
    um: umuri.length === 1 ? l[0].um : null,
    lot: null,
    // Pretul unitar al unui palet mixt n-are sens. Valoarea paletului o
    // calculeaza oricine din linii; aici las null ca sa nu minta nimeni.
    pret_unitar: cantitate > EPS ? valoare / cantitate : null,
  };
}

// ---------------------------------------------------------------- intrarea

// Formularul de intrare e o lista de linii: produs, cate palete, cat pe
// fiecare. Implicit fiecare linie isi face paletii ei. Bifa „pe acelasi
// palet" lipeste linia de grupul de deasupra — asa intra un palet mixt de la
// furnizor, fara sa cer depozitarului sa inteleaga un camp de grupare.
function grupeazaIntrare(linii) {
  const grupuri = [];
  for (const brut of Array.isArray(linii) ? linii : []) {
    const cantitate = cifra(brut.cantitate_per_palet);
    const denumire = String(brut.produs_text || "").trim();
    if (!nr(brut.produs_id) && !denumire) continue;
    if (cantitate === null || cantitate <= 0) {
      return { eroare: "Linia „" + (denumire || "produs") + "” n-are cantitate pe palet." };
    }
    const linie = {
      produs_id: nr(brut.produs_id) || null,
      produs_text: denumire || null,
      cantitate,
      um: String(brut.um || "").trim() || null,
      lot: String(brut.lot || "").trim() || null,
      pret_unitar: cifra(brut.pret_unitar),
    };
    const lipit = String(brut.acelasi_palet || "") === "1" && grupuri.length;
    if (lipit) {
      grupuri[grupuri.length - 1].linii.push(linie);
      continue;
    }
    const cate = Math.floor(nr(brut.nr_paleti));
    if (cate < 1) {
      return { eroare: "Linia „" + (denumire || "produs") + "” n-are numarul de paleti." };
    }
    if (cate > 500) {
      return { eroare: "500 de paleti dintr-o intrare e, cel mai probabil, o greseala de tastare." };
    }
    grupuri.push({ nr_paleti: cate, linii: [linie] });
  }
  if (!grupuri.length) return { eroare: "N-ai adaugat niciun produs." };
  return { grupuri, total: grupuri.reduce((s, g) => s + g.nr_paleti, 0) };
}

module.exports = { EPS, cifra, validareLinie, validareIesire, rezumat, grupeazaIntrare };
