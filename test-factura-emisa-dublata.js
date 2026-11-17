"use strict";
// Factura emisă din ERP nu mai intră a doua oară din SmartBill. PostgreSQL real.
//
// CE A RAPORTAT VALI, 17.11.2026, cu poza listei de facturi: „Fact de la Maia
// Foods nu trebuie dublată." În listă erau, una sub alta, FCT-4 și CSHM3409,
// amândouă Maia Food, amândouă 1.936,00 lei.
//
// CE SE ÎNTÂMPLASE. FCT-4 e factura făcută în ERP. Trimisă în SmartBill, a
// primit acolo numărul ei fiscal, CSHM3409, pe care ERP-ul îl ținea în
// smartbill_serie / smartbill_numar. Sincronizarea facturilor recunoaște o
// factură după seria și numărul ei din ERP — „FCT|4" —, deci rândul
// „CSHM3409" din raportul SmartBill a intrat ca factură nouă.
//
// CE APĂRĂ:
//   • SINCRONIZAREA: rândul care poartă numărul din SmartBill al unei facturi
//     emise din ERP nu se mai scrie — nici dacă dublura lui a fost scoasă
//     între timp din bază. Facturile obișnuite din SmartBill intră ca până acum.
//   • FACTURA DIN ERP primește ce-i lipsea: numărul fiscal ca document (după el
//     se leagă încasările) și scadența din SmartBill. Ce avea deja nu se atinge.
//   • ALTĂ SUMĂ în SmartBill decât în ERP: se spune în rezultatul lotului și
//     nu se schimbă nimic singur.
//   • TRIMITEREA scrie numărul fiscal pe factură — și din pagina ei, și de la
//     validare (acolo se citeau două câmpuri care nu există).
//   • FACTURILE DEJA TRIMISE își primesc numărul fiscal la pornire (lib/db.js).
//   • LISTA și PAGINA arată numărul fiscal, cu cel din ERP alături.
//   • ÎNCASĂRILE aduse din SmartBill merg pe factura din ERP, nu pe dublura ei.
//   • LINIILE citite din SmartBill nu le înlocuiesc pe ale facturii din ERP.
//   • ÎNDREPTAREA FCT-3 (Crama Ceptura, „da, repară"): prețul în euro luat
//     drept lei devine cel din SmartBill, o singură dată, doar pe factura aceea.
//   • MENȚIUNILE de pe factură se văd pe pagina ei.
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
// Seria „din SmartBill" a testului: TFED. Seria ERP-ului: TFE.
const PART = 97701, PROD = 97711;
const [F1, F2, F3, F4, F5, F6, F7, F8, F9] = [97721, 97722, 97723, 97724, 97725, 97726, 97727, 97728, 97729];
// Dublura are id MAI MIC decât factura ei din ERP: pe live e invers, dar așa
// se vede că regula e „cea din ERP", nu „cea mai veche".
const DUBLURA = 97705;
// Îndreptarea FCT-3: factura adevărată (ca pe live) și trei care doar seamănă.
const [C1, C2, C3, C4] = [97731, 97732, 97733, 97734];
function curata() {
  const toate = q(`SELECT id FROM facturi WHERE partener_id = ${PART} OR UPPER(serie) IN ('TFED', 'TFE') OR id IN (${[C1, C2, C3, C4].join(",")})`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM interactiuni WHERE partener_id = ${PART}`);
  q(`DELETE FROM miscari_stoc WHERE produs_id = ${PROD}`);
  q(`DELETE FROM plati WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${toate})`);
  q(`DELETE FROM facturi WHERE id IN (${toate})`);
  q(`DELETE FROM produse WHERE id = ${PROD}`);
  q(`DELETE FROM parteneri WHERE id = ${PART} OR nume LIKE 'TFE Client%'`);
}
// O factură făcută în ERP: fără sursă de import, cu o linie de 160 × 10 lei + 21%.
function facturaErp(id, numar, { sb, doc, scadenta, status, pret } = {}) {
  q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, data_scadenta, activ, smartbill_serie, smartbill_numar, smartbill_sync_la, document_extern)
     VALUES (${id}, 'TFE', ${numar}, ${PART}, 'vanzare', '${status || "emisa"}', '2099-11-17', ${scadenta ? lit(scadenta) : "NULL"}, 1,
             ${sb ? lit(sb[0]) : "NULL"}, ${sb ? lit(sb[1]) : "NULL"}, ${sb ? "'2099-11-17 09:00:00'" : "NULL"}, ${doc ? lit(doc) : "NULL"})`);
  q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id}, ${PROD}, 'TFE Folie', 160, ${pret || 10}, 21)`);
}
const rand = (document, plus) => Object.assign({ document, client: "TFE Client SRL", data: "2099-11-17", scadenta: "2099-11-24", net: "1600.00", tva: "336.00", total: "1936.00", moneda: "RON", status: "emisa" }, plus || {});
const erp = (id) => q(`SELECT document_extern, data_scadenta, smartbill_serie, smartbill_numar, activ FROM facturi WHERE id = ${id}`).map((x) => [x.document_extern, x.data_scadenta, x.smartbill_serie, x.smartbill_numar, Number(x.activ)])[0];
const totalFacturii = (id) => Number(unul(`SELECT ROUND(CAST(SUM(cantitate * pret_unitar * (1 + cota_tva / 100.0)) AS NUMERIC), 2) FROM facturi_linii WHERE factura_id = ${id}`));
const platiPe = (id) => q(`SELECT suma FROM plati WHERE factura_id = ${id} ORDER BY id`).map((x) => Number(x.suma));
const liniiPe = (id) => q(`SELECT denumire, cantitate, pret_unitar FROM facturi_linii WHERE factura_id = ${id} ORDER BY id`).map((x) => [x.denumire, Number(x.cantitate), Number(x.pret_unitar)]);
const aduse = (numere) => q(`SELECT numar, activ FROM facturi WHERE UPPER(serie) = 'TFED' ORDER BY id`).map((x) => [Number(x.numar), Number(x.activ)]).filter((x) => !numere || numere.includes(x[0]));

(async () => {
  curata();
  const ADMIN = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali Test", rol: "admin", sectiuni: "" };
  q(`INSERT INTO parteneri (id, tip, nume, tara, judet, localitate) VALUES (${PART}, 'client', 'TFE Client SRL', 'Romania', 'Ilfov', 'Voluntari')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${PROD}, 'TFE-P', 'TFE Folie', 'buc', 1)`);

  console.log("1. Sincronizarea: factura emisă din ERP nu intră a doua oară");
  facturaErp(F1, 91, { sb: ["TFED", "901"] });
  let r = await PUNTE.HANDLERE.facturi([rand("TFED901")]);
  egal("rândul cu numărul din SmartBill al unei facturi din ERP: nescris, numărat ca venit din ERP", [r.facturi, r.sarite, r.emise_din_erp, r.emise_din_erp_cu_alta_suma, aduse()], [0, 1, 1, [], []]);
  egal("…fără nimic de semnalat: nici dublură în bază, nici altă stare", [r.emise_din_erp_cu_dublura_in_baza, r.emise_din_erp_cu_alta_stare], [[], []]);
  egal("…iar factura din ERP își primește numărul fiscal ca document și scadența din SmartBill", erp(F1), ["TFED901", "2099-11-24", "TFED", "901", 1]);
  r = await PUNTE.HANDLERE.facturi([rand("TFED901", { scadenta: "2099-12-31" })]);
  egal("a doua oară: tot nescris, iar ce are deja factura nu se mai atinge", [r.facturi, r.emise_din_erp, erp(F1)], [0, 1, ["TFED901", "2099-11-24", "TFED", "901", 1]]);

  facturaErp(F2, 92, { sb: ["tfed", "0902"], scadenta: "2099-12-01", doc: "ALTCEVA 7" });
  r = await PUNTE.HANDLERE.facturi([rand("TFED 0902"), rand("", { serie: "TFED", numar: "902" })]);
  egal("zerourile din față, literele mici și forma rândului (lipit sau pe câmpuri) nu contează", [r.facturi, r.sarite, r.emise_din_erp, aduse()], [0, 2, 1, []]);
  egal("…documentul și scadența scrise deja pe factură rămân ale ei", erp(F2), ["ALTCEVA 7", "2099-12-01", "tfed", "0902", 1]);

  console.log("\n2. Altă sumă în SmartBill decât în ERP");
  facturaErp(F3, 93, { sb: ["TFED", "903"], pret: 35.2 });
  r = await PUNTE.HANDLERE.facturi([rand("TFED903", { net: "8488.80", tva: "1782.65", total: "10271.45" })]);
  egal("nu intră a doua oară, dar se spune că sumele diferă — cu amândouă", [r.facturi, r.emise_din_erp, r.emise_din_erp_cu_alta_suma, aduse()], [0, 1, ["TFE-93 = TFED903: 6.814,72 lei în ERP, 10.271,45 lei în SmartBill"], []]);
  egal("…și nicio sumă nu se schimbă singură în ERP", totalFacturii(F3), 6814.72);
  r = await PUNTE.HANDLERE.facturi([rand("TFED901", { total: "1936.03" })]);
  egal("o diferență de câțiva bani (rotunjiri) nu e o diferență", r.emise_din_erp_cu_alta_suma, []);
  r = await PUNTE.HANDLERE.facturi([rand("TFED901", { net: "", tva: "", total: "" })]);
  egal("un rând fără sume nu e raportat ca diferență", r.emise_din_erp_cu_alta_suma, []);

  console.log("\n3. Facturile obișnuite din SmartBill intră ca până acum");
  r = await PUNTE.HANDLERE.facturi([rand("TFED950"), rand("TFED951", { client: "TFE Client Nou SRL" })]);
  egal("două facturi făcute direct în SmartBill: scrise", [r.facturi, r.sarite, r.emise_din_erp, aduse()], [2, 0, 0, [[950, 1], [951, 1]]]);
  r = await PUNTE.HANDLERE.facturi([rand("TFED950"), rand("TFED901")]);
  egal("reimportul: una era deja, cealaltă e a ERP-ului — niciuna scrisă", [r.facturi, r.sarite, r.emise_din_erp, aduse().length], [0, 2, 1, 2]);
  facturaErp(F4, 94, {});
  r = await PUNTE.HANDLERE.facturi([rand("TFED904")]);
  egal("o factură din ERP netrimisă în SmartBill nu oprește nimic", [r.facturi, r.emise_din_erp, aduse([904])], [1, 0, [[904, 1]]]);

  console.log("\n4. Dublura deja intrată, și dublura scoasă din bază");
  facturaErp(F5, 95, { sb: ["TFED", "905"] });
  q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, activ, sursa_import, document_extern) VALUES (${DUBLURA}, 'TFED', 905, ${PART}, 'vanzare', 'emisa', '2099-11-17', 1, 'punte SmartBill', 'TFED905')`);
  q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${DUBLURA}, 'Conform document TFED905', 1, 1600, 21)`);
  r = await PUNTE.HANDLERE.facturi([rand("TFED905")]);
  egal("dublura era deja în bază: nu se mai adaugă una, iar factura din ERP tot își primește numărul și scadența", [r.facturi, r.emise_din_erp, aduse([905]), erp(F5).slice(0, 2)], [0, 1, [[905, 1]], ["TFED905", "2099-11-24"]]);
  egal("…și rezultatul lotului spune că dublura e încă în bază", r.emise_din_erp_cu_dublura_in_baza, ["TFE-95 = TFED905"]);
  r = await PUNTE.HANDLERE.incasari([{ factura: "TFED905", suma: "500.00", data: "2099-11-20" }]);
  egal("încasarea venită pe numărul fiscal, cu dublura încă în bază: pe factura din ERP, nu pe dublură", [r.incasari_scrise, platiPe(F5), platiPe(DUBLURA)], [1, [500], []]);
  q(`UPDATE facturi SET activ = 0 WHERE id = ${DUBLURA}`);
  r = await PUNTE.HANDLERE.facturi([rand("TFED905")]);
  egal("dublura scoasă din bază (activ = 0) NU se întoarce la următoarea sincronizare", [r.facturi, r.sarite, aduse([905]), r.emise_din_erp_cu_dublura_in_baza], [0, 1, [[905, 0]], []]);
  r = await PUNTE.HANDLERE.incasari([{ factura: "TFED 905", suma: "1436.00", data: "2099-11-24" }, { factura: "TFED950", suma: "100.00", data: "2099-11-24" }]);
  egal("după scoaterea dublurii, restul banilor tot pe factura din ERP; o factură venită din SmartBill își primește banii ei", [r.incasari_scrise, platiPe(F5), platiPe(Number(unul(`SELECT id FROM facturi WHERE UPPER(serie) = 'TFED' AND numar = 950`)))], [2, [500, 1436], [100]]);
  r = await PUNTE.HANDLERE.incasari([{ factura: "TFED0902", suma: "250.00", data: "2099-11-25" }]);
  egal("factura din ERP cu alt document scris de om își primește totuși banii veniți pe numărul din SmartBill", [r.incasari_scrise, r.facturi_negasite, platiPe(F2)], [1, 0, [250]]);
  facturaErp(F6, 96, { sb: ["TFED", "906"], status: "anulata" });
  r = await PUNTE.HANDLERE.facturi([rand("TFED906")]);
  egal("și o factură din ERP anulată între timp își ține numărul din SmartBill: nu apare o a doua", [r.facturi, r.emise_din_erp, aduse([906])], [0, 1, []]);
  egal("…dar se spune că stările nu se potrivesc", r.emise_din_erp_cu_alta_stare, ["TFE-96 = TFED906: anulată în ERP, valabilă în SmartBill"]);
  r = await PUNTE.HANDLERE.facturi([rand("TFED906", { status: "Anulată" }), rand("TFED901", { status: "stornata" }), rand("TFED903", { status: "Încasată" })]);
  egal("anulată în amândouă: nimic de spus; valabilă în ERP și anulată în SmartBill: se spune", r.emise_din_erp_cu_alta_stare, ["TFE-91 = TFED901: valabilă în ERP, anulată în SmartBill"]);
  facturaErp(F9, 909, { sb: ["TFED", "909"] });
  q(`UPDATE facturi SET serie = 'TFED' WHERE id = ${F9}`);
  r = await PUNTE.HANDLERE.facturi([rand("TFED909")]);
  egal("o factură din ERP care poartă chiar numărul din SmartBill nu e propria ei dublură", [r.facturi, r.emise_din_erp, r.emise_din_erp_cu_dublura_in_baza], [0, 1, []]);
  q(`UPDATE facturi SET activ = 0 WHERE id = ${F6}`);
  r = await PUNTE.HANDLERE.facturi([rand("TFED906")]);
  egal("…dar una scoasă din bază nu mai ține nimic: factura din SmartBill intră", [r.facturi, r.emise_din_erp, aduse([906])], [1, 0, [[906, 1]]]);

  console.log("\n5. Trimiterea în SmartBill scrie numărul fiscal pe factură");
  facturaErp(F7, 97, {});
  urmatorul = { series: "TFED", number: "0907" };
  r = await cer("post", `/facturi/${F7}/smartbill`, ADMIN);
  egal("din pagina facturii: seria și numărul din SmartBill, și documentul", [trimise.length, unde(r).split("?")[0], erp(F7)[0], erp(F7).slice(2, 4)], [1, `/facturi/${F7}`, "TFED0907", ["TFED", "0907"]]);
  r = await PUNTE.HANDLERE.facturi([rand("TFED907")]);
  egal("…deci sincronizarea de după o recunoaște", [r.facturi, r.emise_din_erp, aduse([907])], [0, 1, []]);
  urmatorul = { series: "TFED", number: "0917" };
  r = await cer("post", `/facturi/${F7}/smartbill`, ADMIN, { body: { iar: "1" } });
  egal("retrimisă anume: numărul nou îl înlocuiește pe cel vechi, și ca document", [trimise.length, erp(F7)[0], erp(F7).slice(2, 4)], [2, "TFED0917", ["TFED", "0917"]]);
  q(`UPDATE facturi SET document_extern = 'SCRIS DE OM' WHERE id = ${F7}`);
  urmatorul = { series: "TFED", number: "0927" };
  await cer("post", `/facturi/${F7}/smartbill`, ADMIN, { body: { iar: "1" } });
  egal("…dar un document scris de om nu se calcă", [erp(F7)[0], erp(F7).slice(2, 4)], ["SCRIS DE OM", ["TFED", "0927"]]);
  // Seria vine și din setările noastre; numărul îl dă doar SmartBill.
  urmatorul = { series: "TFED", number: "" };
  q(`UPDATE facturi SET document_extern = NULL, smartbill_serie = NULL, smartbill_numar = NULL, smartbill_sync_la = NULL WHERE id = ${F7}`);
  await cer("post", `/facturi/${F7}/smartbill`, ADMIN);
  egal("SmartBill n-a spus numărul: factura e trimisă, dar documentul nu se face din serie singură", [erp(F7)[0], Boolean(unul(`SELECT smartbill_sync_la FROM facturi WHERE id = ${F7}`))], [null, true]);
  // De la validare (ciorna devine emisă și pleacă în SmartBill din același pas).
  q(`INSERT INTO facturi (id, serie, partener_id, directie, status, data_emiterii, activ) VALUES (${F8}, 'TFE', ${PART}, 'vanzare', 'ciorna', '2099-11-17', 1)`);
  q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${F8}, ${PROD}, 'TFE Folie', 3, 10, 21)`);
  urmatorul = { series: "TFED", number: "0908" };
  r = await cer("post", `/facturi/${F8}/valideaza`, ADMIN);
  egal("de la validare: emisă, cu numărul din SmartBill și cu documentul", [unul(`SELECT status FROM facturi WHERE id = ${F8}`), erp(F8)[0], erp(F8).slice(2, 4)], ["emisa", "TFED0908", ["TFED", "0908"]]);

  console.log("\n6. Facturile trimise înainte își primesc numărul fiscal la pornire");
  const sqlDb = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
  const reparare = (/UPDATE facturi SET document_extern = TRIM\(smartbill_serie\) \|\| TRIM\(smartbill_numar\)[\s\S]*?;/.exec(sqlDb) || [""])[0];
  bine("migrarea din lib/db.js are pasul", reparare.length > 0, reparare.slice(0, 80));
  q(`UPDATE facturi SET document_extern = NULL WHERE id IN (${F1}, ${F3})`);
  q(`UPDATE facturi SET document_extern = '  ' WHERE id = ${F5}`);
  const importata = Number(unul(`SELECT id FROM facturi WHERE UPPER(serie) = 'TFED' AND numar = 950`));
  q(`UPDATE facturi SET document_extern = NULL, smartbill_serie = 'TFED', smartbill_numar = '950' WHERE id = ${importata}`);
  const ruleaza = () => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", reparare], { env: ENV, encoding: "utf8" });
  ruleaza();
  egal("cele făcute în ERP și trimise: documentul e numărul din SmartBill", [erp(F1)[0], erp(F3)[0], erp(F5)[0]], ["TFED901", "TFED903", "TFED905"]);
  egal("ce avea deja un document, ce n-a fost trimis și ce a venit din import: neatinse", [erp(F2)[0], erp(F4)[0], erp(importata)[0]], ["ALTCEVA 7", null, null]);
  q(`UPDATE facturi SET document_extern = 'PUS DUPA' WHERE id = ${F1}`);
  ruleaza();
  egal("rulată din nou (la fiecare pornire): nu calcă ce s-a scris între timp", erp(F1)[0], "PUS DUPA");
  q(`UPDATE facturi SET document_extern = 'TFED901' WHERE id = ${F1}`);
  q(`UPDATE facturi SET document_extern = 'TFED950', smartbill_serie = NULL, smartbill_numar = NULL WHERE id = ${importata}`);

  console.log("\n7. Lista și pagina arată numărul fiscal, cu cel din ERP alături");
  // Facturile testului sunt din 2099, ca să nu se amestece cu nimic: lista se cere pe anul lor.
  q(`UPDATE facturi SET document_extern = 'DOCMANA7' WHERE id = ${F4}`);
  r = await cer("get", "/facturi", ADMIN, { query: { q: "TFE Client", perioada: "custom", de_la: "2099-01-01", pana_la: "2099-12-31" } });
  const randul = (doc) => { const m = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${doc}</a>[\\s\\S]*?</tr>`).exec(r.corp); return m ? m[0] : ""; };
  bine("factura din ERP trimisă în SmartBill: numărul fiscal, cu „în ERP: TFE-91” dedesubt", r.cod === 200 && randul("TFED901").includes("în ERP: TFE-91"), randul("TFED901").slice(0, 300));
  bine("cea venită din SmartBill și cea netrimisă, cu un document scris de mână: ca până acum, fără rândul în plus", randul("TFED950") !== "" && !randul("TFED950").includes("în ERP:") && randul("DOCMANA7") !== "" && !randul("DOCMANA7").includes("în ERP:"), randul("DOCMANA7").slice(0, 200));
  r = await cer("get", `/facturi/${F1}`, ADMIN);
  bine("pagina facturii: „TFED901 (TFE-91 în ERP)” în titlu", r.cod === 200 && r.corp.includes("Factură TFED901 (TFE-91 în ERP)"), (r.corp.match(/<title>[^<]*/) || [""])[0]);
  r = await cer("get", `/facturi/${F4}`, ADMIN);
  bine("…iar cea netrimisă rămâne „TFE-94”", r.corp.includes("Factură TFE-94") && !r.corp.includes("în ERP)"), (r.corp.match(/<title>[^<]*/) || [""])[0]);

  console.log("\n8. Liniile citite din SmartBill nu le înlocuiesc pe ale facturii făcute în ERP");
  r = await PUNTE.HANDLERE.facturi_linii([
    { factura: "TFED 901", denumire: "Rând ghicit din SmartBill", cantitate: "1", pret_unitar: "1600", cota_tva: "21" },
    { factura: "TFED 950", denumire: "Folie citită din SmartBill", cantitate: "160", pret_unitar: "10", cota_tva: "21" },
  ]);
  egal("factura făcută în ERP își ține liniile; cea venită din SmartBill le primește pe cele citite", [r.facturi, r.facute_in_erp, liniiPe(F1), liniiPe(importata)], [1, 1, [["TFE Folie", 160, 10]], [["Folie citită din SmartBill", 160, 10]]]);

  console.log("\n9. Îndreptarea FCT-3 (Crama Ceptura): prețul în euro luat drept lei");
  const DB = require(path.join(RAD, "lib", "db.js"));
  const martor = (id, numar, sb, pret, cant) => {
    q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, activ, smartbill_serie, smartbill_numar, observatii)
       VALUES (${id}, 'FCT', ${numar}, ${PART}, 'vanzare', 'emisa', '2099-11-16', 1, ${sb ? lit(sb[0]) : "NULL"}, ${sb ? lit(sb[1]) : "NULL"}, 'o mențiune a ei')`);
    q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id}, ${PROD}, 'Folie stretch', ${cant}, ${pret}, 21)`);
    q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id}, 'Transport', 1, 35.2, 21)`);
  };
  const pretSiNota = (id) => [liniiPe(id).map((x) => [x[1], Math.round(x[2] * 100) / 100]), unul(`SELECT COALESCE(observatii, '') FROM facturi WHERE id = ${id}`)];
  martor(C1, 3, ["CSHM", "3407"], 35.2, 45); // factura de pe live
  martor(C2, 3, ["CSHM", "3408"], 35.2, 45); // același număr în ERP, altă factură în SmartBill
  martor(C3, 3, null, 35.2, 45); // netrimisă
  martor(C4, 5, ["CSHM", "3407"], 35.2, 45); // alt număr în ERP
  const inainte = [C2, C3, C4].map(pretSiNota);
  await DB.indreptariPunctuale();
  egal("linia de 45 × 35,20 devine 45 × 188,64; cealaltă linie a facturii rămâne", pretSiNota(C1)[0], [[45, 188.64], [1, 35.2]]);
  egal("totalul facturii e cel din SmartBill, plus transportul ei", totalFacturii(C1), Math.round((45 * 188.64 + 35.2) * 1.21 * 100) / 100);
  egal("pe factură rămâne scris ce s-a îndreptat și de ce, după mențiunea pe care o avea", pretSiNota(C1)[1], "o mențiune a ei " + DB.NOTA_FCT3);
  egal("facturile care doar seamănă (alt număr în SmartBill, netrimisă, alt număr în ERP): neatinse", [C2, C3, C4].map(pretSiNota), inainte);
  await DB.indreptariPunctuale();
  egal("a doua pornire nu mai schimbă nimic și nu scrie mențiunea încă o dată", pretSiNota(C1), [[[45, 188.64], [1, 35.2]], "o mențiune a ei " + DB.NOTA_FCT3]);
  bine("pasul e chemat la pornire, din migrate()", /async function migrate\(\) \{[^}]*await indreptariPunctuale\(\);[^}]*\}/.test(sqlDb), "");
  q(`UPDATE facturi_linii SET pret_unitar = 35.2, cantitate = 44 WHERE factura_id = ${C1} AND denumire = 'Folie stretch'`);
  await DB.indreptariPunctuale();
  egal("aceeași factură, cu altă cantitate decât cea știută: nu se atinge", pretSiNota(C1)[0], [[44, 35.2], [1, 35.2]]);
  r = await cer("get", `/facturi/${C1}`, ADMIN);
  bine("mențiunea se vede pe pagina facturii", r.cod === 200 && /data-observatii[^>]*>[\s\S]{0,200}Îndreptată pe 17\.11\.2026/.test(r.corp), (r.corp.match(/data-observatii[\s\S]{0,160}/) || ["lipsește"])[0]);
  r = await cer("get", `/facturi/${F4}`, ADMIN);
  bine("…iar o factură fără mențiuni n-are rândul gol", r.cod === 200 && !r.corp.includes("data-observatii"), "");

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
