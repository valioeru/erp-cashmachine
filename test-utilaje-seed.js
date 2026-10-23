"use strict";
// Fisa tehnica a utilajelor, scrisa in baza la pornire. Pe PostgreSQL real
// (prin psql — vezi test-depozit.js pentru de ce). Din radacina repo-ului, cu
// baza pornita pe 127.0.0.1:5433.
//
// CE APARA, in ordinea in care doare:
//
//   • A DOUA PORNIRE NU SCHIMBA NIMIC. Seed-ul ruleaza la FIECARE pornire a
//     aplicatiei. Daca ar face UPDATE, fiecare redeploy ar sterge corecturile
//     oamenilor si le-ar pune la loc pe cele din Excel — iar cel care a
//     corectat o grosime maxima gresita ar gasi-o gresita a doua zi si n-ar
//     intelege de ce. Testul porneste seed-ul de doua ori si verifica numarul
//     de randuri SI continutul.
//
//   • O CORECTURA FACUTA DE OM SUPRAVIETUIESTE. Se schimba o valoare in baza,
//     se mai ruleaza o data seed-ul, valoarea trebuie sa ramana schimbata.
//
//   • UT14 NU PRIMESTE COMENZI. E in STANDBY, fara date tehnice. Daca intra
//     activ, planificarea il va alege la un moment dat.
//
//   • ORELE PE ZI IES DIN REGIM, NU DIN 8. Extruderul merge non-stop, 3
//     schimburi × 480 min = 24 h. Daca ramane pe 8, planificarea crede ca
//     avem o treime din capacitate.
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
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const S = require(path.join(RAD, "lib", "utilaje-seed.js"));
const D = require(path.join(RAD, "lib", "utilaje-date.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 220) : "")); esecuri++; }
}

const TABELE = ["utilaje_parametri", "utilaje_setup", "utilaje_reguli", "utilaje_consumabile",
                "cilindri_flexo", "utilaje_rute", "fluxuri_pasi", "fluxuri"];

function curata() {
  for (const t of TABELE) q("DELETE FROM " + t);
  q("DELETE FROM utilaje WHERE cod ~ '^UT[0-9]+$'");
}

(async () => {
  curata();

  console.log("\n1. Prima pornire: fisa intra in baza");
  const p1 = await S.seed();
  {
    bine("cele 15 utilaje", Number(unul("SELECT count(*) FROM utilaje WHERE cod ~ '^UT[0-9]+$'")) === 15, unul("SELECT count(*) FROM utilaje WHERE cod ~ '^UT[0-9]+$'"));
    bine("94 de parametri tehnici", Number(unul("SELECT count(*) FROM utilaje_parametri")) === D.PARAMETRI.length);
    bine("28 de timpi de setup", Number(unul("SELECT count(*) FROM utilaje_setup")) === D.SETUP.length);
    bine("26 de reguli de alocare", Number(unul("SELECT count(*) FROM utilaje_reguli")) === D.REGULI.length);
    bine("30 de consumabile si scule", Number(unul("SELECT count(*) FROM utilaje_consumabile")) === D.CONSUMABILE.length);
    bine("4 tipuri de cilindri flexo", Number(unul("SELECT count(*) FROM cilindri_flexo")) === D.CILINDRI.length);
    bine("30 de rute produs x utilaj", Number(unul("SELECT count(*) FROM utilaje_rute")) === D.RUTE.length);
    bine("12 fluxuri cu 24 de pasi",
      Number(unul("SELECT count(*) FROM fluxuri")) === 12 && Number(unul("SELECT count(*) FROM fluxuri_pasi")) === D.FLUXURI.length,
      unul("SELECT count(*) FROM fluxuri") + " fluxuri / " + unul("SELECT count(*) FROM fluxuri_pasi") + " pasi");
  }

  console.log("\n2. Valorile sunt cele din fisier, nu aproximatii");
  {
    const ex = q("SELECT * FROM utilaje WHERE cod = 'UT01'")[0];
    bine("extruderul e non-stop, 3 schimburi", ex.regim_lucru === "NON-STOP" && Number(ex.schimburi_zi) === 3);
    // 480 min × 3 schimburi = 24 h. Daca ramane 8, planificarea crede ca
    // avem o treime din capacitatea reala.
    bine("orele pe zi ies din regim, nu din 8", Number(ex.ore_pe_zi) === 24, ex.ore_pe_zi);
    bine("consumul de 200 kW", Number(ex.consum_kw) === 200, ex.consum_kw);

    const g = q("SELECT valoare_num, unitate FROM utilaje_parametri p JOIN utilaje u ON u.id = p.utilaj_id WHERE u.cod='UT01' AND p.parametru_cod='grosime_max'")[0];
    bine("grosimea maxima a extruderului: 100 µm", g && Number(g.valoare_num) === 100 && g.unitate === "µm", JSON.stringify(g));

    // Helperul nu e operator: la masina de cartoane sunt doi oameni, dar
    // numai unul o conduce. Daca se numara la fel, planificarea de personal
    // iese gresita in ambele sensuri.
    const cart = q("SELECT nr_helperi, operatori_necesari FROM utilaje WHERE cod='UT06'")[0];
    bine("helperul de la cartoane se numara separat de operator",
      Number(cart.nr_helperi) === 1 && Number(cart.operatori_necesari) === 1, JSON.stringify(cart));

    const r = q("SELECT durata_min, frecventa, interval_valoare, interval_unitate FROM utilaje_setup s JOIN utilaje u ON u.id=s.utilaj_id WHERE u.cod='UT03' AND s.eveniment_cod='SCHIMB_JUMBO'")[0];
    bine("schimbarea de jumbo: 4 min la 48,4 kg", r && Number(r.durata_min) === 4 && Number(r.interval_valoare) === 48.4 && r.interval_unitate === "kg", JSON.stringify(r));

    const r01 = q("SELECT conditie, utilaje FROM utilaje_reguli WHERE regula_cod='R01'")[0];
    bine("regula R01 e scrisa in clar, nu ingropata in cod", r01 && /600/.test(r01.conditie) && /UT10/.test(r01.utilaje), JSON.stringify(r01));
  }

  console.log("\n3. UT14 e in standby si nu primeste comenzi");
  {
    const u = q("SELECT activ, status_date FROM utilaje WHERE cod='UT14'")[0];
    bine("exista in lista", !!u);
    bine("dar e inactiv", Number(u.activ) === 0, JSON.stringify(u));
    bine("si scrie de ce", u.status_date === "STANDBY");
  }

  console.log("\n4. Fluxurile: pasii optionali si utilajele alternative");
  {
    const pasi = q(`SELECT p.pas_nr, p.utilaj_cod, p.tip_pas, p.conditie, p.utilaj_id
                      FROM fluxuri_pasi p JOIN fluxuri f ON f.id = p.flux_id
                     WHERE f.cod = 'F-PUNGA' ORDER BY p.pas_nr`);
    bine("punga curier are 4 pasi", pasi.length === 4, JSON.stringify(pasi.map((x) => x.utilaj_cod)));
    bine("extrudarea e obligatorie", pasi[0].tip_pas === "OBLIGATORIU" && pasi[0].utilaj_cod === "UT01");
    bine("debitarea e optionala, cu conditie scrisa", pasi[1].tip_pas === "OPTIONAL" && /lățimea/i.test(pasi[1].conditie || ""), pasi[1].conditie);
    // „UT10|UT11" nu se leaga de un singur utilaj: alegerea o fac regulile.
    bine("pasul pe doua utilaje pastreaza ambele coduri", pasi[3].utilaj_cod === "UT10|UT11");
    bine("si nu se leaga de niciunul dintre ele", pasi[3].utilaj_id === null, pasi[3].utilaj_id);
    const unic = q(`SELECT p.utilaj_id FROM fluxuri_pasi p JOIN fluxuri f ON f.id=p.flux_id WHERE f.cod='F-PUNGA' AND p.pas_nr=1`)[0];
    bine("iar pasul pe un singur utilaj se leaga", unic.utilaj_id !== null);
  }

  console.log("\n5. A DOUA PORNIRE NU SCHIMBĂ NIMIC");
  {
    const inainte = {};
    for (const t of TABELE) inainte[t] = unul("SELECT count(*) FROM " + t);
    const amprenta = unul("SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) FROM utilaje_parametri x");

    const p2 = await S.seed();
    bine("seed-ul nu mai pune nimic", Object.values(p2).every((v) => v === 0), JSON.stringify(p2));
    let la_fel = true;
    for (const t of TABELE) if (unul("SELECT count(*) FROM " + t) !== inainte[t]) { la_fel = false; console.log("     " + t + ": " + inainte[t] + " -> " + unul("SELECT count(*) FROM " + t)); }
    bine("numarul de randuri e neschimbat", la_fel);
    bine("si continutul e bit cu bit acelasi", unul("SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) FROM utilaje_parametri x") === amprenta);
  }

  console.log("\n6. Corectura facuta de om supravietuieste repornirii");
  {
    // Cineva se uita la utilaj si vede ca grosimea maxima nu e 100, e 120.
    q("UPDATE utilaje_parametri SET valoare_num = 120, sursa = 'CORECTAT', confirmat = 'DA' WHERE parametru_cod = 'grosime_max' AND utilaj_id = (SELECT id FROM utilaje WHERE cod='UT01')");
    q("UPDATE utilaje SET consum_kw = 180 WHERE cod = 'UT01'");
    await S.seed();
    const g = q("SELECT valoare_num, sursa FROM utilaje_parametri p JOIN utilaje u ON u.id=p.utilaj_id WHERE u.cod='UT01' AND p.parametru_cod='grosime_max'")[0];
    bine("parametrul corectat ramane corectat", Number(g.valoare_num) === 120 && g.sursa === "CORECTAT", JSON.stringify(g));
    const u = q("SELECT consum_kw FROM utilaje WHERE cod='UT01'")[0];
    bine("si campul corectat pe utilaj la fel", Number(u.consum_kw) === 180, u.consum_kw);
  }

  console.log("\n7. Un utilaj scris de mana inainte de fisa isi pastreaza datele");
  {
    curata();
    q("INSERT INTO utilaje (cod, denumire, descriere, operatori_necesari, ore_pe_zi, activ, consum_kw) VALUES ('UT01', 'Extruderul meu', 'scris de mana', 2, 16, 1, 999)");
    await S.seed();
    const u = q("SELECT denumire, consum_kw, ore_pe_zi, regim_lucru, categorie FROM utilaje WHERE cod='UT01'")[0];
    bine("denumirea scrisa de om nu se schimba", u.denumire === "Extruderul meu", u.denumire);
    bine("nici consumul", Number(u.consum_kw) === 999, u.consum_kw);
    bine("nici orele pe zi", Number(u.ore_pe_zi) === 16, u.ore_pe_zi);
    // Dar golurile se umplu: coloanele astea erau NULL, deci n-avea ce pierde.
    bine("dar golurile se umplu din fisa", u.regim_lucru === "NON-STOP" && u.categorie === "Extrudare", JSON.stringify(u));
    bine("si tot restul fisei intra normal", Number(unul("SELECT count(*) FROM utilaje_parametri")) === D.PARAMETRI.length);
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
