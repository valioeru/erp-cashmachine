"use strict";
// „Prețuri, aliasuri și costuri manuale" din raportul Comenzi Sameday.
//
// Vali, 09.11.2026: „În pagina de comenzi noi Sameday nu salvează costurile
// noi la anumite produse." Gabi (Achiziții, cu raportul Sameday) a apăsat de
// trei ori „Salvează" pe costurile cutiilor și plicurilor antișoc. Salvarea
// era doar a administratorului și se întorcea pe pagină fără niciun cuvânt.
//
// Ce apără:
//   • COSTUL MANUAL îl salvează oricine are raportul; nota lui la fel.
//   • PREȚUL DE VÂNZARE ȘI ALIASURILE rămân ale administratorului: la ceilalți
//     se văd ca text, iar dacă le trimite cineva de mână, nu se iau.
//   • CE NU E ÎN FORMULAR NU SE ATINGE: produsele scoase din listă (activ = 0)
//     nu mai primesc preț 0 și cost gol la fiecare salvare.
//   • UN COST CARE NU E NUMĂR NU ȘTERGE COSTUL VECHI și pagina spune unde.
//   • PRODUSUL LEGAT LA NOMENCLATOR nu primește cost de mână.
//   • ZILELE DEJA SCRISE: rândurile fără cost îl primesc, cele cu cost înghețat
//     rămân cum erau.
//   • PAGINA SPUNE CE S-A SALVAT, iar cine n-are drept află asta.
//
// Pe PostgreSQL real (port 5433), prin psql.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, { PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp" });
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => {
    // UPDATE/DELETE fără RETURNING: câte rânduri a atins, ca pg (rowCount).
    const s = String(sql);
    if (/^\s*(UPDATE|DELETE)/i.test(s) && !/RETURNING/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});
const mod = require(path.join(RAD, "modules", "comenzi-zi.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} });
const CALE = "/rapoarte/comenzi-la-zi";

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda + " " + cale);
  const r = res();
  await h({ user, params: {}, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase() } });
  return r;
}
// Unde trimite redirectul, cu parametrii citiți ca de server (URLSearchParams).
function dupa(r) {
  const loc = String((r.antet && r.antet.Location) || "");
  const u = new URL(loc, "http://erp.test");
  return { cale: u.pathname, ancora: u.hash, ok: u.searchParams.get("costuri_ok"), eroare: u.searchParams.get("costuri_eroare") };
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const ADMIN = { id: 1, nume: "Vali Test", rol: "admin", sectiuni: "" };
const GABI = { id: 98991, nume: "Gabi Test", rol: "achizitii", sectiuni: "/rapoarte/comenzi-la-zi" };
const AGENT = { id: 98992, nume: "Agent Test", rol: "vanzari", sectiuni: "/crm" };

const ZI = "2031-02-10";
const NOMENCLATOR = 98995;
function curata() {
  q(`DELETE FROM consumabile_linii WHERE zi_id IN (SELECT id FROM consumabile_zile WHERE data = '${ZI}')`);
  q(`DELETE FROM consumabile_zile WHERE data = '${ZI}'`);
  q(`DELETE FROM consumabile_produse WHERE cod LIKE 'tst-cst-%'`);
  q(`DELETE FROM produse WHERE id = ${NOMENCLATOR}`);
}
const prod = (cod) => q(`SELECT pret, cost, nota_cost, cost_sursa, aliasuri FROM consumabile_produse WHERE cod = '${cod}'`)[0] || {};
const num = (v) => (v == null ? null : Number(v));

(async () => {
  curata();
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${NOMENCLATOR}, 'TSTCST', 'TST Nomenclator cost', 'buc')`);
  q(`INSERT INTO consumabile_produse (cod, denumire, pret, cost, nota_cost, aliasuri, ordine, activ, produs_id, cost_sursa) VALUES
       ('tst-cst-a', 'TST Cutie A', 1, NULL, NULL, NULL, 991, 1, NULL, NULL),
       ('tst-cst-b', 'TST Cutie B', 2, 1.5, 'oferta veche', NULL, 992, 1, NULL, 'scris de mână'),
       ('tst-cst-c', 'TST Plic scos din listă', 3, 2, 'n', 'x', 993, 0, NULL, 'scris de mână'),
       ('tst-cst-d', 'TST Legat la nomenclator', 4, 0.5, 'din rețetă', NULL, 994, 1, ${NOMENCLATOR}, 'cost producție')`);
  const id = Object.fromEntries(q("SELECT cod, id FROM consumabile_produse WHERE cod LIKE 'tst-cst-%'").map((r) => [r.cod.slice(-1), r.id]));
  const zi = Number(unul(`INSERT INTO consumabile_zile (client, data, sursa) VALUES ('Sameday', '${ZI}', 'manual') RETURNING id`));
  q(`INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret, cost) VALUES (${zi}, ${id.a}, 10, 1, NULL), (${zi}, ${id.b}, 5, 2, 1.5)`);

  // ------------------------------------------------------------------------
  console.log("1. Pagina, văzută de Gabi: costul se scrie, prețul și aliasul doar se văd");
  let pag = await cer("get", CALE, GABI);
  egal("pagina se deschide", pag.cod, 200);
  const form = (pag.corp.match(/<form method="post" action="\/rapoarte\/comenzi-la-zi\/costuri"[\s\S]*?<\/form>/) || [""])[0];
  bine("caseta de cost la produsul nelegat, fără pas de 4 zecimale", new RegExp(`<input name="k_${id.a}" type="number" step="any"`).test(form), form.slice(0, 200));
  bine("prețul și aliasul nu sunt casete pentru ea", !new RegExp(`name="p_${id.a}"`).test(form) && !new RegExp(`name="a_${id.a}"`).test(form));
  bine("…iar pagina spune cine le schimbă", /Prețul de vânzare și aliasurile le schimbă un administrator/.test(form) && /Salvează costurile<\/button>/.test(form));
  bine("produsul legat la nomenclator n-are casetă de cost", !new RegExp(`name="k_${id.d}"`).test(form));
  bine("produsul scos din listă nu e în formular", !form.includes("TST Plic scos din listă"));
  pag = await cer("get", CALE, ADMIN);
  const formA = (pag.corp.match(/<form method="post" action="\/rapoarte\/comenzi-la-zi\/costuri"[\s\S]*?<\/form>/) || [""])[0];
  bine("administratorul are casete pentru preț și alias", new RegExp(`<input name="p_${id.a}" type="number" step="any"`).test(formA) && new RegExp(`name="a_${id.a}"`).test(formA));

  // ------------------------------------------------------------------------
  console.log("\n2. Gabi salvează costul cutiei A");
  let r = await cer("post", `${CALE}/costuri`, GABI, {
    body: {
      [`k_${id.a}`]: "2,5", [`n_${id.a}`]: "factura 123",
      [`p_${id.a}`]: "9", [`a_${id.a}`]: "alias pus de mână",
      [`k_${id.b}`]: "1.5", [`n_${id.b}`]: "oferta veche",
      [`k_${id.d}`]: "0.01",
    },
  });
  const d1 = dupa(r);
  egal("se întoarce la formular", [r.cod, d1.cale, d1.ancora], [302, CALE, "#preturi"]);
  bine("pagina spune ce s-a salvat", /TST Cutie A: cost gol → 2,5 lei/.test(d1.ok || ""), d1.ok);
  bine("…și că a intrat pe rândul fără cost din ziua deja scrisă", /Costul a intrat și pe un rând din zilele deja scrise, care nu avea cost/.test(d1.ok || ""), d1.ok);
  const a1 = prod("tst-cst-a");
  egal("cutia A: cost 2,5 cu nota și cine l-a scris", [num(a1.cost), a1.nota_cost, a1.cost_sursa], [2.5, "factura 123", "scris de mână de Gabi Test"]);
  egal("…prețul și aliasul trimise de ea nu se iau", [num(a1.pret), a1.aliasuri], [1, null]);
  egal("cutia B, netrimisă schimbată, rămâne", [num(prod("tst-cst-b").cost), prod("tst-cst-b").nota_cost], [1.5, "oferta veche"]);
  egal("produsul legat nu ia cost de mână", num(prod("tst-cst-d").cost), 0.5);
  const c1 = prod("tst-cst-c");
  egal("produsul scos din listă rămâne neatins", [num(c1.pret), num(c1.cost), c1.nota_cost, c1.aliasuri], [3, 2, "n", "x"]);
  egal("ziua deja scrisă: rândul fără cost îl primește, cel înghețat rămâne",
    q(`SELECT produs_id, cost FROM consumabile_linii WHERE zi_id = ${zi} ORDER BY produs_id`).map((x) => [Number(x.produs_id), num(x.cost)]),
    [[Number(id.a), 2.5], [Number(id.b), 1.5]]);

  // ------------------------------------------------------------------------
  console.log("\n3. Un cost care nu e număr nu șterge costul vechi");
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.b}`]: "abc", [`n_${id.b}`]: "oferta veche", [`k_${id.a}`]: "-1" } });
  const d2 = dupa(r);
  bine("pagina spune unde n-a intrat", /TST Cutie A/.test(d2.eroare || "") && /TST Cutie B/.test(d2.eroare || ""), d2.eroare);
  egal("costurile vechi rămân", [num(prod("tst-cst-a").cost), num(prod("tst-cst-b").cost)], [2.5, 1.5]);
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.a}`]: "2.5", [`n_${id.a}`]: "factura 123" } });
  egal("fără nimic schimbat, pagina o spune", dupa(r).ok, "Nicio schimbare de salvat.");

  // ------------------------------------------------------------------------
  console.log("\n4. Administratorul: preț, alias și golirea unui cost");
  r = await cer("post", `${CALE}/costuri`, ADMIN, {
    body: {
      [`p_${id.a}`]: "1,25", [`a_${id.a}`]: "Cutie A eticheta", [`k_${id.a}`]: "2.5", [`n_${id.a}`]: "factura 123",
      [`p_${id.b}`]: "2", [`a_${id.b}`]: "", [`k_${id.b}`]: "", [`n_${id.b}`]: "",
    },
  });
  const d3 = dupa(r);
  const a2 = prod("tst-cst-a");
  egal("cutia A: preț 1,25 și alias", [num(a2.pret), a2.aliasuri], [1.25, "Cutie A eticheta"]);
  bine("pagina spune prețul și aliasul schimbate", /TST Cutie A: preț 1 lei → 1,25 lei/.test(d3.ok || "") && /alias „” → „Cutie A eticheta”/.test(d3.ok || ""), d3.ok);
  egal("costul golit de mână e gol, nu zero", [prod("tst-cst-b").cost, prod("tst-cst-b").cost_sursa], [null, null]);
  egal("…dar rândul înghețat din ziua veche își păstrează costul", num(unul(`SELECT cost FROM consumabile_linii WHERE zi_id = ${zi} AND produs_id = ${id.b}`)), 1.5);
  const c2 = prod("tst-cst-c");
  egal("produsul scos din listă tot neatins (nici preț 0, nici alias gol)", [num(c2.pret), num(c2.cost), c2.aliasuri], [3, 2, "x"]);

  // ------------------------------------------------------------------------
  console.log("\n5. Cine n-are raportul nu schimbă nimic și află de ce");
  r = await cer("post", `${CALE}/costuri`, AGENT, { body: { [`k_${id.a}`]: "99" } });
  bine("mesaj de drept, nu tăcere", /N-ai drept/.test(dupa(r).eroare || ""), dupa(r).eroare);
  egal("costul rămâne", num(prod("tst-cst-a").cost), 2.5);
  pag = await cer("get", CALE, GABI, { query: { costuri_ok: "Salvat: TST Cutie A: cost gol → 2,5 lei.", costuri_eroare: "Costul nu e un număr și n-a intrat la: TST Cutie B." } });
  bine("mesajele apar pe pagină, lângă formular", pag.corp.includes('<h2 id="preturi">') && pag.corp.includes("Salvat: TST Cutie A: cost gol → 2,5 lei.") && pag.corp.includes('class="flash flash-rosu" role="alert">Costul nu e un număr'));

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
