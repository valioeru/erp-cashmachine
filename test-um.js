"use strict";
// Test pentru repararea unităților de măsură strâmbe, și pentru drumul de
// întoarcere.
//
// Ce apără testul, în ordinea în care doare dacă se strică:
//   • o unitate ADEVĂRATĂ stricată de buton („o mie de bucăți" pusă pe „buc")
//     schimbă cantitățile în toate rapoartele, tăcut. De-aia unitățile
//     neobișnuite dar reale nu se ating niciodată;
//   • o reparare fără drum de întoarcere pe mii de produse nu se mai poate
//     anula — de-aia ce era înainte se scrie ÎNAINTE de prima modificare;
//   • „dă înapoi" nu are voie să calce peste un produs pe care l-a corectat
//     un om între timp.
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
// ATENȚIE: shimul înlocuiește fiecare „?" cu un parametru. Un semn de întrebare
// scris într-o fixtură ar fi mâncat ca marcaj și ar muta toți parametrii cu
// unul, fără niciun mesaj de eroare.
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

const mod = require(path.join(RAD, "modules", "verificari.js"));
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

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

const um = () =>
  q("SELECT id, unitate_masura FROM produse WHERE id BETWEEN 96001 AND 96099 ORDER BY id")
    .map((x) => x.id + ":" + (x.unitate_masura || ""));

(async () => {
  for (const s of [
    // Tabelul de întoarcere nu e pus de harness (ALTERARI nu rulează aici).
    `CREATE TABLE IF NOT EXISTS reparatii_um (
       id SERIAL PRIMARY KEY,
       facut_la TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
       facut_de INTEGER REFERENCES utilizatori(id),
       nr_produse INTEGER NOT NULL DEFAULT 0,
       vechi TEXT,
       anulata_la TEXT,
       anulata_de INTEGER REFERENCES utilizatori(id))`,
    "DELETE FROM reparatii_um",
    "DELETE FROM produse WHERE id BETWEEN 96001 AND 96099",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (3,'Gabriela','gabi@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    // 96001 strâmb: UM ține denumirea. 96002 e același cod, cu unitatea bună —
    // el e dovada de unde se împrumută.
    // 96003 strâmb, fără dovadă → „buc".
    // 96004 strâmb: doar cifre.
    // 96005..96007 unități ADEVĂRATE, neobișnuite — nu se ating.
    `INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (96001,'UM-A','JUMBO BD 1620MMX 4050','JUMBO BD 1620MMX 4050'),
       (96002,'UM-A','JUMBO BD 1620MMX 4050','rola'),
       (96003,'UM-B','Cerneala Galbena','Cerneala Galbena'),
       (96004,'UM-C','Folie stretch 23 microni','1720'),
       (96005,'UM-D','Adeziv la kilogram','o mie de bucati'),
       (96006,'UM-E','Banda dubla fata','centimetru patrat'),
       (96007,'UM-F','Servicii lunare','unitate activa')`,
  ]) exec(s);

  // --- ce se propune ---------------------------------------------------------
  let r = await cer("/admin/date/um-strambe");
  if (r.cod !== 200) rau("pagina nu se deschide", String(r.cod));
  else ok("pagina de unități se deschide (" + r.corp.length + " octeți)");

  const fara = r.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|undefined</.test(fara)) rau("NaN/undefined în pagină");
  for (const u of ["o mie de bucati", "centimetru patrat", "unitate activa"]) {
    if (fara.includes(">" + u + "<")) rau("o unitate adevărată a fost propusă spre reparare", u);
  }
  ok("unitățile adevărate, oricât de neobișnuite, nu se propun");

  // --- repararea -------------------------------------------------------------
  r = await cer("/admin/date/repara-um", { user: GABI, metoda: "post" });
  egal("agentul nu poate repara", r.cod, 403);
  egal("nimic nu s-a schimbat", um(), [
    "96001:JUMBO BD 1620MMX 4050", "96002:rola", "96003:Cerneala Galbena", "96004:1720",
    "96005:o mie de bucati", "96006:centimetru patrat", "96007:unitate activa",
  ]);

  r = await cer("/admin/date/repara-um", { metoda: "post" });
  egal("fiecare strâmb a primit unitatea lui", um(), [
    // 96001 împrumută „rola" de la același cod; 96003 și 96004 n-au dovadă → buc
    "96001:rola", "96002:rola", "96003:buc", "96004:buc",
    "96005:o mie de bucati", "96006:centimetru patrat", "96007:unitate activa",
  ]);

  const rep = q("SELECT id, nr_produse, vechi, anulata_la FROM reparatii_um ORDER BY id DESC");
  if (rep.length !== 1) rau("repararea n-a lăsat un singur rând de întoarcere", String(rep.length));
  else ok("repararea a scris drumul de întoarcere — " + rep[0].nr_produse + " produse");
  const salvat = JSON.parse(rep[0].vechi || "[]").sort((a, b) => a[0] - b[0]);
  egal("ce era înainte e scris produs cu produs", salvat, [
    [96001, "JUMBO BD 1620MMX 4050", "rola"],
    [96003, "Cerneala Galbena", "buc"],
    [96004, "1720", "buc"],
  ]);

  r = await cer("/admin/date/um-strambe");
  if (!r.corp.includes("Reparări făcute")) rau("pagina nu arată reparările făcute");
  else if (!r.corp.includes("dă înapoi")) rau("lipsește butonul de dat înapoi");
  else ok("pagina arată repararea și butonul de dat înapoi");

  // --- drumul de întoarcere --------------------------------------------------
  // Un om corectează unul dintre ele între timp: ăla nu se mai atinge.
  exec("UPDATE produse SET unitate_masura = 'kg' WHERE id = 96003");

  r = await cer("/admin/date/repara-um/desfa", { user: GABI, metoda: "post", body: { id: String(rep[0].id) } });
  egal("agentul nu poate da înapoi", r.cod, 403);

  r = await cer("/admin/date/repara-um/desfa", { metoda: "post", body: { id: String(rep[0].id) } });
  egal("s-a pus înapoi doar ce n-a atins nimeni", um(), [
    "96001:JUMBO BD 1620MMX 4050", "96002:rola", "96003:kg", "96004:1720",
    "96005:o mie de bucati", "96006:centimetru patrat", "96007:unitate activa",
  ]);
  if (!r.corp.includes("a rămas cum e")) rau("nu spune că unul a rămas cum l-a pus omul", r.corp.slice(0, 0) || "");
  else ok("spune câte au rămas cum le-a pus un om");

  egal("repararea e însemnată ca dată înapoi",
    q("SELECT anulata_la IS NOT NULL AS da FROM reparatii_um WHERE id = ?", [rep[0].id]).map((x) => x.da), ["t"]);

  r = await cer("/admin/date/repara-um/desfa", { metoda: "post", body: { id: String(rep[0].id) } });
  egal("a doua dare înapoi nu mai face nimic", um(), [
    "96001:JUMBO BD 1620MMX 4050", "96002:rola", "96003:kg", "96004:1720",
    "96005:o mie de bucati", "96006:centimetru patrat", "96007:unitate activa",
  ]);

  // --- curățenie după noi ----------------------------------------------------
  for (const s of ["DELETE FROM reparatii_um", "DELETE FROM produse WHERE id BETWEEN 96001 AND 96099"])
    execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
