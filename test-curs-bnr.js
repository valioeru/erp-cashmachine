"use strict";
// Cursul BNR și prețul cu patru zecimale. Fără rețea, fără bază de date.
//
// CE APĂRĂ:
//
//   • MULTIPLICATORUL. Unele monede sunt cotate la 100 de unități:
//     `<Rate currency="HUF" multiplier="100">1.2345</Rate>` înseamnă 100 de
//     forinți, nu unul. Cine îl ignoră iese de o sută de ori pe lângă. La euro
//     nu se vede — n-are multiplicator — deci greșeala ar sta ascunsă până în
//     ziua în care cineva adaugă prima monedă care are.
//
//   • CURSUL SE SCRIE CU PATRU ZECIMALE. Rotunjit la două, 4,9723 devine 4,97;
//     la o comandă de 50.000 € înseamnă 115 lei diferență.
//
//   • PREȚUL UNITAR ȚINE PATRU ZECIMALE, DAR NU LE ARATĂ DEGEABA. 0,4235 lei
//     pe pungă × 500.000 de bucăți: rotunjirea la 0,42 pierde 1.750 de lei pe
//     o singură linie. Dar 23,50 nu trebuie scris „23,5000".
//
//   • FĂRĂ CURS NU SE INVENTEAZĂ O CIFRĂ. O sumă în lei scoasă dintr-un curs
//     ghicit arată exact ca una adevărată, și pe aia o trece cineva mai departe.
const C = require("./lib/curs-bnr");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 220) : ""));
    esecuri++;
  }
}

// Fișierul BNR, scurtat, cu forma lui adevărată.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd">
  <Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-10-27</PublishingDate></Header>
  <Body>
    <Subject>Reference rates</Subject>
    <OrigCurrency>RON</OrigCurrency>
    <Cube date="2026-10-27">
      <Rate currency="AED">1.3537</Rate>
      <Rate currency="EUR">4.9723</Rate>
      <Rate currency="HUF" multiplier="100">1.2345</Rate>
      <Rate currency="JPY" multiplier="100">3.2918</Rate>
      <Rate currency="USD">4.5612</Rate>
      <Rate currency="XDR">6.1234</Rate>
    </Cube>
  </Body>
</DataSet>`;

console.log("Citirea fișierului BNR");
{
  const r = C.parseaza(XML);
  bine("se citește", Boolean(r), r);
  bine("ia data cursului", r.data === "2026-10-27", r.data);
  bine("euro e acolo, întreg", Math.abs(r.cursuri.EUR - 4.9723) < 1e-9, r.cursuri.EUR);
  bine("dolarul la fel", Math.abs(r.cursuri.USD - 4.5612) < 1e-9, r.cursuri.USD);

  // Miezul testului.
  bine("FORINTUL e împărțit la 100", Math.abs(r.cursuri.HUF - 0.012345) < 1e-12, r.cursuri.HUF);
  bine("yenul la fel", Math.abs(r.cursuri.JPY - 0.032918) < 1e-12, r.cursuri.JPY);
  bine("nu e luat ca atare", r.cursuri.HUF !== 1.2345);

  bine("ia toate monedele din fișier", Object.keys(r.cursuri).length === 6, Object.keys(r.cursuri));
}
{
  bine("un fișier gol nu crapă, dă null", C.parseaza("") === null);
  bine("nici text care nu e XML-ul lor", C.parseaza("<html>eroare 503</html>") === null);
  bine("nici null", C.parseaza(null) === null);
  bine("un Cube fără rânduri dă null", C.parseaza('<Cube date="2026-10-27"></Cube>') === null);
  // Un rand stricat nu are voie sa darame tot fisierul.
  const r = C.parseaza('<Cube date="2026-10-27"><Rate currency="EUR">nu-i numar</Rate><Rate currency="USD">4.56</Rate></Cube>');
  bine("un rând stricat se sare, restul se citesc", r && !r.cursuri.EUR && r.cursuri.USD === 4.56, r);
  bine("un multiplicator de zero nu dă împărțire la zero",
    !C.parseaza('<Cube date="2026-10-27"><Rate currency="HUF" multiplier="0">1.23</Rate></Cube>'));
}

console.log("\nȘi dacă BNR scrie fișierul altfel");
{
  // Prefix de spatiu de nume si ghilimele simple: forme valide de XML pe care
  // un parser scris strict le-ar rata, iar ERP-ul ar cadea tacut pe cursul
  // implicit — adica ar arata cifre vechi fara sa spuna nimanui.
  const cuPrefix = `<bnr:Cube bnr:date='2026-10-27'>
      <bnr:Rate currency='EUR'>4.9723</bnr:Rate>
      <bnr:Rate currency='HUF' multiplier='100'>1.2345</bnr:Rate>
    </bnr:Cube>`;
  const r = C.parseaza(cuPrefix);
  bine("merge și cu prefix de spațiu de nume", Boolean(r) && Math.abs(r.cursuri.EUR - 4.9723) < 1e-9, r);
  bine("și multiplicatorul tot se respectă", r && Math.abs(r.cursuri.HUF - 0.012345) < 1e-12, r && r.cursuri.HUF);
  bine("moneda scrisă cu litere mici se ridică la majuscule",
    Boolean(C.parseaza(`<Cube date="2026-10-27"><Rate currency="eur">4.97</Rate></Cube>`).cursuri.EUR));

  // Dar o pagina de eroare NU are voie sa treaca drept curs.
  bine("o pagină HTML de blocare nu trece",
    C.parseaza('<!DOCTYPE html><html><body>Access denied. date="2026-10-27"</body></html>') === null);
  bine("nici un JSON", C.parseaza('{"EUR":4.97,"date":"2026-10-27"}') === null);
}

console.log("\nFișierul cu zece zile");
{
  // Fisierul de rezerva are zece Cube-uri. Trebuie luat cel mai NOU, nu
  // primul din fisier: un curs de acum noua zile scris pe o comanda de azi
  // n-ar da nicio eroare — ar da doar o suma gresita, care arata bine.
  const zeceZile = `<DataSet><Body>
    <Cube date="2026-10-20"><Rate currency="EUR">4.9000</Rate></Cube>
    <Cube date="2026-10-26"><Rate currency="EUR">5.3467</Rate></Cube>
    <Cube date="2026-10-23"><Rate currency="EUR">5.1000</Rate></Cube>
  </Body></DataSet>`;
  const r = C.parseaza(zeceZile);
  bine("ia ziua cea mai nouă, nu prima din fișier", r.data === "2026-10-26", r.data);
  bine("și cursul ei", Math.abs(r.cursuri.EUR - 5.3467) < 1e-9, r.cursuri.EUR);
}

console.log("\nSocoteala în lei");
{
  bine("leii rămân lei", C.inLei(100, "RON", 4.9723) === 100);
  bine("euro se înmulțește", Math.abs(C.inLei(1000, "EUR", 4.9723) - 4972.3) < 1e-9, C.inLei(1000, "EUR", 4.9723));
  bine("moneda scrisă cu litere mici tot merge", C.inLei(1000, "eur", 4.9723) === C.inLei(1000, "EUR", 4.9723));
  bine("fără curs dă 0, nu NaN", C.inLei(1000, "EUR", 0) === 0 && C.inLei(1000, "EUR", null) === 0);
  bine("o sumă care nu e număr dă 0", C.inLei("x", "EUR", 4.97) === 0);
  // Rotunjirea se face la final, nu pe linie.
  const peLinii = [0.4235, 0.4235, 0.4235].reduce((s, p) => s + C.inLei(p * 100000, "EUR", 4.9723), 0);
  const deodata = C.inLei(0.4235 * 300000, "EUR", 4.9723);
  bine("suma pe linii e aceeași cu suma deodată", Math.abs(peLinii - deodata) < 1e-6, { peLinii, deodata });
}

console.log("\nCum se scriu cifrele");
{
  bine("cursul are patru zecimale", C.scrieCurs(4.9723) === "4,9723", C.scrieCurs(4.9723));
  bine("și un curs rotund tot patru", C.scrieCurs(5) === "5,0000", C.scrieCurs(5));
  bine("un curs lipsă nu se scrie deloc", C.scrieCurs(0) === "" && C.scrieCurs(null) === "");

  bine("prețul rotund se scrie cu două zecimale", C.scriePret(23.5) === "23,50", C.scriePret(23.5));
  bine("prețul întreg la fel", C.scriePret(7) === "7,00", C.scriePret(7));
  bine("dar patru zecimale se păstrează", C.scriePret(0.4235) === "0,4235", C.scriePret(0.4235));
  bine("și trei se scriu tot pe patru", C.scriePret(0.423) === "0,4230", C.scriePret(0.423));
  bine("a cincea zecimală se rotunjește, nu se taie", C.scriePret(0.42356) === "0,4236", C.scriePret(0.42356));
  bine("zero e zero", C.scriePret(0) === "0,00", C.scriePret(0));
  bine("ce nu e număr nu dă NaN pe ecran", C.scriePret("x") === "0,00", C.scriePret("x"));

  bine("totalurile rămân pe două zecimale", C.scrieSuma(4972.3) === "4.972,30", C.scrieSuma(4972.3));
}

console.log("\nCe scrie sub totalul comenzii");
{
  bine("la lei nu scrie nimic", C.explica(1000, "RON", 4.9723, "2026-10-27") === "");
  const t = C.explica(1000, "EUR", 4.9723, "2026-10-27");
  bine("la euro scrie echivalentul", t.indexOf("4.972,30 lei") !== -1, t);
  bine("și cursul folosit", t.indexOf("4,9723") !== -1, t);
  bine("și ziua cursului", t.indexOf("2026-10-27") !== -1, t);

  // Asta e regula care conteaza.
  const f = C.explica(1000, "EUR", 0, "");
  bine("fără curs NU scrie nicio cifră în lei", !/\d/.test(f.replace(/BNR/g, "")), f);
  bine("și spune limpede de ce", f.indexOf("nu a putut fi luat") !== -1, f);
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
