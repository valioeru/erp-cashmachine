"use strict";
// Harta depozitului: rânduri, etaje, locuri — și ce stă pe ele.
//
// Codul unui loc arată așa: A-03-2-1 = zona A, rândul 3, etajul 2, locul 1
// pe etaj. Ultima bucată lipsește la depozitele unde pe un etaj încape un
// singur palet; atunci codul e A-03-2 și poziția se consideră 1.
//
// CE APĂRĂ fișierul ăsta:
//
//   • UN PALET LAT OCUPĂ MAI MULTE LOCURI, și toate trebuie să fie pe
//     ACELAȘI etaj și lipite. Două locuri alese la întâmplare, unul jos în
//     rândul 1 și unul sus în rândul 7, nu sunt „un palet pe două locuri" —
//     sunt două greșeli de click. Dacă trec, harta minte de-atunci încolo.
//
//   • NU SE PUNE MARFĂ PESTE MARFĂ. Un loc ocupat nu se oferă ca liber.
//     Asta se descoperă altfel abia cu motostivuitorul în față.
//
//   • UN LOC BLOCAT E BLOCAT. Dacă cineva l-a marcat (stricat, rezervat,
//     inaccesibil), nu se alege din hartă.
//
// Regulile stau aici, cu teste; desenul hărții și paginile stau în
// modules/receptie.js.

const EPS = 0.001;

function nr(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

// Sparge un cod de loc în bucățile lui. Întoarce null dacă nu se poate citi
// — un cod scris de mână, de forma „lângă ușă", e valid ca loc dar nu apare
// pe hartă, și asta e în regulă.
function bucati(cod) {
  const m = String(cod || "").trim().toUpperCase().match(/^([A-Z]+)-(\d+)-(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return { zona: m[1], rand: Number(m[2]), nivel: Number(m[3]), pozitie: m[4] ? Number(m[4]) : 1 };
}

function codDin(zona, rand, nivel, pozitie) {
  const z = String(zona || "A").trim().toUpperCase();
  const r = String(Math.max(1, Math.round(nr(rand)))).padStart(2, "0");
  const n = Math.max(1, Math.round(nr(nivel)));
  const p = Math.max(1, Math.round(nr(pozitie)));
  return p > 1 || nr(pozitie) ? `${z}-${r}-${n}-${p}` : `${z}-${r}-${n}`;
}

// Locurile, aranjate pentru desen: zonă → rând → etaj → locuri, fiecare cu
// ce stă pe el. Etajele se întorc de sus în jos, fiindcă așa arată un raft
// când stai în fața lui.
function aranjeaza(locuri, stoc) {
  const peLoc = new Map();
  for (const s of stoc || []) {
    const k = Number(s.loc_id);
    if (!peLoc.has(k)) peLoc.set(k, []);
    peLoc.get(k).push(s);
  }

  const zone = new Map();
  const fara = [];
  for (const l of locuri || []) {
    const b = bucati(l.cod) || {
      zona: l.zona || null,
      rand: l.rand_nr != null ? Number(l.rand_nr) : null,
      nivel: l.nivel_nr != null ? Number(l.nivel_nr) : null,
      pozitie: l.pozitie_nr != null ? Number(l.pozitie_nr) : 1,
    };
    const continut = peLoc.get(Number(l.id)) || [];
    const cantitate = Math.round(continut.reduce((s, x) => s + nr(x.cantitate), 0) * 1000) / 1000;
    const celula = {
      id: Number(l.id),
      cod: l.cod,
      categorie: l.categorie || null,
      blocat: !!Number(l.blocat),
      continut,
      cantitate,
      ocupat: cantitate > EPS,
      // „Liber" nu înseamnă doar gol: un loc blocat e gol și tot nu se poate
      // folosi. Cine alege din hartă are nevoie de un singur cuvânt.
      liber: cantitate <= EPS && !Number(l.blocat),
      zona: b.zona, rand: b.rand, nivel: b.nivel, pozitie: b.pozitie,
    };
    if (b.zona == null || b.rand == null || b.nivel == null) { fara.push(celula); continue; }
    if (!zone.has(b.zona)) zone.set(b.zona, new Map());
    const randuri = zone.get(b.zona);
    if (!randuri.has(b.rand)) randuri.set(b.rand, new Map());
    const niveluri = randuri.get(b.rand);
    if (!niveluri.has(b.nivel)) niveluri.set(b.nivel, []);
    niveluri.get(b.nivel).push(celula);
  }

  const iesire = [];
  for (const [zona, randuri] of [...zone.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const r = [];
    for (const [rand, niveluri] of [...randuri.entries()].sort((a, b) => a[0] - b[0])) {
      const n = [];
      // De sus in jos: asa arata raftul cand stai in fata lui.
      for (const [nivel, celule] of [...niveluri.entries()].sort((a, b) => b[0] - a[0])) {
        n.push({ nivel, celule: celule.sort((a, b) => a.pozitie - b.pozitie) });
      }
      r.push({ rand, niveluri: n });
    }
    iesire.push({ zona, randuri: r });
  }
  return { zone: iesire, fara };
}

// Se poate pune un palet pe locurile astea?
//
// locuri: lista de celule (din aranjeaza) sau de randuri brute cu cod.
function validareSelectie(alese, optiuni) {
  const o = optiuni || {};
  const l = (alese || []).filter(Boolean);
  if (!l.length) return { eroare: "N-ai ales niciun loc." };

  const blocate = l.filter((x) => x.blocat);
  if (blocate.length) {
    return { eroare: "Locul " + blocate[0].cod + " e blocat. Alege altul." };
  }
  // Nu se pune marfa peste marfa. Se descopera altfel abia cu
  // motostivuitorul in fata raftului.
  if (!o.permiteOcupate) {
    const ocupate = l.filter((x) => x.ocupat);
    if (ocupate.length) {
      return {
        eroare:
          ocupate.length === 1
            ? "Pe " + ocupate[0].cod + " e deja marfă. Alege un loc liber sau scoate întâi ce e acolo."
            : "Pe " + ocupate.length + " dintre locurile alese e deja marfă (" + ocupate.map((x) => x.cod).join(", ") + ").",
      };
    }
  }

  if (l.length === 1) return { locuri: l, coduri: l.map((x) => x.cod) };

  // Un palet pe mai multe locuri: trebuie sa fie acelasi rand, acelasi etaj,
  // si locuri LIPITE. Altfel nu e un palet lat, sunt doua clickuri gresite —
  // iar harta minte de-atunci incolo.
  const b = l.map((x) => (x.zona != null && x.rand != null ? x : Object.assign({}, x, bucati(x.cod) || {})));
  const z = b[0].zona, r = b[0].rand, n = b[0].nivel;
  if (b.some((x) => x.zona !== z || x.rand !== r)) {
    return { eroare: "Locurile alese nu sunt pe același rând. Un palet stă pe un singur rând." };
  }
  if (b.some((x) => x.nivel !== n)) {
    return { eroare: "Locurile alese nu sunt pe același etaj. Un palet nu stă pe două etaje." };
  }
  const pozitii = b.map((x) => Number(x.pozitie) || 1).sort((a, c) => a - c);
  for (let i = 1; i < pozitii.length; i++) {
    if (pozitii[i] !== pozitii[i - 1] + 1) {
      return { eroare: "Locurile alese nu sunt lipite (" + pozitii.join(", ") + "). Un palet ocupă locuri vecine." };
    }
  }
  return { locuri: l, coduri: l.map((x) => x.cod) };
}

// Numaratoarea de pe capul hartii.
function rezumat(locuri) {
  const l = locuri || [];
  const blocate = l.filter((x) => x.blocat).length;
  const ocupate = l.filter((x) => x.ocupat && !x.blocat).length;
  const libere = l.filter((x) => x.liber).length;
  return {
    total: l.length,
    libere,
    ocupate,
    blocate,
    procentOcupat: l.length - blocate > 0 ? Math.round((ocupate / (l.length - blocate)) * 100) : 0,
  };
}

module.exports = { EPS, bucati, codDin, aranjeaza, validareSelectie, rezumat };
