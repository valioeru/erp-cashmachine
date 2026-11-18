"use strict";
// Factura pe unitate protejată (UPA): bifa de pe comandă, seria și mențiunea.
//
// CEREREA LUI VALI, 17.11.2026: „Comanda trebuie să conțină și o bifă dacă
// factura va fi sau nu pe unitate protejată. Dacă va fi, va avea serie cu UPA;
// dacă nu, seria normală. Numărul va fi următorul la rând […]. Totodată,
// facturile cu UPA trebuie să conțină detaliile speciale."
//
// CE APĂRĂ:
//   • bifa se scrie pe comandă, se vede pe ea și se poate schimba la modificare;
//   • factura făcută din comandă (întreagă sau parțială) îi poartă bifa;
//   • în SmartBill, factura UPA pleacă pe seria UPA, cu mențiunea ei (cu numele
//     clientului); cea normală pleacă exact ca până acum, fără mențiune;
//   • factura UPA fără numele clientului nu pleacă;
//   • seria se poate îndrepta pe factură doar cât n-a plecat în SmartBill.
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

const UPA = require(path.join(RAD, "lib", "upa.js"));
const SB = require(path.join(RAD, "lib", "smartbill.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi", "facturi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97511, nume: "Vali Test", rol: "admin", email: "v.upa@test.ro" };
const AGENT = { id: 97512, nume: "Gabriela Test", rol: "vanzari", email: "g.upa@test.ro" };

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

const CLIENT = 97501, PRODUS = 97521;
function curata() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id = 97501)",
    "UPDATE comenzi SET factura_id = NULL WHERE partener_id = 97501",
    "DELETE FROM facturi WHERE partener_id = 97501",
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 97501)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 97501)",
    "DELETE FROM emailuri WHERE partener_id = 97501",
    "DELETE FROM comenzi WHERE partener_id = 97501",
    "DELETE FROM interactiuni WHERE partener_id = 97501",
    "DELETE FROM parteneri WHERE id = 97501",
    "DELETE FROM produse WHERE id = 97521",
    "DELETE FROM utilizatori WHERE id BETWEEN 97511 AND 97519",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const comanda = (id) => q("SELECT * FROM comenzi WHERE id = ?", [id])[0];
const factura = (id) => q("SELECT * FROM facturi WHERE id = ?", [id])[0];
const corp = (extra) => Object.assign({ partener_id: String(CLIENT), numar: "", livrare_partiala: "nu", livrare_mod: "intern", branding: "nepersonalizat", moneda: "RON", termen_plata_zile: "", "produs_id[]": [String(PRODUS)], "cantitate[]": ["5"], "pret_unitar[]": ["12"], "um[]": ["buc"] }, extra || {});
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/(\d+)(\?|$)/) || [])[1] || 0);

(async () => {
  console.log("── Seria și mențiunea, fără bază ────────────────────────────");
  egal("seria: UPA pentru factura bifată (din mediu sau CSHMUPA), cea normală din mediu sau lăsată pe seama SmartBill",
    [UPA.serie({ upa: 1 }, {}), UPA.serie({ upa: "1" }, { SMARTBILL_SERIE_UPA: " UPAX " }), UPA.serie({ upa: 0 }, { SMARTBILL_SERIE: "CSHM", SMARTBILL_SERIE_UPA: "UPAX" }), UPA.serie({}, {}), UPA.serie({ upa: 1 }, { SMARTBILL_SERIE: "CSHM" })],
    ["CSHMUPA", "UPAX", "CSHM", undefined, "CSHMUPA"]);
  const M = UPA.mentiune("AQUILA PART PROD COM S.A.");
  bine("mențiunea e cea de pe facturile UPA existente, cu numele clientului", M === "Produsele livrate catre AQUILA PART PROD COM S.A. sunt realizate prin activitatea proprie a personalului angajat al CASH MACHINE SRL, in cadrul Unitatii Protejate Autorizate, cu implicarea persoanelor cu dizabilitati/handicap angajate, acestea reprezentand minimum 50% din personalul implicat in activitatea aferenta a companiei, conform art. 78 alin. (3) lit. b) din Legea nr. 448/2006 privind protectia si promovarea drepturilor persoanelor cu handicap, cu modificarile si completarile ulterioare.", M);
  egal("pe pagină", [UPA.eticheta({ upa: 1 }), UPA.eticheta({ upa: 0 }), UPA.eUpa({ upa: "1" }), UPA.eUpa({}), UPA.eUpa(null)], ["unitate protejată (UPA)", "serie normală", true, false, false]);
  process.env.SMARTBILL_SERIE = "CSHM";
  const linii = [{ denumire: "Folie", cantitate: 2, pret_unitar: 10, cota_tva: 21, unitate_masura: "buc" }];
  const pUpa = SB.construiesteFactura({ partener_nume: "Client UPA SRL", upa: 1, moneda: "RON" }, linii, {});
  const pNorm = SB.construiesteFactura({ partener_nume: "Client UPA SRL", upa: 0, moneda: "RON" }, linii, {});
  egal("ce pleacă în SmartBill: factura UPA pe seria UPA, cu mențiunea; cea normală pe seria ei, fără mențiune", [pUpa.seriesName, pUpa.mentions === UPA.mentiune("Client UPA SRL"), pNorm.seriesName, "mentions" in pNorm && pNorm.mentions !== undefined], ["CSHMUPA", true, "CSHM", false]);
  let refuz = "";
  try { SB.construiesteFactura({ partener_nume: "  ", upa: 1 }, linii, {}); } catch (e) { refuz = e.message; }
  egal("factura UPA fără numele clientului nu pleacă (mențiunea ar ieși greșită); cea normală nu e atinsă de regula asta", [/nu poate pleca fără numele clientului/.test(refuz), typeof SB.construiesteFactura({ upa: 0 }, linii, {})], [true, "object"]);
  delete process.env.SMARTBILL_SERIE;

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97511,'Vali Test','v.upa@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (97501, 'UPA-TEST Client SRL', 'RO97501', 'client')",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97521,'UPA-1','Folie stretch pentru UPA','buc',10,21)",
  ]) exec(s);

  console.log("\n── Bifa pe comandă ──────────────────────────────────────────");
  let r = await cer("/comenzi/nou");
  bine("formularul de comandă are bifa, nebifată", /<input type="checkbox" name="upa" value="1" style/.test(r.corp) && r.corp.includes("unitate protejată (UPA)"));
  r = await cer("/comenzi", { metoda: "post", body: corp({ upa: "1" }) });
  const c1 = idDinLocatie(r);
  r = await cer("/comenzi", { metoda: "post", body: corp() });
  const c2 = idDinLocatie(r);
  egal("comanda bifată e scrisă ca UPA, cea nebifată nu", [c1 > 0 && c2 > 0, Number(comanda(c1).upa), Number(comanda(c2).upa)], [true, 1, 0]);
  const p1 = await cer("/comenzi/:id", { params: { id: String(c1) } });
  const p2 = await cer("/comenzi/:id", { params: { id: String(c2) } });
  const bucata = (h) => (String(h).match(/<div data-upa-comanda>[\s\S]*?<\/div>\s*<\/div>|<div data-upa-comanda>[\s\S]*?<\/div>[^<]*<\/div>/) || [""])[0];
  bine("pagina comenzii o spune", /unitate protejată \(UPA\)/.test(bucata(p1.corp)) && /serie normală/.test(bucata(p2.corp)) && !/unitate protejată/.test(bucata(p2.corp)), bucata(p1.corp) + " | " + bucata(p2.corp));
  r = await cer("/comenzi/:id/editare", { params: { id: String(c1) } });
  bine("la modificare bifa vine cum e pe comandă", /<input type="checkbox" name="upa" value="1" checked/.test(r.corp));
  const mod = (extra) => Object.assign(corp(extra), { "pret_exact[]": ["12"], motiv: "test" });
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod() });
  if (process.env.DBG) console.log("DBG", r.cod, locatie(r), String(r.corp).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").match(/.{0,200}(alerta|Motiv|motiv|trebuie|Spune).{0,200}/));
  egal("debifată la modificare: comanda trece pe seria normală, iar istoricul o scrie pe înțeles", [Number(comanda(c1).upa), q("SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ? AND ce = 'Factura'", [c1]).map((x) => [x.vechi, x.nou])], [0, [["unitate protejată (UPA)", "serie normală"]]]);
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod({ upa: "1" }) });
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod() });
  egal("bifată la loc; cea nebifată rămâne nebifată", [Number(comanda(c1).upa), Number(comanda(c2).upa)], [1, 0]);

  console.log("\n── Factura făcută din comandă ───────────────────────────────");
  exec(`UPDATE comenzi SET status = 'in_stoc_depozit' WHERE id IN (${c1}, ${c2})`);
  await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c1) } });
  await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c2) } });
  const f1 = q("SELECT * FROM facturi WHERE comanda_id = ?", [c1])[0];
  const f2 = q("SELECT * FROM facturi WHERE comanda_id = ?", [c2])[0];
  egal("factura din comanda UPA e UPA; cea din comanda normală, nu", [Boolean(f1 && f2), Number(f1 && f1.upa), Number(f2 && f2.upa)], [true, 1, 0]);
  let pf = await cer("/facturi/:id", { params: { id: String(f1.id) } });
  const seria = (h) => (String(h).match(/<div data-upa-factura>[\s\S]*?<\/form>/) || [""])[0];
  bine("pagina facturii UPA spune seria pe care pleacă și lasă trecerea pe seria normală", seria(pf.corp).includes("unitate protejată (UPA)") && seria(pf.corp).includes("pleacă pe CSHMUPA") && seria(pf.corp).includes(`action="/facturi/${f1.id}/upa"`) && seria(pf.corp).includes('name="upa" value="0"'), seria(pf.corp).slice(0, 400));
  pf = await cer("/facturi/:id", { params: { id: String(f2.id) } });
  bine("pagina facturii normale: „serie normală”, cu trecerea pe UPA", seria(pf.corp).includes("serie normală") && seria(pf.corp).includes('name="upa" value="1"') && !seria(pf.corp).includes("pleacă pe"), seria(pf.corp).slice(0, 400));
  await cer("/facturi/:id/upa", { metoda: "post", params: { id: String(f2.id) }, body: { upa: "1" } });
  await cer("/facturi/:id/upa", { metoda: "post", params: { id: String(f1.id) }, body: { upa: "0" } });
  egal("seria se îndreaptă pe factură cât n-a plecat", [Number(factura(f2.id).upa), Number(factura(f1.id).upa)], [1, 0]);
  exec(`UPDATE facturi SET smartbill_sync_la = '2026-11-17 10:00:00', smartbill_serie = 'CSHMUPA', smartbill_numar = '0099' WHERE id = ${f2.id}`);
  await cer("/facturi/:id/upa", { metoda: "post", params: { id: String(f2.id) }, body: { upa: "0" } });
  pf = await cer("/facturi/:id", { params: { id: String(f2.id) } });
  egal("după ce a plecat în SmartBill nu se mai schimbă, iar pagina arată seria cu care a plecat, fără buton", [Number(factura(f2.id).upa), /<div data-upa-factura><div class="k">Seria<\/div>CSHMUPA/.test(pf.corp), /action="\/facturi\/\d+\/upa"/.test(pf.corp)], [1, true, false]);
  exec(`UPDATE facturi SET sursa_import = 'smartbill', serie = 'CSHMUPA', numar = 86, upa = 0 WHERE id = ${f1.id}`);
  await cer("/facturi/:id/upa", { metoda: "post", params: { id: String(f1.id) }, body: { upa: "1" } });
  pf = await cer("/facturi/:id", { params: { id: String(f1.id) } });
  egal("factura adusă din SmartBill își arată seria ei și n-are buton: nu se mai trimite, deci n-are ce alege", [Number(factura(f1.id).upa), /<div data-upa-factura><div class="k">Seria<\/div>CSHMUPA/.test(pf.corp), /action="\/facturi\/\d+\/upa"/.test(pf.corp)], [0, true, false]);
  r = await cer("/facturi/:id/upa", { metoda: "post", params: { id: "999999999" }, body: { upa: "1" } });
  egal("factură care nu există: 404", r.cod, 404);

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
