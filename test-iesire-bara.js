"use strict";
// Ieșire marfă din CT-Park: butonul de scoatere stă sus și rămâne la vedere.
//
// CE A CERUT VALI, 11.11.2026, cu poza paginii (comanda #72, 250 de paleți în
// listă): „Butonul de validare și scoatere etichete să fie undeva sus, să nu
// trebuiască să scrolezi toată lista și să fie tocmai jos."
//
// CE APĂRĂ:
//   • BUTONUL E ȘI SUS, în același formular, deasupra listei de paleți, și
//     rămâne lipit sub capul paginii cât se derulează lista.
//   • LÂNGĂ EL SCRIE CÂȚI PALEȚI SUNT BIFAȚI; fără niciunul, butonul de sus e
//     stins.
//   • MOTIVUL PENTRU „PESTE RÂND" (obligatoriu când sari peste un palet mai
//     vechi) apare tot în bara de sus — jos, sub listă, nu l-ar vedea nimeni
//     și formularul ar părea că nu pleacă.
//   • BUTONUL DE JOS RĂMÂNE, iar pe telefon bara de sus nu se lipește (acolo e
//     deja lipit butonul de jos).
//
// Pe PostgreSQL real (port 5433), prin psql, și într-un browser.
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
for (const m of ["gata-productie", "ct-scaner", "ct-park"]) require(path.join(RAD, "modules", m + ".js")).register(router);

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
        par = Object.fromEntries(nume.map((n, i) => [n, m[i + 1]]));
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
const parametri = (r) => Object.fromEntries(new URL(unde(r), "http://erp.test").searchParams);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- datele de test ------------------------------------------------------
const fs = require("fs");
const PREFIX = "TIB";
const P1 = 98401, P2 = 98402;

function curata() {
  const pal = q(`SELECT id FROM ct_paleti WHERE produs_id IN (${P1}, ${P2}) OR cod LIKE '${PREFIX}-%'`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM produse WHERE id IN (${P1}, ${P2})`);
}
let nrPalet = 0;
function palet(produs, cant, data) {
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare, pret_unitar, pret_sursa)
     VALUES ('${PREFIX}-PAL-${String(++nrPalet).padStart(2, "0")}', ${produs}, ${cant}, ${cant}, 'buc', '${data}', 2, 'scris la intrare') RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar) VALUES (${id}, ${produs}, (SELECT denumire FROM produse WHERE id = ${produs}), ${cant}, 'buc', 2)`);
  return id;
}

(async () => {
  curata();
  const DEP = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "TIB Depozit", rol: "depozit", sectiuni: "" };
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P1}, '${PREFIX}-1', '${PREFIX} Folie de scos', 'buc'), (${P2}, '${PREFIX}-2', '${PREFIX} Banda de scos', 'buc')`);
  // 44 de paleți: destui ca lista să nu încapă pe un ecran.
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(palet(P1, 10 + i, `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`));
  const VECHI = palet(P2, 5, "2026-09-01"), NOU = palet(P2, 6, "2026-09-20");
  palet(P2, 7, "2026-09-25"); palet(P2, 8, "2026-09-26");

  console.log("\n1. Pagina");
  const pag = (await cer("get", "/stocuri/ct-park/iesire", DEP, { query: { q: PREFIX } })).corp;
  // Pentru o privire la pagină: SALVEAZA_PAGINA=/cale/pagina.html
  if (process.env.SALVEAZA_PAGINA) fs.writeFileSync(process.env.SALVEAZA_PAGINA, pag);
  const formular = (pag.match(/<form class="form" method="post" action="\/stocuri\/ct-park\/iesire"[\s\S]*?<\/form>/) || [""])[0];
  bine("lista are toți cei 44 de paleți de probă", (formular.match(/class="bifa-palet"/g) || []).length === 44, (formular.match(/class="bifa-palet"/g) || []).length);
  const iBara = formular.indexOf('id="bara-iesire"'), iTabel = formular.indexOf("<table"), iJos = formular.indexOf('<div class="form-actions">');
  bine("bara cu butonul e în formular, DEASUPRA listei de paleți", iBara > 0 && iTabel > iBara, [iBara, iTabel].join(" "));
  bine("…cu butonul de scoatere, care trimite formularul", /<button class="btn" type="submit" id="scoate-sus" disabled>Scoate paleții și tipărește etichetele →<\/button>/.test(formular.slice(iBara, iTabel)));
  bine("…și cu locul în care scrie câți paleți sunt bifați", /id="cati-bifati"[^>]*>niciun palet bifat — bifează în listă paleții care pleacă</.test(formular.slice(iBara, iTabel)));
  bine("motivul pentru „peste rând” e în bara de sus, o singură dată în pagină", formular.slice(iBara, iTabel).includes('id="camp-peste-rand"') && (pag.match(/id="camp-peste-rand"/g) || []).length === 1 && (pag.match(/name="peste_rand"/g) || []).length === 1);
  bine("butonul de jos a rămas la locul lui, sub listă", iJos > iTabel && /<button class="btn" type="submit">Scoate paleții și tipărește etichetele →<\/button>/.test(formular.slice(iJos)));
  const gol = (await cer("get", "/stocuri/ct-park/iesire", DEP, { query: { q: "nimic-cu-numele-asta-zzz" } })).corp;
  bine("fără niciun palet în listă nu apare nicio bară", !gol.includes('id="bara-iesire"') && gol.includes("Niciun palet care să semene"));

  console.log("\n2. În browser");
  {
    const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try {
      const deschide = async (latime, inaltime) => {
        const pg = await browser.newPage({ viewport: { width: latime, height: inaltime } });
        const st = { erori: [], trimise: [] };
        pg.on("pageerror", (e) => st.erori.push(String(e.message || e)));
        await pg.route("http://erp.test/**", async (rt) => {
          const u = new URL(rt.request().url());
          if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
          if (rt.request().method() === "POST") { st.trimise.push(rt.request().postData() || ""); return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>trimis</body></html>" }); }
          if (u.pathname === "/stocuri/ct-park/iesire") return rt.fulfill({ status: 200, contentType: "text/html", body: pag });
          return rt.fulfill({ status: 200, contentType: "text/plain", body: "" });
        });
        await pg.goto("http://erp.test/stocuri/ct-park/iesire");
        return Object.assign(st, { pg });
      };
      const masoara = (pg) => pg.evaluate(() => {
        const b = document.getElementById("bara-iesire").getBoundingClientRect();
        const cap = document.querySelector("header.topbar").getBoundingClientRect();
        const jos = document.querySelector(".form-actions").getBoundingClientRect();
        const but = document.getElementById("scoate-sus").getBoundingClientRect();
        return {
          sus: Math.round(b.top), jos: Math.round(b.bottom), capJos: Math.round(cap.bottom), inalt: window.innerHeight,
          butonVazut: but.top >= cap.bottom - 1 && but.bottom <= window.innerHeight && but.width > 100,
          // butonul de sus e chiar deasupra a tot ce e în punctul lui (nu sub alt strat)
          deasupra: document.elementFromPoint(but.left + but.width / 2, but.top + but.height / 2) === document.getElementById("scoate-sus"),
          butonJosVazut: jos.top < window.innerHeight && jos.bottom > 0,
          derulat: Math.round(window.scrollY), paginaInalta: document.documentElement.scrollHeight,
          text: document.getElementById("cati-bifati").textContent, stins: document.getElementById("scoate-sus").disabled,
          motiv: getComputedStyle(document.getElementById("camp-peste-rand")).display, motivObligatoriu: document.querySelector('[name="peste_rand"]').required,
        };
      });
      const d = await deschide(1300, 700);
      let m = await masoara(d.pg);
      bine("lista e mult mai înaltă decât ecranul (altfel proba n-ar arăta nimic)", m.paginaInalta > 3 * m.inalt, m.paginaInalta);
      egal("la deschidere: butonul de jos nu se vede, cel de sus e stins, niciun palet bifat", [m.butonJosVazut, m.stins, m.text], [false, true, "niciun palet bifat — bifează în listă paleții care pleacă"]);
      // La mijlocul listei și la capătul ei.
      await d.pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
      await d.pg.waitForTimeout(150);
      m = await masoara(d.pg);
      bine("derulat la mijlocul listei: bara stă lipită sub capul paginii", m.derulat > 1000 && Math.abs(m.sus - m.capJos) <= 1, JSON.stringify(m));
      bine("…cu butonul la vedere, deasupra listei, nu sub ea", m.butonVazut && m.deasupra, JSON.stringify(m));
      await d.pg.evaluate(() => { const b = document.querySelectorAll(".bifa-palet"); b[30].scrollIntoView({ block: "center" }); });
      await d.pg.check(`.bifa-palet[value="${ids[30]}"]`).catch(() => {});
      await d.pg.evaluate((v) => { const b = document.querySelector('.bifa-palet[value="' + v + '"]'); if (!b.checked) b.click(); }, ids[30]);
      m = await masoara(d.pg);
      egal("bifez un palet din mijlocul listei: bara îl numără și butonul se aprinde, fără să derulez înapoi", [m.text, m.stins, m.butonVazut], ["1 palet bifat", false, true]);
      await d.pg.evaluate((v) => { document.querySelector('.bifa-palet[value="' + v + '"]').click(); }, ids[31]);
      egal("încă unul", (await masoara(d.pg)).text, "2 paleți bifați");
      // Peste rând: bifez un palet deși rămâne unul mai vechi din aceeași marfă.
      await d.pg.evaluate((v) => { document.querySelector('.bifa-palet[value="' + v + '"]').click(); }, NOU);
      m = await masoara(d.pg);
      egal("sar peste un palet mai vechi: motivul apare în bara de sus, obligatoriu, la vedere", [m.motiv !== "none", m.motivObligatoriu, m.text, await d.pg.evaluate(() => { const r = document.querySelector('[name="peste_rand"]').getBoundingClientRect(); return r.top > 0 && r.bottom < window.innerHeight; })], [true, true, "3 paleți bifați", true]);
      await d.pg.evaluate(() => { document.querySelector('input[name="destinatie"][value="productie"]').checked = true; document.querySelector('input[name="destinatie"][value="productie"]').dispatchEvent(new Event("change", { bubbles: true })); });
      await d.pg.click("#scoate-sus");
      await d.pg.waitForTimeout(300);
      egal("fără motiv, butonul de sus nu trimite nimic", d.trimise.length, 0);
      await d.pg.fill('[name="peste_rand"]', "paletul vechi e blocat in spate");
      await d.pg.click("#scoate-sus");
      await d.pg.waitForTimeout(500);
      const trimis = new URLSearchParams(d.trimise[0] || "");
      egal("cu motiv: butonul de sus trimite formularul, cu paleții bifați, destinația și motivul", [d.trimise.length, trimis.getAll("paleti").sort(), trimis.get("destinatie"), trimis.get("peste_rand")], [1, [String(ids[30]), String(ids[31]), String(NOU)].sort(), "productie", "paletul vechi e blocat in spate"]);
      egal("nicio eroare de JavaScript", d.erori, []);
      await d.pg.close();

      // „Bifează toți" și debifarea.
      const t = await deschide(1300, 700);
      await t.pg.check("#bifa-toti");
      egal("„bifează toți”: bara îi numără pe toți", (await masoara(t.pg)).text, "44 paleți bifați");
      await t.pg.uncheck("#bifa-toti");
      egal("…și debifați: butonul de sus se stinge la loc", [(await masoara(t.pg)).text, (await masoara(t.pg)).stins], ["niciun palet bifat — bifează în listă paleții care pleacă", true]);
      await t.pg.close();

      // Pe telefon: butonul de jos e cel lipit; bara de sus stă la locul ei.
      const tel = await deschide(390, 780);
      const pozitii = await tel.pg.evaluate(() => [getComputedStyle(document.getElementById("bara-iesire")).position, getComputedStyle(document.querySelector(".form-actions")).position]);
      egal("pe telefon nu sunt două bare lipite: sus stă pe loc, jos e lipită", pozitii, ["static", "sticky"]);
      egal("telefon: nicio eroare de JavaScript", tel.erori, []);
      await tel.pg.close();
    } finally {
      await browser.close();
    }
  }

  curata();
  console.log(esecuri ? `\n${esecuri} eșecuri` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
