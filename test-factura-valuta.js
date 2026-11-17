"use strict";
// Facturile scrise de mână, cu prețuri în valută. PostgreSQL real.
//
// CEREREA LUI VALI, 17.11.2026: „La orice comandă, preț etc., din orice loc în
// tot sistemul, prețurile se introduc în RON sau EUR; se păstrează cursul
// introdus sau BNR; odată plasat, așa rămâne în istoric."
//
// CE APĂRĂ:
//   • formularele de factură (vânzare și achiziție) au alegerea monedei;
//   • liniile rămân în lei: prețul scris în valută × cursul, cu 4 zecimale;
//   • cursul rămâne scris în observații;
//   • în lei, factura se scrie exact ca până acum, fără nicio notă;
//   • cursul greșit sau lipsa lui oprește factura înainte să se scrie ceva.
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
// SmartBill nu e configurat în test: validarea facturii nu trimite nimic.
for (const k of Object.keys(process.env)) if (/^SMARTBILL/.test(k)) delete process.env[k];
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail$/.test(req)) return { trimite: async () => ({ ok: true }), trimiteDeLa: async () => ({ ok: true }), configUtilizator: async () => null };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const UPA = require(path.join(RAD, "lib", "upa.js"));
const SB = require(path.join(RAD, "lib", "smartbill.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["facturi"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97611, nume: "Vali Test", rol: "admin", email: "v.fv@test.ro" };
const AGENT = { id: 97612, nume: "Gabriela Test", rol: "vanzari", email: "g.fv@test.ro" };

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
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));


const CLIENT = 97601, FURNIZOR = 97602, PRODUS = 97621;
function curata() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id IN (97601, 97602))",
    "DELETE FROM facturi WHERE partener_id IN (97601, 97602)",
    "DELETE FROM parteneri WHERE id IN (97601, 97602)",
    "DELETE FROM produse WHERE id = 97621",
    "DELETE FROM utilizatori WHERE id BETWEEN 97611 AND 97619",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const facturi = (partener) => q("SELECT id, observatii, directie FROM facturi WHERE partener_id = ? ORDER BY id", [partener]);
const linii = (id) => q("SELECT pret_unitar, cantitate FROM facturi_linii WHERE factura_id = ? ORDER BY id", [id]).map((l) => [Number(l.pret_unitar), Number(l.cantitate)]);
const parametri = (r) => Object.fromEntries(new URLSearchParams(String(locatie(r)).split("?")[1] || ""));
const vanzare = (extra) => Object.assign({ partener_id: String(CLIENT), data_scadenta: "", observatii: "obs de test", "produs_id[]": ["", String(PRODUS)], "denumire[]": ["Linie liberă", ""], "cantitate[]": ["2", "3"], "pret_unitar[]": ["10", "0.03333"], "cota_tva[]": ["21", "21"] }, extra || {});
const achizitie = (extra) => Object.assign({ partener_id: String(FURNIZOR), serie: "FV", numar: "17", data_emiterii: "2026-11-17", data_scadenta: "2026-12-17", observatii: "", "produs_id[]": [""], "denumire[]": ["Granulă"], "cantitate[]": ["1000"], "pret_unitar[]": ["1.25"], "cota_tva[]": ["21"] }, extra || {});

(async () => {
  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97611,'Vali Test','v.fv@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (97601, 'FV-TEST Client SRL', 'RO97601', 'client'), (97602, 'FV-TEST Furnizor SRL', 'RO97602', 'furnizor')",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97621,'FV-1','Pungă pentru valută','buc',10,21)",
  ]) exec(s);

  console.log("── Formularele ──────────────────────────────────────────────");
  let r = await cer("/facturi/nou");
  bine("factura de vânzare are alegerea monedei și spune că factura se ține în lei", r.cod === 200 && r.corp.includes("data-valuta-factura") && r.corp.includes("Prețurile liniilor sunt scrise în") && r.corp.includes('name="pret_moneda"') && r.corp.includes('name="pret_curs"') && r.corp.includes("Factura se ține în lei"));
  r = await cer("/facturi/achizitii/noua");
  bine("factura de achiziție, la fel", r.cod === 200 && r.corp.includes("data-valuta-factura") && r.corp.includes('name="pret_moneda"') && r.corp.includes('name="pret_curs"'));
  r = await cer("/facturi/nou", { query: { eroare: "Cursul nu e bun" } });
  bine("motivul unui refuz se vede pe formular", r.corp.includes('role="alert"') && r.corp.includes("Cursul nu e bun"));
  r = await cer("/facturi/achizitii/noua", { query: { eroare: "Cursul nu e bun nici aici" } });
  bine("…și pe cel de achiziție", r.corp.includes('role="alert"') && r.corp.includes("Cursul nu e bun nici aici") && !(await cer("/facturi/achizitii/noua")).corp.includes('role="alert"'));

  console.log("\n── Vânzare ──────────────────────────────────────────────────");
  await cer("/facturi", { metoda: "post", body: vanzare() });
  let f = facturi(CLIENT);
  egal("în lei: prețurile intră cum sunt scrise, fără nicio notă de curs", [f.length, linii(f[0].id), f[0].observatii], [1, [[10, 2], [0.03333, 3]], "obs de test"]);
  await cer("/facturi", { metoda: "post", body: vanzare({ pret_moneda: "EUR", pret_curs: "5,1234" }) });
  f = facturi(CLIENT);
  egal("în euro, cu cursul scris: liniile sunt în lei, la cursul acela, cu patru zecimale (10 × 5,1234 și 0,03333 × 5,1234)", [f.length, linii(f[1].id)], [2, [[51.234, 2], [0.1708, 3]]]);
  egal("…iar cursul rămâne scris în observații, după ce a scris omul", f[1].observatii, "obs de test · Prețuri scrise în EUR, trecute în lei: 1 EUR × 5,1234 (curs pus de voi).");
  r = await cer("/facturi", { metoda: "post", body: vanzare({ pret_moneda: "EUR", pret_curs: "cinci" }) });
  egal("curs care nu e număr: factura nu se scrie, iar formularul se întoarce cu motivul", [String(locatie(r)).split("?")[0], /Cursul nu e un număr/.test(parametri(r).eroare || ""), facturi(CLIENT).length], ["/facturi/nou", true, 2]);
  r = await cer("/facturi", { metoda: "post", body: vanzare({ pret_moneda: "GBP", pret_curs: "6" }) });
  egal("monedă în care nu se scriu prețurile: la fel", [/nu e una în care se scriu prețurile/.test(parametri(r).eroare || ""), facturi(CLIENT).length], [true, 2]);
  r = await cer("/facturi", { metoda: "post", body: vanzare({ pret_moneda: "USD", pret_curs: "" }) });
  const cuBnr = facturi(CLIENT).length === 3;
  bine("fără curs scris: ori se ia BNR-ul zilei (cu „BNR” în notă), ori, dacă BNR-ul nu răspunde, factura nu se scrie",
    cuBnr ? /Prețuri scrise în USD, trecute în lei: 1 USD × [\d,]+ \(BNR/.test(facturi(CLIENT)[2].observatii || "") : /BNR nu are acum curs pentru USD/.test(parametri(r).eroare || ""), (facturi(CLIENT)[2] || {}).observatii || parametri(r).eroare);

  console.log("\n── Achiziție ────────────────────────────────────────────────");
  await cer("/facturi/achizitii", { metoda: "post", body: achizitie({ pret_moneda: "USD", pret_curs: "4.5" }) });
  f = facturi(FURNIZOR);
  egal("factura furnizorului scrisă în dolari: linia în lei (1,25 × 4,5), cursul în observații", [f.length, linii(f[0].id), f[0].observatii], [1, [[5.625, 1000]], "Prețuri scrise în USD, trecute în lei: 1 USD × 4,5000 (curs pus de voi)."]);
  await cer("/facturi/achizitii", { metoda: "post", body: achizitie({ numar: "18" }) });
  f = facturi(FURNIZOR);
  egal("în lei: ca până acum", [linii(f[1].id), f[1].observatii], [[[1.25, 1000]], null]);
  r = await cer("/facturi/achizitii", { metoda: "post", body: achizitie({ numar: "19", pret_moneda: "EUR", pret_curs: "-2" }) });
  egal("curs negativ: nu se scrie, iar formularul de achiziție se întoarce cu motivul", [String(locatie(r)).split("?")[0], Boolean(parametri(r).eroare), facturi(FURNIZOR).length], ["/facturi/achizitii/noua", true, 2]);

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
