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

console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
process.exit(rele ? 1 : 0);
