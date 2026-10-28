"use strict";
// Pagina de noutăți. Fără bază de date.
//
// CE APĂRĂ:
//
//   • LINKURILE DUC UNDEVA. Un jurnal de dezvoltări plin de adrese moarte e
//     mai rău decât niciunul: omul apasă, primește „pagină inexistentă", și
//     de-atunci nu mai are încredere în nimic de pe pagina asta. Fiecare
//     adresă scrisă într-un rând trebuie să existe ca rută în ERP.
//
//   • DATELE SUNT ÎN ORDINE, CEL MAI NOU SUS. Un rând pus din greșeală la
//     mijloc dispare din „ultimele 30" fără ca nimeni să observe.
//
//   • NU SE REPETĂ. Același lucru scris de două ori face lista să pară mai
//     lungă decât munca din spatele ei.
const fs = require("fs");
const path = require("path");
const N = require("./lib/noutati");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 260) : ""));
    esecuri++;
  }
}

const toate = N.toate();

console.log("Lista");
{
  bine("are cel puțin 30 de rânduri, cât a cerut Vali", toate.length >= 30, toate.length);
  bine("fiecare rând are dată, titlu și text",
    toate.every((r) => r.data && r.titlu && r.text), toate.filter((r) => !r.data || !r.titlu || !r.text));
  bine("datele sunt scrise aaaa-ll-zz", toate.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.data)),
    toate.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.data)).map((r) => r.data));
  bine("datele sunt reale", toate.every((r) => !isNaN(Date.parse(r.data))));

  const ordonate = toate.every((r, i) => i === 0 || toate[i - 1].data >= r.data);
  bine("cel mai nou sus, până la capăt", ordonate,
    toate.map((r) => r.data).filter((d, i, a) => i > 0 && a[i - 1] < d));

  const titluri = toate.map((r) => r.titlu.toLowerCase());
  bine("niciun titlu scris de două ori", new Set(titluri).size === titluri.length,
    titluri.filter((t, i) => titluri.indexOf(t) !== i));

  bine("textele chiar explică ceva, nu sunt o linie de commit",
    toate.every((r) => r.text.length >= 60), toate.filter((r) => r.text.length < 60).map((r) => r.titlu));
  bine("niciun titlu nu e o cale de fișier",
    !toate.some((r) => /\.js\b|lib\/|modules\//.test(r.titlu)), toate.filter((r) => /\.js\b/.test(r.titlu)));
}

console.log("\nUltimele 30");
{
  bine("scoate exact 30", N.ultimele(30).length === 30, N.ultimele(30).length);
  bine("sunt chiar cele mai noi", N.ultimele(30)[0].data === toate[0].data);
  bine("implicit tot 30", N.ultimele().length === 30);
  bine("numărul e scris într-un singur loc", N.CATE === 30);
}

console.log("\nGruparea pe zile");
{
  const z = N.peZile(toate);
  bine("fiecare zi apare o singură dată", new Set(z.map((x) => x.data)).size === z.length,
    z.map((x) => x.data));
  bine("nu se pierde niciun rând", z.reduce((s, x) => s + x.randuri.length, 0) === toate.length);
  bine("zilele rămân în ordine", z.every((x, i) => i === 0 || z[i - 1].data >= x.data));
}

console.log("\nLinkurile duc undeva");
{
  // Adunam toate rutele inregistrate in ERP, direct din sursa: asa testul nu
  // trebuie tinut la zi de mana cand se adauga o pagina.
  const rute = new Set();
  const dir = path.join(__dirname, "modules");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/router\.(?:get|post)\(\s*[`"']([^`"']+)[`"']/g)) rute.add(m[1]);
    // Rutele scrise cu un prefix in variabila: `${CALE}/etichete`
    for (const m of text.matchAll(/router\.(?:get|post)\(\s*`\$\{CALE\}([^`]*)`/g)) {
      const c = text.match(/const CALE = "([^"]+)"/);
      if (c) rute.add(c[1] + m[1]);
    }
    const c = text.match(/const CALE = "([^"]+)"/);
    if (c) rute.add(c[1]);
  }
  const cuLink = toate.filter((r) => r.unde);
  bine("rutele ERP-ului s-au putut citi", rute.size > 50, rute.size);
  bine("majoritatea rândurilor trimit undeva", cuLink.length >= toate.length / 2, cuLink.length);

  const moarte = cuLink.filter((r) => {
    // Ancora („#serie-alta-firma") ține de pagină, nu de rută: browserul
    // cere „/admin/date" și apoi derulează singur la secțiune. Fără să o
    // tăiem, un link care duce exact unde trebuie ar fi părut mort.
    const unde = String(r.unde).split("#")[0];
    if (rute.has(unde)) return false;
    // O adresa ca „/comenzi/nou" e buna si daca ruta e inregistrata asa;
    // una ca „/parteneri" e buna daca exista „/parteneri" sau „/parteneri/:id".
    for (const ruta of rute) {
      if (ruta === unde) return false;
      if (ruta.startsWith(unde + "/")) return false;
    }
    return true;
  });
  bine("niciun link nu duce în gol", moarte.length === 0, moarte.map((r) => r.unde + "  ←  " + r.titlu));
  bine("toate linkurile încep cu /", cuLink.every((r) => r.unde.startsWith("/")), cuLink.map((r) => r.unde));
}

console.log("\nPagina e înregistrată și deschisă tuturor");
{
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  bine("modulul e înregistrat în server", server.indexOf('require("./modules/noutati")') !== -1);
  const auth = fs.readFileSync(path.join(__dirname, "lib", "auth.js"), "utf8");
  bine("oricine logat o poate deschide", auth.indexOf('"/noutati"') !== -1);
  bine("și adresa „updates”, scrisă din memorie, duce tot acolo", auth.indexOf('"/updates"') !== -1);
  const render = fs.readFileSync(path.join(__dirname, "lib", "render.js"), "utf8");
  bine("are intrare în meniul de sus", render.indexOf('href: "/noutati"') !== -1);
}

console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
process.exit(esecuri ? 1 : 0);
