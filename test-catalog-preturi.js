"use strict";
// Catalogul de prețuri al agenților: pagina de oferte de la furnizori, la
// vânzări, nemodificabilă, cu prețul +25% și fără furnizor.
// Pe PostgreSQL real (prin psql).
//
// CEREREA LUI VALI, 29.10.2026: „Pagina asta să fie duplicată și băgată la
// agenții de vânzări într-un submeniu Catalog prețuri, unde să arate fix la
// fel, dar nemodificabil, doar cu buton Copiază în clipboard … Prețurile să fie
// cu 25% mai mari." Apoi: „Ascunde furnizor."
//
// CE APĂRĂ:
//
//   • PREȚUL DIN CATALOG E +25%, PESTE TOT. Pe rând, în textul copiat și în
//     comparația cu piața — altfel procentul ar vorbi despre altă cifră decât
//     cea de pe ecran. Prețul furnizorului nu apare nicăieri în pagină.
//
//   • FURNIZORUL NU SE VEDE ȘI NU SE POATE AFLA. Nici coloană, nici filtru,
//     nici card, nici subiectul emailului lui. Filtrul „?furnizor=" din adresă
//     se ignoră, iar căutarea nu merge pe observații (unde poate scrie numele):
//     altfel, după ce rânduri rămân, s-ar afla tot cine e furnizorul.
//
//   • NIMIC DE MODIFICAT. Niciun formular care trimite date, niciun link spre
//     paginile achizițiilor (agentul ar primi oricum „Nu ai acces").
//
//   • FIX LA FEL. Aceleași categorii, aceleași filtre, aceeași ordine; pagina
//     achizițiilor rămâne cum era (preț real, furnizor, butoanele ei).
//
//   • AGENTUL AJUNGE LA EA. E sub Vânzări, în subnavigație; nu cere drept pe
//     Procurement.
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
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; } };
require(path.join(RAD, "modules", "procurement.js")).register(router);
const R = require(path.join(RAD, "lib", "render.js"));
const AUTH = require(path.join(RAD, "lib", "auth.js"));

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const AGENT = { id: 7, nume: "Agent Test", rol: "vanzari", sectiuni: "/crm" };
async function cer(cale, query, user) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipsește: GET " + cale);
  const r = res();
  await h({ user: user || VALI, params: {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 260) : "")); esecuri++; }
}
const text = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const dezesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const PFX = "TSTCAT";
const zi = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const roData = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4);

function curata() {
  q(`DELETE FROM ach_oferte WHERE articol_id IN (SELECT id FROM ach_articole WHERE nume LIKE '${PFX}%')`);
  q(`DELETE FROM ach_piata WHERE articol_id IN (SELECT id FROM ach_articole WHERE nume LIKE '${PFX}%')`);
  q(`DELETE FROM ach_articole WHERE nume LIKE '${PFX}%'`);
  q(`DELETE FROM ach_categorii WHERE nume LIKE '${PFX}%'`);
  q(`DELETE FROM parteneri WHERE nume LIKE 'AKON-TST%'`);
}

(async () => {
  curata();
  const cat = Number(unul(`INSERT INTO ach_categorii (nume, ordine, activ) VALUES ('${PFX} Folii', 5, 1) RETURNING id`));
  const art = Number(unul(`INSERT INTO ach_articole (nume, categorie_id, um, specificatie, activ) VALUES ('${PFX} Folie cu bule 70gr', ${cat}, 'mp', 'rola 1,5 m', 1) RETURNING id`));
  const akon = Number(unul(`INSERT INTO parteneri (nume, tip) VALUES ('AKON-TST RULO KAGIT', 'furnizor') RETURNING id`));
  const valabil = zi(30);
  q(`INSERT INTO ach_oferte (articol_id, furnizor_text, pret, moneda, um, data_ofertei, sursa, observatii, activ)
     VALUES (${art}, 'MOLDPLAST-TST', 0.221, 'EUR', 'mp', '${zi(-1)}', 'manual', 'oferta MOLDPLAST-TST telefonic', 1)`);
  q(`INSERT INTO ach_oferte (articol_id, furnizor_id, pret, moneda, um, cantitate_min, data_ofertei, valabil_pana, sursa, email_subiect, email_de_la, activ)
     VALUES (${art}, ${akon}, 0.13, 'EUR', 'mp', 1, '${zi(-8)}', '${valabil}', 'email', 'Oferta AKON-TST pentru Cash Machine', 'vanzari@akon-tst.example', 1)`);
  q(`INSERT INTO ach_oferte (articol_id, furnizor_text, pret, moneda, um, data_ofertei, valabil_pana, sursa, activ)
     VALUES (${art}, 'EXPIRAT-TST', 1, 'EUR', 'mp', '${zi(-40)}', '${zi(-5)}', 'manual', 1)`);
  q(`INSERT INTO ach_piata (articol_id, pret, moneda, um, data, activ) VALUES (${art}, 0.25, 'EUR', 'mp', '${zi(-2)}', 1)`);

  console.log("\n1. Pagina achizițiilor rămâne cum era");
  const pr = await cer("/procurement", { q: PFX });
  const tp = text(pr.corp);
  bine("se randează", pr.cod === 200, pr.cod);
  bine("prețul furnizorului: 0,221 EUR / mp", tp.includes("0,221 EUR / mp"));
  bine("și 0,13 EUR / mp", tp.includes("0,13 EUR / mp"));
  bine("furnizorii se văd", tp.includes("MOLDPLAST-TST") && tp.includes("AKON-TST RULO KAGIT"));
  bine("butoanele achizițiilor sunt acolo", pr.corp.includes('href="/procurement/nou"') && pr.corp.includes("Oferte din emailuri"));
  bine("articolul duce la pagina lui", pr.corp.includes(`href="/procurement/articol/${art}"`));
  bine("filtrul de furnizor e acolo", /name="furnizor"/.test(pr.corp));
  bine("față de piață, pe prețul furnizorului: -12%", tp.includes("-12%"), (tp.match(/[+-]\d+%/g) || []).join(" "));
  bine("fără butoane Copiază", !pr.corp.includes("catalog-copiaza"));
  bine("specificația articolului se vede sub nume", tp.includes("rola 1,5 m"));
  const prF = await cer("/procurement", { q: PFX, furnizor: "MOLDPLAST-TST" });
  bine("filtrul de furnizor merge aici", text(prF.corp).includes("0,221 EUR") && !text(prF.corp).includes("0,13 EUR"));

  console.log("\n2. Catalogul: prețul +25%");
  const ca = await cer("/crm/catalog-preturi", { q: PFX }, AGENT);
  const tc = text(ca.corp);
  bine("se randează pentru agent", ca.cod === 200 && ca.corp.length > 1000, ca.cod);
  bine("titlul e Catalog prețuri", /<title>[^<]*Catalog prețuri/.test(ca.corp) || tc.includes("Catalog prețuri"));
  bine("0,221 → 0,2763 EUR / mp", tc.includes("0,2763 EUR / mp"), (tc.match(/[\d,]+ EUR \/ mp/g) || []).join(" | "));
  bine("0,13 → 0,1625 EUR / mp", tc.includes("0,1625 EUR / mp"));
  bine("prețul furnizorului nu apare nicăieri", !ca.corp.includes("0,221") && !/0,13 EUR/.test(ca.corp));
  bine("față de piață, pe prețul de pe rând: +11%", tc.includes("+11%"), (tc.match(/[+-]\d+%/g) || []).join(" "));
  bine("oferta expirată nu se vede implicit", !tc.includes("1,25 EUR"));
  bine("specificația articolului se vede și aici", tc.includes("rola 1,5 m"));
  bine("aceleași categorii ca la achiziții", tc.includes(`${PFX} Folii`) && tp.includes(`${PFX} Folii`));
  const caExp = await cer("/crm/catalog-preturi", { q: PFX, valabile: "0" }, AGENT);
  bine("cu „și cele expirate” se vede, tot +25%: 1,25 EUR / mp", text(caExp.corp).includes("1,25 EUR / mp"));

  console.log("\n3. Catalogul: furnizorul ascuns");
  for (const nume of ["MOLDPLAST-TST", "AKON-TST", "akon-tst.example", "EXPIRAT-TST"]) {
    bine(`„${nume}” nu apare nicăieri în pagină`, !caExp.corp.includes(nume) && !ca.corp.includes(nume));
  }
  bine("nicio coloană Furnizor", !/<th[^>]*>\s*Furnizor\s*<\/th>/.test(ca.corp));
  bine("niciun filtru de furnizor", !/name="furnizor"/.test(ca.corp));
  bine("niciun card cu numărul de furnizori", !/class="label">Furnizori</.test(ca.corp));
  bine("subiectul emailului furnizorului nu apare", !ca.corp.includes("Oferta AKON-TST"));
  const caF = await cer("/crm/catalog-preturi", { q: PFX, furnizor: "MOLDPLAST-TST" }, AGENT);
  bine("„?furnizor=” din adresă se ignoră: rămân amândouă ofertele", text(caF.corp).includes("0,2763 EUR") && text(caF.corp).includes("0,1625 EUR"));
  const caObs = await cer("/crm/catalog-preturi", { q: "MOLDPLAST-TST" }, AGENT);
  bine("căutarea după numele furnizorului (din observații) nu găsește nimic", !text(caObs.corp).includes("0,2763 EUR") && text(caObs.corp).includes("Nicio ofertă"));
  const prObs = await cer("/procurement", { q: "MOLDPLAST-TST" });
  bine("…pe când la achiziții, aceeași căutare îl găsește", text(prObs.corp).includes("0,221 EUR"));

  console.log("\n4. Catalogul: nimic de modificat");
  // Singurul formular POST permis e „Ieșire” din antetul comun al ERP-ului.
  const formulare = [...ca.corp.matchAll(/<form[^>]*method="post"[^>]*>/gi)].map((m) => m[0]).filter((f) => !/action="\/logout"/.test(f));
  bine("niciun formular care trimite date (în afară de Ieșire)", formulare.length === 0, formulare.join(" | "));
  bine("niciun link spre paginile achizițiilor", !/href="\/procurement/.test(ca.corp));
  bine("fără „+ Ofertă nouă” și fără butoanele achizițiilor", !tc.includes("Ofertă nouă") && !tc.includes("Oferte din emailuri") && !tc.includes("Articole & categorii"));
  bine("filtrele trimit tot la catalog", ca.corp.includes('action="/crm/catalog-preturi"'));
  bine("căutarea e acolo", /name="q"/.test(ca.corp) && /name="categorie"/.test(ca.corp) && /name="valabile"/.test(ca.corp) && /name="luni"/.test(ca.corp));

  console.log("\n5. Butonul Copiază");
  const texte = [...ca.corp.matchAll(/class="btn small secondary catalog-copiaza" data-text="([^"]*)"/g)].map((m) => dezesc(m[1]));
  bine("câte un buton pe fiecare ofertă: 2", texte.length === 2, texte.length);
  bine("textul ofertei fără cantitate minimă", texte.includes(`${PFX} Folie cu bule 70gr — rola 1,5 m: 0,2763 EUR / mp`), JSON.stringify(texte));
  bine("textul cu cantitate minimă și valabilitate", texte.includes(`${PFX} Folie cu bule 70gr — rola 1,5 m: 0,1625 EUR / mp (cantitate minimă 1 mp, valabil până la ${roData(valabil)})`), JSON.stringify(texte));
  bine("scriptul care copiază e în pagină", ca.corp.includes("function catalogCopiaza(b)") && ca.corp.includes("navigator.clipboard"));
  bine("are rezervă pentru browserele fără clipboard modern", ca.corp.includes('document.execCommand("copy")'));
  bine("butonul e de tip „button”: nu trimite nimic", (ca.corp.match(/<button type="button" class="btn small secondary catalog-copiaza"/g) || []).length === 2);

  console.log("\n6. Agentul ajunge la catalog");
  bine("agentul (rol vânzări, fără bife) are voie la catalog", AUTH.poateAccesa({ rol: "vanzari" }, "/crm/catalog-preturi"));
  bine("…dar nu la ofertele achizițiilor", !AUTH.poateAccesa({ rol: "vanzari" }, "/procurement"));
  bine("agentul cu bifa Vânzări are voie la catalog", AUTH.poateAccesa({ rol: "vanzari", sectiuni: "/crm" }, "/crm/catalog-preturi"));
  bine("…și tot nu la achiziții", !AUTH.poateAccesa({ rol: "vanzari", sectiuni: "/crm" }, "/procurement"));
  const sub = R.subnavCrm("/crm/catalog-preturi", AGENT);
  bine("în subnavigația Vânzări: „Catalog prețuri”, aprins", /href="\/crm\/catalog-preturi" class="subnav-link activ">Catalog prețuri</.test(sub), sub.slice(0, 200));
  bine("pagina catalogului are subnavigația Vânzări", ca.corp.includes('href="/crm/catalog-preturi" class="subnav-link activ"'));
  bine("în bara de sus se aprinde Vânzări", /href="\/crm" class="navlink active"/.test(ca.corp));

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
