"use strict";
// Mai multe adrese de livrare pe același client.
//
// CEREREA LUI VALI, 26.11.2026: „Un client să poată avea mai multe adrese de
// livrare, iar la comandă selectezi adresa de livrare."
//
// CE APĂRĂ:
//   • pe fișa clientului se adaugă și se scot adrese de livrare; aceeași
//     adresă nu intră de două ori (nici scrisă puțin altfel, nici când e
//     adresa firmei sau cea de livrare de pe fișă);
//   • la comandă, lista din care se alege are TOATE adresele clientului, cu
//     numele lor; cea de pe fișă rămâne prima (cea completată singură);
//   • o adresă scoasă nu mai apare la alegere, dar comanda plasată cu ea
//     rămâne cu adresa ei;
//   • bifa „ține minte adresa asta la client": adresa scrisă pe comandă intră
//     în lista clientului; nebifată, nu; adresa deja știută nu se dublează.
const fs = require("fs");
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
for (const m of ["comenzi", "parteneri"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98411, nume: "Vali Test", rol: "admin", email: "v.adl@test.ro" };
const AGENT = { id: 98412, nume: "Gabriela Test", rol: "vanzari", email: "g.adl@test.ro" };

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

const ADRL = require(path.join(RAD, "lib", "adrese-livrare.js"));
const LL = require(path.join(RAD, "lib", "livrare-la.js"));
const P1 = 98401, P2 = 98402;
function curata() {
  for (const s of [
    `DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (${P1}, ${P2}))`,
    `DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (${P1}, ${P2}))`,
    `DELETE FROM emailuri WHERE partener_id IN (${P1}, ${P2})`,
    `DELETE FROM comenzi WHERE partener_id IN (${P1}, ${P2})`,
    `DELETE FROM interactiuni WHERE partener_id IN (${P1}, ${P2})`,
    `DELETE FROM parteneri_adrese_livrare WHERE partener_id IN (${P1}, ${P2})`,
    `DELETE FROM parteneri WHERE id IN (${P1}, ${P2})`,
    "DELETE FROM produse WHERE id = 98421",
    "DELETE FROM utilizatori WHERE id BETWEEN 98411 AND 98419",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const adrese = (p) => q("SELECT denumire, adresa, activ FROM parteneri_adrese_livrare WHERE partener_id = ? ORDER BY id", [p]).map((r) => [r.denumire, r.adresa, Number(r.activ)]);
const corp = (partener, extra) => Object.assign({ partener_id: String(partener), numar: "", livrare_partiala: "nu", livrare_mod: "intern", branding: "nepersonalizat", moneda: "RON", termen_plata_zile: "", "produs_id[]": ["98421"], "cantitate[]": ["2"], "pret_unitar[]": ["10"], "um[]": ["buc"] }, extra || {});
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/comenzi\/(\d+)/) || [])[1] || 0);
const json = async (partener) => JSON.parse((await cer("/comenzi/livrare-la.json", { query: { partener: String(partener) } })).corp || "{}");
const mesaj = (r) => decodeURIComponent((String(locatie(r)).match(/adresa_livrare_eroare=([^#&]*)/) || [])[1] || "");

(async () => {
  console.log("── Fără bază ────────────────────────────────────────────────");
  egal("adresa din formular: curățată, cu numele ei", ADRL.dinFormular({ denumire: "  Depozit   Cluj ", adresa: " Str. Fabricii  12,\n Cluj-Napoca " }, []), { ok: true, denumire: "Depozit Cluj", adresa: "Str. Fabricii 12, Cluj-Napoca" });
  egal("fără adresă, prea lungă, nume prea lung: refuzate cu mesaj", [/Scrie adresa/.test(ADRL.dinFormular({ denumire: "X" }, []).eroare), /prea lungă/.test(ADRL.dinFormular({ adresa: "a".repeat(401) }, []).eroare), /Numele adresei/.test(ADRL.dinFormular({ adresa: "a", denumire: "n".repeat(61) }, []).eroare)], [true, true, true]);
  egal("aceeași adresă scrisă puțin altfel nu intră a doua oară", [ADRL.dinFormular({ adresa: "STR. FABRICII, 12 — Cluj-Napoca" }, ["Str. Fabricii 12, Cluj-Napoca"]).eroare, ADRL.eDeja("", ["x"]), ADRL.eDeja("Altă stradă 1", ["Str. Fabricii 12"])], ["Clientul are deja adresa asta de livrare.", false, false]);
  const o = LL.optiuni({ adresa: "Str. Lungă 5", localitate: "Craiova", adresa_livrare: "Depozit Nord, Pitești" }, [], [{ denumire: "Magazin Unirii", adresa: "Bd. Unirii 10, București" }, { denumire: "", adresa: "Hala 2, Brașov" }, { denumire: "Dublura", adresa: "depozit nord pitesti" }]);
  egal("la alegere: întâi adresa de livrare de pe fișă, apoi a firmei, apoi celelalte cu numele lor; dublura nu apare", [o.adrese.map((a) => [a.fel, a.text]), o.implicit.livrare_adresa], [[["adresa de livrare", "Depozit Nord, Pitești"], ["adresa firmei", "Str. Lungă 5, Craiova"], ["Magazin Unirii", "Bd. Unirii 10, București"], ["adresă de livrare", "Hala 2, Brașov"]], "Depozit Nord, Pitești"]);
  const b = LL.bloc({}, { completeaza: true });
  bine("formularul de comandă are lista „Alege adresa de livrare”, alegerea „altă adresă” și bifa „ține minte”", b.includes("data-livrare-la-select") && b.includes("Alege adresa de livrare") && b.includes("altă adresă — o scriu mai jos") && /name="livrare_tine_minte" value="1"/.test(b));
  bine("…iar bifa rămâne pusă la un formular întors cu greșeli", /name="livrare_tine_minte" value="1" checked/.test(LL.bloc({ livrare_tine_minte: "1" }, { completeaza: true })));

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98411,'Vali Test','v.adl@test.ro','x','y','admin')",
    `INSERT INTO parteneri (id, nume, cui, tip, adresa, localitate, judet, adresa_livrare, telefon) VALUES (${P1}, 'ADL-TEST Client SRL', 'RO98401', 'client', 'Str. Lungă 5', 'Craiova', 'Dolj', 'Depozit Nord, Pitești', '0722')`,
    `INSERT INTO parteneri (id, nume, cui, tip, adresa) VALUES (${P2}, 'ADL-TEST Altul SRL', 'RO98402', 'client', 'Bd. Mare 1, Arad')`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (98421,'ADL-1','Produs ADL','buc',10,21)",
  ]) exec(s);

  console.log("\n── Pe fișa clientului ───────────────────────────────────────");
  let r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { denumire: "Magazin Unirii", adresa: "Bd. Unirii 10, București" } });
  egal("adresa adăugată se scrie pe client și fișa o confirmă", [/adresa_livrare=adaugata/.test(locatie(r)), adrese(P1)], [true, [["Magazin Unirii", "Bd. Unirii 10, București", 1]]]);
  r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { denumire: "", adresa: "Hala 2, Brașov" } });
  egal("a doua adresă, fără nume", adrese(P1).length, 2);
  r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { denumire: "Iar", adresa: "bd unirii 10 bucuresti" } });
  egal("aceeași adresă a doua oară: refuzată cu mesaj, nimic scris", [mesaj(r), adrese(P1).length], ["Clientul are deja adresa asta de livrare.", 2]);
  r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { denumire: "Sediu", adresa: "Str. Lungă 5, Craiova, Jud. Dolj" } });
  const r2 = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { adresa: "DEPOZIT NORD PITEȘTI" } });
  egal("adresa firmei și adresa de livrare de pe fișă nu se adaugă încă o dată", [mesaj(r), mesaj(r2), adrese(P1).length], ["Clientul are deja adresa asta de livrare.", "Clientul are deja adresa asta de livrare.", 2]);
  r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { denumire: "Gol", adresa: "   " } });
  egal("fără adresă: refuzată", [/Scrie adresa/.test(mesaj(r)), adrese(P1).length], [true, 2]);
  r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: "999999999" }, body: { adresa: "X" } });
  egal("client care nu există: nu se scrie nimic", Number(q("SELECT COUNT(*) AS n, 1 AS x FROM parteneri_adrese_livrare WHERE partener_id = 999999999")[0].n), 0);
  r = await cer("/parteneri/:id", { params: { id: String(P1) } });
  const cutie = String(r.corp).split("data-adrese-livrare")[1] || "";
  const txt = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("fișa arată toate adresele: cea de pe fișă și cele două adăugate, cu „Scoate” și formularul de adăugat", r.cod === 200 && txt(cutie).includes("Adrese de livrare (3)") && txt(cutie).includes("adresa de livrare Depozit Nord, Pitești") && txt(cutie).includes("Magazin Unirii Bd. Unirii 10, București") && txt(cutie).includes("adresă de livrare Hala 2, Brașov") && (cutie.match(/\/adrese-livrare\/\d+\/scoate/g) || []).length === 2 && cutie.includes(`action="/parteneri/${P1}/adrese-livrare"`), txt(cutie).slice(0, 400));
  r = await cer("/parteneri/:id", { params: { id: String(P2) } });
  bine("client cu livrarea „aceeași” și fără alte adrese: o singură adresă, a firmei", txt(String(r.corp).split("data-adrese-livrare")[1] || "").includes("Adrese de livrare (1)") && txt(String(r.corp).split("data-adrese-livrare")[1] || "").includes("adresa firmei (și de livrare) Bd. Mare 1, Arad"));

  console.log("\n── La comandă ───────────────────────────────────────────────");
  let j = await json(P1);
  egal("lista de la comandă: toate cele patru adrese ale clientului; cea de pe fișă e cea completată singură", [j.adrese.map((a) => [a.fel, a.text]), j.implicit.livrare_adresa], [[["adresa de livrare", "Depozit Nord, Pitești"], ["adresa firmei", "Str. Lungă 5, Craiova, Jud. Dolj"], ["Magazin Unirii", "Bd. Unirii 10, București"], ["adresă de livrare", "Hala 2, Brașov"]], "Depozit Nord, Pitești"]);
  egal("adresele unui client nu apar la altul", (await json(P2)).adrese.map((a) => a.text), ["Bd. Mare 1, Arad"]);
  r = await cer("/comenzi", { metoda: "post", body: corp(P1, { livrare_adresa: "Bd. Unirii 10, București", livrare_contact: "", livrare_telefon: "0722", livrare_email: "" }) });
  const c1 = idDinLocatie(r);
  egal("comandă cu a treia adresă aleasă: pe comandă rămâne ea", [c1 > 0, (q("SELECT livrare_adresa FROM comenzi WHERE id = ?", [c1])[0] || {}).livrare_adresa], [true, "Bd. Unirii 10, București"]);

  console.log("\n── „Ține minte adresa asta la client” ───────────────────────");
  r = await cer("/comenzi", { metoda: "post", body: corp(P1, { livrare_adresa: "Șantier Calea Severinului 40", livrare_contact: "", livrare_telefon: "", livrare_email: "" }) });
  egal("adresă scrisă de mână, fără bifă: rămâne doar pe comandă", [idDinLocatie(r) > 0, adrese(P1).length], [true, 2]);
  r = await cer("/comenzi", { metoda: "post", body: corp(P1, { livrare_adresa: "Șantier Calea Severinului 40", livrare_contact: "", livrare_telefon: "", livrare_email: "", livrare_tine_minte: "1" }) });
  const c3 = idDinLocatie(r);
  egal("cu bifa: adresa intră printre ale clientului și apare la următoarea comandă", [c3 > 0, adrese(P1).slice(2), (await json(P1)).adrese.map((a) => a.text).includes("Șantier Calea Severinului 40")], [true, [[null, "Șantier Calea Severinului 40", 1]], true]);
  r = await cer("/comenzi", { metoda: "post", body: corp(P1, { livrare_adresa: "santier calea severinului 40", livrare_contact: "", livrare_telefon: "", livrare_email: "", livrare_tine_minte: "1" }) });
  const r3 = await cer("/comenzi", { metoda: "post", body: corp(P1, { livrare_adresa: "Depozit Nord, Pitești", livrare_contact: "", livrare_telefon: "", livrare_email: "", livrare_tine_minte: "1" }) });
  egal("bifa pe o adresă pe care clientul o are deja: comanda se face, adresa nu se dublează", [idDinLocatie(r) > 0, idDinLocatie(r3) > 0, adrese(P1).length], [true, true, 3]);
  const mod = (partener, extra) => Object.assign(corp(partener, extra), { "pret_exact[]": ["10"], motiv: "test" });
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod(P1, { livrare_adresa: "Punct de lucru Bragadiru", livrare_contact: "", livrare_telefon: "0722", livrare_email: "", livrare_tine_minte: "1" }) });
  egal("la modificarea comenzii, cu bifa: adresa nouă se scrie pe comandă și se ține minte la client", [(q("SELECT livrare_adresa FROM comenzi WHERE id = ?", [c1])[0] || {}).livrare_adresa, adrese(P1).map((a) => a[1]).includes("Punct de lucru Bragadiru")], ["Punct de lucru Bragadiru", true]);

  console.log("\n── Scoasă de pe fișă ────────────────────────────────────────");
  const idSantier = Number(q("SELECT id FROM parteneri_adrese_livrare WHERE partener_id = ? AND adresa LIKE 'Șantier%'", [P1])[0].id);
  r = await cer("/parteneri/:id/adrese-livrare/:adresa/scoate", { metoda: "post", params: { id: String(P2), adresa: String(idSantier) } });
  egal("nu se poate scoate adresa altui client", Number(q("SELECT activ FROM parteneri_adrese_livrare WHERE id = ?", [idSantier])[0].activ), 1);
  r = await cer("/parteneri/:id/adrese-livrare/:adresa/scoate", { metoda: "post", params: { id: String(P1), adresa: String(idSantier) } });
  j = await json(P1);
  egal("scoasă: nu mai apare la alegere, rândul rămâne ca urmă, iar comanda plasată cu ea își păstrează adresa", [/adresa_livrare=scoasa/.test(locatie(r)), j.adrese.map((a) => a.text).includes("Șantier Calea Severinului 40"), Number(q("SELECT activ FROM parteneri_adrese_livrare WHERE id = ?", [idSantier])[0].activ), (q("SELECT livrare_adresa FROM comenzi WHERE id = ?", [c3])[0] || {}).livrare_adresa], [true, false, 0, "Șantier Calea Severinului 40"]);
  r = await cer("/parteneri/:id/adrese-livrare", { metoda: "post", params: { id: String(P1) }, body: { denumire: "Șantier", adresa: "Șantier Calea Severinului 40" } });
  egal("o adresă scoasă se poate adăuga din nou", [/adresa_livrare=adaugata/.test(locatie(r)), adrese(P1).filter((a) => a[2] === 1 && /Severinului/.test(a[1])).length], [true, 1]);

  console.log("\n── În browser: alegerea din listă ───────────────────────────");
  {
    const { chromium } = require("playwright");
    const br = await chromium.launch();
    const pg = await br.newPage();
    const date = { adrese: [{ text: "Depozit Nord, Pitești", fel: "adresa de livrare" }, { text: "Str. Lungă 5, Craiova", fel: "adresa firmei" }, { text: "Bd. Unirii 10, București", fel: "Magazin Unirii" }], contacte: [], implicit: { livrare_adresa: "Depozit Nord, Pitești", livrare_contact: "", livrare_telefon: "0722", livrare_email: "" } };
    await pg.route("**/comenzi/livrare-la.json*", (ruta) => ruta.fulfill({ contentType: "application/json", body: JSON.stringify(date) }));
    await pg.route("**/pagina", (ruta) => ruta.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><form><input name="partener_id" value="">${LL.bloc({}, { completeaza: true })}</form>` }));
    await pg.goto("http://adl.test/pagina");
    const stare = () => pg.evaluate(() => ({ lista: getComputedStyle(document.querySelector("[data-livrare-la-alege]")).display !== "none", ales: document.querySelector("[data-livrare-la-select]").value, optiuni: [...document.querySelectorAll("[data-livrare-la-select] option")].map((o) => o.textContent), adresa: document.querySelector('[name="livrare_adresa"]').value, tine: getComputedStyle(document.querySelector("[data-livrare-la-tine]")).display !== "none", bifat: document.querySelector('[name="livrare_tine_minte"]').checked }));
    egal("până se alege clientul, lista de adrese și bifa nu se văd", [(await stare()).lista, (await stare()).tine], [false, false]);
    await pg.evaluate(() => document.querySelector("form").dispatchEvent(new CustomEvent("client-ales", { detail: { id: 7 } })));
    await pg.waitForFunction(() => document.querySelector('[name="livrare_adresa"]').value !== "");
    egal("client ales: lista are cele trei adrese și „altă adresă”, e aleasă cea de pe fișă, câmpul e completat cu ea", await stare(), { lista: true, ales: "0", optiuni: ["adresa de livrare: Depozit Nord, Pitești", "adresa firmei: Str. Lungă 5, Craiova", "Magazin Unirii: Bd. Unirii 10, București", "altă adresă — o scriu mai jos"], adresa: "Depozit Nord, Pitești", tine: false, bifat: false });
    await pg.selectOption("[data-livrare-la-select]", "2");
    egal("aleasă a treia adresă din listă: câmpul o ia", [(await stare()).adresa, (await stare()).ales, (await stare()).tine], ["Bd. Unirii 10, București", "2", false]);
    await pg.selectOption("[data-livrare-la-select]", "alta");
    await pg.fill('[name="livrare_adresa"]', "Șantier Calea Severinului 40");
    egal("„altă adresă” și una scrisă de mână: apare bifa „ține minte adresa asta la client”", [(await stare()).ales, (await stare()).tine], ["alta", true]);
    await pg.check('[name="livrare_tine_minte"]');
    await pg.fill('[name="livrare_adresa"]', "str. lunga 5 craiova");
    egal("scrisă de mână o adresă pe care clientul o are: lista o recunoaște, iar bifa dispare și se scoate", [(await stare()).ales, (await stare()).tine, (await stare()).bifat], ["1", false, false]);
    await br.close();
  }

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
