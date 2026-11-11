"use strict";
// „Prețuri, aliasuri și costuri manuale" din raportul Comenzi Sameday.
//
// Vali, 09.11.2026: „În pagina de comenzi noi Sameday nu salvează costurile
// noi la anumite produse." Gabi (Achiziții, cu raportul Sameday) a apăsat de
// trei ori „Salvează" pe costurile cutiilor și plicurilor antișoc. Salvarea
// era doar a administratorului și se întorcea pe pagină fără niciun cuvânt.
//
// Apoi, întrebat de prețuri: „da, să poată schimba, după regula de acum: se
// modifică doar de la ziua salvării înainte."
//
// Ce apără:
//   • PREȚUL, COSTUL MANUAL, NOTA ȘI ALIASURILE le salvează oricine are
//     raportul, nu doar administratorul.
//   • REGULA DE ACUM: prețul nou intră pe zilele scrise de acum înainte; ziua
//     deja scrisă își păstrează prețul înghețat pe rânduri.
//   • CE NU E ÎN FORMULAR NU SE ATINGE: produsele scoase din listă (activ = 0)
//     nu mai primesc preț 0 și cost gol la fiecare salvare.
//   • UN COST CARE NU E NUMĂR NU ȘTERGE COSTUL VECHI și pagina spune unde.
//   • COSTUL SCRIS DE MÂNĂ ARE ÎNTÂIETATE, și la produsul legat la nomenclator
//     (11.11.2026): legarea nu-l șterge, recalculul nu-l înlocuiește, iar golit
//     lasă locul celui automat. Până atunci legarea l-ar fi înlocuit pe tot ce
//     era scris de mână — de-aia nu s-a legat nimic, iar fără legături comanda
//     zilei nu se putea face.
//   • LEGAREA atinge doar ce e în formular și scrie în jurnal cine a legat ce.
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

const ZI = "2031-02-10", ZI2 = "2031-02-11";
const NOMENCLATOR = 98995;
function curata() {
  q(`DELETE FROM consumabile_linii WHERE zi_id IN (SELECT id FROM consumabile_zile WHERE data IN ('${ZI}', '${ZI2}'))`);
  q(`DELETE FROM consumabile_zile WHERE data IN ('${ZI}', '${ZI2}')`);
  q(`DELETE FROM consumabile_produse WHERE cod LIKE 'tst-cst-%'`);
  q(`DELETE FROM produse WHERE id = ${NOMENCLATOR}`);
}
const prod = (cod) => q(`SELECT pret, cost, nota_cost, cost_sursa, aliasuri FROM consumabile_produse WHERE cod = '${cod}'`)[0] || {};
const num = (v) => (v == null ? null : Number(v));

(async () => {
  curata();
  // Ziua scrisă de mână ține minte cine a scris-o: oamenii testului trebuie să existe.
  const uid = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  ADMIN.id = uid; GABI.id = uid; AGENT.id = uid;
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
  console.log("1. Pagina, văzută de Gabi: prețul, costul și aliasul se scriu");
  let pag = await cer("get", CALE, GABI);
  egal("pagina se deschide", pag.cod, 200);
  const form = (pag.corp.match(/<form method="post" action="\/rapoarte\/comenzi-la-zi\/costuri"[\s\S]*?<\/form>/) || [""])[0];
  bine("caseta de cost la produsul nelegat, fără pas de 4 zecimale", new RegExp(`<input name="k_${id.a}" type="number" step="any"`).test(form), form.slice(0, 200));
  bine("are casete și pentru preț și alias", new RegExp(`<input name="p_${id.a}" type="number" step="any"`).test(form) && new RegExp(`name="a_${id.a}"`).test(form));
  bine("…și butonul le salvează pe toate", /Salvează prețurile, costurile manuale și aliasurile<\/button>/.test(form));
  bine("produsul legat la nomenclator are și el casetă de cost, cu costul automat în ea", new RegExp(`<input name="k_${id.d}" type="number" step="any" min="0" value="0.5"`).test(form), form.slice(-900));
  bine("…lângă care scrie că e automat și de unde vine", /class="sursa-cost"[^>]*>automat, din nomenclator: cost producție — scrie alt cost dacă nu e cel bun</.test(form));
  bine("…fără casetă de notă: nota e a costului scris de mână", !new RegExp(`name="n_${id.d}"`).test(form));
  bine("produsul scos din listă nu e în formular", !form.includes("TST Plic scos din listă"));
  pag = await cer("get", CALE, ADMIN);
  const formA = (pag.corp.match(/<form method="post" action="\/rapoarte\/comenzi-la-zi\/costuri"[\s\S]*?<\/form>/) || [""])[0];
  bine("administratorul are casete pentru preț și alias", new RegExp(`<input name="p_${id.a}" type="number" step="any"`).test(formA) && new RegExp(`name="a_${id.a}"`).test(formA));

  // ------------------------------------------------------------------------
  console.log("\n2. Gabi salvează prețul, costul și aliasul cutiei A");
  let r = await cer("post", `${CALE}/costuri`, GABI, {
    body: {
      [`k_${id.a}`]: "2,5", [`n_${id.a}`]: "factura 123",
      [`p_${id.a}`]: "1,40", [`a_${id.a}`]: "Cutie A eticheta",
      [`k_${id.b}`]: "1.5", [`n_${id.b}`]: "oferta veche",
    },
  });
  const d1 = dupa(r);
  egal("se întoarce la formular", [r.cod, d1.cale, d1.ancora], [302, CALE, "#preturi"]);
  bine("pagina spune ce s-a salvat", /TST Cutie A: preț 1 lei → 1,4 lei/.test(d1.ok || "") && /TST Cutie A: alias „” → „Cutie A eticheta”/.test(d1.ok || "") && /TST Cutie A: cost gol → 2,5 lei/.test(d1.ok || ""), d1.ok);
  bine("…și că a intrat pe rândul fără cost din ziua deja scrisă", /Costul a intrat și pe un rând din zilele deja scrise, care nu avea cost/.test(d1.ok || ""), d1.ok);
  const a1 = prod("tst-cst-a");
  egal("cutia A: cost 2,5 cu nota și cine l-a scris", [num(a1.cost), a1.nota_cost, a1.cost_sursa], [2.5, "factura 123", "scris de mână de Gabi Test"]);
  egal("…și prețul 1,40 cu aliasul", [num(a1.pret), a1.aliasuri], [1.4, "Cutie A eticheta"]);
  egal("regula de acum: ziua deja scrisă își păstrează prețul vechi", num(unul(`SELECT pret FROM consumabile_linii WHERE zi_id = ${zi} AND produs_id = ${id.a}`)), 1);
  r = await cer("post", `${CALE}/zi`, GABI, { body: { data: ZI2, [`c_${id.a}`]: "3" } });
  egal("…iar ziua scrisă după salvare ia prețul și costul noi",
    q(`SELECT l.pret, l.cost FROM consumabile_linii l JOIN consumabile_zile z ON z.id = l.zi_id WHERE z.data = '${ZI2}' AND l.produs_id = ${id.a}`).map((x) => [num(x.pret), num(x.cost)]),
    [[1.4, 2.5]]);
  egal("cutia B, netrimisă schimbată, rămâne", [num(prod("tst-cst-b").cost), prod("tst-cst-b").nota_cost], [1.5, "oferta veche"]);
  egal("produsul legat, netrimis, rămâne cu costul automat", [num(prod("tst-cst-d").cost), prod("tst-cst-d").cost_sursa], [0.5, "cost producție"]);
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
  bine("pagina spune prețul schimbat", /TST Cutie A: preț 1,4 lei → 1,25 lei/.test(d3.ok || "") && !/alias/.test(d3.ok || ""), d3.ok);
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

  // ------------------------------------------------------------------------
  console.log("\n6. Produsul legat la nomenclator: costul scris de mână are întâietate");
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.d}`]: "0.5" } });
  egal("caseta neatinsă nu face din costul automat unul de mână", [dupa(r).ok, num(prod("tst-cst-d").cost), prod("tst-cst-d").cost_sursa], ["Nicio schimbare de salvat.", 0.5, "cost producție"]);
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.d}`]: "" } });
  egal("caseta golită la un cost automat nu schimbă nimic", [dupa(r).ok, num(prod("tst-cst-d").cost), prod("tst-cst-d").cost_sursa], ["Nicio schimbare de salvat.", 0.5, "cost producție"]);
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.d}`]: "abc" } });
  bine("un cost care nu e număr e refuzat și la produsul legat", /TST Legat la nomenclator/.test(dupa(r).eroare || "") && num(prod("tst-cst-d").cost) === 0.5, dupa(r).eroare);
  // Nomenclatorul are un cost plauzibil (0,40 la preț 4): tocmai ăsta l-ar fi înlocuit pe cel scris de om.
  q(`UPDATE produse SET pret_achizitie = 0.4 WHERE id = ${NOMENCLATOR}`);
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.d}`]: "0,45" } });
  const d6 = prod("tst-cst-d");
  egal("costul scris de mână intră și la produsul legat, cu cine l-a scris", [num(d6.cost), d6.cost_sursa], [0.45, "scris de mână de Gabi Test"]);
  egal("…fără nota rămasă de la costul automat", d6.nota_cost, null);
  bine("pagina spune schimbarea", /TST Legat la nomenclator: cost 0,5 lei → 0,45 lei/.test(dupa(r).ok || ""), dupa(r).ok);
  const rc = await mod.recalculeazaCosturi();
  egal("recalculul din nomenclator nu-l înlocuiește", [num(prod("tst-cst-d").cost), prod("tst-cst-d").cost_sursa], [0.45, "scris de mână de Gabi Test"]);
  const dRc = (rc.detalii || []).find((x) => x.denumire === "TST Legat la nomenclator") || {};
  egal("…și îl numără ca produs cu cost, scris de mână", [dRc.cost, dRc.manual], [0.45, true]);
  egal("…fiecare produs legat e numărat o dată: cu cost sau fără", rc.cu_cost + rc.fara_cost, rc.produse);
  pag = await cer("get", CALE, GABI);
  if (process.env.SALVEAZA_PAGINI) require("fs").writeFileSync(path.join(process.env.SALVEAZA_PAGINI, "comenzi-zi-costuri.html"), pag.corp);
  bine("formularul spune că e al omului și cum revine cel automat", /class="sursa-cost"[^>]*>scris de mână de Gabi Test — rămâne al tău; golește caseta ca să revină costul din nomenclator</.test(pag.corp));
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.d}`]: "0.45" } });
  egal("costul de mână trimis neschimbat rămâne al omului", [dupa(r).ok, num(prod("tst-cst-d").cost), prod("tst-cst-d").cost_sursa], ["Nicio schimbare de salvat.", 0.45, "scris de mână de Gabi Test"]);
  r = await cer("post", `${CALE}/costuri`, GABI, { body: { [`k_${id.d}`]: "" } });
  const d7 = prod("tst-cst-d");
  egal("golit, lasă locul celui din nomenclator, pe loc", [num(d7.cost), d7.cost_sursa], [0.4, "preț de achiziție de pe produs"]);
  bine("…și pagina spune că a revenit cel din nomenclator", /TST Legat la nomenclator: cost 0,45 lei → cel din nomenclator/.test(dupa(r).ok || ""), dupa(r).ok);
  const E = mod.__test.eCostManual;
  egal("ce e cost scris de mână: cel cu numele omului, cel vechi fără sursă; nu cel automat, nu cel gol",
    [E({ cost: 1, cost_sursa: "scris de mână de Gabi" }), E({ cost: 1, cost_sursa: "scris de mână" }), E({ cost: 1, cost_sursa: null }),
     E({ cost: 1, cost_sursa: "cost producție (rețeta produsului)" }), E({ cost: 1, cost_sursa: "intrare de marfă din 01.11.2026" }),
     E({ cost: 1, cost_sursa: "preț de achiziție de pe produs" }), E({ cost: null, cost_sursa: "scris de mână" }), E({ cost: 0, cost_sursa: "scris de mână" }), E(null)],
    [true, true, true, false, false, false, false, true, false]);

  // ------------------------------------------------------------------------
  console.log("\n7. Legarea la nomenclator nu șterge costul scris de mână");
  q(`INSERT INTO consumabile_produse (cod, denumire, pret, cost, ordine, activ) VALUES ('tst-cst-e', 'TST Cost vechi fără sursă', 2, 0.7, 995, 1)`);
  const idE = unul("SELECT id FROM consumabile_produse WHERE cod = 'tst-cst-e'");
  // Produsul scos din listă e legat, dar formularul nu-l arată: câmpul lui nu vine.
  q(`UPDATE consumabile_produse SET produs_id = ${NOMENCLATOR} WHERE cod = 'tst-cst-c'`);
  // Legăturile celorlalte produse din bază se trimit neschimbate, ca din formular.
  const legate = Object.fromEntries(q("SELECT id, produs_id FROM consumabile_produse WHERE produs_id IS NOT NULL AND activ = 1").map((x) => [`l_${x.id}`, String(x.produs_id)]));
  const jurnal = [];
  const scrie = console.log;
  console.log = (...a) => { jurnal.push(a.join(" ")); };
  let rl;
  try {
    rl = await cer("post", `${CALE}/legare`, ADMIN, { body: { ...legate, [`l_${id.a}`]: String(NOMENCLATOR), [`l_${id.b}`]: String(NOMENCLATOR), [`l_${idE}`]: String(NOMENCLATOR) } });
  } finally { console.log = scrie; }
  egal("legarea se întoarce la formularul ei", [rl.cod, String(rl.antet.Location)], [302, `${CALE}?legare=1`]);
  egal("cele trei sunt legate", q(`SELECT produs_id FROM consumabile_produse WHERE cod IN ('tst-cst-a','tst-cst-b','tst-cst-e') ORDER BY cod`).map((x) => Number(x.produs_id)), [NOMENCLATOR, NOMENCLATOR, NOMENCLATOR]);
  egal("cutia A, cu costul scris de Gabi: rămâne al ei, nu cel din nomenclator", [num(prod("tst-cst-a").cost), prod("tst-cst-a").cost_sursa, prod("tst-cst-a").nota_cost], [2.5, "scris de mână de Gabi Test", "factura 123"]);
  egal("costul vechi, salvat fără sursă, e tot al omului și rămâne", [num(prod("tst-cst-e").cost), prod("tst-cst-e").cost_sursa], [0.7, null]);
  egal("cutia B, fără cost, îl primește pe cel din nomenclator", [num(prod("tst-cst-b").cost), prod("tst-cst-b").cost_sursa], [0.4, "preț de achiziție de pe produs"]);
  egal("produsul scos din listă, netrimis în formular, nu se dezleagă", [Number(unul(`SELECT produs_id FROM consumabile_produse WHERE cod = 'tst-cst-c'`)), num(prod("tst-cst-c").cost)], [NOMENCLATOR, 2]);
  const linieJurnal = jurnal.find((x) => /a schimbat legăturile la nomenclator/.test(x)) || "";
  bine("jurnalul spune cine a legat ce", /Vali Test a schimbat legăturile la nomenclator: /.test(linieJurnal) && linieJurnal.includes(`TST Cutie A: nelegat → #${NOMENCLATOR}`) && linieJurnal.includes(`TST Cutie B: nelegat → #${NOMENCLATOR}`), linieJurnal);
  bine("…doar ce s-a schimbat (produsul deja legat nu apare)", !linieJurnal.includes("TST Legat la nomenclator"), linieJurnal);
  // Dezlegarea se face tot din formular, cu câmpul trimis gol.
  jurnal.length = 0;
  console.log = (...a) => { jurnal.push(a.join(" ")); };
  try {
    await cer("post", `${CALE}/legare`, ADMIN, { body: { ...legate, [`l_${id.a}`]: String(NOMENCLATOR), [`l_${id.b}`]: "", [`l_${idE}`]: String(NOMENCLATOR) } });
  } finally { console.log = scrie; }
  egal("câmpul trimis gol dezleagă produsul", unul(`SELECT produs_id FROM consumabile_produse WHERE cod = 'tst-cst-b'`), null);
  bine("…și jurnalul o spune", jurnal.some((x) => x.includes(`TST Cutie B: #${NOMENCLATOR} → nelegat`)) && !jurnal.some((x) => x.includes("TST Cutie A:")), jurnal.join(" | ").slice(0, 300));
  rl = await cer("post", `${CALE}/legare`, GABI, { body: { [`l_${id.a}`]: "" } });
  egal("legăturile rămân ale administratorului", [rl.cod, Number(unul(`SELECT produs_id FROM consumabile_produse WHERE cod = 'tst-cst-a'`))], [302, NOMENCLATOR]);
  pag = await cer("get", CALE, ADMIN);
  bine("pagina spune la ce folosește legătura și că ce e scris de mână rămâne", /ce produs din nomenclator intră pe comanda zilei/.test(pag.corp) && /Costul scris de mână rămâne neatins/.test(pag.corp));

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
