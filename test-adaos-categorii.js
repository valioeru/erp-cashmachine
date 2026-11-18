"use strict";
// Adaosul pe categorie de produse și prețul de vânzare în „Stoc la zi".
// PostgreSQL real (baza de test de pe 5433).
//
// CE A CERUT VALI, 18.11.2026: „Adaos să fie pus pe categorie de produse și
// să afișeze prețul de vânzare inclusiv în stoc la zi, pe o coloană nouă."
//
// CE APĂRĂ:
//   • TREPTELE: adaosul propriu al produsului bate categoria; categoria bate
//     implicitul; fără niciunul, implicitul — ca până acum.
//   • CATEGORIA se potrivește fără să conteze literele mari/mici și spațiile.
//   • SALVAREA: doar administratorul; gol șterge adaosul categoriei; o valoare
//     care nu se poate citi nu strică ce era.
//   • PAGINA produselor arată formularul și „pe categorie" lângă adaos.
//   • STOC LA ZI are coloana „Preț vânzare", și pentru agent.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");
const RAD = __dirname;
const ENV = Object.assign({}, process.env, { PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp" });
const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  const out = execFileSync("psql", ["-X", "-q", "-A", "-t", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.split("\n").filter((l) => l !== "").map((l) => l.split("\x1f"));
}
function qo(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  const out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const L = out.split("\n").filter((l) => l !== "");
  if (!L.length) return [];
  const h = L[0].split(",");
  return L.slice(1).map((l) => { const c = l.split(","); const o = {}; h.forEach((k, j) => (o[k] = c[j] === "" || c[j] === undefined ? null : c[j].replace(/^"|"$/g, ""))); return o; });
}
process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => qo(sql, p),
  get: async (...p) => qo(sql, p)[0] || null,
  run: async (...p) => { q(sql, p); return { changes: 1 }; },
});
const PR = require(path.join(RAD, "modules", "produse.js"));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(e, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(e, "am " + a + ", așteptam " + b); else ok(e + " = " + b);
}
const bine = (e, c, d) => (c ? ok(e) : rau(e, d));

const rute = { get: {}, post: {} };
const router = { get: (c, h) => (rute.get[c] = h), post: (c, h) => (rute.post[c] = h) };
PR.register(router);
const res = () => { const o = { cod: 0, antet: {}, corp: "" }; o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; }; o.setHeader = () => {}; o.end = (b) => { o.corp = b || ""; }; return o; };
async function cer(metoda, cale, user, extra) {
  const r = res();
  await rute[metoda][cale](Object.assign({ user, params: {}, query: {}, body: {}, res: r, req: { url: cale, headers: {} } }, extra || {}));
  return r;
}
const ADMIN = { id: 98701, nume: "Vali Test", rol: "admin" };
const AGENT = { id: 98702, nume: "Agent Test", rol: "vanzari" };
const CAT = "ZZT Folie test adaos";
const curata = () => {
  q("DELETE FROM adaos_categorii WHERE LOWER(categorie) LIKE 'zzt %'");
  q("DELETE FROM produse WHERE id IN (98711, 98712, 98713)");
};

(async () => {
  console.log("── Treptele adaosului, fără bază ────────────────────────────");
  const peCat = new Map([["folie", 45]]);
  const P = (x) => Object.assign({ pret_achizitie: 100 }, x);
  egal("adaosul propriu bate categoria", PR.adaosProdus(P({ categorie: "Folie", adaos_lista: 10 }), 30, peCat), { valoare: 10, propriu: true, sursa: "propriu" });
  egal("categoria bate implicitul", PR.adaosProdus(P({ categorie: "Folie" }), 30, peCat), { valoare: 45, propriu: false, sursa: "categorie" });
  egal("literele mari și spațiile nu contează", PR.adaosProdus(P({ categorie: "  FOLIE " }), 30, peCat).valoare, 45);
  egal("categorie fără adaos: implicitul", PR.adaosProdus(P({ categorie: "Cutii" }), 30, peCat), { valoare: 30, propriu: false, sursa: "implicit" });
  egal("produs fără categorie: implicitul", PR.adaosProdus(P({}), 30, peCat).sursa, "implicit");
  egal("fără lista pe categorii merge ca înainte", PR.adaosProdus(P({ categorie: "Folie" }), 30), { valoare: 30, propriu: false, sursa: "implicit" });
  egal("adaos propriu zero rămâne zero, nu cade pe categorie", PR.adaosProdus(P({ categorie: "Folie", adaos_lista: 0 }), 30, peCat).valoare, 0);
  egal("preț de listă cu adaosul categoriei", PR.pretLista(P({ categorie: "Folie" }), 30, peCat), 145);
  egal("preț de listă fără cost: necunoscut", PR.pretLista({ categorie: "Folie" }, 30, peCat), null);
  egal("procent scris: virgulă, semnul %", [PR.procentScris("12,5"), PR.procentScris(" 40 % "), PR.procentScris(""), PR.procentScris("abc"), PR.procentScris("-3")], [12.5, 40, null, null, null].map((x, i) => (i >= 3 ? undefined : x)));

  console.log("── Salvarea pe categorii, în bază ───────────────────────────");
  curata();
  q("INSERT INTO produse (id, denumire, categorie, pret_achizitie, pret_vanzare, unitate_masura, activ) VALUES (98711, 'ZZT produs cu categorie', ?, 100, 160, 'buc', 1)", [CAT]);
  q("INSERT INTO produse (id, denumire, categorie, pret_achizitie, pret_vanzare, adaos_lista, unitate_masura, activ) VALUES (98712, 'ZZT produs cu adaos propriu', ?, 100, 0, 10, 'buc', 1)", [CAT]);
  q("INSERT INTO produse (id, denumire, categorie, pret_achizitie, pret_vanzare, unitate_masura, activ) VALUES (98713, 'ZZT produs alta categorie', 'ZZT Alta', 100, 0, 'buc', 1)");
  try {
    const corp = { n: "2", cat_0: CAT, adaos_0: "45", cat_1: "ZZT Alta", adaos_1: "" };
    let r = await cer("post", "/produse/adaos-categorii", AGENT, { body: corp });
    egal("agentul nu poate salva", [r.cod, q("SELECT COUNT(*) FROM adaos_categorii WHERE LOWER(categorie) LIKE 'zzt %'")[0][0]], [302, "0"]);
    r = await cer("post", "/produse/adaos-categorii", ADMIN, { body: corp });
    egal("administratorul salvează", [r.cod, q("SELECT categorie, adaos FROM adaos_categorii WHERE LOWER(categorie) LIKE 'zzt %' ORDER BY 1")], [302, [[CAT, "45"]]]);
    let m = await PR.adaosuriCategorii();
    egal("…și se citește înapoi", [m.get(CAT.toLowerCase()), m.has("zzt alta")], [45, false]);
    r = await cer("post", "/produse/adaos-categorii", ADMIN, { body: { n: "1", cat_0: CAT.toUpperCase(), adaos_0: "50,5" } });
    egal("aceeași categorie, alte litere: un singur rând, valoarea nouă", q("SELECT adaos FROM adaos_categorii WHERE LOWER(categorie) = ?", [CAT.toLowerCase()]), [["50.5"]]);
    r = await cer("post", "/produse/adaos-categorii", ADMIN, { body: { n: "1", cat_0: CAT, adaos_0: "mult" } });
    egal("o valoare care nu se poate citi nu strică ce era", q("SELECT adaos FROM adaos_categorii WHERE LOWER(categorie) = ?", [CAT.toLowerCase()]), [["50.5"]]);

    console.log("── Pagina produselor ────────────────────────────────────────");
    const pag = (await cer("get", "/produse", ADMIN, { query: { q: "ZZT produs" } })).corp;
    bine("formularul „Adaos pe categorii” e pe pagină", pag.includes('action="/produse/adaos-categorii"') && pag.includes("Adaos pe categorii"));
    bine("…cu categoria și adaosul ei completat", new RegExp('name="cat_\\d+" value="' + CAT + '"[\\s\\S]{0,200}name="adaos_\\d+" value="50.5"').test(pag));
    bine("lista spune „pe categorie” la produsul fără adaos propriu", /50\.5%<br><span[^>]*>pe categorie<\/span>/.test(pag));
    bine("…și prețul de listă e făcut cu adaosul categoriei (100 × 1,505)", /150,50/.test(pag), (pag.match(/ZZT produs cu categorie[\s\S]{0,900}/) || [""])[0].replace(/\s+/g, " ").slice(0, 500));
    bine("produsul cu adaos propriu rămâne pe al lui (110)", /110,00/.test(pag));
    bine("cel din altă categorie rămâne pe implicit", /<span[^>]*>implicit<\/span>/.test(pag));

    r = await cer("post", "/produse/adaos-categorii", ADMIN, { body: { n: "1", cat_0: CAT, adaos_0: "" } });
    egal("gol șterge adaosul categoriei", q("SELECT COUNT(*) FROM adaos_categorii WHERE LOWER(categorie) = ?", [CAT.toLowerCase()])[0][0], "0");
  } finally {
    curata();
  }

  console.log(rele ? "\n" + rele + " PROBLEME" : "\nToate verificările au trecut.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error(e); try { curata(); } catch (_) {} process.exit(1); });
