"use strict";
// Test pentru importul „Comenzi consumabile aprobate" (Excelul trimis de
// Sameday) în raportul „Comenzi consumabile la zi", și pentru filtrul de
// perioadă al raportului.
//
// Ce apără:
//   • O COMANDĂ E UN ID, NU UN RÂND. Excelul are un rând pe produs; aceeași
//     comandă cu două produse e o singură comandă, iar același produs scris
//     de două ori pe o comandă se adună.
//   • RÂNDURILE ANULATE NU SE NUMĂRĂ.
//   • UN PRODUS NERECUNOSCUT OPREȘTE TOATĂ ZIUA, ca la AWB-uri.
//   • REIMPORTUL ACELUIAȘI FIȘIER NU DUBLEAZĂ.
//   • CÂND VIN ETICHETELE AWB ALE ZILEI, ELE IAU LOCUL COMENZILOR — aceeași
//     comandă nu se numără de două ori. Și după ce o zi are AWB-uri, un
//     fișier de comenzi nu o mai poate rescrie.
//   • FILTRUL DE PERIOADĂ: azi, ieri, lună, interval (și interval inversat).
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
  run: async (...p) => {
    const r = q(sql, p);
    return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined };
  },
});

const mod = require(path.join(RAD, "modules", "comenzi-zi.js"));
const curierat = require(path.join(RAD, "lib", "clienti-curierat.js"));
const T = mod.__test;

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const bine = (e, cond, d) => (cond ? ok(e) : rau(e, d));
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const rot = (v) => Math.round(Number(v) * 100) / 100;


const ZI = "2031-01-15";
const PRODUSE = [
  { cod: "tst-cmd-c5", den: "TST Plic C5 comanda", pret: 0.1 },
  { cod: "tst-cmd-a4", den: "TST Plic A4 comanda", pret: 0.2 },
];
const ANTET = ["ID", "Tip Consumabil", "Cantitate", "Client", "Holding", "Punct de ridicare", "Judet (punct de ridicare)", "Localitate (punct de ridicare)", "Adresa (punct de ridicare)", "Persoana contact", "Telefon contact", "Email persoana contact", "Data crearii", "Status"];
const rand = (id, produs, cant, client, status) => [id, produs, String(cant), client, null, "Depozit", "Ilfov", "Afumati", "Str Test 1", "X", "07", "x@y.ro", "2031-01-15 10:00:00", status || "Nou"];
const FISIER = [
  ["Comenzi consumabile aprobate"],
  ANTET,
  rand("96701", "TST Plic C5 comanda", 1000, "TST CLIENT UNU SRL"),
  rand("96701", "TST Plic A4 comanda", 200, "TST CLIENT UNU SRL"),
  rand("96701", "TST Plic C5 comanda", 500, "TST CLIENT UNU SRL"),
  rand("96702", "TST Plic A4 comanda", 300, "TST CLIENT DOI SRL"),
  rand("96703", "TST Plic C5 comanda", 9999, "TST CLIENT TREI SRL", "Anulat"),
];

function curata() {
  for (const s of [
    "DELETE FROM consumabile_awb_linii WHERE awb_id IN (SELECT a.id FROM consumabile_awb a JOIN consumabile_zile z ON z.id = a.zi_id WHERE z.data = '" + ZI + "')",
    "DELETE FROM consumabile_awb WHERE zi_id IN (SELECT id FROM consumabile_zile WHERE data = '" + ZI + "')",
    "DELETE FROM consumabile_linii WHERE zi_id IN (SELECT id FROM consumabile_zile WHERE data = '" + ZI + "')",
    "DELETE FROM consumabile_zile WHERE data = '" + ZI + "'",
    "DELETE FROM consumabile_clienti WHERE nume LIKE 'TST CLIENT%'",
    "DELETE FROM consumabile_produse WHERE cod LIKE 'tst-cmd-%'",
  ]) { try { exec(s); } catch (e) { /* las-o */ } }
}
const totalZi = async () => Number(((await db.prepare("SELECT COALESCE(SUM(l.cantitate * l.pret),0) AS v FROM consumabile_linii l JOIN consumabile_zile z ON z.id = l.zi_id WHERE z.data = ?").get(ZI)) || {}).v || 0);
const nrComenzi = async () => Number((await db.prepare(`SELECT COUNT(*) AS n FROM consumabile_awb a JOIN consumabile_zile z ON z.id = a.zi_id WHERE z.data = ? AND a.awb LIKE 'CMD-%'`).get(ZI)).n);

(async () => {
  curata();
  for (const [i, p] of PRODUSE.entries()) {
    exec(`INSERT INTO consumabile_produse (cod, denumire, pret, ordine) VALUES (${lit(p.cod)}, ${lit(p.den)}, ${p.pret}, ${900 + i})`);
  }

  console.log("1. Fișierul se citește pe comenzi, nu pe rânduri");
  const c = mod.citesteComenzi(FISIER);
  egal("comenzi (fără cea anulată)", c.comenzi.length, 2);
  egal("rânduri anulate sărite", c.anulate, 1);
  const unu = c.comenzi.find((x) => x.awb === "CMD-96701");
  egal("produsul scris de două ori se adună", unu && unu.articole.find((a) => a.produs === "TST Plic C5 comanda").cantitate, 1500);
  egal("adresa și localitatea se păstrează", unu && [unu.adresa, unu.oras, unu.judet], ["Str Test 1", "Afumati", "Ilfov"]);

  console.log("\n2. Proba uscată nu scrie nimic");
  const u = await mod.importaComenziAprobate(FISIER, { zi: ZI, uscat: true });
  egal("venit calculat", rot(u.detaliu.venit), rot(1500 * 0.1 + 500 * 0.2));
  egal("nimic în bază", await nrComenzi(), 0);

  console.log("\n3. Un produs necunoscut oprește toată ziua");
  const rau1 = await mod.importaComenziAprobate(FISIER.concat([rand("96704", "Produs Inventat XYZ", 5, "TST CLIENT DOI SRL")]), { zi: ZI });
  bine("refuzat", rau1.scris === false && rau1.necunoscute.length === 1, JSON.stringify(rau1.motiv));
  egal("nimic în bază", await nrComenzi(), 0);

  console.log("\n4. Scrierea, și reimportul nu dublează");
  const w = await mod.importaComenziAprobate(FISIER, { zi: ZI });
  bine("scris", w.scris === true);
  egal("totalul zilei", rot(await totalZi()), 250);
  egal("sursa zilei", (await db.prepare("SELECT sursa FROM consumabile_zile WHERE data = ?").get(ZI)).sursa, "comenzi aprobate");
  egal("clienții au intrat cu orașul", (await db.prepare("SELECT oras FROM consumabile_clienti WHERE nume = 'TST CLIENT UNU SRL'").get()).oras, "Afumati");
  await mod.importaComenziAprobate(FISIER, { zi: ZI });
  egal("după reimport, tot 2 comenzi", await nrComenzi(), 2);
  egal("și același total", rot(await totalZi()), 250);

  console.log("\n5. Etichetele AWB ale zilei iau locul comenzilor");
  const etichetaData = new Date(Date.parse(ZI + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const awb = await mod.importaAwb([{ awb: "1SDY96799999001001", data: etichetaData, kg: 1, destinatar: "TST CLIENT UNU SRL", articole: [{ cantitate: 1000, produs: "TST Plic C5 comanda" }] }], {});
  bine("AWB scris", awb.scris === true, JSON.stringify(awb.motiv));
  egal("comenzile aprobate au ieșit", await nrComenzi(), 0);
  egal("totalul e doar al AWB-ului", rot(await totalZi()), 100);
  const dupa = await mod.importaComenziAprobate(FISIER, { zi: ZI });
  bine("un fișier de comenzi nu mai rescrie ziua cu AWB-uri", dupa.scris === false && /AWB/.test(dupa.motiv || ""), dupa.motiv);
  egal("totalul a rămas", rot(await totalZi()), 100);

  console.log("\n6. Filtrul de perioadă");
  const p1 = mod.perioadaDin({ perioada: "custom", de: "2031-02-10", pana: "2031-02-01" });
  egal("intervalul inversat se întoarce", [p1.deLa, p1.panaLa], ["2031-02-01", "2031-02-10"]);
  const p2 = mod.perioadaDin({ perioada: "custom", de: "nu", pana: "2031-02-01" });
  egal("interval greșit → luna curentă", p2.fel, "luna");
  const pAzi = mod.perioadaDin({ perioada: "azi" }), pIeri = mod.perioadaDin({ perioada: "ieri" });
  egal("ieri e cu o zi înainte de azi", new Date(Date.parse(pAzi.deLa + "T00:00:00Z") - 86400000).toISOString().slice(0, 10), pIeri.deLa);
  egal("filtrul de la top clienți, neales, nu are perioadă proprie", mod.perioadaDin({ perioada: "ieri" }, "c"), null);
  const pc = mod.perioadaDin({ perioada: "ieri", cperioada: "custom", cde: "2031-03-01", cpana: "2031-03-05" }, "c");
  egal("filtrul de la top clienți e independent de cel de sus", [pc.deLa, pc.panaLa, pc.qs], ["2031-03-01", "2031-03-05", "cperioada=custom&cde=2031-03-01&cpana=2031-03-05"]);
  egal("luna aleasă", [mod.perioadaDin({ luna: "2031-02" }).deLa, mod.perioadaDin({ luna: "2031-02" }).panaLa], ["2031-02-01", "2031-02-28"]);

  curata();
  console.log(rele ? `\n${rele} probleme.` : "\nToate verificările trec.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat testul: " + e.message); curata(); process.exit(1); });
