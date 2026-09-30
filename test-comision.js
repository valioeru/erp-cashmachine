"use strict";
// Comisionul agenților se dă din valoarea FĂRĂ TVA, nu din cea cu TVA.
//
// De ce există testul: până acum toate cele patru locuri care socoteau
// comisionul îl luau din suma cu TVA. La 2% asta însemna în realitate 2,42%
// din venitul firmei — TVA-ul nu e al nostru, doar trece prin cont. Greșeala
// nu se vedea nicăieri, fiindcă un procent mic pe o bază mai mare arată tot
// ca un procent mic.
//
// Ce se verifică, pe PostgreSQL real (portul 5433), cu date puse la mână:
//   1. o factură cu TVA 21%, încasată integral → comisionul iese din net;
//   2. o factură cu linii pe cote diferite (21% și 9%) → raportul se citește
//      din liniile ei, nu se presupune o cotă;
//   3. o factură FĂRĂ linii, încasată → comisionul nu iese zero, ci se cade
//      pe cota standard de la data facturii;
//   4. o factură din 2024 fără linii → cota implicită e 19%, nu 21%.
//
// Se rulează din rădăcina repo-ului.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});
const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const cb = require(path.join(RAD, "lib", "comision-baza.js"));

const MARCA = "TESTCOMIS";
let picate = 0;
const aprox = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol === undefined ? 0.01 : tol);
function verifica(nume, gasit, asteptat, tol) {
  if (aprox(gasit, asteptat, tol)) console.log(`  ok   ${nume}: ${Number(gasit).toFixed(2)}`);
  else { picate++; console.log(`  PICAT ${nume}: am ${Number(gasit).toFixed(2)}, așteptam ${Number(asteptat).toFixed(2)}`); }
}

// Secvențele bazei de test rămân în urmă când s-au inserat rânduri cu id dat
// explicit (așa intră datele din backup). Fără asta, primul INSERT al testului
// pică pe cheie duplicată, iar mesajul nu spune nimic despre cauză.
function sincronizeazaSecvente() {
  for (const tabel of ["utilizatori", "parteneri", "facturi", "facturi_linii", "plati", "alocari_clienti"]) {
    exec1(`SELECT setval(pg_get_serial_sequence('${tabel}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${tabel}), 0), 1))`);
  }
}

function curata() {
  exec1(`DELETE FROM plati WHERE factura_id IN (SELECT id FROM facturi WHERE observatii = '${MARCA}')`);
  exec1(`DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE observatii = '${MARCA}')`);
  exec1(`DELETE FROM alocari_clienti WHERE partener_id IN (SELECT id FROM parteneri WHERE nume LIKE '${MARCA}%')`);
  exec1(`DELETE FROM facturi WHERE observatii = '${MARCA}'`);
  exec1(`DELETE FROM parteneri WHERE nume LIKE '${MARCA}%'`);
  exec1(`DELETE FROM utilizatori WHERE nume LIKE '${MARCA}%'`);
}

// O factură cu liniile ei și încasarea integrală. Întoarce {id, net, total}.
function factura(partenerId, numar, data, linii) {
  const f = q(
    `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, status, observatii, intercompany, activ)
     VALUES ('TC', ?, ?, 'vanzare', ?, 'emisa', ?, 0, 1) RETURNING id`,
    [numar, partenerId, data, MARCA]
  )[0];
  let net = 0, total = 0;
  for (const [cant, pret, cota] of linii) {
    q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, 'test', ?, ?, ?)`,
      [Number(f.id), cant, pret, cota]);
    net += cant * pret;
    total += cant * pret * (1 + cota / 100);
  }
  return { id: Number(f.id), net, total };
}
const incaseaza = (fid, suma, data) =>
  q(`INSERT INTO plati (factura_id, suma, data, activ) VALUES (?, ?, ?, 1)`, [fid, suma, data]);

(async () => {
  console.log("Comisionul agenților iese din valoarea fără TVA\n");
  curata();
  sincronizeazaSecvente();

  // ---- 0. partea de JavaScript, fără bază ---------------------------------
  console.log("raportNetJs (plasa pentru facturi fără linii):");
  verifica("factură cu linii: 1000 net / 1210 total", cb.raportNetJs(1000, 1210, "2026-05-01"), 1000 / 1210, 0.0001);
  verifica("fără linii, 2026 → cota 21%", cb.raportNetJs(0, 0, "2026-05-01"), 1 / 1.21, 0.0001);
  verifica("fără linii, 2024 → cota 19%", cb.raportNetJs(0, 0, "2024-05-01"), 1 / 1.19, 0.0001);
  verifica("fără linii, exact 01.08.2025 → 21%", cb.raportNetJs(0, 0, "2025-08-01"), 1 / 1.21, 0.0001);
  verifica("fără linii, 31.07.2025 → 19%", cb.raportNetJs(0, 0, "2025-07-31"), 1 / 1.19, 0.0001);

  // ---- fixtures -----------------------------------------------------------
  const ag = q(
    `INSERT INTO utilizatori (nume, email, parola_hash, parola_salt, rol, comision_procent, activ)
     VALUES (?, ?, 'x', 'y', 'vanzari', 2, 1) RETURNING id`,
    [MARCA + " Agent", MARCA.toLowerCase() + "@test.local"]
  )[0];
  const agentId = Number(ag.id);
  const pa = q(`INSERT INTO parteneri (tip, nume, cui) VALUES ('client', ?, ?) RETURNING id`,
    [MARCA + " Client", "RO" + MARCA])[0];
  const partenerId = Number(pa.id);
  q(`INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (?, ?, 100)`, [partenerId, agentId]);

  // 1. TVA 21% simplu: 1.000 net → 1.210 cu TVA, încasat integral
  const f1 = factura(partenerId, 9001, "2026-05-10", [[10, 100, 21]]);
  incaseaza(f1.id, f1.total, "2026-05-20");
  // 2. cote mixte: 1.000 la 21% + 1.000 la 9%
  const f2 = factura(partenerId, 9002, "2026-05-11", [[10, 100, 21], [10, 100, 9]]);
  incaseaza(f2.id, f2.total, "2026-05-21");
  // 3. fără linii, 2026 → plasa de 21%
  const f3 = q(
    `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, status, observatii, intercompany, activ)
     VALUES ('TC', 9003, ?, 'vanzare', '2026-05-12', 'emisa', ?, 0, 1) RETURNING id`,
    [partenerId, MARCA]
  )[0];
  incaseaza(Number(f3.id), 1210, "2026-05-22");
  // 4. fără linii, 2024 → plasa de 19%
  const f4 = q(
    `INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, status, observatii, intercompany, activ)
     VALUES ('TC', 9004, ?, 'vanzare', '2024-05-12', 'emisa', ?, 0, 1) RETURNING id`,
    [partenerId, MARCA]
  )[0];
  incaseaza(Number(f4.id), 1190, "2026-05-23");

  // 5. o factură încasată CHIAR LUNA ASTA, ca să aibă ce lista pagina
  const aziTxt = new Date().toISOString().slice(0, 10);
  const f5 = factura(partenerId, 9005, aziTxt, [[10, 50, 21]]); // 500 net, 605 cu TVA
  incaseaza(f5.id, f5.total, aziTxt);

  // ---- expresia SQL, pe fiecare factură în parte --------------------------
  console.log("\nexpresia SQL pe fiecare factură:");
  const linii = q(
    `SELECT f.numar, pl.suma, ${cb.incasatNet("pl", "f")} AS baza
       FROM (SELECT * FROM plati WHERE activ = 1) pl
       JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
       ${cb.joinRaport("f")}
      WHERE f.observatii = ? ORDER BY f.numar`,
    [MARCA]
  );
  const peNumar = new Map(linii.map((r) => [String(r.numar), Number(r.baza)]));
  verifica("9001 · 21% · 1.210 încasat → bază", peNumar.get("9001"), 1000);
  verifica("9002 · 21%+9% · 2.110 încasat → bază", peNumar.get("9002"), 2000);
  verifica("9003 · fără linii, 2026 → bază", peNumar.get("9003"), 1210 / 1.21);
  verifica("9004 · fără linii, 2024 → bază", peNumar.get("9004"), 1190 / 1.19);

  // ---- comisionul de 2%, prin funcția reală din modul ---------------------
  console.log("\ncomisionul de 2% al agentului, în mai 2026:");
  const rez = q(
    `SELECT COALESCE(SUM(pl.suma * al.procent / 100.0),0) AS brut,
            COALESCE(SUM(${cb.incasatNet("pl", "f")} * al.procent / 100.0),0) AS baza
       FROM (SELECT * FROM plati WHERE activ = 1) pl
       JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
       ${cb.joinRaport("f")}
       JOIN alocari_clienti al ON al.partener_id = f.partener_id
      WHERE f.observatii = ? AND al.utilizator_id = ? AND pl.data BETWEEN '2026-05-01' AND '2026-05-31'`,
    [MARCA, agentId]
  )[0];
  const brut = Number(rez.brut), baza = Number(rez.baza);
  verifica("încasat brut (cu TVA)", brut, f1.total + f2.total + 1210 + 1190);
  verifica("baza de comision (fără TVA)", baza, 1000 + 2000 + 1210 / 1.21 + 1190 / 1.19);
  verifica("comision 2% pe bază", (baza * 2) / 100, ((1000 + 2000 + 1210 / 1.21 + 1190 / 1.19) * 2) / 100);
  if (!(baza < brut)) { picate++; console.log("  PICAT baza trebuie să fie sub încasatul brut"); }
  else console.log(`  ok   baza e sub brut: ${baza.toFixed(2)} < ${brut.toFixed(2)} (economie ${(((brut - baza) * 2) / 100).toFixed(2)} lei la 2%)`);

  // ---- niciun loc din cod nu mai ia comisionul din total cu TVA -----------
  console.log("\nniciun modul nu mai socotește comision din suma cu TVA:");
  const fs = require("fs");
  const rele = [];
  for (const [fisier, tipare] of [
    ["modules/comision.js", [/const castigat = \(incasat \* pct\) \/ 100/]],
    ["modules/crm.js", [/comisionMeu = \(incasatMeu \* pctMeu\)/, /comision: \(Number\(r\.incasat\) \* Number\(r\.pct\)\)/, /comision: \(g\.incasat \* pctMeu\)/]],
    ["modules/rapoarte.js", [/baza = bazaIncasat === "incasat" \? inc :/]],
  ]) {
    const t = fs.readFileSync(path.join(RAD, fisier), "utf8");
    for (const re of tipare) if (re.test(t)) rele.push(`${fisier} → ${re}`);
  }
  if (rele.length) { picate++; console.log("  PICAT au rămas calcule pe brut:\n    " + rele.join("\n    ")); }
  else console.log("  ok   toate cele patru locuri folosesc baza fără TVA");

  // ---- paginile chiar se deschid, cu SQL-ul nou -------------------------
  // SQL-ul se construiește din șabloane; un alias greșit n-ar ieși la iveală
  // decât când se deschide pagina. De-aia chemăm handlerele reale.
  console.log("\npaginile de comision se deschid cu SQL-ul nou:");
  const rute = { get: {}, post: {} };
  const inreg = { get: (c, h) => { if (!rute.get[c]) rute.get[c] = h; }, post: (c, h) => { if (!rute.post[c]) rute.post[c] = h; }, options: () => {} };
  require(path.join(RAD, "modules", "comision.js")).register(inreg);
  require(path.join(RAD, "modules", "rapoarte.js")).register(inreg);
  const res = () => {
    const o = { cod: 0, corp: "" };
    o.writeHead = (c) => { o.cod = c; return o; };
    o.setHeader = () => {};
    o.end = (b) => { o.corp = b || ""; };
    return o;
  };
  const ADMIN = { id: agentId, nume: MARCA + " Agent", rol: "admin", comision_procent: 2 };
  for (const [cale, intrebari] of [["/crm/comision", {}], ["/rapoarte/comisioane", {}]]) {
    const h = rute.get[cale];
    if (!h) { picate++; console.log(`  PICAT ${cale}: ruta nu e înregistrată`); continue; }
    const r = res();
    try {
      await h({ user: ADMIN, params: {}, query: intrebari, body: {}, res: r, req: { headers: {} } });
      if (r.cod === 200 && /TVA/i.test(r.corp)) console.log(`  ok   ${cale} (${r.cod}, pomenește TVA-ul)`);
      else { picate++; console.log(`  PICAT ${cale}: cod ${r.cod}, TVA în pagină: ${/TVA/i.test(r.corp)}`); }
      if (cale === "/crm/comision") {
        const areSectiunea = /Facturile din care iese comisionul lunii/.test(r.corp);
        const areFactura = /TC9005|9005/.test(r.corp);
        const seRupe = /Atenție: lista dă/.test(r.corp);
        if (areSectiunea) console.log("  ok   are secțiunea cu facturile care au adus comisionul");
        else { picate++; console.log("  PICAT lipsește secțiunea cu facturile"); }
        if (areFactura) console.log("  ok   factura încasată luna asta apare în listă");
        else { picate++; console.log("  PICAT factura încasată luna asta nu apare în listă"); }
        if (!seRupe) console.log("  ok   totalul listei se potrivește cu cifra din capul paginii");
        else { picate++; console.log("  PICAT totalul listei nu se potrivește cu capul paginii"); }
        // coloana cu data facturii și căutarea pe nume
        for (const [ce, re] of [
          ["coloana „Data facturii”", /<th[^>]*>Data facturii<\/th>/],
          // layout() trece HTML-ul prin dateleInText, deci pe pagină data apare
          // în format românesc (30.09.2026), nu ISO.
          ["data emiterii apare pe rând", new RegExp(aziTxt.split("-").reverse().join("\\."))],
          ["câmpul de căutare", /id="cautaFactura"/],
          ["contorul de facturi", /id="cateFacturi"/],
          ["valorile pentru resocotire", /data-cv="baza" data-v="/],
          ["scriptul de filtrare", /camp\.addEventListener\("input", filtreaza\)/],
        ]) {
          if (re.test(r.corp)) console.log(`  ok   ${ce}`);
          else { picate++; console.log(`  PICAT lipsește: ${ce}`); }
        }
        // numărăm coloanele DOAR în tabelul listei, nu în toate de pe pagină
        const de = r.corp.indexOf('id="cautaFacturiComision"');
        const bucata = de >= 0 ? r.corp.slice(de, r.corp.indexOf("</thead>", de)) : "";
        const capete = (bucata.match(/<th[ >]/g) || []).length;
        const dt = r.corp.indexOf("<tfoot", de);
        const totaluri = dt >= 0 ? (r.corp.slice(dt, r.corp.indexOf("</tfoot>", dt)).match(/<td[ >]/g) || []).length : 0;
        if (capete !== 8) console.log("    (cap: " + bucata.replace(/\s+/g, " ").slice(0, 260) + ")");
        if (capete === 8) console.log("  ok   tabelul listei are cele 8 coloane așteptate");
        else { picate++; console.log(`  PICAT tabelul listei are ${capete} coloane, așteptam 8`); }
        if (totaluri === 8) console.log("  ok   rândul de total are tot 8 celule");
        else { picate++; console.log(`  PICAT rândul de total are ${totaluri} celule, așteptam 8`); }
      }
    } catch (e) {
      picate++;
      console.log(`  PICAT ${cale} a crăpat: ${String(e.message).split("\n")[0].slice(0, 160)}`);
    }
  }

  curata();
  console.log(picate ? `\n${picate} verificări picate` : "\nTOATE VERZI");
  process.exit(picate ? 1 : 0);
})().catch((e) => { try { curata(); } catch (x) {} console.error("a crăpat:", e.message); process.exit(1); });
