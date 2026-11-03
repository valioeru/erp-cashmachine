"use strict";
// Nr. Reg. Com. al partenerului: din ANAF după CUI, pe aviz și pe factura
// trimisă la SmartBill.
//
// CEREREA LUI VALI, 03.11.2026: „Fă și Reg. Com. pe client și urcă tot din
// SmartBill, dacă poți — să fie și ăla, inclusiv pentru facturi.”
// (API-ul SmartBill nu dă lista de clienți; ANAF dă, după CUI — lib/anaf.js.)
//
// CE APĂRĂ:
//   • CUI-ul se citește corect („RO…”, cu spații) și cele străine nu pleacă la ANAF;
//   • ANAF e întrebat câte 100, iar o eroare oprește tot, cu mesaj de om;
//   • completarea scrie doar unde Reg. Com. lipsește — nu rescrie ce e scris;
//   • doar adminul o pornește; o eroare ANAF nu schimbă nimic;
//   • fișa partenerului are câmpul și îl arată;
//   • avizul îl ia la emitere și îl tipărește;
//   • factura către SmartBill îl trimite ca „regCom”.
const path = require("path");
const fs = require("fs");
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const ANAF = require(path.join(RAD, "lib", "anaf.js"));
const SB = require(path.join(RAD, "lib", "smartbill.js"));
const avize = require(path.join(RAD, "modules", "avize.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
avize.register(router);
require(path.join(RAD, "modules", "parteneri.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b === undefined ? "" : String(b); };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function cer(metoda, cale, { user = VALI, params = {}, query = {}, body = {} } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => decodeURIComponent((r.antet && (r.antet.Location || r.antet.location)) || "");

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
function contine(eticheta, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !corp.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => corp.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta);
}

const CURATENIE = [
  "DELETE FROM avize_linii WHERE aviz_id IN (SELECT id FROM avize WHERE partener_id BETWEEN 97201 AND 97209)",
  "DELETE FROM avize WHERE partener_id BETWEEN 97201 AND 97209",
  "DELETE FROM parteneri WHERE id BETWEEN 97201 AND 97209",
];
const contorVechi = q("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator')");
function refaContor() {
  exec("DELETE FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator')");
  for (const r of contorVechi) exec(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (${lit(r.cheie)}, ${lit(r.valoare)}, '2026-11-03')`);
}

(async () => {
  for (const s of CURATENIE) exec(s);

  // --- CUI-ul ---------------------------------------------------------------------
  egal("CUI-uri citite", ["RO27244210", "ro 27 244 210", "27846339", "DE811569869", "-", "", "ATU123", "12"].map(ANAF.cuiNumeric),
    [27244210, 27244210, 27846339, null, null, null, null, 12]);
  // Un CNP (13 cifre) scris în câmpul de CUI al unei persoane fizice nu pleacă la ANAF.
  egal("un CNP nu e trimis drept CUI", ANAF.cuiNumeric("1850101123456"), null);

  // --- ANAF, cu răspunsuri false ---------------------------------------------------------
  const cereri = [];
  const fetchFals = async (url, o) => {
    const corp = JSON.parse(o.body);
    cereri.push({ url, n: corp.length, data: corp[0] && corp[0].data });
    return {
      ok: true,
      json: async () => ({
        found: corp.filter((x) => x.cui % 2 === 0).map((x) => ({ date_generale: { cui: x.cui, denumire: "F" + x.cui, nrRegCom: "J40/" + x.cui + "/2001" }, adresa_sediu_social: { sdenumire_Judet: "ILFOV" } })),
        notFound: corp.filter((x) => x.cui % 2 === 1).map((x) => x.cui),
      }),
    };
  };
  const multe = Array.from({ length: 150 }, (_, i) => "RO" + (1000 + i));
  let r = await ANAF.cauta(multe.concat(["RO1000", "DE1"]), { fetchFn: fetchFals, pauzaMs: 0, data: "2026-11-03" });
  egal("câte 100 pe cerere, la adresa v9", cereri.map((c) => [c.n, c.url.endsWith("/PlatitorTvaRest/v9/tva"), c.data]), [[100, true, "2026-11-03"], [50, true, "2026-11-03"]]);
  egal("găsite și negăsite", [r.gasite.size, r.negasite.length, r.gasite.get(1000).nrRegCom, r.gasite.get(1000).judet], [75, 75, "J40/1000/2001", "ILFOV"]);
  let mesaj = "";
  try { await ANAF.cauta(["RO27244210"], { fetchFn: async () => ({ ok: false, status: 503 }), pauzaMs: 0 }); } catch (e) { mesaj = e.message; }
  egal("un răspuns greșit oprește tot, cu mesaj", /ANAF a răspuns cu 503/.test(mesaj), true);
  mesaj = "";
  try { await ANAF.cauta(["RO27244210"], { fetchFn: async () => { throw new Error("ECONNRESET"); }, pauzaMs: 0 }); } catch (e) { mesaj = e.message; }
  egal("o rețea căzută oprește tot, cu mesaj", /ANAF nu răspunde: ECONNRESET/.test(mesaj), true);

  // --- completarea din Parteneri -----------------------------------------------------------
  exec(`INSERT INTO parteneri (id, nume, cui, tip, reg_com, adresa, judet) VALUES
          (97201, 'CASH TEST SRL', 'RO27244210', 'client', NULL, 'Str. Emil Racovita 31-33, Voluntari', 'Ilfov'),
          (97202, 'DEJA SCRIS SRL', '27846339', 'client', 'J99/1/2000', NULL, NULL),
          (97203, 'STRAIN GMBH', 'DE811569869', 'client', NULL, NULL, NULL),
          (97204, 'ASOCIATIA TEST', '12345678', 'client', NULL, NULL, NULL),
          (97205, 'NEGASIT SRL', '87654321', 'client', '', NULL, NULL)`);
  const cerute = [];
  const cautaReal = ANAF.cauta;
  ANAF.cauta = async (cuiuri) => {
    cerute.push(...cuiuri.map(ANAF.cuiNumeric));
    return {
      gasite: new Map([[27244210, { nrRegCom: "J2010002107232" }], [12345678, { nrRegCom: "" }], [27846339, { nrRegCom: "J00/0/0000" }]]),
      negasite: [87654321],
    };
  };
  let rr = await cer("post", "/parteneri/reg-com-anaf", { user: { id: 3, nume: "Agent", rol: "vanzari" } });
  egal("ne-adminul nu pornește completarea", [/eroare=.*administratorul/.test(locatie(rr)), cerute.length], [true, 0]);

  rr = await cer("post", "/parteneri/reg-com-anaf");
  egal("ANAF e întrebat doar de cei fără Reg. Com., cu CUI românesc",
    [cerute.includes(27244210), cerute.includes(12345678), cerute.includes(87654321), cerute.includes(27846339), cerute.includes(null)],
    [true, true, true, false, false]);
  egal("Reg. Com. scris doar unde lipsea; ce era scris rămâne",
    q("SELECT id, reg_com FROM parteneri WHERE id BETWEEN 97201 AND 97205 ORDER BY id").map((x) => [x.id, x.reg_com]),
    [["97201", "J2010002107232"], ["97202", "J99/1/2000"], ["97203", null], ["97204", null], ["97205", null]]);
  const msg = locatie(rr);
  if (!/ok=Nr\. Reg\. Com\. completat de la ANAF la \d+ /.test(msg) || !/n-au număr la ANAF/.test(msg)) rau("mesajul de după nu spune ce s-a întâmplat", msg.slice(0, 200));
  else ok("mesajul spune câți, câți fără număr, câți negăsiți");

  exec("UPDATE parteneri SET reg_com = NULL WHERE id = 97201");
  ANAF.cauta = async () => { throw new Error("ANAF a răspuns cu 503. Încearcă din nou peste câteva minute."); };
  rr = await cer("post", "/parteneri/reg-com-anaf");
  egal("o eroare ANAF nu schimbă nimic și spune de ce", [/eroare=Nu s-a putut întreba ANAF: ANAF a răspuns cu 503/.test(locatie(rr)), unul("SELECT reg_com FROM parteneri WHERE id = 97201")], [true, null]);
  exec("UPDATE parteneri SET reg_com = 'J2010002107232' WHERE id = 97201");
  ANAF.cauta = cautaReal;

  // --- fișa partenerului ------------------------------------------------------------------------
  rr = await cer("get", "/parteneri/nou");
  contine("formularul de partener are câmpul Reg. Com.", rr.corp, ['name="reg_com"', "Nr. Reg. Com."]);
  rr = await cer("get", "/parteneri/:id", { params: { id: "97201" } });
  contine("fișa arată Reg. Com.", rr.corp, ["Nr. Reg. Com.", "J2010002107232"]);
  rr = await cer("get", "/parteneri");
  contine("adminul are butonul de completare din ANAF", rr.corp, ['action="/parteneri/reg-com-anaf"', "Completează Reg. Com. din ANAF"]);

  // --- avizul ------------------------------------------------------------------------------------------
  exec("DELETE FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator')");
  exec("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('aviz_serie','TRC','2026-11-03'), ('aviz_urmator','1','2026-11-03')");
  const a = await avize.emite({ partenerId: 97201, linii: [{ denumire: "Cutii", um: "buc", cantitate: 5 }], creatDe: "Vali" });
  egal("avizul ține Reg. Com. de la emitere", unul(`SELECT client_regcom FROM avize WHERE id = ${a.id}`), "J2010002107232");
  rr = await cer("get", "/avize/:id", { params: { id: String(a.id) } });
  contine("foaia avizului îl scrie la client", rr.corp, ["Client: CASH TEST SRL", "Reg. com.: J2010002107232", "CIF: RO27244210"]);
  const b = await avize.emite({ partenerId: 97203, linii: [{ denumire: "Cutii", um: "buc", cantitate: 5 }], creatDe: "Vali" });
  rr = await cer("get", "/avize/:id", { params: { id: String(b.id) } });
  const client = rr.corp.slice(rr.corp.indexOf('<div class="client">'), rr.corp.indexOf("</div>\n  </div>", rr.corp.indexOf('<div class="client">')));
  contine("fără Reg. Com., rândul lipsește la client", client, ["STRAIN GMBH"], ["Reg. com."]);

  // --- factura către SmartBill ------------------------------------------------------------------------
  const cu = SB.construiesteFactura({ partener_nume: "CASH TEST SRL", cui: "RO27244210", reg_com: " J2010002107232 " }, [], {});
  const fara = SB.construiesteFactura({ partener_nume: "STRAIN GMBH", cui: "DE811569869", reg_com: null }, [], {});
  egal("factura trimite regCom când îl are, altfel deloc", [cu.client.regCom, "regCom" in fara.client ? fara.client.regCom : "lipsă"], ["J2010002107232", undefined]);
  const sursaFacturi = fs.readFileSync(path.join(RAD, "modules", "facturi.js"), "utf8");
  const sel = sursaFacturi.slice(sursaFacturi.indexOf("async function facturaPentruSmartBill"), sursaFacturi.indexOf("async function trimiteInSmartBill"));
  egal("factura pentru SmartBill citește reg_com din fișa clientului", /p\.reg_com/.test(sel), true);

  for (const s of CURATENIE) exec(s);
  refaContor();
  console.log(rele ? "\n" + rele + " probleme." : "\nTotul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  for (const s of CURATENIE) { try { exec(s); } catch (x) { /* best-effort */ } }
  try { refaContor(); } catch (x) { /* best-effort */ }
  process.exit(1);
});
