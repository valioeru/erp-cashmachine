"use strict";
// Test pentru legarea contactelor de firma lor, după domeniul din adresă.
//
// Ce apără testul ăsta, în ordinea în care doare dacă se strică:
//   • un contact legat de firma GREȘITĂ trimite oferta aiurea — de-aia
//     domeniul ambiguu și cel public nu se leagă niciodată;
//   • un coleg legat de un client îi bagă emailurile interne în istoricul
//     clientului — de-aia domeniile noastre nu se leagă;
//   • legarea automată nu are voie să ascundă contactele care nu-s oameni:
//     altfel butonul de curățenie n-ar mai avea ce propune;
//   • „desfă" nu are voie să strice munca unui om.
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
// ATENȚIE: shimul înlocuiește fiecare „?" cu un parametru. Un semn de întrebare
// scris în textul unei fixturi ar fi mâncat ca marcaj și ar muta toți
// parametrii cu unul — fără niciun mesaj de eroare. Textele cu „?" se dau ca
// parametru, nu se scriu în SQL.
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

const mod = require(path.join(RAD, "modules", "marketing.js"));
// Routerul adevărat păstrează PRIMA înregistrare a unei căi; unul scris ca
// obiect simplu ar păstra-o pe ultima și testul ar verifica altă pagină.
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
const GABI = { id: 3, nume: "Gabriela", rol: "vanzari" };

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
function cere(eticheta, corp, bucati, interzise) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined<|>undefined/.test(fara)) return rau(eticheta, "NaN/undefined în pagină");
  const lipsa = bucati.filter((b) => !fara.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => fara.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta + " (" + corp.length + " octeți)");
}

(async () => {
  const FIXTURI = [
    "TRUNCATE mk_aniversari, mk_contacte_istoric, mk_contacte RESTART IDENTITY CASCADE",
    "DELETE FROM email_domenii WHERE domeniu LIKE '%test-lg%'",
    "DELETE FROM parteneri WHERE cui LIKE 'RO-LG-%'",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (3,'Gabriela','gabi@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    `INSERT INTO parteneri (id, nume, cui, tip, email) VALUES
       (95201,'AGORA PLAST SRL','RO-LG-1','client',NULL),
       (95202,'ABZAC ROMANIA SRL','RO-LG-2','furnizor','office@abzac.test-lg.com'),
       (95203,'AECTRA PLASTICS SRL','RO-LG-3','client',NULL),
       (95204,'DOI LA FEL A SRL','RO-LG-4','client','a@doilafel.test-lg.ro'),
       (95205,'DOI LA FEL B SRL','RO-LG-5','client','b@doilafel.test-lg.ro')
     ON CONFLICT (id) DO NOTHING`,
    // Harta confirmată de un om la emailuri — cea mai tare dovadă.
    "INSERT INTO email_domenii (domeniu, partener_id, sursa, pus_de) VALUES ('agoraplast.test-lg.ro', 95201, 'om', 1)",
    // Un om deja legat, ca să avem „alt om de la același domeniu".
    `INSERT INTO mk_contacte (partener_id, nume, email, sursa) VALUES
       (95203, 'Vechi Aectra LG', 'vechi@aectra.test-lg.ro', 'manual')`,
    // Cei fără firmă. Ultimul e numele unei firme pus în dreptul persoanei:
    // se leagă (domeniul e confirmat), dar TREBUIE să rămână în curățenie.
    `INSERT INTO mk_contacte (nume, functie, email, firma_text, sursa) VALUES
       ('Ion Logistica LG', 'Logistică', 'logistica@agoraplast.test-lg.ro', NULL, 'semnatura'),
       ('Maria Abzac LG', 'Sales Manager', 'maria@abzac.test-lg.com', NULL, 'semnatura'),
       ('Andrei Aectra LG', NULL, 'andrei@aectra.test-lg.ro', NULL, 'semnatura'),
       ('Nume Scris LG', NULL, 'altcineva-lg@gmail.com', 'AECTRA PLASTICS SRL', 'semnatura'),
       ('Gmail Singur LG', NULL, 'singur-lg@gmail.com', NULL, 'semnatura'),
       ('Colegul Meu LG', NULL, 'coleg-lg@cashmachine.ro', NULL, 'semnatura'),
       ('Ambiguu Om LG', NULL, 'x@doilafel.test-lg.ro', NULL, 'semnatura'),
       ('AGORA PLAST SRL', NULL, 'office@agoraplast.test-lg.ro', NULL, 'semnatura')`,
  ];
  for (const s of FIXTURI) exec(s);

  console.log("rute GET :", Object.keys(rute.get).filter((x) => x.includes("legare")).join(", "));
  console.log("rute POST:", Object.keys(rute.post).filter((x) => x.includes("legare")).join(", "));
  console.log("");

  // --- ce se propune, și pe ce temei ---------------------------------------
  const propuse = await mod.contacteDeLegat();
  const arata = propuse
    .map((c) => c.nume + " → " + c.partener_nume + " (" + c.temei + ")")
    .sort();
  egal("propunerile, cu temeiul fiecăreia", arata, [
    "AGORA PLAST SRL → AGORA PLAST SRL (domeniu)",
    "Andrei Aectra LG → AECTRA PLASTICS SRL (coleg)",
    "Ion Logistica LG → AGORA PLAST SRL (domeniu)",
    "Maria Abzac LG → ABZAC ROMANIA SRL (fisa)",
    "Nume Scris LG → AECTRA PLASTICS SRL (nume)",
  ]);

  const nelegate = ["Gmail Singur LG", "Colegul Meu LG", "Ambiguu Om LG"];
  const propusi = new Set(propuse.map((c) => c.nume));
  for (const n of nelegate) {
    if (propusi.has(n)) rau("s-a propus ceva ce nu trebuia", n);
  }
  if (!nelegate.some((n) => propusi.has(n)))
    ok("gmail, domeniul nostru și domeniul cu două firme rămân nelegate");

  // --- pagina ---------------------------------------------------------------
  let r = await cer("/marketing/contacte/legare");
  cere("pagina arată propunerile cu temeiul lângă fiecare", r.corp,
    ["Contacte fără firmă", "Leagă toate cele 5", "AGORA PLAST SRL", "ABZAC ROMANIA SRL",
     "domeniu confirmat la emailuri", "alt om de la același domeniu", "adresa de pe fișa firmei",
     "numele firmei, scris pe contact"],
    ["Gmail Singur LG", "Colegul Meu LG", "Ambiguu Om LG"]);

  r = await cer("/marketing/contacte/legare", { user: GABI });
  egal("agentul nu vede pagina", locatie(r), "/marketing/contacte");

  // --- nimeni nu leagă fără să apese -----------------------------------------
  await cer("/marketing/contacte/legare/tot", { metoda: "post", body: {} });
  egal("fără confirmare nu se leagă nimeni",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id IS NOT NULL")[0].n), 1);
  await cer("/marketing/contacte/legare/tot", { user: GABI, metoda: "post", body: { da: "1" } });
  egal("nici agentul, chiar cu confirmare",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id IS NOT NULL")[0].n), 1);

  // --- un singur rând --------------------------------------------------------
  const idIon = Number(q("SELECT id FROM mk_contacte WHERE nume = 'Ion Logistica LG'")[0].id);
  await cer("/marketing/contacte/legare/unul", { metoda: "post", body: { id: String(idIon) } });
  egal("butonul de pe rând leagă doar rândul lui",
    q("SELECT p.nume FROM mk_contacte c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?", [idIon]).map((x) => x.nume),
    ["AGORA PLAST SRL"]);
  egal("restul au rămas nelegați",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte WHERE partener_id IS NOT NULL")[0].n), 2);

  // --- legarea în masă -------------------------------------------------------
  await cer("/marketing/contacte/legare/tot", { metoda: "post", body: { da: "1" } });
  egal("fiecare a ajuns la firma lui",
    q(`SELECT c.nume, p.nume AS firma FROM mk_contacte c JOIN parteneri p ON p.id = c.partener_id
        WHERE c.nume LIKE '%LG%' OR c.nume = 'AGORA PLAST SRL' ORDER BY c.nume`)
      .map((x) => x.nume + " → " + x.firma),
    ["AGORA PLAST SRL → AGORA PLAST SRL",
     "Andrei Aectra LG → AECTRA PLASTICS SRL",
     "Ion Logistica LG → AGORA PLAST SRL",
     "Maria Abzac LG → ABZAC ROMANIA SRL",
     "Nume Scris LG → AECTRA PLASTICS SRL",
     "Vechi Aectra LG → AECTRA PLASTICS SRL"]);
  egal("fiecare legare a lăsat urmă în istoric",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte_istoric WHERE camp = 'legat-automat'")[0].n), 5);

  r = await cer("/marketing/contacte/legare");
  cere("a doua oară nu mai e nimic de legat", r.corp, ["Nimic de legat automat", "Desfă cele 5"], ["Leagă toate cele"]);

  // --- legarea nu ascunde contactele care nu-s oameni ------------------------
  // Fix capcana: legarea scrie în istoric, iar curățenia sare peste contactele
  // „atinse". Dacă legarea s-ar pune la socoteală, exact firmele puse în
  // dreptul persoanei ar deveni invizibile.
  const deCuratat = (await mod.contacteDeCuratat()).map((c) => c.nume);
  if (!deCuratat.includes("AGORA PLAST SRL"))
    rau("legarea a ascuns un contact care nu e om", deCuratat.join(", ") || "lista e goală");
  else ok("un contact legat automat rămâne propus la curățenie");

  // --- desfacerea ------------------------------------------------------------
  // Un om mută unul dintre ele după aceea; ăla nu se mai atinge.
  const idAndrei = Number(q("SELECT id FROM mk_contacte WHERE nume = 'Andrei Aectra LG'")[0].id);
  exec("UPDATE mk_contacte SET partener_id = 95201 WHERE id = " + idAndrei);

  await cer("/marketing/contacte/legare/desfa", { user: GABI, metoda: "post" });
  egal("agentul nu poate desface",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte_istoric WHERE camp = 'legat-automat-desfacut'")[0].n), 0);

  r = await cer("/marketing/contacte/legare/desfa", { metoda: "post" });
  egal("desface doar ce n-a mutat nimeni între timp", locatie(r), "/marketing/contacte/legare?desfacute=4");
  egal("cel mutat de om a rămas cum l-a pus el",
    q("SELECT p.nume FROM mk_contacte c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?", [idAndrei]).map((x) => x.nume),
    ["AGORA PLAST SRL"]);
  egal("legat de mână rămâne legat",
    q("SELECT p.nume FROM mk_contacte c JOIN parteneri p ON p.id = c.partener_id WHERE c.nume = 'Vechi Aectra LG'").map((x) => x.nume),
    ["AECTRA PLASTICS SRL"]);

  await cer("/marketing/contacte/legare/desfa", { metoda: "post" });
  egal("a doua desfacere nu mai desface nimic",
    Number(q("SELECT COUNT(*) AS n FROM mk_contacte_istoric WHERE camp = 'legat-automat-desfacut'")[0].n), 4);

  // --- curățenie după noi ----------------------------------------------------
  for (const s of [
    "TRUNCATE mk_aniversari, mk_contacte_istoric, mk_contacte RESTART IDENTITY CASCADE",
    "DELETE FROM email_domenii WHERE domeniu LIKE '%test-lg%'",
    "DELETE FROM parteneri WHERE cui LIKE 'RO-LG-%'",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
