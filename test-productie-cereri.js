"use strict";
// Confirmarea unei cereri venite din depozit. Pe PostgreSQL real (prin psql).
//
// DE CE EXISTA TESTUL ASTA: handlerul crapa cu „completate is not defined" la
// FIECARE confirmare — o ramasita de copy-paste dintr-un alt formular. Nu se
// vedea pentru ca singura dovada era o pagina alba si o linie in logul
// serverului, iar fluxul se foloseste rar. Vali l-a gasit apasand „Nu pot in
// termen".
//
// CE APARA:
//
//   • CONFIRMAREA MERGE. Si pe termenul cerut, si pe altul.
//   • LINIA COMENZII ARE PRODUSUL PE EA. „produs" se citea fara id, deci
//     linia se nastea cu produs_id gol si legatura cu nomenclatorul se
//     pierdea chiar in clipa in care se crea comanda.
//   • UN TERMEN MAI TARZIU CERE MOTIV, si motivul se pastreaza.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const mod = require(path.join(RAD, "modules", "productie.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, { params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const unde = (r) => decodeURIComponent((r.antet && r.antet.Location) || "");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 220) : "")); esecuri++; }
}

const ZI = 86400000;
const peste10 = new Date(Date.now() + 10 * ZI).toISOString().slice(0, 10);
const peste30 = new Date(Date.now() + 30 * ZI).toISOString().slice(0, 10);

function curata() {
  q("DELETE FROM comenzi_productie_caracteristici WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE observatii LIKE '%Cerere din depozit%')");
  q("DELETE FROM comenzi_productie_linii WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE observatii LIKE '%Cerere din depozit%')");
  q("DELETE FROM comenzi_productie WHERE observatii LIKE '%Cerere din depozit%'");
  q("DELETE FROM aprovizionari WHERE cerut_de = 'TEST-CERERI'");
}
function cerereNoua(termen) {
  const produs = Number(unul("SELECT id FROM produse ORDER BY id LIMIT 1"));
  q(`INSERT INTO aprovizionari (produs_id, cantitate, sursa, termen_cerut, status, cerut_de, creata_la)
     VALUES (${produs}, 10, 'productie', '${termen}', 'ceruta', 'TEST-CERERI', '2026-10-23')`);
  return q("SELECT * FROM aprovizionari WHERE cerut_de = 'TEST-CERERI' ORDER BY id DESC LIMIT 1")[0];
}

(async () => {
  curata();

  console.log("\n1. Confirmarea termenului cerut");
  {
    const a = cerereNoua(peste10);
    const r = await cer("/productie/cereri/:id/confirma", {
      metoda: "post", params: { id: String(a.id) }, body: { termen: peste10 },
    });
    bine("nu crapă, duce la comanda nouă", /\/productie\/\d+$/.test(unde(r)), unde(r));
    const d = q("SELECT * FROM aprovizionari WHERE id = " + a.id)[0];
    bine("cererea e confirmată", d.status === "confirmata" && d.termen_confirmat === peste10);
    const cp = q("SELECT * FROM comenzi_productie WHERE aprovizionare_id = " + a.id)[0];
    bine("s-a deschis comanda de producție", !!cp);
    bine("cu data cerută și cea propusă", cp.data_solicitata === peste10 && cp.data_propusa === peste10);
    // Bug-ul al doilea: produsul se citea fara id, deci linia se nastea goala.
    const linie = q("SELECT * FROM comenzi_productie_linii WHERE comanda_id = " + cp.id)[0];
    bine("linia există", !!linie);
    bine("și are produsul pe ea, nu NULL", linie && linie.produs_id !== null, linie && linie.produs_id);
    bine("cu denumirea scrisă", linie && !!linie.denumire);
  }

  console.log("\n2. „Nu pot în termen”: alt termen, cu motiv");
  {
    const a = cerereNoua(peste10);
    const r = await cer("/productie/cereri/:id/confirma", {
      metoda: "post", params: { id: String(a.id) }, body: { termen: peste30, motiv: "așteptăm granulă" },
    });
    bine("nu crapă", /\/productie\/\d+$/.test(unde(r)), unde(r));
    const d = q("SELECT * FROM aprovizionari WHERE id = " + a.id)[0];
    bine("se scrie termenul producției, nu cel cerut", d.termen_confirmat === peste30, d.termen_confirmat);
    bine("motivul rămâne", /așteptăm granulă/.test(d.raspuns || ""), d.raspuns);
    bine("și scrie cu câte zile s-a mutat", /amânat cu 20 zile/.test(d.raspuns || ""), d.raspuns);
    const cp = q("SELECT * FROM comenzi_productie WHERE aprovizionare_id = " + a.id)[0];
    bine("comanda se deschide cu data producției", cp.data_propusa === peste30 && cp.data_livrare === peste30);
    bine("dar ține minte ce s-a cerut", cp.data_solicitata === peste10, cp.data_solicitata);
  }

  console.log("\n3. Alt termen FĂRĂ motiv nu trece");
  {
    const a = cerereNoua(peste10);
    const r = await cer("/productie/cereri/:id/confirma", {
      metoda: "post", params: { id: String(a.id) }, body: { termen: peste30 },
    });
    bine("cererea rămâne necconfirmată", unul("SELECT status FROM aprovizionari WHERE id = " + a.id) === "ceruta");
    bine("nu s-a deschis nicio comandă", Number(unul("SELECT count(*) FROM comenzi_productie WHERE aprovizionare_id = " + a.id)) === 0);
    bine("și se spune de ce", /motivul/.test(unde(r)), unde(r));
  }

  console.log("\n4. Pagina de cereri se deschide și arată ambele butoane");
  {
    cerereNoua(peste10);
    const p = await cer("/productie/cereri");
    bine("pagina răspunde", p.cod === 200);
    bine("butonul de confirmare arată chiar data", new RegExp("Confirm " + peste10).test(p.corp) || /Confirm \d{2}\.\d{2}\.\d{4}/.test(p.corp), (p.corp.match(/Confirm [^<]{0,14}/) || [])[0]);
    bine("și există „Nu pot în termen”", /Nu pot în termen/.test(p.corp));
    bine("care cere și motivul", /name="motiv"/.test(p.corp));
    bine("refuzul total e separat și rar", /Nu putem face deloc/.test(p.corp));
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
