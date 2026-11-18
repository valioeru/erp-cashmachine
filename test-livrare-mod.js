"use strict";
// Cum se face livrarea, ales la comanda nouă. PostgreSQL real.
//
// Vali, 18.11.2026: „La comanda nouă se alege și cum să se facă livrarea, cu
// variantele: livrează agentul de vânzări, ridică clientul, trimitem noi cu
// transport intern, trimitem noi cu transportator terț."
//
// CE APĂRĂ: cele patru variante; fără alegere comanda nouă nu se plasează; se
// scrie, se vede pe comandă și în lista depozitului, se schimbă la modificare
// (cu istoric); comanda de dinainte rămâne „nespecificat" și se poate modifica.
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

const LM = require(path.join(RAD, "lib", "livrare-mod.js"));

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi", "warehouse"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 98111, nume: "Vali Test", rol: "admin", email: "v.lm@test.ro" };
const AGENT = { id: 98112, nume: "Gabriela Test", rol: "vanzari", email: "g.lm@test.ro" };

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


const CLIENT = 98101, PRODUS = 98121;
function curata() {
  for (const s of [
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 98101)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 98101)",
    "DELETE FROM emailuri WHERE partener_id = 98101",
    "DELETE FROM comenzi WHERE partener_id = 98101",
    "DELETE FROM interactiuni WHERE partener_id = 98101",
    "DELETE FROM parteneri WHERE id = 98101",
    "DELETE FROM produse WHERE id = 98121",
    "DELETE FROM utilizatori WHERE id BETWEEN 98111 AND 98119",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const comanda = (id) => q("SELECT * FROM comenzi WHERE id = ?", [id])[0];
const corp = (extra) => Object.assign({ partener_id: String(CLIENT), numar: "", livrare_partiala: "nu", branding: "nepersonalizat", moneda: "RON", termen_plata_zile: "", "produs_id[]": [String(PRODUS)], "cantitate[]": ["5"], "pret_unitar[]": ["12"], "um[]": ["buc"] }, extra || {});
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/(\d+)(\?|$)/) || [])[1] || 0);
const curat = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

(async () => {
  egal("cele patru variante, cu vorbele lui Vali", LM.OPTIUNI, [["agent", "Livrează agentul de vânzări"], ["client", "Ridică clientul"], ["intern", "Trimitem noi, cu transport intern"], ["tert", "Trimitem noi, cu transportator terț"]]);
  egal("ce nu e una din ele nu se ia; nealesul se scrie „nespecificat”", [LM.valid("tert"), LM.valid(" agent "), LM.valid("curier"), LM.valid(null), LM.text({ livrare_mod: "client" }), LM.text({ livrare_mod: "" }), LM.text(null)], ["tert", "agent", "", "", "Ridică clientul", "nespecificat", "nespecificat"]);

  curata();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98111,'Vali Test','v.lm@test.ro','x','y','admin')",
    "INSERT INTO parteneri (id, nume, cui, tip) VALUES (98101, 'LM-TEST Client SRL', 'RO98101', 'client')",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (98121,'LM-1','Folie pentru livrare','buc',10,21)",
  ]) exec(s);

  console.log("\n── Comanda nouă ─────────────────────────────────────────────");
  let r = await cer("/comenzi/nou");
  const cutie = (h) => (String(h).match(/<fieldset class="field" data-livrare-mod[\s\S]*?<\/fieldset>/) || [""])[0];
  bine("formularul întreabă cum se face livrarea, cu cele patru variante, obligatoriu, nimic ales dinainte", curat(cutie(r.corp)) === "Cum se face livrarea? Livrează agentul de vânzări Ridică clientul Trimitem noi, cu transport intern Trimitem noi, cu transportator terț" && (cutie(r.corp).match(/name="livrare_mod" value="(agent|client|intern|tert)" required>/g) || []).length === 4, cutie(r.corp).slice(0, 400));
  const inainte = q("SELECT id FROM comenzi WHERE partener_id = ?", [CLIENT]).length;
  r = await cer("/comenzi", { metoda: "post", body: corp() });
  bine("fără alegere comanda nu se plasează; formularul revine cu motivul și cu ce era scris", q("SELECT id FROM comenzi WHERE partener_id = ?", [CLIENT]).length === inainte && r.corp.includes("Alege cum se face livrarea") && /name="livrare_partiala" value="nu" required checked/.test(r.corp), curat(r.corp).slice(0, 200));
  r = await cer("/comenzi", { metoda: "post", body: corp({ livrare_mod: "cu barca" }) });
  bine("nici cu o variantă născocită", q("SELECT id FROM comenzi WHERE partener_id = ?", [CLIENT]).length === inainte && r.corp.includes("Alege cum se face livrarea"));
  r = await cer("/comenzi", { metoda: "post", body: corp({ livrare_mod: "tert" }) });
  const c1 = idDinLocatie(r);
  egal("cu alegerea făcută se plasează și se scrie pe comandă", [c1 > 0, comanda(c1).livrare_mod], [true, "tert"]);
  r = await cer("/comenzi/:id", { params: { id: String(c1) } });
  bine("pagina comenzii o spune", /<div data-livrare-mod-comanda><div class="k">Livrarea<\/div>Trimitem noi, cu transportator terț<\/div>/.test(r.corp));

  console.log("\n── Modificarea ──────────────────────────────────────────────");
  r = await cer("/comenzi/:id/editare", { params: { id: String(c1) } });
  bine("formularul de modificare vine cu varianta comenzii aleasă", /name="livrare_mod" value="tert" checked/.test(cutie(r.corp)) && !/value="agent" checked/.test(cutie(r.corp)));
  const mod = (extra) => Object.assign(corp(extra), { "pret_exact[]": ["12"], motiv: "test" });
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod({ livrare_mod: "client" }) });
  egal("schimbată la modificare: se scrie și intră în istoric, pe înțeles", [comanda(c1).livrare_mod, q("SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ? AND ce = 'Cum se face livrarea'", [c1]).map((x) => [x.vechi, x.nou])], ["client", [["Trimitem noi, cu transportator terț", "Ridică clientul"]]]);
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: mod() });
  egal("modificată fără alegere (formular vechi): rămâne ce era", comanda(c1).livrare_mod, "client");
  const veche = Number(q(`INSERT INTO comenzi (partener_id, status, numar) VALUES (${CLIENT}, 'noua', 'LM-VECHE') RETURNING id`)[0].id);
  exec(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${veche}, ${PRODUS}, 5, 12)`);
  r = await cer("/comenzi/:id", { params: { id: String(veche) } });
  bine("comanda de dinainte: „nespecificat”", /<div class="k">Livrarea<\/div>nespecificat<\/div>/.test(r.corp));
  r = await cer("/comenzi/:id/editare", { params: { id: String(veche) } });
  bine("…iar formularul ei de modificare n-are nimic ales și nu obligă", !/name="livrare_mod"[^>]*checked/.test(cutie(r.corp)) && !/name="livrare_mod"[^>]*required/.test(cutie(r.corp)) && cutie(r.corp).includes('value="intern"'));

  console.log("\n── Lista depozitului ────────────────────────────────────────");
  exec(`UPDATE comenzi SET status = 'confirmata' WHERE id IN (${c1}, ${veche})`);
  r = await cer("/depozit");
  const rand = (nr) => curat((new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?${nr}[\\s\\S]*?</tr>`).exec(r.corp) || [""])[0]);
  bine("sub client scrie cum se face livrarea", r.cod === 200 && /LM-TEST Client SRL Ridică clientul/.test(curat(r.corp)) && /LM-TEST Client SRL nespecificat/.test(curat(r.corp)), curat(r.corp).match(/.{0,60}LM-TEST.{0,80}/));

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
