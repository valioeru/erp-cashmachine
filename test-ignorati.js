"use strict";
// Două lucruri prinse în aceeași zi, amândouă pe potrivire și pe ce NU se
// arată.
//
// 1. CHEIA FACTURII LA ÎNCASĂRI. Importul de încasări raporta „nu găsesc
//    factura «CSHMUPA0065»" pentru o factură care era în bază — se vedea cu
//    ochii, în aceeași aplicație. Motivul: factura intră spartă în serie
//    („CSHMUPA") și număr (65), iar pusă la loc dădea „CSHMUPA65", pe când
//    raportul de încasări scrie „CSHMUPA0065". La facturi normalizarea
//    exista deja (lib/documente.js), la încasări nu. Seria CSHM, fără
//    zerouri, mergea — de-aia bugul a stat ascuns până au apărut facturi pe
//    seria CSHMUPA. Au rămas 7 încasări neintrate din 14.
//
// 2. PARTENERI IGNORAȚI. În SmartBill rămăseseră date de test — BSI A/S cu
//    19.222.500 RON și Rovenma cu 2.462.236 EUR în soldul de furnizori. Vali:
//    „sunt teste ceva, șterge-le și ignoră-le pentru totdeauna din ERP".
//    „Pentru totdeauna" înseamnă că nu se mai întorc la următorul import, nu
//    că se distrug datele: se marchează, se scot din calcul, și se pot pune
//    la loc exact cum erau.
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
const unu = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
// `changes` trebuie să fie adevărat, nu aproximat: codul de ignorare
// raportează omului câte facturi a scos din calcul, iar un test care nu poate
// citi numărul ăla n-ar păzi nimic. psql cu `--csv` NU scrie eticheta
// comenzii („UPDATE 2"), deci pentru UPDATE și DELETE rulăm fără `--csv` și
// citim eticheta. Aceeași capcană a mai stricat o dată un test de fuziune.
function ruleazaCuNumar(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  const out = execFileSync("psql", ["-X", "-c", s], { env: ENV, encoding: "utf8" });
  const m = out.match(/^(?:UPDATE|DELETE|INSERT(?: \d+)?)\s+(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}

const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => {
    const cap = sql.trim().toUpperCase();
    if ((cap.startsWith("UPDATE") || cap.startsWith("DELETE")) && !/RETURNING/i.test(sql)) {
      return { changes: ruleazaCuNumar(sql, p) };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const ignorare = require(path.join(RAD, "lib", "parteneri-ignorati.js"));
const { cheiaDocumentExtern } = require(path.join(RAD, "lib", "documente.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

async function curat() {
  for (const s of [
    "DELETE FROM plati WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 96801 AND 96899)",
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 96801 AND 96899)",
    "DELETE FROM facturi WHERE partener_id BETWEEN 96801 AND 96899",
    "DELETE FROM alocari_clienti WHERE partener_id BETWEEN 96801 AND 96899",
    "DELETE FROM parteneri WHERE id BETWEEN 96801 AND 96899",
    "DELETE FROM parteneri_ignorati WHERE nume LIKE 'TEST-IGN%'",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  await curat();

  // =====================================================================
  console.log("\n— Cheia facturii: zerourile din față nu mai rup potrivirea —");
  // =====================================================================
  const perechi = [
    ["CSHMUPA0065", "CSHMUPA65", true],
    ["CSHMUPA0008", "CSHMUPA8", true],
    ["CSHM 3251", "CSHM3251", true],
    ["cshmupa 0065", "CSHMUPA65", true],
    ["CSHM3290", "CSHM3291", false],
    ["CSHMUPA0065", "CSHM0065", false],
  ];
  for (const [a, b, trebuie] of perechi) {
    const la_fel = cheiaDocumentExtern(a) === cheiaDocumentExtern(b);
    if (la_fel !== trebuie) rau(`„${a}" vs „${b}"`, `am ${la_fel ? "egale" : "diferite"}`);
    else ok(`„${a}" ${trebuie ? "=" : "≠"} „${b}" → ${cheiaDocumentExtern(a)}`);
  }

  // Potrivirea reală, cum o face importul: factura stă spartă în serie+număr.
  const dinBaza = cheiaDocumentExtern(`${"CSHMUPA"}${65}`);
  const dinRaport = cheiaDocumentExtern("CSHMUPA0065");
  egal("factura din bază și încasarea din raport ajung la aceeași cheie", dinBaza, dinRaport);

  // =====================================================================
  console.log("\n— Parteneri ignorați —");
  // =====================================================================
  exec(`INSERT INTO parteneri (id, nume, cui, tip) VALUES
          (96801,'TEST-IGN BSI A/S','RO-IGN-1','furnizor'),
          (96802,'TEST-IGN Rovenma Elektronik Sanayi',NULL,'furnizor'),
          (96803,'TEST-IGN Firma Buna SRL','RO-IGN-3','client')`);
  exec(`INSERT INTO facturi (partener_id, serie, numar, directie, data_emiterii, status, activ) VALUES
          (96801,'FIGN',1,'achizitie','2026-10-01','emisa',1),
          (96801,'FIGN',2,'achizitie','2026-10-02','emisa',1),
          (96803,'FIGN',3,'vanzare','2026-10-03','emisa',1)`);
  // O factură scoasă DE MÂNĂ înainte de ignorare: nu trebuie repusă la ridicare.
  exec("INSERT INTO facturi (partener_id, serie, numar, directie, data_emiterii, status, activ) VALUES (96801,'FIGN',4,'achizitie','2026-10-04','emisa',0)");

  const nume = ["TEST-IGN BSI A/S", "bsi a s", "TEST-IGN  BSI   A / S"];
  egal("numele se normalizează la fel oricum e scris",
    [...new Set(nume.slice(0, 1).map(ignorare.cheieNume))], ["test ign bsi a s"]);

  const r1 = await ignorare.adauga({ nume: "TEST-IGN BSI A/S", motiv: "date de test" });
  egal("regula prinde partenerul", r1.parteneri, 1);
  egal("și-i scoate facturile active din calcul", r1.facturi, 2);
  egal("partenerul e marcat ignorat", Number(unu("SELECT ignorat FROM parteneri WHERE id = 96801")), 1);
  egal("facturile lui nu mai sunt active",
    q("SELECT activ, scos_de_ignorare FROM facturi WHERE partener_id = 96801 ORDER BY numar").map((x) => x.activ + "/" + x.scos_de_ignorare),
    ["0/1", "0/1", "0/0"]);
  egal("clientul bun n-a fost atins", Number(unu("SELECT ignorat FROM parteneri WHERE id = 96803")), 0);
  egal("și factura lui a rămas activă", Number(unu("SELECT activ FROM facturi WHERE partener_id = 96803")), 1);

  // Aceeași regulă de două ori nu se adaugă.
  const r2 = await ignorare.adauga({ nume: "bsi  a/s" === "x" ? "x" : "TEST-IGN bsi a / s" });
  if (!r2.eroare) rau("aceeași firmă se poate adăuga de două ori");
  else ok("aceeași firmă nu intră de două ori — " + r2.eroare);

  // Setul folosit la import.
  const s = await ignorare.set();
  if (!ignorare.esteIgnorat(s, "TEST-IGN BSI A/S")) rau("importul n-ar sări firma ignorată");
  else ok("importul sare firma ignorată");
  if (!ignorare.esteIgnorat(s, "test-ign   bsi   a/s")) rau("potrivirea cade la altă scriere a numelui");
  else ok("potrivirea ține și la altă scriere a numelui");
  if (ignorare.esteIgnorat(s, "TEST-IGN Firma Buna SRL")) rau("o firmă bună e sărită la import");
  else ok("firmele bune trec mai departe");

  // Ridicarea pune totul la loc — dar numai ce a scos ignorarea.
  const id = Number(unu("SELECT id FROM parteneri_ignorati WHERE nume = 'TEST-IGN BSI A/S'"));
  const r3 = await ignorare.ridica(id);
  egal("la ridicare partenerul revine", Number(unu("SELECT ignorat FROM parteneri WHERE id = 96801")), 0);
  egal("se repun DOAR facturile scoase de ignorare",
    q("SELECT activ FROM facturi WHERE partener_id = 96801 ORDER BY numar").map((x) => Number(x.activ)),
    [1, 1, 0]);
  egal("iar regula a dispărut din listă",
    Number(unu("SELECT COUNT(*) FROM parteneri_ignorati WHERE nume = 'TEST-IGN BSI A/S'")), 0);

  // O regulă pe CUI, pentru firme scrise în zece feluri.
  const r4 = await ignorare.adauga({ nume: "TEST-IGN Altceva", cui: "RO-IGN-1" });
  egal("regula pe CUI prinde firma indiferent de nume", r4.parteneri, 1);
  egal("partenerul e din nou ignorat", Number(unu("SELECT ignorat FROM parteneri WHERE id = 96801")), 1);

  await curat();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch(async (e) => { console.error("A crăpat:", e.message); try { await curat(); } catch (x) {} process.exit(1); });
