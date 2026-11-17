"use strict";
// Prețul de intrare scris în valută, la marfa care intră în stoc.
//
// CE A CERUT VALI, 17.11.2026: „La orice comandă, preț etc., din orice loc în
// tot sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul
// introdus sau BNR; odată plasat, așa rămâne în istoric și doar cele noi se
// schimbă — la marfa intrată în stoc sau oriunde."
//
// CE APĂRĂ (regulile curate sunt în test-pret-valuta.js; aici, pe PostgreSQL
// real, drumurile pe care intră marfa):
//   • Prețul scris în euro sau dolari ajunge pe palet ÎN LEI, la cursul ales
//     (BNR-ul zilei sau cel scris de om), iar sursa prețului ține minte din ce
//     s-a făcut: „scris la intrare: 1,25 EUR × 5,0912 (BNR din 17.11.2026)".
//   • Un curs care nu se poate folosi oprește intrarea, cu motivul lui.
//   • PESTE TOT: Intrare marfă (și confirmarea locurilor), scanerul, paleții
//     făcuți din recepție și din lista „De alocat pe raft", marfa adăugată pe
//     un palet, prețul pus după intrare (cu „la fel pe ceilalți"), rândul
//     scris de mână în recepție, mișcarea de stoc scrisă de mână.
//   • În lei, totul rămâne ca până acum.
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
for (const m of ["gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie", "stocuri"]) require(path.join(RAD, "modules", m + ".js")).register(router);
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

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- datele de test ------------------------------------------------------
const PREFIX = "TVI";
// PA, PC, PD: fără niciun preț · PB: preț de achiziție 2,5 lei.
const [PA, PB, PC, PD] = [98401, 98402, 98403, 98404];
const PRODUSE = [PA, PB, PC, PD];
const FURNIZOR = 98411;
const DEPOZIT = 98421;
const MARCA_BNR = "test-pret-valuta-intrare";

function curata() {
  const pr = PRODUSE.join(",");
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-R%'`).map((x) => Number(x.id)).join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE produs_id IN (${pr}) OR cod LIKE '${PREFIX}-%' OR produs_text LIKE '${PREFIX} %' OR receptie_id IN (${rec})
                    OR id IN (SELECT palet_id FROM ct_palet_linii WHERE produs_id IN (${pr}) OR produs_text LIKE '${PREFIX} %')`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_tipar WHERE creat_de LIKE '${PREFIX} %'`);
  q(`DELETE FROM ct_palet_preturi WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_adaugari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${rec})`);
  q(`DELETE FROM receptii WHERE id IN (${rec})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM depozite WHERE id = ${DEPOZIT}`);
  q(`DELETE FROM parteneri WHERE id = ${FURNIZOR}`);
  q(`DELETE FROM cursuri_bnr WHERE luat_la = '${MARCA_BNR}'`);
}
const azi = () => new Date().toISOString().slice(0, 10);
const ziRo = (d) => String(d || "").split("-").reverse().join(".");
let nrPalet = 0;
function palet(produs, cant, um, pret, sursa) {
  const cod = `${PREFIX}-PAL-${++nrPalet}`;
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare, pret_unitar, pret_sursa)
     VALUES ('${cod}', ${produs}, ${cant}, ${cant}, '${um}', '2026-11-01', ${pret == null ? "NULL" : pret}, ${pret == null ? "NULL" : lit(sursa || "scris la intrare")}) RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar, pret_sursa)
     VALUES (${id}, ${produs}, (SELECT denumire FROM produse WHERE id = ${produs}), ${cant}, '${um}', ${pret == null ? "NULL" : pret}, ${pret == null ? "NULL" : lit(sursa || "scris la intrare")})`);
  return id;
}
const n = (v) => (v == null ? null : Number(v));
const pretAntet = (id) => q(`SELECT pret_unitar, pret_sursa FROM ct_paleti WHERE id = ${id}`).map((x) => [n(x.pret_unitar), x.pret_sursa])[0];
const pretLinii = (id) => q(`SELECT pret_unitar, pret_sursa FROM ct_palet_linii WHERE palet_id = ${id} ORDER BY id`).map((x) => [n(x.pret_unitar), x.pret_sursa]);
const paletiiProdusului = (pid) => q(`SELECT id, cantitate, pret_unitar, pret_sursa FROM ct_paleti WHERE produs_id = ${pid} ORDER BY id`).map((x) => [n(x.cantitate), n(x.pret_unitar), x.pret_sursa]);
const catePaleti = (pid) => Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE produs_id = ${pid}`));

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: `${PREFIX} Depozit`, rol: "depozit", sectiuni: "" };
  const ADMIN = { id: idUser, nume: `${PREFIX} Admin`, rol: "admin", sectiuni: "" };

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  q(`INSERT INTO depozite (id, denumire) VALUES (${DEPOZIT}, '${PREFIX} Depozit')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie) VALUES
       (${PA}, '${PREFIX}-A', '${PREFIX} Granula fara pret', 'kg', NULL),
       (${PB}, '${PREFIX}-B', '${PREFIX} Folie cu pret de achizitie', 'kg', 2.5),
       (${PC}, '${PREFIX}-C', '${PREFIX} Plic la fel', 'buc', NULL),
       (${PD}, '${PREFIX}-D', '${PREFIX} Alt produs pe palet', 'buc', NULL)`);
  // BNR-ul de azi, dacă baza de test nu-l are deja.
  q(`INSERT INTO cursuri_bnr (data, moneda, valoare, luat_la) VALUES ('${azi()}', 'EUR', 5.0912, '${MARCA_BNR}') ON CONFLICT (data, moneda) DO NOTHING`);
  q(`INSERT INTO cursuri_bnr (data, moneda, valoare, luat_la) VALUES ('${azi()}', 'USD', 4.6034, '${MARCA_BNR}') ON CONFLICT (data, moneda) DO NOTHING`);
  const bnr = (m) => { const x = q(`SELECT valoare, data FROM cursuri_bnr WHERE moneda = '${m}' AND data <= '${azi()}' ORDER BY data DESC LIMIT 1`)[0]; return { valoare: Number(x.valoare), data: x.data }; };
  const EUR = bnr("EUR");
  const rot6 = (x) => Math.round(Number((x * 1e6).toPrecision(14))) / 1e6;
  const scrieCurs = (v) => Number(v).toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const NOTA_BNR = (pret) => `${String(pret).replace(".", ",")} EUR × ${scrieCurs(EUR.valoare)} (BNR din ${ziRo(EUR.data)})`;
  const NOTA_5 = (pret) => `${String(pret).replace(".", ",")} EUR × 5,0000 (curs pus de voi)`;

  // O recepție finalizată, de la furnizor, cu rânduri fără preț.
  const RID = Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare, finalizata_la) VALUES ('${PREFIX}-R1', 'furnizor', ${FURNIZOR}, '${azi()}', 'finalizata', '${azi()} 10:00:00') RETURNING id`));
  const linieRec = (produs, cant, um, pret) => Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, pret_unitar, stare, conditie)
       VALUES (${RID}, ${produs}, ${cant}, ${cant}, '${um}', ${pret == null ? "NULL" : pret}, 'primita', 'bun') RETURNING id`));
  const L1 = linieRec(PA, 100, "kg", null);
  const L2 = linieRec(PA, 50, "kg", null);
  const L3 = linieRec(PA, 80, "kg", null);
  // …și una deschisă, în care se adaugă rânduri de mână.
  const RID2 = Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare) VALUES ('${PREFIX}-R2', 'furnizor', ${FURNIZOR}, '${azi()}', 'in_lucru') RETURNING id`));

  const libere = q(`SELECT l.id, l.rand_id, l.adresa FROM ct_locuri l JOIN ct_randuri rr ON rr.id = l.rand_id AND rr.activ = 1
                     WHERE COALESCE(l.blocat, 0) = 0 AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
                     ORDER BY l.id LIMIT 8`);
  if (libere.length < 8) throw new Error("depozitul de test nu are 8 locuri libere");
  let iLoc = 0;
  const locLiber = () => libere[iLoc++];
  const intrare = (campuri, cant) => {
    const l = locLiber();
    return cer("post", "/stocuri/ct-park/intrare", DEP, { body: Object.assign({ "loc_ids[]": String(l.id), "loc_rand[]": String(l.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": String(cant || 10) }, campuri) });
  };

  // ------------------------------------------------------------------------
  console.log("1. Regula: prețul scris în valută ajunge în lei, cu nota lui");
  egal("euro, cursul gol: BNR-ul zilei", await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "" }), { pret: rot6(1.25 * EUR.valoare), sursa: "scris la intrare: " + NOTA_BNR("1.25") });
  egal("euro, cursul scris de om", await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "5,25" }), { pret: 6.5625, sursa: "scris la intrare: 1,25 EUR × 5,2500 (curs pus de voi)" });
  egal("dolari, cu cursul scris", await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "0.03", pret_moneda: "usd", pret_curs: "4,6" }), { pret: 0.138, sursa: "scris la intrare: 0,03 USD × 4,6000 (curs pus de voi)" });
  egal("în lei, sau fără câmpul de monedă (pagină veche): ca până acum", [await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "1,25", pret_moneda: "RON", pret_curs: "5" }), await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "1,25" })],
    [{ pret: 1.25, sursa: "scris la intrare" }, { pret: 1.25, sursa: "scris la intrare" }]);
  egal("prețul în euro care, în lei, e chiar cel știut de ERP: rămâne sursa lui", await CT.pretDeIntrare({ produs_id: PB, pret_unitar: "0,5", pret_moneda: "EUR", pret_curs: "5" }), { pret: 2.5, sursa: "preț de achiziție de pe produs" });
  egal("curs greșit: prețul scris nu se poate folosi, deci nu e preț", [await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "cinci" }), await CT.pretInRegula({ produs_id: PA, pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "cinci" })], [null, false]);
  const vr = await CT.valutaPretului({ pret_moneda: "EUR", pret_curs: "cinci" });
  bine("…și se poate spune de ce", vr.ok === false && /Cursul nu e un număr pozitiv/.test(vr.eroare), JSON.stringify(vr));
  egal("fără preț scris, moneda nu contează: ce știe ERP-ul", await CT.pretDeIntrare({ produs_id: PB, pret_moneda: "EUR", pret_curs: "cinci" }), { pret: 2.5, sursa: "preț de achiziție de pe produs" });

  // ------------------------------------------------------------------------
  console.log("\n2. Intrare marfă");
  let r = await intrare({ produs_id: String(PA), um: "kg", pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "" }, 60);
  bine("cu prețul în euro: intră și duce la etichete", /\/stocuri\/ct-park\/etichete\?paleti=\d+/.test(unde(r)), unde(r) + " " + r.cod);
  let pid = Number(unul(`SELECT id FROM ct_paleti WHERE produs_id = ${PA} ORDER BY id DESC LIMIT 1`));
  egal("…pe palet, în lei, la BNR-ul zilei; sursa ține minte euro și cursul — pe antet și pe linie", [pretAntet(pid), pretLinii(pid)],
    [[rot6(1.25 * EUR.valoare), "scris la intrare: " + NOTA_BNR("1.25")], [[rot6(1.25 * EUR.valoare), "scris la intrare: " + NOTA_BNR("1.25")]]]);
  let cate = catePaleti(PA);
  r = await intrare({ produs_id: String(PA), um: "kg", pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "cinci" }, 60);
  egal("cu un curs greșit: refuzată, niciun palet", [r.cod, catePaleti(PA) - cate], [422, 0]);
  bine("…cu motivul cursului, nu cu „lipsește prețul”", r.corp.includes("n-a intrat în depozit.") && r.corp.includes("Cursul nu e un număr pozitiv") && !r.corp.includes("ERP-ul nu-l știe") && r.corp.includes('onclick="history.back()"'), r.corp.slice(0, 600));
  r = await intrare({ produs_id: String(PA), um: "kg", pret_unitar: "1,25", pret_moneda: "GBP", pret_curs: "6" }, 60);
  bine("o monedă necunoscută: refuzată, nu luată drept lei", r.cod === 422 && /GBP/.test(r.corp) && catePaleti(PA) === cate, r.cod);
  r = await intrare({ produs_id: String(PA), um: "kg", pret_unitar: "7,35", pret_moneda: "RON", pret_curs: "5" }, 20);
  pid = Number(unul(`SELECT id FROM ct_paleti WHERE produs_id = ${PA} ORDER BY id DESC LIMIT 1`));
  egal("în lei, cu ceva rămas în câmpul de curs: ca până acum", pretAntet(pid), [7.35, "scris la intrare"]);
  // Locurile propuse: pagina a doua duce moneda și cursul mai departe.
  r = await cer("post", "/stocuri/ct-park/intrare", DEP, { body: { "loc_ids[]": "", "loc_rand[]": "", "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "10", produs_id: String(PA), um: "kg", pret_unitar: "2", pret_moneda: "EUR", pret_curs: "5" } });
  bine("confirmarea locurilor propuse poartă moneda și cursul, ascunse", r.cod === 200 && r.corp.includes('<input type="hidden" name="pret_moneda" value="EUR"><input type="hidden" name="pret_curs" value="5">') && r.corp.includes('name="pret_unitar" value="2"'), r.cod + " " + r.corp.slice(0, 200));
  r = await cer("post", "/stocuri/ct-park/intrare", DEP, { body: { "loc_ids[]": "", "loc_rand[]": "", "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "10", produs_id: String(PA), um: "kg", pret_unitar: "2" } });
  bine("…iar în lei nu poartă nimic în plus", r.cod === 200 && !r.corp.includes('name="pret_moneda"') && !r.corp.includes('name="pret_curs"'));
  const lc = locLiber();
  cate = catePaleti(PA);
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { grup_0: String(lc.id), cant_0: "10", produs_id: String(PA), um: "kg", pret_unitar: "2", pret_moneda: "EUR", pret_curs: "cinci" } });
  egal("confirmarea cu un curs greșit: refuzată", [r.cod, r.corp.includes("Cursul nu e un număr pozitiv"), catePaleti(PA) - cate], [422, true, 0]);
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { grup_0: String(lc.id), cant_0: "10", produs_id: String(PA), um: "kg", pret_unitar: "2", pret_moneda: "EUR", pret_curs: "5" } });
  pid = Number(unul(`SELECT id FROM ct_paleti WHERE produs_id = ${PA} ORDER BY id DESC LIMIT 1`));
  egal("…cu cursul bun: intră, în lei, cu nota", [/etichete\?paleti=\d+/.test(unde(r)), pretAntet(pid)], [true, [10, "scris la intrare: " + NOTA_5("2")]]);
  r = await cer("get", "/stocuri/ct-park/intrare", DEP);
  bine("formularul de intrare are alegerea monedei, câmpul de curs și BNR-ul zilei pentru propunere", r.cod === 200 && r.corp.includes('name="pret_moneda" data-pv-moneda') && r.corp.includes('name="pret_curs"') && r.corp.includes('id="pret-intrare" data-pv-pret') && r.corp.includes(`"EUR":{"valoare":${EUR.valoare}`) && r.corp.includes("window.PV_BNR"), r.cod);
  bine("…eticheta prețului se schimbă cu moneda, iar pagina spune ce se întâmplă cu prețul în valută", r.corp.includes("Preț de intrare (<span data-pv-um>lei</span> / UM)") && r.corp.includes("pe palet rămâne în lei"));

  // ------------------------------------------------------------------------
  console.log("\n3. Plasa din puneMarfa");
  let aruncat = "";
  cate = catePaleti(PA);
  try { await CT.puneMarfa({ user: DEP }, { produs_id: String(PA), um: "kg", pret_unitar: "2", pret_moneda: "EUR", pret_curs: "0" }, [[]], 10); } catch (e) { aruncat = e.message; }
  bine("orice altă cale care ar pune un palet cu un curs greșit e oprită, cu motivul", /Cursul nu e un număr pozitiv/.test(aruncat) && catePaleti(PA) === cate, aruncat);

  // ------------------------------------------------------------------------
  console.log("\n4. Scanerul");
  let x = await SC.faPaleti(DEP, "r" + L1, [10], [], { pret: "2", moneda: "EUR", curs: "5" });
  egal("palet făcut din scaner, cu prețul în euro: în lei, cu nota", [!x.eroare, x.ids && x.ids.length, x.ids && pretAntet(x.ids[0])], [true, 1, [10, "scris la intrare: " + NOTA_5("2")]]);
  x = await SC.faPaleti(DEP, "r" + L1, [10], [], { pret: "2", moneda: "EUR", curs: "cinci" });
  bine("curs greșit: nu se face paletul, cu motivul cursului și cu semnul că e de la preț", /Cursul nu e un număr pozitiv/.test(x.eroare || "") && x.faraPret === true && !x.ids, JSON.stringify(x));
  x = await SC.faPaleti(DEP, "r" + L1, [10], [], { pret: "2,5" });
  egal("fără monedă: în lei, ca până acum", x.ids && pretAntet(x.ids[0]), [2.5, "scris la intrare"]);
  r = await cer("get", `/stocuri/ct-park/scaner/intrare/rand/r${L1}`, DEP, { query: { pret: "2", pret_moneda: "EUR", pret_curs: "5,1" } });
  bine("pagina scanerului: alegerea monedei lângă preț, ținută minte între scanări", r.cod === 200 && r.corp.includes('name="pret_moneda" data-pv-moneda data-tine="pret_moneda"') && r.corp.includes('<option value="EUR" selected>') && r.corp.includes('name="pret_curs" value="5,1"') && r.corp.includes('data-tine="pret_curs"') && r.corp.includes('name="pret" data-tine="pret" data-pv-pret'), r.cod);
  bine("…și dusă mai departe la scanarea locului", r.corp.includes('<input type="hidden" name="pret_moneda" value="EUR">') && r.corp.includes('<input type="hidden" name="pret_curs" value="5,1">'));
  r = await cer("post", `/stocuri/ct-park/scaner/intrare/rand/r${L1}`, DEP, { body: { actiune: "paleti", cant: "10", pret: "2", pret_moneda: "EUR", pret_curs: "cinci" } });
  egal("scanerul, curs greșit: pagina se întoarce cu motivul și cu ce era scris", [/Cursul nu e un număr pozitiv/.test(parametri(r).eroare || ""), parametri(r).pret, parametri(r).pret_moneda, parametri(r).pret_curs], [true, "2", "EUR", "cinci"]);
  r = await cer("post", `/stocuri/ct-park/scaner/intrare/rand/r${L1}`, DEP, { body: { actiune: "paleti", cant: "10", pret: "3", pret_moneda: "EUR", pret_curs: "5" } });
  pid = Number(unul(`SELECT id FROM ct_paleti WHERE receptie_linie_id = ${L1} ORDER BY id DESC LIMIT 1`));
  egal("scanerul, cu cursul bun: paletul e făcut, în lei, cu nota", [calea(r), pretAntet(pid)], ["/stocuri/ct-park/scaner/intrare", [15, "scris la intrare: " + NOTA_5("3")]]);

  // ------------------------------------------------------------------------
  console.log("\n5. Paleții făcuți din recepție și din lista „De alocat pe raft”");
  r = await cer("post", `/depozit/receptie/${RID}/paleti`, DEP, { body: { ["paleti_" + L2]: "2 x 10", ["pret_" + L2]: "2", pret_moneda: "EUR", pret_curs: "5" } });
  const dinL2 = q(`SELECT id FROM ct_paleti WHERE receptie_linie_id = ${L2} ORDER BY id`).map((y) => Number(y.id));
  egal("doi paleți dintr-o dată, cu prețul în euro: amândoi în lei, cu nota", [/etichete\?paleti=/.test(unde(r)), dinL2.map(pretAntet)], [true, [[10, "scris la intrare: " + NOTA_5("2")], [10, "scris la intrare: " + NOTA_5("2")]]]);
  r = await cer("post", `/depozit/receptie/${RID}/paleti`, DEP, { body: { ["paleti_" + L2]: "10", ["pret_" + L2]: "2", pret_moneda: "EUR", pret_curs: "x" } });
  bine("…cu un curs greșit: niciun palet, cu motivul", q(`SELECT id FROM ct_paleti WHERE receptie_linie_id = ${L2}`).length === 2 && /Cursul nu e un număr pozitiv/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("get", `/depozit/receptie/${RID}`, DEP);
  bine("pagina recepției: unde rândul n-are preț, căsuța lui și alegerea monedei", r.cod === 200 && r.corp.includes(`name="pret_${L3}" inputmode="decimal" autocomplete="off" data-pv-pret`) && r.corp.includes("Prețurile scrise mai sus sunt în") && r.corp.includes('name="pret_moneda" data-pv-moneda'), r.cod);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L3}/paleti`, DEP, { body: { paleti: "2 x 10", pret: "1", pret_moneda: "EUR", pret_curs: "" } });
  const dinL3 = q(`SELECT id FROM ct_paleti WHERE receptie_linie_id = ${L3} ORDER BY id`).map((y) => Number(y.id));
  egal("din lista „De alocat pe raft”, cu prețul în euro la BNR", dinL3.map(pretAntet), [[rot6(EUR.valoare), "scris la intrare: " + NOTA_BNR("1")], [rot6(EUR.valoare), "scris la intrare: " + NOTA_BNR("1")]]);
  r = await cer("get", "/stocuri/ct-park/intrare", DEP);
  const sec = (() => { const i = r.corp.indexOf('id="gata-productie"'); return i < 0 ? "" : r.corp.slice(i, r.corp.indexOf("</section>", i)); })();
  bine("lista „De alocat pe raft”: rândul fără preț are căsuța, câmpurile ascunse ale monedei și alegerea de deasupra, în zona ei", sec.includes("data-pv-zona") && sec.includes('id="gata-moneda"') && sec.includes('data-pv-copie="moneda"') && sec.includes('name="pret" inputmode="decimal" autocomplete="off" required data-pv-pret'), sec.slice(0, 300));

  // ------------------------------------------------------------------------
  console.log("\n6. Rândul scris de mână în recepție");
  const liniiR2 = () => q(`SELECT id, pret_unitar, pret_nota FROM receptii_linii WHERE receptie_id = ${RID2} ORDER BY id`).map((y) => [n(y.pret_unitar), y.pret_nota]);
  r = await cer("post", `/depozit/receptie/${RID2}/linie`, DEP, { body: { produs_id: String(PA), cantitate: "100", um: "kg", pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "" } });
  egal("prețul în euro: pe rând în lei, cu nota lui", liniiR2(), [[rot6(1.25 * EUR.valoare), NOTA_BNR("1.25")]]);
  const LR = Number(unul(`SELECT id FROM receptii_linii WHERE receptie_id = ${RID2} ORDER BY id DESC LIMIT 1`));
  egal("…iar paletul făcut din rând ia prețul din recepție, cu nota", await CT.pretStiut({ receptie_linie_id: LR, produs_id: PA }), { pret: rot6(1.25 * EUR.valoare), sursa: "prețul din recepție: " + NOTA_BNR("1.25") });
  r = await cer("post", `/depozit/receptie/${RID2}/linie`, DEP, { body: { produs_id: String(PA), cantitate: "100", um: "kg", pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "cinci" } });
  bine("cu un curs greșit: rândul nu se scrie, pagina spune de ce", liniiR2().length === 1 && /Cursul nu e un număr pozitiv/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("post", `/depozit/receptie/${RID2}/linie`, DEP, { body: { produs_id: String(PA), cantitate: "100", um: "kg", pret_unitar: "7,35", pret_moneda: "RON" } });
  r = await cer("post", `/depozit/receptie/${RID2}/linie`, DEP, { body: { produs_id: String(PA), cantitate: "100", um: "kg", pret_unitar: "", pret_moneda: "EUR", pret_curs: "cinci" } });
  egal("în lei: fără notă; fără preț: nimic, oricare ar fi moneda", liniiR2().slice(1), [[7.35, null], [null, null]]);
  egal("…iar prețul din recepție, fără notă, rămâne cum era", (await CT.pretStiut({ receptie_linie_id: Number(unul(`SELECT id FROM receptii_linii WHERE receptie_id = ${RID2} ORDER BY id LIMIT 1 OFFSET 1`)), produs_id: PA })).sursa, "prețul din recepție");
  r = await cer("get", `/depozit/receptie/${RID2}`, DEP);
  bine("formularul „Adaugă un rând” are alegerea monedei", r.cod === 200 && r.corp.includes('name="pret_unitar" data-pv-pret') && r.corp.includes("Prețul e scris în") && r.corp.includes('name="pret_moneda" data-pv-moneda'), r.cod);

  // ------------------------------------------------------------------------
  console.log("\n7. Marfa adăugată pe un palet din raft");
  const PAD = palet(PC, 10, "buc", 10);
  const linieAd = Number(unul(`SELECT id FROM ct_palet_linii WHERE palet_id = ${PAD}`));
  r = await cer("post", `/stocuri/ct-park/palet/${PAD}/adauga`, DEP, { body: { ["adauga_" + linieAd]: "10", ["pret_" + linieAd]: "3", pret_moneda: "EUR", pret_curs: "5" } });
  egal("adaug 10 cu prețul în euro (3 € × 5 = 15 lei) peste 10 la 10 lei: media în lei", [parametri(r).ok !== undefined, pretLinii(PAD)], [true, [[12.5, "medie după adăugare"]]]);
  const ad = q(`SELECT pret_unitar, observatii FROM ct_palet_adaugari WHERE palet_id = ${PAD} ORDER BY id`).map((y) => [n(y.pret_unitar), y.observatii]);
  egal("…iar adăugarea ține minte prețul ei în lei și din ce s-a făcut", ad, [[15, `preț scris în valută — ${PREFIX} Plic la fel: ${NOTA_5("3")}`]]);
  r = await cer("post", `/stocuri/ct-park/palet/${PAD}/adauga`, DEP, { body: { nou_produs: `${PREFIX}-D`, nou_cantitate: "5", nou_um: "buc", nou_pret: "1", pret_moneda: "EUR", pret_curs: "5", observatii: "din alt lot" } });
  egal("alt produs pe palet, cu prețul în euro: linia nouă e în lei, cu nota în sursă", pretLinii(PAD)[1], [5, "scris la adăugare: " + NOTA_5("1")]);
  egal("…și observațiile omului rămân, lângă nota prețului", q(`SELECT id, observatii FROM ct_palet_adaugari WHERE palet_id = ${PAD} ORDER BY id DESC LIMIT 1`)[0].observatii, `din alt lot · preț scris în valută — ${PREFIX}-D: ${NOTA_5("1")}`);
  const inainteAd = JSON.stringify(pretLinii(PAD));
  r = await cer("post", `/stocuri/ct-park/palet/${PAD}/adauga`, DEP, { body: { ["adauga_" + linieAd]: "10", ["pret_" + linieAd]: "3", pret_moneda: "EUR", pret_curs: "cinci" } });
  bine("cu un curs greșit: nimic adăugat, cu motivul", /Cursul nu e un număr pozitiv/.test(parametri(r).eroare || "") && JSON.stringify(pretLinii(PAD)) === inainteAd, unde(r));
  r = await cer("post", `/stocuri/ct-park/palet/${PAD}/adauga`, DEP, { body: { ["adauga_" + linieAd]: "20", ["pret_" + linieAd]: "12,5", pret_moneda: "RON" } });
  egal("în lei: ca până acum, fără notă la adăugare", [pretLinii(PAD)[0], q(`SELECT id, observatii FROM ct_palet_adaugari WHERE palet_id = ${PAD} ORDER BY id DESC LIMIT 1`)[0].observatii], [[12.5, "medie după adăugare"], null]);

  // ------------------------------------------------------------------------
  console.log("\n8. Prețul pus după intrare");
  const P1 = palet(PC, 100, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${P1}/pret`, DEP, { body: { pret: "2", pret_moneda: "EUR", pret_curs: "5" } });
  egal("pe paletul fără preț, în euro: în lei, cu nota în sursă — pe antet și pe linie", [pretAntet(P1), pretLinii(P1)], [[10, "pus după intrare: " + NOTA_5("2")], [[10, "pus după intrare: " + NOTA_5("2")]]]);
  bine("…mesajul spune leii și din ce s-au făcut", (parametri(r).ok || "").includes("Prețul de 10 lei / buc (" + NOTA_5("2") + ") e pus pe"), parametri(r).ok);
  egal("…iar istoricul prețului are rândul lui", q(`SELECT pret_vechi, pret_nou FROM ct_palet_preturi WHERE palet_id = ${P1}`).map((y) => [n(y.pret_vechi), n(y.pret_nou)]), [[null, 10]]);
  r = await cer("post", `/stocuri/ct-park/palet/${P1}/pret`, ADMIN, { body: { pret: "2,2", pret_moneda: "EUR", pret_curs: "" } });
  egal("administratorul îl corectează tot în euro, la BNR", pretAntet(P1), [rot6(2.2 * EUR.valoare), "corectat după intrare: " + NOTA_BNR("2.2")]);
  const P2 = palet(PC, 100, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${P2}/pret`, DEP, { body: { pret: "2", pret_moneda: "EUR", pret_curs: "cinci" } });
  egal("curs greșit: prețul nu se pune, cu motivul", [/Cursul nu e un număr pozitiv/.test(parametri(r).eroare || ""), pretAntet(P2)], [true, [null, null]]);
  r = await cer("post", `/stocuri/ct-park/palet/${P2}/pret`, DEP, { body: { pret: "abc", pret_moneda: "EUR", pret_curs: "5" } });
  bine("preț care nu e număr, în euro: mesajul spune în ce monedă se scrie", /în EUR pe unitatea de măsură/.test(parametri(r).eroare || "") && pretAntet(P2)[0] === null, parametri(r).eroare);
  const linieP2 = Number(unul(`SELECT id FROM ct_palet_linii WHERE palet_id = ${P2}`));
  r = await cer("post", `/stocuri/ct-park/palet/${P2}/pret`, DEP, { body: { ["pret_" + linieP2]: "0,5", pret_moneda: "USD", pret_curs: "4,6" } });
  egal("din fișa paletului, pe produs, în dolari", pretLinii(P2), [[2.3, "pus după intrare: 0,5 USD × 4,6000 (curs pus de voi)"]]);
  const P3 = palet(PC, 100, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${P3}/pret`, DEP, { body: { pret: "7,35", pret_moneda: "RON", pret_curs: "5" } });
  egal("în lei: ca până acum", [pretAntet(P3), (parametri(r).ok || "").includes("Prețul de 7,35 lei / buc e pus pe")], [[7.35, "pus după intrare"], true]);

  // ------------------------------------------------------------------------
  console.log("\n9. „La fel și pe ceilalți”");
  const [F1, F2, F3] = [palet(PD, 10, "buc", null), palet(PD, 20, "buc", null), palet(PD, 30, "buc", 9)];
  r = await cer("post", `/stocuri/ct-park/palet/${F1}/pret`, DEP, { body: { pret: "2", pret_moneda: "EUR", pret_curs: "5", la_fel: "1" } });
  egal("prețul în euro pus și pe celălalt palet fără preț, cu aceeași notă; cel cu preț rămâne", [pretAntet(F1), pretAntet(F2), pretAntet(F3)], [[10, "pus după intrare: " + NOTA_5("2")], [10, "pus după intrare: " + NOTA_5("2")], [9, "scris la intrare"]]);
  bine("…și mesajul o spune", /La fel pe încă un palet/.test(parametri(r).ok || "") || /La fel pe încă 1 palet/.test(parametri(r).ok || ""), parametri(r).ok);

  // ------------------------------------------------------------------------
  console.log("\n10. Paginile: lista de paleți și fișa paletului");
  // Un palet fără preț, ca rândul lui să aibă formularul: cei de mai sus și-au primit prețurile.
  palet(PC, 7, "buc", null);
  r = await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { fara_pret: "1", q: `${PREFIX} Plic` } });
  bine("lista de paleți: alegerea monedei deasupra, câmpurile ascunse pe fiecare rând, scriptul", r.cod === 200 && r.corp.includes('id="moneda-preturi"') && r.corp.includes("Prețurile din listă sunt în") && r.corp.includes('data-pv-copie="moneda"') && r.corp.includes('name="pret" type="text" inputmode="decimal" autocomplete="off" required data-pv-pret') && r.corp.includes("window.PV_BNR"), r.cod);
  r = await cer("get", `/stocuri/ct-park/palet/${P3}`, ADMIN);
  bine("fișa paletului: alegerea monedei și în „Prețul de intrare”, și în „Adaugă marfă”", r.cod === 200 && (r.corp.match(/name="pret_moneda" data-pv-moneda/g) || []).length === 2 && r.corp.includes("Prețurile scrise sunt în") && r.corp.includes("Prețul e scris în") && r.corp.includes("Preț nou (<span data-pv-um>lei</span> / UM)"), (r.corp.match(/name="pret_moneda" data-pv-moneda/g) || []).length);
  r = await cer("get", `/stocuri/ct-park/palet/${P1}`, DEP);
  bine("…iar sursa cu euro și cursul se vede lângă preț", r.corp.includes("corectat după intrare: " + NOTA_BNR("2.2")), "");

  // ------------------------------------------------------------------------
  console.log("\n11. Mișcarea de stoc scrisă de mână");
  const miscari = () => q(`SELECT pret_unitar, observatii FROM miscari_stoc WHERE produs_id = ${PA} ORDER BY id`).map((y) => [n(y.pret_unitar), y.observatii]);
  r = await cer("post", "/stocuri/miscare", ADMIN, { body: { produs_id: String(PA), depozit_id: String(DEPOZIT), tip: "intrare", cantitate: "10", pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "5", observatii: "NIR 7" } });
  egal("prețul în euro: în lei, iar observațiile țin minte din ce s-a făcut", [unde(r), miscari()], ["/stocuri", [[6.25, "NIR 7 · preț: " + NOTA_5("1.25")]]]);
  r = await cer("post", "/stocuri/miscare", ADMIN, { body: { produs_id: String(PA), depozit_id: String(DEPOZIT), tip: "intrare", cantitate: "10", pret_unitar: "1,25", pret_moneda: "EUR", pret_curs: "cinci" } });
  bine("curs greșit: mișcarea nu se scrie, formularul spune de ce", miscari().length === 1 && unde(r).startsWith("/stocuri/miscare/nou?eroare=") && /Cursul nu e un număr pozitiv/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("post", "/stocuri/miscare", ADMIN, { body: { produs_id: String(PA), depozit_id: String(DEPOZIT), tip: "intrare", cantitate: "10", pret_unitar: "7.35", observatii: "" } });
  r = await cer("post", "/stocuri/miscare", ADMIN, { body: { produs_id: String(PA), depozit_id: String(DEPOZIT), tip: "iesire", cantitate: "2", pret_unitar: "", pret_moneda: "EUR", pret_curs: "cinci" } });
  egal("în lei: ca până acum; fără preț: zero, oricare ar fi moneda", miscari().slice(1), [[7.35, null], [0, null]]);
  r = await cer("get", "/stocuri/miscare/nou", ADMIN, { query: { eroare: "Ceva <greșit>" } });
  bine("formularul mișcării are alegerea monedei și arată eroarea, scăpată", r.cod === 200 && r.corp.includes('name="pret_moneda" data-pv-moneda') && r.corp.includes('name="pret_unitar" data-pv-pret') && r.corp.includes("Ceva &lt;greșit&gt;"), r.cod);

  curata();
  console.log(esecuri ? `\n${esecuri} ESEC(URI)` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
