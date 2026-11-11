"use strict";
// Pozele unei recepții: marfa, avizul, factura, CMR-ul — urcate în Drive.
//
// CE A CERUT VALI, 11.11.2026: „La recepție să se poată adăuga o poză cu
// produs, cu aviz etc., momentan va fi opțională, poza o vei urca în Drive."
//
// CE APĂRĂ:
//   • CE SE PRIMEȘTE: doar imagini — micșorate din browser (câmpuri ascunse
//     `poza_date_<n>`, în ordinea lor) sau, fără JavaScript, ca fișiere. O
//     singură poză greșită oprește toată trimiterea, înainte să se urce ceva.
//   • UNDE AJUNG: în Drive, în Recepții / an-lună / numărul recepției, cu un
//     nume din care se înțelege ce sunt. În bază rămâne rândul: recepția, ce e
//     în poză, nota, cine, când (ora României), legătura.
//   • DRIVE NU RĂSPUNDE: poza nu se pierde, rămâne în baza ERP-ului și pagina
//     o spune. Aceeași poză urcată de două ori nu apare de două ori.
//   • CINE: le adaugă cine lucrează recepția (și după finalizare, nu și pe una
//     anulată); le scoate doar administratorul, iar în Drive merg la coș.
//   • PAGINA: lista cu legături spre Drive, formularul, numărul de poze în
//     lista de recepții; nota scrisă de om nu ajunge HTML.
//   • ÎN BROWSER: poza aleasă se micșorează, apare pregătită, se poate scoate,
//     și pleacă o singură dată.
//
// Drive e înlocuit cu unul de probă: nu se urcă nimic nicăieri. PostgreSQL real
// (port 5433), prin psql.
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
// Interogările merg prin stdin, nu ca argument: o poză rămasă în bază e un
// rând de sute de KB, prea lung pentru o linie de comandă.
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
  run: async (...p) => { const r = q(/^\s*INSERT/i.test(String(sql)) && !/RETURNING/i.test(String(sql)) ? String(sql) + " RETURNING id" : sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length }; },
});

// Drive de probă: ține minte ce i s-a cerut și răspunde ce vrea testul.
const drive = require(path.join(RAD, "lib", "drive.js"));
const cerute = { cale: [], urca: [], sterge: [] };
let driveCade = "";
let driveDuplicat = false;
let stergeCade = "";
let urmatorulId = 0;
drive.cale = async (bucati, radacina) => { cerute.cale.push([bucati, radacina]); if (driveCade) throw new Error(driveCade); return "folder-" + bucati.join("/"); };
drive.urca = async (x) => {
  cerute.urca.push({ nume: x.nume, mime: x.mime, parinte: x.parinte, octeti: x.continut.length, md5: drive.md5(x.continut) });
  if (driveCade) throw new Error(driveCade);
  const id = driveDuplicat ? "fisier-" + urmatorulId : "fisier-" + ++urmatorulId;
  return { id, nume: x.nume, link: `https://drive.google.com/file/d/${id}/view`, md5: drive.md5(x.continut), marime: x.continut.length, duplicat: driveDuplicat };
};
drive.sterge = async (id) => { cerute.sterge.push(id); if (stergeCade) throw new Error(stergeCade); };
process.env.GOOGLE_DRIVE_FOLDER = "radacina-erp";

const POZE = require(path.join(RAD, "lib", "receptie-poze.js"));
const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
for (const m of ["gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie"]) require(path.join(RAD, "modules", m + ".js")).register(router);

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
const calea = (r) => new URL(unde(r), "http://erp.test").pathname;
const ancora = (r) => new URL(unde(r), "http://erp.test").hash;

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 600) : "")); esecuri++; }
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

// ---- datele de test ------------------------------------------------------
const PREFIX = "TRP";
const FURNIZOR = 98511;
// O poză adevărată, cât se poate de mică: un PNG de 1 × 1.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const dataUrl = (octeti, mime) => `data:${mime || "image/jpeg"};base64,${Buffer.from(octeti).toString("base64")}`;
const poza = (text) => Buffer.concat([PNG, Buffer.from(String(text))]); // conținut diferit de la o poză la alta

function curata() {
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-R%'`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM receptii_poze WHERE receptie_id IN (${rec})`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${rec})`);
  q(`DELETE FROM receptii WHERE id IN (${rec})`);
  q(`DELETE FROM parteneri WHERE id = ${FURNIZOR}`);
}
const n = (v) => (v == null ? null : Number(v));
const pozele = (rid) => q(`SELECT id, fel, nota, CASE WHEN link LIKE 'data:%' THEN 'data:' || LENGTH(link) ELSE link END AS link, drive_id, nume, marime, creat_de, creat_la FROM receptii_poze WHERE receptie_id = ${rid} ORDER BY id`);
const catePoze = (rid) => Number(unul(`SELECT COUNT(*) FROM receptii_poze WHERE receptie_id = ${rid}`));
const fara = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const sectiune = (html) => { const i = html.indexOf('<h3 id="poze"'); if (i < 0) return ""; const j = html.indexOf("</style>", i); return html.slice(i, j < 0 ? undefined : j); };

(async () => {
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: `${PREFIX} Depozit`, rol: "depozit", sectiuni: "" };
  const ADMIN = { id: idUser, nume: `${PREFIX} Admin`, rol: "admin", sectiuni: "" };
  const AGENT = { id: idUser, nume: `${PREFIX} Agent`, rol: "vanzari", sectiuni: "/crm" };

  console.log("\n0. Tabelul pozelor, din lib/db.js");
  {
    const sursa = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
    const m = /CREATE TABLE IF NOT EXISTS receptii_poze \([\s\S]*?\);\s*CREATE INDEX IF NOT EXISTS idx_receptii_poze_receptie[^;]*;/.exec(sursa);
    bine("lib/db.js face tabelul receptii_poze și indexul lui", !!m);
    if (m) {
      q(m[0]);
      q(m[0]);
      egal("se poate rula de două ori (la fiecare pornire) și are coloanele",
        q("SELECT column_name FROM information_schema.columns WHERE table_name = 'receptii_poze' ORDER BY ordinal_position").map((x) => x.column_name),
        ["id", "receptie_id", "fel", "nota", "link", "drive_id", "nume", "marime", "creat_de", "creat_la"]);
    }
  }
  curata();
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  const receptie = (numar, stare) => Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare) VALUES ('${PREFIX}-${numar}', 'furnizor', ${FURNIZOR}, '2026-11-11', '${stare}') RETURNING id`));
  const R1 = receptie("R1", "in_lucru");
  const R2 = receptie("R2", "finalizata");
  const R3 = receptie("R3", "anulata");
  const R4 = receptie("R4/2026 x", "in_lucru");

  // ------------------------------------------------------------------ ce se primește
  console.log("\n1. Ce se primește din formular");
  egal("o imagine trimisă ca data-URL e citită întreagă", (() => { const p = POZE.dinDataUrl(dataUrl(PNG, "image/png")); return [p.mime, p.octeti.equals(PNG)]; })(), ["image/png", true]);
  egal("ce nu e imagine, ce nu e base64, ce are altceva înăuntru sau e gol: refuzat", [
    POZE.dinDataUrl(dataUrl("<script>", "text/html")), POZE.dinDataUrl("data:image/png,abc"), POZE.dinDataUrl("data:image/png;base64,ab<cd"),
    POZE.dinDataUrl("data:image/png;base64,"), POZE.dinDataUrl("https://exemplu.ro/poza.jpg"), POZE.dinDataUrl(""), POZE.dinDataUrl(null),
  ], [null, null, null, null, null, null, null]);
  let a = POZE.adunaPoze({ poza_date_10: dataUrl(poza("zece")), poza_date_2: dataUrl(poza("doi")), poza_date_0: dataUrl(poza("zero")), poza_date_5: "  ", fel: "aviz" });
  egal("pozele vin în ordinea în care au fost făcute (0, 2, 10), iar câmpul gol e sărit", [a.eroare, a.poze.map((p) => p.octeti.slice(PNG.length).toString())], [undefined, ["zero", "doi", "zece"]]);
  a = POZE.adunaPoze({ poza_date_0: dataUrl(poza("a")), poza_date_1: "data:text/html;base64,PGI+" });
  egal("o singură poză greșită oprește toată trimiterea", [a.eroare, a.poze], ["O poză n-a ajuns întreagă. Încearcă din nou.", undefined]);
  a = POZE.adunaPoze({ __files: { poze: [{ filename: "aviz.png", contentType: "image/png", data: PNG }, { filename: "gol.png", contentType: "image/png", data: Buffer.alloc(0) }] } });
  egal("fără JavaScript pozele vin ca fișiere; fișierul gol e sărit", [a.eroare, a.poze.length, a.poze[0].mime], [undefined, 1, "image/png"]);
  a = POZE.adunaPoze({ __files: { poze: [{ filename: "contract.pdf", contentType: "application/pdf", data: Buffer.from("%PDF") }] } });
  egal("un fișier care nu e poză e refuzat, cu numele lui", a.eroare, "„contract.pdf” nu e o poză.");
  a = POZE.adunaPoze({ __files: { poze: [{ filename: "mare.jpg", contentType: "image/jpeg", data: Buffer.alloc(POZE.MAX_OCTETI + 1) }] } });
  bine("o poză de peste 8 MB e refuzată, cu mărimea ei", /are 8 MB, prea mult \(cel mult 8 MB\)/.test(a.eroare || ""), a.eroare);
  a = POZE.adunaPoze(Object.fromEntries(Array.from({ length: POZE.MAX_POZE + 1 }, (_, i) => ["poza_date_" + i, dataUrl(poza(i))])));
  egal("mai mult de 12 poze odată: refuzat, cu numărul lor", a.eroare, "Sunt 13 poze; se urcă cel mult 12 odată. Trimite-le în două rânduri.");
  egal("exact 12 trec", POZE.adunaPoze(Object.fromEntries(Array.from({ length: POZE.MAX_POZE }, (_, i) => ["poza_date_" + i, dataUrl(poza(i))]))).poze.length, 12);
  egal("fără nimic: nicio poză, nicio eroare", POZE.adunaPoze({ fel: "marfa", nota: "x" }), { poze: [] });
  egal("felul pozei: unul din listă, altfel „marfa”", ["aviz", "cmr", "altceva", "", "<b>", undefined].map(POZE.felCurat), ["aviz", "cmr", "altceva", "marfa", "marfa", "marfa"]);
  egal("numele fișierului spune recepția, ce e în poză, când și a câta e", [
    POZE.numeFisier({ id: 7, numar: "REC-2026-0042" }, "aviz", "image/jpeg", 0, "2026-11-11 16:05:33"),
    POZE.numeFisier({ id: 7, numar: "R 4/2026 <x>" }, "ceva", "image/png", 2, "2026-11-11 16:05:33"),
    POZE.numeFisier({ id: 7 }, "cmr", "image/webp", 11, "2026-11-11 16:05:33"),
  ], ["REC-2026-0042_aviz_2026-11-11-16-05-33_1.jpg", "R-4-2026-x-_marfa_2026-11-11-16-05-33_3.png", "REC-7_cmr_2026-11-11-16-05-33_12.webp"]);
  bine("ora e a României, scrisă an-lună-zi oră:minut:secundă", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(POZE.acumRo()) &&
    POZE.acumRo().slice(0, 16) === new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 16), POZE.acumRo());

  // ------------------------------------------------------------------ Drive
  console.log("\n2. Unde ajung: Drive");
  const post = (user, rid, body) => cer("post", `/depozit/receptie/${rid}/poze`, user, { body });
  let r = await post(DEP, R1, { fel: "aviz", nota: "  aviz <b>CMR</b> semnat  ", poza_date_0: dataUrl(poza("unu")), poza_date_1: dataUrl(poza("doi"), "image/png") });
  egal("omul e întors la recepție, la poze, cu ce s-a întâmplat", [r.cod, calea(r), ancora(r), parametri(r)], [302, `/depozit/receptie/${R1}`, "#poze", { ok: "2 poze sunt în Drive." }]);
  egal("folderul: Recepții / an-lună / numărul recepției și furnizorul, în folderul ERP-ului", cerute.cale[0], [["Recepții", POZE.acumRo().slice(0, 7), `${PREFIX}-R1 · ${PREFIX} Furnizor SRL`], "radacina-erp"]);
  egal("s-au urcat amândouă, cu tipul și conținutul lor, în folderul recepției",
    cerute.urca.map((x) => [x.mime, x.octeti, x.parinte, x.md5 === drive.md5(x.mime === "image/png" ? poza("doi") : poza("unu"))]),
    [["image/jpeg", PNG.length + 3, `folder-Recepții/${POZE.acumRo().slice(0, 7)}/${PREFIX}-R1 · ${PREFIX} Furnizor SRL`, true], ["image/png", PNG.length + 3, `folder-Recepții/${POZE.acumRo().slice(0, 7)}/${PREFIX}-R1 · ${PREFIX} Furnizor SRL`, true]]);
  bine("numele din Drive: recepția, „aviz”, clipa, a câta poză, extensia după tip",
    new RegExp(`^${PREFIX}-R1_aviz_\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}_1\\.jpg$`).test(cerute.urca[0].nume) && /_2\.png$/.test(cerute.urca[1].nume), cerute.urca.map((x) => x.nume).join(" | "));
  let p = pozele(R1);
  egal("în bază rămâne rândul, nu poza: ce e, nota (tăiată de spații), legătura, id-ul din Drive, mărimea, cine",
    p.map((x) => [x.fel, x.nota, x.link, x.drive_id, n(x.marime), x.creat_de]),
    [["aviz", "aviz <b>CMR</b> semnat", "https://drive.google.com/file/d/fisier-1/view", "fisier-1", PNG.length + 3, `${PREFIX} Depozit`],
     ["aviz", "aviz <b>CMR</b> semnat", "https://drive.google.com/file/d/fisier-2/view", "fisier-2", PNG.length + 3, `${PREFIX} Depozit`]]);
  bine("…și când, cu ora României", p.every((x) => x.creat_la.slice(0, 13) === POZE.acumRo().slice(0, 13) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x.creat_la)), p.map((x) => x.creat_la).join(","));
  egal("numele din bază e cel din Drive", p.map((x) => x.nume), cerute.urca.map((x) => x.nume));

  r = await post(DEP, R2, { poza_date_0: dataUrl(poza("dupa finalizare")) });
  egal("și pe o recepție finalizată se mai pot adăuga (avizul se pozează uneori la birou); fără „fel” e „marfa”", [parametri(r).ok, pozele(R2).map((x) => [x.fel, x.nota])], ["o poză e în Drive.", [["marfa", null]]]);
  r = await post(DEP, R4, { fel: "factura", poza_date_0: dataUrl(poza("r4")) });
  egal("numărul recepției cu bară și spații nu strică nici folderul, nici numele", [cerute.cale[cerute.cale.length - 1][0][2], /^TRP-R4-2026-x_factura_/.test(cerute.urca[cerute.urca.length - 1].nume)], [`${PREFIX}-R4/2026 x · ${PREFIX} Furnizor SRL`, true]);

  console.log("\n3. Ce nu se urcă");
  const urcateInainte = cerute.urca.length;
  r = await post(DEP, R3, { poza_date_0: dataUrl(poza("anulata")) });
  egal("pe o recepție anulată nu se mai adaugă", [parametri(r).eroare, catePoze(R3), cerute.urca.length - urcateInainte], ["Recepția e anulată: nu i se mai adaugă poze.", 0, 0]);
  r = await post(AGENT, R1, { poza_date_0: dataUrl(poza("agent")) });
  egal("cine nu lucrează recepția nu adaugă poze", [r.cod, unde(r), catePoze(R1), cerute.urca.length - urcateInainte], [302, "/depozit/receptie", 2, 0]);
  r = await post(DEP, R1, { fel: "aviz", nota: "fara poze" });
  egal("fără nicio poză: i se spune, nu se preface că a urcat", [parametri(r).ok, parametri(r).eroare, catePoze(R1)], [undefined, "N-a ajuns nicio poză. Fă sau alege una și apasă din nou „Urcă pozele”.", 2]);
  r = await post(DEP, R1, { poza_date_0: dataUrl(poza("buna")), poza_date_1: "data:image/png;base64,###" });
  egal("o poză bună lângă una stricată: nu se urcă niciuna", [parametri(r).eroare, catePoze(R1), cerute.urca.length - urcateInainte], ["O poză n-a ajuns întreagă. Încearcă din nou.", 2, 0]);
  r = await post(DEP, 987654321, { poza_date_0: dataUrl(poza("x")) });
  egal("recepție care nu există", [r.cod, unde(r), cerute.urca.length - urcateInainte], [302, "/depozit/receptie", 0]);

  console.log("\n4. Aceeași poză de două ori, și Drive care nu răspunde");
  driveDuplicat = true; // Drive spune: fișierul ăsta e deja aici (fisier-<ultimul>)
  const ultimul = "fisier-" + urmatorulId;
  q(`UPDATE receptii_poze SET drive_id = '${ultimul}' WHERE receptie_id = ${R1} AND drive_id = 'fisier-2'`);
  r = await post(DEP, R1, { poza_date_0: dataUrl(poza("doi"), "image/png") });
  egal("poza pe care Drive o are deja la recepția asta nu apare a doua oară", [parametri(r).ok, catePoze(R1)], ["o poză era deja urcată.", 2]);
  r = await post(DEP, R2, { poza_date_0: dataUrl(poza("doi"), "image/png") });
  egal("…dar la altă recepție se scrie: acolo n-o are", [parametri(r).ok, catePoze(R2)], ["o poză e în Drive.", 2]);
  driveDuplicat = false;

  driveCade = "Drive a răspuns 503";
  r = await post(DEP, R1, { fel: "cmr", poza_date_0: dataUrl(poza("fara drive"), "image/png") });
  egal("Drive nu răspunde: omul află, ca eroare, că poza a rămas în ERP", [parametri(r).ok, parametri(r).eroare], [undefined, "Atenție: Drive n-a răspuns (Drive a răspuns 503), deci o poză a rămas în baza ERP-ului, nu în Drive."]);
  p = pozele(R1);
  egal("…și poza chiar a rămas, întreagă, cu rândul ei", [p.length, p[2].fel, p[2].drive_id, /^data:\d+$/.test(p[2].link), n(p[2].marime)], [3, "cmr", null, true, PNG.length + 10]);
  egal("…exact octeții trimiși", unul(`SELECT link FROM receptii_poze WHERE id = ${p[2].id}`), dataUrl(poza("fara drive"), "image/png"));
  driveCade = "";
  const radacina = process.env.GOOGLE_DRIVE_FOLDER;
  delete process.env.GOOGLE_DRIVE_FOLDER;
  r = await post(DEP, R2, { poza_date_0: dataUrl(poza("fara folder")) });
  bine("folderul din Drive nesetat: la fel, poza rămâne în ERP și se spune de ce", /GOOGLE_DRIVE_FOLDER nu e setată/.test(parametri(r).eroare || "") && catePoze(R2) === 3, unde(r));
  process.env.GOOGLE_DRIVE_FOLDER = radacina;

  // ------------------------------------------------------------------ scoaterea
  console.log("\n5. Scoaterea unei poze");
  p = pozele(R1);
  const sterge = (user, rid, pid) => cer("post", `/depozit/receptie/${rid}/poze/${pid}/sterge`, user);
  r = await sterge(DEP, R1, p[0].id);
  egal("depozitul nu scoate poze", [parametri(r).eroare, catePoze(R1), cerute.sterge.length], ["Pozele le scoate doar administratorul.", 3, 0]);
  r = await sterge(ADMIN, R2, p[0].id);
  egal("poza altei recepții nu se scoate de aici", [parametri(r).eroare, catePoze(R1), cerute.sterge.length], ["Poza nu mai există.", 3, 0]);
  r = await sterge(ADMIN, R1, p[0].id);
  egal("administratorul o scoate: rândul dispare, iar în Drive merge la coș", [parametri(r).ok, ancora(r), catePoze(R1), cerute.sterge], ["Poza a fost scoasă.", "#poze", 2, ["fisier-1"]]);
  r = await sterge(ADMIN, R1, p[2].id);
  egal("poza rămasă în ERP se scoate fără să fie întrebat Drive", [parametri(r).ok, catePoze(R1), cerute.sterge.length], ["Poza a fost scoasă.", 1, 1]);
  stergeCade = "File not found";
  r = await sterge(ADMIN, R1, p[1].id);
  bine("Drive nu răspunde la scoatere: rândul dispare oricum, iar omul află că fișierul a rămas", catePoze(R1) === 0 && /^Poza a fost scoasă\. Din Drive n-am putut-o muta la coș \(File not found\): fișierul „.*” a rămas acolo\.$/.test(parametri(r).ok || ""), unde(r));
  stergeCade = "";

  // ------------------------------------------------------------------ pagina
  console.log("\n6. Pagina recepției și lista");
  await post(DEP, R1, { fel: "aviz", nota: "aviz <b>CMR</b> semnat", poza_date_0: dataUrl(poza("pagina 1")) });
  driveCade = "Drive a răspuns 503";
  await post(DEP, R1, { fel: "marfa", poza_date_0: dataUrl(poza("pagina 2"), "image/png") });
  driveCade = "";
  const pagina = async (user, rid, query) => (await cer("get", `/depozit/receptie/${rid}`, user, { query })).corp;
  let s = sectiune(await pagina(DEP, R1));
  contine("secțiunea de poze: câte sunt, ce e fiecare, nota, cine", fara(s), ["Poze (2)", "<strong>avizul</strong>", "<strong>marfa</strong>", `${PREFIX} Depozit`, "Nu sunt obligatorii", "Se păstrează în Drive"]);
  bine("data și ora sunt scrise românește", /TRP Depozit · \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · \d+ KB/.test(fara(await pagina(DEP, R1)).replace(/\s+/g, " ")), (/.{0,20}TRP Depozit.{0,40}/.exec(fara(await pagina(DEP, R1)).replace(/\s+/g, " ")) || [""])[0]);
  contine("nota scrisă de om nu ajunge HTML", s, ["aviz &lt;b&gt;CMR&lt;/b&gt; semnat"], ["aviz <b>CMR</b> semnat"]);
  bine("poza din Drive are legătura ei, care se deschide în altă filă", /<a href="https:\/\/drive\.google\.com\/file\/d\/fisier-\d+\/view" target="_blank" rel="noopener">vezi în Drive<\/a>/.test(s));
  contine("poza rămasă în ERP se vede pe loc și spune unde e", s, ['<img src="data:image/png;base64,', "a rămas în baza ERP-ului, nu în Drive"]);
  contine("depozitul are formularul: fel, notă, „fă o poză” (camera) și „alege”, trimis ca fișiere", s, [
    `action="/depozit/receptie/${R1}/poze"`, 'enctype="multipart/form-data"', '<option value="marfa">marfa</option>', '<option value="aviz">avizul</option>', '<option value="factura">factura</option>',
    '<option value="cmr">CMR / transport</option>', '<option value="altceva">altceva</option>', 'name="nota"', 'name="poze" accept="image/*" capture="environment"', 'name="poze" accept="image/*" multiple', "Urcă pozele",
  ], ["/sterge", ">scoate</button></form>"]);
  s = sectiune(await pagina(ADMIN, R1));
  bine("administratorul are „scoate” la fiecare poză, cu întrebare", (s.match(new RegExp(`action="/depozit/receptie/${R1}/poze/\\d+/sterge"`, "g")) || []).length === 2 && s.includes("confirm('Scoți poza din recepție? În Drive merge la coș.')"));
  s = sectiune(await pagina(AGENT, R1));
  contine("cine nu lucrează recepția vede pozele, dar nu formularul", s, ["Poze (2)", "vezi în Drive"], ["forma-poze", "Urcă pozele", "/sterge"]);
  q(`INSERT INTO receptii_poze (receptie_id, fel, link, drive_id, nume, marime, creat_de, creat_la) VALUES (${R3}, 'marfa', 'https://drive.google.com/file/d/vechi/view', 'vechi', 'x.jpg', 2048, 'cineva', '2026-11-01 10:00:00')`);
  s = sectiune(await pagina(DEP, R3));
  contine("pe recepția anulată pozele vechi se văd, dar nu se mai adaugă", s, ["Poze (1)", "vezi în Drive", "2 KB"], ["forma-poze", "Urcă pozele"]);
  const R5 = receptie("R5", "in_lucru");
  s = sectiune(await pagina(DEP, R5));
  contine("recepția fără poze: formularul și „nicio poză încă”", s, ["Nicio poză încă.", "forma-poze"], ["Poze ("]);
  egal("…iar cine nu poate adăuga nu vede nicio secțiune goală", sectiune(await pagina(AGENT, R5)), "");
  q(`INSERT INTO receptii_poze (receptie_id, fel, link, drive_id, nume, creat_de, creat_la) VALUES (${R5}, 'altceva', 'javascript:alert(1)', 'x', 'x.jpg', 'cineva', '2026-11-01 10:00:00')`);
  contine("o legătură care nu e de Drive nu devine link", sectiune(await pagina(DEP, R5)), ["a rămas în baza ERP-ului"], ["javascript:alert", "vezi în Drive"]);
  const lista = (await cer("get", "/depozit/receptie", DEP, { query: { stare: "toate" } })).corp;
  const rand = (numar) => { const m = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${numar}</a>[\\s\\S]*?</tr>`).exec(lista); return m ? m[0] : ""; };
  contine("în lista de recepții scrie câte poze are fiecare, cu legătura spre ele", rand(`${PREFIX}-R1`), [`href="/depozit/receptie/${R1}#poze">2 poze</a>`]);
  contine("…la singular unde e una", rand(`${PREFIX}-R3`), [">o poză</a>"]);
  const R6 = receptie("R6", "asteptata");
  const lista2 = (await cer("get", "/depozit/receptie", DEP, { query: { stare: "toate" } })).corp;
  bine("…și nimic unde nu e niciuna", /TRP-R6<\/a>/.test(lista2) && !/#poze/.test((new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${PREFIX}-R6</a>[\\s\\S]*?</tr>`).exec(lista2) || [""])[0]));
  contine("mesajul de după urcare se vede pe pagină", await pagina(DEP, R1, { ok: "2 poze sunt în Drive." }), ["2 poze sunt în Drive."]);

  // ------------------------------------------------------------------ browserul
  console.log("\n7. În browser: poza se micșorează, se vede pregătită și pleacă o singură dată");
  {
    const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
    const corp = await pagina(DEP, R5);
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try {
      const pag = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      const erori = [];
      const trimise = [];
      pag.on("pageerror", (e) => erori.push(String(e.message || e)));
      await pag.route("http://erp.test/**", async (rt) => {
        const u = new URL(rt.request().url());
        if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
        if (rt.request().method() === "POST") {
          trimise.push({ cale: u.pathname, tip: rt.request().headers()["content-type"] || "", corp: rt.request().postDataBuffer() || Buffer.alloc(0) });
          return rt.fulfill({ status: 200, contentType: "text/html", body: "<html><body>trimis</body></html>" });
        }
        return rt.fulfill({ status: 200, contentType: "text/html", body: corp });
      });
      await pag.goto(`http://erp.test/depozit/receptie/${R5}`);
      const stare = () => pag.evaluate(() => ({
        text: document.getElementById("poze-stare").textContent,
        ascunse: [].map.call(document.querySelectorAll("#poze-ascunse input"), (i) => [i.name, i.value.slice(0, 23), i.value.length]),
        mici: document.querySelectorAll("#poze-alese img").length,
        buton: document.getElementById("poze-trimite").disabled,
        fisiere: [].map.call(document.querySelectorAll(".poze-fisiere"), (i) => [i.files.length, getComputedStyle(i).display]),
      }));
      egal("la început: nimic pregătit, câmpurile de fișier ascunse în spatele butoanelor", await stare().then((x) => [x.text, x.ascunse, x.mici, x.fisiere]), ["", [], 0, [[0, "none"], [0, "none"]]]);
      await pag.click("#poze-trimite");
      await pag.waitForTimeout(200);
      egal("fără nicio poză formularul nu pleacă și spune de ce", [trimise.length, (await stare()).text], [0, "fă sau alege întâi o poză"]);
      // O poză mare, ca de telefon: 3000 × 2000.
      const mare = await pag.evaluate(() => { const c = document.createElement("canvas"); c.width = 3000; c.height = 2000; const x = c.getContext("2d"); x.fillStyle = "#c33"; x.fillRect(0, 0, 3000, 2000); x.fillStyle = "#fff"; x.fillRect(200, 200, 900, 500); return c.toDataURL("image/png").split(",")[1]; });
      await pag.setInputFiles('.poze-fisiere[multiple]', [{ name: "marfa.png", mimeType: "image/png", buffer: Buffer.from(mare, "base64") }, { name: "aviz.png", mimeType: "image/png", buffer: PNG }]);
      await pag.waitForFunction(() => document.querySelectorAll("#poze-ascunse input").length === 2 && !document.getElementById("poze-trimite").disabled, null, { timeout: 8000 });
      let st = await stare();
      egal("două poze alese: două câmpuri ascunse, în ordine, ca JPEG; două miniaturi; câmpul de fișier golit", [st.ascunse.map((x) => x.slice(0, 2)), st.mici, st.fisiere.map((x) => x[0]), st.text],
        [[["poza_date_0", "data:image/jpeg;base64,"], ["poza_date_1", "data:image/jpeg;base64,"]], 2, [0, 0], "2 poze pregătite — apasă „Urcă pozele”"]);
      const marimi = await pag.evaluate(() => Promise.all([].map.call(document.querySelectorAll("#poze-ascunse input"), (i) => new Promise((gata) => { const im = new Image(); im.onload = () => gata([im.naturalWidth, im.naturalHeight]); im.src = i.value; }))));
      egal("poza mare a fost micșorată la 1600 pe latura lungă; cea mică a rămas cum era", marimi, [[1600, 1067], [1, 1]]);
      bine("…și e mult mai ușoară decât originalul", st.ascunse[0][2] < mare.length, `${st.ascunse[0][2]} față de ${mare.length}`);
      await pag.setInputFiles('.poze-fisiere[capture]', [{ name: "nu-e-poza.txt", mimeType: "text/plain", buffer: Buffer.from("text") }]);
      await pag.waitForTimeout(400);
      st = await stare();
      egal("un fișier care nu e poză: i se spune, și nu se adaugă", [st.text, st.ascunse.length], ["„nu-e-poza.txt” nu e o poză", 2]);
      await pag.click("#poze-alese span:first-child button");
      st = await stare();
      egal("„scoate” ia poza din trimitere", [st.ascunse.map((x) => x[0]), st.mici, st.text], [["poza_date_1"], 1, "o poză pregătită — apasă „Urcă pozele”"]);
      await pag.setInputFiles('.poze-fisiere[capture]', [{ name: "camera.png", mimeType: "image/png", buffer: PNG }]);
      await pag.waitForFunction(() => document.querySelectorAll("#poze-ascunse input").length === 2, null, { timeout: 8000 });
      egal("poza făcută cu camera se adaugă la cele alese, după ele", (await stare()).ascunse.map((x) => x[0]), ["poza_date_1", "poza_date_3"]);
      await pag.selectOption('#forma-poze select[name="fel"]', "aviz");
      await pag.fill('#forma-poze input[name="nota"]', "aviz semnat");
      await pag.click("#poze-trimite");
      await pag.waitForTimeout(500);
      const t = trimise[0] || { corp: Buffer.alloc(0), tip: "", cale: "" };
      const text = t.corp.toString("latin1");
      egal("formularul pleacă la ruta pozelor, ca multipart", [trimise.length, t.cale, t.tip.startsWith("multipart/form-data")], [1, `/depozit/receptie/${R5}/poze`, true]);
      // Serverul le citește cu același parser ca în producție.
      const citit = (() => {
        const parse = require(path.join(RAD, "lib", "router.js"));
        const f = parse.parseMultipart || parse._parseMultipart;
        return f ? f(t.corp, t.tip) : null;
      })();
      egal("pleacă cele două poze pregătite, felul și nota — și niciun fișier întreg pe lângă",
        [(text.match(/name="poza_date_\d+"/g) || []).sort(), /name="fel"\r\n\r\naviz/.test(text), /name="nota"\r\n\r\naviz semnat/.test(text), (text.match(/filename="[^"]+"/g) || [])],
        [['name="poza_date_1"', 'name="poza_date_3"'], true, true, []]);
      if (citit) egal("…iar serverul le citește: două poze, JPEG", (() => { const x = POZE.adunaPoze(citit); return [x.eroare, x.poze.length, x.poze.map((y) => y.mime)]; })(), [undefined, 2, ["image/jpeg", "image/jpeg"]]);
      egal("nicio eroare de JavaScript", erori, []);
      if (process.env.SALVEAZA_PAGINI) {
        await pag.goto(`http://erp.test/depozit/receptie/${R5}`);
        await pag.setInputFiles('.poze-fisiere[multiple]', [{ name: "marfa.png", mimeType: "image/png", buffer: Buffer.from(mare, "base64") }]);
        await pag.waitForFunction(() => document.querySelectorAll("#poze-ascunse input").length === 1, null, { timeout: 8000 });
        await pag.locator("#poze").scrollIntoViewIfNeeded();
        await pag.screenshot({ path: path.join(process.env.SALVEAZA_PAGINI, "receptie-poze.png"), fullPage: true });
      }
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
