"use strict";
// Prețul de intrare al paleților din CT-Park.
//
// CE A CERUT VALI, 11.11.2026, cu poza listei de paleți („107 paleți n-au preț
// la intrare, deci nu sunt la socoteală"):
//   „Să pot pune preț de intrare de aici / modifica la care nu au, și să fie
//    obligatoriu de introdus la intrare marfă în depozit preț intrare."
//   „Și afișează și la stoc la zi preț la fiecare produs."
//
// CE APĂRĂ:
//   • REGULA: prețul e ce a scris omul, altfel ce știe ERP-ul — rândul
//     recepției, apoi costul produsului (rețetă, producție, achiziție). Prețul
//     scris egal cu cel propus își păstrează sursa. Dacă nu-l știe nimeni,
//     marfa NU intră.
//   • PESTE TOT PE UNDE SE FAC PALEȚI: Intrare marfă (și confirmarea
//     locurilor propuse), scanerul, paleții făcuți din recepție, marfa adăugată
//     pe un palet din raft. Două excepții, pentru că omul din depozit n-are
//     de unde ști prețul și l-ar scrie din burtă: marfa care pleacă direct,
//     fără raft, și marfa făcută de noi al cărei produs n-are cost în ERP —
//     paletul intră fără preț și apare la „fără preț", pentru birou.
//   • PREȚUL PUS DUPĂ INTRARE: din lista de paleți sau din fișa paletului. Pe
//     un palet fără preț îl pune oricine face intrări; un preț existent îl
//     schimbă doar administratorul. Fiecare schimbare rămâne în istoric. „La
//     fel pe ceilalți" atinge doar paleții din depozit cu aceeași marfă și
//     același preț (sau tot fără preț).
//   • PALETUL FĂRĂ CANTITATE nu-și pierde produsul când primește preț.
//   • STOC LA ZI: prețul mediu și valoarea, pe produs — doar pentru cine are
//     Depozitul; agentul nu vede nici coloana, nici cifrele.
//
// Pe PostgreSQL real (port 5433), prin psql; la sfârșit, formularul de intrare
// într-un browser.
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

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- datele de test ------------------------------------------------------
const PREFIX = "TPI";
// PA: preț de achiziție · PB: nimic · PC: rețetă întreagă · PD: rețetă cu
// componente fără cost · PE: cost de producție · PF: al doilea fără nimic ·
// PG, PH: pentru „la fel pe ceilalți" · PI: produs cu toate trei.
const [PA, PB, PC, PD, PE, PF, PG, PH, PI] = [98301, 98302, 98303, 98304, 98305, 98306, 98307, 98308, 98309];
const PRODUSE = [PA, PB, PC, PD, PE, PF, PG, PH, PI];
const FURNIZOR = 98311;
const NR_REC = PREFIX + "-R1";
// Cereri ale depozitului: din producție cu cost pe produs, de la terț fără
// niciun preț, din producție fără cost pe produs.
const [A_CU, A_FARA, A_PROD] = [98321, 98322, 98323];

function curata() {
  const pr = PRODUSE.join(",");
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-R%'`).map((x) => Number(x.id)).join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE produs_id IN (${pr}) OR cod LIKE '${PREFIX}-%' OR produs_text LIKE '${PREFIX} %' OR receptie_id IN (${rec}) OR aprovizionare_id IN (${A_CU}, ${A_FARA}, ${A_PROD})
                    OR id IN (SELECT palet_id FROM ct_palet_linii WHERE produs_id IN (${pr}) OR produs_text LIKE '${PREFIX} %')`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_tipar WHERE creat_de LIKE '${PREFIX} %'`);
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
  q(`DELETE FROM aprovizionari WHERE id IN (${A_CU}, ${A_FARA}, ${A_PROD})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM parteneri WHERE id = ${FURNIZOR}`);
}
const azi = () => new Date().toISOString().slice(0, 10);
let nrPalet = 0;
// Un palet din depozit, scris direct: antetul și linia lui. `pret` null = fără preț.
function palet(produs, cant, um, pret, { text, sursa, iesit, faraLinie } = {}) {
  const cod = `${PREFIX}-PAL-${++nrPalet}`;
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, cantitate_intrare, um, data_intrare, data_iesire, pret_unitar, pret_sursa)
     VALUES ('${cod}', ${produs || "NULL"}, ${text ? lit(text) : "NULL"}, ${cant == null ? "NULL" : cant}, ${cant == null ? "NULL" : cant}, '${um}', '2026-11-01', ${iesit ? "'2026-11-05'" : "NULL"}, ${pret == null ? "NULL" : pret}, ${pret == null ? "NULL" : lit(sursa || "scris la intrare")}) RETURNING id`));
  if (!faraLinie) {
    q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar, pret_sursa)
       VALUES (${id}, ${produs || "NULL"}, ${text ? lit(text) : produs ? `(SELECT denumire FROM produse WHERE id = ${produs})` : "NULL"}, ${cant == null ? 0 : cant}, '${um}', ${pret == null ? "NULL" : pret}, ${pret == null ? "NULL" : lit(sursa || "scris la intrare")})`);
  }
  return id;
}
const n = (v) => (v == null ? null : Number(v));
const antet = (id) => q(`SELECT produs_id, produs_text, cantitate, pret_unitar, pret_sursa FROM ct_paleti WHERE id = ${id}`).map((x) => [n(x.produs_id), x.produs_text, n(x.cantitate), n(x.pret_unitar), x.pret_sursa])[0];
const pretAntet = (id) => q(`SELECT pret_unitar, pret_sursa FROM ct_paleti WHERE id = ${id}`).map((x) => [n(x.pret_unitar), x.pret_sursa])[0];
const pretLinii = (id) => q(`SELECT pret_unitar, pret_sursa FROM ct_palet_linii WHERE palet_id = ${id} ORDER BY id`).map((x) => [n(x.pret_unitar), x.pret_sursa]);
const istoric = (id) => q(`SELECT pret_vechi, pret_nou, sursa_veche, creat_de, creat_la FROM ct_palet_preturi WHERE palet_id = ${id} ORDER BY id`).map((x) => [n(x.pret_vechi), n(x.pret_nou), x.sursa_veche, x.creat_de, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(x.creat_la))]);
const paletiiProdusului = (pid) => q(`SELECT id, cantitate, pret_unitar, pret_sursa FROM ct_paleti WHERE produs_id = ${pid} ORDER BY id`).map((x) => [n(x.cantitate), n(x.pret_unitar), x.pret_sursa]);
const fara = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
// Rândul din lista de paleți al unui palet, după codul lui.
const randLista = (html, cod) => { const m = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${cod}</a>[\\s\\S]*?</tr>`).exec(html); return m ? m[0] : ""; };
const coduri = (html) => (fara(html).match(new RegExp(`${PREFIX}-PAL-\\d+`, "g")) || []).filter((v, i, a) => a.indexOf(v) === i);

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: `${PREFIX} Depozit`, rol: "depozit", sectiuni: "" };
  const ADMIN = { id: idUser, nume: `${PREFIX} Admin`, rol: "admin", sectiuni: "" };
  const AGENT = { id: idUser, nume: `${PREFIX} Agent`, rol: "vanzari", sectiuni: "/crm" };
  const AUTH = require(path.join(RAD, "lib", "auth.js"));

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie, pret_productie, cost_reteta, cost_reteta_lipsa) VALUES
       (${PA}, '${PREFIX}-A', '${PREFIX} Folie cu pret de achizitie', 'kg', 2.5, NULL, NULL, NULL),
       (${PB}, '${PREFIX}-B', '${PREFIX} Marfa fara niciun pret', 'buc', NULL, NULL, NULL, NULL),
       (${PC}, '${PREFIX}-C', '${PREFIX} Produs cu reteta intreaga', 'buc', 9, 8, 1.234567, 0),
       (${PD}, '${PREFIX}-D', '${PREFIX} Produs cu reteta incompleta', 'buc', NULL, NULL, 3, 2),
       (${PE}, '${PREFIX}-E', '${PREFIX} Produs cu cost de productie', 'buc', 5, 4.4, NULL, NULL),
       (${PF}, '${PREFIX}-F', '${PREFIX} Alta marfa fara pret', 'buc', 0, 0, 0, NULL),
       (${PG}, '${PREFIX}-G', '${PREFIX} Plic la fel', 'buc', NULL, NULL, NULL, NULL),
       (${PH}, '${PREFIX}-H', '${PREFIX} Eticheta marunta', 'buc', 0.016678, NULL, NULL, NULL),
       (${PI}, '${PREFIX}-I', '${PREFIX} Produs de cautat', 'buc', NULL, NULL, NULL, NULL)`);
  // O recepție finalizată: L1 are preț pe rând; L2 nu, dar produsul are; L3 nimic.
  const RID = Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare, finalizata_la) VALUES ('${NR_REC}', 'furnizor', ${FURNIZOR}, '${azi()}', 'finalizata', '${azi()} 10:00:00') RETURNING id`));
  const linieRec = (produs, cant, um, pret) => Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, pret_unitar, stare, conditie)
       VALUES (${RID}, ${produs}, ${cant}, ${cant}, '${um}', ${pret == null ? "NULL" : pret}, 'primita', 'bun') RETURNING id`));
  const L1 = linieRec(PB, 100, "buc", 7.35);
  const L2 = linieRec(PA, 200, "kg", null);
  const L3 = linieRec(PF, 300, "buc", null);
  // …și una din producția noastră: L4 fără cost pe produs, L5 cu rețetă.
  const RID2 = Number(unul(`INSERT INTO receptii (numar, sursa, data, stare, finalizata_la) VALUES ('${PREFIX}-R2', 'productie', '${azi()}', 'finalizata', '${azi()} 10:00:00') RETURNING id`));
  const linieProd = (produs, cant) => Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie)
       VALUES (${RID2}, ${produs}, ${cant}, ${cant}, 'buc', 'primita', 'bun') RETURNING id`));
  const L4 = linieProd(PB, 500);
  const L5 = linieProd(PC, 60);
  q(`INSERT INTO aprovizionari (id, comanda_id, produs_id, cantitate, sursa, status, furnizor_id, creata_la) VALUES
       (${A_CU}, NULL, ${PC}, 40, 'productie', 'gata', NULL, '${azi()}'), (${A_FARA}, NULL, ${PF}, 50, 'tert', 'primita', ${FURNIZOR}, '${azi()}'),
       (${A_PROD}, NULL, ${PF}, 70, 'productie', 'gata', NULL, '${azi()}')`);
  const libere = q(`SELECT l.id, l.rand_id, l.adresa FROM ct_locuri l JOIN ct_randuri rr ON rr.id = l.rand_id AND rr.activ = 1
                     WHERE COALESCE(l.blocat, 0) = 0 AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
                     ORDER BY l.id LIMIT 14`);
  if (libere.length < 14) throw new Error("depozitul de test nu are 14 locuri libere");
  let iLoc = 0;
  const locLiber = () => libere[iLoc++];
  const intrare = (campuri, cant) => {
    const l = locLiber();
    return cer("post", "/stocuri/ct-park/intrare", DEP, { body: Object.assign({ "loc_ids[]": String(l.id), "loc_rand[]": String(l.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": String(cant || 10) }, campuri) });
  };

  console.log("\n0. Tabelul istoricului de prețuri, din lib/db.js");
  {
    const src = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
    const a = src.indexOf("CREATE TABLE IF NOT EXISTS ct_palet_preturi (");
    const sfarsit = "CREATE INDEX IF NOT EXISTS idx_ct_palet_preturi_palet ON ct_palet_preturi (palet_id);";
    const z = src.indexOf(sfarsit);
    bine("lib/db.js îl creează, cu indexul lui", a > 0 && z > a);
    const ddl = src.slice(a, z + sfarsit.length);
    // De două ori, ca la fiecare pornire a serverului.
    for (let i = 0; i < 2; i++) execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", ddl], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
    egal("coloanele lui", q("SELECT column_name FROM information_schema.columns WHERE table_name = 'ct_palet_preturi' ORDER BY ordinal_position").map((x) => x.column_name), ["id", "palet_id", "palet_linie_id", "pret_vechi", "pret_nou", "sursa_veche", "creat_de", "creat_la"]);
  }

  console.log("\n1. Regula: de unde vine prețul");
  egal("costul produsului: rețeta întreagă bate costul de producție și prețul de achiziție", await CT.costProdus(PC), { pret: 1.234567, sursa: "costul din rețetă" });
  egal("…rețeta incompletă se ia, dar spune câte componente n-au cost", await CT.costProdus(PD), { pret: 3, sursa: "costul din rețetă (2 componente fără cost)" });
  egal("…fără rețetă: costul de producție, înaintea prețului de achiziție", await CT.costProdus(PE), { pret: 4.4, sursa: "costul de producție de pe produs" });
  egal("…doar preț de achiziție", await CT.costProdus(PA), { pret: 2.5, sursa: "preț de achiziție de pe produs" });
  egal("…nimic pe produs (sau zero peste tot, sau produs necunoscut): nu-l știe", [await CT.costProdus(PB), await CT.costProdus(PF), await CT.costProdus(0), await CT.costProdus(99999999)], [null, null, null, null]);
  egal("un preț mărunt își păstrează zecimalele; unul sub a șasea zecimală nu e preț", [CT.costDinProdus({ pret_achizitie: 0.0166775 }), CT.costDinProdus({ pret_achizitie: 0.0000004 }), CT.costDinProdus({ cost_reteta: 1, cost_reteta_lipsa: 1 }).sursa, CT.costDinProdus(null)], [{ pret: 0.016678, sursa: "preț de achiziție de pe produs" }, null, "costul din rețetă (1 componentă fără cost)", null]);
  egal("ce știe ERP-ul: rândul recepției, înaintea produsului", await CT.pretStiut({ receptie_linie_id: L1, produs_id: PB }), { pret: 7.35, sursa: "prețul din recepție" });
  egal("…rând de recepție fără preț: costul produsului", await CT.pretStiut({ receptie_linie_id: L2, produs_id: PA }), { pret: 2.5, sursa: "preț de achiziție de pe produs" });
  egal("…nici recepția, nici produsul", [await CT.pretStiut({ receptie_linie_id: L3, produs_id: PF }), await CT.pretStiut({}), await CT.pretStiut(null)], [null, null, null]);
  egal("prețul de intrare: ce a scris omul, cu virgulă sau cu punct", [await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "3,10" }), await CT.pretDeIntrare({ produs_id: PB, pret_unitar: "0.5" })], [{ pret: 3.1, sursa: "scris la intrare" }, { pret: 0.5, sursa: "scris la intrare" }]);
  egal("…scris la fel ca propunerea: rămâne sursa propunerii, nu „scris la intrare”", [await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "2,5" }), await CT.pretDeIntrare({ receptie_linie_id: L1, produs_id: PB, pret_unitar: "7.35" }), await CT.pretDeIntrare({ produs_id: PC, pret_unitar: "1,234567" })], [{ pret: 2.5, sursa: "preț de achiziție de pe produs" }, { pret: 7.35, sursa: "prețul din recepție" }, { pret: 1.234567, sursa: "costul din rețetă" }]);
  egal("…nescris, zero, negativ sau text: ce știe ERP-ul", [await CT.pretDeIntrare({ produs_id: PA }), await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "0" }), await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "-4" }), await CT.pretDeIntrare({ produs_id: PA, pret_unitar: "abc" })].map((x) => x && x.sursa), Array(4).fill("preț de achiziție de pe produs"));
  egal("…și dacă nu-l știe nimeni: nimic", [await CT.pretDeIntrare({ produs_id: PB }), await CT.pretDeIntrare({ produs_text: "ceva scris liber" }), await CT.pretDeIntrare({ produs_id: PB, pret_unitar: "0" }), await CT.pretDeIntrare(null)], [null, null, null, null]);
  egal("marfa făcută de noi: recepția din producție și cererea către producție — nu cea de la furnizor sau de la terț", [await CT.dinProductiaNoastra({ receptie_linie_id: L4 }), await CT.dinProductiaNoastra({ aprovizionare_id: A_PROD }), await CT.dinProductiaNoastra({ receptie_linie_id: L1 }), await CT.dinProductiaNoastra({ aprovizionare_id: A_FARA }), await CT.dinProductiaNoastra({}), await CT.dinProductiaNoastra(null)], [true, true, false, false, false, false]);
  egal("poate intra? cu preț da; fără preț doar marfa noastră fără cost sau cea care pleacă direct", [await CT.pretInRegula({ produs_id: PA }), await CT.pretInRegula({ produs_id: PB }), await CT.pretInRegula({ produs_id: PF, receptie_linie_id: L3 }), await CT.pretInRegula({ produs_id: PB, receptie_linie_id: L4 }), await CT.pretInRegula({ produs_id: PF, aprovizionare_id: A_PROD }), await CT.pretInRegula({ produs_id: PF, aprovizionare_id: A_FARA }), await CT.pretInRegula({ produs_id: PB }, { faraPret: true })], [true, false, false, true, true, false, true]);
  egal("cum se scrie un preț", [CT.scriePret(7.35), CT.scriePret(0.0166775), CT.scriePret(418.03), CT.scriePret(2)], ["7,35", "0,016678", "418,03", "2"]);

  console.log("\n2. Intrare marfă: formularul");
  let pag = (await cer("get", "/stocuri/ct-park/intrare", DEP)).corp;
  bine("căsuța de preț e obligatorie", /<input type="text" inputmode="decimal" name="pret_unitar" id="pret-intrare" required /.test(pag));
  bine("…goală, cu îndemnul de a-l scrie de pe factură", /name="pret_unitar" id="pret-intrare" required placeholder="ex\. 7,35"\s+value="">/.test(pag) && pag.includes("Scrie prețul de pe factura sau avizul furnizorului."));
  bine("…și spune că fără preț marfa nu intră", fara(pag).includes("Fără preț, marfa nu mai intră în depozit."));
  bine("valoarea intrării are locul ei, lângă total", pag.includes('id="valoare-intrare"'));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L1) } })).corp;
  bine("din recepție, cu preț pe rând: vine scris, cu sursa", pag.includes('value="7,35" data-propus="1"') && pag.includes("Propus: prețul din recepție. Îl poți schimba."));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L2) } })).corp;
  bine("din recepție, fără preț pe rând: cel de pe produs", pag.includes('value="2,5" data-propus="1"') && pag.includes("Propus: preț de achiziție de pe produs."));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L3) } })).corp;
  bine("din recepție, fără niciun preț: gol, și spune că ERP-ul nu-l știe", /id="pret-intrare" required placeholder="ex\. 7,35"\s+value="">/.test(pag) && pag.includes("ERP-ul nu știe prețul mărfii ăsteia"));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { aprovizionare: String(A_CU) } })).corp;
  bine("marfă gata din producție: costul din rețetă", pag.includes('value="1,234567" data-propus="1"') && pag.includes("Propus: costul din rețetă."));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L4) } })).corp;
  bine("marfă făcută de noi, fără cost pe produs: prețul NU e obligatoriu și spune de ce", /name="pret_unitar" id="pret-intrare" placeholder="ex\. 7,35"\s+value="">/.test(pag) && !/id="pret-intrare" required/.test(pag) && pag.includes("Marfă făcută de noi, iar produsul n-are încă un cost în ERP") && pag.includes("paletul intră fără preț și îl pune biroul"), (pag.match(/<label class="field">Preț de intrare[\s\S]{0,400}/) || [""])[0]);
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { aprovizionare: String(A_PROD) } })).corp;
  bine("…la fel la cererea depozitului către producție", !/id="pret-intrare" required/.test(pag) && pag.includes("Marfă făcută de noi"));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L5) } })).corp;
  bine("marfă făcută de noi, cu rețetă: prețul vine din rețetă și e obligatoriu, ca la orice marfă cu preț știut", pag.includes('value="1,234567" data-propus="1"') && /id="pret-intrare" required/.test(pag));
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { q: `${PREFIX} ` } })).corp;
  const buton = (id) => (new RegExp(`<input type="radio" name="produs_id" value="${id}"[^>]*>`).exec(pag) || [""])[0];
  bine("produsele găsite prin căutare își poartă prețul și sursa lui", buton(PA).includes('data-pret="2,5" data-pret-sursa="preț de achiziție de pe produs"') && buton(PC).includes('data-pret="1,234567" data-pret-sursa="costul din rețetă"') && buton(PD).includes('data-pret-sursa="costul din rețetă (2 componente fără cost)"'), buton(PA) + buton(PC));
  bine("…iar cele fără preț nu poartă nimic", buton(PB).length > 0 && !buton(PB).includes("data-pret") && !buton(PF).includes("data-pret"), buton(PB));

  console.log("\n3. Intrare marfă: fără preț nu intră");
  let r = await intrare({ produs_id: String(PB), um: "buc" });
  egal("produs fără preț, nimic scris: refuzat, niciun palet", [r.cod, paletiiProdusului(PB)], [422, []]);
  bine("…cu mesajul care spune ce e de făcut și cu drumul înapoi la formular", r.corp.includes(`${PREFIX} Marfa fara niciun pret n-a intrat în depozit.`) && r.corp.includes("Scrie prețul de intrare, în lei pe unitatea de măsură.") && r.corp.includes('onclick="history.back()"'));
  r = await intrare({ produs_text: `${PREFIX} marfa scrisa liber`, um: "buc", pret_unitar: "0" });
  egal("marfă scrisă liber, cu preț zero: refuzată", [r.cod, Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE produs_text = '${PREFIX} marfa scrisa liber'`))], [422, 0]);
  r = await intrare({ produs_id: String(PB), um: "buc", pret_unitar: "7,35" }, 60);
  bine("cu prețul scris: intră și duce la etichete", /\/stocuri\/ct-park\/etichete\?paleti=\d+/.test(unde(r)), unde(r) + " " + r.cod);
  egal("…cu prețul pe antet și pe linie, „scris la intrare”", [paletiiProdusului(PB), pretLinii(Number(unul(`SELECT id FROM ct_paleti WHERE produs_id = ${PB}`)))], [[[60, 7.35, "scris la intrare"]], [[7.35, "scris la intrare"]]]);
  r = await intrare({ produs_id: String(PA), um: "kg" }, 20);
  egal("nimic scris, dar produsul are preț: intră cu el și spune de unde", paletiiProdusului(PA), [[20, 2.5, "preț de achiziție de pe produs"]]);
  r = await intrare({ produs_id: String(PC), um: "buc", pret_unitar: "1,234567" }, 5);
  egal("prețul propus, lăsat neschimbat: rămâne „costul din rețetă”", paletiiProdusului(PC), [[5, 1.234567, "costul din rețetă"]]);
  r = await intrare({ produs_id: String(PE), um: "buc", pret_unitar: "4,9" }, 5);
  egal("prețul propus, schimbat de om: „scris la intrare”", paletiiProdusului(PE), [[5, 4.9, "scris la intrare"]]);
  r = await intrare({ produs_id: String(PB), um: "buc", receptie_id: String(RID), receptie_linie_id: String(L1), pret_unitar: "7,35" }, 30);
  egal("din recepție, cu prețul ei: „prețul din recepție”", paletiiProdusului(PB)[1], [30, 7.35, "prețul din recepție"]);
  r = await intrare({ produs_id: String(PB), um: "buc", receptie_id: String(RID2), receptie_linie_id: String(L4) }, 100);
  egal("marfă făcută de noi, fără cost pe produs: intră și fără preț", [/etichete\?paleti=\d+/.test(unde(r)), paletiiProdusului(PB)[2]], [true, [100, null, null]]);
  r = await intrare({ produs_id: String(PB), um: "buc", receptie_id: String(RID2), receptie_linie_id: String(L4), pret_unitar: "0,8" }, 50);
  egal("…iar dacă omul știe prețul și îl scrie, intră cu el", paletiiProdusului(PB)[3], [50, 0.8, "scris la intrare"]);
  // Confirmarea locurilor propuse (pagina a doua).
  const lc = locLiber();
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { grup_0: String(lc.id), cant_0: "10", produs_id: String(PF), um: "buc" } });
  egal("confirmarea locurilor, fără preț: refuzată", [r.cod, paletiiProdusului(PF)], [422, []]);
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { grup_0: String(lc.id), cant_0: "10", produs_id: String(PF), um: "buc", pret_unitar: "1,5" } });
  egal("…cu preț: intră", [/etichete\?paleti=\d+/.test(unde(r)), paletiiProdusului(PF)], [true, [[10, 1.5, "scris la intrare"]]]);
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, { body: { produs_id: String(PF), um: "buc" } });
  egal("confirmarea fără niciun palet bifat se întoarce la formular, ca până acum", unde(r), "/stocuri/ct-park/intrare");

  console.log("\n4. Plasa din puneMarfa și marfa care pleacă direct");
  let aruncat = "";
  try { await CT.puneMarfa({ user: DEP }, { produs_id: String(PG), um: "buc" }, [[]], 10); } catch (e) { aruncat = e.message; }
  egal("orice altă cale care ar face un palet fără preț e oprită", [aruncat, paletiiProdusului(PG)], [CT.MESAJ_FARA_PRET, []]);
  let ids = await CT.puneMarfa({ user: DEP }, { produs_id: String(PG), um: "buc", iesire_plan: "fulfillment" }, [[]], 10, { faraPret: true });
  egal("marfa care pleacă direct, fără raft: trece și fără preț", [ids.length, paletiiProdusului(PG)], [1, [[10, null, null]]]);
  ids = await CT.puneMarfa({ user: DEP }, { produs_id: String(PC), um: "buc", iesire_plan: "fulfillment" }, [[]], 3, { faraPret: true });
  egal("…dar dacă ERP-ul știe prețul, îl ia", paletiiProdusului(PC)[1], [3, 1.234567, "costul din rețetă"]);
  let x = await REC.livrareDirecta(DEP, RID, L3, "fulfillment", "", 40);
  bine("direct la livrare dintr-o recepție fără preț: nu e oprită", !x.eroare && paletiiProdusului(PF).some((p) => p[0] === 40 && p[1] === null), JSON.stringify(x) + JSON.stringify(paletiiProdusului(PF)));

  console.log("\n5. Scanerul");
  x = await SC.faPaleti(DEP, "r" + L3, [50], []);
  egal("rând de recepție fără preț: paleții nu se fac, și spune de ce", [x.eroare, x.faraPret, paletiiProdusului(PF).filter((p) => p[0] === 50).length], [CT.MESAJ_FARA_PRET, true, 0]);
  x = await SC.faPaleti(DEP, "r" + L3, [50, 50], [], { pret: "0,25" });
  egal("…cu prețul scris pe pagină: se fac, cu el", [x.ok, paletiiProdusului(PF).filter((p) => p[0] === 50)], [true, [[50, 0.25, "scris la intrare"], [50, 0.25, "scris la intrare"]]]);
  x = await SC.faPaleti(DEP, "r" + L2, [80], []);
  egal("rând fără preț, dar cu preț pe produs: se face fără să ceară nimic", [x.ok, paletiiProdusului(PA).filter((p) => p[0] === 80)], [true, [[80, 2.5, "preț de achiziție de pe produs"]]]);
  x = await SC.faPaleti(DEP, "c" + A_FARA, [10], []);
  egal("cerere a depozitului de la un terț, fără preț pe produs: oprită", [x.faraPret, x.eroare], [true, CT.MESAJ_FARA_PRET]);
  x = await SC.faPaleti(DEP, "c" + A_PROD, [25], []);
  egal("cerere către producția noastră, fără cost pe produs: paletul se face fără preț", [x.ok, paletiiProdusului(PF).filter((p) => p[0] === 25)], [true, [[25, null, null]]]);
  x = await SC.faPaleti(DEP, "r" + L4, [35], []);
  egal("…la fel rândul unei recepții din producție", [x.ok, paletiiProdusului(PB).filter((p) => p[0] === 35)], [true, [[35, null, null]]]);
  x = await SC.faPaleti(DEP, "r" + L5, [20], []);
  egal("…iar cu rețetă pe produs, intră cu costul din rețetă", [x.ok, paletiiProdusului(PC).filter((p) => p[0] === 20)], [true, [[20, 1.234567, "costul din rețetă"]]]);
  x = await SC.faPaleti(DEP, "c" + A_CU, [10], []);
  egal("…cu rețetă pe produs: intră cu costul din rețetă", [x.ok, paletiiProdusului(PC).filter((p) => p[0] === 10)], [true, [[10, 1.234567, "costul din rețetă"]]]);
  // Întrebarea „ai scris mai mult decât era de pus" vine după preț, nu înainte.
  x = await SC.faPaleti(DEP, "c" + A_FARA, [999], []);
  egal("prețul lipsă se spune înaintea întrebării despre cantitatea prea mare", [x.faraPret, x.peste === undefined], [true, true]);
  egal("ce știe ERP-ul despre un rând, pentru pagini", [await SC.pretRand("r" + L1), await SC.pretRand("r" + L3), await SC.pretRand("c" + A_CU), await SC.pretRand("c" + A_FARA), await SC.pretRand("x1")], [{ pret: 7.35, sursa: "prețul din recepție" }, null, { pret: 1.234567, sursa: "costul din rețetă" }, null, null]);
  const SCAN = "/stocuri/ct-park/scaner";
  pag = (await cer("get", `${SCAN}/intrare/rand/r${L3}`, DEP)).corp;
  bine("pagina scanerului, rând fără preț: căsuță de preț, obligatorie, ținută minte între scanări", /<input name="pret" data-tine="pret" inputmode="decimal" value="" autocomplete="off" required>/.test(pag) && pag.includes("ERP-ul nu-l știe"), (pag.match(/<label class="sc-f">Preț[\s\S]{0,300}/) || [""])[0]);
  pag = (await cer("get", `${SCAN}/intrare/rand/r${L3}`, DEP, { query: { pret: "0,3" } })).corp;
  bine("…prețul scris rămâne în căsuță după o scanare", pag.includes('name="pret" data-tine="pret" inputmode="decimal" value="0,3"'));
  pag = (await cer("get", `${SCAN}/intrare/rand/r${L1}`, DEP)).corp;
  bine("rând cu preț știut: doar îl arată, fără căsuță", pag.includes('id="sc-pret-stiut"') && /Preț de intrare: <strong>7,35 lei \/ buc<\/strong> — prețul din recepție/.test(pag) && !pag.includes('data-tine="pret"'), (pag.match(/sc-pret-stiut[\s\S]{0,200}/) || [""])[0]);
  pag = (await cer("get", `${SCAN}/intrare/rand/r${L4}`, DEP)).corp;
  bine("marfă făcută de noi, fără cost: căsuța de preț e la alegere, nu obligatorie", /<input name="pret" data-tine="pret" inputmode="decimal" value="" autocomplete="off">/.test(pag) && pag.includes("produsul n-are cost în ERP; scrie-l doar dacă îl știi"), (pag.match(/<label class="sc-f">Preț[\s\S]{0,300}/) || [""])[0]);
  r = await cer("post", `${SCAN}/intrare/rand/r${L3}`, DEP, { body: { actiune: "paleti", cant: "20" } });
  bine("trimis fără preț: se întoarce pe pagină cu mesajul, și ține minte cantitatea", calea(r) === `${SCAN}/intrare/rand/r${L3}` && parametri(r).eroare === CT.MESAJ_FARA_PRET && parametri(r).cant === "20", unde(r));
  r = await cer("post", `${SCAN}/intrare/rand/r${L3}`, DEP, { body: { actiune: "paleti", cant: "20", pret: "0,3" } });
  egal("trimis cu preț: paletul se face cu el", [calea(r), paletiiProdusului(PF).filter((p) => p[0] === 20)], [`${SCAN}/intrare`, [[20, 0.3, "scris la intrare"]]]);

  console.log("\n6. Paleții făcuți din recepție");
  pag = (await cer("get", `/depozit/receptie/${RID}`, DEP)).corp;
  bine("rândul fără preț are căsuța lui de preț", pag.includes(`name="pret_${L3}"`) && pag.includes("ERP-ul nu-l știe, scrie-l de pe factură sau aviz"));
  bine("…rândurile cu preț știut (pe rând sau pe produs) n-au", !pag.includes(`name="pret_${L1}"`) && !pag.includes(`name="pret_${L2}"`));
  const inainteRec = paletiiProdusului(PF).length;
  r = await cer("post", `/depozit/receptie/${RID}/paleti`, DEP, { body: { [`paleti_${L3}`]: "2 x 15" } });
  bine("fără preț: niciun palet, iar mesajul trimite la căsuța de preț a rândului", paletiiProdusului(PF).length === inainteRec && /Scrie prețul de intrare/.test(parametri(r).eroare || "") && /Scrie-l în căsuța de preț a rândului\./.test(parametri(r).eroare || ""), unde(r));
  r = await cer("post", `/depozit/receptie/${RID}/paleti`, DEP, { body: { [`paleti_${L3}`]: "2 x 15", [`pret_${L3}`]: "0,45" } });
  egal("cu preț: se fac amândoi paleții, cu el", [/etichete\?paleti=\d+,\d+/.test(unde(r)), paletiiProdusului(PF).filter((p) => p[0] === 15)], [true, [[15, 0.45, "scris la intrare"], [15, 0.45, "scris la intrare"]]]);

  pag = (await cer("get", `/depozit/receptie/${RID2}`, DEP)).corp;
  bine("recepția din producție: rândul fără cost are căsuța de preț la alegere; cel cu rețetă n-are", pag.includes(`name="pret_${L4}"`) && pag.includes("produsul n-are cost în ERP; scrie-l doar dacă îl știi") && !pag.includes(`name="pret_${L5}"`));
  r = await cer("post", `/depozit/receptie/${RID2}/paleti`, DEP, { body: { [`paleti_${L4}`]: "2 x 45" } });
  egal("…și paleții se fac și fără el", [/etichete\?paleti=\d+,\d+/.test(unde(r)), paletiiProdusului(PB).filter((p) => p[0] === 45)], [true, [[45, null, null], [45, null, null]]]);

  console.log("\n7. Marfa adăugată pe un palet din raft");
  const FP = palet(PB, 40, "buc", null);
  const liniaFP = Number(unul(`SELECT id FROM ct_palet_linii WHERE palet_id = ${FP}`));
  pag = (await cer("get", `/stocuri/ct-park/palet/${FP}`, DEP)).corp;
  bine("pe linia fără preț, căsuța cere prețul", new RegExp(`name="pret_${liniaFP}"[^>]*placeholder="scrie prețul"`).test(pag));
  r = await cer("post", `/stocuri/ct-park/palet/${FP}/adauga`, DEP, { body: { [`adauga_${liniaFP}`]: "10" } });
  bine("adaug pe o linie fără preț, fără să-l scriu: refuzat", /n-are preț pe palet: scrie-l în dreptul ei/.test(parametri(r).eroare || "") && antet(FP)[2] === 40, unde(r));
  r = await cer("post", `/stocuri/ct-park/palet/${FP}/adauga`, DEP, { body: { [`adauga_${liniaFP}`]: "10", [`pret_${liniaFP}`]: "2" } });
  egal("…cu prețul scris: se adaugă și paletul are de acum preț", [antet(FP).slice(2), pretLinii(FP)], [[50, 2, "scris la adăugare"], [[2, "scris la adăugare"]]]);
  const FA = palet(PA, 40, "kg", null);
  const liniaFA = Number(unul(`SELECT id FROM ct_palet_linii WHERE palet_id = ${FA}`));
  r = await cer("post", `/stocuri/ct-park/palet/${FA}/adauga`, DEP, { body: { [`adauga_${liniaFA}`]: "10" } });
  egal("linie fără preț, dar produsul are: îl ia de pe produs", [antet(FA).slice(2), /Adăugat pe palet/.test(parametri(r).ok || "")], [[50, 2.5, "preț de achiziție de pe produs"], true]);
  r = await cer("post", `/stocuri/ct-park/palet/${FA}/adauga`, DEP, { body: { nou_produs: `${PREFIX}-F`, nou_cantitate: "5" } });
  bine("„alt produs”, fără preț nicăieri: refuzat", /scrie și prețul: ERP-ul nu-l știe/.test(parametri(r).eroare || "") && pretLinii(FA).length === 1, unde(r));
  r = await cer("post", `/stocuri/ct-park/palet/${FA}/adauga`, DEP, { body: { nou_produs: `${PREFIX}-E`, nou_cantitate: "5" } });
  egal("„alt produs” cu cost pe el: linia nouă îl ia", pretLinii(FA), [[2.5, "preț de achiziție de pe produs"], [4.4, "costul de producție de pe produs"]]);
  r = await cer("post", `/stocuri/ct-park/palet/${FA}/adauga`, DEP, { body: { nou_produs: `${PREFIX}-F`, nou_cantitate: "5", nou_pret: "0,7" } });
  egal("„alt produs” cu prețul scris", pretLinii(FA)[2], [0.7, "scris la adăugare"]);

  console.log("\n8. Prețul pus după intrare");
  const S1 = palet(PI, 100, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${S1}/pret`, AGENT, { body: { pret: "3" } });
  egal("cine nu face intrări nu pune prețuri", [parametri(r).eroare, pretAntet(S1)], ["Prețul îl pune cine face intrările în depozit.", [null, null]]);
  for (const [scris, tipar] of [["", /Scrie prețul: un număr mai mare ca zero/], ["0", /scrie prețul ca număr mai mare ca zero/], ["-2", /mai mare ca zero/], ["doi lei", /mai mare ca zero/], ["0,0000001", /mai mare ca zero/]]) {
    r = await cer("post", `/stocuri/ct-park/palet/${S1}/pret`, DEP, { body: { pret: scris } });
    bine(`„${scris}” nu e preț`, tipar.test(parametri(r).eroare || "") && pretAntet(S1)[0] === null, unde(r));
  }
  r = await cer("post", `/stocuri/ct-park/palet/${S1}/pret`, DEP, { body: { pret: "3,25" } });
  egal("depozitul pune prețul pe un palet care n-avea: pe linie și pe antet", [pretAntet(S1), pretLinii(S1)], [[3.25, "pus după intrare"], [[3.25, "pus după intrare"]]]);
  egal("…rămâne scris cine, când, din cât în cât", istoric(S1), [[null, 3.25, null, `${PREFIX} Depozit`, true]]);
  egal("…și spune ce a făcut, pe fișa paletului", [calea(r), parametri(r).ok], [`/stocuri/ct-park/palet/${S1}`, `Prețul de 3,25 lei / buc e pus pe ${PREFIX}-PAL-${nrPalet}.`]);
  r = await cer("post", `/stocuri/ct-park/palet/${S1}/pret`, DEP, { body: { pret: "4" } });
  egal("un preț pus nu-l mai schimbă depozitul", [parametri(r).eroare, pretAntet(S1), istoric(S1).length], [`„${PREFIX} Produs de cautat” are deja preț (3,25 lei). Un preț pus îl schimbă doar administratorul.`, [3.25, "pus după intrare"], 1]);
  r = await cer("post", `/stocuri/ct-park/palet/${S1}/pret`, DEP, { body: { pret: "3,25" } });
  egal("același preț scris din nou: nimic de schimbat, nicio eroare", [parametri(r).ok, istoric(S1).length], [`${PREFIX}-PAL-${nrPalet} avea deja prețul ăsta.`, 1]);
  r = await cer("post", `/stocuri/ct-park/palet/${S1}/pret`, ADMIN, { body: { pret: "0,41803" } });
  egal("administratorul îl schimbă", [pretAntet(S1), pretLinii(S1), parametri(r).ok], [[0.41803, "corectat după intrare"], [[0.41803, "corectat după intrare"]], `Prețul lui ${PREFIX}-PAL-${nrPalet} e schimbat din 3,25 în 0,41803 lei / buc.`]);
  egal("…iar istoricul ține și prețul vechi, cu sursa lui", istoric(S1)[1], [3.25, 0.41803, "pus după intrare", `${PREFIX} Admin`, true]);
  const IESIT = palet(PI, 10, "buc", null, { iesit: true });
  r = await cer("post", `/stocuri/ct-park/palet/${IESIT}/pret`, ADMIN, { body: { pret: "3" } });
  bine("pe un palet ieșit din depozit nu se mai pune preț", /a ieșit din depozit — prețul lui nu se mai schimbă/.test(parametri(r).eroare || "") && pretAntet(IESIT)[0] === null, unde(r));
  r = await cer("post", "/stocuri/ct-park/palet/999999999/pret", ADMIN, { body: { pret: "3" } });
  egal("paletul care nu există", parametri(r).eroare, "Paletul nu există.");
  // Paletul fără cantitate: prețul se scrie, iar produsul rămâne pe antet.
  const FQ = palet(PI, null, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${FQ}/pret`, DEP, { body: { pret: "1,1" } });
  egal("palet fără cantitate: primește prețul și NU-și pierde produsul de pe antet", [antet(FQ), pretLinii(FQ)], [[PI, null, null, 1.1, "pus după intrare"], [[1.1, "pus după intrare"]]]);
  const FL = palet(PI, null, "buc", null, { faraLinie: true });
  r = await cer("post", `/stocuri/ct-park/palet/${FL}/pret`, DEP, { body: { pret: "1,2" } });
  egal("palet vechi, fără nicio linie: prețul se scrie pe antet, cu istoric", [antet(FL), istoric(FL).map((h) => h.slice(0, 2))], [[PI, null, null, 1.2, "pus după intrare"], [[null, 1.2]]]);
  // Paletul cu mai multe produse: pe fiecare, din fișa lui.
  const MIX = palet(PB, 10, "buc", null);
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar, pret_sursa) VALUES (${MIX}, ${PA}, '${PREFIX} Folie cu pret de achizitie', 30, 'buc', 2.5, 'scris la intrare')`);
  const [M1, M2] = q(`SELECT id FROM ct_palet_linii WHERE palet_id = ${MIX} ORDER BY id`).map((l) => Number(l.id));
  r = await cer("post", `/stocuri/ct-park/palet/${MIX}/pret`, DEP, { body: { pret: "5" } });
  bine("palet cu mai multe produse: un singur preț pe tot paletul nu se poate", /sunt mai multe produse: prețul se pune pe fiecare, din fișa paletului/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("post", `/stocuri/ct-park/palet/${MIX}/pret`, DEP, { body: { [`pret_${M1}`]: "1", [`pret_${M2}`]: "9" } });
  bine("…din fișă: depozitul nu poate schimba linia care are deja preț, și nu se scrie nici cealaltă", /are deja preț \(2,5 lei\)/.test(parametri(r).eroare || "") && JSON.stringify(pretLinii(MIX)) === JSON.stringify([[null, null], [2.5, "scris la intrare"]]), unde(r) + JSON.stringify(pretLinii(MIX)));
  r = await cer("post", `/stocuri/ct-park/palet/${MIX}/pret`, DEP, { body: { [`pret_${M1}`]: "1", [`pret_${M2}`]: "" } });
  egal("…doar linia fără preț: se pune, cealaltă rămâne; antetul ia media", [pretLinii(MIX), pretAntet(MIX)[0]], [[[1, "pus după intrare"], [2.5, "scris la intrare"]], 2.125]);
  r = await cer("post", `/stocuri/ct-park/palet/${MIX}/pret`, ADMIN, { body: { [`pret_${M1}`]: "2", [`pret_${M2}`]: "3" } });
  egal("…administratorul le schimbă pe amândouă dintr-o dată", [pretLinii(MIX), /^Prețurile sunt puse pe/.test(parametri(r).ok || ""), istoric(MIX).map((h) => h.slice(0, 2))], [[[2, "corectat după intrare"], [3, "corectat după intrare"]], true, [[null, 1], [1, 2], [2.5, 3]]]);
  // Înapoi: doar la lista de paleți (cu filtrele ei) sau la fișa paletului.
  const S2 = palet(PI, 5, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${S2}/pret`, DEP, { body: { pret: "2", inapoi: "/stocuri/ct-park/paleti?fara_pret=1&q=plic+g%2F17" } });
  egal("după salvare se întoarce în listă, cu filtrul ei și cu mesajul", [calea(r), parametri(r).fara_pret, parametri(r).q, /e pus pe/.test(parametri(r).ok || "")], ["/stocuri/ct-park/paleti", "1", "plic g/17", true]);
  for (const rau of ["https://alt.site/x", "//alt.site", "/stocuri/ct-park/paleti?x=<script>", "/admin/utilizatori", "/stocuri/ct-park/paleti/../../admin"]) {
    r = await cer("post", `/stocuri/ct-park/palet/${S2}/pret`, DEP, { body: { pret: "2", inapoi: rau } });
    bine(`„${rau}” nu e o adresă la care să se întoarcă: merge pe fișa paletului`, calea(r) === `/stocuri/ct-park/palet/${S2}` && !unde(r).includes("alt.site") && !unde(r).includes("admin"), unde(r));
  }

  console.log("\n9. „La fel și pe ceilalți”");
  // Paletul de la punctul 4, plecat direct și fără preț, a ieșit între timp.
  q(`UPDATE ct_paleti SET data_iesire = '2026-11-02' WHERE produs_id = ${PG}`);
  const codul = (id) => unul(`SELECT cod FROM ct_paleti WHERE id = ${id}`);
  const G1 = palet(PG, 100, "buc", null), G2 = palet(PG, 200, "buc", null), G3 = palet(PG, 300, "buc", null);
  const G_ALT_PRET = palet(PG, 50, "buc", 9);
  const G_IESIT = palet(PG, 50, "buc", null, { iesit: true });
  const G_MIX = palet(PG, 50, "buc", null);
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar) VALUES (${G_MIX}, ${PA}, 'x', 5, 'buc', NULL)`);
  const ALT = palet(PF, 50, "buc", null);
  const T1 = palet(null, 10, "buc", null, { text: `${PREFIX} Marfa Scrisa Liber` }), T2 = palet(null, 20, "buc", null, { text: `${PREFIX} marfa scrisa liber ` }), T3 = palet(null, 20, "buc", null, { text: `${PREFIX} alta marfa libera` });
  r = await cer("post", `/stocuri/ct-park/palet/${G1}/pret`, DEP, { body: { pret: "0,5" } });
  egal("fără bifă: doar paletul ăsta", [G1, G2, G3].map((id) => pretAntet(id)[0]), [0.5, null, null]);
  r = await cer("post", `/stocuri/ct-park/palet/${G2}/pret`, DEP, { body: { pret: "0,5", la_fel: "1" } });
  egal("cu bifă: și ceilalți paleți din depozit cu aceeași marfă, tot fără preț", [G2, G3].map((id) => pretAntet(id)), [[0.5, "pus după intrare"], [0.5, "pus după intrare"]]);
  egal("…fiecare cu rândul lui în istoric", [istoric(G2).length, istoric(G3).map((h) => h.slice(0, 2))], [1, [[null, 0.5]]]);
  egal("…și o spune", parametri(r).ok, `Prețul de 0,5 lei / buc e pus pe ${codul(G2)}. La fel pe încă 1 palet cu aceeași marfă.`);
  egal("neatinși: cel cu alt preț, cel ieșit, cel cu mai multe produse, altă marfă", [G_ALT_PRET, G_IESIT, G_MIX, ALT].map((id) => pretAntet(id)[0]), [9, null, null, null]);
  r = await cer("post", `/stocuri/ct-park/palet/${T1}/pret`, DEP, { body: { pret: "1,5", la_fel: "1" } });
  egal("marfă scrisă liber: aceeași denumire, fără să conteze literele mari sau spațiile de la capăt", [T1, T2, T3].map((id) => pretAntet(id)[0]), [1.5, 1.5, null]);
  // Corecția unui preț greșit, pe toți paleții care îl au.
  const C1 = palet(PH, 2400, "buc", 418.03, { sursa: "preț de achiziție de pe produs" }), C2 = palet(PH, 2400, "buc", 418.03, { sursa: "preț de achiziție de pe produs" }), C3 = palet(PH, 4800, "buc", 418.03, { sursa: "preț de achiziție de pe produs" });
  const C_BUN = palet(PH, 2400, "buc", 0.4124), C_FARA = palet(PH, 100, "buc", null);
  r = await cer("post", `/stocuri/ct-park/palet/${C1}/pret`, DEP, { body: { pret: "0,41803", la_fel: "1" } });
  egal("depozitul nu poate corecta un preț, nici cu bifa", [C1, C2, C3].map((id) => pretAntet(id)[0]), [418.03, 418.03, 418.03]);
  r = await cer("post", `/stocuri/ct-park/palet/${C1}/pret`, ADMIN, { body: { pret: "0,41803", la_fel: "1" } });
  egal("administratorul corectează prețul greșit pe toți paleții care îl au", [C1, C2, C3].map((id) => pretAntet(id)), Array(3).fill([0.41803, "corectat după intrare"]));
  egal("…fără să atingă paletul cu alt preț și nici pe cel fără preț", [pretAntet(C_BUN), pretAntet(C_FARA)], [[0.4124, "scris la intrare"], [null, null]]);
  egal("…cu prețul vechi și sursa lui în istoricul fiecăruia", [C2, C3].map((id) => istoric(id).map((h) => h.slice(0, 3))), Array(2).fill([[418.03, 0.41803, "preț de achiziție de pe produs"]]));
  egal("…și spune câți", parametri(r).ok, `Prețul lui ${codul(C1)} e schimbat din 418,03 în 0,41803 lei / buc. La fel pe încă 2 paleți cu aceeași marfă.`);

  console.log("\n10. Lista de paleți");
  pag = (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { q: PREFIX } })).corp;
  bine("cardul valorii duce la paleții fără preț", /n-au preț la intrare, deci nu sunt la socoteală — <a href="\/stocuri\/ct-park\/paleti\?fara_pret=1" id="arata-fara-pret">arată-i și pune prețurile<\/a>/.test(pag));
  bine("…și la cei mai scumpi întâi", pag.includes('<a href="/stocuri/ct-park/paleti?ordine=valoare">cei mai scumpi întâi</a>'));
  let rd = randLista(pag, `${PREFIX}-PAL-${nrPalet}`); // C_FARA: fără preț, alți paleți cu aceeași marfă au preț
  bine("paletul fără preț are căsuța și butonul „Pune” pe rândul lui", rd.includes(`action="/stocuri/ct-park/palet/${C_FARA}/pret"`) && rd.includes('name="pret"') && />Pune<\/button>/.test(rd) && rd.includes('placeholder="lei / buc"'), rd.slice(-700));
  bine("…formularul se întoarce în lista asta, cu căutarea ei", rd.includes(`name="inapoi" value="/stocuri/ct-park/paleti?q=${PREFIX}"`), rd.slice(-700));
  bine("…fără bifa „la fel”: e singurul cu marfa asta fără preț", !rd.includes('name="la_fel"'));
  rd = randLista(pag, coduri(pag).find((c) => randLista(pag, c).includes(`/palet/${ALT}/pret`)) || "x");
  bine("unde mai sunt paleți cu aceeași marfă fără preț, bifa spune câți", /name="la_fel" value="1"> și pe ceilalți \d+ cu aceeași marfă, tot fără preț/.test(rd), rd.slice(-500));
  rd = randLista(pag, coduri(pag).find((c) => randLista(pag, c).includes(`/palet/${G_MIX}`)) || "x");
  bine("paletul cu mai multe produse trimite la fișa lui", rd.includes(`href="/stocuri/ct-park/palet/${G_MIX}#pret">pune prețurile →</a>`) && !rd.includes('name="pret"'), rd.slice(-500));
  rd = randLista(pag, coduri(pag).find((c) => randLista(pag, c).includes(`>${PREFIX}-PAL-`) && randLista(pag, c).includes("0,4124")) || "x");
  bine("paletul cu preț arată valoarea și prețul pe unitate; depozitul nu-l poate schimba", /989,76 lei/.test(rd) && /0,4124 \/ buc/.test(rd) && !rd.includes("<form") && !rd.includes("modifică"), rd.slice(-500));
  pag = (await cer("get", "/stocuri/ct-park/paleti", ADMIN, { query: { q: PREFIX } })).corp;
  rd = randLista(pag, coduri(pag).find((c) => randLista(pag, c).includes("0,4124 / buc")) || "x");
  bine("administratorul are „modifică” la paletul cu preț", /<details class="pret-schimba"><summary>modifică<\/summary>/.test(rd) && rd.includes(`action="/stocuri/ct-park/palet/${C_BUN}/pret"`) && />Schimbă<\/button>/.test(rd), rd.slice(-700));
  rd = randLista(pag, coduri(pag).find((c) => randLista(pag, c).includes(`/palet/${C2}/pret`)) || "x");
  bine("…cu bifa pentru ceilalți paleți cu aceeași marfă și același preț", /și pe ceilalți 2 cu aceeași marfă și același preț/.test(rd), rd.slice(-500));
  pag = (await cer("get", "/stocuri/ct-park/paleti", AGENT, { query: { q: PREFIX } })).corp;
  bine("cine nu face intrări nu are nicio căsuță de preț", !pag.includes("/pret\"") && !pag.includes('name="la_fel"'));
  // Doar cei fără preț.
  pag = (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { fara_pret: "1", q: PREFIX } })).corp;
  // Fără preț sunt: paletul cu două produse fără preț, „altă marfă", marfa
  // scrisă liber rămasă fără și paletul de etichete pus fără preț. NU și
  // paletul FA: are trei produse în unități diferite, deci antetul lui n-are
  // nici cantitate, nici preț — dar fiecare linie are prețul ei.
  const faraPretAcum = [G_MIX, ALT, T3, C_FARA].map(codul);
  egal("filtrul „fără preț”: exact paleții din depozit cărora le lipsește un preț", coduri(pag).sort(), faraPretAcum.slice().sort());
  bine("…paletul cu produse în unități diferite, toate cu preț, nu e printre ei", !coduri(pag).includes(codul(FA)) && antet(FA)[3] === null, JSON.stringify(antet(FA)));
  bine("…cu explicația și cu drumul înapoi la toți paleții", pag.includes("Paleții din depozit fără preț la intrare.") && pag.includes(`<a href="/stocuri/ct-park/paleti?q=${PREFIX}">Arată toți paleții</a>`));
  bine("…filtrul rămâne la căutare și în adresa de întoarcere", pag.includes('<input type="hidden" name="fara_pret" value="1">') && pag.includes(`name="inapoi" value="/stocuri/ct-park/paleti?fara_pret=1&amp;q=${PREFIX}"`));
  {
    const cuToate = (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { fara_pret: "1", toate: "1", q: PREFIX } })).corp;
    egal("…paleții ieșiți, tot fără preț, nu apar nici cu „toate”: pe ei nu se mai pune", [coduri(cuToate).includes(codul(IESIT)), coduri(cuToate).includes(codul(G_IESIT)), coduri(cuToate).sort().join()], [false, false, faraPretAcum.slice().sort().join()]);
  }
  pag = (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { q: PREFIX } })).corp;
  rd = randLista(pag, codul(FA));
  bine("…iar valoarea lui e suma liniilor: 50 × 2,5 + 5 × 4,4 + 5 × 0,7", /150,50 lei/.test(rd) && !/fără preț/.test(rd), rd.slice(-400));
  const pePaleti = (await cer("get", "/stocuri/ct-park/stoc", DEP, { query: { vedere: "paleti", q: codul(FA) } })).corp;
  bine("…la fel în Stoc la zi pe paleți", /150,50 lei/.test(fara(pePaleti)), (fara(pePaleti).match(/150,50[\s\S]{0,80}|fără preț[\s\S]{0,80}/) || [""])[0]);
  pag = (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { ordine: "valoare", q: `${PREFIX} Eticheta` } })).corp;
  egal("cei mai scumpi întâi", coduri(pag).slice(0, 2).map((c) => Number(unul(`SELECT cantitate * pret_unitar FROM ct_paleti WHERE cod = '${c}'`)) > 1000), [true, true]);
  pag = (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { ok: "Prețul e pus.", eroare: "Ceva <b>rău</b>" } })).corp;
  bine("mesajele de după salvare se văd în listă, fără HTML strecurat", pag.includes('<div class="flash">Prețul e pus.</div>') && pag.includes("Ceva &lt;b&gt;rău&lt;/b&gt;"));

  console.log("\n11. Fișa paletului");
  pag = (await cer("get", `/stocuri/ct-park/palet/${C_FARA}`, DEP)).corp;
  bine("palet fără preț: formularul de preț, cu căsuța liniei", pag.includes(`action="/stocuri/ct-park/palet/${C_FARA}/pret" class="ct-pa-card" id="pret"`) && /<span class="badge galben">fără preț<\/span>/.test(pag) && new RegExp(`name="pret_\\d+" type="text" inputmode="decimal" autocomplete="off" placeholder="scrie prețul"`).test(pag));
  pag = (await cer("get", `/stocuri/ct-park/palet/${C_BUN}`, DEP)).corp;
  bine("palet cu preț, văzut de depozit: fără formular de preț", !pag.includes('id="pret"'));
  pag = (await cer("get", `/stocuri/ct-park/palet/${C1}`, ADMIN)).corp;
  bine("palet cu preț, văzut de administrator: formular cu „preț nou”", pag.includes('id="pret"') && pag.includes('placeholder="preț nou"') && /0,41803 lei \/ buc/.test(pag));
  bine("…și istoricul: din cât în cât, cine, și ce era înainte", /id="istoric-pret"/.test(pag) && /TPI Admin[\s\S]{0,80}418,03 → <strong>0,41803 lei<\/strong> <span[^>]*>\(era: preț de achiziție de pe produs\)<\/span>/.test(pag), (pag.match(/id="istoric-pret"[\s\S]{0,500}/) || [""])[0]);
  pag = (await cer("get", `/stocuri/ct-park/palet/${FQ}`, DEP)).corp;
  bine("palet fără cantitate: prețul se vede, formularul nu mai apare pentru depozit", /1,1 lei \/ buc/.test(pag) && !pag.includes('id="pret"'));
  pag = (await cer("get", `/stocuri/ct-park/palet/${FL}`, ADMIN)).corp;
  bine("palet fără nicio linie: administratorul are căsuța pe antet", pag.includes('id="pret"') && pag.includes('<input name="pret" type="text"'), (pag.match(/id="pret"[\s\S]{0,900}/) || [""])[0]);
  pag = (await cer("get", `/stocuri/ct-park/palet/${IESIT}`, ADMIN)).corp;
  bine("palet ieșit: fără formular de preț", !pag.includes('id="pret"'));

  console.log("\n12. Stoc la zi: prețul la fiecare produs");
  // PH: 3 paleți la 0,41803 (9.600 buc), unul la 0,4124 (2.400 buc), unul fără preț (100 buc).
  const stocH = (await require(path.join(RAD, "lib", "stoc-produse.js")).citeste({ vedeTot: true })).find((x) => x.produs_id === PH);
  const medie = (9600 * 0.41803 + 2400 * 0.4124) / 12000;
  egal("pe produs: stocul, prețul mediu al mărfii cu preț, valoarea și cât n-are preț", [stocH.stoc, Math.round(stocH.pret * 1e6) / 1e6, stocH.valoare, stocH.faraPret], [12100, Math.round(medie * 1e6) / 1e6, Math.round((9600 * 0.41803 + 2400 * 0.4124) * 100) / 100, 100]);
  const stocAgent = (await require(path.join(RAD, "lib", "stoc-produse.js")).citeste({ vedeTot: false })).find((x) => x.produs_id === PH);
  egal("pentru agent rândul n-are nici preț, nici valoare", [stocAgent.stoc, stocAgent.pret, stocAgent.valoare, stocAgent.faraPret], [12100, null, 0, 0]);
  pag = (await cer("get", "/stocuri/ct-park/stoc", DEP, { query: { q: `${PREFIX} Eticheta` } })).corp;
  bine("depozitul are coloana „Preț intrare”, după „În stoc”", />În stoc<[\s\S]{0,300}>Preț intrare<[\s\S]{0,300}>Disponibil</.test(pag));
  bine("…cu prețul pe unitate, valoarea și ce n-are preț", /0,4169 lei \/ buc/.test(pag) && /valoare 5\.002,85 lei/.test(pag) && /100 buc fără preț — <a href="\/stocuri\/ct-park\/paleti\?fara_pret=1&amp;q=TPI%20Eticheta%20marunta">pune-l<\/a>/.test(pag), (pag.match(/lei \/ buc[\s\S]{0,400}/) || [""])[0]);
  bine("…cardul cu valoarea stocului", pag.includes('id="card-valoare"') && /Valoarea stocului/.test(pag));
  bine("…și tabelul are cheia lui de filtre", pag.includes('data-filtre="stoc-la-zi-pret"'));
  // PG: 600 buc la 0,5, 50 buc la 9 și 50 buc (pe paletul cu două produse) fără preț.
  pag = (await cer("get", "/stocuri/ct-park/stoc", DEP, { query: { q: `${PREFIX} Plic` } })).corp;
  bine("media ține seama de cât e la fiecare preț: (600 × 0,5 + 50 × 9) / 650", /1,15 lei \/ buc/.test(pag) && /valoare 750,00 lei/.test(pag) && /50 buc fără preț/.test(pag), (pag.match(/lei \/ buc[\s\S]{0,300}/) || [""])[0]);
  pag = (await cer("get", "/stocuri/ct-park/stoc", DEP, { query: { q: `${PREFIX} alta marfa libera` } })).corp;
  bine("marfă din stoc fără niciun preț: o spune și trimite la paleții ei", /<span class="badge galben">fără preț<\/span>/.test(pag) && pag.includes("pune prețul pe paleți</a>") && pag.includes("fara_pret=1&amp;q=TPI%20alta%20marfa%20libera"), (pag.match(/badge galben[\s\S]{0,300}/) || [""])[0]);
  pag = (await cer("get", "/stocuri/ct-park/stoc", AGENT, { query: { q: `${PREFIX} Eticheta` } })).corp;
  bine("agentul vede produsul și stocul…", pag.includes(`${PREFIX} Eticheta marunta`) && /12\.100 buc/.test(pag));
  bine("…dar nici coloana, nici prețul, nici valoarea", !pag.includes("Preț intrare") && !/0,4169/.test(pag) && !/5\.002,85/.test(pag) && !pag.includes("card-valoare") && !pag.includes("fără preț"), (pag.match(/Preț intrare[\s\S]{0,100}|0,4169[\s\S]{0,60}|fără preț[\s\S]{0,60}/) || [""])[0]);
  bine("…iar tabelul lui rămâne cu cheia veche de filtre", pag.includes('data-filtre="stoc-la-zi"'));

  // Pentru o privire la pagini: SALVEAZA_PAGINI=/un/dosar
  if (process.env.SALVEAZA_PAGINI) {
    const d = process.env.SALVEAZA_PAGINI;
    fs.writeFileSync(path.join(d, "lista-fara-pret.html"), (await cer("get", "/stocuri/ct-park/paleti", DEP, { query: { fara_pret: "1", q: PREFIX } })).corp);
    fs.writeFileSync(path.join(d, "lista-admin.html"), (await cer("get", "/stocuri/ct-park/paleti", ADMIN, { query: { q: `${PREFIX} Eticheta`, ordine: "valoare" } })).corp);
    fs.writeFileSync(path.join(d, "palet-admin.html"), (await cer("get", `/stocuri/ct-park/palet/${C1}`, ADMIN)).corp);
    fs.writeFileSync(path.join(d, "palet-mixt.html"), (await cer("get", `/stocuri/ct-park/palet/${MIX}`, ADMIN)).corp);
    fs.writeFileSync(path.join(d, "stoc.html"), (await cer("get", "/stocuri/ct-park/stoc", DEP, { query: { q: PREFIX } })).corp);
    fs.writeFileSync(path.join(d, "intrare.html"), (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L1) } })).corp);
    fs.writeFileSync(path.join(d, "scaner.html"), (await cer("get", `${SCAN}/intrare/rand/r${L3}`, DEP)).corp);
  }

  console.log("\n13. În browser: formularul de intrare");
  {
    const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const corp = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { q: `${PREFIX} ` } })).corp;
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try {
      const pg = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
      const erori = [];
      const trimise = [];
      pg.on("pageerror", (e) => erori.push(String(e.message || e)));
      await pg.route("http://erp.test/**", async (rt) => {
        const u = new URL(rt.request().url());
        if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
        if (rt.request().method() === "POST") { trimise.push(rt.request().postData() || ""); return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>trimis</body></html>" }); }
        return rt.fulfill({ status: 200, contentType: "text/html", body: corp });
      });
      await pg.goto("http://erp.test/stocuri/ct-park/intrare");
      const st = () => pg.evaluate(() => ({ pret: document.getElementById("pret-intrare").value, propus: document.getElementById("pret-intrare").getAttribute("data-propus"), deUnde: document.getElementById("pret-de-unde").textContent.trim(), val: document.getElementById("valoare-intrare").textContent, tot: document.getElementById("total-intrare").textContent }));
      egal("la deschidere: preț gol, fără valoare", [(await st()).pret, (await st()).val], ["", "—"]);
      await pg.click('button[type="submit"]:has-text("Adaugă marfă")');
      await pg.waitForTimeout(300);
      egal("fără preț, formularul nu pleacă: căsuța e obligatorie", [trimise.length, await pg.evaluate(() => document.querySelector("form.form").checkValidity())], [0, false]);
      await pg.check(`input[name="produs_id"][value="${PA}"]`);
      egal("ales un produs cu preț: îl scrie și spune de unde", await st().then((s) => [s.pret, s.propus, s.deUnde]), ["2,5", "1", "Propus: preț de achiziție de pe produs. Îl poți schimba."]);
      await pg.fill('input[name="loc_cantitate[]"]', "400");
      egal("valoarea intrării se vede înainte de salvare", await st().then((s) => [s.tot, s.val]), ["400 kg", "1.000,00 lei"]);
      await pg.check(`input[name="produs_id"][value="${PC}"]`);
      egal("alt produs: prețul propus se schimbă după el", await st().then((s) => [s.pret, s.deUnde]), ["1,234567", "Propus: costul din rețetă. Îl poți schimba."]);
      await pg.check(`input[name="produs_id"][value="${PB}"]`);
      egal("produs fără preț: căsuța se golește și spune că trebuie scris", await st().then((s) => [s.pret, s.propus, s.deUnde, s.val]), ["", null, "ERP-ul nu știe prețul mărfii ăsteia: scrie-l de pe factura sau avizul furnizorului.", "—"]);
      await pg.fill("#pret-intrare", "418,03");
      egal("prețul scris de om: nu mai e propunere, iar valoarea sare în ochi", await st().then((s) => [s.propus, s.val]), [null, "167.212,00 lei"]);
      await pg.check(`input[name="produs_id"][value="${PA}"]`);
      egal("…și nu e călcat de propunerea altui produs", (await st()).pret, "418,03");
      await pg.click('button[type="submit"]:has-text("Adaugă marfă")');
      await pg.waitForTimeout(400);
      bine("cu preț, formularul pleacă și îl duce", trimise.length === 1 && /pret_unitar=418%2C03/.test(trimise[0]), trimise[0]);
      egal("nicio eroare de JavaScript", erori, []);
    } finally {
      await browser.close();
    }
  }

  curata();
  console.log(esecuri ? `\n${esecuri} eșecuri` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
