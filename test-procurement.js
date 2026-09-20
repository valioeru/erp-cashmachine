"use strict";
// Test pentru modulul Procurement — istoricul ofertelor de la furnizori.
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
// Din rădăcina repo-ului, cu baza pornită pe 127.0.0.1:5433.
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const auth = require(path.join(RAD, "lib", "auth.js"));
const mod = require(path.join(RAD, "modules", "procurement.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const GABI = { id: 3, nume: "Gabriela", rol: "vanzari" };

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
function cere(eticheta, corp, bucati, interzise) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined<|>undefined/.test(fara)) return rau(eticheta, "NaN/undefined în pagină");
  const lipsa = bucati.filter((b) => !fara.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => fara.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta + " (" + corp.length + " octeți)");
}

const azi = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.UTC(+azi.slice(0, 4), +azi.slice(5, 7) - 1, +azi.slice(8, 10) + n)).toISOString().slice(0, 10);

(async () => {
  for (const s of [
    "TRUNCATE ach_piata, ach_oferte, ach_articole, ach_categorii RESTART IDENTITY CASCADE",
    "DELETE FROM setari_app WHERE cheie = 'ach_curs_eur'",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
  ]) execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("rute GET :", Object.keys(rute.get).join(", "));
  console.log("rute POST:", Object.keys(rute.post).join(", "));
  console.log("");

  // --- pagina goală nu crapă și își face singură categoriile ---------------
  let r = await cer("/procurement");
  cere("pagina goală, la prima intrare", r.corp, ["Procurement", "Nicio ofertă", "Ofertă nouă"], []);
  const cat = q("SELECT COUNT(*) AS n FROM ach_categorii")[0].n;
  if (Number(cat) !== mod.CATEGORII_IMPLICITE.length) rau("categoriile implicite nu s-au creat", cat);
  else ok("categoriile mari se creează singure la prima deschidere (" + cat + ")");

  // --- oferta cu articol nou, scris în același formular --------------------
  const catFolie = q("SELECT id FROM ach_categorii WHERE nume ILIKE '%stretch%'")[0].id;
  r = await cer("/procurement/oferta", {
    metoda: "post",
    body: {
      articol_nume: "Folie stretch jumbo 15µ", categorie_id: catFolie, um: "kg",
      specificatie: "1620 mm, 300% alungire",
      furnizor_text: "Rotapack Kft (HU)", pret: "1.89", moneda: "EUR", um2: "kg",
      cantitate_min: "20000", data_ofertei: plus(-1), conditii: "DAP Afumați",
    },
  });
  const idArticol = Number((locatie(r).match(/articol\/(\d+)/) || [])[1]);
  if (!idArticol) rau("articolul nou nu s-a creat", locatie(r));
  else ok("o ofertă pe un articol care nu exista încă îl creează pe loc — #" + idArticol);

  // --- încă două oferte pe același articol, de la alți furnizori -----------
  for (const [furnizor, pret, zile] of [["Denelavas Pack (GR)", "1.51", -5], ["Teraplast / Opal", "1.39", -5]]) {
    await cer("/procurement/oferta", {
      metoda: "post",
      body: { articol_id: idArticol, furnizor_text: furnizor, pret, moneda: "EUR", um: "kg", data_ofertei: plus(zile) },
    });
  }
  // și una veche, ca să avem tendință
  await cer("/procurement/oferta", {
    metoda: "post",
    body: { articol_id: idArticol, furnizor_text: "Rotapack Kft (HU)", pret: "1.70", moneda: "EUR", um: "kg", data_ofertei: plus(-120) },
  });
  const nrOferte = q("SELECT COUNT(*) AS n FROM ach_oferte WHERE articol_id = ?", [idArticol])[0].n;
  if (Number(nrOferte) !== 4) rau("nu s-au salvat toate ofertele", nrOferte);
  else ok("patru oferte pe același articol, de la trei furnizori");

  // --- pagina articolului: cel mai bun preț, cine unde e, tendința ---------
  r = await cer("/procurement/articol/:id", { params: { id: idArticol } });
  cere("pagina articolului", r.corp, [
    "Cea mai bună ofertă valabilă", "1,39 EUR", "Teraplast / Opal",
    "Unde e fiecare furnizor acum", "Istoricul complet", "Denelavas", "Rotapack",
  ], []);
  // Rotapack a urcat de la 1,70 la 1,89 — trebuie să se vadă ca scumpire.
  if (!/\+11[.,]\d%/.test(r.corp)) rau("tendința de preț nu se calculează", (r.corp.match(/[+-]\d+[.,]\d%/g) || []).join(" "));
  else ok("se vede că Rotapack a scumpit cu 11,2% față de oferta lui veche");

  // --- gruparea pe categorii, cele mai noi sus ----------------------------
  r = await cer("/procurement");
  cere("lista pe categorii", r.corp, ["Folie stretch", "Folie stretch jumbo 15µ", "Rotapack"], []);
  // layout() rescrie datele ISO in format romanesc — se cauta zz.ll.aaaa.
  const ro = (d) => d.slice(8, 10) + "." + d.slice(5, 7) + "." + d.slice(0, 4);
  const pozNoua = r.corp.indexOf(ro(plus(-1)));
  const pozVeche = r.corp.indexOf(ro(plus(-5)));
  if (pozNoua === -1 || pozVeche === -1 || pozNoua > pozVeche) rau("ofertele noi nu stau sus", `noua=${pozNoua} veche=${pozVeche}`);
  else ok("în fiecare categorie, ofertele mai recente stau sus");

  // --- căutarea după produs ----------------------------------------------
  r = await cer("/procurement", { query: { q: "stretch" } });
  if (!r.corp.includes("Folie stretch jumbo")) rau("căutarea nu găsește articolul");
  else ok("căutarea după «stretch» găsește articolul");
  r = await cer("/procurement", { query: { q: "banda adeziva inexistenta" } });
  if (!r.corp.includes("Nicio ofertă")) rau("căutarea fără rezultat nu spune nimic");
  else ok("căutarea fără rezultat o spune pe față");

  // --- filtrul pe furnizor ------------------------------------------------
  r = await cer("/procurement", { query: { furnizor: "Denelavas" } });
  if (r.corp.includes("Teraplast")) rau("filtrul pe furnizor nu filtrează");
  else if (!r.corp.includes("Denelavas")) rau("filtrul pe furnizor a ascuns tot");
  else ok("filtrul pe furnizor merge");

  // --- ofertele expirate se ascund implicit -------------------------------
  await cer("/procurement/oferta", {
    metoda: "post",
    body: { articol_id: idArticol, furnizor_text: "Furnizor Expirat SRL", pret: "0.99", moneda: "EUR", um: "kg", data_ofertei: plus(-10), valabil_pana: plus(-2) },
  });
  r = await cer("/procurement");
  if (r.corp.includes("Furnizor Expirat")) rau("oferta expirată apare implicit");
  else ok("ofertele expirate nu se amestecă cu cele valabile");
  r = await cer("/procurement", { query: { valabile: "0" } });
  if (!r.corp.includes("Furnizor Expirat")) rau("nu le pot vedea nici când cer expressly");
  else ok("dar le vezi când ceri «și cele expirate»");
  // ...și nu strică «cea mai bună ofertă»
  r = await cer("/procurement/articol/:id", { params: { id: idArticol } });
  if (r.corp.includes("0,99 EUR</div>")) rau("o ofertă expirată a fost luată drept cea mai bună");
  else ok("oferta expirată nu se bagă la «cea mai bună»");

  // --- scoaterea unei oferte: doar administratorul, și nu șterge rândul ----
  const idOferta = Number(q("SELECT id FROM ach_oferte ORDER BY id DESC LIMIT 1")[0].id);
  await cer("/procurement/oferta/:id/sterge", { user: GABI, metoda: "post", params: { id: idOferta } });
  if (Number(q("SELECT activ FROM ach_oferte WHERE id = ?", [idOferta])[0].activ) !== 1) rau("un neadministrator a scos o ofertă");
  else ok("scoaterea unei oferte e doar a administratorului");
  await cer("/procurement/oferta/:id/sterge", { metoda: "post", params: { id: idOferta } });
  const dupa = q("SELECT activ FROM ach_oferte WHERE id = ?", [idOferta])[0];
  if (!dupa) rau("oferta a fost ștearsă din bază, nu dezactivată");
  else if (Number(dupa.activ) !== 0) rau("oferta n-a fost scoasă");
  else ok("oferta scoasă rămâne în bază, doar dezactivată");

  // --- cursul folosit la comparații ---------------------------------------
  await cer("/procurement/curs", { metoda: "post", body: { curs: "5.07" } });
  r = await cer("/procurement");
  if (!r.corp.includes("5,07")) rau("cursul salvat nu se vede pe pagină");
  else ok("cursul de comparație se salvează și scrie pe pagină");
  // 1 EUR la 5,07 lei: o ofertă în lei sub 5,07 bate una de 1 EUR
  if (Math.round(mod.inLei(1, "EUR", 5.07) * 100) !== 507) rau("conversia în lei e greșită");
  else ok("conversia în lei folosește cursul setat");

  // --- categorie nouă ------------------------------------------------------
  await cer("/procurement/categorie", { metoda: "post", body: { nume: "Etichete & print", ordine: "35" } });
  r = await cer("/procurement/articole");
  // esc() scrie „&" ca „&amp;" — se cauta forma din HTML, nu cea din formular.
  cere("pagina de articole și categorii", r.corp, ["Etichete &amp; print", "Folie stretch jumbo 15µ", "Cursul folosit"], []);

  // --- referința de piață --------------------------------------------------
  // Fără estimare, pagina nu trebuie să inventeze nimic.
  r = await cer("/procurement/articol/:id", { params: { id: idArticol } });
  if (!r.corp.includes("nicio estimare încă")) rau("fără estimare, pagina n-o spune");
  else ok("fără estimare de piață, pagina o spune pe față");

  // Piața la 1,50–1,70 €/kg: cea mai bună ofertă (1,39) e sub piață.
  await cer("/procurement/articol/:id/piata", {
    metoda: "post", params: { id: idArticol },
    body: { pret: "1.50", pret_max: "1.70", moneda: "EUR", um: "kg", data: plus(-2),
            sursa: "PlasticPortal — LLDPE Europa Centrală", url: "https://www.plasticportal.eu/polymer-prices",
            metoda: "rășină LLDPE 1,47 €/kg + procesare", nota: "preț contract lunar" },
  });
  r = await cer("/procurement/articol/:id", { params: { id: idArticol } });
  cere("pagina articolului cu referința de piață", r.corp,
    ["Referința de piață", "1,50 – 1,70 EUR / kg", "PlasticPortal", "rășină LLDPE"], []);
  // 1,39 față de mijlocul benzii (1,60) = −13%
  if (!/-1[23]%/.test(r.corp)) rau("diferența față de piață nu se calculează", (r.corp.match(/[+-]\d+%/g) || []).join(" "));
  else ok("cea mai bună ofertă se vede ca fiind cu 13% sub piață");
  if (!r.corp.includes("cumperi sub piață")) rau("nu spune în cuvinte dacă e bine sau rău");
  else ok("spune în cuvinte: «cumperi sub piață»");

  // O estimare nouă n-o șterge pe cea veche
  await cer("/procurement/articol/:id/piata", {
    metoda: "post", params: { id: idArticol },
    body: { pret: "1.90", moneda: "EUR", um: "kg", data: azi, sursa: "test" },
  });
  const nrRef = q("SELECT COUNT(*) AS n FROM ach_piata WHERE articol_id = ?", [idArticol])[0].n;
  if (Number(nrRef) !== 2) rau("estimarea nouă a înlocuit-o pe cea veche", nrRef);
  else ok("estimările se adună, nu se suprascriu — se vede cum s-a mișcat piața");
  r = await cer("/procurement/articol/:id", { params: { id: idArticol } });
  // acum piața e 1,90, iar 1,39 e cu 27% sub
  if (!/-2[67]%/.test(r.corp)) rau("nu se compară cu cea mai recentă estimare", (r.corp.match(/[+-]\d+%/g) || []).join(" "));
  else ok("comparația se face cu cea mai recentă estimare, nu cu prima");

  // --- unități diferite: mai bine gol decât greșit -------------------------
  // 99.170 lei pe transport față de 6 dolari pe kilogram nu se compară.
  const rTr = await cer("/procurement/oferta", {
    metoda: "post",
    body: { articol_nume: "Transport aerian China – România", categorie_id: "6", um: "transport",
            furnizor_text: "DHL Express", pret: "99169.67", moneda: "RON", data_ofertei: plus(-5) },
  });
  const idTr = Number((locatie(rTr).match(/articol\/(\d+)/) || [])[1]);
  await cer("/procurement/articol/:id/piata", {
    metoda: "post", params: { id: idTr },
    body: { pret: "5.86", pret_max: "6.60", moneda: "USD", um: "kg", data: azi, sursa: "indice aerian general cargo" },
  });
  r = await cer("/procurement/articol/:id", { params: { id: idTr } });
  if (/[+-]\d+%/.test(r.corp)) rau("compară lei/transport cu dolari/kg", (r.corp.match(/[+-]\d+%/g) || []).join(" "));
  else if (!r.corp.includes("altă unitate de măsură")) rau("nu spune de ce n-are procent");
  else ok("când unitățile diferă nu inventează un procent, ci spune de ce");

  // și coloana din lista principală
  r = await cer("/procurement");
  cere("coloana «Față de piață» în listă", r.corp, ["Față de piață"], []);

  // --- accesul -------------------------------------------------------------
  if (!auth.poateAccesa(VALI, "/procurement")) rau("administratorul n-are acces la Procurement");
  else ok("Procurement e o secțiune de sine stătătoare în meniu");

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
