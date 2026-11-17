"use strict";
// Agentul deschide factura unui client de-al lui — și numai pe aceea, numai de citit.
//
// Cererea lui Vali, 17.11.2026: „Când dau click pe facturi în lista din biroul
// lor, agenții nu pot deschide factura că nu au permisiunea; dă-le această
// permisiune."
//
// CE APĂRĂ:
//
//   • UȘA E ÎNGUSTĂ: doar pagina unei facturi (/facturi/<număr>). Lista de
//     facturi, achizițiile, plata, anularea, validarea și SmartBill rămân
//     închise agentului.
//   • DOAR FACTURILE CLIENȚILOR LUI: agent pe factură, client alocat sau
//     agentul de pe fișa clientului. Factura altui client și factura de
//     achiziție primesc 403.
//   • DOAR DE CITIT: fără formularul de plată, fără anulare, ștergere sau
//     trimitere în SmartBill. Financiarul și administratorul le au ca înainte.
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

const AUTH = require(path.join(RAD, "lib", "auth.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["facturi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97611, nume: "Vali FA", rol: "admin", email: "v.fa@test.ro", sectiuni: "" };
const AGENT_A = { id: 97612, nume: "Agent A", rol: "vanzari", email: "a.fa@test.ro", sectiuni: "" };
const AGENT_B = { id: 97613, nume: "Agent B", rol: "vanzari", email: "b.fa@test.ro", sectiuni: "/crm" };
const FINANCIAR = { id: 97614, nume: "Fin FA", rol: "financiar", email: "f.fa@test.ro", sectiuni: "" };

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
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));

function curata() {
  for (const s of [
    "DELETE FROM plati WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 97601 AND 97609)",
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 97601 AND 97609)",
    "DELETE FROM facturi WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM alocari_clienti WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM interactiuni WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM parteneri WHERE id BETWEEN 97601 AND 97609",
    "DELETE FROM utilizatori WHERE id BETWEEN 97611 AND 97619",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES
       (97611,'Vali FA','v.fa@test.ro','x','y','admin'), (97612,'Agent A','a.fa@test.ro','x','y','vanzari'),
       (97613,'Agent B','b.fa@test.ro','x','y','vanzari'), (97614,'Fin FA','f.fa@test.ro','x','y','financiar')`,
    // X: clientul agentului A (pe fișă). Y: alocat agentului B. Z: al nimănui. S: furnizor.
    `INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES
       (97601,'FA CLIENT X SRL','RO-FA-1','client',97612), (97602,'FA CLIENT Y SRL','RO-FA-2','client',NULL),
       (97603,'FA CLIENT Z SRL','RO-FA-3','client',NULL), (97604,'FA FURNIZOR S SRL','RO-FA-4','furnizor',97612)`,
    "INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (97602, 97613, 100)",
    `INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, agent_id) VALUES
       (976001,'TFA',1,97601,'vanzare','emisa','2026-11-10',NULL),
       (976002,'TFA',2,97602,'vanzare','emisa','2026-11-10',NULL),
       (976003,'TFA',3,97603,'vanzare','emisa','2026-11-10',97612),
       (976004,'TFA',4,97603,'vanzare','emisa','2026-11-10',NULL),
       (976005,'TFS',5,97604,'achizitie','emisa','2026-11-10',NULL)`,
    `INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES
       (976001,'folie',10,5,21),(976002,'folie',10,5,21),(976003,'folie',10,5,21),(976004,'folie',10,5,21),(976005,'granulă',10,5,21)`,
  ]) exec(s);

  console.log("\n── Ușa: doar pagina unei facturi ────────────────────────────");
  const usa = (u, p) => AUTH.poateAccesa(u, p);
  egal("agentul (pe rol) deschide pagina unei facturi", usa(AGENT_A, "/facturi/976001"), true);
  egal("agentul cu bifa Vânzări, la fel", usa(AGENT_B, "/facturi/976002"), true);
  for (const p of ["/facturi", "/facturi/achizitii", "/facturi/nou", "/facturi/actualizare", "/facturi/976001/plata", "/facturi/976001/anuleaza",
                   "/facturi/976001/sterge", "/facturi/976001/valideaza", "/facturi/976001/smartbill", "/facturi/976001/agent", "/facturi/976001x"]) {
    egal(`agentul NU ajunge pe ${p}`, usa(AGENT_A, p), false);
  }
  egal("producția nu deschide facturi", usa({ id: 1, rol: "productie", sectiuni: "/productie" }, "/facturi/976001"), false);
  egal("depozitul nu deschide facturi de vânzare", usa({ id: 1, rol: "depozit", sectiuni: "" }, "/facturi/976001"), false);
  egal("financiarul are tot, ca înainte", [usa(FINANCIAR, "/facturi"), usa(FINANCIAR, "/facturi/976001/plata")], [true, true]);

  console.log("\n── Doar facturile clienților lui, doar de citit ─────────────");
  const pag = (id, user) => cer("/facturi/:id", { params: { id: String(id) }, user });
  let r = await pag(976001, AGENT_A);
  egal("agentul A deschide factura clientului de pe fișa lui", r.cod, 200);
  are(r.corp, "FA CLIENT X SRL", "…cu clientul și sumele ei");
  are(r.corp, "Biroul meu", "…cu drumul înapoi spre biroul lui");
  for (const ce of ['action="/facturi/976001/plata"', "Anulează factura", "Șterge factura", "Integrare SmartBill", 'action="/facturi/976001/agent"']) fara(r.corp, ce, "agentul nu are „" + ce + "”");
  r = await pag(976002, AGENT_A);
  egal("agentul A NU deschide factura clientului altui agent", r.cod, 403);
  are(r.corp, "nu e a unui client de-al tău", "…și i se spune de ce");
  fara(r.corp, "FA CLIENT Y SRL", "…fără numele clientului");
  r = await pag(976002, AGENT_B);
  egal("agentul B o deschide: clientul îi e alocat", r.cod, 200);
  r = await pag(976003, AGENT_A);
  egal("agentul A deschide factura pe care e el agent, chiar la un client al nimănui", r.cod, 200);
  r = await pag(976004, AGENT_A);
  egal("…dar nu și cealaltă factură a aceluiași client", r.cod, 403);
  r = await pag(976005, AGENT_A);
  egal("factura de achiziție rămâne închisă, chiar dacă furnizorul e „al lui”", r.cod, 403);

  console.log("\n── Financiarul și administratorul, ca înainte ───────────────");
  r = await pag(976001, FINANCIAR);
  egal("financiarul deschide factura", r.cod, 200);
  for (const ce of ['action="/facturi/976001/plata"', "Anulează factura", "Șterge factura"]) are(r.corp, ce, "financiarul are „" + ce + "”");
  fara(r.corp, "Biroul meu", "…și drumul înapoi spre lista de facturi, nu spre birou");
  r = await pag(976002, ADMIN);
  egal("administratorul deschide orice factură", r.cod, 200);
  are(r.corp, 'action="/facturi/976002/agent"', "…și poate schimba agentul");

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
