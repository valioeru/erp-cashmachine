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
  q("DELETE FROM produse WHERE cod IN ('TST-CUL-A', 'TST-CUL-B', 'TST-CUL-C')");
  q("DELETE FROM ct_culori_marfa WHERE cheie IN ('C:TST-CUL-A', 'C:TST-CUL-B', 'C:TST-CUL-C')");
}

// OKLab și contrastul WCAG, ca să judec paleta ca ochiul, nu după cifre RGB.
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex3 = (h) => (h.length === 4 ? "#" + h.slice(1).split("").map((x) => x + x).join("") : h);
function oklab(h) {
  const [R, G, B] = rgb(hex3(h)).map(lin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const lum = (h) => { const [r, g, b] = rgb(hex3(h)).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

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

  console.log("\n1b. Paleta: culori cât mai diferite între ele (Vali, 30.10.2026)");
  {
    const P = CT.PALETA_MARFA;
    bine("40 de culori, toate diferite", P.length === 40 && new Set(P.map((c) => c.f)).size === 40);
    const slab = P.filter((c) => contrast(c.f, c.t) < 4.5).map((c) => c.f + "/" + c.t);
    bine("textul se citește pe fiecare (contrast ≥ 4,5)", !slab.length, slab.join(" "));
    const minDist = (n) => { let m = Infinity; for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) { const a = oklab(P[i].f), b = oklab(P[j].f); m = Math.min(m, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); } return m; };
    bine("primele 10 sunt foarte diferite între ele (OKLab ≥ 0,2)", minDist(10) >= 0.2, minDist(10).toFixed(3));
    bine("primele 24 rămân clar diferite (OKLab ≥ 0,12)", minDist(24) >= 0.12, minDist(24).toFixed(3));
    const gri = oklab("#eceff3");
    const aproape = P.filter((c) => { const a = oklab(c.f); return Math.hypot(a[0] - gri[0], a[1] - gri[1], a[2] - gri[2]) < 0.13; });
    bine("niciuna nu seamănă cu griul locului liber", !aproape.length, aproape.map((c) => c.f).join(" "));
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
    const dinPaleta = (f) => CT.PALETA_MARFA.some((c) => c.f === f);
    bine("culorile vin din paleta de culori depărtate", dinPaleta(fond(a1)) && dinPaleta(fond(b1)), fond(a1) + " " + fond(b1));
    bine("cu textul potrivit fondului (negru sau alb)", new RegExp('href="/stocuri/ct-park/palet/' + a1 + '"[^>]*style="[^"]*;color:#(111|fff)"').test(r.corp));
    const memorate = q("SELECT cheie, idx FROM ct_culori_marfa WHERE cheie IN ('C:TST-CUL-A', 'C:TST-CUL-B')");
    bine("culoarea fiecărei mărfi e ținută minte", memorate.length === 2, JSON.stringify(memorate));

    // Marfă nouă în depozit: ia o culoare liberă, iar celelalte rămân cum erau.
    const pc = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-CUL-C', 'TEST-CUL Cutie C', 'buc') RETURNING id")[0].id);
    const c1 = pune(pc, null, [loc(1, 3, 1)]);
    const r2 = await cer("get", "/stocuri/ct-park/rand/:id", { id: String(rand) });
    const fond2 = (id) => ((r2.corp.match(new RegExp('href="/stocuri/ct-park/palet/' + id + '"[^>]*style="[^"]*background:([^;"]+)')) || [])[1] || "");
    bine("după o marfă nouă, A și B își păstrează culorile", fond2(a1) === fond(a1) && fond2(b1) === fond(b1), fond2(a1) + " " + fond2(b1));
    bine("marfa nouă are altă culoare decât A și B", dinPaleta(fond2(c1)) && fond2(c1) !== fond2(a1) && fond2(c1) !== fond2(b1), fond2(c1));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
