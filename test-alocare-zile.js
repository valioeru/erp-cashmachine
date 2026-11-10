"use strict";
// Orele unei comenzi, împărțite pe zilele libere ale utilajului.
//
// CE A CERUT VALI, 10.11.2026:
//   „La planificare comandă în producție trebuie să aloc orele pentru comandă
//    manual, dar să le distribuie pe parcursul zilelor, pe acea mașină, care
//    sunt libere."
//
// CE APĂRĂ:
//   • SOCOTEALA (lib/alocare-zile.js): orele se așază zi după zi în ce e liber
//     pe utilaj (ore pe zi minus ce e deja alocat); zilele pline se sar;
//     sâmbăta și duminica se sar dacă nu se cere altfel, afară de ziua de
//     pornire; ora de start a zilelor următoare ține cont de ce e deja pe utilaj.
//   • CANTITATEA se împarte după ore și se adună exact la cât s-a scris.
//   • PAGINA are bifa (pusă din oficiu), bifa de weekend și previzualizarea;
//     previzualizarea e aceeași socoteală ca la salvare și nu scrie nimic.
//   • SALVAREA face câte o alocare pe zi; fără bifă rămâne un singur rând, ca
//     înainte; dacă încape în ziua aleasă, tot un singur rând.
//   • OAMENII bifați intră în zilele următoare doar dacă sunt în tură atunci;
//     unde programul zilei nu e scris, rămân puși.
//
// Socoteala fără bază; rutele pe PostgreSQL real (port 5433), prin psql.
const path = require("path");
const qs = require("querystring");
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
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length || (/^\s*UPDATE/i.test(sql) ? 1 : 0) };
  },
});

const rute = { get: {}, post: {} };
const reg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; } };
require(path.join(RAD, "modules", "utilaje.js")).register(reg);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { query, body } = {}) {
  const r = res();
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
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase() } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
function egal(descriere, a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  bine(descriere + " = " + y, x === y, x);
}

const ADMIN = { id: 1, nume: "Vali Test", rol: "admin", sectiuni: "" };

// ---- datele de test ------------------------------------------------------
const AZ = require(path.join(RAD, "lib", "alocare-zile.js"));
const U1 = 98861, U_24 = 98862, U_OPRIT = 98863;
const CMD = 98871, CMD_ALTA = 98872;
const OM_A = 98881, OM_B = 98882, OM_STRAIN = 98883;
// O săptămână departe în viitor, ca să nu se calce cu nimic: luni 01.03.2027.
const LU = "2027-03-01", MA = "2027-03-02", MI = "2027-03-03", JO = "2027-03-04", VI = "2027-03-05", SA = "2027-03-06", DU = "2027-03-07", LU2 = "2027-03-08", MA2 = "2027-03-09";

function curata() {
  q(`DELETE FROM alocari_resurse WHERE alocare_id IN (SELECT id FROM alocari_productie WHERE comanda_productie_id IN (${CMD}, ${CMD_ALTA}))`);
  q(`DELETE FROM alocari_productie WHERE comanda_productie_id IN (${CMD}, ${CMD_ALTA})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${CMD}, ${CMD_ALTA})`);
  q(`DELETE FROM resurse_program WHERE resursa_id IN (${OM_A}, ${OM_B}, ${OM_STRAIN})`);
  q(`DELETE FROM resurse_competente WHERE resursa_id IN (${OM_A}, ${OM_B}, ${OM_STRAIN})`);
  q(`DELETE FROM resurse WHERE id IN (${OM_A}, ${OM_B}, ${OM_STRAIN})`);
  q(`DELETE FROM utilaje WHERE id IN (${U1}, ${U_24}, ${U_OPRIT})`);
}
const alocari = (cmd) =>
  q(`SELECT id, utilaj_id, data, ora_start, ore, cantitate FROM alocari_productie WHERE comanda_productie_id = ${cmd} ORDER BY data, id`).map((x) => [String(x.data).slice(0, 10), Number(x.ora_start), Number(x.ore), x.cantitate == null ? null : Number(x.cantitate)]);
const oameniPe = (cmd) =>
  q(`SELECT a.data, ar.resursa_id FROM alocari_productie a JOIN alocari_resurse ar ON ar.alocare_id = a.id WHERE a.comanda_productie_id = ${cmd} ORDER BY a.data, ar.resursa_id`).map((x) => [String(x.data).slice(0, 10), Number(x.resursa_id)]);
const sterge = (cmd) => {
  q(`DELETE FROM alocari_resurse WHERE alocare_id IN (SELECT id FROM alocari_productie WHERE comanda_productie_id = ${cmd})`);
  q(`DELETE FROM alocari_productie WHERE comanda_productie_id = ${cmd}`);
};

(async () => {
  // ------------------------------------------------------------------------
  console.log("1. Socoteala: orele se așază în zilele libere");
  const pe = (r) => r.bucati.map((b) => [b.data, b.ore]);
  let r = AZ.imparte({ ore: 30, data: LU, oraStart: 8, capZi: 8 });
  egal("30 h pe un utilaj de 8 h/zi, de luni: 8, 8, 8, 6", pe(r), [[LU, 8], [MA, 8], [MI, 8], [JO, 6]]);
  egal("…fără rest și fără zile sărite", [r.rest, r.sarite], [0, []]);
  r = AZ.imparte({ ore: 20, data: JO, oraStart: 8, capZi: 8 });
  egal("de joi, 20 h: joi, vineri, apoi luni — weekendul e sărit", [pe(r), r.sarite], [[[JO, 8], [VI, 8], [LU2, 4]], [{ data: SA, motiv: "weekend" }, { data: DU, motiv: "weekend" }]]);
  r = AZ.imparte({ ore: 20, data: JO, oraStart: 8, capZi: 8, weekend: true });
  egal("cu „se lucrează și în weekend”: joi, vineri, sâmbătă", pe(r), [[JO, 8], [VI, 8], [SA, 4]]);
  r = AZ.imparte({ ore: 12, data: SA, oraStart: 8, capZi: 8 });
  egal("pornită de om într-o sâmbătă: sâmbăta rămâne, duminica se sare", pe(r), [[SA, 8], [LU2, 4]]);
  r = AZ.imparte({ ore: 14, data: LU, oraStart: 8, capZi: 8, ocupat: { [LU]: 5, [MA]: 8, [MI]: 7.9 } });
  egal("luni mai sunt 3 h, marți e plină, miercuri au rămas 6 minute: 3 luni, 8 joi, 3 vineri", [pe(r), r.sarite], [[[LU, 3], [JO, 8], [VI, 3]], [{ data: MA, motiv: "plina" }, { data: MI, motiv: "plina" }]]);
  egal("…și spune cât era deja ocupat și cât era liber", r.bucati.map((b) => [b.ocupat, b.liber]), [[5, 3], [0, 8], [0, 8]]);
  r = AZ.imparte({ ore: 6, data: LU, oraStart: 8, capZi: 8, ocupat: { [LU]: 8 } });
  egal("ziua aleasă e plină: începe în prima zi liberă", pe(r), [[MA, 6]]);
  r = AZ.imparte({ ore: 5, data: LU, oraStart: 14, capZi: 8 });
  egal("încape în ziua aleasă: o singură bucată, la ora aleasă", r.bucati.map((b) => [b.data, b.ore, b.ora_start]), [[LU, 5, 14]]);
  r = AZ.imparte({ ore: 20, data: LU, oraStart: 8, capZi: 8, ocupat: { [LU]: 2, [MA]: 4, [MI]: 2 }, sfarsit: { [LU]: 16, [MA]: 12, [MI]: 7 } });
  egal("ora de start: prima zi cea aleasă; apoi după ce e deja pe utilaj, dacă se termină mai târziu", r.bucati.map((b) => [b.data, b.ore, b.ora_start]), [[LU, 6, 8], [MA, 4, 12], [MI, 6, 8], [JO, 4, 8]]);
  egal("capacitate nescrisă sau zero: 8 h/zi", pe(AZ.imparte({ ore: 10, data: LU, capZi: 0 })), [[LU, 8], [MA, 2]]);
  egal("capacitatea nu trece de 24 h", AZ.imparte({ ore: 30, data: LU, capZi: 40 }).bucati.map((b) => b.ore), [24, 6]);
  egal("jumătăți de oră", pe(AZ.imparte({ ore: 9.5, data: LU, capZi: 7.5 })), [[LU, 7.5], [MA, 2]]);
  egal("zero ore, ore negative sau dată greșită: nimic", [AZ.imparte({ ore: 0, data: LU, capZi: 8 }).bucati, AZ.imparte({ ore: -3, data: LU, capZi: 8 }).bucati, AZ.imparte({ ore: 5, data: "01.03.2027", capZi: 8 }).bucati], [[], [], []]);
  r = AZ.imparte({ ore: 30, data: LU, capZi: 8, maxZile: 2 });
  egal("dacă nu încap în orizont, spune cât a rămas", [pe(r), r.rest], [[[LU, 8], [MA, 8]], 14]);
  egal("suma bucăților e totalul scris", AZ.imparte({ ore: 37.25, data: LU, capZi: 8, ocupat: { [MA]: 3.5 } }).bucati.reduce((s, b) => s + b.ore, 0), 37.25);

  console.log("\n2. Cantitatea, împărțită după ore");
  egal("10.000 pe 8, 8 și 4 ore", AZ.imparteCantitate(10000, [{ ore: 8 }, { ore: 8 }, { ore: 4 }]), [4000, 4000, 2000]);
  const c3 = AZ.imparteCantitate(1000, [{ ore: 8 }, { ore: 8 }, { ore: 8 }]);
  egal("rotunjirile se strâng pe ultima bucată, iar suma e exactă", [c3, Math.round(c3.reduce((s, x) => s + x, 0) * 100) / 100], [[333.33, 333.33, 333.34], 1000]);
  egal("fără cantitate: nimic de împărțit", AZ.imparteCantitate(0, [{ ore: 8 }, { ore: 4 }]), [null, null]);

  // ------------------------------------------------------------------------
  curata();
  q(`INSERT INTO utilaje (id, cod, denumire, activ, ore_pe_zi) VALUES (${U1}, 'TAZ-01', 'TAZ Mașină cartoane', 1, 8), (${U_24}, 'TAZ-02', 'TAZ Extruder', 1, 24), (${U_OPRIT}, 'TAZ-03', 'TAZ Scoasă din uz', 0, 8)`);
  q(`INSERT INTO comenzi_productie (id, numar, tip_produs, cantitate, um, status, client_text) VALUES
       (${CMD}, 'TAZ-1', 'TAZ Cutie D5', '10000', 'buc', 'noua', 'TAZ Client'), (${CMD_ALTA}, 'TAZ-2', 'TAZ Altă cutie', '500', 'buc', 'in_productie', 'TAZ Client')`);
  q(`INSERT INTO resurse (id, nume, activ) VALUES (${OM_A}, 'TAZ Om A', 1), (${OM_B}, 'TAZ Om B', 1), (${OM_STRAIN}, 'TAZ Om fără competență', 1)`);
  q(`INSERT INTO resurse_competente (resursa_id, utilaj_id, nivel) VALUES (${OM_A}, ${U1}, 2), (${OM_B}, ${U1}, 2)`);
  // Programul: luni amândoi; marți doar A; miercuri doar B; joi nu e scris nimic.
  q(`INSERT INTO resurse_program (resursa_id, data, schimb) VALUES (${OM_A}, '${LU}', 'S1'), (${OM_B}, '${LU}', 'S1'), (${OM_A}, '${MA}', 'S1'), (${OM_B}, '${MI}', 'S1')`);
  // Pe utilaj mai e deja ceva: luni 2 h (6–8), marți toată ziua.
  q(`INSERT INTO alocari_productie (comanda_productie_id, utilaj_id, data, ora_start, ore, status) VALUES (${CMD_ALTA}, ${U1}, '${LU}', 6, 2, 'planificata'), (${CMD_ALTA}, ${U1}, '${MA}', 6, 8, 'planificata')`);
  // …și una anulată, care nu ocupă nimic.
  q(`INSERT INTO alocari_productie (comanda_productie_id, utilaj_id, data, ora_start, ore, status) VALUES (${CMD_ALTA}, ${U1}, '${MI}', 6, 8, 'anulata')`);

  console.log("\n3. Pagina de alocare");
  const pag = (await cer("get", `/productie/aloca/${CMD}`, ADMIN)).corp;
  bine("are bifa „Împarte orele pe zilele libere ale utilajului”, pusă din oficiu", /<input type="checkbox" name="imparte" id="alocImparte" value="1" checked>/.test(pag) && /Împarte orele pe zilele libere ale utilajului/.test(pag));
  bine("…și bifa de weekend, nepusă", /<input type="checkbox" name="weekend" id="alocWeekend" value="1">/.test(pag));
  bine("orele rămân de scris de mână, ca total", /Ore \(total\)<input type="number" name="ore" id="alocOre"/.test(pag));
  bine("previzualizarea cere serverului aceeași socoteală", pag.includes('id="alocPlan"') && pag.includes(`"/productie/aloca/${CMD}/impartire?"`));

  console.log("\n4. Previzualizarea");
  let pv = await cer("get", `/productie/aloca/${CMD}/impartire`, ADMIN, { query: { utilaj_id: String(U1), data: LU, ora_start: "8", ore: "20" } });
  const plan = JSON.parse(pv.corp);
  egal("răspunde JSON, fără cache", [pv.cod, pv.antet["Content-Type"], pv.antet["Cache-Control"]], [200, "application/json; charset=utf-8", "no-store"]);
  egal("20 h de luni: 6 luni (2 ocupate), marți plină, 8 miercuri (anulata nu ocupă), 6 joi", [plan.bucati.map((b) => [b.data, b.ore, b.ora_start, b.ocupat]), plan.sarite, plan.cap],
    [[[LU, 6, 8, 2], [MI, 8, 8, 0], [JO, 6, 8, 0]], [{ data: MA, motiv: "plina" }], 8]);
  egal("nu scrie nimic", alocari(CMD), []);
  pv = await cer("get", `/productie/aloca/${CMD}/impartire`, ADMIN, { query: { utilaj_id: String(U_24), data: LU, ora_start: "6", ore: "30" } });
  egal("utilajul care merge 24 h pe zi: 24 + 6", JSON.parse(pv.corp).bucati.map((b) => [b.data, b.ore]), [[LU, 24], [MA, 6]]);
  pv = await cer("get", `/productie/aloca/${CMD}/impartire`, null, { query: { utilaj_id: String(U1), data: LU, ore: "20" } });
  egal("fără cont: refuzat", pv.cod, 401);
  pv = await cer("get", `/productie/aloca/${CMD}/impartire`, ADMIN, { query: { utilaj_id: String(U_OPRIT), data: LU, ore: "20" } });
  egal("utilaj scos din uz: refuzat", pv.cod, 400);
  pv = await cer("get", `/productie/aloca/${CMD}/impartire`, ADMIN, { query: { utilaj_id: String(U1), data: "ieri", ore: "20" } });
  egal("dată greșită: refuzat", pv.cod, 400);

  console.log("\n5. Salvarea: câte o alocare pe zi");
  let s = await cer("post", `/productie/aloca/${CMD}`, ADMIN, {
    body: { utilaj_id: String(U1), data: LU, ora_start: "8", ore: "20", cantitate: "10000", imparte: "1", observatii: "lot TAZ",
      [`resursa_${OM_A}`]: "1", [`resursa_${OM_B}`]: "1", [`resursa_${OM_STRAIN}`]: "1" },
  });
  egal("trei alocări: luni 6 h, miercuri 8 h, joi 6 h, cu cantitatea împărțită după ore", alocari(CMD), [[LU, 8, 6, 3000], [MI, 8, 8, 4000], [JO, 8, 6, 3000]]);
  egal("…toate pe utilajul ales, cu observația", q(`SELECT DISTINCT utilaj_id, observatii, status FROM alocari_productie WHERE comanda_productie_id = ${CMD}`).map((x) => [Number(x.utilaj_id), x.observatii, x.status]), [[U1, "lot TAZ", "planificata"]]);
  egal("oamenii: luni amândoi (ziua aleasă), miercuri doar cel în tură, joi amândoi (program nescris); cel fără competență nicăieri",
    oameniPe(CMD), [[LU, OM_A], [LU, OM_B], [MI, OM_B], [JO, OM_A], [JO, OM_B]]);
  egal("planificarea se deschide pe prima zi", s.antet.Location, `/productie/planificare?de_la=${LU}`);
  egal("comanda nouă a intrat în producție", q(`SELECT status FROM comenzi_productie WHERE id = ${CMD}`)[0].status, "in_productie");

  sterge(CMD);
  s = await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: MA, ora_start: "8", ore: "5", cantitate: "100", imparte: "1" } });
  egal("ziua aleasă e plină: alocarea începe miercuri, și acolo se deschide planificarea", [alocari(CMD), s.antet.Location], [[[MI, 8, 5, 100]], `/productie/planificare?de_la=${MI}`]);

  sterge(CMD);
  await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: VI, ora_start: "8", ore: "12", imparte: "1", weekend: "1" } });
  egal("cu weekend: vineri și sâmbătă", alocari(CMD), [[VI, 8, 8, null], [SA, 8, 4, null]]);
  sterge(CMD);
  await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: VI, ora_start: "8", ore: "12", imparte: "1" } });
  egal("fără weekend: vineri și luni", alocari(CMD), [[VI, 8, 8, null], [LU2, 8, 4, null]]);

  sterge(CMD);
  await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: LU, ora_start: "10", ore: "4", cantitate: "250", imparte: "1" } });
  egal("încape în ziua aleasă: un singur rând, ca înainte", alocari(CMD), [[LU, 10, 4, 250]]);

  sterge(CMD);
  await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: LU, ora_start: "8", ore: "20", cantitate: "10000" } });
  egal("fără bifă: toate orele pe ziua aleasă, într-un singur rând", alocari(CMD), [[LU, 8, 20, 10000]]);

  sterge(CMD);
  await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: MI, ora_start: "8", ore: "10", imparte: "1" } });
  await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: MI, ora_start: "8", ore: "10", imparte: "1" } });
  egal("a doua comandă pe aceleași zile se așază după prima: miercuri 8, joi 2 + 6, vineri 4",
    alocari(CMD), [[MI, 8, 8, null], [JO, 8, 2, null], [JO, 10, 6, null], [VI, 8, 4, null]]);

  sterge(CMD);
  const rauUtilaj = await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U_OPRIT), data: LU, ora_start: "8", ore: "20", imparte: "1" } });
  egal("utilajul scos din uz e refuzat și cu bifa pusă", [rauUtilaj.cod, alocari(CMD)], [400, []]);

  // Mai multe ore decât încap pe utilaj în tot orizontul de căutare (180 de
  // zile a 8 h, fără weekenduri, înseamnă cam 1.000 h): nu se scrie nimic pe
  // jumătate, ci se spune că nu încap.
  sterge(CMD);
  const preaMulte = await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U1), data: LU, ora_start: "8", ore: "5000", cantitate: "10000", imparte: "1" } });
  egal("ore care nu încap în următoarele 180 de zile: refuzat, fără nicio alocare scrisă", [preaMulte.cod, /Orele nu încap pe utilaj/.test(preaMulte.corp), alocari(CMD)], [400, true, []]);

  // ------------------------------------------------------------------------
  console.log("\n6. În browser: previzualizarea se vede pe loc");
  sterge(CMD);
  const fs = require("fs");
  const { chromium } = require("playwright");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const paginaAloc = (await cer("get", `/productie/aloca/${CMD}`, ADMIN)).corp;
  const browser = await chromium.launch();
  const erori = [];
  let picaPrevizualizarea = false;
  try {
    const p = await (await browser.newContext({ viewport: { width: 1300, height: 950 } })).newPage();
    p.on("pageerror", (e) => erori.push(e.message));
    await p.route("http://erp.test/**", async (rt) => {
      const u = new URL(rt.request().url());
      if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      if (u.pathname === `/productie/aloca/${CMD}`) return rt.fulfill({ status: 200, contentType: "text/html", body: paginaAloc });
      if (u.pathname === `/productie/aloca/${CMD}/impartire`) {
        if (picaPrevizualizarea) return rt.fulfill({ status: 500, body: "" });
        const h = await cer("get", `/productie/aloca/${CMD}/impartire`, ADMIN, { query: Object.fromEntries(u.searchParams) });
        return rt.fulfill({ status: h.cod, contentType: "application/json", body: h.corp });
      }
      return rt.fulfill({ status: 204, body: "" });
    });
    await p.goto(`http://erp.test/productie/aloca/${CMD}`);
    bine("fără utilaj ales nu se arată nimic", !(await p.isVisible("#alocPlan")));
    await p.fill('input[name="data"]', LU);
    await p.dispatchEvent('input[name="data"]', "change");
    await p.selectOption("#alocUtilaj", String(U1));
    await p.fill("#alocOre", "20");
    await p.waitForFunction(() => /Se împarte pe 3 zile/.test(document.getElementById("alocPlan").textContent));
    const text = (await p.textContent("#alocPlan")).replace(/\s+/g, " ");
    bine("20 h: „Se împarte pe 3 zile”, cu capacitatea utilajului", /Se împarte pe 3 zile — utilajul lucrează 8 h pe zi:/.test(text), text);
    egal("zilele, ora și orele fiecăreia", await p.$$eval("#alocPlan li", (l) => l.map((x) => x.textContent)),
      ["Lu 01.03, de la 8:00 — 6 h (alte 2 h sunt deja ocupate)", "Mi 03.03, de la 8:00 — 8 h", "Jo 04.03, de la 8:00 — 6 h"]);
    bine("…și spune ce zi a sărit, fiind plină", /Sărite, fiind pline: Ma 02\.03\./.test(text), text);
    await p.fill("#alocOre", "4");
    await p.waitForFunction(() => /Încape într-o singură zi/.test(document.getElementById("alocPlan").textContent));
    egal("4 h: încape într-o zi", await p.$$eval("#alocPlan li", (l) => l.map((x) => x.textContent)), ["Lu 01.03, de la 8:00 — 4 h (alte 2 h sunt deja ocupate)"]);
    await p.fill('input[name="data"]', VI);
    await p.dispatchEvent('input[name="data"]', "change");
    await p.fill("#alocOre", "12");
    await p.waitForFunction(() => /Lu 08\.03/.test(document.getElementById("alocPlan").textContent));
    bine("de vineri, 12 h: vineri și luni, cu nota despre weekend", /Sâmbăta și duminica sunt sărite/.test(await p.textContent("#alocPlan")));
    await p.check("#alocWeekend");
    await p.waitForFunction(() => /Sâ 06\.03/.test(document.getElementById("alocPlan").textContent));
    egal("cu bifa de weekend: vineri și sâmbătă", await p.$$eval("#alocPlan li", (l) => l.map((x) => x.textContent.slice(0, 8))), ["Vi 05.03", "Sâ 06.03"]);
    if (process.env.POZA) await p.screenshot({ path: process.env.POZA, fullPage: true });
    await p.uncheck("#alocImparte");
    bine("fără bifa de împărțire, previzualizarea dispare", !(await p.isVisible("#alocPlan")));
    await p.check("#alocImparte");
    await p.waitForFunction(() => document.getElementById("alocPlan").style.display !== "none");
    picaPrevizualizarea = true;
    await p.fill("#alocOre", "13");
    await p.waitForFunction(() => document.getElementById("alocPlan").style.display === "none");
    bine("dacă previzualizarea nu răspunde, pagina merge mai departe fără ea", !(await p.isVisible("#alocPlan")) && (await p.isEnabled('button[type="submit"]')));
  } finally {
    await browser.close();
  }
  egal("nicio eroare de JavaScript", erori, []);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
