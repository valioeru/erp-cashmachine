"use strict";
// Text liber în codul produsului: furnizor + denumire, cu primele 2-3 litere
// în cod. Pe PostgreSQL real (portul 5433), prin rutele adevărate.
//
// CEREREA LUI VALI, 05.11.2026:
//   „La cod produs să fie și varianta să adaug o caracteristică cu câmp liber
//    și să ia automat primele 2-3 litere din aia. Vreau ca și practică: adaug
//    furnizor și denumire și să înceapă codul produsului cu 2-3 litere din
//    denumirea furnizorului."
//
// CE APĂRĂ:
//   • CODUL ÎNCEPE CU LITERELE FURNIZORULUI, apoi ale denumirii, apoi un număr
//     de ordine: WBVFOL01. „S.C." din fața firmei nu intră în cod.
//   • PRIMELE LITERE NU SUNT UNICE: alt furnizor sau alt produs cu aceleași
//     litere primește următorul număr, nu produsul celuilalt.
//   • ACELAȘI PRODUS SCRIS ALTFEL („S.C. WBV GMBH", spații duble) e recunoscut:
//     nu se face a doua oară, iar comanda cade pe el.
//   • UN COD SCRIS DE MÂNĂ care arată ca unul generat nu e lovit.
//   • CÂTE LITERE se alege din Configurări (2 sau 3).
//   • DOUĂ FERESTRE ÎN ACEEAȘI CLIPĂ fac un singur produs.
//   • CATEGORIA „furnizor + denumire” se face dintr-un click, iar formularele
//     (Produs nou și comanda) au căsuțe de text cu sugestii, inclusiv
//     furnizorii din Parteneri.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) {
    const err = new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message));
    // Ca driverul pg: indexul unic lovit are codul 23505.
    if (/duplicate key value violates unique constraint/.test(String(e.stderr || ""))) err.code = "23505";
    throw err;
  }
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

const C = require(path.join(RAD, "lib", "cod-produs.js"));
const K = require(path.join(RAD, "lib", "comanda-config.js"));
const CP = require(path.join(RAD, "modules", "cod-produs.js"));
const rute = { get: {}, post: {} };
CP.register({
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
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const NUME = "TEST-TXT Marfă de la furnizori";
function curata() {
  const fam = q(`SELECT id FROM cod_familii WHERE nume LIKE 'TEST-TXT%'`).map((r) => Number(r.id));
  const l = fam.join(",") || "0";
  const prod = q(`SELECT id FROM produse WHERE cod_familie_id IN (${l}) OR cod LIKE 'TXTMAN%' OR denumire LIKE 'TEST-TXT%'`).map((r) => Number(r.id));
  q(`DELETE FROM produse_cod_valori WHERE produs_id IN (${prod.join(",") || 0})`);
  q(`DELETE FROM produse WHERE id IN (${prod.join(",") || 0})`);
  q(`DELETE FROM cod_valori WHERE caracteristica_id IN (SELECT id FROM cod_caracteristici WHERE familie_id IN (${l}))`);
  q(`DELETE FROM cod_caracteristici WHERE familie_id IN (${l})`);
  q(`DELETE FROM cod_familii WHERE id IN (${l})`);
  q(`DELETE FROM parteneri WHERE nume IN ('TEST-TXT Qwerty Furnizor SRL', 'S.C. WBV GMBH')`);
}

(async () => {
  curata();
  const VALI = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali", rol: "admin" };

  console.log("\n1. Regula, fără bază de date");
  const car = [
    { id: 701, nume: "Furnizor", fel: "text", cifre: 3, ordine: 1, in_cod: 1, obligatoriu: 1 },
    { id: 702, nume: "Denumire", fel: "text", cifre: 3, ordine: 2, in_cod: 1, obligatoriu: 1 },
  ];
  let g = C.genereazaCod(car, { 701: "  S.C. WBV  GmbH ", 702: "Folie aluminiu" });
  egal("începutul: 3 litere din furnizor (fără „S.C.”) + 3 din denumire", g.prefix, "WBVFOL");
  egal("…și numărul de ordine se pune la salvare", [g.contor, g.ok], [true, true]);
  egal("denumirea produsului, cu textul curățat", g.denumire, "S.C. WBV GmbH Folie aluminiu");
  egal("semnătura nu ține de „S.C.”, spații sau majuscule",
    C.genereazaCod(car, { 701: "wbv gmbh", 702: "FOLIE  ALUMINIU" }).semnatura, g.semnatura);
  egal("ordinea caracteristicilor nu schimbă semnătura",
    C.genereazaCod([Object.assign({}, car[0], { ordine: 5 }), car[1]], { 701: "WBV GmbH", 702: "Folie aluminiu" }).semnatura, g.semnatura);
  egal("2 litere, când așa e setat", C.genereazaCod([Object.assign({}, car[0], { cifre: 2 })], { 701: "Delivery" }).prefix, "DE");
  egal("cifra din nume intră și ea (3M)", C.genereazaCod([car[0]], { 701: "3M Romania" }).prefix, "3MR");
  egal("„SCA Hygiene” nu e „S.C.”", C.genereazaCod([car[0]], { 701: "SCA Hygiene" }).prefix, "SCA");
  g = C.genereazaCod(car, { 701: "—", 702: "Folie" });
  bine("un text fără nicio literă e refuzat, cu motiv", !g.ok && /n-are nicio literă/.test(g.gresite.join(" ")), g.gresite);
  g = C.genereazaCod(car, { 702: "Folie" });
  egal("furnizorul lipsă e spus", g.lipsa, ["Furnizor"]);
  egal("primul număr liber după cele luate", C.codCuContor("WBVFOL", ["WBVFOL01", "WBVFOL03", "ALTCEVA01"]), "WBVFOL04");
  egal("primul cod al unui început nou", C.codCuContor("ABC", []), "ABC01");
  egal("text liber fără număr de litere scris → 3 litere",
    C.genereazaCod([{ id: 9, nume: "Furnizor", fel: "text", cifre: 0, ordine: 1 }], { 9: "Kartonaj" }).prefix, "KAR");
  egal("cum arată codul în Configurări", C.sablon(car).map((x) => x.exemplu).join(""), "ABCABC01");
  egal("la o categorie fără text, nimic nu se schimbă (folia: fără contor)",
    [C.genereazaCod([{ id: 1, nume: "Tip", fel: "lista", valori: [{ valoare: "Manuală", cod: "FSM" }] }], { 1: "Manuală" }).contor,
     C.genereazaCod([{ id: 1, nume: "Tip", fel: "lista", valori: [{ valoare: "Manuală", cod: "FSM" }] }], { 1: "Manuală" }).cod], [false, "FSM"]);

  console.log("\n2. Categoria „furnizor + denumire”, dintr-un click");
  let pag = await cer("get", CALE, VALI);
  bine("pornirea „furnizor + denumire (text liber)” e în listă", /<option value="sablon:furnizor">furnizor \+ denumire \(text liber\)<\/option>/.test(pag.corp));
  bine("felul „text liber” se poate alege la o caracteristică nouă", /<option value="text">text liber/.test(pag.corp));
  let r = await cer("post", `${CALE}/familie`, VALI, {}, { nume: NUME, copie_din: "sablon:furnizor" });
  const fam = famDin(r);
  bine("categoria e făcută și spune cum iese codul", fam > 0 && /WBVFOL01/.test(loc(r)), loc(r));
  const carac = q(`SELECT id, nume, fel, cifre, in_cod, obligatoriu FROM cod_caracteristici WHERE familie_id = ${fam} ORDER BY ordine`);
  egal("Furnizor și Denumire, text liber, 3 litere, în cod, obligatorii",
    carac.map((c) => [c.nume, c.fel, Number(c.cifre), Number(c.in_cod), Number(c.obligatoriu)]),
    [["Furnizor", "text", 3, 1, 1], ["Denumire", "text", 3, 1, 1]]);
  const [FZ, DEN] = carac.map((c) => Number(c.id));
  pag = await cer("get", CALE, VALI, {}, {}, { familie: String(fam) });
  bine("pagina arată „text liber” și câte litere", /text liber/.test(pag.corp) && /3 litere/.test(pag.corp));
  bine("…codul de exemplu are numărul de ordine", /ABCABC01/.test(pag.corp));
  bine("…și spune că produsul se recunoaște după tot textul", /se recunoaște după tot textul scris/.test(pag.corp));
  bine("…e gata de folosit", /gata de folosit/.test(pag.corp));

  console.log("\n3. Produs nou: WBV GmbH · Folie aluminiu → WBVFOL01");
  q(`INSERT INTO parteneri (tip, nume) VALUES ('furnizor', 'TEST-TXT Qwerty Furnizor SRL'), ('furnizor', 'S.C. WBV GMBH')`);
  const form = await cer("get", "/produse/nou-cu-cod", VALI, {}, {}, { familie: String(fam) });
  bine("căsuța de text pentru furnizor, cu sugestii", new RegExp(`<input type="text" name="c_${FZ}"[^>]*list="dl_c_${FZ}"`).test(form.corp));
  bine("…în care sunt și furnizorii din Parteneri", form.corp.includes('<option value="TEST-TXT Qwerty Furnizor SRL">'));
  bine("…și spune câte litere intră în cod", /În cod intră primele 3 litere/.test(form.corp));
  const nou = (fz, den, extra) => cer("post", "/produse/nou-cu-cod", VALI, {}, Object.assign({ familie: String(fam), ["c_" + FZ]: fz, ["c_" + DEN]: den, pret_vanzare: "10" }, extra || {}));
  const prev = await cer("post", "/produse/nou-cu-cod/preview", VALI, {}, { __familie: String(fam), [FZ]: "WBV GmbH", [DEN]: "Folie aluminiu" });
  const px = JSON.parse(prev.corp || "{}");
  egal("previzualizarea arată codul care va ieși", [px.cod, px.ok, Boolean(px.exista)], ["WBVFOL01", true, false]);
  r = await nou("WBV GmbH", "Folie aluminiu");
  const p1 = Number((loc(r).match(/\/produse\/(\d+)/) || [])[1] || 0);
  const rand1 = q(`SELECT cod, cod_generat, cod_semnatura, denumire FROM produse WHERE id = ${p1}`)[0] || {};
  egal("produsul are codul WBVFOL01 și peste tot (cod = cod generat)", [rand1.cod, rand1.cod_generat], ["WBVFOL01", "WBVFOL01"]);
  bine("ține minte tot ce s-a scris (semnătura)", /WBVGMBH/.test(rand1.cod_semnatura || "") && /FOLIEALUMINIU/.test(rand1.cod_semnatura || ""), rand1.cod_semnatura);
  egal("pe fișă: furnizorul și denumirea, cu bucata lor de cod",
    q(`SELECT nume, valoare, bucata FROM produse_cod_valori WHERE produs_id = ${p1} ORDER BY id`).map((x) => [x.nume, x.valoare, x.bucata]),
    [["Furnizor", "WBV GmbH", "WBV"], ["Denumire", "Folie aluminiu", "FOL"]]);

  console.log("\n4. Aceleași litere, alt produs → următorul număr");
  r = await nou("WBV Pack", "Folie PE");
  const p2 = Number((loc(r).match(/\/produse\/(\d+)/) || [])[1] || 0);
  egal("WBV Pack · Folie PE → WBVFOL02", unul(`SELECT cod_generat FROM produse WHERE id = ${p2}`), "WBVFOL02");
  r = await nou("WBV GmbH", "Folie stretch");
  egal("același furnizor, altă folie → WBVFOL03", unul(`SELECT cod_generat FROM produse WHERE id = ${Number((loc(r).match(/\/produse\/(\d+)/) || [])[1] || 0)}`), "WBVFOL03");

  console.log("\n5. Același produs scris altfel e recunoscut");
  r = await nou("S.C. WBV GMBH", "folie   aluminiu");
  bine("Produs nou îl oprește și trimite la cel existent", r.cod === 400 && r.corp.includes(`href="/produse/${p1}"`) && /există deja/.test(r.corp), r.cod);
  egal("nu s-a scris al doilea", Number(unul(`SELECT COUNT(*) FROM produse WHERE cod_familie_id = ${fam}`)), 3);
  const deLaComanda = await CP.produsulAlegerilor({ [FZ]: "wbv gmbh", [DEN]: "Folie Aluminiu" }, fam, { um: "rola" });
  egal("de pe comandă cade pe ACELAȘI produs", [deLaComanda.id, deLaComanda.creat], [p1, false]);

  console.log("\n6. Un cod scris de mână nu e lovit");
  q(`INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('WBVFOL04', 'TEST-TXT produs vechi cu cod de mână', 'buc')`);
  r = await nou("WBV GmbH", "Folie bule");
  egal("următorul trece peste WBVFOL04 scris de mână → WBVFOL05", unul(`SELECT cod_generat FROM produse WHERE id = ${Number((loc(r).match(/\/produse\/(\d+)/) || [])[1] || 0)}`), "WBVFOL05");

  console.log("\n7. Câte litere se schimbă din Configurări");
  r = await cer("post", `${CALE}/:id/editare`, VALI, { id: String(FZ) }, { familie_id: String(fam), nume: "Furnizor", ordine: "1", cifre: "2", in_cod: "1", obligatoriu: "1", activ: "1" });
  egal("Furnizor pe 2 litere", Number(unul(`SELECT cifre FROM cod_caracteristici WHERE id = ${FZ}`)), 2);
  r = await nou("Delivery Solutions", "Cutie mare");
  egal("Delivery Solutions · Cutie mare → DECUT01", unul(`SELECT cod_generat FROM produse WHERE id = ${Number((loc(r).match(/\/produse\/(\d+)/) || [])[1] || 0)}`), "DECUT01");
  egal("felul nu se schimbă din Modifică (rămâne text)", unul(`SELECT fel FROM cod_caracteristici WHERE id = ${FZ}`), "text");
  r = await cer("post", `${CALE}/caracteristica`, VALI, {}, { familie_id: String(fam), nume: "Cod furnizor", fel: "text", cifre: "", ordine: "3", min_val: "5", max_val: "9", um: "kg" });
  egal("o caracteristică text nouă: 3 litere implicit, fără UM sau interval",
    q(`SELECT fel, cifre, um, min_val, max_val, in_cod FROM cod_caracteristici WHERE familie_id = ${fam} AND nume = 'Cod furnizor'`).map((x) => [x.fel, Number(x.cifre), x.um, x.min_val, x.max_val, Number(x.in_cod)]),
    [["text", 3, null, null, null, 0]]);

  console.log("\n8. Două ferestre în aceeași clipă fac un singur produs");
  const [a, b] = await Promise.all([
    CP.produsulAlegerilor({ [FZ]: "Gama Pack", [DEN]: "Bandă" }, fam, { um: "buc" }),
    CP.produsulAlegerilor({ [FZ]: "GAMA PACK", [DEN]: "bandă" }, fam, { um: "buc" }),
  ]);
  egal("amândouă pe același produs", a.id === b.id && a.id > 0, true);
  egal("unul l-a scris, celălalt l-a găsit", [a.creat, b.creat].sort(), [false, true]);
  egal("un singur produs Gama Pack · Bandă", Number(unul(`SELECT COUNT(*) FROM produse WHERE cod_familie_id = ${fam} AND cod_generat LIKE 'GABAN%'`)), 1);
  // Două produse DIFERITE, cu aceleași litere, în aceeași clipă: amândouă
  // ar lua GABAN02. Al doilea trebuie să ia GABAN03, nu produsul primului.
  const [c1, c2] = await Promise.all([
    CP.produsulAlegerilor({ [FZ]: "Gama Pack", [DEN]: "Banderolă" }, fam, { um: "buc" }),
    CP.produsulAlegerilor({ [FZ]: "Gama Pack", [DEN]: "Bandă albă" }, fam, { um: "buc" }),
  ]);
  egal("două produse diferite cu aceleași litere: două produse, amândouă noi", [c1.id !== c2.id, c1.creat, c2.creat], [true, true, true]);
  egal("…cu numere diferite", q(`SELECT cod_generat FROM produse WHERE id IN (${c1.id}, ${c2.id}) ORDER BY cod_generat`).map((x) => x.cod_generat), ["GABAN02", "GABAN03"]);
  egal("…și fiecare cu textul lui", [unul(`SELECT valoare FROM produse_cod_valori WHERE produs_id = ${c1.id} AND caracteristica_id = ${DEN}`), unul(`SELECT valoare FROM produse_cod_valori WHERE produs_id = ${c2.id} AND caracteristica_id = ${DEN}`)], ["Banderolă", "Bandă albă"]);

  console.log("\n8b. Text liber amestecat cu listă și număr: contează toate");
  let r2 = await cer("post", `${CALE}/familie`, VALI, {}, { nume: "TEST-TXT Mixt" });
  const famM = famDin(r2);
  await cer("post", `${CALE}/caracteristica`, VALI, {}, { familie_id: String(famM), nume: "Furnizor", fel: "text", cifre: "3", ordine: "1", in_cod: "1", obligatoriu: "1" });
  await cer("post", `${CALE}/caracteristica`, VALI, {}, { familie_id: String(famM), nume: "Culoare", fel: "lista", ordine: "2", in_cod: "1", obligatoriu: "1" });
  await cer("post", `${CALE}/caracteristica`, VALI, {}, { familie_id: String(famM), nume: "Lățime", fel: "numar", cifre: "3", ordine: "3", in_cod: "1", obligatoriu: "1", um: "mm" });
  const [mFz, mCul, mLat] = q(`SELECT id FROM cod_caracteristici WHERE familie_id = ${famM} ORDER BY ordine`).map((x) => Number(x.id));
  q(`INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine) VALUES (${mCul}, 'Alb', 'A', 1), (${mCul}, 'Alb mat', 'A', 2)`);
  const m1 = await CP.produsulAlegerilor({ [mFz]: "WBV GmbH", [mCul]: "Alb", [mLat]: "50" }, famM, {});
  const m2 = await CP.produsulAlegerilor({ [mFz]: "WBV GmbH", [mCul]: "Alb mat", [mLat]: "50" }, famM, {});
  egal("aceleași litere și același cod de culoare, dar alb ≠ alb mat: două produse", [m1.creat, m2.creat, m1.id !== m2.id], [true, true, true]);
  egal("…WBVA05001 și WBVA05002", q(`SELECT cod_generat FROM produse WHERE id IN (${m1.id}, ${m2.id}) ORDER BY cod_generat`).map((x) => x.cod_generat), ["WBVA05001", "WBVA05002"]);
  const m3 = await CP.produsulAlegerilor({ [mFz]: "wbv gmbh", [mCul]: "alb", [mLat]: "50.0" }, famM, {});
  egal("…iar „wbv gmbh · alb · 50.0” e primul, nu al treilea", [m3.id, m3.creat], [m1.id, false]);

  console.log("\n9. Pe comandă: căsuța de text cu sugestii");
  const famC = await CP.citesteCaracteristici(false, fam);
  for (const c of famC) if (c.fel === "text") c.sugestii = await CP.sugestiiText(c);
  const campuri = K.campuriFamiliei(famC);
  const cf = campuri.find((c) => c.id === FZ);
  egal("felul text ajunge în pagină, cu câte litere", [cf.fel, cf.litere], ["text", 2]);
  bine("sugestiile au furnizorii scriși deja și pe cei din Parteneri", cf.sugestii.includes("WBV GmbH") && cf.sugestii.includes("TEST-TXT Qwerty Furnizor SRL"), cf.sugestii.slice(0, 6));
  bine("„S.C. WBV GMBH” nu apare a doua oară lângă „WBV GmbH”", !cf.sugestii.includes("S.C. WBV GMBH"));
  const prevC = await CP.genereaza(K.alegeriDin({ ["c_" + FZ]: "WBV GmbH", ["c_" + DEN]: "Folie aluminiu" }), fam);
  egal("previzualizarea de pe comandă: există deja, cu codul lui", [prevC.cod, Boolean(prevC.exista), K.sePoateComanda(prevC)], ["WBVFOL01", true, true]);
  // Panoul de pe comandă desenează căsuța de text (scriptul din pagină).
  const ruteCmd = { get: {}, post: {} };
  require(path.join(RAD, "modules", "comenzi.js")).register({
    get: (p, h) => { if (!ruteCmd.get[p]) ruteCmd.get[p] = h; },
    post: (p, h) => { if (!ruteCmd.post[p]) ruteCmd.post[p] = h; },
    put: () => {}, delete: () => {},
  });
  const rc = res();
  await ruteCmd.get["/comenzi/nou"]({ user: VALI, params: {}, query: {}, body: {}, res: rc, req: { url: "/comenzi/nou" } });
  bine("pe /comenzi/nou, panoul are căsuța de text cu sugestii", rc.corp.includes(`'<input type="text" class="config-val"`) && /"fel":"text"/.test(rc.corp), rc.cod);
  // …și chiar o desenează: scriptul paginii, rulat într-un Chromium adevărat,
  // pe un panou cu familia asta aleasă.
  let chromium = null;
  try { chromium = require("playwright").chromium; } catch (_) {}
  if (!chromium) console.log("  (sar: playwright lipsește)");
  else {
    const br = await chromium.launch();
    try {
      const pg = await br.newPage();
      await pg.route("**/*", (rt) => rt.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
      await pg.setContent(rc.corp, { waitUntil: "domcontentloaded" });
      const desenat = await pg.evaluate((famId) => {
        window.fetch = () => new Promise(() => {});
        const d = document.createElement("div");
        d.className = "config-produs";
        d.innerHTML = '<select class="config-familie"><option value="' + famId + '" selected>x</option></select>' +
          '<div class="config-campuri"></div><div class="config-cod"></div><div class="config-den"></div>' +
          '<div class="config-avertisment"></div><button class="config-ia"></button>';
        document.body.appendChild(d);
        comenziCampuri(d.querySelector(".config-familie"));
        const t = [...d.querySelectorAll('.config-campuri input[type="text"].config-val')];
        const dl = t[0] && t[0].list ? [...t[0].list.options].map((o) => o.value) : [];
        return { text: t.length, sugestii: dl.slice(0, 50) };
      }, String(fam));
      egal("panoul desenează căsuțele de text (Furnizor, Denumire, Cod furnizor)", desenat.text, 3);
      bine("…cu sugestiile furnizorului", desenat.sugestii.includes("WBV GmbH"), desenat.sugestii);
    } finally {
      await br.close();
    }
  }

  curata();
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); } catch (_) {}
  process.exit(1);
});
