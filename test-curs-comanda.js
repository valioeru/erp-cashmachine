"use strict";
// Cursul comenzii de client: BNR-ul zilei sau cel pus de om, fixat pe comandă
// (lib/curs-comanda.js), și factura unei comenzi în euro, scrisă în lei.
//
// Cererea lui Vali, 17.11.2026: „La orice comandă, preț etc., din orice loc în
// tot sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul
// introdus sau BNR; odată plasat, așa rămâne în istoric și doar cele noi se
// schimbă."
//
// CE APĂRĂ:
//
//   • CURSUL SCRIS DE OM RĂMÂNE AL LUI; gol = BNR-ul zilei, cu data lui.
//   • ODATĂ PLASAT, NU SE MIȘCĂ SINGUR: o corectură de cantitate nu-l atinge
//     și nu scrie nimic despre curs în istoric.
//   • MONEDA SCHIMBATĂ IA BNR-UL MONEDEI NOI, nu cursul rămas în câmp.
//   • FACTURA UNEI COMENZI ÎN EURO SE SCRIE ÎN LEI, la cursul comenzii. Înainte
//     lua prețurile în euro drept lei. Fără curs, nu se facturează.
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

const CC = require(path.join(RAD, "lib", "curs-comanda.js"));
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
const ADMIN = { id: 97511, nume: "Vali Curs", rol: "admin", email: "v.cc@test.ro" };

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
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));

const CLIENT = 97501;
const PRODUS = 97521;
const azi = new Date().toISOString().slice(0, 10);

function curata() {
  for (const s of [
    "DELETE FROM ct_palet_linii WHERE palet_id IN (SELECT id FROM ct_paleti WHERE cod = 'CC-PALET-1')",
    "DELETE FROM ct_paleti WHERE cod = 'CC-PALET-1'",
    "DELETE FROM rezervari_stoc WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97501 AND 97509)",
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 97501 AND 97509)",
    "UPDATE comenzi SET factura_id = NULL WHERE partener_id BETWEEN 97501 AND 97509",
    "DELETE FROM facturi WHERE partener_id BETWEEN 97501 AND 97509",
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97501 AND 97509)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97501 AND 97509)",
    "DELETE FROM emailuri WHERE partener_id BETWEEN 97501 AND 97509",
    "DELETE FROM comenzi WHERE partener_id BETWEEN 97501 AND 97509",
    "DELETE FROM interactiuni WHERE partener_id BETWEEN 97501 AND 97509",
    "DELETE FROM parteneri WHERE id BETWEEN 97501 AND 97509",
    "DELETE FROM produse WHERE id BETWEEN 97521 AND 97529",
    "DELETE FROM utilizatori WHERE id BETWEEN 97511 AND 97519",
    // Cursurile puse de test pentru azi (cele adevărate au alt `luat_la`).
    "DELETE FROM cursuri_bnr WHERE luat_la = 'test-curs-comanda'",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const comanda = (id) => q("SELECT * FROM comenzi WHERE id = ?", [id])[0];
const istoric = (id) => q("SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id", [id]);
const corp = (moneda, curs, extra) =>
  Object.assign(
    { partener_id: String(CLIENT), numar: "", livrare_partiala: "nu", livrare_mod: "intern", branding: "nepersonalizat", moneda, curs,
      "produs_id[]": [String(PRODUS)], "cantitate[]": ["100"], "pret_unitar[]": ["1,2345"], "um[]": ["buc"] },
    extra || {}
  );
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/(\d+)(\?|$)/) || [])[1] || 0);

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97511,'Vali Curs','v.cc@test.ro','x','y','admin')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (97501,'CC CLIENT EURO SRL','RO-CC-1','client')`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97521,'CC-1','Folie stretch curs','buc',10,21)",
    // BNR-ul de azi, dacă baza de test nu-l are deja.
    `INSERT INTO cursuri_bnr (data, moneda, valoare, luat_la) VALUES ('${azi}','EUR',5.0912,'test-curs-comanda') ON CONFLICT (data, moneda) DO NOTHING`,
    `INSERT INTO cursuri_bnr (data, moneda, valoare, luat_la) VALUES ('${azi}','USD',4.6034,'test-curs-comanda') ON CONFLICT (data, moneda) DO NOTHING`,
  ]) exec(s);
  const bnr = (m) => { const x = q("SELECT valoare, data FROM cursuri_bnr WHERE moneda = ? AND data <= ? ORDER BY data DESC LIMIT 1", [m, azi])[0]; return { valoare: Number(x.valoare), data: x.data }; };
  const EUR = bnr("EUR"), USD = bnr("USD");

  // ===== 1. regulile, fără bază ==============================================
  console.log("\n── Regulile cursului ────────────────────────────────────────");
  const B = { valoare: 5.0912, data: "2026-11-17" };
  egal("lei: fără curs", CC.laPlasare({ moneda: "RON", scris: 5, bnr: B }), { curs: null, data: null, manual: 0 });
  egal("gol → BNR-ul zilei, cu data lui", CC.laPlasare({ moneda: "EUR", scris: null, bnr: B }), { curs: 5.0912, data: "2026-11-17", manual: 0 });
  egal("scris → al omului", CC.laPlasare({ moneda: "EUR", scris: 5.1, bnr: B }), { curs: 5.1, data: null, manual: 1 });
  egal("scris la fel ca BNR → rămâne BNR", CC.laPlasare({ moneda: "EUR", scris: 5.0912, bnr: B }), { curs: 5.0912, data: "2026-11-17", manual: 0 });
  egal("fără BNR și fără curs scris → nimic inventat", CC.laPlasare({ moneda: "EUR", scris: null, bnr: null }), { curs: null, data: null, manual: 0 });
  const C0 = { moneda: "EUR", curs_bnr: 4.9723, curs_bnr_data: "2026-10-27", curs_manual: 0 };
  egal("modificare, câmp neatins → cursul vechi", CC.laModificare({ comanda: C0, moneda: "EUR", scris: 4.9723, bnr: B }), { curs: 4.9723, data: "2026-10-27", manual: 0 });
  egal("modificare, alt curs scris → al omului", CC.laModificare({ comanda: C0, moneda: "EUR", scris: 5, bnr: B }), { curs: 5, data: null, manual: 1 });
  egal("altă monedă, câmp rămas pe cursul vechi → BNR-ul monedei noi", CC.laModificare({ comanda: C0, moneda: "USD", scris: 4.9723, bnr: { valoare: 4.6, data: "2026-11-17" } }), { curs: 4.6, data: "2026-11-17", manual: 0 });
  egal("înapoi pe lei → fără curs", CC.laModificare({ comanda: C0, moneda: "RON", scris: 4.7, bnr: B }), { curs: null, data: null, manual: 0 });
  const CM = { moneda: "EUR", curs_bnr: 5.25, curs_bnr_data: null, curs_manual: 1 };
  egal("câmpul golit de om → BNR-ul zilei, și peste un curs pus de om", [CC.laModificare({ comanda: CM, moneda: "EUR", scris: null, bnr: B, golit: true }), CC.laModificare({ comanda: C0, moneda: "EUR", scris: null, bnr: B, golit: true })],
    [{ curs: 5.0912, data: "2026-11-17", manual: 0 }, { curs: 5.0912, data: "2026-11-17", manual: 0 }]);
  egal("câmpul golit, dar BNR-ul nu răspunde → rămâne cursul comenzii", CC.laModificare({ comanda: CM, moneda: "EUR", scris: null, bnr: null, golit: true }), { curs: 5.25, data: null, manual: 1 });
  egal("câmpul netrimis (formular vechi) → rămâne cursul comenzii", CC.laModificare({ comanda: CM, moneda: "EUR", scris: null, bnr: B }), { curs: 5.25, data: null, manual: 1 });
  egal("golit nu înseamnă nimic când omul a scris un curs", CC.laModificare({ comanda: CM, moneda: "EUR", scris: 5.4, bnr: B, golit: true }), { curs: 5.4, data: null, manual: 1 });
  egal("comandă fără curs (BNR-ul n-a răspuns la plasare) → îl primește la modificare", CC.laModificare({ comanda: { moneda: "EUR", curs_bnr: null }, moneda: "EUR", scris: null, bnr: B }), { curs: 5.0912, data: "2026-11-17", manual: 0 });
  egal("eticheta BNR, cu ziua scrisă ca la noi", CC.eticheta(C0), "4,9723 lei/EUR · BNR din 27.10.2026");
  egal("…fără zi, doar „BNR”", CC.eticheta(Object.assign({}, C0, { curs_bnr_data: null })), "4,9723 lei/EUR · BNR");
  egal("eticheta cursului pus de om", CC.eticheta({ moneda: "EUR", curs_bnr: 5.1, curs_manual: 1 }), "5,1000 lei/EUR · pus pe comandă");
  egal("comanda în lei n-are etichetă de curs, nici dacă i-a rămas unul scris; nici cea în valută fără curs", [CC.eticheta({ moneda: "RON", curs_bnr: 5 }), CC.eticheta({ moneda: "EUR", curs_bnr: null }), CC.explica(100, { moneda: "RON", curs_bnr: 5, curs_manual: 1 })], ["", "", ""]);
  egal("explicația sub total, curs pus de om", CC.explica(100, { moneda: "EUR", curs_bnr: 5.1, curs_manual: 1 }), "≈ 510,00 lei, la cursul pus pe comandă 5,1000");
  egal("prețul în lei, 4 zecimale", [CC.pretInLei(1.2, C0), CC.pretInLei(1.2, { moneda: "RON" }), CC.pretInLei(1.2, { moneda: "EUR" })], [5.9668, 1.2, null]);
  for (const x of ["cinci", "-1", "0", "5,09,1"]) egal(`cursul „${x}" e refuzat`, CC.citeste(x).ok, false);

  // ===== 2. comanda nouă =====================================================
  console.log("\n── Comanda nouă ─────────────────────────────────────────────");
  const form = await cer("/comenzi/nou");
  // Vali, 19.11.2026: „pune moneda pe fiecare articol. Nu generală, sus."
  // Comanda nouă nu mai are moneda generală cu cursul ei; comenzile vechi
  // în valută le păstrează la modificare (mai jos).
  are(form.corp, 'name="moneda_linie[]"', "formularul are moneda pe fiecare articol");
  fara(form.corp, 'name="curs"', "…și nu mai are moneda generală cu cursul ei");
  are(form.corp, '"EUR":{"valoare":' + EUR.valoare, "BNR-ul de azi e în pagină, pentru propunere");
  let r = await cer("/comenzi", { metoda: "post", body: corp("EUR", "") });
  const c1 = idDinLocatie(r);
  egal("euro, curs gol → BNR-ul zilei, cu data lui, nemarcat ca pus de om",
    [Number(comanda(c1).curs_bnr), comanda(c1).curs_bnr_data, Number(comanda(c1).curs_manual)], [EUR.valoare, EUR.data, 0]);
  r = await cer("/comenzi", { metoda: "post", body: corp("EUR", "5,25") });
  const c2 = idDinLocatie(r);
  egal("euro, curs scris → exact acela, marcat pus de om, fără dată BNR",
    [Number(comanda(c2).curs_bnr), comanda(c2).curs_bnr_data, Number(comanda(c2).curs_manual)], [5.25, null, 1]);
  r = await cer("/comenzi", { metoda: "post", body: corp("RON", "5,25") });
  const c3 = idDinLocatie(r);
  egal("lei → fără curs, orice ar fi în câmp", [comanda(c3).curs_bnr, Number(comanda(c3).curs_manual)], [null, 0]);
  const inainteLei = Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ?", [CLIENT])[0].n);
  r = await cer("/comenzi", { metoda: "post", body: corp("RON", "cinci") });
  egal("lei, cu un text oarecare rămas în câmpul de curs → comanda se salvează, fără curs", [Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ?", [CLIENT])[0].n) - inainteLei, comanda(idDinLocatie(r)).curs_bnr], [1, null]);
  const cate = Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ?", [CLIENT])[0].n);
  r = await cer("/comenzi", { metoda: "post", body: corp("EUR", "cinci") });
  egal("curs scris greșit → comanda nu se salvează", Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id = ?", [CLIENT])[0].n), cate);
  are(r.corp, "Cursul nu e un număr pozitiv", "…și se spune de ce");

  const pag1 = await cer("/comenzi/:id", { params: { id: String(c1) } });
  const ziRo = (d) => String(d || "").split("-").reverse().join(".");
  are(pag1.corp, "lei/EUR · BNR din " + ziRo(EUR.data), "pagina comenzii spune că e cursul BNR și din ce zi");
  const pag2 = await cer("/comenzi/:id", { params: { id: String(c2) } });
  are(pag2.corp, "5,2500 lei/EUR · pus pe comandă", "pagina comenzii spune că e cursul pus de om");
  are(pag2.corp, "la cursul pus pe comandă 5,2500", "…și sub total");
  are(pag2.corp, "648,11 lei", "…cu echivalentul în lei la cursul acela (123,45 € × 5,25)");

  // ===== 3. modificarea ======================================================
  console.log("\n── Modificarea ──────────────────────────────────────────────");
  const mod = (moneda, curs, extra) => Object.assign(corp(moneda, curs), { "pret_exact[]": ["1.2345"], motiv: "" }, extra || {});
  const formMod = await cer("/comenzi/:id/editare", { params: { id: String(c2) } });
  are(formMod.corp, 'name="curs" id="cmd-curs" value="5,2500"', "formularul de modificare are cursul comenzii în câmp");
  // cantitate schimbată, cursul lăsat cum era
  let n = istoric(c2).length;
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod("EUR", "5,2500", { "cantitate[]": ["200"] }) });
  egal("o corectură de cantitate nu atinge cursul", [Number(comanda(c2).curs_bnr), Number(comanda(c2).curs_manual)], [5.25, 1]);
  egal("…și nu scrie nimic despre curs în istoric", istoric(c2).slice(n).filter((x) => /^Curs/.test(x.ce)).length, 0);
  // doar cursul schimbat
  n = istoric(c2).length;
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod("EUR", "5,3", { "cantitate[]": ["200"] }) });
  egal("doar cursul schimbat → se salvează (nu „nimic de schimbat”)", [/ok=nimic/.test(locatie(r)), Number(comanda(c2).curs_bnr), Number(comanda(c2).curs_manual)], [false, 5.3, 1]);
  egal("…și intră în istoric cu ce era și ce a rămas", istoric(c2).slice(n).filter((x) => x.ce === "Curs").map((x) => [x.vechi, x.nou]),
    [["5,2500 lei/EUR · pus pe comandă", "5,3000 lei/EUR · pus pe comandă"]]);
  // comanda pe BNR, salvată neatinsă
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod("EUR", CC.scrie(EUR.valoare)) });
  egal("comanda pe BNR, salvată neatinsă → „nimic de schimbat”, cursul rămâne", [/ok=nimic/.test(locatie(r)), Number(comanda(c1).curs_bnr), comanda(c1).curs_bnr_data], [true, EUR.valoare, EUR.data]);
  // câmpul de curs golit: se cere BNR-ul zilei
  n = istoric(c2).length;
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod("EUR", "", { "cantitate[]": ["200"] }) });
  egal("cursul șters din câmp → BNR-ul zilei, salvat fără altă schimbare", [/ok=nimic/.test(locatie(r)), Number(comanda(c2).curs_bnr), comanda(c2).curs_bnr_data, Number(comanda(c2).curs_manual)], [false, EUR.valoare, EUR.data, 0]);
  egal("…scris în istoric ca „Curs BNR”, cu ce era și ce a rămas", istoric(c2).slice(n).filter((x) => /^Curs/.test(x.ce)).map((x) => [x.ce, x.vechi, x.nou]),
    [["Curs BNR", "5,3000 lei/EUR · pus pe comandă", `${CC.scrie(EUR.valoare)} lei/EUR · BNR din ${ziRo(EUR.data)}`]]);
  // formularul care nu trimite câmpul deloc (pagină deschisă dinaintea actualizării)
  exec(`UPDATE comenzi SET curs_bnr = 5.3, curs_bnr_data = NULL, curs_manual = 1 WHERE id = ${c2}`);
  const faraCamp = mod("EUR", "", { "cantitate[]": ["200"] });
  delete faraCamp.curs;
  n = istoric(c2).length;
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: faraCamp });
  egal("formularul fără câmpul de curs nu atinge cursul și n-are ce salva", [/ok=nimic/.test(locatie(r)), Number(comanda(c2).curs_bnr), Number(comanda(c2).curs_manual), istoric(c2).length - n], [true, 5.3, 1, 0]);
  // comanda rămasă fără curs (BNR-ul n-a răspuns la plasare) îl primește la prima salvare
  exec(`UPDATE comenzi SET curs_bnr = NULL, curs_bnr_data = NULL, curs_manual = 0 WHERE id = ${c1}`);
  n = istoric(c1).length;
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod("EUR", "") });
  egal("comanda fără curs îl primește la salvare, cu rând în istoric", [/ok=nimic/.test(locatie(r)), Number(comanda(c1).curs_bnr), comanda(c1).curs_bnr_data, istoric(c1).slice(n).map((x) => [x.ce, x.vechi, x.nou])],
    [false, EUR.valoare, EUR.data, [["Curs BNR", null, `${CC.scrie(EUR.valoare)} lei/EUR · BNR din ${ziRo(EUR.data)}`]]]);
  // moneda schimbată, câmpul rămas pe cursul euro
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod("USD", "5,3", { "cantitate[]": ["200"] }) });
  egal("euro → dolari, câmpul rămas pe 5,3 → BNR-ul dolarului", [comanda(c2).moneda, Number(comanda(c2).curs_bnr), Number(comanda(c2).curs_manual)], ["USD", USD.valoare, 0]);
  are(istoric(c2).map((x) => x.ce).join("|"), "Curs BNR", "…cu „Curs BNR” în istoric");
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: mod("RON", "", { "cantitate[]": ["200"] }) });
  egal("înapoi pe lei → cursul se șterge", [comanda(c2).curs_bnr, Number(comanda(c2).curs_manual)], [null, 0]);
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod("EUR", "zero") });
  egal("curs greșit la modificare → nimic schimbat", Number(comanda(c1).curs_bnr), EUR.valoare);
  are(r.corp, "Cursul nu e un număr pozitiv", "…și se spune de ce");

  // ===== 4. factura comenzii în euro ========================================
  console.log("\n── Factura comenzii în euro ─────────────────────────────────");
  exec(`UPDATE comenzi SET status = 'in_stoc_depozit', curs_bnr = 5.25, curs_bnr_data = NULL, curs_manual = 1 WHERE id = ${c1}`);
  await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c1) } });
  const f1 = q("SELECT id, moneda, observatii FROM facturi WHERE comanda_id = ?", [c1])[0];
  const l1 = q("SELECT cantitate, pret_unitar FROM facturi_linii WHERE factura_id = ?", [f1.id])[0];
  egal("factura comenzii în euro are prețul în lei, la cursul comenzii (1,2345 € × 5,25)", [f1.moneda, Number(l1.pret_unitar), Number(l1.cantitate)], ["RON", 6.4811, 100]);
  are(f1.observatii || "", "prețurile sunt trecute în lei la cursul comenzii, 5,2500 lei/EUR · pus pe comandă", "…și spune pe ea din ce curs");
  // comanda în lei: neschimbat
  exec(`UPDATE comenzi SET status = 'in_stoc_depozit' WHERE id = ${c3}`);
  await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c3) } });
  const f3 = q("SELECT id, observatii FROM facturi WHERE comanda_id = ?", [c3])[0];
  egal("comanda în lei se facturează ca până acum", [Number(q("SELECT cantitate, pret_unitar FROM facturi_linii WHERE factura_id = ?", [f3.id])[0].pret_unitar), f3.observatii], [1.2345, null]);
  // comanda în euro fără curs
  const c4 = Number(q(`INSERT INTO comenzi (partener_id, status, moneda, livrare_partiala) VALUES (${CLIENT}, 'in_stoc_depozit', 'EUR', 'nu') RETURNING id`)[0].id);
  exec(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${c4}, ${PRODUS}, 10, 2)`);
  r = await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c4) } });
  egal("comanda în euro fără curs nu se facturează", q("SELECT id FROM facturi WHERE comanda_id = ?", [c4]).length, 0);
  are(r.corp, "n-are curs", "…și se spune ce e de făcut");

  // facturarea parțială: doar ce e pe stoc, tot în lei la cursul comenzii
  exec(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, data_intrare) VALUES ('CC-PALET-1', ${PRODUS}, 40, 'buc', '2026-11-01')`);
  const c5 = Number(q(`INSERT INTO comenzi (partener_id, status, moneda, curs_bnr, curs_bnr_data, curs_manual, livrare_partiala) VALUES (${CLIENT}, 'noua', 'EUR', 5.0912, '${azi}', 0, 'da') RETURNING id`)[0].id);
  exec(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${c5}, ${PRODUS}, 100, 0.16005)`);
  await cer("/comenzi/:id/factureaza-partial", { metoda: "post", params: { id: String(c5) } });
  const f5 = q("SELECT id, moneda, observatii FROM facturi WHERE comanda_id = ?", [c5])[0] || {};
  const l5 = q("SELECT cantitate, pret_unitar FROM facturi_linii WHERE factura_id = ?", [f5.id || 0])[0] || {};
  egal("facturarea parțială a comenzii în euro: ce e pe stoc, cu prețul în lei la cursul comenzii (0,16005 € × 5,0912)", [f5.moneda, Number(l5.cantitate), Number(l5.pret_unitar)], ["RON", 40, 0.8148]);
  egal("…și spune pe ea din ce curs, lângă nota de parțial", f5.observatii,
    "facturare parțială — restul comenzii rămâne deschis · Comandă în EUR: prețurile sunt trecute în lei la cursul comenzii, 5,0912 lei/EUR · BNR din " + ziRo(azi) + ".");
  exec(`UPDATE comenzi SET curs_bnr = NULL, curs_bnr_data = NULL WHERE id = ${c5}`);
  r = await cer("/comenzi/:id/factureaza-partial", { metoda: "post", params: { id: String(c5) } });
  egal("…iar fără curs nu se facturează nici parțial, și nu se mișcă nimic pe comandă", [q("SELECT id FROM facturi WHERE comanda_id = ?", [c5]).length, Number(q("SELECT cantitate_livrata FROM comenzi_linii WHERE comanda_id = ?", [c5])[0].cantitate_livrata)], [1, 40]);
  are(r.corp, "n-are curs", "…și se spune ce e de făcut");
  // comanda în lei, parțial: ca până acum
  const c6 = Number(q(`INSERT INTO comenzi (partener_id, status, moneda, livrare_partiala) VALUES (${CLIENT}, 'noua', 'RON', 'da') RETURNING id`)[0].id);
  exec(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${c6}, ${PRODUS}, 5, 7.5)`);
  await cer("/comenzi/:id/factureaza-partial", { metoda: "post", params: { id: String(c6) } });
  const f6 = q("SELECT id, observatii FROM facturi WHERE comanda_id = ?", [c6])[0] || {};
  egal("comanda în lei, facturată parțial: prețul ei și doar nota de parțial", [Number((q("SELECT cantitate, pret_unitar FROM facturi_linii WHERE factura_id = ?", [f6.id || 0])[0] || {}).pret_unitar), f6.observatii], [7.5, "facturare parțială — restul comenzii rămâne deschis"]);

  console.log("\n── Lista de comenzi ─────────────────────────────────────────");
  r = await cer("/comenzi", { query: { perioada: "tot" } });
  const randComanda = (id) => (new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?href="/comenzi/${id}"[\\s\\S]*?</tr>`).exec(r.corp) || [""])[0];
  are(randComanda(c1), "123,45 €", "comanda în euro își arată totalul în euro, nu în lei");
  are(randComanda(c1), "≈ 648,11 lei", "…cu echivalentul în lei la cursul comenzii (123,45 € × 5,25)");
  are(randComanda(c1), 'data-filtru="648,11 lei"', "…pe care îl adună filtrele din capul tabelului");
  egal("comanda în euro fără curs: suma în euro, fără echivalent, și nu intră în totalul în lei", [randComanda(c4).includes("20,00 €"), randComanda(c4).includes("≈"), randComanda(c4).includes('data-filtru="fără curs"')], [true, false, true]);
  egal("comanda în lei: ca până acum", [randComanda(c3).includes("123,45 lei"), randComanda(c3).includes("data-filtru"), randComanda(c3).includes("≈")], [true, false, false]);

  // ===== moneda pe fiecare articol =============================================
  // Vali, 19.11.2026: „pune moneda pe fiecare articol" · totalul: „Totul în lei".
  console.log("\n── Moneda pe fiecare articol ────────────────────────────────");
  const ML = require(path.join(RAD, "lib", "moneda-linie.js"));
  {
    const x = await ML.inLei({ preturi: [{ ok: true, valoare: 2 }, { ok: true, valoare: 7 }, { ok: true, valoare: 3 }], monede: ["EUR", "", "usd"], produse: [1, 2, 3], cursAzi: async (m) => ({ EUR: { valoare: 5 }, USD: { valoare: 4.5 } })[m] });
    egal("fără bază: euro și dolari trec în lei, leii rămân", [x.preturi.map((p) => p.valoare), x.extra.map((e) => [e.moneda, e.pret_valuta, e.curs]), x.eroare], [[10, 7, 13.5], [["EUR", 2, 5], ["RON", null, null], ["USD", 3, 4.5]], ""]);
    const y = await ML.inLei({ preturi: [{ ok: true, valoare: 2 }], monede: ["EUR"], produse: [1], vechi: new Map([[1, { moneda: "EUR", pret_valuta: 2, curs: 4.9, pret_unitar: 9.8 }]]), cursAzi: async () => ({ valoare: 5 }) });
    egal("prețul în valută neatins rămâne cu leii și cursul de la plasare", [y.preturi[0].valoare, y.extra[0].curs], [9.8, 4.9]);
    const z = await ML.inLei({ preturi: [{ ok: true, valoare: 2 }], monede: ["EUR"], produse: [1], cursAzi: async () => null });
    bine("fără curs BNR: se spune, nu se ghicește", /Nu am cursul BNR pentru EUR/.test(z.eroare));
  }
  const corpLinii = (extra) => Object.assign(corp("RON", ""), { "produs_id[]": [String(PRODUS)], "cantitate[]": ["100"], "pret_unitar[]": ["2"], "moneda_linie[]": ["EUR"] }, extra || {});
  r = await cer("/comenzi", { metoda: "post", body: corpLinii() });
  const cl = idDinLocatie(r);
  const linia = () => q("SELECT pret_unitar, moneda, pret_valuta, curs FROM comenzi_linii WHERE comanda_id = ?", [cl]).map((x) => [Number(x.pret_unitar), x.moneda, x.pret_valuta == null ? null : Number(x.pret_valuta), x.curs == null ? null : Number(x.curs)])[0];
  egal("comanda rămâne în lei, fără curs pe ea", q("SELECT moneda, curs_bnr FROM comenzi WHERE id = ?", [cl]).map((x) => [x.moneda, x.curs_bnr])[0], ["RON", null]);
  egal("linia: prețul în lei la BNR-ul zilei, cu moneda, prețul în euro și cursul ținute minte (2 € × 5,0912)", linia(), [10.1824, "EUR", 2, 5.0912]);
  r = await cer("/comenzi/:id", { params: { id: String(cl) } });
  bine("pagina comenzii arată leii și, dedesubt, prețul în euro cu cursul", /data-pret-valuta>2,00 EUR · curs 5,0912</.test(r.corp) && r.corp.includes("10,1824"), (r.corp.match(/data-pret-valuta[^<]*/) || [""])[0]);
  r = await cer("/comenzi/:id/editare", { params: { id: String(cl) } });
  bine("la modificare, rândul vine cu prețul în euro și moneda lui, fără moneda generală", /name="pret_unitar\[\]"[^>]*value="2"/.test(r.corp.replace(/\s+/g, " ")) && /<option value="EUR" selected>/.test(r.corp) && !r.corp.includes('name="curs"') && r.corp.includes('name="moneda" value="RON"'), (r.corp.match(/name="pret_unitar\[\]"[\s\S]{0,160}/) || [""])[0]);
  exec(`UPDATE cursuri_bnr SET valoare = 5.2 WHERE moneda = 'EUR' AND data = '${azi}' AND luat_la = 'test-curs-comanda'`);
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(cl) }, body: corpLinii({ "cantitate[]": ["150"], "pret_exact[]": ["2"] }) });
  egal("altă cantitate, preț neatins: leii și cursul rămân cele de la plasare, deși BNR-ul s-a mișcat", [linia(), Number(q("SELECT cantitate FROM comenzi_linii WHERE comanda_id = ?", [cl])[0].cantitate)], [[10.1824, "EUR", 2, 5.0912], 150]);
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(cl) }, body: corpLinii({ "cantitate[]": ["150"], "pret_unitar[]": ["3"], "pret_exact[]": [""] }) });
  egal("alt preț în euro: se trece în lei la BNR-ul de azi (3 € × 5,2)", linia(), [15.6, "EUR", 3, 5.2]);
  bine("…și schimbarea e în istoricul comenzii", q("SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id", [cl]).some((x) => /^Monedă · /.test(x.ce) && /2,00 EUR/.test(x.vechi) && /3,00 EUR/.test(x.nou)));
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(cl) }, body: corpLinii({ "cantitate[]": ["150"], "pret_unitar[]": ["12,5"], "pret_exact[]": [""], "moneda_linie[]": ["RON"] }) });
  egal("trecut pe lei: prețul e cel scris, fără valută și fără curs", linia(), [12.5, "RON", null, null]);
  exec(`UPDATE cursuri_bnr SET valoare = 5.0912 WHERE moneda = 'EUR' AND data = '${azi}' AND luat_la = 'test-curs-comanda'`);
  r = await cer("/comenzi/:id/editare", { params: { id: String(c1) } });
  bine("comanda veche în euro își păstrează moneda generală și cursul, fără monedă pe rânduri", r.corp.includes('<select name="moneda">') && r.corp.includes('name="curs"') && !r.corp.includes('class="moneda-linie"'));

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
