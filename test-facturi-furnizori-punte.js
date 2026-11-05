"use strict";
// Facturile de la furnizori aduse din SmartBill prin punte (raportul
// „Documente furnizori"), pe PostgreSQL real.
//
// CEREREA LUI VALI, 05.11.2026: „Mai fă update pe încasări, facturi emise,
// rețete, facturi furnizori etc." — facturile de furnizor erau în ERP doar
// până pe 16.09, din Excel.
//
// CE APĂRĂ:
//   • RAPORTUL SE CITEȘTE DUPĂ ANTET, ca Excelul din /import: aceleași reguli.
//   • FACTURA INTRĂ PE ACHIZIȚIE, PE FIRMA DIN ANTETUL SMARTBILL, iar
//     furnizorul nou se naște ca furnizor.
//   • A DOUA SINCRONIZARE A ACELUIAȘI RAPORT NU DUBLEAZĂ NIMIC.
//   • ACELAȘI NUMĂR LA ALTĂ DATĂ e alt document (bonurile se reciclează).
//   • UN LOT FĂRĂ ANTET NU SCRIE NIMIC.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

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
    const s = String(sql);
    if (/^\s*(UPDATE|DELETE)/i.test(s) && !/RETURNING/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});


const { HANDLERE } = require(path.join(RAD, "modules", "punte.js"));
let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

function curata() {
  const f = q(`SELECT id FROM facturi WHERE document_extern LIKE '%TSTFF%'`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${f})`);
  q(`DELETE FROM plati WHERE factura_id IN (${f})`);
  q(`DELETE FROM facturi WHERE id IN (${f})`);
  q(`DELETE FROM parteneri WHERE nume LIKE 'TEST-FF%'`);
  q(`DELETE FROM firme WHERE id IN (97601, 97602)`);
}

(async () => {
  curata();
  q(`INSERT INTO firme (id, nume, cui, culoare, in_grup, implicita, operationala) VALUES (97601, 'TEST-FF Firma Noastra SRL', 'TSTFF1', '#000', 1, 0, 1)`);
  // O firmă implicită alta decât cea din antet: lotul trebuie să cadă pe firma
  // din antet, nu pe cea implicită.
  q(`INSERT INTO firme (id, nume, cui, culoare, in_grup, implicita, operationala) VALUES (97602, 'TEST-FF Alta Firma SRL', 'TSTFF2', '#000', 1, 1, 1)`);
  q(`INSERT INTO parteneri (tip, nume, cui) VALUES ('furnizor', 'TEST-FF Hartii SRL', 'RO7700001')`);
  // Antetul pe care îl pune punte/sincronizare.js (S.furnizori) din raportul v2.
  const ANTET = ["Furnizor", "CIF", "Document", "Data", "Scadenta", "Valoare fara TVA", "TVA", "Total", "Moneda", "Total RON", "Status"];
  const rand = (c) => ({ antet: ANTET, celule: c, firma: "TEST-FF FIRMA NOASTRĂ S.R.L." });
  // Cum vin din SmartBill: „Fact SERIENR", data zz/ll/aaaa, sume cu punct zecimal.
  const lot = [
    rand(["TEST-FF Hartii SRL", "RO7700001", "Fact TSTFF1001", "01/10/2026", "31/10/2026", "1000", "210", "1210", "RON", "1210", "Neplatita"]),
    rand(["TEST-FF Furnizor Nou SRL", "RO7700002", "Fact TSTFF2002", "15/10/2026", "", "500", "105", "605", "RON", "605", "Platita"]),
    rand(["TEST-FF Hartii SRL", "RO7700001", "Fact TSTFF1001", "03/11/2026", "", "100", "21", "121", "RON", "121", "Platita"]),
  ];

  console.log("\n1. Primul lot");
  const r1 = await HANDLERE.facturi_furnizori(lot);
  egal("trei facturi scrise (același număr, altă dată = alt document)", r1.create, 3);
  const scrise = q(`SELECT f.document_extern, f.directie, f.firma_id, f.data_emiterii, p.nume, p.tip FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE f.document_extern LIKE '%TSTFF%' ORDER BY f.data_emiterii`);
  egal("pe achiziție, pe firma din antet", [...new Set(scrise.map((x) => x.directie + "/" + x.firma_id))], ["achizitie/97601"]);
  egal("datele citite din raport", scrise.map((x) => x.data_emiterii.slice(0, 10)), ["2026-10-01", "2026-10-15", "2026-11-03"]);
  egal("furnizorul nou e furnizor", scrise.filter((x) => x.nume === "TEST-FF Furnizor Nou SRL").map((x) => x.tip), ["furnizor"]);
  const totaluri = q(`SELECT ROUND(SUM(l.cantitate * l.pret_unitar * (1 + l.cota_tva / 100))::numeric, 2) AS t FROM facturi_linii l JOIN facturi f ON f.id = l.factura_id WHERE f.document_extern LIKE '%TSTFF%'`)[0];
  egal("valorile, cu TVA, la ban", Number(totaluri.t), 1936);

  console.log("\n2. Același raport, a doua oară");
  const r2 = await HANDLERE.facturi_furnizori(lot);
  egal("nimic nou", r2.create, 0);
  egal("tot trei facturi", Number(unul(`SELECT COUNT(*) FROM facturi WHERE document_extern LIKE '%TSTFF%'`)), 3);

  console.log("\n3. SmartBill deschis pe altă firmă (nu e în ERP)");
  const rStraina = await HANDLERE.facturi_furnizori([{ antet: ANTET, celule: ["TEST-FF Altcineva SRL", "RO7700009", "Fact TSTFF9009", "02/10/2026", "", "10", "2.1", "12.1", "RON", "12.1", "Platita"], firma: "SC YACHTMAG SRL" }]);
  bine("nu scrie nimic pe firma implicită și spune de ce", rStraina.create === 0 && /nu e în ERP/.test((rStraina.erori || []).join(" ")), JSON.stringify(rStraina).slice(0, 200));
  egal("…nicio factură TSTFF9009", Number(unul(`SELECT COUNT(*) FROM facturi WHERE document_extern LIKE '%TSTFF9009%'`)), 0);

  console.log("\n4. Lot stricat");
  const r3 = await HANDLERE.facturi_furnizori([{ celule: ["x"] }]);
  bine("fără antet nu scrie nimic și spune de ce", r3.create === 0 && /antet/.test((r3.erori || []).join(" ")), JSON.stringify(r3));

  curata();
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); } catch (_) {}
  process.exit(1);
});
