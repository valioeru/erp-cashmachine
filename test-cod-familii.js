"use strict";
// Familiile de produse și codurile care ies din ele. Fără bază de date.
//
// CE APĂRĂ:
//
//   • CODUL PROMIS CHIAR IESE. Pentru fiecare familie, testul dă alegerile din
//     exemplu și cere codul. O literă schimbată din greșeală la „Imprimare" ar
//     trece altfel neobservată până când cineva caută un produs după cod și nu
//     îl găsește.
//
//   • FIECARE NUMĂR DIN COD ARE LUNGIME FIXĂ. Fără ea, codul devine ambiguu:
//     grosime 1 + lungime 200 și grosime 10 + lungime 20 dau amândouă „1200".
//     Verificăm pe toate familiile deodată, nu doar pe cea de la care am
//     pornit.
//
//   • BUCĂȚILE DE COD SUNT DISTINCTE ÎN INTERIORUL UNEI CARACTERISTICI. Dacă
//     „Alb" și „Automată" ar da amândouă „A" pe aceeași caracteristică, două
//     produse diferite ar primi același cod.
//
//   • CARACTERISTICILE OBLIGATORII CHIAR OPRESC. Dacă lipsește una, codul nu
//     trebuie să iasă pe jumătate — trebuie să spună ce lipsește.
const { START } = require("./lib/cod-familii");
const C = require("./lib/cod-produs");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 200) : "")); esecuri++; }
}

// Transformă forma scurtă din lib/cod-familii în ce așteaptă lib/cod-produs.
function caracteristici(lista) {
  return lista.map((c, i) => {
    const [nume, fel, um, ordine, cifre, valori, minv, maxv, inCod, oblig] = c;
    return {
      id: i + 1, nume, fel, um: um || null,
      in_cod: inCod === 0 ? 0 : 1, ordine, obligatoriu: oblig === 0 ? 0 : 1,
      cifre: cifre || 0, min_val: minv == null ? null : minv, max_val: maxv == null ? null : maxv,
      valori: (valori || []).map((v, k) => ({ id: k + 1, valoare: v[0], cod: v[1], ordine: k + 1 })),
    };
  });
}

// Alegerile din care trebuie să iasă codul-exemplu al fiecărei familii.
const EXEMPLE = {
  "Folie stretch": { Tip: "Folie Stretch", Aplicare: "Manuală", Culoare: "Alb", Grosime: 10, Lungime: 200 },
  "Pungă curier": { Tip: "Pungă curier", Imprimare: "Imprimată", "Culoare folie": "Alb", "Lățime": 350,
                    "Lungime fără clapetă": 450, Grosime: 45, "Clapetă": 50, "Tip închidere": "Bandă adezivă" },
  "Sac SGR": { Tip: "Sac SGR", Imprimare: "Imprimat", "Culoare folie": "Alb", "Lățime": 800, Lungime: 750,
               Grosime: 45, "Folie pliată": "Da" },
  "Plic AWB": { Tip: "Plic AWB", "Lățime": 175, Lungime: 240, "Grosime CPE": 25, "Buzunar documente": "Nu" },
  "Sac menajer": { Tip: "Sac menajer", Culoare: "Negru", "Lățime": 1000, Lungime: 1200, Grosime: 70, Fel: "Tub" },
  "Bandă adezivă": { Tip: "Bandă adezivă", Zgomot: "Low noise", Culoare: "Transparent", "Lățime": 48,
                     "Lungime rolă": 900, Grosime: 45, "Diametru core": 47 },
  "Cutie carton": { Tip: "Cutie carton", Fel: "Americană", Lungime: 400, "Lățime": 300, "Înălțime": 200,
                    "Straturi carton": 3, Imprimare: "Neimprimată" },
  "Folie debitată": { Tip: "Folie debitată", Material: "Reciclat", Culoare: "Transparent", Grosime: 23,
                      "Lățime": 500, "Folie pliată": "Nu" },
};

console.log("Codul fiecărei familii");
bine("sunt opt familii", START.length === 8, START.length);

for (const [nume, exemplu, lista] of START) {
  const car = caracteristici(lista);
  const dupaNume = new Map(car.map((c) => [c.nume, c.id]));
  const alegeri = {};
  const cerute = EXEMPLE[nume];
  bine(`„${nume}" are un exemplu de verificat`, Boolean(cerute));
  if (!cerute) continue;
  for (const [k, v] of Object.entries(cerute)) {
    const id = dupaNume.get(k);
    if (!id) { bine(`„${nume}": caracteristica „${k}" există`, false, [...dupaNume.keys()]); continue; }
    alegeri[id] = v;
  }
  const r = C.genereazaCod(car, alegeri);
  bine(`„${nume}" dă ${exemplu}`, r.cod === exemplu, { iesit: r.cod, lipsa: r.lipsa, gresite: r.gresite });
  bine(`„${nume}" iese complet, fără lipsuri`, r.ok, { lipsa: r.lipsa, gresite: r.gresite });
  bine(`„${nume}" nu e ambiguu`, !r.ambiguu);
  bine(`„${nume}" are și denumire scrisă`, Boolean(r.denumire && r.denumire.length > 3), r.denumire);
}

console.log("\nReguli peste toate familiile");
const faraCifre = [];
const codDublu = [];
const codGol = [];
for (const [nume, , lista] of START) {
  for (const c of lista) {
    const [cn, fel, , , cifre, valori, , , inCod] = c;
    const intra = inCod !== 0;
    if (intra && fel === "numar" && !cifre) faraCifre.push(nume + " / " + cn);
    if (fel === "lista") {
      const coduri = (valori || []).map((v) => String(v[1]));
      if (coduri.some((x) => !x)) codGol.push(nume + " / " + cn);
      if (new Set(coduri).size !== coduri.length) codDublu.push(nume + " / " + cn);
    }
  }
}
bine("orice număr care intră în cod are lungime fixă de cifre", faraCifre.length === 0, faraCifre);
bine("nicio caracteristică de listă n-are două valori cu aceeași bucată de cod", codDublu.length === 0, codDublu);
bine("nicio valoare de listă n-are bucata de cod goală", codGol.length === 0, codGol);

console.log("\nCe se întâmplă când lipsește ceva");
const pungi = caracteristici(START.find((f) => f[0] === "Pungă curier")[2]);
const fara = C.genereazaCod(pungi, { 1: "Pungă curier", 2: "Imprimată" });
bine("codul incomplet nu se declară bun", !fara.ok);
bine("spune exact ce lipsește", fara.lipsa.length >= 4, fara.lipsa);
bine("o valoare care nu e în listă e refuzată, nu ghicită",
  C.genereazaCod(pungi, { 1: "Pungă curier", 2: "Mov" }).gresite.length > 0,
  C.genereazaCod(pungi, { 1: "Pungă curier", 2: "Mov" }).gresite);

console.log("\nCe NU intră în cod");
const pc = START.find((f) => f[0] === "Pungă curier")[2];
const inCodPC = pc.filter((c) => c[8] !== 0).map((c) => c[0]);
bine("la punga curier, clapeta și nr. de culori rămân doar atribute",
  !inCodPC.includes("Clapetă") && !inCodPC.includes("Nr. culori"), inCodPC);
bine("dar rămân obligatorii la comandă unde trebuie",
  pc.find((c) => c[0] === "Clapetă")[9] !== 0 && pc.find((c) => c[0] === "Nr. culori")[9] === 0);

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
