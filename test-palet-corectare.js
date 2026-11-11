"use strict";
// Marfa de pe un palet din CT-Park: denumirea obligatorie la intrare și
// corectarea de după (cantitate, unitate de măsură, alt produs), cu istoric.
//
// CE A CERUT VALI, 11.11.2026, cu poza paletului CT261111-0370 („marfă", 1.515,
// fără nume, fără unitate, pe R6-03-3-2 + R6-03-3-3):
//   „Nu trebuie să bage produs fără denumire pe spațiu. În depozit, dacă se
//    greșește cantitatea să se poată edita ulterior, se păstrează data și cine
//    a modificat."
//   „Administratorii să poată edita și denumire produs, să aleagă practic
//    altul, dar tot așa se salvează cine și ce a modificat."
//
// CE APĂRĂ:
//   • FĂRĂ DENUMIRE NU INTRĂ: Intrare marfă, confirmarea locurilor, scanerul,
//     livrarea directă din recepție și puneMarfa însăși refuză marfa care n-are
//     nici produs din catalog, nici denumire scrisă. În formular, căsuța de
//     denumire e obligatorie cât nu e ales un produs.
//   • CANTITATEA se corectează de oricine face intrări: linia, antetul și „cu
//     cât a intrat paletul" se mută împreună; prețul pe unitate rămâne. Pe
//     palet trebuie să rămână ceva. Rămâne scris ce era, ce e, cine, când și de ce.
//   • UNITATEA DE MĂSURĂ și DENUMIREA: le completează oricine acolo unde
//     lipsesc; odată scrise, le schimbă doar administratorul. Produsul nou se
//     alege din catalog (după cod, denumire exactă sau din lista căutată) ori
//     se scrie liber. Cantitatea și unitatea rămân cum erau; dacă produsul se
//     ține în altă unitate, omul e anunțat.
//   • RECEPȚIA: paletul corectat în sus trage recepția după el (ca la intrare);
//     corectat în jos, rândul recepției are din nou marfă nepusă și omul află.
//   • PALETUL FĂRĂ CANTITATE nu-și pierde denumirea când i se corectează ceva.
//   • PAGINILE: cardul de corectare din fișa paletului (ce vede depozitul, ce
//     vede administratorul, ce nu vede agentul), istoricul, filtrul „fără
//     denumire" din lista de paleți.
//
// Pe PostgreSQL real (port 5433), prin psql; la sfârșit, formularele într-un browser.
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

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
// În ordinea din server.js.
for (const m of ["gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const CT = require(path.join(RAD, "modules", "ct-park.js"));
const SC = require(path.join(RAD, "lib", "ct-scaner.js"));
const REC = require(path.join(RAD, "modules", "receptie.js"));

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
const parametri = (r) => Object.fromEntries(new URL(unde(r), "http://erp.test").searchParams);
const calea = (r) => new URL(unde(r), "http://erp.test").pathname;
const ancora = (r) => new URL(unde(r), "http://erp.test").hash;

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 600) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
function contine(d, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !String(corp).includes(b));
  const gasite = (interzise || []).filter((b) => String(corp).includes(b));
  bine(d, !lipsa.length && !gasite.length, (lipsa.length ? "lipsește: " + lipsa.join(" | ") : "") + (gasite.length ? " n-ar trebui: " + gasite.join(" | ") : ""));
}

// Un `await` care nu se mai întoarce ar lăsa Node să iasă cu 0, fără nicio
// eroare: testul oprit la jumătate iese cu 1.
let ajunsLaCapat = false;
process.on("exit", () => {
  if (ajunsLaCapat) return;
  console.log("\nTESTUL S-A OPRIT ÎNAINTE DE CAPĂT.");
  process.exitCode = 1;
});

// ---- datele de test ------------------------------------------------------
const PREFIX = "TPC";
// PA: folie, la kg, cu categorie de depozit · PB: bandă, la buc · PC: plic, la
// buc · PD: scos din catalog · PE: unit în PA · PF: fără unitate de măsură.
const [PA, PB, PC, PD, PE, PF] = [98401, 98402, 98403, 98404, 98405, 98406];
const PRODUSE = [PA, PB, PC, PD, PE, PF];
const FURNIZOR = 98411;

function curata() {
  const pr = PRODUSE.join(",");
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-R%'`).map((x) => Number(x.id)).join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE produs_id IN (${pr}) OR cod LIKE '${PREFIX}-%' OR produs_text LIKE '${PREFIX} %' OR receptie_id IN (${rec}) OR creat_de LIKE '${PREFIX} %'
                    OR id IN (SELECT palet_id FROM ct_palet_linii WHERE produs_id IN (${pr}) OR produs_text LIKE '${PREFIX} %')`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_tipar WHERE creat_de LIKE '${PREFIX} %'`);
  q(`DELETE FROM ct_palet_corectii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_preturi WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_adaugari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${rec})`);
  q(`DELETE FROM receptii WHERE id IN (${rec})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM parteneri WHERE id = ${FURNIZOR}`);
}
const azi = () => new Date().toISOString().slice(0, 10);
let nrPalet = 0;
// Un palet din depozit, scris direct: antetul și liniile lui. O linie =
// [produs, text scris, cantitate, um, preț]; antetul e rezumatul lor.
function palet(linii, { iesit, intrare, receptieLinie, receptie, categorie } = {}) {
  const cod = `${PREFIX}-PAL-${++nrPalet}`;
  const una = linii.length === 1 ? linii[0] : null;
  const total = linii.reduce((s, l) => s + (Number(l[2]) || 0), 0);
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, cantitate_intrare, um, data_intrare, data_iesire, pret_unitar, categorie, receptie_id, receptie_linie_id, creat_de)
     VALUES ('${cod}', ${una && una[0] ? una[0] : "NULL"}, ${una ? (una[1] ? lit(una[1]) : "NULL") : lit(linii.length + " produse")}, ${total ? total : "NULL"},
             ${intrare === undefined ? (total ? total : "NULL") : intrare === null ? "NULL" : intrare}, ${una && una[3] ? lit(una[3]) : "NULL"}, '2026-11-01', ${iesit ? "'2026-11-05'" : "NULL"},
             ${una && una[4] != null ? una[4] : "NULL"}, ${categorie ? lit(categorie) : "NULL"}, ${receptie || "NULL"}, ${receptieLinie || "NULL"}, '${PREFIX} Intrare') RETURNING id`));
  const idLinii = [];
  for (const l of linii) {
    idLinii.push(Number(unul(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar, pret_sursa)
       VALUES (${id}, ${l[0] || "NULL"}, ${l[1] ? lit(l[1]) : "NULL"}, ${Number(l[2]) || 0}, ${l[3] ? lit(l[3]) : "NULL"}, ${l[4] != null ? l[4] : "NULL"}, ${l[4] != null ? "'scris la intrare'" : "NULL"}) RETURNING id`)));
  }
  return { id, cod, linii: idLinii };
}
const n = (v) => (v == null ? null : Number(v));
const antet = (id) => q(`SELECT produs_id, produs_text, cantitate, um, cantitate_intrare, pret_unitar, categorie FROM ct_paleti WHERE id = ${id}`).map((x) => [n(x.produs_id), x.produs_text, n(x.cantitate), x.um, n(x.cantitate_intrare), n(x.pret_unitar), x.categorie])[0];
const liniile = (id) => q(`SELECT produs_id, produs_text, cantitate, um, pret_unitar FROM ct_palet_linii WHERE palet_id = ${id} ORDER BY id`).map((x) => [n(x.produs_id), x.produs_text, n(x.cantitate), x.um, n(x.pret_unitar)]);
const istoric = (id) => q(`SELECT camp, vechi, nou, cantitate_veche, cantitate_noua, produs_vechi_id, produs_nou_id, motiv, creat_de, creat_la FROM ct_palet_corectii WHERE palet_id = ${id} ORDER BY id`)
  .map((x) => [x.camp, x.vechi, x.nou, n(x.cantitate_veche), n(x.cantitate_noua), n(x.produs_vechi_id), n(x.produs_nou_id), x.motiv, x.creat_de, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(x.creat_la))]);
const cateCorectari = (id) => Number(unul(`SELECT COUNT(*) FROM ct_palet_corectii WHERE palet_id = ${id}`));
const fara = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
// Cardul de corectare din fișa paletului, fără restul paginii.
const card = (html) => { const i = html.indexOf('id="corecteaza"'); if (i < 0) return ""; const j = html.indexOf("</style>", i); return html.slice(html.lastIndexOf("<div", i), j < 0 ? i + 6000 : j); };
const randLista = (html, cod) => { const m = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${cod}</a>[\\s\\S]*?</tr>`).exec(html); return m ? m[0] : ""; };
const coduri = (html) => (fara(html).match(new RegExp(`${PREFIX}-PAL-\\d+`, "g")) || []).filter((v, i, a) => a.indexOf(v) === i);

(async () => {
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: `${PREFIX} Depozit`, rol: "depozit", sectiuni: "" };
  const ADMIN = { id: idUser, nume: `${PREFIX} Admin`, rol: "admin", sectiuni: "" };
  const AGENT = { id: idUser, nume: `${PREFIX} Agent`, rol: "vanzari", sectiuni: "/crm" };
  const AUTH = require(path.join(RAD, "lib", "auth.js"));

  console.log("\n0. Tabelul corectărilor, din lib/db.js");
  {
    const sursa = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
    const m = /CREATE TABLE IF NOT EXISTS ct_palet_corectii \([\s\S]*?\);\s*CREATE INDEX IF NOT EXISTS idx_ct_palet_corectii_palet[^;]*;/.exec(sursa);
    bine("lib/db.js face tabelul ct_palet_corectii și indexul lui", !!m);
    if (m) {
      execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", m[0]], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
      execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", m[0]], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
      egal("se poate rula de două ori (la fiecare pornire) și are coloanele",
        q("SELECT column_name FROM information_schema.columns WHERE table_name = 'ct_palet_corectii' ORDER BY ordinal_position").map((x) => x.column_name),
        ["id", "palet_id", "palet_linie_id", "camp", "vechi", "nou", "cantitate_veche", "cantitate_noua", "produs_vechi_id", "produs_nou_id", "motiv", "creat_de", "creat_la"]);
    }
  }

  // Curățenia vine după tabel: șterge și din el.
  curata();
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie, activ, fuzionat_in, categorie_depozit) VALUES
       (${PA}, '${PREFIX}-A', '${PREFIX} Folie stretch', 'kg', 2.5, 1, NULL, 'materie primă'),
       (${PB}, '${PREFIX}-B', '${PREFIX} Banda adeziva', 'buc', 1, 1, NULL, NULL),
       (${PC}, '${PREFIX}-C', '${PREFIX} Plic', 'buc', 0.4, 1, NULL, NULL),
       (${PD}, '${PREFIX}-D', '${PREFIX} Produs scos din catalog', 'buc', 1, 0, NULL, NULL),
       (${PF}, '${PREFIX}-F', '${PREFIX} Produs fara unitate', NULL, 1, 1, NULL, NULL)`);
  q(`UPDATE produse SET unitate_masura = NULL WHERE id = ${PF}`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, activ, fuzionat_in) VALUES (${PE}, '${PREFIX}-E', '${PREFIX} Produs unit in altul', 'kg', 1, ${PA})`);
  const corecteaza = (user, palet, cerere) => CT.corecteazaMarfa(user, palet.id, cerere);
  const linia = (palet, cant, um) => ({ linii: { [palet.linii[0]]: Object.assign({}, cant === undefined ? {} : { cantitate: cant }, um === undefined ? {} : { um }) } });

  // ------------------------------------------------------------------ cantitatea
  console.log("\n1. Cantitatea scrisă greșit");
  const p1 = palet([[PA, null, 1515, "kg", 2.5]]);
  let r = await corecteaza(DEP, p1, Object.assign(linia(p1, "1151"), { motiv: "  numarat din nou  " }));
  egal("depozitul corectează 1.515 → 1.151", [r.ok, r.schimbari.length, r.eroare], [true, 1, undefined]);
  egal("linia, antetul și „cu cât a intrat” se mută împreună; prețul pe unitate rămâne", [liniile(p1.id), antet(p1.id)],
    [[[PA, null, 1151, "kg", 2.5]], [PA, `${PREFIX} Folie stretch`, 1151, "kg", 1151, 2.5, null]]);
  egal("rămâne scris ce era, ce e, cine, când și de ce", istoric(p1.id),
    [["cantitate", "1.515 kg", "1.151 kg", 1515, 1151, null, null, "numarat din nou", `${PREFIX} Depozit`, true]]);
  egal("ce s-a făcut, în cuvinte", r.facute, ["cantitatea 1.515 kg → 1.151 kg"]);

  r = await corecteaza(DEP, p1, linia(p1, "1151"));
  egal("aceeași cantitate: nu se schimbă nimic și nu rămâne nimic scris", [r.ok, r.schimbari.length, cateCorectari(p1.id)], [true, 0, 1]);
  r = await corecteaza(DEP, p1, linia(p1, "  "));
  egal("căsuța goală nu e zero: nu se schimbă nimic", [r.ok, r.schimbari.length, liniile(p1.id)[0][2]], [true, 0, 1151]);
  r = await corecteaza(DEP, p1, linia(p1, "12,5"));
  egal("virgula e zecimală", [r.ok, liniile(p1.id)[0][2], antet(p1.id)[2], antet(p1.id)[4]], [true, 12.5, 12.5, 12.5]);
  r = await corecteaza(DEP, p1, linia(p1, "7.12349"));
  egal("cantitatea se ține cu trei zecimale", [r.ok, liniile(p1.id)[0][2]], [true, 7.123]);

  for (const [scris, ce] of [["abc", "litere"], ["-5", "minus"], ["12 kg", "cu unitate lipită"], ["1e12", "uriașă"]]) {
    const inainte = JSON.stringify([liniile(p1.id), antet(p1.id), cateCorectari(p1.id)]);
    r = await corecteaza(DEP, p1, linia(p1, scris));
    bine(`„${scris}” (${ce}) e refuzat, cu numele mărfii, și nu schimbă nimic`, !!r.eroare && r.eroare.includes(`${PREFIX} Folie stretch`) && JSON.stringify([liniile(p1.id), antet(p1.id), cateCorectari(p1.id)]) === inainte, r.eroare);
  }
  r = await corecteaza(DEP, p1, linia(p1, "0"));
  contine("zero pe singurul produs: refuzat — paletul gol se scoate, nu se corectează", r.eroare || "", [p1.cod, "trebuie să rămână ceva", "Scoate paletul din depozit"]);
  egal("…și paletul a rămas cum era", liniile(p1.id)[0][2], 7.123);

  const pIesit = palet([[PA, null, 100, "kg", 2.5]], { iesit: true });
  r = await corecteaza(ADMIN, pIesit, linia(pIesit, "90"));
  contine("pe un palet ieșit din depozit nu se mai corectează nimic, nici de administrator", r.eroare || "", [pIesit.cod, "a ieșit din depozit"]);
  egal("…și a rămas cum era", [liniile(pIesit.id)[0][2], cateCorectari(pIesit.id)], [100, 0]);
  r = await CT.corecteazaMarfa(DEP, 987654321, { linii: {} });
  egal("palet care nu există", r.eroare, "Paletul nu există.");

  console.log("\n2. Paletul din care a plecat deja o parte, și cel pe care s-a adăugat");
  // A intrat cu 1.000, au plecat 300: pe el sunt 700. Numărat: 650.
  const p2 = palet([[PA, null, 700, "kg", 2.5]], { intrare: 1000 });
  r = await corecteaza(DEP, p2, linia(p2, "650"));
  egal("„cu cât a intrat” se mută cu aceeași diferență, nu devine cantitatea de acum", [liniile(p2.id)[0][2], antet(p2.id)[4]], [650, 950]);
  // A intrat cu 100, s-au mai adăugat 400: pe el sunt 500. Corectat la 300.
  const p3 = palet([[PA, null, 500, "kg", 2.5]], { intrare: 100 });
  r = await corecteaza(DEP, p3, linia(p3, "300"));
  egal("…și nu coboară sub zero", [liniile(p3.id)[0][2], antet(p3.id)[4]], [300, 0]);
  // Paleții vechi n-au „cu cât a intrat": rămâne necompletat (se ia cantitatea de acum).
  const p4 = palet([[PA, null, 200, "kg", 2.5]], { intrare: null });
  r = await corecteaza(DEP, p4, linia(p4, "180"));
  egal("paletul fără „cu cât a intrat” rămâne fără", [liniile(p4.id)[0][2], antet(p4.id)[2], antet(p4.id)[4]], [180, 180, null]);

  console.log("\n3. Paletul fără cantitate");
  const p5 = palet([[PA, null, 0, "kg", 2.5]]);
  egal("la început: linia pe zero, antetul fără cantitate, dar cu produs", [liniile(p5.id)[0][2], antet(p5.id).slice(0, 3)], [0, [PA, null, null]]);
  r = await corecteaza(DEP, p5, linia(p5, "300"));
  egal("i se poate scrie cantitatea, iar produsul rămâne", [r.ok, liniile(p5.id), antet(p5.id).slice(0, 4)], [true, [[PA, null, 300, "kg", 2.5]], [PA, `${PREFIX} Folie stretch`, 300, "kg"]]);
  egal("în istoric scrie că n-avea cantitate", istoric(p5.id).map((x) => x.slice(0, 5)), [["cantitate", "fără cantitate", "300 kg", 0, 300]]);

  console.log("\n4. Paletul cu mai multe produse");
  const p6 = palet([[PA, null, 100, "kg", 2.5], [PB, null, 40, "buc", 1]]);
  r = await corecteaza(DEP, p6, { linii: { [p6.linii[1]]: { cantitate: "45" } } });
  egal("se corectează doar linia scrisă", [r.ok, liniile(p6.id).map((x) => x[2]), r.facute], [true, [100, 45], [`${PREFIX} Banda adeziva: cantitatea 40 buc → 45 buc`]]);
  r = await corecteaza(DEP, p6, { linii: { [p6.linii[0]]: { cantitate: "0" }, [p6.linii[1]]: { cantitate: "0" } } });
  contine("amândouă pe zero: refuzat", r.eroare || "", ["trebuie să rămână ceva"]);
  egal("…fără să fi scris vreuna", liniile(p6.id).map((x) => x[2]), [100, 45]);
  r = await corecteaza(DEP, p6, { linii: { [p6.linii[0]]: { cantitate: "0" } } });
  egal("o linie greșită poate fi pusă pe zero cât rămâne alta: antetul devine al produsului rămas", [r.ok, liniile(p6.id).map((x) => x[2]), antet(p6.id).slice(0, 4)],
    [true, [0, 45], [PB, `${PREFIX} Banda adeziva`, 45, "buc"]]);
  const p7 = palet([[PA, null, 100, "kg", 2.5]]);
  r = await corecteaza(DEP, p6, { linii: { [p7.linii[0]]: { cantitate: "5" } } });
  egal("linia altui palet, trimisă pe paletul ăsta, nu e atinsă", [r.ok, r.schimbari.length, liniile(p7.id)[0][2]], [true, 0, 100]);

  // ------------------------------------------------------------------ unitatea de măsură
  console.log("\n5. Unitatea de măsură");
  const p8 = palet([[null, `${PREFIX} marfa scrisa de mana`, 1515, null, null]]);
  r = await corecteaza(DEP, p8, linia(p8, undefined, " kg "));
  egal("unde lipsește, o completează și depozitul", [r.ok, liniile(p8.id)[0][3], antet(p8.id)[3], r.facute], [true, "kg", "kg", ["unitatea de măsură nescrisă → kg"]]);
  egal("…și rămâne scris", istoric(p8.id).map((x) => x.slice(0, 3)), [["um", null, "kg"]]);
  r = await corecteaza(DEP, p8, linia(p8, undefined, "buc"));
  contine("odată scrisă, depozitul n-o mai schimbă", r.eroare || "", ["e în kg", "doar administratorul"]);
  egal("…a rămas kg", liniile(p8.id)[0][3], "kg");
  r = await corecteaza(DEP, p8, linia(p8, undefined, "KG"));
  egal("aceeași unitate, scrisă cu litere mari: nimic de schimbat", [r.ok, r.schimbari.length], [true, 0]);
  r = await corecteaza(ADMIN, p8, linia(p8, undefined, "buc"));
  egal("administratorul o schimbă", [r.ok, liniile(p8.id)[0][3], istoric(p8.id).map((x) => x.slice(0, 3))[1]], [true, "buc", ["um", "kg", "buc"]]);
  r = await corecteaza(ADMIN, p8, linia(p8, undefined, "kilograme multe"));
  contine("o unitate prea lungă e refuzată", r.eroare || "", ["prea lungă"]);
  // Linia fără unitate scrisă, dar cu produs din catalog: unitatea e a produsului.
  const p9 = palet([[PA, null, 100, null, 2.5]]);
  r = await corecteaza(DEP, p9, linia(p9, undefined, "buc"));
  contine("unitatea venită din produs e tot „scrisă”: depozitul n-o schimbă", r.eroare || "", ["e în kg", "doar administratorul"]);
  r = await corecteaza(DEP, p9, linia(p9, "90", "kg"));
  egal("cantitatea și unitatea deodată: se scrie doar ce s-a schimbat", [r.ok, r.facute], [true, ["cantitatea 100 kg → 90 kg"]]);
  r = await corecteaza(DEP, p8, linia(p8, "1151", "role"));
  contine("o cantitate bună, lângă o unitate pe care n-are voie s-o schimbe: nu se scrie nimic", r.eroare || "", ["doar administratorul"]);
  egal("…nici cantitatea", liniile(p8.id)[0][2], 1515);

  // ------------------------------------------------------------------ marfa
  console.log("\n6. Marfa fără denumire: o completează oricine face intrări");
  const pFara = () => palet([[null, null, 1515, null, null]]);
  const p10 = pFara();
  egal("paletul din poză: 1.515, fără nume, fără unitate", [liniile(p10.id), antet(p10.id).slice(0, 4)], [[[null, null, 1515, null, null]], [null, null, 1515, null]]);
  r = await corecteaza(DEP, p10, { produs: { produs_id: String(PA) } });
  egal("depozitul alege produsul din catalog", [r.ok, r.eroare], [true, undefined]);
  egal("linia ia produsul și, neavând unitate, unitatea lui; cantitatea rămâne", [liniile(p10.id), antet(p10.id).slice(0, 4)],
    [[[PA, null, 1515, "kg", null]], [PA, `${PREFIX} Folie stretch`, 1515, "kg"]]);
  egal("paletul fără categorie o ia pe a produsului", antet(p10.id)[6], "materie primă");
  egal("rămâne scris: n-avea denumire, ce are acum (cu codul), cine", istoric(p10.id).map((x) => [x[0], x[1], x[2], x[5], x[6], x[8]]),
    [["marfa", null, `${PREFIX} Folie stretch (${PREFIX}-A)`, null, PA, `${PREFIX} Depozit`]]);
  egal("ce s-a făcut, în cuvinte", r.facute, [`marfa fără denumire → „${PREFIX} Folie stretch (${PREFIX}-A)”`]);
  egal("fără nepotrivire de unitate, niciun avertisment", r.avertismente, []);

  const p11 = pFara();
  r = await corecteaza(DEP, p11, { produs: { text: `  ${PREFIX.toLowerCase()}-b ` } });
  egal("scris codul produsului (cu litere mici): îl găsește în catalog", [r.ok, liniile(p11.id)[0].slice(0, 4)], [true, [PB, null, 1515, "buc"]]);
  const p12 = pFara();
  r = await corecteaza(DEP, p12, { produs: { text: `${PREFIX} PLIC` } });
  egal("scrisă denumirea exactă: tot produsul din catalog", [r.ok, liniile(p12.id)[0].slice(0, 2)], [true, [PC, null]]);
  const p13 = pFara();
  r = await corecteaza(DEP, p13, { produs: { text: `${PREFIX} folie de la un client` }, linii: { [p13.linii[0]]: { um: "kg" } } });
  egal("altceva: rămâne denumire scrisă liber, cu unitatea scrisă alături", [r.ok, liniile(p13.id)[0].slice(0, 4), antet(p13.id).slice(0, 4)],
    [true, [null, `${PREFIX} folie de la un client`, 1515, "kg"], [null, `${PREFIX} folie de la un client`, 1515, "kg"]]);
  egal("două rânduri în istoric: unitatea și marfa", istoric(p13.id).map((x) => x.slice(0, 3)), [["um", null, "kg"], ["marfa", null, `${PREFIX} folie de la un client`]]);
  const p14 = pFara();
  r = await corecteaza(DEP, p14, { produs: { produs_id: String(PD) } });
  contine("produsul scos din catalog nu se poate alege", r.eroare || "", ["nu mai e în catalog"]);
  r = await corecteaza(DEP, p14, { produs: { produs_id: String(PE) } });
  contine("nici cel unit în alt produs", r.eroare || "", ["nu mai e în catalog"]);
  egal("…paletul a rămas fără denumire", liniile(p14.id)[0].slice(0, 2), [null, null]);
  r = await corecteaza(DEP, p14, { produs: { produs_id: String(PF) } });
  egal("produs fără unitate în catalog: paletul rămâne fără unitate", [r.ok, liniile(p14.id)[0].slice(0, 4)], [true, [PF, null, 1515, null]]);

  console.log("\n7. Marfa cu denumire: o schimbă doar administratorul");
  const p15 = palet([[PA, null, 400, "kg", 2.5]]);
  r = await corecteaza(DEP, p15, { produs: { produs_id: String(PB) } });
  contine("depozitul nu schimbă produsul de pe palet", r.eroare || "", [`${PREFIX} Folie stretch`, "doar administratorul", "Unde denumirea lipsește"]);
  egal("…a rămas cum era, nimic scris", [liniile(p15.id), cateCorectari(p15.id)], [[[PA, null, 400, "kg", 2.5]], 0]);
  r = await corecteaza(DEP, p15, { produs: { produs_id: String(PA) } });
  egal("același produs ales din nou: nimic de schimbat (și nu e refuz)", [r.ok, r.schimbari.length], [true, 0]);
  r = await corecteaza(ADMIN, p15, { produs: { produs_id: String(PB) }, motiv: "era banda, nu folie" });
  egal("administratorul alege alt produs", [r.ok, r.eroare], [true, undefined]);
  egal("cantitatea, unitatea și prețul rămân cum erau scrise", [liniile(p15.id), antet(p15.id).slice(0, 6)],
    [[[PB, null, 400, "kg", 2.5]], [PB, `${PREFIX} Banda adeziva`, 400, "kg", 400, 2.5]]);
  egal("e anunțat că produsul nou se ține în altă unitate", r.avertismente, [`Pe palet cantitatea e în kg, iar „${PREFIX} Banda adeziva” se ține în buc — verifică unitatea și cantitatea.`]);
  egal("rămâne scris din ce în ce, cu produsele, cine și de ce", istoric(p15.id).map((x) => [x[0], x[1], x[2], x[5], x[6], x[7], x[8]]),
    [["marfa", `${PREFIX} Folie stretch (${PREFIX}-A)`, `${PREFIX} Banda adeziva (${PREFIX}-B)`, PA, PB, "era banda, nu folie", `${PREFIX} Admin`]]);
  r = await corecteaza(ADMIN, p15, { produs: { produs_id: String(PC) }, linii: { [p15.linii[0]]: { cantitate: "380", um: "buc" } } });
  egal("totul deodată: cantitate, unitate și produs", [r.ok, liniile(p15.id), r.avertismente], [true, [[PC, null, 380, "buc", 2.5]], []]);
  egal("…trei rânduri noi în istoric, în ordinea asta", istoric(p15.id).slice(1).map((x) => x.slice(0, 3)),
    [["cantitate", "400 buc", "380 buc"], ["um", "kg", "buc"], ["marfa", `${PREFIX} Banda adeziva (${PREFIX}-B)`, `${PREFIX} Plic (${PREFIX}-C)`]]);
  // Linia cu unitatea venită din produs: la schimbarea produsului rămâne cea în care s-a numărat.
  const p16 = palet([[PA, null, 100, null, 2.5]]);
  r = await corecteaza(ADMIN, p16, { produs: { produs_id: String(PB) } });
  egal("unitatea venită din produsul vechi (kg) rămâne pe palet, nu devine pe tăcute a celui nou", [liniile(p16.id)[0].slice(0, 4), r.avertismente.length], [[PB, null, 100, "kg"], 1]);

  const p17 = palet([[null, `${PREFIX} folie veche`, 100, "kg", 2.5]]);
  r = await corecteaza(DEP, p17, { produs: { text: `${PREFIX} folie noua` } });
  contine("nici denumirea scrisă liber n-o schimbă depozitul", r.eroare || "", ["doar administratorul"]);
  r = await corecteaza(ADMIN, p17, { produs: { text: `${PREFIX} FOLIE VECHE` } });
  egal("aceeași denumire, cu alte litere: nimic de schimbat", [r.ok, r.schimbari.length], [true, 0]);
  r = await corecteaza(ADMIN, p17, { produs: { text: `${PREFIX} folie noua` } });
  egal("administratorul schimbă denumirea scrisă", [r.ok, liniile(p17.id)[0].slice(0, 2), antet(p17.id).slice(0, 2)], [true, [null, `${PREFIX} folie noua`], [null, `${PREFIX} folie noua`]]);
  r = await corecteaza(ADMIN, p17, { produs: { text: `${PREFIX}-A` } });
  egal("…sau o leagă de produsul din catalog, după cod: denumirea scrisă dispare", [r.ok, liniile(p17.id)[0].slice(0, 2), antet(p17.id).slice(0, 2)], [true, [PA, null], [PA, `${PREFIX} Folie stretch`]]);

  console.log("\n8. Marfa pe paletul cu mai multe produse și pe cel fără cantitate");
  const p18 = palet([[PA, null, 100, "kg", 2.5], [null, null, 40, "buc", 1]]);
  r = await corecteaza(DEP, p18, { produs: { produs_id: String(PB) } });
  contine("fără să spui la care produs: refuzat", r.eroare || "", ["mai multe produse", "alege la care"]);
  r = await corecteaza(DEP, p18, { produs: { linie: String(p18.linii[0]), produs_id: String(PB) } });
  contine("depozitul, pe linia care are denumire: refuzat", r.eroare || "", ["doar administratorul"]);
  r = await corecteaza(DEP, p18, { produs: { linie: String(p18.linii[1]), produs_id: String(PB) } });
  egal("depozitul, pe linia fără denumire: merge, și doar pe ea", [r.ok, liniile(p18.id).map((x) => x.slice(0, 2))], [true, [[PA, null], [PB, null]]]);
  bine("antetul paletului spune amândouă produsele", /2 produse: .*Folie stretch.*Banda adeziva/.test(String(antet(p18.id)[1])), antet(p18.id)[1]);
  r = await corecteaza(DEP, p18, { produs: { linie: "987654321", produs_id: String(PB) } });
  contine("o linie care nu e pe palet: refuzat", r.eroare || "", ["alege la care"]);

  const p19 = palet([[null, null, 0, null, null]]);
  r = await corecteaza(DEP, p19, { produs: { produs_id: String(PA) } });
  egal("palet fără cantitate și fără denumire: primește denumirea, pe linie și pe antet", [r.ok, liniile(p19.id)[0].slice(0, 4), antet(p19.id).slice(0, 4)],
    [true, [PA, null, 0, "kg"], [PA, `${PREFIX} Folie stretch`, null, "kg"]]);
  r = await corecteaza(ADMIN, p19, { produs: { produs_id: String(PB) } });
  egal("…și nu și-o pierde la următoarea corectare (rezumatul l-ar fi golit)", [r.ok, antet(p19.id).slice(0, 2)], [true, [PB, `${PREFIX} Banda adeziva`]]);

  // ------------------------------------------------------------------ recepția
  console.log("\n9. Paletul venit dintr-o recepție");
  const RID = Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare, finalizata_la) VALUES ('${PREFIX}-R1', 'furnizor', ${FURNIZOR}, '${azi()}', 'finalizata', '${azi()} 10:00:00') RETURNING id`));
  const linieRec = (produs, text, cant, um) => Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, produs_text, cantitate_asteptata, cantitate_primita, um, pret_unitar, stare, conditie)
       VALUES (${RID}, ${produs || "NULL"}, ${text ? lit(text) : "NULL"}, ${cant}, ${cant}, '${um}', 2.5, 'primita', 'bun') RETURNING id`));
  const L1 = linieRec(PA, null, 1000, "kg");
  const primit = (l) => Number(unul(`SELECT cantitate_primita FROM receptii_linii WHERE id = ${l}`));
  const p20 = palet([[PA, null, 600, "kg", 2.5]], { receptie: RID, receptieLinie: L1 });
  const p21 = palet([[PA, null, 400, "kg", 2.5]], { receptie: RID, receptieLinie: L1 });
  r = await corecteaza(DEP, p21, linia(p21, "500"));
  egal("în sus, peste ce scria recepția: recepția ia cantitatea de pe paleți", [r.ok, primit(L1), antet(p21.id)[4]], [true, 1100, 500]);
  egal("…și omul e anunțat", r.avertismente, ["Recepția a luat și ea cantitatea de pe paleți: 1.000 → 1.100 kg."]);
  r = await corecteaza(DEP, p21, linia(p21, "300"));
  egal("în jos: recepția rămâne cum e, iar pe rândul ei apare din nou marfă nepusă", [r.ok, primit(L1), antet(p21.id)[4]], [true, 1100, 300]);
  egal("…și omul e anunțat cât și ce are de făcut", r.avertismente,
    [`În recepția ${PREFIX}-R1 au rămas 200 kg nepuse pe raft și apar din nou la Intrare marfă. Dacă marfa aceea nu există, scoate rândul din listă acolo.`]);
  q(`UPDATE receptii_linii SET ct_inchis_la = '2026-11-11 10:00:00' WHERE id = ${L1}`);
  r = await corecteaza(DEP, p21, linia(p21, "250"));
  egal("rândul scos deja din listă nu mai dă avertisment", [r.ok, r.avertismente], [true, []]);
  q(`UPDATE receptii_linii SET ct_inchis_la = NULL WHERE id = ${L1}`);
  r = await corecteaza(DEP, p20, linia(p20, "650"));
  egal("în sus, dar tot sub ce scria recepția: recepția nu se schimbă și nu e niciun avertisment", [r.ok, primit(L1), r.avertismente], [true, 1100, []]);
  r = await corecteaza(ADMIN, p20, { produs: { produs_id: String(PB) } });
  egal("schimbarea produsului nu umblă la recepție", [r.ok, primit(L1)], [true, 1100]);

  // ------------------------------------------------------------------ ruta
  console.log("\n10. Ruta: cine are voie și ce i se spune");
  const p22 = palet([[PA, null, 1515, "kg", 2.5]]);
  const post = (user, p, body) => cer("post", `/stocuri/ct-park/palet/${p.id}/corecteaza`, user, { body });
  bine("agentul de vânzări nu are Intrare marfă (de-aia e bun de probă)", !AUTH.poateAccesa(AGENT, "/stocuri/ct-park/intrare") && AUTH.poateAccesa(DEP, "/stocuri/ct-park/intrare"));
  r = await post(AGENT, p22, { ["cant_" + p22.linii[0]]: "1151" });
  egal("cine nu face intrări nu corectează", [r.cod, calea(r), parametri(r).eroare, liniile(p22.id)[0][2], cateCorectari(p22.id)],
    [302, `/stocuri/ct-park/palet/${p22.id}`, "Marfa de pe palet o corectează cine face intrările în depozit.", 1515, 0]);
  r = await post(DEP, p22, { ["cant_" + p22.linii[0]]: "1151", motiv: "numarat" });
  egal("depozitul: se întoarce la fișa paletului, la cardul de corectare", [r.cod, calea(r), ancora(r)], [302, `/stocuri/ct-park/palet/${p22.id}`, "#corecteaza"]);
  egal("…cu ce s-a corectat și cu îndemnul de a retipări eticheta", parametri(r).ok, `Corectat pe ${p22.cod}: cantitatea 1.515 kg → 1.151 kg. Tipărește din nou eticheta paletului.`);
  egal("…și chiar s-a scris", [liniile(p22.id)[0][2], istoric(p22.id).map((x) => [x[0], x[7], x[8]])], [1151, [["cantitate", "numarat", `${PREFIX} Depozit`]]]);
  r = await post(DEP, p22, {});
  egal("nimic scris în formular: i se spune, nu se preface că a salvat", [parametri(r).ok, parametri(r).eroare], [undefined, "N-ai schimbat nimic. Scrie cantitatea corectă, unitatea de măsură sau alege altă marfă."]);
  r = await post(DEP, p22, { ["cant_" + p22.linii[0]]: "abc" });
  bine("o greșeală se întoarce ca eroare, tot la card", !!parametri(r).eroare && parametri(r).eroare.includes("scrie cantitatea ca număr") && ancora(r) === "#corecteaza", unde(r));
  r = await post(DEP, p22, { produs_linie: String(p22.linii[0]), produs_nou: String(PB) });
  bine("depozitul nu schimbă produsul nici prin rută", /doar administratorul/.test(parametri(r).eroare || "") && liniile(p22.id)[0][0] === PA, unde(r));
  r = await post(ADMIN, p22, { produs_linie: String(p22.linii[0]), produs_nou: String(PB), ["um_" + p22.linii[0]]: "buc" });
  egal("administratorul: produs și unitate, din formular", [liniile(p22.id)[0].slice(0, 4), parametri(r).ok],
    [[PB, null, 1151, "buc"], `Corectat pe ${p22.cod}: unitatea de măsură kg → buc; marfa „${PREFIX} Folie stretch (${PREFIX}-A)” → „${PREFIX} Banda adeziva (${PREFIX}-B)”. Tipărește din nou eticheta paletului.`]);
  r = await post(ADMIN, p22, { produs_linie: String(p22.linii[0]), produs_text_nou: `${PREFIX}-A` });
  contine("avertismentul de unitate ajunge și el în mesaj", parametri(r).ok || "", ["Pe palet cantitatea e în buc", "se ține în kg", "Tipărește din nou eticheta"]);

  // ------------------------------------------------------------------ fișa paletului
  console.log("\n11. Fișa paletului");
  const pagina = async (user, p, query) => (await cer("get", `/stocuri/ct-park/palet/${p.id}`, user, { query })).corp;
  let pg = await pagina(DEP, p1);
  let c = card(pg);
  contine("depozitul, pe un palet cu denumire și unitate: doar cantitatea", c,
    ["Corectează marfa de pe palet", `action="/stocuri/ct-park/palet/${p1.id}/corecteaza"`, `name="cant_${p1.linii[0]}"`, `${PREFIX} Folie stretch`, "7,123 kg", 'name="motiv"', "Salvează corectarea"],
    [`name="um_${p1.linii[0]}"`, 'name="produs_text_nou"', 'name="produs_linie"', 'name="produs_q"', "Altă marfă", "Ce marfă e pe palet"]);
  contine("istoricul corectărilor: ce, cine, când, de ce", fara(pg), ["Corectări făcute pe palet", `${PREFIX} Depozit`, "cantitatea 1.515 kg →", "1.151 kg", "numarat din nou"]);
  bine("…cu data și ora scrise românește", /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · TPC Depozit/.test(fara(pg).replace(/\s+/g, " ")), (/.{30}TPC Depozit/.exec(fara(pg).replace(/\s+/g, " ")) || [""])[0]);
  bine("lângă cantitate e legătura spre corectare", /<div class="k">Cantitate<\/div>[^<]*<a class="mic" href="#corecteaza">corectează<\/a>/.test(pg));
  c = card(await pagina(ADMIN, p1));
  contine("administratorul vede și unitatea, și marfa", c,
    [`name="cant_${p1.linii[0]}"`, `name="um_${p1.linii[0]}"`, 'name="produs_text_nou"', `name="produs_linie" value="${p1.linii[0]}"`, 'name="produs_q"', "Altă marfă, dacă denumirea e greșită"], ["Ce marfă e pe palet"]);
  const p23 = pFara();
  pg = await pagina(DEP, p23);
  c = card(pg);
  contine("depozitul, pe paletul fără denumire: poate scrie marfa și unitatea", c,
    ['<span class="badge galben">fără denumire</span>', "Ce marfă e pe palet", 'name="produs_text_nou"', `name="produs_linie" value="${p23.linii[0]}"`, `name="um_${p23.linii[0]}"`, 'name="produs_q"'], ["Altă marfă, dacă denumirea e greșită"]);
  bine("în fișă, la „Marfă”, scrie „fără denumire”, cu legătura spre corectare", /<div class="k">Marfă<\/div><span class="badge galben">fără denumire<\/span> <a class="mic" href="#corecteaza">scrie-o<\/a>/.test(pg));
  c = card(await pagina(DEP, p23, { produs_q: `${PREFIX} ` }));
  contine("căutarea în catalog aduce produsele de ales, fără cel scos și fără cel unit", c,
    [`name="produs_nou" value="${PA}"`, `name="produs_nou" value="${PB}"`, `name="produs_nou" value="${PC}"`, `${PREFIX} Folie stretch`, `${PREFIX}-A · kg`, `name="produs_q" form="cauta-produs-palet" value="${PREFIX}"`, "…sau scrisă de mână"],
    [`name="produs_nou" value="${PD}"`, `name="produs_nou" value="${PE}"`]);
  c = card(await pagina(DEP, p23, { produs_q: "zzz nu exista asa ceva" }));
  contine("căutarea fără rezultat o spune", c, ["Niciun produs care să semene cu „zzz nu exista asa ceva”"], ['name="produs_nou"']);
  c = card(await pagina(DEP, p18));
  contine("palet cu mai multe produse: depozitul vede amândouă cantitățile, dar nu poate schimba marfa (amândouă au denumire)", c,
    [`name="cant_${p18.linii[0]}"`, `name="cant_${p18.linii[1]}"`], ['name="produs_linie"', 'name="produs_text_nou"']);
  c = card(await pagina(ADMIN, p18));
  contine("…iar administratorul alege la care dintre ele", c, ['<select name="produs_linie">', `<option value="${p18.linii[0]}">${PREFIX} Folie stretch · 100 kg</option>`, `<option value="${p18.linii[1]}">${PREFIX} Banda adeziva · 40 buc</option>`]);
  const p24 = palet([[PA, null, 100, "kg", 2.5], [null, null, 5, null, null]]);
  c = card(await pagina(DEP, p24));
  contine("mai multe produse, unul fără denumire: depozitul îl poate completa doar pe acela", c,
    [`name="produs_linie" value="${p24.linii[1]}"`, 'name="produs_text_nou"', `name="um_${p24.linii[1]}"`], [`name="um_${p24.linii[0]}"`, "<select"]);
  egal("pe paletul ieșit nu e niciun card", card(await pagina(ADMIN, pIesit)), "");
  bine("…și nicio legătură spre corectare", !(await pagina(ADMIN, pIesit)).includes('href="#corecteaza"'));
  egal("cine nu face intrări nu vede cardul", card(await pagina(AGENT, p1)), "");
  c = card(await pagina(DEP, p5));
  contine("paletul fără cantitate la intrare are și el cardul", card(await pagina(DEP, palet([[PA, null, 0, "kg", 2.5]]))), ["fără cantitate", "Cantitate corectă"]);
  pg = await pagina(ADMIN, p22, { ok: "Corectat pe X: cantitatea 1 → 2." });
  contine("mesajul de după corectare se vede sus", pg, ['<div class="flash">Corectat pe X: cantitatea 1 → 2.</div>']);

  // ------------------------------------------------------------------ lista de paleți
  console.log("\n12. Lista de paleți: cei fără denumire");
  const lista = async (user, query) => (await cer("get", "/stocuri/ct-park/paleti", user, { query })).corp;
  const fNume = [p14.cod, p23.cod, p24.cod];
  // p14 are acum produsul fără unitate — nu mai e fără denumire.
  fNume.shift();
  const pGol = palet([[null, null, 0, null, null]]);
  const pIesitFara = palet([[null, null, 10, null, null]], { iesit: true });
  pg = await lista(DEP, { fara_nume: "1", q: `${PREFIX}-PAL` });
  egal("filtrul arată exact paleții din depozit fără denumire: cel simplu, cel cu o linie fără nume, cel fără cantitate", coduri(pg).sort(), [p23.cod, p24.cod, pGol.cod].sort());
  bine("…nu și pe cel ieșit", !coduri(pg).includes(pIesitFara.cod));
  bine("…nici dacă se cere „și paleții scoși”: filtrul e pentru ce e de completat pe raft", !coduri(await lista(DEP, { fara_nume: "1", toate: "1", q: `${PREFIX}-PAL` })).includes(pIesitFara.cod));
  contine("spune ce sunt și ce e de făcut", fara(pg), ["Paleții din depozit fără denumirea mărfii.", "Corectează marfa de pe palet", "Arată toți paleții"]);
  contine("rândul: „fără denumire”, cu legătura spre fișă", randLista(pg, p23.cod), ['<span class="badge galben">fără denumire</span>', `href="/stocuri/ct-park/palet/${p23.id}#corecteaza">scrie-o</a>`]);
  pg = await lista(DEP, { q: `${PREFIX}-PAL` });
  contine("în lista obișnuită, cardul spune câți sunt și duce la ei", fara(pg), ["3 paleți n-au denumirea mărfii", 'href="/stocuri/ct-park/paleti?fara_nume=1" id="arata-fara-nume">arată-i</a>']);
  contine("fiecare palet din depozit are „corectează”", randLista(pg, p1.cod), [`href="/stocuri/ct-park/palet/${p1.id}#corecteaza">corectează</a>`]);
  pg = await lista(DEP, { q: `${PREFIX}-PAL`, toate: "1" });
  contine("cel ieșit n-are", randLista(pg, pIesit.cod), ["scoasă"], ["corectează", "fără denumire"]);
  pg = await lista(AGENT, { q: `${PREFIX}-PAL` });
  contine("cine nu face intrări vede „fără denumire”, dar fără legături de corectare", randLista(pg, p23.cod), ["fără denumire"], ["scrie-o", "corectează"]);
  // După completare iese din filtru.
  await corecteaza(DEP, p23, { produs: { produs_id: String(PA) } });
  pg = await lista(DEP, { fara_nume: "1", q: `${PREFIX}-PAL` });
  bine("paletul completat iese din filtru", !coduri(pg).includes(p23.cod), coduri(pg).join(","));

  // ------------------------------------------------------------------ intrarea
  console.log("\n13. Fără denumire nu intră");
  const libere = q(`SELECT l.id, l.rand_id, l.adresa FROM ct_locuri l JOIN ct_randuri rr ON rr.id = l.rand_id AND rr.activ = 1
                     WHERE COALESCE(l.blocat, 0) = 0 AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
                     ORDER BY l.id LIMIT 8`);
  if (libere.length < 8) throw new Error("depozitul de test nu are 8 locuri libere");
  let iLoc = 0;
  const intrare = (campuri) => {
    const l = libere[iLoc++];
    return cer("post", "/stocuri/ct-park/intrare", DEP, { body: Object.assign({ "loc_ids[]": String(l.id), "loc_rand[]": String(l.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "1515" }, campuri) });
  };
  const paletiDep = () => Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE creat_de = '${PREFIX} Depozit'`));
  r = await intrare({ pret_unitar: "2,5" });
  egal("Intrare marfă fără produs și fără denumire, chiar cu preț: oprită", [r.cod, paletiDep()], [422, 0]);
  contine("…cu ce are omul de făcut și cu drumul înapoi la formular", r.corp, ["Marfa n-a intrat în depozit.", "alege produsul din catalog sau scrie denumirea", "history.back()"]);
  r = await intrare({ pret_unitar: "2,5", produs_text: "   " });
  egal("denumirea doar din spații nu e denumire", [r.cod, paletiDep()], [422, 0]);
  r = await intrare({ pret_unitar: "2,5", produs_id: "987654321" });
  egal("un produs care nu există nu e denumire", [r.cod, paletiDep()], [422, 0]);
  r = await intrare({ pret_unitar: "2,5", produs_text: `${PREFIX} marfa scrisa`, um: "kg" });
  egal("cu denumire scrisă: intră", [r.cod, paletiDep()], [302, 1]);
  r = await intrare({ produs_id: String(PA) });
  egal("cu produs din catalog: intră", [r.cod, paletiDep()], [302, 2]);
  const lc = libere[iLoc++];
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { grup_0: String(lc.id), cant_0: "10", um: "buc", pret_unitar: "1,5" } });
  egal("confirmarea locurilor propuse, fără denumire: oprită", [r.cod, paletiDep()], [422, 2]);
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { grup_0: String(lc.id), cant_0: "10", um: "buc", pret_unitar: "1,5", produs_text: `${PREFIX} marfa confirmata` } });
  egal("…cu denumire: intră", [r.cod, paletiDep()], [302, 3]);
  let aruncat = "";
  try { await CT.puneMarfa({ user: DEP }, { um: "kg", pret_unitar: "2" }, [[libere[iLoc].id]], 5); } catch (e) { aruncat = e.message; }
  egal("orice altă cale ajunge la puneMarfa, care refuză și ea", [aruncat, paletiDep()], [CT.MESAJ_FARA_NUME, 3]);
  egal("regula, pe scurt", [{}, { produs_id: "" }, { produs_text: "  " }, { produs_id: "0" }, { produs_id: "7" }, { produs_text: " x " }, null].map((b) => CT.areNume(b)), [false, false, false, false, true, true, false]);
  // Un rând de recepție fără produs și fără denumire.
  const L2 = linieRec(null, null, 50, "buc");
  let x = await SC.faPaleti(DEP, "r" + L2, [50], []);
  egal("scanerul nu face palet dintr-un rând fără denumire", [x.ok, x.faraNume, /n-are denumirea mărfii/.test(x.eroare || ""), Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE receptie_linie_id = ${L2}`))], [undefined, true, true, 0]);
  x = await REC.livrareDirecta(DEP, RID, L2, "fulfillment", "", 50);
  egal("nici livrarea directă din recepție", [/n-are denumirea mărfii/.test(x.eroare || ""), Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE receptie_linie_id = ${L2}`))], [true, 0]);
  const L3 = linieRec(null, `${PREFIX} marfa din receptie`, 50, "buc");
  x = await SC.faPaleti(DEP, "r" + L3, [50], []);
  egal("…dar din rândul cu denumire scrisă, da", [x.ok, Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE receptie_linie_id = ${L3}`))], [true, 1]);

  // ------------------------------------------------------------------ browserul
  console.log("\n14. În browser: formularul de intrare și cardul de corectare");
  {
    const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try {
      // a) Intrare marfă: fără denumire, formularul nu pleacă.
      const corpIntrare = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { q: `${PREFIX} ` } })).corp;
      let pag = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
      const erori = [];
      let trimise = [];
      pag.on("pageerror", (e) => erori.push(String(e.message || e)));
      await pag.route("http://erp.test/**", async (rt) => {
        const u = new URL(rt.request().url());
        if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
        if (rt.request().method() === "POST") { trimise.push(rt.request().postData() || ""); return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>trimis</body></html>" }); }
        return rt.fulfill({ status: 200, contentType: "text/html", body: corpIntrare });
      });
      await pag.goto("http://erp.test/stocuri/ct-park/intrare");
      const stare = () => pag.evaluate(() => { const e = document.getElementById("marfa-text"); return [e.required, e.validationMessage, e.checkValidity()]; });
      egal("la deschidere, denumirea e cerută, cu mesajul nostru", await stare(), [true, "Alege produsul din catalog sau scrie aici denumirea mărfii.", false]);
      await pag.fill("#pret-intrare", "2,5");
      await pag.fill('input[name="loc_cantitate[]"]', "1515");
      await pag.click('button[type="submit"]:has-text("Adaugă marfă")');
      await pag.waitForTimeout(300);
      egal("cu preț și cantitate, dar fără denumire: formularul nu pleacă", trimise.length, 0);
      await pag.fill("#marfa-text", "   ");
      egal("spațiile nu sunt denumire", (await stare())[2], false);
      await pag.fill("#marfa-text", "folie de proba");
      egal("scrisă denumirea: căsuța e în regulă", (await stare()).slice(1), ["", true]);
      await pag.fill("#marfa-text", "");
      await pag.check(`input[name="produs_id"][value="${PA}"]`);
      egal("ales un produs din catalog: denumirea scrisă nu mai e cerută", await stare(), [false, "", true]);
      await pag.fill("#pret-intrare", "2,5");
      await pag.click('button[type="submit"]:has-text("Adaugă marfă")');
      await pag.waitForTimeout(400);
      bine("…și formularul pleacă, cu produsul", trimise.length === 1 && new RegExp("produs_id=" + PA).test(trimise[0]), trimise[0]);
      await pag.close();

      // b) Fișa paletului fără denumire, văzută de depozit: caută, alege, salvează.
      const pBrowser = pFara();
      trimise = [];
      const cereri = [];
      pag = await browser.newPage({ viewport: { width: 1300, height: 1100 } });
      pag.on("pageerror", (e) => erori.push(String(e.message || e)));
      await pag.route("http://erp.test/**", async (rt) => {
        const u = new URL(rt.request().url());
        if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
        if (rt.request().method() === "POST") { trimise.push([u.pathname, rt.request().postData() || ""]); return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>trimis</body></html>" }); }
        cereri.push(u.pathname + u.search);
        const corp = (await cer("get", `/stocuri/ct-park/palet/${pBrowser.id}`, DEP, { query: Object.fromEntries(u.searchParams) })).corp;
        return rt.fulfill({ status: 200, contentType: "text/html", body: corp });
      });
      await pag.goto(`http://erp.test/stocuri/ct-park/palet/${pBrowser.id}`);
      await pag.fill('#corecteaza input[name="produs_q"]', `${PREFIX} fol`);
      await pag.click('#corecteaza button:has-text("Caută în catalog")');
      await pag.waitForLoadState("load");
      egal("căutarea rămâne pe fișa paletului, la cardul de corectare", [cereri[cereri.length - 1], new URL(pag.url()).hash],
        [`/stocuri/ct-park/palet/${pBrowser.id}?produs_q=${PREFIX}+fol`, "#corecteaza"]);
      egal("…și aduce produsul căutat, de bifat", await pag.locator('#corecteaza input[name="produs_nou"]').count(), 1);
      await pag.check(`#corecteaza input[name="produs_nou"][value="${PA}"]`);
      await pag.fill(`#corecteaza input[name="cant_${pBrowser.linii[0]}"]`, "1151");
      await pag.fill('#corecteaza input[name="motiv"]', "numarat din nou");
      await pag.click('#corecteaza button:has-text("Salvează corectarea")');
      await pag.waitForTimeout(400);
      const trimis = trimise[0] ? Object.fromEntries(new URLSearchParams(trimise[0][1])) : {};
      egal("formularul pleacă la ruta de corectare, cu tot ce s-a scris", [trimise.length, trimise[0] && trimise[0][0], trimis["cant_" + pBrowser.linii[0]], trimis.produs_nou, trimis.produs_linie, trimis.motiv],
        [1, `/stocuri/ct-park/palet/${pBrowser.id}/corecteaza`, "1151", String(PA), String(pBrowser.linii[0]), "numarat din nou"]);
      bine("căsuța de căutare nu pleacă odată cu corectarea (e alt formular)", !("produs_q" in trimis), JSON.stringify(trimis));
      if (process.env.SALVEAZA_PAGINI) {
        await pag.goto(`http://erp.test/stocuri/ct-park/palet/${pBrowser.id}?produs_q=${PREFIX}`);
        await pag.screenshot({ path: path.join(process.env.SALVEAZA_PAGINI, "palet-fara-denumire.png"), fullPage: true });
      }
      egal("nicio eroare de JavaScript", erori, []);
    } finally {
      await browser.close();
    }
  }

  curata();
  ajunsLaCapat = true;
  console.log(esecuri ? `\n${esecuri} eșecuri` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  ajunsLaCapat = true;
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
