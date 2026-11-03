"use strict";
// Avizele de însoțire a mărfii: emise automat la ieșirea din depozit pe o
// comandă de client, sau manual din Avize. Fără prețuri.
//
// CE A CERUT VALI, 03.11.2026:
//   „Când se scoate marfa din depozit pentru livrare client se generează, în
//    loc de etichetă, aviz de însoțire a mărfii, fără preț produs, doar cu
//    produse, cantități și client. Nr. în continuare la acesta și format ca
//    cel din SmartBill” · „Fă și pagină de generare aviz manual din Financiar,
//    cu adăugare produse și fără preț; ține minte aceeași numerotare” ·
//   „Gabi Tecuceanu să aibă acces la avize de acolo” · „Avizul să aibă pe el
//    și nr. de comandă” · „Dacă nu are nr. de comandă, nu pui.”
//
// CE APĂRĂ:
//   • NUMEROTAREA: un singur contor, numere consecutive, fără dubluri; un
//     număr deja folosit oprește emiterea fără să „consume” contorul;
//   • ieșirea pe comandă dă avizul (nu etichetele), cu tot ce a plecat,
//     adunat pe produs, și cu numărul comenzii; ieșirea spre producție dă
//     tot etichetele; ieșirea parțială dă aviz doar pentru ce a plecat;
//   • avizul manual: produs din catalog sau scris liber, U.M. din catalog,
//     validări cu mesaj de om, comanda doar dacă e scrisă;
//   • foaia: datele firmei și ale clientului, Nr. crt / Denumire / U.M. /
//     Cant. — și NICIUN preț, valoare, TVA sau total;
//   • bifa „Avize” se dă separat de Financiar; contorul și anularea sunt ale
//     administratorului; anularea lasă numărul folosit și scrie ANULAT.
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
function q(sql, p) {
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
const mail = require(path.join(RAD, "lib", "mail.js"));
mail.trimite = async () => {};
mail.trimiteDeLa = async () => {};

const AV = require(path.join(RAD, "lib", "aviz.js"));
const auth = require(path.join(RAD, "lib", "auth.js"));
const avize = require(path.join(RAD, "modules", "avize.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
// Ordinea din server.js: avizele înaintea depozitului.
avize.register(router);
require(path.join(RAD, "modules", "ct-park.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b === undefined ? "" : String(b); };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const GABI = { id: 97602, nume: "Gabi Test", rol: "depozit", sectiuni: "/crm,/comenzi,/depozit,/avize" };
async function cer(metoda, cale, { user = VALI, params = {}, query = {}, body = {} } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body, res: r, req: { url: cale } });
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
function contine(eticheta, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !corp.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => corp.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta);
}
const FARA_PRET = ["Pret", "Preț", "Valoare", "Valoarea", "TVA", "Total", "lei", "Lei"];

const CURATENIE = [
  "UPDATE ct_iesiri SET aviz_id = NULL WHERE palet_id BETWEEN 97481 AND 97489",
  "DELETE FROM avize_linii WHERE aviz_id IN (SELECT id FROM avize WHERE serie = 'TST' OR partener_id BETWEEN 97101 AND 97109)",
  "DELETE FROM avize WHERE serie = 'TST' OR partener_id BETWEEN 97101 AND 97109",
  "DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id BETWEEN 97481 AND 97489)",
  "DELETE FROM ct_iesiri WHERE palet_id BETWEEN 97481 AND 97489",
  "DELETE FROM ct_ocupari WHERE palet_id BETWEEN 97481 AND 97489",
  "DELETE FROM ct_palet_linii WHERE palet_id BETWEEN 97481 AND 97489",
  "DELETE FROM ct_paleti WHERE id BETWEEN 97481 AND 97489",
  "DELETE FROM comenzi_linii WHERE comanda_id BETWEEN 97191 AND 97199",
  "DELETE FROM comenzi WHERE id BETWEEN 97191 AND 97199",
  "DELETE FROM produse WHERE id BETWEEN 97501 AND 97509",
  "DELETE FROM parteneri WHERE id BETWEEN 97101 AND 97109",
];
const contorVechi = q("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator')");
function refaContor() {
  exec("DELETE FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator')");
  for (const r of contorVechi) exec(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (${lit(r.cheie)}, ${lit(r.valoare)}, '2026-11-03')`);
}

(async () => {
  for (const s of CURATENIE) exec(s);
  exec("DELETE FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator')");
  exec("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('aviz_serie','TST','2026-11-03'), ('aviz_urmator','5001','2026-11-03')");
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING");
  exec(`INSERT INTO parteneri (id, nume, cui, tip, adresa, judet) VALUES
          (97101, 'CLIENT AVIZ TEST SRL', 'RO97101', 'client', 'Str. Test 1, Loc. Voluntari', 'Ilfov'),
          (97102, 'AL DOILEA CLIENT TEST SRL', 'RO97102', 'client', 'Sos. Virtutii 148, Sector 6, Jud. Bucuresti', 'Bucuresti')`);
  exec(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES
          (97501, 'AVZ-1', 'Cutii tip III 250X150X50 TEST', 'buc', 7.28),
          (97502, 'AVZ-2', 'Folie stretch TEST 23my', 'kg', 9.5)`);
  exec(`INSERT INTO comenzi (id, partener_id, numar, status) VALUES (97191, 97101, 'CMD-T-1', 'noua')`);

  // --- foaia, fără bază de date -------------------------------------------------
  const ag = AV.agrega([
    { produs_id: 1, denumire: "A", um: "buc", cantitate: 100, palet: "P1" },
    { produs_id: 2, denumire: "B", um: "kg", cantitate: "2,5" },
    { produs_id: 1, denumire: "A", um: "buc", cantitate: 50, palet: "P2" },
    { produs_id: 3, denumire: "C", um: "buc", cantitate: 0 },
  ]);
  egal("liniile aceluiași produs se adună, în ordinea apariției", ag.map((x) => [x.denumire, x.cantitate, x.paleti.join("+")]), [["A", 150, "P1+P2"], ["B", 2.5, ""]]);
  egal("data se scrie ca pe avizul din SmartBill", AV.dataAviz("2026-11-03"), "03/11/2026");
  egal("adresa ia județul din fișă când lipsește", AV.adresaClient({ adresa: "Str. Test 1, Loc. Voluntari", judet: "Ilfov" }), "Str. Test 1, Loc. Voluntari, Jud. Ilfov");
  egal("…și nu-l dublează când e deja scris", AV.adresaClient({ adresa: "Sos. Virtutii 148, Jud. Bucuresti", judet: "Bucuresti" }), "Sos. Virtutii 148, Jud. Bucuresti");

  // --- numerotarea ----------------------------------------------------------------
  const a1 = await avize.emite({ partenerId: 97101, linii: [{ produs_id: 97501, denumire: "Cutii", um: "buc", cantitate: 10 }], creatDe: "Vali", sursa: "manual" });
  const a2 = await avize.emite({ partenerId: 97101, linii: [{ produs_id: 97501, denumire: "Cutii", um: "buc", cantitate: 20 }], creatDe: "Vali", sursa: "manual" });
  egal("numerele sunt consecutive, din contorul comun", [a1.serie, a1.numar, a2.numar], ["TST", 5001, 5002]);
  egal("contorul arată următorul", unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_urmator'"), "5003");
  exec("UPDATE setari_app SET valoare = '5001' WHERE cheie = 'aviz_urmator'");
  let mesaj = "";
  try { await avize.emite({ partenerId: 97101, linii: [{ denumire: "X", um: "buc", cantitate: 1 }], creatDe: "Vali" }); } catch (e) { mesaj = e.message; }
  if (!/5001.*deja folosit/.test(mesaj)) rau("un număr folosit nu e oprit cu mesaj de om", mesaj);
  else ok("un număr deja folosit oprește emiterea: " + mesaj);
  egal("…și contorul nu se mișcă la emiterea oprită", unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_urmator'"), "5001");
  egal("nu s-a scris niciun aviz dublu", Number(unul("SELECT COUNT(*) FROM avize WHERE serie = 'TST' AND numar = 5001")), 1);
  exec("UPDATE setari_app SET valoare = '5003' WHERE cheie = 'aviz_urmator'");
  mesaj = "";
  try { await avize.emite({ partenerId: 97101, linii: [{ denumire: "X", um: "buc", cantitate: 0 }] }); } catch (e) { mesaj = e.message; }
  if (!/nicio linie/.test(mesaj)) rau("un aviz fără linii nu e oprit", mesaj); else ok("un aviz fără nicio cantitate nu se emite");

  // --- accesul: bifa „Avize” e separată de Financiar --------------------------------
  egal("cu bifa Avize: lista, avizul nou și foaia", ["/avize", "/avize/nou", "/avize/12"].map((p) => auth.poateAccesa(GABI, p)), [true, true, true]);
  egal("bifa Avize nu deschide Financiarul", auth.poateAccesa(GABI, "/financiar"), false);
  egal("fără bifa Avize, nu intră", auth.poateAccesa({ rol: "depozit", sectiuni: "/depozit" }, "/avize"), false);
  egal("rolul financiar are avizele din oficiu", auth.poateAccesa({ rol: "financiar" }, "/avize"), true);
  egal("agentul de vânzări nu le are din oficiu", auth.poateAccesa({ rol: "vanzari" }, "/avize"), false);
  egal("bifa Avize apare la utilizatori", auth.ZONE.some((z) => z.cheie === "/avize" && z.eticheta === "Avize"), true);

  // Gabi intră în Depozit prin CT-Park, unde bara de taburi e a lui CT-Park:
  // „Avize” trebuie să fie acolo, lângă „Ieșire marfă” — dar numai cu bifa.
  let rt = await cer("get", "/stocuri/ct-park/iesire", { user: GABI });
  contine("în CT-Park, cine are bifa vede taburile Avize și Aviz nou", rt.corp, ['href="/avize" class="subnav-link', 'href="/avize/nou" class="subnav-link']);
  rt = await cer("get", "/stocuri/ct-park/iesire", { user: { id: 97603, nume: "Fără bifă", rol: "depozit", sectiuni: "/depozit" } });
  contine("…fără bifă, taburile nu apar", rt.corp, [], ['href="/avize"', 'href="/avize/nou"']);

  // „Pune linkul în comenzi, ăla cu avize" (Vali, 03.11.2026).
  const R = require(path.join(RAD, "lib", "render.js"));
  contine("în Comenzi, linkul Avize apare cu bifa", R.subnavComenzi("/comenzi", GABI), ['href="/avize"']);
  contine("…și lipsește fără bifă", R.subnavComenzi("/comenzi", { rol: "vanzari" }), [], ['href="/avize"']);

  // --- avizul manual ---------------------------------------------------------------------
  let r = await cer("get", "/avize/nou", { user: GABI });
  contine("formularul de aviz manual", r.corp, ["Aviz de însoțire nou", 'name="produs[]"', 'name="cantitate[]"', 'name="comanda_numar"', "TST 5003", "AVZ-1 — Cutii tip III 250X150X50 TEST", 'data-um="kg"'], ["pret_unitar", "Preț"]);
  r = await cer("post", "/avize", { user: GABI, body: { partener_id: "", "produs[]": ["AVZ-1 — Cutii tip III 250X150X50 TEST"], "cantitate[]": ["5"] } });
  contine("fără client nu se emite", r.corp, ["Alege clientul"]);
  r = await cer("post", "/avize", { user: GABI, body: { partener_id: "97101", "produs[]": ["Ceva", ""], "cantitate[]": ["0", ""], "um[]": ["", ""] } });
  contine("cantitatea 0 e oprită, cu rândul și produsul", r.corp, ["Rândul 1 (Ceva)", "mai mare ca 0"]);
  r = await cer("post", "/avize", { user: GABI, body: { partener_id: "97101", "produs[]": ["", ""], "cantitate[]": ["", ""] } });
  contine("fără niciun produs nu se emite", r.corp, ["Adaugă cel puțin un produs"]);
  const inainte = Number(unul("SELECT COUNT(*) FROM avize WHERE serie = 'TST'"));
  r = await cer("post", "/avize", {
    user: GABI,
    body: {
      partener_id: "97101", comanda_numar: "CMD-EXT-9", delegat: "Ion Delegat", transport: "B 12 ABC", observatii: "fragil",
      "produs[]": ["AVZ-1 — Cutii tip III 250X150X50 TEST", "Folie stretch TEST 23my", "Paleți EURO", ""],
      "um[]": ["", "", "buc", ""],
      "cantitate[]": ["150", "2,5", "3", ""],
    },
  });
  const m = locatie(r).match(/^\/avize\/(\d+)$/);
  if (!m) rau("avizul manual nu duce la foaia lui", locatie(r) || r.corp.slice(0, 300));
  else ok("avizul manual s-a emis și duce la foaie — " + locatie(r));
  egal("s-a scris un singur aviz nou", Number(unul("SELECT COUNT(*) FROM avize WHERE serie = 'TST'")) - inainte, 1);
  const idManual = m ? m[1] : "0";
  egal("liniile: produs din catalog, U.M. din catalog, text liber",
    q(`SELECT produs_id, denumire, cod, um, cantitate FROM avize_linii WHERE aviz_id = ${idManual} ORDER BY id`).map((x) => [x.produs_id, x.denumire, x.cod, x.um, Number(x.cantitate)]),
    [["97501", "Cutii tip III 250X150X50 TEST", "AVZ-1", "buc", 150], ["97502", "Folie stretch TEST 23my", "AVZ-2", "kg", 2.5], [null, "Paleți EURO", null, "buc", 3]]);
  egal("emis de cine l-a scris, cu numărul următor", q(`SELECT numar, creat_de, sursa, comanda_numar FROM avize WHERE id = ${idManual}`)[0], { numar: "5003", creat_de: "Gabi Test", sursa: "manual", comanda_numar: "CMD-EXT-9" });

  r = await cer("get", "/avize/:id", { user: GABI, params: { id: idManual } });
  const foaie = r.corp;
  contine("foaia: titlul, seria, data, furnizorul", foaie, ["AVIZ DE ÎNSOȚIRE", "Seria TST nr. 5003", "Data (zi/luna/an): " + AV.dataAviz(avize.aziRo()), "CASH MACHINE S.R.L.", "J2010002107232", "RO27244210"]);
  contine("foaia: clientul și comanda", foaie, ["Client: CLIENT AVIZ TEST SRL", "CIF: RO97101", "Str. Test 1, Loc. Voluntari, Jud. Ilfov", "Comanda nr.: CMD-EXT-9"]);
  contine("foaia: tabelul și liniile", foaie, ["Nr. crt", "Denumirea produselor sau a serviciilor", "U.M.", "Cant.", "Cutii tip III 250X150X50 TEST", "150", "2,5", "Paleți EURO"]);
  contine("foaia: delegatul, transportul, observațiile, întocmit de", foaie, ["Numele delegatului: Ion Delegat", "Mijloc transport: B 12 ABC", "Observații: fragil", "Întocmit de: Gabi Test", "Semnătura de primire"]);
  const corpFoaie = foaie.slice(foaie.indexOf('<div class="foaie">'));
  contine("foaia NU are prețuri, valori, TVA sau total", corpFoaie, [], FARA_PRET);
  contine("foaia e A4", foaie, ["@page { size: A4;"]);

  // „Dacă nu are nr. de comandă, nu pui."
  r = await cer("post", "/avize", { user: GABI, body: { partener_id: "97102", "produs[]": ["AVZ-1"], "um[]": [""], "cantitate[]": ["7"] } });
  const idFara = (locatie(r).match(/^\/avize\/(\d+)$/) || [])[1];
  r = await cer("get", "/avize/:id", { user: GABI, params: { id: idFara } });
  contine("fără număr de comandă, rândul nu apare deloc", r.corp, ["AL DOILEA CLIENT TEST SRL", "Cutii tip III 250X150X50 TEST"], ["Comanda nr."]);

  // --- lista, contorul, anularea --------------------------------------------------------
  r = await cer("get", "/avize", { user: GABI });
  contine("lista arată avizele, fără formularul de contor pentru ne-admin", r.corp, ["TST 5003", "CLIENT AVIZ TEST SRL", "CMD-EXT-9", "Următorul aviz"], ['action="/avize/contor"']);
  r = await cer("get", "/avize", { user: VALI });
  contine("adminul vede contorul", r.corp, ['action="/avize/contor"', "SmartBill"]);
  r = await cer("post", "/avize/contor", { user: GABI, body: { serie: "TST", urmator: "9000" } });
  egal("ne-adminul nu schimbă contorul", [/eroare=/.test(locatie(r)), unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_urmator'")], [true, "5005"]);
  r = await cer("post", "/avize/contor", { user: VALI, body: { serie: "TST", urmator: "5002" } });
  egal("nu se poate pune un număr deja folosit", [decodeURIComponent(locatie(r)).includes("până la nr. 5004"), unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_urmator'")], [true, "5005"]);
  r = await cer("post", "/avize/contor", { user: VALI, body: { serie: "tst", urmator: "5010" } });
  egal("adminul mută contorul înainte", [unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_serie'"), unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_urmator'")], ["TST", "5010"]);
  r = await cer("post", "/avize/:id/anuleaza", { user: GABI, params: { id: idFara }, body: { motiv: "greșit" } });
  egal("ne-adminul nu anulează", unul(`SELECT anulat FROM avize WHERE id = ${idFara}`), "0");
  r = await cer("post", "/avize/:id/anuleaza", { user: VALI, params: { id: idFara }, body: { motiv: "client greșit" } });
  egal("adminul anulează, cu motiv", q(`SELECT anulat, motiv_anulare LIKE 'client greșit%' AS m FROM avize WHERE id = ${idFara}`)[0], { anulat: "1", m: "t" });
  r = await cer("get", "/avize/:id", { user: VALI, params: { id: idFara } });
  contine("foaia anulată scrie ANULAT și motivul", r.corp, ['<div class="anulat">ANULAT</div>', "client greșit"]);
  egal("numărul anulat rămâne folosit", Number(unul(`SELECT COUNT(*) FROM avize WHERE serie = 'TST' AND numar = 5004`)), 1);

  // --- ieșirea din depozit pe comandă → avizul ----------------------------------------------
  exec(`INSERT INTO ct_paleti (id, cod, produs_id, cantitate, um, data_intrare) VALUES
          (97481, 'CT261103-9481', 97501, 100, 'buc', '2026-11-01'),
          (97482, 'CT261103-9482', 97501, 50, 'buc', '2026-11-01'),
          (97483, 'CT261103-9483', 97502, 40, 'kg', '2026-11-01'),
          (97484, 'CT261103-9484', 97502, 80, 'kg', '2026-11-01')`);
  exec(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES
          (97481, 97501, 100, 'buc'), (97482, 97501, 50, 'buc'), (97483, 97502, 40, 'kg'), (97484, 97502, 80, 'kg')`);
  r = await cer("post", "/stocuri/ct-park/iesire", { user: VALI, body: { paleti: ["97481", "97482"], destinatie: "comanda", comanda_id: "97191" } });
  const mi = locatie(r).match(/^\/stocuri\/ct-park\/aviz\/(\d+)\?paleti=97481,97482$/);
  if (!mi) rau("ieșirea pe comandă nu duce la aviz", locatie(r));
  else ok("ieșirea pe comandă duce la aviz, nu la etichete — " + locatie(r));
  const idDepozit = mi ? mi[1] : "0";
  egal("avizul are tot ce a plecat, adunat pe produs", q(`SELECT denumire, um, cantitate, paleti FROM avize_linii WHERE aviz_id = ${idDepozit}`).map((x) => [x.denumire, x.um, Number(x.cantitate), x.paleti]),
    [["Cutii tip III 250X150X50 TEST", "buc", 150, "CT261103-9481, CT261103-9482"]]);
  egal("avizul e pe client, cu comanda, din depozit, cu numărul următor", q(`SELECT numar, partener_id, comanda_id, comanda_numar, sursa FROM avize WHERE id = ${idDepozit}`)[0],
    { numar: "5010", partener_id: "97101", comanda_id: "97191", comanda_numar: "CMD-T-1", sursa: "depozit" });
  egal("ieșirile paleților țin minte avizul", q("SELECT aviz_id FROM ct_iesiri WHERE palet_id IN (97481, 97482) ORDER BY palet_id").map((x) => x.aviz_id), [idDepozit, idDepozit]);
  r = await cer("get", "/stocuri/ct-park/aviz/:id", { user: GABI, params: { id: idDepozit }, query: { paleti: "97481,97482" } });
  contine("foaia din depozit: comanda, linkul spre etichete, fără prețuri", r.corp, ["Seria TST nr. 5010", "Comanda nr.: CMD-T-1", "/stocuri/ct-park/etichete?paleti=97481,97482", "înapoi la depozit"], ["7,28", "7.28"]);

  r = await cer("post", "/stocuri/ct-park/iesire", { user: VALI, body: { paleti: ["97483"], destinatie: "productie" } });
  egal("ieșirea spre producție dă tot etichetele, fără aviz", [locatie(r), Number(unul("SELECT COUNT(*) FROM ct_iesiri WHERE palet_id = 97483 AND aviz_id IS NOT NULL"))], ["/stocuri/ct-park/etichete?paleti=97483", 0]);

  // --- ieșirea parțială pe comandă → aviz doar pentru ce a plecat --------------------------
  const linie = unul("SELECT id FROM ct_palet_linii WHERE palet_id = 97484");
  r = await cer("post", "/stocuri/ct-park/palet/:id/scoate-partial", {
    user: VALI, params: { id: "97484" },
    body: { destinatie: "comanda", comanda_id: "97191", ["pleaca_" + linie]: "30", ["ramane_" + linie]: "50" },
  });
  const mp = locatie(r).match(/^\/stocuri\/ct-park\/aviz\/(\d+)\?palet=97484&mesaj=/);
  if (!mp) rau("ieșirea parțială pe comandă nu duce la aviz", locatie(r));
  else ok("ieșirea parțială pe comandă duce la aviz");
  egal("avizul parțial are doar ce a plecat", mp ? q(`SELECT denumire, um, cantitate FROM avize_linii WHERE aviz_id = ${mp[1]}`).map((x) => [x.denumire, x.um, Number(x.cantitate)]) : null,
    [["Folie stretch TEST 23my", "kg", 30]]);
  egal("pe palet rămâne restul", Number(unul("SELECT cantitate FROM ct_palet_linii WHERE palet_id = 97484")), 50);

  for (const s of CURATENIE) exec(s);
  refaContor();
  console.log(rele ? "\n" + rele + " probleme." : "\nTotul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  for (const s of CURATENIE) { try { exec(s); } catch (x) { /* best-effort */ } }
  try { refaContor(); } catch (x) { /* best-effort */ }
  process.exit(1);
});
