"use strict";
// Oferta în lei, euro sau dolari, cu cursul fixat pe ea. PostgreSQL real.
//
// CEREREA LUI VALI, 17.11.2026: „La orice comandă, preț etc., din orice loc în
// tot sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul
// introdus sau BNR; odată plasat, așa rămâne în istoric și doar cele noi se
// schimbă." Comanda de client și prețul de intrare în stoc au deja regula;
// aici e oferta către client și ce pleacă din ea.
//
// CE APĂRĂ:
//   • OFERTA NOUĂ își ia moneda și cursul din formular: BNR-ul zilei când
//     câmpul e gol, exact ce s-a scris când e scris. Un curs care nu e număr
//     sau o monedă necunoscută: oferta nu se face, formularul se întoarce.
//   • PAGINA scrie prețurile și totalul în moneda ofertei, cu echivalentul în
//     lei la cursul ei — nu „lei" lângă sume în euro.
//   • MONEDA nu se schimbă pe o ofertă cu linii (prețurile sunt scrise în ea);
//     cursul da, cu regulile comenzii: nescris altfel rămâne, golit ia BNR-ul.
//   • VERSIUNEA NOUĂ își ține moneda și cursul.
//   • COMANDA făcută din ofertă e în moneda ei: cursul pus de om merge pe
//     comandă, altfel BNR-ul zilei în care se plasează comanda.
//   • CONTRACTUL își ține valoarea în lei, la cursul ofertei, cu mențiunea.
//   • LISTA, EMAILUL către client, PÂLNIA din CRM și lista depozitului scriu
//     moneda documentului, iar sumele adunate sunt în lei.
//   • CALCULATORUL DE PREȚ socotește în lei: pe o ofertă în valută linia lui
//     intră trecută în moneda ofertei; pe una fără curs nu intră deloc.
//   • VALOAREA ESTIMATĂ a comenzii de producție e în lei, la cursul comenzii
//     clientului; fără curs rămâne nescrisă — nu euro trecuți drept lei.
//   • PREȚURILE CONCURENȚEI de pe ofertă se compară cu al nostru doar în
//     aceeași monedă și se scriu în moneda lor.
//   • BNR-UL CARE NU RĂSPUNDE: oferta în valută cere cursul scris; un curs
//     bun, deja pus, nu se pierde.
//   • COMANDA ȘTEARSĂ lasă în istoricul clientului valoarea în moneda ei.
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
  put: () => {},
  delete: () => {},
};
for (const m of ["oferte", "warehouse", "calculator", "productie", "comenzi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97611, nume: "Vali Oferta", rol: "admin", email: "v.om@test.ro" };
const ALTUL = { id: 97612, nume: "Alt Agent", rol: "vanzari", email: "a.om@test.ro" };

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


const CLIENT = 97601;
const PRODUS = 97621;
const azi = new Date().toISOString().slice(0, 10);
const ziRo = (d) => String(d).slice(8, 10) + "." + String(d).slice(5, 7) + "." + String(d).slice(0, 4);

function curata() {
  for (const s of [
    "DELETE FROM comenzi_productie_caracteristici WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE produs_id BETWEEN 97621 AND 97629)",
    "DELETE FROM comenzi_productie_linii WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE produs_id BETWEEN 97621 AND 97629)",
    "UPDATE aprovizionari SET productie_id = NULL WHERE produs_id BETWEEN 97621 AND 97629",
    "DELETE FROM comenzi_productie WHERE produs_id BETWEEN 97621 AND 97629",
    "DELETE FROM aprovizionari WHERE produs_id BETWEEN 97621 AND 97629",
    "DELETE FROM calculator_categorii WHERE nume = 'OM categorie de test'",
    "DELETE FROM concurenta_preturi WHERE produs_id BETWEEN 97621 AND 97629",
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97601 AND 97609)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97601 AND 97609)",
    "UPDATE oferte SET comanda_id = NULL, contract_id = NULL WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM comenzi WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM contracte WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM oferte_linii WHERE oferta_id IN (SELECT id FROM oferte WHERE partener_id BETWEEN 97601 AND 97609)",
    "DELETE FROM emailuri WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM oferte WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM interactiuni WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM parteneri WHERE id BETWEEN 97601 AND 97609",
    "DELETE FROM produse WHERE id BETWEEN 97621 AND 97629",
    "DELETE FROM utilizatori WHERE id BETWEEN 97611 AND 97619",
    "DELETE FROM cursuri_bnr WHERE luat_la = 'test-oferta-moneda'",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const oferta = (id) => q("SELECT * FROM oferte WHERE id = ?", [id])[0];
const cursul = (o) => [o.moneda, nr(o.curs_bnr), o.curs_bnr_data, Number(o.curs_manual)];
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/(\d+)(\?|$)/) || [])[1] || 0);
const parametri = (r) => Object.fromEntries(new URLSearchParams(String(locatie(r)).split("?")[1] || ""));
const nrOferte = () => Number(q("SELECT COUNT(*) AS n, 1 AS x FROM oferte WHERE partener_id = ?", [CLIENT])[0].n);
const corpNou = (moneda, curs, extra) => Object.assign({ partener_id: String(CLIENT), titlu: "Folie pe luna decembrie", valabil_pana: "2099-12-31", pret_moneda: moneda, pret_curs: curs }, extra || {});
const liniiOf = (id) => q("SELECT denumire, cantitate, pret_unitar FROM oferte_linii WHERE oferta_id = ? ORDER BY id", [id]).map((l) => [l.denumire, Number(l.cantitate), Number(l.pret_unitar)]);

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97611,'Vali Oferta','v.om@test.ro','x','y','admin'), (97612,'Alt Agent','a.om@test.ro','x','y','vanzari')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (97601,'OM CLIENT EURO SRL','RO-OM-1','client')`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97621,'OM-1','Folie stretch oferta','buc',10,21)",
    `INSERT INTO cursuri_bnr (data, moneda, valoare, luat_la) VALUES ('${azi}','EUR',5.0912,'test-oferta-moneda') ON CONFLICT (data, moneda) DO NOTHING`,
    `INSERT INTO cursuri_bnr (data, moneda, valoare, luat_la) VALUES ('${azi}','USD',4.6034,'test-oferta-moneda') ON CONFLICT (data, moneda) DO NOTHING`,
  ]) exec(s);
  const bnr = (m) => { const x = q("SELECT valoare, data FROM cursuri_bnr WHERE moneda = ? AND data <= ? ORDER BY data DESC LIMIT 1", [m, azi])[0]; return { valoare: Number(x.valoare), data: x.data }; };
  const EUR = bnr("EUR");
  const scrieCurs = (v) => CC.scrie(v);

  console.log("\n── Ce e comun comenzii și ofertei (fără bază) ───────────────");
  egal("suma și prețul, în moneda documentului", [CC.suma(1584, "EUR"), CC.suma(1584, "RON"), CC.suma(20, "USD"), CC.pret(0.0345, "EUR"), CC.pret(12.5, "EUR"), CC.pret(7.35, "RON")], ["1.584,00 €", "1.584,00 lei", "20,00 $", "0,0345 €", "12,50 €", "7,35 lei"]);
  egal("în lei, la cursul documentului; fără curs nu se ghicește", [CC.inLei(100, { moneda: "EUR", curs_bnr: 5.25 }), CC.inLei(100, { moneda: "RON" }), CC.inLei(100, { moneda: "EUR" }), CC.inLei("abc", { moneda: "RON" })], [525, 100, null, null]);
  egal("prețul în lei al produsului, trecut în moneda ofertei, cu patru zecimale", [CC.dinLei(10, { moneda: "EUR", curs_bnr: 5.2 }), CC.dinLei(10, { moneda: "RON" }), CC.dinLei(10, { moneda: "EUR" })], [1.9231, 10, null]);
  egal("cursul pus de om spune pe ce document stă", [CC.eticheta({ moneda: "EUR", curs_bnr: 5.2, curs_manual: 1 }, "ofertă"), CC.eticheta({ moneda: "EUR", curs_bnr: 5.2, curs_manual: 1 }), CC.explica(100, { moneda: "EUR", curs_bnr: 5.2, curs_manual: 1 }, "ofertă")], ["5,2000 lei/EUR · pus pe ofertă", "5,2000 lei/EUR · pus pe comandă", "≈ 520,00 lei, la cursul pus pe ofertă 5,2000"]);

  console.log("\n── Oferta nouă ──────────────────────────────────────────────");
  let r = await cer("/oferte", { metoda: "post", body: { partener_id: String(CLIENT), titlu: "In lei" } });
  const oLei = idDinLocatie(r);
  egal("fără monedă aleasă (formular vechi): în lei, fără curs", cursul(oferta(oLei)), ["RON", null, null, 0]);
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "") });
  const oBnr = idDinLocatie(r);
  egal("în euro, cursul lăsat gol: BNR-ul de azi, cu data lui", cursul(oferta(oBnr)), ["EUR", EUR.valoare, EUR.data, 0]);
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "5,2") });
  const oMan = idDinLocatie(r);
  egal("în euro, cu cursul scris: exact acela, al omului", cursul(oferta(oMan)), ["EUR", 5.2, null, 1]);
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", scrieCurs(EUR.valoare)) });
  egal("cursul scris la fel ca BNR-ul zilei rămâne BNR", cursul(oferta(idDinLocatie(r))), ["EUR", EUR.valoare, EUR.data, 0]);
  let inainte = nrOferte();
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "cinci") });
  egal("curs care nu e număr: oferta nu se face, formularul se întoarce cu motivul și cu ce era scris", [nrOferte() - inainte, String(locatie(r)).split("?")[0], /Cursul nu e un număr pozitiv/.test(parametri(r).eroare || ""), parametri(r).titlu, parametri(r).pret_moneda, parametri(r).pret_curs, parametri(r).partener_id], [0, "/oferte/nou", true, "Folie pe luna decembrie", "EUR", "cinci", String(CLIENT)]);
  r = await cer("/oferte", { metoda: "post", body: corpNou("GBP", "6") });
  egal("monedă necunoscută: refuzată", [nrOferte() - inainte, /nu e una în care se scriu prețurile/.test(parametri(r).eroare || "")], [0, true]);
  r = await cer("/oferte/nou", { query: { eroare: "Ceva <greșit>", titlu: "Folie", pret_moneda: "EUR", pret_curs: "cinci", partener_id: String(CLIENT) } });
  are(r.corp, "Ceva &lt;greșit&gt;", "formularul întors arată motivul");
  are(r.corp, 'value="EUR" selected', "…și moneda aleasă");
  are(r.corp, 'name="pret_curs" value="cinci"', "…și cursul scris");
  are(r.corp, "window.PV_BNR", "…și are BNR-ul zilei în pagină");

  console.log("\n── Pagina ofertei și liniile ────────────────────────────────");
  r = await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oMan) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "1000", pret_unitar: "0,0345", cota_tva: "21" } });
  r = await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oMan) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "10", pret_unitar: "", cota_tva: "21" } });
  egal("prețul liniei ține patru zecimale; fără preț scris, cel din nomenclator (10 lei) intră trecut în euro la cursul ofertei", liniiOf(oMan), [["Folie stretch oferta", 1000, 0.0345], ["Folie stretch oferta", 10, 1.9231]]);
  r = await cer("/oferte/:id", { params: { id: String(oMan) } });
  are(r.corp, "0,0345 €", "prețul unitar e scris în euro, cu zecimalele lui");
  are(r.corp, "<strong>53,73 €</strong>", "totalul e în euro (34,50 + 19,231)");
  are(r.corp, "≈ 279,40 lei, la cursul pus pe ofertă 5,2000", "…cu echivalentul în lei la cursul ofertei");
  are(r.corp, "curs 5,2000 lei/EUR · pus pe ofertă", "moneda și cursul se văd în caseta ofertei");
  are(r.corp, "Preț unitar (EUR)", "câmpul de preț spune moneda");
  are(r.corp, 'name="pret_unitar" type="number" step="0.0001"', "…și primește patru zecimale");
  fara(r.corp.split("<h2>Linii</h2>")[1].split("</table>")[0], " lei", "în tabelul liniilor nu scrie „lei” lângă sume în euro");
  r = await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oLei) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "3", pret_unitar: "", cota_tva: "21" } });
  egal("oferta în lei: prețul din nomenclator intră cum e", liniiOf(oLei), [["Folie stretch oferta", 3, 10]]);
  r = await cer("/oferte/:id", { params: { id: String(oLei) } });
  are(r.corp, "<strong>30,00 lei</strong>", "oferta în lei arată ca până acum");
  fara(r.corp, "Preț unitar (", "…fără monedă lângă câmpul de preț");
  fara(r.corp, "≈", "…și fără echivalent");
  // prețurile concurenței: diferența față de al nostru doar în aceeași monedă
  exec(`INSERT INTO concurenta_preturi (directie, produs_id, denumire, concurent, pret, moneda, um, data_ofertei, activ) VALUES ('vanzare', ${PRODUS}, 'Folie stretch oferta', 'Concurent Lei', 9, 'RON', 'buc', '${azi}', 1), ('vanzare', ${PRODUS}, 'Folie stretch oferta', 'Concurent Euro', 1.5, 'EUR', 'buc', '${azi}', 1)`);
  r = await cer("/oferte/:id", { params: { id: String(oMan) } });
  const tabelLinii = (html) => html.split("<h2>Linii</h2>")[1].split("</table>")[0];
  egal("oferta în euro: față de concurentul în euro scrie diferența în euro; față de cel în lei, nimic", [tabelLinii(r.corp).includes("Concurent Euro: <strong>1,50 €</strong>/buc"), tabelLinii(r.corp).includes("(+0,42 € la noi)"), /Concurent Lei: <strong>9,00 lei<\/strong>\/buc · [^<(]*<\/div>/.test(tabelLinii(r.corp)), /Concurent Lei:[^<]*<strong>[^<]*<\/strong>[^<]*<span/.test(tabelLinii(r.corp))], [true, true, true, false]);
  are(r.corp, 'var MONEDA = "EUR";', "…iar scriptul paginii știe moneda ofertei, pentru comparația de la alegerea produsului");
  r = await cer("/oferte/:id", { params: { id: String(oLei) } });
  egal("oferta în lei: diferența față de concurentul în lei, nimic față de cel în euro", [tabelLinii(r.corp).includes("(+1,00 lei la noi)"), /Concurent Euro: <strong>1,50 €<\/strong>\/buc · [^<(]*<\/div>/.test(tabelLinii(r.corp))], [true, true]);
  exec(`DELETE FROM concurenta_preturi WHERE produs_id = ${PRODUS}`);

  console.log("\n── Schimbarea monedei și a cursului ─────────────────────────");
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMan) }, body: { pret_moneda: "RON", pret_curs: "" } });
  egal("oferta cu linii nu-și schimbă moneda, și spune de ce", [cursul(oferta(oMan)), /are deja linii cu prețuri în EUR/.test(parametri(r).eroare || "")], [["EUR", 5.2, null, 1], true]);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMan) }, body: { pret_moneda: "EUR", pret_curs: "5,2000" } });
  egal("cursul nescris altfel rămâne cum era", cursul(oferta(oMan)), ["EUR", 5.2, null, 1]);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMan) }, body: { pret_moneda: "EUR", pret_curs: "5,31" } });
  egal("alt curs scris: acela, al omului", cursul(oferta(oMan)), ["EUR", 5.31, null, 1]);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMan) }, body: { pret_moneda: "EUR", pret_curs: "abc" } });
  egal("curs care nu e număr: neschimbat, cu motivul", [cursul(oferta(oMan)), /Cursul nu e un număr pozitiv/.test(parametri(r).eroare || "")], [["EUR", 5.31, null, 1], true]);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMan) }, body: { pret_moneda: "EUR", pret_curs: "" } });
  egal("câmpul golit: BNR-ul de azi", cursul(oferta(oMan)), ["EUR", EUR.valoare, EUR.data, 0]);
  exec(`UPDATE oferte SET curs_bnr = 5.2, curs_bnr_data = NULL, curs_manual = 1 WHERE id = ${oMan}`);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMan) }, body: { pret_moneda: "EUR", pret_curs: "9" }, user: ALTUL });
  egal("alt agent nu schimbă cursul ofertei altuia", cursul(oferta(oMan)), ["EUR", 5.2, null, 1]);
  r = await cer("/oferte", { metoda: "post", body: { partener_id: String(CLIENT), titlu: "Fara linii" } });
  const oGol = idDinLocatie(r);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oGol) }, body: { pret_moneda: "USD", pret_curs: "4,7" } });
  egal("oferta fără linii își poate schimba moneda", cursul(oferta(oGol)), ["USD", 4.7, null, 1]);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oGol) }, body: { pret_moneda: "RON", pret_curs: "4,7" } });
  egal("…iar întoarsă pe lei nu mai are curs", cursul(oferta(oGol)), ["RON", null, null, 0]);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oGol) }, body: { pret_moneda: "GBP", pret_curs: "6" } });
  egal("monedă necunoscută: neschimbată, cu motivul ei", [cursul(oferta(oGol)), /nu e una dintre lei, euro și dolari/.test(parametri(r).eroare || "")], [["RON", null, null, 0], true]);
  exec(`UPDATE oferte SET status = 'acceptata' WHERE id = ${oGol}`);
  r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oGol) }, body: { pret_moneda: "EUR", pret_curs: "5" } });
  egal("oferta acceptată nu-și mai schimbă moneda", cursul(oferta(oGol)), ["RON", null, null, 0]);
  r = await cer("/oferte/:id", { params: { id: String(oMan) } });
  are(r.corp, `action="/oferte/${oMan}/moneda"`, "pe oferta de lucru e formularul de curs");
  are(r.corp, 'name="pret_curs" value="5,2000"', "…cu cursul ofertei în câmp");
  are(r.corp, "Schimbă cursul ofertei", "…și spune că, având linii, se schimbă doar cursul");
  const formMoneda = (html) => ((/<form method="post" action="\/oferte\/\d+\/moneda"[\s\S]*?<\/form>/.exec(html) || [""])[0]);
  egal("…iar din listă se poate alege doar moneda ei", (formMoneda(r.corp).match(/<option value="([A-Z]+)"/g) || []).map((x) => x.slice(15, 18)), ["EUR"]);
  r = await cer("/oferte/:id", { params: { id: String(oLei) } });
  fara(r.corp, `action="/oferte/${oLei}/moneda"`, "oferta în lei cu linii nu mai are ce schimba: fără formular");
  r = await cer("/oferte", { metoda: "post", body: { partener_id: String(CLIENT), titlu: "Goala, de lucru" } });
  r = await cer("/oferte/:id", { params: { id: String(idDinLocatie(r)) } });
  egal("oferta fără linii are toate cele trei monede de ales", [(formMoneda(r.corp).match(/<option value="([A-Z]+)"/g) || []).map((x) => x.slice(15, 18)), r.corp.includes("Schimbă moneda sau cursul ofertei")], [["RON", "EUR", "USD"], true]);
  r = await cer("/oferte/:id", { params: { id: String(oGol) } });
  fara(r.corp, `action="/oferte/${oGol}/moneda"`, "pe oferta acceptată nu mai e");

  console.log("\n── Versiunea nouă ───────────────────────────────────────────");
  r = await cer("/oferte/:id/versiune-noua", { metoda: "post", params: { id: String(oMan) } });
  const oV2 = idDinLocatie(r);
  egal("versiunea nouă își ține moneda și cursul, cu liniile în euro", [cursul(oferta(oV2)), liniiOf(oV2), oferta(oMan).status], [["EUR", 5.2, null, 1], [["Folie stretch oferta", 1000, 0.0345], ["Folie stretch oferta", 10, 1.9231]], "inlocuita"]);

  console.log("\n── Comanda și contractul făcute din ofertă ──────────────────");
  r = await cer("/oferte/:id/accepta", { metoda: "post", params: { id: String(oV2) }, body: { creeaza_contract: "1", creeaza_comanda: "1" } });
  const ov = oferta(oV2);
  const cmd = q("SELECT * FROM comenzi WHERE id = ?", [ov.comanda_id])[0];
  egal("comanda e în euro, cu cursul pus de om pe ofertă", [cmd.moneda, nr(cmd.curs_bnr), cmd.curs_bnr_data, Number(cmd.curs_manual)], ["EUR", 5.2, null, 1]);
  egal("…și cu prețurile liniilor așa cum sunt scrise pe ofertă", q("SELECT cantitate, pret_unitar FROM comenzi_linii WHERE comanda_id = ? ORDER BY id", [cmd.id]).map((l) => [Number(l.cantitate), Number(l.pret_unitar)]), [[1000, 0.0345], [10, 1.9231]]);
  const ctr = q("SELECT valoare, observatii FROM contracte WHERE id = ?", [ov.contract_id])[0];
  egal("contractul își ține valoarea în lei, la cursul ofertei (53,731 € × 5,2), și spune din ce s-a făcut", [Math.round(Number(ctr.valoare) * 100) / 100, ctr.observatii], [279.4, `Din oferta ${ov.numar}, în EUR: 53,73 € × 5,2000 · pus pe ofertă.`]);
  // oferta cu BNR-ul unei zile mai vechi: comanda se plasează azi
  exec(`UPDATE oferte SET curs_bnr = 4.9, curs_bnr_data = '2026-10-01', curs_manual = 0 WHERE id = ${oBnr}`);
  await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oBnr) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "100", pret_unitar: "2", cota_tva: "21" } });
  r = await cer("/oferte/:id/spre-comanda", { metoda: "post", params: { id: String(oBnr) } });
  const cmd2 = q("SELECT * FROM comenzi WHERE id = ?", [oferta(oBnr).comanda_id])[0];
  egal("oferta la BNR-ul unei zile mai vechi: comanda ia BNR-ul zilei în care se plasează", [cmd2.moneda, nr(cmd2.curs_bnr), cmd2.curs_bnr_data, Number(cmd2.curs_manual)], ["EUR", EUR.valoare, EUR.data, 0]);
  r = await cer("/oferte/:id/spre-contract", { metoda: "post", params: { id: String(oBnr) } });
  const ctr2 = q("SELECT valoare, observatii FROM contracte WHERE id = ?", [oferta(oBnr).contract_id])[0];
  egal("…iar contractul ei e la cursul ofertei (200 € × 4,9)", [Number(ctr2.valoare), ctr2.observatii], [980, `Din oferta ${oferta(oBnr).numar}, în EUR: 200,00 € × 4,9000 · BNR din 01.10.2026.`]);
  r = await cer("/oferte/:id/accepta", { metoda: "post", params: { id: String(oLei) }, body: { creeaza_contract: "1", creeaza_comanda: "1" } });
  const cmd3 = q("SELECT * FROM comenzi WHERE id = ?", [oferta(oLei).comanda_id])[0];
  const ctr3 = q("SELECT valoare, observatii FROM contracte WHERE id = ?", [oferta(oLei).contract_id])[0];
  egal("oferta în lei: comandă în lei fără curs, contract cu valoarea ei și fără mențiune", [cmd3.moneda, cmd3.curs_bnr, Number(cmd3.curs_manual), Number(ctr3.valoare), ctr3.observatii], ["RON", null, 0, 30, null]);

  console.log("\n── Lista de oferte, emailul, pâlnia, depozitul ──────────────");
  r = await cer("/oferte", { query: { status: "acceptata", perioada: "tot" } });
  const randOf = (id) => (new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?href="/oferte/${id}"[\\s\\S]*?</tr>`).exec(r.corp) || [""])[0];
  are(randOf(oV2), "53,73 €", "lista: oferta în euro își arată valoarea în euro");
  are(randOf(oV2), "≈ 279,40 lei", "…cu echivalentul în lei la cursul ei");
  egal("lista: oferta în lei, ca până acum", [randOf(oLei).includes("30,00 lei"), randOf(oLei).includes("≈")], [true, false]);
  const EM = require(path.join(RAD, "modules", "email.js"));
  const liniiEm = q("SELECT denumire, um, cantitate, pret_unitar, cota_tva FROM oferte_linii WHERE oferta_id = ? ORDER BY id", [oV2]);
  const text = EM.corpOferta(Object.assign({}, oferta(oV2), { client: "OM CLIENT EURO SRL" }), liniiEm, { nume: "Vali Oferta" }, "");
  are(text, "0,0345 EUR", "emailul: prețul unitar în euro, cu patru zecimale");
  are(text, "53,73 EUR", "…totalul fără TVA în euro");
  are(text, "65,01 EUR", "…totalul de plată în euro");
  are(text, "Prețurile sunt în euro (EUR).", "…și o spune și cu vorbe");
  fara(text, " lei", "…fără „lei” nicăieri");
  const textLei = EM.corpOferta(Object.assign({}, oferta(oLei), { client: "OM CLIENT EURO SRL" }), q("SELECT denumire, um, cantitate, pret_unitar, cota_tva FROM oferte_linii WHERE oferta_id = ? ORDER BY id", [oLei]), { nume: "Vali Oferta" }, "");
  egal("emailul ofertei în lei: ca până acum", [textLei.includes("10,00 lei"), textLei.includes("30,00 lei"), textLei.includes("Prețurile sunt în lei."), textLei.includes("EUR")], [true, true, true, false]);
  // pâlnia: sumele se adună în lei, la cursul fiecărui document
  const pal = q(`SELECT o.id, (SELECT SUM(l.cantitate * l.pret_unitar) FROM oferte_linii l WHERE l.oferta_id = o.id) * ${CC.sqlFactorLei("o")} AS lei FROM oferte o WHERE o.id IN (${oV2}, ${oLei}, ${oBnr}) ORDER BY o.id`).map((x) => [Number(x.id), Math.round(Number(x.lei) * 100) / 100]);
  egal("în SQL: oferta în euro intră cu leii ei (× cursul), cea în lei cu suma ei", pal.sort((a, b) => a[0] - b[0]), [[oLei, 30], [oBnr, 980], [oV2, 279.4]].sort((a, b) => a[0] - b[0]));
  exec(`UPDATE comenzi SET curs_bnr = NULL, curs_bnr_data = NULL WHERE id = ${cmd2.id}`);
  const cz = q(`SELECT c.id, COALESCE((SELECT SUM(l.cantitate * l.pret_unitar) FROM comenzi_linii l WHERE l.comanda_id = c.id), 0) * ${CC.sqlFactorLei("c")} AS lei FROM comenzi c WHERE c.id IN (${cmd.id}, ${cmd2.id}, ${cmd3.id}) ORDER BY c.id`).map((x) => [Number(x.id), Math.round(Number(x.lei) * 100) / 100]);
  egal("…comanda în euro fără curs nu se adună drept lei", cz.sort((a, b) => a[0] - b[0]), [[Number(cmd.id), 279.4], [Number(cmd2.id), 0], [Number(cmd3.id), 30]].sort((a, b) => a[0] - b[0]));
  // pâlnia agentului, așa cum o socotește CRM-ul
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "5,2", { titlu: "Trimisa, euro" }) });
  const oTr = idDinLocatie(r);
  await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oTr) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "100", pret_unitar: "2", cota_tva: "21" } });
  r = await cer("/oferte", { metoda: "post", body: { partener_id: String(CLIENT), titlu: "Trimisa, lei" } });
  const oTrLei = idDinLocatie(r);
  await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oTrLei) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "3", pret_unitar: "", cota_tva: "21" } });
  exec(`UPDATE oferte SET status = 'trimisa' WHERE id IN (${oTr}, ${oTrLei})`);
  const CRM = require(path.join(RAD, "modules", "crm.js"));
  const tr = await CRM.trepteleP(ADMIN.id);
  const treapta = (eticheta) => tr.trepte.find((x) => x.label === eticheta) || {};
  egal("pâlnia agentului: ofertele trimise se adună în lei (100 × 2 € × 5,2 + 30 lei)", [treapta("Oferte trimise").n, Math.round(treapta("Oferte trimise").valoare * 100) / 100], [2, 1070]);
  egal("…și comenzile lui: 279,40 + 0 (cea în euro fără curs) + 30", Math.round(treapta("Comenzi").valoare * 100) / 100, 309.4);
  r = await cer("/depozit");
  const randDep = (c) => (new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?href="/depozit/comanda/${c}"[\\s\\S]*?</tr>`).exec(r.corp) || [""])[0];
  are(randDep(cmd.id), "53,73 €", "lista depozitului: comanda în euro își arată suma în euro");
  are(randDep(cmd.id), "≈ 279,40 lei", "…cu echivalentul în lei");
  egal("…cea în euro fără curs: doar euro; cea în lei: ca până acum", [randDep(cmd2.id).includes("200,00 €"), randDep(cmd2.id).includes("≈"), randDep(cmd3.id).includes("30,00 lei"), randDep(cmd3.id).includes("≈")], [true, false, true, false]);

  console.log("\n── Când BNR-ul nu răspunde ──────────────────────────────────");
  const CURS = require(path.join(RAD, "modules", "curs.js"));
  const laZiuaBun = CURS.laZiua;
  CURS.laZiua = async () => null;
  try {
    inainte = nrOferte();
    r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "") });
    egal("oferta în euro cu cursul gol nu se face: cursul se cere, nu se ghicește", [nrOferte() - inainte, /BNR nu are acum curs pentru EUR/.test(parametri(r).eroare || "")], [0, true]);
    r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "5,15", { titlu: "Fara BNR" }) });
    const oMut = idDinLocatie(r);
    egal("…dar cu cursul scris se face", cursul(oferta(oMut)), ["EUR", 5.15, null, 1]);
    r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMut) }, body: { pret_moneda: "EUR", pret_curs: "" } });
    egal("câmpul golit: cursul bun al ofertei rămâne", cursul(oferta(oMut)), ["EUR", 5.15, null, 1]);
    r = await cer("/oferte", { metoda: "post", body: { partener_id: String(CLIENT), titlu: "In lei, fara BNR" } });
    const oMutLei = idDinLocatie(r);
    r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMutLei) }, body: { pret_moneda: "EUR", pret_curs: "" } });
    egal("oferta în lei nu trece pe euro fără curs: rămâne în lei și cere cursul", [cursul(oferta(oMutLei)), /BNR nu are acum curs pentru EUR\. Scrie cursul/.test(parametri(r).eroare || "")], [["RON", null, null, 0], true]);
    r = await cer("/oferte/:id/moneda", { metoda: "post", params: { id: String(oMutLei) }, body: { pret_moneda: "EUR", pret_curs: "5,3" } });
    egal("…cu cursul scris, trece", cursul(oferta(oMutLei)), ["EUR", 5.3, null, 1]);
    exec(`UPDATE oferte SET curs_bnr = 4.9, curs_bnr_data = '2026-10-01', curs_manual = 0 WHERE id = ${oMut}`);
    await cer("/oferte/:id/linii", { metoda: "post", params: { id: String(oMut) }, body: { produs_id: String(PRODUS), denumire: "", um: "buc", cantitate: "10", pret_unitar: "3", cota_tva: "21" } });
    r = await cer("/oferte/:id/spre-comanda", { metoda: "post", params: { id: String(oMut) } });
    const cMut = q("SELECT * FROM comenzi WHERE id = ?", [oferta(oMut).comanda_id])[0] || {};
    egal("comanda făcută acum din ofertă ia cursul ofertei, cu data lui — nu rămâne fără curs", [cMut.moneda, nr(cMut.curs_bnr), cMut.curs_bnr_data, Number(cMut.curs_manual)], ["EUR", 4.9, "2026-10-01", 0]);
  } finally {
    CURS.laZiua = laZiuaBun;
  }

  console.log("\n── Comanda ștearsă ──────────────────────────────────────────");
  const deSters = (numar, moneda, curs, pretLinie) => {
    const c = Number(q("INSERT INTO comenzi (partener_id, numar, data, status, moneda, curs_bnr, curs_manual) VALUES (?, ?, ?, 'noua', ?, ?, ?) RETURNING id", [CLIENT, numar, azi, moneda, curs, curs ? 1 : 0])[0].id);
    exec(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${c}, ${PRODUS}, 100, ${pretLinie})`);
    return c;
  };
  const urma = (numar) => q("SELECT descriere, 1 AS x FROM interactiuni WHERE partener_id = ? AND subiect = ?", [CLIENT, `Comanda ${numar} a fost ștearsă`]).map((x) => String(x.descriere).replace(/^.*valoare /, ""));
  r = await cer("/comenzi/:id/sterge", { metoda: "post", params: { id: String(deSters("OM-DEL-EUR", "EUR", 5.2, 2)) } });
  egal("comanda în euro: în istoricul clientului rămâne valoarea în euro", urma("OM-DEL-EUR"), ["200,00 €."]);
  r = await cer("/comenzi/:id/sterge", { metoda: "post", params: { id: String(deSters("OM-DEL-LEI", "RON", null, 7.5)) } });
  egal("comanda în lei: valoarea în lei", urma("OM-DEL-LEI"), ["750,00 lei."]);

  console.log("\n── Calculatorul de preț ─────────────────────────────────────");
  exec("INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES (97622,'OM-2','OM Calculator produs','buc',1)");
  const calc = (dest, extra) => cer("/calculator/adauga", { metoda: "post", body: Object.assign({ partener_id: String(CLIENT), cantitate: "100", pret: "10.4000", cost: "8.0000", denumire: "OM Calculator produs", denumire_afisata: "OM Calculator produs", um: "buc", destinatie: dest }, extra || {}) });
  const liniiCalc = (id) => q("SELECT produs_id, cantitate, pret_unitar FROM oferte_linii WHERE oferta_id = ? AND produs_id = 97622 ORDER BY id", [id]).map((l) => [Number(l.produs_id), Number(l.cantitate), Number(l.pret_unitar)]);
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "5,2", { titlu: "Din calculator, euro" }) });
  const oCalc = idDinLocatie(r);
  r = await calc("oferta:" + oCalc);
  egal("pe oferta în euro, prețul din calculator (10,40 lei) intră trecut în euro la cursul ei (÷ 5,2)", [liniiCalc(oCalc), locatie(r)], [[[97622, 100, 2]], "/oferte/" + oCalc]);
  egal("…iar produsul își ține prețul în lei", q("SELECT pret_vanzare, pret_achizitie FROM produse WHERE id = 97622").map((x) => [Number(x.pret_vanzare), Number(x.pret_achizitie)]), [[10.4, 8]]);
  r = await cer("/oferte", { metoda: "post", body: corpNou("EUR", "5,2", { titlu: "Din calculator, fara curs" }) });
  const oFaraCurs = idDinLocatie(r);
  exec(`UPDATE oferte SET curs_bnr = NULL, curs_bnr_data = NULL, curs_manual = 0 WHERE id = ${oFaraCurs}`);
  r = await calc("oferta:" + oFaraCurs);
  egal("pe oferta în euro fără curs linia nu se pune (ar fi lei citiți drept euro) și se spune de ce", [liniiCalc(oFaraCurs), String(locatie(r)).split("?")[0], /nu are curs/.test(parametri(r).eroare || ""), parametri(r).moneda], [[], "/oferte/" + oFaraCurs, true, "1"]);
  r = await cer("/oferte/:id", { params: { id: String(oFaraCurs) }, query: parametri(r) });
  are(r.corp, "Oferta e în EUR și nu are curs", "pagina ofertei arată motivul");
  are(r.corp, "<details style=\"margin-top:10px\" open>", "…cu formularul de curs deschis");
  r = await cer("/oferte", { metoda: "post", body: { partener_id: String(CLIENT), titlu: "Din calculator, lei" } });
  const oCalcLei = idDinLocatie(r);
  r = await calc("oferta:" + oCalcLei);
  egal("pe oferta în lei prețul intră cum e", liniiCalc(oCalcLei), [[97622, 100, 10.4]]);
  inainte = nrOferte();
  r = await calc("oferta_noua");
  const oCalcNoua = idDinLocatie(r);
  egal("oferta nouă făcută din calculator e în lei, cu prețul lui", [nrOferte() - inainte, cursul(oferta(oCalcNoua)), liniiCalc(oCalcNoua)], [1, ["RON", null, null, 0], [[97622, 100, 10.4]]]);
  r = await calc("oferta:999999999");
  egal("ofertă care nu există: înapoi la calculator, fără eroare de bază", locatie(r), "/calculator");
  const catId = Number(q("INSERT INTO calculator_categorii (nume, descriere, campuri, formula_cost, um, activ) VALUES ('OM categorie de test', 'test', ?, 'cost_achizitie + manipulare', 'buc', 1) RETURNING id", [JSON.stringify([{ cheie: "cost_achizitie", eticheta: "Cost achiziție", unitate: "lei/buc", implicit: 8 }, { cheie: "manipulare", eticheta: "Manipulare", unitate: "lei/buc", implicit: 0 }])])[0].id);
  r = await cer("/calculator", { query: { categorie: String(catId) } });
  const optiune = (id) => (new RegExp(`<option value="oferta:${id}">[^<]*</option>`).exec(r.corp) || [""])[0];
  egal("în lista „Unde”, oferta în euro își spune moneda; cea în lei, nu", [/ · în EUR<\/option>$/.test(optiune(oCalc)), optiune(oCalcLei) !== "" && !/ · în /.test(optiune(oCalcLei))], [true, true]);
  are(r.corp, "data-calc-valuta", "…și sub listă scrie că prețul în lei intră trecut în moneda ofertei");

  console.log("\n── Valoarea estimată a comenzii de producție ────────────────");
  exec("INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES (97623,'OM-3','OM Folie de produs','buc',1)");
  const termen = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  async function cerereConfirmata(moneda, curs, manual, pretLinie) {
    const c = Number(q("INSERT INTO comenzi (partener_id, numar, data, status, moneda, curs_bnr, curs_manual) VALUES (?, ?, ?, 'confirmata', ?, ?, ?) RETURNING id", [CLIENT, "OM-CP-" + moneda + "-" + (curs || 0), azi, moneda, curs, manual])[0].id);
    const l = Number(q("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (?, 97623, 100, ?, 'buc') RETURNING id", [c, pretLinie])[0].id);
    const a = Number(q("INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, um, sursa, status, termen_cerut) VALUES (?, ?, 97623, 40, 'buc', 'productie', 'ceruta', ?) RETURNING id", [c, l, termen])[0].id);
    await cer("/productie/cereri/:id/confirma", { metoda: "post", params: { id: String(a) }, body: { termen } });
    const cp = q("SELECT valoare_estimata, cantitate, 1 AS x FROM comenzi_productie WHERE aprovizionare_id = ?", [a])[0];
    return cp ? [nr(cp.valoare_estimata), cp.cantitate] : "fără comandă de producție";
  }
  egal("comanda clientului în euro la curs 5,2: 40 buc × 2 € × 5,2 = 416 lei", await cerereConfirmata("EUR", 5.2, 1, 2), [416, "40"]);
  egal("comanda în euro fără curs: valoarea rămâne nescrisă, nu 80 de euro trecuți drept lei", await cerereConfirmata("EUR", null, 0, 2), [null, "40"]);
  egal("comanda în lei: ca până acum, 40 × 7,50", await cerereConfirmata("RON", null, 0, 7.5), [300, "40"]);

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
