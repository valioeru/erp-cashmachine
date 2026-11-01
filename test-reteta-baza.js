"use strict";
// Rețeta unui produs care în SmartBill se produce pe mai multe bucăți odată.
//
// CE S-A ÎNTÂMPLAT: plicurile AWB C5 CM se scriu în SmartBill „la mia” — un
// bon de producție spune 1, adică 1.000 de plicuri. Puntea reface rețeta din
// bonuri (consum / cantitate produsă), deci ieșea pe 1.000 de plicuri, citită
// pe unul: 40,43 mp de hârtie pe plic, 32,74 lei cost pe un plic de 0,04 lei.
// Vali, 01.11.2026: împărțită la 1.000, iar importul să n-o strice iar.
//
// CE APĂRĂ:
//   • „1 pe bon = N bucăți” se scrie pe pagina rețetei (produse.reteta_baza);
//     cu bifa „împarte”, cantitățile de acum trec pe noua bază, iar costul se
//     recalculează pe loc;
//   • importul din SmartBill împarte consumul la bucățile reale, deci nu mai
//     aduce înapoi rețeta pe 1.000;
//   • produsele fără bază rămân exact ca înainte;
//   • o bază aiurea (0, negativă, text, peste un milion) nu schimbă nimic.
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
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

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
require(path.join(RAD, "modules", "retete.js")).register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const { HANDLERE } = require(path.join(RAD, "modules", "punte.js"));

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const USER = { id: 1, nume: "Vali", rol: "admin" };
async function cer(cale, params, query) {
  const r = res();
  await rute.get[cale]({ user: USER, params: params || {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
}
async function trimite(cale, params, body) {
  const r = res();
  await rute.post[cale]({ user: USER, params: params || {}, query: {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const unde = (r) => decodeURIComponent(String((r.antet && (r.antet.Location || r.antet.location)) || ""));
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 260) : "")); esecuri++; }
}
// REAL în Postgres ține ~7 cifre semnificative: comparăm relativ.
const aproape = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.abs(Number(b)) * 1e-5 + 1e-12;

const PFX = "TSTBAZA-";
function curata() {
  q(`DELETE FROM retete_componente WHERE produs_id IN (SELECT id FROM produse WHERE cod LIKE '${PFX}%')
        OR componenta_id IN (SELECT id FROM produse WHERE cod LIKE '${PFX}%')`);
  q(`DELETE FROM produse WHERE cod LIKE '${PFX}%'`);
}
const produs = (cod, den, um, pret) =>
  Number(q(`INSERT INTO produse (cod, denumire, unitate_masura, pret_achizitie) VALUES (${lit(cod)}, ${lit(den)}, ${lit(um)}, ${pret}) RETURNING id`)[0].id);
const cant = (finit, comp) => Number(unul(`SELECT cantitate FROM retete_componente WHERE produs_id = ${finit} AND componenta_id = ${comp}`));
const bazaDe = (id) => unul(`SELECT reteta_baza FROM produse WHERE id = ${id}`);

(async () => {
  curata();
  const plic = produs(PFX + "PLIC", "TSTBAZA Plic AWB C5", "buc", 0.04);
  const hartie = produs(PFX + "HARTIE", "TSTBAZA Hartie release", "m2", 0.5978);
  const film = produs(PFX + "FILM", "TSTBAZA Film CPE", "kg", 7.15);
  const ctrl = produs(PFX + "CTRL", "TSTBAZA Cutie control", "buc", 2);
  const carton = produs(PFX + "CARTON", "TSTBAZA Carton", "kg", 3);
  // Rețeta pe 1.000 de plicuri, cum a adus-o SmartBill.
  q(`INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (${plic}, ${hartie}, 40.433964), (${plic}, ${film}, 1.15566), (${ctrl}, ${carton}, 0.25)`);

  console.log("\n1. Pagina rețetei");
  {
    const r = await cer("/productie/retete/:id", { id: String(plic) });
    const t = text(r.corp);
    bine("se deschide", r.cod === 200, r.cod);
    bine("are secțiunea „Producția din SmartBill”, cu baza de acum (1 bucată)", t.includes("Producția din SmartBill") && t.includes("1 pe bon = 1 bucată"));
    bine("formularul trimite la /baza, cu bifa „împarte” pusă din oficiu", r.corp.includes(`action="/productie/retete/${plic}/baza"`) && /name="imparte" value="1" checked/.test(r.corp));
  }

  console.log("\n2. Baza 1.000 cu „împarte”");
  {
    const r = await trimite("/productie/retete/:id/baza", { id: String(plic) }, { baza: "1000", imparte: "1" });
    bine("se întoarce pe rețetă cu mesaj de succes", r.cod === 302 && unde(r).includes("ok=") && unde(r).includes("împărțite la 1.000"), unde(r));
    bine("hârtia: 40,433964 → 0,040433964 mp pe plic", aproape(cant(plic, hartie), 0.040433964), cant(plic, hartie));
    bine("filmul: 1,15566 → 0,00115566 kg pe plic", aproape(cant(plic, film), 0.00115566), cant(plic, film));
    bine("baza e ținută minte: 1.000", Number(bazaDe(plic)) === 1000, bazaDe(plic));
    const cost = Number(unul(`SELECT cost_reteta FROM produse WHERE id = ${plic}`));
    bine("costul s-a recalculat pe loc: ~0,032 lei pe plic, nu 32 de lei", cost > 0.02 && cost < 0.05, cost);
    bine("altă rețetă nu s-a atins", aproape(cant(ctrl, carton), 0.25), cant(ctrl, carton));
    const p = text((await cer("/productie/retete/:id", { id: String(plic) }, { ok: "x" })).corp);
    bine("pagina arată acum „1 pe bon = 1.000 bucăți”", p.includes("1 pe bon = 1.000 bucăți"));
  }

  console.log("\n3. Importul din SmartBill nu mai strică rețeta");
  {
    // Un bon cu 2 unități (= 2.000 de plicuri) și consumul real pentru ele.
    const rez = await HANDLERE.productie([
      { finite: [{ produs: "TSTBAZA Plic AWB C5", cod: PFX + "PLIC", cantitate: 2, um: "mii" }],
        consum: [{ produs: "TSTBAZA Hartie release", cod: PFX + "HARTIE", cantitate: 80.867928, um: "m2" },
                 { produs: "TSTBAZA Film CPE", cod: PFX + "FILM", cantitate: 2.31132, um: "kg" }] },
      { finite: [{ produs: "TSTBAZA Cutie control", cod: PFX + "CTRL", cantitate: 4, um: "buc" }],
        consum: [{ produs: "TSTBAZA Carton", cod: PFX + "CARTON", cantitate: 1.2, um: "kg" }] },
    ]);
    bine("importul a scris rețetele", rez && rez.retete >= 3, JSON.stringify(rez));
    bine("hârtia rămâne pe plic: 80,87 / (2 × 1.000) = 0,040434", aproape(cant(plic, hartie), 0.040433964), cant(plic, hartie));
    bine("filmul rămâne pe plic: 2,31132 / 2.000 = 0,00115566", aproape(cant(plic, film), 0.00115566), cant(plic, film));
    bine("produsul fără bază, ca înainte: 1,2 / 4 = 0,3 kg pe cutie", aproape(cant(ctrl, carton), 0.3), cant(ctrl, carton));
  }

  console.log("\n4. Baze greșite și varianta fără bifă");
  {
    for (const v of ["0", "-5", "abc", "2000000", ""]) {
      const r = await trimite("/productie/retete/:id/baza", { id: String(plic) }, { baza: v, imparte: "1" });
      bine(`baza „${v}” e refuzată, nimic schimbat`, unde(r).includes("eroare=") && Number(bazaDe(plic)) === 1000 && aproape(cant(plic, hartie), 0.040433964), unde(r));
    }
    const r = await trimite("/productie/retete/:id/baza", { id: String(ctrl) }, { baza: "10" });
    bine("fără bifă: se schimbă doar baza, cantitățile rămân", unde(r).includes("au rămas cum erau") && Number(bazaDe(ctrl)) === 10 && aproape(cant(ctrl, carton), 0.3), unde(r));
  }

  console.log("\n5. Înapoi la 1 bucată");
  {
    const r = await trimite("/productie/retete/:id/baza", { id: String(plic) }, { baza: "1", imparte: "1" });
    bine("cantitățile se înmulțesc înapoi cu 1.000", unde(r).includes("înmulțite la 1.000") && aproape(cant(plic, hartie), 40.433964), cant(plic, hartie));
    bine("baza se șterge (NULL = 1, ca la toate produsele)", bazaDe(plic) === null, bazaDe(plic));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
