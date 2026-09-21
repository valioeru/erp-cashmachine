"use strict";
// Test pentru raportul „Clienți cheie vs. restul".
//
// Ce apără, în ordinea în care doare dacă se strică:
//   • sumele sunt FĂRĂ TVA. Dacă se strecoară cota, fiecare cifră e cu 19%
//     mai mare și procentele par corecte — adică greșeala nu se vede;
//   • excluderile se aplică ÎNAINTE de procente. Altfel numitorul conține
//     exact ce am scos, iar procentele sunt minciuni rotunde;
//   • „POȘTA ROMÂNĂ S.A." și „Posta Romana SA" sunt aceeași firmă. Numărate
//     separat, raportul arată două firme mici în loc de una mare;
//   • pragul Warehouse All taie DOAR facturile de la Warehouse All, nu pe
//     toate cele mari.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
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
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

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

const mod = require(path.join(RAD, "modules", "clienti-cheie.js"));
const rute = { get: {}, post: {} };
mod.register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function cer(cale, { query = {} } = {}) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipsește: GET " + cale);
  const r = res();
  await h({ user: VALI, params: {}, query, body: {}, res: r, req: { url: cale } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const rot = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  // Toate facturile fixturii sunt în ianuarie și februarie 2026, ca raportul
  // să aibă exact două luni și cifrele să se poată număra pe degete.
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id BETWEEN 96501 AND 96599",
    "DELETE FROM facturi WHERE id BETWEEN 96501 AND 96599",
    "DELETE FROM parteneri WHERE cui LIKE 'RO-CK-%'",
    "DELETE FROM firme WHERE cui IN ('CK-CM','CK-WH')",
    `INSERT INTO firme (id, nume, cui, culoare, in_grup, implicita, operationala) VALUES
       (96601,'Cash Machine SRL test','CK-CM','#000',1,0,1),
       (96602,'Warehouse All SRL test','CK-WH','#000',1,0,1)
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES
       (96501,'DELIVERY SOLUTIONS S.A.','RO-CK-1','client'),
       (96502,'URGENT CARGUS SA','RO-CK-2','client'),
       (96503,'DANTE INTERNATIONAL SA (eMAG Retail)','RO-CK-3','client'),
       (96504,'COMPANIA NATIONALA POSTA ROMANA S.A.','RO-CK-4','client'),
       (96505,'Posta Romana SA','RO-CK-5','client'),
       (96506,'UN CLIENT OARECARE SRL','RO-CK-6','client'),
       (96507,'NEGRU AND NEGRU SRL','RO-CK-7','client'),
       (96508,'BCR LEASING IFN SA','RO-CK-8','client')`,
  ]) exec(s);

  // O factură = un rând aici. Net-ul se scrie ca o singură linie, cu TVA 19%,
  // ca să se vadă dacă raportul scapă cota în sumă.
  const F = [
    // id, partener, luna, firma, net
    [96501, 96501, "2026-01-10", 96601, 10000],  // Delivery
    [96502, 96502, "2026-01-12", 96601, 5000],   // Cargus
    [96503, 96503, "2026-01-15", 96601, 3000],   // eMAG (Dante)
    [96504, 96504, "2026-01-20", 96601, 1000],   // Poșta, nume lung
    [96505, 96505, "2026-01-22", 96601, 1000],   // Poșta, alt nume — TOT Poșta
    [96506, 96506, "2026-01-25", 96601, 5000],   // ceilalți
    [96507, 96507, "2026-01-26", 96601, 90000],  // Negru and Negru — se scoate
    [96508, 96508, "2026-01-27", 96601, 70000],  // BCR Leasing — se scoate
    // februarie
    [96509, 96501, "2026-02-05", 96601, 20000],  // Delivery
    [96510, 96506, "2026-02-06", 96601, 30000],  // ceilalți
    [96511, 96506, "2026-02-07", 96602, 250000], // Warehouse All, peste ambele praguri
    [96512, 96506, "2026-02-08", 96602, 150000], // Warehouse All: iese la 100.000, rămâne la 200.000
    [96513, 96506, "2026-02-09", 96601, 250000], // mare, dar NU Warehouse — rămâne
  ];
  for (const [id, part, data, firma, net] of F) {
    exec(
      `INSERT INTO facturi (id, serie, numar, partener_id, firma_id, directie, data_emiterii, status, activ, intercompany)
       VALUES (${id},'CK',${id},${part},${firma},'vanzare','${data}','emisa',1,0)`
    );
    exec(
      `INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva)
       VALUES (${id},'marfa',1,${net},19)`
    );
  }
  // O factură fără nicio linie: trebuie numărată și semnalată, nu ascunsă.
  exec(
    `INSERT INTO facturi (id, serie, numar, partener_id, firma_id, directie, data_emiterii, status, activ, intercompany)
     VALUES (96514,'CK',96514,96506,96601,'vanzare','2026-02-10','emisa',1,0)`
  );

  // Pragul implicit e acum 100.000 — coborât de Vali de la 200.000.
  egal("pragul implicit e 100.000", mod.PRAG_IMPLICIT, 100000);

  // --- împreună (cum se vede din start) -------------------------------------
  const d = await mod.culege({ deLa: "2026-01-01", panaLa: "2026-02-28", prag: 100000 });
  egal("Delivery și Cargus sunt o singură coloană",
    d.grupuri.map((g) => g.nume), ["Delivery + Cargus", "eMAG Retail", "Poșta Română"]);

  const ian = d.luni.find((x) => x[0] === "2026-01")[1];
  egal("ianuarie: sumele sunt fără TVA, cu curierii adunați",
    [rot(ian.curieri), rot(ian.emag), rot(ian.posta), rot(ian.altii), rot(ian.total)],
    [15000, 3000, 2000, 5000, 25000]);
  ok("Poșta apare o singură dată, deși are două nume scrise diferit (1000 + 1000)");

  // 15000/25000 = 60%
  egal("procentele se calculează după excluderi", rot((ian.curieri / ian.total) * 100), 60);

  // --- februarie: pragul de 100.000 taie AMBELE facturi Warehouse ------------
  const feb = d.luni.find((x) => x[0] === "2026-02")[1];
  egal("februarie: la 100.000 ies ambele facturi Warehouse, cea mare non-Warehouse rămâne",
    [rot(feb.curieri), rot(feb.altii), rot(feb.total)],
    [20000, 280000, 300000]);
  egal("factura fără linii e numărată, dar valorează zero", [feb.nr, feb.faraLinii], [4, 1]);

  // --- excluderile --------------------------------------------------------
  egal("Negru and Negru + BCR Leasing, scoase cu tot cu sumă",
    [d.scoase.excluse, rot(d.scoase.sumaExcluse)], [2, 160000]);
  egal("două facturi Warehouse peste prag",
    [d.scoase.warehouse, rot(d.scoase.sumaWarehouse)], [2, 400000]);

  // --- totalul ------------------------------------------------------------
  egal("totalul e suma lunilor", rot(d.total.total), rot(ian.total + feb.total));

  // --- separat, la cerere ---------------------------------------------------
  const ds = await mod.culege({ deLa: "2026-01-01", panaLa: "2026-02-28", prag: 100000, separat: true });
  egal("cu separat=1 revin patru coloane",
    ds.grupuri.map((g) => g.nume), ["Delivery Solutions", "Cargus", "eMAG Retail", "Poșta Română"]);
  const ianS = ds.luni.find((x) => x[0] === "2026-01")[1];
  egal("separat, suma lor e aceeași ca împreună",
    rot(ianS.delivery + ianS.cargus), rot(ian.curieri));
  egal("și nu se schimbă nici totalul, nici ceilalți",
    [rot(ianS.total), rot(ianS.altii)], [rot(ian.total), rot(ian.altii)]);

  // --- pragul se poate schimba din pagină -----------------------------------
  const d2 = await mod.culege({ deLa: "2026-01-01", panaLa: "2026-02-28", prag: 200000 });
  egal("înapoi la 200.000, iese o singură factură Warehouse", d2.scoase.warehouse, 1);
  egal("iar februarie urcă la loc cu cea de 150.000",
    rot(d2.luni.find((x) => x[0] === "2026-02")[1].total), 450000);

  // --- pagina --------------------------------------------------------------
  const r = await cer("/rapoarte/clienti-cheie", { query: { de_la: "2026-01-01", pana_la: "2026-02-28" } });
  const fara = r.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (r.cod !== 200) rau("pagina nu se deschide", String(r.cod));
  else if (/NaN|Infinity|undefined</.test(fara)) rau("NaN/undefined în pagină");
  else {
    const lipsa = ["Delivery + Cargus", "eMAG Retail", "Poșta Română", "Ceilalți", "60,0%", "n-au nicio linie", "Vezi-i separat"]
      .filter((b) => !fara.includes(b));
    if (lipsa.length) rau("lipsește din pagină", lipsa.join(", "));
    else ok("pagina arată grupurile, procentele și avertismentul (" + r.corp.length + " octeți)");
  }
  if (!fara.includes("DELIVERY SOLUTIONS S.A.") || !fara.includes("URGENT CARGUS SA"))
    rau("pagina nu spune ce firme au intrat în grupul comun");
  else ok("pagina spune ce firme au intrat în fiecare grup, inclusiv amândouă la curieri");

  const rs = await cer("/rapoarte/clienti-cheie", { query: { de_la: "2026-01-01", pana_la: "2026-02-28", separat: "1" } });
  if (!rs.corp.includes("Numără-i împreună")) rau("din pagina separată nu se poate reveni");
  else ok("din pagina separată se revine la coloana comună");

  // eMAG se prinde după numele juridic, nu după cel de pe cutie.
  egal("eMAG Retail se recunoaște și ca Dante International",
    !!mod.potrivit(mod.grupuri(true), mod.strans("DANTE INTERNATIONAL S.A.")), true);

  // --- curățenie după noi ----------------------------------------------------
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id BETWEEN 96501 AND 96599",
    "DELETE FROM facturi WHERE id BETWEEN 96501 AND 96599",
    "DELETE FROM parteneri WHERE cui LIKE 'RO-CK-%'",
    "DELETE FROM firme WHERE cui IN ('CK-CM','CK-WH')",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
