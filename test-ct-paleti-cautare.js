"use strict";
// Căutarea în lista de paleți din CT-Park (Depozit → Paleți în depozit).
//
// Vali, 10.11.2026, cu poza listei de 246 de paleți: „Fă te rog un box de
// căutare după denumire în pagina asta."
//
// Ce se verifică:
//   1. pagina are căsuța de căutare, iar fără nimic scris arată toți paleții;
//   2. căutarea după denumire nu ține cont de litere mari, de diacritice și de
//      ordinea cuvintelor; găsește și marfa scrisă liber, și paletul cu mai
//      multe produse, după oricare din ele;
//   3. merge și codul produsului, codul paletului și lotul;
//   4. „%" și „_" se caută ca atare, nu ca „orice";
//   5. paleții scoși apar doar cu „Arată și paleții scoși", iar căutarea se
//      păstrează când treci de la una la alta;
//   6. cifrele de sus (câți paleți, valoarea) sunt ale celor găsiți;
//   7. în browser: rândurile se filtrează pe loc, pe măsură ce scrii.
//
// Pe baza Postgres locală (port 5433), cu pagina adevărată, plus Chromium.
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
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); } };
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

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
// În ordinea din server.js.
for (const m of ["avize", "gata-productie", "ct-scaner", "ct-park"]) require(path.join(RAD, "modules", m + ".js")).register(router);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query } = {}) {
  let h = rute[metoda][cale];
  let par = {};
  if (!h) {
    for (const [tipar, fn] of Object.entries(rute[metoda])) {
      const re = new RegExp("^" + tipar.replace(/:[^/]+/g, "([^/]+)") + "$");
      const m = re.exec(cale);
      if (m) {
        const nume = (tipar.match(/:[^/]+/g) || []).map((x) => x.slice(1));
        par = Object.fromEntries(nume.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        h = fn;
        break;
      }
    }
  }
  if (!h) throw new Error("nicio rută pentru " + metoda + " " + cale);
  const r = res();
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase(), headers: {} } });
  return r;
}
const unde = (r) => String((r.antet && r.antet.Location) || "");
const adresa = (r) => new URL(unde(r), "http://erp.test");
const parametri = (r) => Object.fromEntries(adresa(r).searchParams);
// Urmează redirecționarea unei cereri GET, cum face browserul.
async function urmeaza(r, user) {
  const u = adresa(r);
  return cer("get", u.pathname, user, { query: Object.fromEntries(u.searchParams) });
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
const azi = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 10);

// ---- datele de test ------------------------------------------------------
const PREFIX = "TCP";
const P1 = 97901, P2 = 97902;
const PAL = (n) => 97910 + n;
const ADMIN = { id: 1, nume: "Vali Test", rol: "admin", sectiuni: "" };
const CALE = "/stocuri/ct-park/paleti";

function curata() {
  q(`DELETE FROM ct_palet_linii WHERE palet_id BETWEEN ${PAL(1)} AND ${PAL(9)}`);
  q(`DELETE FROM ct_paleti WHERE id BETWEEN ${PAL(1)} AND ${PAL(9)}`);
  q(`DELETE FROM produse WHERE id IN (${P1}, ${P2})`);
}
// Codurile paleților noștri de pe pagină, în ordinea de acolo.
function coduri(html) {
  return [...html.matchAll(/<a href="\/stocuri\/ct-park\/palet\/(\d+)">/g)].map((m) => Number(m[1])).filter((id) => id >= PAL(1) && id <= PAL(9)).sort((a, b) => a - b);
}
const cauta = async (text, extra) => (await cer("get", CALE, ADMIN, { query: Object.assign(text === null ? {} : { q: text }, extra || {}) })).corp;

(async () => {
  curata();
  try {
    await ruleaza();
  } finally {
    curata();
  }
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function ruleaza() {
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P1}, '${PREFIX}-BND5', '${PREFIX} Bandă PET 5mm 6000ml albă', 'buc'), (${P2}, '${PREFIX}-LAD', '${PREFIX} Lădiță umedă mare Aquila', 'buc')`);
  // 1: bandă, pe produs. 2: lădiță, pe produs, cu lot. 3: marfă scrisă liber.
  // 4: palet cu două produse (rezumatul lui e text, liniile sunt bandă + lădiță).
  // 5: bandă, scos din depozit. 6: o denumire cu „%" și „_" în ea.
  q(`INSERT INTO ct_paleti (id, cod, produs_id, produs_text, cantitate, um, lot, data_intrare, data_iesire, pret_unitar) VALUES
       (${PAL(1)}, 'CT991001-97911', ${P1}, NULL, 100, 'buc', NULL, '2026-10-30', NULL, 2),
       (${PAL(2)}, 'CT991001-97912', ${P2}, NULL, 200, 'buc', 'TCP-LOT-77', '2026-10-30', NULL, 5),
       (${PAL(3)}, 'CT991001-97913', NULL, '${PREFIX} Placă carton CO5 alb', 250, 'buc', NULL, '2026-10-30', NULL, NULL),
       (${PAL(4)}, 'CT991001-97914', NULL, '${PREFIX} palet mixt', 30, 'buc', NULL, '2026-10-30', NULL, NULL),
       (${PAL(5)}, 'CT991001-97915', ${P1}, NULL, 50, 'buc', NULL, '2026-10-01', '2026-10-20', 2),
       (${PAL(6)}, 'CT991001-97916', NULL, '${PREFIX} Folie 100% reciclată tip_A', 10, 'kg', NULL, '2026-10-30', NULL, NULL)`);
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar) VALUES
       (${PAL(1)}, ${P1}, NULL, 100, 'buc', 2), (${PAL(2)}, ${P2}, NULL, 200, 'buc', 5),
       (${PAL(3)}, NULL, '${PREFIX} Placă carton CO5 alb', 250, 'buc', NULL),
       (${PAL(4)}, ${P1}, NULL, 10, 'buc', 2), (${PAL(4)}, ${P2}, NULL, 20, 'buc', 5),
       (${PAL(5)}, ${P1}, NULL, 50, 'buc', 2),
       (${PAL(6)}, NULL, '${PREFIX} Folie 100% reciclată tip_A', 10, 'kg', NULL)`);

  console.log("1. Căsuța de căutare");
  const tot = await cauta(null);
  bine("pagina are căsuța de căutare după denumire", /<input type="search" name="q" id="cauta-paleti"[^>]*placeholder="Caută după denumire/.test(tot));
  egal("fără nimic scris: toți paleții din depozit", coduri(tot), [1, 2, 3, 4, 6].map(PAL));
  bine("fără căutare nu apare „Arată tot”", !/>Arată tot<\/a>/.test(tot));

  console.log("\n2. După denumire");
  egal("„banda”: fără diacritice și cu litere mici — paletul de bandă și cel mixt", coduri(await cauta("tcp banda")), [PAL(1), PAL(4)]);
  egal("„BANDĂ PET”: cu litere mari și diacritice, la fel", coduri(await cauta("TCP BANDĂ PET")), [PAL(1), PAL(4)]);
  egal("„pet tcp banda”: ordinea cuvintelor nu contează", coduri(await cauta("pet tcp banda")), [PAL(1), PAL(4)]);
  egal("„tcp ladita aquila”: paletul de lădiță și cel mixt (are lădiță pe o linie)", coduri(await cauta("tcp ladita aquila")), [PAL(2), PAL(4)]);
  egal("„tcp banda ladita”: amândouă cuvintele — doar paletul mixt", coduri(await cauta("tcp banda ladita")), [PAL(4)]);
  egal("marfa scrisă liber se găsește și ea", coduri(await cauta("tcp placa carton")), [PAL(3)]);
  egal("un cuvânt care nu e nicăieri: nimic", coduri(await cauta("tcp banda inexistent")), []);
  const nimic = await cauta("tcp-nu-exista");
  bine("…cu mesaj și drum spre paleții scoși", /Niciun palet în depozit cu „tcp-nu-exista”/.test(nimic) && /href="\/stocuri\/ct-park\/paleti\?toate=1&q=tcp-nu-exista"/.test(nimic));
  const gasit = await cauta("tcp banda");
  bine("ce ai căutat rămâne în căsuță, cu „Arată tot” alături", /name="q" id="cauta-paleti" value="tcp banda"/.test(gasit) && /<a class="btn secondary small" href="\/stocuri\/ct-park\/paleti">Arată tot<\/a>/.test(gasit));
  bine("…și spune câți a găsit", /2 paleți găsiți pentru „tcp banda”/.test(gasit));

  console.log("\n3. Codul produsului, codul paletului, lotul");
  egal("codul produsului", coduri(await cauta("tcp-lad")), [PAL(2)]);
  egal("codul paletului", coduri(await cauta("ct991001-97913")), [PAL(3)]);
  egal("lotul", coduri(await cauta("tcp-lot-77")), [PAL(2)]);

  console.log("\n4. „%” și „_” se caută ca atare");
  egal("„tcp 100%”: doar denumirea care are „100%” în ea", coduri(await cauta("tcp 100%")), [PAL(6)]);
  egal("„tip_a”: doar denumirea cu liniuța de jos", coduri(await cauta("tcp tip_a")), [PAL(6)]);
  egal("„tcp %”: nu înseamnă „orice”", coduri(await cauta("tcp %")), [PAL(6)]);
  egal("„tcp b_nda”: „_” nu ține loc de o literă", coduri(await cauta("tcp b_nda")), []);

  console.log("\n5. Paleții scoși");
  egal("paletul scos nu apare la căutarea obișnuită", coduri(await cauta("tcp banda")).includes(PAL(5)), false);
  const cuScosi = await cauta("tcp banda", { toate: "1" });
  egal("…dar apare cu „Arată și paleții scoși”", coduri(cuScosi), [PAL(1), PAL(4), PAL(5)]);
  bine("căutarea se păstrează între cele două", /<input type="hidden" name="toate" value="1">/.test(cuScosi) && /href="\/stocuri\/ct-park\/paleti\?q=tcp%20banda">Doar paleții din depozit/.test(cuScosi) && /href="\/stocuri\/ct-park\/paleti\?toate=1&q=tcp%20banda">Arată și paleții scoși/.test(gasit));

  console.log("\n6. Cifrele de sus sunt ale celor găsiți");
  const carduri = (html) => [...html.matchAll(/<div class="label">([^<]*)<\/div><div class="value">([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]);
  const valoare = (html) => ((html.match(/<div class="label">Valoarea lor<\/div>\s*<div class="value">([^<]*)</) || [])[1] || "").replace(/\s+/g, " ");
  egal("„tcp ladita”: 2 paleți găsiți", carduri(await cauta("tcp ladita"))[0], ["Paleți găsiți, în depozit", "2"]);
  // Din 11.11.2026 valoarea unui palet se socotește din liniile lui: paletul
  // mixt n-are preț pe rezumat, dar liniile lui au (10 × 2 + 20 × 5).
  egal("…cu valoarea lor: 200 × 5, plus paletul mixt socotit din liniile lui", valoare(await cauta("tcp ladita")), "1.120,00 lei");
  bine("fără căutare, eticheta rămâne „Paleți în depozit”", /<div class="label">Paleți în depozit<\/div>/.test(tot) && /<div class="label">Valoarea stocului<\/div>/.test(tot));

  console.log("\n7. În browser: filtrarea pe loc");
  const { chromium } = require("playwright");
  const fs = require("fs");
  const br = await chromium.launch();
  try {
    const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/style.css") return route.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(RAD, "public", "style.css")) });
      if (u.pathname !== CALE) return route.fulfill({ status: 204, body: "" });
      const r = await cer("get", CALE, ADMIN, { query: Object.fromEntries(u.searchParams) });
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: r.corp });
    });
    await page.goto("http://erp.test" + CALE);
    const vazute = () =>
      page.evaluate(([de, pana]) => [...document.querySelectorAll("table.table tbody tr")].filter((r) => r.style.display !== "none").map((r) => { const a = r.querySelector('a[href^="/stocuri/ct-park/palet/"]'); return a ? Number(a.getAttribute("href").split("/").pop()) : 0; }).filter((id) => id >= de && id <= pana).sort((a, b) => a - b), [PAL(1), PAL(9)]);
    await page.fill("#cauta-paleti", "tcp LĂDIȚĂ");
    egal("scriu „tcp LĂDIȚĂ”: rămân paletul de lădiță și cel mixt, fără reîncărcare", await vazute(), [PAL(2), PAL(4)]);
    bine("pagina nu s-a reîncărcat", !new URL(page.url()).searchParams.has("q"));
    bine("…și scrie câte rânduri au rămas", /^\d+ din \d+ de pe pagină — Enter caută în tot depozitul$/.test((await page.textContent("#cate-paleti")).trim()), await page.textContent("#cate-paleti"));
    await page.fill("#cauta-paleti", "carton  tcp");
    egal("alt text: se schimbă pe loc", await vazute(), [PAL(3)]);
    await page.fill("#cauta-paleti", "tcp-bnd5");
    egal("codul produsului, care nu se vede pe rând: tot pe loc", await vazute(), [PAL(1), PAL(4)]);
    await page.fill("#cauta-paleti", "");
    egal("căsuța golită: toate rândurile înapoi", await vazute(), [1, 2, 3, 4, 6].map(PAL));
    await page.fill("#cauta-paleti", "tcp banda");
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => u.searchParams.get("q") === "tcp banda");
    egal("Enter: caută pe server, în tot depozitul", await vazute(), [PAL(1), PAL(4)]);
  } finally {
    await br.close();
  }
}
