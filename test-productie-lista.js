"use strict";
// Lista de comenzi de productie: cifrele de sus si navigarea prin tabel.
// Pe PostgreSQL real (prin psql).
//
// CE APARA:
//
//   • CIFRA DE PE CARD SI LISTA LA CARE DUCE SPUN ACELASI LUCRU. Cardul e
//     acum buton. Daca numaratoarea foloseste alt camp sau alte stari decat
//     filtrul, omul vede „3 intarziate", da click, si gaseste 7 sau niciuna
//     — si de-atunci nu mai are incredere in niciun numar de pe pagina.
//
//   • NUMARATOAREA E PE TOATA BAZA, NU PE PAGINA. Lista e taiata la 400 de
//     randuri si e deja filtrata; numarata acolo, cifra s-ar fi schimbat la
//     fiecare filtru.
//
//   • TABELUL LAT SE POATE NAVIGA DE ORIUNDE. Cap lipit sus, primele doua
//     coloane lipite la stanga, a doua bara de scroll lipita jos.
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
require(path.join(RAD, "modules", "productie.js")).register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });
const R = require(path.join(RAD, "lib", "render.js"));

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, query) {
  const h = rute.get[cale];
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params: {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 220) : "")); esecuri++; }
}

const ZI = 86400000;
const trecut = new Date(Date.now() - 7 * ZI).toISOString().slice(0, 10);
const viitor = new Date(Date.now() + 7 * ZI).toISOString().slice(0, 10);

function curata() {
  q("DELETE FROM comenzi_productie WHERE numar LIKE 'LT-%'");
}

(async () => {
  curata();
  // Trei intarziate (deschise, cu data trecuta) si doua care nu sunt.
  for (const [n, st, d] of [
    ["LT-1", "noua", trecut],
    ["LT-2", "in_productie", trecut],
    ["LT-3", "noua", trecut],
    ["LT-4", "noua", viitor],
    ["LT-5", "finalizata", trecut], // finalizata: nu mai e problema productiei
  ]) {
    q(`INSERT INTO comenzi_productie (numar, tip_produs, cantitate, um, status, data_initiere, data_livrare)
       VALUES ('${n}', 'Test', '1', 'buc', '${st}', '2026-10-01', '${d}')`);
  }

  console.log("\n1. Cardul „Cu termenul depășit” și lista spun același lucru");
  {
    const p = await cer("/productie", {});
    bine("pagina răspunde", p.cod === 200);
    // Cardul numara in BAZA, nu in lista de pe ecran.
    const cifra = (p.corp.match(/Cu termenul depășit<\/div>\s*<div class="value"[^>]*>(\d+)</) || [])[1];
    bine("cardul arată o cifră", /^\d+$/.test(String(cifra)), cifra);
    bine("și e un link, nu doar o cifră", /card-filtru[^"]*" href="\/productie\?status=intarziate/.test(p.corp));

    const f = await cer("/productie", { status: "intarziate" });
    const nr = (f.corp.match(/Comenzi producție \((\d+)\)/) || [])[1];
    // ASTA E VERIFICAREA CARE CONTEAZA. Cifra de pe card si lungimea listei
    // la care duce trebuie sa fie acelasi numar. Daca nu sunt, omul vede „3",
    // da click, gaseste 7, si de-atunci nu mai crede niciun numar de pe
    // pagina. Nu verific o valoare anume: baza are si comenzi reale, iar un
    // test care cere „fix 3" ar pica maine din alt motiv.
    bine("lista la care duce are exact atâtea rânduri cât scrie pe card", nr === cifra, "card " + cifra + " / listă " + nr);
    bine("și cele trei de test sunt printre ele", Number(cifra) >= 3, cifra);
    bine("și sunt chiar cele întârziate", /LT-1/.test(f.corp) && /LT-2/.test(f.corp) && /LT-3/.test(f.corp));
    bine("nu și cea cu termen în viitor", !/LT-4/.test(f.corp));
    bine("nici cea finalizată", !/LT-5/.test(f.corp));
    bine("cardul se vede ca ales", /card-filtru activ[^"]*" href="\/productie\?status=intarziate/.test(f.corp));
  }

  console.log("\n2. Cardurile de stare filtrează și ele");
  {
    const p = await cer("/productie", {});
    bine("„Nouă (solicitată)” e link", /href="\/productie\?status=noua"/.test(p.corp));
    bine("„În producție” la fel", /href="\/productie\?status=in_productie"/.test(p.corp));
    const f = await cer("/productie", { status: "in_productie" });
    bine("și duc unde trebuie", /LT-2/.test(f.corp) && !/LT-1/.test(f.corp));
  }

  console.log("\n3. Căutarea nu se pierde la click pe card");
  {
    const p = await cer("/productie", { q: "Test" });
    bine("linkul cardului păstrează căutarea", /status=noua&q=Test/.test(p.corp), (p.corp.match(/status=noua[^"]*/) || [])[0]);
  }

  console.log("\n4. Tabelul lat se poate naviga de oriunde");
  {
    const p = await cer("/productie", {});
    bine("primele coloane sunt înghețate", /class="tabel-lat tabel-inghetat"/.test(p.corp));
    bine("și tabelul are panoul de coloane", /data-coloane-pentru="comenzi-productie"/.test(p.corp));

    const html = R.layout({ user: { id: 1, nume: "V", rol: "admin" }, title: "x", body: "", active: "/" });
    bine("scriptul adaugă a doua bară de scroll", /scroll-lipit/.test(html));
    bine("sincronizată în ambele sensuri", /cutie\.scrollLeft = bara\.scrollLeft/.test(html) && /bara\.scrollLeft = cutie\.scrollLeft/.test(html));
    bine("și se ascunde dacă tabelul încape pe ecran", /bara\.style\.display = trebuie \? "" : "none"/.test(html));
    // Coloanele se pot ascunde din panou; latimea tabelului se schimba sub bara.
    bine("se remăsoară când se schimbă coloanele", /ResizeObserver/.test(html));
    bine("shift+rotiță derulează orizontal", /ev\.shiftKey/.test(html));
  }

  console.log("\n5. CSS-ul chiar există");
  {
    const fs = require("fs");
    const css = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    bine("capul de tabel rămâne sus", /\.tabel-lat thead th \{[\s\S]{0,120}position: sticky/.test(css));
    bine("primele două coloane rămân la stânga", /\.tabel-inghetat td:nth-child\(2\)[\s\S]{0,120}position: sticky/.test(css));
    bine("bara lipită de jos", /\.scroll-lipit \{[\s\S]{0,140}position: sticky[\s\S]{0,60}bottom: 0/.test(css));
    bine("cardurile arată că se poate da click", /\.card-filtru \{[\s\S]{0,60}cursor: pointer/.test(css));
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
