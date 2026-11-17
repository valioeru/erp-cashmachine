"use strict";
// Starea de încasare din SmartBill ajunge pe facturile din ERP. PostgreSQL real.
//
// CE A RAPORTAT VALI, 17.11.2026, cu poza restanțelor din ERP: „Primele 2
// facturi sunt încasate în SmartBill." Erau CSHMUPA0043 (6.098,40 lei) și
// CSHMUPA0042 (2.286,90 lei), Aquila, la 52 de zile de întârziere.
//
// CE SE ÎNTÂMPLASE. Pe 31.08 cele două fuseseră stornate cu CSHM3168 și
// CSHM3169 și refăcute ca CSHMUPA0048 și 0049. În SmartBill toate sunt stinse
// (`is_paid: "y"` în raportul de facturi). ERP-ul afla că o factură s-a închis
// doar din raportul de încasări, iar o stornare nu e o încasare: facturile
// inițiale au rămas la restanțe, iar stornările, cu minus, la „emise".
//
// CE APĂRĂ:
//   • SINCRONIZAREA trimite starea de încasare a fiecărei facturi și recitește
//     facturile mai vechi: pleacă cele din fereastra cerută și, dintre cele
//     vechi, doar cele a căror stare s-a schimbat de la ultima trimitere.
//   • ERP-UL trece pe „plătită" factura pe care SmartBill o ține stinsă, fără
//     să-i nască o plată; pe „plătită parțial" una încasată parțial; pe
//     „anulată" una anulată în SmartBill după import.
//   • STATUSUL URCĂ, NU COBOARĂ: dacă SmartBill o ține neîncasată și ERP-ul
//     plătită, se spune în rezultatul lotului și nu se schimbă nimic.
//   • STORNAREA: factura inițială și stornarea ei ies amândouă din sold.
//   • FACTURA NOUĂ intră direct cu starea ei din SmartBill.
//   • FACTURA FĂCUTĂ ÎN ERP își ia și ea starea de încasare; anularea ei
//     rămâne doar semnalată.
//   • PAGINA facturii spune „stinsă în SmartBill", nu „restant".
//   • FIECARE SCHIMBARE făcută singură rămâne scrisă, cu ce era înainte, și
//     se vede în lista „Stări aduse din SmartBill".
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
let urmatorul = { series: "TFED", number: "0905" };
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

// ---- datele de test ------------------------------------------------------
const PART = 97801, PROD = 97811;
const [A1, A2, A3, A4, A5, A6, A7, A8] = [97821, 97822, 97823, 97824, 97825, 97826, 97827, 97828];
function curata() {
  const toate = q(`SELECT id FROM facturi WHERE partener_id = ${PART} OR UPPER(serie) IN ('TSI', 'TSIS', 'TSIE')`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM interactiuni WHERE partener_id = ${PART}`);
  q(`DELETE FROM plati WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi_stare_istoric WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi WHERE id IN (${toate})`);
  q(`DELETE FROM produse WHERE id = ${PROD}`);
  q(`DELETE FROM parteneri WHERE id = ${PART} OR nume LIKE 'TSI Client%'`);
}
// O factură adusă din SmartBill, cu o linie „conform document".
function importata(id, serie, numar, net, { status, data, inchis } = {}) {
  q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, data_scadenta, activ, sursa_import, document_extern, inchis_istoric)
     VALUES (${id}, '${serie}', ${numar}, ${PART}, 'vanzare', '${status || "emisa"}', '${data || "2099-08-27"}', '2099-09-26', 1, 'punte SmartBill', '${serie}${String(numar).padStart(4, "0")}', ${inchis ? "'2099-09-19'" : "NULL"})`);
  q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id}, 'Conform document ${serie}${numar}', 1, ${net}, 21)`);
}
const rand = (document, total, plus) => Object.assign({ document, client: "TSI Client SRL", data: "2099-08-27", scadenta: "2099-09-26", net: String(Math.round((total / 1.21) * 100) / 100), tva: String(Math.round((total - total / 1.21) * 100) / 100), total: String(total), moneda: "RON", status: "emisa", incasata: "n" }, plus || {});
const starea = (...ids) => ids.map((id) => unul(`SELECT status FROM facturi WHERE id = ${id}`));
const istoric = (...ids) => q(`SELECT factura_id, din, in_ce, motiv FROM facturi_stare_istoric WHERE factura_id IN (${ids.join(",")}) ORDER BY id`).map((x) => [Number(x.factura_id), x.din, x.in_ce, x.motiv]);
const platiPe = (id) => q(`SELECT id, suma FROM plati WHERE factura_id = ${id} ORDER BY id`).map((x) => Number(x.suma));
const SOLD = require(path.join(RAD, "lib", "solduri.js"));
// Facturile clientului care mai au sold, după regula folosită peste tot (lib/solduri.js).
const deschise = () => q(`SELECT f.id FROM facturi f WHERE f.partener_id = ${PART} AND f.activ = 1 AND ${SOLD.deschisa("f")} ORDER BY f.id`).map((x) => Number(x.id));

(async () => {
  curata();
  const ADMIN = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali Test", rol: "admin", sectiuni: "" };
  q(`INSERT INTO parteneri (id, tip, nume, tara, judet, localitate) VALUES (${PART}, 'client', 'TSI Client SRL', 'Romania', 'Ilfov', 'Voluntari')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${PROD}, 'TSI-P', 'TSI Folie', 'buc', 1)`);

  console.log("1. Scriptul din pagina SmartBill: starea de încasare și ce pleacă spre ERP");
  const cod = fs.readFileSync(path.join(RAD, "punte", "sincronizare.js"), "utf8");
  const depozit = {};
  const fereastra = { location: { href: "https://cloud.smartbill.ro/raport/facturi/" }, localStorage: { getItem: (k) => (k in depozit ? depozit[k] : null), setItem: (k, v) => { depozit[k] = String(v); } } };
  new Function("window", "document", "console", "fetch", cod)(fereastra, { querySelector: () => null, body: { innerText: "" } }, { log() {} }, () => {});
  const S = fereastra.__sync;
  const celula = (p, extra) => JSON.stringify(Object.assign({ id: 306989965, is_draft: false, is_annulled: false, is_paid: p, is_due_date: true }, extra || {}));
  egal("starea se citește din JSON-ul coloanei Status; ce nu se înțelege rămâne gol", [S.stareIncasare(celula("y")), S.stareIncasare(celula("p")), S.stareIncasare(celula("n")), S.stareIncasare(celula("Y")), S.stareIncasare("nu e json"), S.stareIncasare(celula("x")), S.stareIncasare(null), S.stareIncasare({ is_paid: "y" })], ["y", "p", "n", "y", "", "", "", "y"]);
  const brut = (doc, zi, total, p, anulata, ciorna) => ["", "", doc, "TSI Client SRL", zi, "26/09/2099", "100.00", "21.00", String(total), "RON", "", celula(p), "", anulata ? "True" : "False", ciorna ? "True" : "False"];
  egal("rândul trimis poartă starea de încasare", S.randFactura(brut("TSI0043", "27/08/2099", 6098.4, "y"), "CASH MACHINE S.R.L."), { document: "TSI0043", client: "TSI Client SRL", data: "2099-08-27", scadenta: "2099-09-26", net: "100.00", tva: "21.00", total: "6098.4", moneda: "RON", status: "emisa", incasata: "y", firma: "CASH MACHINE S.R.L." });
  egal("starea într-o literă: anulata și ciorna înaintea încasării", [S.semnFactura({ status: "emisa", incasata: "y" }), S.semnFactura({ status: "emisa", incasata: "" }), S.semnFactura({ status: "anulata", incasata: "y" }), S.semnFactura({ status: "ciorna", incasata: "n" })], ["y", "-", "a", "c"]);
  const toate = [
    S.randFactura(brut("TSI0100", "15/11/2099", 121, "n"), "F"),
    S.randFactura(brut("TSI0099", "14/11/2099", 121, "y"), "F"),
    S.randFactura(brut("TSI0043", "27/08/2099", 6098.4, "y"), "F"),
    S.randFactura(brut("TSI0042", "27/08/2099", 2286.9, "n"), "F"),
    S.randFactura(brut("TSI0041", "26/08/2099", 50, "n", true), "F"),
  ];
  let a = S.alegeFacturi(toate, "2099-11-14", {}, false);
  egal("prima rulare (nu se știe nimic): pleacă toate, cele din fereastră întâi", [a.randuri.map((x) => x.document), a.noi, a.vechi], [["TSI0100", "TSI0099", "TSI0043", "TSI0042", "TSI0041"], 2, 3]);
  egal("…și se ține minte starea fiecăreia", a.stare, { TSI0100: "n", TSI0099: "y", TSI0043: "y", TSI0042: "n", TSI0041: "a" });
  let b = S.alegeFacturi(toate, "2099-11-14", a.stare, false);
  egal("a doua rulare, nimic schimbat: doar fereastra cerută", [b.randuri.map((x) => x.document), b.vechi], [["TSI0100", "TSI0099"], 0]);
  const schimbate = toate.map((x) => (x.document === "TSI0042" ? Object.assign({}, x, { incasata: "y" }) : x));
  b = S.alegeFacturi(schimbate, "2099-11-14", a.stare, false);
  egal("o factură veche stinsă între timp: pleacă și ea, singura dintre cele vechi", [b.randuri.map((x) => x.document), b.vechi, b.stare.TSI0042], [["TSI0100", "TSI0099", "TSI0042"], 1, "y"]);
  b = S.alegeFacturi(toate, "2099-11-14", a.stare, true);
  egal("rularea de seară (complet): toate, orice s-ar ști", b.randuri.map((x) => x.document), ["TSI0100", "TSI0099", "TSI0043", "TSI0042", "TSI0041"]);
  bine("rularea de seară cere trimiterea completă, iar raportul se citește mult în urmă", /S\.facturi\(z, \{ complet: true \}\)/.test(cod) && /const STARE_ZILE = (\d+);/.test(cod) && Number(/const STARE_ZILE = (\d+);/.exec(cod)[1]) >= 200, (/const STARE_ZILE = [^;]*/.exec(cod) || [""])[0]);

  console.log("\n2. Cazul lui Vali: factura stornată și stornarea ei");
  importata(A1, "TSI", 43, 5040);       // 6.098,40 — factura inițială, la restanțe
  importata(A2, "TSIS", 3168, -5040, { data: "2099-08-31" }); // stornarea ei
  importata(A3, "TSI", 48, 5040, { data: "2099-08-31" });     // refăcută și încasată cu bani
  q(`INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (${A3}, 6098.4, '2099-09-10', 'transfer bancar', 'încasare SmartBill')`);
  q(`UPDATE facturi SET status = 'platita' WHERE id = ${A3}`);
  egal("înainte: factura inițială și stornarea ei au amândouă sold", deschise(), [A1, A2]);
  let r = await PUNTE.HANDLERE.facturi([rand("TSI0043", 6098.4, { incasata: "y" }), rand("TSIS3168", -6098.4, { incasata: "y", data: "2099-08-31" }), rand("TSI0048", 6098.4, { incasata: "y", data: "2099-08-31" })]);
  egal("SmartBill le ține stinse: amândouă trec pe „plătită”, iar cea încasată cu bani rămâne cum era", starea(A1, A2, A3), ["platita", "platita", "platita"]);
  egal("…și ies din sold", deschise(), []);
  egal("…fără nicio plată născută: banii unei stornări nu există", [platiPe(A1), platiPe(A2), platiPe(A3)], [[], [], [6098.4]]);
  egal("rezultatul lotului spune care s-au stins, cu suma; nimic scris a doua oară", [r.facturi, r.sarite, r.stinse_dupa_smartbill, r.stinse_dupa_smartbill_care], [0, 3, 2, ["TSI0043 · 6.098,40 lei", "TSIS3168 · -6.098,40 lei"]]);
  egal("fiecare schimbare rămâne scrisă, cu ce era înainte; factura neatinsă n-are rând", istoric(A1, A2, A3), [[A1, "emisa", "platita", "stinsă în SmartBill"], [A2, "emisa", "platita", "stinsă în SmartBill"]]);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0043", 6098.4, { incasata: "y" }), rand("TSIS3168", -6098.4, { incasata: "y" })]);
  egal("a doua oară același lot: nimic de schimbat, nimic scris în plus", [r.stinse_dupa_smartbill, r.stinse_dupa_smartbill_care, starea(A1, A2), istoric(A1, A2).length], [0, [], ["platita", "platita"], 2]);
  r = await cer("get", `/facturi/${A1}`, ADMIN);
  bine("pagina facturii spune că e stinsă în SmartBill, nu „Restant”", r.cod === 200 && /data-stinsa>Stinsă în SmartBill fără încasare adusă în ERP/.test(r.corp) && !/Restant: /.test(r.corp), (r.corp.match(/Încasat:[\s\S]{0,160}/) || ["lipsește"])[0]);
  bine("…și de când a venit starea", /Starea a venit din SmartBill pe \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\./.test(r.corp) || /Starea a venit din SmartBill pe \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./.test(r.corp), (r.corp.match(/Starea a venit[\s\S]{0,60}/) || ["lipsește"])[0]);
  r = await cer("get", `/facturi/${A3}`, ADMIN);
  bine("…iar cea încasată cu bani arată ca până acum", /Restant: 0,00 lei/.test(r.corp) && !r.corp.includes("data-stinsa"), (r.corp.match(/Încasat:[\s\S]{0,120}/) || ["lipsește"])[0]);

  console.log("\n3. Statusul urcă, nu coboară");
  importata(A4, "TSI", 60, 1000);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0060", 1210, { incasata: "p" })]);
  egal("încasată parțial în SmartBill: „plătită parțial” în ERP", [starea(A4), r.partiale_dupa_smartbill, r.stinse_dupa_smartbill], [["platita_partial"], ["TSI0060 · 1.210,00 lei"], 0]);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0060", 1210, { incasata: "n" })]);
  egal("SmartBill o ține iar neîncasată: ERP-ul nu coboară nimic, dar o spune", [starea(A4), r.alta_stare_de_incasare, r.alta_stare_de_incasare_care], [["platita_partial"], 1, ["TSI0060 · 1.210,00 lei: neîncasată în SmartBill, plătită parțial în ERP"]]);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0060", 1210, { incasata: "y" })]);
  egal("apoi stinsă: urcă pe „plătită”", [starea(A4), r.stinse_dupa_smartbill], [["platita"], 1]);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0060", 1210, { incasata: "p" }), rand("TSI0048", 6098.4, { incasata: "n", data: "2099-08-31" })]);
  egal("„plătită” în ERP, mai puțin în SmartBill: neatinsă, semnalată", [starea(A4, A3), r.alta_stare_de_incasare, r.alta_stare_de_incasare_care], [["platita", "platita"], 2, ["TSI0060 · 1.210,00 lei: încasată parțial în SmartBill, plătită în ERP", "TSI0048 · 6.098,40 lei: neîncasată în SmartBill, plătită în ERP"]]);
  importata(A5, "TSI", 61, 100);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0061", 121, { incasata: "" }), rand("TSI0061", 121, { incasata: "da" }), rand("TSI0061", 121, {})]);
  egal("rândul fără stare (punte veche) sau cu una neînțeleasă nu schimbă nimic; „n” pe o factură emisă nu e o veste", [starea(A5), r.stinse_dupa_smartbill, r.alta_stare_de_incasare, r.partiale_dupa_smartbill], [["emisa"], 0, 0, []]);

  console.log("\n4. Anulată în SmartBill după ce a intrat în ERP; factura închisă ca istoric");
  r = await PUNTE.HANDLERE.facturi([rand("TSI0061", 121, { status: "anulata", incasata: "n" })]);
  egal("anulată în SmartBill: anulată și în ERP, și se spune", [starea(A5), r.anulate_dupa_smartbill], [["anulata"], ["TSI0061 · 121,00 lei"]]);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0061", 121, { incasata: "y" })]);
  egal("o factură anulată în ERP nu se mai „încasează”", [starea(A5), r.stinse_dupa_smartbill], [["anulata"], 0]);
  importata(A6, "TSI", 20, 300, { inchis: true, data: "2098-03-01" });
  r = await PUNTE.HANDLERE.facturi([rand("TSI0020", 363, { incasata: "y", data: "2098-03-01" })]);
  egal("factura închisă ca istoric vechi, stinsă în SmartBill: trece și ea pe „plătită”", [starea(A6), r.stinse_dupa_smartbill], [["platita"], 1]);

  egal("istoricul stărilor: parțial, apoi plătită; anularea; istoricul vechi", [istoric(A4), istoric(A5), istoric(A6)], [[[A4, "emisa", "platita_partial", "încasată parțial în SmartBill"], [A4, "platita_partial", "platita", "stinsă în SmartBill"]], [[A5, "emisa", "anulata", "anulată în SmartBill"]], [[A6, "emisa", "platita", "stinsă în SmartBill"]]]);
  r = await cer("get", "/facturi/stari-din-smartbill", ADMIN);
  const randIst = (doc) => (new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${doc}</a>[\\s\\S]*?</tr>`).exec(r.corp) || [""])[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("lista „Stări aduse din SmartBill”: factura, clientul, ce era și ce a devenit", r.cod === 200 && /TSI Client SRL .* 6\.098,40 lei 0,00 lei emisă plătită stinsă în SmartBill/.test(randIst("TSI0043")), randIst("TSI0043").slice(0, 260));
  bine("…cu anularea și cu numărătoarea celor stinse fără încasare în ERP", /emisă anulată anulată în SmartBill/.test(randIst("TSI0061")) && r.corp.includes("…dintre care fără încasare în ERP"), randIst("TSI0061").slice(0, 200));

  console.log("\n5. Factura nouă intră cu starea ei din SmartBill");
  r = await PUNTE.HANDLERE.facturi([rand("TSI0070", 242, { incasata: "y" }), rand("TSI0071", 242, { incasata: "p" }), rand("TSI0072", 242, { incasata: "n" }), rand("TSI0073", 242, {}), rand("TSI0074", 242, { incasata: "y", status: "anulata" })]);
  const noi = q(`SELECT numar, status FROM facturi WHERE UPPER(serie) = 'TSI' AND numar BETWEEN 70 AND 74 ORDER BY numar`).map((x) => [Number(x.numar), x.status]);
  egal("stinsă, parțială, neîncasată, fără stare, anulată", [r.facturi, noi, r.stinse_dupa_smartbill], [5, [[70, "platita"], [71, "platita_partial"], [72, "emisa"], [73, "emisa"], [74, "anulata"]], 0]);
  egal("…fără plăți născute pentru cea stinsă, și fără rând în istoric: n-a schimbat nimic, așa a intrat", [platiPe(Number(unul(`SELECT id FROM facturi WHERE UPPER(serie) = 'TSI' AND numar = 70`))), istoric(Number(unul(`SELECT id FROM facturi WHERE UPPER(serie) = 'TSI' AND numar = 70`)))], [[], []]);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0080", 121, { incasata: "n" }), rand("TSI0080", 121, { incasata: "y" })]);
  egal("aceeași factură de două ori în lot (nouă, apoi stinsă): o singură factură, plătită", [r.facturi, q(`SELECT id, status FROM facturi WHERE UPPER(serie) = 'TSI' AND numar = 80`).map((x) => x.status), r.stinse_dupa_smartbill], [1, ["platita"], 1]);

  console.log("\n6. Factura făcută în ERP și trimisă în SmartBill");
  q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, activ, smartbill_serie, smartbill_numar, smartbill_sync_la, document_extern)
     VALUES (${A7}, 'TSIE', 7, ${PART}, 'vanzare', 'emisa', '2099-11-17', 1, 'TSI', '90', '2099-11-17 09:00:00', 'TSI90')`);
  q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${A7}, ${PROD}, 'TSI Folie', 10, 10, 21)`);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0090", 121, { incasata: "y", data: "2099-11-17" })]);
  egal("stinsă în SmartBill: factura din ERP trece pe „plătită”, sub numele ei din ERP și cel fiscal", [starea(A7), r.emise_din_erp, r.stinse_dupa_smartbill_care, r.facturi], [["platita"], 1, ["TSIE-7 = TSI0090 · 121,00 lei"], 0]);
  q(`UPDATE facturi SET status = 'emisa' WHERE id = ${A7}`);
  r = await PUNTE.HANDLERE.facturi([rand("TSI0090", 121, { status: "anulata", incasata: "n", data: "2099-11-17" })]);
  egal("anulată în SmartBill: factura făcută în ERP nu se anulează singură, doar se semnalează", [starea(A7), r.anulate_dupa_smartbill, r.emise_din_erp_cu_alta_stare], [["emisa"], [], ["TSIE-7 = TSI0090: valabilă în ERP, anulată în SmartBill"]]);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
