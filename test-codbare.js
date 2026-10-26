"use strict";
// Codul de bare de pe fișa însoțitoare. Desen pur, fără bază de date.
//
// CE APĂRĂ:
//
//   • UN COD GREȘIT E MAI RĂU DECÂT NICIUN COD. Dacă tabela de simboluri are
//     o singură linie strâmbă, fișa iese tipărită frumos, scannerul citește
//     altceva decât scrie sub cod, iar operatorul raportează ora de început
//     la altă comandă. Nimeni nu descoperă asta în hală — se vede abia în
//     raport, peste o săptămână. De-aia tabela se verifică aici, nu la ochi.
//
//   • STRUCTURA CODE 128 ESTE VERIFICABILĂ SINGURĂ. Fiecare simbol are 3
//     benzi și 3 spații, 11 module, iar lățimea totală a benzilor e mereu
//     pară. O greșeală de tastare în tabelă strică aproape sigur una din
//     reguli.
//
//   • CIFRA DE CONTROL ȘI SIMBOLURILE ÎNCEPUT/SFÂRȘIT. Valorile pentru
//     „CMP142.030” sunt cele pe care le scoate și reportlab, o implementare
//     complet separată (vezi test-codbare-reportlab.py, rulat o dată la
//     scrierea fișierului).
//
//   • DIACRITICELE NU AJUNG ÎN COD. Code 128-B nu le știe. Dacă ar trece,
//     codul ar spune altceva decât textul de sub el.
const CB = require("./lib/codbare");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 200) : "")); esecuri++; }
}

// ---- 1. Tabela de simboluri -----------------------------------------------
console.log("Tabela de simboluri");
bine("are exact 107 simboluri", CB.TIPARE.length === 107, CB.TIPARE.length);

let structuraRea = [];
let paritateRea = [];
for (let i = 0; i < 106; i++) {
  const t = CB.TIPARE[i];
  const cifre = t.split("").map(Number);
  const suma = cifre.reduce((a, b) => a + b, 0);
  if (t.length !== 6 || suma !== 11 || cifre.some((c) => c < 1 || c > 4)) structuraRea.push(i);
  const benzi = cifre[0] + cifre[2] + cifre[4];
  if (benzi % 2 !== 0) paritateRea.push(i);
}
bine("fiecare simbol are 3 benzi + 3 spații pe 11 module", structuraRea.length === 0, structuraRea);
bine("lățimea benzilor e pară la fiecare simbol", paritateRea.length === 0, paritateRea);
bine("simbolul STOP are 7 elemente pe 13 module",
  CB.TIPARE[106].length === 7 && CB.TIPARE[106].split("").reduce((a, b) => a + Number(b), 0) === 13,
  CB.TIPARE[106]);
bine("toate cele 107 simboluri sunt distincte", new Set(CB.TIPARE).size === 107, new Set(CB.TIPARE).size);

// ---- 2. Codarea unui cod real de pe fișă -----------------------------------
console.log("\nCodarea");
// Valorile de referință: [104, 35, 45, 48, 17, 20, 18, 14, 16, 19, 16, 73, 106]
// — start B, cele zece caractere, cifra de control 73, stop. Aceleași cifre
// le scoate reportlab.graphics.barcode.code128 pentru „CMP142.030”.
function dinValori(valori) {
  let out = "";
  for (const v of valori) {
    const t = CB.TIPARE[v];
    for (let i = 0; i < t.length; i++) out += (i % 2 === 0 ? "1" : "0").repeat(Number(t[i]));
  }
  return out;
}
const refBiti = dinValori([104, 35, 45, 48, 17, 20, 18, 14, 16, 19, 16, 73, 106]);
bine("„CMP142.030” dă exact modulele din referință", CB.benzi("CMP142.030") === refBiti);
bine("codul începe cu banda de start 2-1-1-2-1-4", CB.benzi("CMP142.030").startsWith("11010010000"));
bine("codul se termină cu bara de sfârșit", CB.benzi("CMP142.030").endsWith("1100011101011"));
bine("lungimea = 11 module/caracter + 35", CB.benzi("CMP142.030").length === (10 + 2) * 11 + 13,
  CB.benzi("CMP142.030").length);
bine("alt text dă alt cod", CB.benzi("CMP142.030") !== CB.benzi("CMP142.040"));
bine("textul gol nu dă nimic", CB.benzi("") === "");

// ---- 3. Curățarea ----------------------------------------------------------
console.log("\nCurățarea textului");
bine("diacriticele se reduc la litere ASCII", CB.curat("PUNGĂ-CURIER") === "PUNGA-CURIER", CB.curat("PUNGĂ-CURIER"));
bine("ce nu e ASCII tipăribil dispare", CB.curat("CM 142–A") === "CM142A", CB.curat("CM 142–A"));
bine("textul lung se taie, nu crapă", CB.curat("X".repeat(300)).length === 48);
bine("un cod cu diacritice tot se desenează", CB.svg("LOT-ĂÎȘ-1").length > 100);

// ---- 4. SVG-ul -------------------------------------------------------------
console.log("\nSVG");
const s = CB.svg("CMP142.030", { inalt: 12, modul: 0.3 });
bine("e un SVG cu dimensiuni în milimetri", s.startsWith("<svg") && s.includes("mm\""), s.slice(0, 60));
bine("are fundal alb (altfel nu se citește pe hârtie colorată)", s.includes('fill="#fff"'));
bine("scrie textul sub cod", s.includes(">CMP142.030</text>"));
bine("se poate cere fără text", !CB.svg("CMP142.030", { subtitlu: false }).includes("</text>"));
bine("lățimea ține cont de zona de liniște de 10 module de fiecare parte",
  s.includes(`width="${(((10 + 2) * 11 + 13 + 20) * 0.3).toFixed(2)}mm"`), s.slice(0, 120));
bine("modulul nu coboară sub 0,25 mm oricât s-ar cere",
  CB.svg("A", { modul: 0.01 }).includes("height=\"12.00\""));
bine("benzile lipite se desenează ca un singur dreptunghi",
  (s.match(/<rect /g) || []).length < CB.benzi("CMP142.030").length / 2,
  (s.match(/<rect /g) || []).length);
bine("textul gol nu produce SVG", CB.svg("") === "");
bine("ghilimelele din text nu sparg SVG-ul", !CB.svg('A"B').includes('>A"B<'));

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
