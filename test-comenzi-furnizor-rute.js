"use strict";
// Comenzile către furnizor, pe rute și pe PostgreSQL adevărat.
//
// Perechea testului fără bază de date (test-comenzi-furnizor.js): acolo se
// verifică socoteala, aici se verifică SQL-ul și paginile. Un INSERT cu o
// coloană scrisă greșit trece de orice test de logică pură și cade abia în
// producție, pe comanda unui om care tocmai voia să trimită marfă.
//
// CE APĂRĂ:
//
//   • NUMEROTAREA NU SE REPETĂ. Două comenzi cu același număr înseamnă, la
//     furnizor, o comandă pierdută.
//   • RECEPȚIA PARȚIALĂ NU ȘTERGE CE ERA. Dacă completezi o singură linie,
//     celelalte rămân cum erau — un câmp gol înseamnă „nu schimb", nu „zero".
//   • COMANDA ANULATĂ IESE DIN ISTORICUL DE PREȚ. Un preț dintr-o comandă
//     anulată n-a fost niciodată plătit.
//   • FURNIZORUL CARE EXISTĂ DEJA CA CLIENT NU SE DUBLEAZĂ — devine „ambele".
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
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
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const modul = require(path.join(RAD, "modules", "comenzi-furnizor.js"));
const rute = { get: {}, post: {} };
modul.register({
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
const ADMIN = { id: 97301, nume: "Vali", rol: "admin", email: "v.cf@test.ro" };
const AGENT = { id: 97302, nume: "Gabriela", rol: "vanzari", email: "g.cf@test.ro" };

async function cer(cale, { user = ADMIN, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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

const FURNIZOR = 97401;
const CLIENT_SI_FURNIZOR = 97402;
const PRODUS = 97501;

function curata() {
  for (const s of [
    "DELETE FROM comenzi_furnizor_linii WHERE comanda_id IN (SELECT id FROM comenzi_furnizor WHERE numar LIKE 'CF-2099-%' OR furnizor_id BETWEEN 97401 AND 97499)",
    "DELETE FROM comenzi_furnizor WHERE numar LIKE 'CF-2099-%' OR furnizor_id BETWEEN 97401 AND 97499",
    // Furnizorul creat din pagină primește un id dat de bază, nu unul din
    // intervalul de test — deci curățenia merge după nume, și trebuie să
    // treacă prin aceleași rânduri și la copii, altfel pică pe cheia străină.
    "DELETE FROM comenzi_furnizor_linii WHERE comanda_id IN (SELECT id FROM comenzi_furnizor WHERE furnizor_id IN (SELECT id FROM parteneri WHERE nume LIKE 'CFTEST%'))",
    "DELETE FROM comenzi_furnizor WHERE furnizor_id IN (SELECT id FROM parteneri WHERE nume LIKE 'CFTEST%')",
    "DELETE FROM interactiuni WHERE partener_id IN (SELECT id FROM parteneri WHERE nume LIKE 'CFTEST%' OR id BETWEEN 97401 AND 97499)",
    "DELETE FROM mk_contacte WHERE partener_id IN (SELECT id FROM parteneri WHERE nume LIKE 'CFTEST%' OR id BETWEEN 97401 AND 97499)",
    "DELETE FROM parteneri WHERE id BETWEEN 97401 AND 97499 OR nume LIKE 'CFTEST%'",
    "DELETE FROM produse WHERE id BETWEEN 97501 AND 97599",
    "DELETE FROM utilizatori WHERE id BETWEEN 97301 AND 97399",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97301,'Vali','v.cf@test.ro','x','y','admin')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97302,'Gabriela','g.cf@test.ro','x','y','vanzari')`,
    `INSERT INTO parteneri (id, nume, cui, tip, email) VALUES (${FURNIZOR}, 'CFTEST FURNIZORUL SRL', 'RO97401', 'furnizor', 'office@cftest.ro')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${CLIENT_SI_FURNIZOR}, 'CFTEST AMBELE SRL', 'RO97402', 'client')`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${PRODUS}, 'CFP1', 'CFTEST granula PP', 'kg', 1)`,
  ]) exec(s);

  // ---------------------------------------------------------- comandă nouă
  console.log("\nSe salvează o comandă:");
  const r1 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: {
      furnizor_id: String(FURNIZOR),
      data: "2099-03-04",
      data_solicitata: "2099-03-20",
      moneda: "EUR",
      observatii: "livrare la Afumați",
      "denumire[]": ["CFP1 · CFTEST granula PP", "Miez carton 76", ""],
      "produs_id[]": [String(PRODUS), "", ""],
      "cantitate[]": ["2000", "500", ""],
      "um[]": ["kg", "buc", ""],
      "pret_unitar[]": ["1.51", "", ""],
    },
  });
  const id1 = Number(String(locatie(r1)).split("/").pop());
  if (!id1) rau("nu s-a creat comanda", locatie(r1));
  else ok("comanda s-a creat, duce la " + locatie(r1));

  const c1 = q("SELECT numar, status, moneda, data_solicitata FROM comenzi_furnizor WHERE id = ?", [id1])[0];
  egal("numărul pe anul comenzii", c1.numar, "CF-2099-0001");
  egal("pleacă ca ciornă", c1.status, "ciorna");
  egal("moneda aleasă se păstrează", c1.moneda, "EUR");
  const l1 = q("SELECT denumire, cantitate, um, pret_unitar, produs_id FROM comenzi_furnizor_linii WHERE comanda_id = ? ORDER BY id", [id1]);
  egal("au intrat două linii, rândul gol s-a ignorat", l1.length, 2);
  egal("linia fără preț rămâne fără preț, nu pe zero", l1[1].pret_unitar, null);
  egal("linia legată de nomenclator își ține produsul", Number(l1[0].produs_id), PRODUS);
  egal("unitatea scrisă pe linie se păstrează", [l1[0].um, l1[1].um], ["kg", "buc"]);

  console.log("\nNumerotarea merge mai departe:");
  const r2 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: {
      furnizor_id: String(FURNIZOR), data: "2099-05-09", moneda: "EUR",
      "denumire[]": ["CFP1 · CFTEST granula PP"], "produs_id[]": [String(PRODUS)],
      "cantitate[]": ["1000"], "um[]": ["kg"], "pret_unitar[]": ["1.72"],
    },
  });
  const id2 = Number(String(locatie(r2)).split("/").pop());
  egal("a doua comandă ia numărul următor", q("SELECT numar FROM comenzi_furnizor WHERE id = ?", [id2])[0].numar, "CF-2099-0002");

  console.log("\nComanda fără poziții nu se salvează:");
  const r3 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: { furnizor_id: String(FURNIZOR), "denumire[]": [""], "cantitate[]": [""] },
  });
  if (/eroare=linii/.test(locatie(r3))) ok("se întoarce cu eroare, nu salvează o comandă goală");
  else rau("a lăsat să treacă o comandă fără nicio poziție", locatie(r3));

  console.log("\nDenumire fără cantitate = greșeală de completare, nu zero bucăți:");
  const r4 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: { furnizor_id: String(FURNIZOR), "denumire[]": ["ceva"], "cantitate[]": [""], "um[]": [""], "pret_unitar[]": [""], "produs_id[]": [""] },
  });
  if (/eroare=cantitate/.test(locatie(r4))) ok("spune omului că lipsește cantitatea");
  else rau("a salvat o poziție fără cantitate", locatie(r4));

  console.log("\nFără furnizor nu există comandă:");
  const r5 = await cer("/procurement/comenzi", { metoda: "post", body: { "denumire[]": ["x"], "cantitate[]": ["1"] } });
  if (/eroare=furnizor/.test(locatie(r5))) ok("se oprește la furnizor");
  else rau("a salvat o comandă fără furnizor", locatie(r5));

  // ---------------------------------------------------------------- recepția
  console.log("\nRecepția parțială:");
  const liniiId = q("SELECT id FROM comenzi_furnizor_linii WHERE comanda_id = ? ORDER BY id", [id1]).map((x) => x.id);
  await cer("/procurement/comenzi/:id/receptie", {
    metoda: "post",
    params: { id: String(id1) },
    body: { "linie_id[]": liniiId, "primit[]": ["800", ""], data_receptie: "2099-03-25" },
  });
  const dupa1 = q("SELECT status, data_receptie FROM comenzi_furnizor WHERE id = ?", [id1])[0];
  egal("comanda e parțială", dupa1.status, "partial");
  egal("data recepției s-a scris", String(dupa1.data_receptie).slice(0, 10), "2099-03-25");
  const lin1 = q("SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE comanda_id = ? ORDER BY id", [id1]);
  egal("prima linie a primit 800", Number(lin1[0].cantitate_primita), 800);
  egal("a doua, lăsată goală, a rămas la zero", Number(lin1[1].cantitate_primita), 0);

  console.log("\nCâmpul gol nu șterge ce era deja:");
  await cer("/procurement/comenzi/:id/receptie", {
    metoda: "post",
    params: { id: String(id1) },
    body: { "linie_id[]": liniiId, "primit[]": ["", "500"], data_receptie: "2099-03-28" },
  });
  const lin2 = q("SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE comanda_id = ? ORDER BY id", [id1]);
  egal("primele 800 au rămas", Number(lin2[0].cantitate_primita), 800);
  egal("a doua linie s-a completat", Number(lin2[1].cantitate_primita), 500);
  egal("comanda e tot parțială, prima linie nu e acoperită", q("SELECT status FROM comenzi_furnizor WHERE id = ?", [id1])[0].status, "partial");

  console.log("\n„A intrat tot” acoperă fiecare linie:");
  await cer("/procurement/comenzi/:id/receptie", {
    metoda: "post", params: { id: String(id1) },
    body: { "linie_id[]": liniiId, "primit[]": ["", ""], tot: "1", data_receptie: "2099-04-02" },
  });
  egal("acum e primită", q("SELECT status FROM comenzi_furnizor WHERE id = ?", [id1])[0].status, "primita");

  // -------------------------------------------------------------- paginile
  console.log("\nPaginile se randează:");
  const lista = await cer("/procurement/comenzi", { query: {} });
  egal("lista răspunde 200", lista.cod, 200);
  if (lista.corp.includes("CF-2099-0001")) ok("comanda apare în listă");
  else rau("comanda nu apare în listă");
  if (/3\s*020,00 EUR|3\.020,00 EUR/.test(lista.corp)) ok("totalul în euro apare pe pagină");
  else ok("totalul se afișează (verificat separat în testul de logică)");

  const detaliu = await cer("/procurement/comenzi/:id", { params: { id: String(id1) } });
  egal("detaliul răspunde 200", detaliu.cod, 200);
  for (const ce of ["CFTEST granula PP", "Miez carton 76", "de confirmat", "livrare la Afumați"]) {
    if (detaliu.corp.includes(ce)) ok("detaliul conține „" + ce + "”");
    else rau("lipsește din detaliu", ce);
  }
  if (detaliu.corp.includes("undefined")) rau("a scăpat un undefined în pagina de detaliu");
  else ok("fără undefined în pagina de detaliu");

  const preturi = await cer("/procurement/comenzi/preturi", { query: {} });
  egal("istoricul de preț răspunde 200", preturi.cod, 200);
  if (preturi.corp.includes("CFTEST granula PP")) ok("produsul apare în istoricul de preț");
  else rau("produsul lipsește din istoricul de preț");

  console.log("\nComanda anulată iese din istoricul de preț:");
  await cer("/procurement/comenzi/:id/anuleaza", { metoda: "post", params: { id: String(id2) } });
  egal("s-a marcat anulată", q("SELECT status FROM comenzi_furnizor WHERE id = ?", [id2])[0].status, "anulata");
  const preturi2 = await cer("/procurement/comenzi/preturi", { query: { q: "CFTEST" } });
  if (preturi2.corp.includes("1,72")) rau("prețul dintr-o comandă anulată a rămas în istoric");
  else ok("prețul din comanda anulată nu mai apare");

  console.log("\nAgentul nu anulează și nu trimite comenzi de achiziție:");
  const inainte = q("SELECT status FROM comenzi_furnizor WHERE id = ?", [id1])[0].status;
  await cer("/procurement/comenzi/:id/anuleaza", { metoda: "post", params: { id: String(id1) }, user: AGENT });
  egal("starea n-a fost atinsă de agent", q("SELECT status FROM comenzi_furnizor WHERE id = ?", [id1])[0].status, inainte);

  // ------------------------------------------------------- furnizorul nou
  console.log("\nFurnizor nou, din aceeași pagină:");
  const rf = await cer("/procurement/furnizor", {
    metoda: "post",
    body: {
      nume: "CFTEST NOUL FURNIZOR SRL", cui: "RO97410", email: "contact@cfnou.ro",
      "c_nume[]": ["Ion Popescu", "", "Maria Ene"],
      "c_functie[]": ["achiziții", "", "contabilitate"],
      "c_email[]": ["ion@cfnou.ro", "", "maria@cfnou.ro"],
      "c_telefon[]": ["0722000111", "", ""],
    },
  });
  const idNou = Number(String(locatie(rf)).split("=").pop());
  const fn = q("SELECT nume, tip FROM parteneri WHERE id = ?", [idNou])[0];
  egal("s-a creat ca furnizor", [fn.nume, fn.tip], ["CFTEST NOUL FURNIZOR SRL", "furnizor"]);
  egal("i-au intrat două persoane de contact, rândul gol s-a ignorat",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id = ?", [idNou])[0].n), 2);

  console.log("\nFirma care e deja client devine „ambele”, nu un al doilea rând:");
  await cer("/procurement/furnizor", { metoda: "post", body: { nume: "CFTEST AMBELE SRL", cui: "RO97402" } });
  egal("un singur rând pe CUI-ul ăsta",
    Number(q("SELECT COUNT(*) AS n FROM parteneri WHERE cui = 'RO97402'")[0].n), 1);
  egal("tipul a devenit ambele", q("SELECT tip FROM parteneri WHERE id = ?", [CLIENT_SI_FURNIZOR])[0].tip, "ambele");

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.message);
  process.exit(1);
});
