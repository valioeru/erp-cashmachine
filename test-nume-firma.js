"use strict";
// „SC” din fata numelor de firma.
//
// CE APARA, si primul punct e singurul care poate face pagube:
//
//   • IMPORTUL DE FACTURI NU TREBUIE SA FACA DUPLICATE. In baza numele e
//     acum fara „SC”, dar facturile vin in continuare cu „SC AQUILA SRL”.
//     Daca potrivirea pe nume s-ar face pe text brut, la fiecare import s-ar
//     naste un partener nou — adica exact duplicatul pe care il evitam de
//     ani de zile. Cheia trebuie sa dea acelasi lucru pentru ambele forme.
//
//   • „SC” SE TAIE DOAR DE LA INCEPUT. Intr-un nume ca „Prod SC Ceva”,
//     „SC” e parte din nume.
//
//   • O FIRMA NU RAMANE FARA NUME. Daca dupa taiere n-ar mai ramane nimic,
//     se pastreaza ce era.
//
//   • CAUTAREA GASESTE SI DUPA FORMA VECHE. Omul care scrie din obisnuinta
//     „sc aquila” trebuie sa gaseasca firma scrisa acum „Aquila SRL”.
const path = require("path");
const NF = require(path.join(__dirname, "lib", "nume-firma.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu) : "")); esecuri++; }
}

console.log("\n1. Formele în care se scrie prefixul");
{
  for (const [intrare, asteptat] of [
    ["SC AQUILA SRL", "AQUILA SRL"],
    ["S.C. AQUILA SRL", "AQUILA SRL"],
    ["S.C AQUILA SRL", "AQUILA SRL"],
    ["Sc Aquila Srl", "Aquila Srl"],
    ["sc aquila srl", "aquila srl"],
    ["S. C. AQUILA SRL", "AQUILA SRL"],
    ["Societatea Aquila SRL", "Aquila SRL"],
    ["Soc. Aquila SRL", "Aquila SRL"],
    ["  SC   AQUILA   SRL  ", "AQUILA SRL"],
  ]) {
    bine('„' + intrare + '” → „' + asteptat + '”', NF.faraSC(intrare) === asteptat, NF.faraSC(intrare));
  }
}

console.log("\n2. Ce NU se atinge");
{
  bine("un nume fără prefix rămâne neatins", NF.faraSC("Aquila SRL") === "Aquila SRL");
  // „SC” la mijloc e parte din nume, nu forma juridica.
  bine("„SC” la mijloc nu se taie", NF.faraSC("Prod SC Ceva SRL") === "Prod SC Ceva SRL");
  bine("un cuvânt care începe cu SC nu se taie", NF.faraSC("Scala Media SRL") === "Scala Media SRL", NF.faraSC("Scala Media SRL"));
  bine("nici „Scandia Food”", NF.faraSC("Scandia Food SA") === "Scandia Food SA", NF.faraSC("Scandia Food SA"));
  // O firma nu ramane fara nume.
  bine("„SC” singur rămâne cum e", NF.faraSC("SC") === "SC");
  bine("gol rămâne gol", NF.faraSC("") === "" && NF.faraSC(null) === "");

  bine("areSC spune corect când e ceva de tăiat", NF.areSC("SC Aquila SRL") === true);
  bine("și când nu e", NF.areSC("Aquila SRL") === false);
  bine("nici la „Scala”", NF.areSC("Scala Media") === false);
}

console.log("\n3. Cheia de potrivire — partea care nu are voie să greșească");
{
  // ASTA E VERIFICAREA. Baza are „Aquila SRL”, factura vine „SC AQUILA SRL”.
  bine(
    "forma cu SC și cea fără dau aceeași cheie",
    NF.cheieNume("SC AQUILA SRL") === NF.cheieNume("Aquila SRL"),
    NF.cheieNume("SC AQUILA SRL") + " / " + NF.cheieNume("Aquila SRL")
  );
  bine("și cu punctuație", NF.cheieNume("S.C. Aquila S.R.L.") === NF.cheieNume("Aquila S.R.L."));
  bine("diacriticele nu contează", NF.cheieNume("SC Brutăria Veche SRL") === NF.cheieNume("Brutaria Veche SRL"));
  bine("spațiile duble nu contează", NF.cheieNume("SC   Aquila    SRL") === NF.cheieNume("Aquila SRL"));
  // Dar doua firme DIFERITE nu trebuie lipite.
  bine("firme diferite rămân diferite", NF.cheieNume("SC Aquila SRL") !== NF.cheieNume("SC Aquila Prod SRL"));
  bine("și „Scala” nu devine „ala”", NF.cheieNume("Scala Media") === "scala media", NF.cheieNume("Scala Media"));
}

console.log("\n4. Textul după care caută căsuța");
{
  const t = NF.textCautare("SC AQUILA SRL", "RO123456");
  // Trebuie sa gaseasca si cine scrie forma veche, si cine scrie forma noua.
  bine("conține forma fără SC", t.indexOf("aquila srl") >= 0, t);
  bine("conține și forma cu SC", t.indexOf("sc aquila srl") >= 0, t);
  bine("și CUI-ul", t.indexOf("ro123456") >= 0, t);
  const fara = NF.textCautare("Aquila SRL", null);
  bine("la un nume deja curat nu se dublează degeaba", fara === "aquila srl", fara);
}

console.log("\n5. Căutarea progresivă, literă cu literă");
{
  // Reproduc exact functia din pagina (lib/render.js), ca sa verific ordinea.
  const date = [
    [1, "Aquila SRL", NF.textCautare("Aquila SRL"), "", NF.cheieNume("Aquila SRL")],
    [2, "Profi Rom Food", NF.textCautare("Profi Rom Food"), "", NF.cheieNume("Profi Rom Food")],
    [3, "Marea Alianță", NF.textCautare("Marea Alianță"), "", NF.cheieNume("Marea Alianță")],
    [4, "Apa Nova", NF.textCautare("Apa Nova"), "", NF.cheieNume("Apa Nova")],
  ];
  function cauta(q) {
    const intreg = String(q).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
    const bucati = intreg.split(" ").filter(Boolean);
    if (!bucati.length) return [];
    const inceput = [], oriunde = [];
    for (const r of date) {
      let bun = true;
      for (const b of bucati) if (r[2].indexOf(b) < 0) { bun = false; break; }
      if (!bun) continue;
      if ((r[4] || r[2]).indexOf(intreg) === 0) inceput.push(r); else oriunde.push(r);
    }
    return inceput.concat(oriunde);
  }
  // Litera cu litera: fiecare pas ingusteaza.
  bine('„a” găsește 3 (Aquila, Apa, și Marea care-l conține)', cauta("a").length === 3, cauta("a").map((r) => r[1]).join(", "));
  bine("dar primele sunt cele care ÎNCEP cu a", ["Aquila SRL", "Apa Nova"].indexOf(cauta("a")[0][1]) >= 0, cauta("a")[0][1]);
  bine('„aq” lasă doar Aquila', cauta("aq").length === 1 && cauta("aq")[0][1] === "Aquila SRL");
  bine('„aqu” la fel', cauta("aqu")[0][1] === "Aquila SRL");
  bine('„pro” găsește Profi', cauta("pro")[0][1] === "Profi Rom Food");
  // Cuvant din mijloc: tot trebuie gasit, doar ca nu primul.
  bine('„rom” găsește tot Profi, deși e la mijloc', cauta("rom").length === 1 && cauta("rom")[0][1] === "Profi Rom Food");
  bine("ceva ce nu există nu găsește nimic", cauta("zzz").length === 0);
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
