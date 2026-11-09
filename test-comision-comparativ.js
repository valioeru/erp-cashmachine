"use strict";
// Comisionul agenților: regula propusă (09.11.2026) lângă cea de acum.
// PostgreSQL real.
//
// CE A SCRIS VALI: „dacă tot ce a facturat într-o lună calendaristică un agent
// este sub 265.000 fără TVA pe toate acele facturi, comisionul va fi 10% din
// marjă. Dă-mi mie doar comparativ într-un raport calculul la zi pentru luna
// în curs, care se updatează pe măsură ce intră facturi."
//
// CE APĂRĂ:
//   • REGULA: sub prag 10% din marja facturată; exact la prag și peste, regula
//     de acum; marja negativă se reportează întreagă.
//   • BAZA: facturile lunii până azi, fără TVA, ale clienților agentului; fără
//     anulate, ciorne, intercompany sau facturi din altă lună.
//   • REGULA DE ACUM vine din decont, neatinsă.
//   • DOAR VALI vede pagina și linkul spre ea — nici alt admin, nici financiarul.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, { PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp" });
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}

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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length }; },
});
const rute = { get: {}, post: {} };
const inreg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
const DEC = require(path.join(RAD, "modules", "decont.js"));
DEC.register(inreg);
const CC = require(path.join(RAD, "lib", "comision-comparativ.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const AG1 = 98901, AG2 = 98902, CL1 = 98911, CL2 = 98912, PROD = 98921;
const FACT = [98931, 98932, 98933, 98934, 98935, 98936];
function curata() {
  q(`DELETE FROM plati WHERE factura_id IN (${FACT.join(",")})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${FACT.join(",")})`);
  q(`DELETE FROM facturi WHERE id IN (${FACT.join(",")})`);
  q(`DELETE FROM produse WHERE id = ${PROD}`);
  q(`DELETE FROM parteneri WHERE id IN (${CL1}, ${CL2})`);
  q(`DELETE FROM utilizatori WHERE id IN (${AG1}, ${AG2})`);
}

const azi = new Date().toISOString().slice(0, 10);
const luna = azi.slice(0, 7);
const lunaTrecuta = (() => { const d = new Date(luna + "-15T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();

(async () => {
  console.log("\n1. Regula, fără bază de date");
  egal("sub prag: 10% din marja facturată", CC.comisionNou(100000, 20000, 999), { valoare: 2000, dupa: "10% din marja facturată", subPrag: true });
  egal("chiar sub prag", CC.comisionNou(264999.99, 1000, 5).valoare, 100);
  egal("exact la prag: regula de acum", CC.comisionNou(265000, 1000, 5), { valoare: 5, dupa: "peste prag: regula de acum", subPrag: false });
  egal("peste prag: regula de acum", CC.comisionNou(400000, 50000, 1234.56).valoare, 1234.56);
  egal("marjă negativă: se reportează întreagă", CC.comisionNou(1000, -300, 0), { valoare: -300, dupa: "marjă negativă, se reportează întreagă", subPrag: true });
  egal("rotunjit la bani", CC.comisionNou(1000, 333.333, 0).valoare, 33.33);
  const ag = [{ id: 1, nume: "Ana" }, { id: 2, nume: "Bogdan" }, { id: 3, nume: "Cezar" }, { id: 4, nume: "Dan" }];
  const fac = new Map([
    [1, { net: 1000, cost: 600, fara_cost: 100, facturi: [{}] }],
    [2, { net: 300000, cost: 180000, fara_cost: 0, facturi: [{}, {}] }],
  ]);
  const dec = [
    { agent: { id: 1 }, incasat_net: 500, marja: 200, castigat: 20, dupa: "10% din marjă" },
    { agent: { id: 2 }, incasat_net: 300000, marja: 120000, castigat: 12000, dupa: "10% din marjă" },
    { agent: { id: 3 }, incasat_net: 50, marja: 10, castigat: 1, dupa: "10% din marjă" },
    { agent: { id: 4 }, incasat_net: 0, marja: 0, castigat: 0, dupa: "" },
  ];
  const rs = CC.randuri(ag, fac, dec);
  egal("rândurile: cine a făcut ceva, cei mai mari întâi", rs.map((r) => r.agent.nume), ["Bogdan", "Ana", "Cezar"]);
  const ana = rs.find((r) => r.agent.id === 1);
  egal("Ana: facturat, până la prag, marjă, acoperire", [ana.facturat, ana.pana_la_prag, ana.marja_facturata, Math.round(ana.acoperire)], [1000, 264000, 400, 90]);
  egal("Ana: nou 40 față de 20 acum", [ana.nou, ana.actual, ana.diferenta, ana.sub_prag], [40, 20, 20, true]);
  const bog = rs.find((r) => r.agent.id === 2);
  egal("Bogdan peste prag: aceeași sumă", [bog.nou, bog.actual, bog.diferenta, bog.sub_prag, bog.pana_la_prag], [12000, 12000, 0, false, 0]);
  const cez = rs.find((r) => r.agent.id === 3);
  egal("Cezar a încasat dar n-a facturat în lună: 0 față de 1", [cez.facturat, cez.nou, cez.actual, cez.diferenta], [0, 0, 1, -1]);
  egal("totalurile", CC.totaluri(rs), { facturat: 301000, marja_facturata: 120400, incasat: 300550, actual: 12021, nou: 12040, diferenta: 19 });

  console.log("\n2. Baza din facturi, pe PostgreSQL");
  curata();
  q(`INSERT INTO utilizatori (id, nume, email, rol, activ, parola_salt, parola_hash) VALUES
       (${AG1}, 'TCC Agent Unu', 'tcc1@test.invalid', 'vanzari', 1, 'x', 'x'),
       (${AG2}, 'TCC Agent Doi', 'tcc2@test.invalid', 'vanzari', 1, 'x', 'x')`);
  q(`INSERT INTO parteneri (id, tip, nume, agent_id) VALUES (${CL1}, 'client', 'TCC Client Unu', ${AG1}), (${CL2}, 'client', 'TCC Client Doi', ${AG2})`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, pret_achizitie, activ) VALUES (${PROD}, 'TCCP', 'TCC Produs', 'buc', 10, 6, 1)`);
  // [id, client, data, status, intercompany, cantitate]
  const F = [
    [98931, CL1, azi, "emisa", 0, 100],        // intră: 1.000 net, 600 cost
    [98932, CL1, azi, "anulata", 0, 50],       // anulată
    [98933, CL1, lunaTrecuta, "emisa", 0, 70], // luna trecută
    [98934, CL2, azi, "emisa", 0, 30000],      // 300.000 net: peste prag
    [98935, CL1, azi, "emisa", 1, 40],         // între firmele grupului
    [98936, CL1, azi, "ciorna", 0, 20],        // ciornă
  ];
  for (const [id, cl, data, st, ic, cant] of F) {
    q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, status, intercompany, activ) VALUES (?, 'TCC', ?, ?, 'vanzare', ?, ?, ?, 1)`, [id, String(id), cl, data, st, ic]);
    q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, 'TCC Produs', ?, 10, 21)`, [id, PROD, cant]);
  }
  // Încasări azi: jumătate din prima factură, toată a doua.
  q(`INSERT INTO plati (factura_id, suma, data, activ) VALUES (98931, 605, ?, 1), (98934, 363000, ?, 1)`, [azi, azi]);

  const fct = await DEC.facturatCuMarja(luna, azi);
  const f1 = fct.get(AG1);
  egal("agentul 1: doar factura bună a lunii", [f1.net, f1.cost, f1.facturi.map((x) => x.id)], [1000, 600, [98931]]);
  egal("…cu documentul, clientul și data", [f1.facturi[0].document, f1.facturi[0].client, f1.facturi[0].emisa], ["TCC 98931", "TCC Client Unu", azi]);
  egal("agentul 2", [fct.get(AG2).net, fct.get(AG2).cost], [300000, 180000]);
  const ieri = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (ieri.slice(0, 7) === luna) {
    const pnIeri = await DEC.facturatCuMarja(luna, ieri);
    bine("„la zi”: ce s-a facturat azi nu intră într-un calcul până ieri", !pnIeri.get(AG1));
  }

  const { ultima } = await DEC.calculeaza(luna);
  const d1 = ultima.randuri.find((r) => Number(r.agent.id) === AG1);
  egal("regula de acum, din decont: încasat 500, marjă 200, comision 20", [Math.round(d1.incasat_net), Math.round(d1.marja), Math.round(d1.castigat * 100) / 100], [500, 200, 20]);

  console.log("\n3. Pagina");
  const VALI = { id: AG1, nume: "Vali", email: "Valentin.Oeru@cashmachine.ro ", rol: "admin" };
  const ALT_ADMIN = { id: AG1, nume: "Alt admin", email: "altcineva@cashmachine.ro", rol: "admin" };
  const FIN = { id: AG1, nume: "Financiar", email: "valentin.oeru@cashmachine.ro", rol: "financiar" };
  async function cer(user, cale, query) {
    const r = { cod: 0, antet: {}, corp: "" };
    r.writeHead = (c, h) => { r.cod = c; r.antet = h || {}; return r; };
    r.setHeader = () => {};
    r.end = (b) => { r.corp = b || ""; };
    await rute.get[cale]({ user, params: {}, query: query || {}, body: {}, res: r, req: { url: cale } });
    return r;
  }
  const pg = await cer(VALI, "/costuri/decont/comparativ");
  egal("Vali o vede", pg.cod, 200);
  const rand = (nume) => {
    const i = pg.corp.indexOf(nume);
    return i < 0 ? "" : pg.corp.slice(i, pg.corp.indexOf("</tr>", i));
  };
  const r1 = rand("TCC Agent Unu");
  const plain = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("agentul 1: facturat 1.000, regula nouă 40, acum 20, diferența +20", /1\.000,00 lei/.test(r1) && /40,00 lei/.test(r1) && /20,00 lei/.test(r1) && /\+20,00 lei/.test(r1), plain(r1).slice(0, 400));
  bine("…și până la prag 264.000", /264\.000,00 lei/.test(r1));
  bine("…cu facturile lui, legate", r1.includes('href="/facturi/98931"') && !r1.includes("98932") && !r1.includes("98933") && !r1.includes("98935"));
  const r2 = rand("TCC Agent Doi");
  bine("agentul 2: peste prag, regula de acum", r2.includes("peste prag") && r2.includes("peste prag: regula de acum"), plain(r2).slice(0, 300));
  bine("pagina spune când s-a calculat și se reîncarcă singură", /Actualizat la \d\d:\d\d/.test(pg.corp) && pg.corp.includes("location.reload()"));
  bine("…și ultima factură inclusă", pg.corp.includes("ultima factură inclusă: TCC 9893"));
  egal("alt admin: trimis la decont", [(await cer(ALT_ADMIN, "/costuri/decont/comparativ")).antet.Location], ["/costuri/decont"]);
  egal("financiarul, chiar cu adresa lui Vali: trimis la decont", [(await cer(FIN, "/costuri/decont/comparativ")).antet.Location], ["/costuri/decont"]);
  egal("fără utilizator", [(await cer(null, "/costuri/decont/comparativ")).antet.Location], ["/costuri/decont"]);
  bine("linkul din decont apare doar la Vali", (await cer(VALI, "/costuri/decont")).corp.includes('href="/costuri/decont/comparativ"') && !(await cer(ALT_ADMIN, "/costuri/decont")).corp.includes('href="/costuri/decont/comparativ"'));
  const trecut = await cer(VALI, "/costuri/decont/comparativ", { luna: lunaTrecuta.slice(0, 7) });
  bine("altă lună: se poate alege, fără „la zi”", trecut.cod === 200 && !trecut.corp.includes(", la zi (") && trecut.corp.includes("TCC Agent Unu") === true);

  curata();
  console.log(esecuri ? `\n${esecuri} ESECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (x) { console.error("curățarea a picat:", x.message); }
  process.exit(1);
});
