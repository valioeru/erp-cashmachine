"use strict";
// Acoperirea comenzilor din stocul de fulfillment. Aritmetică pură.
//
// CE APĂRĂ, și de ce merită un test înainte de orice pagină:
//
//   • O COMANDĂ NU PLEACĂ PE JUMĂTATE. Dacă un singur produs lipsește,
//     comanda e blocată — un colet incomplet nu există.
//
//   • MARFA UNEI COMENZI BLOCATE NU SE REZERVĂ. Dacă s-ar rezerva, o
//     comandă oprită de un singur produs ar ține pe loc alte zece care erau
//     gata, iar la sfârșitul zilei n-ar pleca nimic deși marfa era acolo.
//     Asta nu dă eroare: dă o zi proastă, și se vede abia după o săptămână.
//
//   • COMENZILE VECHI SE SERVESC PRIMELE. Altfel una ghinionistă rămâne la
//     coadă la infinit, iar „pending" devine un cimitir.
//
//   • CE SE CERE DIN DEPOZIT E DIFERENȚA, NU TOT. Două comenzi blocate pe
//     același produs cer o singură dată cât lipsește, socotit pe ce rămâne
//     după ce au plecat cele acoperite. Altfel am cere marfă pe care o avem,
//     iar depozitul ar goli raftul degeaba.
const F = require("./lib/fulfillment");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 260) : "")); esecuri++; }
}
const egal = (d, avut, asteptat) =>
  bine(d + " = " + JSON.stringify(asteptat), JSON.stringify(avut) === JSON.stringify(asteptat), JSON.stringify(avut));

// O comandă scrisă scurt: awb, ziua, și perechi produs→cantitate.
const cmd = (awb, zi, perechi) => ({
  awb, zi, client: "client " + awb,
  linii: Object.entries(perechi).map(([p, c]) => ({ produs_id: Number(p), cantitate: c })),
});

console.log("\n1. Totul verde");
{
  const r = F.acoperire([cmd("A", "2026-10-20", { 1: 2, 2: 1 }), cmd("B", "2026-10-20", { 1: 3 })],
                        new Map([[1, 10], [2, 5]]), "2026-10-20");
  bine("amândouă pleacă", r.totul_verde === true, JSON.stringify(r.comenzi.map((c) => c.stare)));
  egal("nu se cere nimic din depozit", r.lipsuri, []);
  egal("stocul scade cu ce a plecat", [r.stoc_dupa.get(1), r.stoc_dupa.get(2)], [5, 4]);
}

console.log("\n2. Un produs lipsă oprește toată comanda");
{
  const r = F.acoperire([cmd("A", "2026-10-20", { 1: 2, 2: 1 })], new Map([[1, 10], [2, 0]]), "2026-10-20");
  egal("comanda e blocată", r.comenzi[0].stare, "lipsa");
  egal("și se spune exact ce lipsește", r.comenzi[0].lipsa, [{ produs_id: 2, cerut: 1, am: 0, lipsa: 1 }]);
  bine("nu e totul verde", r.totul_verde === false);
  // Produsul 1 era pe raft si NU s-a consumat: comanda n-a plecat.
  egal("marfa produsului care exista a rămas liberă", r.stoc_dupa.get(1), 10);
}

console.log("\n3. Marfa unei comenzi blocate nu se rezervă");
{
  // A e blocată de produsul 2. B cere numai produsul 1, din care avem
  // destul. B TREBUIE să plece — altfel o comandă blocată înfometează una
  // perfect bună.
  const r = F.acoperire(
    [cmd("A", "2026-10-20", { 1: 8, 2: 1 }), cmd("B", "2026-10-20", { 1: 8 })],
    new Map([[1, 10], [2, 0]]),
    "2026-10-20"
  );
  egal("A stă, B pleacă", r.comenzi.map((c) => [c.awb, c.stare]), [["A", "lipsa"], ["B", "acoperita"]]);
  egal("stocul s-a dus pe B", r.stoc_dupa.get(1), 2);
  // Iar acum A are nevoie si de produsul 1: din 8 cerute mai sunt 2.
  egal("ce se cere din depozit ține cont de ce a mai rămas",
    r.lipsuri, [{ produs_id: 1, cantitate: 6 }, { produs_id: 2, cantitate: 1 }]);
}

console.log("\n4. Comenzile vechi se servesc primele");
{
  // Stoc pentru una singură. Cea de ieri trebuie s-o ia.
  const r = F.acoperire(
    [cmd("NOUA", "2026-10-21", { 1: 5 }), cmd("VECHE", "2026-10-19", { 1: 5 })],
    new Map([[1, 5]]),
    "2026-10-21"
  );
  const dupaAwb = Object.fromEntries(r.comenzi.map((c) => [c.awb, c.stare]));
  egal("cea veche pleacă, cea nouă așteaptă", [dupaAwb.VECHE, dupaAwb.NOUA], ["acoperita", "lipsa"]);
  egal("și i se numără zilele de întârziere",
    r.comenzi.find((c) => c.awb === "VECHE").intarziere, 2);
  egal("cea de azi n-are întârziere", r.comenzi.find((c) => c.awb === "NOUA").intarziere, 0);
}

console.log("\n5. Ordinea nu se schimbă între două rulări");
{
  // Două comenzi din aceeași zi: le desparte AWB-ul, nu ordinea din listă.
  const a = F.acoperire([cmd("Z", "2026-10-20", { 1: 5 }), cmd("A", "2026-10-20", { 1: 5 })], new Map([[1, 5]]), "2026-10-20");
  const b = F.acoperire([cmd("A", "2026-10-20", { 1: 5 }), cmd("Z", "2026-10-20", { 1: 5 })], new Map([[1, 5]]), "2026-10-20");
  egal("aceeași comandă câștigă, indiferent cum vin în listă",
    [a.acoperite[0].awb, b.acoperite[0].awb], ["A", "A"]);
}

console.log("\n6. Cazuri care ar trece neobservate");
{
  // Acelasi produs pe doua linii ale aceleiasi comenzi: se aduna, altfel a
  // doua trece neverificata si comanda pleaca fara marfa.
  const dubla = { awb: "D", zi: "2026-10-20", linii: [
    { produs_id: 1, cantitate: 3 }, { produs_id: 1, cantitate: 3 } ] };
  const r = F.acoperire([dubla], new Map([[1, 5]]), "2026-10-20");
  egal("două linii cu același produs se adună, nu se iau separat", r.comenzi[0].stare, "lipsa");
  egal("și lipsa e 1, nu 0", r.comenzi[0].lipsa[0].lipsa, 1);

  // O comanda fara nicio linie recunoscuta nu e „acoperita": n-avem ce
  // pregati. Ar fi trecut verde si ar fi plecat un colet gol.
  const goala = F.acoperire([{ awb: "G", zi: "2026-10-20", linii: [] }], new Map([[1, 100]]), "2026-10-20");
  egal("o comandă fără linii nu trece drept acoperită", goala.comenzi[0].stare, "fara_linii");
  bine("și nu face ziua verde", goala.totul_verde === false);

  // Exact cat trebuie: nu lipseste nimic.
  const fix = F.acoperire([cmd("F", "2026-10-20", { 1: 5 })], new Map([[1, 5]]), "2026-10-20");
  egal("cantitatea exactă ajunge", fix.comenzi[0].stare, "acoperita");
  egal("și stocul rămâne zero, nu negativ", fix.stoc_dupa.get(1), 0);

  // Un produs care nu exista deloc in fulfillment.
  const strain = F.acoperire([cmd("S", "2026-10-20", { 99: 1 })], new Map([[1, 5]]), "2026-10-20");
  egal("un produs care n-a ajuns niciodată acolo lipsește cu totul",
    strain.comenzi[0].lipsa, [{ produs_id: 99, cerut: 1, am: 0, lipsa: 1 }]);

  // Nicio comanda: nu e „totul verde", e „nimic de facut".
  const nimic = F.acoperire([], new Map([[1, 5]]), "2026-10-20");
  bine("o zi fără comenzi nu e «totul verde»", nimic.totul_verde === false);
}

console.log("\n7. Stocul se adună din mișcări");
{
  const s = F.stocDinMiscari([
    { produs_id: 1, cantitate: 100 },
    { produs_id: 1, cantitate: -30 },
    { produs_id: 2, cantitate: 5 },
    { produs_id: 1, cantitate: 10 },
  ]);
  egal("intrările și consumurile se adună", [s.get(1), s.get(2)], [80, 5]);
  // Un stoc negativ e o greseala de operare, nu o cantitate — dar se arata
  // ca atare, nu se ascunde la zero: ascuns, n-ar repara-o nimeni.
  const neg = F.stocDinMiscari([{ produs_id: 1, cantitate: 2 }, { produs_id: 1, cantitate: -5 }]);
  egal("un stoc negativ se vede, nu se ascunde la zero", neg.get(1), -3);
}

console.log("\n8. Închiderea zilei");
{
  egal("o zi goală nu se închide", F.validareInchidere({ pregatite: 0, ramase: 0 }).ok, false);
  egal("nici una în care nu s-a pregătit nimic", F.validareInchidere({ pregatite: 0, ramase: 4 }).ok, false);
  egal("una terminată se închide fără explicații", F.validareInchidere({ pregatite: 7, ramase: 0 }).ok, true);
  const cuRamase = F.validareInchidere({ pregatite: 7, ramase: 3 });
  bine("cu comenzi rămase cere un motiv", cuRamase.ok === false && /Scrie de ce/.test(cuRamase.motiv), cuRamase.motiv);
  bine("și îl acceptă dacă e scris",
    F.validareInchidere({ pregatite: 7, ramase: 3 }, "s-a terminat hârtia A4").ok === true);
}

console.log("\n9. Retururi");
{
  const bun = { stare: "in_stoc", produs_id: 1, cantitate: 3 };
  const r = F.validareRetur(bun);
  bine("marfa bună se pune înapoi în stoc", r.ok === true, r.motiv);
  egal("și intră ca mișcare pozitivă, de fel «retur»",
    [r.miscare.cantitate, r.miscare.fel], [3, "retur"]);

  // Nedecis nu e o decizie.
  bine("«de_decis» nu închide nimic", F.validareRetur({ stare: "de_decis", produs_id: 1, cantitate: 3 }).ok === false);
  bine("nici o stare inventată", F.validareRetur({ stare: "aruncat", produs_id: 1, cantitate: 3 }).ok === false);
  bine("fără produs nu se poate pune nicăieri", F.validareRetur({ stare: "in_stoc", cantitate: 3 }).ok === false);
  bine("fără cantitate, la fel", F.validareRetur({ stare: "in_stoc", produs_id: 1 }).ok === false);

  // Deteriorat FARA poza: se refuza. Asta e miezul cererii lui.
  const faraPoza = F.validareRetur({ stare: "deteriorat", produs_id: 1, cantitate: 2, motiv: "strivit" });
  bine("marfa deteriorată NU iese din gestiune fără poză",
    faraPoza.ok === false && /poz/i.test(faraPoza.motiv), faraPoza.motiv);
  const faraMotiv = F.validareRetur({ stare: "deteriorat", produs_id: 1, cantitate: 2, poza: "/f/1.jpg" });
  bine("și nici fără un motiv scris", faraMotiv.ok === false && /motiv|strivit/i.test(faraMotiv.motiv), faraMotiv.motiv);

  const det = F.validareRetur({ stare: "deteriorat", produs_id: 1, cantitate: 2, poza: "/f/1.jpg", motiv: "udat la transport" });
  bine("cu poză și motiv, trece", det.ok === true, det.motiv);
  // Deteriorata NU intra in stoc deloc — nici macar ca minus. Un minus ar
  // scadea din marfa buna, care n-are nicio vina.
  egal("dar nu atinge stocul, nici în plus nici în minus", det.miscare, null);
}

console.log(esecuri ? `\n${esecuri} probleme.\n` : "\nTotul curat.\n");
process.exit(esecuri ? 1 : 0);
