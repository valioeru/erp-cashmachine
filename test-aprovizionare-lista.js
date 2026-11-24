"use strict";
// „De aprovizionat": cererile care așteaptă marfa nu mai ies din pagină.
//
// ÎNTREBAREA LUI VALI, 24.11.2026: „La comandă nouă cu produs care nu se
// regăsește în depozit și așteaptă marfă, unde o mai găsesc apoi? Că dispare
// cumva."
//
// CE ERA: pagina arăta ultimele 300 de cereri, deschise și închise la un loc,
// în ordinea în care au fost făcute. O cerere deschisă mai veche se pierdea
// printre cele închise și, după a 300-a, nu mai apărea deloc.
//
// CE APĂRĂ: tot ce așteaptă e sus, oricâte cereri închise au venit după; cele
// mai grabnice întâi; cele închise stau separat; refuzata rămâne sus cât
// comanda ei n-are marfa.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
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
for (const m of ["warehouse"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98411, nume: "Vali Test", rol: "admin", email: "v.ap@test.ro" };
const AGENT = { id: 98412, nume: "Gabriela Test", rol: "vanzari", email: "g.ap@test.ro" };

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
    "DELETE FROM aprovizionari WHERE produs_id BETWEEN 98421 AND 98429",
    "DELETE FROM comenzi_linii WHERE comanda_id BETWEEN 984001 AND 984009",
    "DELETE FROM comenzi WHERE id BETWEEN 984001 AND 984009",
    "DELETE FROM parteneri WHERE id IN (98401, 98402)",
    "DELETE FROM produse WHERE id BETWEEN 98421 AND 98429",
    "DELETE FROM utilizatori WHERE id BETWEEN 98411 AND 98419",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const text = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// Rândurile cu produsele testului, din fiecare parte a paginii, în ordine.
function parti(html) {
  const deschise = (String(html).match(/<div id="aprov-deschise">[\s\S]*?<\/table>/) || [""])[0];
  const inchise = (String(html).match(/<details[^>]*data-aprov-inchise[\s\S]*?<\/details>/) || [""])[0];
  const ale = (h) => (h.match(/<tr[\s\S]*?<\/tr>/g) || []).map((tr) => (text(tr).match(/AP-TEST (\S+)/) || [])[1]).filter(Boolean);
  return { deschise: ale(deschise), inchise: ale(inchise) };
}

(async () => {
  curata();
  const azi = new Date().toISOString().slice(0, 10);
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98411,'Vali Test','v.ap@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (98401, 'AP-CLIENT Unu SRL', 'RO98401', 'client'), (98402, 'AP-FURNIZOR SRL', 'RO98402', 'furnizor')",
    "INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (98421,'AP-1','AP-TEST veche-deschisa','buc'), (98422,'AP-2','AP-TEST inchisa','buc'), (98423,'AP-3','AP-TEST fara-termen','buc'), (98424,'AP-4','AP-TEST grabnica','buc'), (98425,'AP-5','AP-TEST refuzata-asteapta','buc'), (98426,'AP-6','AP-TEST refuzata-livrata','buc'), (98427,'AP-7','AP-TEST de-preluat','buc'), (98428,'AP-8','AP-TEST pentru-stoc','buc')",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, moneda) VALUES (984001, 98401, 'AP-CMD-1', '2026-11-04', 'asteapta_marfa', 'RON'), (984002, 98401, 'AP-CMD-2', '2026-11-05', 'livrata', 'RON')",
    // Cea mai veche: cererea care așteaptă marfa pentru comanda de pe 04.11.
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, furnizor_id, termen_cerut, status, cerut_de) VALUES (984001, 98421, 60, 'tert', 98402, '2099-03-10', 'confirmata', 'Vali')",
  ]) exec(s);
  // După ea, 320 de cereri închise — mai multe decât arăta pagina cu totul.
  exec("INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, status, cerut_de) SELECT 984002, 98422, 1, 'productie', '2099-01-01', CASE WHEN g % 3 = 0 THEN 'anulata' ELSE 'primita' END, 'Vali' FROM generate_series(1, 320) g");
  for (const s of [
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, status, cerut_de) VALUES (984001, 98424, 5, 'productie', '2099-01-05', 'ceruta', 'Vali')",
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, status, cerut_de) VALUES (984001, 98423, 5, 'tert', NULL, 'ceruta', 'Vali')",
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, status, cerut_de) VALUES (984001, 98425, 5, 'productie', '2099-02-01', 'refuzata', 'Vali')",
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, status, cerut_de) VALUES (984002, 98426, 5, 'productie', '2099-02-01', 'refuzata', 'Vali')",
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, termen_confirmat, status, cerut_de) VALUES (984001, 98427, 5, 'productie', '2099-06-01', '2099-01-20', 'gata', 'Vali')",
    "INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, termen_cerut, status, cerut_de) VALUES (NULL, 98428, 5, 'tert', '2099-04-01', 'ceruta', 'Vali')",
  ]) exec(s);

  const r = await cer("/depozit/aprovizionare");
  const p = parti(r.corp);
  bine("pagina se deschide", r.cod === 200, r.cod);
  bine("cererea veche care așteaptă marfa e pe pagină, deși după ea au venit 320 de cereri închise", p.deschise.includes("veche-deschisa"), p.deschise.join(","));
  egal("sus stau doar cele care așteaptă, cele mai grabnice întâi: fără termen, apoi după termenul confirmat (altfel cel cerut)", p.deschise, ["fara-termen", "grabnica", "de-preluat", "refuzata-asteapta", "veche-deschisa", "pentru-stoc"]);
  bine("refuzata rămâne sus cât comanda ei așteaptă marfa; cea a unei comenzi livrate e la închise", p.deschise.includes("refuzata-asteapta") && !p.deschise.includes("refuzata-livrata") && p.inchise.includes("refuzata-livrata"));
  bine("cele închise nu se amestecă printre cele deschise și stau strânse, cel mult 200", !p.deschise.includes("inchisa") && p.inchise.length === 200 && /<details[^>]*data-aprov-inchise="200"/.test(r.corp), p.inchise.length);
  const nDeschise = Number((r.corp.match(/data-aprov-deschise="(\d+)"/) || [])[1]);
  const inBaza = Number(q("SELECT COUNT(*) AS n, 1 AS x FROM aprovizionari a JOIN produse p ON p.id = a.produs_id LEFT JOIN comenzi c ON c.id = a.comanda_id WHERE a.status IN ('ceruta','confirmata','gata') OR (a.status = 'refuzata' AND c.status IN ('noua','confirmata','asteapta_marfa'))")[0].n);
  egal("titlul numără toate cererile care așteaptă, câte sunt în bază", nDeschise, inBaza);
  bine("pagina are căutarea și spune ce e sus", r.corp.includes('id="cauta-aprov"') && text(r.corp).includes("Așteaptă marfa —") && text(r.corp).includes("Închise — ultimele 200"));
  bine("cererea deschisă își păstrează acțiunile (intră în stoc, anulează), legătura spre comandă și clientul", /AP-TEST veche-deschisa[\s\S]{0,2500}\/depozit\/aprovizionare\/\d+\/primita/.test(r.corp) && r.corp.includes("AP-CMD-1") && r.corp.includes("AP-CLIENT Unu SRL"));

  exec("UPDATE aprovizionari SET status = 'primita' WHERE produs_id IN (98421, 98423, 98424, 98425, 98427, 98428)");
  const r2 = await cer("/depozit/aprovizionare");
  const p2 = parti(r2.corp);
  bine("după ce intră în stoc, cererea coboară la închise", !p2.deschise.includes("veche-deschisa") && p2.inchise.includes("grabnica"));

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
