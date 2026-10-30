"use strict";
// Câte locuri ține un palet din raft: extinde la locul de lângă (unul sau
// două) sau eliberează, fără să scoți și să repui paletul.
//
// CE A CERUT VALI, 30.10.2026:
//   „Vreau să pot modifica o marfă pusă inițial să ocupe doar un spațiu, să
//    poată ocupa două sau trei, ca să nu o scot să o repun iar." ·
//   „Extinde la spațiul de lângă, unul sau două."
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

const CTM = require(path.join(RAD, "lib", "ct-mutare.js"));
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
async function cer(metoda, cale, params, body) {
  const r = res();
  await rute[metoda][cale]({ user: { id: 1, nume: "Vali", rol: "admin" }, params: params || {}, query: {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => decodeURIComponent(String((r.antet && (r.antet.Location || r.antet.location)) || ""));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const NUMAR = 94;
const MARCAJ = "TEST-LAT palet de test";
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
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
}

(async () => {
  console.log("\n1. Regula (pură)");
  {
    const L = (id, poz, extra) => Object.assign({ id, rand_id: 1, nivel: 2, camp: 5, pozitie: poz, adresa: "R1-05-2-" + poz, blocat: 0, ocupat_de: null }, extra || {});
    const camp = (ocupari) => [1, 2, 3].map((p) => L(p, p, ocupari[p] || {}));
    const P = { id: 77, nume: "Folie" };
    const ad = (pl) => (pl.locuri || []).map((l) => l.pozitie).join(",");
    let pl = CTM.planLatime(P, [L(1, 1, { ocupat_de: 77 })], camp({ 1: { ocupat_de: 77 } }), 2, "");
    bine("1 → 2: ia locul din dreapta", pl.ok && ad(pl) === "1,2" && pl.adaugate.length === 1 && pl.adaugate[0].pozitie === 2, JSON.stringify(pl));
    pl = CTM.planLatime(P, [L(3, 3)], camp({ 3: { ocupat_de: 77 } }), 2, "");
    bine("la capătul câmpului: se întinde spre stânga", pl.ok && ad(pl) === "2,3", JSON.stringify(pl));
    pl = CTM.planLatime(P, [L(3, 3)], camp({ 3: { ocupat_de: 77 } }), 2, "dreapta");
    bine("cerut „dreapta” la capăt: refuzat, cu motiv", !pl.ok && /câmpul n-are poziția 4/.test(pl.motiv), pl.motiv);
    pl = CTM.planLatime(P, [L(2, 2)], camp({ 2: { ocupat_de: 77 }, 3: { ocupat_de: 99 } }), 2, "");
    bine("dreapta ocupată de altă marfă: ia stânga", pl.ok && ad(pl) === "1,2", JSON.stringify(pl));
    pl = CTM.planLatime(P, [L(2, 2)], camp({ 1: { blocat: 1 }, 2: { ocupat_de: 77 }, 3: { ocupat_de: 99 } }), 2, "");
    bine("nicăieri loc: refuzat, spune de ce", !pl.ok && /altă marfă/.test(pl.motiv) && /scos din uz/.test(pl.motiv), pl.motiv);
    pl = CTM.planLatime(P, [L(2, 2)], camp({ 2: { ocupat_de: 77 } }), 3, "");
    bine("1 → 3 din mijloc: ambele vecine", pl.ok && ad(pl) === "1,2,3" && pl.adaugate.length === 2, JSON.stringify(pl));
    const trei = [L(1, 1), L(2, 2), L(3, 3)];
    pl = CTM.planLatime(P, trei, camp({}), 1, "");
    bine("3 → 1: eliberează dreapta, ține primul loc", pl.ok && ad(pl) === "1" && pl.scoase.length === 2, JSON.stringify(pl));
    pl = CTM.planLatime(P, trei, camp({}), 2, "stanga");
    bine("3 → 2, „stânga”: eliberează locul din stânga", pl.ok && ad(pl) === "2,3", JSON.stringify(pl));
    bine("același număr: nimic de schimbat", !CTM.planLatime(P, trei, camp({}), 3, "").ok);
    bine("4 locuri: refuzat", !CTM.planLatime(P, [L(1, 1)], camp({}), 4, "").ok);
    bine("locuri nelipite: refuzat", !CTM.planLatime(P, [L(1, 1), L(3, 3)], camp({}), 2, "").ok);
  }

  curata();
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR}, 'rand test latime', 2, 1, 3, 800, 1200, 1)`);
  const rand = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`));
  for (let c = 1; c <= 2; c++)
    for (let p = 1; p <= 3; p++)
      q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${rand}, 1, ${c}, ${p}, 'R94-0${c}-1-${p}', 0)`);
  const loc = (c, p) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND camp=${c} AND pozitie=${p}`));
  const pune = (text, locuri) => {
    const id = Number(
      q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, um, data_intrare, observatii)
         VALUES ('CTTEST-LAT', ${lit(text)}, 1, 'buc', '2026-10-30', ${lit(MARCAJ)}) RETURNING id`)[0].id
    );
    for (const l of locuri) q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${id}, ${l})`);
    return id;
  };
  const P = pune("TEST-LAT cutii", [loc(1, 1)]);
  pune("TEST-LAT vecin", [loc(1, 3)]);
  const ale = (id) =>
    q(`SELECT l.pozitie FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id WHERE o.palet_id = ${id} ORDER BY l.pozitie`)
      .map((r) => Number(r.pozitie))
      .join(",");

  console.log("\n2. Pe pagina paletului");
  {
    const g = await cer("get", "/stocuri/ct-park/palet/:id", { id: String(P) });
    bine("butoanele 1 / 2 / 3 locuri, cel de acum dezactivat", g.cod === 200 && /name="cate" value="1" class="btn small" disabled/.test(g.corp) && /name="cate" value="2" class="btn small secondary"/.test(g.corp), g.cod);
    let r = await cer("post", "/stocuri/ct-park/palet/:id/latime", { id: String(P) }, { cate: "2" });
    bine("extins pe locul de lângă: pozițiile 1, 2", ale(P) === "1,2", ale(P));
    bine("mesajul spune unde și cere eticheta nouă", /s-a extins pe R94-01-1-2/.test(locatie(r)) && /Retipărește eticheta/.test(locatie(r)), locatie(r));
    r = await cer("post", "/stocuri/ct-park/palet/:id/latime", { id: String(P) }, { cate: "3" });
    bine("al treilea loc e al vecinului: refuzat, nimic schimbat", /eroare=/.test(locatie(r)) && /altă marfă/.test(locatie(r)) && ale(P) === "1,2", locatie(r));
    r = await cer("post", "/stocuri/ct-park/palet/:id/latime", { id: String(P) }, { cate: "1" });
    bine("înapoi pe un loc: eliberează R94-01-1-2", ale(P) === "1" && /a eliberat R94-01-1-2/.test(locatie(r)), locatie(r));
    q(`UPDATE ct_paleti SET data_iesire = '2026-10-30' WHERE id = ${P}`);
    r = await cer("post", "/stocuri/ct-park/palet/:id/latime", { id: String(P) }, { cate: "2" });
    bine("pe un palet ieșit: refuzat", /eroare=Paletul a ieșit/.test(locatie(r)), locatie(r));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
