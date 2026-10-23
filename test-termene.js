"use strict";
// Termenul cerut si termenul raspuns.
//
// CE APARA:
//
//   • O CERERE FARA TERMEN NU PLEACA. Pana acum, daca pe comanda nu era
//     completata data de livrare, cererea catre productie pleca cu termen
//     gol. Nu se poate intarzia ceva ce n-are termen, deci nu se poate
//     urmari, deci nimeni nu afla ca s-a uitat.
//
//   • AMANAREA SE VEDE, NU SE DEDUCE. Doua coloane alaturate pe care
//     trebuie sa le compari cu ochiul nu sunt o alerta.
//
//   • CE CONTEAZA E TERMENUL CLIENTULUI, NU CEL INTERN. Productia poate
//     amana cu trei zile si sa fie in regula, sau sa confirme exact ce i
//     s-a cerut si tot sa depaseasca data promisa clientului — daca
//     termenul cerut era deja prea tarziu.
//
//   • CINE MUTA TERMENUL SPUNE DE CE. Peste doua saptamani nimeni nu-si
//     mai aminteste.
const path = require("path");
const T = require(path.join(__dirname, "lib", "termene.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu ? "  -> " + detaliu : "")); esecuri++; }
}

console.log("\n1. Termenul cerut e obligatoriu");
{
  bine("gol e refuzat", !!T.validareTermenCerut("", { azi: "2026-10-23" }).eroare);
  bine("null e refuzat", !!T.validareTermenCerut(null, { azi: "2026-10-23" }).eroare);
  bine(
    "mesajul spune DE CE, nu doar ca e obligatoriu",
    /urmărită/.test(T.validareTermenCerut("", {}).eroare || "")
  );
  bine("text care nu e data", !!T.validareTermenCerut("saptamana viitoare", {}).eroare);
  bine("data inexistenta", !!T.validareTermenCerut("2026-02-31", {}).eroare);
  bine("data in trecut", !!T.validareTermenCerut("2026-10-01", { azi: "2026-10-23" }).eroare);
  bine("azi e acceptat", T.validareTermenCerut("2026-10-23", { azi: "2026-10-23" }).termen === "2026-10-23");
  bine("o data viitoare trece", T.validareTermenCerut("2026-11-25", { azi: "2026-10-23" }).termen === "2026-11-25");
}

console.log("\n2. Compararea raspunsului cu ce s-a cerut");
{
  bine("acelasi termen = confirmat", T.compara("2026-11-25", "2026-11-25").fel === "confirmat");
  const a = T.compara("2026-11-25", "2026-12-15");
  bine("mai tarziu = amanat", a.fel === "amanat" && a.zile === 20, String(a.zile));
  bine("amanarea e rosie", a.culoare === "rosu");
  bine("eticheta spune cu cate zile", /20 zile/.test(a.eticheta));
  const d = T.compara("2026-11-25", "2026-11-24");
  bine("mai devreme = devansat, si e bine", d.fel === "devansat" && d.culoare === "verde");
  bine("o zi se scrie la singular", /1 zi$/.test(d.eticheta), d.eticheta);
  bine("fara raspuns inca", T.compara("2026-11-25", null).fel === "fara_raspuns");
  bine("fara termen cerut e rosu, nu neutru", T.compara(null, "2026-11-25").culoare === "rosu");
}

console.log("\n3. Fata de ce i s-a promis clientului — verificarea care conteaza");
{
  const ok = T.fataDeClient("2026-11-20", "2026-11-25");
  bine("raspuns inainte de data clientului: in termen", ok.fel === "in_termen" && ok.culoare === "verde");
  bine("fix in ziua clientului: tot in termen", T.fataDeClient("2026-11-25", "2026-11-25").fel === "in_termen");
  const rau = T.fataDeClient("2026-12-15", "2026-11-25");
  bine("dupa data clientului: alerta", rau.fel === "depaseste_clientul" && rau.intarziere === 20);
  bine("eticheta zice ce sa faci, nu doar ca e rau", /sună clientul/.test(rau.eticheta), rau.eticheta);
  bine("comanda fara data de livrare se semnaleaza", T.fataDeClient("2026-12-15", null).fel === "fara_data_client");

  // Cazul care scapa printre degete: productia confirma EXACT ce i s-a
  // cerut, deci intern totul pare verde, dar termenul cerut era deja dupa
  // data promisa clientului.
  const capcana = T.compara("2026-12-10", "2026-12-10");
  bine("intern arata confirmat", capcana.fel === "confirmat" && capcana.culoare === "verde");
  bine(
    "dar fata de client tot e depasire",
    T.fataDeClient("2026-12-10", "2026-11-25").fel === "depaseste_clientul"
  );
}

console.log("\n4. Raspunsul celui care executa");
{
  bine(
    "confirma termenul cerut, fara motiv: trece",
    T.validareRaspuns({ termen: "2026-11-25" }, "2026-11-25").termen === "2026-11-25"
  );
  bine(
    "da un termen mai tarziu FARA motiv: refuzat",
    !!T.validareRaspuns({ termen: "2026-12-15" }, "2026-11-25").eroare
  );
  bine(
    "da un termen mai tarziu CU motiv: trece",
    T.validareRaspuns({ termen: "2026-12-15", motiv: "asteptam granula" }, "2026-11-25").termen === "2026-12-15"
  );
  bine(
    "motivul se pastreaza",
    T.validareRaspuns({ termen: "2026-12-15", motiv: "asteptam granula" }, "2026-11-25").motiv === "asteptam granula"
  );
  bine(
    "mai devreme fara motiv e in regula",
    !T.validareRaspuns({ termen: "2026-11-20" }, "2026-11-25").eroare
  );
  bine("fara termen deloc", !!T.validareRaspuns({}, "2026-11-25").eroare);
  bine("termen invalid", !!T.validareRaspuns({ termen: "candva" }, "2026-11-25").eroare);
  bine(
    "comparatia vine odata cu raspunsul, sa n-o recalculeze pagina",
    T.validareRaspuns({ termen: "2026-12-15", motiv: "x" }, "2026-11-25").comparatie.zile === 20
  );
}

console.log("\n5. Numaratoarea de zile");
{
  bine("peste an", T.zile("2026-12-28", "2027-01-04") === 7);
  bine("an bisect", T.zile("2028-02-28", "2028-03-01") === 2);
  bine("aceeasi zi", T.zile("2026-11-25", "2026-11-25") === 0);
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
