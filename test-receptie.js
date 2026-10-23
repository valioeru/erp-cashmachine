"use strict";
// Recepția mărfii — regulile.
//
// CE APARA:
//
//   • STOCUL NU SE SCRIE DE DOUA ORI. Buton apasat de doua ori, refresh pe
//     POST, doua tab-uri: oricare ar dubla marfa pe stoc.
//
//   • CAT A VENIT NU E CAT S-A ANUNTAT. Daca lipsa trece fara sa spuna
//     nimeni nimic, receptia nu verifica — doar semneaza.
//
//   • MARFA INTOARSA NU E MARFA NOUA. Un retur nedeclarat ca bun intra in
//     stocul vandabil si se vinde a doua oara.
//
//   • MARFA FARA LOC E MARFA PIERDUTA.
const path = require("path");
const R = require(path.join(__dirname, "lib", "receptie.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 200) : "")); esecuri++; }
}

const LINIE = { id: 1, denumire: "Folie stretch 23µ", cantitate_asteptata: 100, um: "buc" };

console.log("\n1. Cât a venit de fapt");
{
  const ok = R.validareLinie(LINIE, { cantitate_primita: "100", loc_id: "5" }, { sursa: "furnizor", cereLoc: true });
  bine("exact cât s-a anunțat: trece", !ok.eroare && ok.cantitate_primita === 100, ok.eroare);
  bine("și nu are lipsă", ok.lipsa === 0 && ok.lipsa_reala === false);

  // Campul gol nu e zero: sunt doua lucruri diferite.
  const gol = R.validareLinie(LINIE, { cantitate_primita: "", loc_id: "5" }, { sursa: "furnizor", cereLoc: true });
  bine("gol e refuzat", !!gol.eroare);
  bine("și spune ce să scrie dacă n-a venit nimic", /scrie 0/.test(gol.eroare), gol.eroare);

  const zero = R.validareLinie(LINIE, { cantitate_primita: "0", motiv: "n-a livrat" }, { sursa: "furnizor", cereLoc: true });
  bine("zero cu motiv trece", !zero.eroare, zero.eroare);
  bine("și rândul iese respins, nu primit", zero.stare === "respinsa");
  bine("fără loc, fiindcă n-are ce să pună nicăieri", zero.loc_id === null);
}

console.log("\n2. Lipsa cere explicație");
{
  const fara = R.validareLinie(LINIE, { cantitate_primita: "80", loc_id: "5" }, { sursa: "furnizor", cereLoc: true });
  bine("20 lipsă fără motiv: refuzat", !!fara.eroare);
  bine("și la furnizor se spune că pe asta se face reclamația", /reclamația la furnizor/.test(fara.eroare), fara.eroare);

  const dinProductie = R.validareLinie(LINIE, { cantitate_primita: "80", loc_id: "5" }, { sursa: "productie", cereLoc: true });
  bine("la producție mesajul e altul: e pierdere, nu reclamație", /pierderea nu se vede/.test(dinProductie.eroare), dinProductie.eroare);

  const cu = R.validareLinie(LINIE, { cantitate_primita: "80", loc_id: "5", motiv: "un bax spart" }, { sursa: "furnizor", cereLoc: true });
  bine("cu motiv trece", !cu.eroare, cu.eroare);
  bine("lipsa se calculează", cu.lipsa === 20 && cu.lipsa_reala === true);
  bine("și motivul se păstrează", cu.motiv === "un bax spart");

  // Sub pragul de cantar nu se cere explicatie pentru fiecare gram.
  const mic = R.validareLinie(LINIE, { cantitate_primita: "99", loc_id: "5" }, { sursa: "furnizor", cereLoc: true });
  bine("o lipsă de 1% trece fără explicație", !mic.eroare, mic.eroare);
  bine("dar se vede că lipsește ceva", mic.lipsa === 1 && mic.lipsa_reala === false);
}

console.log("\n3. Mai mult decât s-a anunțat");
{
  const fara = R.validareLinie(LINIE, { cantitate_primita: "120", loc_id: "5" }, { sursa: "furnizor", cereLoc: true });
  bine("surplusul fără explicație nu trece", !!fara.eroare);
  bine("fiindcă ajunge pe stoc marfă necomandată", /necomandată/.test(fara.eroare), fara.eroare);
  const cu = R.validareLinie(LINIE, { cantitate_primita: "120", loc_id: "5", motiv: "a trimis un bax în plus" }, { sursa: "furnizor", cereLoc: true });
  bine("cu explicație trece", !cu.eroare && cu.in_plus === 20, cu.eroare);
}

console.log("\n4. Returul nu e o cumpărare");
{
  const fara = R.validareLinie(LINIE, { cantitate_primita: "100", loc_id: "5" }, { sursa: "retur_tert", cereLoc: true });
  bine("retur fără starea mărfii: refuzat", !!fara.eroare);
  bine("și se spune de ce", /se vinde a doua oară/.test(fara.eroare), fara.eroare);

  const bun = R.validareLinie(LINIE, { cantitate_primita: "100", loc_id: "5", conditie: "bun" }, { sursa: "retur_tert", cereLoc: true });
  bine("declarat bun: intră în stocul vandabil", !bun.eroare && bun.vandabila === true, bun.eroare);

  const stricat = R.validareLinie(LINIE, { cantitate_primita: "100", conditie: "deteriorat" }, { sursa: "retur_fulfilment", cereLoc: true });
  bine("deteriorat: trece, dar NU e vandabil", !stricat.eroare && stricat.vandabila === false, stricat.eroare);
  bine("și nu i se cere raft în depozitul de marfă bună", stricat.loc_id === null);

  const aiurea = R.validareLinie(LINIE, { cantitate_primita: "100", loc_id: "5", conditie: "cam asa" }, { sursa: "retur_tert", cereLoc: true });
  bine("o stare inventată nu trece", !!aiurea.eroare);

  // La marfa de la furnizor nu se cere starea: e marfa noua.
  const nou = R.validareLinie(LINIE, { cantitate_primita: "100", loc_id: "5" }, { sursa: "furnizor", cereLoc: true });
  bine("la furnizor nu se cere starea", !nou.eroare && nou.conditie === "bun");
}

console.log("\n4b. Stocul inițial: se numără, nu se verifică");
{
  // Marfa care era deja pe rafturi cand a pornit ERP-ul. Nimeni n-a anuntat
  // nimic, deci „cantitate_asteptata" e 0 si NU exista surplus de explicat.
  const gol = { cantitate_asteptata: 0, denumire: "Folie veche" };
  const r = R.validareLinie(gol, { cantitate_primita: "340", loc_id: "7" }, { sursa: "inventar_initial", cereLoc: true });
  bine("340 numărate, fără nimic anunțat: trece fără explicații", !r.eroare && r.cantitate_primita === 340, r.eroare);
  bine("și nu inventează o lipsă", r.lipsa_reala === false);
  bine("marfa intră pe stocul vandabil", r.vandabila === true);
  // Locul se cere si aici: tot acolo o cauti mai tarziu.
  bine("dar raftul tot se cere", !!R.validareLinie(gol, { cantitate_primita: "340" }, { sursa: "inventar_initial", cereLoc: true }).eroare);

  // Daca regula de surplus s-ar aplica, omul ar scrie „x" la fiecare rand si
  // coloana de motive ar deveni zgomot.
  const multe = R.validareLinie({ cantitate_asteptata: 0 }, { cantitate_primita: "9999", loc_id: "7" }, { sursa: "inventar_initial", cereLoc: true });
  bine("oricât de mult, tot nu cere motiv", !multe.eroare, multe.eroare);

  // La o livrare de la furnizor, acelasi caz CERE explicatie.
  const furnizor = R.validareLinie({ cantitate_asteptata: 0 }, { cantitate_primita: "10", loc_id: "7" }, { sursa: "furnizor", cereLoc: true });
  bine("la furnizor însă, marfa neanunțată cere explicație", !!furnizor.eroare, furnizor.eroare);
}

console.log("\n5. Marfa fără loc");
{
  const fara = R.validareLinie(LINIE, { cantitate_primita: "100" }, { sursa: "furnizor", cereLoc: true });
  bine("marfă bună fără raft: refuzat", !!fara.eroare);
  bine("cu mesajul care spune de ce contează", /peste două săptămâni/.test(fara.eroare), fara.eroare);
  const fns = R.validareLinie(LINIE, { cantitate_primita: "100" }, { sursa: "furnizor", cereLoc: false });
  bine("dacă depozitul n-are locuri definite, nu se cere", !fns.eroare);
}

console.log("\n6. Finalizarea nu se poate face de două ori");
{
  const linii = [
    { stare: "primita", cantitate_asteptata: 100, cantitate_primita: 100, conditie: "bun" },
    { stare: "primita", cantitate_asteptata: 50, cantitate_primita: 50, conditie: "bun" },
  ];
  const ok = R.validareFinalizare({ stare: "in_lucru" }, linii);
  bine("o recepție completă se poate închide", !ok.eroare, ok.eroare);
  bine("și se știe cât intră pe stocul vandabil", ok.cantitateVandabila === 150, ok.cantitateVandabila);

  // Linia care apara stocul.
  const dinNou = R.validareFinalizare({ stare: "finalizata" }, linii);
  bine("a doua oară: refuzat", !!dinNou.eroare);
  bine("și se spune exact ce s-ar întâmpla", /l-ar dubla/.test(dinNou.eroare), dinNou.eroare);

  bine("o recepție anulată nu se finalizează", !!R.validareFinalizare({ stare: "anulata" }, linii).eroare);
  bine("una fără rânduri, nici atât", !!R.validareFinalizare({ stare: "in_lucru" }, []).eroare);
}

console.log("\n7. Nu se închide cu rânduri neatinse");
{
  const linii = [
    { stare: "primita", cantitate_asteptata: 100, cantitate_primita: 100 },
    { stare: "de_primit", cantitate_asteptata: 50, cantitate_primita: 0 },
    { stare: "de_primit", cantitate_asteptata: 20, cantitate_primita: 0 },
  ];
  const r = R.validareFinalizare({ stare: "in_lucru" }, linii);
  bine("refuzat", !!r.eroare);
  bine("și spune câte au rămas", /Mai sunt 2 rânduri/.test(r.eroare), r.eroare);
  const unul = R.validareFinalizare({ stare: "in_lucru" }, linii.slice(0, 2));
  bine("la unul singur, se scrie la singular", /Mai e un rând/.test(unul.eroare), unul.eroare);
}

console.log("\n8. Ce se raportează la finalizare");
{
  const linii = [
    { stare: "primita", cantitate_asteptata: 100, cantitate_primita: 90, conditie: "bun" },
    { stare: "primita", cantitate_asteptata: 50, cantitate_primita: 50, conditie: "deteriorat" },
    { stare: "respinsa", cantitate_asteptata: 30, cantitate_primita: 0, conditie: "lipsa" },
  ];
  const r = R.validareFinalizare({ stare: "in_lucru" }, linii);
  bine("intră două rânduri pe stoc", r.deIntrat.length === 2);
  bine("unul e respins", r.respinse.length === 1);
  bine("două au lipsă față de cât s-a anunțat", r.lipsuri.length === 2, r.lipsuri.length);
  bine("unul a venit stricat", r.nevandabile.length === 1);
  // 90 bune; cele 50 deteriorate NU intra in stocul din care se vinde.
  bine("pe stocul vandabil intră doar 90", r.cantitateVandabila === 90, r.cantitateVandabila);
}

console.log("\n9. Rezumatul de pe listă");
{
  const z = R.rezumat([
    { stare: "primita", cantitate_asteptata: 10, cantitate_primita: 10 },
    { stare: "de_primit", cantitate_asteptata: 10, cantitate_primita: 0 },
    { stare: "primita", cantitate_asteptata: 10, cantitate_primita: 8, conditie: "deteriorat" },
    { stare: "de_primit", cantitate_asteptata: 5, cantitate_primita: 0 },
  ]);
  bine("4 rânduri, 2 făcute", z.total === 4 && z.gata === 2 && z.ramase === 2);
  bine("jumătate", z.procent === 50);
  bine("trei cu lipsă (cele neatinse încă n-au venit)", z.cuLipsa === 3, z.cuLipsa);
  bine("unul stricat", z.stricate === 1);
  bine("o recepție goală nu împarte la zero", R.rezumat([]).procent === 0);
}

console.log("\n10. Zecimale și virgulă");
{
  const l = { cantitate_asteptata: 0.3 };
  const r = R.validareLinie(l, { cantitate_primita: "0,3", loc_id: "1" }, { sursa: "furnizor", cereLoc: true });
  bine("virgula merge ca punctul", !r.eroare && r.cantitate_primita === 0.3, r.eroare);
  bine("și 0.1+0.2 nu inventează o lipsă", r.lipsa_reala === false, r.lipsa);
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
