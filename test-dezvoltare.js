"use strict";
// Test pentru modulul de cereri de dezvoltare, pe PostgreSQL real (vezi
// comentariul din test-depozit.js pentru de ce prin psql și nu prin `pg`).
// Se rulează din rădăcina repo-ului, cu baza pornită pe 127.0.0.1:5433.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n→ " + (e.stderr || e.message)); }
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

const auth = require(path.join(RAD, "lib", "auth.js"));
const mod = require(path.join(RAD, "modules", "dezvoltare.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const MIHAI = { id: 2, nume: "Mihai Mosneanu", rol: "productie" };

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";

let rele = 0;
function ok(eticheta) { console.log("  ok       " + eticheta); }
function rau(eticheta, de) { console.log("  PROBLEMĂ " + eticheta + (de ? ": " + de : "")); rele++; }
function cere(eticheta, corp, bucati) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  const lipsa = bucati.filter((b) => !fara.includes(b));
  if (/NaN|undefined<|>undefined/.test(fara)) return rau(eticheta, "NaN/undefined în pagină");
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  ok(eticheta + " (" + corp.length + " octeți)");
}

(async () => {
  execFileSync("psql", ["-X", "-q", "-c",
    "TRUNCATE cereri_dezvoltare_comentarii, cereri_dezvoltare RESTART IDENTITY CASCADE"], { env: ENV });

  // --- oricine logat poate scrie o cerere --------------------------------
  let r = await cer("/dezvoltare", {
    user: MIHAI, metoda: "post",
    body: { titlu: "La comanda de producție să se treacă și numărul de bax-uri", modul: "Producție", prioritate: "urgenta", descriere: "Acum scriem pe hârtie și se pierde." },
  });
  const id = Number((locatie(r).match(/\/dezvoltare\/(\d+)/) || [])[1]);
  if (!id) rau("Mihai scrie o cerere", "nu s-a creat: " + locatie(r));
  else ok("Mihai (rol productie) scrie o cerere — #" + id);

  const dinBaza = q("SELECT stare, creat_de, prioritate, modul FROM cereri_dezvoltare WHERE id = ?", [id])[0];
  if (!dinBaza || dinBaza.stare !== "noua" || Number(dinBaza.creat_de) !== 2) rau("cererea nu e salvată corect", JSON.stringify(dinBaza));
  else ok("pornește în starea „nouă”, pe numele lui Mihai");

  // --- un neadministrator NU poate aproba --------------------------------
  r = await cer("/dezvoltare/:id/stare", { user: MIHAI, metoda: "post", params: { id }, body: { stare: "aprobata" } });
  const dupaIncercare = q("SELECT stare FROM cereri_dezvoltare WHERE id = ?", [id])[0].stare;
  if (dupaIncercare !== "noua") rau("Mihai și-a aprobat singur cererea", dupaIncercare);
  else if (!locatie(r).includes("eroare=")) rau("refuzul nu i-a spus nimic lui Mihai");
  else ok("refuză aprobarea venită de la un neadministrator");

  // --- Vali aprobă --------------------------------------------------------
  await cer("/dezvoltare/:id/stare", { user: VALI, metoda: "post", params: { id }, body: { stare: "aprobata" } });
  const dupaAprobare = q("SELECT stare, decis_de FROM cereri_dezvoltare WHERE id = ?", [id])[0];
  if (dupaAprobare.stare !== "aprobata" || Number(dupaAprobare.decis_de) !== 1) rau("aprobarea n-a mers", JSON.stringify(dupaAprobare));
  else ok("Vali aprobă — cererea intră în coadă, cu decidentul scris");

  // --- coada o vede -------------------------------------------------------
  r = await cer("/dezvoltare/coada");
  cere("coada aprobată arată cererea", r.corp, ["Coada aprobată", "#" + id, "bax-uri", "urgentă"]);

  // --- comentariu de la oricine ------------------------------------------
  await cer("/dezvoltare/:id/comentariu", { user: MIHAI, metoda: "post", params: { id }, body: { text: "Bax = cutia de 12 bucăți." } });
  r = await cer("/dezvoltare/:id", { params: { id } });
  cere("pagina cererii, cu discuția", r.corp, ["Bax = cutia de 12", "Mihai Mosneanu", "Decizia ta", "Marchează livrată"]);

  // --- Mihai nu vede butoanele de decizie --------------------------------
  r = await cer("/dezvoltare/:id", { user: MIHAI, params: { id } });
  if (r.corp.includes("Decizia ta")) rau("Mihai vede butoanele de aprobare");
  else if (!r.corp.includes("Bax = cutia de 12")) rau("Mihai nu vede discuția");
  else ok("Mihai vede cererea și discuția, dar nu butoanele de decizie");

  // --- respingere cu motiv ------------------------------------------------
  const r2 = await cer("/dezvoltare", { user: MIHAI, metoda: "post", body: { titlu: "Altă idee", modul: "Depozit" } });
  const id2 = Number((locatie(r2).match(/\/dezvoltare\/(\d+)/) || [])[1]);
  await cer("/dezvoltare/:id/stare", { user: VALI, metoda: "post", params: { id: id2 }, body: { stare: "respinsa", motiv: "Se rezolvă din raportul existent." } });
  const resp = q("SELECT stare, motiv FROM cereri_dezvoltare WHERE id = ?", [id2])[0];
  if (resp.stare !== "respinsa" || !String(resp.motiv).includes("raportul existent")) rau("respingerea n-a păstrat motivul", JSON.stringify(resp));
  else ok("respingerea păstrează motivul, ca omul să știe de ce");

  // --- lista, cu filtre ---------------------------------------------------
  r = await cer("/dezvoltare");
  cere("lista tuturor cererilor", r.corp, ["Cereri de dezvoltare", "bax-uri", "Altă idee", "aprobată", "respinsă"]);
  r = await cer("/dezvoltare", { query: { stare: "respinsa" } });
  // Atenție: „bax-uri" apare și în placeholder-ul formularului de cerere nouă,
  // deci filtrul se verifică pe linkul rândului, nu pe text.
  if (r.corp.includes("/dezvoltare/" + id + "\"")) rau("filtrul pe stare nu filtrează");
  else if (!r.corp.includes("/dezvoltare/" + id2)) rau("filtrul a ascuns și cererea respinsă");
  else ok("filtrul pe stare merge");

  // --- livrare ------------------------------------------------------------
  await cer("/dezvoltare/:id/stare", { user: VALI, metoda: "post", params: { id }, body: { stare: "livrata" } });
  const liv = q("SELECT stare, livrat_la FROM cereri_dezvoltare WHERE id = ?", [id])[0];
  if (liv.stare !== "livrata" || !liv.livrat_la) rau("livrarea n-a scris data", JSON.stringify(liv));
  else ok("livrarea scrie data, ca Mihai să vadă singur că s-a făcut");

  // --- accesul e deschis tuturor -----------------------------------------
  if (!auth.poateAccesa(MIHAI, "/dezvoltare") || !auth.poateAccesa({ rol: "depozit" }, "/dezvoltare/3")) {
    rau("pagina nu e accesibilă tuturor rolurilor");
  } else ok("orice rol logat ajunge la /dezvoltare");

  console.log(rele ? "\n" + rele + " probleme." : "\nTotul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
