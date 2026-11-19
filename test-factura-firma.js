"use strict";
// Factura de vânzare: firma care o emite. PostgreSQL real (baza de pe 5433).
//
// CE A CERUT VALI, 19.11.2026: „Fă și la facturi la fel, să alegi pe ce le
// emiți, începând cu ultimul număr din SmartBill." · „Le băgăm noi și în
// SmartBill, nu le trimite direct decât dacă poți." · „Ai grijă la ambele să
// nu le duplici când aduci facturi."
//
// CE APĂRĂ:
//   • ALEGEREA: pe ciornă, cine facturează alege Cash Machine sau Warehouse
//     All. După emitere sau după plecarea în SmartBill, firma nu se mai schimbă.
//   • WAREHOUSE ALL: la validare ia numărul următor din seria ei — după
//     ultimul adus din SmartBill — și NU pleacă în SmartBill, pe niciun drum
//     (validare, butonul de trimitere, formularul cu adresa clientului).
//   • CASH MACHINE: ca până acum — pleacă în SmartBill la validare.
//   • FĂRĂ DUBLURI, la amândouă: factura Warehouse All introdusă de mână în
//     SmartBill și adusă înapoi nu se scrie a doua oară; nici cea Cash Machine
//     întoarsă cu numărul ei fiscal.
//   • FOAIA facturii Warehouse All poartă datele ei, nu ale Cash Machine.
//   • CONTORUL: administratorul îl poate urca; nu coboară sub un număr folosit.
const path = require("path");
const fs = require("fs");
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



// SmartBill, înlocuit: întoarce ce număr „a dat" facturii și ține minte ce a primit.
const trimise = [];
let urmatorul = { series: "TFWC", number: "0700" };
const origSb = Module._load;
Module._load = function (req) {
  if (/(^|\/)smartbill$/.test(req)) {
    return {
      isConfigured: () => true,
      trimiteFactura: async (factura, linii, adresa) => { trimise.push({ id: Number(factura.id), linii: linii.length, adresa: adresa || null }); return Object.assign({ raw: {} }, urmatorul); },
      construiesteFactura: () => ({}),
      interogheazaStoc: async () => ({}),
    };
  }
  return origSb.apply(this, arguments);
};

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "facturi.js")).register(router);
const PUNTE = require(path.join(RAD, "modules", "punte.js"));

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
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const FF = require(path.join(RAD, "lib", "factura-firma.js"));
const PART = 97801, PROD = 97811;
const [W1, W2, W3, C1, C2] = [97821, 97822, 97823, 97831, 97832];
const SERII = "('TFW', 'TFWC', 'TFWX')";
let firmaWaPusa = false;
const setariVechi = q("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('factura_serie_wa', 'factura_urmator_wa')");
function curata() {
  const toate = q(`SELECT id FROM facturi WHERE partener_id = ${PART} OR UPPER(COALESCE(serie, '')) IN ${SERII}`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM interactiuni WHERE partener_id = ${PART}`);
  q(`DELETE FROM miscari_stoc WHERE produs_id = ${PROD}`);
  q(`DELETE FROM plati WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi WHERE id IN (${toate})`);
  q(`DELETE FROM produse WHERE id = ${PROD}`);
  q(`DELETE FROM parteneri WHERE id = ${PART} OR nume LIKE 'TFW Client%'`);
}
function refaSetari() {
  q("DELETE FROM setari_app WHERE cheie IN ('factura_serie_wa', 'factura_urmator_wa')");
  for (const x of setariVechi) q(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (${lit(x.cheie)}, ${lit(x.valoare)}, '2026-11-19')`);
  if (firmaWaPusa) q("DELETE FROM firme WHERE cui = '44140650' AND nume = 'Warehouse All SRL (test)'");
}
function ciorna(id) {
  q(`INSERT INTO facturi (id, partener_id, directie, status, data_emiterii, activ) VALUES (${id}, ${PART}, 'vanzare', 'ciorna', '2099-11-19', 1)`);
  q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id}, ${PROD}, 'TFW Folie', 10, 10, 21)`);
}
const f = (id) => q(`SELECT serie, numar, status, firma_id, document_extern, smartbill_serie, smartbill_numar, smartbill_sync_la FROM facturi WHERE id = ${id}`)[0];
const rand = (document, plus) => Object.assign({ document, client: "TFW Client SRL", data: "2099-11-19", scadenta: "2099-11-26", net: "100.00", tva: "21.00", total: "121.00", moneda: "RON", status: "emisa" }, plus || {});
const cuSeria = (s) => q(`SELECT id, numar FROM facturi WHERE activ = 1 AND UPPER(COALESCE(serie, '')) = '${s}' ORDER BY numar`).map((x) => Number(x.numar));

(async () => {
  curata();
  const ADMIN = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali Test", rol: "admin", sectiuni: "" };
  const AGENT = { id: 97899, nume: "Agent Test", rol: "vanzari", sectiuni: "/crm" };
  q(`INSERT INTO parteneri (id, tip, nume, tara, judet, localitate) VALUES (${PART}, 'client', 'TFW Client SRL', 'Romania', 'Ilfov', 'Voluntari')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${PROD}, 'TFW-P', 'TFW Folie', 'buc', 1)`);
  // Cele două firme, cum le pune pornirea (lib/grup.js); pe o bază de test goală lipsesc.
  if (!unul("SELECT id FROM firme WHERE REGEXP_REPLACE(COALESCE(cui, ''), '[^0-9]', '', 'g') = '27244210'")) q("INSERT INTO firme (nume, cui, in_grup, implicita) VALUES ('Cash Machine SRL (test)', '27244210', 1, 1)");
  if (!unul("SELECT id FROM firme WHERE REGEXP_REPLACE(COALESCE(cui, ''), '[^0-9]', '', 'g') = '44140650'")) { q("INSERT INTO firme (nume, cui, in_grup, implicita) VALUES ('Warehouse All SRL (test)', '44140650', 1, 0)"); firmaWaPusa = true; }
  const ID_WA = await FF.idFirma("wa"), ID_CM = await FF.idFirma("cm");
  q("DELETE FROM setari_app WHERE cheie IN ('factura_serie_wa', 'factura_urmator_wa')");
  q("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('factura_serie_wa', 'TFW', '2026-11-19')");

  console.log("1. Firma se alege pe ciornă");
  egal("cele două firme se găsesc după CUI, diferite", [ID_WA > 0, ID_CM > 0, ID_WA !== ID_CM], [true, true, true]);
  ciorna(W1);
  egal("o ciornă fără firmă e Cash Machine", await FF.cheie(f(W1)), "cm");
  let r = await cer("get", `/facturi/${W1}`, ADMIN);
  bine("pagina ciornei are alegerea firmei, cu Cash Machine pusă dinainte", r.corp.includes(`action="/facturi/${W1}/firma"`) && r.corp.includes('name="firma" value="cm" checked') && r.corp.includes('name="firma" value="wa"'));
  r = await cer("post", `/facturi/${W1}/firma`, AGENT, { body: { firma: "wa" } });
  egal("cine nu facturează nu o poate schimba", [f(W1).firma_id, /drepturi pe facturare/.test(decodeURIComponent(unde(r)))], [null, true]);
  r = await cer("post", `/facturi/${W1}/firma`, ADMIN, { body: { firma: "wa" } });
  egal("cine facturează o pune pe Warehouse All", [Number(f(W1).firma_id), await FF.cheie(f(W1))], [ID_WA, "wa"]);

  console.log("\n2. Warehouse All: numărul continuă după ultimul din SmartBill");
  // Două facturi Warehouse All aduse din SmartBill: ultimul număr e 41.
  q(`INSERT INTO facturi (serie, numar, partener_id, directie, status, data_emiterii, activ, sursa_import, document_extern, firma_id) VALUES
     ('TFW', 40, ${PART}, 'vanzare', 'emisa', '2099-11-01', 1, 'punte SmartBill', 'TFW40', ${ID_WA}), ('TFW', 41, ${PART}, 'vanzare', 'emisa', '2099-11-02', 1, 'punte SmartBill', 'TFW41', ${ID_WA})`);
  let c = await FF.contorWa();
  egal("următorul e ultimul din SmartBill + 1", [c.serie, c.ultim, c.urmator], ["TFW", 41, 42]);
  r = await cer("get", `/facturi/${W1}`, ADMIN);
  bine("pagina spune ce număr va primi și că nu pleacă în SmartBill", r.corp.includes("TFW 42") && r.corp.includes("TFW 41") && r.corp.includes("Nu pleacă din ERP în SmartBill") && r.corp.includes("data-smartbill-wa"));
  trimise.length = 0;
  r = await cer("post", `/facturi/${W1}/valideaza`, ADMIN);
  egal("validată: seria și numărul ei, emisă, cu documentul scris ca în SmartBill", [f(W1).serie, Number(f(W1).numar), f(W1).status, f(W1).document_extern], ["TFW", 42, "emisa", "TFW42"]);
  egal("…și NU a plecat în SmartBill", [trimise.length, f(W1).smartbill_sync_la, f(W1).smartbill_numar, /Nu pleacă în SmartBill din ERP/.test(decodeURIComponent(unde(r)))], [0, null, null, true]);
  r = await cer("post", `/facturi/${W1}/smartbill`, ADMIN);
  egal("butonul de trimitere e oprit și el", [trimise.length, /nu se trimite din ERP în SmartBill/.test(decodeURIComponent(unde(r)))], [0, true]);
  r = await cer("post", `/facturi/${W1}/smartbill/client`, ADMIN, { body: { tara: "Romania", judet: "Ilfov", localitate: "Voluntari" } });
  egal("…la fel formularul cu adresa clientului", [trimise.length, f(W1).smartbill_sync_la], [0, null]);
  r = await cer("post", `/facturi/${W1}/firma`, ADMIN, { body: { firma: "cm" } });
  egal("după emitere firma nu se mai schimbă", [Number(f(W1).firma_id), /deja emisă/.test(decodeURIComponent(unde(r)))], [ID_WA, true]);
  ciorna(W2);
  q(`UPDATE facturi SET firma_id = ${ID_WA} WHERE id = ${W2}`);
  await cer("post", `/facturi/${W2}/valideaza`, ADMIN);
  egal("a doua factură ia numărul următor", [f(W2).serie, Number(f(W2).numar)], ["TFW", 43]);

  console.log("\n3. Adusă înapoi din SmartBill, nu se dublează");
  r = await PUNTE.HANDLERE.facturi([rand("TFW42"), rand("TFW 0043")]);
  egal("factura Warehouse All introdusă de mână în SmartBill și adusă înapoi: nescrisă a doua oară", [r.facturi, r.sarite, cuSeria("TFW")], [0, 2, [40, 41, 42, 43]]);
  r = await PUNTE.HANDLERE.facturi([rand("TFW44")]);
  egal("o factură făcută direct în SmartBill intră, o singură dată", [r.facturi, cuSeria("TFW")], [1, [40, 41, 42, 43, 44]]);
  c = await FF.contorWa();
  egal("…iar ERP-ul continuă după ea", c.urmator, 45);

  console.log("\n4. Cash Machine: ca până acum");
  ciorna(C1);
  trimise.length = 0;
  urmatorul = { series: "TFWC", number: "0700" };
  r = await cer("post", `/facturi/${C1}/valideaza`, ADMIN);
  egal("pleacă în SmartBill la validare și își ține numărul fiscal", [trimise.map((x) => x.id), f(C1).smartbill_serie, f(C1).smartbill_numar, f(C1).status], [[C1], "TFWC", "0700", "emisa"]);
  bine("…fără seria Warehouse All", String(f(C1).serie || "").toUpperCase() !== "TFW");
  r = await PUNTE.HANDLERE.facturi([rand("TFWC700")]);
  egal("întoarsă din SmartBill cu numărul fiscal: nu se dublează", [r.facturi, r.emise_din_erp, cuSeria("TFWC")], [0, 1, []]);
  r = await cer("post", `/facturi/${C1}/firma`, ADMIN, { body: { firma: "wa" } });
  egal("o factură emisă nu se mută pe altă firmă", await FF.cheie(f(C1)), "cm");
  ciorna(C2);
  q(`UPDATE facturi SET smartbill_sync_la = '2099-11-19 10:00:00', smartbill_serie = 'TFWC', smartbill_numar = '701' WHERE id = ${C2}`);
  r = await cer("post", `/facturi/${C2}/firma`, ADMIN, { body: { firma: "wa" } });
  egal("ciorna plecată deja în SmartBill nu se mută pe Warehouse All", [await FF.cheie(f(C2)), /a plecat deja în SmartBill/.test(decodeURIComponent(unde(r)))], ["cm", true]);
  q(`UPDATE facturi SET firma_id = ${ID_WA} WHERE id = ${C2}`);
  r = await cer("post", `/facturi/${C2}/valideaza`, ADMIN);
  egal("…iar dacă ajunge totuși așa, validarea o refuză în loc să-i dea număr Warehouse All", [f(C2).status, String(f(C2).serie || "").toUpperCase() === "TFW", f(C2).numar, /a plecat deja în SmartBill pe Cash Machine/.test(decodeURIComponent(unde(r)))], ["ciorna", false, null, true]);

  console.log("\n5. Foaia și contorul");
  r = await cer("get", `/facturi/${W1}/tipar`, ADMIN);
  const t = String(r.corp).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("foaia facturii Warehouse All are datele ei, nu ale Cash Machine",
    t.includes("WAREHOUSE ALL SRL") && t.includes("RO44140650") && t.includes("RO34UGBI0000172035560RON") && t.includes("TFW") && !t.includes("CASH MACHINE S.R.L.") && !t.includes("RO10BRDE450SV99442324500") && !t.includes("office@cashmachine.ro"),
    (t.match(/Furnizor[\s\S]{0,300}/) || [""])[0]);
  r = await cer("get", `/facturi/${C1}/tipar`, ADMIN);
  bine("…iar cea Cash Machine rămâne cu ale ei", String(r.corp).includes("CASH MACHINE S.R.L.") && !String(r.corp).includes("WAREHOUSE ALL SRL"));
  ciorna(W3);
  q(`UPDATE facturi SET firma_id = ${ID_WA} WHERE id = ${W3}`);
  r = await cer("post", "/facturi/contor-wa", AGENT, { body: { serie: "TFW", urmator: "500", inapoi: String(W3) } });
  egal("doar administratorul schimbă contorul", [(await FF.contorWa()).urmator, /Doar administratorul/.test(decodeURIComponent(unde(r)))], [45, true]);
  r = await cer("post", "/facturi/contor-wa", ADMIN, { body: { serie: "TFW", urmator: "44", inapoi: String(W3) } });
  egal("nu coboară sub un număr folosit", [(await FF.contorWa()).urmator, /cel puțin 45/.test(decodeURIComponent(unde(r)))], [45, true]);
  r = await cer("post", "/facturi/contor-wa", ADMIN, { body: { serie: "TFW", urmator: "60", inapoi: String(W3) } });
  egal("urcat de administrator (SmartBill e mai departe)", [(await FF.contorWa()).urmator, unde(r).startsWith(`/facturi/${W3}?`)], [60, true]);
  await cer("post", `/facturi/${W3}/valideaza`, ADMIN);
  egal("următoarea factură ia numărul pus", [f(W3).serie, Number(f(W3).numar)], ["TFW", 60]);

  curata();
  refaSetari();
  console.log(esecuri ? "\n" + esecuri + " ESECURI" : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("ESEC (crash):", e.stack || e.message);
  try { curata(); refaSetari(); } catch (x) { /* best-effort */ }
  process.exit(1);
});
