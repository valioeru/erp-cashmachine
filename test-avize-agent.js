"use strict";
// Avizele de însoțire făcute de agent, pentru clienții lui.
//
// CEREREA LUI VALI, 18.11.2026: „Și lasă-i să facă și avize de însoțire, de
// asemenea."
//
// CE APĂRĂ:
//   • agentul face aviz doar pentru clienții lui (de pe fișă sau alocați), și
//     nu poate ocoli regula trimițând de mână alt client;
//   • vede avizele făcute de el și pe ale clienților lui, nu pe ale altora;
//   • „Fă aviz" din comandă vine cu clientul, numărul comenzii și liniile;
//   • numerotarea rămâne una singură; contorul și anularea rămân la administrator;
//   • cine are bifa „Avize" lucrează ca până acum, pe toți clienții.
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

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi", "avize", "proforme"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97811, nume: "Vali Test", rol: "admin", email: "v.av@test.ro" };
const AGENT = { id: 97812, nume: "Gabriela Test", rol: "vanzari", email: "g.av@test.ro" };

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


const ALT = { id: 97813, nume: "Altul Test", rol: "vanzari", email: "a.av@test.ro" };
const ALOCAT = { id: 97814, nume: "Alocata Test", rol: "vanzari", email: "al.av@test.ro" };
const CUBIFA = { id: 97816, nume: "Cu Bifa Test", rol: "depozit", email: "b.av@test.ro", sectiuni: "/depozit,/avize" };
let contorVechi = [];
function curata() {
  for (const s of [
    "DELETE FROM avize WHERE partener_id IN (97801, 97802)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id IN (97801, 97802))",
    "DELETE FROM comenzi WHERE partener_id IN (97801, 97802)",
    "DELETE FROM alocari_clienti WHERE partener_id IN (97801, 97802)",
    "DELETE FROM interactiuni WHERE partener_id IN (97801, 97802)",
    "DELETE FROM parteneri WHERE id IN (97801, 97802)",
    "DELETE FROM produse WHERE id = 97821",
    "DELETE FROM utilizatori WHERE id BETWEEN 97811 AND 97819",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const contor = () => q("SELECT cheie, valoare FROM setari_app WHERE cheie IN ('aviz_serie','aviz_urmator') ORDER BY cheie").map((x) => x.valoare);
const cate = () => Number(q("SELECT COUNT(*) AS n, 1 AS x FROM avize WHERE partener_id IN (97801, 97802)")[0].n);
const corp = (partener, extra) => Object.assign({ partener_id: String(partener), comanda_numar: "", delegat: "", transport: "", observatii: "", "produs[]": ["AV-1 — Pungă curier AV"], "um[]": ["buc"], "cantitate[]": ["100"] }, extra || {});
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/avize\/(\d+)/) || [])[1] || 0);
const text = (h) => String(h).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

(async () => {
  curata();
  contorVechi = contor();
  for (const s of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97811,'Vali Test','v.av@test.ro','x','y','admin'), (97812,'Gabriela Test','g.av@test.ro','x','y','vanzari'), (97813,'Altul Test','a.av@test.ro','x','y','vanzari'), (97814,'Alocata Test','al.av@test.ro','x','y','vanzari'), (97816,'Cu Bifa Test','b.av@test.ro','x','y','depozit')",
    "INSERT INTO parteneri (id, nume, cui, tip, agent_id, adresa, localitate, judet) VALUES (97801, 'AV-TEST Client SRL', 'RO97801', 'client', 97812, 'Str. Lunga 5', 'Craiova', 'Dolj'), (97802, 'AV-TEST Al Doilea SRL', 'RO97802', 'client', 97813, NULL, NULL, NULL)",
    "INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (97801, 97814, 50)",
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97821,'AV-1','Pungă curier AV','buc',0.5,21)",
    "INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda) VALUES (978001, 97801, 'AV-CMD-1', '2026-11-18', 'in_stoc_depozit', 97812, 97812, 'RON'), (978002, 97802, 'AV-CMD-2', '2026-11-18', 'in_stoc_depozit', 97813, 97813, 'RON'), (978003, 97801, 'AV-CMD-3', '2026-11-18', 'anulata', 97812, 97812, 'RON')",
    "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (978001, 97821, 1500.5, 0.4, 'buc'), (978002, 97821, 10, 1, NULL), (978003, 97821, 10, 1, 'buc')",
    "UPDATE setari_app SET valoare = 'AVT' WHERE cheie = 'aviz_serie'",
    "UPDATE setari_app SET valoare = '701' WHERE cheie = 'aviz_urmator'",
  ]) exec(s);

  console.log("── Agentul face aviz pentru clientul lui ────────────────────");
  let r = await cer("/avize/nou", { user: AGENT });
  bine("formularul îi arată doar clienții lui și îi spune asta", r.cod === 200 && r.corp.includes("AV-TEST Client SRL") && !r.corp.includes("AV-TEST Al Doilea SRL") && /data-doar-clientii-mei/.test(r.corp) && r.corp.includes('value="AV-CMD-1"') && !r.corp.includes('value="AV-CMD-2"'));
  r = await cer("/avize", { metoda: "post", user: AGENT, body: corp(97801, { comanda_numar: "AV-CMD-1", delegat: "Ion Șofer", transport: "B 123 ABC" }) });
  const a1 = idDinLocatie(r);
  let a = q("SELECT * FROM avize WHERE id = ?", [a1])[0] || {};
  egal("avizul se emite pe numărul următor, pe numele lui, legat de comandă", [r.cod, a.serie, nr(a.numar), a.client_nume, a.creat_de, nr(a.creat_de_id), nr(a.comanda_id), a.comanda_numar, a.delegat, contor()], [302, "AVT", 701, "AV-TEST Client SRL", "Gabriela Test", 97812, 978001, "AV-CMD-1", "Ion Șofer", ["AVT", "702"]]);
  egal("… cu linia lui, fără prețuri", q("SELECT denumire, cod, um, cantitate FROM avize_linii WHERE aviz_id = ?", [a1]).map((x) => [x.denumire, x.cod, x.um, nr(x.cantitate)]), [["Pungă curier AV", "AV-1", "buc", 100]]);
  r = await cer("/avize/:id", { user: AGENT, params: { id: String(a1) } });
  bine("își deschide foaia: de tipărit, fără buton de anulare", r.cod === 200 && text(r.corp).includes("Seria AVT nr. 701") && />Tipărește</.test(r.corp) && !r.corp.includes(`/avize/${a1}/anuleaza`) && !/pret|Preț/i.test(text(r.corp).replace(/Tipărește/g, "")));

  console.log("\n── Nu pentru clienții altora ────────────────────────────────");
  r = await cer("/avize", { metoda: "post", user: AGENT, body: corp(97802) });
  egal("client al altui agent, trimis de mână: refuzat, niciun număr consumat", [r.cod, /Poți face avize doar pentru clienții tăi/.test(r.corp), cate(), contor()], [200, true, 1, ["AVT", "702"]]);
  r = await cer("/avize", { metoda: "post", user: ALT, body: corp(97801) });
  egal("… și invers", [/Poți face avize doar pentru clienții tăi/.test(r.corp), cate()], [true, 1]);
  r = await cer("/avize", { metoda: "post", user: ALOCAT, body: corp(97801, { "cantitate[]": ["7"] }) });
  const a2 = idDinLocatie(r);
  egal("agentul cu clientul alocat face aviz; numărul continuă același șir", [nr((q("SELECT numar, 1 AS x FROM avize WHERE id = ?", [a2])[0] || {}).numar), contor()], [702, ["AVT", "703"]]);
  r = await cer("/avize", { metoda: "post", user: ALT, body: corp(97802) });
  const a3 = idDinLocatie(r);
  r = await cer("/avize", { metoda: "post", user: CUBIFA, body: corp(97801, { "cantitate[]": ["3"] }) });
  const a4 = idDinLocatie(r);
  r = await cer("/avize", { metoda: "post", user: CUBIFA, body: corp(97802, { "cantitate[]": ["4"] }) });
  const a5 = idDinLocatie(r);
  egal("cine are bifa „Avize” face pentru oricine, ca până acum", [a3 > 0, a4 > 0, a5 > 0, cate(), contor()], [true, true, true, 5, ["AVT", "706"]]);

  console.log("\n── Ce vede fiecare ──────────────────────────────────────────");
  const inLista = (h) => [a1, a2, a3, a4, a5].map((id) => h.includes(`href="/avize/${id}"`));
  r = await cer("/avize", { user: AGENT });
  egal("agentul: avizele lui și ale clientului lui (și cele făcute de alții pe clientul lui), nu ale altui client", [inLista(r.corp), /data-doar-ale-mele/.test(r.corp), r.corp.includes('action="/avize/contor"')], [[true, true, false, true, false], true, false]);
  egal("celălalt agent", inLista((await cer("/avize", { user: ALT })).corp), [false, false, true, false, true]);
  r = await cer("/avize", { user: CUBIFA });
  egal("cine are bifa le vede pe toate, fără nota „doar ale mele”", [inLista(r.corp), /data-doar-ale-mele/.test(r.corp)], [[true, true, true, true, true], false]);
  bine("administratorul are și contorul", (await cer("/avize", { user: ADMIN })).corp.includes('action="/avize/contor"'));
  egal("foaia: agentul nu o deschide pe a altui client; o deschid cel cu bifa și administratorul", [(await cer("/avize/:id", { user: AGENT, params: { id: String(a3) } })).cod, (await cer("/avize/:id", { user: ALT, params: { id: String(a1) } })).cod, (await cer("/avize/:id", { user: CUBIFA, params: { id: String(a1) } })).cod, (await cer("/avize/:id", { user: ADMIN, params: { id: String(a3) } })).cod, (await cer("/avize/:id", { user: ALOCAT, params: { id: String(a4) } })).cod], [403, 403, 200, 200, 200]);
  r = await cer("/avize/:id/anuleaza", { metoda: "post", user: AGENT, params: { id: String(a1) }, body: { motiv: "greșit" } });
  egal("agentul nu anulează: asta rămâne la administrator", [nr(q("SELECT anulat, 1 AS x FROM avize WHERE id = ?", [a1])[0].anulat), /Doar administratorul/.test(decodeURIComponent(locatie(r)))], [0, true]);
  r = await cer("/avize/contor", { metoda: "post", user: AGENT, body: { serie: "AVT", urmator: "900" } });
  egal("… și nu schimbă contorul", contor(), ["AVT", "706"]);

  console.log("\n── „Fă aviz” din comandă ────────────────────────────────────");
  r = await cer("/comenzi/:id", { user: AGENT, params: { id: "978001" } });
  bine("pagina comenzii lui are „Fă aviz de însoțire”", r.corp.includes('href="/avize/nou?comanda=978001" data-fa-aviz'));
  bine("… pe comanda altui client nu", !(await cer("/comenzi/:id", { user: AGENT, params: { id: "978002" } })).corp.includes("data-fa-aviz"));
  bine("… pe cea anulată nu", !(await cer("/comenzi/:id", { user: AGENT, params: { id: "978003" } })).corp.includes("data-fa-aviz"));
  bine("… cine are bifa „Avize” îl are pe orice comandă", (await cer("/comenzi/:id", { user: CUBIFA, params: { id: "978002" } })).corp.includes("data-fa-aviz"));
  r = await cer("/avize/nou", { user: AGENT, query: { comanda: "978001" } });
  bine("formularul vine cu clientul, numărul comenzii și linia ei, cu unitatea și cantitatea", r.corp.includes('name="comanda_numar" list="aviz-comenzi" value="AV-CMD-1"') && r.corp.includes('value="AV-1 — Pungă curier AV"') && r.corp.includes('name="cantitate[]" value="1500,5"') && r.corp.includes('name="um[]" value="buc"') && /name="partener_id"[^>]*value="97801"|value="97801"[^>]*name="partener_id"/.test(r.corp), (r.corp.match(/<input[^>]*partener_id[^>]*>/) || [""])[0]);
  r = await cer("/avize/nou", { user: AGENT, query: { comanda: "978002" } });
  bine("comanda altui client: formular gol, cu explicația", /Comanda nu e a unui client de-al tău/.test(r.corp) && !r.corp.includes('value="AV-CMD-2"'));
  r = await cer("/avize/nou", { user: CUBIFA, query: { comanda: "978002" } });
  bine("cine are bifa primește formularul completat (unitatea produsului, când linia n-are)", r.corp.includes('list="aviz-comenzi" value="AV-CMD-2"') && r.corp.includes('name="um[]" value="buc"') && r.corp.includes('name="cantitate[]" value="10"'));
  r = await cer("/avize/nou", { user: AGENT, query: { comanda: "999999999" } });
  bine("comandă care nu există: formularul obișnuit", r.cod === 200 && r.corp.includes("Aviz de însoțire nou"));

  curata();
  exec(`UPDATE setari_app SET valoare = '${contorVechi[0]}' WHERE cheie = 'aviz_serie'`);
  exec(`UPDATE setari_app SET valoare = '${contorVechi[1]}' WHERE cheie = 'aviz_urmator'`);
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); if (contorVechi.length === 2) { exec(`UPDATE setari_app SET valoare = '${contorVechi[0]}' WHERE cheie = 'aviz_serie'`); exec(`UPDATE setari_app SET valoare = '${contorVechi[1]}' WHERE cheie = 'aviz_urmator'`); } } catch (x) {}
  process.exit(1);
});
