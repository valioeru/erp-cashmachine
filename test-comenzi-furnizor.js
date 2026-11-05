"use strict";
// Comenzile către furnizor: ce se poate greși tăcut.
//
// CE APĂRĂ:
//
//   • „PRIMITĂ" SE CALCULEAZĂ, NU SE BIFEAZĂ. O comandă din care a venit tot
//     ce e scump și n-a venit șurubul de 2 lei nu e primită — cineva trebuie
//     să-l mai ceară o dată. Dacă ar fi bifă, lista de „în curs" ar minți
//     exact în cazul care contează.
//
//   • PREȚUL LIPSĂ NU E ZERO. `Number(null)` dă 0, un zero finit și
//     nenegativ, care trece de orice gardă — aceeași capcană care era cât pe
//     ce să arate agentului prețul de achiziție la RFQ. Aici ar transforma o
//     comandă neprețuită într-una „de 0 lei": un total care arată cinstit și
//     e fals.
//
//   • NU SE ADUNĂ LEI CU EURO. Niciodată, în niciun total.
//
//   • ÎNTÂRZIEREA LIPSĂ NU E „LA TIMP". Fără una din cele două date răspunsul
//     e „nu se știe", nu zero zile.
//
// Rulează fără bază de date: lib/comenzi-furnizor-logica.js e logică pură.
const path = require("path");
const L = require(path.join(__dirname, "lib", "comenzi-furnizor-logica.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

console.log("\nStatusul după recepție:");
egal("tot primit → primită",
  L.statusDupaReceptie([{ cantitate: 10, cantitate_primita: 10 }, { cantitate: 5, cantitate_primita: 5 }], "trimisa"),
  "primita");
egal("o linie neacoperită ține comanda deschisă",
  L.statusDupaReceptie([{ cantitate: 10, cantitate_primita: 10 }, { cantitate: 5, cantitate_primita: 0 }], "trimisa"),
  "partial");
egal("o linie pe jumătate → parțial",
  L.statusDupaReceptie([{ cantitate: 10, cantitate_primita: 4 }], "trimisa"),
  "partial");
egal("nimic primit → rămâne unde era",
  L.statusDupaReceptie([{ cantitate: 10, cantitate_primita: 0 }], "confirmata"),
  "confirmata");
egal("mai mult decât s-a comandat tot primită e",
  L.statusDupaReceptie([{ cantitate: 10, cantitate_primita: 10.5 }], "trimisa"),
  "primita");
egal("o linie cu cantitate 0 nu ține comanda deschisă",
  L.statusDupaReceptie([{ cantitate: 10, cantitate_primita: 10 }, { cantitate: 0, cantitate_primita: 0 }], "trimisa"),
  "primita");
egal("fără linii, nimic nu se schimbă", L.statusDupaReceptie([], "trimisa"), "trimisa");

console.log("\nPrețul lipsă NU e zero:");
egal("fără preț → fără valoare", L.valoareLinie({ cantitate: 100, pret_unitar: null }), null);
egal("preț gol → fără valoare", L.valoareLinie({ cantitate: 100, pret_unitar: "" }), null);
egal("undefined → fără valoare", L.valoareLinie({ cantitate: 100 }), null);
egal("preț negativ → fără valoare", L.valoareLinie({ cantitate: 100, pret_unitar: -3 }), null);
egal("zero scris dinadins rămâne zero", L.valoareLinie({ cantitate: 100, pret_unitar: 0 }), 0);
egal("preț normal", L.valoareLinie({ cantitate: 2.5, pret_unitar: 1.89 }), 4.73);

console.log("\nTotalul spune câte poziții n-au preț:");
egal("două cu preț, una fără",
  L.totalComanda([
    { cantitate: 10, pret_unitar: 2 },
    { cantitate: 5, pret_unitar: 3 },
    { cantitate: 7, pret_unitar: null },
  ]),
  { total: 35, faraPret: 1 });
egal("niciuna cu preț", L.totalComanda([{ cantitate: 10, pret_unitar: null }]), { total: 0, faraPret: 1 });

console.log("\nMonedele nu se adună între ele:");
const pe = L.totaluriPeMoneda([
  { moneda: "RON", total: 100 },
  { moneda: "EUR", total: 50 },
  { moneda: "RON", total: 25 },
]);
egal("lei separat", pe.get("RON"), 125);
egal("euro separat", pe.get("EUR"), 50);
egal("două monede, două rânduri", pe.size, 2);

console.log("\nÎntârzierea:");
egal("trei zile peste termen", L.intarziere("2026-10-01", "2026-10-04"), 3);
egal("la timp", L.intarziere("2026-10-01", "2026-10-01"), 0);
egal("mai devreme", L.intarziere("2026-10-10", "2026-10-07"), -3);
egal("fără recepție nu se știe", L.intarziere("2026-10-01", null), null);
egal("fără termen cerut nu se știe", L.intarziere("", "2026-10-04"), null);

console.log("\nNumerotarea:");
egal("prima din an", L.numarUrmator(null, 2026), "CF-2026-0001");
egal("următoarea", L.numarUrmator("CF-2026-0007", 2026), "CF-2026-0008");
egal("an nou, numerotare nouă", L.numarUrmator("CF-2026-0912", 2027), "CF-2027-0001");
egal("număr scris de mână nu încurcă seria", L.numarUrmator("comanda veche", 2026), "CF-2026-0001");

console.log("\nEmailul către furnizor:");
const corp = L.corpEmail({
  comanda: { numar: "CF-2026-0003", data: "2026-10-21", moneda: "EUR", data_solicitata: "2026-11-05", observatii: "livrare la Afumați" },
  linii: [
    { denumire: "Folie stretch jumbo 15µ", cantitate: 2000, um: "kg", pret_unitar: 1.51 },
    { denumire: "Miez carton 76mm", cantitate: 500, um: "buc", pret_unitar: null },
  ],
  furnizor: "Denelavas",
  semnatura: "Cu stimă,\nCash Machine SRL",
});
const are = (ce) => (corp.includes(ce) ? ok("emailul conține „" + ce + "”") : rau("lipsește din email", ce));
are("CF-2026-0003");
are("Folie stretch jumbo 15µ");
are("2026-11-05");
are("livrare la Afumați");
are("preț de confirmat");
if (/Total comandă/.test(corp)) rau("a scris un total ca și cum ar fi complet, deși o poziție n-are preț");
else ok("totalul spune că o poziție n-are preț, nu se dă drept total final");
if (corp.includes("undefined") || corp.includes("null")) rau("a scăpat un undefined/null în textul trimis furnizorului");
else ok("fără undefined/null în textul trimis afară");

console.log("\nEmailul în engleză (furnizorii din afară):");
const corpEn = L.corpEmail({
  comanda: { numar: "CF-2026-0004", data: "2026-11-05", moneda: "EUR", data_solicitata: "2026-11-20" },
  linii: [
    { denumire: "Packtape acrylic 48mm*60m", cantitate: 28, um: "PALLET", pret_unitar: null },
    { denumire: "Packtape acrylic 48mm*53m", cantitate: 5, um: "PALLET", pret_unitar: 812.5 },
  ],
  furnizor: "WBV",
  limba: "en",
});
for (const ce of ["Dear WBV", "purchase order CF-2026-0004", "price to be confirmed", "812.50 EUR/PALLET", "Requested delivery date: 2026-11-20", "Unloading hours: Monday to Friday, 09:00 – 17:30", "Please confirm receipt", "Best regards"]) {
  if (corpEn.includes(ce)) ok("în engleză scrie „" + ce + "”");
  else rau("lipsește din emailul în engleză", ce);
}
if (/Vă |Bună ziua|preț de confirmat|Cu stimă/.test(corpEn)) rau("a rămas română în emailul în engleză");
else ok("nicio frază în română în emailul în engleză");
if (/Order total/.test(corpEn)) rau("„Order total” deși o poziție n-are preț");
else ok("în engleză, totalul spune și el că lipsește un preț");
are("Orar de descărcare: luni – vineri, 09:00 – 17:30");
const corpRole = L.corpEmail({ comanda: { numar: "CF-1", moneda: "EUR" }, linii: [{ denumire: "Packtape", cantitate: 84672, um: "rola", pret_unitar: 0.23 }], limba: "en" });
if (corpRole.includes("84,672 roll — 0.23 EUR/roll") && corpRole.includes("Order total: 19,474.56 EUR")) ok("în engleză: 84,672 roll, 0.23 EUR, total 19,474.56 — numere și unități englezești");
else rau("numerele sau unitățile nu sunt englezești", corpRole.split("\n").slice(3, 7).join(" / "));
egal("fără `limba`, rămâne în română ca înainte",
  L.corpEmail({ comanda: { numar: "X", moneda: "RON" }, linii: [{ denumire: "a", cantitate: 1, pret_unitar: 1 }] }).startsWith("Bună ziua"),
  true);

console.log("\nLimba documentelor pentru furnizor:");
egal("CIF german → engleză", L.limbaImplicita("DE123927422"), "en");
egal("CIF românesc cu RO → română", L.limbaImplicita("RO27244210"), "ro");
egal("CIF românesc doar cifre → română", L.limbaImplicita("27244210"), "ro");
egal("fără CIF → română", L.limbaImplicita(null), "ro");
egal("prefix scris mic și cu spațiu → tot străin", L.limbaImplicita("de 123 927"), "en");
egal("numere englezești", [L.scrieNumar(84672, "en", 0, 3), L.scrieNumar(0.23, "en", 2, 4), L.scrieNumar(22649.76, "en", 2, 2)], ["84,672", "0.23", "22,649.76"]);
egal("numere românești", [L.scrieNumar(84672, "ro", 0, 3), L.scrieNumar(0.23, "ro", 2, 4)], ["84.672", "0,23"]);
egal("unitățile românești în engleză", ["rola", "rolă", "buc", "palet", "ml", "mp", "tonă"].map((u) => L.umInLimba(u, "en")), ["roll", "roll", "pcs", "pallet", "lin. m", "m²", "t"]);
egal("unitățile care nu sunt românești rămân", ["PALLET", "kg", "set", ""].map((u) => L.umInLimba(u, "en")), ["PALLET", "kg", "set", ""]);
egal("în română unitatea rămâne cum a fost scrisă", L.umInLimba("rola", "ro"), "rola");
egal("orarul de descărcare, în ambele limbi", [L.orarDescarcare("ro"), L.orarDescarcare("en")],
  ["Orar de descărcare: luni – vineri, 09:00 – 17:30", "Unloading hours: Monday to Friday, 09:00 – 17:30"]);

console.log("\nNumărul tastat în câmp (cantitate, preț):");
egal("virgulă", L.numarDinCamp("1,51", 4), { ok: true, valoare: 1.51 });
egal("punct", L.numarDinCamp("1.51", 4), { ok: true, valoare: 1.51 });
egal("spații ignorate", L.numarDinCamp(" 2 000 ", 3), { ok: true, valoare: 2000 });
egal("gol = nescris, nu zero", L.numarDinCamp("", 4), { ok: true, valoare: null });
egal("„1.234,56” e refuzat, nu ghicit", L.numarDinCamp("1.234,56", 4).ok, false);
egal("„12 buc” e refuzat", L.numarDinCamp("12buc", 3).ok, false);
egal("negativ e refuzat", L.numarDinCamp("-3", 3).ok, false);
egal("prețul se taie la patru zecimale", L.numarDinCamp("0,16005859", 4).valoare, 0.1601);
egal("cantitatea la trei", L.numarDinCamp("2,5004", 3).valoare, 2.5);

console.log("\nCursul tastat:");
egal("ca la BNR", L.cursDinCamp("5,0912"), { ok: true, valoare: 5.0912 });
egal("gol = se ia BNR-ul", L.cursDinCamp(""), { ok: true, valoare: null });
egal("zero nu e curs", L.cursDinCamp("0").ok, false);
egal("text nu e curs", L.cursDinCamp("cinci").ok, false);
egal("șase zecimale, nu mai multe", L.cursDinCamp("5,12345678").valoare, 5.123457);

console.log("\nCursurile unei comenzi:");
egal("RON: cursul e 1, euro din curs_eur", L.cursurile({ moneda: "RON", curs: 7, curs_eur: 5.09 }), { moneda: "RON", curs: 1, cursEur: 5.09 });
egal("EUR: cursul euro E cursul comenzii, nu ce stă în curs_eur", L.cursurile({ moneda: "EUR", curs: 5.09, curs_eur: 4.2 }), { moneda: "EUR", curs: 5.09, cursEur: 5.09 });
egal("USD: amândouă", L.cursurile({ moneda: "usd", curs: "4.4", curs_eur: 5.09 }), { moneda: "USD", curs: 4.4, cursEur: 5.09 });
egal("curs lipsă rămâne lipsă", L.cursurile({ moneda: "EUR", curs: null }), { moneda: "EUR", curs: null, cursEur: null });

console.log("\nÎn lei și în euro:");
egal("comandă în euro → lei", L.echivalente(1000, { moneda: "EUR", curs: 5.0912 }), { ron: 5091.2, eur: 1000 });
egal("comandă în lei → euro (moneda standard e RON)", L.echivalente(5091.2, { moneda: "RON", curs_eur: 5.0912 }), { ron: 5091.2, eur: 1000 });
egal("comandă în dolari → lei și euro", L.echivalente(100, { moneda: "USD", curs: 4.5, curs_eur: 5 }), { ron: 450, eur: 90 });
egal("euro din leii nerotunjiți, nu rotunjit de două ori", L.echivalente(33.33, { moneda: "USD", curs: 4.4567, curs_eur: 4.9771 }).eur, 29.85);
egal("în euro fără curs: lei lipsă (nu zero), euro e chiar suma", L.echivalente(1000, { moneda: "EUR", curs: null }), { ron: null, eur: 1000 });
egal("în dolari fără curs: nici lei, nici euro", L.echivalente(1000, { moneda: "USD", curs: null, curs_eur: 5 }), { ron: null, eur: null });
egal("lei fără curs euro: lei da, euro nu", L.echivalente(500, { moneda: "RON" }), { ron: 500, eur: null });
egal("suma lipsă: nimic", L.echivalente(null, { moneda: "EUR", curs: 5 }), { ron: null, eur: null });

console.log("\nCursul scris pentru om:");
egal("patru zecimale ca la BNR", L.scrieCurs(5.0912), "5,0912");
egal("5,1 se scrie 5,1000", L.scrieCurs(5.1), "5,1000");
egal("șase dacă așa a fost pus", L.scrieCurs(5.123456), "5,123456");
egal("lipsă → gol, nu 0", L.scrieCurs(null), "");
egal("abatere față de BNR, în procente", L.abatereFataDeBnr(5.1, 5), 2);
egal("același curs → 0", L.abatereFataDeBnr(5.0912, 5.0912), 0);
egal("fără BNR nu se spune nimic", L.abatereFataDeBnr(5.1, null), null);

console.log("\nIstoricul — capul comenzii:");
const cap = { furnizor: "WBV", data: "2026-11-05", data_solicitata: null, moneda: "EUR", curs: 5.0912, curs_eur: 5.0912, observatii: "CTPark" };
egal("nimic schimbat → nimic scris", L.diferenteAntet(cap, Object.assign({}, cap)), []);
egal("data din bază cu oră și cea din formular sunt aceeași zi",
  L.diferenteAntet(Object.assign({}, cap, { data: "2026-11-05 00:00:00" }), cap), []);
egal("cursul schimbat, cu moneda lui",
  L.diferenteAntet(cap, Object.assign({}, cap, { curs: 5.1, curs_eur: 5.1 })),
  [{ ce: "Curs", vechi: "5,0912 lei/EUR", nou: "5,1000 lei/EUR" }]);
const laLei = L.diferenteAntet(cap, Object.assign({}, cap, { moneda: "RON", curs: null }));
egal("din euro în lei: moneda, cursul care dispare și cursul euro care apare",
  laLei.map((x) => x.ce), ["Moneda", "Curs", "Curs EUR"]);
egal("același număr pe altă monedă e altă schimbare",
  L.diferenteAntet({ moneda: "USD", curs: 4.4 }, { moneda: "GBP", curs: 4.4 }).find((x) => x.ce === "Curs"),
  { ce: "Curs", vechi: "4,4000 lei/USD", nou: "4,4000 lei/GBP" });
egal("furnizorul și observațiile",
  L.diferenteAntet(cap, Object.assign({}, cap, { furnizor: "Altul SRL", observatii: "Afumați" })).map((x) => x.ce),
  ["Furnizor", "Observații"]);

console.log("\nIstoricul — pozițiile, pe ID:");
const vechi = [
  { id: 1, denumire: "Bandă 60m", cantitate: 28, um: "PALLET", pret_unitar: null },
  { id: 2, denumire: "Bandă 53m", cantitate: 5, um: "PALLET", pret_unitar: 812.5 },
  { id: 3, denumire: "Miez", cantitate: 100, um: "buc", pret_unitar: 0 },
];
egal("aceleași valori, unele ca text → nicio schimbare",
  L.diferenteLinii(vechi, [
    { id: 1, denumire: "Bandă 60m", cantitate: "28", um: "PALLET", pret_unitar: null },
    { id: 2, denumire: "Bandă 53m", cantitate: 5, um: "PALLET", pret_unitar: "812.50" },
    { id: 3, denumire: "Miez", cantitate: 100, um: "buc", pret_unitar: 0 },
  ], "EUR"),
  []);
egal("ștergerea poziției din mijloc e O schimbare, nu trei",
  L.diferenteLinii(vechi, [vechi[0], vechi[2]], "EUR"),
  [{ ce: "Poziție ștearsă", vechi: "Bandă 53m — 5 PALLET × 812,50 EUR", nou: "" }]);
egal("prețul pus unde era „de confirmat”",
  L.diferenteLinii(vechi, [Object.assign({}, vechi[0], { pret_unitar: 790 }), vechi[1], vechi[2]], "EUR"),
  [{ ce: "Preț unitar · Bandă 60m", vechi: "fără preț", nou: "790,00 EUR" }]);
egal("zero și „fără preț” nu sunt același lucru",
  L.diferenteLinii(vechi, [vechi[0], vechi[1], Object.assign({}, vechi[2], { pret_unitar: null })], "EUR").length, 1);
egal("cantitate și UM",
  L.diferenteLinii(vechi, [Object.assign({}, vechi[0], { cantitate: 30, um: "palet" }), vechi[1], vechi[2]], "EUR"),
  [{ ce: "Cantitate · Bandă 60m", vechi: "28", nou: "30" }, { ce: "UM · Bandă 60m", vechi: "PALLET", nou: "palet" }]);
egal("poziție adăugată",
  L.diferenteLinii(vechi, vechi.concat([{ id: null, denumire: "Folie", cantitate: 2.5, um: "kg", pret_unitar: 1.51 }]), "EUR"),
  [{ ce: "Poziție adăugată", vechi: "", nou: "Folie — 2,5 kg × 1,51 EUR" }]);
egal("denumirea schimbată se scrie, iar restul poartă numele nou",
  L.diferenteLinii(vechi, [Object.assign({}, vechi[0], { denumire: "Bandă acrilică 60m", cantitate: 29 }), vechi[1], vechi[2]], "EUR").map((x) => x.ce),
  ["Denumire poziție", "Cantitate · Bandă acrilică 60m"]);

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
