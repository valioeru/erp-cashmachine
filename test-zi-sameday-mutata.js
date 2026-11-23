"use strict";
// Ziua de 19.11.2026 din „Comenzi Sameday", urcată din greșeală pe 23.11.
//
// CEREREA LUI VALI, 23.11.2026: „Am urcat ziua 19.11 din comenzi consumabile
// la 23.11, poți modifica tu, te rog, corespunzător."
//
// CE APĂRĂ: îndreptarea mută exact rândul acela (ziua 23.11 legată de comanda
// #146, încă nouă, făcută de ERP, cu numele greșit), o singură dată; nu atinge
// o zi de 23.11 urcată după aceea, o comandă deja pornită sau o zi de 19.11
// care există deja.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
// SmartBill nu e configurat în test: validarea facturii nu trimite nimic.
for (const k of Object.keys(process.env)) if (/^SMARTBILL/.test(k)) delete process.env[k];
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail$/.test(req)) return { trimite: async () => ({ ok: true }), trimiteDeLa: async () => ({ ok: true }), configUtilizator: async () => null };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) { console.log("  PROBLEMĂ " + eticheta + ": am " + a + ", așteptam " + b); rele++; } else ok(eticheta + " = " + b);
}
const CLIENT = "ZSM-TEST";
function curata() {
  for (const s of [
    `DELETE FROM consumabile_zile WHERE client IN ('${CLIENT}', '${CLIENT}-2')`,
    "DELETE FROM comenzi WHERE id = 146 AND partener_id = 98201",
    "DELETE FROM parteneri WHERE id = 98201",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const stare = () => [
  q(`SELECT client, data, comanda_id FROM consumabile_zile WHERE client LIKE '${CLIENT}%' ORDER BY client, data`).map((x) => [x.client, x.data, x.comanda_id === null ? null : Number(x.comanda_id)]),
  q("SELECT numar, data_livrare_ceruta, observatii, status FROM comenzi WHERE id = 146").map((x) => [x.numar, x.data_livrare_ceruta, x.observatii, x.status])[0],
];
const pune = (statusul, numar, sursa) => {
  curata();
  exec("INSERT INTO parteneri (id, nume, cui, tip) VALUES (98201, 'ZSM-TEST Client', 'RO98201', 'client')");
  exec(`INSERT INTO comenzi (id, partener_id, numar, data, status, sursa, moneda, data_livrare_ceruta, observatii) VALUES (146, 98201, '${numar}', '2026-11-23 14:01:00', '${statusul}', '${sursa}', 'RON', '2026-11-24', 'Comanda zilnică de consumabile Sameday pentru 23.11.2026, făcută de ERP din raportul de comenzi.')`);
  exec(`INSERT INTO consumabile_zile (client, data, sursa, comanda_id) VALUES ('${CLIENT}', '2026-11-23', 'comenzi aprobate', 146)`);
};

(async () => {
  if (Number(q("SELECT COUNT(*) AS n, 1 AS x FROM comenzi WHERE id = 146 AND partener_id <> 98201")[0].n)) {
    console.log("Baza de test are deja o comandă #146 a altcuiva: testul nu rulează peste ea.");
    process.exit(0);
  }
  const OBS19 = "Comanda zilnică de consumabile Sameday pentru 19.11.2026, făcută de ERP din raportul de comenzi.";
  const OBS23 = OBS19.replace("19.11", "23.11");

  pune("noua", "Sameday 23.11.2026", "sameday");
  await db.indreptariPunctuale();
  egal("ziua trece pe 19.11, iar comanda ei ia numele zilei, livrarea de vineri 20.11 și observația corectă", stare(), [[[CLIENT, "2026-11-19", 146]], ["Sameday 19.11.2026", "2026-11-20", OBS19, "noua"]]);
  exec(`INSERT INTO consumabile_zile (client, data, sursa) VALUES ('${CLIENT}', '2026-11-23', 'comenzi aprobate')`);
  await db.indreptariPunctuale();
  egal("a doua pornire nu mai schimbă nimic; ziua adevărată de 23.11, urcată după aceea, rămâne pe 23.11", stare(), [[[CLIENT, "2026-11-19", 146], [CLIENT, "2026-11-23", null]], ["Sameday 19.11.2026", "2026-11-20", OBS19, "noua"]]);

  pune("noua", "Sameday 23.11.2026", "sameday");
  exec(`INSERT INTO consumabile_zile (client, data, sursa) VALUES ('${CLIENT}', '2026-11-19', 'AWB')`);
  await db.indreptariPunctuale();
  egal("dacă 19.11 există deja, nu se mută nimic peste ea", stare(), [[[CLIENT, "2026-11-19", null], [CLIENT, "2026-11-23", 146]], ["Sameday 23.11.2026", "2026-11-24", OBS23, "noua"]]);

  for (const [ce, st, nume, sursa] of [["comanda deja pornită (nu mai e nouă)", "in_stoc_depozit", "Sameday 23.11.2026", "sameday"], ["comanda cu alt nume", "noua", "Sameday 24.11.2026", "sameday"], ["comanda scrisă de mână", "noua", "Sameday 23.11.2026", "manual"]]) {
    pune(st, nume, sursa);
    await db.indreptariPunctuale();
    egal(ce + ": nu se atinge", stare(), [[[CLIENT, "2026-11-23", 146]], [nume, "2026-11-24", OBS23, st]]);
  }

  pune("noua", "Sameday 23.11.2026", "sameday");
  exec(`UPDATE consumabile_zile SET comanda_id = NULL WHERE client = '${CLIENT}'`);
  await db.indreptariPunctuale();
  egal("ziua de 23.11 nelegată de comanda #146: nu se atinge", stare(), [[[CLIENT, "2026-11-23", null]], ["Sameday 23.11.2026", "2026-11-24", OBS23, "noua"]]);

  curata();
  console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
