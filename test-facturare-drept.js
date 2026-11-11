"use strict";
// Bifa „Facturare": cine poate deschide facturile și cine le poate valida.
// PostgreSQL real.
//
// CE A CERUT VALI, 11.11.2026: „Gabi să poată și factura."
//
// Facturile stăteau numai sub „Financiar", lângă bancă, salarii și costuri, iar
// validarea (emiterea) era doar a administratorului și a rolului financiar.
// Gabi e la achiziții; ca să factureze ar fi trebuit să vadă tot Financiarul
// sau să-și schimbe rolul. Acum facturarea are bifa ei, ca avizele.
//
// CE APĂRĂ:
//   • BIFA deschide paginile de facturi și nimic altceva din Financiar.
//   • VALIDAREA: administratorul, rolul financiar și cine are bifa. Bifa
//     „Financiar" singură arată facturile, dar nu le emite — ca până acum.
//   • FĂRĂ BIFĂ: pagina facturii spune că n-ai drept, iar ruta refuză și nu
//     schimbă nimic.
//   • UTILIZATORI: bifa apare în formular și se salvează.
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
const unul = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); } };
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
      const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});


const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
const auth = require(path.join(RAD, "lib", "auth.js"));
require(path.join(RAD, "modules", "facturi.js")).register(router);
require(path.join(RAD, "modules", "utilizatori.js")).register(router);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query } = {}) {
  let h = rute[metoda][cale];
  let par = {};
  if (!h) {
    for (const [tipar, fn] of Object.entries(rute[metoda])) {
      const re = new RegExp("^" + tipar.replace(/:[^/]+/g, "([^/]+)") + "$");
      const m = re.exec(cale);
      if (m) {
        const nume = (tipar.match(/:[^/]+/g) || []).map((x) => x.slice(1));
        par = Object.fromEntries(nume.map((n, i) => [n, m[i + 1]]));
        h = fn;
        break;
      }
    }
  }
  if (!h) throw new Error("nicio rută pentru " + metoda + " " + cale);
  const r = res();
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase(), headers: {} } });
  return r;
}
const unde = (r) => String((r.antet && r.antet.Location) || "");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const PART = 97621, PROD = 97641, F1 = 97631, F2 = 97632, U_GABI = 97611;
function curata() {
  q(`DELETE FROM interactiuni WHERE partener_id = ${PART}`);
  q(`DELETE FROM miscari_stoc WHERE produs_id = ${PROD}`);
  q(`DELETE FROM plati WHERE factura_id IN (${F1}, ${F2})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${F1}, ${F2})`);
  q(`DELETE FROM facturi WHERE id IN (${F1}, ${F2})`);
  q(`DELETE FROM produse WHERE id = ${PROD}`);
  q(`DELETE FROM parteneri WHERE id = ${PART}`);
  q(`DELETE FROM utilizatori WHERE id = ${U_GABI}`);
}
const factura = (id) => q(`SELECT status, numar, validata_de FROM facturi WHERE id = ${id}`)[0] || {};

(async () => {
  curata();
  const ADMIN = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali Test", rol: "admin", sectiuni: "" };
  const GABI = { id: U_GABI, nume: "Gabi Test", rol: "depozit", sectiuni: "/crm,/comenzi,/depozit,/avize,/facturi" };
  const FARA = { id: U_GABI, nume: "Fără bifă", rol: "depozit", sectiuni: "/crm,/comenzi,/depozit,/avize" };
  const DOAR_FIN = { id: U_GABI, nume: "Doar Financiar", rol: "depozit", sectiuni: "/financiar" };
  const CONTABIL = { id: U_GABI, nume: "Contabil", rol: "financiar", sectiuni: "" };

  console.log("1. Ce deschide bifa");
  egal("cu bifa Facturare: lista, factura, factura nouă, validarea, trimiterea în SmartBill",
    ["/facturi", "/facturi/12", "/facturi/nou", "/facturi/12/valideaza", "/facturi/12/smartbill"].map((p) => auth.poateAccesa(GABI, p)), [true, true, true, true, true]);
  egal("…dar nimic altceva din Financiar", ["/financiar", "/banca", "/salarii", "/angajati", "/costuri", "/import"].map((p) => auth.poateAccesa(GABI, p)), [false, false, false, false, false, false]);
  egal("fără bifă: facturile rămân închise", ["/facturi", "/facturi/12", "/facturi/12/valideaza"].map((p) => auth.poateAccesa(FARA, p)), [false, false, false]);
  egal("cine are „Financiar” le vede ca până acum", ["/facturi", "/facturi/12", "/banca"].map((p) => auth.poateAccesa(DOAR_FIN, p)), [true, true, true]);
  egal("rolul financiar, fără nicio bifă: ca până acum", ["/facturi", "/facturi/12/valideaza"].map((p) => auth.poateAccesa(CONTABIL, p)), [true, true]);
  egal("pentru meniu, facturile țin tot de Financiar; la acces contează și bifa lor", [auth.sectiune("/facturi/12"), auth.zoneleRutei("/facturi/12")], ["/financiar", ["/financiar", "/facturi"]]);
  const zona = auth.ZONE.find((z) => z.cheie === "/facturi");
  bine("bifa e în lista de secțiuni, cu nume pe înțeles, și nu e marcată sensibilă", zona && /Facturare/.test(zona.eticheta) && !zona.sensibil, JSON.stringify(zona));

  console.log("\n2. Cine validează");
  egal("administratorul, rolul financiar, bifa Facturare: da; fără bifă, doar cu „Financiar”, fără cont, doar numele rolului: nu",
    [ADMIN, CONTABIL, GABI, FARA, DOAR_FIN, null, undefined, "financiar", {}].map((u) => auth.areFacturare(u)), [true, true, true, false, false, false, false, false, false]);
  egal("bifa se caută întreagă, nu ca bucată din alt nume", auth.areFacturare({ rol: "depozit", sectiuni: "/facturi/achizitii,/facturile" }), false);

  console.log("\n3. Pagina facturii și validarea");
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${PART}, 'client', 'TFD Client SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${PROD}, 'TFD-P', 'TFD Produs', 'buc', 1)`);
  for (const id of [F1, F2]) {
    q(`INSERT INTO facturi (id, serie, partener_id, directie, status, data_emiterii, activ) VALUES (${id}, 'TFD', ${PART}, 'vanzare', 'ciorna', '2099-01-05', 1)`);
    q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id}, ${PROD}, 'TFD Produs', 3, 10, 21)`);
  }
  let p = await cer("get", `/facturi/${F1}`, GABI);
  bine("Gabi, cu bifa: vede butonul de validare", p.cod === 200 && p.corp.includes(`action="/facturi/${F1}/valideaza"`) && p.corp.includes("Validează și emite factura") && !p.corp.includes("Nu ai drepturi de validare"), p.cod);
  p = await cer("get", `/facturi/${F1}`, FARA);
  bine("fără bifă: pagina spune că n-are drept și nu arată butonul", p.corp.includes("Nu ai drepturi de validare") && !p.corp.includes(`action="/facturi/${F1}/valideaza"`));
  p = await cer("get", `/facturi/${F1}`, DOAR_FIN);
  bine("doar cu „Financiar”: vede factura, dar nu butonul — ca până acum", p.cod === 200 && p.corp.includes("Nu ai drepturi de validare") && !p.corp.includes(`action="/facturi/${F1}/valideaza"`));

  let r = await cer("post", `/facturi/${F1}/valideaza`, FARA);
  egal("fără bifă, validarea e refuzată și factura rămâne ciornă", [r.cod, /Fără drepturi de facturare/.test(r.corp), factura(F1).status, factura(F1).numar], [403, true, "ciorna", null]);
  r = await cer("post", `/facturi/${F1}/valideaza`, DOAR_FIN);
  egal("…la fel doar cu „Financiar”", [r.cod, factura(F1).status], [403, "ciorna"]);
  r = await cer("post", `/facturi/${F1}/valideaza`, null);
  egal("…și fără cont", [r.cod, factura(F1).status], [403, "ciorna"]);
  egal("un refuz nu mișcă stocul", Number(unul(`SELECT COUNT(*) FROM miscari_stoc WHERE produs_id = ${PROD}`)), 0);

  r = await cer("post", `/facturi/${F1}/valideaza`, GABI);
  const f1 = factura(F1);
  egal("Gabi validează: factura e emisă, cu număr și cu numele ei pe validare", [r.cod, unde(r).split("?")[0], f1.status, Number(f1.numar) > 0, Number(f1.validata_de)], [302, `/facturi/${F1}`, "emisa", true, U_GABI]);
  egal("…și stocul a scăzut cu ce era pe factură", q(`SELECT tip, cantitate FROM miscari_stoc WHERE produs_id = ${PROD}`).map((x) => [x.tip, Number(x.cantitate)]), [["iesire", 3]]);
  r = await cer("post", `/facturi/${F2}/valideaza`, CONTABIL);
  egal("rolul financiar validează ca până acum", [r.cod, factura(F2).status], [302, "emisa"]);

  console.log("\n4. Utilizatori");
  q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol, sectiuni, activ) VALUES (${U_GABI}, 'Gabi Test', 'gabi@test-facturare.ro', 'x', 'y', 'depozit', '/crm,/comenzi,/depozit,/avize', 1)`);
  p = await cer("get", `/admin/utilizatori/${U_GABI}/editare`, ADMIN);
  bine("formularul are bifa „Facturare”, nebifată", /<input type="checkbox" name="sectiuni" value="\/facturi">\s*<span>Facturare \(emite facturi\)/.test(p.corp), p.cod);
  bine("…și pe cele deja date, bifate", /name="sectiuni" value="\/avize" checked/.test(p.corp));

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
