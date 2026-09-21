"use strict";
// Test pentru comanda nouă: clientul e obligatoriu, și ce a scris omul se
// întoarce cu el când salvarea e oprită.
//
// DE CE: lista de clienți n-avea rând gol, deci PRIMUL client din alfabet era
// ales din start. Un agent care uita să aleagă nu primea nicio eroare —
// comanda pleca, corectă în toate privințele în afară de firma pe care era
// trecută. Iar fără client de tot, inserarea crăpa cu 500 (partener_id e NOT
// NULL în bază), adică omul pierdea tot ce tastase.
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

// Emailul de anunț nu pleacă nicăieri în test.
const mail = require(path.join(RAD, "lib", "mail.js"));
mail.trimite = async () => {};
mail.trimiteDeLa = async () => {};

const mod = require(path.join(RAD, "modules", "comenzi.js"));
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
const GABI = { id: 3, nume: "Gabriela", rol: "vanzari" };

async function cer(cale, { user = GABI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const cateComenzi = () => Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id BETWEEN 96301 AND 96399")[0].n);

(async () => {
  for (const s of [
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 96301 AND 96399)",
    "DELETE FROM comenzi WHERE partener_id BETWEEN 96301 AND 96399",
    "DELETE FROM produse WHERE id BETWEEN 96401 AND 96499",
    "DELETE FROM parteneri WHERE id BETWEEN 96301 AND 96399",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (3,'Gabriela','gabi@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    // Doi clienți: „AAA" ar fi fost ales din start de lista fără rând gol.
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES
       (96301,'AAA PRIMUL DIN ALFABET SRL','RO-CN-1','client'),
       (96302,'ZZZ CLIENTUL ADEVARAT SRL','RO-CN-2','client')`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES (96401,'CN-1','Folie stretch de test','buc',10)",
  ]) exec(s);

  // --- formularul începe cu rândul gol ---------------------------------------
  let r = await cer("/comenzi/nou");
  if (!r.corp.includes("— alege clientul —")) rau("lista de clienți n-are rând gol — primul din alfabet e ales din start");
  else ok("lista de clienți începe cu „— alege clientul —”");
  const inainteaLui = r.corp.indexOf("— alege clientul —");
  const primul = r.corp.indexOf("AAA PRIMUL DIN ALFABET SRL");
  if (!(inainteaLui >= 0 && primul > inainteaLui)) rau("rândul gol nu e primul în listă");
  else ok("rândul gol e chiar primul, deci el e cel ales din start");

  // --- fără client nu se salvează --------------------------------------------
  r = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: "", numar: "CMD-1", observatii: "livrare la poartă",
            "produs_id[]": ["96401"], "cantitate[]": ["5"], "pret_unitar[]": ["12"] },
  });
  egal("fără client nu se salvează nimic", cateComenzi(), 0);
  if (!r.corp.includes("Alege clientul")) rau("nu spune de ce n-a mers", String(r.cod));
  else ok("spune limpede că trebuie ales clientul");
  if (/NaN|undefined</.test(r.corp.replace(/<script[\s\S]*?<\/script>/g, ""))) rau("NaN/undefined în pagină");

  // ce a scris omul se întoarce cu el
  for (const bucata of ["CMD-1", "livrare la poartă", 'value="5"', 'value="12"']) {
    if (!r.corp.includes(bucata)) rau("s-a pierdut ce tastase omul", bucata);
  }
  ok("numărul, observațiile și liniile se întorc cu formularul");

  // --- un client care nu există ----------------------------------------------
  r = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: "999999", "produs_id[]": ["96401"], "cantitate[]": ["5"], "pret_unitar[]": ["12"] },
  });
  egal("un client inexistent nu trece", cateComenzi(), 0);
  if (!r.corp.includes("nu mai există")) rau("nu spune că firma aleasă nu există");
  else ok("un client șters între timp e prins înainte de salvare");

  // --- fără nicio linie cu cantitate ------------------------------------------
  r = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: "96302", "produs_id[]": ["96401"], "cantitate[]": ["0"], "pret_unitar[]": ["12"] },
  });
  egal("o comandă goală nu se salvează", cateComenzi(), 0);
  if (!r.corp.includes("cel puțin o linie")) rau("nu spune că lipsesc liniile");
  else ok("o comandă fără nicio cantitate e oprită");

  // --- comanda bună trece ------------------------------------------------------
  r = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: "96302", numar: "CMD-2",
            "produs_id[]": ["96401"], "cantitate[]": ["5"], "pret_unitar[]": ["12"] },
  });
  egal("comanda bună se salvează", cateComenzi(), 1);
  egal("pe clientul ales, nu pe primul din alfabet",
    q("SELECT p.nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.partener_id BETWEEN 96301 AND 96399").map((x) => x.nume),
    ["ZZZ CLIENTUL ADEVARAT SRL"]);
  if (!/^\/comenzi\/\d+$/.test(locatie(r))) rau("nu duce la comanda salvată", locatie(r));
  else ok("duce la comanda salvată — " + locatie(r));
  egal("linia cu cantitate a intrat",
    q("SELECT cantitate FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 96302)").map((x) => Number(x.cantitate)),
    [5]);

  // --- curățenie după noi --------------------------------------------------
  for (const s of [
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 96301 AND 96399)",
    "DELETE FROM interactiuni WHERE partener_id BETWEEN 96301 AND 96399",
    "DELETE FROM emailuri WHERE partener_id BETWEEN 96301 AND 96399",
    "DELETE FROM comenzi WHERE partener_id BETWEEN 96301 AND 96399",
    "DELETE FROM produse WHERE id BETWEEN 96401 AND 96499",
    "DELETE FROM parteneri WHERE id BETWEEN 96301 AND 96399",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
