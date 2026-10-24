"use strict";
// Regulile mutării unui palet. Aritmetică pură, fără bază de date.
//
// CE APĂRĂ. Vali, când a cerut mutarea: „atentie daca ocupa mai multe spatii
// sa aibe loc in partea aia si sa alegi la fel". Asta e miezul: un palet lat
// stă pe locuri LIPITE, în același rând, nivel și câmp. Dacă validarea ar
// lăsa să treacă trei locuri răzlețe, în bază ar apărea un palet întins
// peste două câmpuri — ceva ce fizic nu există, și care s-ar descoperi abia
// la inventar, când cineva se duce la raft și nu găsește marfa.
const mod = require("./lib/ct-mutare");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 240) : "")); esecuri++; }
}
const egal = (d, avut, asteptat) =>
  bine(d + " = " + JSON.stringify(asteptat), JSON.stringify(avut) === JSON.stringify(asteptat), JSON.stringify(avut));

// Un loc, scris scurt. r=rând, n=nivel, c=câmp, p=poziție.
let idul = 0;
const loc = (r, n, c, p, extra) =>
  Object.assign({ id: ++idul, rand_id: r, nivel: n, camp: c, pozitie: p, adresa: `R${r}-${String(c).padStart(2, "0")}-${n}-${p}`, blocat: 0, ocupat_de: null }, extra || {});

const PALET = { id: 7, cod: "P-7", nume: "folie stretch" };

console.log("\n1. Ce înseamnă „lipite\"");
{
  const a = loc(1, 1, 3, 1), b = loc(1, 1, 3, 2), c = loc(1, 1, 3, 3);
  egal("trei poziții consecutive în același câmp fac un grup",
    mod.grupeazaLipite([c, a, b]).map((g) => g.length), [3]);

  // Aceeași poziție, alt câmp: raft diferit, deci grupuri diferite.
  egal("câmpuri diferite nu se lipesc",
    mod.grupeazaLipite([loc(1, 1, 3, 3), loc(1, 1, 4, 1)]).map((g) => g.length), [1, 1]);
  egal("nici niveluri diferite", mod.grupeazaLipite([loc(1, 1, 3, 1), loc(1, 2, 3, 2)]).map((g) => g.length), [1, 1]);
  egal("nici rânduri diferite", mod.grupeazaLipite([loc(1, 1, 3, 1), loc(2, 1, 3, 2)]).map((g) => g.length), [1, 1]);
  // Gaura din mijloc rupe grupul: 1 și 3 nu sunt vecine.
  egal("o poziție sărită rupe grupul",
    mod.grupeazaLipite([loc(1, 1, 3, 1), loc(1, 1, 3, 3)]).map((g) => g.length), [1, 1]);
}

console.log("\n2. Mutarea unui palet de un singur loc");
{
  const acum = [loc(1, 1, 2, 1)];
  const r = mod.validareMutare(PALET, acum, [loc(1, 3, 5, 2)]);
  bine("se mută oriunde e liber", r.ok === true, r.motiv);
  egal("și spune de unde unde", [r.de_la, r.unde], ["R1-02-1-1", "R1-05-3-2"]);

  const blocat = mod.validareMutare(PALET, acum, [loc(1, 3, 5, 2, { blocat: 1 })]);
  bine("dar nu pe un loc scos din uz", blocat.ok === false && /scos din uz/.test(blocat.motiv), blocat.motiv);

  const ocupat = mod.validareMutare(PALET, acum, [loc(1, 3, 5, 2, { ocupat_de: 9 })]);
  bine("și nici peste altă marfă", ocupat.ok === false && /stă deja altă marfă/.test(ocupat.motiv), ocupat.motiv);

  const acolo = mod.validareMutare(PALET, acum, [acum[0]]);
  bine("mutarea în același loc se spune, nu se face", acolo.ok === false && /deja acolo/.test(acolo.motiv), acolo.motiv);
}

console.log("\n3. Paletul lat: „sa aibe loc in partea aia\"");
{
  // Trei locuri ocupate acum, în câmpul 2.
  const acum = [loc(1, 1, 2, 1), loc(1, 1, 2, 2), loc(1, 1, 2, 3)];

  const bun = mod.validareMutare(PALET, acum, [loc(1, 2, 7, 1), loc(1, 2, 7, 2), loc(1, 2, 7, 3)]);
  bine("trei locuri lipite o primesc", bun.ok === true, bun.motiv);
  egal("și se mută întreagă", bun.locuri.length, 3);

  // Prea puține: exact cazul de care s-a temut.
  const putine = mod.validareMutare(PALET, acum, [loc(1, 2, 7, 1), loc(1, 2, 7, 2)]);
  bine("două locuri nu ajung, și spune câte mai trebuie",
    putine.ok === false && /ține 3 locuri/.test(putine.motiv) && /Mai alege 1/.test(putine.motiv), putine.motiv);

  const multe = mod.validareMutare(PALET, acum, [loc(1, 2, 7, 1), loc(1, 2, 7, 2), loc(1, 2, 7, 3), loc(1, 2, 7, 4)]);
  bine("patru sunt prea multe, și spune câte să lase",
    multe.ok === false && /Lasă 1 deoparte/.test(multe.motiv), multe.motiv);

  // Trei locuri, dar rupte între două câmpuri: fizic nu există așa ceva.
  const rupte = mod.validareMutare(PALET, acum, [loc(1, 2, 7, 2), loc(1, 2, 7, 3), loc(1, 2, 8, 1)]);
  bine("trei locuri rupte între două câmpuri nu se acceptă",
    rupte.ok === false && /nu sunt lipite/.test(rupte.motiv), rupte.motiv);
  bine("și mesajul arată cum s-au spart", /\//.test(rupte.motiv), rupte.motiv);

  // Trei locuri în același câmp, dar cu o gaură la mijloc.
  const gaura = mod.validareMutare(PALET, acum, [loc(1, 2, 7, 1), loc(1, 2, 7, 2), loc(1, 2, 7, 4)]);
  bine("nici cu o poziție sărită la mijloc", gaura.ok === false && /nu sunt lipite/.test(gaura.motiv), gaura.motiv);

  // Unul dintre cele trei e ocupat de altcineva.
  const unulOcupat = mod.validareMutare(PALET, acum, [loc(1, 2, 7, 1), loc(1, 2, 7, 2, { ocupat_de: 9 }), loc(1, 2, 7, 3)]);
  bine("un singur loc ocupat oprește toată mutarea", unulOcupat.ok === false && /stă deja altă marfă/.test(unulOcupat.motiv), unulOcupat.motiv);
}

console.log("\n4. Mutarea cu un loc mai încolo, peste propriile locuri");
{
  // Cazul subtil: paletul stă pe 1-2-3 și se mută pe 2-3-4. Locurile 2 și 3
  // sunt „ocupate" — dar de ea însăși. Dacă validarea n-ar ști asta, ar
  // refuza o mutare perfect normală, iar omul ar scoate marfa din depozit
  // ca s-o poată muta cu 80 de centimetri.
  const l1 = loc(1, 1, 2, 1), l2 = loc(1, 1, 2, 2), l3 = loc(1, 1, 2, 3), l4 = loc(1, 1, 2, 4);
  const acum = [l1, l2, l3];
  const tinta = [
    Object.assign({}, l2, { ocupat_de: PALET.id }),
    Object.assign({}, l3, { ocupat_de: PALET.id }),
    l4,
  ];
  const r = mod.validareMutare(PALET, acum, tinta);
  bine("propriile locuri nu-și stau în cale", r.ok === true, r.motiv);
  egal("mutarea iese pe pozițiile 2-3-4", r.locuri.map((x) => x.pozitie), [2, 3, 4]);
}

console.log("\n5. Ce se refuză din start");
{
  const acum = [loc(1, 1, 2, 1)];
  bine("fără palet", mod.validareMutare(null, acum, [loc(1, 1, 3, 1)]).ok === false);
  bine("fără destinație", mod.validareMutare(PALET, acum, []).ok === false);
  const fara = mod.validareMutare(PALET, [], [loc(1, 1, 3, 1)]);
  bine("un palet care nu stă nicăieri", fara.ok === false && /n-are de unde/.test(fara.motiv), fara.motiv);
}

console.log("\n6. Unde încape, ca să putem propune");
{
  // Câmpul 1 are 4 locuri libere lipite, câmpul 2 doar 2.
  const libere = [
    loc(1, 1, 1, 1), loc(1, 1, 1, 2), loc(1, 1, 1, 3), loc(1, 1, 1, 4),
    loc(1, 1, 2, 1), loc(1, 1, 2, 2),
  ];
  egal("pentru un palet de 3 locuri sunt două ferestre în câmpul 1",
    mod.undeIncape(libere, 3).map((g) => g.map((x) => x.pozitie)), [[1, 2, 3], [2, 3, 4]]);
  egal("pentru una de 2 locuri sunt mai multe",
    mod.undeIncape(libere, 2).length, 4);
  egal("pentru una de 5 locuri, niciuna", mod.undeIncape(libere, 5).length, 0);
  egal("și se poate cere doar primele câteva", mod.undeIncape(libere, 2, 2).length, 2);
}

console.log(esecuri ? `\n${esecuri} probleme.\n` : "\nTotul curat.\n");
process.exit(esecuri ? 1 : 0);
