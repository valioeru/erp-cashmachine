"use strict";
// Mai multe persoane de contact pe aceeași firmă, adăugate de pe fișa ei.
//
// CE APĂRĂ:
//
//   • ACELAȘI OM NU INTRĂ DE DOUĂ ORI. Emailul e cheia (e singurul lucru care
//     chiar e unic); dacă lipsește, numele. Altfel, al doilea om care
//     completează lista face dubluri, iar aniversările și mailurile pleacă de
//     două ori la aceeași persoană.
//
//   • NU SE SCRIE PESTE CE EXISTĂ. Se completează doar golurile — aceeași
//     regulă ca la importul din Monday. Cine a scris funcția pe fișă știe de
//     ce; o completare grăbită n-are dreptul s-o șteargă.
//
//   • RÂNDURILE GOALE SE IGNORĂ. Formularul vine cu trei rânduri; de obicei
//     se umple unul.
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
function q(sql, p) {
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
const exec = (s) => execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

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
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});
const mk = require(path.join(RAD, "modules", "marketing.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

const P = 97601;
const curata = () => {
  exec("DELETE FROM mk_contacte_istoric WHERE contact_id IN (SELECT id FROM mk_contacte WHERE partener_id = " + P + ")");
  exec("DELETE FROM mk_contacte WHERE partener_id = " + P);
  exec("DELETE FROM parteneri WHERE id = " + P);
};

(async () => {
  curata();
  exec(`INSERT INTO parteneri (id, nume, cui, tip) VALUES (${P}, 'CONTACTEST SRL', 'RO97601', 'client')`);

  console.log("\nTrei rânduri, unul gol:");
  let r = await mk.adaugaContacte({
    partenerId: P,
    userId: null,
    randuri: [
      { nume: "Ana Marin", functie: "achiziții", email: "ana@contactest.ro", telefon: "0722111222" },
      { nume: "", functie: "", email: "", telefon: "" },
      { nume: "Bogdan Ilie", functie: "", email: "bogdan@contactest.ro", telefon: "" },
    ],
  });
  egal("doi adăugați, rândul gol ignorat", [r.adaugati, r.completati], [2, 0]);
  egal("sunt doi în bază", Number(q("SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id = ?", [P])[0].n), 2);

  console.log("\nAcelași om, a doua oară:");
  r = await mk.adaugaContacte({
    partenerId: P, userId: null,
    randuri: [{ nume: "Ana Marin", functie: "director achiziții", email: "ana@contactest.ro", telefon: "0733999888" }],
  });
  egal("nu se adaugă încă o Ana", [r.adaugati, r.completati], [0, 0]);
  const ana = q("SELECT functie, telefon FROM mk_contacte WHERE partener_id = ? AND email = 'ana@contactest.ro'", [P])[0];
  egal("funcția scrisă prima dată NU s-a rescris", ana.functie, "achiziții");
  egal("nici telefonul", ana.telefon, "0722111222");

  console.log("\nGolurile se completează:");
  r = await mk.adaugaContacte({
    partenerId: P, userId: null,
    randuri: [{ nume: "Bogdan Ilie", functie: "depozit", email: "bogdan@contactest.ro", telefon: "0744555666" }],
  });
  egal("un rând completat, niciunul adăugat", [r.adaugati, r.completati], [0, 1]);
  const bog = q("SELECT functie, telefon FROM mk_contacte WHERE partener_id = ? AND email = 'bogdan@contactest.ro'", [P])[0];
  egal("funcția lipsă s-a completat", bog.functie, "depozit");
  egal("telefonul lipsă s-a completat", bog.telefon, "0744555666");

  console.log("\nPotrivirea pe nume, când omul n-are email:");
  await mk.adaugaContacte({ partenerId: P, userId: null, randuri: [{ nume: "Carmen Toma", functie: "contabilitate" }] });
  r = await mk.adaugaContacte({ partenerId: P, userId: null, randuri: [{ nume: "carmen toma", email: "carmen@contactest.ro" }] });
  egal("nu s-a dublat, i s-a pus emailul", [r.adaugati, r.completati], [0, 1]);
  egal("sunt trei oameni la firmă, nu patru",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id = ?", [P])[0].n), 3);

  console.log("\nBlocul de pe fișă are formularul chiar și când firma n-are pe nimeni:");
  const gol = await mk.blocContacte({ partenerId: P, numePartener: "CONTACTEST SRL", user: { id: 1, rol: "admin" } });
  if (gol.includes("/parteneri/" + P + "/contacte")) ok("formularul trimite pe ruta fișei");
  else rau("formularul nu e în bloc");

  curata();
  console.log("\n" + (rele ? rele + " probleme." : "Totul curat."));
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
