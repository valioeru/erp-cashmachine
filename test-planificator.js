"use strict";
// Propunerea de planificare. Aritmetică pură, fără bază de date.
//
// CE APĂRĂ:
//
//   • POSTUL GREU DE ACOPERIT SE DĂ PRIMUL. Dacă flexo e știut de un singur
//     om și algoritmul îl pune la extruder fiindcă acolo a ajuns întâi în
//     listă, flexo rămâne gol DEGEABA — exista o soluție în care mergeau
//     amândouă. Ăsta e testul care contează cel mai mult aici.
//
//   • NIMENI NU E PUS DE DOUĂ ORI ÎN ACEEAȘI ZI. Un om nu poate ține două
//     mașini în două schimburi în aceeași zi, oricât de bine ar fi planul.
//
//   • CINE NU E DISPONIBIL NU APARE. Toată planificarea se sprijină pe asta.
//
//   • POSTUL GOL SPUNE DE CE E GOL. „Nu s-a putut" nu ajută pe nimeni:
//     una e că n-ai pe cine califica, alta e că toți erau deja puși.
//
//   • ACELAȘI PLAN LA A DOUA RULARE. Un planificator care dă altceva de
//     fiecare dată nu se poate verifica și nu se poate discuta.
const P = require("./lib/planificator");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 240) : "")); esecuri++; }
}

const ZI = "2026-10-26";
const toti = (oameni, zile) => {
  const d = {};
  for (const o of oameni) for (const z of zile) d[P.cheieZi(o.id, z)] = true;
  return d;
};

// ---- 1. Postul strâmt se dă primul -----------------------------------------
console.log("Postul greu de acoperit");
// Giri știe și extruderul, și flexo. Bam știe doar extruderul. Dacă Giri
// ajunge la extruder, flexo rămâne gol degeaba.
const oameni1 = [
  { id: 1, nume: "Giri", competente: [1, 12] },
  { id: 2, nume: "Bam", competente: [1] },
];
const r1 = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 1 },
            { utilaj_id: 12, cod: "UT12", denumire: "Flexo", schimburi: 1 }],
  oameni: oameni1,
  disponibil: toti(oameni1, [ZI]),
});
const pe = (r, cod, schimb) => (r.zile[0].sloturi.find((s) => s.cod === cod && s.schimb === schimb) || {});
bine("flexo îl ia Giri, singurul care-l știe", pe(r1, "UT12", "S1").nume === "Giri", pe(r1, "UT12", "S1"));
bine("extruderul îl ia Bam, deși Giri l-ar fi putut face", pe(r1, "UT01", "S1").nume === "Bam", pe(r1, "UT01", "S1"));
bine("amândouă posturile sunt acoperite", r1.neacoperite === 0, r1.zile[0].sloturi);

// ---- 2. Nimeni de două ori în aceeași zi -----------------------------------
console.log("\nUn om, un schimb pe zi");
const oameni2 = [{ id: 1, nume: "Singurul", competente: [1, 2] }];
const r2 = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 1 },
            { utilaj_id: 2, cod: "UT02", denumire: "Slitter", schimburi: 1 }],
  oameni: oameni2,
  disponibil: toti(oameni2, [ZI]),
});
bine("un singur post e acoperit, nu amândouă", r2.zile[0].acoperite === 1, r2.zile[0].sloturi);
bine("al doilea spune că toți erau deja puși",
  r2.zile[0].sloturi.filter((s) => !s.resursa_id)[0].motiv === P.MOTIVE.TOTI_OCUPATI,
  r2.zile[0].sloturi.filter((s) => !s.resursa_id)[0]);

// ---- 3. Disponibilitatea ---------------------------------------------------
console.log("\nDisponibilitatea");
const oameni3 = [{ id: 1, nume: "Vine", competente: [1] }, { id: 2, nume: "Nu vine", competente: [1] }];
const r3 = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 2 }],
  oameni: oameni3,
  disponibil: { [P.cheieZi(1, ZI)]: true },
});
bine("doar cine e disponibil intră în plan", r3.zile[0].acoperite === 1 && pe(r3, "UT01", "S1").nume === "Vine",
  r3.zile[0].sloturi);
bine("al doilea schimb rămâne gol fiindcă ceilalți nu sunt disponibili",
  pe(r3, "UT01", "S2").motiv === P.MOTIVE.TOTI_OCUPATI || pe(r3, "UT01", "S2").motiv === P.MOTIVE.NIMENI_DISPONIBIL,
  pe(r3, "UT01", "S2"));

const r3b = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 9, cod: "UT09", denumire: "Tăiat core", schimburi: 1 }],
  oameni: oameni3,
  disponibil: toti(oameni3, [ZI]),
});
bine("un utilaj pe care nu e trecut nimeni o spune pe față",
  pe(r3b, "UT09", "S1").motiv === P.MOTIVE.NIMENI_CALIFICAT, pe(r3b, "UT09", "S1"));

// ---- 4. Rotația schimburilor ----------------------------------------------
console.log("\nRotația schimburilor");
const oameni4 = [{ id: 1, nume: "A", competente: [1] }, { id: 2, nume: "B", competente: [1] }];
const r4 = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 2 }],
  oameni: oameni4,
  disponibil: toti(oameni4, [ZI]),
  schimbAnterior: { 1: "S1", 2: "S2" },
});
bine("cine a fost pe S1 săptămâna trecută nu prinde iar S1", pe(r4, "UT01", "S1").nume === "B", pe(r4, "UT01", "S1"));
bine("și invers, pe S2", pe(r4, "UT01", "S2").nume === "A", pe(r4, "UT01", "S2"));
bine("nicio regulă n-a fost încălcată", r4.incalcariRotatie.length === 0, r4.incalcariRotatie);

const oameni5 = [{ id: 1, nume: "Unicul", competente: [1] }];
const r5 = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 1 }],
  oameni: oameni5,
  disponibil: toti(oameni5, [ZI]),
  schimbAnterior: { 1: "S1" },
});
bine("regula se încalcă dacă altfel postul rămâne gol", pe(r5, "UT01", "S1").nume === "Unicul");
bine("dar încălcarea se raportează, pe om și pe zi",
  r5.incalcariRotatie.length === 1 && r5.incalcariRotatie[0].nume === "Unicul", r5.incalcariRotatie);

// ---- 5. Împărțirea încărcării ----------------------------------------------
console.log("\nÎmpărțirea încărcării");
const SAPT = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"];
const oameni6 = [
  { id: 1, nume: "A", competente: [1] }, { id: 2, nume: "B", competente: [1] }, { id: 3, nume: "C", competente: [1] },
];
const r6 = P.propune({
  zile: SAPT,
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 1 }],
  oameni: oameni6,
  disponibil: toti(oameni6, SAPT),
});
const zilePe = Object.values(r6.zilePePersoana).sort();
bine("patru zile se împart cât mai egal între trei oameni",
  zilePe.join() === "1,1,2" || zilePe.join() === "1,1,2", zilePe);
bine("nimeni nu prinde trei zile când altul are una", Math.max(...zilePe) - Math.min(...zilePe) <= 1, zilePe);

// ---- 6. Cine învață intră ultimul ------------------------------------------
console.log("\nNivelul de calificare");
const oameni7 = [
  { id: 1, nume: "Invata", competente: [1], nivel: { 1: 1 } },
  { id: 2, nume: "Poate", competente: [1], nivel: { 1: 2 } },
];
const r7 = P.propune({
  zile: [ZI],
  posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 1 }],
  oameni: oameni7,
  disponibil: toti(oameni7, [ZI]),
});
bine("între un om care poate și unul care învață, intră cel care poate",
  pe(r7, "UT01", "S1").nume === "Poate", pe(r7, "UT01", "S1"));

// ---- 7. Ce iese din propunere ----------------------------------------------
console.log("\nCe iese");
bine("programul e gata de scris pe om și pe zi",
  r6.program.length === 4 && r6.program.every((x) => x.resursa_id && x.data && x.schimb && x.post), r6.program[0]);
bine("se spune cine a rămas nefolosit în ziua aia", r1.zile[0].nefolositi.length === 0 && r2.zile[0].nefolositi.length === 0);
bine("a doua rulare dă exact același plan",
  JSON.stringify(P.propune({ zile: SAPT, posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "Extruder", schimburi: 1 }], oameni: oameni6, disponibil: toti(oameni6, SAPT) })) === JSON.stringify(r6));
bine("fără posturi cerute nu propune nimic", P.propune({ zile: [ZI], posturi: [], oameni: oameni6, disponibil: {} }).total === 0);
bine("fără oameni nu crapă, doar raportează golurile",
  P.propune({ zile: [ZI], posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "E", schimburi: 3 }], oameni: [], disponibil: {} }).neacoperite === 3);
bine("un utilaj cerut pe zero schimburi nu produce sloturi",
  P.propune({ zile: [ZI], posturi: [{ utilaj_id: 1, cod: "UT01", denumire: "E", schimburi: 0 }], oameni: oameni6, disponibil: toti(oameni6, [ZI]) }).zile[0].sloturi.length === 0);

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
