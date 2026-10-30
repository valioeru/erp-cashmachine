"use strict";
// Culorile mărfii pe harta depozitului: aceeași marfă (același cod) are aceeași
// culoare pe toate rândurile; fără legendă.
//
// CE A CERUT VALI, 30.10.2026:
//   „Fă aceeași marfă ca și cod cu aceeași culoare peste tot, fără legendă,
//    doar culori diferite; folosește orice culori vrei tu, aleator."
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

const CT = require(path.join(RAD, "modules", "ct-park.js"));
const rute = { get: {}, post: {} };
CT.register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(metoda, cale, params, body) {
  const r = res();
  await rute[metoda][cale]({ user: { id: 1, nume: "Vali", rol: "admin" }, params: params || {}, query: {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const NUMAR = 95;
const MARCAJ = "TEST-CUL palet de test";
function curata() {
  const paleti = q(`SELECT id FROM ct_paleti WHERE observatii = ${lit(MARCAJ)}`).map((r) => Number(r.id));
  if (paleti.length) {
    const l = paleti.join(",");
    q(`DELETE FROM ct_ocupari WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_paleti WHERE id IN (${l})`);
  }
  const r = unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`);
  if (r) {
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_sectoare WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
  q("DELETE FROM produse WHERE cod IN ('TST-CUL-A', 'TST-CUL-B')");
}

(async () => {
  console.log("\n1. Culoarea vine din cod");
  {
    const c = (o) => CT.culoareMarfa(CT.cheieMarfa(o));
    bine("același cod, scris oricum (spații, litere mici) = aceeași culoare", JSON.stringify(c({ produs_cod: "TST-CUL-A" })) === JSON.stringify(c({ produs_cod: "  tst-cul-a " })));
    bine("același cod, altă denumire pe palet = tot aceeași culoare", JSON.stringify(c({ produs_cod: "TST-CUL-A", produs: "x" })) === JSON.stringify(c({ produs_cod: "TST-CUL-A", produs_text: "y" })));
    bine("alt cod = altă culoare", c({ produs_cod: "TST-CUL-A" }).fond !== c({ produs_cod: "TST-CUL-B" }).fond, c({ produs_cod: "TST-CUL-A" }).fond + " / " + c({ produs_cod: "TST-CUL-B" }).fond);
    bine("fără cod: după denumire", JSON.stringify(c({ produs_text: "Folie  liberă" })) === JSON.stringify(c({ produs_text: "folie liberă" })));
    bine("paletul cu mai multe produse e gri dungat", /repeating-linear-gradient/.test(c({ produs_text: "2 produse: A, B" }).fond));
    // Textul din căsuță e negru: fondul trebuie să rămână deschis.
    const lum = [];
    for (let i = 0; i < 300; i++) { const m = c({ produs_cod: "COD" + i }).fond.match(/hsl\(\d+, \d+%, (\d+)%\)/); lum.push(m ? Number(m[1]) : 0); }
    bine("pe 300 de coduri, fondul e mereu deschis (≥ 76%)", lum.every((x) => x >= 76), Math.min(...lum));
    const nuante = new Set();
    for (let i = 0; i < 40; i++) nuante.add(c({ produs_cod: "COD" + i }).fond);
    bine("40 de coduri dau culori diferite", nuante.size >= 38, nuante.size);
  }

  curata();
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR}, 'rand test culori', 3, 2, 3, 800, 1200, 1)`);
  const rand = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`));
  for (let n = 1; n <= 2; n++) for (let c = 1; c <= 3; c++) for (let p = 1; p <= 3; p++)
    q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${rand}, ${n}, ${c}, ${p}, 'R95-0${c}-${n}-${p}', 0)`);
  const loc = (n, c, p) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND nivel=${n} AND camp=${c} AND pozitie=${p}`));
  const pa = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-CUL-A', 'TEST-CUL Folie A', 'kg') RETURNING id")[0].id);
  const pb = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-CUL-B', 'TEST-CUL Bandă B', 'buc') RETURNING id")[0].id);
  const pune = (produsId, text, locuri) => {
    const id = Number(q(`INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, um, categorie, data_intrare, observatii) VALUES ('CTTEST-CUL', ${produsId || "NULL"}, ${lit(text)}, 1, 'kg', 'materie primă', '2026-10-30', ${lit(MARCAJ)}) RETURNING id`)[0].id);
    for (const l of locuri) q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${id}, ${l})`);
    return id;
  };
  const a1 = pune(pa, null, [loc(1, 1, 1)]);
  const a2 = pune(pa, "altă denumire scrisă", [loc(2, 3, 2)]);
  const b1 = pune(pb, null, [loc(1, 2, 1)]);
  const mx = pune(null, "2 produse: TEST-CUL Folie A, TEST-CUL Bandă B", [loc(2, 1, 1)]);

  console.log("\n2. Pe hartă");
  {
    const r = await cer("get", "/stocuri/ct-park/rand/:id", { id: String(rand) });
    bine("harta se deschide", r.cod === 200, r.cod);
    const fond = (id) => ((r.corp.match(new RegExp('href="/stocuri/ct-park/palet/' + id + '"[^>]*style="[^"]*background:([^;"]+)')) || [])[1] || "");
    bine("aceeași marfă pe niveluri și locuri diferite: aceeași culoare", fond(a1) && fond(a1) === fond(a2), fond(a1) + " / " + fond(a2));
    bine("altă marfă: altă culoare", fond(b1) && fond(b1) !== fond(a1), fond(b1));
    bine("paletul mixt: gri dungat", /repeating-linear-gradient/.test(fond(mx)), fond(mx));
    const leg = (r.corp.match(/<p class="ct-legenda2">([\s\S]*?)<\/p>/) || [])[1] || "";
    bine("fără legendă de culori", leg && !/<i style="background/.test(leg) && !/produse finite|materie primă/.test(leg), leg.slice(0, 200));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
