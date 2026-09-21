"use strict";
// Test pentru orizontul prognozei de vânzări.
//
// DE CE: până acum filtrul avea o singură formă — „următoarele N luni",
// pornind mereu din luna curentă. Asta răspunde la „cum merge trimestrul",
// dar nu la întrebarea pe care o pune oricine în septembrie: „cu ce închei
// anul". Vali a cerut standard „până la final de an în curs" și un interval
// la alegere mereu la vedere.
//
// Ce apără testul, în ordinea în care doare dacă se strică:
//   • o LUNĂ ÎNCHEIATĂ nu se prognozează. Dacă ar fi prezisă, totalul „anul
//     întreg" ar fi o ficțiune pusă peste o realitate cunoscută — și ar arăta
//     credibil, ceea ce e mai rău;
//   • luna încheiată n-are bandă pesimist/optimist: cifra e cunoscută;
//   • intervalul la alegere ia lunile scrise, inclusiv când sunt date invers;
//   • linkurile vechi (?luni=6) nu se rup.
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

const mod = require(path.join(RAD, "modules", "rapoarte.js"));
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
async function cer(query) {
  const h = rute.get["/rapoarte/forecast"];
  if (!h) throw new Error("ruta lipsește: GET /rapoarte/forecast");
  const r = res();
  await h({ user: VALI, params: {}, query: query || {}, body: {}, res: r, req: { url: "/rapoarte/forecast" } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
// Lunile efectiv desenate pe pagină, în ordine.
const luniDin = (corp) => [...corp.matchAll(/class="chart-label">(\d{4}-\d{2})</g)].map((m) => m[1]);

const AZI = new Date().toISOString().slice(0, 10);
const AN = Number(AZI.slice(0, 4));
const LUNA = Number(AZI.slice(5, 7));
const lunaStr = (n) => `${AN}-${String(n).padStart(2, "0")}`;

(async () => {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id BETWEEN 96701 AND 96799",
    "DELETE FROM facturi WHERE id BETWEEN 96701 AND 96799",
    "DELETE FROM parteneri WHERE cui = 'RO-FC-1'",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (96701,'CLIENT FORECAST SRL','RO-FC-1','client') ON CONFLICT (id) DO NOTHING",
  ]) exec(s);

  // O factură pe fiecare lună încheiată din anul curent, 1.000 lei net fiecare
  // (TVA 19% → 1.190 cu TVA, iar forecastul lucrează cu totalul cu TVA).
  const inchise = [];
  for (let m = 1; m < LUNA; m++) {
    const id = 96700 + m;
    inchise.push(lunaStr(m));
    exec(
      `INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, status, activ, intercompany)
       VALUES (${id},'FC',${id},96701,'vanzare','${lunaStr(m)}-10','emisa',1,0)`
    );
    exec(
      `INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva)
       VALUES (${id},'marfa',1,1000,19)`
    );
  }

  // --- implicit: până la final de an ---------------------------------------
  let r = await cer({});
  if (r.cod !== 200) rau("pagina nu se deschide", String(r.cod));
  const fara = r.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined</.test(fara)) rau("NaN/undefined în pagină");
  const asteptatPanaLaFinal = [];
  for (let m = LUNA; m <= 12; m++) asteptatPanaLaFinal.push(lunaStr(m));
  egal("implicit merge de la luna curentă până în decembrie", luniDin(r.corp), asteptatPanaLaFinal);
  if (!fara.includes('value="an_curent" selected')) rau("opțiunea implicită nu e „până la final de an”");
  else ok("„până la final de an” e opțiunea aleasă din start");
  if (!fara.includes('name="de_la"') || !fara.includes('name="pana_la"'))
    rau("câmpurile de interval nu sunt mereu la vedere");
  else ok("intervalul la alegere e mereu pe pagină, lângă celelalte opțiuni");

  // --- anul întreg: lunile încheiate intră cu cifra reală --------------------
  r = await cer({ orizont: "an_intreg" });
  const toateLunile = [];
  for (let m = 1; m <= 12; m++) toateLunile.push(lunaStr(m));
  egal("anul întreg are toate cele 12 luni", luniDin(r.corp), toateLunile);
  egal("lunile încheiate sunt marcate ca atare",
    (r.corp.match(/badge">încheiată/g) || []).length, LUNA - 1);

  // Cifra reală: fiecare lună încheiată are exact 1.190,00 lei, iar „din care
  // realizat" trebuie să fie suma lor — nu o prognoză peste ele.
  const realizatAsteptat = (LUNA - 1) * 1190;
  const cardRealizat = (r.corp.match(/Din care realizat<\/div><div class="value">([^<]+)</) || [])[1] || "";
  const cifra = Number(String(cardRealizat).replace(/[^\d,]/g, "").replace(/\./g, "").replace(",", "."));
  if (Math.abs(cifra - realizatAsteptat) > 1)
    rau("„din care realizat” nu e suma lunilor încheiate", `am ${cardRealizat}, așteptam ${realizatAsteptat}`);
  else ok("„din care realizat” = suma reală a lunilor încheiate (" + cardRealizat.trim() + ")");

  // O lună încheiată n-are bandă: pesimist și optimist sunt „—".
  const randInchis = (r.corp.match(new RegExp(lunaStr(1) + "[\\s\\S]{0,400}?</tr>")) || [""])[0];
  if (!/>—</.test(randInchis)) rau("o lună încheiată are bandă pesimist/optimist");
  else ok("o lună încheiată n-are bandă — cifra e cunoscută, nu estimată");

  // --- interval la alegere ---------------------------------------------------
  r = await cer({ orizont: "custom", de_la: lunaStr(3), pana_la: lunaStr(5) });
  egal("intervalul la alegere ia exact lunile scrise", luniDin(r.corp), [lunaStr(3), lunaStr(4), lunaStr(5)]);

  r = await cer({ orizont: "custom", de_la: lunaStr(5), pana_la: lunaStr(3) });
  egal("scrise invers, tot intervalul corect iese", luniDin(r.corp), [lunaStr(3), lunaStr(4), lunaStr(5)]);

  r = await cer({ orizont: "custom", de_la: "prostii", pana_la: "" });
  const implicitCustom = luniDin(r.corp);
  if (!implicitCustom.length || implicitCustom[0] !== `${AN}-${String(LUNA).padStart(2, "0")}`)
    rau("un interval scris aiurea nu cade pe implicit", JSON.stringify(implicitCustom));
  else ok("un interval scris aiurea cade pe luna curentă → decembrie");

  // --- linkurile vechi ---------------------------------------------------------
  r = await cer({ luni: "3" });
  egal("un link vechi cu ?luni=3 încă merge", luniDin(r.corp).length, 3);
  egal("și pornește din luna curentă", luniDin(r.corp)[0], lunaStr(LUNA));

  // --- curățenie după noi ------------------------------------------------------
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id BETWEEN 96701 AND 96799",
    "DELETE FROM facturi WHERE id BETWEEN 96701 AND 96799",
    "DELETE FROM parteneri WHERE cui = 'RO-FC-1'",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
