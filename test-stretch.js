"use strict";
// Greutatea și lungimea foliei stretch, una din cealaltă.
//
// CE APĂRĂ:
//
//   • CIFRELE SUNT CELE DIN HALĂ. O rolă de 23µ × 300 m cântărește 3,17 kg;
//     una de mașină, 17µ × 1500 m, cântărește 11,7 kg. Dacă formula iese
//     altceva, nu e o greșeală de programare — e marfă comandată greșit. De-aia
//     testul fixează role adevărate, nu doar „dus-întors dă același număr".
//
//   • DUS-ÎNTORS NU PIERDE NIMIC. Omul scrie greutatea, vede lungimea, se
//     răzgândește și scrie lungimea înapoi: trebuie să-i iasă aceeași
//     greutate, nu una cu 2 kg mai mică.
//
//   • „LUNGIME FĂRĂ CLAPETĂ (mm)" DE LA PUNGI NU PICĂ AICI. Verificarea merge
//     pe unitate, iar „mm" începe cu „m" — exact felul de potrivire care
//     trece neobservată și pune o căsuță de greutate pe punga curier.
//
//   • ZERO ȘI GUNOI NU DAU NaN PE ECRAN. Un câmp gol e starea normală a
//     formularului, nu o eroare.
const S = require("./lib/stretch");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 200) : ""));
    esecuri++;
  }
}
const aproape = (a, b, toleranta) => a !== null && Math.abs(a - b) <= toleranta;

console.log("Datele date de Vali");
{
  bine("lățimea e 50 cm", S.LATIME_M === 0.5, S.LATIME_M);
  bine("densitatea e 0,918 g/cm³", S.DENSITATE_G_CM3 === 0.918, S.DENSITATE_G_CM3);
  bine("un metru de folie de un micron are 0,000459 kg",
    Math.abs(S.kgPeMetruMicron() - 0.000459) < 1e-12, S.kgPeMetruMicron());
}

console.log("\nRole adevărate");
{
  // Rola manuala obisnuita.
  bine("23µ × 300 m ≈ 3,17 kg", aproape(S.greutateDinLungime(300, 23), 3.17, 0.01), S.greutateDinLungime(300, 23));
  // Rola de masina.
  bine("17µ × 1500 m ≈ 11,70 kg", aproape(S.greutateDinLungime(1500, 17), 11.7, 0.01), S.greutateDinLungime(1500, 17));
  // Una subtire, de prestretch.
  bine("10µ × 200 m ≈ 0,918 kg", aproape(S.greutateDinLungime(200, 10), 0.918, 0.001), S.greutateDinLungime(200, 10));

  bine("3,17 kg de 23µ dau înapoi ~300 m", aproape(S.lungimeDinGreutate(3.17, 23), 300, 1), S.lungimeDinGreutate(3.17, 23));
  bine("11,7 kg de 17µ dau înapoi ~1500 m", aproape(S.lungimeDinGreutate(11.7, 17), 1500, 1), S.lungimeDinGreutate(11.7, 17));
}

console.log("\nDus-întors");
{
  for (const [L, g] of [[300, 23], [1500, 17], [200, 10], [1000, 12], [50, 50]]) {
    const kg = S.greutateDinLungime(L, g);
    const inapoi = S.lungimeDinGreutate(kg, g);
    bine(`${g}µ × ${L} m → ${kg} kg → ${inapoi} m`, Math.abs(inapoi - L) <= 1, { kg, inapoi, L });
  }
}

console.log("\nCâmpuri goale și gunoi");
{
  for (const [a, b] of [[0, 23], [300, 0], [-5, 23], [300, -1], ["", 23], [null, 23], ["abc", 23], [NaN, 23]]) {
    bine(`greutate(${JSON.stringify(a)}, ${JSON.stringify(b)}) = null`, S.greutateDinLungime(a, b) === null);
  }
  bine("lungime(0, 23) = null", S.lungimeDinGreutate(0, 23) === null);
  bine("lungime(3, 0) = null", S.lungimeDinGreutate(3, 0) === null);
  bine("lungime('', 23) = null", S.lungimeDinGreutate("", 23) === null);
}

console.log("\nCui i se pune căsuța de greutate");
{
  const stretch = [
    { id: 1, nume: "Tip", fel: "lista", um: "" },
    { id: 4, nume: "Grosime", fel: "numar", um: "microni" },
    { id: 5, nume: "Lungime", fel: "numar", um: "m" },
  ];
  const p = S.potriveste(stretch);
  bine("folia stretch se potrivește", Boolean(p), p);
  bine("și știe care câmp e care", p.grosime_id === 4 && p.lungime_id === 5, p);

  // Asta e capcana: „mm" incepe cu „m".
  const pungi = [
    { id: 6, nume: "Grosime", fel: "numar", um: "microni" },
    { id: 7, nume: "Lungime fără clapetă", fel: "numar", um: "mm" },
    { id: 8, nume: "Lățime", fel: "numar", um: "mm" },
  ];
  bine("punga curier NU se potrivește (lungimea ei e în mm)", S.potriveste(pungi) === null, S.potriveste(pungi));

  const banda = [
    { id: 9, nume: "Grosime", fel: "numar", um: "microni" },
    { id: 10, nume: "Lungime rolă", fel: "numar", um: "m" },
  ];
  // Banda are grosime in microni SI lungime in metri — deci trecea. Dar are
  // si latimea ei (48 mm), iar formula asta presupune 50 cm ficsi: ar fi iesit
  // de zece ori mai grea, fara nicio eroare pe ecran.
  bine("banda adezivă NU se potrivește, fiindcă își alege lățimea",
    S.potriveste(banda.concat([{ id: 11, nume: "Lățime", fel: "numar", um: "mm" }])) === null);
  bine("dar o familie cu lungime în metri și lățime fixă se potrivește", Boolean(S.potriveste(banda)), S.potriveste(banda));

  bine("o familie fără grosime nu se potrivește",
    S.potriveste([{ id: 1, nume: "Lungime", fel: "numar", um: "m" }]) === null);
  bine("o familie fără lungime nu se potrivește",
    S.potriveste([{ id: 1, nume: "Grosime", fel: "numar", um: "microni" }]) === null);
  bine("o listă goală nu crapă", S.potriveste([]) === null && S.potriveste(null) === null);
  // Grosimea ca lista, nu ca numar, n-are ce calcula.
  bine("o grosime care e listă, nu număr, nu se potrivește",
    S.potriveste([{ id: 1, nume: "Grosime", fel: "lista", um: "microni" }, { id: 2, nume: "Lungime", fel: "numar", um: "m" }]) === null);
}

console.log("\nDacă se schimbă folia");
{
  // Densitatea si latimea se pot da din afara: daca maine se lucreaza pe 45 cm
  // sau pe alt material, formula nu trebuie rescrisa.
  const altfel = S.greutateDinLungime(300, 23, { latime: 0.45, densitate: 0.92 });
  bine("o lățime de 45 cm dă mai puțin", altfel < S.greutateDinLungime(300, 23), { altfel });
  bine("și cifra e cea așteptată", aproape(altfel, 300 * 23 * 0.45 * 1e-6 * 920, 0.002), altfel);
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
