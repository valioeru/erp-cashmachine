"use strict";
// Produsul scris direct pe comanda.
//
// CE APARA, in ordinea in care doare daca se strica:
//
//   • NOMENCLATORUL NU SE UMPLE DE DUBLURI. Butonul e la indemana oricarui
//     agent, pe orice linie de comanda. Daca "Banda adeziva 48mm" si
//     "BANDA  ADEZIVA 48 MM" intra ca doua randuri, in sase luni avem iar de
//     lucru la produse-fuziune. Deci denumirea se normalizeaza si se cauta
//     intai printre cele existente.
//
//   • DAR NORMALIZAREA NU LIPESTE PRODUSE DIFERITE. "folie 15 micron" si
//     "folie 23 micron" sunt lucruri diferite. O normalizare care scoate
//     cifrele ar fi fost mai "curata" si ar fi facut o paguba mai mare decat
//     dublura pe care o evita.
//
//   • UN PRODUS FUZIONAT NU SE REUTILIZEAZA. Motorul de fuziune l-a scos deja
//     din joc; legat de o comanda noua, ar reinvia un id mort.
//
//   • CE INTRA ASA E MARCAT PROVIZORIU. Altfel ajunge in nomenclator un articol
//     fara cod si fara pret de achizitie pe care nu-l mai verifica nimeni.
//
//   • DENUMIREA NU AJUNGE COD. "1699" scris in casuta de denumire e un cod pus
//     gresit, nu un produs.
//
// Partea de logica nu atinge baza. Partea de final ruleaza pe PostgreSQL real
// exact instructiunile pe care le da ruta (vezi test-depozit.js pentru de ce).
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};

const R = require(path.join(RAD, "lib", "produs-rapid.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu ? "  -> " + detaliu : "")); esecuri++; }
}
function psql(sql) {
  return execFileSync("psql", ["-X", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV })
    .toString()
    .trim();
}
// psql lipeste eticheta comenzii ("INSERT 0 1") sub rezultatul lui RETURNING.
// Lasata asa, ajunge in interogarea urmatoare si o face sa crape.
function unul(sql) {
  return psql(sql).split("\n")[0].trim();
}

console.log("\n1. Normalizarea denumirii");
{
  const k = R.cheieDenumire;
  bine("diacriticele si majusculele nu conteaza", k("Bandă Adezivă") === k("BANDA ADEZIVA"));
  bine("spatiile duble si semnele nu conteaza", k("Banda  adeziva, 48mm") === k("banda adeziva 48 mm"));
  bine("sirul gol nu crapa", k(null) === "" && k(undefined) === "");
  bine(
    "doua grosimi diferite raman produse diferite",
    k("folie stretch 15 micron") !== k("folie stretch 23 micron")
  );
  bine("cifrele nu se pierd", k("Cutie CO3") === "cutie co 3", k("Cutie CO3"));
  bine(
    "48mm si 48 mm sunt acelasi produs - cazul cel mai des intalnit",
    k("Banda adeziva 48mm") === k("Banda adeziva 48 mm")
  );
}

console.log("\n2. Validarea a ce vine prin HTTP");
{
  bine("denumire prea scurta e refuzata", !!R.validare({ denumire: "ba" }).eroare);
  bine("denumire lipsa e refuzata", !!R.validare({}).eroare);
  bine("numai cifre e refuzat (e un cod, nu o denumire)", !!R.validare({ denumire: "1699" }).eroare);
  bine("denumire peste 200 de caractere e refuzata", !!R.validare({ denumire: "a".repeat(201) }).eroare);

  const v = R.validare({ denumire: "  Banda   adeziva  48 mm ", categorie: "Benzi adezive", um: "role" });
  bine("spatiile multiple se strang", v.denumire === "Banda adeziva 48 mm", v.denumire);
  bine("categoria trece mai departe", v.categorie === "Benzi adezive");
  bine("unitatea trece mai departe", v.um === "role");

  const g = R.validare({ denumire: "Produs fara nimic" });
  bine("fara unitate, implicit buc", g.um === "buc");
  bine("fara categorie, ramane null (o completeaza achizitiile)", g.categorie === null);
  bine("unitatea prea lunga se taie, nu crapa", R.validare({ denumire: "Test", um: "x".repeat(40) }).um.length === 12);
}

console.log("\n3. Potrivirea cu ce exista deja");
{
  const cheie = R.cheieDenumire("Banda adeziva 48 mm");
  const lista = [
    { id: 1, denumire: "Cutie CO3", activ: 1, fuzionat_in: null },
    { id: 2, denumire: "BANDĂ  ADEZIVĂ, 48MM", activ: 1, fuzionat_in: null },
  ];
  bine("gaseste acelasi produs scris altfel", (R.potrivire(lista, cheie) || {}).id === 2);
  bine(
    "un produs fuzionat NU se reutilizeaza",
    R.potrivire([{ id: 2, denumire: "Banda adeziva 48 mm", activ: 1, fuzionat_in: 9 }], cheie) === null
  );
  bine(
    "un produs dezactivat NU se reutilizeaza",
    R.potrivire([{ id: 2, denumire: "Banda adeziva 48 mm", activ: 0, fuzionat_in: null }], cheie) === null
  );
  bine("lista goala nu crapa", R.potrivire([], cheie) === null && R.potrivire(null, cheie) === null);
  bine(
    "nu confunda doua grosimi",
    R.potrivire([{ id: 5, denumire: "folie 23 micron", activ: 1, fuzionat_in: null }],
      R.cheieDenumire("folie 15 micron")) === null
  );
}

console.log("\n4. Pe PostgreSQL real: ce scrie efectiv ruta");
try {
  psql("SELECT 1");
} catch (e) {
  console.log("  (sarit: nu e pornita baza de test pe 127.0.0.1:5433)");
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
}

psql("DELETE FROM produse WHERE denumire LIKE 'TSTRAPID%'");
try {
  const v = R.validare({ denumire: "TSTRAPID Banda adeziva 48 mm", categorie: "Benzi adezive", um: "role" });
  const id = unul(
    "INSERT INTO produse (denumire, categorie, unitate_masura, activ, provizoriu, creat_de, creat_la) VALUES (" +
      "'" + v.denumire.replace(/'/g, "''") + "', '" + v.categorie.replace(/'/g, "''") + "', '" + v.um + "'," +
      " 1, 1, NULL, '2026-10-22 12:00:00') RETURNING id"
  );
  bine("produsul se insereaza", /^\d+$/.test(id), id);

  const rand = psql(
    "SELECT activ, provizoriu, unitate_masura, COALESCE(cod,'(fara cod)') FROM produse WHERE id = " + id
  ).split("|");
  bine("ramane ACTIV, ca sa poata fi comandat chiar acum", rand[0] === "1", rand[0]);
  bine("dar e marcat PROVIZORIU", rand[1] === "1", rand[1]);
  bine("pastreaza unitatea scrisa de agent", rand[2] === "role", rand[2]);
  bine("intra fara cod - codul il pune achizitiile", rand[3] === "(fara cod)", rand[3]);

  // A doua oara, scris altfel: ruta cauta intai printre cele existente.
  const existente = psql(
    "SELECT id, denumire, activ, COALESCE(fuzionat_in::text,'') FROM produse WHERE denumire LIKE 'TSTRAPID%'"
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const c = l.split("|");
      return { id: Number(c[0]), denumire: c[1], activ: Number(c[2]), fuzionat_in: c[3] ? Number(c[3]) : null };
    });
  const dinNou = R.validare({ denumire: "TSTRAPID  BANDĂ ADEZIVĂ, 48MM" });
  const gasit = R.potrivire(existente, dinNou.cheie);
  bine("a doua oara il gaseste pe primul, nu mai insereaza", gasit && String(gasit.id) === String(id), String(gasit && gasit.id));

  // Lista de verificat il contine, pana il confirma cineva.
  const inLista = psql("SELECT COUNT(*) FROM produse WHERE id = " + id + " AND provizoriu = 1 AND COALESCE(activ,1) = 1");
  bine("apare in lista de verificat", inLista === "1", inLista);

  psql("UPDATE produse SET provizoriu = 0 WHERE id = " + id);
  const dupa = psql("SELECT provizoriu FROM produse WHERE id = " + id);
  bine("dupa confirmare iese din lista", dupa === "0", dupa);
} finally {
  psql("DELETE FROM produse WHERE denumire LIKE 'TSTRAPID%'");
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
