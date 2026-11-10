"use strict";
// Cele două categorii din „Stoc la zi": ordinea coloanelor, schimbarea lor de
// către administrator și categoria simplă ținută pe produs.
//
// CE A CERUT VALI, 10.11.2026:
//   „În Stoc la zi, categoria nomenclator mut-o ca a doua coloană și pune la
//    toate categorii, clasate după cele care au — te pricepi tu să le
//    încadrezi; la fel completează și încadrează și la categoria simplă."
//
// DE CE E NEVOIE DE MAI MULT DECÂT O MUTARE DE COLOANĂ: categoria simplă
// (produse finite, produse intermediare, consumabile, materie primă) stătea
// doar pe palet, aleasă opțional la intrare; 133 din cele 148 de produse din
// stoc n-aveau niciuna. Acum stă și pe produs, paletul nou o moștenește, iar
// pagina o arată și când paleții n-au una.
//
// CE APĂRĂ:
//   • COLOANELE: Produs, Categorie nomenclator, Categorie, apoi restul.
//   • CATEGORIA DIN NOMENCLATOR se scrie pe produs, curățată; goală = fără.
//   • CATEGORIA SIMPLĂ se scrie pe produs și pe paleții lui din stoc: pe cei
//     fără categorie mereu; pe cei cu alta doar dacă pe palet e numai produsul
//     ăsta; niciodată pe paleții ieșiți. Cu „doar goi", cei care au alta rămân.
//   • SALVAREA DOAR A NOMENCLATORULUI nu rescrie paleții.
//   • FIECARE SCHIMBARE lasă un rând în jurnal, cu ce era înainte.
//   • DOAR ADMINISTRATORUL schimbă; ceilalți nici nu văd formularul.
//   • PALETUL NOU moștenește categoria simplă a produsului, dacă omul n-a ales.
//   • PAGINA arată categoria produsului când paleții n-au una; a paleților, când au.
//
// Pe PostgreSQL real (port 5433), prin psql.
const path = require("path");
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
for (const m of ["stoc-la-zi", "gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const GP = require(path.join(RAD, "lib", "gata-productie.js"));
const STADIU = require(path.join(RAD, "lib", "stadiu-comanda.js"));

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query, antete } = {}) {
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
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase(), headers: antete || {} } });
  return r;
}
const unde = (r) => String((r.antet && r.antet.Location) || "");
const parametri = (r) => Object.fromEntries(new URL(unde(r), "http://erp.test").searchParams);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- datele de test ------------------------------------------------------
const A = 96201, B = 96202, C = 96203, D = 96204, E = 96205, F = 96206;
const PREFIX = "TSK";
const PRODUSE = [A, B, C, D, E, F];
const SC = require(path.join(RAD, "lib", "stoc-categorii.js"));
const SP = require(path.join(RAD, "lib", "stoc-produse.js"));
const CT = require(path.join(RAD, "modules", "ct-park.js"));

function curata() {
  const pr = PRODUSE.join(",");
  const pal = q(`SELECT id FROM ct_paleti WHERE cod LIKE '${PREFIX}-PAL-%' OR produs_id IN (${pr})`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p}) OR produs_id IN (${pr})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM produse_categorii_jurnal WHERE produs_id IN (${pr})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM rezervari_agenti WHERE produs_id IN (${pr})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
let nrPalet = 0;
// Paletul unui produs, cu linia lui. `linii` = alte produse puse pe același palet (mixt).
function palet(produs, cant, um, categorie, { iesit, linii } = {}) {
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, categorie, data_intrare, data_iesire)
     VALUES ('${PREFIX}-PAL-${++nrPalet}', ${produs}, ${cant}, '${um}', ${categorie ? "'" + categorie + "'" : "NULL"}, '${azi()}', ${iesit ? "'" + azi() + "'" : "NULL"}) RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (${id}, ${produs}, ${cant}, '${um}')`);
  for (const [p2, c2] of linii || []) q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (${id}, ${p2}, ${c2}, '${um}')`);
  return id;
}
const catPalet = (id) => unul(`SELECT categorie FROM ct_paleti WHERE id = ${id}`);
const produs = (id) => q(`SELECT categorie, categorie_depozit FROM produse WHERE id = ${id}`)[0] || {};
const jurnal = (id) => q(`SELECT camp, vechi, nou, paleti, de FROM produse_categorii_jurnal WHERE produs_id = ${id} ORDER BY id`).map((x) => [x.camp, x.vechi, x.nou, Number(x.paleti), x.de]);
const randPagina = (html, nume) => { const i = html.indexOf(`<strong>${nume}</strong>`); if (i < 0) return ""; const a = html.lastIndexOf("<tr", i); return html.slice(a, html.indexOf("</tr>", i)); };
const celuleRand = (tr) => tr.split(/<td[^>]*>/).slice(1).map((c) => c.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const ADMIN = { id: idUser, nume: "Vali Test", rol: "admin", sectiuni: "" };
  const DEP = { id: idUser, nume: "Om Depozit", rol: "depozit", sectiuni: "" };
  const AGENT = { id: idUser, nume: "Agent", rol: "vanzari", sectiuni: "/crm" };

  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, categorie, activ) VALUES
       (${A}, 'TSK-A', '${PREFIX} Carton A', 'buc', NULL, 1),
       (${B}, 'TSK-B', '${PREFIX} Folie B', 'kg', '${PREFIX} Folie stretch', 1),
       (${C}, 'TSK-C', '${PREFIX} Banda C', 'buc', 'diverse', 1),
       (${D}, 'TSK-D', '${PREFIX} Granule D', 'kg', '${PREFIX} Granule', 1),
       (${E}, 'TSK-E', '${PREFIX} Nou E', 'buc', NULL, 1),
       (${F}, 'TSK-F', '${PREFIX} Jumbo F', 'kg', NULL, 1)`);
  const PA1 = palet(A, 100, "buc", null);
  const PA2 = palet(A, 50, "buc", null);
  const PA_IESIT = palet(A, 30, "buc", null, { iesit: true });
  const PB1 = palet(B, 300, "kg", "materie primă");
  const PB2 = palet(B, 100, "kg", "produse finite");
  const PB3 = palet(B, 50, "kg", null);
  const PC1 = palet(C, 20, "buc", null);
  // Palet mixt, cu categoria lui: banda C și cartonul A pe același palet.
  const PM = palet(C, 10, "buc", "consumabile", { linii: [[A, 5]] });
  const PD1 = palet(D, 500, "kg", null);

  // ------------------------------------------------------------------------
  console.log("1. Categoria din nomenclator");
  egal("textul se curăță: spații și lungime", [SC.curataCategorie("  Benzi   adezive "), SC.curataCategorie(null), SC.curataCategorie("x".repeat(200)).length], ["Benzi adezive", "", 80]);
  let r = await SC.seteaza(A, { categorie: "  TSK   Cartoane " }, ADMIN);
  egal("se scrie pe produs, curățată", [r.ok, produs(A).categorie, r.paleti], [true, "TSK Cartoane", 0]);
  bine("…cu un mesaj care spune ce s-a pus", /TSK Carton A — categoria din nomenclator: TSK Cartoane\./.test(r.mesaj), r.mesaj);
  egal("…și un rând în jurnal, cu ce era înainte și cine a schimbat", jurnal(A), [["categorie", null, "TSK Cartoane", 0, "Vali Test"]]);
  egal("categoria simplă n-a fost atinsă", [produs(A).categorie_depozit, catPalet(PA1)], [null, null]);
  r = await SC.seteaza(A, { categorie: "TSK Cartoane" }, ADMIN);
  egal("aceeași valoare: nimic de schimbat, nimic în jurnal", [r.ok, r.schimbat.length, /nimic de schimbat/.test(r.mesaj), jurnal(A).length], [true, 0, true, 1]);
  r = await SC.seteaza(C, { categorie: "" }, ADMIN);
  egal("goală = fără categorie", [produs(C).categorie, jurnal(C)], [null, [["categorie", "diverse", null, 0, "Vali Test"]]]);
  egal("produs inexistent", (await SC.seteaza(99999999, { categorie: "x" }, ADMIN)).eroare, "Produsul nu există.");
  // Două produse cu aceeași categorie: în listă apare o singură dată.
  q(`UPDATE produse SET categorie = 'TSK Cartoane' WHERE id = ${E}`);
  const lista = await SC.categoriiNomenclator();
  q(`UPDATE produse SET categorie = NULL WHERE id = ${E}`);
  bine("lista de ales: categoriile folosite deja, fără dubluri", lista.includes("TSK Cartoane") && lista.includes("TSK Folie stretch") && lista.filter((x) => x === "TSK Cartoane").length === 1 && !lista.includes(""));

  // ------------------------------------------------------------------------
  console.log("\n2. Categoria simplă: pe produs și pe paleții lui");
  r = await SC.seteaza(A, { tip: "materie primă" }, ADMIN);
  egal("se scrie pe produs și pe cei doi paleți fără categorie", [produs(A).categorie_depozit, catPalet(PA1), catPalet(PA2), r.paleti], ["materie primă", "materie primă", "materie primă", 2]);
  egal("paletul ieșit rămâne cum era", catPalet(PA_IESIT), null);
  egal("paletul mixt, care are categoria lui, rămâne cum era", catPalet(PM), "consumabile");
  bine("mesajul spune și câți paleți", /categoria simplă: materie primă \(scrisă și pe 2 paleți\)/.test(r.mesaj), r.mesaj);
  egal("jurnalul ține și numărul de paleți", jurnal(A).slice(-1), [["categorie_depozit", null, "materie primă", 2, "Vali Test"]]);

  r = await SC.seteaza(B, { tip: "materie primă" }, ADMIN, { doarGoi: true });
  egal("cu „doar goi”: se completează paletul fără categorie, cel cu alta rămâne", [produs(B).categorie_depozit, catPalet(PB1), catPalet(PB2), catPalet(PB3), r.paleti], ["materie primă", "materie primă", "produse finite", "materie primă", 1]);
  r = await SC.seteaza(B, { tip: "produse intermediare" }, ADMIN);
  egal("fără „doar goi”: toți paleții care țin doar produsul ăsta iau categoria nouă", [produs(B).categorie_depozit, catPalet(PB1), catPalet(PB2), catPalet(PB3), r.paleti], ["produse intermediare", "produse intermediare", "produse intermediare", "produse intermediare", 3]);

  r = await SC.seteaza(C, { tip: "materie primă" }, ADMIN);
  egal("banda: paletul ei se schimbă, cel mixt (cu categorie) nu", [catPalet(PC1), catPalet(PM), r.paleti], ["materie primă", "consumabile", 1]);
  q(`UPDATE ct_paleti SET categorie = NULL WHERE id = ${PM}`);
  r = await SC.seteaza(C, { tip: "consumabile" }, ADMIN);
  egal("paletul mixt FĂRĂ categorie o primește", [catPalet(PC1), catPalet(PM), r.paleti], ["consumabile", "consumabile", 2]);

  r = await SC.seteaza(A, { tip: "ceva inventat" }, ADMIN);
  bine("o categorie simplă din afara celor patru e refuzată", /una din: produse finite, produse intermediare, consumabile, materie primă/.test(r.eroare || "") && produs(A).categorie_depozit === "materie primă", r.eroare);
  r = await SC.seteaza(A, { tip: "" }, ADMIN);
  egal("goală: se șterge de pe produs, paleții rămân cu ce aveau", [produs(A).categorie_depozit, catPalet(PA1)], [null, "materie primă"]);
  r = await SC.seteaza(A, { tip: "materie primă" }, ADMIN);
  egal("pusă la loc: nimic de scris pe paleți", [produs(A).categorie_depozit, r.paleti], ["materie primă", 0]);
  // Produsul are deja categoria, dar un palet de-al lui a rămas fără: aceeași
  // categorie pusă din nou îl completează, și rămâne scris în jurnal.
  q(`UPDATE ct_paleti SET categorie = NULL WHERE id = ${PA2}`);
  r = await SC.seteaza(A, { tip: "materie primă" }, ADMIN);
  egal("aceeași categorie, dar un palet gol: paletul se completează și jurnalul o ține minte", [catPalet(PA2), r.paleti, jurnal(A).slice(-1)], ["materie primă", 1, [["categorie_depozit", "materie primă", "materie primă", 1, "Vali Test"]]]);
  // Paleții puși pe raft fără cantitate (se scrie după numărare) sunt tot ai
  // produsului de pe ei. Pe 10.11.2026, la încadrarea de pe live, 24 de asemenea
  // paleți au rămas fără categorie: regula se uita doar la liniile cu cantitate.
  const PF_PLIN = palet(F, 800, "kg", null);
  const PF_ZERO = palet(F, 0, "kg", null); // linia e scrisă, cu zero
  const PF_FARA_LINIE = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, um, data_intrare) VALUES ('${PREFIX}-PAL-GOL', ${F}, 'kg', '${azi()}') RETURNING id`));
  const PF_ALTUL = palet(F, 0, "kg", null, { linii: [[E, 7]] }); // golit de F, a rămas pe el alt produs
  const PF_ZERO_CU_CAT = palet(F, 0, "kg", "produse finite");
  r = await SC.seteaza(F, { tip: "materie primă" }, ADMIN, { doarGoi: true });
  egal("paletul cu marfă, cel fără cantitate și cel fără nicio linie primesc categoria produsului", [catPalet(PF_PLIN), catPalet(PF_ZERO), catPalet(PF_FARA_LINIE), r.paleti], ["materie primă", "materie primă", "materie primă", 3]);
  egal("…dar nu și paletul pe care a rămas doar alt produs, nici (cu „doar goi”) cel care are deja o categorie", [catPalet(PF_ALTUL), catPalet(PF_ZERO_CU_CAT)], [null, "produse finite"]);
  r = await SC.seteaza(F, { tip: "produse intermediare" }, ADMIN);
  egal("fără „doar goi”, paletul fără cantitate cu altă categorie o ia pe cea nouă", [catPalet(PF_ZERO_CU_CAT), catPalet(PF_ALTUL), r.paleti], ["produse intermediare", null, 4]);
  egal("cele patru categorii simple", SC.TIPURI, ["produse finite", "produse intermediare", "consumabile", "materie primă"]);

  // ------------------------------------------------------------------------
  console.log("\n3. Paletul nou moștenește categoria");
  egal("categoria pentru un palet nou: a produsului; altfel a paleților lui; altfel niciuna",
    [await SC.tipPentruPaletNou(A), await SC.tipPentruPaletNou(D), await SC.tipPentruPaletNou(E), await SC.tipPentruPaletNou(0)], ["materie primă", null, null, null]);
  q(`UPDATE ct_paleti SET categorie = 'consumabile' WHERE id = ${PD1}`);
  egal("…produsul fără categorie pe el o ia de pe paleții lui din stoc", await SC.tipPentruPaletNou(D), "consumabile");
  q(`UPDATE ct_paleti SET categorie = NULL WHERE id = ${PD1}`);
  let ids = await CT.puneMarfa({ user: DEP }, { produs_id: String(A), um: "buc" }, [[]], 10);
  egal("intrare fără categorie aleasă: paletul ia categoria produsului", catPalet(ids[0]), "materie primă");
  ids = await CT.puneMarfa({ user: DEP }, { produs_id: String(A), um: "buc", categorie: "consumabile" }, [[]], 10);
  egal("intrare cu categoria aleasă de om: rămâne cea aleasă", catPalet(ids[0]), "consumabile");
  ids = await CT.puneMarfa({ user: DEP }, { produs_id: String(E), um: "buc" }, [[]], 10);
  egal("produs fără nicio categorie: paletul rămâne fără", catPalet(ids[0]), null);

  // ------------------------------------------------------------------------
  console.log("\n4. Ce arată „Stoc la zi”");
  const unit = SP.construieste({
    produse: new Map([[1, { denumire: "Unu", categorie: "Cat", categorie_depozit: "consumabile", unitate_masura: "buc" }], [2, { denumire: "Doi", categorie_depozit: "consumabile", unitate_masura: "buc" }]]),
    linii: [
      { produs_id: 1, um: "buc", cantitate: 10, palet_id: 1, categorie: null },
      { produs_id: 2, um: "buc", cantitate: 10, palet_id: 2, categorie: "materie primă" },
      { produs_id: 2, um: "buc", cantitate: 4, palet_id: 3, categorie: null },
    ],
  });
  egal("paleți fără categorie: se arată cea a produsului; paleți cu categorie: a lor", unit.map((x) => [x.denumire, x.tip, x.categorie]), [["Doi", "materie primă", ""], ["Unu", "consumabile", "Cat"]]);
  await SC.seteaza(D, { tip: "materie primă" }, ADMIN);
  // Produsul are categoria lui, iar un palet vechi are alta: paletul nou o ia pe a produsului.
  q(`UPDATE ct_paleti SET categorie = 'consumabile' WHERE id = ${PD1}`);
  egal("paletul nou ia categoria produsului, nu pe cea a paleților vechi", await SC.tipPentruPaletNou(D), "materie primă");
  q(`UPDATE ct_paleti SET categorie = NULL WHERE id = ${PD1}`);
  const toate = await SP.citeste({ vedeTot: true });
  const peId = (id) => toate.find((x) => x.produs_id === id) || {};
  egal("din bază: granulele (palet fără categorie) arată categoria produsului", [peId(D).tip, peId(D).categorie], ["materie primă", "TSK Granule"]);
  egal("…iar folia arată categoria paleților ei", [peId(B).tip, peId(B).categorie], ["produse intermediare", "TSK Folie stretch"]);

  let pag = await cer("get", "/stocuri/ct-park/stoc", ADMIN, { query: { q: PREFIX } });
  const cap = (pag.corp.match(/<thead>[\s\S]*?<\/thead>/) || [""])[0].split(/<th(?:\s[^>]*)?>/).slice(1).map((c) => c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().replace(/ ▾$/, ""));
  egal("capul tabelului: categoria din nomenclator e a doua coloană", cap.slice(0, 4).map((c) => c.replace(/\s*[▾▴▼▲⇅↕].*$/, "")), ["Produs", "Categorie nomenclator", "Categorie", "În stoc"]);
  egal("…și nu mai e la coadă", [cap.length, /Sosire/.test(cap[cap.length - 1])], [10, true]);
  let rb = randPagina(pag.corp, `${PREFIX} Folie B`);
  egal("rândul foliei: nomenclatorul al doilea, categoria simplă a treia", celuleRand(rb).slice(1, 3), ["TSK Folie stretch", "produse intermediare"]);
  bine("administratorul are „modifică”, cu cele două câmpuri completate", rb.includes('class="stoc-cat"') && rb.includes('action="/stocuri/ct-park/stoc/categorii"') && rb.includes(`name="produs_id" value="${B}"`) && rb.includes('name="categorie" list="categorii-nomenclator" value="TSK Folie stretch"') && rb.includes('<option value="produse intermediare" selected>') && rb.includes('name="tip_vechi" value="produse intermediare"'), rb.slice(rb.indexOf("stoc-cat"), rb.indexOf("stoc-cat") + 700));
  bine("…întoarcerea e pe aceeași căutare", rb.includes(`name="inapoi" value="/stocuri/ct-park/stoc?q=${PREFIX}"`));
  bine("…și lista de categorii din nomenclator e în pagină", /<datalist id="categorii-nomenclator">[\s\S]*<option value="TSK Cartoane">/.test(pag.corp));
  for (const [om, nume] of [[DEP, "depozitul"], [AGENT, "agentul"]]) {
    const p2 = (await cer("get", "/stocuri/ct-park/stoc", om, { query: { q: PREFIX } })).corp;
    bine(`${nume} vede cele două categorii, dar nu formularul`, celuleRand(randPagina(p2, `${PREFIX} Folie B`)).slice(1, 3).join("|") === "TSK Folie stretch|produse intermediare" && !p2.includes("stoc-cat") && !p2.includes("categorii-nomenclator"));
  }

  // ------------------------------------------------------------------------
  console.log("\n5. Salvarea din pagină");
  const CALE = "/stocuri/ct-park/stoc/categorii";
  r = await cer("post", CALE, AGENT, { body: { produs_id: String(B), categorie: "Altceva", tip: "consumabile", tip_vechi: "", inapoi: `/stocuri/ct-park/stoc?q=${PREFIX}` } });
  bine("agentul e refuzat, cu mesaj, și nu se schimbă nimic", /doar administratorul/.test(parametri(r).eroare || "") && produs(B).categorie === "TSK Folie stretch" && catPalet(PB1) === "produse intermediare", unde(r));
  r = await cer("post", CALE, DEP, { body: { produs_id: String(B), categorie: "Altceva" } });
  bine("…la fel depozitul", /doar administratorul/.test(parametri(r).eroare || "") && produs(B).categorie === "TSK Folie stretch", unde(r));
  r = await cer("post", CALE, null, { body: { produs_id: String(B), categorie: "Altceva" } });
  egal("fără cont: la autentificare", unde(r), "/login");

  q(`UPDATE ct_paleti SET categorie = 'produse finite' WHERE id = ${PB2}`);
  r = await cer("post", CALE, ADMIN, { body: { produs_id: String(B), categorie: "TSK Folie stretch manuala", tip: "produse intermediare", tip_vechi: "produse intermediare", inapoi: `/stocuri/ct-park/stoc?q=${PREFIX}` } });
  egal("doar nomenclatorul schimbat: paleții nu se rescriu", [produs(B).categorie, catPalet(PB2), unde(r).split("?")[0], parametri(r).q], ["TSK Folie stretch manuala", "produse finite", "/stocuri/ct-park/stoc", PREFIX]);
  bine("…și mesajul spune ce s-a schimbat", /TSK Folie B — categoria din nomenclator: TSK Folie stretch manuala\./.test(parametri(r).ok || ""), parametri(r).ok);
  r = await cer("post", CALE, ADMIN, { body: { produs_id: String(B), categorie: "TSK Folie stretch manuala", tip: "materie primă", tip_vechi: "produse intermediare", inapoi: "https://rau.example/x" } });
  egal("categoria simplă schimbată: produsul și toți paleții lui; o adresă străină nu e crezută", [produs(B).categorie_depozit, catPalet(PB1), catPalet(PB2), catPalet(PB3), unde(r).split("?")[0]], ["materie primă", "materie primă", "materie primă", "materie primă", "/stocuri/ct-park/stoc"]);
  q(`UPDATE ct_paleti SET categorie = 'produse finite' WHERE id = ${PB2}`);
  q(`UPDATE ct_paleti SET categorie = NULL WHERE id = ${PB3}`);
  r = await cer("post", CALE, ADMIN, { body: { produs_id: String(B), tip: "consumabile", tip_vechi: "", doar_goi: "1" }, antete: { accept: "application/json" } });
  const j = JSON.parse(r.corp || "{}");
  egal("cerut ca JSON, cu „doar goi”: răspuns scurt, doar paletul gol completat", [r.cod, /application\/json/.test(String(r.antet["Content-Type"])), j.ok, j.paleti, catPalet(PB2), catPalet(PB3), produs(B).categorie], [200, true, true, 1, "produse finite", "consumabile", "TSK Folie stretch manuala"]);
  r = await cer("post", CALE, ADMIN, { body: { produs_id: "99999999", categorie: "x" }, antete: { accept: "application/json" } });
  egal("produs inexistent, ca JSON: 400 cu eroarea", [r.cod, JSON.parse(r.corp).eroare], [400, "Produsul nu există."]);
  r = await cer("post", CALE, ADMIN, { body: { produs_id: String(B), tip: "prostii", tip_vechi: "" } });
  bine("categorie simplă greșită: mesaj de eroare în pagină", /una din: produse finite/.test(parametri(r).eroare || ""), unde(r));

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
