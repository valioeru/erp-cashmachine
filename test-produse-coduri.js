"use strict";
// Nomenclatorul de produse: caracteristicile cerute la comandă și unificarea
// codurilor duplicate.
//
// De ce există testul. Două lucruri se pot strica aici fără să se vadă:
//
//   1. Unificarea atinge 17 coloane din 16 tabele. Dacă cineva adaugă mâine un
//      tabel nou cu `produs_id` și uită să-l treacă în lista motorului, fuziunea
//      îl lasă în urmă: rândurile rămân agățate de un produs dezactivat, stocul
//      iese greșit și nimeni nu primește nicio eroare. Testul citește schema și
//      cere ca fiecare coloană de produs să fie acoperită.
//   2. Comanda de producție trebuie să ia produsul din nomenclator și să ceară
//      caracteristicile lui. Dacă se întoarce câmpul liber, se întorc și
//      codurile duplicate pe care tocmai le-am unit.
//
// Se verifică, pe PostgreSQL real (portul 5433):
//   1. lista de tabele a motorului acoperă toată schema;
//   2. previzualizarea numără corect, pe fiecare tabel;
//   3. fuziunea mută rândurile și NU șterge produsul înghițit;
//   4. conflictul din inventar e raportat, nu forțat;
//   5. jurnalul fuziunii rămâne citibil;
//   6. formularul de comandă are dropdown, nu câmp liber;
//   7. validarea caracteristicilor obligatorii e în cod.
//
// Se rulează din rădăcina repo-ului.
const path = require("path");
const fs = require("fs");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

// ---- un `pg` de carton care vorbește cu psql -------------------------------
// Așa motorul de fuziune rulează pe o bază adevărată, cu SQL-ul lui adevărat,
// fără să avem nevoie de pachetul `pg` (registrul npm e blocat aici).
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
const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

function ruleaza(sql, params) {
  const s = String(sql).replace(/\$(\d+)/g, (_, n) => lit((params || [])[Number(n) - 1]));
  let out;
  try {
    out = execFileSync("psql", ["-X", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" });
  } catch (e) {
    throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n→ " + String(e.stderr || e.message).slice(0, 300));
  }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  // psql scrie "UPDATE 3" pe stderr-ul lui, nu în CSV; numărăm separat mai jos
  if (!L.length) return { rows: [], rowCount: 0 };
  const h = L[0];
  const rows = L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
  return { rows, rowCount: rows.length };
}

// UPDATE/INSERT nu întorc rânduri, deci rowCount se ia din eticheta psql.
function ruleazaCuNumar(sql, params) {
  const s = String(sql).replace(/\$(\d+)/g, (_, n) => lit((params || [])[Number(n) - 1]));
  // Fără -q: psql afișează eticheta comenzii ("UPDATE 3"), de unde citim rowCount.
  // Cu -q eticheta e suprimată și rowCount ar ieși mereu 0 — ar arăta ca un bug
  // în motorul de fuziune, deși e doar liniștea lui psql.
  const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" });
  const m = out.match(/^(?:UPDATE|DELETE)\s+(\d+)|^INSERT\s+\d+\s+(\d+)/m);
  return { rows: [], rowCount: m ? Number(m[1] !== undefined ? m[1] : m[2]) : 0 };
}

const origLoad = Module._load;
Module._load = function (req) {
  if (req === "pg") {
    return {
      Pool: function () {
        return {
          on: () => {},
          query: async (sql, params) => {
            const cap = String(sql).trim().slice(0, 6).toUpperCase();
            if (cap.startsWith("SELECT") || /RETURNING/i.test(sql)) return ruleaza(sql, params);
            return ruleazaCuNumar(sql, params);
          },
        };
      },
    };
  }
  return origLoad.apply(this, arguments);
};
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5433/erp";

const fuziune = require(path.join(RAD, "lib", "produse-fuziune.js"));

let picate = 0;
function bine(nume, cond, detaliu) {
  if (cond) console.log("  ok   " + nume);
  else { picate++; console.log("  PICAT " + nume + (detaliu !== undefined ? ": " + detaliu : "")); }
}
const egal = (nume, gasit, asteptat) =>
  bine(nume, String(gasit) === String(asteptat), `am ${JSON.stringify(gasit)}, așteptam ${JSON.stringify(asteptat)}`);

const sql = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" });
const unul = (s) => ruleaza(s, []).rows[0];

(async () => {
  console.log("Nomenclatorul de produse: caracteristici și unificare de coduri\n");

  // ---- 1. lista motorului acoperă schema ----------------------------------
  console.log("lista de tabele a motorului acoperă schema:");
  const dbjs = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
  const tabele = {};
  for (const m of dbjs.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) tabele[m[1]] = m[2];
  const dinSchema = [];
  for (const [t, corp] of Object.entries(tabele)) {
    for (const linie of corp.split("\n")) {
      const c = linie.trim().match(/^(produs_id|componenta_id)\b/);
      if (c) dinSchema.push(`${t}.${c[1]}`);
    }
  }
  for (const m of dbjs.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (produs_id|componenta_id)\b/g)) {
    dinSchema.push(`${m[1]}.${m[2]}`);
  }
  const acoperite = new Set(fuziune.TABELE.map((t) => `${t.tabel}.${t.coloana}`));
  const lipsa = [...new Set(dinSchema)].filter((k) => !acoperite.has(k));
  bine(`toate cele ${new Set(dinSchema).size} coloane de produs din schemă sunt în motor`, lipsa.length === 0, lipsa.join(", "));
  const inPlus = [...acoperite].filter((k) => !dinSchema.includes(k));
  bine("motorul nu trimite la coloane care nu există", inPlus.length === 0, inPlus.join(", "));

  // ---- pregătim datele ----------------------------------------------------
  sql(`DELETE FROM produse_fuziuni WHERE inghitit_cod LIKE 'TSTP%';
       DELETE FROM comenzi_productie_caracteristici WHERE denumire LIKE 'TST %';
       DELETE FROM produse_caracteristici WHERE denumire LIKE 'TST %';
       DELETE FROM inventare_linii WHERE produs_id IN (SELECT id FROM produse WHERE cod LIKE 'TSTP%');
       DELETE FROM facturi_linii WHERE produs_id IN (SELECT id FROM produse WHERE cod LIKE 'TSTP%');
       DELETE FROM miscari_stoc WHERE document_ref = 'TSTMV';
       DELETE FROM produse WHERE cod LIKE 'TSTP%';`);
  sql(`INSERT INTO produse (cod, denumire, unitate_masura) VALUES
         ('TSTP-A', 'Folie test unificare', 'kg'),
         ('TSTP-B', 'Folie test unificare', 'kg'),
         ('TSTP-C', 'Folie test unificare', 'kg');`);
  const A = Number(unul("SELECT id FROM produse WHERE cod = 'TSTP-A'").id);
  const B = Number(unul("SELECT id FROM produse WHERE cod = 'TSTP-B'").id);
  const C = Number(unul("SELECT id FROM produse WHERE cod = 'TSTP-C'").id);

  // rânduri care trebuie să se mute
  sql(`INSERT INTO depozite (denumire) SELECT 'TST depozit' WHERE NOT EXISTS (SELECT 1 FROM depozite WHERE denumire = 'TST depozit');`);
  const DEP = Number(unul("SELECT id FROM depozite WHERE denumire = 'TST depozit'").id);
  sql(`INSERT INTO miscari_stoc (produs_id, depozit_id, cantitate, tip, document_ref) VALUES
         (${B}, ${DEP}, 10, 'intrare', 'TSTMV'), (${C}, ${DEP}, 5, 'intrare', 'TSTMV');`);

  // ---- 2. caracteristicile ------------------------------------------------
  console.log("\ncaracteristicile se definesc una câte una:");
  sql(`INSERT INTO produse_caracteristici (produs_id, denumire, tip, unitate, obligatoriu, ordine) VALUES
         (${A}, 'TST Grosime', 'numar', 'µm', 1, 10),
         (${A}, 'TST Culoare', 'lista', NULL, 1, 20);
       UPDATE produse_caracteristici SET valori = 'transparent|negru' WHERE produs_id = ${A} AND denumire = 'TST Culoare';`);
  const carac = ruleaza(`SELECT denumire, tip, obligatoriu FROM produse_caracteristici WHERE produs_id = ${A} AND activ = 1 ORDER BY ordine`, []).rows;
  egal("produsul are două caracteristici active", carac.length, 2);
  egal("prima e numerică", carac[0].tip, "numar");
  egal("a doua e listă", carac[1].tip, "lista");
  sql(`UPDATE produse_caracteristici SET activ = 0 WHERE produs_id = ${A} AND denumire = 'TST Culoare';`);
  egal("scoaterea unei caracteristici n-o șterge din bază",
    unul(`SELECT COUNT(*) AS n FROM produse_caracteristici WHERE produs_id = ${A} AND denumire = 'TST Culoare'`).n, 1);
  sql(`UPDATE produse_caracteristici SET activ = 1 WHERE produs_id = ${A};`);

  // ---- 3. previzualizarea -------------------------------------------------
  console.log("\nprevizualizarea numără înainte să miște:");
  const prev = await fuziune.previzualizeaza(A, [B, C]);
  const randMiscari = prev.randuri.find((r) => r.cheie === "miscari_stoc.produs_id");
  egal("vede cele două mișcări de stoc", randMiscari ? randMiscari.muta : 0, 2);
  egal("nu raportează nimic blocat încă", prev.blocate, 0);
  const inainte = unul(`SELECT COUNT(*) AS n FROM miscari_stoc WHERE produs_id IN (${B}, ${C})`).n;
  egal("previzualizarea chiar n-a mutat nimic", inainte, 2);

  // ---- 4. conflictul din inventar ----------------------------------------
  console.log("\nconflictul din inventar e raportat, nu forțat:");
  sql(`INSERT INTO inventare (depozit_id, nume) VALUES (${DEP}, 'TST inventar');`);
  const inv = Number(unul("SELECT id FROM inventare WHERE nume = 'TST inventar' ORDER BY id DESC LIMIT 1").id);
  sql(`INSERT INTO inventare_linii (inventar_id, produs_id, scriptic, numarat) VALUES
         (${inv}, ${A}, 1, 1), (${inv}, ${B}, 2, 2);`);
  const prev2 = await fuziune.previzualizeaza(A, [B, C]);
  const randInv = prev2.randuri.find((r) => r.cheie === "inventare_linii.produs_id");
  egal("linia care s-ar ciocni e numărată ca blocată", randInv ? randInv.blocat : 0, 1);
  egal("și nu e numărată ca mutabilă", randInv ? randInv.muta : -1, 0);

  // ---- 5. fuziunea --------------------------------------------------------
  console.log("\nfuziunea mută și nu șterge:");
  const rez = await fuziune.fuzioneaza(A, [B, C], null);
  egal("mișcările de stoc au ajuns pe produsul păstrat",
    unul(`SELECT COUNT(*) AS n FROM miscari_stoc WHERE produs_id = ${A} AND document_ref = 'TSTMV'`).n, 2);
  egal("nu mai rămâne nicio mișcare pe cele unificate",
    unul(`SELECT COUNT(*) AS n FROM miscari_stoc WHERE produs_id IN (${B}, ${C})`).n, 0);
  egal("produsele unificate există în continuare",
    unul(`SELECT COUNT(*) AS n FROM produse WHERE id IN (${B}, ${C})`).n, 2);
  egal("dar sunt dezactivate",
    unul(`SELECT COUNT(*) AS n FROM produse WHERE id IN (${B}, ${C}) AND activ = 0`).n, 2);
  egal("și arată spre cel păstrat",
    unul(`SELECT COUNT(*) AS n FROM produse WHERE id IN (${B}, ${C}) AND fuzionat_in = ${A}`).n, 2);
  egal("linia de inventar care se ciocnea a rămas pe loc",
    unul(`SELECT COUNT(*) AS n FROM inventare_linii WHERE inventar_id = ${inv} AND produs_id = ${B}`).n, 1);

  console.log("\njurnalul rămâne citibil:");
  const jurnal = ruleaza(`SELECT inghitit_cod, mutari FROM produse_fuziuni WHERE pastrat_id = ${A} ORDER BY id`, []).rows;
  egal("două înregistrări în jurnal", jurnal.length, 2);
  bine("jurnalul reține codul vechi", jurnal.some((j) => j.inghitit_cod === "TSTP-B"), JSON.stringify(jurnal.map((j) => j.inghitit_cod)));
  let m = {};
  try { m = JSON.parse(jurnal[0].mutari || "{}"); } catch (e) { /* rămâne gol */ }
  bine("jurnalul reține ce tabele s-au mutat", Object.keys(m).length > 0, JSON.stringify(m));

  // ---- 6 și 7. formularul și validarea ------------------------------------
  console.log("\ncomanda nouă ia produsul din nomenclator:");
  const prod = fs.readFileSync(path.join(RAD, "modules", "productie.js"), "utf8");
  // Comanda are acum mai multe linii de produs, fiecare din nomenclator.
  // Comportamentul lor e verificat pe bază adevărată în test-comanda-produse.js;
  // aici rămân doar lucrurile care NU trebuie să se întoarcă niciodată.
  bine("formularul alege produsul din nomenclator", /<select name="linie_produs\[\]"/.test(prod));
  bine("nu mai are câmp liber pentru produs", !/<input name="tip_produs"/.test(prod));
  bine("trimite la Produse pentru articole noi", /\/produse\/nou/.test(prod));
  bine("refuză comanda fără produs din nomenclator", /Alege cel puțin un produs din nomenclator/.test(prod));
  bine("refuză comanda fără caracteristicile obligatorii", /este obligatorie pentru/.test(prod));
  bine("verifică tipul numeric", /trebuie să fie un număr/.test(prod));
  bine("verifică valorile permise ale listei", /acceptă doar/.test(prod));
  bine("salvează valorile în tabelul lor", /INSERT INTO comenzi_productie_caracteristici/.test(prod));
  bine("păstrează rezumatul în coloana veche, ca rapoartele să meargă", /caracteristici, cantitate/.test(prod) && /rezumat,/.test(prod));

  const pr = fs.readFileSync(path.join(RAD, "modules", "produse.js"), "utf8");
  bine("unificarea e înregistrată înaintea lui /produse/:id",
    pr.indexOf('"/produse/fuziune"') < pr.indexOf('router.get("/produse/:id"'));
  bine("unificarea cere o confirmare", /onsubmit="return confirm/.test(pr));
  const rend = fs.readFileSync(path.join(RAD, "lib", "render.js"), "utf8");
  bine("Produse apare în meniul Financiar", /\["\/produse", "Produse"\]/.test(rend));
  bine("/produse primește subnavul Financiar", /z === "\/produse"/.test(rend));

  // ---- curățenie ----------------------------------------------------------
  sql(`DELETE FROM produse_fuziuni WHERE pastrat_id = ${A};
       DELETE FROM comenzi_productie_caracteristici WHERE denumire LIKE 'TST %';
       DELETE FROM produse_caracteristici WHERE denumire LIKE 'TST %';
       DELETE FROM inventare_linii WHERE inventar_id = ${inv};
       DELETE FROM inventare WHERE id = ${inv};
       DELETE FROM miscari_stoc WHERE document_ref = 'TSTMV';
       DELETE FROM produse WHERE id IN (${A}, ${B}, ${C});`);

  // ---- 8. unificările rămân PLATE, nu se înlănțuie ------------------------
  // De ce contează: punte.js și importurile caută produsul după cod și apoi
  // urmează `fuzionat_in` ca să-i atașeze liniile — într-un singur pas, prin
  // COALESCE(fuzionat_in, id). Dacă s-ar forma un lanț A→B→C, cine caută A ar
  // nimeri pe B, care e dezactivat, iar liniile ar ajunge pe un produs scos din
  // uz. Nimic nu crapă: stocul iese greșit, în liniște.
  console.log("\nunificările nu se înlănțuie:");
  sql(`DELETE FROM produse_fuziuni WHERE inghitit_cod IN ('TSTL-A','TSTL-B');
       DELETE FROM produse WHERE cod IN ('TSTL-A','TSTL-B','TSTL-C');
       INSERT INTO produse (cod, denumire, unitate_masura, activ) VALUES
         ('TSTL-A','Lant test A','buc',1), ('TSTL-B','Lant test B','buc',1), ('TSTL-C','Lant test C','buc',1);`);
  const LA = Number(unul("SELECT id FROM produse WHERE cod = 'TSTL-A'").id);
  const LB = Number(unul("SELECT id FROM produse WHERE cod = 'TSTL-B'").id);
  const LC = Number(unul("SELECT id FROM produse WHERE cod = 'TSTL-C'").id);

  await fuziune.fuzioneaza(LB, [LA], null);
  egal("A arată spre B", Number(unul(`SELECT fuzionat_in FROM produse WHERE id = ${LA}`).fuzionat_in), LB);

  // B se unifică acum în C. A trebuie să se mute și el pe C, nu să rămână pe B.
  await fuziune.fuzioneaza(LC, [LB], null);
  egal("B arată spre C", Number(unul(`SELECT fuzionat_in FROM produse WHERE id = ${LB}`).fuzionat_in), LC);
  egal("iar A a fost mutat direct pe C, nu lăsat pe B", Number(unul(`SELECT fuzionat_in FROM produse WHERE id = ${LA}`).fuzionat_in), LC);
  egal(
    "deci un singur pas ajunge la codul final",
    Number(unul(`SELECT COALESCE(fuzionat_in, id) AS f FROM produse WHERE id = ${LA}`).f),
    LC
  );

  let refuzat = "";
  try {
    await fuziune.fuzioneaza(LB, [LC], null);
  } catch (e) {
    refuzat = e.message;
  }
  bine("refuză să păstreze un cod care e el însuși unificat", /unificat/.test(refuzat), JSON.stringify(refuzat));
  bine("și spune care e codul final", /TSTL-C|Lant test C/.test(refuzat), JSON.stringify(refuzat));

  sql(`DELETE FROM produse_fuziuni WHERE inghitit_cod IN ('TSTL-A','TSTL-B','TSTL-C');
       DELETE FROM produse WHERE cod IN ('TSTL-A','TSTL-B','TSTL-C');`);

  console.log(picate ? `\n${picate} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(picate ? 1 : 0);
})().catch((e) => {
  console.error("Testul a crăpat:", e.message);
  process.exit(2);
});
