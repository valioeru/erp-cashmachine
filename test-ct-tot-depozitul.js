"use strict";
// „Tot depozitul": toate rândurile, desenate unul sub altul, ca pe pagina
// fiecărui rând, fără „Zone pe categorii".
//
// CE A CERUT VALI, 30.10.2026:
//   „Fă un alt submeniu: tot depozitul, cu totul detaliat, așa cum vezi
//    fiecare rând — fără zone pe categorii sub —, dar toate rândurile vizuale
//    una sub alta."
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
require(path.join(RAD, "modules", "ct-park.js")).register({
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
async function cer(cale, params) {
  const r = res();
  await rute.get[cale]({ user: { id: 1, nume: "Vali", rol: "admin" }, params: params || {}, query: {}, body: {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const NUMERE = [93, 92];
const MARCAJ = "TEST-TOT palet de test";
function curata() {
  const paleti = q(`SELECT id FROM ct_paleti WHERE observatii = ${lit(MARCAJ)}`).map((r) => Number(r.id));
  if (paleti.length) {
    const l = paleti.join(",");
    q(`DELETE FROM ct_ocupari WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_paleti WHERE id IN (${l})`);
  }
  for (const n of NUMERE) {
    const r = unul(`SELECT id FROM ct_randuri WHERE numar = ${n}`);
    if (!r) continue;
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_sectoare WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
  q("DELETE FROM produse WHERE cod = 'TST-TOT-A'");
  q("DELETE FROM ct_culori_marfa WHERE cheie = 'C:TST-TOT-A'");
}

(async () => {
  curata();
  const ids = {};
  for (const n of NUMERE) {
    q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
       VALUES (${n}, 'materie primă', 2, 2, 3, 800, 1200, 1)`);
    ids[n] = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${n}`));
    for (let niv = 1; niv <= 2; niv++)
      for (let c = 1; c <= 2; c++)
        for (let p = 1; p <= 3; p++)
          q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${ids[n]}, ${niv}, ${c}, ${p}, 'R${n}-0${c}-${niv}-${p}', 0)`);
  }
  const loc = (n, niv, c, p) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${ids[n]} AND nivel=${niv} AND camp=${c} AND pozitie=${p}`));
  const pa = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-TOT-A', 'TEST-TOT Folie', 'kg') RETURNING id")[0].id);
  const pune = (locuri) => {
    const id = Number(q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, data_intrare, observatii) VALUES ('CTTEST-TOT', ${pa}, 5, 'kg', '2026-10-30', ${lit(MARCAJ)}) RETURNING id`)[0].id);
    for (const l of locuri) q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${id}, ${l})`);
    return id;
  };
  const a = pune([loc(93, 1, 1, 1)]);
  const b = pune([loc(92, 2, 2, 2), loc(92, 2, 2, 3)]);

  console.log("\n1. Pagina „Tot depozitul”");
  {
    const r = await cer("/stocuri/ct-park/tot");
    bine("se deschide", r.cod === 200, r.cod);
    bine("e în submeniu, și e cea activă", /href="\/stocuri\/ct-park\/tot" class="subnav-link activ">Tot depozitul</.test(r.corp));
    const poz93 = r.corp.indexOf(`id="rand-${ids[93]}"`), poz92 = r.corp.indexOf(`id="rand-${ids[92]}"`);
    bine("toate rândurile, unul sub altul, în ordinea numerelor", poz92 > 0 && poz93 > poz92, poz92 + " / " + poz93);
    bine("fiecare rând duce la pagina lui", r.corp.includes(`href="/stocuri/ct-park/rand/${ids[93]}">Rândul 93<`) && r.corp.includes(`href="/stocuri/ct-park/rand/${ids[92]}">Rândul 92<`));
    bine("fără „Zone pe categorii”", !/Zone pe categorii/.test(r.corp) && !/action="\/stocuri\/ct-park\/rand\/\d+\/zone"/.test(r.corp));
    const fond = (id) => ((r.corp.match(new RegExp('href="/stocuri/ct-park/palet/' + id + '"[^>]*style="[^"]*background:([^;"]+)')) || [])[1] || "");
    bine("aceeași marfă pe rânduri diferite: aceeași culoare", fond(a) && fond(a) === fond(b), fond(a) + " / " + fond(b));
    bine("paletul lat e tot o căsuță dublă", new RegExp('href="/stocuri/ct-park/palet/' + b + '"[^>]*data-latime="2"').test(r.corp));
    bine("un loc liber duce la intrarea de marfă pe locul ăla", r.corp.includes(`href="/stocuri/ct-park/intrare?rand=${ids[93]}&amp;locuri=${loc(93, 1, 1, 2)}"`));
    bine("fără căsuțe de bifat (nu e formular aici)", !/<input type="checkbox" name="loc"/.test(r.corp));
    const m = r.corp.match(/<script type="application\/json" id="ct-info-paleti">([\s\S]*?)<\/script>/);
    let info = {};
    try { info = JSON.parse(m ? m[1] : "{}"); } catch (e) { info = {}; }
    bine("fișa de la mouseover are paleții din toate rândurile", !!info[a] && !!info[b], Object.keys(info).length);
    bine("stilul desenului e același cu al rândului", /\.ct-nivel-campuri \{[^}]*min-width:0;/.test(r.corp) && /pointerover/.test(r.corp));
  }

  console.log("\n2. Pagina rândului arată ca înainte");
  {
    const r = await cer("/stocuri/ct-park/rand/:id", { id: String(ids[93]) });
    bine("se deschide, cu căsuțele de bifat și cu zonele", r.cod === 200 && /<input type="checkbox" name="loc"/.test(r.corp) && /Zone pe categorii/.test(r.corp));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
