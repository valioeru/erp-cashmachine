"use strict";
// Cantitatea comenzii: numărul într-o coloană, unitatea în alta.
//
// Până acum pe comenzi scria „120 buc" într-o singură celulă. Arată bine și nu
// se poate folosi la nimic: coloana se sortează ca text (deci „1.200" vine
// înaintea lui „90"), nu se adună, iar copiată în Excel aterizează ca text.
//
// Partea delicată: `comenzi_productie.cantitate` e TEXT, nu număr — registrul
// de comenzi vine dintr-un Excel completat de mână, unde scrie „120", „120
// buc" sau „1.200". De-aia despărțirea NU reinterpretează numărul, doar mută
// coada în coloana ei. Dacă l-ar normaliza, „1.200" ar putea deveni 1,2 și s-ar
// strica o comandă de 1.200 de bucăți fără ca nimeni să observe.
//
// Ce se verifică:
//   1. despărțirea pe toate formele care apar în date;
//   2. numărul rămâne scris exact cum a fost scris (fără „normalizare");
//   3. unitatea din coloana `um` bate ce scrie în text;
//   4. nu se inventează „buc" când nu există unitate;
//   5. paginile comenzii chiar au două câmpuri, nu unul;
//   6. tabelele au tot atâtea celule câte capete de coloană — exact bug-ul
//      care apare când adaugi o coloană și uiți rândul de total.
//
// Se rulează din rădăcina repo-ului. Nu are nevoie de bază de date.
const path = require("path");
const fs = require("fs");
const Module = require("module");

const RAD = __dirname;
// render.js trage după el auth.js → db.js → `pg`, care nu e instalat aici
// (registrul npm e blocat în container). Testul nu atinge baza, deci punem un
// `pg` de carton ca să poată fi încărcat modulul.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5433/erp";
const origLoad = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return origLoad.apply(this, arguments);
};
const { despartCantitate, cantitate, unitate } = require(path.join(RAD, "lib", "render.js"));

let picate = 0;
function bine(nume, conditie, detaliu) {
  if (conditie) console.log(`  ok   ${nume}`);
  else { picate++; console.log(`  PICAT ${nume}${detaliu !== undefined ? ": " + detaliu : ""}`); }
}
const egal = (nume, gasit, asteptat) =>
  bine(nume, JSON.stringify(gasit) === JSON.stringify(asteptat), `am ${JSON.stringify(gasit)}, așteptam ${JSON.stringify(asteptat)}`);

(async () => {
  console.log("Cantitatea comenzii: numărul separat de unitate\n");

  console.log("despărțirea, pe formele care chiar apar în date:");
  egal('„120" + um „buc"', despartCantitate("120", "buc"), { numar: "120", um: "buc" });
  egal('„120 buc" fără coloana um', despartCantitate("120 buc", null), { numar: "120", um: "buc" });
  egal('„120 buc" ȘI um „buc" — nu iese „buc buc"', despartCantitate("120 buc", "buc"), { numar: "120", um: "buc" });
  egal("numărul singur, fără unitate nicăieri", despartCantitate("500", null), { numar: "500", um: "" });
  egal("cantitate goală", despartCantitate("", "buc"), { numar: "", um: "buc" });
  egal("cantitate lipsă cu totul", despartCantitate(null, null), { numar: "", um: "" });
  egal("text fără niciun număr rămâne întreg", despartCantitate("la comandă", null), { numar: "la comandă", um: "" });
  egal("unitate pe două cuvinte", despartCantitate("12 role mari", null), { numar: "12", um: "role mari" });
  egal("un număr dat ca number, nu ca text", despartCantitate(250, "kg"), { numar: "250", um: "kg" });

  console.log("\nnumărul NU se reinterpretează:");
  egal('„1.200" rămâne „1.200", nu devine 1,2', despartCantitate("1.200", "buc"), { numar: "1.200", um: "buc" });
  egal('„2,5" rămâne „2,5"', despartCantitate("2,5", "to"), { numar: "2,5", um: "to" });
  egal('„1.200 buc" se desparte, dar numărul rămâne', despartCantitate("1.200 buc", null), { numar: "1.200", um: "buc" });
  egal("spațiul ca separator de mii se păstrează", despartCantitate("10 000", "buc"), { numar: "10 000", um: "buc" });

  console.log("\nunitatea explicită bate textul, și nu se inventează:");
  egal("um din coloană câștigă", despartCantitate("12 role", "buc"), { numar: "12", um: "buc" });
  bine('fără unitate nicăieri, afișăm „—", nu „buc"', unitate("500", null) === "—", unitate("500", null));
  bine("cantitate() dă doar numărul", cantitate("120 buc", "buc") === "120", cantitate("120 buc", "buc"));
  bine("unitate() dă doar unitatea", unitate("120 buc", "buc") === "buc", unitate("120 buc", "buc"));

  // ---- paginile ---------------------------------------------------------
  console.log("\npaginile comenzii au două câmpuri, nu unul:");
  const surse = {
    "modules/productie.js": fs.readFileSync(path.join(RAD, "modules", "productie.js"), "utf8"),
    "modules/comision.js": fs.readFileSync(path.join(RAD, "modules", "comision.js"), "utf8"),
    "modules/utilaje.js": fs.readFileSync(path.join(RAD, "modules", "utilaje.js"), "utf8"),
  };
  for (const [fisier, s] of Object.entries(surse)) {
    bine(`${fisier}: nu mai lipește cantitatea de unitate`,
      !/\[c\.cantitate, c\.um\]\.filter\(Boolean\)\.join/.test(s),
      (s.match(/\[c\.cantitate, c\.um\][^\n]*/) || [""])[0]);
  }
  bine("fișa tipărită a comenzii are rând de UM", /<tr><th>UM<\/th>/.test(surse["modules/productie.js"]));
  bine("pagina comenzii are câmp de UM", /<div class="k">UM<\/div>/.test(surse["modules/productie.js"]));
  bine("pagina de alocare are câmp de UM", /<div class="k">UM<\/div>/.test(surse["modules/utilaje.js"]));

  // ---- coloanele se potrivesc ------------------------------------------
  //
  // Când adaugi o coloană, trei locuri trebuie să se miște: capul de tabel,
  // rândurile și rândul de total. Dacă uiți unul, tabelul iese strâmb și
  // cifrele ajung sub alt cap de coloană — greșeala se vede abia pe ecran.
  console.log("\ntabelele au tot atâtea celule câte coloane:");
  const { table } = require(path.join(RAD, "lib", "render.js"));

  // tabelul de comenzi din „Comisionul meu", exact ca în modul
  const capComision = ["Comanda", "Client", "Produs", "Cantitate", "UM", "Livrare", "Valoare", "De unde e valoarea", "Comision (2%)"];
  const randComision = ["20260826-002", "ELHOR", "Folie Stretch", cantitate("120", "buc"), unitate("120", "buc"), "2026-09-04", "3.378,14 lei", "media", "67,56 lei"];
  const totalComision = ["Total", "", "", "", "", "", "3.378,14 lei", "", "67,56 lei"];
  egal("comision — cap, rând și total au aceeași lățime",
    [capComision.length, randComision.length, totalComision.length], [9, 9, 9]);
  const htmlComision = table(capComision, [randComision], { total: totalComision });
  egal("și în HTML-ul randat",
    [(htmlComision.match(/<th[ >]/g) || []).length, (htmlComision.match(/<tbody[\s\S]*?<\/tbody>/) || [""])[0].match(/<td[ >]/g).length],
    [9, 9]);

  // același lucru pentru capul din sursă: dacă cineva scoate „UM" din cap dar
  // o lasă în rânduri, testul de mai sus trece, ăsta nu
  const sComision = surse["modules/comision.js"];
  bine('capul din cod conține „Cantitate", "UM"',
    /"Produs", "Cantitate", "UM", "Livrare"/.test(sComision),
    (sComision.match(/\["Comanda"[^\]]*\]/) || [""])[0].slice(0, 160));
  // Căutăm rândul de total AL TABELULUI DE COMENZI, nu primul din fișier:
  // comision.js are mai multe tabele cu total, iar o potrivire lacomă ar fi
  // măsurat alt tabel și ar fi trecut degeaba.
  const deLa = sComision.indexOf('"De unde e valoarea"');
  const totalDinCod = (sComision.slice(deLa).match(/\{ total: \["Total"[^\]]*\]/) || [""])[0];
  egal("rândul de total al tabelului de comenzi are 9 celule",
    (totalDinCod.match(/,/g) || []).length + 1, 9);

  const sProd = surse["modules/productie.js"];
  bine('tabelul de alocare are „Cantitate", "UM" în cap',
    /"Produs", "Cantitate", "UM", "Livrare"/.test(sProd),
    (sProd.match(/\["#", "Client"[^\]]*\]/) || [""])[0].slice(0, 160));

  console.log(picate ? `\n${picate} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(picate ? 1 : 0);
})().catch((e) => {
  console.error("Testul a crăpat:", e.message);
  process.exit(2);
});
