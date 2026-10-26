"use strict";
// Scrierea fișierelor Excel. Fără bază de date, fără rețea.
//
// CE APĂRĂ:
//
//   • UN FIȘIER PE CARE EXCEL REFUZĂ SĂ-L DESCHIDĂ e mai rău decât niciun
//     buton de export: omul apasă, primește „fișier corupt" și nu mai are ce
//     face cu el. De-aia testul nu se uită doar la ce-am scris — desface
//     arhiva înapoi și verifică părțile pe care Excel le cere obligatoriu.
//
//   • NUMERELE TREBUIE SĂ RĂMÂNĂ NUMERE. Un rulaj scris ca text arată la fel
//     pe ecran, dar nu se adună și nu se sortează. Exact lucrul pentru care
//     cineva deschide exportul.
//
//   • DATELE LA FEL. „26.10.2026" ca text se sortează alfabetic: 01.12 vine
//     înaintea lui 26.10.
//
//   • UN CARACTER DE CONTROL RĂMAS DINTR-UN IMPORT strică fișierul ÎNTREG,
//     nu doar celula lui. Se curăță la scriere.
//
//   • NUMELE FOII ȘI AL FIȘIERULUI. Excel refuză foi mai lungi de 31 de
//     caractere sau cu „/" în ele.
const XLS = require("./lib/export-xlsx");
const zlib = require("zlib");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 220) : "")); esecuri++; }
}

// Desfacem arhiva înapoi, din directorul central — adică exact pe drumul pe
// care o citește și Excel, nu scanând după semnături prin fișier.
function desfa(buf) {
  const sfarsit = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (sfarsit < 0) throw new Error("fără sfârșit de arhivă");
  const nr = buf.readUInt16LE(sfarsit + 10);
  let p = buf.readUInt32LE(sfarsit + 16);
  const out = {};
  for (let i = 0; i < nr; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("intrare centrală stricată la " + p);
    const comprimat = buf.readUInt32LE(p + 20);
    const lungimeNume = buf.readUInt16LE(p + 28);
    const lungimeExtra = buf.readUInt16LE(p + 30);
    const lungimeComent = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const nume = buf.slice(p + 46, p + 46 + lungimeNume).toString("utf8");
    const nl = buf.readUInt16LE(offset + 26);
    const xl = buf.readUInt16LE(offset + 28);
    const date = buf.slice(offset + 30 + nl + xl, offset + 30 + nl + xl + comprimat);
    out[nume] = zlib.inflateRawSync(date).toString("utf8");
    p += 46 + lungimeNume + lungimeExtra + lungimeComent;
  }
  return out;
}

const COLOANE = [
  { titlu: "Nume", cheie: "nume", tip: "text", latime: 40 },
  { titlu: "Rulaj", cheie: "rulaj", tip: "bani", latime: 18 },
  { titlu: "Facturi", cheie: "nr", tip: "numar", latime: 10 },
  { titlu: "Ultima", cheie: "ultima", tip: "data", latime: 14 },
];
const RANDURI = [
  { nume: "DELIVERY SOLUTIONS S.A.", rulaj: 15472099.94, nr: 132, ultima: "2026-10-26" },
  { nume: 'Ăsta & <are> "ghilimele"', rulaj: -5.5, nr: 0, ultima: "26.10.2026" },
  { nume: "fără nimic", rulaj: null, nr: null, ultima: "" },
];
const buf = XLS.carte([{ nume: "Parteneri", coloane: COLOANE, randuri: RANDURI }]);
const parti = desfa(buf);
const foaie = parti["xl/worksheets/sheet1.xml"];

// ---- 1. Arhiva ------------------------------------------------------------
console.log("Arhiva");
bine("începe cu semnătura ZIP", buf[0] === 0x50 && buf[1] === 0x4b, buf.slice(0, 4));
bine("se desface înapoi fără erori", Object.keys(parti).length > 0);
for (const cerut of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
  bine("conține " + cerut, Boolean(parti[cerut]));
}
bine("fiecare parte e XML valid la prima vedere", Object.values(parti).every((v) => v.trim().startsWith("<")));
bine("două exporturi identice dau fișiere identice (fără ceas în arhivă)",
  XLS.carte([{ nume: "Parteneri", coloane: COLOANE, randuri: RANDURI }]).equals(buf));

// ---- 2. Conținutul foii ---------------------------------------------------
console.log("\nCelulele");
bine("antetul e scris cu stilul de antet", foaie.includes('s="1" t="inlineStr"><is><t>Nume</t>'));
bine("suma e NUMĂR, nu text", foaie.includes('<c r="B2" s="2"><v>15472099.94</v></c>'), foaie.match(/<c r="B2"[^/]*?<\/c>/));
bine("numărul de facturi e număr întreg", foaie.includes('<c r="C2" s="3"><v>132</v></c>'));
bine("data în format ISO devine serie Excel", foaie.includes('<c r="D2" s="4"><v>46321</v></c>'),
  (foaie.match(/<c r="D2"[^>]*>[^<]*<v>(\d+)<\/v>/) || [])[1]);
bine("data în format românesc dă aceeași serie", XLS.serieData("26.10.2026") === XLS.serieData("2026-10-26"));
bine("zero e scris, nu sărit", foaie.includes('<c r="C3" s="3"><v>0</v></c>'));
bine("negativele trec", foaie.includes("<v>-5.5</v>"));
bine("celula goală lipsește de tot din XML", !foaie.includes('r="B4"') && !foaie.includes('r="D4"'));
bine("textul cu & < > \" e scapat", foaie.includes("&amp;") && foaie.includes("&lt;are&gt;") && foaie.includes("&quot;"));
bine("diacriticele rămân intacte", foaie.includes("Ăsta"));
bine("capul de tabel rămâne sus la derulare", foaie.includes('ySplit="1"') && foaie.includes('state="frozen"'));
bine("are filtru pe coloane", foaie.includes('<autoFilter ref="A1:D4"/>'));
bine("lățimile cerute ajung în fișier", foaie.includes('width="40"') && foaie.includes('width="14"'));

// ---- 3. Ce strică fișierul întreg -----------------------------------------
console.log("\nCe ar strica fișierul");
const rau = XLS.carte([{ nume: "X", coloane: [{ titlu: "A", cheie: "a", tip: "text" }], randuri: [{ a: "da\u0001nu\u0007" }] }]);
const foaieRea = desfa(rau)["xl/worksheets/sheet1.xml"];
bine("caracterele de control sunt scoase", foaieRea.includes("<t xml:space=\"preserve\">danu</t>"), foaieRea.match(/<t[^>]*>[^<]*<\/t>/g));
bine("tabul și rândul nou rămân (sunt legale în XML)",
  desfa(XLS.carte([{ nume: "X", coloane: [{ titlu: "A", cheie: "a" }], randuri: [{ a: "a\tb\nc" }] }]))["xl/worksheets/sheet1.xml"].includes("a\tb\nc"));
const lung = XLS.carte([{ nume: "Un nume de foaie mult prea lung ca să încapă/cu slash", coloane: [{ titlu: "A", cheie: "a" }], randuri: [] }]);
const numeFoaie = (desfa(lung)["xl/workbook.xml"].match(/name="([^"]+)"/) || [])[1];
bine("numele foii se taie la 31 de caractere", numeFoaie.length <= 31, numeFoaie);
bine("slash-ul din numele foii dispare", !numeFoaie.includes("/"), numeFoaie);

// ---- 4. Adresele de celulă ------------------------------------------------
console.log("\nAdresele de celulă");
bine("coloana 1 e A", XLS.litera(1) === "A");
bine("coloana 26 e Z", XLS.litera(26) === "Z");
bine("coloana 27 e AA", XLS.litera(27) === "AA", XLS.litera(27));
bine("coloana 52 e AZ", XLS.litera(52) === "AZ", XLS.litera(52));
bine("o dată imposibilă nu dă serie", XLS.serieData("tralala") === null);
bine("un câmp gol nu dă serie", XLS.serieData("") === null);

// ---- 5. Numele fișierului și antetele -------------------------------------
console.log("\nDescărcarea");
bine("diacriticele din numele fișierului se reduc", XLS.numeFisier("parteneri-cașă") === "parteneri-casa.xlsx",
  XLS.numeFisier("parteneri-cașă"));
bine("spațiile devin liniuțe de subliniere", XLS.numeFisier("doi parteneri") === "doi_parteneri.xlsx");
bine("extensia se pune o singură dată", XLS.numeFisier("x").endsWith(".xlsx") && !XLS.numeFisier("x").includes(".xlsx.xlsx"));
const a = XLS.antete("lista", 1234);
bine("tipul de conținut e cel de Excel", /spreadsheetml\.sheet$/.test(a["Content-Type"]), a["Content-Type"]);
bine("browserul primește fișierul ca descărcare", /^attachment; filename="lista\.xlsx"$/.test(a["Content-Disposition"]), a["Content-Disposition"]);
bine("lungimea e trimisă", a["Content-Length"] === "1234");
bine("nu se ține în cache (altfel se descarcă vechiul export)", a["Cache-Control"] === "no-store");

// ---- 6. Mai multe foi ------------------------------------------------------
console.log("\nMai multe foi");
const doua = desfa(XLS.carte([
  { nume: "Unu", coloane: [{ titlu: "A", cheie: "a" }], randuri: [{ a: "x" }] },
  { nume: "Doi", coloane: [{ titlu: "B", cheie: "b" }], randuri: [{ b: "y" }] },
]));
bine("a doua foaie există ca fișier", Boolean(doua["xl/worksheets/sheet2.xml"]));
bine("amândouă sunt legate în workbook", (doua["xl/workbook.xml"].match(/<sheet /g) || []).length === 2);
bine("legăturile acoperă foile și stilurile", (doua["xl/_rels/workbook.xml.rels"].match(/<Relationship /g) || []).length === 3);
bine("tipurile de conținut le acoperă pe amândouă", (doua["[Content_Types].xml"].match(/worksheets\/sheet/g) || []).length === 2);
let aCrapat = false;
try { XLS.carte([]); } catch (e) { aCrapat = true; }
bine("o carte fără nicio foaie e refuzată, nu scrisă goală", aCrapat);

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
