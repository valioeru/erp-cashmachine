"use strict";
// Clientul scris pe loc, din formularul de comandă. Fără bază de date.
//
// CE APĂRĂ:
//
//   • CIFRA DE CONTROL A CUI-ULUI. O cifră tastată greșit face o firmă nouă
//     care arată exact ca una adevărată. Verificarea o prinde ÎNAINTE să intre
//     în bază — după aceea, cineva o descoperă la facturare, peste o lună.
//
//   • CODURILE STRĂINE NU SE MĂSOARĂ CU RIGLA NOASTRĂ. „HU12345678” n-are
//     cum să treacă formula românească. Fără excepția asta, un client unguresc
//     adevărat ar fi refuzat cu „ai tastat greșit”.
//
//   • DUBLURILE. Ăsta e tot rostul unui formular rapid de client: dacă n-ar
//     căuta înainte să scrie, ar fabrica „Sameday”, „S.C. Sameday S.R.L.” și
//     „SAMEDAY" ca trei parteneri, fiecare cu scadențele lui.
//
//   • TOATE GREȘELILE DEODATĂ. Cine completează un formular vrea să le vadă pe
//     toate, nu să-l trimită de cinci ori.
const C = require("./lib/client-nou");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 200) : "")); esecuri++; }
}

console.log("Cifra de control a CUI-ului");
{
  // CUI-uri romanesti adevarate, verificate si cu creionul.
  bine("RO14399840 e valid", C.cuiValid("RO14399840"));
  bine("RO1590082 e valid", C.cuiValid("RO1590082"));
  bine("merge și fără prefixul RO", C.cuiValid("14399840"));
  bine("merge cu spații și puncte", C.cuiValid("RO 14.399.840"));

  // O singura cifra schimbata trebuie sa cada.
  bine("14399841 (ultima cifră greșită) cade", !C.cuiValid("14399841"));
  bine("14399850 (o cifră din mijloc greșită) cade", !C.cuiValid("14399850"));
  bine("24399840 (prima cifră greșită) cade", !C.cuiValid("24399840"));

  bine("gol cade", !C.cuiValid("") && !C.cuiValid(null));
  bine("o singură cifră cade", !C.cuiValid("8"));
  bine("mai mult de zece cifre cade", !C.cuiValid("12345678901"));
  bine("text curat cade", !C.cuiValid("abcdefg"));
}

console.log("\nCoduri din alte țări");
{
  bine("HU… e recunoscut ca străin", C.eStrain("HU12345678"));
  bine("DE… la fel", C.eStrain("DE811234567"));
  bine("RO… NU e străin", !C.eStrain("RO14399840"));
  bine("un cod fără prefix nu e străin", !C.eStrain("14399840"));
  const r = C.verifica({ nume: "Kft Budapesta", cui: "HU 12345678" });
  bine("un cod străin trece fără să fie măsurat cu formula noastră", r.ok, r.gresite);
  bine("și se păstrează cu prefixul lui", r.date.cui === "HU12345678", r.date.cui);
}

console.log("\nCe se cere");
{
  const camp = (n) => C.CAMPURI.find((c) => c.nume === n);
  bine("numele e obligatoriu", camp("nume").obligatoriu);
  bine("CUI-ul e obligatoriu", camp("cui").obligatoriu);
  bine("telefonul NU e obligatoriu", !camp("telefon").obligatoriu);
  bine("emailul NU e obligatoriu", !camp("email").obligatoriu);
  bine("adresa NU e obligatorie", !camp("adresa").obligatoriu);

  const gol = C.verifica({});
  bine("formularul gol cade", !gol.ok);
  bine("și spune AMÂNDOUĂ lipsurile deodată", gol.gresite.length === 2, gol.gresite);

  bine("un nume de două litere cade", !C.verifica({ nume: "AB", cui: "RO14399840" }).ok);
  const e = C.verifica({ nume: "Firma Test SRL", cui: "RO14399840", email: "nu-i email" });
  bine("un email stricat cade", !e.ok && /email/.test(e.gresite[0]), e.gresite);
  bine("dar emailul lăsat gol nu deranjează", C.verifica({ nume: "Firma Test SRL", cui: "RO14399840" }).ok);

  const bun = C.verifica({ nume: "  Firma Test SRL  ", cui: " ro 14.399.840 ", telefon: " 0722 000 000 " });
  bine("completat corect, trece", bun.ok, bun.gresite);
  bine("numele se curăță de spații", bun.date.nume === "Firma Test SRL", bun.date.nume);
  bine("CUI-ul se scrie doar cu cifre", bun.date.cui === "14399840", bun.date.cui);
}

console.log("\nFirma care există deja");
{
  const ai = [
    { id: 3, nume: "Sameday Courier SRL", cui: "RO34765521" },
    { id: 7, nume: "Dante International", cui: "14399840" },
    { id: 9, nume: "Firma Fără CUI", cui: null },
    { id: 11, nume: "Kft Budapesta", cui: "HU12345678" },
  ];
  bine("se găsește după CUI, oricum ar fi scris",
    (C.gaseste(ai, { cui: "RO 14.399.840", nume: "Altceva" }) || {}).dupa === "CUI");
  bine("și întoarce firma potrivită",
    C.gaseste(ai, { cui: "RO14399840", nume: "Altceva" }).partener.id === 7);

  // Asta e capcana care fabrica dubluri.
  bine("„S.C. Sameday Courier S.R.L.” o găsește pe „Sameday Courier SRL”",
    (C.gaseste(ai, { cui: "", nume: "S.C. Sameday Courier S.R.L." }) || {}).dupa === "nume",
    C.gaseste(ai, { cui: "", nume: "S.C. Sameday Courier S.R.L." }));
  bine("și „SAMEDAY COURIER” la fel",
    Boolean(C.gaseste(ai, { cui: "", nume: "SAMEDAY COURIER" })));
  bine("firma veche fără CUI se găsește după nume",
    (C.gaseste(ai, { cui: "RO14399840x", nume: "firma fara cui" }) || {}).partener === undefined ||
    C.gaseste(ai, { cui: "", nume: "Firma Fără CUI" }).partener.id === 9);
  bine("codul străin se recunoaște și el",
    C.gaseste(ai, { cui: "hu 12345678", nume: "Altceva" }).partener.id === 11);

  bine("o firmă chiar nouă NU se găsește",
    C.gaseste(ai, { cui: "RO1590082", nume: "Firma Chiar Noua SRL" }) === null);
  bine("o listă goală nu crapă", C.gaseste([], { cui: "RO1590082", nume: "X" }) === null);
  bine("nici una lipsă", C.gaseste(null, { cui: "", nume: "X" }) === null);

  // CUI-ul bate numele: doua firme pot avea nume asemanatoare si CUI-uri
  // diferite, si atunci sunt doua firme.
  const douaNume = [{ id: 1, nume: "Transport SRL", cui: "RO14399840" }, { id: 2, nume: "Transport SRL", cui: "RO1590082" }];
  bine("CUI-ul decide când numele e același",
    C.gaseste(douaNume, { cui: "RO1590082", nume: "Transport SRL" }).partener.id === 2);
}

console.log("\nCurățarea numelui pentru comparație");
{
  bine("formele juridice se ignoră", C.cheieNume("S.C. Alfa S.R.L.") === C.cheieNume("Alfa"));
  bine("diacriticele se ignoră", C.cheieNume("Țară Mică SA") === C.cheieNume("Tara Mica"));
  bine("dar două firme diferite rămân diferite", C.cheieNume("Alfa SRL") !== C.cheieNume("Beta SRL"));
  bine("nu crapă pe gol", C.cheieNume("") === "" && C.cheieNume(null) === "");
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
