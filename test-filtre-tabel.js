"use strict";
// Filtrele ca în Excel din capul tabelului de comenzi. PostgreSQL real + Chromium.
//
// CEREREA LUI VALI, 06.11.2026, cu poza listei de comenzi: „Filtre te rog pe
// datele din capul de tabel."
//
// CE APĂRĂ:
//   • LISTA DE COMENZI are ▾ pe fiecare coloană, în afară de „Acțiuni", și bara
//     cu numărul de rânduri și totalul.
//   • BIFELE filtrează pe loc, se adună între coloane, iar lista unei coloane
//     arată doar ce trece de celelalte filtre.
//   • DATELE se bifează pe zi, nu pe oră; căutarea + Enter păstrează doar ce se
//     potrivește („11.2026" = noiembrie).
//   • CONFIRMATĂ DE PRODUCȚIE se filtrează după data ei, nu după nota de dedesubt.
//   • CLICUL PE ▾ NU SORTEAZĂ coloana.
//   • FILTRUL RĂMÂNE după reîncărcare (în aceeași fereastră) și se șterge dintr-un
//     buton; „toate în afară de" se ține ca listă de ascunse, deci o valoare
//     nouă se vede.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
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
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length }; },
});

const rute = { get: {}, post: {} };
const inreg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "comenzi.js")).register(inreg);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const PART = [98711, 98712, 98713];
const COM = [98721, 98722, 98723, 98724, 98725];
function curata() {
  q(`DELETE FROM comenzi_productie WHERE comanda_id IN (${COM.join(",")})`);
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${COM.join(",")})`);
  q(`DELETE FROM comenzi WHERE id IN (${COM.join(",")})`);
  q(`DELETE FROM parteneri WHERE id IN (${PART.join(",")})`);
}

(async () => {
  curata();
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (98711, 'client', 'TFT Alfa SRL'), (98712, 'client', 'TFT Beta SRL'), (98713, 'client', 'TFT Gama SRL')`);
  const prod = Number(unul("SELECT id FROM produse ORDER BY id LIMIT 1"));
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status, data_livrare_ceruta) VALUES
       (98721, 98711, 'TFT-1', '2099-11-04 09:00:00', 'livrata', '2099-11-05'),
       (98722, 98711, NULL,    '2099-11-04 15:39:00', 'in_productie', '2099-11-12'),
       (98723, 98712, 'TFT-3', '2099-10-28 10:00:00', 'in_productie', '2099-10-30'),
       (98724, 98712, 'TFT-4', '2099-11-05 08:00:00', 'noua', NULL),
       (98725, 98713, 'TFT-5', '2099-11-05 12:00:00', 'livrata', '2099-11-06')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES
       (98721, ?, 1, 100), (98722, ?, 2, 100), (98723, ?, 1, 1000), (98724, ?, 3, 10), (98725, ?, 1, 50.5)`, [prod, prod, prod, prod, prod]);
  // Două comenzi de producție pe 98722: „cea mai târzie din 2" stă sub dată.
  q(`INSERT INTO comenzi_productie (numar, comanda_id, status, data_livrare) VALUES ('TFT-P1', 98722, 'noua', '2099-11-10'), ('TFT-P2', 98722, 'noua', '2099-11-11')`);

  const VALI = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali Test", rol: "admin" };
  const r = { cod: 0, antet: null, corp: "" };
  r.writeHead = (c, h) => { r.cod = c; r.antet = h; return r; };
  r.setHeader = () => {};
  r.end = (b) => { r.corp = b || ""; };
  await rute.get["/comenzi"]({ user: VALI, params: {}, query: { perioada: "custom", de_la: "2099-10-01", pana_la: "2099-11-30" }, body: {}, res: r, req: { url: "/comenzi" } });
  const pagina = r.corp;

  console.log("\n1. Pagina");
  bine("tabelul de comenzi cere filtre", pagina.includes('data-filtre="comenzi"'));
  bine("bara cu numărul și totalul stă deasupra lui", pagina.indexOf('data-filtre-pentru="comenzi"') < pagina.indexOf('data-filtre="comenzi"') && pagina.includes("Șterge filtrele"));
  bine("scriptul filtrelor e pe pagină", pagina.includes("filtre-tabel:"));
  bine("…dar nu și pe paginile fără filtre", !require(path.join(RAD, "lib", "render.js")).layout({ title: "x", active: "/", body: "<p>x</p>", user: VALI }).includes("filtre-tabel:"));

  const { chromium } = require("playwright");
  const fs = require("fs");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const p = await ctx.newPage();
    await p.route("http://erp.test/**", (rt) => {
      const u = rt.request().url();
      if (u.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      return rt.fulfill({ status: 200, contentType: "text/html", body: pagina });
    });
    await p.goto("http://erp.test/comenzi");
    const vazute = () => p.$$eval("table[data-filtre] tbody tr", (rs) => rs.filter((r) => r.style.display !== "none" && !r.classList.contains("filtre-gol")).map((r) => r.cells[0].textContent.trim()));
    const bara = () => p.$eval('[data-filtre-pentru="comenzi"]', (b) => b.innerText.replace(/\s+/g, " ").trim());
    const coloana = (nume) => p.$$eval("table[data-filtre] thead th", (ths, n) => ths.findIndex((th) => th.textContent.replace("▾", "").trim() === n), nume);
    const deschide = async (nume) => {
      const i = await coloana(nume);
      await p.click(`table[data-filtre] thead th:nth-child(${i + 1}) .filtru-btn`);
      await p.waitForSelector(".filtru-pop");
    };
    const valoriLista = () => p.$$eval(".filtru-pop .filtru-lista label", (ls) => ls.map((l) => l.querySelector(".filtru-v").textContent + "=" + l.querySelector(".filtru-n").textContent));
    const comuta = async (val) => {
      await p.$$eval(".filtru-pop .filtru-lista label", (ls, v) => { const l = ls.find((x) => x.querySelector(".filtru-v").textContent === v); l.querySelector("input").click(); }, val);
    };

    console.log("\n2. Capul tabelului");
    egal("▾ pe fiecare coloană, în afară de „Acțiuni”", await p.$$eval("table[data-filtre] thead th", (ths) => ths.map((th) => Boolean(th.querySelector(".filtru-btn")))), [true, true, true, true, true, true, true, false]);
    egal("fără filtru se văd toate cele 5 comenzi", (await vazute()).length, 5);
    bine("bara: 5 rânduri și totalul lor", /5 rânduri/.test(await bara()) && /Total: 1\.380,50 lei/.test(await bara()), await bara());
    const ordine = await vazute();
    await deschide("Client");
    egal("clicul pe ▾ nu sortează", await vazute(), ordine);

    console.log("\n3. Bifele");
    egal("lista clienților, cu câte comenzi are fiecare", await valoriLista(), ["TFT Alfa SRL=2", "TFT Beta SRL=2", "TFT Gama SRL=1"]);
    await comuta("TFT Gama SRL");
    egal("Gama debifat → se văd celelalte 4", (await vazute()).length, 4);
    bine("bara: „Se văd 4 din 5”, cu totalul celor 4", /Se văd 4 din 5/.test(await bara()) && /Total afișat: 1\.330,00 lei/.test(await bara()), await bara());
    bine("▾ de la Client arată că filtrează", await p.$eval(`table[data-filtre] thead th:nth-child(${(await coloana("Client")) + 1}) .filtru-btn`, (b) => b.classList.contains("activ")));
    await p.keyboard.press("Escape");
    bine("Escape închide fereastra filtrului", !(await p.$(".filtru-pop")));
    await deschide("Status");
    egal("la Status: doar statusurile clienților rămași", await valoriLista(), ["în producție=2", "livrată=1", "nouă=1"]);
    await comuta("livrată");
    await comuta("nouă");
    egal("Status doar „în producție” + fără Gama → 2 comenzi", (await vazute()).sort(), ["#98722", "TFT-3"].sort());
    await p.click(".filtru-pop .filtru-ok");
    await deschide("Status");
    egal("redeschis, Status își arată și valorile debifate, cu câte rânduri au", await valoriLista(), ["în producție=2", "livrată=1", "nouă=1"]);
    await p.keyboard.press("Escape");

    console.log("\n4. Datele");
    await p.click('[data-filtre-pentru="comenzi"] [data-sterge]');
    egal("„Șterge filtrele” → toate 5 din nou", (await vazute()).length, 5);
    await deschide("Data");
    egal("la Data: zilele, cea mai nouă sus, fără oră", await valoriLista(), ["05.11.2099=2", "04.11.2099=2", "28.10.2099=1"]);
    await p.fill(".filtru-pop .filtru-cauta", "11.2099");
    await p.press(".filtru-pop .filtru-cauta", "Enter");
    egal("„11.2099” + Enter → doar noiembrie", (await vazute()).length, 4);
    bine("…și fereastra s-a închis", !(await p.$(".filtru-pop")));
    await deschide("Confirmată de producție");
    const conf = await valoriLista();
    bine("Confirmată de producție: data, nu nota „cea mai târzie din 2”", conf.some((x) => x.startsWith("11.11.2099=")) && !conf.some((x) => /cea mai/.test(x)), conf);
    await p.keyboard.press("Escape");

    console.log("\n5. Ținut minte");
    await deschide("Client");
    await comuta("TFT Alfa SRL");
    await p.keyboard.press("Escape");
    const inainte = (await vazute()).sort();
    await p.reload();
    egal("după reîncărcare, aceleași comenzi", (await vazute()).sort(), inainte);
    const stocat = await p.evaluate(() => JSON.parse(sessionStorage.getItem("filtre-tabel:comenzi")));
    bine("„toate în afară de Alfa” se ține ca ascunse, nu ca bifate", stocat && Object.values(stocat).some((f) => f.out && f.out.length === 1 && f.out[0] === "TFT Alfa SRL"), JSON.stringify(stocat));
    await p.click('[data-filtre-pentru="comenzi"] [data-sterge]');
    egal("„Șterge filtrele” golește și ce s-a ținut minte", await p.evaluate(() => sessionStorage.getItem("filtre-tabel:comenzi")), "{}");

    console.log("\n6. Nimic potrivit");
    await deschide("Status");
    await p.click(".filtru-pop .filtru-tot input");
    bine("totul debifat → rândul „Niciun rând nu se potrivește”", await p.$eval("tr.filtre-gol", (r) => r.textContent.includes("Niciun rând nu se potrivește")).catch(() => false));
    await p.click(".filtru-pop .filtru-goleste");
    egal("„Șterge filtrul” din fereastră → toate", (await vazute()).length, 5);
    await p.screenshot({ path: path.join(RAD, "..", "scan-lab", "filtre.png") }).catch(() => null);
    await ctx.close();
  } finally {
    await browser.close();
  }

  curata();
  console.log(esecuri ? `\n${esecuri} verificări au căzut.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
