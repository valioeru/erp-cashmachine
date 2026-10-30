"use strict";
// Numerotarea câmpurilor pe harta rândului: F și L pentru intervalele în plus
// de la bază, 1…N pentru celelalte, număr peste număr pe toate nivelurile.
//
// CE A CERUT VALI, 30.10.2026 (rândul 1, exterior):
//   „Pe nivelul 2 și 3 sunt doar 10 intervale, acum apar 11 … sau mai bine
//    1 și 12 pui F și L, first și last, și apoi suprapui frumos număr peste
//    număr."
//
// Doar desenul se schimbă: adresele locurilor (R1-02-1-1) rămân pe numărul
// câmpului, ca nimic din ce e deja scris sau tipărit să nu mintă.
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

const NUMAR = 96;
function curata() {
  const r = unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`);
  if (!r) return;
  q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
  q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
  q(`DELETE FROM ct_sectoare WHERE rand_id = ${r}`);
  q(`DELETE FROM ct_randuri WHERE id = ${r}`);
}

(async () => {
  console.log("\n1. Regula, pe forma rândului");
  {
    const et = (niveluri) => [...CT.eticheteCampuri(new Map(niveluri.map((n, i) => [i + 1, n])), niveluri.length).values()].join(",");
    bine("rândul 1: F, 1–10, L", et([1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1]) === "F,1,2,3,4,5,6,7,8,9,10,L", et([1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1]));
    bine("rând la fel peste tot: 1, 2, 3 — ca înainte", et([3, 3, 3]) === "1,2,3");
    bine("doar în față: F, 1, 2", et([1, 3, 3]) === "F,1,2");
    bine("doar în spate: 1, 2, L", et([3, 3, 1]) === "1,2,L");
    bine("două câmpuri scunde la capăt nu fac F (nu e „un interval în plus”)", et([1, 1, 3, 3]) === "1,2,3,4", et([1, 1, 3, 3]));
    bine("un rând de două câmpuri rămâne numerotat", et([1, 3]) === "1,2");
  }

  curata();
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR}, 'rand test etichete', 5, 3, 3, 800, 1200, 1)`);
  const rand = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`));
  await cer("post", "/stocuri/ct-park/rand/:id/editeaza", { id: String(rand) }, { ce: "camp", camp: "1", niveluri: "1", paleti: "1" });
  const ed = await cer("post", "/stocuri/ct-park/rand/:id/editeaza", { id: String(rand) }, { ce: "camp", camp: "5", niveluri: "1", paleti: "2" });

  console.log("\n2. Pe hartă: număr peste număr");
  {
    bine("rândul de test are forma rândului 1 (F + 3 + L)", /"ok":true/.test(ed.corp), ed.corp);
    const r = await cer("get", "/stocuri/ct-park/rand/:id", { id: String(rand) });
    bine("harta se deschide", r.cod === 200, r.cod);
    const peNivel = (n) => {
      const parti = r.corp.split(`<div class="ct-camp" data-nivel="${n}"`).slice(1);
      return parti.map((p) => (p.match(/class="ct-camp-eticheta">([^<]*)</) || [])[1]).join(",");
    };
    bine("jos: F, 1, 2, 3, L", peNivel(1) === "F,1,2,3,L", peNivel(1));
    bine("sus: 1, 2, 3 — aceleași numere, deasupra", peNivel(3) === "1,2,3", peNivel(3));
    bine("rezumatul de sus vorbește la fel", /<strong>F<\/strong> cu 1 nivel × 1 palet, <strong>1–3<\/strong> cu 3 niveluri × 3 paleți, <strong>L<\/strong> cu 1 nivel × 2 paleți/.test(r.corp));
    bine("legenda spune ce sunt F și L și că adresele rămân", /<strong>F<\/strong> și <strong>L<\/strong> sunt intervalele în plus de la bază/.test(r.corp) && /R96-02-1-1/.test(r.corp));
    bine("adresele locurilor rămân pe numărul câmpului", r.corp.includes('data-adresa="R96-01-1-1"') && r.corp.includes('data-adresa="R96-05-1-2"'));
    bine("banda de editare are aceleași etichete", /class="bifa-camp" value="1"> F</.test(r.corp) && /class="bifa-camp" value="2"> 1</.test(r.corp) && /class="bifa-camp" value="5"> L</.test(r.corp));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
