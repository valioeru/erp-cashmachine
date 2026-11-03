"use strict";
// Eticheta de ieșire din CT-Park: A4, cu cod de bare și denumirea întreagă.
//
// CE A CERUT VALI, 03.11.2026 (cu poza etichetei de 100 × 150 mm a paletului
// CT261030-0058, ieșit spre producție):
//   „Eticheta de aici să fie A4 și să conțină și cod de bare” ·
//   „Și să conțină și denumire produs complet, aceeași etichetă.”
//
// CE APĂRĂ:
//   • paletul ieșit primește o foaie A4 (@page A4), nu 100 × 150;
//   • codul de bare de jos e chiar codul paletului — benzile se citesc înapoi
//     și se compară cu Code 128 al codului, nu doar „există un SVG”;
//   • fiecare produs care a plecat are denumirea ÎNTREAGĂ, cantitatea și codul
//     de bare al produsului; la paletul mixt apar toate;
//   • la paletul golit prin ieșiri parțiale apare ce a plecat ultima dată
//     (ct_iesiri_linii), nu zero;
//   • un palet din care a plecat doar o parte stă pe raft: primește eticheta
//     de depozit, de 100 × 150, nu una de „IEȘIRE”;
//   • eticheta de depozit rămâne neschimbată (Zebra);
//   • pe o pagină amestecată, fiecare etichetă își cere foaia ei;
//   • „&” și „<” din denumire nu strică pagina.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
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
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});
const codbare = require(path.join(RAD, "lib", "codbare.js"));

const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "ct-park.js")).register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const res = () => {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b === undefined ? "" : String(b); };
  return o;
};
async function etichete(ids) {
  const r = res();
  await rute.get["/stocuri/ct-park/etichete"]({
    user: { id: 1, nume: "Vali", rol: "admin" }, params: {}, query: { paleti: ids.join(",") }, body: {}, res: r, req: { url: "/stocuri/ct-park/etichete" },
  });
  return r.corp;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function contine(eticheta, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !corp.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => corp.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta);
}
// Bucata de HTML a fiecărei etichete, în ordinea din pagină.
const bucatiEtichete = (html) => html.split(/(?=<div class="et(?: et-iesire)?">)/).slice(1);
// Codul de bare citit înapoi din SVG: dreptunghiurile negre → șirul de module.
function citesteBenzi(svg, modul, liniste) {
  const rect = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)" height="[\d.]+"\/>/g)];
  let biti = "";
  let poz = liniste;
  for (const m of rect) {
    const start = Math.round(Number(m[1]) / modul);
    const lat = Math.round(Number(m[2]) / modul);
    biti += "0".repeat(start - poz) + "1".repeat(lat);
    poz = start + lat;
  }
  return biti;
}

const LUNG = "Placa carton 780mm*565mm co5 — TEST cu o denumire foarte lungă, ca să se vadă că nu se taie nimic din ea la tipar";
const CURATENIE = [
  "DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id BETWEEN 97461 AND 97469)",
  "DELETE FROM ct_iesiri WHERE palet_id BETWEEN 97461 AND 97469",
  "DELETE FROM ct_ocupari WHERE palet_id BETWEEN 97461 AND 97469",
  "DELETE FROM ct_palet_linii WHERE palet_id BETWEEN 97461 AND 97469",
  "DELETE FROM ct_paleti WHERE id BETWEEN 97461 AND 97469",
  "DELETE FROM produse WHERE id BETWEEN 97451 AND 97459",
];

(async () => {
  for (const s of CURATENIE) exec(s);
  exec(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
          (97451, 'VPKTEST780565', ${lit(LUNG)}, 'buc'),
          (97452, 'FOLTEST23', 'Folie <stretch> & co TEST 23my', 'kg')`);
  exec(`INSERT INTO ct_paleti (id, cod, produs_id, produs_text, cantitate, um, lot, data_intrare, data_iesire) VALUES
          (97461, 'CT261030-9461', 97451, NULL, 580, 'buc', NULL, '2026-10-30', '2026-11-03'),
          (97462, 'CT261030-9462', NULL, '2 produse: amestec', 0, NULL, NULL, '2026-10-30', '2026-11-03'),
          (97463, 'CT261030-9463', NULL, '2 produse: rămas de dinainte', 0, NULL, 'L-77', '2026-10-30', '2026-11-03'),
          (97464, 'CT261030-9464', 97451, NULL, 300, 'buc', NULL, '2026-10-30', NULL),
          (97465, 'CT261030-9465', 97452, NULL, 250, 'kg', NULL, '2026-10-30', '2026-11-03')`);
  exec(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um) VALUES
          (97461, 97451, NULL, 580, 'buc'),
          (97462, 97451, NULL, 120, 'buc'), (97462, 97452, NULL, 40, 'kg'),
          (97463, 97451, NULL, 0, 'buc'), (97463, 97452, NULL, 0, 'kg'),
          (97464, 97451, NULL, 300, 'buc'),
          (97465, 97452, NULL, 250, 'kg')`);
  exec(`INSERT INTO ct_iesiri (id, palet_id, destinatie, adresa, data, creat_de, partiala, client, comanda_numar, comanda_data) VALUES
          (97471, 97461, 'productie', 'R1-02-3-3', '2026-11-03', 'Mirella', 0, NULL, NULL, NULL),
          (97472, 97462, 'fulfillment', 'R2-01-1-1', '2026-11-03', 'Mirella', 0, NULL, NULL, NULL),
          (97473, 97463, 'productie', 'R3-01-2-2', '2026-11-03', 'Mirella', 0, NULL, NULL, NULL),
          (97474, 97464, 'productie', 'R4-01-1-2', '2026-11-02', 'Mirella', 1, NULL, NULL, NULL),
          (97475, 97465, 'comanda', 'R5-01-1-1', '2026-11-03', 'Mirella', 0, 'CLIENT TEST SRL', 'CMD-77', '2026-11-01')`);
  exec(`INSERT INTO ct_iesiri_linii (iesire_id, produs_id, produs_text, cantitate, cantitate_ramasa, um) VALUES
          (97473, 97451, NULL, 100, 0, 'buc'), (97473, 97452, NULL, 5, 0, 'kg'),
          (97474, 97451, NULL, 200, 300, 'buc')`);

  // --- paletul ieșit întreg: A4, cod de bare, denumirea întreagă -------------
  let h = await etichete([97461]);
  contine("foaia e A4, nu 100 × 150", h, ["@page { size: A4; margin: 0; }", '<div class="et et-iesire">', "1 etichetă A4 de ieșire"], ["size: 100mm 150mm"]);
  contine("destinația, cine și de unde", h, ["Producție", "R1-02-3-3", "Mirella", "580 buc"]);
  contine("denumirea produsului e întreagă", h, [LUNG.replace(/&/g, "&amp;")]);
  if (/text-overflow|ellipsis|line-clamp/.test(h)) rau("pagina are reguli care pot tăia textul");
  else ok("nicio regulă care să taie denumirea (ellipsis / line-clamp)");
  const svgPalet = (h.match(/<svg class="cod-bare"[^>]*aria-label="cod de bare CT261030-9461"[\s\S]*?<\/svg>/) || [""])[0];
  if (!svgPalet) rau("lipsește codul de bare al paletului");
  else {
    const citit = citesteBenzi(svgPalet, 0.5, 10);
    if (citit !== codbare.benzi("CT261030-9461")) rau("codul de bare al paletului nu codifică CT261030-9461", citit.slice(0, 40));
    else ok("codul de bare de jos codifică exact CT261030-9461 (citit înapoi din benzi)");
  }
  const svgProdus = (h.match(/<svg class="cod-bare"[^>]*aria-label="cod de bare VPKTEST780565"[\s\S]*?<\/svg>/) || [""])[0];
  if (!svgProdus) rau("lipsește codul de bare al produsului");
  else if (citesteBenzi(svgProdus, 0.33, 10) !== codbare.benzi("VPKTEST780565")) rau("codul de bare al produsului nu codifică VPKTEST780565");
  else ok("codul de bare al produsului codifică exact VPKTEST780565");
  // Pe o foaie cu nume („page:”), Chrome rupe pagina înaintea fiecărui SVG de
  // tip block: eticheta ieșea pe trei foi A4 (văzut în PDF, 03.11.2026).
  contine("codurile de bare sunt inline-block, ca eticheta să stea pe o singură foaie", h,
    [".et-cod-produs .cod-bare, .et-jos-cod .cod-bare { display:inline-block"], [".cod-bare { display:block"]);
  contine("codul paletului e scris mare sub cod", h, ['<div class="et-cod-palet">CT261030-9461</div>', "Cod palet", "Cod produs"]);

  // --- paletul mixt: toate produsele ------------------------------------------
  h = await etichete([97462]);
  contine("paletul mixt arată ambele produse, cu cantități și coduri", h,
    [LUNG.replace(/&/g, "&amp;"), "Folie &lt;stretch&gt; &amp; co TEST 23my", "120 buc", "40 kg", "Produse pe palet", "et-marfa-cateva",
     'aria-label="cod de bare VPKTEST780565"', 'aria-label="cod de bare FOLTEST23"'],
    ["Folie <stretch>", "2 produse: amestec"]);

  // --- golit prin ieșiri parțiale: ce a plecat ultima dată ---------------------
  h = await etichete([97463]);
  const eta = bucatiEtichete(h)[0] || "";
  contine("paletul mixt golit prin ieșiri parțiale arată ce a plecat ultima dată, linie cu linie", eta,
    ["100 buc", "5 kg", "Folie &lt;stretch&gt; &amp; co TEST 23my", "L-77"], ['<div class="et-cant">—</div>', "2 produse: rămas de dinainte"]);

  // --- palet încă pe raft, după o ieșire parțială: eticheta de depozit --------
  h = await etichete([97464]);
  contine("paletul rămas pe raft primește eticheta de depozit", h,
    ["@page { size: 100mm 150mm; margin: 0; }", "CASH MACHINE · CT-PARK", "1 etichetă de 100 × 150 mm"],
    ['<div class="et et-iesire">', "CASH MACHINE · IEȘIRE"]);

  // --- ieșire pe comandă ----------------------------------------------------------
  h = await etichete([97465]);
  contine("pe comandă: clientul și comanda", h, ["CLIENT TEST SRL", "Comanda CMD-77", "01.11.2026", "250 kg"]);

  // --- pagina amestecată ------------------------------------------------------------
  h = await etichete([97461, 97464]);
  contine("pagina amestecată: fiecare etichetă își cere foaia", h,
    ["@page { size: 100mm 150mm; margin: 0; }", "@page eticheta-a4 { size: A4; margin: 0; }", "page:eticheta-a4",
     "1 etichetă de 100 × 150 mm + 1 etichetă A4 de ieșire"]);
  const bucati = bucatiEtichete(h);
  if (bucati.length !== 2 || !bucati[0].startsWith('<div class="et et-iesire">') || bucati[1].startsWith('<div class="et et-iesire">'))
    rau("pe pagina amestecată etichetele nu sunt cele așteptate", bucati.map((b) => b.slice(0, 30)).join(" | "));
  else ok("pe pagina amestecată: una A4 de ieșire, una de depozit");

  for (const s of CURATENIE) exec(s);
  console.log(rele ? "\n" + rele + " probleme." : "\nTotul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  for (const s of CURATENIE) { try { exec(s); } catch (x) { /* best-effort */ } }
  process.exit(1);
});
