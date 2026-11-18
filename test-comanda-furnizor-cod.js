"use strict";
// Codul produsului pe pagina comenzii către furnizor.
//
// CEREREA LUI VALI, 18.11.2026 (cu poza comenzii CF-2026-0003): „Putem pune și
// cod produs aici, te rog."
//
// CE APĂRĂ: codul stă în coloana lui, la poziții și la recepție; produsul din
// configurator (fără `cod`) își arată codul generat; poziția scrisă de mână,
// fără produs din nomenclator, spune că n-are cod și trimite la „Modifică";
// codul ajunge și pe PDF.
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

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi-furnizor"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97911, nume: "Vali Test", rol: "admin", email: "v.cf@test.ro" };
const AGENT = { id: 97912, nume: "Gabriela Test", rol: "vanzari", email: "g.cf@test.ro" };

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
    "DELETE FROM comenzi_furnizor_linii WHERE comanda_id = 979001",
    "DELETE FROM comenzi_furnizor WHERE id = 979001",
    "DELETE FROM parteneri WHERE id = 97901",
    "DELETE FROM produse WHERE id IN (97921, 97922, 97923)",
    "DELETE FROM utilizatori WHERE id BETWEEN 97911 AND 97919",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97911,'Vali Test','v.cf@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (97901, 'CF-TEST Furnizor SRL', 'RO97901', 'furnizor')",
    "INSERT INTO produse (id, cod, cod_generat, denumire, unitate_masura) VALUES (97921,'ROTA-17','GEN-NU','Folie jumbo 17my CF','kg'), (97922,'  ','FS-J-15-GEN','Folie jumbo 15my CF','kg'), (97923,NULL,NULL,'Folie fara cod CF','kg')",
    "INSERT INTO comenzi_furnizor (id, numar, furnizor_id, data, status, moneda, creata_de) VALUES (979001, 'CF-TEST-1', 97901, '2026-11-18', 'ciorna', 'EUR', 97911)",
    "INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, um, pret_unitar) VALUES (979001, 97921, 'Folie jumbo 17my CF', 100, 'kg', 2), (979001, 97922, 'Folie jumbo 15my CF', 50, 'kg', 2), (979001, 97923, 'Folie fara cod CF', 10, 'kg', 2), (979001, NULL, 'Folie scrisa <de> mana', 5, 'kg', 2)",
  ]) exec(s);

  const r = await cer("/procurement/comenzi/:id", { params: { id: "979001" } });
  if (r.cod !== 200) console.log(String(r.corp).slice(0, 400));
  const tabele = String(r.corp).match(/<table[\s\S]*?<\/table>/g) || [];
  const pozitii = tabele.find((t) => /Față de ultima/.test(t)) || "";
  const receptie = tabele.find((t) => /Primit până acum/.test(t)) || "";
  const celule = (t) => (t.match(/<tr[\s\S]*?<\/tr>/g) || []).slice(1).map((tr) => ((tr.match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  egal("pagina se deschide și tabelul de poziții începe cu „Cod”, apoi „Poziție”", [r.cod, (pozitii.match(/<th\b[^>]*>[^<]*/g) || []).slice(0, 2).map((x) => x.replace(/<th\b[^>]*>/, ""))], [200, ["Cod", "Poziție"]]);
  egal("codul fiecărei poziții: cel scris pe produs; cel generat, când `cod` e gol; „produs fără cod”; poziția scrisă de mână",
    celule(pozitii), ["ROTA-17", "FS-J-15-GEN", "produs fără cod", "scrisă de mână, fără produs alege produsul"]);
  bine("poziția scrisă de mână trimite la „Modifică”, iar denumirea ei rămâne scăpată", pozitii.includes('href="/procurement/comenzi/979001/modifica"') && pozitii.includes("Folie scrisa &lt;de&gt; mana") && !pozitii.includes("<de>"));
  bine("codul nu mai e scris a doua oară sub denumire", !/>cod ROTA-17</.test(pozitii));
  egal("tabelul de recepție are și el coloana „Cod”, cu aceleași coduri", [(receptie.match(/<th>([^<]*)</) || [])[1], celule(receptie)], ["Cod", ["ROTA-17", "FS-J-15-GEN", "—", "—"]]);
  bine("recepția își păstrează câmpurile pe fiecare rând", (receptie.match(/name="primit\[\]"/g) || []).length === 4 && (receptie.match(/name="paleti_nr\[\]"/g) || []).length === 4);
  const pdf = await cer("/procurement/comenzi/:id/pdf", { params: { id: "979001" }, query: { limba: "ro" } });
  bine("PDF-ul poartă codurile, și pe cel generat", pdf.cod === 200 && pdf.corp.includes('<td class="cod">ROTA-17</td>') && pdf.corp.includes('<td class="cod">FS-J-15-GEN</td>'));

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
