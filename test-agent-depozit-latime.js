"use strict";
// Două cereri de-ale lui Vali, 30.10.2026, urcate împreună:
//
//   1. „Fă totul să se lățească automat funcție de rezoluție și ecranul pe
//      care se deschide” — pagina nu mai stă prinsă la 1100px.
//   2. „Agenții de vânzări au și ei acces la secțiunea depozit, dar văd doar
//      stoc la zi și nu au activ butonul intrare marfă.”
//
// Și una din 05.11.2026: „să se poată exporta și în xls asta de către admini”
// — exportul în Excel al stocului la zi, doar pentru administratori, cu
// exact rândurile de pe ecran (și cu căutarea pusă).
//
// Al doilea e o regulă de acces, deci se verifică și ce NU se deschide: harta,
// intrarea, paletul, „Tot depozitul”, plus o adresă care doar începe la fel
// ca pagina de stoc. Și ce nu vede agentul pe pagina de stoc: furnizorul și
// prețul de intrare (aceeași regulă ca la Cereri de preț).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
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
const auth = require(path.join(RAD, "lib", "auth.js"));
const render = require(path.join(RAD, "lib", "render.js"));

const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "ct-park.js")).register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, user, query) {
  const r = res();
  await rute.get[cale]({ user, params: {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
}

// Arhiva .xlsx desfăcută înapoi, din directorul central (ca în test-export-xlsx.js).
function desfa(buf) {
  const sfarsit = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (sfarsit < 0) throw new Error("fără sfârșit de arhivă");
  const n = buf.readUInt16LE(sfarsit + 10);
  let p = buf.readUInt32LE(sfarsit + 16);
  const out = {};
  for (let i = 0; i < n; i++) {
    const comprimat = buf.readUInt32LE(p + 20);
    const ln = buf.readUInt16LE(p + 28), lx = buf.readUInt16LE(p + 30), lc = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const nume = buf.slice(p + 46, p + 46 + ln).toString("utf8");
    const nl = buf.readUInt16LE(offset + 26), xl = buf.readUInt16LE(offset + 28);
    out[nume] = zlib.inflateRawSync(buf.slice(offset + 30 + nl + xl, offset + 30 + nl + xl + comprimat)).toString("utf8");
    p += 46 + ln + lx + lc;
  }
  return out;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

// Oamenii, așa cum stau pe server: agenții au bifat doar „Vânzări".
const ADMIN = { id: 1, nume: "Vali", rol: "admin", sectiuni: "" };
const AGENT = { id: 901, nume: "Agent Test", rol: "vanzari", sectiuni: "/crm" };
const AGENT_FARA_BIFE = { id: 902, nume: "Agent Vechi", rol: "vanzari", sectiuni: "" };
const DEPOZIT = { id: 903, nume: "Om Depozit", rol: "depozit", sectiuni: "/depozit" };
const FINANCIAR = { id: 904, nume: "Om Financiar", rol: "financiar", sectiuni: "/financiar" };

const NUMAR = 94;
const MARCAJ = "TEST-AGENT palet de test";
const FURNIZOR = "TEST-AGENT Furnizorul Secret SRL";
function curata() {
  const paleti = q(`SELECT id FROM ct_paleti WHERE observatii = ${lit(MARCAJ)}`).map((r) => Number(r.id));
  if (paleti.length) {
    const l = paleti.join(",");
    q(`DELETE FROM ct_ocupari WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${l})`);
    q(`DELETE FROM ct_paleti WHERE id IN (${l})`);
  }
  const r = unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`);
  if (r) {
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_sectoare WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
  q("DELETE FROM produse WHERE cod = 'TST-AGENT-A'");
  q("DELETE FROM ct_culori_marfa WHERE cheie = 'C:TST-AGENT-A'");
}

(async () => {
  console.log("\n1. Cine ce poate deschide din Depozit");
  {
    const STOC = "/stocuri/ct-park/stoc";
    const OPRITE = [
      "/stocuri/ct-park", "/stocuri/ct-park/intrare", "/stocuri/ct-park/tot", "/stocuri/ct-park/palet/5",
      "/stocuri/ct-park/palet/5/adauga", "/stocuri/ct-park/muta", "/stocuri/ct-park/iesire",
      "/stocuri/ct-park/configurare", "/stocuri/ct-park/ocupa", "/stocuri", "/depozit",
      "/stocuri/ct-park/stoc/altceva", "/stocuri/ct-park/stocuri",
    ];
    for (const [cine, u] of [["agentul cu „Vânzări” bifat", AGENT], ["agentul fără nicio bifă", AGENT_FARA_BIFE]]) {
      bine(`${cine} deschide „Stoc la zi”`, auth.poateAccesa(u, STOC));
      const deschise = OPRITE.filter((p) => auth.poateAccesa(u, p));
      bine(`${cine} nu deschide nimic altceva din Depozit`, !deschise.length, deschise.join(", "));
      bine(`${cine} își păstrează Vânzările`, auth.poateAccesa(u, "/crm") && auth.poateAccesa(u, "/comenzi"));
    }
    bine("rolul dat ca text merge la fel (apelurile vechi)", auth.poateAccesa("vanzari", STOC) && !auth.poateAccesa("vanzari", "/stocuri/ct-park/intrare"));
    bine("depozitul vede tot ca până acum", [STOC].concat(OPRITE).every((p) => auth.poateAccesa(DEPOZIT, p)));
    bine("administratorul vede tot", [STOC].concat(OPRITE).every((p) => auth.poateAccesa(ADMIN, p)));
    bine("financiarul n-a primit nimic în plus", !auth.poateAccesa(FINANCIAR, STOC));
  }

  console.log("\n2. Butonul „Depozit” din bara de sus");
  {
    const dep = (u) => render.navPentru(u).find((x) => x.label === "Depozit");
    bine("agentul are butonul, și îl duce la „Stoc la zi”", dep(AGENT) && dep(AGENT).href === "/stocuri/ct-park/stoc", JSON.stringify(dep(AGENT)));
    bine("la fel agentul fără bife", dep(AGENT_FARA_BIFE) && dep(AGENT_FARA_BIFE).href === "/stocuri/ct-park/stoc");
    bine("depozitul intră tot pe hartă", dep(DEPOZIT) && dep(DEPOZIT).href === "/stocuri/ct-park");
    bine("administratorul intră tot pe hartă", dep(ADMIN) && dep(ADMIN).href === "/stocuri/ct-park");
    bine("financiarul nu are butonul", !dep(FINANCIAR));
    bine("NAV-ul în sine nu s-a schimbat (copia, nu originalul)", render.NAV.find((x) => x.label === "Depozit").href === "/stocuri/ct-park");
    const cuNavVechi = render.NAV.filter((i) => auth.poateAccesa(DEPOZIT, i.zona || i.href)).map((i) => i.label).join("|");
    bine("pentru cine are toată zona, bara e exact cea de dinainte", render.navPentru(DEPOZIT).map((i) => i.label).join("|") === cuNavVechi);
  }

  console.log("\n3. Pagina „Stoc la zi”, văzută de agent și de administrator");
  curata();
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR}, 'materie primă', 1, 1, 2, 800, 1200, 1)`);
  const rid = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${NUMAR}`));
  q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${rid}, 1, 1, 1, 'R${NUMAR}-01-1-1', 0)`);
  const loc = Number(unul(`SELECT id FROM ct_locuri WHERE rand_id = ${rid}`));
  const pa = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-AGENT-A', 'TEST-AGENT Folie stretch', 'kg') RETURNING id")[0].id);
  const pal = Number(q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, categorie, lot, data_intrare, pret_unitar, furnizor_text, observatii)
     VALUES ('CTTEST-AG', ${pa}, 250, 'kg', 'materie primă', 'LOT-AG-7', '2026-10-30', 12.34, ${lit(FURNIZOR)}, ${lit(MARCAJ)}) RETURNING id`)[0].id);
  q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${pal}, ${loc})`);

  {
    const r = await cer("/stocuri/ct-park/stoc", AGENT);
    bine("agentul: pagina se deschide", r.cod === 200, r.cod);
    bine("agentul: vede marfa, cantitatea, lotul și locul", r.corp.includes("TEST-AGENT Folie stretch") && r.corp.includes("250 kg") && r.corp.includes("LOT-AG-7") && r.corp.includes(`R${NUMAR}-01-1-1`));
    const taburi = (r.corp.match(/<div class="subnav"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
    const etichete = [...taburi.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);
    bine("agentul: în submeniu are doar „Stoc la zi”", etichete.length === 1 && etichete[0] === "Stoc la zi", etichete.join(", "));
    bine("agentul: „Intrare marfă” e la vedere, dar inactiv", /<button type="button" class="btn secondary" disabled[^>]*>\+ Intrare marfă<\/button>/.test(r.corp));
    bine("agentul: niciun link spre intrare, hartă sau palet", !/href="\/stocuri\/ct-park(\/intrare[^"]*|\/palet\/\d+|\/tot)?"/.test(r.corp), (r.corp.match(/href="\/stocuri\/ct-park(\/intrare[^"]*|\/palet\/\d+|\/tot)?"/) || [])[0]);
    bine("agentul: butonul Depozit din bară e aprins și duce la stoc", /<a href="\/stocuri\/ct-park\/stoc" class="navlink active">Depozit<\/a>/.test(r.corp));
    bine("agentul: nu vede furnizorul", !r.corp.includes(FURNIZOR) && !/<th[^>]*>Furnizor/.test(r.corp));
    bine("agentul: nu vede prețul de intrare și valoarea", !/12,34/.test(r.corp) && !/3\.085,00/.test(r.corp) && !/Valoare la preț de intrare/.test(r.corp) && !/<th[^>]*>Valoare/.test(r.corp));
    const cuFurnizor = await cer("/stocuri/ct-park/stoc", AGENT, { q: "Furnizorul Secret" });
    bine("agentul: căutarea nu merge pe furnizor (nu-l poate afla căutând)", !cuFurnizor.corp.includes("TEST-AGENT Folie stretch"));
    const cuNume = await cer("/stocuri/ct-park/stoc", AGENT, { q: "LOT-AG-7" });
    bine("agentul: căutarea după lot merge", cuNume.corp.includes("TEST-AGENT Folie stretch"));
  }
  {
    const r = await cer("/stocuri/ct-park/stoc", ADMIN);
    bine("administratorul: vede furnizorul, prețul și valoarea, ca înainte", r.corp.includes(FURNIZOR) && /12,34/.test(r.corp) && /3\.085,00/.test(r.corp) && /Valoare la preț de intrare/.test(r.corp));
    bine("administratorul: „+ Intrare marfă” e link activ", r.corp.includes('<a class="btn secondary" href="/stocuri/ct-park/intrare">+ Intrare marfă</a>'));
    const taburi = (r.corp.match(/<div class="subnav"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
    bine("administratorul: are tot submeniul", ["Harta depozitului", "Tot depozitul", "Intrare marfă", "Stoc la zi", "Configurare rânduri"].every((t) => taburi.includes(">" + t + "<")));
    const cuFurnizor = await cer("/stocuri/ct-park/stoc", ADMIN, { q: "Furnizorul Secret" });
    bine("administratorul: căutarea pe furnizor merge ca înainte", cuFurnizor.corp.includes("TEST-AGENT Folie stretch"));
    const d = await cer("/stocuri/ct-park/stoc", DEPOZIT);
    bine("depozitul: vede tot, cu intrarea activă", d.corp.includes(FURNIZOR) && d.corp.includes('href="/stocuri/ct-park/intrare"'));
  }

  console.log("\n3b. Exportul în Excel al stocului la zi — doar administratorii");
  {
    const EXPORT = "/stocuri/ct-park/stoc/export.xlsx";
    const admin = await cer("/stocuri/ct-park/stoc", ADMIN);
    bine("administratorul are butonul „Export Excel”", /<a class="btn secondary" href="\/stocuri\/ct-park\/stoc\/export\.xlsx"[^>]*>Export Excel<\/a>/.test(admin.corp));
    const cautat = await cer("/stocuri/ct-park/stoc", ADMIN, { q: "LOT-AG-7" });
    bine("cu o căutare pusă, butonul exportă căutarea", cautat.corp.includes('href="/stocuri/ct-park/stoc/export.xlsx?q=LOT-AG-7"'));
    for (const [cine, u] of [["agentul", AGENT], ["depozitul", DEPOZIT], ["financiarul", FINANCIAR]]) {
      const p = await cer("/stocuri/ct-park/stoc", u);
      bine(`${cine}: n-are butonul de export`, !/export\.xlsx/.test(p.corp));
      const e = await cer(EXPORT, u);
      bine(`${cine}: exportul îi e refuzat cu motiv (403), nu primește fișierul`,
        e.cod === 403 && /rezervat administratorilor/.test(String(e.corp)) && !(e.antet && /spreadsheetml/.test(e.antet["Content-Type"] || "")), e.cod);
    }

    const r = await cer(EXPORT, ADMIN);
    const buf = Buffer.isBuffer(r.corp) ? r.corp : Buffer.from(String(r.corp || ""));
    bine("administratorul primește un fișier Excel", r.cod === 200 && /spreadsheetml\.sheet/.test((r.antet || {})["Content-Type"] || ""), r.cod);
    bine("ca descărcare, cu numele și data", /^attachment; filename="stoc-la-zi-ct-park-\d{4}-\d{2}-\d{2}\.xlsx"$/.test((r.antet || {})["Content-Disposition"] || ""), (r.antet || {})["Content-Disposition"]);
    let parti = {};
    try { parti = desfa(buf); } catch (e) { parti = {}; }
    const foaie = parti["xl/worksheets/sheet1.xml"] || "";
    const rand = (foaie.match(/<row r="\d+">(?:(?!<\/row>).)*TEST-AGENT Folie stretch(?:(?!<\/row>).)*<\/row>/) || [])[0] || "";
    bine("paletul de test e în fișier, pe un rând", Boolean(rand), foaie.slice(0, 200));
    bine("cu categoria, codul produsului și codul paletului separat",
      rand.includes(">materie primă<") && rand.includes(">TST-AGENT-A<") && rand.includes(">CTTEST-AG<"), rand.slice(0, 400));
    bine("cantitatea e număr (250), nu text", /<c r="F\d+"><v>250<\/v><\/c>/.test(rand), rand.match(/<c r="F\d+".*?<\/c>/));
    bine("furnizorul, lotul și locul", rand.includes(FURNIZOR) && rand.includes(">LOT-AG-7<") && rand.includes(`R${NUMAR}-01-1-1`));
    bine("data intrării e dată Excel (30.10.2026)", rand.includes("<v>46325</v>"), rand.match(/<c r="I\d+".*?<\/c>/));
    bine("prețul pe UM cu zecimale (12,34) și valoarea 3.085", /<c r="N\d+"><v>12\.34<\/v><\/c>/.test(rand) && /<c r="O\d+" s="2"><v>3085<\/v><\/c>/.test(rand),
      [rand.match(/<c r="N\d+".*?<\/c>/), rand.match(/<c r="O\d+".*?<\/c>/)]);
    const cat = parti["xl/worksheets/sheet2.xml"] || "";
    bine("a doua foaie are totalurile pe categorii, cu TOTAL", cat.includes(">materie primă<") && cat.includes(">TOTAL<"));
    const cum = parti["xl/worksheets/sheet3.xml"] || "";
    bine("a treia foaie spune cine, când și cu ce căutare", cum.includes("Vali") && cum.includes("tot stocul"));

    const f = await cer(EXPORT, ADMIN, { q: "LOT-AG-7" });
    const pf = desfa(Buffer.isBuffer(f.corp) ? f.corp : Buffer.from(String(f.corp)));
    const randuriF = ((pf["xl/worksheets/sheet1.xml"] || "").match(/<row r=/g) || []).length;
    bine("exportul cu căutare scoate doar ce s-a găsit (antet + 1 rând)", randuriF === 2, randuriF);
    bine("și spune ce căutare era pusă", (pf["xl/worksheets/sheet3.xml"] || "").includes("LOT-AG-7"));
    const gol = desfa(Buffer.from((await cer(EXPORT, ADMIN, { q: "TEST-AGENT-nu-exista-xyz" })).corp));
    bine("o căutare fără rezultat dă fișier cu antetul, nu eroare", ((gol["xl/worksheets/sheet1.xml"] || "").match(/<row r=/g) || []).length === 1);

    // Un palet fără preț: celula de preț și cea de valoare rămân goale, nu
    // zero — un zero s-ar aduna în Excel ca o valoare adevărată.
    q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, categorie, lot, data_intrare, observatii)
       VALUES ('CTTEST-AG2', ${pa}, 7.5, 'kg', 'materie primă', 'LOT-AG-8', '2026-11-01', ${lit(MARCAJ)})`);
    const fp = desfa(Buffer.from((await cer(EXPORT, ADMIN, { q: "LOT-AG-8" })).corp));
    const randFp = ((fp["xl/worksheets/sheet1.xml"] || "").match(/<row r="2">.*?<\/row>/) || [])[0] || "";
    bine("palet fără preț: cantitatea 7,5 cu zecimale", /<c r="F2"><v>7\.5<\/v><\/c>/.test(randFp), randFp.slice(0, 300));
    bine("palet fără preț: prețul și valoarea goale, nu zero", randFp.includes(">CTTEST-AG2<") && !/r="N2"/.test(randFp) && !/r="O2"/.test(randFp), randFp.match(/<c r="[NO]2".*?<\/c>/g));
    bine("și se numără la „paleți fără preț”", (fp["xl/worksheets/sheet3.xml"] || "").includes(">1 (valoarea lor nu intră în sumă)<"));
  }
  curata();

  console.log("\n4. Pagina pe toată lățimea ecranului");
  {
    const css = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const reg = (css.match(/(^|\n)\.content \{([^}]*)\}/) || [])[2];
    bine("regula .content există", reg !== undefined);
    bine(".content nu mai are lățime maximă", reg !== undefined && !/max-width/.test(reg), reg);
    const reguli = css.replace(/\/\*[\s\S]*?\*\//g, ""); // fără comentarii: contează regulile, nu povestea lor
    bine("marginea negativă a tabelului lat a plecat (l-ar fi împins în afara ecranului)", !/50vw/.test(reguli) && !/margin-left:\s*calc\(/.test(reguli));
    bine("pe telefon .content își păstrează marginile mici", /@media \(max-width: 760px\)[\s\S]*?\.content \{ padding: 14px 12px 28px; \}/.test(css));
    const sw = fs.readFileSync(path.join(RAD, "public", "sw.js"), "utf8");
    bine("service worker-ul a ridicat versiunea (altfel rămâne foaia veche)", !/const VERSIUNE = "erp-v3";/.test(sw));
    const pag = render.layout({ user: ADMIN, title: "x", active: "/stocuri/ct-park", body: '<div class="subnav"></div><p>x</p>' });
    bine("pagina nu-și pune singură o lățime", /<main class="content">/.test(pag));
  }

  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
