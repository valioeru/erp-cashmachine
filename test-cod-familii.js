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
//
//   • BANDA NEPERSONALIZATĂ ÎȘI PĂSTREAZĂ CODUL. Personalizarea (03.11.2026)
//     s-a adăugat la o familie care avea deja produse. Dacă „Nepersonalizată"
//     ar fi pus o literă în cod, fiecare bandă simplă configurată de acum
//     încolo ar fi ieșit produs nou, lângă cel vechi — stocul rupt în două.
//
//   • HÂRTIA: CUTIA ȘI TOPUL SUNT PRODUSE DIFERITE, CU UNITATEA LOR. O cutie
//     (5 topuri) și un top cu același cod ar fi același produs, cu un singur
//     preț — unul dintre ele ar fi vândut de cinci ori prea ieftin.
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
      valori: (valori || []).map((v, k) => ({ id: k + 1, valoare: v[0], cod: v[1], ordine: k + 1, um: v[2] || null })),
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
                     "Lungime rolă": 900, Grosime: 45, "Diametru core": 47, Personalizare: "Nepersonalizată" },
  "Cutie carton": { Tip: "Cutie carton", Fel: "Americană", Lungime: 400, "Lățime": 300, "Înălțime": 200,
                    "Straturi carton": 3, Imprimare: "Neimprimată" },
  "Folie debitată": { Tip: "Folie debitată", Material: "Reciclat", Culoare: "Transparent", Grosime: 23,
                      "Lățime": 500, "Folie pliată": "Nu" },
  "Hârtie": { Tip: "Hârtie copiator", Format: "A4", Gramaj: 80, Ambalare: "Cutie (5 topuri)" },
};

console.log("Codul fiecărei familii");
bine("sunt nouă familii", START.length === 9, START.length);

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
  // Ultima caracteristică din cod, după ordine: singura după care nu se mai
  // lipește nimic, deci singura unde o bucată goală nu face două coduri să
  // semene.
  const dinCod = lista.filter((c) => c[8] !== 0).slice().sort((a, b) => a[3] - b[3]);
  const ultima = dinCod.length ? dinCod[dinCod.length - 1][0] : null;
  for (const c of lista) {
    const [cn, fel, , , cifre, valori, , , inCod] = c;
    const intra = inCod !== 0;
    if (intra && fel === "numar" && !cifre) faraCifre.push(nume + " / " + cn);
    if (fel === "lista") {
      const coduri = (valori || []).map((v) => String(v[1]));
      const goale = coduri.filter((x) => !x).length;
      if (goale > 1 || (goale === 1 && (cn !== ultima || !intra))) codGol.push(nume + " / " + cn);
      if (new Set(coduri).size !== coduri.length) codDublu.push(nume + " / " + cn);
    }
  }
}
bine("orice număr care intră în cod are lungime fixă de cifre", faraCifre.length === 0, faraCifre);
bine("nicio caracteristică de listă n-are două valori cu aceeași bucată de cod", codDublu.length === 0, codDublu);
bine("o bucată de cod goală e una singură, și doar la ultima caracteristică din cod", codGol.length === 0, codGol);

// Familia, cu alegerile date pe nume, nu pe id.
function codDin(numeFamilie, alegeriPeNume) {
  const car = caracteristici(START.find((f) => f[0] === numeFamilie)[2]);
  const dupa = new Map(car.map((c) => [c.nume, c.id]));
  const a = {};
  for (const [k, v] of Object.entries(alegeriPeNume)) a[dupa.get(k)] = v;
  return C.genereazaCod(car, a);
}

console.log("\nBanda adezivă: personalizarea");
{
  const baza = { Tip: "Bandă adezivă", Zgomot: "Low noise", Culoare: "Transparent", "Lățime": 48,
                 "Lungime rolă": 900, Grosime: 45, "Diametru core": 47 };
  const simpla = codDin("Bandă adezivă", { ...baza, Personalizare: "Nepersonalizată" });
  bine("nepersonalizată dă codul de dinainte, BALT4890045", simpla.cod === "BALT4890045" && simpla.ok, simpla);
  const fragil = codDin("Bandă adezivă", { ...baza, Personalizare: "Personalizată FRAGIL" });
  bine("FRAGIL dă BALT4890045F", fragil.cod === "BALT4890045F" && fragil.ok, fragil.cod);
  const doua = codDin("Bandă adezivă", { ...baza, Personalizare: "Personalizată custom 2 culori" });
  bine("custom cu 2 culori dă BALT4890045C2", doua.cod === "BALT4890045C2" && doua.ok, doua.cod);
  bine("numărul de culori se vede și în denumire", /custom 2 culori/.test(doua.denumire), doua.denumire);
  const fara = codDin("Bandă adezivă", baza);
  bine("fără personalizare aleasă nu iese cod bun — agentul trebuie să spună",
    !fara.ok && fara.lipsa.includes("Personalizare"), fara.lipsa);
  const toate = START.find((f) => f[0] === "Bandă adezivă")[2].find((c) => c[0] === "Personalizare")[5]
    .map(([v]) => codDin("Bandă adezivă", { ...baza, Personalizare: v }).cod);
  bine("fiecare personalizare are codul ei", new Set(toate).size === toate.length && toate.length === 6, toate);
  bine("nicio bandă nu primește unitate de măsură din caracteristici", simpla.um === null && doua.um === null);
}

console.log("\nHârtia: cutie sau top");
{
  const cutie = codDin("Hârtie", { Tip: "Hârtie copiator", Format: "A4", Gramaj: 80, Ambalare: "Cutie (5 topuri)" });
  const top = codDin("Hârtie", { Tip: "Hârtie copiator", Format: "A4", Gramaj: 80, Ambalare: "Top" });
  bine("cutia dă HCA4080C", cutie.cod === "HCA4080C" && cutie.ok, cutie);
  bine("topul dă HCA4080T", top.cod === "HCA4080T" && top.ok, top);
  bine("cutia iese cu UM cutie", cutie.um === "cutie", cutie.um);
  bine("topul iese cu UM top", top.um === "top", top.um);
  bine("în denumirea cutiei scrie că are 5 topuri", /Cutie \(5 topuri\)/.test(cutie.denumire), cutie.denumire);
  const a3 = codDin("Hârtie", { Tip: "Hârtie copiator", Format: "A3", Gramaj: 80, Ambalare: "Top" });
  bine("A3 nu se lovește de A4", a3.cod === "HCA3080T", a3.cod);
  const gros = codDin("Hârtie", { Tip: "Hârtie copiator", Format: "A4", Gramaj: 160, Ambalare: "Top" });
  bine("160 g/m² încape în cele trei cifre", gros.cod === "HCA4160T" && gros.ok, gros);
  const scapat = codDin("Hârtie", { Tip: "Hârtie copiator", Format: "A4", Gramaj: 8, Ambalare: "Top" });
  bine("8 g/m² în loc de 80 e prins, nu devine produs", !scapat.ok && scapat.gresite.length > 0, scapat.gresite);
  const lipsa = codDin("Hârtie", { Tip: "Hârtie copiator", Format: "A4", Gramaj: 80 });
  bine("fără cutie/top nu iese cod", !lipsa.ok && lipsa.lipsa.includes("Ambalare"), lipsa.lipsa);
}

console.log("\nExemplul din Configurări");
{
  const sab = C.sablon(caracteristici(START.find((f) => f[0] === "Bandă adezivă")[2]));
  const ultima = sab[sab.length - 1];
  bine("personalizarea apare în exemplu cu o literă adevărată, nu cu „?”",
    ultima && ultima.nume === "Personalizare" && ultima.exemplu === "F", ultima);
}

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
