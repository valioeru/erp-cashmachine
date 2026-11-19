"use strict";
// Proforma emisă de agent direct din comandă.
//
// CEREREA LUI VALI, 18.11.2026: „Fă meniu «emite proformă» și emite proformă de
// către agenți pentru clienții lor, să o poată emite direct din comandă, cu
// preluare la toate datele și pus pe el. La număr incrementat, indiferent cine
// face proforma."
//
// CE APĂRĂ:
//   • proforma ia din comandă clientul, liniile, prețurile, TVA-ul, moneda,
//     cursul, termenul, livrarea și mențiunea UPA, și le ține: o fișă sau o
//     comandă schimbată mai târziu nu rescrie hârtia emisă;
//   • numerele merg într-un singur șir, oricine ar emite; o emitere refuzată
//     nu consumă număr; aceeași comandă neschimbată nu primește două numere;
//   • agentul emite și vede doar pentru comenzile lui și ale clienților lui;
//     financiarul și administratorul, pentru toți;
//   • proforma nu se șterge: se anulează, cu motiv, de cine a emis-o sau de financiar.
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
};
for (const m of ["comenzi", "proforme"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97611, nume: "Vali Test", rol: "admin", email: "v.pf@test.ro" };
const AGENT = { id: 97612, nume: "Gabriela Test", rol: "vanzari", email: "g.pf@test.ro" };

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


const PF = require(path.join(RAD, "lib", "proforma.js"));
const AUTH = require(path.join(RAD, "lib", "auth.js"));
const RENDER = require(path.join(RAD, "lib", "render.js"));
const C1 = 97601, C2 = 97602, P1 = 97621, P2 = 97622;
const ALT = { id: 97613, nume: "Altul Test", rol: "vanzari", email: "a.pf@test.ro" };
const ALOCAT = { id: 97614, nume: "Alocata Test", rol: "vanzari", email: "al.pf@test.ro" };
const FIN = { id: 97615, nume: "Financiar Test", rol: "financiar", email: "f.pf@test.ro" };
const CUBIFA = { id: 97616, nume: "Cu Bifa Test", rol: "vanzari", email: "b.pf@test.ro", sectiuni: "/crm,/facturi" };
let contorVechi = [];
function curata() {
  for (const s of [
    "DELETE FROM proforme WHERE partener_id IN (97601, 97602)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (97601, 97602))",
    "DELETE FROM comenzi WHERE partener_id IN (97601, 97602)",
    "DELETE FROM interactiuni WHERE partener_id IN (97601, 97602)",
    "DELETE FROM alocari_clienti WHERE partener_id IN (97601, 97602)",
    "DELETE FROM parteneri WHERE id IN (97601, 97602)",
    "DELETE FROM produse WHERE id IN (97621, 97622)",
    "DELETE FROM utilizatori WHERE id BETWEEN 97611 AND 97619",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const contor = () => q("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('proforma_serie','proforma_urmator') ORDER BY cheie").map((x) => x.valoare);
const pfDe = (id) => q("SELECT * FROM proforme WHERE id = ?", [id])[0];
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/proforme\/(\d+)/) || [])[1] || 0);
const emite = (comandaId, user, body) => cer("/comenzi/:id/proforma", { metoda: "post", user, params: { id: String(comandaId) }, body });
const cate = () => Number(q("SELECT COUNT(*) AS n, 1 AS x FROM proforme WHERE partener_id IN (97601, 97602)")[0].n);
const text = (h) => String(h).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

(async () => {
  console.log("── Socotelile și foaia, fără bază ───────────────────────────");
  const L = [
    { produs_id: 1, denumire: "Pungă", um: "buc", cantitate: 1000, pret_unitar: 0.4235, cota_tva: 21 },
    { produs_id: 2, denumire: "Carte", um: "buc", cantitate: 3, pret_unitar: 33.335, cota_tva: 11 },
  ];
  const T = PF.totaluri(L);
  egal("totalul: fiecare linie rotunjită la bani, TVA pe cote, apoi adunate", [T.subtotal, T.tva, T.total, T.peCota.map((c) => [c.cota, c.baza, c.tva])], [523.51, 99.94, 623.45, [[11, 100.01, 11], [21, 423.5, 88.94]]]);
  egal("fără linii: zero, nu NaN", [PF.totaluri([]).total, PF.totaluri(null).subtotal, PF.totaluri([{ cantitate: "x", pret_unitar: 2 }]).total], [0, 0, 0]);
  const D = { partener_id: 5, moneda: "RON", curs: null, termen_plata_zile: 30, upa: 0 };
  const a0 = PF.amprenta(D, L);
  egal("amprenta: aceeași la aceleași date; alta la altă cantitate, alt preț, alt client, altă monedă, alt termen, altă bifă UPA, o linie în minus",
    [PF.amprenta(Object.assign({}, D), L.map((x) => Object.assign({}, x))) === a0,
      PF.amprenta(D, [Object.assign({}, L[0], { cantitate: 1001 }), L[1]]) === a0,
      PF.amprenta(D, [Object.assign({}, L[0], { pret_unitar: 0.4236 }), L[1]]) === a0,
      PF.amprenta(Object.assign({}, D, { partener_id: 6 }), L) === a0,
      PF.amprenta(Object.assign({}, D, { moneda: "EUR", curs: 5 }), L) === a0,
      PF.amprenta(Object.assign({}, D, { termen_plata_zile: 0 }), L) === a0,
      PF.amprenta(Object.assign({}, D, { upa: 1 }), L) === a0,
      PF.amprenta(D, [L[0]]) === a0],
    [true, false, false, false, false, false, false, false]);
  let h = PF.pagina({ serie: "PF", numar: 7, data: "2026-11-18", client_nume: "Client <SRL>", client_cui: "RO1", moneda: "EUR", curs: 5.0912, curs_nota: "BNR din 17/11/2026", termen_plata_zile: 30, mentiune: "Mentiune UPA", creat_de: "Gabi", comanda_numar: "CMD-9" }, L, { bara: "<button>Tipărește</button>" });
  const t = text(h);
  bine("foaia: titlul, seria și numărul, data, furnizorul cu IBAN și bancă, clientul (cu semnele scăpate), comanda",
    t.includes("FACTURĂ PROFORMĂ") && t.includes("Seria PF nr. 7") && t.includes("18/11/2026") && t.includes("CASH MACHINE S.R.L.") && t.includes("RO10BRDE450SV99442324500") && t.includes("BRD Sucursala MCC")
      && h.includes("Client &lt;SRL&gt;") && !h.includes("Client <SRL>") && t.includes("Comanda nr.: CMD-9"));
  bine("foaia: prețul cu patru zecimale, totalurile în moneda comenzii, echivalentul în lei la cursul comenzii, termenul, mențiunea",
    t.includes("0,4235") && /data-total>623,45 EUR</.test(h) && /data-subtotal>523,51 EUR</.test(h) && /data-total-lei>3\.174,11 lei</.test(h) && t.includes("Curs EUR: 5,0912 lei (BNR din 17/11/2026)") && t.includes("Termen de plată: 30 de zile") && t.includes("Mentiune UPA"),
    (h.match(/data-total[^<]*<|data-total-lei[^<]*</g) || []).join(" "));
  bine("foaia spune că nu e document fiscal; titlul paginii devine numele PDF-ului; bara nu se tipărește",
    t.includes("Proforma nu este document fiscal") && /<title>Proforma PF 7 - Client &lt;SRL&gt;<\/title>/.test(h) && /@media print \{ \.bara \{ display:none/.test(h));
  h = PF.pagina({ serie: "PF", numar: 8, data: "2026-11-18", client_nume: "X", moneda: "RON", termen_plata_zile: 0, anulat: 1, motiv_anulare: "preț greșit" }, [L[0]]);
  bine("în lei: fără rând de curs și fără echivalent; termen 0 = la emiterea facturii; anulată se vede, cu motiv",
    !/data-curs|data-total-lei/.test(h) && /data-total>512,44 lei</.test(h) && text(h).includes("la emiterea facturii") && />ANULATĂ</.test(h) && text(h).includes("Anulată: preț greșit"));
  egal("termenul, pe românește", [1, 15, 20, 101, 119, 120].map((z) => (text(PF.pagina({ serie: "PF", numar: 1, data: "2026-11-18", termen_plata_zile: z }, [])).match(/Termen de plată: ([^I]*?) Întocmit/) || [])[1]), ["1 zi", "15 zile", "20 de zile", "101 zile", "119 zile", "120 de zile"]);

  console.log("\n── Accesul și meniul ────────────────────────────────────────");
  egal("pagina proformelor e a oricui e logat (agent, depozit), ca și comenzile", [AUTH.poateAccesa(AGENT, "/proforme"), AUTH.poateAccesa(AGENT, "/proforme/emite"), AUTH.poateAccesa(AGENT, "/proforme/12"), AUTH.poateAccesa({ rol: "depozit" }, "/proforme"), AUTH.poateAccesa({ rol: "vanzari", sectiuni: "/crm" }, "/proforme/emite")], [true, true, true, true, true]);
  const nav = RENDER.subnavComenzi("/proforme/emite", AGENT);
  bine("meniul Comenzi are „Emite proformă” și „Proforme”, și pentru agent", /href="\/proforme\/emite" class="subnav-link activ">Emite proformă</.test(nav) && /href="\/proforme" class="subnav-link">Proforme</.test(nav), nav.slice(0, 600));

  curata();
  contorVechi = contor();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97611,'Vali Test','v.pf@test.ro','x','y','admin'), (97612,'Gabriela Test','g.pf@test.ro','x','y','vanzari'), (97613,'Altul Test','a.pf@test.ro','x','y','vanzari'), (97614,'Alocata Test','al.pf@test.ro','x','y','vanzari'), (97615,'Financiar Test','f.pf@test.ro','x','y','financiar'), (97616,'Cu Bifa Test','b.pf@test.ro','x','y','vanzari')",
    "INSERT INTO parteneri (id, nume, cui, tip, reg_com, adresa, localitate, judet, telefon, email, persoana_contact, termen_plata_zile) VALUES (97601, 'PF-TEST Client SRL', 'RO97601', 'client', 'J40/1/2020', 'Str. Lunga 5', 'Craiova', 'Dolj', '0722000111', 'achizitii@pftest.ro', 'Ion Popescu', 45)",
    "INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES (97602, 'PF-TEST Al Doilea SRL', 'RO97602', 'client', 97613)",
    "INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (97601, 97614, 100)",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97621,'PF-1','Pungă curier PF','buc',0.5,21), (97622,'PF-2','Folie stretch PF','kg',12,21)",
    // 1: comanda Gabrielei, în lei, UPA, termen propriu. 2: în EUR cu curs. 3: a altui agent, pe clientul lui. 4: fără preț. 5: anulată. 6: fără linii.
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda, termen_plata_zile, upa, livrare_mod, data_livrare_ceruta) VALUES (976001, 97601, 'PF-CMD-1', '2026-11-18', 'noua', 97612, 97612, 'RON', 30, 1, 'intern', '2026-11-25')",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda, curs_bnr, curs_bnr_data) VALUES (976002, 97601, 'PF-CMD-2', '2026-11-18', 'noua', 97612, 97611, 'EUR', 5.0912, '2026-11-17')",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda) VALUES (976003, 97602, 'PF-CMD-3', '2026-11-18', 'noua', 97613, 97613, 'RON')",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda) VALUES (976004, 97601, 'PF-CMD-4', '2026-11-18', 'noua', 97612, 97612, 'RON')",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda) VALUES (976005, 97601, 'PF-CMD-5', '2026-11-18', 'anulata', 97612, 97612, 'RON')",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda) VALUES (976006, 97601, 'PF-CMD-6', '2026-11-18', 'noua', 97612, 97612, 'RON')",
    "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (976001, 97621, 1000, 0.4235, 'buc'), (976001, 97622, 12.5, 11.9, NULL), (976002, 97622, 100, 2.5, 'kg'), (976003, 97621, 10, 1, 'buc'), (976004, 97621, 10, 0, 'buc'), (976004, 97622, 1, 5, 'kg'), (976005, 97621, 10, 1, 'buc')",
    "UPDATE setari_app SET valoare = 'PFT' WHERE cheie = 'proforma_serie'",
    "UPDATE setari_app SET valoare = '501' WHERE cheie = 'proforma_urmator'",
  ]) exec(s);

  console.log("\n── Emiterea din comandă ─────────────────────────────────────");
  let r = await emite(976001, AGENT);
  const p1 = idDinLocatie(r);
  let d = pfDe(p1) || {};
  egal("agentul comenzii emite: primește numărul următor și e dus la proformă", [r.cod, /^\/proforme\/\d+\?nou=1$/.test(locatie(r)), d.serie, nr(d.numar), contor()], [302, true, "PFT", 501, ["PFT", "502"]]);
  egal("ia din comandă clientul cu toate datele de pe fișă",
    [d.client_nume, d.client_cui, d.client_regcom, d.client_adresa, d.client_contact, d.client_telefon, d.client_email, nr(d.partener_id), nr(d.comanda_id), d.comanda_numar],
    ["PF-TEST Client SRL", "RO97601", "J40/1/2020", "Str. Lunga 5, Craiova, Jud. Dolj", "Ion Popescu", "0722000111", "achizitii@pftest.ro", 97601, 976001, "PF-CMD-1"]);
  egal("… termenul comenzii (nu al fișei), livrarea, data cerută, moneda, bifa UPA cu mențiunea ei, cine a emis și agentul",
    [nr(d.termen_plata_zile), d.livrare, d.data_livrare, d.moneda, d.curs, nr(d.upa), /^Produsele livrate catre PF-TEST Client SRL sunt realizate/.test(d.mentiune || ""), d.creat_de, nr(d.creat_de_id), nr(d.agent_id), d.agent_email, d.data === new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" })],
    [30, "Trimitem noi, cu transport intern", "2026-11-25", "RON", null, 1, true, "Gabriela Test", 97612, 97612, "g.pf@test.ro", true]);
  egal("… liniile cu denumire, cod, unitate (a liniei, altfel a produsului), cantitate, preț și TVA; totalurile socotite",
    [q("SELECT denumire, cod, um, cantitate, pret_unitar, cota_tva FROM proforme_linii WHERE proforma_id = ? ORDER BY id", [p1]).map((x) => [x.denumire, x.cod, x.um, nr(x.cantitate), nr(x.pret_unitar), nr(x.cota_tva)]), nr(d.subtotal), nr(d.tva), nr(d.total)],
    [[["Pungă curier PF", "PF-1", "buc", 1000, 0.4235, 21], ["Folie stretch PF", "PF-2", "kg", 12.5, 11.9, 21]], 572.25, 120.18, 692.43]);
  egal("emiterea rămâne scrisă la client", q("SELECT subiect, 1 AS x FROM interactiuni WHERE partener_id = 97601 ORDER BY id DESC LIMIT 1").map((x) => x.subiect), ["Proformă PFT 501 din comanda PF-CMD-1"]);

  r = await emite(976001, AGENT);
  egal("a doua apăsare, comanda neschimbată: aceeași proformă, niciun număr consumat", [locatie(r), contor(), cate()], [`/proforme/${p1}?nou=0`, ["PFT", "502"], 1]);
  r = await emite(976001, ADMIN);
  egal("… la fel și când apasă altcineva", [locatie(r), cate()], [`/proforme/${p1}?nou=0`, 1]);

  console.log("\n── Cine are voie ────────────────────────────────────────────");
  r = await emite(976001, ALT);
  egal("alt agent, fără legătură cu clientul: refuzat, nimic scris", [r.cod, /nu e a unui client de-al tău/.test(r.corp), cate(), contor()], [403, true, 1, ["PFT", "502"]]);
  r = await emite(976003, AGENT);
  egal("… și invers: Gabriela nu emite pe comanda altui agent", [r.cod, cate()], [403, 1]);
  r = await emite(976003, ALT);
  const p3 = idDinLocatie(r);
  egal("agentul de pe fișa clientului emite; numărul continuă același șir, deși e alt om", [nr((pfDe(p3) || {}).numar), (pfDe(p3) || {}).creat_de, contor()], [502, "Altul Test", ["PFT", "503"]]);
  r = await emite(976002, ALOCAT);
  const p2 = idDinLocatie(r);
  egal("agentul cu clientul alocat emite pe comanda clientului", [nr((pfDe(p2) || {}).numar), nr((pfDe(p2) || {}).agent_id), nr((pfDe(p2) || {}).creat_de_id)], [503, 97612, 97614]);
  exec("UPDATE comenzi_linii SET cantitate = 11 WHERE comanda_id = 976003");
  r = await emite(976003, FIN);
  const p3b = idDinLocatie(r);
  r = await emite(976003, CUBIFA);
  egal("financiarul emite pentru oricine (comanda schimbată → număr nou); cine are bifa „Facturare” la fel — dar comanda fiind neschimbată, primește aceeași proformă",
    [nr((pfDe(p3b) || {}).numar), locatie(r), contor()], [504, `/proforme/${p3b}?nou=0`, ["PFT", "505"]]);
  r = await cer("/comenzi/:id/proforma", { metoda: "post", user: null, params: { id: "976001" } });
  egal("fără om logat: la intrare", [locatie(r), cate()], ["/login", 4]);

  console.log("\n── Ce nu se emite ───────────────────────────────────────────");
  r = await emite(976004, AGENT);
  egal("linie fără preț: refuzată cu numele produsului, fără număr consumat", [/^\/comenzi\/976004\?eroare_proforma=/.test(locatie(r)), /Fără preț pe comandă: Pungă curier PF\./.test(decodeURIComponent(locatie(r))), cate(), contor()], [true, true, 4, ["PFT", "505"]]);
  r = await cer("/comenzi/:id", { user: AGENT, params: { id: "976004" }, query: { eroare_proforma: "Proforma cere preț <b>" } });
  bine("pagina comenzii arată de ce nu s-a emis, cu semnele scăpate", /data-eroare-proforma[\s\S]{0,300}Proforma cere preț &lt;b&gt;/.test(r.corp));
  r = await emite(976005, AGENT);
  egal("comandă anulată: refuzată", [/Comanda e anulată/.test(decodeURIComponent(locatie(r))), cate()], [true, 4]);
  r = await emite(976006, AGENT);
  egal("comandă fără linii: refuzată", [/n-are nicio linie/.test(decodeURIComponent(locatie(r))), cate()], [true, 4]);
  r = await emite(999999999, ADMIN);
  egal("comandă care nu există: refuzată", [/Comanda nu există/.test(decodeURIComponent(locatie(r))), cate(), contor()], [true, 4, ["PFT", "505"]]);

  console.log("\n── Foaia emisă ──────────────────────────────────────────────");
  r = await cer("/proforme/:id", { user: AGENT, params: { id: String(p1) }, query: { nou: "1" } });
  let tx = text(r.corp);
  bine("agentul își deschide proforma: număr, client, linii, total, termen, livrare, mențiunea UPA, butoanele de tipărit și descărcat",
    r.cod === 200 && tx.includes("Seria PFT nr. 501") && tx.includes("PF-TEST Client SRL") && tx.includes("Pungă curier PF") && /data-total>692,43 lei</.test(r.corp) && tx.includes("Termen de plată: 30 de zile")
      && tx.includes("Livrare: Trimitem noi, cu transport intern") && tx.includes("Livrare cerută: 25/11/2026") && /data-mentiune>Produsele livrate catre PF-TEST Client SRL/.test(r.corp)
      && />Tipărește</.test(r.corp) && />Descarcă PDF</.test(r.corp) && tx.includes("Proforma PFT 501 a fost emisă.") && tx.includes("Întocmit de: Gabriela Test, g.pf@test.ro"));
  r = await cer("/proforme/:id", { user: ALOCAT, params: { id: String(p2) } });
  bine("comanda în EUR: prețuri și total în EUR, cursul comenzii, echivalentul în lei", /data-total>302,50 EUR</.test(r.corp) && /data-total-lei>1\.540,09 lei</.test(r.corp) && text(r.corp).includes("Curs EUR: 5,0912 lei (BNR din 17/11/2026)"), (r.corp.match(/data-total[^<]*<[^<]*|data-curs>[^<]*/g) || []).join(" | "));
  exec("UPDATE parteneri SET nume = 'PF-TEST Redenumit SRL', adresa = 'Alta 9' WHERE id = 97601");
  exec("UPDATE comenzi_linii SET pret_unitar = 99 WHERE comanda_id = 976001");
  r = await cer("/proforme/:id", { user: AGENT, params: { id: String(p1) } });
  bine("fișa și comanda schimbate după emitere nu rescriu proforma", text(r.corp).includes("PF-TEST Client SRL") && !text(r.corp).includes("Redenumit") && /data-total>692,43 lei</.test(r.corp) && text(r.corp).includes("Str. Lunga 5"));
  r = await emite(976001, AGENT);
  const p1b = idDinLocatie(r);
  d = pfDe(p1b) || {};
  egal("… dar comanda schimbată primește, la cerere, o proformă nouă, cu datele de acum", [/nou=1$/.test(locatie(r)), nr(d.numar), d.client_nume, nr(d.subtotal)], [true, 505, "PF-TEST Redenumit SRL", 100237.5]);
  r = await cer("/proforme/:id", { user: ALT, params: { id: String(p1) } });
  egal("alt agent nu deschide proforma unui client care nu e al lui", [r.cod, /Proforma altui client/.test(r.corp), r.corp.includes("692,43")], [403, true, false]);
  egal("o deschid: cine are clientul alocat, financiarul, administratorul", [(await cer("/proforme/:id", { user: ALOCAT, params: { id: String(p1) } })).cod, (await cer("/proforme/:id", { user: FIN, params: { id: String(p1) } })).cod, (await cer("/proforme/:id", { user: ADMIN, params: { id: String(p1) } })).cod], [200, 200, 200]);
  egal("proformă care nu există: 404", (await cer("/proforme/:id", { params: { id: "999999999" } })).cod, 404);

  console.log("\n── Listele ──────────────────────────────────────────────────");
  const inLista = (h) => [p1, p2, p3, p3b, p1b].map((id) => h.includes(`data-proforma="${id}"`));
  r = await cer("/proforme", { user: AGENT });
  egal("lista agentului: proformele lui și ale clienților lui, nu ale altora", inLista(r.corp), [true, true, false, false, true]);
  egal("lista celuilalt agent", inLista((await cer("/proforme", { user: ALT })).corp), [false, false, true, true, false]);
  r = await cer("/proforme", { user: FIN });
  egal("financiarul le vede pe toate; contorul îl schimbă doar administratorul", [inLista(r.corp), r.corp.includes('action="/proforme/contor"'), (await cer("/proforme", { user: ADMIN })).corp.includes('action="/proforme/contor"')], [[true, true, true, true, true], false, true]);
  const peEmite = (h) => [976001, 976002, 976003, 976004, 976005, 976006].map((id) => (h.includes(`data-emite="${id}"`) ? "buton" : h.includes(`href="/comenzi/${id}"`) ? "fără buton" : "nu apare"));
  r = await cer("/proforme/emite", { user: AGENT });
  egal("„Emite proformă”: agentul își vede comenzile (fără cele anulate; cea fără linii n-are buton)", peEmite(r.corp), ["buton", "buton", "nu apare", "buton", "nu apare", "fără buton"]);
  bine("… și proforma deja emisă pe fiecare", r.corp.includes(`href="/proforme/${p1b}" target="_blank">PFT 505<`) && r.corp.includes(">Emite din nou<") && r.corp.includes(">Emite proformă<"));
  egal("… celălalt agent, pe ale lui; administratorul, pe toate", [peEmite((await cer("/proforme/emite", { user: ALT })).corp), peEmite((await cer("/proforme/emite", { user: ADMIN })).corp)], [["nu apare", "nu apare", "buton", "nu apare", "nu apare", "nu apare"], ["buton", "buton", "buton", "buton", "nu apare", "fără buton"]]);

  console.log("\n── Pagina comenzii ──────────────────────────────────────────");
  r = await cer("/comenzi/:id", { user: AGENT, params: { id: "976001" } });
  bine("agentul comenzii are butonul și legăturile spre proformele emise", /action="\/comenzi\/976001\/proforma"[\s\S]{0,700}Emite proformă din nou/.test(r.corp) && r.corp.includes(`data-proforma="${p1}">Proforma PFT 501<`) && r.corp.includes(`data-proforma="${p1b}">Proforma PFT 505<`));
  r = await cer("/comenzi/:id", { user: ALT, params: { id: "976001" } });
  bine("alt agent nu are butonul", !r.corp.includes('action="/comenzi/976001/proforma"'));
  r = await cer("/comenzi/:id", { user: AGENT, params: { id: "976004" } });
  bine("comandă fără nicio proformă: butonul simplu „Emite proformă”", /data-emite-proforma>Emite proformă</.test(r.corp));
  r = await cer("/comenzi/:id", { user: AGENT, params: { id: "976005" } });
  bine("comanda anulată n-are buton", !r.corp.includes('action="/comenzi/976005/proforma"'));

  console.log("\n── Anularea ─────────────────────────────────────────────────");
  const anuleaza = (id, user, motiv) => cer("/proforme/:id/anuleaza", { metoda: "post", user, params: { id: String(id) }, body: { motiv } });
  r = await anuleaza(p1b, ALT, "nu-mi place");
  egal("alt agent nu anulează", [nr(pfDe(p1b).anulat), /o anulează cine a emis-o/.test(decodeURIComponent(locatie(r)))], [0, true]);
  r = await anuleaza(p1b, AGENT, "   ");
  egal("fără motiv nu se anulează", [nr(pfDe(p1b).anulat), /Scrie de ce/.test(decodeURIComponent(locatie(r)))], [0, true]);
  r = await anuleaza(p1b, AGENT, "preț greșit pe comandă");
  d = pfDe(p1b);
  egal("cine a emis-o o anulează, cu motiv; numărul rămâne folosit", [nr(d.anulat), d.motiv_anulare, d.anulat_de, nr(d.numar), contor()], [1, "preț greșit pe comandă", "Gabriela Test", 505, ["PFT", "506"]]);
  r = await cer("/proforme/:id", { user: AGENT, params: { id: String(p1b) } });
  bine("foaia anulată o spune și nu mai are buton de anulare", />ANULATĂ</.test(r.corp) && text(r.corp).includes("Anulată: preț greșit pe comandă") && !r.corp.includes(`/proforme/${p1b}/anuleaza`));
  r = await anuleaza(p3, FIN, "cerută de client");
  egal("financiarul anulează proforma altcuiva", nr(pfDe(p3).anulat), 1);
  r = await emite(976001, AGENT);
  egal("după anulare, aceeași comandă primește proformă nouă: cea anulată nu ține locul uneia bune", [/nou=1$/.test(locatie(r)), nr((pfDe(idDinLocatie(r)) || {}).numar)], [true, 506]);
  r = await cer("/proforme", { user: AGENT });
  bine("lista arată starea", />anulată</.test(r.corp) && />emisă</.test(r.corp));

  console.log("\n── Contorul ─────────────────────────────────────────────────");
  const pune = (user, serie, urmator) => cer("/proforme/contor", { metoda: "post", user, body: { serie, urmator } });
  r = await pune(FIN, "PFT", "900");
  egal("doar administratorul îl schimbă", [contor(), /Doar administratorul/.test(decodeURIComponent(locatie(r)))], [["PFT", "507"], true]);
  r = await pune(ADMIN, "PFT", "506");
  egal("nu se poate da înapoi peste numere folosite", [contor(), /cel puțin 507/.test(decodeURIComponent(locatie(r)))], [["PFT", "507"], true]);
  r = await pune(ADMIN, "pf t", "1");
  egal("seria: doar litere, cifre, cratimă", contor(), ["PFT", "507"]);
  r = await pune(ADMIN, "pft", "600");
  egal("administratorul îl mută înainte", [contor(), /Următoarea proformă Cash Machine va fi PFT 600/.test(decodeURIComponent(locatie(r)))], [["PFT", "600"], true]);
  exec("UPDATE comenzi_linii SET cantitate = 12 WHERE comanda_id = 976003");
  r = await emite(976003, ALT);
  egal("următoarea proformă ia numărul pus", nr((pfDe(idDinLocatie(r)) || {}).numar), 600);
  exec("UPDATE setari_app SET valoare = '600' WHERE cheie = 'proforma_urmator'");
  exec("UPDATE comenzi_linii SET cantitate = 13 WHERE comanda_id = 976003");
  const inainte = cate();
  r = await emite(976003, ALT);
  egal("contor dat înapoi de mână, în bază: numărul dublat e refuzat cu mesaj, nu scris a doua oară", [/e deja folosit pe altă proformă/.test(decodeURIComponent(locatie(r))), cate() === inainte, Number(q("SELECT COUNT(*) AS n, 1 AS x FROM proforme WHERE serie = 'PFT' AND numar = 600")[0].n)], [true, true, 1]);

  console.log("\n── Firma care emite ─────────────────────────────────────────");
  // Vali, 19.11.2026: „La avize și proforme, fă să alegi firma după care
  // emiți: Cash Machine sau Warehouse All."
  const waVechi = q("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('proforma_serie_wa','proforma_urmator_wa') ORDER BY cheie");
  const refaWa = () => {
    exec("DELETE FROM setari_app WHERE cheie IN ('proforma_serie_wa','proforma_urmator_wa')");
    for (const x of waVechi) exec(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('${x.cheie}', '${x.valoare}', '2026-11-19')`);
  };
  try {
    exec("DELETE FROM setari_app WHERE cheie IN ('proforma_serie_wa','proforma_urmator_wa')");
    exec("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('proforma_serie_wa','PWT','2026-11-19'), ('proforma_urmator_wa','31','2026-11-19')");
    exec("UPDATE setari_app SET valoare = '700' WHERE cheie = 'proforma_urmator'");
    exec("UPDATE comenzi_linii SET cantitate = 14 WHERE comanda_id = 976003");
    r = await emite(976003, ALT);
    const pc = pfDe(idDinLocatie(r));
    egal("fără firmă aleasă: Cash Machine, pe seria ei", [pc.serie, nr(pc.numar), pc.firma, JSON.parse(pc.furnizor).cif], ["PFT", 700, "cm", "RO27244210"]);
    r = await emite(976003, ALT, { firma: "wa" });
    const pw = pfDe(idDinLocatie(r));
    egal("aceeași comandă, pe Warehouse All: altă proformă, pe seria ei", [pw.serie, nr(pw.numar), pw.firma, JSON.parse(pw.furnizor).nume, JSON.parse(pw.furnizor).iban, /nou=1/.test(locatie(r))], ["PWT", 31, "wa", "WAREHOUSE ALL SRL", "RO34UGBI0000172035560RON", true]);
    egal("…fără să miște contorul Cash Machine", contor(), ["PFT", "701"]);
    r = await emite(976003, ALT, { firma: "wa" });
    egal("a doua oară pe aceeași firmă, comanda neschimbată: aceeași proformă", [idDinLocatie(r), /nou=0/.test(locatie(r))], [Number(pw.id), true]);
    r = await cer("/proforme/:id", { user: ADMIN, params: { id: String(pw.id) } });
    const tw = text(r.corp);
    bine("foaia proformei Warehouse All are datele ei, nu ale Cash Machine",
      tw.includes("WAREHOUSE ALL SRL") && tw.includes("J13/1311/2021") && tw.includes("RO44140650") && tw.includes("RO34UGBI0000172035560RON") && tw.includes("GARANTIBANK") &&
        !tw.includes("CASH MACHINE S.R.L.") && !tw.includes("RO10BRDE450SV99442324500") && !tw.includes("office@cashmachine.ro") && !tw.includes("162 460"),
      (tw.match(/Furnizor[\s\S]{0,400}/) || [""])[0]);
    r = await cer("/proforme/emite", { user: ADMIN });
    bine("la „Emite proformă” se alege firma, cu Cash Machine pusă dinainte", /<select name="firma"[^>]*>\s*<option value="cm" selected>Cash Machine<\/option><option value="wa">Warehouse All<\/option>/.test(r.corp));
    r = await cer("/comenzi/:id", { user: ADMIN, params: { id: "976003" } });
    bine("…și pe pagina comenzii", /action="\/comenzi\/976003\/proforma"[\s\S]{0,400}<select name="firma"/.test(r.corp));
    r = await cer("/proforme", { user: ADMIN });
    bine("lista de proforme are butonul „PDF” pe fiecare rând", r.corp.includes(`href="/proforme/${pw.id}?pdf=1"`));
    bine("lista arată firma și următorul număr al fiecăreia", r.corp.includes("Warehouse All: <strong>PWT 32</strong>") && />Warehouse All</.test(r.corp) && />Cash Machine</.test(r.corp));
    r = await cer("/proforme/contor", { metoda: "post", user: ADMIN, body: { firma: "wa", serie: "PFT", urmator: "9000" } });
    egal("două firme nu pot avea aceeași serie", [/e a firmei Cash Machine/.test(decodeURIComponent(locatie(r))), q("SELECT valoare FROM setari_app WHERE cheie = 'proforma_serie_wa'")[0].valoare], [true, "PWT"]);
    r = await cer("/proforme/contor", { metoda: "post", user: ADMIN, body: { firma: "wa", serie: "PWT", urmator: "90" } });
    egal("contorul Warehouse All se schimbă separat", [q("SELECT valoare FROM setari_app WHERE cheie = 'proforma_urmator_wa'")[0].valoare, contor()], ["90", ["PFT", "701"]]);
  } finally {
    refaWa();
  }

  curata();
  exec(`UPDATE setari_app SET valoare = '${contorVechi[0]}' WHERE cheie = 'proforma_serie'`);
  exec(`UPDATE setari_app SET valoare = '${contorVechi[1]}' WHERE cheie = 'proforma_urmator'`);
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); if (contorVechi.length === 2) { exec(`UPDATE setari_app SET valoare = '${contorVechi[0]}' WHERE cheie = 'proforma_serie'`); exec(`UPDATE setari_app SET valoare = '${contorVechi[1]}' WHERE cheie = 'proforma_urmator'`); } } catch (x) {}
  process.exit(1);
});
