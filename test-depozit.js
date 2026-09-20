"use strict";
// Harnașament de test pentru depozitul CT-Park.
//
// `pg` nu se poate instala aici (registrul npm e blocat), dar psql există —
// așa că interogările pleacă spre o bază PostgreSQL reală prin linia de
// comandă. Deci nu e un mock: SQL-ul chiar se execută, pe schema adevărată.
// Se rulează din rădăcina repo-ului, cu baza pornită pe 127.0.0.1:5433.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Un parser de CSV cât să citească ce scoate psql --csv (ghilimele duble
// pentru câmpurile cu virgulă sau cu ghilimele înăuntru).
function csv(text) {
  const randuri = [];
  let camp = "", rand = [], inGhilimele = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inGhilimele) {
      if (c === '"') {
        if (text[i + 1] === '"') { camp += '"'; i++; } else inGhilimele = false;
      } else camp += c;
    } else if (c === '"') inGhilimele = true;
    else if (c === ",") { rand.push(camp); camp = ""; }
    else if (c === "\n") { rand.push(camp); randuri.push(rand); rand = []; camp = ""; }
    else if (c !== "\r") camp += c;
  }
  if (camp !== "" || rand.length) { rand.push(camp); randuri.push(rand); }
  return randuri;
}

let interogari = 0;
function ruleaza(sql, params) {
  interogari++;
  let i = 0;
  const complet = String(sql).replace(/\?/g, () => literal(params[i++]));
  let out;
  try {
    out = execFileSync("psql", ["-X", "--csv", "-c", complet], { env: ENV, encoding: "utf8" });
  } catch (e) {
    const mesaj = (e.stderr || e.message || "").toString().trim();
    throw new Error("SQL a picat:\n" + complet.slice(0, 400) + "\n→ " + mesaj);
  }
  const linii = csv(out).filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  if (!linii.length) return [];
  const cap = linii[0];
  return linii.slice(1).map((r) => {
    const o = {};
    cap.forEach((k, j) => { o[k] = r[j] === "" ? null : r[j]; });
    return o;
  });
}

const dbFals = {
  prepare(sql) {
    return {
      all: async (...p) => ruleaza(sql, p),
      get: async (...p) => (ruleaza(sql, p)[0] || null),
      run: async (...p) => {
        const r = ruleaza(sql, p);
        return { lastInsertRowid: r[0] && (r[0].id || r[0].ID) ? Number(r[0].id || r[0].ID) : undefined };
      },
    };
  },
};

const RAD = __dirname;
const orig = Module._load;
Module._load = function (req, parent) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  const m = orig.apply(this, arguments);
  return m;
};
process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";

// lib/db e cerut de toate modulele; îl înlocuim în cache după ce se încarcă.
const dbReal = require(path.join(RAD, "lib", "db.js"));
dbReal.prepare = dbFals.prepare;

const ct = require(path.join(RAD, "modules", "ct-park.js"));

const rute = { get: {}, post: {} };
ct.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

function res() {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
const ADMIN = { rol: "admin", nume: "Vali", id: 1 };

async function cer(cale, { params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: ADMIN, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}

function verifica(eticheta, corp, cerute) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  const rele = [];
  if (/NaN|Infinity|undefined<|>undefined|value="undefined"/.test(fara)) rele.push("NaN/undefined în pagină");
  for (const c of cerute) if (!fara.includes(c)) rele.push("lipsește „" + c + "”");
  if (rele.length) { console.log("  PROBLEMĂ " + eticheta + ": " + rele.join("; ")); return 1; }
  console.log("  ok       " + eticheta + " (" + corp.length + " octeți)");
  return 0;
}

(async () => {
  let rele = 0;

  // Depozitul de test se reface de la zero: testul schimbă niveluri și
  // locuri, deci fără asta a doua rulare ar porni din starea lăsată de prima.
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f",
    path.join(RAD, "test-depozit-fixture.sql")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("rute GET :", Object.keys(rute.get).join(", "));
  console.log("rute POST:", Object.keys(rute.post).join(", "));
  console.log("");

  // --- prima pagină: indicatorii ceruți ---------------------------------
  let r = await cer("/stocuri/ct-park");
  rele += verifica("harta depozitului", r.corp, [
    "Paleți reali în stoc", "Grad de ocupare", "Spații libere", "Valoarea mărfii",
    ">3<",                      // 3 paleți reali
    "ocupă 5 locuri",           // pe 5 locuri
    "10.664,00 lei",            // valoarea la preț de intrare
    "1 palet fără preț",
  ]);

  // --- stoc la zi --------------------------------------------------------
  r = await cer("/stocuri/ct-park/stoc");
  rele += verifica("stoc la zi", r.corp, [
    "Stoc la zi", "materie primă", "produse finite",
    "Granulă LLDPE natur", "TERAPLAST RECYCLING SA",
    "ROMTEXTIL SA", "(dedus)",
    "R3-01-2-1", "rând 3 · câmp 1 · nivel 2",
    "14.08.2026", "fără preț",   // layout() rescrie datele ISO în format românesc
  ]);

  r = await cer("/stocuri/ct-park/stoc", { query: { q: "R5-01" } });
  rele += verifica("stoc la zi · căutare după adresă", r.corp, ["Cutie carton", "din 3 în total"]);
  if (r.corp.includes("Granulă LLDPE natur")) { console.log("  PROBLEMĂ căutarea nu filtrează"); rele++; }

  r = await cer("/stocuri/ct-park/stoc", { query: { q: "teraplast" } });
  rele += verifica("stoc la zi · căutare după furnizor", r.corp, ["Granulă LLDPE natur"]);

  // --- fața rândului, cu niveluri inegale --------------------------------
  r = await cer("/stocuri/ct-park/rand/:id", { params: { id: 1 } });
  rele += verifica("fața rândului 3", r.corp, [
    "Rândul 3", "2.20 m", "1.20 m", "paleți înalți",
    "Nivelurile nu sunt toate la fel",
    "ct-niv-ctrl",
  ]);

  // --- configurare -------------------------------------------------------
  r = await cer("/stocuri/ct-park/configurare");
  rele += verifica("configurare rânduri", r.corp, ["ct-mic", "Configurare rânduri"]);

  r = await cer("/stocuri/ct-park/configurare/:id", { params: { id: 1 } });
  rele += verifica("configurare rândul 3", r.corp, [
    "Nivelurile rândului", "paleți înalți", "cutii ușoare", "Înălțimea totală a rândului",
  ]);

  // --- adaugă / scoate nivel --------------------------------------------
  const inainte = ruleaza("SELECT niveluri FROM ct_randuri WHERE id = 1", [])[0].niveluri;
  await cer("/stocuri/ct-park/configurare/:id/nivel", { metoda: "post", params: { id: 1 }, body: { spre: "adauga" } });
  const dupa = ruleaza("SELECT niveluri FROM ct_randuri WHERE id = 1", [])[0].niveluri;
  const locuriDupa = Number(ruleaza("SELECT count(*) AS n FROM ct_locuri WHERE rand_id = 1", [])[0].n);
  if (Number(dupa) !== Number(inainte) + 1) { console.log("  PROBLEMĂ + nivel n-a mărit rândul: " + inainte + " → " + dupa); rele++; }
  else if (locuriDupa !== 56 + 12) { console.log("  PROBLEMĂ + nivel n-a creat 12 locuri noi: " + locuriDupa); rele++; }
  else console.log("  ok       + nivel: " + inainte + " → " + dupa + " niveluri, " + locuriDupa + " locuri");

  const r2 = await cer("/stocuri/ct-park/configurare/:id/nivel", { metoda: "post", params: { id: 1 }, body: { spre: "scoate" } });
  const dupa2 = Number(ruleaza("SELECT niveluri FROM ct_randuri WHERE id = 1", [])[0].niveluri);
  const locuri2 = Number(ruleaza("SELECT count(*) AS n FROM ct_locuri WHERE rand_id = 1", [])[0].n);
  if (dupa2 !== Number(inainte) || locuri2 !== 56) { console.log("  PROBLEMĂ − nivel n-a revenit: " + dupa2 + " niveluri, " + locuri2 + " locuri"); rele++; }
  else console.log("  ok       − nivel: înapoi la " + dupa2 + " niveluri, " + locuri2 + " locuri");

  // --- refuzul de a tăia raftul de sub marfă ----------------------------
  // Pe rândul 1 marfa stă pe nivelul 2. Scoatem niveluri până dăm de ea.
  let opriri = 0, ultim = "";
  for (let i = 0; i < 6; i++) {
    const rr = await cer("/stocuri/ct-park/configurare/:id/nivel", { metoda: "post", params: { id: 1 }, body: { spre: "scoate" } });
    const loc = (rr.antet && (rr.antet.Location || rr.antet.location)) || "";
    if (loc.includes("eroare=")) { opriri++; ultim = decodeURIComponent(loc.split("eroare=")[1] || ""); break; }
  }
  const nivFinal = Number(ruleaza("SELECT niveluri FROM ct_randuri WHERE id = 1", [])[0].niveluri);
  const maiAreMarfa = Number(ruleaza(
    "SELECT count(*) AS n FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id WHERE l.rand_id = 1", [])[0].n);
  if (!opriri) { console.log("  PROBLEMĂ nu s-a oprit deloc — raftul s-a tăiat de sub marfă"); rele++; }
  else if (nivFinal < 2 || maiAreMarfa !== 3) { console.log("  PROBLEMĂ marfa s-a pierdut: nivel " + nivFinal + ", ocupări " + maiAreMarfa); rele++; }
  else console.log("  ok       refuză să taie sub marfă la nivelul " + nivFinal + " (" + ultim.slice(0, 60) + "…)");

  // --- planul halei ------------------------------------------------------
  r = await cer("/stocuri/ct-park/plan");
  rele += verifica("planul halei", r.corp, [
    "Planul halei", "Rânduri în plan",
    ">8<",                 // cele 8 rânduri din planul de montaj
    "spate în spate", "Adâncime raft",
  ]);

  const locatie = (rr) => (rr.antet && (rr.antet.Location || rr.antet.location)) || "";

  r = await cer("/stocuri/ct-park/plan", { metoda: "post", body: { grupuri: "1 2\n3 4\n5", adancime: "1200", spate: "150", culoar: "3600" } });
  if (!locatie(r).includes("ok=")) { console.log("  PROBLEMĂ planul nou n-a fost salvat: " + locatie(r)); rele++; }
  else {
    const dupa = await cer("/stocuri/ct-park/plan");
    const are = dupa.corp.includes("1.20 m") && dupa.corp.includes("3.60 m") && dupa.corp.includes(">5<");
    if (!are) { console.log("  PROBLEMĂ planul salvat nu se vede în pagină"); rele++; }
    else console.log("  ok       plan nou: 5 rânduri în 3 grupuri, culoar 3,60 m, adâncime 1,20 m");
  }

  r = await cer("/stocuri/ct-park/plan", { metoda: "post", body: { grupuri: "1 2\n2 3", adancime: "1100", spate: "200", culoar: "3200" } });
  if (!locatie(r).includes("eroare=")) { console.log("  PROBLEMĂ planul cu rândul 2 de două ori a fost acceptat"); rele++; }
  else console.log("  ok       refuză un rând care apare de două ori în plan");

  r = await cer("/stocuri/ct-park/plan", { metoda: "post", body: { grupuri: "   \n  ", adancime: "1100" } });
  if (!locatie(r).includes("eroare=")) { console.log("  PROBLEMĂ planul gol a fost acceptat"); rele++; }
  else console.log("  ok       refuză un plan fără niciun rând");

  r = await cer("/stocuri/ct-park/plan", { metoda: "post", body: { implicit: "1" } });
  const inapoi = await cer("/stocuri/ct-park/plan");
  if (!inapoi.corp.includes(">8<") || !inapoi.corp.includes("1.10 m")) { console.log("  PROBLEMĂ nu s-a revenit la planul de montaj"); rele++; }
  else console.log("  ok       revine la planul de montaj (8 rânduri, adâncime 1,10 m)");

  // --- pagina merge si pe o baza care n-a primit inca migrarea ------------
  // S-a intamplat pe bune: codul a ajuns pe server inaintea fisierului cu
  // migrarea, si pagina de stoc a dat 500. Nu trebuie sa se mai poata.
  const psql = (sql) => execFileSync("psql", ["-X", "-q", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  psql("ALTER TABLE ct_paleti DROP COLUMN IF EXISTS furnizor_id, DROP COLUMN IF EXISTS furnizor_text");
  try {
    execFileSync("node", [path.join(RAD, "test-depozit-fallback.js")], { stdio: "inherit" });
  } catch (e) {
    rele++;
  } finally {
    psql("ALTER TABLE ct_paleti ADD COLUMN IF NOT EXISTS furnizor_id INTEGER, ADD COLUMN IF NOT EXISTS furnizor_text TEXT");
  }

  console.log("\n" + interogari + " interogări SQL rulate pe PostgreSQL real.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
