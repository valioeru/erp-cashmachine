"use strict";
// Acoperirea unei linii de comanda din mai multe surse.
//
// CE APARA:
//
//   • NU SE PROMITE DIN STOC MAI MULT DECAT EXISTA. „Disponibil" e deja net
//     de ce au rezervat alte comenzi. Daca lasam sa treaca, doua comenzi
//     pleaca pe aceeasi marfa si una dintre ele afla la incarcare.
//
//   • NU SE ACOPERA MAI MULT DECAT S-A CERUT. O greseala de tastare in
//     casuta de productie deschide o comanda de productie in plus, care se
//     fabrica si ramane pe stoc.
//
//   • O CANTITATE DE LA FURNIZOR FARA FURNIZOR E O CERERE ORFANA. Azi
//     formularul lasa sa alegi „din productie" SI un furnizor, iar handlerul
//     arunca furnizorul in tacere. Operatorul crede ca a comandat de la el.
//
//   • LINIA POATE RAMANE PARTIAL DESCOPERITA, DAR SE VEDE. Acoperirea in doi
//     pasi e legitima; acoperirea pe jumatate fara sa stie nimeni, nu.
const path = require("path");
const RAD = __dirname;
const A = require(path.join(RAD, "lib", "acoperire-linie.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu ? "  -> " + detaliu : "")); esecuri++; }
}

// Linia din poza: 60 cerute, nimic livrat, nimic pe stoc.
const LIPSA = { denumire: "Folie SMST1522190 CM", ramas: 60, disponibil: 0, um: "buc" };
// O linie acoperita pe jumatate din stoc.
const PARTIAL = { denumire: "Folie stretch manual negru", ramas: 60, disponibil: 20, um: "buc" };

console.log("\n1. Impartirea pe surse");
{
  const r = A.imparte(PARTIAL, { stoc: "20", productie: "40" });
  bine("20 din stoc + 40 din productie trece", !r.eroare && r.total === 60, r.eroare);
  bine("iese o rezervare si o aprovizionare", r.actiuni.length === 2);
  bine("rezervarea e pe cantitatea din stoc", r.actiuni[0].fel === "rezervare" && r.actiuni[0].cantitate === 20);
  bine("aprovizionarea merge la productie", r.actiuni[1].sursa === "productie" && r.actiuni[1].cantitate === 40);
  bine("linia ramane acoperita integral", r.descoperit === 0);

  const trei = A.imparte(PARTIAL, { stoc: "20", productie: "30", furnizor: "10", furnizor_id: "7" });
  bine("se poate imparti in trei surse", !trei.eroare && trei.actiuni.length === 3, trei.eroare);
  bine("furnizorul ajunge pe aprovizionarea lui", trei.actiuni[2].sursa === "tert" && trei.actiuni[2].furnizor_id === 7);
  bine("si doar pe a lui", trei.actiuni[1].furnizor_id === null);
}

console.log("\n2. Ce nu are voie sa treaca");
{
  bine(
    "din stoc mai mult decat disponibil",
    !!A.imparte(PARTIAL, { stoc: "60" }).eroare
  );
  bine(
    "mesajul spune cat e disponibil si ce sa faca cu restul",
    /disponibil sunt 20/.test(A.imparte(PARTIAL, { stoc: "60" }).eroare || "")
  );
  bine("total peste cat s-a cerut", !!A.imparte(PARTIAL, { stoc: "20", productie: "50" }).eroare);
  bine(
    "cantitate de la furnizor fara furnizor ales",
    !!A.imparte(LIPSA, { furnizor: "60" }).eroare
  );
  bine(
    "furnizor ales fara cantitate nu deranjeaza",
    !A.imparte(LIPSA, { productie: "60", furnizor_id: "7" }).eroare
  );
  bine("nicio cantitate scrisa", !!A.imparte(LIPSA, {}).eroare);
  bine("negative", !!A.imparte(LIPSA, { productie: "-5" }).eroare);
  bine("campurile goale nu sunt zero care sa treaca de validare", !!A.imparte(LIPSA, { stoc: "", productie: "" }).eroare);
}

console.log("\n3. Acoperirea in doi pasi");
{
  const r = A.imparte(PARTIAL, { stoc: "20" });
  bine("se poate rezerva doar ce e pe stoc, acum", !r.eroare && r.total === 20, r.eroare);
  bine("si se vede cat ramane descoperit", r.descoperit === 40, String(r.descoperit));
}

console.log("\n4. Propunerea cu care se deschide pagina");
{
  const p1 = A.propune(PARTIAL);
  bine("ia tot ce e pe stoc si pune restul pe productie", p1.stoc === 20 && p1.productie === 40);
  const p2 = A.propune(LIPSA);
  bine("fara stoc, totul pe productie", p2.stoc === 0 && p2.productie === 60);
  const p3 = A.propune({ ramas: 10, disponibil: 500 });
  bine("stoc mai mult decat cerut: propune doar cat trebuie", p3.stoc === 10 && p3.productie === 0);
  const p4 = A.propune({ ramas: 0, disponibil: 0 });
  bine("linie deja livrata: nu propune nimic", p4.stoc === 0 && p4.productie === 0);
}

console.log("\n5. Zecimale");
{
  const r = A.imparte({ ramas: 0.3, disponibil: 0.1 }, { stoc: "0,1", productie: "0.2" });
  bine("virgula si punctul merg amandoua", !r.eroare, r.eroare);
  bine("0.1 + 0.2 nu refuza o linie buna", r && r.descoperit === 0, String(r && r.descoperit));
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
