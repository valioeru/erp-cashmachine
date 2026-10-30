"use strict";
// Lista de comenzi: data cerută de client și data confirmată de producție.
// Pe PostgreSQL real (prin psql).
//
// CEREREA LUI VALI, 30.10.2026: „În comenzi, la agenții de vânzări, să fie și
// coloana cu data solicitată, data confirmată din producție."
//
// CE APĂRĂ:
//
//   • DATA CONFIRMATĂ E CEA DE AZI A PRODUCȚIEI. Se ia din comanda de
//     producție legată (data de livrare, pe care producția o mută când se
//     reprogramează), nu din ziua confirmării. Doar dacă nu există încă o
//     comandă de producție se ia termenul confirmat de pe cerere.
//
//   • CU MAI MULTE COMENZI DE PRODUCȚIE, CEA MAI TÂRZIE. Comanda clientului e
//     gata când e gata ultima bucată; cea mai devreme ar promite o zi falsă.
//
//   • O COMANDĂ DE PRODUCȚIE ANULATĂ NU MAI DĂ NICIO DATĂ.
//
//   • DUPĂ DATA CERUTĂ DE CLIENT → ROȘU. Agentul trebuie s-o afle înaintea
//     clientului.
//
//   • CE N-ARE ÎNCĂ DATĂ SPUNE DE CE: „așteaptă producția", „refuzată de
//     producție", „în producție, fără dată" — nu o liniuță care le amestecă.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
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
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});
const mail = require(path.join(RAD, "lib", "mail.js"));
mail.trimite = async () => {};
mail.trimiteDeLa = async () => {};

const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "comenzi.js")).register({
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
const AGENT = { id: 96711, nume: "Agent Test", rol: "vanzari" };
async function lista() {
  const r = res();
  await rute.get["/comenzi"]({ user: AGENT, params: {}, query: {}, body: {}, res: r, req: { url: "/comenzi" } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const text = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const PFX = "TSTDP-";
function curata() {
  q(`DELETE FROM aprovizionari WHERE comanda_id IN (SELECT id FROM comenzi WHERE numar LIKE '${PFX}%')`);
  q(`DELETE FROM comenzi_productie WHERE numar LIKE '${PFX}%'`);
  q(`DELETE FROM comenzi WHERE numar LIKE '${PFX}%'`);
  q(`DELETE FROM produse WHERE cod = '${PFX}PROD'`);
  q(`DELETE FROM parteneri WHERE nume = '${PFX}Client'`);
}

(async () => {
  curata();
  const client = Number(unul(`INSERT INTO parteneri (nume, tip) VALUES ('${PFX}Client', 'client') RETURNING id`));
  const produs = Number(unul(`INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('${PFX}PROD', 'Produs test date', 'buc') RETURNING id`));
  const comanda = (n, ceruta) =>
    Number(unul(`INSERT INTO comenzi (partener_id, numar, status, data_livrare_ceruta) VALUES (${client}, '${PFX}${n}', 'noua', ${lit(ceruta)}) RETURNING id`));
  const productie = (cid, n, livrare, propusa, status) =>
    q(`INSERT INTO comenzi_productie (numar, tip_produs, cantitate, status, comanda_id, data_livrare, data_propusa)
       VALUES ('${PFX}P${n}', 'Test', '1', ${lit(status || "noua")}, ${cid}, ${lit(livrare)}, ${lit(propusa)})`);
  const cerere = (cid, status, cerut, confirmat) =>
    q(`INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, status, termen_cerut, termen_confirmat)
       VALUES (${cid}, ${produs}, 10, 'productie', ${lit(status)}, ${lit(cerut)}, ${lit(confirmat)})`);

  const A = comanda("A", "2026-11-10"); productie(A, "A", "2026-11-08", null);
  const B = comanda("B", "2026-11-05"); productie(B, "B1", "2026-11-04", null); productie(B, "B2", "2026-11-12", null);
  const C = comanda("C", "2026-11-20"); cerere(C, "ceruta", "2026-11-18", null);
  const D = comanda("D", null); cerere(D, "confirmata", "2026-11-14", "2026-11-15");
  const E = comanda("E", "2026-11-09"); cerere(E, "refuzata", "2026-11-09", null);
  const F = comanda("F", "2026-11-03"); productie(F, "F", "2026-12-01", null, "anulata");
  const G = comanda("G", "2026-11-07"); productie(G, "G", null, null);
  const H = comanda("H", "2026-11-30"); productie(H, "H", null, "2026-11-21"); cerere(H, "ceruta", "2026-11-25", null);
  const I = comanda("I", "2026-11-11"); cerere(I, "confirmata", "2026-11-11", "2026-11-11"); productie(I, "I", "2026-11-19", null);

  const r = await lista();
  bine("lista se randează", r.cod === 200 && r.corp.length > 1000, r.cod);
  const cap = (r.corp.match(/<thead>[\s\S]*?<\/thead>/) || [""])[0];
  bine("coloana „Data solicitată” e în cap", text(cap).includes("Data solicitată"));
  bine("coloana „Confirmată de producție” e în cap", text(cap).includes("Confirmată de producție"));
  bine("ordinea: Data, Data solicitată, Confirmată de producție, Status", /Data Data solicitată Confirmată de producție Status/.test(text(cap)), text(cap));

  const rand = (n) => {
    const tr = (r.corp.match(/<tr>[\s\S]*?<\/tr>/g) || []).find((x) => x.includes(`>${PFX}${n}<`));
    if (!tr) return null;
    return (tr.match(/<td>[\s\S]*?<\/td>/g) || []).map((td) => td.replace(/^<td>|<\/td>$/g, ""));
  };
  const celule = (n) => { const x = rand(n); return x ? { ceruta: x[3], confirmata: x[4], cerutaT: text(x[3]), confirmataT: text(x[4]) } : null; };

  const a = celule("A");
  bine("A: data solicitată 10.11.2026", a && a.cerutaT === "10.11.2026", a && a.cerutaT);
  bine("A: confirmată 08.11.2026, din comanda de producție", a && a.confirmataT === "08.11.2026", a && a.confirmataT);
  bine("A: înainte de data cerută → nu e roșie", a && !a.confirmata.includes("badge rosu"));

  const b = celule("B");
  bine("B: din două comenzi de producție, cea mai târzie: 12.11.2026", b && b.confirmataT.startsWith("12.11.2026"), b && b.confirmataT);
  bine("B: după data cerută (05.11) → roșie", b && b.confirmata.includes("badge rosu"));
  bine("B: spune că e cea mai târzie din 2", b && b.confirmataT.includes("cea mai târzie din 2 comenzi de producție"));
  bine("B: titlul spune data cerută, în format românesc", b && b.confirmata.includes("(05.11.2026)"));

  const c = celule("C");
  bine("C: cererea așteaptă răspuns → „așteaptă producția”", c && c.confirmataT === "așteaptă producția", c && c.confirmataT);
  const d = celule("D");
  bine("D: fără comandă de producție → termenul confirmat pe cerere, 15.11.2026", d && d.confirmataT === "15.11.2026", d && d.confirmataT);
  bine("D: fără dată cerută → liniuță la solicitată, și nu e roșie", d && d.cerutaT === "—" && !d.confirmata.includes("badge rosu"));
  const e = celule("E");
  bine("E: cerere refuzată → „refuzată de producție”", e && e.confirmataT === "refuzată de producție", e && e.confirmataT);
  const f = celule("F");
  bine("F: comanda de producție anulată nu dă nicio dată", f && f.confirmataT === "—", f && f.confirmataT);
  const g = celule("G");
  bine("G: în producție, dar fără dată", g && g.confirmataT === "în producție, fără dată", g && g.confirmataT);
  const h = celule("H");
  bine("H: fără data de livrare se ia data propusă, 21.11.2026", h && h.confirmataT.startsWith("21.11.2026"), h && h.confirmataT);
  bine("H: și spune că mai e o cerere neconfirmată", h && h.confirmataT.includes("încă o cerere neconfirmată"));
  const i = celule("I");
  bine("I: producția a mutat data (19.11) → contează cea de azi, nu termenul confirmat (11.11)", i && i.confirmataT === "19.11.2026", i && i.confirmataT);
  bine("I: 19.11 e după 11.11 cerut → roșie", i && i.confirmata.includes("badge rosu"));

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
