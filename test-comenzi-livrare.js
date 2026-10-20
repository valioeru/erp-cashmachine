"use strict";
// Livrarea parțială și drumul comenzii prin depozit.
//
// Ce apără, în ordinea în care doare dacă se strică:
//
//   • ÎNTREBAREA SE PUNE LA PLASARE. Agentul vorbește cu clientul când ia
//     comanda, nu peste trei zile, când depozitul descoperă că lipsește
//     marfă. Fără răspuns, comanda nu se salvează — nici din formular, nici
//     dintr-un POST venit din altă parte.
//
//   • NULL NU E „NU". Comenzile de dinainte de coloana asta n-au răspuns.
//     Se tratează prudent ca „nu" (nu pleacă marfă pe jumătate), dar se
//     afișează altfel — altfel nimeni n-ar mai pune întrebarea.
//
//   • BUTONUL DEPOZITULUI DUCE COMANDA UNDE ÎI E LOCUL. Până acum scria
//     „confirmata" orice-ar fi fost pe stoc, iar din starea aia nu se putea
//     factura: trebuia ca cineva să mai mute o dată statusul, de mână. Nu-l
//     muta nimeni. Acum: tot pe stoc → „în stoc depozit"; parțial cu accept
//     → „în stoc depozit"; parțial sau nimic fără accept → „așteaptă marfă".
//
//   • „AȘTEAPTĂ MARFĂ" NU E O FUNDĂTURĂ. Comanda rămâne în lista depozitului
//     și se redeschide singură când răspunsul se schimbă în „da".
//
//   • FACTURAREA PARȚIALĂ SE OPREȘTE PE SERVER, nu doar prin ascunderea
//     butonului. Un POST direct nu are voie să taie comanda în bucăți pe
//     care clientul nu le-a cerut.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});
const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
function csv(t) {
  const R = []; let c = "", r = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n") { r.push(c); R.push(r); r = []; c = ""; }
    else if (ch !== "\r") c += ch;
  }
  if (c !== "" || r.length) { r.push(c); R.push(r); }
  return R;
}
let interogari = 0;
function q(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const mail = require(path.join(RAD, "lib", "mail.js"));
mail.trimite = async () => {};
mail.trimiteDeLa = async () => {};

const livrare = require(path.join(RAD, "lib", "livrare-partiala.js"));
const stari = require(path.join(RAD, "lib", "comenzi-stari.js"));

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
require(path.join(RAD, "modules", "comenzi.js")).register(router);
require(path.join(RAD, "modules", "warehouse.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const GABI = { id: 96701, nume: "Gabriela", rol: "vanzari" };
const MARIUS = { id: 96702, nume: "Marius", rol: "depozit" };

async function cer(cale, { user = GABI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

const CLIENT = 96501;
const PROD_A = 96601; // intră pe stoc
const PROD_B = 96602; // nu intră deloc pe stoc

function curata() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id = 96501)",
    "DELETE FROM facturi WHERE partener_id = 96501",
    "DELETE FROM rezervari_stoc WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 96501)",
    "DELETE FROM aprovizionari WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 96501)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 96501)",
    "DELETE FROM interactiuni WHERE partener_id = 96501",
    "DELETE FROM emailuri WHERE partener_id = 96501",
    "DELETE FROM comenzi WHERE partener_id = 96501",
    "DELETE FROM miscari_stoc WHERE produs_id BETWEEN 96601 AND 96699",
    "DELETE FROM produse WHERE id BETWEEN 96601 AND 96699",
    "DELETE FROM parteneri WHERE id = 96501",
    "DELETE FROM depozite WHERE id = 96801",
    // Utilizatorii de test pleacă și ei: lăsați în urmă, se ciocnesc de alt
    // test care își vrea propriul rând pe aceeași adresă de email.
    "DELETE FROM utilizatori WHERE id IN (96701, 96702, 96703)",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

// Plasează o comandă prin ruta reală și întoarce id-ul ei.
async function plaseaza(raspuns, linii) {
  const body = {
    partener_id: String(CLIENT),
    numar: "LP-" + Math.random().toString(36).slice(2, 7),
    "produs_id[]": linii.map((l) => String(l.produs)),
    "cantitate[]": linii.map((l) => String(l.cant)),
    "pret_unitar[]": linii.map(() => "10"),
  };
  if (raspuns !== undefined) body.livrare_partiala = raspuns;
  const r = await cer("/comenzi", { metoda: "post", body });
  const m = /^\/comenzi\/(\d+)$/.exec(locatie(r));
  if (!m) throw new Error("comanda nu s-a salvat: " + (locatie(r) || r.corp.slice(0, 160)));
  return Number(m[1]);
}
const statusul = (id) => (q("SELECT status FROM comenzi WHERE id = ?", [id])[0] || {}).status;

(async () => {
  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (96701,'Gabriela','gabi.lp@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (96702,'Marius','marius.lp@test.ro','x','y','depozit') ON CONFLICT (id) DO NOTHING",
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${CLIENT}, 'LP CLIENT DE TEST SRL', 'RO96501', 'client')`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES (${PROD_A},'LP-A','Produs pe stoc','buc',10)`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES (${PROD_B},'LP-B','Produs lipsă','buc',10)`,
    "INSERT INTO depozite (id, denumire, locatie) VALUES (96801, 'Depozit de test LP', 'test')",
    // 10 bucăți din A intră în depozit; din B nimic.
    `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate) VALUES (${PROD_A}, 96801, 'intrare', 10)`,
  ]) exec(s);

  // ---------------------------------------------------------------- regula pură
  console.log("\nRegula, fără bază de date:");
  egal("„da” înseamnă că se poate parțial", livrare.acceptaPartial({ livrare_partiala: "da" }), true);
  egal("„nu” nu se poate", livrare.acceptaPartial({ livrare_partiala: "nu" }), false);
  egal("fără răspuns NU se poate", livrare.acceptaPartial({}), false);
  egal("fără răspuns nu se citește ca „nu”", livrare.raspuns({}), null);
  egal("un răspuns inventat nu e valid", livrare.valid("poate"), null);
  egal("„DA” cu majuscule e tot da", livrare.valid("DA"), "da");

  const matrice = [
    [{ acoperiteTot: true, acoperitePartial: true }, "da", "in_stoc_depozit"],
    [{ acoperiteTot: true, acoperitePartial: true }, "nu", "in_stoc_depozit"],
    [{ acoperiteTot: true, acoperitePartial: true }, null, "in_stoc_depozit"],
    [{ acoperiteTot: false, acoperitePartial: true }, "da", "in_stoc_depozit"],
    [{ acoperiteTot: false, acoperitePartial: true }, "nu", "asteapta_marfa"],
    [{ acoperiteTot: false, acoperitePartial: true }, null, "asteapta_marfa"],
    [{ acoperiteTot: false, acoperitePartial: false }, "da", "asteapta_marfa"],
    [{ acoperiteTot: false, acoperitePartial: false }, "nu", "asteapta_marfa"],
  ];
  for (const [stoc, raspuns, astept] of matrice) {
    const avut = livrare.statusDupaVerificare({ ...stoc, comanda: { livrare_partiala: raspuns } });
    egal(
      `stoc ${stoc.acoperiteTot ? "complet" : stoc.acoperitePartial ? "parțial" : "zero"} + răspuns ${raspuns || "lipsă"}`,
      avut,
      astept
    );
  }

  // Bara de pași: „așteaptă marfă" apare doar când comanda chiar e acolo.
  if (/așteaptă marfă/.test(stari.bara({ status: "noua" }))) rau("bara arată „așteaptă marfă” pe o comandă nouă");
  else ok("bara nu arată ocolirea pe o comandă care n-a luat-o");
  if (!/așteaptă marfă/.test(stari.bara({ status: "asteapta_marfa" }))) rau("bara nu arată pasul curent");
  else ok("bara arată pasul curent când comanda așteaptă marfă");
  if (!/✓/.test(stari.bara({ status: "in_stoc_depozit" }))) rau("bara nu bifează pașii făcuți");
  else ok("bara bifează pașii deja făcuți");

  // ------------------------------------------------------- drumurile prin depozit
  console.log("\nDrumurile prin depozit:");

  // 1. tot pe stoc → pleacă spre livrare
  let id = await plaseaza("nu", [{ produs: PROD_A, cant: 4 }]);
  await cer("/depozit/comanda/:id/confirma", { metoda: "post", user: MARIUS, params: { id: String(id) } });
  egal("tot pe stoc → în stoc depozit, chiar dacă clientul voia doar complet", statusul(id), "in_stoc_depozit");
  egal("se scrie cine a verificat",
    (q("SELECT verificata_depozit_de FROM comenzi WHERE id = ?", [id])[0] || {}).verificata_depozit_de, "Marius");

  // 2. parțial + clientul acceptă → pleacă ce e pe stoc
  const idDa = await plaseaza("da", [{ produs: PROD_A, cant: 4 }, { produs: PROD_B, cant: 3 }]);
  await cer("/depozit/comanda/:id/confirma", { metoda: "post", user: MARIUS, params: { id: String(idDa) } });
  egal("parțial + acceptă → în stoc depozit", statusul(idDa), "in_stoc_depozit");

  // 3. parțial + clientul NU acceptă → așteaptă marfă
  const idNu = await plaseaza("nu", [{ produs: PROD_A, cant: 2 }, { produs: PROD_B, cant: 3 }]);
  await cer("/depozit/comanda/:id/confirma", { metoda: "post", user: MARIUS, params: { id: String(idNu) } });
  egal("parțial + nu acceptă → așteaptă marfă", statusul(idNu), "asteapta_marfa");

  // 4. nimic pe stoc, deși clientul accepta parțial → tot așteaptă marfă
  const idGol = await plaseaza("da", [{ produs: PROD_B, cant: 5 }]);
  await cer("/depozit/comanda/:id/confirma", { metoda: "post", user: MARIUS, params: { id: String(idGol) } });
  egal("nimic pe stoc → așteaptă marfă, chiar cu accept", statusul(idGol), "asteapta_marfa");

  // 5. comanda veche, fără răspuns, se poartă ca un „nu"
  const idVechi = await plaseaza("da", [{ produs: PROD_A, cant: 1 }, { produs: PROD_B, cant: 9 }]);
  exec(`UPDATE comenzi SET livrare_partiala = NULL WHERE id = ${idVechi}`);
  await cer("/depozit/comanda/:id/confirma", { metoda: "post", user: MARIUS, params: { id: String(idVechi) } });
  egal("comandă veche fără răspuns → așteaptă marfă", statusul(idVechi), "asteapta_marfa");

  // Dar se vede că răspunsul lipsește, nu că e „nu".
  const paginaDepozit = await cer("/depozit/comanda/:id", { user: MARIUS, params: { id: String(idVechi) } });
  if (!paginaDepozit.corp.includes("nu s-a întrebat")) rau("depozitul nu vede că răspunsul lipsește");
  else ok("depozitul vede că nimeni n-a întrebat clientul");

  // ----------------------------------------------------- facturarea parțială
  console.log("\nFacturarea parțială:");
  const facturi = (p) => Number(q("SELECT COUNT(*) AS n FROM facturi WHERE partener_id = ?", [p])[0].n);
  const inainte = facturi(CLIENT);
  const rFact = await cer("/comenzi/:id/factureaza-partial", { metoda: "post", params: { id: String(idNu) } });
  egal("un POST direct nu facturează parțial fără acceptul clientului", facturi(CLIENT), inainte);
  if (!rFact.corp.includes("comanda completă")) rau("nu explică de ce n-a facturat");
  else ok("spune limpede de ce n-a facturat");

  // ------------------------------------------------- răspunsul se poate schimba
  console.log("\nRăspunsul schimbat pe parcurs:");
  await cer("/comenzi/:id/livrare-partiala", {
    metoda: "post", params: { id: String(idNu) }, body: { livrare_partiala: "da" },
  });
  egal("clientul se răzgândește → comanda se redeschide", statusul(idNu), "in_stoc_depozit");
  egal("răspunsul nou e în bază",
    (q("SELECT livrare_partiala FROM comenzi WHERE id = ?", [idNu])[0] || {}).livrare_partiala, "da");

  await cer("/comenzi/:id/livrare-partiala", {
    metoda: "post", params: { id: String(idNu) }, body: { livrare_partiala: "nu" },
  });
  egal("și înapoi: un „nu” o trimite iar la așteptare", statusul(idNu), "asteapta_marfa");

  // Depozitul nu scrie răspunsul clientului — el doar îl citește.
  await cer("/comenzi/:id/livrare-partiala", {
    metoda: "post", user: MARIUS, params: { id: String(idNu) }, body: { livrare_partiala: "da" },
  });
  egal("depozitul nu poate schimba răspunsul clientului",
    (q("SELECT livrare_partiala FROM comenzi WHERE id = ?", [idNu])[0] || {}).livrare_partiala, "nu");

  // ------------------------------------------------------------ ecranul agentului
  console.log("\nCe vede agentul:");
  const pagina = await cer("/comenzi/:id", { params: { id: String(idNu) } });
  if (!pagina.corp.includes("doar comanda completă")) rau("fișa comenzii nu arată răspunsul clientului");
  else ok("fișa comenzii arată răspunsul clientului");
  if (pagina.corp.includes("Facturează parțial")) rau("butonul de facturare parțială apare deși clientul a refuzat");
  else ok("butonul de facturare parțială nu apare când clientul a refuzat");
  if (!/<ol[^>]*>[\s\S]*așteaptă marfă/.test(pagina.corp)) rau("fișa comenzii n-are bara de pași");
  else ok("fișa comenzii are bara de pași, cu pasul curent");
  if (/NaN|undefined</.test(pagina.corp.replace(/<script[\s\S]*?<\/script>/g, ""))) rau("NaN/undefined în pagină");
  else ok("fără NaN sau undefined în pagină");

  const listaDepozit = await cer("/depozit", { user: MARIUS });
  if (!listaDepozit.corp.includes("Livrare parțială")) rau("lista depozitului n-are coloana de livrare parțială");
  else ok("lista depozitului arată răspunsul pe fiecare comandă");
  if (/>in_stoc_depozit</.test(listaDepozit.corp)) rau("lista depozitului arată statusul brut, cu underscore");
  else ok("lista depozitului arată statusul în română, nu numele din bază");

  // ------------------------------------- alegerea produsului pe comanda nouă
  console.log("\nAlegerea produsului:");
  exec(`UPDATE produse SET categorie = 'Folie stretch manuala' WHERE id = ${PROD_A}`);
  exec(`UPDATE produse SET categorie = 'Cartoane' WHERE id = ${PROD_B}`);
  const formular = await cer("/comenzi/nou");
  if (/<select[^>]*name="produs_id\[\]"/.test(formular.corp))
    rau("a rămas lista derulantă cu toate produsele pe linie");
  else ok("produsul nu mai e o listă derulantă cu tot nomenclatorul");
  if (!/class="cat-produs"/.test(formular.corp)) rau("lipsește filtrul de categorie pe linie");
  else ok("fiecare linie are filtru de categorie");
  if (!/class="cauta-produs"/.test(formular.corp)) rau("lipsește căutarea de produs");
  else ok("fiecare linie are căsuță de căutare");
  // Lista de rezultate trebuie să fie `fixed`. Pe `absolute` se vedea doar o
  // dungă de câțiva pixeli: rândul e o celulă de tabel, iar un strămoș cu
  // overflow (derularea pe orizontală) taie orice element absolut, oricât de
  // mare i-ar fi z-index-ul.
  if (!/\.rezultate-produs\s*\{[^}]*position:\s*fixed/.test(formular.corp))
    rau("lista de rezultate nu e „fixed” — se va tăia în tabel");
  else ok("lista de rezultate iese din tabel, nu se taie");
  if (!/function comenziAseaza/.test(formular.corp)) rau("lipsește așezarea listei după câmp");
  else ok("lista se așază după câmp, și la derulare");
  for (const c of ["Folie stretch manuala", "Cartoane"]) {
    if (!formular.corp.includes(`<option value="${c}"`)) rau("categoria lipsește din filtru", c);
    else ok("categoria apare în filtru: " + c);
  }
  if (!formular.corp.includes("— toate categoriile —")) rau("nu se poate renunța la filtru");
  else ok("se poate renunța la filtru");
  // Produsele pleacă o singură dată, ca date, nu clonate pe fiecare linie.
  const aparitii = (formular.corp.match(/Produs pe stoc/g) || []).length;
  if (aparitii > 2) rau("produsele se repetă în pagină", aparitii + " apariții");
  else ok("produsele se trimit o singură dată (" + aparitii + " apariții)");

  // Cantitate fără produs ales: oprită, nu 500 pe NOT NULL.
  const inainteLinii = Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ?", [CLIENT])[0].n);
  const rGol = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: String(CLIENT), livrare_partiala: "da",
            "produs_id[]": [""], "cantitate[]": ["3"], "pret_unitar[]": ["10"] },
  });
  egal("cantitate fără produs ales nu salvează nimic",
    Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ?", [CLIENT])[0].n), inainteLinii);
  if (!rGol.corp.includes("niciun produs ales")) rau("nu spune că lipsește produsul");
  else ok("spune limpede că n-a apăsat pe produs");

  // --------------------------------------- categoriile aduse din fișierul Excel
  console.log("\nImportul de categorii și gestiuni:");
  const HANDLERE = require(path.join(RAD, "modules", "punte.js")).HANDLERE;
  exec(`UPDATE produse SET categorie = NULL, gestiune = NULL WHERE id IN (${PROD_A}, ${PROD_B})`);
  const rezCat = await HANDLERE.categorii_produse([
    // același cod de două ori: o dată în coșul „diverse", o dată clasificat
    { cod: "LP-A", produs: "Produs pe stoc", gestiune: "Materie prima", categorie: "diverse", um: "buc" },
    { cod: "LP-A", produs: "Produs pe stoc", gestiune: "Materie prima", categorie: "Folie stretch manuala", um: "buc" },
    // același articol în două gestiuni: ciocnire reală, nu scăpare
    { cod: "LP-B", produs: "Produs lipsă", gestiune: "Online", categorie: "Cartoane", um: "kg" },
    { cod: "LP-B", produs: "Produs lipsă", gestiune: "Produse Finite", categorie: "Cartoane", um: "kg" },
    // cod care nu există în ERP
    { cod: "LP-INEXISTENT", produs: "Articol fantomă", gestiune: "Online", categorie: "Saci", um: "buc" },
  ]);
  const dupaImport = (id) => q("SELECT categorie, gestiune, unitate_masura FROM produse WHERE id = ?", [id])[0] || {};
  egal("categoria adevărată bate „diverse”", dupaImport(PROD_A).categorie, "Folie stretch manuala");
  egal("gestiunea unică se scrie", dupaImport(PROD_A).gestiune, "Materie prima");
  egal("categoria se scrie și când gestiunea e ambiguă", dupaImport(PROD_B).categorie, "Cartoane");
  egal("gestiunea NU se ghicește când articolul stă în două", dupaImport(PROD_B).gestiune, null);
  egal("ciocnirea de gestiuni se raportează", rezCat.mai_multe_gestiuni, 1);
  egal("codul inexistent se raportează, nu se creează", rezCat.nepotrivite, 1);
  egal("nu s-a născut niciun produs nou",
    Number(q("SELECT COUNT(*) AS n FROM produse WHERE cod = 'LP-INEXISTENT'")[0].n), 0);
  egal("unitatea de măsură diferită se numără, nu se suprascrie", rezCat.um_diferita, 1);
  egal("și chiar nu s-a atins", dupaImport(PROD_B).unitate_masura, "buc");

  // Reimportul aceluiași fișier nu mai are ce scrie.
  const rezCat2 = await HANDLERE.categorii_produse([
    { cod: "LP-A", produs: "Produs pe stoc", gestiune: "Materie prima", categorie: "Folie stretch manuala", um: "buc" },
  ]);
  egal("reimportul nu rescrie ce e deja corect", rezCat2.categorii_scrise + rezCat2.gestiuni_scrise, 0);

  // Și prin pagina de import, cu fișier, nu doar prin punte.
  require(path.join(RAD, "modules", "import.js")).register(router);
  exec(`UPDATE produse SET categorie = NULL, gestiune = NULL WHERE id IN (${PROD_A}, ${PROD_B})`);
  const csv = [
    "Cod,Produs,Gestiune,Categorie,U.M.",
    "LP-A,Produs pe stoc,Materie prima,diverse,buc",
    "LP-A,Produs pe stoc,Materie prima,Folie stretch manuala,buc",
    "LP-B,Produs lipsa,Online,Cartoane,buc",
  ].join("\n");
  const rImport = await cer("/import/categorii", {
    metoda: "post",
    user: { id: 1, nume: "Vali", rol: "admin" },
    body: { __files: { fisier: [{ filename: "categorii.csv", data: Buffer.from(csv, "utf8") }] } },
  });
  if (!rImport.corp.includes("Categorii scrise")) rau("pagina de import nu raportează ce a scris");
  else ok("pagina de import raportează ce a scris");
  egal("importul din fișier scrie categoria", dupaImport(PROD_A).categorie, "Folie stretch manuala");
  egal("și gestiunea", dupaImport(PROD_B).gestiune, "Online");
  // Un om care nu e admin nu importă nimic.
  exec(`UPDATE produse SET categorie = NULL WHERE id = ${PROD_A}`);
  await cer("/import/categorii", {
    metoda: "post", user: GABI,
    body: { __files: { fisier: [{ filename: "categorii.csv", data: Buffer.from(csv, "utf8") }] } },
  });
  egal("doar adminul importă", dupaImport(PROD_A).categorie, null);

  // ------------------------------------------------- cine ajunge la Comenzi
  //
  // Bug-ul reparat: „Comenzi" atârna sub Vânzări, iar producția și depozitul
  // aveau dreptul pe /comenzi fără să aibă pe unde intra — butonul Vânzări
  // nu li se afișa, fiindcă n-au acces la /crm.
  console.log("\nAccesul la Comenzi:");
  const auth = require(path.join(RAD, "lib", "auth.js"));
  const render = require(path.join(RAD, "lib", "render.js"));
  for (const rol of ["admin", "vanzari", "financiar", "depozit", "productie"]) {
    if (!auth.poateAccesa({ rol }, "/comenzi")) rau("rolul " + rol + " nu ajunge la /comenzi");
    else ok("rolul " + rol + " ajunge la /comenzi");
  }
  // Un om căruia adminul i-a bifat doar Producție ajunge tot acolo: pagina e
  // în MEREU_PERMISE, deci nu mai depinde de nicio bifă.
  if (!auth.poateAccesa({ rol: "productie", sectiuni: "/productie" }, "/comenzi"))
    rau("cu secțiuni bifate manual, /comenzi rămâne închis");
  else ok("cu secțiuni bifate manual, /comenzi rămâne deschis");
  // Iar agentul care avea doar /crm bifat nu pierde nimic din mutare.
  if (!auth.poateAccesa({ rol: "vanzari", sectiuni: "/crm" }, "/comenzi"))
    rau("agentul cu doar /crm bifat a pierdut accesul la comenzi");
  else ok("agentul cu doar /crm bifat nu pierde accesul");

  const nav = render.NAV.filter((i) => auth.poateAccesa({ rol: "productie" }, i.zona || i.href)).map((i) => i.label);
  if (!nav.includes("Comenzi")) rau("producția nu vede intrarea Comenzi în bară", JSON.stringify(nav));
  else ok("producția vede intrarea Comenzi în bară");
  const pag = render.layout({ user: MARIUS, title: "x", active: "/comenzi", body: "<p>x</p>" });
  if (!/navlink active[^>]*>Comenzi</.test(pag)) rau("intrarea Comenzi nu se aprinde pe pagina comenzilor");
  else ok("intrarea Comenzi se aprinde când ești pe ea");

  // ------------------------------------------------- cine mută ce status
  console.log("\nCine mută statusurile:");
  const comandaLuiGabi = { id: 1, agent_id: GABI.id, status: "noua" };
  egal("producția mută doar pașii ei",
    stari.stariPermise({ rol: "productie", id: 9 }, comandaLuiGabi), ["in_productie", "in_stoc_depozit"]);
  egal("depozitul are și livrarea",
    stari.stariPermise({ rol: "depozit", id: 9 }, comandaLuiGabi),
    ["confirmata", "asteapta_marfa", "in_stoc_depozit", "livrata", "anulata"]);
  egal("agentul își poate anula comanda lui", stari.stariPermise(GABI, comandaLuiGabi), ["anulata"]);
  egal("dar nu pe a altuia",
    stari.stariPermise({ rol: "vanzari", id: 999 }, comandaLuiGabi), []);
  egal("agentul nu poate pune „livrată”", stari.poateMuta(GABI, comandaLuiGabi, "livrata"), false);
  egal("producția nu poate pune „livrată”",
    stari.poateMuta({ rol: "productie", id: 9 }, comandaLuiGabi, "livrata"), false);
  if (!stari.stariPermise({ rol: "admin", id: 1 }, comandaLuiGabi).includes("livrata"))
    rau("adminul a pierdut vreun status");
  else ok("adminul mută orice");
  if (stari.stariPermise({ rol: "admin", id: 1 }, comandaLuiGabi).includes("ciorna"))
    rau("„ciornă” a ajuns în lista de statusuri de pus");
  else ok("„ciornă” nu se pune din select — se naște dintr-un email");

  // Și pe rută, nu doar în listă: un POST trimis de mână nu trece.
  const idStatus = await plaseaza("da", [{ produs: PROD_A, cant: 1 }]);
  await cer("/comenzi/:id/status", {
    metoda: "post", user: GABI, params: { id: String(idStatus) }, body: { status: "livrata" },
  });
  egal("POST direct „livrată” de la agent nu trece", statusul(idStatus), "noua");
  await cer("/comenzi/:id/status", {
    metoda: "post", user: { rol: "productie", id: 96703, nume: "Ionel" },
    params: { id: String(idStatus) }, body: { status: "in_productie" },
  });
  egal("producția își poate pune pasul ei", statusul(idStatus), "in_productie");

  curata();
  console.log("\n" + interogari + " interogări SQL rulate pe PostgreSQL real.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { curata(); console.error("A crăpat:", e.message); process.exit(1); });
