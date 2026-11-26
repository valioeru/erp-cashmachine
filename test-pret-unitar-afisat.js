"use strict";
// Prețul pe unitate se arată cu zecimalele lui, nu rotunjit la doi bani.
//
// CE A VĂZUT VALI, 26.11.2026 (factura CSHM 3448, ELHOR TRADE): 30.000 buc,
// „0,08 lei", subtotal 2.370,00 lei — „aici ai calculat greșit, vezi să nu mai
// fie și în alte părți". Prețul din ERP era 0,079; suma era bună, afișarea
// prețului era rotunjită, deci cifrele de pe pagină nu ieșeau la socoteală.
//
// CE APĂRĂ:
//   • formatorul de preț unitar scrie patru zecimale când prețul le are
//     (0,0790 — la fel ca pe comenzi) și două când e rotund (23,50);
//   • pagina facturii arată prețul din bază, iar cantitate × prețul afișat dă
//     subtotalul afișat;
//   • niciun modul nu mai scrie un preț sau un cost pe unitate cu `money`
//     (două zecimale): lista de mai jos e ce s-a găsit și s-a îndreptat, iar
//     căutarea prinde un loc nou scris la fel.
const fs = require("fs");
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
// SmartBill nu e configurat în test: validarea facturii nu trimite nimic.
for (const k of Object.keys(process.env)) if (/^SMARTBILL/.test(k)) delete process.env[k];
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail$/.test(req)) return { trimite: async () => ({ ok: true }), trimiteDeLa: async () => ({ ok: true }), configUtilizator: async () => null };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["facturi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98511, nume: "Vali Test", rol: "admin", email: "v.pu@test.ro" };
const AGENT = { id: 98512, nume: "Gabriela Test", rol: "vanzari", email: "g.pu@test.ro" };

async function cer(cale, { user = ADMIN, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));

const RENDER = require(path.join(RAD, "lib", "render.js"));
function curata() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id = 985001",
    "DELETE FROM facturi WHERE id = 985001",
    "DELETE FROM interactiuni WHERE partener_id = 98501",
    "DELETE FROM parteneri WHERE id = 98501",
    "DELETE FROM utilizatori WHERE id BETWEEN 98511 AND 98519",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  console.log("── Formatorul ───────────────────────────────────────────────");
  egal("prețul pe unitate: până la patru zecimale, câte are; cel rotund rămâne cu două",
    [0.079, 0.4235, 23.5, 12, 0.08, 1234.5678, 0.00004, "0.079", null, "", "abc"].map((v) => RENDER.pretLei(v)),
    ["0,0790 lei", "0,4235 lei", "23,50 lei", "12,00 lei", "0,08 lei", "1.234,5678 lei", "0,00 lei", "0,0790 lei", "0,00 lei", "0,00 lei", "0,00 lei"]);
  egal("sumele rămân la două zecimale", [RENDER.money(2370), RENDER.money(0.079)], ["2.370,00 lei", "0,08 lei"]);

  console.log("\n── Pagina facturii ──────────────────────────────────────────");
  curata();
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98511,'Vali Test','v.pu@test.ro','x','y','admin')");
  exec("INSERT INTO parteneri (id, nume, cui, tip) VALUES (98501, 'PU-TEST Client SRL', 'RO98501', 'client')");
  exec("INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, status) VALUES (985001, 'FCT', 985001, 98501, 'vanzare', '2026-11-26', 'emisa')");
  exec("INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (985001, 'Plic AWB C5 PU', 30000, 0.079, 21), (985001, 'Folie PU', 12, 23.5, 21)");
  const r = await cer("/facturi/:id", { params: { id: "985001" } });
  const randuri = (String(r.corp).match(/<tr[\s\S]*?<\/tr>/g) || []).map((tr) => (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((td) => td.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()));
  const plic = randuri.find((x) => x[0] === "Plic AWB C5 PU") || [];
  const folie = randuri.find((x) => x[0] === "Folie PU") || [];
  egal("linia de 30.000 × 0,079: prețul apare întreg, subtotalul e 2.370,00", [r.cod, plic[1], plic[2], plic[4]], [200, "30000", "0,0790 lei", "2.370,00 lei"]);
  const numar = (t) => Number(String(t).replace(/[^0-9,]/g, "").replace(",", "."));
  egal("cantitate × prețul afișat = subtotalul afișat (pe fiecare linie)", [Math.round(numar(plic[1]) * numar(plic[2]) * 100) / 100 === numar(plic[4]), folie[2], Math.round(numar(folie[1]) * numar(folie[2]) * 100) / 100 === numar(folie[4])], [true, "23,50 lei", true]);
  curata();

  console.log("\n── Nicăieri un preț pe unitate cu două zecimale ─────────────");
  // Ce nume poartă, în module, un preț sau un cost PE UNITATE. `money(…)` peste
  // ele e greșeala de pe factură. Totalurile (venit, valoare, cost pe toată
  // cantitatea) au alte nume și rămân cu `money`.
  const PE_UNITATE = /money\(\s*(?:[A-Za-z_$][\w$.]*\.)?(?:pret_unitar|pret_vanzare|pret_achizitie|pret_productie|pret_minim|pret_intrare|pret_tinta|pret_ofertare|cost_reteta|cost_unitar|costPeBucata|pretReper|pret|pretNou)\s*\)/;
  const gasite = [];
  for (const dosar of ["modules", "lib"]) {
    for (const f of fs.readdirSync(path.join(RAD, dosar)).filter((x) => x.endsWith(".js"))) {
      fs.readFileSync(path.join(RAD, dosar, f), "utf8").split("\n").forEach((rand, i) => {
        if (PE_UNITATE.test(rand)) gasite.push(`${dosar}/${f}:${i + 1}`);
      });
    }
  }
  egal("niciun preț sau cost pe unitate nu mai e scris cu `money`", gasite, []);
  const cu = (f, n) => (fs.readFileSync(path.join(RAD, f), "utf8").match(/pretLei\(/g) || []).length >= n;
  egal("locurile îndreptate folosesc formatorul de preț", ["modules/facturi.js", "modules/oferte.js", "modules/produse.js", "modules/stocuri.js", "modules/retete.js", "modules/comenzi-zi.js", "modules/verificari.js", "modules/concurenta.js", "modules/calculator.js", "modules/productie.js", "modules/procurement.js", "modules/forecast.js", "modules/inventar.js", "modules/punte-rute.js"].filter((f) => !cu(f, 1)).concat(cu("modules/rfq.js", 11) ? [] : ["modules/rfq.js"]), []);
  const ist = fs.readFileSync(path.join(RAD, "lib", "comanda-istoric.js"), "utf8");
  const com = fs.readFileSync(path.join(RAD, "modules", "comenzi.js"), "utf8");
  bine("istoricul comenzii și emailul de comandă nouă scriu prețul cu zecimalele lui", !/bani\([a-z]\.pret_unitar\)/.test(ist) && /pretScris\(l\.pret_unitar\)/.test(ist) && /× \$\{pretIn\(l\.pret_unitar, c\.moneda\)\}/.test(com) && !/× \$\{lei\(l\.pret_unitar\)\}/.test(com));
  const IST = require(path.join(RAD, "lib", "comanda-istoric.js"));
  const dif = IST.diferenteLinii([{ id: 1, produs_id: 5, denumire: "Plic", cantitate: 10, pret_unitar: 0.079 }], [{ id: 1, produs_id: 5, denumire: "Plic", cantitate: 10, pret_unitar: 0.081 }]);
  egal("o schimbare de preț de la 0,079 la 0,081 se vede în istoric (înainte: „0,08 → 0,08”)", dif.map((x) => [x.vechi, x.nou]), [["0,0790", "0,0810"]]);

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
