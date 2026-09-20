"use strict";
// Verifică pagina de stoc pe o bază care N-A PRIMIT ÎNCĂ migrarea.
//
// Se rulează în proces separat pentru că modulul ține minte, o dată pentru
// toată viața procesului, ce coloane are baza. Apelantul (test-depozit.js)
// scoate coloanele înainte și le pune la loc după.
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
function run(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit(p[i++]));
  const out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" });
  const L = csv(out).filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((r) => { const o = {}; h.forEach((k, j) => (o[k] = r[j] === "" ? null : r[j])); return o; });
}
process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (q) {
  if (q === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => run(sql, p),
  get: async (...p) => run(sql, p)[0] || null,
  run: async (...p) => { const r = run(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});
const ct = require(path.join(RAD, "modules", "ct-park.js"));
const rute = { get: {}, post: {} };
ct.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });
const res = () => { const x = { cod: 0, corp: "" }; x.writeHead = (c) => { x.cod = c; return x; }; x.setHeader = () => {}; x.end = (b) => { x.corp = b || ""; }; return x; };

(async () => {
  const r = res();
  try {
    await rute.get["/stocuri/ct-park/stoc"]({ user: { rol: "admin", nume: "V", id: 1 }, params: {}, query: {}, body: {}, res: r, req: {} });
  } catch (e) {
    console.log("  PROBLEMĂ stoc la zi CADE pe baza nemigrată: " + String(e.message).split("\n")[0]);
    process.exit(1);
  }
  const fara = r.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  const rele = [];
  if (!fara.includes("Stoc la zi")) rele.push("lipsește titlul");
  if (!fara.includes("n-a primit încă migrarea")) rele.push("lipsește avertismentul");
  if (!fara.includes("TERAPLAST RECYCLING SA")) rele.push("furnizorul dedus nu apare");
  if (/NaN|undefined</.test(fara)) rele.push("NaN/undefined în pagină");
  if (rele.length) { console.log("  PROBLEMĂ stoc la zi pe baza nemigrată: " + rele.join("; ")); process.exit(1); }
  console.log("  ok       stoc la zi merge și fără coloanele de furnizor (" + r.corp.length + " octeți)");
  process.exit(0);
})();
