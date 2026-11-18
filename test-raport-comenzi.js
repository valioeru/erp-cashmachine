"use strict";
// Raportul „Comenzi pe status": sume, totaluri, agenți, perioadă. PostgreSQL real.
//
// CEREREA LUI VALI, 18.11.2026: „La raportul comenzi pe status vreau și sume
// și totaluri pe categorii de comenzi și de la ce agent vin." „La același
// raport să pot alege eu perioada."
//
// CE APĂRĂ:
//   • stadiile stau în ordinea cerută (noi, așteaptă marfă, în producție, în
//     stoc depozit, facturată, livrată, anulată), cu număr, valoare și parte din total;
//   • agenții, de la cea mai mare valoare în jos, cu ce au pe fiecare stadiu;
//   • doar comenzile din perioada aleasă; perioada implicită e luna curentă;
//   • comanda în valută intră la cursul ei; cea fără curs nu se adună și e spusă.
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

const CO = require(path.join(RAD, "lib", "comenzi-ordine.js"));

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["rapoarte", "comenzi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97911, nume: "Vali Test", rol: "admin", email: "v.rc@test.ro" };
const AGENT = { id: 97912, nume: "Gabriela Test", rol: "vanzari", email: "g.rc@test.ro" };

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
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 97901)",
    "DELETE FROM comenzi WHERE partener_id = 97901",
    "DELETE FROM parteneri WHERE id = 97901",
    "DELETE FROM produse WHERE id = 97921",
    "DELETE FROM utilizatori WHERE id BETWEEN 97911 AND 97919",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const curat = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rand = (html, atribut, v) => curat((new RegExp(`<tr data-${atribut}="${v}">[\\s\\S]*?</tr>`).exec(html) || [""])[0]);

(async () => {
  console.log("── Ordinea și adunarea, fără bază ───────────────────────────");
  egal("ordinea stadiilor: noi, așteaptă marfă, în producție, în stoc depozit, facturată, livrată, anulată; necunoscutele la urmă",
    ["anulata", "livrata", "facturata", "in_stoc_depozit", "in_productie", "asteapta_marfa", "noua", "ceva_nou", ""].sort((a, b) => CO.rang(a) - CO.rang(b)),
    ["noua", "asteapta_marfa", "in_productie", "in_stoc_depozit", "facturata", "livrata", "anulata", "ceva_nou", ""]);
  bine("aceeași ordine și în SQL", CO.sqlRang("c.status").startsWith("CASE c.status WHEN 'noua' THEN 0 ") && CO.sqlRang("c.status").endsWith(`ELSE ${CO.ORDINE.length} END`) && CO.sqlRang("x").indexOf("'asteapta_marfa'") < CO.sqlRang("x").indexOf("'in_productie'"));
  const A = CO.aduna([
    { status: "livrata", agent: "Ana", nr: "2", valoare: "300", fara_curs: "0" },
    { status: "noua", agent: "Ana", nr: 1, valoare: 100, fara_curs: 0 },
    { status: "noua", agent: "Bogdan", nr: 3, valoare: 600, fara_curs: 1 },
    { status: "noua", agent: " ", nr: 1, valoare: 0, fara_curs: 0 },
  ]);
  egal("pe stadiu: numărul, valoarea și partea din total, în ordine", A.peStatus.map((s) => [s.status, s.nr, s.valoare, s.parte]), [["noua", 5, 700, 0.7], ["livrata", 2, 300, 0.3]]);
  egal("pe agent: de la cea mai mare valoare în jos, cu ce are pe fiecare stadiu; cel fără nume e „fără agent”", A.peAgent.map((a) => [a.agent, a.nr, a.valoare, a.parte, a.peStatus]),
    [["Bogdan", 3, 600, 0.6, { noua: { nr: 3, valoare: 600 } }], ["Ana", 3, 400, 0.4, { livrata: { nr: 2, valoare: 300 }, noua: { nr: 1, valoare: 100 } }], ["fără agent", 1, 0, 0, { noua: { nr: 1, valoare: 0 } }]]);
  egal("totalul și comenzile fără curs", [A.total, A.stari, CO.aduna([]).total, CO.aduna(null).peStatus], [{ nr: 7, valoare: 1000, faraCurs: 1 }, ["noua", "livrata"], { nr: 0, valoare: 0, faraCurs: 0 }, []]);

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97911,'Vali Raport','v.rc@test.ro','x','y','admin'), (97912,'Gabriela Raport','g.rc@test.ro','x','y','vanzari')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (97901, 'RC-TEST Client SRL', 'RO97901', 'client')",
    "INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (97921,'RC-1','Folie pentru raport','buc')",
    // în perioadă (2031-03): Vali — 2 noi (100 + 50), 1 livrată (1.000); Gabriela — 1 nouă în euro la curs 5 (20 € = 100 lei), 1 anulată (70), 1 în euro fără curs; fără agent — 1 în producție (30)
    `INSERT INTO comenzi (numar, partener_id, data, status, agent_id, moneda, curs_bnr) VALUES
       ('RC-1', 97901, '2031-03-01 08:00:00', 'noua', 97911, 'RON', NULL), ('RC-2', 97901, '2031-03-31 23:00:00', 'noua', 97911, 'RON', NULL),
       ('RC-3', 97901, '2031-03-10 10:00:00', 'livrata', 97911, 'RON', NULL), ('RC-4', 97901, '2031-03-11 10:00:00', 'noua', 97912, 'EUR', 5),
       ('RC-5', 97901, '2031-03-12 10:00:00', 'anulata', 97912, 'RON', NULL), ('RC-6', 97901, '2031-03-13 10:00:00', 'noua', 97912, 'EUR', NULL),
       ('RC-7', 97901, '2031-03-14 10:00:00', 'in_productie', NULL, 'RON', NULL),
       ('RC-8', 97901, '2031-02-28 23:59:00', 'noua', 97911, 'RON', NULL), ('RC-9', 97901, '2031-04-01 00:00:00', 'noua', 97911, 'RON', NULL)`,
    `INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) SELECT id, 97921, 1, v FROM comenzi JOIN (VALUES ('RC-1', 100), ('RC-2', 50), ('RC-3', 1000), ('RC-4', 20), ('RC-5', 70), ('RC-6', 999), ('RC-7', 30), ('RC-8', 5000), ('RC-9', 7000)) x(nr, v) ON x.nr = comenzi.numar WHERE partener_id = 97901`,
    "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) SELECT id, 97921, 2, 0 FROM comenzi WHERE numar = 'RC-1' AND partener_id = 97901",
  ]) exec(s);

  console.log("\n── Pagina, pe perioada aleasă ───────────────────────────────");
  const P = { perioada: "custom", de_la: "2031-03-01", pana_la: "2031-03-31" };
  let r = await cer("/rapoarte/comenzi", { query: P });
  bine("pagina are alegerea perioadei, cu intervalul la alegere", r.cod === 200 && r.corp.includes('action="/rapoarte/comenzi"') && r.corp.includes('name="de_la" value="2031-03-01"') && r.corp.includes('name="pana_la" value="2031-03-31"') && r.corp.includes('value="luna_curenta"'));
  egal("pe status, în ordinea cerută, cu număr și valoare — doar comenzile din perioadă, cu prima și ultima zi cu tot",
    [...r.corp.matchAll(/<tr data-status="([a-z_]+)">/g)].map((m) => m[1]).map((s) => [s, rand(r.corp, "status", s).replace(/^.*?(\d+) ([\d.,]+ lei).*$/, "$1 | $2")]),
    [["noua", "4 | 250,00 lei"], ["in_productie", "1 | 30,00 lei"], ["livrata", "1 | 1.000,00 lei"], ["anulata", "1 | 70,00 lei"]]);
  bine("…cu totalul: 7 comenzi, 1.350 lei", /<tfoot><tr[^>]*><td>Total<\/td><td[^>]*>7<\/td><td[^>]*>1\.350,00 lei<\/td>/.test(r.corp), curat((r.corp.match(/<tfoot>[\s\S]*?<\/tfoot>/) || [""])[0]));
  bine("…și partea fiecărui stadiu din total", rand(r.corp, "status", "livrata").includes("74,1%") && rand(r.corp, "status", "noua").includes("18,5%"), rand(r.corp, "status", "livrata"));
  egal("pe agent, de la cea mai mare valoare în jos", [...r.corp.matchAll(/<tr data-agent="([^"]+)">/g)].map((m) => m[1]), ["Vali Raport", "Gabriela Raport", "fără agent"]);
  const v = rand(r.corp, "agent", "Vali Raport"), g = rand(r.corp, "agent", "Gabriela Raport");
  bine("agentul cu comenzile lui: total și pe fiecare stadiu (valoare și număr)", v.startsWith("Vali Raport 3 1.150,00 lei 85,2% 150,00 lei 2 comenzi — 1.000,00 lei 1 comandă —"), v);
  bine("comanda în euro intră la cursul ei (20 € × 5 = 100 lei); cea fără curs se numără, dar nu se adună", g.startsWith("Gabriela Raport 3 170,00 lei 12,6% 100,00 lei 2 comenzi — — 70,00 lei 1 comandă"), g);
  bine("…și pagina spune că o comandă n-are curs", r.corp.includes("1 comandă în valută n-are curs și nu e adunată"));
  bine("cardurile: comenzi, încă în lucru, anulate, agenți", /Comenzi<\/div><div class="value">7<\/div><div class="ct-sub">1\.350,00 lei/.test(r.corp) && /Încă în lucru<\/div><div class="value">5<\/div><div class="ct-sub">280,00 lei/.test(r.corp) && /Anulate<\/div><div class="value">1<\/div><div class="ct-sub">70,00 lei/.test(r.corp) && /Agenți<\/div><div class="value">3<\/div>/.test(r.corp));
  r = await cer("/rapoarte/comenzi", { query: { perioada: "custom", de_la: "2031-02-28", pana_la: "2031-02-28" } });
  egal("altă perioadă, alte comenzi: doar cea din 28.02", [...r.corp.matchAll(/<tr data-status="([a-z_]+)">/g)].map((m) => m[1] + " " + rand(r.corp, "status", m[1]).replace(/^.*?(\d+) ([\d.,]+ lei).*$/, "$1 | $2")), ["noua 1 | 5.000,00 lei"]);
  r = await cer("/rapoarte/comenzi", { query: { perioada: "custom", de_la: "2040-01-01", pana_la: "2040-01-31" } });
  bine("perioadă fără comenzi: o spune, fără tabele", r.corp.includes("Nicio comandă în perioada aleasă.") && !r.corp.includes("data-pe-status"));
  r = await cer("/rapoarte/comenzi");
  const luna = new Date().toISOString().slice(0, 7);
  bine("fără nimic ales, perioada e luna curentă", r.cod === 200 && r.corp.includes(`name="de_la" value="${luna}-01"`), (r.corp.match(/name="de_la" value="[^"]*"/) || [""])[0]);

  console.log("\n── Lista de comenzi, în aceeași ordine ──────────────────────");
  r = await cer("/comenzi", { query: P });
  egal("implicit: noi, apoi în producție, livrate, anulate; în fiecare stadiu, cele mai noi sus", [...r.corp.matchAll(/>(RC-\d)<\/a>/g)].map((m) => m[1]), ["RC-6", "RC-4", "RC-2", "RC-1", "RC-7", "RC-3", "RC-5"]);
  bine("…și pagina spune ordinea", r.corp.includes("data-ordine-comenzi") && r.corp.includes("întâi comenzile noi"));

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
