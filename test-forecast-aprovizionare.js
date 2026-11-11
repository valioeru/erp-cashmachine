"use strict";
// Procurement · Forecast de comandat: ce e de comandat ca să fie mereu stoc.
//
// CE A CERUT VALI, 11.11.2026: „Vreau o pagină de forecast cu produse de
// comandat astfel încât să am stoc mereu, bazat pe istoric vânzări și comenzi
// în curs, care ar trebui, în funcție de rețete, să calculeze stocul consumat.
// Fă-o ca pe o pagină distinctă în Procurement."
//
// CE APĂRĂ:
//   • SOCOTEALA (lib/forecast-aprovizionare.js), cu numere știute: de comandat
//     = comenzile în curs + consumul pe zilele de acoperire − stoc − pe drum;
//     cererea coboară prin rețete nivel cu nivel, după ce se scade produsul
//     finit existent și producția începută; producția neîncepută se face
//     oricum; regia din rețete nu e marfă.
//   • COMENZILE ÎN CURS: comenzile clienților minus ce a plecat (ieșit din
//     depozit sau facturat parțial — cea mai mare dintre ele, nu suma);
//     producția pentru un client fără comandă în ERP e cerere; pe același
//     client, comanda și producția lui nu se adună; producția legată de o
//     comandă și cea pentru stoc nu sunt cerere în plus.
//   • VÂNZĂRILE: doar facturile de vânzare din fereastră, fără anulate, ciorne,
//     șterse și între firmele grupului; stornările scad; produsul unit în altul
//     se socotește pe cel păstrat.
//   • STOCUL în altă unitate decât a produsului nu intră și se spune.
//   • CÂND SE TERMINĂ: ziua în care cererea trece de stoc, cu și fără ce e pe drum.
//   • PAGINA: rândurile, legătura „comandă →", bifele, atenționările; aceeași
//     pagină la adresa veche din Depozit; submeniul din Procurement.
//   • COMANDA LA FURNIZOR pornită din forecast vine cu produsele și cantitățile.
//
// Socoteala se verifică fără bază de date; datele și pagina, pe PostgreSQL real
// (port 5433), prin psql; bifele, într-un browser.
const path = require("path");
const fs = require("fs");
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-f", "-"], { env: ENV, encoding: "utf8", input: s, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length }; },
});

const F = require(path.join(RAD, "lib", "forecast-aprovizionare.js"));
const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "forecast.js")).register(router);
require(path.join(RAD, "modules", "comenzi-furnizor.js")).register(router);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(cale, user, query) {
  const h = rute.get[cale];
  if (!h) throw new Error("nicio rută pentru GET " + cale);
  const r = res();
  await h({ user, params: {}, query: query || {}, body: {}, res: r, req: { url: cale, method: "GET", headers: {} } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 700) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
function contine(d, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !String(corp).includes(b));
  const gasite = (interzise || []).filter((b) => String(corp).includes(b));
  bine(d, !lipsa.length && !gasite.length, (lipsa.length ? "lipsește: " + lipsa.join(" | ") : "") + (gasite.length ? " n-ar trebui: " + gasite.join(" | ") : ""));
}
let ajunsLaCapat = false;
process.on("exit", () => {
  if (ajunsLaCapat) return;
  console.log("\nTESTUL S-A OPRIT ÎNAINTE DE CAPĂT.");
  process.exitCode = 1;
});

// ---- ajutoare pentru socoteala fără bază ----------------------------------
const AZI = "2026-11-11";
// Un produs: [id, denumire, um, categorie]; categorie "" = fără încadrare.
const prod = (lista) => lista.map(([id, denumire, um, categorie, extra]) => Object.assign({ id, denumire, unitate_masura: um, categorie: categorie === undefined ? "Categorie" : categorie }, extra || {}));
const stocDe = (id, cant, um, intrari, alteUm) => ({ produs_id: id, um, stoc: cant, alteUm: alteUm || [], intrari: intrari || [] });
const deLaFurnizor = (cant, um, data, document) => ({ fel: "furnizor", cantitate: cant, um, data: data || "", document: document || "CF", document_id: 1, furnizor: "F" });
const productie = (cant, um, stare, extra) => Object.assign({ fel: "productie", cantitate: cant, um, stare, document: "CP", document_id: 1, client: "", cheieClient: "", comanda_id: null }, extra || {});
const socoteste = (d, opt) => F.calculeaza(Object.assign({ azi: AZI, retete: [], vanzari: [], comenzi: [], iesite: [], stoc: [], furnizori: new Map() }, d), Object.assign({ zile: 30, fereastra: 90 }, opt || {}));
const rand = (r, id) => r.deCumparat.find((x) => x.produs_id === id);
const facut = (r, id) => r.deProdus.find((x) => x.produs_id === id);
const pe = (x, chei) => (x ? chei.map((k) => x[k]) : null);

// ---- datele de test din bază -----------------------------------------------
const PREFIX = "TFC";
const [PUNGA, FOLIE, GRANULA, BANDA, SERVICIU, ROLA, VECHI, CUTIE, REGIE] = [9710001, 9710002, 9710003, 9710004, 9710005, 9710006, 9710007, 9710008, 9710010];
const PRODUSE = [PUNGA, FOLIE, GRANULA, BANDA, SERVICIU, ROLA, VECHI, CUTIE, REGIE];
const [C1, C2, F1] = [9710101, 9710102, 9710111];
const FACTURI = [9710201, 9710202, 9710203, 9710204, 9710205, 9710206, 9710207, 9710208, 9710209, 9710210];
const [O1, O2, O3, O4, O5] = [9710301, 9710302, 9710303, 9710304, 9710305];
const [CF0, CF1, CF2] = [9710401, 9710402, 9710403];
const [CP1, CP2, CP3, CP4, CP5] = [9710501, 9710502, 9710503, 9710504, 9710505];

function curata() {
  const pr = PRODUSE.join(",");
  const pal = q(`SELECT id FROM ct_paleti WHERE cod LIKE '${PREFIX}-PAL-%'`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${pal}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${pal})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${pal})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${pal})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${pal})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${[CP1, CP2, CP3, CP4, CP5].join(",")})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${[CP1, CP2, CP3, CP4, CP5].join(",")})`);
  q(`DELETE FROM comenzi_furnizor_linii WHERE comanda_id IN (${[CF0, CF1, CF2].join(",")})`);
  q(`DELETE FROM comenzi_furnizor WHERE id IN (${[CF0, CF1, CF2].join(",")})`);
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${[O1, O2, O3, O4, O5].join(",")})`);
  q(`DELETE FROM comenzi WHERE id IN (${[O1, O2, O3, O4, O5].join(",")})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${FACTURI.join(",")})`);
  q(`DELETE FROM facturi WHERE id IN (${FACTURI.join(",")})`);
  q(`DELETE FROM retete_componente WHERE produs_id IN (${pr}) OR componenta_id IN (${pr})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM parteneri WHERE id IN (${C1}, ${C2}, ${F1})`);
}
let nrPalet = 0;
function palet(produs, text, cant, um) {
  const cod = `${PREFIX}-PAL-${++nrPalet}`;
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, produs_text, cantitate, cantitate_intrare, um, data_intrare) VALUES ('${cod}', ${produs || "NULL"}, ${text ? lit(text) : "NULL"}, ${cant}, ${cant}, '${um}', '2026-11-01') RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um) VALUES (${id}, ${produs || "NULL"}, ${text ? lit(text) : "NULL"}, ${cant}, '${um}')`);
  return id;
}
const fara = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const randPagina = (html, id) => { const m = new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?href="/produse/${id}"[\\s\\S]*?</tr>`).exec(html); return m ? m[0] : ""; };
const celule = (tr) => (tr.match(/<td>[\s\S]*?<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

(async () => {
  // ========================================================== A. SOCOTEALA
  console.log("\n1. Lanțul întreg: pungă ← folie ← granulă, cu numere știute");
  // 90.000 de pungi vândute în 90 de zile = 1.000 pe zi. O pungă cere 0,01 kg
  // de folie; un kg de folie cere 1,05 kg de granulă. „Salarii" e regie.
  const P1 = prod([[1, "Punga", "buc"], [2, "Folie", "kg"], [3, "Granula", "kg"], [4, "Salarii - Salarii", "buc", ""], [5, "Banda", "buc"]]);
  const R1 = [{ produs_id: 1, componenta_id: 2, cantitate: 0.01 }, { produs_id: 2, componenta_id: 3, cantitate: 1.05 }, { produs_id: 1, componenta_id: 4, cantitate: 0.5 }];
  const V1 = [{ produs_id: 1, cantitate: 90000, luni: 3, ultima: "2026-11-05" }, { produs_id: 5, cantitate: 900, luni: 3, ultima: "2026-11-01" }];
  const S1 = [stocDe(1, 10000, "buc"), stocDe(2, 50, "kg"), stocDe(3, 100, "kg", [deLaFurnizor(200, "kg", "2026-11-20", "CF-1")]), stocDe(5, 100, "buc")];
  const O_1 = [{ comanda_id: 7, numar: "C7", partener_id: 9, client: "Client", produs_id: 1, cantitate: 20000, cantitate_livrata: 0 }];
  let r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: S1, comenzi: O_1 });
  egal("de făcut din pungă: comanda de 20.000 + 30.000 pe 30 de zile − 10.000 pe stoc", pe(facut(r, 1), ["inCurs", "consumLuna", "stoc", "necesar", "deFacut"]), [20000, 30000, 10000, 50000, 40000]);
  egal("de făcut din folie: 40.000 × 0,01 = 400 kg cerute − 50 pe stoc", pe(facut(r, 2), ["necesar", "stoc", "deFacut"]), [400, 50, 350]);
  egal("granula: 350 × 1,05 = 367,5 cerute; stoc 100, pe drum 200 → de comandat 67,5", pe(rand(r, 3), ["necesar", "stoc", "vine", "deComandat"]), [367.5, 100, 200, 67.5]);
  egal("…comenzile în curs îi cer acum 52,5 (10.000 de pungi nefăcute → 100 kg folie − 50 pe stoc → × 1,05)", rand(r, 3).inCurs, 52.5);
  egal("…consumul pe lună, din vânzări, fără stocuri: 30.000 pungi → 300 kg folie → 315 kg", rand(r, 3).consumLuna, 315);
  egal("…stocul ajunge 5 zile (16.11); cu ce e pe drum, 24 (05.12)", pe(rand(r, 3), ["zileStoc", "dataStoc", "zileCuDrum", "dataCuDrum"]), [5, "2026-11-16", 24, "2026-12-05"]);
  egal("…și spune pentru ce e: folia, toată", rand(r, 3).dinCe.map((d) => [d.denumire, d.cantitate, d.parte]), [["Folie", 367.5, 1]]);
  egal("…cu comanda la furnizor pe drum, cu data ei", rand(r, 3).vineDocumente.map((d) => [d.document, d.cantitate, d.data]), [["CF-1", 200, "2026-11-20"]]);
  egal("…starea: de comandat (comenzile în curs sunt acoperite din stoc)", rand(r, 3).stare, "de_comandat");
  egal("marfa de revânzare: 10 pe zi × 30 − 100 pe stoc = 200; stocul ajunge 11 zile", pe(rand(r, 5), ["consumLuna", "inCurs", "necesar", "deComandat", "zileStoc", "zileCuDrum"]), [300, 0, 300, 200, 11, 11]);
  egal("regia din rețetă nu e marfă: nici de comandat, nici de făcut", [rand(r, 4), facut(r, 4)], [undefined, undefined]);
  egal("produsele făcute de noi nu apar la „de cumpărat”, iar cele cumpărate nu apar la „de făcut”", [rand(r, 1), rand(r, 2), facut(r, 3), facut(r, 5)], [undefined, undefined, undefined, undefined]);
  egal("ce s-a luat în calcul", pe(r.note, ["produseVandute", "cuReteta", "comenziClienti", "productiiInCurs"]), [2, 1, 1, 0]);

  console.log("\n2. Zilele de acoperire și fereastra de istoric");
  egal("cu 60 de zile: granula 682,5 cerute → de comandat 383 (rotunjit în sus)", pe(rand(socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: S1, comenzi: O_1 }, { zile: 60 }), 3), ["necesar", "deComandat"]), [682.5, 383]);
  egal("cu 15 zile: 210 cerute, sub stoc + pe drum → nimic de comandat, „acoperit”", pe(rand(socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: S1, comenzi: O_1 }, { zile: 15 }), 3), ["necesar", "deComandat", "stare"]), [210, 0, "acoperit"]);
  egal("aceleași vânzări pe o fereastră de 180 de zile înseamnă jumătate din ritm", pe(rand(socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: S1 }, { fereastra: 180 }), 5), ["consumLuna", "deComandat"]), [150, 50]);
  r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: S1 }, { zile: 7, fereastra: 33 });
  egal("zile sau fereastră care nu sunt în listă: rămân cele din oficiu (30 și 90)", [r.zile, r.fereastra], [30, 90]);
  egal("listele oferite", [F.ACOPERIRI, F.FERESTRE], [[15, 30, 45, 60, 90], [90, 180, 365]]);
  const cresc = F.ACOPERIRI.map((z) => rand(socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: S1, comenzi: O_1 }, { zile: z }), 3).deComandat);
  bine("mai multe zile de acoperire nu cer niciodată mai puțin", cresc.every((v, i) => i === 0 || v >= cresc[i - 1]), cresc.join(","));

  console.log("\n3. Ce există deja se scade înainte să se ceară materie primă");
  r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: [stocDe(1, 60000, "buc"), stocDe(2, 0, "kg"), stocDe(3, 0, "kg")], comenzi: O_1 });
  egal("pungi destule pe stoc (60.000 față de 50.000 cerute): nu mai trebuie nici folie, nici granulă", [facut(r, 1), facut(r, 2), rand(r, 3).necesar, rand(r, 3).deComandat, rand(r, 3).stare], [undefined, undefined, 0, 0, "acoperit"]);
  egal("…dar consumul lunar al granulei se vede în continuare", rand(r, 3).consumLuna, 315);
  r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: [stocDe(1, 10000, "buc", [productie(15000, "buc", "in_productie")]), stocDe(2, 50, "kg"), stocDe(3, 100, "kg")], comenzi: O_1 });
  egal("producția începută e ca și făcută: 15.000 de pungi în lucru scad din ce e de făcut", pe(facut(r, 1), ["inProductie", "deFacut"]), [15000, 25000]);
  egal("…deci granula cerută scade la (250 − 50) × 1,05 = 210", rand(r, 3).necesar, 210);
  r = socoteste({ produse: P1, retete: R1, vanzari: [], stoc: [stocDe(1, 0, "buc", [productie(8000, "buc", "noua")]), stocDe(2, 0, "kg"), stocDe(3, 0, "kg")] });
  egal("producția neîncepută se face oricum, chiar fără nicio vânzare și nicio comandă: 8.000 de pungi → 80 kg folie → 84 kg granulă", [pe(facut(r, 1), ["neinceput", "deFacut"]), facut(r, 2).deFacut, pe(rand(r, 3), ["inCurs", "necesar", "deComandat", "stare"])], [[8000, 8000], 80, [84, 84, 84, "lipsa"]]);
  r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: [stocDe(1, 10000, "buc", [productie(8000, "buc", "noua")]), stocDe(2, 50, "kg"), stocDe(3, 100, "kg")], comenzi: O_1 });
  egal("…iar când cererea e oricum mai mare, producția planificată nu se adună peste ea", facut(r, 1).deFacut, 40000);
  r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: [stocDe(1, 100000, "buc", [productie(8000, "buc", "noua")]), stocDe(2, 0, "kg"), stocDe(3, 0, "kg")] });
  egal("…și nu coboară sub ea când stocul de pungi ar acoperi tot", facut(r, 1).deFacut, 8000);
  r = socoteste({ produse: P1, retete: R1, vanzari: V1, stoc: [stocDe(1, 10000, "buc"), stocDe(2, 50, "kg", [deLaFurnizor(500, "kg")]), stocDe(3, 100, "kg")], comenzi: O_1 });
  egal("un produs făcut de noi, dar și comandat la furnizor: ce e pe drum se scade și el", [facut(r, 2), rand(r, 3).necesar], [undefined, 0]);

  console.log("\n4. Comenzile în curs");
  const P4 = prod([[1, "Marfa", "buc"]]);
  const cmd = (id, partener, cant, livrat) => ({ comanda_id: id, numar: "C" + id, partener_id: partener, client: "Client " + partener, produs_id: 1, cantitate: cant, cantitate_livrata: livrat || 0 });
  r = socoteste({ produse: P4, comenzi: [cmd(1, 5, 100), cmd(2, 6, 40)], stoc: [] });
  egal("două comenzi deschise se adună; fără stoc: lipsește acum tot", pe(rand(r, 1), ["inCurs", "necesar", "deComandat", "lipsaAcum", "stare", "zileStoc"]), [140, 140, 140, 140, "lipsa", 0]);
  r = socoteste({ produse: P4, comenzi: [cmd(1, 5, 100)], iesite: [{ comanda_id: 1, produs_id: 1, cantitate: 30 }], stoc: [] });
  egal("ce a ieșit deja din depozit pe comandă nu mai e de dat", rand(r, 1).inCurs, 70);
  r = socoteste({ produse: P4, comenzi: [cmd(1, 5, 100, 45)], stoc: [] });
  egal("nici ce s-a facturat parțial", rand(r, 1).inCurs, 55);
  r = socoteste({ produse: P4, comenzi: [cmd(1, 5, 100, 45)], iesite: [{ comanda_id: 1, produs_id: 1, cantitate: 30 }], stoc: [] });
  egal("ieșit 30 și facturat 45 e aceeași marfă: se scade 45, nu 75", rand(r, 1).inCurs, 55);
  r = socoteste({ produse: P4, comenzi: [cmd(1, 5, 100, 100), cmd(2, 6, 50)], iesite: [{ comanda_id: 2, produs_id: 1, cantitate: 80 }], stoc: [stocDe(1, 5, "buc")], vanzari: [{ produs_id: 1, cantitate: 90 }] });
  egal("comanda dată toată (sau cu mai mult ieșit decât comandat) nu mai cere nimic", pe(rand(r, 1), ["inCurs", "necesar"]), [0, 30]);
  r = socoteste({ produse: P4, comenzi: [{ comanda_id: 1, numar: "C1", partener_id: 5, client: "X", produs_id: 1, cantitate: 60 }, { comanda_id: 1, numar: "C1", partener_id: 5, client: "X", produs_id: 1, cantitate: 40 }], iesite: [{ comanda_id: 1, produs_id: 1, cantitate: 30 }], stoc: [] });
  egal("același produs pe două linii ale aceleiași comenzi: se adună, iar ieșirea se scade o singură dată", rand(r, 1).inCurs, 70);
  egal("documentele comenzilor în curs rămân pe rând", socoteste({ produse: P4, comenzi: [cmd(1, 5, 100)], stoc: [] }).deCumparat[0].documente, [{ fel: "comanda", document: "C1", document_id: 1, client: "Client 5", cantitate: 100 }]);

  console.log("\n5. Producția ca cerere");
  const P5 = prod([[1, "Punga", "buc"], [2, "Folie", "kg"]]);
  const R5 = [{ produs_id: 1, componenta_id: 2, cantitate: 0.01 }];
  const s5 = (intrari) => [stocDe(1, 0, "buc", intrari), stocDe(2, 0, "kg")];
  r = socoteste({ produse: P5, retete: R5, stoc: s5([productie(5000, "buc", "noua", { cheieClient: "p:9", client: "Sameday" })]) });
  egal("producție pentru un client, fără comanda lui în ERP, neîncepută: e cerere și cere materie primă", [pe(facut(r, 1), ["inCurs", "deFacut"]), rand(r, 2).inCurs], [[5000, 5000], 50]);
  egal("…cu documentul ei", facut(r, 1).documente, [{ fel: "productie", document: "CP", client: "Sameday", cantitate: 5000 }]);
  r = socoteste({ produse: P5, retete: R5, stoc: s5([productie(5000, "buc", "in_productie", { cheieClient: "p:9", client: "Sameday" })]) });
  egal("aceeași, începută: și-a luat deja materia primă", [facut(r, 1), rand(r, 2)], [undefined, undefined]);
  r = socoteste({ produse: P5, retete: R5, stoc: s5([productie(5000, "buc", "noua", { cheieClient: "p:9", client: "Sameday" })]), comenzi: [{ comanda_id: 3, numar: "C3", partener_id: 9, client: "Sameday", produs_id: 1, cantitate: 3000 }] });
  egal("același client are și comandă (3.000) și producție fără comandă (5.000): e aceeași marfă, se ia cea mai mare", facut(r, 1).inCurs, 5000);
  r = socoteste({ produse: P5, retete: R5, stoc: s5([productie(5000, "buc", "noua", { cheieClient: "p:9", client: "Sameday" })]), comenzi: [{ comanda_id: 3, numar: "C3", partener_id: 8, client: "Altul", produs_id: 1, cantitate: 3000 }] });
  egal("alt client: se adună", facut(r, 1).inCurs, 8000);
  r = socoteste({ produse: P5, retete: R5, stoc: s5([productie(5000, "buc", "noua", { cheieClient: "p:9", client: "Sameday", comanda_id: 3 })]), comenzi: [{ comanda_id: 3, numar: "C3", partener_id: 9, client: "Sameday", produs_id: 1, cantitate: 5000 }] });
  egal("producția legată de comanda clientului nu e o cerere în plus", pe(facut(r, 1), ["inCurs", "deFacut"]), [5000, 5000]);
  r = socoteste({ produse: P5, retete: R5, vanzari: [{ produs_id: 1, cantitate: 9000 }], stoc: s5([productie(5000, "buc", "in_productie")]) });
  egal("producția pentru stoc (fără client), începută: nu e cerere, ci acoperă vânzările viitoare — 3.000 pe lună < 5.000 în lucru", [facut(r, 1), rand(r, 2).necesar], [undefined, 0]);
  r = socoteste({ produse: P5, retete: R5, vanzari: [{ produs_id: 1, cantitate: 9000 }], stoc: s5([productie(5000, "buc", "noua")]) });
  egal("producția pentru stoc, neîncepută: tot nu e cerere, dar se face — 5.000, nu 3.000 + 5.000", pe(facut(r, 1), ["inCurs", "neinceput", "deFacut"]), [0, 5000, 5000]);
  r = socoteste({ produse: P5, retete: R5, stoc: s5([productie(5000, "role", "noua", { cheieClient: "p:9" })]) });
  egal("producția scrisă în altă unitate decât a produsului nu se poate socoti", [facut(r, 1), r.note.productiiInCurs], [undefined, 0]);

  console.log("\n6. Vânzările");
  r = socoteste({ produse: prod([[1, "Marfa", "buc"], [2, "Cod vechi", "buc", "Categorie", { fuzionat_in: 1, activ: 0 }]]), vanzari: [{ produs_id: 1, cantitate: 600, luni: 2, ultima: "2026-10-01" }, { produs_id: 2, cantitate: 300, luni: 3, ultima: "2026-11-02" }], stoc: [stocDe(2, 40, "buc")] });
  egal("produsul unit în altul: vânzările și stocul lui se socotesc pe cel păstrat", [r.deCumparat.map((x) => x.produs_id), pe(rand(r, 1), ["consumLuna", "stoc", "deComandat"]), rand(r, 1).vandut], [[1], [300, 40, 260], { cantitate: 900, luni: 3, ultima: "2026-11-02" }]);
  r = socoteste({ produse: prod([[1, "Marfa", "buc"]]), vanzari: [{ produs_id: 1, cantitate: -50 }], stoc: [] });
  egal("mai mult stornat decât vândut: niciun consum, niciun rând", r.deCumparat, []);
  r = socoteste({ produse: prod([[1, "Marfa", "buc", "Categorie", { activ: 0 }]]), vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [] });
  egal("produsul scos din catalog rămâne în socoteală, cu semn", pe(rand(r, 1), ["deComandat", "inactiv"]), [30, true]);
  r = socoteste({ produse: prod([[1, "Marfa", "buc"]]), vanzari: [{ produs_id: 99, cantitate: 90 }], stoc: [] });
  egal("o vânzare pe un produs care nu mai există e sărită", r.deCumparat, []);

  console.log("\n7. Unitățile de măsură");
  const P7 = prod([[1, "Folie la kg", "kilogram"]]);
  r = socoteste({ produse: P7, vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [stocDe(1, 12, "rola", [], [{ um: "kg", cantitate: 5 }])] });
  egal("stocul în role al unui produs la kg nu intră; cel în kg intră („kilogram” și „kg” sunt aceeași unitate)", pe(rand(r, 1), ["um", "stoc", "stocAlteUm", "deComandat"]), ["kg", 5, [{ um: "rola", cantitate: 12 }], 25]);
  egal("…și se numără la atenționări", r.note.cuAltaUnitate, 1);
  r = socoteste({ produse: P7, vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [stocDe(1, 5, "kg", [deLaFurnizor(100, "rola"), deLaFurnizor(10, "kg")])] });
  egal("la fel ce e pe drum de la furnizor în altă unitate", pe(rand(r, 1), ["vine", "deComandat"]), [10, 15]);
  r = socoteste({ produse: prod([[1, "Fara unitate", ""]]), vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [stocDe(1, 7, "buc")] });
  egal("produsul fără unitate în catalog ia stocul cum e scris", pe(rand(r, 1), ["stoc", "stocAlteUm"]), [7, []]);
  r = socoteste({ produse: P7, vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [{ produs_id: null, um: "buc", stoc: 9, alteUm: [], intrari: [] }, { produs_id: null, um: "buc", stoc: 0, alteUm: [], intrari: [] }] });
  egal("marfa din depozit scrisă liber, fără produs din catalog, nu se poate lega: se numără", r.note.stocFaraProdus, 1);

  console.log("\n8. Când se termină stocul");
  const P8 = prod([[1, "Marfa", "buc"]]);
  const v8 = [{ produs_id: 1, cantitate: 90 }]; // 1 pe zi
  egal("stoc 10, 1 pe zi: ziua 10 încă e acoperită, a 11-a nu", pe(rand(socoteste({ produse: P8, vanzari: v8, stoc: [stocDe(1, 10, "buc")] }), 1), ["zileStoc", "dataStoc"]), [11, "2026-11-22"]);
  egal("fără stoc deloc: nu ajunge, nu „până mâine”", pe(rand(socoteste({ produse: P8, vanzari: v8, stoc: [] }), 1), ["zileStoc", "zileCuDrum", "dataStoc", "stare"]), [0, 0, AZI, "de_comandat"]);
  egal("fără stoc, dar cu marfă pe drum: cu ea ajunge", pe(rand(socoteste({ produse: P8, vanzari: v8, stoc: [stocDe(1, 0, "buc", [deLaFurnizor(20, "buc")])] }), 1), ["zileStoc", "zileCuDrum"]), [0, 21]);
  egal("stoc pentru peste un an: fără dată", pe(rand(socoteste({ produse: P8, vanzari: v8, stoc: [stocDe(1, 5000, "buc")] }), 1), ["zileStoc", "dataStoc", "zileCuDrum", "deComandat", "stare"]), [null, "", null, 0, "acoperit"]);
  egal("exact la marginea anului: 365 de zile acoperite → fără dată; 364 → ziua 365", [rand(socoteste({ produse: P8, vanzari: v8, stoc: [stocDe(1, 365, "buc")] }), 1).zileStoc, rand(socoteste({ produse: P8, vanzari: v8, stoc: [stocDe(1, 364, "buc")] }), 1).zileStoc], [null, 365]);
  r = socoteste({ produse: P8, vanzari: v8, comenzi: [{ comanda_id: 1, numar: "C1", partener_id: 5, client: "X", produs_id: 1, cantitate: 50 }], stoc: [stocDe(1, 30, "buc", [deLaFurnizor(40, "buc")])] });
  egal("comenzile în curs trec de stoc, dar nu și de ce e pe drum: „acoperit doar cu ce e pe drum”", pe(rand(r, 1), ["stare", "zileStoc", "zileCuDrum", "lipsaAcum"]), ["pe_drum", 0, 21, 0]);
  r = socoteste({ produse: P8, vanzari: v8, comenzi: [{ comanda_id: 1, numar: "C1", partener_id: 5, client: "X", produs_id: 1, cantitate: 50 }], stoc: [stocDe(1, 30, "buc", [deLaFurnizor(10, "buc")])] });
  egal("…nici cu ce e pe drum: „lipsește acum”, cu cât", pe(rand(r, 1), ["stare", "lipsaAcum", "zileCuDrum"]), ["lipsa", 10, 0]);
  egal("zilele se adună pe calendar, peste sfârșit de lună și de an", [F.ziPlus("2026-11-11", 20), F.ziPlus("2026-12-31", 1), F.ziPlus("2026-03-01", -1), F.ziPlus("x", 1)], ["2026-12-01", "2027-01-01", "2026-02-28", ""]);

  console.log("\n9. Rotunjirea, ordinea și ce nu e marfă");
  egal("cantitatea de comandat se rotunjește în sus: întreg peste 100, o zecimală peste 10, două sub", [1234.2, 100, 67.51, 67.5, 10, 9.991, 0.004, 0, -3].map(F.rotunjitInSus), [1235, 100, 67.6, 67.5, 10, 10, 0.01, 0, 0]);
  const P9 = prod([[1, "A acoperit", "buc"], [2, "B de comandat peste 20 de zile", "buc"], [3, "C lipseste", "buc"], [4, "D pe drum", "buc"], [5, "E de comandat peste 5 zile", "buc"]]);
  const c9 = (id, cant) => ({ comanda_id: id, numar: "C" + id, partener_id: id, client: "X", produs_id: id, cantitate: cant });
  r = socoteste({
    produse: P9,
    vanzari: [1, 2, 3, 4, 5].map((id) => ({ produs_id: id, cantitate: 90 })),
    comenzi: [c9(3, 50), c9(4, 50)],
    stoc: [stocDe(1, 1000, "buc"), stocDe(2, 20, "buc"), stocDe(3, 10, "buc"), stocDe(4, 10, "buc", [deLaFurnizor(100, "buc")]), stocDe(5, 5, "buc")],
  });
  egal("ordinea: întâi ce lipsește acum, apoi ce ține doar cu ce e pe drum, apoi ce se termină mai repede, la urmă ce e acoperit", r.deCumparat.map((x) => x.denumire[0] + ":" + x.stare), ["C:lipsa", "D:pe_drum", "E:de_comandat", "B:de_comandat", "A:acoperit"]);
  const P9b = prod([[1, "Marfa cu categorie", "buc", "Benzi"], [2, "Servicii de montaj", "buc", ""], [3, "Cu gestiune", "buc", "", { gestiune: "Materie prima" }], [4, "Cu tip de depozit", "buc", "", { categorie_depozit: "materie primă" }], [5, "Fara nimic, dar pe stoc", "buc", ""], [6, "Transport - Transport", "buc", "Categorie"]]);
  const v9 = [1, 2, 3, 4, 5, 6].map((id) => ({ produs_id: id, cantitate: 90 }));
  r = socoteste({ produse: P9b, vanzari: v9, stoc: [stocDe(5, 3, "buc")] });
  egal("un articol vândut fără categorie, fără gestiune și fără să fi stat în depozit nu apare (serviciu, de regulă), dar se numără", [r.deCumparat.map((x) => x.produs_id).sort(), r.note.faraIncadrare], [[1, 3, 4, 5], 2]);
  r = socoteste({ produse: P9b, vanzari: v9, stoc: [stocDe(5, 3, "buc")] }, { toate: true });
  egal("…cu „toate” apar și ele, cu semn", [r.deCumparat.map((x) => x.produs_id).sort(), rand(r, 2).marfa, rand(r, 6).marfa, rand(r, 1).marfa], [[1, 2, 3, 4, 5, 6], false, false, true]);
  r = socoteste({ produse: prod([[1, "Punga", "buc"], [2, "Folie fara categorie", "kg", ""]]), retete: [{ produs_id: 1, componenta_id: 2, cantitate: 0.01 }], vanzari: [{ produs_id: 1, cantitate: 9000 }], stoc: [] });
  egal("ce intră într-o rețetă e marfă, chiar fără categorie", pe(rand(r, 2), ["marfa", "deComandat"]), [true, 30]);

  console.log("\n10. Rețete stricate");
  r = socoteste({ produse: prod([[1, "A", "buc"], [2, "B", "buc"], [3, "C", "kg"]]), retete: [{ produs_id: 1, componenta_id: 2, cantitate: 1 }, { produs_id: 2, componenta_id: 1, cantitate: 1 }, { produs_id: 2, componenta_id: 3, cantitate: 2 }], vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [] });
  bine("o rețetă care se învârte în cerc nu blochează socoteala și e raportată", r.note.cercuri.length === 1 && Array.isArray(r.deCumparat), JSON.stringify(r.note.cercuri));
  egal("…iar restul lanțului se socotește: A → B → C", pe(rand(r, 3), ["necesar"]), [60]);
  r = socoteste({ produse: prod([[1, "A", "buc"], [2, "B", "kg"]]), retete: [{ produs_id: 1, componenta_id: 1, cantitate: 1 }, { produs_id: 1, componenta_id: 2, cantitate: 0 }, { produs_id: 1, componenta_id: 99, cantitate: 5 }, { produs_id: 1, componenta_id: 2, cantitate: 0.5 }, { produs_id: 1, componenta_id: 2, cantitate: 0.25 }], vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [] });
  egal("produsul făcut din el însuși, cantitatea zero și componenta care nu există sunt sărite; aceeași componentă scrisă de două ori se adună", pe(rand(r, 2), ["necesar"]), [22.5]);
  r = socoteste({ produse: prod([[1, "A", "buc"], [2, "Energie electrica - Electricitate", "kwh"]]), retete: [{ produs_id: 1, componenta_id: 2, cantitate: 3 }], vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [] });
  egal("produsul cu rețetă doar din regie n-are din ce se face: e marfă cumpărată", [r.deCumparat.map((x) => x.produs_id), r.deProdus.length], [[1], 0]);
  const lung = Array.from({ length: 40 }, (_, i) => [i + 1, "Nivel " + (i + 1), "buc"]);
  r = socoteste({ produse: prod(lung), retete: lung.slice(0, 39).map(([id]) => ({ produs_id: id, componenta_id: id + 1, cantitate: 1 })), vanzari: [{ produs_id: 1, cantitate: 90 }], stoc: [] });
  egal("un lanț de 40 de niveluri se socotește până jos", [r.deCumparat.map((x) => x.produs_id), rand(r, 40).necesar, r.deProdus.length], [[40], 30, 39]);
  egal("fără nimic: nimic", [socoteste({ produse: [] }).deCumparat, F.calculeaza(null, null).deCumparat], [[], []]);

  // ========================================================== B. DATELE DIN BAZĂ
  console.log("\n11. Datele din bază");
  curata();
  const inainte = await F.citeste({ azi: AZI, fereastra: 90 });
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${C1}, 'client', '${PREFIX} Client Unu SRL'), (${C2}, 'client', '${PREFIX} Client Doi SRL'), (${F1}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, categorie, gestiune, activ, fuzionat_in) VALUES
       (${PUNGA}, '${PREFIX}-PUNGA', '${PREFIX} Punga curier', 'buc', 'Pungi curier', 'Produse Finite', 1, NULL),
       (${FOLIE}, '${PREFIX}-FOLIE', '${PREFIX} Folie extrudata', 'kg', 'Produse polietilena', 'Produse Intermediare', 1, NULL),
       (${GRANULA}, '${PREFIX}-GRAN', '${PREFIX} Granula LDPE', 'kg', 'diverse', 'Materie prima', 1, NULL),
       (${BANDA}, '${PREFIX}-BANDA', '${PREFIX} Banda adeziva', 'buc', 'Benzi adezive', NULL, 1, NULL),
       (${SERVICIU}, NULL, '${PREFIX} Servicii montaj', 'buc', NULL, NULL, 1, NULL),
       (${ROLA}, '${PREFIX}-ROLA', '${PREFIX} Stretch la kg', 'kg', 'Folie stretch manuala', NULL, 1, NULL),
       (${CUTIE}, '${PREFIX}-CUTIE', '${PREFIX} Cutie carton', 'buc', 'Cartoane', NULL, 1, NULL),
       (${REGIE}, NULL, 'Salarii - Salarii', 'buc', NULL, NULL, 1, NULL)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, categorie, activ, fuzionat_in) VALUES (${VECHI}, '${PREFIX}-VECHI', '${PREFIX} Banda cod vechi', 'buc', 'Benzi adezive', 0, ${BANDA})`);
  q(`INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (${PUNGA}, ${FOLIE}, 0.01), (${FOLIE}, ${GRANULA}, 1.05), (${PUNGA}, ${REGIE}, 0.5)`);
  // Facturile. Fereastra de 90 de zile până la 11.11.2026 e (13.08, 11.11].
  const factura = (id, data, extra) => q(`INSERT INTO facturi (id, serie, numar, partener_id, directie, status, data_emiterii, intercompany, activ)
       VALUES (${id}, 'TFC', ${id}, ${C1}, ${lit((extra && extra.directie) || "vanzare")}, ${lit((extra && extra.status) || "emisa")}, '${data}', ${(extra && extra.intercompany) || 0}, ${extra && extra.activ === 0 ? 0 : 1})`);
  const linie = (fid, produs, cant, pret, den) => q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${fid}, ${produs || "NULL"}, ${lit(den || "linie")}, ${cant}, ${pret}, 21)`);
  factura(FACTURI[0], "2026-10-01 09:30:00");
  linie(FACTURI[0], PUNGA, 60000, 0.2); linie(FACTURI[0], BANDA, 600, 5); linie(FACTURI[0], VECHI, 150, 5); linie(FACTURI[0], ROLA, 90, 10); linie(FACTURI[0], CUTIE, 9, 2);
  factura(FACTURI[1], "2026-11-05");
  linie(FACTURI[1], PUNGA, 30000, 0.2); linie(FACTURI[1], BANDA, 300, 5); linie(FACTURI[1], SERVICIU, 9, 100); linie(FACTURI[1], null, 1, 500, "Transport scris liber");
  factura(FACTURI[2], "2026-08-13"); linie(FACTURI[2], PUNGA, 1000000, 0.2); // ziua dinaintea ferestrei
  factura(FACTURI[3], "2026-11-12"); linie(FACTURI[3], PUNGA, 1000000, 0.2); // după „azi”
  factura(FACTURI[4], "2026-10-10", { status: "anulata" }); linie(FACTURI[4], PUNGA, 1000000, 0.2);
  factura(FACTURI[5], "2026-10-10", { status: "ciorna" }); linie(FACTURI[5], PUNGA, 1000000, 0.2);
  factura(FACTURI[6], "2026-10-10", { intercompany: 1 }); linie(FACTURI[6], PUNGA, 1000000, 0.2);
  factura(FACTURI[7], "2026-10-10", { directie: "achizitie" }); linie(FACTURI[7], GRANULA, 5000, 5);
  factura(FACTURI[8], "2026-10-20"); linie(FACTURI[8], BANDA, -150, 5); // stornare
  factura(FACTURI[9], "2026-10-10", { activ: 0 }); linie(FACTURI[9], PUNGA, 1000000, 0.2); // ștearsă
  // Stocul din CT-Park.
  const palPunga = palet(PUNGA, null, 10000, "buc");
  palet(FOLIE, null, 50, "kg"); palet(GRANULA, null, 60, "kg"); palet(GRANULA, null, 40, "kilogram"); palet(BANDA, null, 100, "buc");
  palet(ROLA, null, 12, "role"); palet(ROLA, null, 5, "kg"); palet(CUTIE, null, 100000, "buc"); palet(null, `${PREFIX} marfa scrisa liber`, 7, "buc");
  // Comenzile clienților.
  const comanda = (id, partener, status, produs, cant, livrat) => {
    q(`INSERT INTO comenzi (id, partener_id, numar, status, data) VALUES (${id}, ${partener}, '${PREFIX}-C${id - 9710300}', '${status}', '2026-11-03')`);
    q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, cantitate_livrata) VALUES (${id}, ${produs}, ${cant}, 1, ${livrat || 0})`);
  };
  comanda(O1, C1, "in_productie", PUNGA, 25000);
  const ies = Number(unul(`INSERT INTO ct_iesiri (palet_id, destinatie, comanda_id, data, partiala) VALUES (${palPunga}, 'comanda', ${O1}, '2026-11-08', 1) RETURNING id`));
  q(`INSERT INTO ct_iesiri_linii (iesire_id, produs_id, cantitate, um) VALUES (${ies}, ${PUNGA}, 5000, 'buc')`);
  comanda(O2, C1, "livrata", PUNGA, 999999);
  comanda(O3, C2, "noua", BANDA, 50, 20);
  comanda(O4, C2, "anulata", BANDA, 999999);
  comanda(O5, C2, "ciorna", BANDA, 999999);
  // Producția.
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, cantitate, um, partener_id, comanda_id, trimisa_depozit_la) VALUES
       (${CP1}, '${PREFIX}-CP1', 'noua', ${PUNGA}, '8000', 'buc', ${C1}, ${O1}, NULL),
       (${CP2}, '${PREFIX}-CP2', 'in_productie', ${PUNGA}, '4,000', 'buc', ${C2}, NULL, NULL),
       (${CP3}, '${PREFIX}-CP3', 'noua', ${FOLIE}, '30', 'kg', NULL, NULL, NULL),
       (${CP4}, '${PREFIX}-CP4', 'finalizata', ${PUNGA}, '777777', 'buc', ${C2}, NULL, NULL)`);
  q(`INSERT INTO comenzi_productie (id, numar, status, produs_id, tip_produs, cantitate, um) VALUES (${CP5}, '${PREFIX}-CP5', 'in_productie', NULL, 'ceva scris doar ca text', '500', 'buc')`);
  // Comenzile la furnizor.
  q(`INSERT INTO comenzi_furnizor (id, numar, furnizor_id, data, data_solicitata, status, moneda) VALUES
       (${CF0}, '${PREFIX}-CF0', ${F1}, '2026-09-01', '2026-09-10', 'primita', 'EUR'),
       (${CF1}, '${PREFIX}-CF1', ${F1}, '2026-11-02', '2026-11-20', 'trimisa', 'RON'),
       (${CF2}, '${PREFIX}-CF2', ${F1}, '2026-11-09', '2026-11-25', 'ciorna', 'RON')`);
  q(`INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, cantitate_primita, um, pret_unitar) VALUES
       (${CF0}, ${GRANULA}, 'granula', 1000, 1000, 'kg', 1.1),
       (${CF1}, ${GRANULA}, 'granula', 250, 50, 'kg', 5.5),
       (${CF2}, ${GRANULA}, 'granula', 999, 0, 'kg', 9.9)`);

  const d = await F.citeste({ azi: AZI, fereastra: 90 });
  const vz = (id) => { const v = d.vanzari.find((x) => Number(x.produs_id) === id); return v ? [Number(v.cantitate), Number(v.luni), v.ultima] : null; };
  egal("vânzările pungii: doar cele două facturi bune din fereastră (nu ziua dinainte, nu după azi, nu anulata, ciorna, ștearsa, cea între firme)", vz(PUNGA), [90000, 2, "2026-11-05"]);
  egal("banda: 600 + 300 − 150 stornate; codul vechi vine separat din bază (se unește la socoteală)", [vz(BANDA), vz(VECHI)], [[750, 2, "2026-11-05"], [150, 1, "2026-10-01"]]);
  egal("factura de achiziție nu e vânzare", vz(GRANULA), null);
  egal("cât din facturat e pe linii fără produs: 10 linii, una fără, 500 din 26.318 lei", [d.acoperire.linii - inainte.acoperire.linii, d.acoperire.liniiFara - inainte.acoperire.liniiFara, Math.round(d.acoperire.valoare - inainte.acoperire.valoare), Math.round(d.acoperire.valoareFara - inainte.acoperire.valoareFara)], [10, 1, 26318, 500]);
  egal("comenzile de producție în curs scrise doar ca text se numără", d.productieFaraProdus - inainte.productieFaraProdus, 1);
  egal("ultimul furnizor al granulei: comanda cea mai nouă care nu e ciornă", (({ furnizor_id, furnizor, pret_unitar, moneda, data }) => [Number(furnizor_id), furnizor, Number(pret_unitar), moneda, data])(d.furnizori.get(GRANULA)), [F1, `${PREFIX} Furnizor SRL`, 5.5, "RON", "2026-11-02"]);
  egal("pe o fereastră de 180 de zile intră și factura din 13.08", Number((await F.citeste({ azi: AZI, fereastra: 180 })).vanzari.find((x) => Number(x.produs_id) === PUNGA).cantitate), 1090000);

  console.log("\n12. Forecastul întreg, din bază");
  r = await F.forecast({ azi: AZI, fereastra: 90, zile: 30 });
  egal("punga: comenzi în curs 20.000 (C1: 25.000 − 5.000 ieșite) + 4.000 (producția lui C2, fără comandă); stoc 10.000; 4.000 în producție; 8.000 planificate", pe(facut(r, PUNGA), ["inCurs", "consumLuna", "stoc", "inProductie", "neinceput", "necesar", "deFacut"]), [24000, 30000, 10000, 4000, 8000, 54000, 40000]);
  egal("…cu documentele comenzilor în curs", facut(r, PUNGA).documente.map((x) => [x.fel, x.document, x.client, x.cantitate]).sort(), [["comanda", `${PREFIX}-C1`, `${PREFIX} Client Unu SRL`, 20000], ["productie", `${PREFIX}-CP2`, `${PREFIX} Client Doi SRL`, 4000]]);
  egal("folia: 400 kg cerute − 50 pe stoc; producția pentru stoc de 30 kg nu e cerere", pe(facut(r, FOLIE), ["inCurs", "stoc", "neinceput", "necesar", "deFacut"]), [0, 50, 30, 400, 350]);
  const g = rand(r, GRANULA);
  egal("granula: paleții în „kg” și „kilogram” se adună (100); pe drum 200; de comandat 67,5", pe(g, ["um", "consumLuna", "inCurs", "stoc", "vine", "vineData", "necesar", "deComandat", "stare"]), ["kg", 315, 52.5, 100, 200, "2026-11-20", 367.5, 67.5, "de_comandat"]);
  egal("…se termină în 5 zile; cu ce e pe drum, în 24", pe(g, ["zileStoc", "dataStoc", "zileCuDrum", "dataCuDrum"]), [5, "2026-11-16", 24, "2026-12-05"]);
  egal("…ciorna de la furnizor nu e „pe drum”, iar comanda primită nu mai vine", g.vineDocumente.map((x) => [x.document, x.cantitate, x.data]), [[`${PREFIX}-CF1`, 200, "2026-11-20"]]);
  egal("…cu ultimul furnizor și prețul lui", [g.furnizor.id, g.furnizor.nume, g.furnizor.pret, g.furnizor.moneda, g.furnizor.data], [F1, `${PREFIX} Furnizor SRL`, 5.5, "RON", "2026-11-02"]);
  egal("banda: 900 vândute (cu codul vechi) = 10 pe zi; comanda lui C2 mai are 30 de dat (50 − 20 facturate)", pe(rand(r, BANDA), ["consumLuna", "inCurs", "stoc", "necesar", "deComandat", "zileStoc"]), [300, 30, 100, 330, 230, 8]);
  egal("codul vechi nu are rând al lui", rand(r, VECHI), undefined);
  egal("stretchul la kg: paletul în role nu intră, cel în kg da", pe(rand(r, ROLA), ["stoc", "stocAlteUm", "deComandat"]), [5, [{ um: "rola", cantitate: 12 }], 25]);
  egal("cutia: stoc pentru peste un an, nimic de comandat", pe(rand(r, CUTIE), ["zileStoc", "deComandat", "stare"]), [null, 0, "acoperit"]);
  egal("serviciul (fără categorie, fără gestiune) nu apare; cu „toate”, apare", [rand(r, SERVICIU), pe(rand(await F.forecast({ azi: AZI, fereastra: 90, zile: 30, toate: true }), SERVICIU), ["marfa", "deComandat"])], [undefined, [false, 3]]);
  bine("atenționările: marfă scrisă liber în depozit, o producție fără produs, un articol cu stoc în altă unitate", r.note.stocFaraProdus >= 1 && r.note.productieFaraProdus >= 1 && r.note.cuAltaUnitate >= 1 && r.note.faraIncadrare >= 1, JSON.stringify(r.note));
  bine("Stoc la zi socotește la fel ce e în curs (aceleași comenzi deschise)", (await require(path.join(RAD, "lib", "stoc-produse.js")).citeste({ vedeTot: true })).find((x) => x.produs_id === PUNGA).promis > 0);

  // ========================================================== C. PAGINA
  console.log("\n13. Pagina din Procurement");
  const ADMIN = { id: 1, nume: `${PREFIX} Admin`, rol: "admin", sectiuni: "" };
  // Pagina socotește cu ziua de azi; aici o fixăm la 11.11.2026, ca cifrele să fie cele de mai sus.
  F.aziRo = () => AZI;
  let pg = await cer("/procurement/forecast", ADMIN);
  egal("pagina se deschide", pg.cod, 200);
  let corp = pg.corp;
  contine("spune cum se socotește și din ce", fara(corp), ["de comandat = comenzile în curs + consumul pe 30 de zile − stocul − ce e pe drum", "ultimele 90 de zile", "De cumpărat", "De făcut în producție", "Din ce e socotit"]);
  contine("are alegerea istoricului și a zilelor de acoperire", corp, ['<select name="istoric"', '<option value="90" selected>ultimele 90 de zile</option>', '<option value="365">ultimele 365 de zile</option>', '<select name="zile"', '<option value="30" selected>30 de zile de stoc</option>', '<option value="15">15 de zile de stoc</option>']);
  contine("tabelul are filtre în cap, ca în Excel", corp, ['data-filtre="forecast-comandat"']);
  const rg = randPagina(corp, GRANULA);
  const cg = celule(rg);
  bine("rândul granulei: articolul, cu codul și pentru ce e", /TFC Granula LDPE \(TFC-GRAN\)/.test(cg[1]) && /pentru: TFC Folie extrudata 100%/.test(cg[1]), cg[1]);
  egal("…categoria, stocul și ce e pe drum, cu comanda și data ei", [cg[2], cg[5], cg[6]], ["diverse", "100 kg", `200 kg ${PREFIX}-CF1 · 20.11.2026`]);
  egal("…consumul pe lună, comenzile în curs și până când ajunge stocul", [cg[3], cg[4], cg[7]], ["315 kg", "52,50 kg", "16.11.2026 în 5 zile cu ce e pe drum: 05.12.2026"]);
  egal("…de comandat și starea", [cg[8], cg[9]], ["67,50 kg comandă →", "de comandat"]);
  contine("…cu legătura care deschide comanda la furnizor cu produsul, cantitatea și furnizorul, și cu bifa", rg, ['href="/procurement/comenzi/noua?linii=9710003:67.5&amp;furnizor=9710111">comandă →</a>', 'class="fc-bifa" data-linie="9710003:67.5" data-furnizor="9710111"']);
  contine("…ultimul furnizor, cu prețul și data", cg[10], [`${PREFIX} Furnizor SRL`, "5,5 RON / kg", "02.11.2026"]);
  bine("…comanda la furnizor de pe rând duce la comanda ei", rg.includes(`href="/procurement/comenzi/${CF1}">${PREFIX}-CF1</a>`));
  const rr = randPagina(corp, ROLA);
  contine("stocul în altă unitate e spus pe rând", rr, ["mai sunt 12 rola — altă unitate, nu intră în socoteală"]);
  contine("cutia, cu stoc pentru peste un an: fără bifă, „acoperit”", randPagina(corp, CUTIE), ["peste un an", '<span class="badge verde">acoperit</span>'], ["fc-bifa", "comandă →"]);
  contine("banda: fără furnizor cunoscut, bifa are doar produsul și cantitatea", randPagina(corp, BANDA), ['class="fc-bifa" data-linie="9710004:230" data-furnizor=""', "în 8 zile", "<strong>230 buc</strong>"]);
  egal("serviciul nu e în listă, dar e pomenit la alegeri", [randPagina(corp, SERVICIU), /fără categorie și fără gestiune \(servicii, de regulă\)/.test(corp)], ["", true]);
  contine("atenționările sunt scrise pe pagină", fara(corp), ["scrise liber, fără produs din catalog", "doar ca text, fără produs din catalog", "altă unitate de măsură decât cea a produsului"]);
  bine("spune cât din facturat e pe linii fără produs, dacă e mult", /% din ce s-a facturat în ultimele 90 de zile e pe linii fără produs din catalog/.test(fara(corp)) || d.acoperire.valoareFara / d.acoperire.valoare <= 0.02);
  const tabelProdus = corp.slice(corp.indexOf("De făcut în producție"));
  contine("la „De făcut în producție”: punga, cu comenzile ei în curs", tabelProdus, [`${PREFIX} Punga curier`, `href="/comenzi/${O1}">${PREFIX}-C1</a>`, `${PREFIX}-CP2`, `${PREFIX} Client Doi SRL`]);
  contine("butonul de comandă pentru cele bifate", corp, ['id="fc-comanda" disabled>Fă o comandă la furnizor cu cele bifate →</button>', 'id="fc-toate"', "niciun articol bifat"]);
  contine("submeniul din Procurement are pagina, aprinsă", corp, ['<a href="/procurement/forecast" class="subnav-link activ">Forecast de comandat</a>', 'href="/procurement/comenzi"']);
  pg = await cer("/procurement/forecast", ADMIN, { zile: "60", istoric: "180", toate: "1" });
  contine("alegerile se țin: 60 de zile, 180 de istoric, cu toate articolele", pg.corp, ['<option value="60" selected>', '<option value="180" selected>', 'name="toate" value="1" checked', "consumul pe 60 de zile", "De comandat (60 zile)"]);
  contine("…și apare serviciul, cu semn", randPagina(pg.corp, SERVICIU), ["fără categorie și fără gestiune — poate fi un serviciu"]);
  pg = await cer("/procurement/forecast", ADMIN, { zile: "7", istoric: "abc" });
  contine("alegeri care nu există: rămân cele din oficiu", pg.corp, ['<option value="30" selected>', '<option value="90" selected>']);
  pg = await cer("/depozit/forecast", ADMIN);
  contine("adresa veche din Depozit arată aceeași pagină, cu submeniul Depozitului", pg.corp, ["De cumpărat", `${PREFIX} Granula LDPE`, 'action="/depozit/forecast"', '<a href="/depozit/forecast" class="subnav-link activ">'], ["Stoc curent", "Diferență estimată"]);

  console.log("\n14. Comanda la furnizor pornită din forecast");
  pg = await cer("/procurement/comenzi/noua", ADMIN, { linii: `${GRANULA}:67.5;${BANDA}:230;${GRANULA}:5;999999999:3;${CUTIE}:-2;x:y;${ROLA}:;${FOLIE}:1e12;${PUNGA}:7:9`, furnizor: String(F1) });
  egal("pagina comenzii noi se deschide", pg.cod, 200);
  const liniiForm = [...pg.corp.matchAll(/name="denumire\[\]" value="([^"]*)"[\s\S]*?name="produs_id\[\]" value="([^"]*)"[\s\S]*?name="cantitate\[\]" value="([^"]*)"[\s\S]*?name="um\[\]" value="([^"]*)"/g)].map((m) => m.slice(1, 5));
  egal("vin puse granula și banda, cu cantitățile lor; restul e sărit (dublură, produs inexistent, cantitate negativă, goală, uriașă sau scrisă greșit)", liniiForm.filter((l) => l[1]), [[`${PREFIX} Granula LDPE`, String(GRANULA), "67,5", "kg"], [`${PREFIX} Banda adeziva`, String(BANDA), "230", "buc"]]);
  contine("spune de unde vin și ce e de făcut", pg.corp, ['id="din-forecast">2 produse puse din Forecast de comandat', "Alege furnizorul, verifică și cantitățile, scrie prețurile."]);
  bine("furnizorul din adresă e ales", new RegExp(`<option value="${F1}"[^>]*selected`).test(pg.corp));
  pg = await cer("/procurement/comenzi/noua", ADMIN, {});
  contine("fără nimic în adresă, comanda nouă e goală ca până acum", pg.corp, ['name="denumire[]" value=""'], ["din-forecast"]);

  // ========================================================== D. BROWSERUL
  console.log("\n15. În browser: bifele și butonul de comandă");
  {
    const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try {
      const pag = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      const erori = [];
      const mers = [];
      pag.on("pageerror", (e) => erori.push(String(e.message || e)));
      await pag.route("http://erp.test/**", async (rt) => {
        const u = new URL(rt.request().url());
        if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
        if (u.pathname === "/procurement/comenzi/noua") { mers.push(u.pathname + u.search); return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>comanda</body></html>" }); }
        if (u.pathname === "/procurement/forecast") return rt.fulfill({ status: 200, contentType: "text/html", body: corp });
        return rt.fulfill({ status: 200, contentType: "text/plain", body: "" });
      });
      await pag.goto("http://erp.test/procurement/forecast");
      const stare = () => pag.evaluate(() => [document.getElementById("fc-comanda").disabled, document.getElementById("fc-cate").textContent, document.querySelectorAll(".fc-bifa:checked").length]);
      egal("la început nimic bifat, butonul stins", await stare(), [true, "niciun articol bifat", 0]);
      const bifa = (id) => `.fc-bifa[data-linie^="${id}:"]`;
      const areGranula = (await pag.locator(bifa(GRANULA)).count()) === 1;
      await pag.check(bifa(BANDA));
      egal("o bifă: butonul se aprinde", await stare(), [false, "un articol bifat", 1]);
      if (areGranula) {
        await pag.check(bifa(GRANULA));
        egal("două bife", (await stare()).slice(1), ["2 articole bifate", 2]);
        await pag.uncheck(bifa(BANDA));
        await pag.click("#fc-comanda");
        await pag.waitForLoadState("load");
        const u = new URL("http://erp.test" + mers[mers.length - 1]);
        egal("doar granula bifată: comanda se deschide cu ea și cu furnizorul ei", [/^9710003:[0-9.]+$/.test(u.searchParams.get("linii")), u.searchParams.get("furnizor")], [true, String(F1)]);
        await pag.goto("http://erp.test/procurement/forecast");
        await pag.check(bifa(GRANULA));
      }
      await pag.check(bifa(BANDA));
      await pag.click("#fc-comanda");
      await pag.waitForLoadState("load");
      const u2 = new URL("http://erp.test" + mers[mers.length - 1]);
      const linii2 = (u2.searchParams.get("linii") || "").split(";").map((x) => x.split(":")[0]).sort();
      egal("două articole cu furnizori diferiți: amândouă în comandă, fără furnizor ales din oficiu", [linii2, u2.searchParams.get("furnizor")], [areGranula ? [String(GRANULA), String(BANDA)].sort() : [String(BANDA)], null]);
      await pag.goto("http://erp.test/procurement/forecast");
      const cate = await pag.locator(".fc-bifa").count();
      await pag.check("#fc-toate");
      egal("„bifează tot” le ia pe toate cele de comandat", (await stare())[2], cate);
      await pag.uncheck("#fc-toate");
      egal("…și le lasă la loc", await stare(), [true, "niciun articol bifat", 0]);
      egal("nicio eroare de JavaScript", erori, []);
      if (process.env.SALVEAZA_PAGINI) await pag.screenshot({ path: path.join(process.env.SALVEAZA_PAGINI, "forecast.png"), fullPage: true });
    } finally {
      await browser.close();
    }
  }

  curata();
  ajunsLaCapat = true;
  console.log(esecuri ? `\n${esecuri} eșecuri` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  ajunsLaCapat = true;
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
