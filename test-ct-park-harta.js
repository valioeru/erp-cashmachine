"use strict";
// Harta rândului din CT-Park: alegerea locurilor cu degetul.
// Pe PostgreSQL real (prin psql).
//
// Pana acum locurile OCUPATE erau linkuri (click → vezi ce e pe paleta), iar
// cele LIBERE erau div-uri moarte: se vedea ca sunt libere si atat. Ca sa pui
// marfa, scriai „randul preferat" intr-o lista derulanta si ERP-ul iti
// propunea el niste locuri — nu neaparat raftul la care te gandeai.
//
// CE APARA:
//
//   • PE UN LOC LIBER SE POATE DA CLICK. Daca redevine div, tot ecranul asta
//     nu mai are rost.
//
//   • CE AI ALES SE FOLOSESTE EXACT. Daca propunerea automata ar rula peste
//     alegerea ta, marfa ar ajunge in alt raft decat cel aratat cu degetul —
//     si a doua oara nimeni n-ar mai folosi harta.
//
//   • LOCURILE LIPITE FAC O PALETA LATA, cele razlete fac paleti separati.
//
//   • UN LOC OCUPAT INTRE TIMP NU SE SUPRASCRIE. Intre click si salvare pot
//     trece zece minute, iar altcineva poate pune marfa acolo. Un palet
//     peste altul, in baza, nu se vede pana la inventar.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

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

const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "ct-park.js")).register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, { params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 240) : "")); esecuri++; }
}

const NUMAR_TEST = 99;
function curata() {
  const r = unul("SELECT id FROM ct_randuri WHERE numar = " + NUMAR_TEST);
  if (r) {
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
  q("DELETE FROM ct_paleti WHERE produs_text = 'TEST-HARTA'");
}

(async () => {
  curata();
  // Un rand de test: 3 campuri x 2 niveluri x 3 locuri pe nivel = 18 locuri.
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR_TEST}, 'rand de test', 3, 2, 3, 800, 1200, 1)`);
  const rand = Number(unul("SELECT id FROM ct_randuri WHERE numar = " + NUMAR_TEST));
  for (let nivel = 1; nivel <= 2; nivel++)
    for (let camp = 1; camp <= 3; camp++)
      for (let poz = 1; poz <= 3; poz++)
        q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat)
           VALUES (${rand}, ${nivel}, ${camp}, ${poz}, 'TH-${nivel}-${camp}-${poz}', 0)`);

  console.log("\n1. Pe locurile libere se poate da click");
  {
    const p = await cer("/stocuri/ct-park/rand/:id", { params: { id: String(rand) } });
    bine("harta rândului se deschide", p.cod === 200);
    // Asta e inima schimbarii: locul liber e o casuta, nu un div mort.
    const casute = (p.corp.match(/<input type="checkbox" name="loc"/g) || []).length;
    bine("toate cele 18 locuri libere sunt bifabile", casute === 18, casute);
    bine("sunt într-un formular care duce la intrarea de marfă", /action="\/stocuri\/ct-park\/intrare"/.test(p.corp));
    bine("cu rândul dus mai departe", new RegExp('name="rand" value="' + rand + '"').test(p.corp));
    bine("și o bară care apare după ce alegi", /id="bara-locuri"/.test(p.corp));
    bine("legenda spune ce se poate face", /Click pe un loc <strong>liber<\/strong>/.test(p.corp));
    // Fiecare casuta stie unde e, ca bara sa poata spune daca sunt lipite.
    bine("fiecare loc își știe nivelul, câmpul și poziția", /data-nivel="1" data-camp="1" data-pozitie="1"/.test(p.corp));
  }

  const loc = (nivel, camp, poz) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND nivel=${nivel} AND camp=${camp} AND pozitie=${poz}`));

  console.log("\n2. Locurile alese ajung pe pagina de intrare");
  {
    const a = loc(1, 2, 1), b2 = loc(1, 2, 2);
    const p = await cer("/stocuri/ct-park/intrare", { query: { rand: String(rand), locuri: a + "," + b2 } });
    bine("pagina se deschide", p.cod === 200);
    bine("și spune că locurile vin de pe hartă", /2 locuri alese de pe hartă/.test(p.corp), (p.corp.match(/locuri alese[^<]*/) || [])[0]);
    bine("cu adresele lor", /TH-1-2-1/.test(p.corp) && /TH-1-2-2/.test(p.corp));
    bine("și le duce mai departe în formular", new RegExp('name="locuri_alese" value="' + a + "," + b2 + '"').test(p.corp));
    bine("scrie clar că nu mai caută altundeva", /nu mai caută altundeva/.test(p.corp));

    // Fara locuri alese, pagina ramane cum era.
    const f = await cer("/stocuri/ct-park/intrare", { query: {} });
    bine("fără alegere, pagina e cea veche", !/alese de pe hartă/.test(f.corp) && /ERP-ul propune locurile libere/.test(f.corp));
  }

  console.log("\n3. Ce ai ales se folosește EXACT");
  {
    const a = loc(2, 3, 1), b2 = loc(2, 3, 2);
    const p = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: { produs_text: "TEST-HARTA", cantitate: "100", um: "buc", paleti: "1", locuri: "2", locuri_alese: a + "," + b2 },
    });
    bine("pasul 2 se deschide", p.cod === 200);
    // Locurile propuse trebuie sa fie fix cele alese, nu altele.
    bine("apar fix locurile alese", /TH-2-3-1/.test(p.corp) && /TH-2-3-2/.test(p.corp));
    const alteLocuri = (p.corp.match(/TH-1-\d-\d/g) || []);
    bine("și niciunul din restul rândului", alteLocuri.length === 0, alteLocuri.slice(0, 5).join(", "));
    bine("nu se plânge că n-a găsit destule", !/Am găsit doar/.test(p.corp));
  }

  console.log("\n4. Lipite fac o paletă lată, răzlețe fac paleți separați");
  {
    // Trei locuri lipite, acelasi camp si nivel → o singura paleta lata.
    const t = [loc(1, 1, 1), loc(1, 1, 2), loc(1, 1, 3)].join(",");
    const p = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: { produs_text: "TEST-HARTA", cantitate: "90", um: "buc", paleti: "1", locuri: "3", locuri_alese: t },
    });
    const grupuri = (p.corp.match(/name="locuri\[\]"/g) || []).length;
    bine("trei lipite ies ca un singur grup", grupuri === 1 || /TH-1-1-1.*TH-1-1-3/s.test(p.corp), grupuri);

    // Doua locuri din campuri diferite → doi paleti, nu unul lat.
    const d = [loc(1, 1, 1), loc(1, 3, 1)].join(",");
    const p2 = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: { produs_text: "TEST-HARTA", cantitate: "60", um: "buc", paleti: "2", locuri: "2", locuri_alese: d },
    });
    bine("două din câmpuri diferite apar amândouă", /TH-1-1-1/.test(p2.corp) && /TH-1-3-1/.test(p2.corp));
  }

  console.log("\n5. Un loc ocupat între timp nu se suprascrie");
  {
    const a = loc(2, 1, 1), b2 = loc(2, 1, 2);
    // Intre click si salvare, altcineva pune marfa pe primul.
    q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, um, data_intrare) VALUES ('TH-PAL-1', 'TEST-HARTA', 10, 'buc', '2026-10-23')`);
    const palet = Number(unul("SELECT id FROM ct_paleti WHERE produs_text='TEST-HARTA' ORDER BY id DESC LIMIT 1"));
    q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${palet}, ${a})`);

    const p = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: { produs_text: "TEST-HARTA", cantitate: "50", um: "buc", paleti: "2", locuri: "1", locuri_alese: a + "," + b2 },
    });
    bine("se spune că un loc nu mai e liber", /nu mai e liber|nu mai sunt libere/.test(p.corp), (p.corp.match(/nu mai [^<.]*/) || [])[0]);
    bine("și că altcineva a pus marfă acolo", /a pus marfă acolo între timp/.test(p.corp));
    // Locul ocupat NU trebuie sa apara ca propunere.
    bine("locul ocupat nu se propune", !new RegExp('value="' + a + '"').test(p.corp), "apare " + a);
    bine("dar cel liber, da", new RegExp('value="' + b2 + '"').test(p.corp));
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
