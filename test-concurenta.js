"use strict";
// Test pentru BI-ul de prețuri ale concurenței.
//
// Rulează pe PostgreSQL adevărat, prin psql (vezi comentariul din
// test-depozit.js). Se rulează din rădăcina repo-ului, cu baza pe 5433.
//
// Ce se verifică:
//   1. blocul de pe ofertarea de vânzare arată prețurile concurenței ȘI
//      diferența față de prețul NOSTRU de pe linia ofertei;
//   2. blocul de pe articolul de achiziție compară cu cea mai bună ofertă a
//      noastră, nu cu prima din listă;
//   3. euro se aduce în lei la cursul din Procurement, ca să se poată compara;
//   4. agentul de vânzări vede doar vânzarea, procurement-ul doar achiziția,
//      managementul vede amândouă;
//   5. adăugarea refuză rândurile fără produs, fără concurent sau cu preț zero,
//      și leagă automat produsul din nomenclator când denumirea se potrivește;
//   6. ștergerea e o dezactivare, o poate face doar autorul sau adminul, iar
//      rândul rămâne în bază;
//   7. gruparea pe produs arată ultimul preț al fiecărui concurent, minimul,
//      maximul și cât de veche e ultima informație.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : "'" + String(v).replace(/'/g, "''") + "'";

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

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; }, options: () => {} };
const conc = require(path.join(RAD, "modules", "concurenta.js"));
conc.register(router);
require(path.join(RAD, "modules", "oferte.js")).register(router);
require(path.join(RAD, "modules", "procurement.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "", locatie: null };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; if (h && h.Location) o.locatie = h.Location; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const AGENT = { id: 2, nume: "Agentul", rol: "vanzari" };

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  const url = cale + "?" + new URLSearchParams(query).toString();
  await h({ user, params, query, body: body || {}, res: r, req: { url } });
  return r;
}

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
const egal = (eticheta, a, b) => (String(a) === String(b) ? ok(`${eticheta} = ${a}`) : rau(eticheta, `am ${a}, așteptam ${b}`));

const rulaj = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

const azi = new Date().toISOString().slice(0, 10);
const cuZile = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function fixture() {
  const S = [
    "DELETE FROM concurenta_preturi WHERE denumire LIKE 'TEST %' OR concurent LIKE 'TEST %'",
    "DELETE FROM oferte_linii WHERE oferta_id IN (SELECT id FROM oferte WHERE numar = 'TEST-OF-1')",
    "DELETE FROM oferte WHERE numar = 'TEST-OF-1'",
    "DELETE FROM ach_oferte WHERE articol_id IN (SELECT id FROM ach_articole WHERE nume = 'TEST Granule LLDPE')",
    "DELETE FROM ach_piata WHERE articol_id IN (SELECT id FROM ach_articole WHERE nume = 'TEST Granule LLDPE')",
    "DELETE FROM ach_articole WHERE nume = 'TEST Granule LLDPE'",
    "DELETE FROM produse WHERE denumire = 'TEST Sac menaj 60L'",
    "DELETE FROM parteneri WHERE cui IN ('RO-CONC-C','RO-CONC-F')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (92001,'CLIENT CONCURENTA SRL','RO-CONC-C','client'), (92002,'FURNIZOR CONCURENTA SRL','RO-CONC-F','furnizor') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin'), (2,'Agentul','agent@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO produse (id, denumire, unitate_masura, pret_vanzare) VALUES (92101,'TEST Sac menaj 60L','buc',1.00) ON CONFLICT (id) DO NOTHING",
    // oferta de vânzare: prețul NOSTRU e 1,00 lei/buc
    "INSERT INTO oferte (id, numar, versiune, radacina_id, partener_id, agent_id, titlu, status) VALUES (92201,'TEST-OF-1',1,92201,92001,2,'Ofertă de test','trimisa') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO oferte_linii (oferta_id, produs_id, denumire, um, cantitate, pret_unitar, cota_tva) VALUES (92201,92101,'TEST Sac menaj 60L','buc',1000,1.00,21)",
    // articol de achiziție: cea mai bună ofertă a NOASTRĂ e 1,40 EUR/kg (a doua, nu prima din listă)
    "INSERT INTO ach_categorii (id, nume) VALUES (92301,'TEST Materii prime') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO ach_articole (id, nume, categorie_id, um, activ) VALUES (92302,'TEST Granule LLDPE',92301,'kg',1) ON CONFLICT (id) DO NOTHING",
    `INSERT INTO ach_oferte (articol_id, furnizor_id, pret, moneda, um, data_ofertei, valabil_pana, sursa, activ) VALUES (92302,92002,1.60,'EUR','kg','${azi}','${cuZile(30)}','manual',1)`,
    `INSERT INTO ach_oferte (articol_id, furnizor_text, pret, moneda, um, data_ofertei, valabil_pana, sursa, activ) VALUES (92302,'Fabrica din Ungaria',1.40,'EUR','kg','${azi}','${cuZile(30)}','manual',1)`,
    // curs fix, ca cifrele din test să nu depindă de ce e setat în bază
    "INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('ach_curs_eur','5.00','x') ON CONFLICT (cheie) DO UPDATE SET valoare = '5.00'",
  ];
  for (const s of S) rulaj(s);
}

function curatenie() {
  for (const s of [
    "DELETE FROM concurenta_preturi WHERE denumire LIKE 'TEST %' OR concurent LIKE 'TEST %'",
    "DELETE FROM oferte_linii WHERE oferta_id = 92201",
    "DELETE FROM oferte WHERE id = 92201",
    "DELETE FROM ach_oferte WHERE articol_id = 92302",
    "DELETE FROM ach_articole WHERE id = 92302",
    "DELETE FROM ach_categorii WHERE id = 92301",
    "DELETE FROM produse WHERE id = 92101",
    "DELETE FROM parteneri WHERE id IN (92001,92002)",
  ]) {
    try { rulaj(s); } catch (e) { /* fixtura poate fi deja curată */ }
  }
}

(async () => {
  console.log("\n── Prețurile concurenței ─────────────────────────────────────");
  fixture();

  // ---- adăugare de pe ofertarea de vânzare --------------------------------
  // Prețul nostru pe linie e 1,00 lei. Concurentul dă 0,90 lei ⇒ −10%, roșu.
  let r = await cer("/crm/concurenta/adauga", {
    metoda: "post",
    user: AGENT,
    body: { directie: "vanzare", oferta_id: "92201", partener_id: "92001", denumire: "TEST Sac menaj 60L", concurent: "TEST Concurentul Mare", pret: "0.90", moneda: "RON", um: "buc", data_ofertei: azi, sursa: "client", inapoi: "/oferte/92201" },
  });
  egal("adăugarea trimite înapoi la ofertă", r.locatie, "/oferte/92201");

  const scris = q("SELECT produs_id, directie, creat_de FROM concurenta_preturi WHERE concurent = 'TEST Concurentul Mare'")[0];
  egal("produsul din nomenclator e legat automat", scris && scris.produs_id, "92101");
  egal("direcția e vânzare", scris && scris.directie, "vanzare");
  egal("autorul e agentul care a scris", scris && scris.creat_de, "2");

  // rânduri care n-ar spune nimic: se refuză, fără să crape pagina
  const inainte = Number(q("SELECT COUNT(*) AS n FROM concurenta_preturi")[0].n);
  for (const b of [
    { denumire: "", concurent: "X", pret: "1" },
    { denumire: "TEST Sac menaj 60L", concurent: "", pret: "1" },
    { denumire: "TEST Sac menaj 60L", concurent: "X", pret: "0" },
    { denumire: "TEST Sac menaj 60L", concurent: "X", pret: "-5" },
  ]) {
    await cer("/crm/concurenta/adauga", { metoda: "post", user: AGENT, body: Object.assign({ oferta_id: "92201", inapoi: "/oferte/92201" }, b) });
  }
  egal("rândurile fără produs / concurent / preț se refuză", Number(q("SELECT COUNT(*) AS n FROM concurenta_preturi")[0].n), inainte);

  // ---- blocul de pe ofertarea de vânzare ----------------------------------
  r = await cer("/oferte/:id", { params: { id: "92201" }, user: AGENT });
  cere(
    "oferta de vânzare arată blocul de concurență cu diferența față de noi",
    r.corp,
    ["Prețurile concurenței", "TEST Concurentul Mare", "0,90 RON", "0,90 lei", "-10.0%", "Adaugă prețul"]
  );

  // ---- achiziție: comparația se face cu CEA MAI BUNĂ ofertă a noastră ------
  // Cea mai bună a noastră: 1,40 EUR = 7,00 lei la curs 5,00.
  // Concurentul ia la 1,26 EUR = 6,30 lei ⇒ −10% față de 7,00, nu față de 1,60.
  await cer("/procurement/concurenta/adauga", {
    metoda: "post",
    user: VALI,
    body: { directie: "achizitie", ach_articol_id: "92302", denumire: "TEST Granule LLDPE", concurent: "TEST Rivalul", pret: "1.26", moneda: "EUR", um: "kg", data_ofertei: azi, sursa: "furnizor", inapoi: "/procurement/articol/92302" },
  });
  r = await cer("/procurement/articol/:id", { params: { id: "92302" }, user: VALI });
  cere(
    "articolul de achiziție compară cu cea mai bună ofertă a noastră, nu cu prima",
    r.corp,
    ["Prețurile concurenței", "TEST Rivalul", "1,26 EUR", "6,30 lei", "-10.0%"]
  );

  // ---- cine vede ce -------------------------------------------------------
  r = await cer("/crm/concurenta", { user: AGENT });
  cere("agentul vede doar vânzarea", r.corp, ["TEST Concurentul Mare", "Prețurile concurenței la clienți"], ["TEST Rivalul"]);

  r = await cer("/procurement/concurenta", { user: VALI });
  cere("procurement-ul vede doar achiziția", r.corp, ["TEST Rivalul", "Prețurile concurenței la achiziții"], ["TEST Concurentul Mare"]);

  r = await cer("/rapoarte/concurenta", { user: VALI });
  cere("managementul le vede pe amândouă", r.corp, ["TEST Concurentul Mare", "TEST Rivalul", "achiziție", "vânzare"]);

  // ---- gruparea pe produs -------------------------------------------------
  // acelasi produs, alt concurent, alta data: minimul si maximul trebuie sa se vada
  await cer("/concurenta/adauga", {
    metoda: "post",
    user: VALI,
    body: { directie: "vanzare", denumire: "TEST Sac menaj 60L", concurent: "TEST Concurentul Mic", pret: "1.20", moneda: "RON", data_ofertei: cuZile(-200), sursa: "targ", inapoi: "/rapoarte/concurenta" },
  });
  r = await cer("/rapoarte/concurenta", { user: VALI, query: { vedere: "produse", directie: "vanzare" } });
  cere(
    "gruparea pe produs arată fiecare concurent, minimul și maximul",
    r.corp,
    ["TEST Concurentul Mare", "TEST Concurentul Mic", "0,90 lei", "1,20 lei", "proaspăt"]
  );
  r = await cer("/rapoarte/concurenta", { user: VALI, query: { vedere: "istoric", q: "Concurentul Mic" } });
  // „TEST Rivalul" rămâne în lista derulantă de concurenți a filtrului — acolo
  // trebuie să fie, altfel n-ai cum să-l alegi. Verific că nu e în TABEL, prin
  // prețul lui în lei, care apare doar pe rând.
  cere("căutarea liberă filtrează", r.corp, ["TEST Concurentul Mic", "1,20 lei"], ["6,30 lei"]);

  // ---- ștergerea ----------------------------------------------------------
  const idAgent = Number(q("SELECT id FROM concurenta_preturi WHERE concurent = 'TEST Concurentul Mare'")[0].id);
  // adminul care n-a scris rândul are voie; un alt agent, nu
  await cer("/concurenta/:id/sterge", { metoda: "post", params: { id: String(idAgent) }, user: { id: 3, nume: "Altul", rol: "vanzari" }, body: {} });
  egal("un alt agent nu poate șterge rândul altcuiva", q(`SELECT activ FROM concurenta_preturi WHERE id = ${idAgent}`)[0].activ, "1");
  await cer("/concurenta/:id/sterge", { metoda: "post", params: { id: String(idAgent) }, user: VALI, body: {} });
  egal("adminul poate", q(`SELECT activ FROM concurenta_preturi WHERE id = ${idAgent}`)[0].activ, "0");
  egal("rândul rămâne în bază, doar dezactivat", Number(q(`SELECT COUNT(*) AS n FROM concurenta_preturi WHERE id = ${idAgent}`)[0].n), 1);

  r = await cer("/crm/concurenta", { user: AGENT });
  cere("rândul dezactivat dispare din raport", r.corp, [], ["TEST Concurentul Mare"]);

  curatenie();
  console.log(`\n${rele ? rele + " probleme" : "Totul curat."}  (${interogari} interogări SQL)\n`);
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error(e); curatenie(); process.exit(2); });
