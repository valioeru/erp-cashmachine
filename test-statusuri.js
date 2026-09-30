"use strict";
// Statusul facturii trebuie să urce singur când intră banii.
//
// De ce există testul: încasările care vin prin punte (sincronizarea de
// noapte și butonul „Actualizează din SmartBill" — practic tot ce intră
// astăzi) scriau plata în tabelul `plati` și atât. Factura rămânea pe
// „emisă" oricâți bani ar fi intrat pe ea. Soldurile ieșeau corecte peste
// tot, fiindcă se socotesc din total minus plăți; mințea doar coloana
// Status, adică exact ce se uită omul când întreabă „s-a încasat?".
// Recalcularea exista, dar doar pe drumul de import din Excel.
//
// Regula pe care o apără testul: statusul URCĂ, nu coboară. O factură
// marcată încasată în SmartBill intră în ERP cu statusul ăla și fără plată
// (vezi lib/solduri.js) — dacă am reseta-o fiindcă n-are rânduri în `plati`,
// am reînvia creanțe stinse de ani.
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
const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

function csv(t) {
  const R = []; let c = "", r = [], qq = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (qq) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else qq = false; } else c += ch; }
    else if (ch === '"') qq = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n") { r.push(c); R.push(r); r = []; c = ""; }
    else if (ch !== "\r") c += ch;
  }
  if (c !== "" || r.length) { r.push(c); R.push(r); }
  return R;
}
const umple = (sql, p) => { let i = 0; return String(sql).replace(/\?/g, () => lit((p || [])[i++])); };
function q(sql, p) {
  const s = umple(sql, p);
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
// UPDATE-urile trebuie să întoarcă numărul de rânduri atinse, ca în shim-ul
// real (pg dă rowCount). psql îl scrie în eticheta comenzii: "UPDATE 3".
function ruleaza(sql, p) {
  const s = umple(sql, p);
  const out = execFileSync("psql", ["-X", "-c", s], { env: ENV, encoding: "utf8" });
  const m = out.match(/^(?:UPDATE|INSERT \d+|DELETE)\s+(\d+)/m);
  return { changes: m ? Number(m[1]) : 0 };
}
const exec1 = (sql) =>
  execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

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
  run: async (...p) => (/^\s*(update|delete)\b/i.test(sql) ? ruleaza(sql, p) : (() => {
    const r = q(sql, p);
    return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined };
  })()),
});

const MARCA = "TESTSTAT";
let picate = 0;
function bine(nume, conditie, detaliu) {
  if (conditie) console.log(`  ok   ${nume}`);
  else { picate++; console.log(`  PICAT ${nume}${detaliu !== undefined ? ": " + detaliu : ""}`); }
}

function curata() {
  exec1(`DELETE FROM plati WHERE factura_id IN (SELECT id FROM facturi WHERE observatii = '${MARCA}')`);
  exec1(`DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE observatii = '${MARCA}')`);
  exec1(`DELETE FROM facturi WHERE observatii = '${MARCA}'`);
  exec1(`DELETE FROM parteneri WHERE nume LIKE '${MARCA}%'`);
}
function secvente() {
  for (const t of ["parteneri", "facturi", "facturi_linii", "plati"]) {
    exec1(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1))`);
  }
}

// O factură cu o linie de 1.000 lei net + 21% TVA = 1.210 lei cu tot.
function factura(partenerId, numar, status, inchisIstoric) {
  const f = q(
    `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, status, observatii, inchis_istoric, intercompany, activ)
     VALUES ('TS', ?, ?, 'vanzare', '2026-09-01', ?, ?, ?, 0, 1) RETURNING id`,
    [numar, partenerId, status, MARCA, inchisIstoric || null]
  )[0];
  q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, 'test', 1, 1000, 21)`,
    [Number(f.id)]);
  return Number(f.id);
}
const plateste = (fid, suma) =>
  q(`INSERT INTO plati (factura_id, suma, data, activ) VALUES (?, ?, '2026-09-20', 1)`, [fid, suma]);
const statusul = (fid) => (q(`SELECT status FROM facturi WHERE id = ?`, [fid])[0] || {}).status;

(async () => {
  console.log("Statusul facturii urcă singur când intră banii\n");
  curata();
  secvente();

  const { recalculeazaStatusFacturi } = require(path.join(RAD, "lib", "statusuri.js"));
  const partenerId = Number(q(`INSERT INTO parteneri (tip, nume) VALUES ('client', ?) RETURNING id`, [MARCA + " Client"])[0].id);

  // 1.210 cu TVA. Fiecare caz pe factura lui.
  const platitaIntegral = factura(partenerId, 8001, "emisa");
  const platitaPartial = factura(partenerId, 8002, "emisa");
  const neplatita = factura(partenerId, 8003, "emisa");
  const dejaPlatitaFaraPlati = factura(partenerId, 8004, "platita");
  const dejaPlatitaCuPlataMica = factura(partenerId, 8005, "platita");
  const anulata = factura(partenerId, 8006, "anulata");
  const inchisaIstoric = factura(partenerId, 8007, "emisa", "2025-12-31");
  const subToleranta = factura(partenerId, 8008, "emisa");
  const pesteToleranta = factura(partenerId, 8009, "emisa");

  plateste(platitaIntegral, 1210);
  plateste(platitaPartial, 500);
  plateste(dejaPlatitaCuPlataMica, 300);
  plateste(anulata, 1210);
  plateste(inchisaIstoric, 1210);
  plateste(subToleranta, 1209.6);   // lipsesc 40 de bani → tot încasată
  plateste(pesteToleranta, 1209);   // lipsește 1 leu → parțial

  const n = await recalculeazaStatusFacturi();

  console.log("ce urcă:");
  bine("factura încasată integral trece pe „încasată”", statusul(platitaIntegral) === "platita", statusul(platitaIntegral));
  bine("factura încasată pe jumătate trece pe „încasată parțial”",
    statusul(platitaPartial) === "platita_partial", statusul(platitaPartial));
  bine("40 de bani lipsă intră în toleranță, deci tot „încasată”",
    statusul(subToleranta) === "platita", statusul(subToleranta));
  bine("un leu lipsă NU intră în toleranță, deci „parțial”",
    statusul(pesteToleranta) === "platita_partial", statusul(pesteToleranta));

  console.log("\nce rămâne neatins:");
  bine("factura fără nicio plată rămâne „emisă”", statusul(neplatita) === "emisa", statusul(neplatita));
  bine("factura marcată încasată în SmartBill, fără plăți, NU se resetează",
    statusul(dejaPlatitaFaraPlati) === "platita", statusul(dejaPlatitaFaraPlati));
  bine("factura marcată încasată, cu o plată mai mică, NU coboară pe parțial",
    statusul(dejaPlatitaCuPlataMica) === "platita", statusul(dejaPlatitaCuPlataMica));
  bine("factura anulată rămâne anulată chiar dacă are plată",
    statusul(anulata) === "anulata", statusul(anulata));
  bine("factura închisă ca istorie veche nu se atinge",
    statusul(inchisaIstoric) === "emisa", statusul(inchisaIstoric));

  console.log("\ncâte a schimbat, raportat:");
  bine("raportează cel puțin cele 3 trecute pe încasat", Number(n.trecute_pe_incasat) >= 2, JSON.stringify(n));
  bine("raportează cel puțin cele 2 trecute pe parțial", Number(n.trecute_pe_partial) >= 2, JSON.stringify(n));

  // A doua rulare nu mai are ce schimba — semn că nu oscilează.
  const n2 = await recalculeazaStatusFacturi();
  const alteleInJoc = q(
    `SELECT COUNT(*) AS n FROM facturi WHERE observatii = '${MARCA}' AND status NOT IN ('platita','platita_partial','emisa','anulata')`
  )[0];
  bine("a doua rulare nu mai mișcă facturile noastre", Number(alteleInJoc.n) === 0);
  bine("statusurile nu oscilează între rulări",
    statusul(platitaIntegral) === "platita" && statusul(dejaPlatitaCuPlataMica) === "platita",
    JSON.stringify({ a: statusul(platitaIntegral), b: statusul(dejaPlatitaCuPlataMica), n2 }));

  // ---- recalcularea chiar e legată de punte ----------------------------
  console.log("\nrecalcularea e legată de drumul pe care intră banii:");
  const sursaAplica = fs.readFileSync(path.join(RAD, "lib", "punte-aplica.js"), "utf8");
  bine("aplicarea loturilor cheamă recalcularea",
    /recalculeazaStatusFacturi\(\)/.test(sursaAplica) && /require\("\.\/statusuri"\)/.test(sursaAplica));
  bine("aplicarea întoarce și câte statusuri a schimbat", /return \{ rezultate, statusuri \}/.test(sursaAplica));
  const sursaFacturi = fs.readFileSync(path.join(RAD, "modules", "facturi.js"), "utf8");
  bine("butonul de actualizare arată cifra omului", /trecute_pe_incasat/.test(sursaFacturi));

  // ---- rezumatul citește cheile reale ale handlerelor ------------------
  //
  // Prima versiune ghicea („adaugate", „importate", „noi") și a raportat
  // „0 rânduri noi" pe un import care adusese 16 facturi și 34 de încasări.
  console.log("\nrezumatul citește cheile pe care le întorc chiar handlerele:");
  const aplicare = require(path.join(RAD, "lib", "punte-aplica.js"));
  const { total, peTip } = aplicare.rezumat([
    { id: 210, tip: "facturi", rez: { facturi: 4, sarite: 114, parteneri_noi: 1, erori: [] } },
    { id: 211, tip: "incasari", rez: { incasari_scrise: 3, dubluri_sarite: 91, inchise_istoric_ignorate: 0, facturi_negasite: 0 } },
    { id: 212, tip: "facturi", rez: { facturi: 12, sarite: 15, intercompany_marcate: 1, erori: [] } },
    { id: 213, tip: "incasari", rez: { incasari_scrise: 31, dubluri_sarite: 0, inchise_istoric_ignorate: 31, facturi_negasite: 0 } },
  ]);
  bine("numără cele 16 facturi noi, nu zero", total.noi === 16 + 34, `noi=${total.noi}`);
  bine("facturile apar separat de încasări",
    peTip.get("facturi").noi === 16 && peTip.get("incasari").noi === 34,
    JSON.stringify([...peTip]));
  // 129 facturi sărite + 91 încasări duplicate. Cele 31 căzute pe facturi
  // închise NU mai sunt „sărite": acum se scriu, doar marcate.
  bine("sărite: 129 facturi + 91 încasări duplicate", total.sarite === 129 + 91, `sarite=${total.sarite}`);
  bine("un lot cu eroare se numără ca eroare",
    aplicare.rezumat([{ id: 1, tip: "facturi", rez: { eroare: "ceva" } }]).total.erori === 1);
  bine("un tip necunoscut nu crapă rezumatul",
    aplicare.rezumat([{ id: 1, tip: "ceva_nou", rez: { adaugate: 2 } }]).total.noi === 2);
  bine("toate tipurile din HANDLERE au o linie în tabelul de chei",
    Object.keys(require(path.join(RAD, "modules", "punte.js")).HANDLERE).every((t) => aplicare.CHEI[t]),
    Object.keys(require(path.join(RAD, "modules", "punte.js")).HANDLERE).filter((t) => !aplicare.CHEI[t]).join(", "));

  // ---- încasări pe facturi închise ca istoric vechi ---------------------
  //
  // Erau aruncate, ca să nu „redeschidă" soldurile închise pe 19.09.2026.
  // Teama era nefondată: deschisa() scoate din calcul orice factură cu
  // inchis_istoric, oricâte plăți ar avea. Ce se pierdea era adevărul —
  // factura rămânea cu Încasat 0,00 deși banii intraseră. 31 de plăți,
  // 2.575.136,18 lei, toate pe Marine Branding.
  console.log("\nîncasările pe facturi închise ca istoric:");
  exec1(`ALTER TABLE plati ADD COLUMN IF NOT EXISTS pe_factura_inchisa INTEGER NOT NULL DEFAULT 0`);
  const punte = require(path.join(RAD, "modules", "punte.js"));
  const inchisa2 = factura(partenerId, 8010, "emisa", "2025-12-31");
  const deschisa2 = factura(partenerId, 8011, "emisa");

  const rez = await punte.HANDLERE.incasari([
    { factura: "TS8010", data: "2026-09-25", suma: 1210, metoda: "Ordin plata" },
    { factura: "TS8011", data: "2026-09-25", suma: 1210, metoda: "Ordin plata" },
  ]);
  const platiInchisa = q(`SELECT suma, pe_factura_inchisa FROM plati WHERE factura_id = ?`, [inchisa2]);
  const platiDeschisa = q(`SELECT suma, pe_factura_inchisa FROM plati WHERE factura_id = ?`, [deschisa2]);

  bine("plata pe factura închisă se scrie, nu se mai aruncă", platiInchisa.length === 1, JSON.stringify(rez));
  bine("și e marcată ca fiind pe factură închisă",
    platiInchisa.length === 1 && Number(platiInchisa[0].pe_factura_inchisa) === 1, JSON.stringify(platiInchisa));
  bine("plata pe factura deschisă NU e marcată",
    platiDeschisa.length === 1 && Number(platiDeschisa[0].pe_factura_inchisa) === 0, JSON.stringify(platiDeschisa));
  bine("raportează câte au căzut pe facturi închise", Number(rez.pe_facturi_inchise) === 1, JSON.stringify(rez));
  bine("nu mai raportează cheia veche „inchise_istoric_ignorate”", rez.inchise_istoric_ignorate === undefined);

  // soldul NU se redeschide: inchis_istoric bate plățile
  const { deschisa: clauzaDeschisa } = require(path.join(RAD, "lib", "solduri.js"));
  const inca = q(
    `SELECT COUNT(*) AS n FROM (SELECT * FROM facturi WHERE activ = 1) f WHERE f.id = ? AND ${clauzaDeschisa("f")}`,
    [inchisa2]
  );
  bine("factura închisă rămâne în afara soldurilor, deși are acum plată", Number(inca[0].n) === 0);

  // a doua trecere nu dublează
  await punte.HANDLERE.incasari([{ factura: "TS8010", data: "2026-09-25", suma: 1210, metoda: "Ordin plata" }]);
  bine("re-aplicarea aceluiași rând nu dublează plata",
    q(`SELECT COUNT(*) AS n FROM plati WHERE factura_id = ?`, [inchisa2])[0].n === "1");

  const sursaRute = fs.readFileSync(path.join(RAD, "modules", "punte-rute.js"), "utf8");
  bine("un lot deja aplicat se poate trece din nou", /Aplică din nou/.test(sursaRute));
  bine("previzualizarea poate arăta toate rândurile", /ctx\.query\.tot/.test(sursaRute));

  curata();
  console.log(picate ? `\n${picate} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(picate ? 1 : 0);
})().catch((e) => {
  console.error("Testul a crăpat:", e.message);
  process.exit(2);
});
