"use strict";
// Marja comenzii și vorba ei, în lista de comenzi. PostgreSQL real pentru listă.
//
// CEREREA LUI VALI, 18.11.2026: „La orice comenzi cu marja sub 5% să apară în
// lista comenzi «atenție, renegociază urgent marja». La sub 10% […] prioritar;
// la sub 15% marjă minimă, încearcă peste 20%; la peste 20% ține sub
// observație; la peste 25% marja e OK; la peste 30% marjă bună; peste 35%
// foarte bună; la peste 40% marjă spectaculoasă, you are the best!"
//
// CE APĂRĂ: treptele, la fiecare hotar; costul bucății (rețetă, producție,
// achiziție); comanda în valută la cursul ei; liniile fără cost, în altă
// unitate sau cu cost de necrezut nu intră; sub jumătate din valoare
// acoperită, marja nu se spune.
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

const MJ = require(path.join(RAD, "lib", "marja-comanda.js"));

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98011, nume: "Vali Test", rol: "admin", email: "v.mj@test.ro" };
const AGENT = { id: 98012, nume: "Gabriela Test", rol: "vanzari", email: "g.mj@test.ro" };

async function cer(cale, { user = ADMIN, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));


function curata() {
  for (const s of [
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 98001)",
    "DELETE FROM comenzi WHERE partener_id = 98001",
    "DELETE FROM parteneri WHERE id = 98001",
    "DELETE FROM produse WHERE id BETWEEN 98021 AND 98029",
    "DELETE FROM utilizatori WHERE id BETWEEN 98011 AND 98019",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const curat = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

(async () => {
  console.log("── Treptele ─────────────────────────────────────────────────");
  egal("fiecare hotar, de o parte și de alta",
    [-10, 4.99, 5, 9.99, 10, 14.9, 15, 19.99, 20, 24.99, 25, 29.99, 30, 34.99, 35, 39.99, 40, 80].map((p) => MJ.treapta(p).cheie),
    ["urgent", "urgent", "prioritar", "prioritar", "minima", "minima", "minima", "minima", "observatie", "observatie", "ok", "ok", "buna", "buna", "foarte_buna", "foarte_buna", "spectaculoasa", "spectaculoasa"]);
  egal("vorbele, cum le-a spus Vali", [3, 7, 12, 22, 27, 32, 37, 45].map((p) => MJ.treapta(p).text),
    ["Atenție: renegociază urgent marja", "Renegociază marja — prioritar", "Marjă minimă — încearcă peste 20%", "Ține sub observație", "Marjă OK", "Marjă bună", "Marjă foarte bună", "Marjă spectaculoasă — you are the best!"]);
  egal("culorile: roșu sub 10%, galben până la 20%, verde de la 25%; un număr care nu e număr n-are treaptă", [[3, 7, 12, 22, 27, 45].map((p) => MJ.treapta(p).culoare), MJ.treapta("x"), MJ.treapta(NaN)], [["rosu", "rosu", "galben", "albastru", "verde", "verde"], null, null]);

  console.log("\n── Marja, fără bază ─────────────────────────────────────────");
  egal("costul bucății: rețeta înaintea costului de producție, acesta înaintea prețului de achiziție", [MJ.costBucata({ cost_reteta: 3, pret_productie: 4, pret_achizitie: 5 }), MJ.costBucata({ pret_productie: 4, pret_achizitie: 5 }), MJ.costBucata({ pret_achizitie: "5" }), MJ.costBucata({ cost_reteta: 0 }), MJ.costBucata(null)], [3, 4, 5, null, null]);
  const r1 = (x) => (x.stiuta ? Math.round(x.pct * 100) / 100 : x.motiv);
  egal("marja = (vânzare − cost) ÷ vânzare, pe toate liniile", r1(MJ.marja([{ cantitate: 10, pret_unitar: 10, pret_achizitie: 7 }, { cantitate: 5, pret_unitar: 20, cost_reteta: 16 }], 1)), 25);
  egal("comanda în euro: prețul × cursul, costul rămâne în lei (2 € × 5 = 10 lei, cost 7 → 30%)", r1(MJ.marja([{ cantitate: 1, pret_unitar: 2, pret_achizitie: 7 }], 5)), 30);
  egal("comandă în valută fără curs, sau fără valoare: nu se știe", [r1(MJ.marja([{ cantitate: 1, pret_unitar: 2, pret_achizitie: 1 }], null)), r1(MJ.marja([{ cantitate: 1, pret_unitar: 0, pret_achizitie: 1 }], 1)), r1(MJ.marja([], 1))], ["comanda e în valută și n-are curs", "comanda n-are valoare", "comanda n-are valoare"]);
  const mixt = MJ.marja([{ cantitate: 10, pret_unitar: 10, pret_achizitie: 9 }, { cantitate: 1, pret_unitar: 50 }], 1);
  egal("linia fără cost nu intră: marja se socotește pe restul și se spune câte lipsesc", [r1(mixt), mixt.faraCost, Math.round(mixt.acoperire * 100)], [10, 1, 67]);
  egal("sub jumătate din valoare cu cost: marja nu se spune", [r1(MJ.marja([{ cantitate: 1, pret_unitar: 40, pret_achizitie: 30 }, { cantitate: 1, pret_unitar: 60 }], 1)), r1(MJ.marja([{ cantitate: 1, pret_unitar: 40 }, { cantitate: 1, pret_unitar: 60 }], 1))], ["un produs n-are cost", "2 produse n-au cost"]);
  egal("linia vândută în altă unitate decât produsul (kg față de rolă) nu se socotește; aceeași unitate scrisă altfel, da", [r1(MJ.marja([{ cantitate: 1, pret_unitar: 10, um: "kg", produs_um: "rola", pret_achizitie: 5 }], 1)), r1(MJ.marja([{ cantitate: 1, pret_unitar: 10, um: "BUC.", produs_um: "buc", pret_achizitie: 5 }], 1)), r1(MJ.marja([{ cantitate: 1, pret_unitar: 10, um: "", produs_um: "buc", pret_achizitie: 5 }], 1))], ["un produs n-are cost", 50, 50]);
  egal("costul de peste cinci ori vânzarea e greșeală de date, nu marjă; pierderea adevărată se vede", [r1(MJ.marja([{ cantitate: 100, pret_unitar: 1, pret_achizitie: 1720 }], 1)), r1(MJ.marja([{ cantitate: 1000, pret_unitar: 10, pret_achizitie: 12 }], 1))], ["un produs n-are cost", -20]);

  console.log("\n── Lista de comenzi ─────────────────────────────────────────");
  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98011,'Vali Marja','v.mj@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (98001, 'MJ-TEST Client SRL', 'RO98001', 'client')",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie, pret_productie, cost_reteta) VALUES (98021,'MJ-1','Folie cu cost 8','buc',8,NULL,NULL), (98022,'MJ-2','Produs fara cost','buc',0,NULL,NULL), (98023,'MJ-3','Produs cu reteta 5','buc',9,7,5)",
    `INSERT INTO comenzi (numar, partener_id, data, status, moneda, curs_bnr) VALUES
       ('MJ-A', 98001, '2032-05-02 10:00:00', 'noua', 'RON', NULL), ('MJ-B', 98001, '2032-05-03 10:00:00', 'noua', 'RON', NULL),
       ('MJ-C', 98001, '2032-05-04 10:00:00', 'noua', 'RON', NULL), ('MJ-D', 98001, '2032-05-05 10:00:00', 'noua', 'EUR', 5),
       ('MJ-E', 98001, '2032-05-06 10:00:00', 'noua', 'RON', NULL), ('MJ-F', 98001, '2032-05-07 10:00:00', 'noua', 'EUR', NULL)`,
    // A: 8,2 la cost 8 → 2,4% (urgent); B: 10 la cost 8 → 20% (observație); C: produsul cu rețetă 5 vândut cu 10 → 50%;
    // D: 2 € × 5 = 10 lei la cost 8 → 20%; E: doar produs fără cost; F: euro fără curs
    `INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) SELECT c.id, x.p, 10, x.v FROM comenzi c JOIN (VALUES ('MJ-A', 98021, 8.2), ('MJ-B', 98021, 10), ('MJ-C', 98023, 10), ('MJ-D', 98021, 2), ('MJ-E', 98022, 10), ('MJ-F', 98021, 2)) x(nr, p, v) ON x.nr = c.numar WHERE c.partener_id = 98001`,
  ]) exec(s);
  const r = await cer("/comenzi", { query: { perioada: "custom", de_la: "2032-05-01", pana_la: "2032-05-31" } });
  const randuri = [...r.corp.matchAll(/<tr>(?:(?!<\/tr>)[\s\S])*?>(MJ-[A-F])<\/a>[\s\S]*?<\/tr>/g)];
  const marjaLui = (nr) => { const m = randuri.find((x) => x[1] === nr); const c = m ? (m[0].match(/<span data-marja="([a-z_]+)"[\s\S]*?<\/td>/) || []) : []; return [c[1] || "lipsa", curat(c[0] || "")]; };
  bine("lista are coloana „Marjă”", r.cod === 200 && />Marjă<\/th>/.test(r.corp));
  egal("sub 5%: roșu, „renegociază urgent”", marjaLui("MJ-A"), ["urgent", "2,4% Atenție: renegociază urgent marja"]);
  egal("20%: „ține sub observație”", marjaLui("MJ-B"), ["observatie", "20,0% Ține sub observație"]);
  egal("costul din rețetă bate prețul de achiziție: 50%, „spectaculoasă”", marjaLui("MJ-C"), ["spectaculoasa", "50,0% Marjă spectaculoasă — you are the best!"]);
  egal("comanda în euro, la cursul ei: tot 20%", marjaLui("MJ-D")[0], "observatie");
  egal("produs fără cost și comandă în euro fără curs: „necunoscută”, cu motivul", [marjaLui("MJ-E"), marjaLui("MJ-F")[0], /title="un produs n-are cost"/.test(r.corp), /title="comanda e în valută și n-are curs"/.test(r.corp)], [["necunoscuta", "necunoscută"], "necunoscuta", true, true]);
  bine("vorba urgentă e scrisă cu roșu", /<span class="badge rosu">2,4%<\/span>\s*<div style="font-size:12px;color:var\(--danger\);font-weight:600">Atenție/.test(r.corp));

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
