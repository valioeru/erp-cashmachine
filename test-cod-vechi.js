"use strict";
// Eticheta „cod vechi" la alegerea produsului și parcarea. PostgreSQL real.
//
// CEREREA LUI VALI, 17.11.2026: „Toate produsele vechi fără stoc să le marcăm
// (să apară, dar să fie marcate ca produs cu cod vechi, nu selecta); ulterior,
// dacă nu mai sunt folosite o lună de zile, le parchezi undeva și nici nu le
// mai sugerezi."
//
// CE APĂRĂ:
//   • Cod vechi = fără familie, netrecut ca „E bun așa", făcut de mai mult de
//     30 de zile. Cel fără stoc poartă eticheta; cel cu stoc, nu.
//   • Parcarea: doar după 17.12.2026, doar cod vechi fără stoc, nefolosit de
//     30 de zile; scoaterea din parcare ține loc de folosire.
//   • Produsul parcat nu mai apare la alegere — în afară de documentul pe
//     care e deja pus.
//   • Paginile: Cod vechi fără stoc, Parcate, „Parchează", „Scoate din parcare".
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, { PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp" });
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
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
  run: async (...p) => {
    const s = String(sql);
    if (/^\s*(UPDATE|DELETE)/i.test(s) && !/RETURNING/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const CV = require(path.join(RAD, "lib", "cod-vechi.js"));
const SP = require(path.join(RAD, "lib", "stoc-produse.js"));
const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
const MOD = require(path.join(RAD, "modules", "unificare-coduri.js"));
for (const m of ["stocuri", "comenzi", "comenzi-furnizor", "productie"]) require(path.join(RAD, "modules", m + ".js")).register(router);
MOD.register(router);
const CALE = MOD.CALE;

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97811, nume: "Vali Unificare", rol: "admin", email: "v.uc@test.ro" };
async function cer(cale, { metoda = "get", query = {}, body = {}, user = ADMIN } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params: {}, query, body, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";
const parametri = (r) => Object.fromEntries(new URLSearchParams(String(locatie(r)).split("?")[1] || ""));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d !== undefined ? ": " + String(d).slice(0, 500) : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));


const A = 97851, B = 97852, C = 97853, D = 97854, E = 97855, F1 = 97856, G = 97857, H = 97858;
const TOATE = "97851 AND 97869";
function curata() {
  for (const s of [
    `DELETE FROM comenzi_linii WHERE produs_id BETWEEN ${TOATE}`,
    "DELETE FROM comenzi WHERE numar LIKE 'TCV-%'",
    "DELETE FROM parteneri WHERE nume LIKE 'TCV %'",
    "DELETE FROM ct_paleti WHERE cod LIKE 'TCV-PAL-%'",
    `DELETE FROM produse WHERE id BETWEEN ${TOATE}`,
    "DELETE FROM utilizatori WHERE id = 97811",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const produs = (id) => q("SELECT * FROM produse WHERE id = ?", [id])[0] || {};
const curat = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

(async () => {
  console.log("── Socoteala, fără bază ─────────────────────────────────────");
  egal("zilele: parcarea începe la 30 de zile după etichetă", [CV.MARCAT_DE_LA, CV.PARCARE_DE_LA, CV.plusZile("2026-12-31", 1), CV.plusZile("2027-01-01", -30), CV.plusZile("prostie", 3)], ["2026-11-17", "2026-12-17", "2027-01-01", "2026-12-02", ""]);
  egal("produsul bun: cu familie sau trecut ca „E bun așa”", [CV.eBun({ cod_familie_id: 3 }), CV.eBun({ cod_vechi_exceptat: 1 }), CV.eBun({ exceptat: "1" }), CV.eBun({ cod_familie_id: null, cod_vechi_exceptat: 0 }), CV.eBun(null)], [true, true, true, false, false]);
  egal("proaspăt: făcut în ultimele 30 de zile; cel fără zi de naștere e de dinainte", [CV.eProaspat({ nascut_la: "2026-12-01" }, "2026-12-31"), CV.eProaspat({ nascut_la: "2026-11-30" }, "2026-12-31"), CV.eProaspat({ nascut_la: null }, "2026-12-31"), CV.eProaspat({}, "2026-12-31")], [true, false, false, false]);
  const P = [
    { id: 1 }, // vechi, nefolosit niciodată
    { id: 2 }, // vechi, folosit acum 31 de zile
    { id: 3 }, // vechi, folosit acum 30 de zile
    { id: 4, cod_familie_id: 2 }, // cu familie
    { id: 5, cod_vechi_exceptat: 1 }, // „E bun așa”
    { id: 6 }, // are stoc
    { id: 7, parcat_la: "2026-12-18" }, // deja parcat
    { id: 8, neparcat_la: "2026-12-25" }, // scos din parcare de curând
    { id: 9, neparcat_la: "2026-11-20" }, // scos din parcare demult
    { id: 10, nascut_la: "2026-12-20" }, // proaspăt
  ];
  const folosit = new Map([[2, "2026-11-30"], [3, "2026-12-01"], [9, "2026-11-01"]]);
  egal("ce se parchează pe 31.12: vechi, fără stoc, nefolosit de 30 de zile — nu cel bun, nu cel cu stoc, nu cel proaspăt, nu cel abia scos din parcare",
    CV.deParcat({ produse: P, cuStoc: new Set([6]), folosit, azi: "2026-12-31" }), [1, 2, 9]);
  egal("înainte de 17.12.2026 nu se parchează nimic; chiar în ziua aceea, da", [CV.deParcat({ produse: P, cuStoc: new Set([6]), folosit, azi: "2026-12-16" }), CV.deParcat({ produse: [{ id: 1 }], cuStoc: new Set(), folosit: new Map(), azi: "2026-12-17" })], [[], [1]]);
  egal("eticheta, în denumire", [CV.cuEticheta("Folie", { cod_vechi: true }), CV.cuEticheta("Folie", {}), CV.ETICHETA], ["Folie — COD VECHI — nu selecta", "Folie", "COD VECHI — nu selecta"]);

  curata();
  const FAM = Number((q("SELECT id, 1 AS x FROM cod_familii ORDER BY id LIMIT 1")[0] || { id: 1 }).id);
  for (const sql of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97811,'Vali Unificare','v.uc@test.ro','x','y','admin')",
    `INSERT INTO produse (id, cod, denumire, unitate_masura, cod_familie_id, cod_vechi_exceptat, nascut_la) VALUES
       (${A}, 'TCV-A', 'TCV vechi fara stoc nefolosit', 'buc', NULL, 0, NULL),
       (${B}, 'TCV-B', 'TCV vechi fara stoc folosit ieri', 'buc', NULL, 0, NULL),
       (${C}, 'TCV-C', 'TCV vechi cu stoc', 'buc', NULL, 0, NULL),
       (${D}, 'TCV-D', 'TCV cu familie', 'buc', ${FAM}, 0, NULL),
       (${E}, 'TCV-E', 'TCV trecut ca bun', 'buc', NULL, 1, NULL),
       (${G}, 'TCV-G', 'TCV vechi folosit demult', 'buc', NULL, 0, NULL)`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${F1}, 'TCV-F', 'TCV proaspat facut', 'buc')`,
    `INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare) VALUES ('TCV-PAL-1', ${C}, 10, 10, 'buc', '2026-11-10')`,
    "INSERT INTO parteneri (nume, tip) VALUES ('TCV Client', 'client')",
    "INSERT INTO comenzi (numar, partener_id, data, status) SELECT 'TCV-1', id, '2026-12-30', 'noua' FROM parteneri WHERE nume = 'TCV Client'",
    "INSERT INTO comenzi (numar, partener_id, data, status) SELECT 'TCV-2', id, '2026-10-01', 'noua' FROM parteneri WHERE nume = 'TCV Client'",
    `INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) SELECT id, ${B}, 1, 1 FROM comenzi WHERE numar = 'TCV-1'`,
    `INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) SELECT id, ${G}, 1, 1 FROM comenzi WHERE numar = 'TCV-2'`,
  ]) exec(sql);
  CV.goleste();

  console.log("\n── La alegerea produsului ───────────────────────────────────");
  egal("produsul făcut acum își primește singur ziua de naștere; cele de dinainte n-o au", [produs(F1).nascut_la === new Date().toISOString().slice(0, 10), produs(A).nascut_la], [true, null]);
  exec(`UPDATE produse SET nascut_la = '2026-12-20' WHERE id = ${F1}`); // de aici încolo zilele sunt cele din decembrie ale testului
  const lista = () => [A, B, C, D, E, F1, G].map((id) => ({ id, denumire: "x" + id }));
  let l = await CV.pentruAles(lista());
  egal("eticheta o poartă doar codul vechi fără stoc — nu cel cu stoc, nu cel cu familie, nu cel trecut ca bun, nu cel proaspăt", l.map((p) => [p.id, Boolean(p.cod_vechi)]), [[A, true], [B, true], [C, false], [D, false], [E, false], [F1, false], [G, true]]);
  egal("ultima folosire se citește din documente", [(await CV.folosite()).get(B), (await CV.folosite()).get(G), (await CV.folosite()).get(C), (await CV.folosite()).get(A)], ["2026-12-30", "2026-10-01", "2026-11-10", undefined]);

  console.log("\n── Parcarea de noapte ───────────────────────────────────────");
  const parcate = () => q(`SELECT id, parcat_la, parcat_fel FROM produse WHERE id BETWEEN ${TOATE} AND parcat_la IS NOT NULL ORDER BY id`).map((x) => [Number(x.id), x.parcat_la, x.parcat_fel]);
  await CV.parcheaza("2026-12-16");
  egal("pe 16.12.2026 nu parchează nimic", parcate(), []);
  await CV.parcheaza("2026-12-31");
  egal("pe 31.12: se parchează cel nefolosit și cel folosit demult; nu cel folosit ieri, nu cel cu stoc, nu cele bune, nu cel proaspăt", parcate(), [[A, "2026-12-31", "auto"], [G, "2026-12-31", "auto"]]);
  l = await CV.pentruAles(lista());
  egal("produsele parcate nu mai apar la alegere", l.map((p) => p.id), [B, C, D, E, F1]);
  l = await CV.pentruAles(lista(), [String(G)]);
  egal("…în afară de cel deja pus pe documentul care se modifică, care rămâne, cu eticheta", l.filter((p) => [A, G].includes(p.id)).map((p) => [p.id, Boolean(p.cod_vechi)]), [[G, true]]);
  await CV.scoateDinParcare(G, "2026-12-31");
  await CV.parcheaza("2027-01-05");
  egal("scos din parcare de om, nu se parchează la loc în zilele următoare…", parcate().map((x) => x[0]), [A]);
  await CV.parcheaza("2027-02-05");
  egal("…ci abia după alte 30 de zile nefolosit — atunci și cel care nu mai e proaspăt", parcate().map((x) => [x[0], x[2]]), [[A, "auto"], [B, "auto"], [F1, "auto"], [G, "auto"]]);
  exec(`UPDATE produse SET parcat_la = NULL, parcat_fel = NULL, neparcat_la = NULL WHERE id IN (${B}, ${G}, ${F1})`);
  exec(`UPDATE produse SET nascut_la = to_char(now(), 'YYYY-MM-DD') WHERE id = ${F1}`);
  CV.goleste();

  console.log("\n── Paginile de alegere ──────────────────────────────────────");
  let r = await cer("/stocuri/miscare/nou");
  bine("mișcare de stoc: codul vechi fără stoc are eticheta în listă, cel cu stoc nu, cel parcat lipsește",
    r.corp.includes(`<option value="${B}">TCV vechi fara stoc folosit ieri — COD VECHI — nu selecta</option>`) && r.corp.includes(`<option value="${C}">TCV vechi cu stoc</option>`) && !r.corp.includes(`<option value="${A}">`),
    (r.corp.match(/<option value="9785\d">[^<]*<\/option>/g) || []).join(" "));
  r = await cer("/comenzi/nou");
  const date = JSON.parse((r.corp.match(/var COMENZI_PRODUSE = (\[.*?\]);\n/) || [null, "[]"])[1]);
  egal("comandă nouă: produsele vin cu semnul de cod vechi, iar cel parcat lipsește", [A, B, C, D, F1].map((id) => { const p = date.find((x) => Number(x[0]) === id); return p ? p[9] : "lipsa"; }), ["lipsa", 1, 0, 0, 0]);
  bine("…și lista îl scrie cu roșu, „nu selecta”", r.corp.includes("rezultat-cod-vechi") && r.corp.includes("COD VECHI — nu selecta"));
  r = await cer("/procurement/comenzi/noua");
  const cf = JSON.parse((r.corp.match(/var CF_PRODUSE = (\[.*?\]);\n/) || [null, "[]"])[1]);
  egal("comandă la furnizor: la fel", [A, B, C].map((id) => { const p = cf.find((x) => Number(x[0]) === id); return p ? p[8] : "lipsa"; }), ["lipsa", 1, 0]);
  bine("…cu eticheta în lista browserului, nu în valoarea după care se regăsește produsul", r.corp.includes(`(p[8] ? ' label="COD VECHI — nu selecta"' : '')`) && cf.find((x) => Number(x[0]) === B)[1] === "TCV-B · TCV vechi fara stoc folosit ieri");

  console.log("\n── Configurări → Unificare coduri: cod vechi și parcate ─────");
  const CALE = MOD.CALE;
  r = await cer(CALE, { query: { parte: "vechi", q: "TCV" } });
  const idVechi = [...r.corp.matchAll(/<tr data-produs="(\d+)">/g)].map((m) => Number(m[1]));
  egal("„Cod vechi, fără stoc”: doar ele, cu ultima folosire", [idVechi.sort(), /30\.12\.2026/.test(r.corp), /01\.10\.2026/.test(r.corp), r.corp.includes("începând cu 17.12.2026")], [[B, G].sort(), true, true, true]);
  r = await cer(CALE, { query: { parte: "parcate", q: "TCV" } });
  egal("„Parcate”: cel parcat, cu ziua parcării și „Scoate din parcare”", [[...r.corp.matchAll(/<tr data-produs="(\d+)">/g)].map((m) => Number(m[1])), /31\.12\.2026/.test(r.corp), r.corp.includes("Scoate din parcare")], [[A], true, true]);
  const parcare = (id, pe) => cer(`${CALE}/parcare`, { metoda: "post", body: { produs_id: String(id), pe: String(pe) } });
  r = await parcare(C, 1);
  egal("produsul cu stoc nu se parchează", [/are stoc în CT-Park: nu se parchează/.test(parametri(r).eroare || ""), produs(C).parcat_la], [true, null]);
  r = await parcare(D, 1);
  egal("nici cel cu cod bun", [/are cod bun: nu se parchează/.test(parametri(r).eroare || ""), produs(D).parcat_la], [true, null]);
  r = await parcare(B, 1);
  egal("parcat de mână: iese de la alegere", [produs(B).parcat_fel, Boolean(produs(B).parcat_la), parametri(r).parte, (await CV.pentruAles(lista())).some((p) => p.id === B)], ["mana", true, "vechi", false]);
  r = await parcare(B, 0);
  egal("scos din parcare: apare din nou, cu eticheta", [produs(B).parcat_la, produs(B).neparcat_la === new Date().toISOString().slice(0, 10), parametri(r).parte, (await CV.pentruAles(lista())).filter((p) => p.id === B).map((p) => Boolean(p.cod_vechi))], [null, true, "parcate", [true]]);
  r = await parcare(999999999, 1);
  egal("produs care nu există: nu", /nu mai există/.test(parametri(r).eroare || ""), true);
  r = await cer(`${CALE}/excepta`, { metoda: "post", body: { produs_id: String(B), pe: "1", inapoi: "vechi" } });
  egal("„E bun așa” din lista celor vechi: codul lui nu mai e socotit vechi, la alegere n-are etichetă", [parametri(r).parte, (await CV.pentruAles(lista())).filter((p) => p.id === B).map((p) => Boolean(p.cod_vechi))], ["vechi", [false]]);
  r = await cer(CALE, { query: { q: "TCV" } });
  bine("…și e de acum o țintă bună: apare în lista din care se alege produsul în care intră cele vechi", r.corp.includes(`<option value="TCV-B — TCV vechi fara stoc folosit ieri">`) && r.corp.includes(`<option value="TCV-E — TCV trecut ca bun">`) && !r.corp.includes(`<option value="TCV-C — `));
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(E), nou: String(C) } });
  egal("produsul trecut ca bun nu se unifică într-unul cu cod vechi", /trecut ca „E bun așa” e cel care rămâne/.test(parametri(r).eroare || ""), true);

  curata();
  CV.goleste();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
