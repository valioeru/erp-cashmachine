"use strict";
// De unde se acopera o linie de comanda: din stoc, din productie, de la furnizor.
//
// Pana acum pagina comenzii din depozit avea un singur formular pe linie: o
// cantitate si o sursa, pentru tot ce lipsea. In realitate o linie se acopera
// din doua sau trei locuri deodata — 20 sunt pe stoc, 30 se produc, 10 se
// cumpara — iar operatorul trebuia sa aleaga una si sa se descurce.
//
// Stocul nu era nici macar o alegere: se rezerva global, cu butonul de la
// capul comenzii, si nu se vedea nicaieri pe linie cat s-a luat din el.
//
// Aici stau doar regulile. Ce iese se traduce in randuri in doua tabele:
// rezervari_stoc pentru partea din stoc, aprovizionari pentru productie si
// pentru furnizor. Ambele exista deja, cu linie_id pe ele.

const EPS = 0.001;

function nr(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

// Campul gol nu e zero: inseamna „nu iau nimic de aici", si asta conteaza
// cand verificam ca macar o sursa a fost completata.
function cifra(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const x = Number(s);
  return isFinite(x) ? x : null;
}

// linie: { ramas, disponibil, denumire, um }  — asa cum le calculeaza
//        potrivire() in modules/warehouse.js
// scris: { stoc, productie, furnizor, furnizor_id }
function imparte(linie, scris) {
  const ramas = nr(linie && linie.ramas);
  const disponibil = nr(linie && linie.disponibil);
  const s = scris || {};

  const parti = {
    stoc: cifra(s.stoc) || 0,
    productie: cifra(s.productie) || 0,
    furnizor: cifra(s.furnizor) || 0,
  };
  const furnizorId = parseInt(s.furnizor_id, 10) || null;

  for (const [cheie, val] of Object.entries(parti)) {
    if (val < 0) return { eroare: "Cantitatile nu pot fi negative (" + cheie + ")." };
  }

  const total = parti.stoc + parti.productie + parti.furnizor;
  if (total <= EPS) {
    return { eroare: "N-ai scris nicio cantitate. Completeaza din stoc, din productie sau de la furnizor." };
  }

  // Stocul e singura sursa cu plafon real: restul se comanda, stocul exista
  // sau nu. „Disponibil" e deja net de ce au rezervat alte comenzi.
  if (parti.stoc > disponibil + EPS) {
    return {
      eroare:
        "Din stoc ceri " + parti.stoc + " dar disponibil sunt " + disponibil +
        ". Diferenta se ia din productie sau de la furnizor.",
    };
  }

  if (total > ramas + EPS) {
    return {
      eroare:
        "Total " + Math.round(total * 1000) / 1000 + ", dar pe linie mai sunt de acoperit " + ramas +
        ". Nu poti acoperi mai mult decat s-a cerut.",
    };
  }

  // O cantitate de la furnizor fara furnizor ales ajunge o cerere pe care
  // n-o preia nimeni. Invers — furnizor ales fara cantitate — e doar o
  // bifa uitata, si o ignoram.
  if (parti.furnizor > EPS && !furnizorId) {
    return { eroare: "Ai scris o cantitate de la furnizor, dar n-ai ales furnizorul." };
  }

  const actiuni = [];
  if (parti.stoc > EPS) actiuni.push({ fel: "rezervare", cantitate: parti.stoc });
  if (parti.productie > EPS) actiuni.push({ fel: "aprovizionare", sursa: "productie", cantitate: parti.productie, furnizor_id: null });
  if (parti.furnizor > EPS) actiuni.push({ fel: "aprovizionare", sursa: "tert", cantitate: parti.furnizor, furnizor_id: furnizorId });

  return {
    parti,
    total,
    actiuni,
    // Nu e eroare: operatorul poate acoperi in doi pasi, azi ce stie si
    // maine restul. Dar trebuie sa vada ca linia ramane descoperita.
    descoperit: Math.max(0, Math.round((ramas - total) * 1000) / 1000),
  };
}

// Ce propune pagina cand se deschide: tot ce e pe stoc se ia din stoc,
// restul se lasa in casuta de productie. E propunerea cea mai des corecta,
// iar operatorul o schimba daca vrea altfel.
function propune(linie) {
  const ramas = nr(linie && linie.ramas);
  const disponibil = nr(linie && linie.disponibil);
  const dinStoc = Math.min(Math.max(disponibil, 0), ramas);
  return {
    stoc: Math.round(dinStoc * 1000) / 1000,
    productie: Math.round(Math.max(0, ramas - dinStoc) * 1000) / 1000,
    furnizor: 0,
  };
}

module.exports = { EPS, cifra, imparte, propune };
