"use strict";
// Test pentru raportul „Indicatori financiari — ochii băncii".
//
// Rulează pe PostgreSQL adevărat, prin psql (vezi comentariul din
// test-depozit.js: `pg` nu se poate instala aici, dar SQL-ul chiar se execută
// pe schema reală). Se rulează din rădăcina repo-ului, cu baza pe 5433.
//
// Ce se verifică, în ordinea în care se pot strica lucrurile:
//   1. balanțele ciuntite (un singur cont, rămase din sincronizări) nu au voie
//      să intre în comparație — ar arăta un an cu cifra de afaceri zero;
//   2. o balanță trasă la mijlocul lunii nu e „lună închisă" și nu are voie să
//      fie reperul comparației an/an;
//   3. dacă lipsește aceeași lună dintr-un an, coloana arată luna cea mai
//      apropiată dinainte ȘI o spune pe față;
//   4. estimarea anului în curs merge pe sezon, nu pe pro-rata liniară, când
//      are din ce să măsoare sezonul;
//   5. evoluția pe luni e tabel separat, cu diferența lunară calculată din
//      cumulat;
//   6. top 5 furnizori și concentrarea pe primul furnizor;
//   7. indicatorii pe care banca îi scrie în contract — EBITDA, CFO, equity
//      ratio, leverage, gearing, datorie netă ÷ EBITDA, rotația stocurilor —
//      toți cu valori calculate cu mâna din fixtură, nu copiate din ieșire;
//   8. raportul de tipărit pentru bancă: antet, stil de tipar, aceleași cifre
//      și fără nimic din interfața ERP-ului.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : "'" + String(v).replace(/'/g, "''") + "'";

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

let interogari = 0;
function q(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}

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

const rap = require(path.join(RAD, "modules", "rapoarte.js"));
const rute = { get: {}, post: {} };
rap.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  const url = cale + "?" + new URLSearchParams(query).toString();
  await h({ user, params, query, body: body || {}, res: r, req: { url } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function cere(eticheta, corp, bucati, interzise) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined<|>undefined/.test(fara)) return rau(eticheta, "NaN/undefined în pagină");
  const lipsa = bucati.filter((b) => !fara.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => fara.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta + " (" + corp.length + " octeți)");
}

const rulaj = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

// ---- balanțele de test ------------------------------------------------------
// O balanță adevărată are peste o sută de conturi; pragul din raport e 20, așa
// că fiecare balanță de test primește conturile care contează plus umplutură
// din clasa 6 (pe care analiza n-o citește pentru profit — Conta închide lunar
// 6/7 prin 121, de-aia profitul se ia din soldul lui 121).
//
// IMPORTANT: fixtura se ECHILIBREAZĂ (activ = pasiv), la soldurile inițiale și
// la cele finale. Nu e cochetărie: identitatea contabilă face ca
// CFO + CFI + CFF să dea exact variația de cash. Dacă formula de cash flow din
// raport e greșită, verificarea din pagină nu mai spune „Se leagă" și testul
// pică — ăsta e tot rostul echilibrării.
//
// Soldul furnizorilor nu se dă, se DEDUCE: activ − capital − profit − credit.
const FINAL = { imob: 400000, marfa: 500000, clienti: 900000, banca: 120000, capital: 200000, credit: 300000 };
const INITIAL = { imob: 380000, marfa: 400000, clienti: 800000, banca: 100000, capital: 200000, credit: 320000, profit: 0 };
// rulajele nelegate de profit, la fel în toate balanțele, ca EBITDA să difere
// doar prin profit și comparația pe ani să rămână citibilă
const FLUX = { amort: 80000, dob: 30000, imp: 20000, consum: 2000000 };

function furnizoriDedusi(s) {
  const activ = s.imob + s.marfa + s.clienti + s.banca;
  return activ - s.capital - (s.profit || 0) - s.credit;
}

// Fixtura scrie ȘI coloanele de „total sume" (ts_d / ts_c), fiindcă de acolo
// citește raportul fluxurile: total sume minus solduri inițiale = cumulatul
// anului, și pe o balanță trasă cumulat, și pe una trasă pe o lună. Tot de
// acolo iese profitul — veniturile închise în 121 minus cheltuielile — ca să
// nu depindă de ce a rămas în 121 din anul trecut.
//
// Cheltuielile sunt fixate să închidă exact: cifra de afaceri minus profitul.
function balanta(eticheta, deLa, panaLa, d) {
  const F = Object.assign({}, FINAL, { profit: d.profit });
  const I = INITIAL;
  const fF = furnizoriDedusi(F);
  const fI = furnizoriDedusi(I);
  const cheltuieliTotal = d.ca - d.profit;
  const umplutura = cheltuieliTotal - (FLUX.amort + FLUX.dob + FLUX.imp + FLUX.consum);
  const R = [];
  // ts = sold inițial + rulaj cumulat de la 1 ianuarie
  const pune = (cont, den, siD, siC, rD, rC, sfD, sfC) =>
    R.push(
      `(${lit(eticheta)},${lit(deLa)},${lit(panaLa)},${lit(cont)},${lit(den)},${siD || 0},${siC || 0},${rD || 0},${rC || 0},${(siD || 0) + (rD || 0)},${
        (siC || 0) + (rC || 0)
      },${sfD || 0},${sfC || 0},'test')`
    );
  pune("1012", "Capital social", 0, I.capital, 0, 0, 0, F.capital);
  // 121: veniturile se închid pe credit, cheltuielile pe debit
  pune("121", "Profit sau pierdere", 0, I.profit, cheltuieliTotal, d.ca, 0, F.profit);
  pune("1621", "Credite bancare pe termen lung", 0, I.credit, 0, 0, 0, F.credit);
  pune("2131", "Echipamente", I.imob, 0, 0, 0, F.imob, 0);
  pune("371", "Mărfuri", I.marfa, 0, 0, 0, F.marfa, 0);
  pune("4111", "Clienți", I.clienti, 0, 0, 0, F.clienti, 0);
  pune("401", "Furnizori", 0, fI, 0, 0, 0, fF);
  pune("5121", "Conturi la bănci în lei", I.banca, 0, 0, 0, F.banca, 0);
  pune("701", "Venituri din vânzarea produselor finite", 0, 0, d.ca, d.ca, 0, 0);
  pune("6811", "Cheltuieli de exploatare privind amortizarea", 0, 0, FLUX.amort, FLUX.amort, 0, 0);
  pune("666", "Cheltuieli privind dobânzile", 0, 0, FLUX.dob, FLUX.dob, 0, 0);
  pune("691", "Cheltuieli cu impozitul pe profit", 0, 0, FLUX.imp, FLUX.imp, 0, 0);
  pune("607", "Cheltuieli privind mărfurile", 0, 0, FLUX.consum, FLUX.consum, 0, 0);
  pune("6280", "Alte cheltuieli cu serviciile", 0, 0, umplutura, umplutura, 0, 0);
  // umplutură: conturi fără sume, ca balanța să treacă pragul de „balanță întreagă"
  for (let i = 0; i < 11; i++) pune("62" + (10 + i), "Cheltuială " + i, 0, 0, 0, 0, 0, 0);
  return `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, si_d, si_c, r_d, r_c, ts_d, ts_c, sf_d, sf_c, fisier) VALUES ${R.join(",")}`;
}

const cu = (x) => x;

const azi = new Date().toISOString().slice(0, 10);
const AN = azi.slice(0, 4);

function fixtureFacturi() {
  const S = [
    "TRUNCATE plati, facturi_linii, facturi, inchideri_istoric RESTART IDENTITY CASCADE",
    "DELETE FROM parteneri WHERE cui IN ('RO-IND-C','RO-IND-F1','RO-IND-F2')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (91001,'CLIENT INDICATORI SRL','RO-IND-C','client'), (91002,'FURNIZOR MARE SRL','RO-IND-F1','furnizor'), (91003,'FURNIZOR MIC SRL','RO-IND-F2','furnizor') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
  ];
  const zileInUrma = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const F = [
    [91101, "vanzare", 91001, zileInUrma(30), zileInUrma(0), "emisa", 600000],
    [91102, "vanzare", 91001, zileInUrma(400), zileInUrma(370), "platita", 500000],
    [91201, "achizitie", 91002, zileInUrma(40), zileInUrma(10), "emisa", 200000],
    [91202, "achizitie", 91003, zileInUrma(60), zileInUrma(30), "emisa", 50000],
  ];
  for (const [id, dir, part, em, sc, st, tot] of F) {
    S.push(`INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, firma_id, intercompany, activ) VALUES (${id},'IND',${id},${part},'${dir}','${em}','${sc}','${st}',NULL,0,1)`);
    S.push(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id},'marfă',1,${tot},19)`);
  }
  S.push("SELECT setval(pg_get_serial_sequence('facturi','id'), 91500, true)");
  for (const s of S) rulaj(s);
}

function fixtureBalante(cuAugustVechi) {
  rulaj("DELETE FROM balante_snapshot");
  const B = [
    balanta("Anul 2024", "2024-01-01", "2024-12-31", cu({ ca: 5400000, profit: 280000 })),
    balanta("2024 la 31.07", "2024-01-01", "2024-07-31", cu({ ca: 3000000, profit: 150000 })),
    balanta("Anul 2025", "2025-01-01", "2025-12-31", cu({ ca: 6000000, profit: 300000 })),
    balanta("2025 la 31.07", "2025-01-01", "2025-07-31", cu({ ca: 3400000, profit: 170000 })),
    balanta("2026 la 31.07", "2026-01-01", "2026-07-31", cu({ ca: 3800000, profit: 190000 })),
    balanta("2026 la 31.08", "2026-01-01", "2026-08-31", cu({ ca: 4300000, profit: 220000 })),
    // balanță trasă la mijlocul lunii — la zi, dar NU lună închisă
    balanta("2026 la 14.09", "2026-01-01", "2026-09-14", cu({ ca: 4600000, profit: 230000 })),
  ];
  if (cuAugustVechi) {
    B.push(balanta("2025 la 31.08", "2025-01-01", "2025-08-31", cu({ ca: 3900000, profit: 200000 })));
    B.push(balanta("2024 la 31.08", "2024-01-01", "2024-08-31", cu({ ca: 3500000, profit: 180000 })));
  }
  for (const s of B) rulaj(s);
  // balanță ciuntită: un singur cont, rămasă dintr-o sincronizare picată.
  // Nu are voie să apară ca o coloană de an.
  rulaj(
    "INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, si_d, si_c, r_d, r_c, ts_d, ts_c, sf_d, sf_c, fisier) VALUES ('2025 la 28.08 CIUNTITA','2025-01-01','2025-08-28','121','Profit sau pierdere',0,0,0,0,0,0,0,9999,'test')"
  );
}

(async () => {
  console.log("\n── Indicatori financiari — ochii băncii ──────────────────────");
  fixtureFacturi();

  // ---- etapa 1: lipsesc balanțele de august din anii trecuți ---------------
  fixtureBalante(false);
  let r = await cer("/rapoarte/indicatori");
  cere(
    "reperul e ultima LUNĂ ÎNCHISĂ, nu balanța de la mijlocul lunii",
    r.corp,
    ["La aceeași lună, pe trei ani — aug. 2026"],
    ["pe trei ani — sep. 2026"]
  );
  cere("balanța ciuntită de un cont nu devine coloană", r.corp, [], ["CIUNTITA"]);
  cere(
    "lipsa lunii se spune pe față, cu luna folosită în loc",
    r.corp,
    ["Nu am balanța pe aug. 2025 și aug. 2024", "iul. 2025", "iul. 2024"],
    ["Toate cele trei coloane sunt pe aceeași lună"]
  );
  cere(
    "fără sezon măsurabil, estimarea e pro-rata liniară și o spune",
    r.corp,
    ["pro-rata liniară", "2026 estimat", "6.450.000,00 lei"],
    ["factorul mediu de sezon"]
  );

  // ---- etapa 2: balanțele de august există pe toți cei trei ani -----------
  fixtureBalante(true);
  r = await cer("/rapoarte/indicatori");
  cere(
    "trei coloane pe aceeași lună",
    r.corp,
    ["aug. 2026", "aug. 2025", "aug. 2024", "Toate cele trei coloane sunt pe aceeași lună"],
    ["Nu am balanța pe"]
  );
  cere(
    "cifrele reale pe cele trei coloane",
    r.corp,
    ["4.300.000,00 lei", "3.900.000,00 lei", "3.500.000,00 lei"]
  );
  cere("creșterea an/an apare pe coloana de delta", r.corp, ["Δ 26/25", "+10.3%"]);
  cere(
    "estimarea merge pe sezonul măsurat, nu liniar",
    r.corp,
    ["factorul mediu de sezon 1.54", "măsurat pe 2024 și 2025", "6.624.835,16 lei", "338.945,05 lei"],
    ["pro-rata liniară"]
  );
  cere(
    "tabelul de final de an are anii încheiați, cel mai nou primul",
    r.corp,
    ["La final de an (cu estimat 2026)", "6.000.000,00 lei", "5.400.000,00 lei"]
  );
  cere(
    "pozițiile de bilanț nu se extrapolează",
    r.corp,
    ["Restul pozițiilor de bilanț sunt fotografii la o dată"]
  );
  cere(
    "evoluția lunară e tabel separat, cu diferența pe lună",
    r.corp,
    ["Evoluția pe luni — 2026", "iul. 2026", "din care în lună", "500.000,00 lei", "(parțial, la 14.09.2026)"]
  );
  cere(
    "top 5 furnizori, cu concentrarea pe primul",
    r.corp,
    ["Top 5 furnizori (concentrarea aprovizionării)", "FURNIZOR MARE SRL", "FURNIZOR MIC SRL", "200.000,00 lei", "Concentrarea pe primul furnizor", "80% (FURNIZOR MARE SRL)", "Ai a doua sursă la FURNIZOR MARE SRL?"]
  );
  cere("top 5 clienți a rămas la locul lui", r.corp, ["Top 5 clienți (concentrarea riscului)", "CLIENT INDICATORI SRL"]);

  // ---- indicatorii ceruți de bancă ---------------------------------------
  // Valorile de mai jos sunt calculate cu mâna din fixtură, nu copiate din
  // ieșirea programului — altfel testul ar confirma orice formulă.
  //
  // La aug. 2026: capitaluri 420.000 (capital 200.000 + profit 220.000);
  // activ 1.920.000; datorii 1.500.000 (credit 300.000 + furnizori 1.200.000).
  //   EBITDA      = 220.000 + 20.000 (impozit) + 30.000 (dobânzi) + 80.000 (amortizare) = 350.000
  //   marja EBITDA= 350.000 / 4.300.000 = 8,1%
  //   equity ratio= 420.000 / 1.920.000 = 21,9%
  //   leverage    = 1.500.000 / 420.000 = 3,57
  //   datorie netă= 300.000 − 120.000 = 180.000 ⇒ gearing = 180.000/420.000 = 42,9%
  //   EBITDA anualizat = 350.000 × 365/243 zile = 525.720 ⇒ datorie netă/EBITDA = 0,34
  //   acoperirea dobânzii = (220.000+20.000+30.000)/30.000 = 9,00
  //   stoc mediu = (400.000+500.000)/2 = 450.000 ⇒ zile = 450.000/2.000.000 × 243 = 55
  //                                              ⇒ rotația = 365/55 = 6,68
  //   CFO = 220.000 + 80.000 − 100.000 (creanțe) − 100.000 (stocuri) + 40.000 (furnizori) = 140.000
  cere(
    "EBITDA și marja EBITDA",
    r.corp,
    ["EBITDA", "350.000,00 lei", "Marja EBITDA", "8.1%", "Profit net + impozit + dobânzi + amortizare"]
  );
  cere(
    "CFO și verificarea cu variația reală de cash",
    r.corp,
    ["Cash flow din exploatare", "140.000,00 lei", "Verificarea cash flow-ului", "Se leagă."]
  );
  cere(
    "equity ratio, leverage, gearing, datorie netă ÷ EBITDA",
    r.corp,
    ["Equity ratio (capitaluri ÷ total activ)", "21.9%", "Leverage (total datorii ÷ capitaluri)", "3.57", "Gearing (datorie netă ÷ capitaluri)", "42.9%", "Datorie netă ÷ EBITDA (anualizat)", "0.34"]
  );
  cere("acoperirea dobânzii", r.corp, ["Acoperirea dobânzii (EBIT ÷ dobânzi)", "9.00"]);
  cere("rotația stocurilor și zilele de stoc", r.corp, ["Rotația stocurilor", "6.68", "Zile de stoc", "55 zile"]);
  cere(
    "tabelele multi-an sunt împărțite pe capitole",
    r.corp,
    ["Rezultate", "Bilanț", "Structura și riscul — ce se uită banca", "Cash flow (metoda indirectă)"]
  );
  cere("EBITDA se estimează, indicatorii de structură nu", r.corp, ["539.230,77 lei"]);

  // ---- raportul de tipărit pentru bancă -----------------------------------
  cere("butonul de raport e pe pagină", r.corp, ["Generează raport pentru bancă", "/rapoarte/indicatori/raport-banca"]);
  const rb = await cer("/rapoarte/indicatori/raport-banca");
  cere(
    "raportul pentru bancă are antet, buton de tipărire și aceleași cifre",
    rb.corp,
    ["Dosar financiar — indicatori pentru bancă", "Tipărește / salvează PDF", "Perioada de referință", "350.000,00 lei", "140.000,00 lei", "Top 5 furnizori", "Indicatorii dosarului de credit"],
    ["subnav", "Toate rapoartele", "Generează raport pentru bancă"]
  );
  if (!/@media print/.test(rb.corp) || !/A4 landscape/.test(rb.corp)) rau("raportul pentru bancă are stil de tipar");
  else ok("raportul pentru bancă are stil de tipar");

  // ---- etapa 3: fără nicio balanță ----------------------------------------
  rulaj("DELETE FROM balante_snapshot");
  r = await cer("/rapoarte/indicatori");
  cere(
    "fără balanțe, raportul nu crapă și cere încărcarea lor",
    r.corp,
    ["Balanțe istorice", "Indicatorii dosarului de credit", "Top 5 furnizori"],
    ["La aceeași lună, pe trei ani", "Evoluția pe luni"]
  );

  // ---- curățenie ----------------------------------------------------------
  rulaj("TRUNCATE plati, facturi_linii, facturi RESTART IDENTITY CASCADE");
  rulaj("DELETE FROM parteneri WHERE cui IN ('RO-IND-C','RO-IND-F1','RO-IND-F2')");

  console.log(`\n${rele ? rele + " probleme" : "Totul curat."}  (${interogari} interogări SQL)\n`);
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
