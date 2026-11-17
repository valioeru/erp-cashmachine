"use strict";
// Configurări · Unificare coduri. PostgreSQL real pentru pagină, fără bază
// pentru socoteală.
//
// CEREREA LUI VALI, 17.11.2026: „Vreau să găsim o soluție să folosim aceleași
// coduri pentru produse; acum sunt aceleași produse cu diverse coduri. Propun
// o pagină de configurare unde să asociezi tu, la produsele cu coduri noi,
// toate produsele cu stoc care ți se par similare, iar odată ce noi validăm să
// ștergi produsul vechi și să muți stocul pe noul produs, cu modificare peste
// tot în depozit etc."
//
// CE APĂRĂ:
//   • PERECHILE „scrise de două ori": „Denumire (COD)" fără cod ↔ produsul cu
//     codul COD. Sigure când și denumirea e aceeași; de privit când nu.
//   • ASEMĂNAREA: numerele înaintea cuvintelor; felul mărfii, culoarea,
//     virgin/reciclat, manual/automat, grosimea și măsurile contrazise despart.
//   • PAGINA arată produsele vechi CU STOC, fiecare cu propunerile lui, și nu
//     unifică nimic singură.
//   • „Unifică…" arată întâi ce se mută; unificarea mută stocul pe produsul
//     care rămâne, îl dezactivează pe cel vechi și completează câmpurile goale
//     ale celui păstrat (prețurile doar la aceeași unitate).
//   • Sensul: produsul cu cod nou nu se unifică într-unul cu cod vechi.
//   • „Nu e același produs" nu mai aduce propunerea; asocierea de mână o aduce.
//   • „E bun așa" scoate produsul din listă.
//   • ÎN BLOC se unifică doar perechile la care produsul fără cod n-are stoc,
//     verificate din nou pe server.
//   • REȚETELE: două produse care au fiecare rețetă nu se unifică (s-ar lipi
//     rețetele); când rețeta vine de la cel vechi, vine cu baza ei, iar costul
//     din rețetă se socotește din nou.
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
let interogari = 0;
function q(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
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

const U = require(path.join(RAD, "lib", "unificare-coduri.js"));
const SP = require(path.join(RAD, "lib", "stoc-produse.js"));
const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
const MOD = require(path.join(RAD, "modules", "unificare-coduri.js"));
MOD.register(router);
const CALE = MOD.CALE;

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97811, nume: "Vali Unificare", rol: "admin", email: "v.uc@test.ro" };
async function cer(cale, { metoda = "get", query = {}, body = {}, user = ADMIN } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params: {}, query, body, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";
const parametri = (r) => Object.fromEntries(new URLSearchParams(String(locatie(r)).split("?")[1] || ""));

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d !== undefined ? ": " + String(d).slice(0, 500) : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));

// ---- datele de test ------------------------------------------------------
const N3 = 97823, N4 = 97824, V12 = 97842, C1 = 97843, V13 = 97844, V14 = 97845, V15 = 97846;
const N1 = 97821, N2 = 97822, V1 = 97831, V2 = 97832, V3 = 97833, V4 = 97834, V5 = 97835, V6 = 97836, V7 = 97837, V8 = 97838, V9 = 97839, V10 = 97840, V11 = 97841;
const V16 = 97847, V17 = 97848;
const TOATE = "97821 AND 97849";
function curata() {
  for (const s of [
    `DELETE FROM retete_componente WHERE produs_id BETWEEN ${TOATE} OR componenta_id BETWEEN ${TOATE}`,
    `DELETE FROM concurenta_preturi WHERE produs_id BETWEEN ${TOATE}`,
    `DELETE FROM ct_palet_linii WHERE palet_id IN (SELECT id FROM ct_paleti WHERE cod LIKE 'TUC-PAL-%')`,
    `DELETE FROM ct_paleti WHERE cod LIKE 'TUC-PAL-%'`,
    `DELETE FROM produse_asocieri WHERE vechi_id BETWEEN ${TOATE} OR nou_id BETWEEN ${TOATE}`,
    `DELETE FROM produse_fuziuni WHERE pastrat_id BETWEEN ${TOATE} OR inghitit_id BETWEEN ${TOATE}`,
    `UPDATE produse SET fuzionat_in = NULL WHERE id BETWEEN ${TOATE}`,
    `DELETE FROM produse WHERE id BETWEEN ${TOATE}`,
    "DELETE FROM utilizatori WHERE id = 97811",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const produs = (id) => q("SELECT * FROM produse WHERE id = ?", [id])[0] || {};
const stare = (id) => { const p = produs(id); return [Number(p.activ), p.fuzionat_in == null ? null : Number(p.fuzionat_in)]; };
const paletiPe = (id) => Number(q("SELECT COUNT(*) AS n, 1 AS x FROM ct_paleti WHERE produs_id = ? AND cod LIKE 'TUC-PAL-%'", [id])[0].n);
const asociere = (v, n) => q("SELECT stare, fel, nota FROM produse_asocieri WHERE vechi_id = ? AND nou_id = ?", [v, n]).map((x) => [x.stare, x.fel, x.nota]);
const randul = (html, id) => (new RegExp(`<tr data-vechi="${id}">[\\s\\S]*?</tr>`).exec(html) || [""])[0];
const propunerea = (rand, id) => (new RegExp(`<div data-propunere="${id}"[\\s\\S]*?</form>\\s*</div>\\s*</div>`).exec(rand) || [""])[0];
const curat = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

(async () => {
  console.log("── Socoteala, fără bază ─────────────────────────────────────");
  egal("paranteza de la coadă: simplă, cu paranteze în ea, fără, doar ea",
    [U.coadaCuCod("BANDA ADEZIVA FRAGIL 50X60 (Fragil)"), U.coadaCuCod("SHEETS NE1N ( 2000 x 1500 )-test (NE1N ( 2000 x 1500 ))"), U.coadaCuCod("Banda fara cod"), U.coadaCuCod("(doar)"), U.coadaCuCod("Cutie (mare) alba")],
    [{ nume: "BANDA ADEZIVA FRAGIL 50X60", cod: "Fragil" }, { nume: "SHEETS NE1N ( 2000 x 1500 )-test", cod: "NE1N ( 2000 x 1500 )" }, null, null, null]);
  const L = [
    { id: 1, cod: "", denumire: "BANDA FRAGIL 50X60 (Fragil)" }, { id: 2, cod: "fragil", denumire: "Banda  Fragil 50x60" },
    { id: 3, cod: "", denumire: "Capac 1450 (CAP)" }, { id: 4, cod: "CAP", denumire: "Capac 1450x1800 folie" },
    { id: 5, cod: "", denumire: "Cutie A3 (CUT)" }, { id: 6, cod: "CUT", denumire: "Alta cutie" }, { id: 7, cod: "cut", denumire: "Cutie A3" }, { id: 8, cod: "CUT", denumire: "Cutie A3", cod_familie_id: 4 },
    { id: 9, cod: "", denumire: "Singur (XYZ)" }, { id: 10, cod: "ARE", denumire: "Are cod (CUT)" }, { id: 11, cod: "", denumire: "Fara paranteza" },
    { id: 12, cod: "", denumire: "Sac X (SAC)" }, { id: 13, cod: "SAC", denumire: "Sac X" }, { id: 14, cod: "SAC", denumire: "Sac altfel", cod_familie_id: 2 },
  ];
  egal("perechile scrise de două ori: sigură când și denumirea e aceeași; doar codul = de privit; dintre mai mulți frați, cel cu aceeași denumire și cod nou",
    U.perechi(L).map((x) => [x.vechi.id, x.nou.id, x.sigura, x.altele]), [[1, 2, true, 0], [3, 4, false, 0], [5, 8, true, 2], [12, 13, true, 1]]);
  const t = (d, c) => { const x = U.trasaturi(d, c); return [[...x.numere].sort((a, b) => a - b).join(","), [...x.culori].join(","), x.fel, x.material, x.aplicare, x.grosime, x.masuri.join(",")]; };
  egal("ce se citește dintr-o denumire: numerele (și cele despărțite de x sau /), culoarea, felul, grosimea, măsurile",
    [t("Banda adeziva acryl transparent 48mm x 60m, 40 microni", "1056"), t("SP 470 50/63 350 gr", "7441399"), t("Stretch standard automat 23mm", "SSA23/16/2000"), t("FOLIE STRETCH JUMBO JLP23NEGRUPF", "NegruCM"), t("Folie cu bule natur 40 my 0,5 m 100 m"), t("Punga curier LDPE reciclat manuala")],
    [["40,48,60", "transparent", "banda", null, null, 40, "48x60"], ["50,63,350,470", "", null, null, null, null, ""], ["16,23,2000", "", "folie", null, "automat", null, ""], ["23", "negru", "folie", null, null, null, ""], ["0.5,40,100", "natur", "bule", null, null, 40, ""], ["", "", "punga", "reciclat", "manual", null, ""]]);
  egal("„TR” la coadă e transparent; codul făcut numai din cifre nu aduce numere, cel cu litere da", [t("Folie stretch 17my 50kg TR")[1], t("Banda 48 60", "1056")[0], t("Banda 48 60", "B66")[0]], ["transparent", "48,60", "48,60,66"]);
  egal("măsurile lipite cu „x” se despart în numere și când au zecimale sau sunt multe la rând", [t("Folie bule 0,5x100 m")[0], t("Capac 1450x1800x2000x30")[0]], ["0.5,100", "30,1450,1800,2000"]);
  const s = (v, n) => { const r = U.asemanare(v, { denumire: n }); return r.contra ? "contra: " + r.contra : r.scor; };
  egal("asemănarea: aceeași marfă scrisă altfel = 1; numerele trag mai greu decât cuvintele",
    [s({ denumire: "Banda adeziva acryl transparent 48mm x 60m, 40 microni", cod: "1056" }, "Bandă adezivă Acrilică Transparent 48 mm 60 m 40 microni"),
     s({ denumire: "Stretch standard automat 23mm", cod: "SSA23/16/2000" }, "Folie Stretch Virgin Automată Transparent 23 microni 16 kg 2000 m"),
     s({ denumire: "Cutie 485X295X335-D7 CO3", cod: "CUTD7485295335" }, "Cutie carton Americană 485 mm 295 mm 335 mm CO3"),
     s({ denumire: "SP 470 50/63 350 gr", cod: "7441399" }, "Tub carton SP 470 mm 50/62 350 gr"),
     s({ denumire: "Plicuri autoadezive AWB C5 CM", cod: "AWBCM" }, "Plic AWB 175 mm 240 mm 25 microni")],
    [1, 0.73, 0.73, 0.54, 0.2]);
  const cuCod = { id: 31, denumire: "Banda 48 60", cod: "B66X" };
  egal("produsul vechi se citește cu tot cu cod, cel cu cod nou doar din denumire — și când același produs e întâi vechi, apoi nou",
    [U.asemanare(cuCod, { denumire: "Bandă 48 60 66" }).scor, U.asemanare({ denumire: "Banda 48 60" }, cuCod).scor, U.asemanare(cuCod, { denumire: "Bandă 48 60 66" }).scor, U.asemanare(null, null).scor], [1, 1, 1, 0]);
  egal("fără niciun număr de o parte și de alta rămân cuvintele, cu scorul tăiat: măsura nu se poate ști", [s({ denumire: "Granula reciclata CM" }, "Granula reciclată"), s({ denumire: "Granula reciclata CM" }, "Granula reciclată neagră import")], [0.8, 0.4]);
  egal("ce se contrazice e altă marfă: felul, culoarea, virgin/reciclat, manual/automat, grosimea, măsurile",
    [s({ denumire: "Banda adeziva 48 60 40" }, "Folie stretch 48 60 40"), s({ denumire: "Banda acryl Alb 48mm x 60m" }, "Bandă Transparent 48 mm 60 m"), s({ denumire: "Folie reciclata 23 500" }, "Folie Virgin 23 500"),
     s({ denumire: "Folie manuala 23 500" }, "Folie Automată 23 500"), s({ denumire: "Folie 17my 500" }, "Folie 23 microni 500"), s({ denumire: "Cutie 300x200x100" }, "Cutie 300x200x150")],
    ["contra: altă marfă (banda / folie)", "contra: altă culoare (alb / transparent)", "contra: reciclat / virgin", "contra: manual / automat", "contra: altă grosime (17 / 23)", "contra: alte măsuri (300x200x100 / 300x200x150)"]);
  egal("…dar aceeași măsură scrisă mai scurt sau în altă ordine nu desparte („520 x 50” încape în „50 x 57 x 520”)",
    [s({ denumire: "TUB SP 520 X 50/57 200 gr" }, "Tub 50 x 57 x 520 mm 200 gr"), s({ denumire: "Cutie 300x200" }, "Cutie 200 x 300 x 100")], [1, 0.8]);
  const noi = [{ id: 22, denumire: "Bandă adezivă Acrilică Transparent 48 mm 66 m 40 microni" }, { id: 25, denumire: "Bandă adezivă PVC Transparent 50 mm 66 m" }, { id: 21, denumire: "Bandă adezivă Acrilică Transparent 48 mm 60 m 40 microni" }, { id: 23, denumire: "Folie Stretch 23 microni" }, { id: 24, denumire: "Bandă adezivă Acrilică Transparent 48 mm 60 m 45 microni" }];
  const vechi = { id: 5, denumire: "Banda adeziva acryl transparent 48mm x 60m, 40 microni", cod: "1056" };
  egal("propunerile: de la cea mai bună în jos, doar peste prag, fără cele respinse de om, cel mult câte s-au cerut",
    [U.propuneri(vechi, noi, null, 3).map((x) => [x.nou.id, x.scor]), U.propuneri(vechi, noi, new Set(["5:21"]), 3).map((x) => x.nou.id), U.propuneri(vechi, noi, null, 1).map((x) => x.nou.id), U.propuneri({ id: 21, denumire: noi[2].denumire }, noi, null, 3).map((x) => x.nou.id).includes(21)],
    [[[21, 1], [22, 0.7]], [22], [21], false]);
  egal("cuvântul scorului și produsul cu cod nou", [U.cuvantScor(0.9), U.cuvantScor(0.7), U.cuvantScor(0.6), U.cuvantScor(0.45), U.eNou({ cod_familie_id: 3 }), U.eNou({ cod_familie_id: null }), U.eNou({})], ["mare", "mare", "medie", "slabă", true, false, false]);

  // ---- pagina, pe bază ---------------------------------------------------
  curata();
  const F = Number((q("SELECT id, 1 AS x FROM cod_familii ORDER BY id LIMIT 1")[0] || { id: 1 }).id);
  for (const sql of [
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97811,'Vali Unificare','v.uc@test.ro','x','y','admin')",
    `INSERT INTO produse (id, cod, cod_generat, denumire, unitate_masura, cod_familie_id, pret_achizitie, pret_vanzare) VALUES
       (${N1}, 'TUCBAAT4860040', 'TUCBAAT4860040', 'TUC Bandă adezivă Acrilică Transparent 48 mm 60 m 40 microni', 'rola', ${F}, 0, 0),
       (${N2}, 'TUCFSVAT2316', 'TUCFSVAT2316', 'TUC Folie Stretch Virgin Automată Transparent 23 microni 16 kg 2000 m', 'rola', ${F}, 0, 0)`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie, pret_vanzare, categorie, categorie_depozit) VALUES
       (${V1}, 'TUC-1056', 'TUC Banda adeziva acryl transparent 48mm x 60m, 40 microni', 'rola', 3.5, 5, 'Benzi adezive', 'produse finite'),
       (${V2}, NULL, 'TUC BANDA FRAGIL 50X60 (TUC-Fragil)', 'buc', 2.2, 4, 'Benzi adezive', NULL),
       (${V3}, 'TUC-Fragil', 'TUC BANDA FRAGIL 50X60', 'buc', 0, 0, NULL, NULL),
       (${V4}, '', 'TUC Cutie 300x200 (TUC-CUT)', 'buc', 0, 0, NULL, NULL),
       (${V5}, 'TUC-CUT', 'TUC Cutie 300x200', 'buc', 0, 0, NULL, NULL),
       (${V6}, NULL, 'TUC Capac plastic 1450 (TUC-CAP)', 'buc', 0, 0, NULL, NULL),
       (${V7}, 'TUC-CAP', 'TUC Capac plastic 1450x1800 folie', 'buc', 0, 0, NULL, NULL),
       (${V8}, 'TUC-TRANSPORT', 'TUC Transport marfa', 'buc', 0, 0, NULL, NULL),
       (${V9}, 'TUC-1052', 'TUC Banda adeziva acryl Alb 48mm x 60m, 40 microni', 'rola', 0, 0, NULL, NULL),
       (${V10}, NULL, 'TUC Eticheta 100x50 (TUC-ET)', 'buc', 0, 0, NULL, NULL),
       (${V11}, 'TUC-ET', 'TUC Eticheta 100x50', 'buc', 0, 0, NULL, NULL)`,
    `INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare) VALUES
       ('TUC-PAL-1', ${V1}, 100, 100, 'rola', '2026-11-10'), ('TUC-PAL-2', ${V1}, 50, 50, 'rola', '2026-11-11'),
       ('TUC-PAL-3', ${V2}, 684, 684, 'buc', '2026-11-05'), ('TUC-PAL-4', ${V8}, 1, 1, 'buc', '2026-11-05'),
       ('TUC-PAL-5', ${V9}, 10, 10, 'rola', '2026-11-05'), ('TUC-PAL-6', ${V11}, 7, 7, 'buc', '2026-11-05'),
       ('TUC-PAL-7', ${N2}, 5, 5, 'rola', '2026-11-05')`,
    `INSERT INTO concurenta_preturi (directie, produs_id, denumire, concurent, pret, moneda, data_ofertei, activ) VALUES ('vanzare', ${V1}, 'TUC banda', 'TUC Concurent', 4, 'RON', '2026-11-01', 1)`,
    // rețete: un produs vechi cu rețetă scrisă la mia de bucăți și fratele lui cu cod nou, fără; două care au fiecare rețetă; o pereche „scrisă de două ori” cu două rețete
    `INSERT INTO produse (id, cod, cod_generat, denumire, unitate_masura, cod_familie_id, pret_achizitie, pret_vanzare) VALUES
       (${N3}, 'TUCPLICRET1', 'TUCPLICRET1', 'TUC Plic cu rețetă nou', 'buc', ${F}, 0, 0), (${N4}, 'TUCPLICRET2', 'TUCPLICRET2', 'TUC Plic doi cu rețetă nou', 'buc', ${F}, 0, 0)`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, pret_achizitie, pret_vanzare, reteta_baza) VALUES
       (${V12}, 'TUC-RET-1', 'TUC Plic cu reteta vechi', 'buc', 0, 0, 1000), (${C1}, 'TUC-GRAN', 'TUC Componenta granula', 'kg', 2, 0, NULL),
       (${V13}, 'TUC-RET-2', 'TUC Plic doi cu reteta vechi', 'buc', 0, 0, NULL), (${V14}, NULL, 'TUC Sac cu reteta (TUC-SACR)', 'buc', 0, 0, NULL), (${V15}, 'TUC-SACR', 'TUC Sac cu reteta', 'buc', 0, 0, NULL)`,
    `INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (${V12}, ${C1}, 0.5), (${V13}, ${C1}, 1), (${N4}, ${C1}, 2), (${V14}, ${C1}, 3), (${V15}, ${C1}, 4)`,
    // banda veche are tot ce strânge un produs folosit de ani: cost de producție, preț minim, stoc minim, adaos propriu, costul real din contabilitate, gestiune
    `UPDATE produse SET pret_productie = 2.75, pret_minim = 4.25, stoc_minim = 30, adaos_lista = 15, cost_rata = 0.625, cost_rata_sursa = 'TUC profit pe produs', gestiune = 'TUC Marfuri' WHERE id = ${V1}`,
  ]) exec(sql);

  console.log("\n── Produse vechi cu stoc ────────────────────────────────────");
  let r = await cer(CALE, { query: { q: "TUC" } });
  bine("pagina se deschide și e legată în Configurări", r.cod === 200 && r.corp.includes(`<a href="${CALE}" class="subnav-link activ">Unificare coduri</a>`) && r.corp.includes('href="/configurari/cod-produs"'));
  const idVechi = [...r.corp.matchAll(/<tr data-vechi="(\d+)">/g)].map((m) => Number(m[1]));
  egal("în listă: doar produsele cu cod vechi care au stoc — nu cele cu cod nou, nu cele fără stoc", idVechi.slice().sort(), [V1, V2, V8, V9, V11].sort());
  egal("…cele cu propunere întâi, apoi cele fără, după denumire", [idVechi.slice(0, 2).sort(), idVechi.slice(2)], [[V1, V2].sort(), [V9, V11, V8]]);
  let rand = randul(r.corp, V1);
  bine("banda veche își arată stocul: 150 rola pe 2 paleți", curat(rand).includes("150 rola · 2 paleți"), curat(rand).slice(0, 300));
  let pr = propunerea(rand, N1);
  bine("…și e propusă în produsul cu cod nou care seamănă, cu motivul: numerele și cuvintele comune", /seamănă · potrivire mare/.test(pr) && curat(pr).includes("numere comune: 40, 48, 60") && curat(pr).includes("cuvinte comune:") && pr.includes(`href="${CALE}/unifica?vechi=${V1}&amp;nou=${N1}"`), curat(pr).slice(0, 400));
  bine("…fără folia stretch, care e altă marfă", !rand.includes(`data-propunere="${N2}"`));
  rand = randul(r.corp, V2);
  pr = propunerea(rand, V3);
  bine("produsul fără cod, „Denumire (COD)”, e propus în fratele lui cu codul: „scris de două ori”", pr.includes('<span class="badge verde">scris de două ori</span>') && curat(pr).includes("TUC-Fragil") && curat(rand).includes("684 buc · 1 palet"), curat(rand).slice(0, 400));
  rand = randul(r.corp, V9);
  bine("banda albă nu e propusă în cea transparentă; rândul spune că n-are propunere și lasă asocierea de mână", !rand.includes("data-propunere=") && rand.includes("Nicio propunere.") && rand.includes(`action="${CALE}/asociaza"`) && rand.includes(`list="produse-noi"`), curat(rand).slice(0, 300));
  bine("lista de ales are produsele cu cod nou, cu codul în față", r.corp.includes(`<option value="TUCBAAT4860040 — TUC Bandă adezivă Acrilică Transparent 48 mm 60 m 40 microni">`) && !/<option value="TUC-1056/.test(r.corp));
  r = await cer(CALE, { query: { q: "TUC-Fragil" } });
  egal("căutarea ține și de codul propunerii", [...r.corp.matchAll(/<tr data-vechi="(\d+)">/g)].map((m) => Number(m[1])), [V2]);

  console.log("\n── Ce se mută, înainte să se mute ───────────────────────────");
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(V1), nou: String(N1) } });
  bine("previzualizarea spune cine dispare și cine rămâne, cu stocul lor", r.cod === 200 && /Dispare din liste[\s\S]*TUC-1056[\s\S]*Rămâne[\s\S]*TUCBAAT4860040/.test(r.corp) && curat(r.corp).includes("cod vechi · stoc: 150 rola · 2 paleți") && curat(r.corp).includes("cod nou · stoc: fără stoc"), curat(r.corp).slice(0, 500));
  bine("…ce se mută, pe înțeles: 2 paleți și prețul concurenței, în total 3 rânduri", /<td>paleți<\/td><td>2<\/td>/.test(r.corp) && /<td>concurenta_preturi\.produs_id<\/td><td>1<\/td>/.test(r.corp) && /<td>Total<\/td><td>3<\/td>/.test(r.corp), (r.corp.match(/<tbody>[\s\S]*?<\/tfoot>/) || [""])[0].slice(0, 400));
  bine("…fără rândurile cu zero: se vede doar ce chiar se mută", !/<td>0<\/td>/.test((r.corp.match(/<tbody>[\s\S]*?<\/tbody>/) || [""])[0]) && (r.corp.match(/<tbody>[\s\S]*?<\/tbody>/) || [""])[0].split("<tr>").length - 1 === 2, (r.corp.match(/<tbody>[\s\S]*?<\/tbody>/) || [""])[0].slice(0, 300));
  bine("…fără avertisment de unitate (amândouă în role) și cu formularul de validare", !r.corp.includes("au unități diferite") && r.corp.includes(`<form method="post" action="${CALE}/unifica"`) && r.corp.includes(`name="vechi_id" value="${V1}"`) && r.corp.includes(`name="nou_id" value="${N1}"`));
  egal("nimic nu s-a mutat doar din privit", [stare(V1), paletiPe(V1), paletiPe(N1)], [[1, null], 2, 0]);
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(V4), nou: String(V5) } });
  bine("produsul vechi nefolosit nicăieri: o spune, fără tabel", r.cod === 200 && r.corp.includes("Produsul vechi nu e folosit nicăieri: se scoate doar din liste.") && !r.corp.includes("<td>Total</td>"));
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(V2), nou: String(N1) } });
  bine("unități diferite (buc și rola): avertisment", r.cod === 200 && r.corp.includes("Cele două produse au unități diferite (buc și rola)"));
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(N1), nou: String(V1) } });
  egal("sensul: produsul cu cod nou nu se unifică într-unul cu cod vechi", [String(locatie(r)).split("?")[0], /Produsul cu cod nou e cel care rămâne/.test(parametri(r).eroare || "")], [CALE, true]);
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(V1), nou: String(V1) } });
  egal("același produs cu el însuși: nu", /E același produs/.test(parametri(r).eroare || ""), true);
  r = await cer(`${CALE}/unifica`, { query: { vechi: "999999999", nou: String(N1) } });
  egal("produs care nu există: nu", /nu mai există sau a fost deja unificat/.test(parametri(r).eroare || ""), true);

  console.log("\n── Unificarea ───────────────────────────────────────────────");
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(N1), nou_id: String(V1) } });
  egal("și prin POST sensul greșit e refuzat, fără să miște nimic", [/Produsul cu cod nou e cel care rămâne/.test(parametri(r).eroare || ""), stare(N1), stare(V1)], [true, [1, null], [1, null]]);
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(V1), nou_id: String(N1) } });
  egal("banda veche a intrat în cea cu cod nou: dezactivată și legată de ea, cu paleții și prețul concurenței mutate", [stare(V1), paletiPe(V1), paletiPe(N1), Number(q("SELECT COUNT(*) AS n, 1 AS x FROM concurenta_preturi WHERE produs_id = ?", [N1])[0].n)], [[0, N1], 0, 2, 1]);
  const n1 = produs(N1);
  egal("câmpurile goale ale produsului păstrat s-au completat din cel vechi (aceeași unitate): prețurile, categoria, categoria din depozit", [Number(n1.pret_achizitie), Number(n1.pret_vanzare), n1.categorie, n1.categorie_depozit], [3.5, 5, "Benzi adezive", "produse finite"]);
  egal("…și costul de producție, prețul minim, stocul minim, adaosul propriu, costul real din contabilitate (cu sursa lui) și gestiunea",
    [Number(n1.pret_productie), Number(n1.pret_minim), Number(n1.stoc_minim), Number(n1.adaos_lista), Number(n1.cost_rata), n1.cost_rata_sursa, n1.gestiune], [2.75, 4.25, 30, 15, 0.625, "TUC profit pe produs", "TUC Marfuri"]);
  egal("…scris în istoricul unificărilor și la asocieri, cu ce s-a completat", [q("SELECT inghitit_id, inghitit_cod, 1 AS x FROM produse_fuziuni WHERE pastrat_id = ?", [N1]).map((x) => [Number(x.inghitit_id), x.inghitit_cod]), asociere(V1, N1)],
    [[[V1, "TUC-1056"]], [["unificata", "validata", "completat din cel vechi: prețul de achiziție, costul de producție, prețul de vânzare, prețul minim de vânzare, stocul minim, adaosul propriu, costul real din contabilitate, categoria, gestiunea, categoria din depozit"]]]);
  bine("…și spus pe pagină", /a intrat în TUCBAAT4860040 · „TUC Bandă adezivă Acrilică Transparent 48 mm 60 m 40 microni”: 3 rânduri mutate; completat din cel vechi: prețul de achiziție/.test(parametri(r).ok || ""), parametri(r).ok);
  egal("stocul e acum pe produsul cu cod nou, cum îl vede „Stoc la zi”", (await SP.citeste({ vedeTot: true })).filter((x) => [N1, V1].includes(Number(x.produs_id))).map((x) => [Number(x.produs_id), x.stoc, x.paleti]), [[N1, 150, 2]]);
  r = await cer(CALE, { query: { q: "TUC" } });
  bine("banda veche nu mai e în listă", !r.corp.includes(`data-vechi="${V1}"`) && r.corp.includes("TUC-1056") && /Ultimele unificări/.test(r.corp));
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(V1), nou_id: String(N1) } });
  egal("a doua oară nu mai are ce unifica", /nu mai există sau a fost deja unificat/.test(parametri(r).eroare || ""), true);
  // prețurile nu se completează între unități diferite; categoria da
  exec(`UPDATE produse SET pret_achizitie = 9, pret_productie = 7, pret_vanzare = 11, pret_minim = 8, stoc_minim = 6, adaos_lista = 12, cost_rata = 0.5, cost_rata_sursa = 'TUC alta sursa', gestiune = 'TUC Alta gestiune', categorie = 'TUC categorie veche', categorie_depozit = 'TUC alt raft', furnizor_id = NULL WHERE id = ${V9}`);
  exec(`UPDATE produse SET adaos_lista = 0 WHERE id = ${V3}`);
  const cePusV3 = await MOD.completeazaDinVechi(V3, V9);
  const v3 = produs(V3);
  egal("la unități diferite (buc și rola) nu se copiază nimic din ce ține de unitate — prețurile, costul de producție, stocul minim: un preț pe rolă pus pe bucăți ar fi o greșeală nouă",
    [Number(v3.pret_achizitie), Number(v3.pret_productie), Number(v3.pret_vanzare), Number(v3.pret_minim), Number(v3.stoc_minim)], [0, 0, 0, 0, 0]);
  egal("…dar ce nu ține de unitate, da: costul real din contabilitate, categoria, gestiunea; iar adaosul scris zero de om e o valoare, nu un gol, și rămâne zero",
    [cePusV3, Number(v3.cost_rata), v3.cost_rata_sursa, v3.categorie, v3.gestiune, Number(v3.adaos_lista)], [["costul real din contabilitate", "categoria", "gestiunea", "categoria din depozit"], 0.5, "TUC alta sursa", "TUC categorie veche", "TUC Alta gestiune", 0]);
  const cePusN1 = await MOD.completeazaDinVechi(N1, V9);
  const n1Dupa = produs(N1);
  egal("ce are deja păstratul rămâne, chiar la aceeași unitate: nimic nu se calcă",
    [cePusN1, Number(n1Dupa.pret_achizitie), Number(n1Dupa.pret_productie), Number(n1Dupa.pret_vanzare), Number(n1Dupa.pret_minim), Number(n1Dupa.stoc_minim), Number(n1Dupa.adaos_lista), Number(n1Dupa.cost_rata), n1Dupa.cost_rata_sursa, n1Dupa.categorie, n1Dupa.gestiune, n1Dupa.categorie_depozit],
    [[], 3.5, 2.75, 5, 4.25, 30, 15, 0.625, "TUC profit pe produs", "Benzi adezive", "TUC Marfuri", "produse finite"]);
  exec(`UPDATE produse SET categorie = NULL, categorie_depozit = NULL, gestiune = NULL, cost_rata = NULL, cost_rata_sursa = NULL, adaos_lista = NULL WHERE id = ${V3}`);

  console.log("\n── Rețetele ─────────────────────────────────────────────────");
  const reteta = (id) => q("SELECT componenta_id, cantitate FROM retete_componente WHERE produs_id = ? ORDER BY id", [id]).map((x) => [Number(x.componenta_id), Number(x.cantitate)]);
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(V13), nou: String(N4) } });
  bine("două produse care au fiecare rețetă: previzualizarea spune de ce nu se pot unifica și nu mai are butonul", r.cod === 200 && r.corp.includes("data-doua-retete") && r.corp.includes("Amândouă produsele au rețetă.") && !r.corp.includes('<button class="btn" type="submit">Unifică</button>') && r.corp.includes(">Înapoi</a>"), curat(r.corp).slice(0, 300));
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(V13), nou_id: String(N4) } });
  egal("…iar POST-ul e refuzat fără să miște nimic: rețetele nu se lipesc una de alta", [/^Unificarea n-a mers: Amândouă produsele au rețetă\./.test(parametri(r).eroare || ""), stare(V13), reteta(V13), reteta(N4)], [true, [1, null], [[C1, 1]], [[C1, 2]]]);
  r = await cer(`${CALE}/unifica`, { query: { vechi: String(V12), nou: String(N3) } });
  bine("produsul vechi cu rețetă și fratele lui fără: se poate, iar previzualizarea arată rândul de rețetă care se mută", r.cod === 200 && !r.corp.includes("data-doua-retete") && /<td>rânduri de rețetă \(ca produs\)<\/td><td>1<\/td>/.test(r.corp) && r.corp.includes('<button class="btn" type="submit">Unifică</button>'));
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(V12), nou_id: String(N3) } });
  egal("rețeta trece pe produsul care rămâne, cu baza pe care e scrisă (la mia de bucăți), iar costul din rețetă se socotește din nou (0,5 kg × 2 lei)",
    [stare(V12), reteta(N3), reteta(V12), Number(produs(N3).reteta_baza), Number(produs(N3).cost_reteta), produs(V12).cost_reteta, asociere(V12, N3).map((x) => x[2])],
    [[0, N3], [[C1, 0.5]], [], 1000, 1, null, ["completat din cel vechi: baza rețetei"]]);

  console.log("\n── Asocierea de mână și „Nu e același produs” ───────────────");
  const asociaza = (v, scris) => cer(`${CALE}/asociaza`, { metoda: "post", body: { vechi_id: String(v), nou: scris } });
  r = await asociaza(V9, "");
  egal("fără nimic scris: spune ce să scrii", /Scrie codul produsului în care intră, sau #id/.test(parametri(r).eroare || ""), true);
  r = await asociaza(V9, "TUC-NU-EXISTA");
  egal("cod care nu e al niciunui produs activ: nu", [/Niciun produs activ cu codul „TUC-NU-EXISTA”/.test(parametri(r).eroare || ""), asociere(V9, N2)], [true, []]);
  r = await asociaza(V9, "TUC-1056");
  egal("codul unui produs deja unificat nu se mai poate alege", /Niciun produs activ cu codul/.test(parametri(r).eroare || ""), true);
  r = await asociaza(V9, "TUCFSVAT2316 — TUC Folie Stretch Virgin Automată Transparent 23 microni 16 kg 2000 m");
  egal("ales din listă („COD — denumire”): asocierea e doar propusă, nimic nu se unifică", [asociere(V9, N2), stare(V9), /e asociat cu TUCFSVAT2316[\s\S]*Unificarea rămâne de validat/.test(parametri(r).ok || "")], [[["propusa", "de_mana", null]], [1, null], true]);
  r = await cer(CALE, { query: { q: "TUC" } });
  pr = propunerea(randul(r.corp, V9), N2);
  bine("…și apare pe rândul lui, cu cine a asociat-o", pr.includes('<span class="badge albastru">asociat de Vali Unificare</span>') && pr.includes(`href="${CALE}/unifica?vechi=${V9}&amp;nou=${N2}"`), curat(randul(r.corp, V9)).slice(0, 300));
  r = await cer(`${CALE}/respinge`, { metoda: "post", body: { vechi_id: String(V9), nou_id: String(N2) } });
  egal("„Nu e același produs”: notat", [asociere(V9, N2).map((x) => x[0]), /Propunerea nu mai apare/.test(parametri(r).ok || "")], [["respinsa"], true]);
  r = await cer(CALE, { query: { q: "TUC" } });
  bine("…și propunerea nu mai apare", !randul(r.corp, V9).includes("data-propunere="));
  r = await cer(`${CALE}/respinge`, { metoda: "post", body: { vechi_id: String(V2), nou_id: String(V3) } });
  r = await cer(CALE, { query: { q: "TUC" } });
  bine("la fel fratele „scris de două ori”, odată respins", !randul(r.corp, V2).includes(`data-propunere="${V3}"`), curat(randul(r.corp, V2)).slice(0, 200));
  const ra = await asociaza(V2, "#" + V3);
  r = await cer(CALE, { query: { q: "TUC" } });
  bine("asocierea de mână, cu „#id”, îl aduce înapoi", randul(r.corp, V2).includes(`data-propunere="${V3}"`) && /„TUC BANDA FRAGIL 50X60 \(TUC-Fragil\)” e asociat cu TUC-Fragil · „TUC BANDA FRAGIL 50X60”/.test(parametri(ra).ok || ""), parametri(ra).ok || parametri(ra).eroare);
  r = await asociaza(V8, "TUCFSVAT2316");
  r = await cer(CALE, { query: { q: "TUC" } });
  bine("propunerea cu altă unitate decât produsul vechi (buc și rola) o spune în listă; cea cu aceeași unitate, nu", propunerea(randul(r.corp, V8), N2).includes("altă unitate decât cel vechi") && curat(propunerea(randul(r.corp, V8), N2)).includes("5 rola · 1 palet") && !propunerea(randul(r.corp, V2), V3).includes("altă unitate"), curat(randul(r.corp, V8)).slice(0, 300));
  await cer(`${CALE}/respinge`, { metoda: "post", body: { vechi_id: String(V8), nou_id: String(N2) } });
  exec(`UPDATE produse SET cod = 'TUC-CUT' WHERE id = ${V8}`);
  r = await asociaza(V9, "tuc-cut");
  egal("două produse cu același cod: cere #id", /Sunt 2 produse cu codul „tuc-cut”\. Scrie-l cu #id/.test(parametri(r).eroare || ""), true);
  exec(`UPDATE produse SET cod = 'TUC-TRANSPORT' WHERE id = ${V8}`);
  r = await asociaza(N1, "TUC-1052");
  egal("nici de mână nu se asociază un produs cu cod nou într-unul vechi", [/Produsul cu cod nou e cel care rămâne/.test(parametri(r).eroare || ""), asociere(N1, V9)], [true, []]);
  r = await asociaza(999999999, "TUC-1052");
  egal("produs vechi care nu există: nu", /Produsul vechi nu mai există/.test(parametri(r).eroare || ""), true);

  console.log("\n── „E bun așa” ──────────────────────────────────────────────");
  r = await cer(`${CALE}/excepta`, { metoda: "post", body: { produs_id: String(V8), pe: "1" } });
  egal("produsul rămâne cum e și iese din listă", [Number(produs(V8).cod_vechi_exceptat), /rămâne cum e și a ieșit din listă/.test(parametri(r).ok || ""), (await cer(CALE, { query: { q: "TUC" } })).corp.includes(`data-vechi="${V8}"`)], [1, true, false]);
  const repune = (id) => `name="produs_id" value="${id}"><input type="hidden" name="pe" value="0">`;
  r = await cer(CALE, { query: { q: "TUC" } });
  const scoase = (r.corp.match(/<details data-exceptate[\s\S]*?<\/details>/) || [""])[0];
  bine("…și stă într-o listă închisă, sub tabel, de unde se poate repune — doar el, nu și celelalte produse vechi", scoase.includes("Scoase din listă cu „E bun așa”") && scoase.includes(repune(V8)) && scoase.includes("Repune în listă") && !scoase.includes(repune(V9)) && curat(scoase).includes("1 buc · 1 palet"), curat(scoase).slice(0, 300));
  r = await cer(`${CALE}/excepta`, { metoda: "post", body: { produs_id: String(V8), pe: "0" } });
  const dupaRepunere = (await cer(CALE, { query: { q: "TUC" } })).corp;
  egal("…și se poate repune: e iar în lista de unificat și a ieșit din cea a celor scoase", [Number(produs(V8).cod_vechi_exceptat), dupaRepunere.includes(`data-vechi="${V8}"`), dupaRepunere.includes(repune(V8))], [0, true, false]);

  console.log("\n── Scrise de două ori, fără stoc ────────────────────────────");
  r = await cer(CALE, { query: { parte: "perechi", q: "TUC" } });
  const bife = [...r.corp.matchAll(/<input type="checkbox" name="pereche" value="(\d+):(\d+)"( data-sigura="1")?>/g)].map((m) => [Number(m[1]), Number(m[2]), Boolean(m[3])]);
  egal("perechile la care produsul fără cod n-are stoc: cea sigură se bifează cu „toate”, cea cu altă denumire nu; cea cu stoc pe produsul fără cod nu e aici; cea cu stoc doar pe produsul păstrat, da",
    bife.sort((a, b) => a[0] - b[0]), [[V4, V5, true], [V6, V7, false], [V10, V11, true], [V14, V15, true]]);
  bine("…cu ce spune fiecare", r.corp.includes('<span class="badge verde">aceeași denumire</span>') && r.corp.includes('<span class="badge galben">același cod, altă denumire</span>') && curat(r.corp).includes("7 buc · 1 palet"));
  r = await cer(`${CALE}/perechi`, { metoda: "post", body: {} });
  egal("fără nicio bifă: nimic", [/N-ai bifat nicio pereche/.test(parametri(r).eroare || ""), parametri(r).parte], [true, "perechi"]);
  r = await cer(`${CALE}/perechi`, { metoda: "post", body: { pereche: [`${V4}:${V5}`, `${V6}:${V7}`, `${V2}:${V3}`, "999999998:999999999", `${V5}:${V4}`] } });
  egal("în bloc: cele două perechi fără stoc se unifică; cea cu stoc, cea născocită și cea întoarsă pe dos sunt sărite",
    [stare(V4), stare(V6), stare(V2), stare(V5), stare(V3), parametri(r).eroare || parametri(r).ok], [[0, V5], [0, V7], [1, null], [1, null], [1, null], "2 perechi unificate; 3 sărite (nu mai sunt perechi fără stoc — pagina era veche)."]);
  egal("…scrise ca „pereche” la asocieri", [asociere(V4, V5).map((x) => [x[0], x[1]]), asociere(V6, V7).map((x) => [x[0], x[1]])], [[["unificata", "pereche"]], [["unificata", "pereche"]]]);
  r = await cer(`${CALE}/perechi`, { metoda: "post", body: { pereche: `${V10}:${V11}` } });
  egal("o singură bifă (vine ca text, nu ca listă): se unifică", [stare(V10), parametri(r).ok], [[0, V11], "1 pereche unificată."]);
  r = await cer(`${CALE}/perechi`, { metoda: "post", body: { pereche: `${V10}:${V11}` } });
  egal("a doua oară: sărită, spus ca eroare", [parametri(r).eroare], ["0 perechi unificate; 1 sărite (nu mai sunt perechi fără stoc — pagina era veche)."]);
  r = await cer(`${CALE}/perechi`, { metoda: "post", body: { pereche: `${V14}:${V15}` } });
  egal("perechea la care amândouă au rețetă nu se unifică în bloc, și spune de ce", [stare(V14), reteta(V14), reteta(V15), parametri(r).eroare],
    [[1, null], [[C1, 3]], [[C1, 4]], "0 perechi unificate; 1 n-au mers: TUC Sac cu reteta (TUC-SACR) (amândouă au rețetă — unifică-le una câte una, după ce rămâne o singură rețetă)."]);
  r = await cer(CALE, { query: { parte: "perechi", q: "TUC" } });
  egal("în listă rămâne doar ea", [...r.corp.matchAll(/name="pereche" value="(\d+):(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]), [[V14, V15]]);
  r = await cer(CALE, { query: { parte: "perechi", q: "TUC nimic-de-gasit" } });
  bine("căutarea fără rezultat o spune", r.corp.includes("Nimic nu se potrivește cu ce ai căutat."));

  console.log("\n── Perechea cu stoc, una câte una ───────────────────────────");
  // produsul vechi n-are rețetă, dar i-au rămas scrise o bază de rețetă și un flux: fără rețetă, ele nu trec
  exec(`UPDATE produse SET reteta_baza = 500, flux_id = 7 WHERE id = ${V2}`);
  r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(V2), nou_id: String(V3) } });
  egal("banda Fragil fără cod intră în cea cu codul: stocul ei (684 buc) trece pe produsul păstrat, cu prețurile celui vechi",
    [stare(V2), paletiPe(V3), (await SP.citeste({ vedeTot: true })).filter((x) => Number(x.produs_id) === V3).map((x) => [x.stoc, x.um]), Number(produs(V3).pret_achizitie), Number(produs(V3).pret_vanzare), produs(V3).categorie],
    [[0, V3], 1, [[684, "buc"]], 2.2, 4, "Benzi adezive"]);
  egal("…dar baza de rețetă și fluxul nu vin, fiindcă nu vine nicio rețetă cu ele", [produs(V3).reteta_baza, produs(V3).flux_id, /baza rețetei|fluxul/.test(parametri(r).ok || "")], [null, null, false]);

  console.log("\n── Când motorul nu poate muta un loc ────────────────────────");
  // Motorul de unificare notează locul la care mutarea a căzut și merge mai departe. Pagina n-are voie să spună „gata”.
  const FZ = require(path.join(RAD, "lib", "produse-fuziune.js"));
  const fuzioneazaAdevarat = FZ.fuzioneaza;
  FZ.fuzioneaza = async (pastrat, inghitite) => ({ pastrat, inghitite, mutari: { "ct_paleti.produs_id": 1, "comenzi_linii.produs_id (eroare)": "nu s-a putut", "tabel_nou.produs_id (eroare)": "nu s-a putut" }, total: 1 });
  try {
    r = await cer(`${CALE}/unifica`, { metoda: "post", body: { vechi_id: String(V9), nou_id: String(N1) } });
    egal("unificarea la care un loc n-a putut fi mutat o spune cu roșu, pe numele locului, nu ca reușită",
      [parametri(r).ok === undefined, /1 rând mutat\. Atenție: n-au putut fi mutate: linii de comandă de client, tabel_nou\.produs_id\. Au rămas pe produsul vechi/.test(parametri(r).eroare || "")], [true, true]);
    exec(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${V16}, NULL, 'TUC Folie de proba (TUC-FP)', 'buc'), (${V17}, 'TUC-FP', 'TUC Folie de proba', 'buc')`);
    r = await cer(`${CALE}/perechi`, { metoda: "post", body: { pereche: `${V16}:${V17}` } });
    egal("…și în bloc, la fel", [parametri(r).ok === undefined, parametri(r).eroare], [true, "1 pereche unificată; 1 cu rânduri rămase pe produsul vechi: TUC Folie de proba (TUC-FP) (linii de comandă de client, tabel_nou.produs_id)."]);
  } finally {
    FZ.fuzioneaza = fuzioneazaAdevarat;
  }

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
