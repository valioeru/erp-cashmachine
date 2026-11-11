"use strict";
// Scanerul din CT-Park: intrarea și ieșirea mărfii cu terminalul în mână.
//
// Vali, 10.11.2026: „când iese marfa din producție cu cod pe ea, să o scaneze
// cineva, să scaneze codul raftului și să dea OK, și să se înregistreze automat
// marfa ca a intrat în CT-Park pe raftul, locul X (sau locurile X). La fel și la
// ieșire." „Două butoane pe display, intrare/ieșire marfă, cu opțiune de unde
// vine." „La recepție marfă să te asiguri că se generează etichete pentru
// fiecare palet — se lipește pe palet, apoi se scanează și se pun pe rafturi."
// „La pune pe raft poți să și alegi locul: se sugerează inițial unul unde sunt
// produse din categorii similare, sau poți alege tu unul, sau poți scana direct
// un loc." „Pe ieșire alegi comanda și se imprimă și comanda client."
//
// Ce se verifică:
//   1. citirea cantităților („400 + 400 + 200", „3 x 400", „12,5") și a codurilor;
//   2. ce e de pus pe raft, pe surse (producție, furnizor, retururi);
//   3. recepția: paleți fără loc, câte unul pe cantitate, cu etichetele lor;
//   4. pagina de intrare: scanarea unui palet, a unui loc, a codului mărfii;
//   5. paletul: locul propus lângă același produs, locul scanat verificat pe loc,
//      punerea, mutarea, paletul lat pe locuri lipite;
//   6. marfa din producție fără palet: cantitate + loc → palet pe raft, recepția
//      numărată „cum a fost anunțată", eticheta la tipărit;
//   7. cererea depozitului gata în producție;
//   8. ieșirea: paletul, locul sau produsul scanat; FIFO; întreg sau o parte;
//      pe comandă iese avizul, iar avizul și comanda clientului merg la tipărit;
//   9. foaia comenzii clientului, fără prețuri, cu ce a plecat;
//  10. coada „De tipărit";
//  11. etichetele locurilor;
//  12. un loc scanat de oriunde din ERP;
//  13. cine n-are depozitul nu face nimic din toate astea;
//  14. în browser, pe ecran de telefon: cititorul scrie în câmp, Enter trimite,
//      nimic nu iese din ecran, cantitatea scrisă nu se pierde la un click.
//
// Pe baza Postgres locală (port 5433), cu paginile adevărate, plus Chromium.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n-> " + (e.stderr || e.message)); }
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
for (const m of ["avize", "gata-productie", "ct-scaner", "ct-park", "receptie", "scan"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const SC = require(path.join(RAD, "lib", "ct-scaner.js"));
const SCAN = require(path.join(RAD, "lib", "scan.js"));

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
        par = Object.fromEntries(nume.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
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
const adresa = (r) => new URL(unde(r), "http://erp.test");
const parametri = (r) => Object.fromEntries(adresa(r).searchParams);
// Urmează redirecționarea unei cereri GET, cum face browserul.
async function urmeaza(r, user) {
  const u = adresa(r);
  return cer("get", u.pathname, user, { query: Object.fromEntries(u.searchParams) });
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
const azi = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 10);

// ---- datele de test ------------------------------------------------------
const PREFIX = "TSC";
const P1 = 97801, P2 = 97802, P3 = 97803, P4 = 97804;
const CLIENT = 97811, FURNIZOR = 97812;
const CMD = 97821, CMD2 = 97822;
const CP = 97831;
const A_GATA = 97841;
const RAND = 97851, NUMAR_RAND = 97;
const VECHI = 97881; // paletul de P1 deja pe raft, intrat pe 01.11
const COD_VECHI = "CT261101-97881";
const DEPOZIT = { id: 1, nume: "TSC Depozit", rol: "depozit", sectiuni: "" };
const VANZARI = { id: 2, nume: "TSC Agent", rol: "vanzari", sectiuni: "" };
const BAZA = "/stocuri/ct-park/scaner";
// Locurile rândului de test: 2 câmpuri × 2 niveluri × 3 poziții.
const L = (camp, nivel, poz) => 97860 + (camp - 1) * 6 + (nivel - 1) * 3 + poz;
const A = (camp, nivel, poz) => `R${NUMAR_RAND}-0${camp}-${nivel}-${poz}`;
let avizUrmator = null;

function receptiiMele() {
  return q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-%' OR comanda_productie_id = ${CP}`).map((x) => Number(x.id));
}
function curata() {
  const r = receptiiMele().join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE produs_id IN (${P1}, ${P2}, ${P3}, ${P4}) OR receptie_id IN (${r}) OR aprovizionare_id = ${A_GATA}`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_tipar WHERE creat_de IN ('${DEPOZIT.nume}', '${PREFIX} vechi')`);
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM avize WHERE partener_id = ${CLIENT}`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p}) OR loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${RAND})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM ct_locuri WHERE rand_id = ${RAND}`);
  q(`DELETE FROM ct_randuri WHERE id = ${RAND}`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${P1}, ${P2}, ${P3}, ${P4})`);
  q(`DELETE FROM stoc_locuri WHERE receptie_id IN (${r}) OR produs_id IN (${P1}, ${P2}, ${P3}, ${P4})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${r}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii WHERE id IN (${r})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id = ${CP}`);
  q(`DELETE FROM comenzi_productie WHERE id = ${CP}`);
  q(`DELETE FROM aprovizionari WHERE id = ${A_GATA} OR produs_id IN (${P1}, ${P2}, ${P3}, ${P4})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${P1}, ${P2}, ${P3}, ${P4})`);
  try { q(`DELETE FROM comenzi_istoric WHERE comanda_id IN (${CMD}, ${CMD2})`); } catch (_) { /* tabela poate lipsi */ }
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${CMD}, ${CMD2})`);
  q(`DELETE FROM comenzi WHERE id IN (${CMD}, ${CMD2})`);
  q(`DELETE FROM produse WHERE id IN (${P1}, ${P2}, ${P3}, ${P4})`);
  q(`DELETE FROM interactiuni WHERE partener_id IN (${CLIENT}, ${FURNIZOR})`);
  q(`DELETE FROM parteneri WHERE id IN (${CLIENT}, ${FURNIZOR})`);
}
const paletiFaraLoc = (produs) =>
  q(`SELECT p.id, p.cod, p.cantitate FROM ct_paleti p WHERE p.produs_id = ${produs} AND p.data_iesire IS NULL
      AND NOT EXISTS (SELECT 1 FROM ct_ocupari o WHERE o.palet_id = p.id) ORDER BY p.id`);
const locurilePaletului = (id) => q(`SELECT l.adresa FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id WHERE o.palet_id = ${id} ORDER BY l.adresa`).map((x) => x.adresa);

(async () => {
  curata();
  avizUrmator = unul("SELECT valoare FROM setari_app WHERE cheie = 'aviz_urmator'");
  try {
    await ruleaza();
  } finally {
    try { curata(); } catch (e) { console.error("curățenia a picat:", e.message); }
    if (avizUrmator != null) q("UPDATE setari_app SET valoare = ? WHERE cheie = 'aviz_urmator'", [avizUrmator]);
  }
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function ruleaza() {
  // ------------------------------------------------------------------------
  console.log("1. Cantitățile și codurile, cum le scrie omul");
  egal("„400 + 400 + 200”", SC.cantitatiDinText("400 + 400 + 200"), [400, 400, 200]);
  egal("„400+400+200”", SC.cantitatiDinText("400+400+200"), [400, 400, 200]);
  egal("„400, 400, 200”", SC.cantitatiDinText("400, 400, 200"), [400, 400, 200]);
  egal("„400 400 200”", SC.cantitatiDinText("400 400 200"), [400, 400, 200]);
  egal("„400,400,200” (fără spații)", SC.cantitatiDinText("400,400,200"), [400, 400, 200]);
  egal("„3 x 400”", SC.cantitatiDinText("3 x 400"), [400, 400, 400]);
  egal("„2x12,5”", SC.cantitatiDinText("2x12,5"), [12.5, 12.5]);
  egal("„12,5” e un palet de 12,5, nu doi", SC.cantitatiDinText("12,5"), [12.5]);
  egal("„12.5”", SC.cantitatiDinText("12.5"), [12.5]);
  egal("gol", SC.cantitatiDinText("  "), []);
  bine("„abc” nu e o cantitate", SC.cantitatiDinText("abc").length === 1 && Number.isNaN(SC.cantitatiDinText("abc")[0]));
  bine("„400 + x” are o cantitate greșită", SC.cantitatiDinText("400 + x").some((v) => Number.isNaN(v)));
  bine("eticheta unui loc se recunoaște, cu litere mici și spații", SC.eLoc(" r97-01-2-3 ") && !SC.eLoc("R97-01-2") && !SC.eLoc("CT261101-0001"));
  bine("eticheta unui palet se recunoaște", SC.ePalet("ct261101-0042") && !SC.ePalet("R97-01-2-3") && !SC.ePalet("CT2611-1"));
  bine("sursele: retur de la client și din fulfillment sunt „Retururi”", SC.sursaPotrivita("retur_tert", "retur") && SC.sursaPotrivita("retur_fulfilment", "retur") && !SC.sursaPotrivita("productie", "retur"));
  bine("sursele: „Toate” nu filtrează", SC.sursaPotrivita("orice", "toate") && SC.sursaPotrivita("productie", ""));
  bine("un loc scanat e și o formă pentru /scan", SCAN.interpreteaza("r97-01-1-1").forme.some((f) => f.fel === "loc" && f.adresa === "R97-01-1-1"));

  // ---- datele ------------------------------------------------------------
  q(`INSERT INTO parteneri (id, tip, nume, adresa) VALUES (${CLIENT}, 'client', '${PREFIX} Client SRL', 'Str. Testului 7, Craiova'), (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL', NULL)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (${P1}, '${PREFIX}-P1', '${PREFIX} Folie stretch 23my', 'kg'),
       (${P2}, '${PREFIX}-P2', '${PREFIX} Pungă curier', 'buc'),
       (${P3}, '${PREFIX}-P3', '${PREFIX} Bandă adezivă', 'buc')`);
  // Prețul e obligatoriu la intrarea în depozit (11.11.2026; test-pret-intrare.js):
  // produsele de probă au un cost, ca paleții lor să intre.
  q(`UPDATE produse SET pret_achizitie = 2 WHERE id IN (${P1}, ${P2}, ${P3})`);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD}, ${CLIENT}, '${PREFIX}-CMD-1', '${azi()}', 'confirmata'), (${CMD2}, ${CLIENT}, '${PREFIX}-CMD-2', '${azi()}', 'confirmata')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${CMD}, ${P1}, 700, 123.45), (${CMD2}, ${P2}, 10, 1)`);
  q(`INSERT INTO ct_randuri (id, numar, eticheta, niveluri, campuri, locuri_pe_camp, activ) VALUES (${RAND}, ${NUMAR_RAND}, '${PREFIX}', 2, 2, 3, 1)`);
  const locuri = [];
  for (let camp = 1; camp <= 2; camp++) for (let nivel = 1; nivel <= 2; nivel++) for (let poz = 1; poz <= 3; poz++) {
    locuri.push(`(${L(camp, nivel, poz)}, ${RAND}, ${nivel}, ${camp}, ${poz}, '${A(camp, nivel, poz)}', ${camp === 2 && nivel === 2 && poz === 3 ? 1 : 0})`);
  }
  q(`INSERT INTO ct_locuri (id, rand_id, nivel, camp, pozitie, adresa, blocat) VALUES ${locuri.join(", ")}`);
  // Un palet de P1 deja pe raft, de pe 01.11, pe R97-01-1-1.
  q(`INSERT INTO ct_paleti (id, cod, produs_id, cantitate, um, lot, categorie, data_intrare, pret_unitar) VALUES (${VECHI}, '${COD_VECHI}', ${P1}, 500, 'kg', 'TSC-LOT-0', 'materie primă', '2026-11-01', 9)`);
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um, lot, pret_unitar) VALUES (${VECHI}, ${P1}, 500, 'kg', 'TSC-LOT-0', 9)`);
  q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${VECHI}, ${L(1, 1, 1)})`);
  // Recepția de la furnizor, numărată: 1000 kg de P1.
  const REC_F = Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare, finalizata_la) VALUES ('${PREFIX}-REC-F', 'furnizor', ${FURNIZOR}, '${azi()}', 'finalizata', '${azi()} 08:00:00') RETURNING id`));
  const RL_F = Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, lot, pret_unitar, stare, conditie) VALUES (${REC_F}, ${P1}, 1000, 1000, 'kg', 'TSC-LOT-1', 9.5, 'primita', 'bun') RETURNING id`));
  // Recepția din producție, încă nenumărată: 600 buc de P2.
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, data_initiere, client_text) VALUES (${CP}, '${PREFIX}-CP-1', ${P2}, '${PREFIX} Pungă curier', '600', 'buc', 'finalizata', '${azi()}', '${PREFIX} Client SRL')`);
  const REC_P = Number(unul(`INSERT INTO receptii (numar, sursa, comanda_productie_id, data, stare) VALUES ('${PREFIX}-REC-P', 'productie', ${CP}, '${azi()}', 'asteptata') RETURNING id`));
  const RL_P = Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, um, stare) VALUES (${REC_P}, ${P2}, 600, 'buc', 'de_primit') RETURNING id`));
  // Cererea depozitului, gata în producție: 90 buc de P3.
  q(`INSERT INTO aprovizionari (id, comanda_id, produs_id, cantitate, sursa, status, creata_la) VALUES (${A_GATA}, NULL, ${P3}, 90, 'productie', 'gata', '${azi()}')`);

  // ------------------------------------------------------------------------
  console.log("\n2. Ce e de pus pe raft, pe surse");
  const cheile = async (f) => (await SC.deAsezat(f)).map((r) => r.cheie).filter((k) => [`r${RL_F}`, `r${RL_P}`, `c${A_GATA}`].includes(k)).sort();
  egal("toate: recepția furnizorului, recepția din producție, cererea", await cheile("toate"), [`c${A_GATA}`, `r${RL_F}`, `r${RL_P}`].sort());
  egal("de la furnizor: doar recepția furnizorului", await cheile("furnizor"), [`r${RL_F}`]);
  egal("din producție: recepția din producție și cererea", await cheile("productie"), [`c${A_GATA}`, `r${RL_P}`].sort());
  egal("retururi: nimic din ale noastre", await cheile("retur"), []);
  const rf = await SC.randDeAsezat(`r${RL_F}`);
  egal("recepția furnizorului: 1000 kg de pus", [rf.ramas, rf.um, rf.sursa], [1000, "kg", "furnizor"]);

  // ------------------------------------------------------------------------
  console.log("\n3. Recepția: paleți cu etichetă, fără loc");
  const pagRec = await cer("get", `/depozit/receptie/${REC_F}`, DEPOZIT);
  egal("pagina recepției se deschide", pagRec.cod, 200);
  bine("are formularul de paleți, cu tot rândul pe un palet dacă nu scrii altceva",
    pagRec.corp.includes(`action="/depozit/receptie/${REC_F}/paleti"`) && pagRec.corp.includes(`name="paleti_${RL_F}" value="1000"`));
  const rv = await cer("post", `/depozit/receptie/${REC_F}/paleti`, VANZARI, { body: { [`paleti_${RL_F}`]: "400 + 400" } });
  bine("agentul de vânzări nu face paleți", unde(rv) === "/depozit/receptie" && paletiFaraLoc(P1).length === 0, unde(rv));
  const rGresit = await cer("post", `/depozit/receptie/${REC_F}/paleti`, DEPOZIT, { body: { [`paleti_${RL_F}`]: "abc" } });
  bine("„abc”: înapoi la recepție cu eroarea, fără paleți", /^\/depozit\/receptie\/\d+\?eroare=/.test(unde(rGresit)) && paletiFaraLoc(P1).length === 0, unde(rGresit));
  const rGol = await cer("post", `/depozit/receptie/${REC_F}/paleti`, DEPOZIT, { body: { [`paleti_${RL_F}`]: "" } });
  bine("nimic scris: eroare, fără paleți", /eroare=/.test(unde(rGol)) && paletiFaraLoc(P1).length === 0, unde(rGol));
  const rPrea = await cer("post", `/depozit/receptie/${REC_F}/paleti`, DEPOZIT, { body: { [`paleti_${RL_F}`]: "600 + 600" } });
  bine("600 + 600 din 1000, fără bifă: întreabă, fără paleți", /eroare=/.test(unde(rPrea)) && /Ai scris 1\.200 kg, dar mai erau de pus 1\.000 kg — cu 200 kg mai mult\./.test(parametri(rPrea).eroare || "") && paletiFaraLoc(P1).length === 0, unde(rPrea));
  bine("…și spune cum se confirmă pe pagina recepției", /bifează „pe paleți e mai mult decât s-a numărat” și trimite din nou/.test(parametri(rPrea).eroare || ""), parametri(rPrea).eroare);
  const rPal = await cer("post", `/depozit/receptie/${REC_F}/paleti`, DEPOZIT, { body: { [`paleti_${RL_F}`]: "400 + 400" } });
  const facuti = paletiFaraLoc(P1);
  egal("400 + 400: doi paleți de 400, fără loc", facuti.map((p) => Number(p.cantitate)), [400, 400]);
  const [PA, PB] = facuti.map((p) => Number(p.id));
  const [COD_A, COD_B] = facuti.map((p) => p.cod);
  egal("se deschid etichetele celor doi paleți", unde(rPal), `/stocuri/ct-park/etichete?paleti=${PA},${PB}`);
  bine("fiecare are codul lui de palet", SC.ePalet(COD_A) && SC.ePalet(COD_B) && COD_A !== COD_B, COD_A + " " + COD_B);
  const pa = q(`SELECT receptie_id, receptie_linie_id, lot, pret_unitar, um FROM ct_paleti WHERE id = ${PA}`)[0];
  egal("paletul ține minte recepția, lotul, prețul și unitatea", [Number(pa.receptie_id), Number(pa.receptie_linie_id), pa.lot, Number(pa.pret_unitar), pa.um], [REC_F, RL_F, "TSC-LOT-1", 9.5, "kg"]);
  const etichete = await cer("get", "/stocuri/ct-park/etichete", DEPOZIT, { query: { paleti: `${PA},${PB}` } });
  bine("pagina de etichete le are pe amândouă", etichete.cod === 200 && etichete.corp.includes(COD_A) && etichete.corp.includes(COD_B));
  bine("eticheta unui palet fără loc spune ce urmează, nu „—”", (etichete.corp.match(/<div class="et-adresa et-fara-loc">DE PUS PE RAFT<\/div>/g) || []).length === 2 && !/<td>Locuri<\/td>/.test(etichete.corp));
  const etVechi = await cer("get", "/stocuri/ct-park/etichete", DEPOZIT, { query: { paleti: String(VECHI) } });
  bine("eticheta paletului de pe raft are adresa lui, ca până acum", /<div class="et-adresa">R97-01-1-1<\/div>/.test(etVechi.corp) && /<td>Locuri<\/td><td>1<\/td>/.test(etVechi.corp));
  egal("recepția mai are 200 kg fără paleți", (await SC.randDeAsezat(`r${RL_F}`)).ramas, 200);
  const fl = async (f) => (await SC.faraLoc(f)).map((p) => Number(p.id)).filter((id) => [PA, PB].includes(id));
  egal("paleții așteaptă raftul la „De la furnizor”", await fl("furnizor"), [PA, PB]);
  egal("…nu și la „Din producție”", await fl("productie"), []);
  const pagRec2 = (await cer("get", `/depozit/receptie/${REC_F}`, DEPOZIT)).corp;
  bine("recepția îi arată „fără loc”, cu 200 rămase în formular", pagRec2.includes(COD_A) && /fără loc/.test(pagRec2) && pagRec2.includes(`name="paleti_${RL_F}" value="200"`));

  // ------------------------------------------------------------------------
  console.log("\n4. Scanerul: acasă și pagina de intrare");
  const acasa = await cer("get", BAZA, DEPOZIT);
  bine("acasă: două butoane, INTRARE și IEȘIRE", acasa.cod === 200 && /class="sc-mare sc-intrare" href="\/stocuri\/ct-park\/scaner\/intrare"/.test(acasa.corp) && /class="sc-mare sc-iesire" href="\/stocuri\/ct-park\/scaner\/iesire"/.test(acasa.corp));
  bine("pagina de terminal n-are meniul ERP-ului", !/class="topbar"/.test(acasa.corp) && /class="sc-sus"/.test(acasa.corp));
  const intrare = await cer("get", `${BAZA}/intrare`, DEPOZIT);
  bine("intrare: paleții care așteaptă raftul și marfa fără paleți", intrare.cod === 200 && intrare.corp.includes(COD_A) && intrare.corp.includes(`${BAZA}/intrare/rand/r${RL_P}`) && intrare.corp.includes(`${BAZA}/intrare/rand/c${A_GATA}`));
  bine("intrare: de unde vine marfa — producție, furnizor, retururi, toate", ["Din producție", "De la furnizor", "Retururi", "Toate"].every((t) => intrare.corp.includes(">" + t + "</a>")));
  const intrProd = (await cer("get", `${BAZA}/intrare`, DEPOZIT, { query: { sursa: "productie" } })).corp;
  bine("„Din producție”: fără paleții furnizorului, cu marfa din producție", !intrProd.includes(COD_A) && intrProd.includes(`/intrare/rand/r${RL_P}`) && !intrProd.includes(`/intrare/rand/r${RL_F}`));
  const scan = (cod, extra) => cer("get", `${BAZA}/intrare`, DEPOZIT, { query: Object.assign({ cod }, extra || {}) });
  egal("scanez paletul: se deschide el", unde(await scan(COD_A)), `${BAZA}/intrare/palet/${PA}`);
  egal("…și scris cu litere mici și spații", unde(await scan(`  ${COD_A.toLowerCase()} `)), `${BAZA}/intrare/palet/${PA}`);
  bine("palet necunoscut: eroare", /nu există în CT-Park/.test(parametri(await scan("CT990101-999999")).eroare || ""));
  const sLoc = await scan(A(1, 1, 2));
  egal("scanez un loc liber: rămâne ales", [parametri(sLoc).loc, /Loc ales: R97-01-1-2/.test(parametri(sLoc).ok || "")], [String(L(1, 1, 2)), true]);
  egal("…și merge mai departe la paletul scanat după el", unde(await scan(COD_A, { loc: String(L(1, 1, 2)) })), `${BAZA}/intrare/palet/${PA}?loc=${L(1, 1, 2)}`);
  bine("loc ocupat: eroare", /stă deja alt palet/.test(parametri(await scan(A(1, 1, 1))).eroare || ""));
  bine("loc scos din uz: eroare", /scos din uz/.test(parametri(await scan(A(2, 2, 3))).eroare || ""));
  bine("loc care nu e pe hartă: eroare", /nu există pe hartă/.test(parametri(await scan("R97-09-9-9")).eroare || ""));
  const sProdus = await scan(`${PREFIX}-P1`);
  bine("codul produsului, cu doi paleți și un rând: listă din care alegi", sProdus.cod === 200 && /Cu codul TSC-P1 sunt mai multe/.test(sProdus.corp) && sProdus.corp.includes(COD_A) && sProdus.corp.includes(COD_B) && sProdus.corp.includes(`/intrare/rand/r${RL_F}`) && !sProdus.corp.includes(`/intrare/rand/r${RL_P}`));
  egal("fișa de lot a producției (CM-…): marfa ei", unde(await scan(`CM-261110-${CP}`)), `${BAZA}/intrare/rand/r${RL_P}`);
  egal("codul produsului din producție: tot ea", unde(await scan(`${PREFIX}-P2`)), `${BAZA}/intrare/rand/r${RL_P}`);
  bine("lotul de pe paleți: cei doi paleți", (await scan("TSC-LOT-1")).corp.includes(COD_B));
  bine("un cod fără nimic de pus: eroare", /Nu e nimic de pus pe raft cu codul NIMIC-123/.test(parametri(await scan("nimic-123")).eroare || ""));

  // ------------------------------------------------------------------------
  console.log("\n5. Paletul: locul propus, locul scanat, pune, mută, palet lat");
  const pp = await cer("get", `${BAZA}/intrare/palet/${PA}`, DEPOZIT);
  egal("pagina paletului se deschide", pp.cod, 200);
  const propus = (pp.corp.match(/class="sc-propus" href="[^"]*loc=(\d+)[^"]*">[\s\S]*?<b>([^<]+)<\/b>[\s\S]*?<span class="sc-mic">([^<]*)/) || []).slice(1);
  egal("propune locul de lângă același produs, la nivelul de jos", [propus[0], propus[1]], [String(L(1, 1, 2)), A(1, 1, 2)]);
  bine("…și spune de ce", /lângă același produs/.test(propus[2] || ""), propus[2]);
  bine("fără loc ales, „Efectuează” e oprit", /<button class="sc-ok" type="submit" disabled>Scanează sau alege locul<\/button>/.test(pp.corp));
  const peP = (cod, extra) => cer("get", `${BAZA}/intrare/palet/${PA}`, DEPOZIT, { query: Object.assign({ cod }, extra || {}) });
  const cuLoc = await peP(A(1, 1, 3));
  egal("scanez locul: rămâne ales", parametri(cuLoc).loc, String(L(1, 1, 3)));
  const pp2 = await urmeaza(cuLoc, DEPOZIT);
  bine("butonul spune unde pune", /EFECTUEAZĂ — pune pe R97-01-1-3<\/button>/.test(pp2.corp) && !/sc-ok" type="submit" disabled/.test(pp2.corp));
  egal("alt loc scanat îl înlocuiește (palet de un loc)", parametri(await peP(A(1, 2, 2), { loc: String(L(1, 1, 3)) })).loc, String(L(1, 2, 2)));
  bine("loc ocupat, scanat: eroare pe loc", /stă deja alt palet/.test(parametri(await peP(A(1, 1, 1))).eroare || ""));
  bine("loc scos din uz, scanat: eroare", /scos din uz/.test(parametri(await peP(A(2, 2, 3))).eroare || ""));
  bine("altceva decât un loc: eroare care spune ce se scanează", /nu e eticheta unui loc/.test(parametri(await peP("TSC-P1")).eroare || ""));
  egal("alt palet scanat aici: se trece la el", unde(await peP(COD_B)), `${BAZA}/intrare?cod=${encodeURIComponent(COD_B)}`);
  const pune = (id, locuri, extra) => cer("post", `${BAZA}/intrare/palet/${id}`, DEPOZIT, { body: Object.assign({ locuri: locuri.join(",") }, extra || {}) });
  const rOcupat = await pune(PA, [L(1, 1, 1)]);
  bine("pe un loc ocupat nu se pune", /stă deja altă marfă/.test(parametri(rOcupat).eroare || "") && locurilePaletului(PA).length === 0, unde(rOcupat));
  const rBlocat = await pune(PA, [L(2, 2, 3)]);
  bine("pe un loc scos din uz nu se pune, nici trimis de-a dreptul", /scos din uz/.test(parametri(rBlocat).eroare || "") && locurilePaletului(PA).length === 0, unde(rBlocat));
  const rFara = await pune(PA, []);
  bine("fără loc nu se pune", /Scanează locul/.test(parametri(rFara).eroare || "") && locurilePaletului(PA).length === 0);
  const rPus = await pune(PA, [L(1, 1, 2)]);
  egal("pus: paletul e pe locul scanat", locurilePaletului(PA), [A(1, 1, 2)]);
  bine("…și terminalul se întoarce la intrare, cu ce s-a făcut", adresa(rPus).pathname === `${BAZA}/intrare` && new RegExp(`${COD_A} e pe R97-01-1-2`).test(parametri(rPus).ok || ""), unde(rPus));
  egal("nu mai așteaptă raftul", await fl("toate"), [PB]);
  const ppMut = (await cer("get", `${BAZA}/intrare/palet/${PA}`, DEPOZIT)).corp;
  bine("paletul de pe raft: pagina spune că se mută", /Acum pe <strong>R97-01-1-2<\/strong>/.test(ppMut) && !/Câte locuri ține paletul/.test(ppMut));
  const rAcelasi = await pune(PA, [L(1, 1, 2)]);
  bine("pe același loc: nu e mutare", /e deja acolo/.test(parametri(rAcelasi).eroare || ""), unde(rAcelasi));
  const rMutat = await pune(PA, [L(1, 2, 1)]);
  egal("mutat: stă doar pe locul nou", locurilePaletului(PA), [A(1, 2, 1)]);
  bine("…și mesajul spune de unde și unde", /s-a mutat de pe R97-01-1-2 pe R97-01-2-1/.test(parametri(rMutat).ok || ""), parametri(rMutat).ok);
  const rDoua = await pune(PA, [L(2, 1, 1), L(2, 1, 2)]);
  bine("un palet de un loc nu se mută pe două", /ține 1 loc/.test(parametri(rDoua).eroare || "") && locurilePaletului(PA).join() === A(1, 2, 1), unde(rDoua));
  // Paletul lat: două locuri lipite.
  const ppLat = (await cer("get", `${BAZA}/intrare/palet/${PB}`, DEPOZIT, { query: { lat: "2" } })).corp;
  const propusLat = (ppLat.match(/class="sc-propus" href="[^"]*loc=([\d%C,]+)/) || [])[1];
  const idsLat = decodeURIComponent(propusLat || "").split(",").map(Number);
  const lipite = q(`SELECT rand_id, nivel, camp, pozitie FROM ct_locuri WHERE id IN (${idsLat.join(",") || 0}) ORDER BY pozitie`);
  bine("pentru un palet de două locuri propune două poziții lipite", lipite.length === 2 && lipite[0].camp === lipite[1].camp && lipite[0].nivel === lipite[1].nivel && Number(lipite[1].pozitie) === Number(lipite[0].pozitie) + 1, propusLat);
  const peLat = await cer("get", `${BAZA}/intrare/palet/${PB}`, DEPOZIT, { query: { lat: "2", loc: String(L(2, 1, 1)), cod: A(2, 1, 2) } });
  egal("al doilea loc scanat se adună la primul", parametri(peLat).loc, `${L(2, 1, 1)},${L(2, 1, 2)}`);
  const peLat3 = await cer("get", `${BAZA}/intrare/palet/${PB}`, DEPOZIT, { query: { lat: "2", loc: `${L(2, 1, 1)},${L(2, 1, 2)}`, cod: A(2, 1, 3) } });
  bine("al treilea, la un palet de două: eroare", /ține 2 locuri/.test(parametri(peLat3).eroare || ""));
  const rRupt = await pune(PB, [L(2, 1, 1), L(2, 1, 3)], { lat: "2" });
  bine("locuri nelipite: refuzat, nimic scris", /nu sunt lipite/.test(parametri(rRupt).eroare || "") && locurilePaletului(PB).length === 0, unde(rRupt));
  await pune(PB, [L(2, 1, 1), L(2, 1, 2)], { lat: "2" });
  egal("paletul lat stă pe cele două locuri", locurilePaletului(PB), [A(2, 1, 1), A(2, 1, 2)]);

  // ------------------------------------------------------------------------
  console.log("\n6. Marfa din producție, fără palet: cantitate + loc");
  const pr = await cer("get", `${BAZA}/intrare/rand/r${RL_P}`, DEPOZIT);
  bine("pagina rândului: 600 buc de pus, cantitatea completată", pr.cod === 200 && /de pus <strong>600 buc<\/strong>/.test(pr.corp) && /name="cant"[^>]*value="600"/.test(pr.corp));
  const peRand = (cheie, body) => cer("post", `${BAZA}/intrare/rand/${cheie}`, DEPOZIT, { body });
  const nrP2 = () => Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE produs_id = ${P2}`));
  const e1 = await peRand(`r${RL_P}`, { actiune: "loc", cant: "250", locuri: "" });
  bine("fără loc: eroare, fără palet", /Scanează locul/.test(parametri(e1).eroare || "") && nrP2() === 0);
  const e2 = await peRand(`r${RL_P}`, { actiune: "loc", cant: "50 + 50", locuri: String(L(2, 2, 1)) });
  bine("două cantități pe un loc: eroare care spune ce să faci, fără palet", /Scrie o singură cantitate/.test(parametri(e2).eroare || "") && nrP2() === 0, parametri(e2).eroare);
  const e3 = await peRand(`r${RL_P}`, { actiune: "loc", cant: "zece", locuri: String(L(2, 2, 1)) });
  bine("cantitate necitibilă: eroare, fără palet", /Scrie cât e pe palet/.test(parametri(e3).eroare || "") && nrP2() === 0);
  const e4 = await peRand(`r${RL_P}`, { actiune: "loc", cant: "250", locuri: String(L(1, 1, 1)) });
  bine("loc ocupat: eroare, fără palet și recepția rămâne nenumărată", /stă deja altă marfă/.test(parametri(e4).eroare || "") && nrP2() === 0 && unul(`SELECT stare FROM receptii WHERE id = ${REC_P}`) === "asteptata", unde(e4));
  bine("eroarea păstrează ce a scris omul", parametri(e4).cant === "250" && parametri(e4).loc === String(L(1, 1, 1)), unde(e4));
  const okP = await peRand(`r${RL_P}`, { actiune: "loc", cant: "250", locuri: String(L(2, 2, 1)) });
  const palP = q(`SELECT id, cod, cantitate, receptie_linie_id, categorie FROM ct_paleti WHERE produs_id = ${P2} ORDER BY id`);
  egal("un palet de 250, legat de rândul recepției, ca produs finit", [palP.length, Number(palP[0] && palP[0].cantitate), Number(palP[0] && palP[0].receptie_linie_id), palP[0] && palP[0].categorie], [1, 250, RL_P, "produse finite"]);
  const PP = Number(palP[0].id);
  egal("…pe locul scanat", locurilePaletului(PP), [A(2, 2, 1)]);
  egal("recepția din producție s-a numărat „cum a fost anunțată”", unul(`SELECT stare FROM receptii WHERE id = ${REC_P}`), "finalizata");
  bine("terminalul rămâne pe marfă și spune cât mai e", adresa(okP).pathname === `${BAZA}/intrare/rand/r${RL_P}` && /Mai sunt de pus 350 buc/.test(parametri(okP).ok || ""), unde(okP));
  const coada = () => q(`SELECT id, fel, titlu, url, tiparit_la, eroare FROM ct_tipar WHERE creat_de = '${DEPOZIT.nume}' ORDER BY id`);
  egal("eticheta paletului e la tipărit", coada().map((c) => [c.fel, c.url]), [["etichete", `/stocuri/ct-park/etichete?paleti=${PP}`]]);
  const okPal = await peRand(`r${RL_P}`, { actiune: "paleti", cant: "100 + 100", locuri: String(L(2, 2, 2)) });
  const faraP2 = paletiFaraLoc(P2);
  egal("„doar paleți”: doi paleți de 100, fără loc, chiar dacă era un loc ales", faraP2.map((p) => Number(p.cantitate)), [100, 100]);
  bine("…și mesajul spune ce urmează", adresa(okPal).pathname === `${BAZA}/intrare` && /2 paleți făcuți/.test(parametri(okPal).ok || "") && /lipește-le/.test(parametri(okPal).ok || ""), unde(okPal));
  egal("etichetele lor sunt la tipărit", coada().length, 2);
  const direct = await SC.faPaleti(DEPOZIT, `r${RL_P}`, [10, 10], [L(2, 2, 2)]);
  bine("doi paleți pe același loc nu se fac nici chemat de-a dreptul", /un singur palet/.test(direct.eroare || "") && nrP2() === 3, JSON.stringify(direct));
  const ePrea = await peRand(`r${RL_P}`, { actiune: "loc", cant: "999", locuri: String(L(2, 2, 2)) });
  bine("mai mult decât a rămas: întâi întreabă, fără palet", /Ai scris 999 buc, dar mai erau de pus 150 buc — cu 849 buc mai mult\./.test(parametri(ePrea).eroare || "") && nrP2() === 3, unde(ePrea));
  egal("…ține minte locul, cantitatea și suma de confirmat", [parametri(ePrea).loc, parametri(ePrea).cant, parametri(ePrea).peste], [String(L(2, 2, 2)), "999", "999"]);
  const propP2 = (await cer("get", `${BAZA}/intrare/rand/r${RL_P}`, DEPOZIT)).corp;
  bine("locul propus pentru restul: lângă același produs", /lângă același produs/.test((propP2.match(/class="sc-propus"[\s\S]*?<\/a>/) || [""])[0]), (propP2.match(/class="sc-propus"[\s\S]*?<\/a>/) || [""])[0]);

  // ------------------------------------------------------------------------
  console.log("\n7. Cererea depozitului, gata în producție");
  const okC = await peRand(`c${A_GATA}`, { actiune: "loc", cant: "40", locuri: String(L(2, 2, 2)) });
  const palC = q(`SELECT id, cantitate, aprovizionare_id FROM ct_paleti WHERE produs_id = ${P3}`);
  egal("paletul cererii: 40 buc, legat de cerere, pe locul scanat", [palC.length, Number(palC[0] && palC[0].cantitate), Number(palC[0] && palC[0].aprovizionare_id), locurilePaletului(palC[0] && palC[0].id)], [1, 40, A_GATA, [A(2, 2, 2)]]);
  egal("cererea e „intrată în stoc”", unul(`SELECT status FROM aprovizionari WHERE id = ${A_GATA}`), "primita");
  bine("mai sunt 50 de pus din ea", /Mai sunt de pus 50 buc/.test(parametri(okC).ok || ""), parametri(okC).ok);
  bine("un rând care nu mai există: înapoi la listă", /nu mai e de pus/.test(parametri(await cer("get", `${BAZA}/intrare/rand/r999999999`, DEPOZIT)).eroare || ""));

  // ------------------------------------------------------------------------
  console.log("\n8. Ieșirea");
  const ies = await cer("get", `${BAZA}/iesire`, DEPOZIT);
  bine("pagina de ieșire se deschide, cu câmpul de scanat", ies.cod === 200 && /id="sc-cod"/.test(ies.corp));
  const scanI = (cod) => cer("get", `${BAZA}/iesire`, DEPOZIT, { query: { cod } });
  egal("scanez paletul", unde(await scanI(COD_VECHI)), `${BAZA}/iesire/palet/${VECHI}`);
  egal("scanez locul pe care stă", unde(await scanI(A(1, 2, 1))), `${BAZA}/iesire/palet/${PA}`);
  bine("loc gol: eroare", /Locul R97-01-1-3 e gol/.test(parametri(await scanI(A(1, 1, 3))).eroare || ""));
  bine("loc care nu există: eroare", /nu există pe hartă/.test(parametri(await scanI("R97-09-9-9")).eroare || ""));
  bine("palet care nu există: eroare", /nu există în CT-Park/.test(parametri(await scanI("CT990101-999999")).eroare || ""));
  const listaI = await scanI(`${PREFIX}-P1`);
  const ordine = [...listaI.corp.matchAll(/href="\/stocuri\/ct-park\/scaner\/iesire\/palet\/(\d+)">\s*<strong>/g)].map((m) => Number(m[1])).filter((id) => [VECHI, PA, PB].includes(id));
  egal("codul produsului: paleții lui, cel mai vechi primul", ordine.slice(0, 3), [VECHI, PA, PB]);
  bine("…cu „primul la rând” pe cel vechi", new RegExp(`${COD_VECHI}</strong>[^<]*<span class="badge verde">primul la rând`).test(listaI.corp));

  const pi = (await cer("get", `${BAZA}/iesire/palet/${PA}`, DEPOZIT)).corp;
  bine("paletul mai nou: avertisment că nu e primul la rând, cu cel vechi și locul lui", /Nu e primul la rând/.test(pi) && pi.includes(COD_VECHI) && pi.includes("(R97-01-1-1)") && /name="peste_rand" required/.test(pi));
  const optiuni = [...pi.matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [Number(m[1]), m[2]]).filter(([id]) => [CMD, CMD2].includes(id));
  egal("comanda care are produsul e prima, cu ✓", optiuni.map(([id, t]) => [id, t.startsWith("✓")]), [[CMD, true], [CMD2, false]]);
  bine("trei destinații: comandă, fulfillment, producție", ["comanda", "fulfillment", "productie"].every((d) => pi.includes(`name="destinatie" value="${d}"`)));
  bine("cantitatea vine completată cu tot paletul", /name="q"[^>]*value="400"/.test(pi));
  const scoate = (id, body) => cer("post", `${BAZA}/iesire/palet/${id}`, DEPOZIT, { body });
  const stare = (id) => q(`SELECT cantitate, data_iesire FROM ct_paleti WHERE id = ${id}`)[0];
  const nrIesiri = () => Number(unul(`SELECT COUNT(*) FROM ct_iesiri WHERE palet_id IN (${VECHI}, ${PA}, ${PB})`));
  const f1 = await scoate(PA, { q: "100" });
  bine("fără destinație: eroare, nimic nu iese", /Alege unde se duce marfa/.test(parametri(f1).eroare || "") && nrIesiri() === 0, unde(f1));
  const f2 = await scoate(PA, { destinatie: "comanda", q: "100" });
  bine("comandă fără comandă aleasă: eroare", /trebuie aleasă exact comanda/.test(parametri(f2).eroare || "") && nrIesiri() === 0, unde(f2));
  const f3 = await scoate(PA, { destinatie: "fulfillment", q: "9999" });
  bine("mai mult decât e pe palet: eroare, cu ce a scris omul păstrat", /Pe palet sunt doar 400 kg/.test(parametri(f3).eroare || "") && parametri(f3).q === "9999" && parametri(f3).destinatie === "fulfillment" && nrIesiri() === 0, unde(f3));
  const f4 = await scoate(PA, { destinatie: "fulfillment", q: "zero" });
  bine("cantitate necitibilă: eroare", /Scrie cât pleacă/.test(parametri(f4).eroare || "") && nrIesiri() === 0);

  // O parte, pe comanda clientului, peste rând.
  const o1 = await scoate(PA, { destinatie: "comanda", comanda_id: String(CMD), q: "150", peste_rand: "cel vechi e blocat în spate", observatii: "ridicat de curier" });
  egal("150 din 400: paletul rămâne pe loc, cu 250", [Number(stare(PA).cantitate), stare(PA).data_iesire, locurilePaletului(PA)], [250, null, [A(1, 2, 1)]]);
  const i1 = q(`SELECT destinatie, comanda_id, partiala, aviz_id, peste_rand, observatii FROM ct_iesiri WHERE palet_id = ${PA} ORDER BY id DESC LIMIT 1`)[0];
  egal("ieșirea e scrisă pe comandă, ca parțială", [i1.destinatie, Number(i1.comanda_id), Number(i1.partiala)], ["comanda", CMD, 1]);
  bine("motivul săririi peste rând rămâne pe ieșire", /mai vechi/.test(i1.peste_rand || "") && /blocat în spate/.test(i1.peste_rand || ""), i1.peste_rand);
  const aviz1 = Number(i1.aviz_id);
  egal("avizul are 150 kg din produs", q(`SELECT produs_id, cantitate FROM avize_linii WHERE aviz_id = ${aviz1}`).map((l) => [Number(l.produs_id), Number(l.cantitate)]), [[P1, 150]]);
  const g1 = parametri(o1);
  egal("terminalul ajunge la „ieșire făcută”, cu avizul și comanda", [adresa(o1).pathname, Number(g1.aviz), Number(g1.comanda), g1.intreg || ""], [`${BAZA}/iesire/gata`, aviz1, CMD, ""]);
  const a4 = () => coada().filter((c) => c.fel === "a4").map((c) => c.url);
  egal("la tipărit: avizul și comanda clientului", a4(), [`/stocuri/ct-park/aviz/${aviz1}`, `/stocuri/ct-park/comanda/${CMD}/foaie`]);
  bine("…cu numărul comenzii în titlu, nu cu id-ul ei", coada().filter((c) => c.fel === "a4").every((c) => /comanda TSC-CMD-1$/.test(c.titlu)), coada().map((c) => c.titlu).join(" | "));
  const gata = await urmeaza(o1, DEPOZIT);
  bine("pagina de după: avizul, comanda clientului, următorul palet", gata.cod === 200 && gata.corp.includes(`/stocuri/ct-park/aviz/${aviz1}`) && gata.corp.includes(`/stocuri/ct-park/comanda/${CMD}/foaie`) && /URMĂTORUL PALET/.test(gata.corp) && /Mai scoate din același palet/.test(gata.corp));

  // Întreg, pe comandă.
  const o2 = await scoate(VECHI, { destinatie: "comanda", comanda_id: String(CMD), q: "500" });
  bine("paletul vechi iese întreg și locul lui se eliberează", stare(VECHI).data_iesire === azi() && locurilePaletului(VECHI).length === 0, JSON.stringify(stare(VECHI)));
  const i2 = q(`SELECT aviz_id, peste_rand, COALESCE(partiala, 0) AS partiala FROM ct_iesiri WHERE palet_id = ${VECHI}`)[0];
  egal("ieșire întreagă, fără „peste rând” (era cel mai vechi)", [Number(i2.partiala), i2.peste_rand], [0, null]);
  egal("…cu al doilea aviz, de 500 kg", q(`SELECT cantitate FROM avize_linii WHERE aviz_id = ${Number(i2.aviz_id)}`).map((l) => Number(l.cantitate)), [500]);
  egal("terminalul: ieșire făcută, palet întreg", [parametri(o2).intreg, Number(parametri(o2).aviz)], ["1", Number(i2.aviz_id)]);
  egal("la tipărit s-au adăugat avizul al doilea și comanda", a4().slice(2), [`/stocuri/ct-park/aviz/${Number(i2.aviz_id)}`, `/stocuri/ct-park/comanda/${CMD}/foaie`]);

  // Întreg, în fulfillment, palet lat.
  const o3 = await scoate(PB, { destinatie: "fulfillment" });
  bine("paletul lat iese în fulfillment și eliberează amândouă locurile", stare(PB).data_iesire === azi() && locurilePaletului(PB).length === 0);
  egal("fără aviz; la tipărit merge eticheta de ieșire", [parametri(o3).aviz || "", a4().slice(4)], ["", [`/stocuri/ct-park/etichete?paleti=${PB}`]]);
  bine("mesajul spune ce a ieșit și unde", new RegExp(`${COD_B} \\(400 kg ${PREFIX} Folie stretch 23my\\) a ieșit spre fulfillment`).test(parametri(o3).ok || ""), parametri(o3).ok);
  // O parte în producție: fără hârtii.
  const pi2 = (await cer("get", `${BAZA}/iesire/palet/${PA}`, DEPOZIT)).corp;
  bine("rămas singur din marfa lui: fără avertisment de rând", !/Nu e primul la rând/.test(pi2) && /name="q"[^>]*value="250"/.test(pi2));
  const o4 = await scoate(PA, { destinatie: "productie", q: "50" });
  egal("50 în producție: rămân 200, nimic nou la tipărit", [Number(stare(PA).cantitate), a4().length, parametri(o4).intreg || ""], [200, 5, ""]);
  const o5 = await scoate(PA, { destinatie: "productie", q: "200" });
  bine("restul de 200: paletul iese de tot", stare(PA).data_iesire === azi() && locurilePaletului(PA).length === 0 && parametri(o5).intreg === "1");
  egal("…cu eticheta lui de ieșire la tipărit", a4().slice(5), [`/stocuri/ct-park/etichete?paleti=${PA}`]);
  bine("palet ieșit, scanat la ieșire: eroare", /a ieșit deja din depozit/.test(parametri(await scanI(COD_A)).eroare || ""));
  bine("palet ieșit, scanat la intrare: eroare", /a ieșit din depozit/.test(parametri(await scan(COD_A)).eroare || ""));
  bine("pagina unui palet ieșit trimite înapoi", /a ieșit deja/.test(parametri(await cer("get", `${BAZA}/iesire/palet/${PA}`, DEPOZIT)).eroare || ""));
  const rIesit = await pune(PA, [L(1, 1, 2)]);
  bine("un palet ieșit nu se mai pune pe raft", /a ieșit din depozit/.test(parametri(rIesit).eroare || "") && locurilePaletului(PA).length === 0, unde(rIesit));
  const dublu = await scoate(PA, { destinatie: "productie" });
  bine("a doua ieșire a aceluiași palet e refuzată", /a ieșit deja/.test(parametri(dublu).eroare || "") && Number(unul(`SELECT COUNT(*) FROM ct_iesiri WHERE palet_id = ${PA}`)) === 3);

  // ------------------------------------------------------------------------
  console.log("\n9. Comanda clientului, de tipărit");
  const foaie = await cer("get", `/stocuri/ct-park/comanda/${CMD}/foaie`, DEPOZIT);
  egal("foaia se deschide", foaie.cod, 200);
  const f = foaie.corp;
  bine("numărul comenzii, clientul și adresa lui", f.includes(`COMANDĂ CLIENT ${PREFIX}-CMD-1`) && f.includes(`${PREFIX} Client SRL`) && f.includes("Str. Testului 7, Craiova"));
  const randF = (f.match(/<tr>\s*<td class="n">1<\/td>[\s\S]*?<\/tr>/) || [""])[0].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  bine("rândul: comandat 700, plecat 650, rămas 50", /TSC Folie stretch 23my kg 700 650 50/.test(randF), randF);
  bine("fără prețuri", !/123[,.]45/.test(f));
  bine("codul de bare al comenzii și al produsului", (f.match(/<svg/g) || []).length === 2);
  bine("avizele comenzii sunt scrise", (f.match(/avize: [A-Z]+ \d+, [A-Z]+ \d+/) || []).length === 1, (f.match(/avize:[^<]*/) || [""])[0]);
  egal("comandă care nu există", (await cer("get", "/stocuri/ct-park/comanda/999999999/foaie", DEPOZIT)).cod, 404);

  // ------------------------------------------------------------------------
  console.log("\n10. De tipărit");
  const TIPAR = "/stocuri/ct-park/tipar";
  const pt = await cer("get", TIPAR, DEPOZIT);
  bine("pagina arată ce așteaptă", pt.cod === 200 && /Avizul [A-Z]+ \d+ — comanda TSC-CMD-1/.test(pt.corp) && /Comanda clientului — comanda TSC-CMD-1/.test(pt.corp) && /Eticheta paletului/.test(pt.corp) && /așteaptă<\/span>/.test(pt.corp));
  const noi = async (fel) => JSON.parse((await cer("get", `${TIPAR}/noi.json`, DEPOZIT, { query: fel ? { fel } : {} })).corp).documente.filter((d) => coada().some((c) => Number(c.id) === d.id));
  egal("documentele A4 care așteaptă: două avize, comanda de două ori, două etichete de ieșire", (await noi("a4")).length, 6);
  egal("etichetele care așteaptă", (await noi("etichete")).map((d) => d.fel), ["etichete", "etichete", "etichete"]);
  egal("fără filtru: toate", (await noi()).length, 9);
  const primul = (await noi("a4"))[0];
  const m1 = await cer("post", `${TIPAR}/${primul.id}/tiparit`, DEPOZIT, { body: { eroare: "documentul nu s-a încărcat" } });
  bine("o eroare nu marchează documentul ca tipărit", m1.cod === 200 && (await noi("a4")).some((d) => d.id === primul.id) && coada().find((c) => Number(c.id) === primul.id).eroare === "documentul nu s-a încărcat");
  await cer("post", `${TIPAR}/${primul.id}/tiparit`, DEPOZIT, { body: { eroare: "" } });
  const dupa = coada().find((c) => Number(c.id) === primul.id);
  bine("tipărit: nu mai e în coadă, eroarea s-a șters", !(await noi("a4")).some((d) => d.id === primul.id) && dupa.tiparit_la && dupa.eroare === null, JSON.stringify(dupa));
  const vechi = Number(unul(`INSERT INTO ct_tipar (fel, titlu, url, creat_la, creat_de) VALUES ('a4', 'TSC vechi', '/stocuri/ct-park/aviz/1', '2026-11-01 08:00:00', '${PREFIX} vechi') RETURNING id`));
  const toateNoi = JSON.parse((await cer("get", `${TIPAR}/noi.json`, DEPOZIT)).corp).documente;
  bine("ce e mai vechi de o zi și jumătate nu mai iese singur", !toateNoi.some((d) => d.id === vechi));
  egal("o adresă din afara ERP-ului nu intră la tipărit", await SC.laTipar("a4", "x", "https://alt.site/x", DEPOZIT), null);
  egal("…nici una „//alt.site”", await SC.laTipar("a4", "x", "//alt.site/x", DEPOZIT), null);
  const nv = await cer("get", `${TIPAR}/noi.json`, VANZARI);
  egal("agentul de vânzări nu vede coada", [nv.cod, nv.corp], [403, "{}"]);
  const mv = await cer("post", `${TIPAR}/${(await noi("a4"))[0].id}/tiparit`, VANZARI, { body: {} });
  bine("…și nu poate marca nimic", mv.cod === 403 && (await noi("a4")).length === 5);

  // ------------------------------------------------------------------------
  console.log("\n11. Etichetele locurilor");
  const idx = await cer("get", "/stocuri/ct-park/locuri/etichete", DEPOZIT);
  bine("lista de rânduri, cu rândul de test", idx.cod === 200 && idx.corp.includes(`/stocuri/ct-park/locuri/etichete?rand=${RAND}`) && /la înălțimea ochilor/.test(idx.corp));
  const le = await cer("get", "/stocuri/ct-park/locuri/etichete", DEPOZIT, { query: { rand: String(RAND) } });
  const adrese = [...le.corp.matchAll(/<div class="le-adresa">([^<]+)</g)].map((m) => m[1]);
  egal("12 etichete, câte una pe loc, cu codul ei de bare", [adrese.length, (le.corp.match(/<svg/g) || []).length], [12, 12]);
  egal("în ordinea de pe stâlp: câmp, poziție, nivelul de sus întâi", adrese.slice(0, 4), [A(1, 2, 1), A(1, 1, 1), A(1, 2, 2), A(1, 1, 2)]);
  bine("nivelul e scris mare, cu săgeată pentru cele de sus", /<div class="le-nivel"><span>NIVEL<\/span><b>2<\/b><i>▲<\/i><\/div>/.test(le.corp) && /<b>1<\/b><i>jos<\/i>/.test(le.corp));
  bine("format A4", /size: A4/.test(le.corp));
  const lz = await cer("get", "/stocuri/ct-park/locuri/etichete", DEPOZIT, { query: { rand: String(RAND), format: "zebra" } });
  bine("format Zebra 100 × 150", /size: 100mm 150mm/.test(lz.corp) && (lz.corp.match(/<div class="le">/g) || []).length === 12);
  const ln = await cer("get", "/stocuri/ct-park/locuri/etichete", DEPOZIT, { query: { rand: String(RAND), nivel: "1", camp: "2" } });
  egal("doar nivelul 1 din câmpul 2", [...ln.corp.matchAll(/<div class="le-adresa">([^<]+)</g)].map((m) => m[1]), [A(2, 1, 1), A(2, 1, 2), A(2, 1, 3)]);

  // ------------------------------------------------------------------------
  console.log("\n12. Un loc scanat de oriunde din ERP");
  const PPcod = unul(`SELECT cod FROM ct_paleti WHERE id = ${PP}`);
  egal("loc cu marfă: la ieșirea paletului de pe el", unde(await cer("get", `${BAZA}/loc`, DEPOZIT, { query: { cod: A(2, 2, 1).toLowerCase() } })), `${BAZA}/iesire/palet/${PP}`);
  egal("loc liber: ales pentru intrare", unde(await cer("get", `${BAZA}/loc`, DEPOZIT, { query: { cod: A(1, 1, 1) } })), `${BAZA}/intrare?cod=${encodeURIComponent(A(1, 1, 1))}`);
  bine("loc necunoscut: eroare", /nu există pe hartă/.test(parametri(await cer("get", `${BAZA}/loc`, DEPOZIT, { query: { cod: "R97-09-9-9" } })).eroare || ""));
  const dinScan = await cer("get", "/scan", DEPOZIT, { query: { cod: A(2, 2, 1) } });
  egal("/scan cu eticheta unui loc duce la scaner", unde(dinScan), `${BAZA}/loc?cod=${encodeURIComponent(A(2, 2, 1))}`);
  bine("paletul de pe loc e cel al producției", Boolean(PPcod) && SC.ePalet(PPcod));

  // ------------------------------------------------------------------------
  console.log("\n13. Cine n-are depozitul");
  for (const cale of [BAZA, `${BAZA}/intrare`, `${BAZA}/iesire`, `${BAZA}/intrare/palet/${PP}`, `${BAZA}/iesire/palet/${PP}`, "/stocuri/ct-park/tipar", "/stocuri/ct-park/locuri/etichete", `/stocuri/ct-park/comanda/${CMD}/foaie`]) {
    const r = await cer("get", cale, VANZARI);
    bine(`vânzări, ${cale.replace(BAZA, "…/scaner") || "/"}: trimis la depozit, fără pagină`, r.cod === 302 && unde(r) === "/stocuri/ct-park" && !r.corp, r.cod + " " + unde(r));
  }
  const inainte = JSON.stringify([locurilePaletului(PP), stare(PP)]);
  await cer("post", `${BAZA}/intrare/palet/${PP}`, VANZARI, { body: { locuri: String(L(1, 1, 1)) } });
  await cer("post", `${BAZA}/iesire/palet/${PP}`, VANZARI, { body: { destinatie: "fulfillment" } });
  await cer("post", `${BAZA}/intrare/rand/r${RL_P}`, VANZARI, { body: { actiune: "loc", cant: "10", locuri: String(L(1, 1, 1)) } });
  egal("vânzări: nici mutare, nici ieșire, nici palet nou", [JSON.stringify([locurilePaletului(PP), stare(PP)]), nrP2()], [inainte, 3]);

  // ------------------------------------------------------------------------
  console.log("\n14. În browser, pe ecranul terminalului");
  const { chromium } = require("playwright");
  const fs = require("fs");
  const br = await chromium.launch();
  try {
    const ctx = await br.newContext({ viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    await page.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/style.css") return route.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(RAD, "public", "style.css")) });
      if (!u.pathname.startsWith("/stocuri/")) return route.fulfill({ status: 204, body: "" });
      const metoda = route.request().method().toLowerCase();
      const body = metoda === "post" ? Object.fromEntries(new URLSearchParams(route.request().postData() || "")) : {};
      const r = await cer(metoda, u.pathname, DEPOZIT, { query: Object.fromEntries(u.searchParams), body });
      // Redirecționarea se face din pagină: un 302 dat de aici ar pleca spre
      // rețea fără să mai treacă prin ruta asta.
      if (r.cod === 302) return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<script>location.replace(${JSON.stringify(unde(r))})</script>` });
      return route.fulfill({ status: r.cod || 200, contentType: (r.antet && r.antet["Content-Type"]) || "text/html; charset=utf-8", body: r.corp });
    });
    const lat = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const [palNou] = (await SC.faPaleti(DEPOZIT, `r${RL_F}`, [200], [])).ids;
    const codNou = unul(`SELECT cod FROM ct_paleti WHERE id = ${palNou}`);

    await page.goto(`http://erp.test${BAZA}`);
    bine("acasă: nimic nu iese din ecran", await lat());
    await page.click("a.sc-intrare");
    await page.waitForURL(`**${BAZA}/intrare`);
    bine("intrare: câmpul de scanat e gata, nimic nu iese din ecran", (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "sc-cod" && (await lat()));
    // Cititorul: tastează codul și dă Enter.
    await page.keyboard.type(codNou, { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForURL(`**${BAZA}/intrare/palet/${palNou}`);
    bine("paletul scanat se deschide; nimic nu iese din ecran", page.url().endsWith(`/intrare/palet/${palNou}`) && (await lat()));
    // Focusul pierdut (o atingere pe pagină): cititorul tot în câmp scrie.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.type(A(1, 1, 3), { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => u.searchParams.get("loc") === String(L(1, 1, 3)));
    bine("locul scanat cu focusul pierdut ajunge tot în câmp", (await page.textContent(".sc-loc")).includes(A(1, 1, 3)));
    bine("butonul spune unde pune și e pornit", (await page.textContent("button.sc-ok")).includes(`pune pe ${A(1, 1, 3)}`) && !(await page.isDisabled("button.sc-ok")));
    await page.click("button.sc-ok");
    await page.waitForURL((u) => u.pathname === `${BAZA}/intrare`);
    bine("Efectuează: paletul e pe loc, terminalul e înapoi la intrare cu mesajul", locurilePaletului(palNou).join() === A(1, 1, 3) && (await page.textContent(".sc-flash.ok")).includes(`${codNou} e pe ${A(1, 1, 3)}`));
    // Tastatura de pe ecran: se ascunde și rămâne ascunsă.
    egal("la început, tastatura de pe ecran e lăsată", await page.getAttribute("#sc-cod", "inputmode"), "text");
    await page.click("#sc-tast");
    egal("„Ascunde tastatura”: câmpul nu mai cere tastatură", await page.getAttribute("#sc-cod", "inputmode"), "none");
    await page.reload();
    egal("…și alegerea rămâne pe terminal", [await page.getAttribute("#sc-cod", "inputmode"), (await page.textContent("#sc-tast")).trim()], ["none", "Arată tastatura"]);
    // Marfa fără palet: cantitatea scrisă nu se pierde când alegi locul propus.
    await page.goto(`http://erp.test${BAZA}/intrare/rand/c${A_GATA}`);
    await page.fill('input[name="cant"][data-tine]', "12,5");
    await page.click("a.sc-propus");
    await page.waitForURL((u) => u.searchParams.has("loc"));
    egal("cantitatea scrisă rămâne după alegerea locului propus", await page.inputValue('input[name="cant"][data-tine]'), "12,5");
    await page.fill('input[name="cant"][data-tine]', "30");
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.type(A(1, 1, 1), { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => u.searchParams.get("loc") === String(L(1, 1, 1)));
    egal("…și după scanarea altui loc", await page.inputValue('input[name="cant"][data-tine]'), "30");
    bine("pagina mărfii: nimic nu iese din ecran", await lat());
    await page.click('button[name="actiune"][value="loc"]');
    await page.waitForURL((u) => u.searchParams.has("ok"));
    const palC2 = q(`SELECT id, cantitate FROM ct_paleti WHERE produs_id = ${P3} ORDER BY id DESC LIMIT 1`)[0];
    egal("Efectuează: palet de 30 pe locul scanat", [Number(palC2.cantitate), locurilePaletului(palC2.id)], [30, [A(1, 1, 1)]]);
    // Ieșirea, până la capăt.
    await page.goto(`http://erp.test${BAZA}/iesire`);
    await page.keyboard.type(A(1, 1, 3), { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForURL(`**${BAZA}/iesire/palet/${palNou}`);
    bine("ieșire: locul scanat deschide paletul de pe el; nimic nu iese din ecran", await lat());
    bine("comanda apare doar când destinația e „Comandă”", await page.isHidden("#sc-comanda"));
    await page.check('input[name="destinatie"][value="comanda"]');
    bine("…și atunci e obligatorie", (await page.isVisible("#sc-comanda")) && (await page.evaluate(() => document.querySelector('select[name="comanda_id"]').required)));
    await page.selectOption('select[name="comanda_id"]', String(CMD));
    await page.fill('input[name="q"]', "50");
    await page.click("button.sc-ok.iesire");
    await page.waitForURL((u) => u.pathname === `${BAZA}/iesire/gata`);
    bine("ieșire făcută: 50 kg pe comandă, cu avizul și comanda de tipărit", Number(stare(palNou).cantitate) === 150 && (await page.textContent(".sc-card")).includes("Comanda clientului") && (await lat()));
    await ctx.close();
  } finally {
    await br.close();
  }

  // ------------------------------------------------------------------------
  // Vali, 10.11.2026: „Cantitatea recepționată poate fi mai mare decât cea din
  // comandă și se salvează cantitatea din recepție."
  console.log("\n15. Mai mult decât era de pus: scanerul întreabă o dată, apoi face paletul");
  const GP = require(path.join(RAD, "lib", "gata-productie.js"));
  egal("după ieșirea parțială de 50 kg din paletul făcut la recepție, rândul recepției nu reapare ca „de pus”",
    [await SC.randDeAsezat(`r${RL_F}`), (await GP.receptiiFurnizori()).filter((x) => x.id === RL_F).length], [null, 0]);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P4}, '${PREFIX}-P4', '${PREFIX} Sac menaj', 'buc')`);
  q(`UPDATE produse SET pret_achizitie = 2 WHERE id = ${P4}`);
  const receptieNoua = (numar, sursa, stare) => Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare, finalizata_la) VALUES ('${PREFIX}-${numar}', '${sursa}', ${sursa === "furnizor" ? FURNIZOR : "NULL"}, '${azi()}', '${stare}', ${stare === "finalizata" ? "'" + azi() + " 09:00:00'" : "NULL"}) RETURNING id`));
  const linieNoua = (rid, anuntat, primit) => Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie) VALUES (${rid}, ${P4}, ${anuntat}, ${primit == null ? "NULL" : primit}, 'buc', '${primit == null ? "de_primit" : "primita"}', ${primit == null ? "NULL" : "'bun'"}) RETURNING id`));
  const paletiRand = (lid) => q(`SELECT cantitate, cantitate_intrare FROM ct_paleti WHERE receptie_linie_id = ${lid} ORDER BY id`).map((p) => [Number(p.cantitate), Number(p.cantitate_intrare)]);
  const primitPe = (lid) => Number(unul(`SELECT cantitate_primita FROM receptii_linii WHERE id = ${lid}`));
  const miscariRec = (numar) => q(`SELECT cantitate FROM miscari_stoc WHERE produs_id = ${P4} AND document_ref = '${PREFIX}-${numar}' ORDER BY id`).map((x) => Number(x.cantitate));
  // Din producție, anunțată cu 100 buc, încă nenumărată.
  const REC_X = receptieNoua("REC-X", "productie", "asteptata");
  const RL_X = linieNoua(REC_X, 100, null);
  await peRand(`r${RL_X}`, { actiune: "paleti", cant: "60" });
  egal("60 din 100 pe un palet: rămân 40 de pus, recepția arată 100", [paletiRand(RL_X), primitPe(RL_X), (await SC.randDeAsezat(`r${RL_X}`)).ramas], [[[60, 60]], 100, 40]);
  const x1 = await peRand(`r${RL_X}`, { actiune: "paleti", cant: "65" });
  bine("65 când mai erau 40 de pus: scanerul întreabă, nu face paletul", adresa(x1).pathname === `${BAZA}/intrare/rand/r${RL_X}` && /^Ai scris 65 buc, dar mai erau de pus 40 buc — cu 25 buc mai mult\. /.test(parametri(x1).eroare || "") && paletiRand(RL_X).length === 1, unde(x1));
  bine("…spune cum se confirmă", /Dacă atât e pe palet, apasă încă o dată: se salvează cantitatea de pe palet\.$/.test(parametri(x1).eroare || ""), parametri(x1).eroare);
  egal("…ține minte ce a scris omul și suma de confirmat", [parametri(x1).cant, parametri(x1).peste], ["65", "65"]);
  const pagX = await cer("get", `${BAZA}/intrare/rand/r${RL_X}`, DEPOZIT, { query: parametri(x1) });
  bine("pagina întoarsă are confirmarea ascunsă, cu aceeași sumă, și cantitatea scrisă de om", /name="confirma_peste" value="65"/.test(pagX.corp) && /name="cant"[^>]*value="65"/.test(pagX.corp) && /sc-flash rau/.test(pagX.corp));
  bine("pagina deschisă normal n-are nicio confirmare", !/confirma_peste/.test((await cer("get", `${BAZA}/intrare/rand/r${RL_X}`, DEPOZIT)).corp));
  const x2 = await peRand(`r${RL_X}`, { actiune: "paleti", cant: "650", confirma_peste: "65" });
  bine("altă cantitate decât cea confirmată (650, un zero în plus): întreabă din nou", /^Ai scris 650 buc, dar mai erau de pus 40 buc — cu 610 buc mai mult\. /.test(parametri(x2).eroare || "") && parametri(x2).peste === "650" && paletiRand(RL_X).length === 1, unde(x2));
  const x2b = await peRand(`r${RL_X}`, { actiune: "paleti", cant: "30 + 35" });
  bine("doi paleți care trec împreună de rest: întreabă la plural", /cu 25 buc mai mult\. Dacă atât e pe paleți, apasă încă o dată: se salvează cantitatea de pe paleți\.$/.test(parametri(x2b).eroare || "") && parametri(x2b).peste === "65" && paletiRand(RL_X).length === 1, parametri(x2b).eroare);
  const x3 = await peRand(`r${RL_X}`, { actiune: "paleti", cant: "65", confirma_peste: "65" });
  egal("a doua apăsare, cu aceeași cantitate: paletul de 65 se face", paletiRand(RL_X), [[60, 60], [65, 65]]);
  bine("…mesajul spune că e peste și că s-a salvat cantitatea de pe palet", adresa(x3).pathname === `${BAZA}/intrare` && /Un palet făcut/.test(parametri(x3).ok || "") && /E cu 25 buc peste cât era de pus: s-a salvat cantitatea de pe palet\.$/.test(parametri(x3).ok || ""), parametri(x3).ok);
  egal("recepția ia cantitatea de pe paleți: 125 primite, 100 anunțate", [primitPe(RL_X), Number(unul(`SELECT cantitate_asteptata FROM receptii_linii WHERE id = ${RL_X}`))], [125, 100]);
  egal("…iar diferența e în mișcările de stoc, sub numărul recepției", miscariRec("REC-X"), [100, 25]);
  bine("rândul nu mai e de pus", (await SC.randDeAsezat(`r${RL_X}`)) === null && /nu mai e de pus/.test(parametri(await cer("get", `${BAZA}/intrare/rand/r${RL_X}`, DEPOZIT)).eroare || ""));
  const x4 = await peRand(`r${RL_X}`, { actiune: "paleti", cant: "10", confirma_peste: "10" });
  bine("după ce tot rândul are palet nu se mai face altul, nici confirmat", /are deja palet/.test(parametri(x4).eroare || "") && paletiRand(RL_X).length === 2, unde(x4));
  // Cu loc scanat: un singur palet, cu mai mult decât era de pus.
  const REC_Y = receptieNoua("REC-Y", "productie", "asteptata");
  const RL_Y = linieNoua(REC_Y, 50, null);
  const locLiber = Number(unul(`SELECT l.id FROM ct_locuri l WHERE l.rand_id = ${RAND} AND COALESCE(l.blocat, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id) ORDER BY l.id LIMIT 1`));
  const adresaLibera = unul(`SELECT adresa FROM ct_locuri WHERE id = ${locLiber}`);
  const y1 = await peRand(`r${RL_Y}`, { actiune: "loc", cant: "80", locuri: String(locLiber) });
  egal("cu loc scanat: întâi întreabă și păstrează locul", [parametri(y1).peste, parametri(y1).loc, paletiRand(RL_Y).length], ["80", String(locLiber), 0]);
  const y2 = await peRand(`r${RL_Y}`, { actiune: "loc", cant: "80", locuri: String(locLiber), confirma_peste: "80" });
  const palY = q(`SELECT id, cantitate FROM ct_paleti WHERE receptie_linie_id = ${RL_Y}`)[0] || {};
  egal("confirmat: paletul de 80 e pe locul scanat, recepția arată 80", [Number(palY.cantitate), locurilePaletului(palY.id), primitPe(RL_Y), miscariRec("REC-Y")], [80, [adresaLibera], 80, [50, 30]]);
  bine("…terminalul se întoarce la intrare (rândul e gata), cu mesajul întreg", adresa(y2).pathname === `${BAZA}/intrare` && new RegExp(` e pe ${adresaLibera}\\. Eticheta lui e la tipărit\\. E cu 30 buc peste cât era de pus: s-a salvat cantitatea de pe palet\\.$`).test(parametri(y2).ok || ""), parametri(y2).ok);
  // Pagina recepției de la furnizor: formularul de paleți, cu bifa.
  const REC_Z = receptieNoua("REC-Z", "furnizor", "finalizata");
  const RL_Z = linieNoua(REC_Z, 200, 200);
  const z1 = await cer("post", `/depozit/receptie/${REC_Z}/paleti`, DEPOZIT, { body: { [`paleti_${RL_Z}`]: "150 + 100" } });
  bine("pagina recepției, 150 + 100 din 200, fără bifă: întreabă, fără paleți", /Ai scris 250 buc, dar mai erau de pus 200 buc — cu 50 buc mai mult\. Dacă a venit mai mult, bifează/.test(parametri(z1).eroare || "") && paletiRand(RL_Z).length === 0, unde(z1));
  const pagZ = (await cer("get", `/depozit/receptie/${REC_Z}`, DEPOZIT)).corp;
  bine("formularul are bifa, cu ce face", /<input type="checkbox" name="peste" value="1"/.test(pagZ) && /se salvează cantitatea de pe paleți/.test(pagZ));
  const z2 = await cer("post", `/depozit/receptie/${REC_Z}/paleti`, DEPOZIT, { body: { [`paleti_${RL_Z}`]: "150 + 100", peste: "1" } });
  egal("cu bifa: doi paleți, de 150 și de 100, și etichetele lor", [paletiRand(RL_Z), /^\/stocuri\/ct-park\/etichete\?paleti=\d+,\d+$/.test(unde(z2))], [[[150, 150], [100, 100]], true]);
  egal("…iar recepția de la furnizor arată 250 primite", [primitPe(RL_Z), miscariRec("REC-Z")], [250, [50]]);
  const pagZ2 = (await cer("get", `/depozit/receptie/${REC_Z}`, DEPOZIT)).corp;
  bine("pagina recepției: 250 primite, +50 față de anunțat, tot pus, fără „pus mai mult decât a venit”", /<strong>250<\/strong>/.test(pagZ2) && /badge galben">\+50</.test(pagZ2) && /tot pus/.test(pagZ2) && !/mai mult decât a venit/.test(pagZ2));
  // Chemat de-a dreptul: fără confirmare întoarce întrebarea, cu cifrele ei.
  const REC_W = receptieNoua("REC-W", "furnizor", "finalizata");
  const RL_W = linieNoua(REC_W, 20, 20);
  const d1 = await SC.faPaleti(DEPOZIT, `r${RL_W}`, [12, 18], []);
  egal("chemat fără confirmare: nu face paleți și întoarce cifrele", [d1.ok, d1.peste, paletiRand(RL_W).length], [undefined, { total: 30, ramas: 20, cu: 10, um: "buc", paleti: 2 }, 0]);
  egal("o confirmare cu altă sumă, goală sau zero nu e confirmare", [
    Boolean((await SC.faPaleti(DEPOZIT, `r${RL_W}`, [12, 18], [], { confirmaPeste: "29.9" })).peste),
    Boolean((await SC.faPaleti(DEPOZIT, `r${RL_W}`, [12, 18], [], { confirmaPeste: "" })).peste),
    Boolean((await SC.faPaleti(DEPOZIT, `r${RL_W}`, [12, 18], [], { confirmaPeste: 0 })).peste),
    Boolean((await SC.faPaleti(DEPOZIT, `r${RL_W}`, [12, 18], [], { peste: "1" })).peste),
    paletiRand(RL_W).length,
  ], [true, true, true, true, 0]);
  const d2 = await SC.faPaleti(DEPOZIT, `r${RL_W}`, [12, 18], [], { peste: true });
  egal("cu `peste: true` (bifa din formulare): paleții se fac", [d2.ok, d2.ids.length, d2.ramas, d2.peste, d2.um, primitPe(RL_W)], [true, 2, 0, 10, "buc", 30]);
  const d3 = await SC.faPaleti(DEPOZIT, `r${RL_X}`, [5], [], { peste: true });
  bine("un rând deja pus tot nu primește alt palet nici așa", /are deja palet/.test(d3.eroare || "") && !d3.peste, JSON.stringify(d3));
  // Sub rest și exact restul: nicio întrebare, recepția neatinsă.
  const REC_V = receptieNoua("REC-V", "furnizor", "finalizata");
  const RL_V = linieNoua(REC_V, 90, 90);
  const v1 = await SC.faPaleti(DEPOZIT, `r${RL_V}`, [40], []);
  const v2 = await SC.faPaleti(DEPOZIT, `r${RL_V}`, [50], []);
  egal("sub rest, apoi exact restul: fără întrebare, fără „peste”, recepția rămâne la 90", [v1.ok, v1.ramas, v1.peste, v2.ok, v2.ramas, v2.peste, primitPe(RL_V), miscariRec("REC-V")], [true, 50, 0, true, 0, 0, 90, []]);
  // Cererea depozitului (fără recepție): la fel, cu confirmare.
  const cerereInainte = await GP.cerere(A_GATA);
  const c1 = await peRand(`c${A_GATA}`, { actiune: "paleti", cant: String(cerereInainte.ramas + 5) });
  bine("cererea depozitului: peste ce a rămas, întâi întreabă", parametri(c1).peste === String(cerereInainte.ramas + 5) && (await GP.cerere(A_GATA)).pus === cerereInainte.pus, unde(c1));
  const c2 = await peRand(`c${A_GATA}`, { actiune: "paleti", cant: String(cerereInainte.ramas + 5), confirma_peste: String(cerereInainte.ramas + 5) });
  const cerereDupa = await GP.cerere(A_GATA);
  egal("…confirmat: paletul se face, iar din cerere nu mai rămâne nimic", [/E cu 5 buc peste cât era de pus/.test(parametri(c2).ok || ""), cerereDupa.pus - cerereInainte.pus, cerereDupa.ramas], [true, cerereInainte.ramas + 5, 0]);
}
