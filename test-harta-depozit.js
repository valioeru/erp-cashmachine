"use strict";
// Harta depozitului: randuri, etaje, locuri.
//
// CE APARA:
//
//   • UN PALET LAT OCUPA LOCURI VECINE, PE ACELASI ETAJ. Doua locuri alese
//     la intamplare, unul jos in randul 1 si unul sus in randul 7, nu sunt
//     „un palet pe doua locuri" — sunt doua clickuri gresite. Daca trec,
//     harta minte de-atunci incolo si nimeni nu stie de cand.
//
//   • NU SE PUNE MARFA PESTE MARFA. Se descopera altfel abia cu
//     motostivuitorul in fata raftului.
//
//   • UN LOC BLOCAT NU SE ALEGE, nici daca e gol.
//
//   • ETAJELE SE DESENEAZA DE SUS IN JOS, cum arata raftul cand stai in
//     fata lui. Daca ies invers, omul citeste harta pe dos si pune marfa pe
//     alt etaj.
const path = require("path");
const H = require(path.join(__dirname, "lib", "harta-depozit.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 200) : "")); esecuri++; }
}

console.log("\n1. Codul locului se citeste in bucati");
{
  const b = H.bucati("A-03-2-1");
  bine("zona, randul, etajul, pozitia", b.zona === "A" && b.rand === 3 && b.nivel === 2 && b.pozitie === 1, JSON.stringify(b));
  const f = H.bucati("B-10-4");
  bine("fara pozitie, se considera prima", f.pozitie === 1 && f.rand === 10 && f.nivel === 4, JSON.stringify(f));
  // Un loc scris de mana („langa usa") e valid ca loc, doar ca nu apare pe
  // harta. Nu e o eroare.
  bine("un cod liber nu se poate citi, si e in regula", H.bucati("langa usa") === null);
  bine("nici gol", H.bucati("") === null && H.bucati(null) === null);
  bine("literele mici merg la fel", H.bucati("a-03-2").zona === "A");
}

console.log("\n2. Aranjarea pentru desen");
{
  const locuri = [
    { id: 1, cod: "A-01-1-1" }, { id: 2, cod: "A-01-1-2" },
    { id: 3, cod: "A-01-2-1" }, { id: 4, cod: "A-02-1-1" },
    { id: 5, cod: "B-01-1-1" }, { id: 6, cod: "langa usa" },
  ];
  const h = H.aranjeaza(locuri, []);
  bine("doua zone", h.zone.length === 2 && h.zone[0].zona === "A" && h.zone[1].zona === "B");
  bine("zona A are doua randuri", h.zone[0].randuri.length === 2);
  bine("randul 1 are doua etaje", h.zone[0].randuri[0].niveluri.length === 2);
  // De sus in jos, ca raftul real.
  bine("etajele vin de sus in jos", h.zone[0].randuri[0].niveluri[0].nivel === 2, h.zone[0].randuri[0].niveluri[0].nivel);
  bine("etajul 1 are doua locuri, in ordine", h.zone[0].randuri[0].niveluri[1].celule.map((c) => c.pozitie).join() === "1,2");
  bine("locul scris de mana sta deoparte, nu se pierde", h.fara.length === 1 && h.fara[0].cod === "langa usa");
}

console.log("\n3. Ce e liber si ce nu");
{
  const locuri = [
    { id: 1, cod: "A-01-1-1" },
    { id: 2, cod: "A-01-1-2" },
    { id: 3, cod: "A-01-1-3", blocat: 1 },
  ];
  const stoc = [{ loc_id: 1, produs_text: "Folie", cantitate: 120 }];
  const h = H.aranjeaza(locuri, stoc);
  const c = h.zone[0].randuri[0].niveluri[0].celule;
  bine("locul cu marfa e ocupat", c[0].ocupat === true && c[0].cantitate === 120);
  bine("si nu e liber", c[0].liber === false);
  bine("locul gol e liber", c[1].liber === true);
  // Blocat si gol in acelasi timp: tot nu se poate folosi.
  bine("locul blocat e gol DAR nu e liber", c[2].ocupat === false && c[2].liber === false);
  bine("continutul se vede pe loc", c[0].continut[0].produs_text === "Folie");

  const z = H.rezumat(c);
  bine("rezumatul: 1 ocupat, 1 liber, 1 blocat", z.ocupate === 1 && z.libere === 1 && z.blocate === 1);
  // Procentul se raporteaza la ce se poate folosi, nu la tot.
  bine("procentul ignora locurile blocate", z.procentOcupat === 50, z.procentOcupat);
  bine("o harta goala nu imparte la zero", H.rezumat([]).procentOcupat === 0);
}

console.log("\n4. Un palet pe mai multe locuri");
{
  const l = (cod, extra) => Object.assign({ cod, liber: true, ocupat: false, blocat: false }, H.bucati(cod), extra || {});

  const unul = H.validareSelectie([l("A-01-2-1")]);
  bine("un singur loc: trece", !unul.eroare, unul.eroare);

  const doua = H.validareSelectie([l("A-01-2-1"), l("A-01-2-2")]);
  bine("doua locuri vecine pe acelasi etaj: trece", !doua.eroare, doua.eroare);
  const trei = H.validareSelectie([l("A-01-2-1"), l("A-01-2-2"), l("A-01-2-3")]);
  bine("trei vecine: trece", !trei.eroare, trei.eroare);
  // Ordinea in care s-a dat click nu conteaza.
  bine("ordinea clickurilor nu conteaza", !H.validareSelectie([l("A-01-2-3"), l("A-01-2-1"), l("A-01-2-2")]).eroare);

  const alt_rand = H.validareSelectie([l("A-01-2-1"), l("A-02-2-1")]);
  bine("doua randuri diferite: refuzat", !!alt_rand.eroare);
  bine("si se spune de ce", /un singur rând/.test(alt_rand.eroare), alt_rand.eroare);

  const alt_etaj = H.validareSelectie([l("A-01-2-1"), l("A-01-3-1")]);
  bine("doua etaje: refuzat", !!alt_etaj.eroare);
  bine("cu mesajul potrivit", /nu stă pe două etaje/.test(alt_etaj.eroare), alt_etaj.eroare);

  const gaura = H.validareSelectie([l("A-01-2-1"), l("A-01-2-3")]);
  bine("locuri cu o gaura intre ele: refuzat", !!gaura.eroare);
  bine("si se spune care sunt", /1, 3/.test(gaura.eroare), gaura.eroare);

  const alta_zona = H.validareSelectie([l("A-01-2-1"), l("B-01-2-2")]);
  bine("zone diferite: refuzat", !!alta_zona.eroare);
}

console.log("\n5. Ocupat si blocat la alegere");
{
  const l = (cod, extra) => Object.assign({ cod, liber: true, ocupat: false, blocat: false }, H.bucati(cod), extra || {});
  const peste = H.validareSelectie([l("A-01-2-1", { ocupat: true, liber: false })]);
  bine("nu se pune marfa peste marfa", !!peste.eroare);
  bine("si mesajul spune ce sa faca", /scoate întâi ce e acolo/.test(peste.eroare), peste.eroare);

  const doua = H.validareSelectie([l("A-01-2-1", { ocupat: true }), l("A-01-2-2", { ocupat: true })]);
  bine("la mai multe ocupate le numeste pe toate", /A-01-2-1, A-01-2-2/.test(doua.eroare), doua.eroare);

  const blocat = H.validareSelectie([l("A-01-2-1", { blocat: true })]);
  bine("locul blocat nu se alege nici gol", !!blocat.eroare && /blocat/.test(blocat.eroare));

  // Exista cazuri in care chiar vrei sa adaugi peste (acelasi produs, acelasi
  // lot). Atunci se cere explicit.
  bine("cu permiteOcupate se poate adauga peste", !H.validareSelectie([l("A-01-2-1", { ocupat: true })], { permiteOcupate: true }).eroare);
  // Dar blocat ramane blocat, oricum.
  bine("blocat ramane blocat si asa", !!H.validareSelectie([l("A-01-2-1", { blocat: true })], { permiteOcupate: true }).eroare);

  bine("nimic ales", !!H.validareSelectie([]).eroare);
}

console.log("\n6. Facerea codurilor");
{
  bine("A-03-2-1", H.codDin("A", 3, 2, 1) === "A-03-2-1", H.codDin("A", 3, 2, 1));
  bine("randul se scrie cu doua cifre", H.codDin("a", 7, 1, 2) === "A-07-1-2", H.codDin("a", 7, 1, 2));
  bine("fara pozitie, codul e scurt", H.codDin("B", 12, 4) === "B-12-4", H.codDin("B", 12, 4));
  // Codul facut trebuie sa se poata citi inapoi — altfel harta nu-si
  // recunoaste propriile locuri.
  const c = H.codDin("C", 5, 3, 2);
  const b = H.bucati(c);
  bine("ce se scrie se poate citi inapoi", b.zona === "C" && b.rand === 5 && b.nivel === 3 && b.pozitie === 2, c);
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
