"use strict";
// Produsul configurat pe comanda agentului. Fără bază de date.
//
// CE APĂRĂ:
//
//   • UN CÂMP LĂSAT GOL NU TRECE DREPT COMPLETAT. Dacă `c_7=""` ar ajunge în
//     alegeri ca string gol, caracteristica ar părea aleasă, n-ar mai apărea
//     în „mai lipsește", iar codul ar ieși mai scurt și s-ar lovi de al
//     altui produs. Ăsta e bugul care sparge stocul în tăcere.
//
//   • NUMAI CÂMPURILE DE CARACTERISTICI SE CITESC CA ATARE. În același corp
//     POST vin și `cantitate`, `moneda`, `client_cautat`. Niciunul n-are voie
//     să ajungă caracteristica nr. NaN.
//
//   • „EXISTĂ DEJA" NU OPREȘTE COMANDA. La ecranul de produs nou e o
//     piedică; pe comandă e exact ce vrei — agentul trebuie să cadă pe
//     ACELAȘI produs, nu să facă al doilea cu același cod.
//
//   • MESAJUL E ACELAȘI ÎN BROWSER ȘI PE SERVER. Dacă previzualizarea ar
//     spune una și refuzul alta, agentul ar vedea „gata" și apoi „lipsește
//     grosimea" fără să înțeleagă ce s-a schimbat.
const K = require("./lib/comanda-config");
const C = require("./lib/cod-produs");
const { START } = require("./lib/cod-familii");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 220) : ""));
    esecuri++;
  }
}

// Caracteristicile unei familii, în forma pe care o scoate baza de date.
function caracteristici(lista) {
  return lista.map((c, i) => {
    const [nume, fel, um, ordine, cifre, valori, minv, maxv, inCod, oblig] = c;
    return {
      id: i + 1, nume, fel, um: um || null, activ: 1,
      in_cod: inCod === 0 ? 0 : 1, ordine, obligatoriu: oblig === 0 ? 0 : 1,
      cifre: cifre || 0, min_val: minv == null ? null : minv, max_val: maxv == null ? null : maxv,
      familie_id: 2, creat_la: "2026-10-27",
      valori: (valori || []).map((v, k) => ({ id: k + 1, valoare: v[0], cod: v[1], ordine: k + 1, activ: 1 })),
    };
  });
}
const pungi = caracteristici(START.find((f) => f[0] === "Pungă curier")[2]);
const dupaNume = new Map(pungi.map((c) => [c.nume, c.id]));
const id = (n) => dupaNume.get(n);

console.log("Ce se citește din formular");
{
  const corp = {
    "c_1": "Pungă curier", "c_2": "Imprimată", "c_3": "  ", "c_4": "350",
    cantitate: "1000", moneda: "RON", client_cautat: "Sameday", "c_": "x", "c_abc": "y", "c_0": "z", "c_-2": "w",
  };
  const a = K.alegeriDin(corp);
  bine("ia doar câmpurile de caracteristici", Object.keys(a).sort().join(",") === "1,2,4", a);
  bine("câmpul gol nu trece drept completat", a[3] === undefined, a);
  bine("cantitatea și moneda nu devin caracteristici", a.cantitate === undefined && a.moneda === undefined);
  bine("nu crapă pe corp gol", Object.keys(K.alegeriDin(null)).length === 0);
}

console.log("\nCâmpurile trimise în pagină");
{
  const campuri = K.campuriFamiliei(pungi);
  bine("sunt toate caracteristicile active", campuri.length === pungi.length, campuri.length);
  bine("vin în ordinea din configurare", campuri.every((c, i) => i === 0 || campuri[i - 1].id <= c.id));
  const grosime = campuri.find((c) => c.nume === "Grosime");
  bine("numărul se trimite ca număr, cu unitatea lui", grosime && grosime.fel === "numar" && grosime.um === "microni", grosime);
  const inchidere = campuri.find((c) => c.nume === "Tip închidere");
  bine("lista vine cu valorile ei", inchidere && inchidere.valori.length >= 2, inchidere);
  const brut = JSON.stringify(campuri);
  bine("nu scapă coloane de bază de date în pagină",
    brut.indexOf("creat_la") === -1 && brut.indexOf("familie_id") === -1 && brut.indexOf("cifre") === -1);
  bine("inactivele nu se trimit",
    K.campuriFamiliei(pungi.map((c, i) => (i === 0 ? { ...c, activ: 0 } : c))).length === pungi.length - 1);
}

console.log("\nFamiliile pentru pagină");
{
  const pePagina = K.familiiPentruPagina(
    [{ id: 2, nume: "Pungă curier", exemplu: "PCIA35045045", activ: 1 }],
    { 2: pungi }
  );
  bine("familia își poartă câmpurile", pePagina[0].campuri.length === pungi.length);
  bine("familia își poartă exemplul", pePagina[0].exemplu === "PCIA35045045");
  bine("o familie fără caracteristici nu crapă", K.familiiPentruPagina([{ id: 9, nume: "X" }], {})[0].campuri.length === 0);
}

console.log("\nCe se poate pune pe comandă");
{
  const complet = {};
  for (const [n, v] of Object.entries({
    Tip: "Pungă curier", Imprimare: "Imprimată", "Culoare folie": "Alb", "Lățime": 350,
    "Lungime fără clapetă": 450, Grosime: 45, "Clapetă": 50, "Tip închidere": "Bandă adezivă",
  })) complet[id(n)] = v;

  const r = C.genereazaCod(pungi, complet);
  bine("configurat complet, codul iese", r.cod === "PCIA35045045", r.cod);
  bine("configurat complet se poate comanda", K.sePoateComanda({ ...r, exista: null }));

  const pePjumatate = C.genereazaCod(pungi, { [id("Tip")]: "Pungă curier", [id("Imprimare")]: "Imprimată" });
  bine("pe jumătate NU se poate comanda", !K.sePoateComanda({ ...pePjumatate, exista: null }));
  bine("și spune ce lipsește",
    K.motivRefuz(pePjumatate, "Pungă curier").indexOf("mai lipsește") !== -1,
    K.motivRefuz(pePjumatate, "Pungă curier"));
  bine("refuzul numește familia", K.motivRefuz(pePjumatate, "Pungă curier").indexOf("Pungă curier") !== -1);

  // Ăsta e miezul: un produs care există deja TREBUIE lăsat pe comandă.
  const existent = { ...r, exista: { id: 77, denumire: "Pungă curier imprimată", cod_generat: "PCIA35045045" } };
  bine("produsul care există deja se poate comanda", K.sePoateComanda(existent));
  bine("și se vede că e cel vechi, cu codul lui",
    K.rezumat(existent).indexOf("PCIA35045045") !== -1 && K.rezumat(existent).indexOf("există deja") !== -1,
    K.rezumat(existent));

  bine("nimic completat = refuz cu îndrumare spre catalog",
    K.motivRefuz(C.genereazaCod(pungi, {}), "Pungă curier", true).indexOf("catalog") !== -1,
    K.motivRefuz(C.genereazaCod(pungi, {}), "Pungă curier", true));

  // Zeroul tastat in plus. La pungi nu exista min/max, deci numarul de cifre
  // e singura plasa — si trebuie sa tina.
  const gresit = { ...complet, [id("Lățime")]: 3500 };
  const rg = C.genereazaCod(pungi, gresit);
  bine("o lățime cu un zero în plus nu trece", !K.sePoateComanda({ ...rg, exista: null }), { cod: rg.cod, gresite: rg.gresite });
  bine("și scrie că nu încape în locul ei",
    K.rezumat({ ...rg, exista: null }).indexOf("cifre") !== -1, K.rezumat({ ...rg, exista: null }));
  bine("codul greșit nu iese deloc, nici scurt nici lung", !rg.ok, rg.cod);

  // Dar o valoare care incape fix trebuie sa treaca.
  const laLimita = { ...complet, [id("Lățime")]: 999 };
  bine("valoarea care încape fix trece", C.genereazaCod(pungi, laLimita).ok);
}

console.log("\nMesajul e unul singur");
{
  const r = C.genereazaCod(pungi, { [id("Tip")]: "Pungă curier" });
  bine("rezumatul nu e gol când lipsesc caracteristici", K.rezumat({ ...r, exista: null }).length > 10);
  bine("rezumatul e gol când e totul în regulă",
    K.rezumat({ cod: "X", lipsa: [], gresite: [], ambiguu: false, exista: null }) === "");
  bine("rezumatul nu crapă pe nimic", K.rezumat(null) === "" && K.rezumat(undefined) === "");
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
