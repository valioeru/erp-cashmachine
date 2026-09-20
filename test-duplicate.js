"use strict";
// Test pentru verificarea de facturi duplicate ȘI pentru butonul care le curăță.
//
// De ce există: verificarea de dinainte compara doar numărul documentului și
// partenerul. Pe datele reale asta dădea alarme false — bonurile fiscale de la
// OMV se numerotează de la capăt în fiecare zi, așa că „Bon fiscal 42" de 35,00
// lei și „Bon fiscal 42" de 523,79 lei ieșeau drept același document. Butonul
// „Scoate exemplarele în plus" lucra pe aceeași grupare largă, deci ar fi
// dezactivat facturi bune.
//
// Regula de acum: se raportează doar exemplarele identice în TOT — același
// număr de document, același partener, aceeași dată de emitere și aceeași sumă
// la bănuț. Butonul folosește exact aceeași interogare ca raportul, deci nu
// poate atinge niciodată altceva decât ce vezi în tabel.
//
// Rulează pe PostgreSQL adevărat, prin psql. Se pornește din rădăcina
// repo-ului, cu baza pe 5433.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});

const lit = (v) =>
  v === null || v === undefined ? "NULL"
    : typeof v === "number" ? String(v)
    : typeof v === "boolean" ? (v ? "TRUE" : "FALSE")
    : "'" + String(v).replace(/'/g, "''") + "'";

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

const ver = require(path.join(RAD, "modules", "verificari.js"));
const rute = { get: {}, post: {} };
ver.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

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
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}

let rele = 0;
function cere(ce, corp, treb = [], interzis = []) {
  const lipsa = treb.filter((t) => !corp.includes(t));
  const gasite = interzis.filter((t) => corp.includes(t));
  if (lipsa.length || gasite.length) {
    rele++;
    console.log("  PROBLEMĂ " + ce +
      (lipsa.length ? ": lipsește „" + lipsa.join("”, „") + "”" : "") +
      (gasite.length ? (lipsa.length ? "; " : ": ") + "apare deși n-ar trebui „" + gasite.join("”, „") + "”" : ""));
  } else console.log("  ok       " + ce);
}
function egal(ce, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) { rele++; console.log("  PROBLEMĂ " + ce + ": am " + a + ", așteptam " + b); }
  else console.log("  ok       " + ce + " = " + b);
}
// Decupează o singură verificare din pagină, ca să nu confundăm un text care
// apare în alt tabel cu unul din tabelul care ne interesează.
function sectiune(corp, cheie) {
  const i = corp.indexOf('<h2 id="' + cheie + '"');
  if (i < 0) return "";
  const j = corp.indexOf('<h2 id="', i + 8);
  return corp.slice(i, j < 0 ? corp.length : j);
}

(async () => {
  console.log("Facturi duplicate — raportul și butonul de curățare\n");

  // --- fixtura -----------------------------------------------------------
  // Se curăță întâi, ca testul să poată fi rulat de câte ori vrei.
  exec1(`DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE serie = 'DUPTEST')`);
  exec1(`DELETE FROM facturi WHERE serie = 'DUPTEST' OR document_extern LIKE 'DUPTEST%'`);
  exec1(`DELETE FROM curatari_duplicate WHERE ids LIKE '%' AND directie = 'vanzare' AND nr_documente = 2 AND suma BETWEEN 2379 AND 2381`);
  exec1(`DELETE FROM parteneri WHERE cui IN ('RO-DUP-C1','RO-DUP-C2','RO-DUP-F')`);

  const client1 = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('CLIENT DUP UNU SRL','RO-DUP-C1','client') RETURNING id`)[0].id);
  const client2 = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('CLIENT DUP DOI SRL','RO-DUP-C2','client') RETURNING id`)[0].id);
  const furnizor = Number(q(`INSERT INTO parteneri (nume, cui, tip) VALUES ('BENZINARIE DUP SRL','RO-DUP-F','furnizor') RETURNING id`)[0].id);
  // utilizatorul care apasă butonul trebuie să existe: curatari_duplicate are
  // cheie străină pe utilizatori.
  const autor = q(`SELECT id FROM utilizatori ORDER BY id LIMIT 1`)[0];
  if (!autor) { console.log("  PROBLEMĂ nu există niciun utilizator în baza de test"); process.exit(1); }
  VALI.id = Number(autor.id);

  // O factură: o linie de 1000 lei cu TVA 19% → 1.190,00 lei cu tot cu TVA.
  function factura({ numar, doc = null, partener, data, pret = 1000, directie = "vanzare" }) {
    const id = Number(q(
      `INSERT INTO facturi (serie, numar, document_extern, partener_id, directie, data_emiterii, data_scadenta, status, activ)
       VALUES ('DUPTEST', ?, ?, ?, ?, ?, ?, 'emisa', 1) RETURNING id`,
      [numar, doc, partener, directie, data, data]
    )[0].id);
    q(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, 'Marfă test', 1, ?, 19)`, [id, pret]);
    return id;
  }

  // (A) trei exemplare identice în tot — ăsta e duplicatul adevărat.
  const a1 = factura({ numar: 42, partener: client1, data: "2026-08-27" });
  const a2 = factura({ numar: 42, partener: client1, data: "2026-08-27" });
  const a3 = factura({ numar: 42, partener: client1, data: "2026-08-27" });
  // (B) același număr și același client, dar alte zile — facturi diferite.
  const b1 = factura({ numar: 43, partener: client1, data: "2026-08-27" });
  const b2 = factura({ numar: 43, partener: client1, data: "2026-09-01" });
  // (C) același număr, același client, aceeași zi, dar alte sume.
  const c1 = factura({ numar: 44, partener: client1, data: "2026-08-27", pret: 1000 });
  const c2 = factura({ numar: 44, partener: client1, data: "2026-08-27", pret: 2500 });
  // (D) totul la fel, dar clienți diferiți.
  const d1 = factura({ numar: 45, partener: client1, data: "2026-08-27" });
  const d2 = factura({ numar: 45, partener: client2, data: "2026-08-27" });
  // (E) cazul OMV: același bon fiscal, același furnizor, aceeași zi, alte sume.
  const e1 = factura({ numar: 901, doc: "DUPTEST Bon fiscal 42", partener: furnizor, data: "2026-08-27", pret: 35, directie: "achizitie" });
  const e2 = factura({ numar: 902, doc: "DUPTEST Bon fiscal 42", partener: furnizor, data: "2026-08-27", pret: 440.16, directie: "achizitie" });
  // (F) o achiziție chiar intrată de două ori.
  const f1 = factura({ numar: 903, doc: "DUPTEST F-DUBLA-1", partener: furnizor, data: "2026-08-27", directie: "achizitie" });
  const f2 = factura({ numar: 904, doc: "DUPTEST F-DUBLA-1", partener: furnizor, data: "2026-08-27", directie: "achizitie" });

  const pastrat = Math.min(a1, a2, a3);
  const inPlus = [a1, a2, a3].filter((x) => x !== pastrat).sort((x, y) => x - y);
  const neatinse = [b1, b2, c1, c2, d1, d2, e1, e2].sort((x, y) => x - y);

  // --- 1. raportul de vânzări --------------------------------------------
  const pag = await cer("/admin/date");
  const sV = sectiune(pag.corp, "vanzari-duplicate");
  cere("raportul de vânzări arată exemplarele identice", sV, ["DUPTEST42", "1.190,00", "se păstrează"], []);
  cere("raportul nu mai dă alarmă pe numerele care se repetă cu alte date/sume", sV,
    [], ["DUPTEST43", "DUPTEST44", "DUPTEST45"]);
  cere("raportul socotește creanțele care nu există (2 × 1.190,00)", sV, ["2.380,00"], []);
  cere("exemplarul care rămâne e cel cu id-ul cel mai mic", sV,
    [`<a href="/facturi/${pastrat}">#${pastrat}</a> <span class="badge verde">se păstrează</span>`], []);

  // --- 2. raportul de achiziții ------------------------------------------
  const sA = sectiune(pag.corp, "achizitii-duplicate");
  cere("bonurile fiscale cu același număr dar alte sume nu mai sunt duplicate", sA, [], ["Bon fiscal 42"]);
  cere("achiziția intrată de două ori tot iese la raport", sA, ["DUPTEST F-DUBLA-1"], []);

  // --- 3. butonul curăță exact ce arată raportul --------------------------
  const inainte = q(`SELECT id, activ FROM facturi WHERE serie = 'DUPTEST' ORDER BY id`);
  egal("toate facturile de test pornesc active", inainte.filter((x) => x.activ !== "1").length, 0);

  const r = await cer("/admin/date/duplicate/curata", { metoda: "post" });
  egal("butonul redirecționează după curățare", r.cod, 302);

  const scoase = q(`SELECT id FROM facturi WHERE serie = 'DUPTEST' AND activ = 0 ORDER BY id`).map((x) => Number(x.id));
  egal("s-au dezactivat exact exemplarele în plus", scoase, inPlus);
  const ramase = q(`SELECT id FROM facturi WHERE serie = 'DUPTEST' AND activ = 1 ORDER BY id`).map((x) => Number(x.id));
  egal("nicio factură bună n-a fost atinsă", ramase, [pastrat, ...neatinse, f1, f2].sort((x, y) => x - y));

  const istoric = q(`SELECT * FROM curatari_duplicate ORDER BY id DESC LIMIT 1`)[0];
  egal("curățarea s-a scris în istoric cu numărul corect", Number(istoric.nr_documente), 2);
  egal("suma scoasă din creanțe e cea din raport", Math.round(Number(istoric.suma) * 100) / 100, 2380);
  egal("id-urile scoase sunt scrise, ca să se poată da înapoi", JSON.parse(istoric.ids).sort((x, y) => x - y), inPlus);
  egal("curățarea e pe vânzări, nu pe achiziții", istoric.directie, "vanzare");

  // --- 4. raportul se golește, dar restul rămâne pe loc -------------------
  const pag2 = await cer("/admin/date");
  cere("după curățare grupul nu mai apare la vânzări", sectiune(pag2.corp, "vanzari-duplicate"), [], ["DUPTEST42"]);
  cere("achiziția dublă a rămas neatinsă de butonul de vânzări", sectiune(pag2.corp, "achizitii-duplicate"), ["DUPTEST F-DUBLA-1"], []);

  // --- 5. anularea pune totul la loc --------------------------------------
  const r2 = await cer("/admin/date/duplicate/:id/anuleaza", { metoda: "post", params: { id: String(istoric.id) } });
  egal("anularea redirecționează", r2.cod, 302);
  const dupaAnulare = q(`SELECT id FROM facturi WHERE serie = 'DUPTEST' AND activ = 0`).map((x) => Number(x.id));
  egal("toate facturile sunt la loc active", dupaAnulare, []);
  const ist2 = q(`SELECT anulata_la FROM curatari_duplicate WHERE id = ?`, [istoric.id])[0];
  egal("istoricul rămâne, marcat ca anulat", !!ist2.anulata_la, true);

  // --- 6. a doua apăsare nu mai are ce curăța ------------------------------
  await cer("/admin/date/duplicate/curata", { metoda: "post" });
  const dupaADoua = q(`SELECT id FROM facturi WHERE serie = 'DUPTEST' AND activ = 0 ORDER BY id`).map((x) => Number(x.id));
  egal("a doua curățare scoate tot exemplarele în plus, nimic altceva", dupaADoua, inPlus);

  // --- curățenie ----------------------------------------------------------
  exec1(`DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE serie = 'DUPTEST')`);
  exec1(`DELETE FROM facturi WHERE serie = 'DUPTEST'`);
  exec1(`DELETE FROM curatari_duplicate WHERE directie = 'vanzare' AND suma BETWEEN 2379 AND 2381`);
  exec1(`DELETE FROM parteneri WHERE cui IN ('RO-DUP-C1','RO-DUP-C2','RO-DUP-F')`);

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
