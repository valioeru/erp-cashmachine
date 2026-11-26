"use strict";
// Unificarea clienților: propuneri, validare de mână, mutare, desfacere.
//
// CEREREA LUI VALI, 26.11.2026: „Fă te rog și pagina de unificare […] care să
// fie validată manual, cu sugestie, ca la produse. Vreau unificare pe clienți."
//
// CE APĂRĂ:
//   • propunerile: același CUI, același nume fără forma juridică, același
//     email/telefon, nume aproape la fel; NU propune firme cu CUI diferit doar
//     pe nume asemănătoare; perechea respinsă nu mai apare;
//   • nimic nu se unifică fără confirmarea omului (pagina doar arată);
//   • la unificare, TOT ce ține de partenerul scos trece pe cel păstrat, cel
//     păstrat primește doar ce-i lipsea, iar ce avea scris nu se calcă;
//   • motorul știe toate coloanele de partener din schemă (altfel refuză);
//   • desfacerea pune totul la loc, cu aceleași id-uri;
//   • legătura veche spre fișa partenerului scos duce la cel păstrat.
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
for (const m of ["parteneri", "unificare-clienti"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98511, nume: "Vali Test", rol: "admin", email: "v.uc@test.ro" };
const AGENT = { id: 98512, nume: "Gabriela Test", rol: "vanzari", email: "g.uc@test.ro" };

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

const UC = require(path.join(RAD, "lib", "unificare-clienti.js"));
const PF = require(path.join(RAD, "lib", "parteneri-fuziune.js"));
const CALE = "/configurari/unificare-clienti";
// A = scris de agent, fără CUI (dispare); B = din SmartBill, cu CUI (rămâne);
// C, D = două firme cu același nume și CUI diferit; E = fără nicio legătură.
const A = 98601, B = 98602, C = 98603, D = 98604, E = 98605, F = 98606;
const TOTI = `${A}, ${B}, ${C}, ${D}, ${E}, ${F}`;
function curata() {
  for (const s of [
    `DELETE FROM parteneri_fuziuni WHERE pastrat_id IN (${TOTI}) OR inghitit_id IN (${TOTI})`,
    `DELETE FROM parteneri_unificare_respinse WHERE a_id IN (${TOTI}) OR b_id IN (${TOTI})`,
    `DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id IN (${TOTI}))`,
    `DELETE FROM facturi WHERE partener_id IN (${TOTI})`,
    `DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (${TOTI}))`,
    `DELETE FROM comenzi WHERE partener_id IN (${TOTI})`,
    `DELETE FROM comenzi_furnizor WHERE furnizor_id IN (${TOTI})`,
    `DELETE FROM mk_contacte WHERE partener_id IN (${TOTI})`,
    `DELETE FROM interactiuni WHERE partener_id IN (${TOTI})`,
    `DELETE FROM alocari_clienti WHERE partener_id IN (${TOTI})`,
    `DELETE FROM factoring_clienti WHERE partener_id IN (${TOTI})`,
    `DELETE FROM alias_parteneri WHERE partener_id IN (${TOTI})`,
    `DELETE FROM parteneri_adrese_livrare WHERE partener_id IN (${TOTI})`,
    `UPDATE produse SET furnizor_id = NULL WHERE furnizor_id IN (${TOTI})`,
    "DELETE FROM produse WHERE id = 98621",
    `DELETE FROM parteneri WHERE id IN (${TOTI})`,
    "DELETE FROM utilizatori WHERE id BETWEEN 98511 AND 98519",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const partener = (id) => q("SELECT * FROM parteneri WHERE id = ?", [id])[0] || null;
const cate = (tabel, col, id) => Number(q(`SELECT COUNT(*) AS n, 1 AS x FROM ${tabel} WHERE ${col} = ?`, [id])[0].n);
const txt = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
const param = (r, n) => decodeURIComponent((String(locatie(r)).match(new RegExp("[?&]" + n + "=([^&#]*)")) || [])[1] || "");

(async () => {
  console.log("── Propunerile, fără bază ───────────────────────────────────");
  egal("CUI-ul se compară pe cifre; numele, fără forma juridică și fără diacritice", [UC.cuiCurat("RO 123456"), UC.cuiCurat("ro0123456"), UC.cuiCurat("12"), UC.cheieNume("S.C. Elhor Trade S.R.L."), UC.cheieNume("ELHOR  TRADE srl-d"), UC.cheieNume("Țiriac Auto SA"), UC.cheieNume("SRL")], ["123456", "123456", "", "elhor trade", "elhor trade", "tiriac auto", "srl"]);
  const L = [
    { id: 1, nume: "SC Elhor Trade SRL", cui: "RO 123456" }, { id: 2, nume: "Elhor Trade", cui: "" }, { id: 3, nume: "ELHOR TRADE S.R.L.", cui: "123456" },
    { id: 4, nume: "Alfa Impex SRL", cui: "111111" }, { id: 5, nume: "Alfa Impex SA", cui: "222222" },
    { id: 6, nume: "Dedeman Bacău", email: "Achizitii@dedeman.ro" }, { id: 7, nume: "Dedeman", email: "achizitii@dedeman.ro" },
    { id: 8, nume: "Rompack Solutions" }, { id: 9, nume: "Rompak Solutions" },
    { id: 10, nume: "Beta Construct SRL", cui: "333333" }, { id: 11, nume: "Beta Construct Nord SRL", cui: "444444" },
    { id: 12, nume: "Gama Trans", telefon: "+40 722 111 222" }, { id: 13, nume: "Transport Ionescu", telefon: "0722.111.222" },
    { id: 14, nume: "Singur Pe Lume SRL", cui: "555555" },
  ];
  const pr = UC.propuneri(L);
  const ca = (r) => `${r.a.id}-${r.b.id}`;
  egal("perechile propuse, cele mai sigure întâi, cu motivul lor", pr.map((r) => [ca(r), r.scor, r.motive[0]]), [["1-3", 100, "același CUI (123456)"], ["2-3", 90, "același nume"], ["1-2", 90, "același nume"], ["6-7", 70, "același email (achizitii@dedeman.ro)"], ["12-13", 65, "același telefon"], ["8-9", 55, "nume scrise aproape la fel"], ["4-5", 40, "același nume"]]);
  egal("același nume cu CUI diferit: se arată, dar cu avertisment; nume doar asemănătoare cu CUI diferit: nu se propun", [pr.find((r) => ca(r) === "4-5").atentie.length, pr.some((r) => ca(r) === "10-11"), pr.some((r) => r.a.id === 14 || r.b.id === 14)], [1, false, false]);
  egal("perechea respinsă de om nu mai apare", UC.propuneri(L, { respinse: new Set(["1:2", "8:9"]) }).map(ca).filter((k) => k === "1-2" || k === "8-9"), []);
  egal("un partener apărut din nou după ce a fost unificat se propune spre cel în care a intrat", UC.propuneri([{ id: 20, nume: "Omega Pack SRL", cui: "777777" }, { id: 21, nume: "Omega Ambalaje" }], { fuziuni: [{ pastrat_id: 20, inghitit_nume: "OMEGA AMBALAJE S.R.L.", inghitit_cui: "", facut_la: "2026-11-26 10:00:00" }] }).map((r) => [ca(r), r.scor, /a mai fost unificat în acesta pe 2026-11-26/.test(r.motive[0])]), [["20-21", 95, true]]);
  egal("pe care îl păstrăm: cel cu CUI; la egalitate cel cu mai multe documente; apoi cel mai vechi", [UC.alegePastrat(L[1], L[0], new Map([[2, 50]])).id, UC.alegePastrat(L[7], L[8], new Map([[9, 3]])).id, UC.alegePastrat(L[8], L[7], new Map()).id], [1, 9, 8]);
  egal("păstratul primește doar ce-i lipsește; client + furnizor = ambele; leadul devine client", UC.completari({ tip: "client", cui: "", email: "are@el.ro", telefon: null, stare: "lead", agent_id: 5 }, { tip: "furnizor", cui: "RO9", email: "alt@el.ro", telefon: "0722", stare: "client_activ", agent_id: 7 }), { cui: "RO9", telefon: "0722", tip: "ambele", stare: "client_activ" });

  console.log("\n── Motorul știe toate legăturile spre parteneri ─────────────");
  egal("în schema de test nu e nicio coloană de partener neștiută de motor", await PF.nestiute(), []);
  const inCod = new Set();
  for (const dosar of ["lib", "modules"]) for (const f of fs.readdirSync(path.join(RAD, dosar)).filter((x) => x.endsWith(".js"))) {
    const s = fs.readFileSync(path.join(RAD, dosar, f), "utf8");
    for (const m of s.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) for (const c of m[2].matchAll(/^\s*(\w*(?:partener|furnizor)\w*id)\s+INTEGER/gm)) inCod.add(`${m[1]}.${c[1]}`);
    for (const m of s.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w*(?:partener|furnizor)\w*id)\s+INTEGER/g)) inCod.add(`${m[1]}.${m[2]}`);
  }
  const stiute = new Set(PF.TABELE.map((t) => `${t.tabel}.${t.coloana}`));
  egal("…și nici în tabelele scrise în cod (un tabel nou cu partener_id trebuie pus în lib/parteneri-fuziune.js)", [...inCod].filter((k) => !stiute.has(k) && !PF.ALTCEVA.has(k)).sort(), []);

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98511,'Vali Test','v.uc@test.ro','x','y','admin'), (98512,'Gabriela Test','g.uc@test.ro','x','y','vanzari')",
    `INSERT INTO parteneri (id, nume, cui, tip, adresa, localitate, email, telefon, persoana_contact, agent_id, stare, adresa_livrare, termen_plata_zile) VALUES (${A}, 'Uctest Ambalaje', NULL, 'furnizor', 'Str. Veche 1, Ploiești', NULL, 'office@uctest.ro', '0722 000 111', 'Ion Vechi', 98512, 'client_activ', 'Depozit Ploiești Sud', 30)`,
    `INSERT INTO parteneri (id, nume, cui, tip, adresa, localitate, email, telefon, stare) VALUES (${B}, 'SC UCTEST AMBALAJE SRL', 'RO98602', 'client', 'Bd. Nou 9', 'București', 'contact@uctest.ro', NULL, 'lead')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${C}, 'Uctest Gemeni SRL', 'RO986031', 'client'), (${D}, 'Uctest Gemeni SA', 'RO986042', 'client'), (${E}, 'Uctest Altceva Total', 'RO986053', 'client'), (${F}, 'Uctest Fara Nimic', NULL, 'client')`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (98621,'UC-1','Produs UC','buc',10,21)",
    `INSERT INTO comenzi (id, partener_id, numar, status, data) VALUES (986101, ${A}, 'UC-A1', 'noua', '2026-11-20'), (986102, ${A}, 'UC-A2', 'noua', '2026-11-21'), (986103, ${B}, 'UC-B1', 'noua', '2026-11-22'), (986104, ${E}, 'UC-E1', 'noua', '2026-11-22')`,
    `INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, status) VALUES (986201, 'UCT', 986201, ${A}, 'vanzare', '2026-11-20', 'emisa'), (986202, 'UCT', 986202, ${B}, 'vanzare', '2026-11-21', 'emisa')`,
    `INSERT INTO mk_contacte (partener_id, nume, email) VALUES (${A}, 'Ana Uctest', 'ana@uctest.ro')`,
    `INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (${A}, 98512, 100)`,
    `INSERT INTO parteneri_adrese_livrare (partener_id, denumire, adresa) VALUES (${A}, 'Magazin', 'Str. Magazinului 3, Brașov')`,
    `UPDATE produse SET furnizor_id = ${A} WHERE id = 98621`,
  ]) exec(s);
  // Setarea care ține id-ul clientului Sameday: se salvează și se pune pe A.
  const samedayInainte = (q("SELECT valoare FROM setari_app WHERE cheie = 'sameday_partener_id'")[0] || {}).valoare;
  exec(`INSERT INTO setari_app (cheie, valoare) VALUES ('sameday_partener_id', '${A}') ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare`);
  const sameday = () => (q("SELECT valoare FROM setari_app WHERE cheie = 'sameday_partener_id'")[0] || {}).valoare;
  db.prepare("x"); // (stubul de bază e pus)

  console.log("\n── Pagina cu propuneri ──────────────────────────────────────");
  let r = await cer(CALE, { query: { q: "uctest" } });
  const rand = (h, a, b) => (String(h).split(`data-pereche="${a}:${b}"`)[1] || "").split("</tr>")[0];
  bine("perechea A–B apare cu motivul „același nume”, cu documentele fiecăruia și cu cele două butoane", r.cod === 200 && txt(rand(r.corp, A, B)).includes("același nume") && txt(rand(r.corp, A, B)).includes("2 comenzi · 1 factură") && txt(rand(r.corp, A, B)).includes("fără CUI") && rand(r.corp, A, B).includes(`${CALE}/unifica?pastrat=${B}&inghitit=${A}`) && rand(r.corp, A, B).includes("Nu e același client"), txt(rand(r.corp, A, B)).slice(0, 300));
  bine("propunerea păstrează partenerul cu CUI, chiar dacă celălalt are mai multe documente", rand(r.corp, A, B).includes(`pastrat=${B}&inghitit=${A}`));
  bine("C–D (același nume, CUI diferit) apare cu avertisment; E și F nu apar în nicio pereche", txt(rand(r.corp, C, D)).includes("CUI diferit: 986031 și 986042") && !String(r.corp).includes(`:${E}"`) && !String(r.corp).includes(`data-pereche="${E}:`) && !String(r.corp).includes(`:${F}"`));
  egal("deschiderea paginii nu unifică și nu scrie nimic", [Boolean(partener(A)), cate("parteneri_fuziuni", "pastrat_id", B), cate("comenzi", "partener_id", A)], [true, 0, 2]);

  console.log("\n── „Nu e același client” ────────────────────────────────────");
  r = await cer(`${CALE}/respinge`, { metoda: "post", body: { a_id: String(D), b_id: String(C) } });
  const dupa = await cer(CALE, { query: { q: "uctest" } });
  egal("perechea respinsă se ține minte (cu id-ul mic întâi) și nu mai apare; cealaltă rămâne", [q(`SELECT a_id, b_id FROM parteneri_unificare_respinse WHERE a_id = ${C}`).map((x) => [Number(x.a_id), Number(x.b_id)]), String(dupa.corp).includes(`data-pereche="${C}:${D}"`), String(dupa.corp).includes(`data-pereche="${A}:${B}"`)], [[[C, D]], false, true]);
  r = await cer(`${CALE}/respinge`, { metoda: "post", body: { a_id: String(C), b_id: String(D) } });
  egal("respinsă a doua oară: nu se dublează și nu pică", cate("parteneri_unificare_respinse", "a_id", C), 1);

  console.log("\n── Verificarea dinaintea unificării ─────────────────────────");
  r = await cer(`${CALE}/unifica`, { query: { pastrat: String(B), inghitit: String(A) } });
  const t = txt(r.corp);
  bine("arată ce trece pe cel păstrat, tabel cu tabel, și totalul", r.cod === 200 && /comenzi 2/.test(t) && /facturi 1/.test(t) && /persoane de contact 1/.test(t) && /adrese de livrare 1/.test(t) && /alocări pe agenți 1/.test(t) && /produse cu furnizorul lui 1/.test(t) && /în total 7/.test(t), t.slice(t.indexOf("Ce trece"), t.indexOf("Ce trece") + 500));
  bine("arată ce primește păstratul (doar ce-i lipsea), aliasul și adresele aduse", /primește ce-i lipsea: telefon 0722 000 111 ?, persoana de contact Ion Vechi ?, termenul de plată 30 ?, agentul Gabriela Test ?, tipul client și furnizor ?, starea client activ/.test(t) && !/primește ce-i lipsea:[^.]*CUI/.test(t) && !/primește ce-i lipsea:[^.]*email/.test(t) && t.includes("Numele „Uctest Ambalaje” rămâne ținut minte") && t.includes("Depozit Ploiești Sud") && t.includes("Str. Veche 1, Ploiești"), t.slice(t.indexOf("primește"), t.indexOf("primește") + 500));
  bine("se poate alege invers, iar verificarea singură nu schimbă nimic", String(r.corp).includes(`${CALE}/unifica?pastrat=${A}&inghitit=${B}`) && Boolean(partener(A)) && cate("comenzi", "partener_id", A) === 2);
  r = await cer(`${CALE}/unifica`, { query: { pastrat: String(C), inghitit: String(D) } });
  bine("la CUI-uri diferite, verificarea avertizează că sunt două firme în acte", txt(r.corp).includes("au CUI-uri diferite (986042 și 986031)"));
  r = await cer(`${CALE}/unifica`, { query: { pastrat: String(B), inghitit: String(B) } });
  const r0 = await cer(`${CALE}/unifica`, { query: { pastrat: "#" + B + " SC UCTEST", inghitit: "999999999" } });
  egal("același partener de două ori sau unul care nu există: întoarce la listă cu mesaj", [/doi parteneri diferiți/.test(param(r, "eroare")), /nu mai există/.test(param(r0, "eroare"))], [true, true]);

  console.log("\n── Unificarea ───────────────────────────────────────────────");
  const randA = partener(A);
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { pastrat_id: String(B), inghitit_id: String(A) } });
  egal("partenerul unificat nu mai e în listă, iar mesajul spune câte rânduri s-au mutat", [partener(A), /„Uctest Ambalaje” a intrat în „SC UCTEST AMBALAJE SRL”: 7 rânduri mutate/.test(param(r, "ok"))], [null, true]);
  egal("tot ce era al lui e acum pe cel păstrat: comenzi, facturi, contacte, adrese, alocare, furnizor de produs", [cate("comenzi", "partener_id", B), cate("comenzi", "partener_id", A), cate("facturi", "partener_id", B), cate("mk_contacte", "partener_id", B), cate("alocari_clienti", "partener_id", B), Number(q("SELECT furnizor_id FROM produse WHERE id = 98621")[0].furnizor_id)], [3, 0, 2, 1, 1, B]);
  const pb = partener(B);
  egal("păstratul a primit ce-i lipsea și și-a păstrat ce avea (CUI, email, adresă, nume)", [pb.nume, pb.cui, pb.email, pb.adresa, pb.telefon, pb.persoana_contact, Number(pb.termen_plata_zile), Number(pb.agent_id), pb.tip, pb.stare], ["SC UCTEST AMBALAJE SRL", "RO98602", "contact@uctest.ro", "Bd. Nou 9", "0722 000 111", "Ion Vechi", 30, 98512, "ambele", "client_activ"]);
  egal("adresele celui unificat au intrat printre adresele de livrare ale păstratului, fără dubluri", q(`SELECT adresa FROM parteneri_adrese_livrare WHERE partener_id = ${B} AND activ = 1 ORDER BY adresa`).map((x) => x.adresa), ["Depozit Ploiești Sud", "Str. Magazinului 3, Brașov", "Str. Veche 1, Ploiești"]);
  egal("numele vechi a rămas ca alias al păstratului", q(`SELECT alias, sursa FROM alias_parteneri WHERE partener_id = ${B}`).map((x) => [x.alias, x.sursa]), [["Uctest Ambalaje", "unificare clienți"]]);
  const urma = q(`SELECT * FROM parteneri_fuziuni WHERE pastrat_id = ${B}`)[0];
  egal("urma ține rândul întreg al partenerului scos și id-urile mutate", [Number(urma.inghitit_id), urma.inghitit_nume, JSON.parse(urma.inghitit_rand).email, JSON.parse(urma.mutari)["comenzi.partener_id"].sort(), JSON.parse(urma.mutari)["facturi.partener_id"], Number(urma.facut_de)], [A, "Uctest Ambalaje", "office@uctest.ro", [986101, 986102], [986201], 98511]);
  egal("setarea care ținea id-ul lui (clientul Sameday) arată acum spre cel păstrat", sameday(), String(B));
  egal("partenerii fără legătură cu perechea au rămas neatinși", [cate("comenzi", "partener_id", E), partener(E).nume, Boolean(partener(C)), Boolean(partener(D))], [1, "Uctest Altceva Total", true, true]);
  r = await cer("/parteneri/:id", { params: { id: String(A) } });
  egal("legătura veche spre fișa celui unificat duce la cel păstrat", [r.cod, locatie(r)], [302, `/parteneri/${B}`]);
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { pastrat_id: String(B), inghitit_id: String(A) } });
  egal("apăsat a doua oară: mesaj că nu mai există, fără a doua urmă", [/nu mai există/.test(param(r, "eroare")), cate("parteneri_fuziuni", "pastrat_id", B)], [true, 1]);
  r = await cer(CALE, { query: { parte: "facute" } });
  bine("unificarea apare la „Unificări făcute”, cu „Desfă”", txt((String(r.corp).split("data-unificari-facute")[1] || "")).includes("Uctest Ambalaje") && String(r.corp).includes(`name="fuziune_id" value="${urma.id}"`));

  console.log("\n── Revenit după unificare ───────────────────────────────────");
  exec(`INSERT INTO parteneri (id, nume, tip) VALUES (${A + 100000}, 'UCTEST AMBALAJE S.R.L.', 'client')`);
  r = await cer(CALE, { query: { q: "uctest ambalaje" } });
  bine("un import a scris din nou numele vechi: e propus spre cel păstrat, cu motivul", /a mai fost unificat în acesta/.test(txt(rand(r.corp, B, A + 100000))), txt(rand(r.corp, B, A + 100000)).slice(0, 300));
  exec(`DELETE FROM parteneri WHERE id = ${A + 100000}`);

  console.log("\n── Alocare și factoring la amândoi ──────────────────────────");
  for (const s of [
    `INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (${C}, 98511, 100), (${D}, 98512, 100)`,
    `INSERT INTO factoring_clienti (partener_id, procent_finantare, activ) VALUES (${C}, 80, 1), (${D}, 90, 1)`,
  ]) exec(s);
  await PF.fuzioneaza(C, D, 98511);
  egal("rămâne alocarea păstratului; a celui unificat se scoate și se ține în urmă", [q(`SELECT utilizator_id FROM alocari_clienti WHERE partener_id = ${C}`).map((x) => Number(x.utilizator_id)), cate("alocari_clienti", "partener_id", D), JSON.parse(q(`SELECT sterse FROM parteneri_fuziuni WHERE inghitit_id = ${D}`)[0].sterse).map((x) => x.utilizator_id)], [[98511], 0, [98512]]);
  egal("factoring activ rămâne doar al păstratului; al celuilalt trece la el, oprit", q(`SELECT procent_finantare, activ FROM factoring_clienti WHERE partener_id = ${C} ORDER BY id`).map((x) => [Number(x.procent_finantare), Number(x.activ)]), [[80, 1], [90, 0]]);

  console.log("\n── Desfacerea ───────────────────────────────────────────────");
  exec(`INSERT INTO comenzi (id, partener_id, numar, status, data) VALUES (986105, ${B}, 'UC-B2-dupa', 'noua', '2026-11-26')`);
  r = await cer(`${CALE}/desfa`, { metoda: "post", body: { fuziune_id: String(urma.id) } });
  const inapoi = partener(A);
  egal("partenerul revine cu același id și cu rândul lui întreg", [/desfăcută/.test(param(r, "ok")), inapoi && Object.keys(randA).every((k) => String(inapoi[k]) === String(randA[k]))], [true, true]);
  egal("rândurile mutate se întorc la el; ce s-a făcut după unificare rămâne la cel păstrat", [q(`SELECT id FROM comenzi WHERE partener_id = ${A} ORDER BY id`).map((x) => Number(x.id)), q(`SELECT id FROM comenzi WHERE partener_id = ${B} ORDER BY id`).map((x) => Number(x.id)), cate("facturi", "partener_id", A), cate("mk_contacte", "partener_id", A), cate("alocari_clienti", "partener_id", A), Number(q("SELECT furnizor_id FROM produse WHERE id = 98621")[0].furnizor_id)], [[986101, 986102], [986103, 986105], 1, 1, 1, A]);
  const pb2 = partener(B);
  egal("păstratul își recapătă câmpurile de dinainte; aliasul și adresele aduse dispar", [pb2.telefon, pb2.persoana_contact, pb2.termen_plata_zile, pb2.agent_id, pb2.tip, pb2.stare, pb2.cui, cate("alias_parteneri", "partener_id", B), q(`SELECT adresa FROM parteneri_adrese_livrare WHERE partener_id = ${B}`).length, q(`SELECT adresa FROM parteneri_adrese_livrare WHERE partener_id = ${A}`).map((x) => x.adresa)], [null, null, null, null, "client", "lead", "RO98602", 0, 0, ["Str. Magazinului 3, Brașov"]]);
  egal("…și setarea clientului Sameday se întoarce la el", sameday(), String(A));
  r = await cer(`${CALE}/desfa`, { metoda: "post", body: { fuziune_id: String(urma.id) } });
  egal("desfăcută a doua oară: refuzată cu mesaj", /deja desfăcută/.test(param(r, "eroare")), true);
  r = await cer("/parteneri/:id", { params: { id: String(A) } });
  egal("fișa partenerului revenit se deschide din nou", r.cod, 200);
  await PF.desfa(q(`SELECT id FROM parteneri_fuziuni WHERE inghitit_id = ${D}`)[0].id, 98511);
  egal("desfacerea pune la loc și alocarea scoasă, și factoringul oprit", [q(`SELECT utilizator_id FROM alocari_clienti WHERE partener_id = ${D}`).map((x) => Number(x.utilizator_id)), q(`SELECT partener_id, activ FROM factoring_clienti WHERE partener_id IN (${C}, ${D}) ORDER BY partener_id`).map((x) => [Number(x.partener_id), Number(x.activ)])], [[98512], [[C, 1], [D, 1]]]);

  console.log("\n── Totul sau nimic ──────────────────────────────────────────");
  exec("ALTER TABLE comenzi ADD COLUMN IF NOT EXISTS uc_test_partener_id INTEGER");
  let prins = "";
  try { await PF.fuzioneaza(B, A, 98511); } catch (e) { prins = e.message; }
  exec("ALTER TABLE comenzi DROP COLUMN IF EXISTS uc_test_partener_id");
  egal("o coloană de partener pe care motorul n-o știe oprește unificarea înainte să mute ceva", [/comenzi\.uc_test_partener_id/.test(prins), Boolean(partener(A)), cate("comenzi", "partener_id", A)], [true, true, 2]);
  exec(`CREATE OR REPLACE FUNCTION uc_test_pica() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'uc test: pica'; END $$ LANGUAGE plpgsql`);
  exec(`CREATE TRIGGER uc_test_pica BEFORE UPDATE ON mk_contacte FOR EACH ROW WHEN (NEW.partener_id = ${B}) EXECUTE FUNCTION uc_test_pica()`);
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { pastrat_id: String(B), inghitit_id: String(A) } });
  exec("DROP TRIGGER uc_test_pica ON mk_contacte; DROP FUNCTION uc_test_pica()");
  egal("dacă o mutare pică la mijloc, nu rămâne nimic făcut pe jumătate: comenzile, facturile și partenerul sunt unde erau", [/n-a mers și nu s-a schimbat nimic/.test(param(r, "eroare")), Boolean(partener(A)), cate("comenzi", "partener_id", A), cate("facturi", "partener_id", A), q(`SELECT id FROM parteneri_fuziuni WHERE inghitit_id = ${A} AND desfacut_la IS NULL`).length, partener(B).telefon], [true, true, 2, 1, 0, null]);

  console.log("\n── Cine vede pagina ─────────────────────────────────────────");
  bine("pagina e în Configurări, legată din celelalte pagini de acolo", ["configurari.js", "cod-produs.js", "unificare-coduri.js"].every((f) => fs.readFileSync(path.join(RAD, "modules", f), "utf8").includes('"/configurari/unificare-clienti", "Unificare clienți"')) && fs.readFileSync(path.join(RAD, "server.js"), "utf8").includes('require("./modules/unificare-clienti").register(router)'));
  const auth = require(path.join(RAD, "lib", "auth.js"));
  if (typeof auth.poateAccesa === "function") egal("agentul de vânzări n-are acces la ea; adminul are", [Boolean(auth.poateAccesa(AGENT, CALE)), Boolean(auth.poateAccesa(ADMIN, CALE))], [false, true]);

  if (samedayInainte == null) exec("DELETE FROM setari_app WHERE cheie = 'sameday_partener_id'");
  else exec(`UPDATE setari_app SET valoare = '${String(samedayInainte).replace(/'/g, "''")}' WHERE cheie = 'sameday_partener_id'`);
  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { execFileSync("psql", ["-X", "-q", "-c", "ALTER TABLE comenzi DROP COLUMN IF EXISTS uc_test_partener_id; DROP TRIGGER IF EXISTS uc_test_pica ON mk_contacte"], { env: ENV, stdio: "ignore" }); curata(); } catch (x) {} process.exit(1); });
