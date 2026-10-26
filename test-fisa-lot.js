"use strict";
// Fișa însoțitoare de lot. Desen pur, fără bază de date.
//
// CE APĂRĂ:
//
//   • OPERAȚIILE NU SE PIERD ȘI NU SE DUBLEAZĂ. Fișa e fluxul tehnologic plus
//     patru operații pe care le are orice lot. Dacă una dispare, lotul pleacă
//     din hală fără control final sau fără recepția materiei prime scrisă
//     nicăieri — exact lucrurile pentru care ținem hârtia asta.
//
//   • UNITATEA DE MĂSURĂ SE SCHIMBĂ O SINGURĂ DATĂ. Până la confecționare se
//     lucrează folie (kg), după aceea bucăți. „Buc" la extruder ar face
//     operatorul să scrie acolo numărul de pungi pe care nu le-a făcut încă,
//     iar rebutul s-ar aduna în două unități diferite.
//
//   • PASUL OPȚIONAL ÎȘI DUCE CONDIȚIA PE HÂRTIE. Fără ea, unul îl sare și
//     altul îl face degeaba — lecția deja învățată în pagina Fluxuri.
//
//   • PARAMETRUL CERUT SE POTRIVEȘTE CU CARACTERISTICA COMENZII chiar dacă
//     unul e scris „Lățime folie" și altul „Latime folie (mm)". Altfel coloana
//     „Specificat" ar rămâne goală exact la produsele la care doi oameni au
//     scris același lucru în două feluri.
//
//   • CODUL LOTULUI E STABIL ȘI SCANABIL. Dacă s-ar schimba de la o tipărire
//     la alta, două hârtii ale aceluiași lot ar raporta în ERP două loturi.
//
//   • CE SCRIE OMUL NU DEVINE COD. O denumire de produs cu „<script>" în ea
//     trebuie să iasă text pe hârtie, nu să rupă pagina.
const FL = require("./lib/fisa-lot");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 220) : "")); esecuri++; }
}

// Fluxul real F-PUNGA, așa cum e în ERP.
const PASI = [
  { pas_nr: 1, utilaj_cod: "UT01", utilaj_denumire: "Extruder", operatie: "Extrudare folie (45 µm)",
    tip_pas: "OBLIGATORIU", conditie: null, parametri: "Grosime|µm;Lățime folie|mm;Tratament corona" },
  { pas_nr: 2, utilaj_cod: "UT02", utilaj_denumire: "Slitter", operatie: "Debitare la lățime",
    tip_pas: "OPTIONAL", conditie: "Dacă lățimea extrudată ≠ lățimea necesară (R10)", parametri: "Lățime după debitare|mm" },
  { pas_nr: 3, utilaj_cod: "UT12", utilaj_denumire: "Flexo", operatie: "Imprimare flexo",
    tip_pas: "OPTIONAL", conditie: "Dacă punga este imprimată (R11)", parametri: "Clișeu;Nr. culori" },
  { pas_nr: 4, utilaj_cod: "UT10|UT11", utilaj_denumire: null, operatie: "Confecționare pungi + ambalare în cutii",
    tip_pas: "OBLIGATORIU", conditie: "Alocare după R01/R02", parametri: "Lățime pungă|mm;Clapetă|mm" },
];

// ---- 1. Lista de operații --------------------------------------------------
console.log("Operațiile fișei");
const ops = FL.operatii(PASI, { um: "buc" });
bine("fluxul de 4 pași dă 8 operații (recepție + 4 + control + ambalare + eliberare)", ops.length === 8, ops.length);
bine("prima e recepția materiei prime", /Recepție materie primă/.test(ops[0].titlu), ops[0].titlu);
bine("ultima e eliberarea lotului", /Eliberare/.test(ops[ops.length - 1].titlu), ops[ops.length - 1].titlu);
bine("există control final de calitate", ops.some((o) => o.qc === true));
bine("numerotarea e 010, 020, ... 080",
  ops.map((o) => o.nr).join(",") === "010,020,030,040,050,060,070,080", ops.map((o) => o.nr).join(","));
bine("pașii fluxului își păstrează ordinea", ops[1].titlu.includes("Extrudare") && ops[4].titlu.includes("Confecționare"),
  ops.map((o) => o.titlu).join(" | "));
bine("postul arată utilajul", ops[1].post === "UT01 · Extruder", ops[1].post);
bine("pasul pe două utilaje alternative le arată pe amândouă", ops[4].post === "UT10|UT11", ops[4].post);

console.log("\nPașii opționali");
bine("pasul opțional rămâne marcat opțional", ops[2].tip === "OPTIONAL", ops[2].tip);
bine("își duce condiția pe hârtie", /R10/.test(ops[2].conditie || ""), ops[2].conditie);
bine("pasul obligatoriu nu e marcat opțional", ops[1].tip === "OBLIGATORIU", ops[1].tip);

console.log("\nUnitatea de măsură pe operații");
bine("recepția materiei prime se măsoară în kg", ops[0].um === "kg", ops[0].um);
bine("extruderul se măsoară în kg", ops[1].um === "kg", ops[1].um);
bine("debitarea se măsoară în kg", ops[2].um === "kg", ops[2].um);
bine("imprimarea se măsoară în kg", ops[3].um === "kg", ops[3].um);
bine("confecționarea se măsoară în bucăți", ops[4].um === "buc", ops[4].um);
bine("tot ce urmează confecționării e în bucăți", ops.slice(4).every((o) => o.um === "buc"),
  ops.map((o) => o.nr + ":" + o.um).join(" "));
const opsKg = FL.operatii(PASI, { um: "kg" });
bine("la un produs vândut la kilogram, finalul rămâne în kg", opsKg[7].um === "kg", opsKg[7].um);
bine("fără niciun flux, fișa tot are cele patru operații de bază", FL.operatii([], {}).length === 4);

// ---- 2. Parametrii ---------------------------------------------------------
console.log("\nParametrii");
const p = FL.parametri("Grosime|µm;Lățime folie|mm;Tratament corona");
bine("se despart pe punct și virgulă", p.length === 3, p.length);
bine("unitatea se ia după bara verticală", p[0].nume === "Grosime" && p[0].um === "µm", JSON.stringify(p[0]));
bine("un parametru fără unitate e valid", p[2].nume === "Tratament corona" && p[2].um === "", JSON.stringify(p[2]));
bine("text gol nu dă parametri", FL.parametri("").length === 0);
bine("spațiile și rândurile goale se ignoră", FL.parametri("  A ; ; \n B|mm ").length === 2);

const CARAC = [
  { denumire: "Grosime", valoare: "60", unitate: "µm", linie_id: 7 },
  { denumire: "Latime folie (mm)", valoare: "700", unitate: null, linie_id: 7 },
  { denumire: "Nr. culori", valoare: "2", unitate: null, linie_id: 7 },
];
bine("potrivirea exactă aduce valoarea și unitatea", FL.specificat("Grosime", CARAC) === "60 µm", FL.specificat("Grosime", CARAC));
bine("diacriticele și parantezele nu strică potrivirea", FL.specificat("Lățime folie", CARAC) === "700",
  FL.specificat("Lățime folie", CARAC));
bine("punctul din „Nr. culori” nu strica potrivirea", FL.specificat("Nr culori", CARAC) === "2", FL.specificat("Nr culori", CARAC));
bine("ce nu există rămâne gol, nu inventat", FL.specificat("Tratament corona", CARAC) === null,
  FL.specificat("Tratament corona", CARAC));

// ---- 3. Codul lotului ------------------------------------------------------
console.log("\nCodul lotului");
bine("se construiește din dată și numărul comenzii",
  FL.codLot({ id: 142, numar: "CMD-1187", data_initiere: "2026-10-26" }) === "CM-261026-CMD1187",
  FL.codLot({ id: 142, numar: "CMD-1187", data_initiere: "2026-10-26" }));
bine("nu se schimbă de la o tipărire la alta",
  FL.codLot({ id: 142, numar: "CMD-1187", data_initiere: "2026-10-26" }) ===
    FL.codLot({ id: 142, numar: "CMD-1187", data_initiere: "2026-10-26" }));
bine("o comandă fără număr folosește id-ul", FL.codLot({ id: 9, data_initiere: "2026-10-26" }) === "CM-261026-9",
  FL.codLot({ id: 9, data_initiere: "2026-10-26" }));
bine("codul de operație e scurt, ca să încapă în coloană", FL.codOperatie(142, "030") === "CMP142.030",
  FL.codOperatie(142, "030"));

// ---- 4. Fișa întreagă ------------------------------------------------------
console.log("\nFișa tipărită");
const html = FL.fisa({
  comanda: { id: 142, numar: "CMD-1187", data_initiere: "2026-10-26", data_livrare: "2026-11-05",
             partener_nume: "DPD România", agent_nume: "Ionuț P.", observatii: "Clapetă dublu adeziv.", um: "buc" },
  linii: [{ id: 7, denumire: "Pungă curier 350x450+50", produs_cod: "PC-DPD-350450", cantitate: "100000", um: "buc" }],
  caracteristici: CARAC,
  operatii: ops,
  alocari: [{ data: "2026-10-28", interval: "06:00–14:00", utilaj: "UT01 · Extruder", cantitate: 420, oameni: "Marius, Ana" }],
  lot: "CM-261026-CMD1187",
  tiparitLa: "2026-10-26",
  proces: "REALIZARE PUNGĂ CURIER",
  procesEn: "COURIER BAGS",
  fluxText: "F-PUNGA · Pungă curier (de la produs)",
});
bine("e o pagină HTML completă", html.startsWith("<!doctype html>") && html.trim().endsWith("</html>"));
bine("are antetul ISO 9001", html.includes("SR EN ISO 9001:2015"));
bine("are titlul bilingv", html.includes("FIȘĂ ÎNSOȚITOARE LOT") && html.includes("PRODUCTION TRAVELER"));
bine("scrie codul lotului", html.includes("CM-261026-CMD1187"));
bine("are un cod de bare pentru lot și câte unul pentru fiecare operație",
  (html.match(/<svg class="cod-bare"/g) || []).length === ops.length + 1,
  (html.match(/<svg class="cod-bare"/g) || []).length);
bine("fiecare operație are codul ei scris sub cod",
  ops.every((o) => html.includes(">CMP142." + o.nr + "</text>")));
bine("are banda OPERAȚII", html.includes("OPERAȚII / OPERATIONS"));
bine("are coloanele Specificat și Realizat", html.includes("Specificat") && html.includes("Realizat"));
bine("valoarea cerută e deja tipărită lângă caseta goală", html.includes('<td class="spec">60 µm</td>'));
bine("parametrul fără valoare lasă caseta goală, nu scrie zero", html.includes('<td class="spec"></td>'));
bine("are casete Bune și Rebut în kg la extruder", html.includes("Bune (kg):") && html.includes("Rebut (kg):"));
bine("are casete în bucăți după confecționare", html.includes("Bune (buc):"));
bine("spune condiția pasului opțional", html.includes("se aplică doar dacă") && html.includes("R10"));
bine("are nota de scanare", html.includes("Scanează codul operației la începutul lucrului la post"));
bine("are nota în engleză", html.includes("Scan the operation barcode"));
bine("are cele două semnături", html.includes("Responsabil producție") && html.includes("Eliberare lot — Control calitate"));
bine("arată clientul și termenul", html.includes("DPD România") && html.includes("2026-11-05"));
bine("arată produsul, codul și cantitatea scrisă citeț", html.includes("PC-DPD-350450") && html.includes("100.000 buc"));
bine("cantitatea brută nu mai apare nicăieri", !html.includes(">100000"));
bine("arată alocarea pe utilaj", html.includes("06:00–14:00") && html.includes("Marius, Ana"));
bine("arată din ce flux vin operațiile", html.includes("F-PUNGA · Pungă curier (de la produs)"));
bine("arată observațiile lotului", html.includes("Clapetă dublu adeziv."));
bine("are butonul de tipărire, ascuns la print", html.includes("window.print()") && html.includes(".bara { display: none; }"));

console.log("\nCe scrie omul nu devine cod");
const rau = FL.fisa({
  comanda: { id: 1, numar: "<script>alert(1)</script>", client_text: "<b>X</b>", observatii: "a<img src=x onerror=y>" },
  linii: [],
  caracteristici: [],
  operatii: FL.operatii([], {}),
  lot: "CM-1",
});
bine("denumirile cu etichete HTML ies ca text", !rau.includes("<script>alert(1)</script>"));
bine("observațiile cu etichete HTML ies ca text", !rau.includes("<img src=x"));
bine("fișa se desenează și fără produse și fără caracteristici", rau.includes("OPERAȚII / OPERATIONS"));

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
