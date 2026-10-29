"use strict";
// Coloanele care se pot ascunde si trage de margine.
//
// CE APARA:
//
//   • UN TABEL FARA CHEIE RAMANE EXACT CUM ERA. Functia table() e chemata din
//     vreo suta de locuri. Daca varianta fara optiuni s-ar schimba cu un
//     caracter, as atinge toate paginile aplicatiei deodata.
//
//   • RANDUL GOL NU SE ASCUNDE. "Niciun rand inca" e un singur td cu colspan
//     peste tot tabelul. Daca scriptul i-ar pune display:none pentru ca e pe
//     pozitia unei coloane ascunse, tabelul gol ar arata ca o pagina stricata.
//
//   • TRAGEREA DE MARGINE NU SORTEAZA TABELUL. Capetele sunt sortabile la
//     click, iar o tragere scurta e si un click.
const path = require("path");
const Module = require("module");
process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const R = require(path.join(__dirname, "lib", "render.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 200) : "")); esecuri++; }
}

const CAPETE = ["Nr", "Client", "Produs"];
const RANDURI = [["1", "Aquila", "Folie"], ["2", "Profi", "Pungi"]];

console.log("\n1. Fara cheie, nimic nu se schimba");
{
  const t = R.table(CAPETE, RANDURI);
  bine("nu apare atributul data-tabel", !/data-tabel/.test(t));
  bine("nu apare panoul de coloane", !/coloane-panou/.test(t));
  bine("incepe direct cu tabelul", t.trim().startsWith("<table"), t.slice(0, 40));
}

console.log("\n2. Cu cheie, apar si panoul si marcajul");
{
  const t = R.table(CAPETE, RANDURI, { coloane: "comenzi-productie" });
  bine("tabelul e marcat cu cheia", /<table class="table" data-tabel="comenzi-productie">/.test(t));
  bine("panoul e legat de acelasi tabel", /data-coloane-pentru="comenzi-productie"/.test(t));
  bine("panoul are unde sa-si puna bifele", /data-lista/.test(t));
  bine("si un drum inapoi la toate coloanele", /data-reset/.test(t));
  bine("panoul sta inaintea tabelului", t.indexOf("coloane-panou") < t.indexOf("<table"));
  bine("randurile sunt neatinse", /Aquila/.test(t) && /Profi/.test(t));
}

console.log("\n3. Cheia se curata, nu se pune in pagina asa cum vine");
{
  // Cheia ajunge intr-un atribut HTML si intr-un selector CSS. Nu vine de la
  // utilizator azi, dar peste un an cineva o va construi dintr-un parametru.
  const t = R.table(CAPETE, RANDURI, { coloane: 'rau" onload="alert(1)' });
  // Nu "nu contine cuvantul onload" — litere ca litere e in regula. Ce nu are
  // voie sa existe e ghilimeaua care ar inchide atributul si ar deschide unul nou.
  bine("ghilimeaua nu inchide atributul", !/onload=/.test(t) && !/data-tabel="[^"]*"[^>]*"/.test(t.match(/<table[^>]*>/)[0]), t.match(/<table[^>]*>/)[0]);
  bine("ramane ceva utilizabil", /data-tabel="rauonloadalert1"/.test(t), (t.match(/data-tabel="[^"]*"/) || [])[0]);
}

console.log("\n4. Tabelul gol");
{
  const t = R.table(CAPETE, [], { coloane: "x" });
  bine("are randul de gol", /class="empty"/.test(t));
  // Scriptul sare peste td.empty cand ascunde coloane — altfel randul asta,
  // care e un singur td cu colspan, ar disparea si tabelul ar parea stricat.
  bine("si e marcat ca atare, ca scriptul sa-l ocoleasca", /colspan="3" class="empty"/.test(t));
}

console.log("\n5. Scriptul din pagina");
{
  const html = R.layout({ user: { id: 1, nume: "Vali", rol: "admin" }, title: "x", body: "", active: "/" });
  bine("scriptul de coloane e in pagina", /tabel:" \+ tabel\.dataset\.tabel/.test(html));
  bine("citirea din localStorage e in try/catch", /try \{ return JSON\.parse\(localStorage/.test(html));
  bine("si scrierea la fel", /try \{ localStorage\.setItem/.test(html));
  // O tragere scurta e si un click, iar capetele sunt sortabile la click.
  bine("gripul opreste clickul ca sa nu sorteze", /grip\.addEventListener\("click", function \(ev\) \{ ev\.stopPropagation\(\)/.test(html));
  bine("si mousedown-ul la fel", /mousedown[\s\S]{0,200}stopPropagation/.test(html));
  bine("randul gol e ocolit la ascundere", /classList\.contains\("empty"\)/.test(html));
  bine("latimea minima nu lasa coloana sa dispara de tot", /Math\.max\(40,/.test(html));
}

console.log("\n6. Casuta de pret din formularul de comanda");
{
  // Vali a trimis poza: tastai pretul si nu vedeai nimic — ramasesera doar
  // sagetile de increment. Coloana „Produs" cere 260px, „Categorie" 150px,
  // iar cand nu mai incape randul browserul ingusteaza exact coloanele fara
  // latime ceruta. Un camp GOL se strange cel mai tare, de-aia pretul
  // disparea iar cantitatea, avand deja cifre, mai rezista.
  const fs = require("fs");
  const css = fs.readFileSync(require("path").join(__dirname, "public", "style.css"), "utf8");
  bine("numerele din tabelele de linii au latime minima", /\.lines-table input\[type="number"\][^}]*min-width:\s*110px/.test(css));
  bine("si nu mai au sagetile care mancau latimea", /inner-spin-button[^}]*-webkit-appearance:\s*none/.test(css));
  bine("tabelul de linii are o latime minima", /\.lines-table \{[^}]*min-width:\s*760px/.test(css));

  const comenzi = fs.readFileSync(require("path").join(__dirname, "modules", "comenzi.js"), "utf8");
  // Latimile exacte s-au strans pe 29.10 (130 → 120 la pret, 120 → 110 la
  // cantitate), cand pretul a devenit camp text fara sageti si tabelul a
  // trebuit sa incapa in formularul de 980px. Conteaza ca latimea e CERUTA
  // si ca ajunge pentru un pret cu patru zecimale, nu cifra exacta.
  const latime = (eticheta) => {
    const m = comenzi.match(new RegExp('min-width:(\\d+)px">' + eticheta));
    return m ? Number(m[1]) : 0;
  };
  bine("coloana de pret cere latime in antet", latime("Preț unitar") >= 110, latime("Preț unitar"));
  bine("si cea de cantitate", latime("Cantitate") >= 100, latime("Cantitate"));
  // Capcana evitata: infasurat in .tabel-lat, overflow-x ar fi taiat si pe
  // verticala, iar lista de produse de sub campul de cautare ar fi fost
  // retezata. S-ar fi reparat o casuta si s-ar fi stricat o cautare.
  bine("tabelul de linii NU e invelit in .tabel-lat", !/tabel-lat/.test(comenzi));
}

console.log("\n7. Formularele nu ies din casetă");
{
  // Bugul, acelasi pe toate paginile cu formular: intr-un grid, `1fr`
  // inseamna `minmax(auto, 1fr)`, iar `auto` NU coboara sub latimea
  // continutului. Un <select> cu „GUANGDONG TENGEN INDUSTRIAL GROUP CO.,LTD"
  // in lista umfla coloana la latimea numelui ala si impinge restul campurilor
  // in afara casetei — pe ecran raman taiate de marginea paginii.
  const fs = require("fs");
  const css = fs.readFileSync(require("path").join(__dirname, "public", "style.css"), "utf8");
  const campul = (css.match(/\.field \{[^}]*\}/) || [""])[0];
  bine("clasa .field are min-width: 0", /min-width:\s*0/.test(campul), campul);
  const controale = (css.match(/\.field input, \.field select, \.field textarea \{[^}]*\}/) || [""])[0];
  bine("și controalele din ea la fel", /min-width:\s*0/.test(controale));
  // Fara box-sizing, padding-ul de 10px se adauga peste 100% si tot iese.
  bine("cu box-sizing, ca padding-ul să nu împingă", /box-sizing:\s*border-box/.test(controale));
  bine("și max-width 100%", /max-width:\s*100%/.test(controale));
  // Selectul isi ia latimea din cea mai lunga optiune daca nu-i spui altfel.
  bine("selectul se încadrează în coloană", /\.field select \{[^}]*width:\s*100%/.test(css));
  bine("iar textul lung se taie, nu împinge", /\.field select \{[^}]*text-overflow:\s*ellipsis/.test(css));
}

console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
process.exit(esecuri ? 1 : 0);
