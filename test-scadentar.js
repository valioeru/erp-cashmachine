"use strict";
// Test pentru scadențare și pentru închiderea istoricului vechi.
//
// Rulează pe PostgreSQL adevărat, prin psql (vezi comentariul din
// test-depozit.js: `pg` nu se poate instala aici, dar SQL-ul chiar se execută
// pe schema reală). Se rulează din rădăcina repo-ului, cu baza pe 5433.
//
// Ce se verifică, în ordinea în care s-au stricat lucrurile:
//   1. „de plătit" aduna fiecare factură de furnizor din 2021 încoace;
//   2. bifa „include scadențele depășite" nu se putea scoate;
//   3. închiderea istoricului trebuie să fie reversibilă exact cum era;
//   4. o factură închisă nu mai are voie să primească încasări.
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

const rap = require(path.join(RAD, "modules", "rapoarte.js"));
const rute = { get: {}, post: {} };
rap.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const MIHAI = { id: 2, nume: "Mihai", rol: "productie" };

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

// ---- datele de test ---------------------------------------------------------
const azi = new Date().toISOString().slice(0, 10);
const AN = azi.slice(0, 4);
const plus = (n) => new Date(Date.UTC(+azi.slice(0, 4), +azi.slice(5, 7) - 1, +azi.slice(8, 10) + n)).toISOString().slice(0, 10);

function fixture() {
  const S = [
    "TRUNCATE plati, facturi_linii, facturi, inchideri_istoric RESTART IDENTITY CASCADE",
    "DELETE FROM parteneri WHERE cui IN ('RO-TEST-C','RO-TEST-F')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (90001,'CLIENT DE TEST SRL','RO-TEST-C','client'), (90002,'FURNIZOR DE TEST SRL','RO-TEST-F','furnizor') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
  ];
  // id, directie, partener, emitere, scadenta, status, total fără TVA (cota 0)
  const F = [
    [90101, "vanzare", 90001, "2022-03-01", "2022-04-01", "emisa", 10000],
    [90102, "vanzare", 90001, AN + "-02-10", plus(5), "emisa", 5000],
    [90103, "vanzare", 90001, AN + "-02-11", plus(-3), "emisa", 1000],
    [90104, "vanzare", 90001, "2023-06-01", "2023-07-01", "platita_partial", 4000],
    [90201, "achizitie", 90002, "2022-05-09", "2022-06-09", "emisa", 1000000],
    [90202, "achizitie", 90002, AN + "-03-01", plus(10), "emisa", 20000],
  ];
  for (const [id, dir, part, em, sc, st, tot] of F) {
    S.push(`INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, firma_id, intercompany, activ) VALUES (${id},'TST',${id},${part},'${dir}','${em}','${sc}','${st}',NULL,0,1)`);
    S.push(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id},'marfă',1,${tot},0)`);
  }
  // 90104 are deja 1.000 încasați, deci rest 3.000 și status platita_partial
  S.push("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (90104, 1000, '2023-08-01', 'banca', 'test')");
  S.push("SELECT setval(pg_get_serial_sequence('facturi','id'), 90500, true)");
  for (const s of S) execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  fixture();
  console.log("rute GET :", Object.keys(rute.get).filter((r) => /scadentar-grup|incasari|inchide/.test(r)).join(", "));
  console.log("rute POST:", Object.keys(rute.post).filter((r) => /incasari|inchide/.test(r)).join(", "));
  console.log("");

  // --- 1. scadențarul de grup taie istoricul vechi ------------------------
  let r = await cer("/rapoarte/scadentar-grup");
  cere("scadențar grup, implicit ultimele 12 luni", r.corp,
    ["Total de plătit", "20.000,00", "Ce n-a intrat în totalurile de sus", "1.000.000,00", "2022"],
    []);
  if (r.corp.indexOf("1.000.000,00") < r.corp.indexOf("Ce n-a intrat"))
    rau("factura de 1.000.000 din 2022 a intrat în totaluri, nu în blocul de vechi");
  else ok("cel mai mare document vechi stă în blocul de jos, nu în total");

  // --- 2. pe „tot istoricul" intră și cele vechi ---------------------------
  r = await cer("/rapoarte/scadentar-grup", { query: { vechime: "tot" } });
  cere("scadențar grup, tot istoricul", r.corp, ["1.020.000,00"], ["Ce n-a intrat în totalurile de sus"]);

  // --- 3. intervalele ------------------------------------------------------
  r = await cer("/rapoarte/scadentar-grup", { query: { interval: "sapt_curenta" } });
  cere("interval „săptămâna curentă”", r.corp, ["săptămâna curentă"], []);
  r = await cer("/rapoarte/scadentar-grup", { query: { interval: "pana_final_an" } });
  // layout() rescrie datele ISO în format românesc, deci se caută 31.12.aaaa.
  cere("interval „până la final de an”", r.corp, ["31.12." + AN], []);

  // --- 4. bifa care nu se putea scoate ------------------------------------
  const fara = await cer("/rapoarte/incasari", { query: { vechi: "0" } });
  const cu = await cer("/rapoarte/incasari", { query: { vechi: "1" } });
  // 90103 e scadentă acum 3 zile: cu „1" intră (6.000), cu „0" nu (5.000).
  if (!cu.corp.includes("6.000,00")) rau("cu scadențele depășite nu dă 6.000");
  else if (fara.corp.includes("6.000,00")) rau("«doar din intervalul ales» tot le include — bifa e la fel de stricată");
  else if (!fara.corp.includes("5.000,00")) rau("fără scadențele depășite nu rămâne 5.000");
  else ok("alegerea „cu / fără scadențele depășite” chiar schimbă totalul");

  // --- 5. vederea listă, sortabilă ---------------------------------------
  r = await cer("/rapoarte/incasari", { query: { vedere: "lista" } });
  cere("vederea listă", r.corp, ["<thead><tr><th>Scadența</th>", "TST-90102"], ["zi-bloc"]);

  // --- 6. pagina de închidere: câte se închid și cât rămâne ---------------
  r = await cer("/rapoarte/inchide-istoric");
  cere("pagina de închidere a istoricului", r.corp,
    ["Închiderea istoricului vechi", "1.000.000,00", "facturi de furnizor", "Marchează ca achitate"], []);

  // --- 7. un neadministrator nu închide nimic -----------------------------
  await cer("/rapoarte/inchide-istoric", { user: MIHAI, metoda: "post", body: { prag: AN + "-01-01", directie: "ambele" } });
  if (q("SELECT COUNT(*) AS n FROM inchideri_istoric")[0].n !== "0") rau("un neadministrator a putut închide istoricul");
  else ok("închiderea e refuzată dacă n-o cere administratorul");

  // --- 8. închiderea propriu-zisă -----------------------------------------
  await cer("/rapoarte/inchide-istoric", { metoda: "post", body: { prag: AN + "-01-01", directie: "ambele" } });
  const dupa = q("SELECT id, status, inchis_istoric FROM facturi WHERE id IN (90101,90102,90103,90104,90201,90202) ORDER BY id");
  const stare = Object.fromEntries(dupa.map((x) => [x.id, x.status + (x.inchis_istoric ? "+închisă" : "")]));
  const asteptat = {
    90101: "platita+închisă", 90102: "emisa", 90103: "emisa",
    90104: "platita+închisă", 90201: "platita+închisă", 90202: "emisa",
  };
  const gresite = Object.keys(asteptat).filter((k) => stare[k] !== asteptat[k]);
  if (gresite.length) rau("închiderea a atins ce nu trebuia", JSON.stringify(stare));
  else ok("s-au închis doar documentele de dinainte de 1 ianuarie; anul curent e neatins");

  // --- 9. după închidere, rapoartele arată realitatea ---------------------
  r = await cer("/rapoarte/scadentar-grup", { query: { vechime: "tot" } });
  cere("scadențarul după închidere, pe tot istoricul", r.corp, ["20.000,00", "6.000,00"], ["1.000.000,00"]);

  // --- 9b. după închidere, filtrul pe vechime se dă singur la o parte ------
  // Altfel ar tăia a doua oară peste tăietura deja făcută, iar scadențarul ar
  // arăta altă cifră decât Financiar sau Consolidat.
  r = await cer("/rapoarte/scadentar-grup");
  if (!r.corp.includes("tot istoricul")) rau("după închidere, implicitul n-a trecut pe „tot istoricul”");
  else if (r.corp.includes("Ce n-a intrat în totalurile de sus")) rau("după închidere, scadențarul încă ascunde documente");
  else ok("după închidere, scadențarul se pune singur pe „tot istoricul”");

  // --- 10. o încasare venită pe o factură închisă e ignorată --------------
  // Exact regula cerută: „daca in viitor apar incasari ptr facturi mai vechi
  // le ignori". Verificăm pe interogarea care hrănește reconcilierea bancară.
  const deschise = q(
    `SELECT f.id FROM (SELECT * FROM facturi WHERE activ = 1) f
      WHERE f.status NOT IN ('anulata','necunoscut','platita') AND f.inchis_istoric IS NULL
        AND f.id IN (90101,90102,90201,90202) ORDER BY f.id`
  ).map((x) => Number(x.id));
  if (deschise.includes(90101) || deschise.includes(90201)) rau("facturile închise sunt încă oferite la reconciliere", JSON.stringify(deschise));
  else if (deschise.join(",") !== "90102,90202") rau("s-au ascuns și facturile din anul curent", JSON.stringify(deschise));
  else ok("facturile închise nu mai apar la potrivirea încasărilor");

  // --- 11. anularea pune totul exact cum era -----------------------------
  const inch = q("SELECT id FROM inchideri_istoric ORDER BY id");
  for (const i of inch) await cer("/rapoarte/inchide-istoric/:id/anuleaza", { metoda: "post", params: { id: Number(i.id) } });
  const inapoi = Object.fromEntries(
    q("SELECT id, status, inchis_istoric FROM facturi WHERE id IN (90101,90104,90201) ORDER BY id").map((x) => [x.id, x.status + (x.inchis_istoric ? "+închisă" : "")])
  );
  if (inapoi["90104"] !== "platita_partial") rau("anularea a uitat că 90104 era achitată parțial", JSON.stringify(inapoi));
  else if (inapoi["90101"] !== "emisa" || inapoi["90201"] !== "emisa") rau("anularea n-a redeschis facturile", JSON.stringify(inapoi));
  else ok("anularea pune fiecare factură pe statusul ei de dinainte, nu pe unul presupus");

  // ...iar filtrul pe vechime își reia rolul, fiindcă închiderea nu mai e activă
  r = await cer("/rapoarte/scadentar-grup");
  if (!r.corp.includes("Ce n-a intrat în totalurile de sus")) rau("după anulare, filtrul pe vechime nu s-a reactivat");
  else ok("după anulare, filtrul pe vechime se reactivează singur");

  const marcate = q("SELECT COUNT(*) AS n FROM inchideri_istoric WHERE anulata_la IS NOT NULL")[0].n;
  if (Number(marcate) !== inch.length) rau("închiderile nu s-au marcat ca anulate");
  else ok("istoricul închiderilor rămâne, marcat ca anulat");

  // --- 12. verificările noi ----------------------------------------------
  const ver = require(path.join(RAD, "modules", "verificari.js"));
  const ruteV = { get: {}, post: {} };
  ver.register({ get: (p, h) => { ruteV.get[p] = h; }, post: (p, h) => { ruteV.post[p] = h; } });
  const rv = res();
  await ruteV.get["/admin/date"]({ user: VALI, params: {}, query: {}, body: {}, res: rv, req: { url: "/admin/date" } });
  cere("pagina de verificări cu cele două controale noi", rv.corp,
    ["Facturi de vânzare cu același număr de document", "Facturi de peste un milion de lei", "1.000.000,00"], []);

  // Curățăm după noi: testul depozitului își reface propria fixtură ștergând
  // facturile, iar o plată rămasă aici i-ar bloca ștergerea prin cheia străină.
  for (const s of [
    "TRUNCATE plati, facturi_linii, facturi, inchideri_istoric RESTART IDENTITY CASCADE",
    "DELETE FROM parteneri WHERE cui IN ('RO-TEST-C','RO-TEST-F')",
  ]) execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
