"use strict";
// Test pentru inventarul fizic și pentru vechimea stocului.
//
// Ce apără, în ordinea în care doare dacă se strică:
//   • NENUMĂRAT NU E ZERO. Dacă un inventar oprit la jumătate ar trata
//     câmpurile goale drept zero, ar șterge stocul tuturor produselor la care
//     nu s-a ajuns — și ar arăta ca o corecție legitimă;
//   • scripticul e FOTOGRAFIAT la deschidere, nu citit la aplicare. Altfel o
//     intrare făcută între timp apare ca diferență și „corectăm” o cifră bună;
//   • plusurile și minusurile NU se amestecă: 10.000 lipsă și 10.000 în plus
//     nu e un depozit în regulă, sunt două probleme;
//   • aplicarea se poate desface, exact, fără să atingă alte mișcări;
//   • „12,5” e o cantitate. Respins tăcut ca gol, ar lăsa produsul nenumărat.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

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

const mod = require(path.join(RAD, "modules", "inventar.js"));
const rute = { get: {}, post: {} };
mod.register({
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
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const GABI = { id: 3, nume: "Gabriela", rol: "vanzari" };
async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
const { SUB_STOC } = require(path.join(RAD, "lib", "stoc.js"));
const stocul = () =>
  q(`SELECT s.produs_id, s.stoc FROM ${SUB_STOC} s WHERE s.depozit_id = 96801 AND s.stoc <> 0 ORDER BY s.produs_id`)
    .map((x) => x.produs_id + ":" + Number(x.stoc));

(async () => {
  for (const s of [
    `CREATE TABLE IF NOT EXISTS inventare (
       id SERIAL PRIMARY KEY, depozit_id INTEGER NOT NULL REFERENCES depozite(id), nume TEXT,
       stare TEXT NOT NULL DEFAULT 'deschis', deschis_de INTEGER, deschis_la TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
       aplicat_de INTEGER, aplicat_la TEXT, desfacut_de INTEGER, desfacut_la TEXT, observatii TEXT)`,
    `CREATE TABLE IF NOT EXISTS inventare_linii (
       id SERIAL PRIMARY KEY, inventar_id INTEGER NOT NULL REFERENCES inventare(id),
       produs_id INTEGER NOT NULL REFERENCES produse(id), scriptic REAL NOT NULL DEFAULT 0, numarat REAL,
       pret_intrare REAL, pret_din TEXT, numarat_de INTEGER, numarat_la TEXT, observatii TEXT)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_inventare_linii_unic ON inventare_linii (inventar_id, produs_id)",
    "DELETE FROM inventare_linii WHERE inventar_id IN (SELECT id FROM inventare WHERE depozit_id = 96801)",
    "DELETE FROM inventare WHERE depozit_id = 96801",
    "DELETE FROM miscari_stoc WHERE depozit_id = 96801",
    "DELETE FROM produse WHERE id BETWEEN 96811 AND 96819",
    "DELETE FROM depozite WHERE id = 96801",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO depozite (id, denumire, locatie) VALUES (96801,'DEPOZIT TEST INV','test')",
    `INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie) VALUES
       (96811,'INV-A','Folie stretch inventar','rola',9),
       (96812,'INV-B','Banda adeziva inventar','buc',5),
       (96813,'INV-C','Produs cu stoc zero','buc',3)`,
    // 96811: intrare veche 100 @ 10, ieșire 40, intrare nouă 50 @ 12 → stoc 110
    `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, data) VALUES
       (96811,96801,'intrare',100,10,'2025-01-10 08:00:00'),
       (96811,96801,'iesire',40,NULL,'2025-06-01 08:00:00'),
       (96811,96801,'intrare',50,12,'2026-03-01 08:00:00'),
       (96812,96801,'intrare',20,5,'2026-08-01 08:00:00'),
       (96813,96801,'intrare',10,3,'2026-02-01 08:00:00'),
       (96813,96801,'iesire',10,NULL,'2026-02-15 08:00:00')`,
  ]) exec(s);

  egal("stocul de pornire", stocul(), ["96811:110", "96812:20"]);

  // --- cantitatea scrisă de om ------------------------------------------------
  egal("„12,5” e o cantitate, nu un gol", mod.cantitate("12,5"), 12.5);
  egal("gol rămâne gol", mod.cantitate(""), null);
  egal("un text nu e cantitate", mod.cantitate("cinci"), null);
  egal("zero e zero, nu gol", mod.cantitate("0"), 0);

  // --- deschiderea ------------------------------------------------------------
  const inv = await mod.deschide({ depozitId: 96801, nume: "Inventar de test", user: VALI });
  const linii = await mod.liniile(inv.id);
  egal("intră doar produsele cu stoc, cu scripticul fotografiat",
    linii.map((l) => l.cod + ":" + Number(l.scriptic)).sort(), ["INV-A:110", "INV-B:20"]);
  egal("prețul vine de la ultima intrare, nu de pe fișă",
    linii.filter((l) => l.cod === "INV-A").map((l) => Number(l.pret_intrare)), [12]);
  if (!linii.find((l) => l.cod === "INV-A").pret_din.includes("ultima intrare"))
    rau("nu spune de unde vine prețul");
  else ok("pagina poate spune de unde vine prețul — „" + linii.find((l) => l.cod === "INV-A").pret_din + "”");

  // O intrare făcută DUPĂ deschidere nu are voie să apară ca diferență.
  exec(
    "INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, data) VALUES (96811,96801,'intrare',7,12,'2026-09-20 08:00:00')"
  );
  const liniiDupa = await mod.liniile(inv.id);
  egal("scripticul rămâne cel fotografiat, chiar dacă a mai intrat marfă",
    liniiDupa.filter((l) => l.cod === "INV-A").map((l) => Number(l.scriptic)), [110]);

  // --- numărătoarea -----------------------------------------------------------
  await cer("/depozit/inventar/:id/salveaza", {
    metoda: "post", params: { id: String(inv.id) },
    body: { ["c_96811"]: "105", ["c_96812"]: "" },
  });
  const dupaSalvare = await mod.liniile(inv.id);
  const s1 = mod.sumar(dupaSalvare);
  egal("s-a numărat doar ce s-a scris", [s1.numarate, s1.nenumarate], [1, 1]);
  egal("lipsa e văzută ca lipsă, nu ca plus", [s1.plus, s1.minus], [0, 1]);
  egal("valoarea lipsei e la preț de intrare (5 buc × 12 lei)", Math.round(s1.valMinus), 60);
  egal("plusurile și minusurile nu se amestecă în aceeași cifră",
    [Math.round(s1.valPlus), Math.round(s1.valNet)], [0, -60]);

  // --- aplicarea ---------------------------------------------------------------
  const inainteDeAplicare = stocul();
  let r = await cer("/depozit/inventar/:id/aplica", { user: GABI, metoda: "post", params: { id: String(inv.id) } });
  egal("un agent de vânzări nu aplică inventarul", stocul(), inainteDeAplicare);

  r = await cer("/depozit/inventar/:id/aplica", { metoda: "post", params: { id: String(inv.id) } });
  egal("stocul numărat intră, cel nenumărat rămâne neatins", stocul(), ["96811:105", "96812:20"]);
  egal("s-a scris o singură mișcare de inventar, cu urma ei",
    q("SELECT COUNT(*) AS n FROM miscari_stoc WHERE tip = 'inventar' AND document_ref = ?", ["inventar:" + inv.id]).map((x) => Number(x.n)),
    [1]);
  egal("inventarul e marcat aplicat",
    q("SELECT stare FROM inventare WHERE id = ?", [inv.id]).map((x) => x.stare), ["aplicat"]);

  // --- vechimea, după inventar ---------------------------------------------------
  const vechimeDupa = await mod.vechimeStoc(96801);
  const a = vechimeDupa.find((x) => x.cod === "INV-A");
  if (!a.dinInventar) rau("după inventar, vechimea nu spune că firul a fost rupt");
  else ok("după inventar, cea mai veche bucată e marcată „din inventar”");

  // --- desfacerea -----------------------------------------------------------------
  r = await cer("/depozit/inventar/:id/desfa", { user: GABI, metoda: "post", params: { id: String(inv.id) } });
  egal("un agent nu desface inventarul", stocul(), ["96811:105", "96812:20"]);

  r = await cer("/depozit/inventar/:id/desfa", { metoda: "post", params: { id: String(inv.id) } });
  egal("stocul se întoarce exact cum era", stocul(), ["96811:117", "96812:20"]);
  egal("mișcările inventarului au dispărut, nimic altceva",
    [
      Number(q("SELECT COUNT(*) AS n FROM miscari_stoc WHERE tip = 'inventar' AND depozit_id = 96801")[0].n),
      Number(q("SELECT COUNT(*) AS n FROM miscari_stoc WHERE depozit_id = 96801")[0].n),
    ],
    [0, 7]);

  // --- vechimea, fără inventar -------------------------------------------------
  const vechime = await mod.vechimeStoc(96801);
  const va = vechime.find((x) => x.cod === "INV-A");
  const vb = vechime.find((x) => x.cod === "INV-B");
  egal("cea mai veche bucată de pe stoc e din prima intrare, nu din ultima", va.data, "2025-01-10");
  egal("iar din ea au mai rămas 60 după ieșirea de 40", Math.round(va.cantVeche), 60);
  egal("un produs cu o singură intrare are vechimea ei", vb.data, "2026-08-01");
  egal("produsul cu stoc zero nu apare deloc", vechime.map((x) => x.cod).sort(), ["INV-A", "INV-B"]);
  egal("lista e ordonată cu cele mai vechi întâi", vechime[0].cod, "INV-A");

  // --- paginile -------------------------------------------------------------------
  for (const [cale, params] of [["/depozit/inventar", {}], ["/depozit/inventar/vechime", {}], ["/depozit/inventar/:id", { id: String(inv.id) }]]) {
    const p = await cer(cale, { params, query: cale.includes("vechime") ? { depozit: "96801" } : {} });
    const fara = p.corp.replace(/<script[\s\S]*?<\/script>/g, "");
    if (p.cod !== 200) rau("pagina " + cale + " nu se deschide", String(p.cod));
    else if (/NaN|Infinity|undefined</.test(fara)) rau("NaN/undefined în " + cale);
    else ok("pagina " + cale + " se deschide curat (" + p.corp.length + " octeți)");
  }
  // ATENȚIE: stratul de randare rescrie datele ISO în format românesc
  // (dateleInText), deci pagina arată „10.01.2025”, nu „2025-01-10”.
  const pv = await cer("/depozit/inventar/vechime", { query: { depozit: "96801" } });
  if (!pv.corp.includes("10.01.2025")) rau("pagina de vechime nu arată data celei mai vechi bucăți");
  else ok("pagina de vechime arată data celei mai vechi bucăți, în format românesc");

  const pg = await cer("/depozit/inventar", { user: GABI });
  egal("un agent de vânzări nu vede inventarul", locatie(pg), "/stocuri");

  // --- curățenie după noi -----------------------------------------------------------
  for (const s of [
    "DELETE FROM inventare_linii WHERE inventar_id IN (SELECT id FROM inventare WHERE depozit_id = 96801)",
    "DELETE FROM inventare WHERE depozit_id = 96801",
    "DELETE FROM miscari_stoc WHERE depozit_id = 96801",
    "DELETE FROM produse WHERE id BETWEEN 96811 AND 96819",
    "DELETE FROM depozite WHERE id = 96801",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
