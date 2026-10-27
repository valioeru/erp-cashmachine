"use strict";
// Codul unic al produsului. Aritmetică pură, fără bază de date.
//
// CE APĂRĂ:
//
//   • CODUL CERUT DE VALI IESE EXACT. „Folie stretch manuală albă de 10
//     microni, 200 m pe rolă" trebuie să dea FSMA10200. Dacă se schimbă
//     ordinea caracteristicilor în configurare, codul se schimbă și el — și
//     testul ăsta e singurul loc în care se vede imediat.
//
//   • O VALOARE NERECUNOSCUTĂ NU SE SARE PESTE. Dacă cineva scrie o culoare
//     care nu e în listă, bucata ei ar lipsi din cod, iar codul scurt s-ar
//     putea lovi de alt produs. Se refuză, nu se completează pe ghicite.
//
//   • NUMERELE FĂRĂ LUNGIME FIXĂ SUNT AMBIGUE. Grosime 1 + lungime 200 și
//     grosime 10 + lungime 20 dau amândouă „1200". Funcția trebuie să spună
//     asta, nu să tacă.
const C = require("./lib/cod-produs");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 200) : "")); esecuri++; }
}
const egal = (d, avut, asteptat) =>
  bine(d + " = " + JSON.stringify(asteptat), JSON.stringify(avut) === JSON.stringify(asteptat), JSON.stringify(avut));

// Configurarea cerută de Vali pe 26.10.2026.
const CARACTERISTICI = [
  { id: 1, nume: "Tip", fel: "lista", in_cod: 1, ordine: 1, obligatoriu: 1,
    valori: [{ valoare: "Folie Stretch", cod: "FS" }, { valoare: "Folie Prestretch", cod: "FP" }] },
  { id: 2, nume: "Aplicare", fel: "lista", in_cod: 1, ordine: 2, obligatoriu: 1,
    valori: [{ valoare: "Manuală", cod: "M" }, { valoare: "Automată", cod: "A" }] },
  { id: 3, nume: "Culoare", fel: "lista", in_cod: 1, ordine: 3, obligatoriu: 1,
    valori: [{ valoare: "Transparent", cod: "T" }, { valoare: "Alb", cod: "A" }, { valoare: "Negru", cod: "N" }] },
  { id: 4, nume: "Grosime", fel: "numar", um: "microni", in_cod: 1, ordine: 4, obligatoriu: 1,
    cifre: 2, min_val: 4, max_val: 23 },
  { id: 5, nume: "Lungime", fel: "numar", um: "m", in_cod: 1, ordine: 5, obligatoriu: 1, cifre: 3 },
];

console.log("\n1. Codul cerut: folie stretch manuală albă, 10 microni, 200 m");
{
  const r = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 10, 5: 200 });
  egal("codul e FSMA10200", r.cod, "FSMA10200");
  bine("și e valid", r.ok === true, JSON.stringify({ lipsa: r.lipsa, gresite: r.gresite }));
  egal("denumirea se scrie singură", r.denumire, "Folie Stretch Manuală Alb 10 microni 200 m");
  egal("se vede din ce bucăți e făcut", r.bucati.map((b) => b.cod), ["FS", "M", "A", "10", "200"]);
  bine("nu e ambiguu: numerele au lungime fixă", r.ambiguu === false);
}

console.log("\n2. Ordinea din configurare e ordinea din cod");
{
  // Aceleasi caracteristici, dar culoarea inaintea aplicarii.
  const alt = CARACTERISTICI.map((c) => (c.id === 2 ? { ...c, ordine: 3 } : c.id === 3 ? { ...c, ordine: 2 } : c));
  const r = C.genereazaCod(alt, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 10, 5: 200 });
  egal("codul se schimbă cu ordinea", r.cod, "FSAM10200");
}

console.log("\n3. O caracteristică scoasă din cod nu mai apare în el");
{
  const alt = CARACTERISTICI.map((c) => (c.id === 3 ? { ...c, in_cod: 0 } : c));
  const r = C.genereazaCod(alt, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 10, 5: 200 });
  egal("fără culoare în cod", r.cod, "FSM10200");
  bine("dar culoarea rămâne în denumire", r.denumire.includes("Alb"), r.denumire);
}

console.log("\n4. Ce nu se acceptă");
{
  const fara = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 4: 10, 5: 200 });
  egal("o caracteristică obligatorie lipsă oprește codul", fara.lipsa, ["Culoare"]);
  bine("și nu e valid", fara.ok === false);

  const strain = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Roșu", 4: 10, 5: 200 });
  bine("o valoare care nu e în listă se refuză, nu se sare peste",
    strain.ok === false && /Roșu/.test(strain.gresite.join(" ")), JSON.stringify(strain.gresite));

  const gros = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 230, 5: 200 });
  bine("o grosime peste interval se prinde aici, nu în depozit",
    gros.ok === false && /peste maximul/.test(gros.gresite.join(" ")), JSON.stringify(gros.gresite));

  const text = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: "gros", 5: 200 });
  bine("un text în loc de număr se prinde", text.ok === false && /nu e un număr/.test(text.gresite.join(" ")));
}

console.log("\n5. Numerele fără lungime fixă sunt ambigue — și se spune");
{
  const fara = CARACTERISTICI.map((c) => (c.fel === "numar" ? { ...c, cifre: 0 } : c));
  const a = C.genereazaCod(fara, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 1, 5: 200 });
  const b = C.genereazaCod(fara, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 12, 5: 0 });
  egal("două produse diferite, același cod", [a.cod, b.cod], ["FSMA1200", "FSMA120"]);
  bine("funcția avertizează", a.ambiguu === true);
  // Cu cifre fixe, nu se mai pot lovi.
  const c1 = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 1, 5: 200 });
  const c2 = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: 12, 5: 0 });
  bine("cu lungime fixă, coduri diferite", c1.cod !== c2.cod, c1.cod + " / " + c2.cod);
  egal("și se citesc corect", [c1.cod, c2.cod], ["FSMA01200", "FSMA12000"]);
}

console.log("\n6. Scrierea valorii nu contează, conținutul da");
{
  const r = C.genereazaCod(CARACTERISTICI, { 1: "folie stretch", 2: "manuala", 3: "ALB", 4: "10", 5: "200" });
  egal("fără diacritice, cu altă literă mare — același cod", r.cod, "FSMA10200");
  // Virgula se citeste ca punct zecimal, dar bucata tot trebuie sa incapa in
  // locul ei. „10,5" intr-un loc de doua cifre ar scrie „105" — exact codul
  // unei grosimi de 105. Se refuza, nu se lateste codul in tacere.
  const z = C.genereazaCod(CARACTERISTICI, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: "10,5", 5: 200 });
  bine("o zecimală care nu încape în locul ei se refuză", !z.ok && z.gresite.length === 1, JSON.stringify(z.gresite));
  bine("și spune în câte cifre trebuia să încapă", z.gresite[0].indexOf("2 cifre") !== -1, z.gresite[0]);
  bine("codul rupt nu iese deloc", z.cod !== "FSMA105200", z.cod);

  // Unde incape, virgula merge mai departe ca punct zecimal.
  const larg = CARACTERISTICI.map((c) => (c.id === 4 ? { ...c, cifre: 3, max_val: 100 } : c));
  const w = C.genereazaCod(larg, { 1: "Folie Stretch", 2: "Manuală", 3: "Alb", 4: "10,5", 5: 200 });
  egal("virgula zecimală se citește ca punct", w.bucati[3].cod, "105");
  bine("și codul e valid", w.ok, JSON.stringify(w.gresite));
}

console.log("\n7. Șablonul, pentru ecranul de configurare");
{
  egal("se vede din ce se compune codul",
    C.sablon(CARACTERISTICI).map((s) => s.nume), ["Tip", "Aplicare", "Culoare", "Grosime", "Lungime"]);
}

console.log(esecuri ? `\n${esecuri} probleme.\n` : "\nTotul curat.\n");
process.exit(esecuri ? 1 : 0);
