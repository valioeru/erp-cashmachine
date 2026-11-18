"use strict";
// Numerele din ERP continuă după cele din SmartBill (proforme, avize).
//
// CEREREA LUI VALI, 18.11.2026: „ia codurile pentru proforme, facturi etc. în
// continuare din SmartBill, și pentru avize" · „momentan va fi 2" (se emit și
// în SmartBill, și în ERP; ERP-ul sare peste ce s-a emis acolo).
//
// CE APĂRĂ:
//   • contorul ERP-ului urcă până la numărul curent din SmartBill, pe aceeași
//     serie, și nu coboară niciodată;
//   • adresa prin care vin numerele nu cere sesiune, deci nu poate arunca
//     contorul oriunde: salt mărginit, doar cifre, doar seria ERP-ului;
//   • pagina spune unde e SmartBill, iar când ERP-ul e înainte, câte numere se
//     vor dubla și ce număr trebuie pus în SmartBill;
//   • scriptul de sincronizare citește tabelul de serii și îl trimite odată cu
//     facturile, doar pe Cash Machine, fără să strice facturile dacă pică.
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
  options: () => {},
};
for (const m of ["proforme", "avize", "punte"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98011, nume: "Vali Test", rol: "admin", email: "v.ss@test.ro" };
const AGENT = { id: 98012, nume: "Gabriela Test", rol: "vanzari", email: "g.ss@test.ro" };

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


const SS = require(path.join(RAD, "lib", "serii-smartbill.js"));
const CHEI = ["proforma_serie", "proforma_urmator", "aviz_serie", "aviz_urmator", "smartbill_proforma_vazut", "smartbill_aviz_vazut"];
let vechi = [];
const setare = (k) => (q("SELECT valoare, 1 AS x FROM setari_app WHERE cheie = ?", [k])[0] || {}).valoare || null;
const pune = (k, v) => exec(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('${k}', '${String(v).replace(/'/g, "''")}', '2026-11-18') ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare`);
function laLoc() {
  for (const [k, v] of vechi) { if (v === null) exec(`DELETE FROM setari_app WHERE cheie = '${k}'`); else pune(k, v); }
}
const ingest = async (randuri) => { const r = await cer("/api/ingest", { metoda: "post", user: null, body: { tip: "serii", sursa: "test", randuri } }); return { cod: r.cod, j: JSON.parse(r.corp || "{}") }; };
const contoare = () => [setare("proforma_urmator"), setare("aviz_urmator")];
const text = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

(async () => {
  console.log("── Regula, fără bază ────────────────────────────────────────");
  egal("ce se citește din ce trimite sincronizarea: doar proforme și avize, serie curată, număr întreg; o singură dată pe serie",
    SS.curata([{ tip: "Proforma", serie: " cshp ", urmator: "0134" }, { tip: "Aviz", serie: "CHMA", urmator: 1455 }, { tip: "Factura", serie: "CSHM", urmator: "3422" }, { tip: "Aviz", serie: "CHMA", urmator: "9" },
      { tip: "Aviz", serie: "X'; DROP", urmator: "5" }, { tip: "Proforma", serie: "P2", urmator: "12a" }, { tip: "Proforma", serie: "P3", urmator: "-4" }, { tip: "Proforma", serie: "P4", urmator: "0" }, null, "x"]),
    [{ tip: "proforma", serie: "CSHP", urmator: 134 }, { tip: "aviz", serie: "CHMA", urmator: 1455 }]);
  egal("ce nu e listă nu se citește", [SS.curata(null), SS.curata({}), SS.curata("x")], [[], [], []]);
  const h = (eu, sb, se = "CSHP", ss = "CSHP") => SS.hotaraste({ serie: se, urmator: eu }, { serie: ss, urmator: sb });
  egal("SmartBill mai departe: ERP-ul urcă până acolo", [h(134, 137).urca, h("134", 135).urca, h(1, 2001).urca], [137, 135, 2001]);
  egal("la zi sau SmartBill în urmă: nu se atinge (nu coboară niciodată)", [h(134, 134), h(1461, 1455)], [{ urca: null, motiv: "la zi" }, { urca: null, motiv: "SmartBill e în urmă" }]);
  egal("altă serie decât a ERP-ului: nu se atinge; literele mari/mici nu contează", [h(1, 500, "PF", "CSHP").urca, h(1, 500, "PF", "CSHP").motiv, h(1, 5, "cshp ", "CSHP").urca], [null, "altă serie decât în ERP", 5]);
  egal("salt peste 2.000: neaplicat", [h(134, 2135).urca, /salt prea mare \(2001\)/.test(h(134, 2135).motiv), h(134, 99999999).urca], [null, true, null]);
  egal("fără numere: nu se atinge", [SS.hotaraste({ serie: "A", urmator: "" }, { serie: "A", urmator: 5 }).urca, SS.hotaraste({ serie: "A", urmator: 3 }, null).urca], [null, null]);
  let s = SS.stare({ serie: "CHMA", urmator: 1461 }, { serie: "CHMA", urmator: 1455, la: "2026-11-18 17:57" }, "aviz");
  egal("pagina, când ERP-ul e înainte: câte se dublează, care numere și ce se pune în SmartBill", [s.fel, s.dubluri, s.text],
    ["in-urma", 6, "SmartBill e la CHMA 1455 (citit 2026-11-18 17:57), iar ERP-ul a ajuns la 1461. Următoarele 6 documente făcute în SmartBill vor primi numere deja folosite în ERP (CHMA 1455–1460). Ca să nu se dubleze, pune în SmartBill, la Configurare → Serii, numărul curent al seriei de avize pe 1461."]);
  s = SS.stare({ serie: "CSHP", urmator: 135 }, { serie: "CSHP", urmator: 134, la: "2026-11-18 17:57" }, "proforma");
  egal("… la un singur document, la singular", [s.dubluri, /Următoarele document făcut în SmartBill va primi un număr deja folosit în ERP \(CSHP 134\)\. .* seriei de proforme pe 135\./.test(s.text)], [1, true]);
  egal("pagina: la zi, altă serie, necitit", [SS.stare({ serie: "CSHP", urmator: 134 }, { serie: "CSHP", urmator: 134, la: "x" }, "proforma").fel, SS.stare({ serie: "CSHP", urmator: 130 }, { serie: "CSHP", urmator: 134 }, "proforma").fel, SS.stare({ serie: "PF", urmator: 1 }, { serie: "CSHP", urmator: 134 }, "proforma").fel, SS.stare({ serie: "PF", urmator: 1 }, null, "proforma").fel, SS.stare({ serie: "PF", urmator: 1 }, { serie: "PF", urmator: "x" }, "proforma").fel],
    ["la-zi", "la-zi", "alta-serie", "necitit", "necitit"]);

  console.log("\n── Scriptul de sincronizare ─────────────────────────────────");
  const cod = fs.readFileSync(path.join(RAD, "punte", "sincronizare.js"), "utf8");
  const fereastra = { location: { href: "https://cloud.smartbill.ro/raport/facturi/" } };
  new Function("window", "document", "console", "fetch", cod)(fereastra, { querySelector: () => null, body: { innerText: "" } }, { log() {} }, () => {});
  const tr = (c) => ({ querySelectorAll: () => c.map((t) => ({ innerText: t })) });
  const doc = { querySelectorAll: () => [tr(["Tip serie", "Descriere", "Serie", "Primul numar", "Numar curent"]), tr(["Factura", "", "CSHM", "134", "3422", "", ""]), tr(["Proforma", "", "CSHP", "0001", "0134", "", ""]), tr(["Aviz", "", " CHMA ", "0001", "1455", "", ""]), tr(["Aviz", "", "", "1", "5"]), tr(["Aviz", "", "X", "1", "abc"]), tr(["Chitanta", "", "CHM", "0001", "0008"]), tr(["Aviz", "x"])] };
  egal("citește din tabelul de serii doar proformele și avizele, cu seria și numărul curent", fereastra.__sync.seriiDin(doc), [{ tip: "Proforma", serie: "CSHP", urmator: "0134" }, { tip: "Aviz", serie: "CHMA", urmator: "1455" }]);
  bine("seriile pleacă odată cu facturile, doar pe Cash Machine, iar o cădere a lor nu strică facturile",
    /if \(\/CASH\\s\*MACHINE\/i\.test\(String\(firma \|\| ""\)\)\) \{\s*try \{\s*await S\.serii\(\);\s*\} catch \(e\) \{\s*log\("serii: EȘUAT"/.test(cod));
  bine("firma se ia din pagina de serii, nu din fila veche, iar pe altă firmă seriile nu se trimit",
    /return r\.length \? \{ randuri: r, firma: S\.firmaDin\(d\) \} : null;/.test(cod) && /if \(!\/CASH\\s\*MACHINE\/i\.test\(String\(citit\.firma \|\| ""\)\)\) \{\s*log\("serii: netrimise, SmartBill e pe altă firmă"[\s\S]{0,120}return 0;/.test(cod));
  bine("scriptul doar citește pagina de serii: nu trimite nimic înapoi în SmartBill", !/serii\/[^"']*["'][^)]*method:\s*"POST"/.test(cod) && /cadru\.src = "\/core\/configurare\/serii\/"/.test(cod) && /ERP \+ "\/api\/ingest"[\s\S]{0,200}tip: "serii"/.test(cod));

  console.log("\n── În ERP ───────────────────────────────────────────────────");
  vechi = CHEI.map((k) => [k, setare(k)]);
  exec("DELETE FROM utilizatori WHERE id BETWEEN 98011 AND 98019");
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98011,'Vali Test','v.ss@test.ro','x','y','admin')");
  pune("proforma_serie", "CSHP"); pune("proforma_urmator", "134"); pune("aviz_serie", "CHMA"); pune("aviz_urmator", "1461");
  exec("DELETE FROM setari_app WHERE cheie IN ('smartbill_proforma_vazut','smartbill_aviz_vazut')");
  const loturi = () => Number(q("SELECT COUNT(*) AS n, 1 AS x FROM punte_staging")[0].n);
  const inainteLoturi = loturi();

  let r = await cer("/proforme");
  bine("înainte de prima citire, pagina o spune", /data-smartbill-serie="necitit"/.test(r.corp) && text(r.corp).includes("n-a fost citit încă"));
  let x = await ingest([{ tip: "Factura", serie: "CSHM", urmator: "3422" }, { tip: "Proforma", serie: "CSHP", urmator: "0137" }, { tip: "Aviz", serie: "CHMA", urmator: "1455" }]);
  egal("SmartBill e la CSHP 137 și CHMA 1455: proformele urcă la 137, avizele rămân la 1461 (nu coboară)", [x.cod, x.j.ok, x.j.citite, x.j.urcate, x.j.neatinse, contoare()], [200, true, 2, { proforma: { serie: "CSHP", de_la: 134, la: 137 } }, { aviz: "SmartBill e în urmă" }, ["137", "1461"]]);
  egal("nu rămâne niciun lot în așteptare: seriile se aplică pe loc", loturi(), inainteLoturi);
  const vazut = JSON.parse(setare("smartbill_aviz_vazut"));
  egal("ce a văzut se ține minte, cu ora României", [vazut.serie, vazut.urmator, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(vazut.la)], ["CHMA", 1455, true]);
  r = await cer("/proforme");
  bine("pagina de proforme: SmartBill la CSHP 137, ERP-ul continuă de acolo; următoarea e CSHP 137", /data-smartbill-serie="la-zi"/.test(r.corp) && text(r.corp).includes("SmartBill e la CSHP 137") && text(r.corp).includes("ERP-ul continuă de acolo") && text(r.corp).includes("Următoarea proformă: CSHP 137"));
  r = await cer("/avize");
  bine("pagina de avize: avertizează că 6 avize făcute în SmartBill vor dubla numere și spune ce se pune acolo", /data-smartbill-serie="in-urma"/.test(r.corp) && text(r.corp).includes("Următoarele 6 documente făcute în SmartBill vor primi numere deja folosite în ERP (CHMA 1455–1460)") && text(r.corp).includes("numărul curent al seriei de avize pe 1461"));
  x = await ingest([{ tip: "Proforma", serie: "CSHP", urmator: "135" }, { tip: "Aviz", serie: "CHMA", urmator: "1463" }]);
  egal("a doua citire: avizele din SmartBill au trecut de ERP → ERP-ul urcă la 1463; proformele nu coboară de la 137", [x.j.urcate, contoare()], [{ aviz: { serie: "CHMA", de_la: 1461, la: 1463 } }, ["137", "1463"]]);
  x = await ingest([{ tip: "Proforma", serie: "CSHP", urmator: "137" }, { tip: "Aviz", serie: "CHMA", urmator: "1463" }]);
  egal("aceeași citire încă o dată: nimic de făcut", [x.j.urcate, x.j.neatinse, contoare()], [{}, { proforma: "la zi", aviz: "la zi" }, ["137", "1463"]]);

  console.log("\n── Ce nu trece ──────────────────────────────────────────────");
  x = await ingest([{ tip: "Proforma", serie: "CSHP", urmator: "999999" }, { tip: "Aviz", serie: "CHMA", urmator: "3464" }]);
  egal("un număr aruncat (salt peste 2.000) nu mută contorul", [x.j.urcate, /salt prea mare/.test(x.j.neatinse.proforma), /salt prea mare/.test(x.j.neatinse.aviz), contoare()], [{}, true, true, ["137", "1463"]]);
  x = await ingest([{ tip: "Proforma", serie: "ALTA", urmator: "500" }, { tip: "Aviz", serie: "CHMA'; DELETE FROM setari_app; --", urmator: "1470" }, { tip: "Aviz", serie: "CHMA", urmator: "1470 OR 1=1" }]);
  egal("altă serie, serie cu semne, număr cu text: contoarele rămân", [x.j.citite, x.j.urcate, contoare(), setare("aviz_serie")], [1, {}, ["137", "1463"], "CHMA"]);
  egal("seria străină (altă firmă din SmartBill) nici nu se ține minte: rămâne ce se știa despre seria ERP-ului", [JSON.parse(setare("smartbill_proforma_vazut")).serie, x.j.neatinse.proforma], ["CSHP", "altă serie decât în ERP"]);
  x = await ingest([{ tip: "Proforma", serie: "MBR", urmator: "0003" }, { tip: "Aviz", serie: "MBRA", urmator: "0004" }]);
  egal("ca pe live, 18.11: SmartBill era pe altă firmă (MBR, MBRA) — nimic urcat, nimic ținut minte", [x.j.urcate, x.j.neatinse, JSON.parse(setare("smartbill_aviz_vazut")).serie, contoare()], [{}, { proforma: "altă serie decât în ERP", aviz: "altă serie decât în ERP" }, "CHMA", ["137", "1463"]]);
  pune("smartbill_proforma_vazut", JSON.stringify({ serie: "MBR", urmator: 3, la: "2026-11-18 18:19" }));
  r = await cer("/proforme");
  bine("o citire veche pe altă serie, rămasă în bază, e spusă ca atare, nu ca număr al seriei ERP-ului", /data-smartbill-serie="alta-serie"/.test(r.corp) && text(r.corp).includes("Numărul seriei CSHP din SmartBill n-a fost citit încă (ultima citire a prins seria MBR)"));
  pune("smartbill_proforma_vazut", JSON.stringify({ serie: "CSHP", urmator: 137, la: "2026-11-18 18:30" }));
  x = await ingest([]);
  egal("fără rânduri: nimic", [x.j.ok, x.j.citite, contoare()], [true, 0, ["137", "1463"]]);
  x = await ingest("ceva");
  egal("… nici cu altceva decât o listă", [x.j.citite, contoare()], [0, ["137", "1463"]]);
  exec("UPDATE setari_app SET valoare = 'x' WHERE cheie = 'proforma_urmator'");
  x = await ingest([{ tip: "Proforma", serie: "CSHP", urmator: "140" }]);
  egal("contor stricat în ERP: nu se ghicește nimic peste el", [x.j.urcate, setare("proforma_urmator")], [{}, "x"]);
  pune("proforma_urmator", "137");

  console.log("\n── Emiterea ia numărul urcat ────────────────────────────────");
  exec("DELETE FROM proforme WHERE partener_id = 98001; DELETE FROM comenzi_linii WHERE comanda_id = 980001; DELETE FROM comenzi WHERE id = 980001; DELETE FROM interactiuni WHERE partener_id = 98001; DELETE FROM parteneri WHERE id = 98001; DELETE FROM produse WHERE id = 98021");
  exec("INSERT INTO parteneri (id, nume, cui, tip) VALUES (98001, 'SS-TEST Client SRL', 'RO98001', 'client')");
  exec("INSERT INTO produse (id, cod, denumire, unitate_masura, cota_tva) VALUES (98021, 'SS-1', 'Produs SS', 'buc', 21)");
  exec("INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda) VALUES (980001, 98001, 'SS-CMD-1', '2026-11-18', 'noua', 98011, 98011, 'RON')");
  exec("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (980001, 98021, 2, 10, 'buc')");
  await ingest([{ tip: "Proforma", serie: "CSHP", urmator: "141" }]);
  r = await cer("/comenzi/:id/proforma", { metoda: "post", params: { id: "980001" } });
  const pf = q("SELECT serie, numar FROM proforme WHERE comanda_id = 980001")[0] || {};
  egal("proforma emisă după citire ia numărul de după SmartBill, iar contorul merge mai departe", [pf.serie, nr(pf.numar), setare("proforma_urmator")], ["CSHP", 141, "142"]);
  r = await cer("/proforme");
  bine("… iar pagina spune că acum ERP-ul e înaintea SmartBill-ului cu un număr", /data-smartbill-serie="in-urma"/.test(r.corp) && text(r.corp).includes("(CSHP 141)") && text(r.corp).includes("pe 142"));

  exec("DELETE FROM proforme WHERE partener_id = 98001; DELETE FROM comenzi_linii WHERE comanda_id = 980001; DELETE FROM comenzi WHERE id = 980001; DELETE FROM interactiuni WHERE partener_id = 98001; DELETE FROM parteneri WHERE id = 98001; DELETE FROM produse WHERE id = 98021; DELETE FROM utilizatori WHERE id BETWEEN 98011 AND 98019");
  laLoc();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { laLoc(); } catch (x) {} process.exit(1); });
