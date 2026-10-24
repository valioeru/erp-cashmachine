"use strict";
// Fulfillment: cine se poate expedia azi din ce avem pe raft, și ce lipsește.
//
// CONTEXTUL. Fulfillment e altă gestiune decât CT-Park, și fizic alt loc.
// Marfa ajunge acolo printr-un transfer din depozit, nu printr-o mutare de
// palet. Comenzile vin din AWB-urile Sameday, importate deja (vezi
// `consumabile_awb` și capcanele din lib/db.js: ultimele trei cifre ale
// AWB-ului sunt numărul coletului, iar eticheta fiecărui colet repetă
// comanda întreagă).
//
// Fișierul ăsta nu atinge baza. Primește comenzile și stocul, întoarce ce se
// poate face. Așa se poate proba pe hârtie, cu cifre scrise de mână, fără să
// montezi un depozit.
//
// ───────────────────────────────────────────────────────────────────────────
// REGULA CARE CONTEAZĂ CEL MAI MULT: ACOPERIREA E TOT-SAU-NIMIC PE COMANDĂ.
//
// O comandă cere trei produse. Două sunt pe raft, al treilea nu. Comanda NU
// pleacă — un colet pe jumătate nu există. Întrebarea adevărată e alta: ce
// facem cu marfa celor două produse care există?
//
// Răspunsul: NU se rezervă. Rămâne liberă pentru comenzile care chiar pot
// pleca azi. Dacă am rezerva-o, o comandă blocată de un singur produs ar
// ține pe loc alte zece care erau gata — iar la sfârșitul zilei n-ar fi
// plecat nimic, deși marfa era acolo. Asta se cheamă înfometare, și se vede
// abia după câteva zile, când se adună teancul de pending.
//
// Costul alegerii: o comandă blocată poate rămâne blocată și mâine, fiindcă
// între timp marfa ei s-a dus pe altele. De-aia ordinea contează, și de-aia
// comenzile vechi se servesc PRIMELE (vezi `ordoneaza`). Cu cât stă mai
// mult, cu atât urcă mai sus, deci nu poate rămâne la coadă la infinit.
// ───────────────────────────────────────────────────────────────────────────

const nr = (v) => {
  const x = Number(v);
  return isFinite(x) ? x : 0;
};

// Vechimea unei comenzi, în zile, față de ziua de lucru.
function zileIntarziere(ziComanda, ziAzi) {
  const a = Date.parse(String(ziComanda || "") + "T00:00:00Z");
  const b = Date.parse(String(ziAzi || "") + "T00:00:00Z");
  if (!isFinite(a) || !isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Ordinea în care se servesc comenzile: cea mai veche prima, iar la aceeași
// zi, în ordinea AWB-ului, ca rezultatul să fie același de fiecare dată.
// Un clasament care se schimbă între două încărcări ale paginii e mai rău
// decât unul imperfect: nimeni nu mai are încredere în el.
function ordoneaza(comenzi) {
  return (comenzi || []).slice().sort((a, b) => {
    const za = String(a.zi || ""), zb = String(b.zi || "");
    if (za !== zb) return za < zb ? -1 : 1;
    return String(a.awb || "") < String(b.awb || "") ? -1 : 1;
  });
}

// Câte bucăți din fiecare produs cere o comandă. Liniile vin de pe AWB și
// pot repeta același produs (două articole care s-au recunoscut la fel);
// se adună, altfel a doua ar trece neverificată.
function nevoiaComenzii(comanda) {
  const h = new Map();
  for (const l of (comanda && comanda.linii) || []) {
    const id = Number(l.produs_id);
    if (!id) continue;
    h.set(id, (h.get(id) || 0) + nr(l.cantitate));
  }
  return h;
}

// Ce se poate expedia azi, din ce e pe raft.
//
//   comenzi — [{ awb, zi, client, linii: [{ produs_id, denumire, cantitate }] }]
//   stoc    — Map produs_id -> cantitate, sau [{ produs_id, cantitate }]
//   azi     — ziua de lucru, pentru calculul întârzierii
//
// Întoarce fiecare comandă cu starea ei și, pentru cele blocate, exact ce
// lipsește și cât. Plus `lipsuri`: totalul de cerut din depozit, pe produs —
// adunat DOAR din comenzile blocate, și socotit după ce cele care pot pleca
// și-au luat marfa. Altfel am cere din depozit marfă pe care o aveam.
function acoperire(comenzi, stoc, azi) {
  const liber = new Map();
  if (stoc instanceof Map) for (const [k, v] of stoc) liber.set(Number(k), nr(v));
  else for (const s of stoc || []) liber.set(Number(s.produs_id), nr(s.cantitate));

  const rezultate = [];
  const lipsuri = new Map();

  for (const c of ordoneaza(comenzi)) {
    const nevoie = nevoiaComenzii(c);
    const lipsa = [];
    for (const [produsId, cat] of nevoie) {
      const am = liber.get(produsId) || 0;
      if (am + 1e-9 < cat) lipsa.push({ produs_id: produsId, cerut: cat, am, lipsa: Math.round((cat - am) * 1e6) / 1e6 });
    }

    const intarziere = zileIntarziere(c.zi, azi || c.zi);
    if (!nevoie.size) {
      // O comandă fără nicio linie recunoscută nu e „acoperită": n-avem ce
      // pregăti. Ar fi trecut verde și ar fi plecat un colet gol.
      rezultate.push({ ...c, stare: "fara_linii", lipsa: [], intarziere });
      continue;
    }

    if (lipsa.length) {
      // Nu scădem nimic: marfa rămâne liberă pentru cine poate pleca azi.
      rezultate.push({ ...c, stare: "lipsa", lipsa, intarziere });
      continue;
    }

    for (const [produsId, cat] of nevoie) liber.set(produsId, (liber.get(produsId) || 0) - cat);
    rezultate.push({ ...c, stare: "acoperita", lipsa: [], intarziere });
  }

  // Lipsurile se adună ABIA ACUM, pe stocul rămas după ce au plecat cele
  // acoperite. Două comenzi blocate pe același produs cer o singură dată
  // diferența totală, nu de două ori.
  const ramas = new Map(liber);
  for (const r of rezultate) {
    if (r.stare !== "lipsa") continue;
    for (const [produsId, cat] of nevoiaComenzii(r)) {
      const am = ramas.get(produsId) || 0;
      const acopera = Math.min(am, cat);
      ramas.set(produsId, am - acopera);
      const inca = cat - acopera;
      if (inca > 1e-9) lipsuri.set(produsId, (lipsuri.get(produsId) || 0) + inca);
    }
  }

  const acoperite = rezultate.filter((r) => r.stare === "acoperita");
  return {
    comenzi: rezultate,
    acoperite,
    blocate: rezultate.filter((r) => r.stare === "lipsa"),
    fara_linii: rezultate.filter((r) => r.stare === "fara_linii"),
    lipsuri: [...lipsuri.entries()]
      .map(([produs_id, cantitate]) => ({ produs_id, cantitate: Math.round(cantitate * 1e6) / 1e6 }))
      .sort((a, b) => b.cantitate - a.cantitate),
    stoc_dupa: liber,
    // „Totul verde" înseamnă: sunt comenzi, și toate pot pleca.
    totul_verde: rezultate.length > 0 && acoperite.length === rezultate.length,
  };
}

// Stocul curent, adunat din mișcări. Nu există o coloană cu cantitatea: o
// cifră care se scrie peste ea însăși nu se poate explica.
function stocDinMiscari(miscari) {
  const h = new Map();
  for (const m of miscari || []) {
    const id = Number(m.produs_id);
    if (!id) continue;
    h.set(id, (h.get(id) || 0) + nr(m.cantitate));
  }
  // Un stoc negativ e o greșeală de operare, nu o cantitate. Se arată ca
  // atare — nu se ascunde la zero, fiindcă ascuns n-ar repara-o nimeni.
  return h;
}

// Poate fi închisă ziua? Se poate închide și cu comenzi rămase — „când nu
// mai e marfă" e o decizie de om — dar atunci trebuie spus de ce, ca mâine
// să se știe ce s-a întâmplat.
function validareInchidere(rezumat, motiv) {
  const pregatite = nr(rezumat && rezumat.pregatite);
  const ramase = nr(rezumat && rezumat.ramase);
  if (!pregatite && !ramase) return { ok: false, motiv: "Nu e nicio comandă pe ziua asta." };
  if (!pregatite) return { ok: false, motiv: "Nu s-a pregătit nicio comandă — n-ai ce trimite la transport." };
  if (ramase && !String(motiv || "").trim())
    return {
      ok: false,
      motiv: `Rămân ${ramase} ${ramase === 1 ? "comandă nepregătită" : "comenzi nepregătite"}. Scrie de ce închizi ziua — trec în pending cu motivul ăsta.`,
    };
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// RETURURI
//
// Coletul se scanează când ajunge pe masă, iar decizia vine după. Între
// cele două momente returul există ca rând, nu ca stoc: dacă scanarea ar
// scrie direct în stocul bun, marfa deteriorată ar fi promisă unei comenzi
// pe care n-o poate onora.
const RETUR_STARI = ["de_decis", "in_stoc", "deteriorat"];

// Poate fi închis returul ăsta așa cum vrea operatorul?
//
// Poza la „deteriorat" nu e birocrație: marfa scoasă din gestiune fără nicio
// dovadă e exact rândul pe care îl caută un control, iar singurul moment în
// care poza se poate face e cât coletul e încă pe masă. Peste o oră e la
// gunoi și nu se mai poate dovedi nimic.
function validareRetur(decizie, date) {
  const d = String((decizie && decizie.stare) || "");
  if (!RETUR_STARI.includes(d) || d === "de_decis")
    return { ok: false, motiv: "Alege ce faci cu marfa: o pui înapoi în stoc, sau o scoți ca deteriorată." };

  const cantitate = nr(decizie.cantitate);
  if (!(cantitate > 0)) return { ok: false, motiv: "Scrie ce cantitate s-a întors." };
  if (!Number(decizie.produs_id)) return { ok: false, motiv: "Spune ce produs e — fără el nu se poate pune nicăieri." };

  if (d === "deteriorat") {
    if (!String(decizie.poza || "").trim())
      return { ok: false, motiv: "Marfa deteriorată iese din gestiune doar cu o poză. Fă-o cât coletul e pe masă." };
    if (!String(decizie.motiv || "").trim())
      return { ok: false, motiv: "Scrie pe scurt ce are: strivit, udat, lipsă din colet. Poza arată, motivul explică." };
  }

  // Cantitatea care se întoarce în stoc e pozitivă; cea deteriorată NU intră
  // în stoc deloc — nu intră ca minus, pur și simplu nu intră. Un minus ar
  // scădea din marfa bună, care n-are nicio vină.
  return {
    ok: true,
    miscare: d === "in_stoc" ? { produs_id: Number(decizie.produs_id), cantitate, fel: "retur" } : null,
    stare: d,
  };
}

module.exports = {
  acoperire,
  stocDinMiscari,
  ordoneaza,
  nevoiaComenzii,
  zileIntarziere,
  validareInchidere,
  validareRetur,
  RETUR_STARI,
};
