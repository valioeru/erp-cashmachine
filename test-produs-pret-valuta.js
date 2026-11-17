"use strict";
// Prețul de produs scris în valută și trecut în lei, din fișa produsului.
//
// CEREREA LUI VALI, 17.11.2026: „prețurile se introduc în RON sau EUR; se
// păstrează cursul introdus sau BNR; odată plasat, așa rămâne în istoric."
//
// CE APĂRĂ:
//   • fișa produsului are trecerea din valută și câmpul „Din ce s-au făcut prețurile";
//   • scriptul paginii (rulat în Chromium) pune în câmpul ales suma × cursul,
//     cu patru zecimale, la BNR-ul zilei sau la cursul scris, și scrie nota;
//   • nota unui câmp trecut a doua oară se înlocuiește, ale celorlalte rămân;
//   • salvarea ține prețul cu patru zecimale și nota; nimic nu se convertește la salvare.
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
for (const m of ["produse"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97711, nume: "Vali Test", rol: "admin", email: "v.pp@test.ro" };
const AGENT = { id: 97712, nume: "Gabriela Test", rol: "vanzari", email: "g.pp@test.ro" };

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


const PRODUS = 97721;
function curata() {
  for (const s of ["DELETE FROM produse WHERE id = 97721", "DELETE FROM utilizatori WHERE id BETWEEN 97711 AND 97719"]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const produs = () => q("SELECT * FROM produse WHERE id = ?", [PRODUS])[0];

(async () => {
  curata();
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97711,'Vali Test','v.pp@test.ro','x','y','admin')");
  exec("INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, pret_achizitie, cota_tva) VALUES (97721,'PP-1','Folie pentru preț în valută','buc',10,6,21)");

  console.log("── Fișa produsului ──────────────────────────────────────────");
  let r = await cer("/produse/:id/editare", { params: { id: String(PRODUS) } });
  bine("fișa are trecerea din valută, cele patru câmpuri de preț și nota", r.cod === 200 && r.corp.includes("data-trecere-valuta") && r.corp.includes("Ai prețul în euro sau dolari?") && ["pret_achizitie", "pret_productie", "pret_minim", "pret_vanzare"].every((n) => r.corp.includes(`<option value="${n}">`)) && r.corp.includes('name="pret_nota"'));
  bine("câmpurile de preț primesc patru zecimale", /name="pret_vanzare"[^>]*step="0\.0001"/.test(r.corp) || /step="0\.0001"[^>]*name="pret_vanzare"/.test(r.corp), (r.corp.match(/<input[^>]*name="pret_vanzare"[^>]*>/) || [""])[0]);

  console.log("\n── Scriptul paginii, în Chromium ────────────────────────────");
  const P = require(path.join(RAD, "modules", "produse.js"));
  let pw = null;
  try { pw = require("playwright"); } catch (_) { pw = null; }
  if (!pw) rau("Playwright lipsește: scriptul paginii n-a fost rulat");
  else {
    const b = await pw.chromium.launch();
    const pg = await b.newPage();
    const html = (bnr) => `<!doctype html><meta charset="utf-8"><form><input name="pret_achizitie" value="6"><input name="pret_productie"><input name="pret_minim"><input name="pret_vanzare" value="10"><input name="pret_nota" value="">${P.trecereDinValuta(bnr)}</form>`;
    await pg.setContent(html({ EUR: { valoare: 5.0912, data: "2026-11-17" } }));
    const v = (n) => pg.$eval(`input[name="${n}"]`, (e) => e.value);
    const pune = async (suma, moneda, curs, camp) => {
      await pg.fill("[data-tv-suma]", suma);
      await pg.selectOption("[data-tv-moneda]", moneda);
      await pg.fill("[data-tv-curs]", curs);
      await pg.selectOption("[data-tv-camp]", camp);
      await pg.click("[data-tv-pune]");
    };
    egal("câmpul de curs arată BNR-ul zilei pentru moneda aleasă", await pg.$eval("[data-tv-curs]", (e) => e.placeholder), "5,0912");
    await pune("2", "EUR", "", "pret_vanzare");
    egal("2 EUR la BNR-ul zilei → preț de vânzare 10,1824 lei, cu nota „BNR din”; celelalte câmpuri rămân", [await v("pret_vanzare"), await v("pret_achizitie"), await v("pret_nota")], ["10.1824", "6", "Preț vânzare: 2 EUR × 5,0912 (BNR din 17.11.2026)"]);
    await pune("1,25", "EUR", "5,2", "pret_achizitie");
    egal("1,25 EUR la cursul scris → achiziție 6,5 lei, „curs pus de voi”; nota vânzării rămâne", [await v("pret_achizitie"), await v("pret_nota")], ["6.5", "Preț vânzare: 2 EUR × 5,0912 (BNR din 17.11.2026) · Preț achiziție: 1,25 EUR × 5,2000 (curs pus de voi)"]);
    await pune("3", "EUR", "5,0912", "pret_vanzare");
    egal("trecut a doua oară, câmpul își înlocuiește nota; cursul scris la fel ca BNR-ul rămâne BNR", [await v("pret_vanzare"), await v("pret_nota")], ["15.2736", "Preț achiziție: 1,25 EUR × 5,2000 (curs pus de voi) · Preț vânzare: 3 EUR × 5,0912 (BNR din 17.11.2026)"]);
    await pune("0,03333", "EUR", "5,1234", "pret_minim");
    egal("patru zecimale: 0,03333 × 5,1234 = 0,1708", await v("pret_minim"), "0.1708");
    await pune("2", "USD", "", "pret_productie");
    egal("monedă fără BNR și fără curs scris: nu pune nimic și spune de ce", [await v("pret_productie"), await pg.$eval("[data-tv-mesaj]", (e) => e.textContent)], ["", "BNR nu are acum curs pentru USD. Scrie cursul."]);
    await pune("doi", "EUR", "", "pret_productie");
    await pune("2", "EUR", "abc", "pret_productie");
    egal("sumă sau curs care nu sunt numere: nu pune nimic", [await v("pret_productie"), await pg.$eval("[data-tv-mesaj]", (e) => e.textContent)], ["", "Cursul nu e un număr."]);
    await b.close();
  }

  console.log("\n── Salvarea ─────────────────────────────────────────────────");
  r = await cer("/produse/:id/editare", { metoda: "post", params: { id: String(PRODUS) }, body: { cod: "PP-1", denumire: "Folie pentru preț în valută", categorie: "", gestiune: "", unitate_masura: "buc", pret_achizitie: "6.5", pret_productie: "", adaos_lista: "", pret_minim: "", pret_vanzare: "10.1824", pret_nota: "Preț vânzare: 2 EUR × 5,0912 (BNR din 17.11.2026)", cota_tva: "21", stoc_minim: "0", pret_moneda: "EUR", pret_curs: "9" } });
  const p = produs();
  egal("prețul rămâne cum e în câmp (în lei, cu patru zecimale), cu nota lui — nimic nu se înmulțește la salvare", [Number(p.pret_vanzare), Number(p.pret_achizitie), p.pret_nota], [10.1824, 6.5, "Preț vânzare: 2 EUR × 5,0912 (BNR din 17.11.2026)"]);

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
