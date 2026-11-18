"use strict";
// Facturile făcute de agent: ciorna din comandă, validarea la financiar,
// factura emisă de tipărit și de descărcat.
//
// CEREREA LUI VALI, 18.11.2026: „Dă-le acces și la facturi, să le facă tot ei,
// iar din financiar, înainte de trimitere în SmartBill, se validează. Iar când
// e gata văd factura emisă și o pot inclusiv downloada sau printa."
//
// CE APĂRĂ:
//   • agentul își face factura din comanda lui; iese ciornă, pe care NU o
//     poate valida; financiarul o găsește în capul listei de facturi;
//   • „Facturile mele" arată agentului comenzile gata de facturat și facturile
//     lui și ale clienților lui — nu ale altora;
//   • foaia de tipărit: ciorna poartă CIORNĂ, factura trimisă poartă seria și
//     numărul din SmartBill; PDF-ul din SmartBill se dă doar pentru facturile
//     ajunse acolo și doar se citește;
//   • alt agent nu deschide nici foaia, nici PDF-ul.
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

const SB = require(path.join(RAD, "lib", "smartbill.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi", "facturi", "proforme", "facturile-mele"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97711, nume: "Vali Test", rol: "admin", email: "v.fa@test.ro" };
const AGENT = { id: 97712, nume: "Gabriela Test", rol: "vanzari", email: "g.fa@test.ro" };

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


const AUTH = require(path.join(RAD, "lib", "auth.js"));
const ALT = { id: 97713, nume: "Altul Test", rol: "vanzari", email: "a.fa@test.ro" };
const FIN = { id: 97715, nume: "Financiar Test", rol: "financiar", email: "f.fa@test.ro" };
function curata() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id IN (97701, 97702))",
    "UPDATE comenzi SET factura_id = NULL WHERE partener_id IN (97701, 97702)",
    "DELETE FROM facturi WHERE partener_id IN (97701, 97702)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (97701, 97702))",
    "DELETE FROM comenzi WHERE partener_id IN (97701, 97702)",
    "DELETE FROM interactiuni WHERE partener_id IN (97701, 97702)",
    "DELETE FROM parteneri WHERE id IN (97701, 97702)",
    "DELETE FROM miscari_stoc WHERE produs_id = 97721",
    "DELETE FROM produse WHERE id = 97721",
    "DELETE FROM utilizatori WHERE id BETWEEN 97711 AND 97719",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const factura = (id) => q("SELECT * FROM facturi WHERE id = ?", [id])[0];
const text = (h) => String(h).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

(async () => {
  console.log("── Ușile ────────────────────────────────────────────────────");
  egal("agentul deschide factura, foaia ei de tipărit, PDF-ul și „Facturile mele”; lista de facturi, validarea, plata și trimiterea rămân închise",
    ["/facturi/12", "/facturi/12/tipar", "/facturi/12/pdf", "/facturile-mele", "/facturi", "/facturi/12/valideaza", "/facturi/12/plata", "/facturi/12/smartbill", "/facturi/12/tipar/x", "/facturi/nou"].map((p) => AUTH.poateAccesa(AGENT, p)),
    [true, true, true, true, false, false, false, false, false, false]);
  egal("cine n-are Vânzările nu intră pe ușa facturii", [AUTH.poateAccesa({ rol: "depozit" }, "/facturi/12/tipar"), AUTH.poateAccesa({ rol: "depozit" }, "/facturile-mele")], [false, true]);

  console.log("\n── PDF-ul din SmartBill: doar citire ────────────────────────");
  const fetchVechi = global.fetch;
  const cereri = [];
  let raspuns = { ok: true, status: 200, corp: Buffer.from("%PDF-1.4 factura") };
  global.fetch = async (url, o) => { cereri.push({ url: String(url), o }); return { ok: raspuns.ok, status: raspuns.status, arrayBuffer: async () => raspuns.corp }; };
  Object.assign(process.env, { SMARTBILL_EMAIL: "x@test.ro", SMARTBILL_TOKEN: "tok", SMARTBILL_CIF: "RO27244210" });
  const buf = await SB.descarcaPdf("CSHM", "0099");
  egal("cere PDF-ul cu GET, pe CIF, serie și număr, fără corp", [buf.toString(), cereri[0].o.method, cereri[0].o.body === undefined, cereri[0].url, /^Basic /.test(cereri[0].o.headers.Authorization)], ["%PDF-1.4 factura", "GET", true, "https://ws.smartbill.ro/SBORO/api/invoice/pdf?cif=RO27244210&seriesname=CSHM&number=0099", true]);
  const pica = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
  raspuns = { ok: true, status: 200, corp: Buffer.from("<html>nu e pdf</html>") };
  const e1 = await pica(() => SB.descarcaPdf("CSHM", "1"));
  raspuns = { ok: false, status: 404, corp: Buffer.from(JSON.stringify({ errorText: "Factura nu exista" })) };
  const e2 = await pica(() => SB.descarcaPdf("CSHM", "2"));
  const inainte = cereri.length;
  const e3 = await pica(() => SB.descarcaPdf("", "2"));
  for (const k of Object.keys(process.env)) if (/^SMARTBILL/.test(k)) delete process.env[k];
  const e4 = await pica(() => SB.descarcaPdf("CSHM", "2"));
  egal("ce nu e PDF e refuzat, cu mesajul SmartBill; fără serie sau fără configurare nu se cere nimic", [/n-a dat PDF-ul facturii CSHM 1 \(200\)/.test(e1), /\(404\): Factura nu exista/.test(e2), /n-are serie și număr/.test(e3), /nu este configurată/.test(e4), cereri.length === inainte], [true, true, true, true, true]);
  global.fetch = fetchVechi;

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97711,'Vali Test','v.fa@test.ro','x','y','admin'), (97712,'Gabriela Test','g.fa@test.ro','x','y','vanzari'), (97713,'Altul Test','a.fa@test.ro','x','y','vanzari'), (97715,'Financiar Test','f.fa@test.ro','x','y','financiar')",
    "INSERT INTO parteneri (id, nume, cui, tip, reg_com, adresa, localitate, judet, termen_plata_zile) VALUES (97701, 'FA-TEST Client SRL', 'RO97701', 'client', 'J40/7/2020', 'Str. Lunga 5', 'Craiova', 'Dolj', 30)",
    "INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES (97702, 'FA-TEST Al Doilea SRL', 'RO97702', 'client', 97713)",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97721,'FA-1','Pungă curier FA','buc',0.5,21)",
    // 1: a Gabrielei, gata de facturat, UPA. 2: a Gabrielei, încă nouă. 3: a celuilalt agent, gata. 4: a Gabrielei, gata (rămâne nefacturată).
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda, upa, termen_plata_zile) VALUES (977001, 97701, 'FA-CMD-1', '2026-11-18', 'in_stoc_depozit', 97712, 97712, 'RON', 1, 30), (977002, 97701, 'FA-CMD-2', '2026-11-18', 'noua', 97712, 97712, 'RON', 0, NULL), (977003, 97702, 'FA-CMD-3', '2026-11-18', 'in_stoc_depozit', 97713, 97713, 'RON', 0, NULL), (977004, 97701, 'FA-CMD-4', '2026-11-18', 'in_stoc_depozit', 97712, 97712, 'RON', 0, NULL)",
    "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (977001, 97721, 1000, 0.4235, 'buc'), (977002, 97721, 5, 1, 'buc'), (977003, 97721, 10, 1, 'buc'), (977004, 97721, 20, 1, 'buc')",
  ]) exec(s);

  console.log("\n── Agentul își face factura ─────────────────────────────────");
  const gata = (h) => [977001, 977002, 977003, 977004].map((id) => h.includes(`data-fa-factura="${id}"`));
  let r = await cer("/facturile-mele", { user: AGENT });
  egal("„Facturile mele”: comenzile lui gata de facturat au buton; cea nouă și cea a altui agent, nu", [r.cod, gata(r.corp)], [200, [true, false, false, true]]);
  egal("… celălalt agent o vede pe a lui", gata((await cer("/facturile-mele", { user: ALT })).corp), [false, false, true, false]);
  r = await cer("/comenzi/:id/factureaza", { metoda: "post", user: AGENT, params: { id: "977001" } });
  const f1 = q("SELECT * FROM facturi WHERE comanda_id = 977001")[0] || {};
  egal("din comandă iese o ciornă pe numele lui: fără număr fiscal, netrimisă", [locatie(r), f1.status, nr(f1.creata_de), nr(f1.agent_id), f1.smartbill_numar, nr(f1.upa)], [`/facturi/${f1.id}`, "ciorna", 97712, 97712, null, 1]);
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: AGENT, params: { id: String(f1.id) } });
  egal("agentul nu o poate valida: rămâne ciornă", [r.cod, factura(f1.id).status], [403, "ciorna"]);
  r = await cer("/facturi/:id", { user: AGENT, params: { id: String(f1.id) } });
  bine("pagina ciornei îi spune că așteaptă validarea și are butonul de tipărit, fără cel de validare și fără PDF din SmartBill",
    r.cod === 200 && /data-asteapta-validarea>Nu ai drepturi de validare: factura așteaptă să fie validată de cineva de la facturare/.test(r.corp) && r.corp.includes(`href="/facturi/${f1.id}/tipar"`) && !r.corp.includes(`/facturi/${f1.id}/valideaza`) && !r.corp.includes(`/facturi/${f1.id}/pdf`));
  r = await cer("/facturile-mele", { user: AGENT });
  bine("în lista lui: ciornă, așteaptă validarea; comanda facturată a ieșit dintre cele de facturat; fără „Descarcă PDF”",
    r.corp.includes(`data-factura="${f1.id}"><strong>ciornă</strong>`) && r.corp.includes("ciornă — așteaptă validarea") && r.corp.includes("1 ciornă așteaptă validarea") && !r.corp.includes('data-fa-factura="977001"') && r.corp.includes('data-fa-factura="977004"') && !r.corp.includes(`data-pdf="${f1.id}"`));
  bine("celălalt agent nu o vede în lista lui", !(await cer("/facturile-mele", { user: ALT })).corp.includes(`data-factura="${f1.id}"`));

  console.log("\n── Foaia ciornei ────────────────────────────────────────────");
  r = await cer("/facturi/:id/tipar", { user: AGENT, params: { id: String(f1.id) } });
  let tx = text(r.corp);
  bine("foaia: FACTURĂ, cu CIORNĂ scris peste ea, clientul, linia, totalul, scadența, mențiunea UPA, și spune că nu e încă factură",
    r.cod === 200 && tx.includes("FACTURĂ") && !tx.includes("PROFORMĂ") && /data-filigran>CIORNĂ</.test(r.corp) && tx.includes("FA-TEST Client SRL") && tx.includes("J40/7/2020") && tx.includes("Str. Lunga 5, Craiova, Jud. Dolj")
      && tx.includes("Pungă curier FA") && /data-total>512,44 lei</.test(r.corp) && tx.includes("Scadentă:") && tx.includes("Comanda nr.: FA-CMD-1") && /data-mentiune>Produsele livrate catre FA-TEST Client SRL/.test(r.corp)
      && tx.includes("Ciornă: nu e încă factură") && tx.includes("Întocmit de: Gabriela Test") && !r.corp.includes(`/facturi/${f1.id}/pdf`),
    tx.slice(0, 700));
  r = await cer("/facturi/:id/pdf", { user: AGENT, params: { id: String(f1.id) } });
  egal("ciorna n-are PDF în SmartBill: e dus la foaia din ERP, cu explicația", [r.cod, /^\/facturi\/\d+\/tipar\?mesaj=/.test(locatie(r)), /n-a ajuns încă în SmartBill/.test(decodeURIComponent(locatie(r)))], [302, true, true]);
  egal("alt agent nu deschide nici foaia, nici PDF-ul; financiarul și administratorul, da", [(await cer("/facturi/:id/tipar", { user: ALT, params: { id: String(f1.id) } })).cod, (await cer("/facturi/:id/pdf", { user: ALT, params: { id: String(f1.id) } })).cod, (await cer("/facturi/:id/tipar", { user: FIN, params: { id: String(f1.id) } })).cod, (await cer("/facturi/:id/tipar", { user: ADMIN, params: { id: String(f1.id) } })).cod], [403, 403, 200, 200]);
  egal("factură care nu există: 404", [(await cer("/facturi/:id/tipar", { params: { id: "999999999" } })).cod, (await cer("/facturi/:id/pdf", { params: { id: "999999999" } })).cod], [404, 404]);

  console.log("\n── Financiarul validează ────────────────────────────────────");
  r = await cer("/facturi", { user: FIN });
  const bloc = (String(r.corp).match(/<div class="detail-box" data-de-validat[\s\S]*?<\/table>/) || [""])[0];
  bine("lista de facturi începe cu ciornele care așteaptă validarea: clientul, comanda, cine a făcut-o", bloc.includes("FA-TEST Client SRL") && bloc.includes("FA-CMD-1") && bloc.includes("Gabriela Test") && bloc.includes(`href="/facturi/${f1.id}"`) && /așteaptă\s+validarea/.test(bloc), bloc.slice(0, 500));
  bine("… și filtrul de status are „ciorne — de validat”", r.corp.includes('<option value="ciorna">ciorne — de validat</option>'));
  r = await cer("/facturi/:id", { user: FIN, params: { id: String(f1.id) } });
  bine("financiarul are butonul de validare pe ciornă", r.corp.includes(`action="/facturi/${f1.id}/valideaza"`));

  console.log("\n── Factura emisă ────────────────────────────────────────────");
  // Trimiterea în SmartBill e a altui test; aici factura e pusă în starea de după ea.
  exec(`UPDATE facturi SET status = 'emisa', numar = 7, smartbill_sync_la = '2026-11-18 10:00:00', smartbill_serie = 'CSHMUPA', smartbill_numar = '0099', document_extern = 'CSHMUPA0099' WHERE id = ${f1.id}`);
  r = await cer("/facturi", { user: FIN });
  bine("odată validată, nu mai stă la „de validat”", !/data-de-validat/.test(r.corp) || !(String(r.corp).match(/<div class="detail-box" data-de-validat[\s\S]*?<\/table>/) || [""])[0].includes("FA-CMD-1"));
  r = await cer("/facturile-mele", { user: AGENT });
  bine("agentul o vede emisă, cu numărul din SmartBill, cu „Tipărește” și „Descarcă PDF”", r.corp.includes(`data-factura="${f1.id}"><strong>CSHMUPA 0099</strong>`) && />emisă</.test(r.corp) && r.corp.includes(`href="/facturi/${f1.id}/tipar"`) && r.corp.includes(`data-pdf="${f1.id}"`) && !r.corp.includes("așteaptă validarea</span></h2>"));
  r = await cer("/facturi/:id", { user: AGENT, params: { id: String(f1.id) } });
  bine("pagina facturii are amândouă butoanele", r.corp.includes(`href="/facturi/${f1.id}/tipar"`) && r.corp.includes(`href="/facturi/${f1.id}/pdf"`) && r.corp.includes("Descarcă PDF-ul din SmartBill"));
  r = await cer("/facturi/:id/tipar", { user: AGENT, params: { id: String(f1.id) } });
  tx = text(r.corp);
  bine("foaia poartă seria și numărul din SmartBill, fără CIORNĂ, și spune care e documentul fiscal", tx.includes("Seria CSHMUPA nr. 0099") && !/data-filigran/.test(r.corp) && tx.includes("Copie din ERP a facturii CSHMUPA 0099. Documentul fiscal este cel emis din SmartBill.") && /<title>Factura CSHMUPA 0099 - FA-TEST Client SRL<\/title>/.test(r.corp) && r.corp.includes(`/facturi/${f1.id}/pdf`));
  const cerute = [];
  const original = SB.descarcaPdf;
  SB.descarcaPdf = async (s, n) => { cerute.push([s, n]); return Buffer.from("%PDF-1.4 din smartbill"); };
  r = await cer("/facturi/:id/pdf", { user: AGENT, params: { id: String(f1.id) } });
  egal("PDF-ul: cerut din SmartBill pe seria și numărul facturii, dat agentului ca PDF", [r.cod, r.antet["Content-Type"], /filename="Factura-CSHMUPA-0099\.pdf"/.test(r.antet["Content-Disposition"]), String(r.corp), cerute], [200, "application/pdf", true, "%PDF-1.4 din smartbill", [["CSHMUPA", "0099"]]]);
  r = await cer("/facturi/:id/pdf", { user: ALT, params: { id: String(f1.id) } });
  egal("alt agent nu-l primește și SmartBill nici nu e întrebat", [r.cod, cerute.length], [403, 1]);
  SB.descarcaPdf = async () => { throw new Error("SmartBill e oprit"); };
  r = await cer("/facturi/:id/pdf", { user: AGENT, params: { id: String(f1.id) } });
  egal("SmartBill nu răspunde: agentul primește foaia din ERP, cu motivul", [r.cod, /^\/facturi\/\d+\/tipar\?mesaj=/.test(locatie(r)), /SmartBill e oprit/.test(decodeURIComponent(locatie(r)))], [302, true, true]);
  SB.descarcaPdf = async (s, n) => { cerute.push([s, n]); return Buffer.from("%PDF-1.4"); };
  exec(`UPDATE facturi SET smartbill_sync_la = NULL, smartbill_serie = NULL, smartbill_numar = NULL, sursa_import = 'smartbill', serie = 'CSHM', numar = 3409, document_extern = 'CSHM3409' WHERE id = ${f1.id}`);
  r = await cer("/facturi/:id/pdf", { user: AGENT, params: { id: String(f1.id) } });
  egal("factura adusă din SmartBill se cere pe seria și numărul ei", [r.cod, cerute[cerute.length - 1]], [200, ["CSHM", "3409"]]);
  exec(`UPDATE facturi SET sursa_import = NULL, serie = 'FCT', numar = 7, document_extern = NULL WHERE id = ${f1.id}`);
  const inainteDe = cerute.length;
  r = await cer("/facturi/:id/pdf", { user: AGENT, params: { id: String(f1.id) } });
  const foaie = await cer("/facturi/:id/tipar", { user: AGENT, params: { id: String(f1.id) } });
  egal("factura emisă în ERP și netrimisă: fără PDF din SmartBill; foaia o spune", [r.cod, cerute.length === inainteDe, text(foaie.corp).includes("Seria FCT nr. 7"), text(foaie.corp).includes("netrimisă încă în SmartBill")], [302, true, true, true]);
  exec(`UPDATE facturi SET status = 'anulata' WHERE id = ${f1.id}`);
  bine("factura anulată: foaia o spune", />ANULATĂ</.test((await cer("/facturi/:id/tipar", { user: AGENT, params: { id: String(f1.id) } })).corp));
  SB.descarcaPdf = original;

  console.log("\n── Validarea nu trimite a doua oară; ciorna nu pleacă nevalidată ──");
  // Pe live, 18.11.2026: cinci ciorne erau deja în SmartBill (trimise cu butonul),
  // iar validarea le-ar fi emis a doua oară.
  const trimise = [];
  const cfg = SB.isConfigured, trm = SB.trimiteFactura;
  SB.isConfigured = () => true;
  let raspunsSB = async () => ({ series: "CSHM", number: "4001" });
  SB.trimiteFactura = async (f, l, a) => { trimise.push({ id: Number(f.id), coduri: l.map((x) => x.cod_smartbill), adresa: a && [a.tara, a.judet, a.localitate] }); return raspunsSB(); };
  exec("UPDATE parteneri SET tara = 'Romania' WHERE id = 97701");
  const ciornaNoua = async (comandaId, user) => { await cer("/comenzi/:id/factureaza", { metoda: "post", user: user || AGENT, params: { id: String(comandaId) } }); return q("SELECT * FROM facturi WHERE comanda_id = ? ORDER BY id DESC LIMIT 1", [comandaId])[0]; };
  const mesaj = (r) => decodeURIComponent(String(locatie(r)).split("mesaj=")[1] || "");

  // A. Ciornă deja trimisă cu butonul.
  let fa = await ciornaNoua(977004);
  exec(`UPDATE facturi SET smartbill_sync_la = '2026-11-18 09:00:00', smartbill_serie = 'CSHM', smartbill_numar = '3418', document_extern = 'CSHM3418' WHERE id = ${fa.id}`);
  r = await cer("/facturi", { user: FIN });
  bine("în coada de validat, ciorna deja trimisă e arătată ca atare", r.corp.includes(`data-deja-trimisa="${fa.id}">deja trimisă (CSHM-3418)`) && /nu se mai trimit o dată/.test(r.corp));
  r = await cer("/facturi/:id", { user: FIN, params: { id: String(fa.id) } });
  bine("pagina ei spune că e deja în SmartBill și că validarea nu o mai trimite", /data-ciorna-trimisa>A plecat deja în SmartBill \(CSHM-3418\)/.test(r.corp) && r.corp.includes("nu o mai trimite o dată") && r.corp.includes("E deja în SmartBill, deci nu se mai trimite."));
  r = await cer("/facturile-mele", { user: AGENT });
  bine("agentul o vede emisă în SmartBill (nevalidată în ERP), cu PDF", r.corp.includes(`data-factura="${fa.id}"><strong>CSHM 3418</strong>`) && r.corp.includes("emisă în SmartBill") && r.corp.includes("nevalidată în ERP") && r.corp.includes(`data-pdf="${fa.id}"`));
  r = await cer("/facturi/:id/tipar", { user: AGENT, params: { id: String(fa.id) } });
  bine("foaia ei poartă numărul fiscal, fără CIORNĂ", text(r.corp).includes("Seria CSHM nr. 3418") && !/data-filigran/.test(r.corp) && text(r.corp).includes("Copie din ERP a facturii CSHM 3418"));
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: FIN, params: { id: String(fa.id) } });
  let dupa = factura(fa.id);
  egal("validată: capătă număr în ERP, dar în SmartBill NU mai pleacă o dată", [dupa.status, nr(dupa.numar) > 0, trimise.length, dupa.smartbill_numar, /era deja în SmartBill \(CSHM-3418\): n-am trimis-o a doua oară/.test(mesaj(r))], ["emisa", true, 0, "3418", true]);

  // B. Ciornă nevalidată: butonul de trimitere nu o trimite.
  exec("UPDATE comenzi SET factura_id = NULL, status = 'in_stoc_depozit' WHERE id = 977001");
  exec(`UPDATE facturi SET activ = 0 WHERE id = ${f1.id}`);
  let fb = await ciornaNoua(977001);
  r = await cer("/facturi/:id/smartbill", { metoda: "post", user: FIN, params: { id: String(fb.id) }, body: {} });
  egal("„Trimite în SmartBill” pe o ciornă: nu pleacă, i se spune să valideze", [trimise.length, factura(fb.id).smartbill_sync_la, /Factura e ciornă: n-am trimis-o\. Apasă „Validează și emite factura”/.test(mesaj(r))], [0, null, true]);
  r = await cer("/facturi/:id/smartbill/client", { metoda: "post", user: FIN, params: { id: String(fb.id) }, body: { tara: "Romania", judet: "Dolj", localitate: "Craiova" } });
  egal("… nici pe ușa cu datele clientului", [trimise.length, /Factura e ciornă/.test(mesaj(r))], [0, true]);
  r = await cer("/facturi/:id", { user: FIN, params: { id: String(fb.id) } });
  bine("pagina ciornei n-are buton de trimitere: spune că pleacă la validare", /data-smartbill-dupa-validare/.test(r.corp) && !r.corp.includes(`action="/facturi/${fb.id}/smartbill"`) && r.corp.includes(`action="/facturi/${fb.id}/valideaza"`));

  // C. Validarea o trimite, o singură dată, cum o trimite și butonul.
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: FIN, params: { id: String(fb.id) } });
  dupa = factura(fb.id);
  egal("validarea o emite și o trimite: cu codul produsului și cu țara, județul și localitatea clientului", [dupa.status, trimise, dupa.smartbill_serie, dupa.smartbill_numar, /Trimisă și în SmartBill/.test(mesaj(r))], ["emisa", [{ id: Number(fb.id), coduri: ["FA-1"], adresa: ["Romania", "Dolj", "Craiova"] }], "CSHM", "4001", true]);
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: FIN, params: { id: String(fb.id) } });
  r = await cer("/facturi/:id/smartbill", { metoda: "post", user: FIN, params: { id: String(fb.id) }, body: {} });
  egal("a doua validare și butonul apăsat după: nimic nu mai pleacă", [trimise.length, /deja în SmartBill \(CSHM-4001\)/.test(mesaj(r))], [1, true]);
  r = await cer("/facturi/:id", { user: FIN, params: { id: String(fb.id) } });
  bine("factura validată are la loc butonul, ca „Retrimite”, cu întrebare", r.corp.includes(`action="/facturi/${fb.id}/smartbill"`) && r.corp.includes("Retrimite în SmartBill"));

  // D. Client fără localitate și județ: validă la noi, netrimisă, cu motivul.
  let fd = await ciornaNoua(977003, ALT);
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: FIN, params: { id: String(fd.id) } });
  egal("clientul n-are țară, județ, localitate: factura e validă în ERP și nu pleacă pe ghicite", [factura(fd.id).status, trimise.length, factura(fd.id).smartbill_sync_la, /N-a plecat în SmartBill: lipsesc țara, județul sau localitatea/.test(mesaj(r))], ["emisa", 1, null, true]);
  r = await cer("/facturi/:id", { user: FIN, params: { id: String(fd.id) } });
  bine("… și se trimite apoi cu butonul", r.corp.includes(`action="/facturi/${fd.id}/smartbill"`) && r.corp.includes("Trimite factura în SmartBill"));

  // E. SmartBill cade fără răspuns limpede.
  exec("UPDATE comenzi SET factura_id = NULL, status = 'in_stoc_depozit' WHERE id = 977004");
  exec(`UPDATE facturi SET activ = 0 WHERE id = ${fa.id}`);
  let fe = await ciornaNoua(977004);
  raspunsSB = async () => { throw new Error("fetch failed"); };
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: FIN, params: { id: String(fe.id) } });
  egal("SmartBill cade la mijloc: factura e validă la noi, netrimisă, iar omul e trimis să se uite în SmartBill înainte de a retrimite", [factura(fe.id).status, factura(fe.id).smartbill_sync_la, /nu a plecat în SmartBill: fetch failed Nu se știe dacă a ajuns: uită-te în SmartBill/.test(mesaj(r))], ["emisa", null, true]);
  raspunsSB = async () => { throw new Error("SmartBill a răspuns cu eroare (400): țara trebuie specificată"); };
  exec(`UPDATE facturi SET status = 'ciorna', numar = NULL WHERE id = ${fe.id}`);
  r = await cer("/facturi/:id/valideaza", { metoda: "post", user: FIN, params: { id: String(fe.id) } });
  bine("un refuz limpede (400) nu sperie degeaba", /\(400\): țara trebuie specificată/.test(mesaj(r)) && !/Nu se știe dacă a ajuns/.test(mesaj(r)), mesaj(r));
  SB.isConfigured = cfg; SB.trimiteFactura = trm;

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
