"use strict";
// Paletul mixt si iesirea partiala.
//
// CE APARA, in ordinea in care doare daca se strica:
//
//   • STOCUL DIN SISTEM NU SE DESPARTE DE STOCUL DIN HALA. Depozitul scrie si
//     cat pleaca, si cat ramane. Daca cele doua nu inchid cantitatea de pe
//     linie, iesirea e refuzata. O iesire care „merge oricum” si lasa o
//     diferenta e exact felul in care un stoc devine fictiune in sase luni.
//
//   • PALETUL NU PLEACA DIN DEPOZIT CAT TIMP MAI ARE MARFA PE EL. Locurile se
//     elibereaza doar cand toate liniile ajung la zero. Altfel am avea un loc
//     liber in harta si marfa fizic pe el.
//
//   • NU SE SCOATE MAI MULT DECAT EXISTA. Evident, si de-aia usor de uitat.
//
//   • PRODUSELE DE PE PALET CARE NU FAC PARTE DIN COMANDA RAMAN NEATINSE.
//     Un palet mixt are aproape intotdeauna si altceva pe el.
//
//   • REZUMATUL DE PE ct_paleti NU MINTE. Coloanele vechi tin in viata harta
//     si eticheta. Un palet cu kilograme si bucati pe el nu are o cantitate
//     unica — si atunci nu inventam una.
const path = require("path");
const Module = require("module");

const RAD = __dirname;

const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};

const L = require(path.join(RAD, "lib", "ct-palet-linii.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu ? "  -> " + detaliu : "")); esecuri++; }
}

// Un palet mixt ca in hala: folie la kilogram, benzi la rola.
const PALET = [
  { id: 1, produs_id: 10, produs_text: "Folie stretch 23 my", cantitate: 400, um: "kg", pret_unitar: 7.2 },
  { id: 2, produs_id: 11, produs_text: "Banda adeziva 48 mm", cantitate: 120, um: "role", pret_unitar: 3.5 },
  { id: 3, produs_id: 12, produs_text: "Coltar carton", cantitate: 50, um: "buc", pret_unitar: 1.1 },
];

console.log("\n1. Cifra scrisa de om");
{
  bine("virgula si punctul sunt acelasi numar", L.cifra("12,5") === 12.5 && L.cifra("12.5") === 12.5);
  bine("campul gol NU e zero", L.cifra("") === null && L.cifra(null) === null && L.cifra("   ") === null);
  bine("zero scris explicit e zero", L.cifra("0") === 0);
  bine("textul nu trece", L.cifra("doi paleti") === null);
}

console.log("\n2. Verificarea unei linii");
{
  const linie = { id: 1, cantitate: 400, produs_text: "Folie" };
  bine("se inchide: 150 pleaca + 250 ramane = 400", L.validareLinie(linie, { pleaca: "150", ramane: "250" }).pleaca === 150);
  bine(
    "NU se inchide: 150 + 240 = 390, lipsesc 10",
    !!L.validareLinie(linie, { pleaca: "150", ramane: "240" }).eroare
  );
  bine(
    "mesajul de eroare spune diferenta, nu doar ca e gresit",
    /Diferenta -10/.test(L.validareLinie(linie, { pleaca: "150", ramane: "240" }).eroare || "")
  );
  bine("nu scoti mai mult decat exista", !!L.validareLinie(linie, { pleaca: "500", ramane: "0" }).eroare);
  bine("negativele sunt refuzate", !!L.validareLinie(linie, { pleaca: "-5", ramane: "405" }).eroare);
  bine("linia necompletata e sarita, nu eroare", L.validareLinie(linie, {}).sarita === true);
  bine(
    "doar „cat ramane”, fara „cat pleaca”, e refuzat",
    !!L.validareLinie(linie, { ramane: "250" }).eroare
  );
  bine(
    "doar „cat pleaca”, fara „cat ramane”, e refuzat — asta a cerut depozitul",
    !!L.validareLinie(linie, { pleaca: "150" }).eroare
  );
  bine("paletul golit complet: 400 pleaca, 0 ramane", L.validareLinie(linie, { pleaca: "400", ramane: "0" }).pleaca === 400);
  bine(
    "zecimalele binare nu refuza o iesire buna",
    L.validareLinie({ id: 1, cantitate: 0.3 }, { pleaca: "0.1", ramane: "0.2" }).pleaca === 0.1
  );
}

console.log("\n3. Iesirea dintr-un palet mixt");
{
  const r = L.validareIesire(PALET, { "1": { pleaca: "150", ramane: "250" } });
  bine("pleaca o singura linie din trei", r.miscate && r.miscate.length === 1);
  bine("celelalte doua raman neatinse", r.dupa[1].cantitate === 120 && r.dupa[2].cantitate === 50);
  bine("linia atinsa scade la cat a ramas", r.dupa[0].cantitate === 250);
  bine("paletul NU pleaca din depozit", r.paletGol === false);
  bine("costul e al cantitatii plecate, nu al paletului", Math.abs(r.cost - 150 * 7.2) < 0.001, String(r.cost));

  const tot = L.validareIesire(PALET, {
    "1": { pleaca: "400", ramane: "0" },
    "2": { pleaca: "120", ramane: "0" },
    "3": { pleaca: "50", ramane: "0" },
  });
  bine("golit pe toate liniile: paletul pleaca", tot.paletGol === true);
  bine(
    "costul total aduna toate liniile",
    Math.abs(tot.cost - (400 * 7.2 + 120 * 3.5 + 50 * 1.1)) < 0.001,
    String(tot.cost)
  );

  bine(
    "o linie gresita opreste toata iesirea, nu doar linia ei",
    !!L.validareIesire(PALET, { "1": { pleaca: "150", ramane: "250" }, "2": { pleaca: "10", ramane: "999" } }).eroare
  );
  bine(
    "eroarea spune pe ce produs s-a impiedicat",
    /Banda adeziva/.test(
      L.validareIesire(PALET, { "2": { pleaca: "10", ramane: "999" } }).eroare || ""
    )
  );
  bine("nimic completat = eroare, nu iesire goala", !!L.validareIesire(PALET, {}).eroare);
}

console.log("\n4. Rezumatul scris inapoi pe ct_paleti");
{
  const unul = L.rezumat([PALET[0]]);
  bine("un singur produs se comporta ca inainte", unul.produs_id === 10 && unul.cantitate === 400 && unul.um === "kg");

  const mixt = L.rezumat(PALET);
  bine("palet mixt: nu pretinde ca are un produs_id", mixt.produs_id === null);
  bine("denumirea devine rezumat", /3 produse/.test(mixt.produs_text || ""));
  bine(
    "kilograme + role + bucati NU se aduna intr-o cantitate inventata",
    mixt.cantitate === 0 && mixt.um === null,
    String(mixt.cantitate)
  );

  const aceeasiUm = L.rezumat([
    { produs_id: 1, produs_text: "A", cantitate: 100, um: "kg", pret_unitar: 5 },
    { produs_id: 2, produs_text: "B", cantitate: 300, um: "kg", pret_unitar: 10 },
  ]);
  bine("aceeasi unitate: cantitatile se aduna", aceeasiUm.cantitate === 400 && aceeasiUm.um === "kg");
  bine(
    "pretul unitar al paletului mixt e media ponderata",
    Math.abs(aceeasiUm.pret_unitar - (100 * 5 + 300 * 10) / 400) < 0.001,
    String(aceeasiUm.pret_unitar)
  );

  const golit = L.rezumat([{ produs_id: 1, cantitate: 0, um: "kg" }]);
  bine("paletul golit nu mai are cantitate", golit.cantitate === 0 && golit.produs_text === null);
}

console.log("\n5. Intrarea: produs, numar de paleti, cantitate pe palet");
{
  const simplu = L.grupeazaIntrare([
    { produs_id: 10, nr_paleti: "6", cantitate_per_palet: "400", um: "kg" },
  ]);
  bine("sase paleti dintr-un produs", simplu.grupuri.length === 1 && simplu.grupuri[0].nr_paleti === 6);
  bine("fiecare palet are o linie", simplu.grupuri[0].linii.length === 1);
  bine("totalul de paleti e numarat", simplu.total === 6);

  const doua = L.grupeazaIntrare([
    { produs_id: 10, nr_paleti: "6", cantitate_per_palet: "400", um: "kg" },
    { produs_id: 11, nr_paleti: "2", cantitate_per_palet: "120", um: "role" },
  ]);
  bine("doua produse separate fac doua grupuri de paleti", doua.grupuri.length === 2 && doua.total === 8);

  const mixt = L.grupeazaIntrare([
    { produs_id: 10, nr_paleti: "2", cantitate_per_palet: "400", um: "kg" },
    { produs_id: 11, cantitate_per_palet: "120", um: "role", acelasi_palet: "1" },
    { produs_id: 12, cantitate_per_palet: "50", um: "buc", acelasi_palet: "1" },
  ]);
  bine("bifa „acelasi palet” lipeste liniile de grupul de deasupra", mixt.grupuri.length === 1);
  bine("grupul are trei produse pe el", mixt.grupuri[0].linii.length === 3);
  bine("si tot doi paleti, nu sase", mixt.total === 2);

  bine("linie fara cantitate pe palet e refuzata", !!L.grupeazaIntrare([{ produs_id: 10, nr_paleti: "2" }]).eroare);
  bine(
    "linie fara numar de paleti e refuzata",
    !!L.grupeazaIntrare([{ produs_id: 10, cantitate_per_palet: "400" }]).eroare
  );
  bine("lista goala e refuzata", !!L.grupeazaIntrare([]).eroare);
  bine(
    "500 de paleti dintr-o intrare e o greseala de tastare, nu o livrare",
    !!L.grupeazaIntrare([{ produs_id: 10, nr_paleti: "5000", cantitate_per_palet: "1" }]).eroare
  );
  bine(
    "o linie fara produs se sare, nu crapa",
    L.grupeazaIntrare([
      { produs_text: "", nr_paleti: "2", cantitate_per_palet: "1" },
      { produs_id: 10, nr_paleti: "1", cantitate_per_palet: "400" },
    ]).total === 1
  );
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
