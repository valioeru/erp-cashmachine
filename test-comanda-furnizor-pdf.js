"use strict";
// PDF-ul comenzii către furnizor (lib/comanda-furnizor-pdf.js).
//
// Cererea lui Vali, 05.11.2026: „buton de export pdf". Foaia pleacă afară, la
// furnizor — deci ce se verifică aici e ce ar face de râs firma pe o hârtie:
//
//   • PREȚUL LIPSĂ NU APARE CA ZERO. „0,00" pe o poziție neprețuită i-ar spune
//     furnizorului că o vrem gratis.
//   • ECHIVALENTUL ÎN LEI / EURO APARE DOAR CU CURS. Fără curs, rândul
//     lipsește; o cifră ghicită arată la fel de îngrijit ca una adevărată.
//   • ÎN ENGLEZĂ CHIAR E ÎN ENGLEZĂ — nicio frază rămasă în română.
//   • NUMELE FURNIZORULUI SE ESCAPEAZĂ. Vine din bază, scris de oameni.
//   • TITLUL PAGINII e numele fișierului salvat: are numărul și furnizorul.
//
// Fără bază de date: foaia e desen pur.
const path = require("path");
const P = require(path.join(__dirname, "lib", "comanda-furnizor-pdf.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const are = (html, ce, eticheta) => (html.includes(ce) ? ok(eticheta || "conține „" + ce + "”") : rau("lipsește", eticheta || ce));
const nuAre = (html, ce, eticheta) => (html.includes(ce) ? rau("n-are ce căuta", eticheta || ce) : ok(eticheta || "fără „" + ce + "”"));

const COMANDA = {
  id: 7,
  numar: "CF-2026-0001",
  data: "2026-11-05",
  data_solicitata: "2026-11-20",
  moneda: "EUR",
  curs: 5.0912,
  curs_eur: 5.0912,
  status: "ciorna",
  observatii: "Bucharest, CTPark Bucharest North | Vila Ana Street nr.6, Warehouse B2",
  furnizor: "WBV WESTDEUTSCHER BINDEGARN-VERTRIEB ESELGRIMM GMBH & CO. KG",
  furnizor_cui: "DE123456789",
  furnizor_email: "twerning@wbv-worldwide.com",
};
const LINII = [
  { denumire: "Packtape acrylic 48mm*60m WBV", produs_cod: "BA4860", cantitate: 28, um: "PALLET", pret_unitar: 800 },
  { denumire: "Packtape acrylic 48mm*53m WBV", produs_cod: null, cantitate: 5, um: "PALLET", pret_unitar: null },
];

console.log("\nÎn română:");
const ro = P.pagina({ comanda: COMANDA, linii: LINII, emitent: { nume: "Mirella", email: "comercial@cashmachine.ro" }, inapoi: "/procurement/comenzi/7", alta: "/procurement/comenzi/7/pdf?limba=en", generatLa: "2026-11-05 13:40:00" });
are(ro, "COMANDĂ DE ACHIZIȚIE");
are(ro, "CF-2026-0001");
are(ro, "05.11.2026", "data scrisă cu ziua întâi");
are(ro, "20.11.2026", "data de livrare solicitată");
are(ro, "WBV WESTDEUTSCHER BINDEGARN-VERTRIEB ESELGRIMM GMBH &amp; CO. KG", "furnizorul, cu & escapat");
are(ro, "twerning@wbv-worldwide.com");
are(ro, "CASH MACHINE S.R.L.", "firma noastră în antet");
are(ro, "RO27244210", "CIF-ul nostru");
are(ro, "Packtape acrylic 48mm*60m WBV");
are(ro, "BA4860", "codul produsului");
are(ro, "22.400,00", "valoarea liniei 28 × 800");
are(ro, "de confirmat", "poziția fără preț spune „de confirmat”");
are(ro, "Total pe pozițiile cu preț", "totalul nu se dă drept complet când lipsește un preț");
are(ro, "1 poziție fără preț", "spune câte poziții n-au preț");
are(ro, "Echivalent în lei: 114.042,88 lei, la cursul de 5,0912 lei/EUR (informativ)", "echivalentul în lei, cu cursul");
nuAre(ro, "Echivalent în euro", "fără „echivalent în euro” la o comandă în euro");
are(ro, "Warehouse B2", "observațiile (adresa de livrare)");
are(ro, "Mirella", "cine a întocmit-o");
are(ro, "<strong>Orar de descărcare:</strong> luni&nbsp;–&nbsp;vineri, 09:00&nbsp;–&nbsp;17:30", "orarul de descărcare, fără să se rupă pe două rânduri");
are(ro, "Jud. Ilfov", "adresa în română rămâne cum e");
are(ro, "<title>Comanda CF-2026-0001 - WBV WESTDEUTSCHER", "titlul = numele fișierului PDF");
are(ro, 'href="/procurement/comenzi/7/pdf?limba=en"', "legătura spre varianta în engleză");
are(ro, "@media print", "bara de butoane nu se tipărește");
nuAre(ro, "window.print(); }, 350", "fără tipar automat dacă nu s-a cerut");
for (const urat of ["undefined", "NaN", ">null<", "[object Object]"]) nuAre(ro, urat);
// Prețul lipsă nu e zero, pe nicio coloană.
const randFaraPret = (ro.match(/<tr>\s*<td class="nr">2<\/td>[\s\S]*?<\/tr>/) || [""])[0];
if (/0,00/.test(randFaraPret)) rau("poziția fără preț arată 0,00 — furnizorul ar înțelege că o vrem gratis", randFaraPret.replace(/\s+/g, " ").slice(0, 200));
else ok("poziția fără preț nu are niciun 0,00");

console.log("\nÎn engleză:");
const en = P.pagina({ comanda: COMANDA, linii: LINII, limba: "en", emitent: { nume: "Mirella" }, tipar: true });
for (const ce of ["PURCHASE ORDER", "Supplier", "Unit price", "to be confirmed", "Total of the items with a price", "1 item without a price", "Equivalent in RON: 114,042.88 RON, at the rate of 5.0912 RON/EUR (for reference)", "22,400.00", "Please confirm receipt of this order", "Prepared by", '<html lang="en">', "Purchase order CF-2026-0001", "<strong>Unloading hours:</strong> Monday to Friday, 09:00&nbsp;–&nbsp;17:30", "Voluntari, Ilfov, Romania"]) are(en, ce);
nuAre(en, "Jud.", "fără „Jud.” în adresa din engleză");
nuAre(en, "22.400,00", "fără numere scrise românește în engleză");
for (const ro_ of ["COMANDĂ", "Furnizor", "de confirmat", "Vă rugăm", "Întocmit", "Echivalent în", "informativ"]) nuAre(en, ro_, "nicio română: „" + ro_ + "”");
are(en, "window.print()", "cu tipar=1 se deschide singură fereastra din care se salvează PDF-ul");

console.log("\nUnitățile românești se traduc în engleză:");
const role = { comanda: COMANDA, linii: [{ denumire: "Packtape", cantitate: 84672, um: "rola", pret_unitar: 0.23 }] };
are(P.pagina(Object.assign({ limba: "en" }, role)), '<td class="um">roll</td>', "rola → roll");
are(P.pagina(Object.assign({ limba: "en" }, role)), "84,672", "84.672 role → 84,672 în engleză");
are(P.pagina(role), '<td class="um">rola</td>', "în română rămâne rola");
are(P.pagina(role), "84.672", "în română 84.672");

console.log("\nComandă în lei — echivalentul e în euro:");
const lei = P.pagina({ comanda: Object.assign({}, COMANDA, { moneda: "RON", curs: null, curs_eur: 5 }), linii: [{ denumire: "Granulă", cantitate: 1000, um: "kg", pret_unitar: 7.5 }] });
are(lei, "Total comandă: <strong>7.500,00 RON</strong>", "totalul complet, în lei");
are(lei, "Echivalent în euro: 1.500,00 EUR, la cursul de 5,0000 lei/EUR (informativ)");
nuAre(lei, "Echivalent în lei", "fără echivalent în lei la o comandă în lei");
nuAre(lei, "poziție fără preț", "fără nota de preț lipsă când toate au preț");

console.log("\nColoana de cod doar când există coduri:");
are(ro, "<th>Cod</th>", "cu un produs din nomenclator, coloana Cod apare");
nuAre(lei, "<th>Cod</th>", "fără niciun cod, coloana lipsește și lasă loc denumirii");
are(ro, 'class="linii-scroll"', "pe telefon tabelul se derulează în el, nu strică pagina");

console.log("\nFără curs nu se inventează unul:");
const faraCurs = P.pagina({ comanda: Object.assign({}, COMANDA, { curs: null, curs_eur: null }), linii: LINII });
nuAre(faraCurs, "Echivalent în lei", "fără rând de echivalent când lipsește cursul");

console.log("\nComandă în dolari — și lei, și euro:");
const usd = P.pagina({ comanda: Object.assign({}, COMANDA, { moneda: "USD", curs: 4.5, curs_eur: 5 }), linii: [{ denumire: "Pigment", cantitate: 10, um: "kg", pret_unitar: 10 }] });
are(usd, "Echivalent în lei: 450,00 lei, la cursul de 4,5000 lei/USD");
are(usd, "Echivalent în euro: 90,00 EUR, la cursul de 5,0000 lei/EUR");

console.log("\nComanda anulată se vede anulată:");
are(P.pagina({ comanda: Object.assign({}, COMANDA, { status: "anulata" }), linii: LINII }), 'class="anulata">ANULATĂ', "ștampila ANULATĂ");
nuAre(ro, 'class="anulata"', "fără ștampilă pe o comandă valabilă");

console.log("\nCe vine din bază se escapează:");
const rau_ = P.pagina({ comanda: Object.assign({}, COMANDA, { furnizor: '<script>alert(1)</script>', observatii: '<img src=x onerror=alert(1)>' }), linii: [{ denumire: "<b>x</b>", cantitate: 1, pret_unitar: 1 }] });
nuAre(rau_, "<script>alert(1)</script>", "numele furnizorului nu rulează cod");
nuAre(rau_, "<img src=x", "observațiile nu rulează cod");
nuAre(rau_, "<b>x</b>", "denumirea poziției nu e HTML");

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
