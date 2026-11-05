"use strict";
// Categorii de produs definite de om, în Configurări → Codul produsului, pe
// PostgreSQL real (portul 5433), prin rutele adevărate.
//
// CEREREA LUI VALI, 05.11.2026:
//   „La configurări să poți adăuga categorie de produs nouă cu caracteristici
//    funcție de care se generează codul automat, totul definit de utilizator."
//
// CE APĂRĂ:
//
//   • CATEGORIA NOUĂ SE VEDE ȘI SE FACE DIN PAGINĂ: buton la vedere, cu pașii
//     scriși. Goală, sau copiată după alta cu caracteristicile și valorile ei.
//   • PAGINA SPUNE CE MAI LIPSEȘTE până se poate face un produs, și când e gata.
//   • ÎNCEPUTUL DE COD AL ALTEI CATEGORII e semnalat: o copie pornește cu
//     aceleași bucăți și ar da coduri care se lovesc. Modificarea valorii
//     (nouă) repară, iar avertismentul dispare.
//   • VALOAREA SE MODIFICĂ, cu aceleași reguli ca la adăugare: bucata de cod nu
//     se dublează în listă și nu rămâne goală.
//   • REDENUMIRE fără dubluri; ȘTERGERE curată (cu valori), dar o categorie cu
//     produse doar iese din uz.
//   • CAP-COADĂ: din categoria făcută acum, Produs nou scoate codul singur.
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
  run: async (...p) => {
    const s = String(sql);
    if (/^\s*(UPDATE|DELETE)/i.test(s) && !/RETURNING/i.test(s)) {
      let i = 0;
      const t = s.replace(/\?/g, () => lit(p[i++]));
      const out = execFileSync("psql", ["-X", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "cod-produs.js")).register({
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
const CALE = "/configurari/cod-produs";
async function cer(metoda, cale, user, params, body, query) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params: params || {}, query: query || {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const loc = (r) => decodeURIComponent(String((r.antet && r.antet.Location) || ""));
const famDin = (r) => Number((loc(r).match(/familie=(\d+)/) || [])[1] || 0);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const NUME = "TEST-CAT Etichete";
function curata() {
  const fam = q(`SELECT id FROM cod_familii WHERE nume LIKE 'TEST-CAT%'`).map((r) => Number(r.id));
  const l = fam.join(",") || "0";
  const prod = q(`SELECT id FROM produse WHERE cod_familie_id IN (${l})`).map((r) => Number(r.id));
  q(`DELETE FROM produse_cod_valori WHERE produs_id IN (${prod.join(",") || 0})`);
  q(`DELETE FROM produse WHERE id IN (${prod.join(",") || 0})`);
  q(`DELETE FROM cod_valori WHERE caracteristica_id IN (SELECT id FROM cod_caracteristici WHERE familie_id IN (${l}))`);
  q(`DELETE FROM cod_caracteristici WHERE familie_id IN (${l})`);
  q(`DELETE FROM cod_familii WHERE id IN (${l})`);
}

(async () => {
  curata();
  const VALI = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali", rol: "admin" };
  const AGENT = { id: VALI.id, nume: "Agent", rol: "vanzari" };

  console.log("\n1. Butonul „Categorie nouă de produs” e la vedere");
  const pag = await cer("get", CALE, VALI);
  bine("titlul vorbește de categorii de produs", /Categorii de produs și codul lor/.test(pag.corp));
  bine("butonul e la vedere, cu pașii scriși", /<summary class="btn"[^>]*>\+ Categorie nouă de produs<\/summary>/.test(pag.corp) && /bucata ei de cod/.test(pag.corp));
  bine("se poate porni de la o categorie existentă", /<option value="\d+">copie după „/.test(pag.corp));
  const pagAgent = await cer("get", CALE, AGENT);
  bine("cine nu e admin nu are butonul", !/Categorie nouă de produs/.test(pagAgent.corp));
  let r = await cer("post", `${CALE}/familie`, AGENT, {}, { nume: NUME });
  bine("și nici nu poate crea pe ascuns", !Number(unul(`SELECT COUNT(*) FROM cod_familii WHERE nume = '${NUME}'`)));

  console.log("\n2. Categorie goală, construită pas cu pas");
  r = await cer("post", `${CALE}/familie`, VALI, {}, { nume: NUME, ordine: "50" });
  const fam = famDin(r);
  bine("se creează și duce la ea, cu ce urmează", fam > 0 && /adaugă-i caracteristicile/.test(loc(r)), loc(r));
  let p = await cer("get", CALE, VALI, {}, {}, { familie: String(fam) });
  bine("pagina spune că încă nu e gata", /încă nu se poate face un produs/.test(p.corp) && /0 caracteristici/.test(p.corp));
  r = await cer("post", `${CALE}/familie`, VALI, {}, { nume: " test-cat etichete " });
  bine("aceeași denumire a doua oară e refuzată", /Există deja categoria/.test(loc(r)) && Number(unul(`SELECT COUNT(*) FROM cod_familii WHERE nume ILIKE 'test-cat etichete%'`)) === 1, loc(r));

  await cer("post", `${CALE}/caracteristica`, VALI, {}, { familie_id: String(fam), nume: "Tip", fel: "lista", ordine: "1", in_cod: "1", obligatoriu: "1" });
  await cer("post", `${CALE}/caracteristica`, VALI, {}, { familie_id: String(fam), nume: "Lățime", fel: "numar", um: "mm", ordine: "2", cifre: "3", in_cod: "1", obligatoriu: "1" });
  const tip = Number(unul(`SELECT id FROM cod_caracteristici WHERE familie_id = ${fam} AND nume = 'Tip'`));
  p = await cer("get", CALE, VALI, {}, {}, { familie: String(fam) });
  bine("cu caracteristicile puse, spune ce valori lipsesc", /lipsesc valorile cu bucată de cod la: Tip/.test(p.corp));
  bine("și nu se dă drept gata de folosit", !/gata de folosit/.test(p.corp));
  await cer("post", `${CALE}/valoare`, VALI, {}, { familie_id: String(fam), caracteristica_id: String(tip), "valoare[]": ["Etichetă termică"], "cod[]": ["ET"] });
  p = await cer("get", CALE, VALI, {}, {}, { familie: String(fam) });
  bine("cu valorile puse: gata de folosit, cu link spre Produs nou", /gata de folosit/.test(p.corp) && p.corp.includes(`/produse/nou-cu-cod?familie=${fam}`));
  bine("și arată cum iese codul", /ET100|ET\d{3}/.test(p.corp));

  console.log("\n3. Produs nou din categoria făcută acum: codul iese singur");
  const lat = Number(unul(`SELECT id FROM cod_caracteristici WHERE familie_id = ${fam} AND nume = 'Lățime'`));
  const CP = require(path.join(RAD, "modules", "cod-produs.js"));
  const gen = await CP.genereaza({ [tip]: "Etichetă termică", [lat]: "58" }, fam);
  bine("codul generat e ET058", gen.ok && gen.cod === "ET058", JSON.stringify({ cod: gen.cod, lipsa: gen.lipsa, gresite: gen.gresite }));
  const scris = await CP.produsulAlegerilor({ [tip]: "Etichetă termică", [lat]: "58" }, fam, { um: "rolă" });
  bine("și produsul se scrie cu el", scris.creat && unul(`SELECT cod FROM produse WHERE id = ${scris.id}`) === "ET058");

  console.log("\n4. Copie după o categorie existentă");
  const plic = Number(unul("SELECT id FROM cod_familii WHERE nume = 'Plic AWB' AND activ = 1"));
  r = await cer("post", `${CALE}/familie`, VALI, {}, { nume: "TEST-CAT Plic mare", copie_din: String(plic) });
  const copie = famDin(r);
  const nCar = (f) => Number(unul(`SELECT COUNT(*) FROM cod_caracteristici WHERE familie_id = ${f}`));
  bine("are caracteristicile categoriei de la care a pornit", copie && nCar(copie) === Number(unul(`SELECT COUNT(*) FROM cod_caracteristici WHERE familie_id = ${plic} AND activ = 1`)), [nCar(copie)]);
  bine("cu valori cu tot, separat de original", Number(unul(`SELECT COUNT(*) FROM cod_valori v JOIN cod_caracteristici c ON c.id = v.caracteristica_id WHERE c.familie_id = ${copie}`)) > 0);
  bine("mesajul cere schimbarea începutului de cod", /Schimbă acum bucata de cod/.test(loc(r)), loc(r));
  p = await cer("get", CALE, VALI, {}, {}, { familie: String(copie) });
  bine("pagina avertizează că se lovește de „Plic AWB”", /începutul codului se poate lovi de altă categorie/.test(p.corp) && /din „Plic AWB”/.test(p.corp));

  console.log("\n5. Modificarea unei valori repară începutul");
  const tipCopie = Number(unul(`SELECT id FROM cod_caracteristici WHERE familie_id = ${copie} AND nume = 'Tip'`));
  const val = q(`SELECT id, valoare, cod FROM cod_valori WHERE caracteristica_id = ${tipCopie} ORDER BY id`)[0];
  r = await cer("post", `${CALE}/valoare/:id/editare`, VALI, { id: val.id }, { familie_id: String(copie), valoare: "Plic mare", cod: "", um: "" });
  bine("bucata de cod nu poate rămâne goală", /nu poate rămâne goală/.test(loc(r)) && unul(`SELECT cod FROM cod_valori WHERE id = ${val.id}`) === val.cod, loc(r));
  r = await cer("post", `${CALE}/valoare/:id/editare`, VALI, { id: val.id }, { familie_id: String(copie), valoare: "Plic mare", cod: "pm", um: "" });
  const dupa = q(`SELECT valoare, cod FROM cod_valori WHERE id = ${val.id}`)[0];
  bine("denumirea și bucata se schimbă (litere mari, fără spații)", dupa.valoare === "Plic mare" && dupa.cod === "PM", JSON.stringify(dupa));
  bine("și rămâne pe categoria la care lucra", loc(r).includes(`familie=${copie}`) && /salvată/.test(loc(r)), loc(r));
  p = await cer("get", CALE, VALI, {}, {}, { familie: String(copie) });
  bine("avertismentul a dispărut", !/începutul codului se poate lovi/.test(p.corp));
  await cer("post", `${CALE}/valoare`, VALI, {}, { familie_id: String(copie), caracteristica_id: String(tipCopie), "valoare[]": ["Plic mic"], "cod[]": ["PS"] });
  const mic = Number(unul(`SELECT id FROM cod_valori WHERE caracteristica_id = ${tipCopie} AND valoare = 'Plic mic'`));
  r = await cer("post", `${CALE}/valoare/:id/editare`, VALI, { id: mic }, { familie_id: String(copie), valoare: "Plic mic", cod: "PM" });
  bine("aceeași bucată la două valori din listă e refuzată", /e deja la altă valoare/.test(loc(r)) && unul(`SELECT cod FROM cod_valori WHERE id = ${mic}`) === "PS", loc(r));
  r = await cer("post", `${CALE}/valoare/:id/editare`, VALI, { id: mic }, { familie_id: String(copie), valoare: "plic mare", cod: "PS" });
  bine("la fel aceeași valoare de două ori", /există deja în listă/.test(loc(r)), loc(r));

  console.log("\n6. Redenumire și ștergere");
  r = await cer("post", `${CALE}/familie/:id/editare`, VALI, { id: String(copie) }, { nume: NUME, ordine: "51" });
  bine("redenumirea pe numele altei categorii e refuzată", /Există deja categoria/.test(loc(r)) && unul(`SELECT nume FROM cod_familii WHERE id = ${copie}`) === "TEST-CAT Plic mare", loc(r));
  r = await cer("post", `${CALE}/familie/:id/editare`, VALI, { id: String(copie) }, { nume: "TEST-CAT Plicuri mari", ordine: "51" });
  bine("altfel se redenumește", unul(`SELECT nume FROM cod_familii WHERE id = ${copie}`) === "TEST-CAT Plicuri mari");
  const valoriCopie = Number(unul(`SELECT COUNT(*) FROM cod_valori v JOIN cod_caracteristici c ON c.id = v.caracteristica_id WHERE c.familie_id = ${copie}`));
  const idsCar = q(`SELECT id FROM cod_caracteristici WHERE familie_id = ${copie}`).map((x) => x.id).join(",");
  r = await cer("post", `${CALE}/familie/:id/sterge`, VALI, { id: String(copie) });
  bine("o categorie fără produse se șterge de tot, cu valori cu tot",
    Number(unul(`SELECT COUNT(*) FROM cod_familii WHERE id = ${copie}`)) === 0 &&
    Number(unul(`SELECT COUNT(*) FROM cod_valori WHERE caracteristica_id IN (${idsCar || 0})`)) === 0 && valoriCopie > 0);
  r = await cer("post", `${CALE}/familie/:id/sterge`, VALI, { id: String(fam) });
  bine("una cu produse doar iese din uz", unul(`SELECT activ FROM cod_familii WHERE id = ${fam}`) === "0" && /are deja produse/.test(loc(r)), loc(r));
  bine("iar produsul ei rămâne cu codul lui", unul(`SELECT cod FROM produse WHERE id = ${scris.id}`) === "ET058");

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
