"use strict";
// Cu cât a intrat paletul — și de ce „de alocat" nu se mai umple cu marfă plecată.
//
// CE S-A GĂSIT, 10.11.2026 (în timp ce se scotea plafonul de cantitate):
//   „Cât s-a pus pe paleți dintr-un rând de recepție" se socotea din cantitatea
//   de ACUM a paletului. După o ieșire parțială paletul are mai puțin, deci
//   rândul recepției reapărea în Intrare marfă și pe scaner cu marfa plecată ca
//   „de alocat", iar Stoc la zi, stocul pentru comenzi și calculatorul de
//   stretch o numărau încă o dată: 1000 kg puse pe palet, 300 scoase în
//   producție → „300 kg de alocat" și 300 kg în plus la stoc. Cu recepțiile de
//   la furnizori intrate în listă în aceeași zi, s-ar fi văzut la fiecare sac
//   de granulă luat în producție.
//
// CE APĂRĂ:
//   • PALETUL ȚINE MINTE CU CÂT A INTRAT (ct_paleti.cantitate_intrare), scris
//     la intrare și neschimbat de ieșiri sau adăugări.
//   • DUPĂ O IEȘIRE PARȚIALĂ RÂNDUL NU REAPARE: nici în lista din producție,
//     nici în cea de la furnizori, nici la cererile depozitului, nici pe scaner,
//     nici pe pagina recepției, nici la livrarea directă; iar stocul (Stoc la
//     zi, stocul pentru comenzi, calculatorul de stretch) scade cu ce a plecat.
//   • PALEȚII DE DINAINTEA COLOANEI: fără valoare, contează cu ce au pe ei;
//     completarea de la pornire (lib/db.js) le pune cât au, plus ce a plecat
//     prin ieșiri parțiale, minus ce s-a adăugat — o singură dată.
//   • RECEPȚIA IA CANTITATEA DE PE PALEȚI când pe ei e mai mult decât scria că
//     a venit (Vali, 10.11.2026: „se salvează cantitatea din recepție"), doar
//     în sus, doar la recepția finalizată, pe rândul primit în stare bună.
//
// Pe PostgreSQL real (port 5433), prin psql.
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
function q(sql, p) {
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
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

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
// În ordinea din server.js.
for (const m of ["gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const GP = require(path.join(RAD, "lib", "gata-productie.js"));
const STADIU = require(path.join(RAD, "lib", "stadiu-comanda.js"));

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

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- datele de test ------------------------------------------------------
const fs = require("fs");
const PREFIX = "TPI";
const PF = 97901, PP = 97902, PC = 97903, PV = 97904;
const FURNIZOR = 97911;
const A_C = 97921;
const PRODUSE = [PF, PP, PC, PV];
const BAZA = "/stocuri/ct-park/scaner";

function curata() {
  const pr = PRODUSE.join(",");
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-%'`).map((x) => Number(x.id));
  const r = rec.join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE receptie_id IN (${r}) OR produs_id IN (${pr}) OR aprovizionare_id = ${A_C} OR cod LIKE '${PREFIX}-%'`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_tipar WHERE creat_de = 'TPI Depozit'`);
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_adaugari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM stoc_locuri WHERE receptie_id IN (${r}) OR produs_id IN (${pr})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${r}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii WHERE id IN (${r})`);
  q(`DELETE FROM aprovizionari WHERE id = ${A_C} OR produs_id IN (${pr})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM parteneri WHERE id = ${FURNIZOR}`);
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
function receptie(numar, sursa, stare) {
  return Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare, finalizata_la)
     VALUES ('${PREFIX}-${numar}', '${sursa}', ${sursa === "furnizor" ? FURNIZOR : "NULL"}, '${azi()}', '${stare}', ${stare === "finalizata" ? "'" + azi() + " 10:00:00'" : "NULL"}) RETURNING id`));
}
function linie(rid, produs, asteptat, primit, um, stare, conditie) {
  return Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie, pret_unitar)
     VALUES (${rid}, ${produs}, ${asteptat}, ${primit == null ? "NULL" : primit}, '${um}', '${stare}', ${conditie ? "'" + conditie + "'" : "NULL"}, 4) RETURNING id`));
}
const paleti = (unde) => q(`SELECT id, cantitate, cantitate_intrare FROM ct_paleti WHERE ${unde} ORDER BY id`).map((x) => [Number(x.cantitate), x.cantitate_intrare == null ? null : Number(x.cantitate_intrare)]);
const idPaleti = (unde) => q(`SELECT id FROM ct_paleti WHERE ${unde} ORDER BY id`).map((x) => Number(x.id));
const primit = (lid) => Number(unul(`SELECT cantitate_primita FROM receptii_linii WHERE id = ${lid}`));

(async () => {
  curata();
  const DEP = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "TPI Depozit", rol: "depozit", sectiuni: "" };
  const CT = require(path.join(RAD, "modules", "ct-park.js"));
  const REC = require(path.join(RAD, "modules", "receptie.js"));
  const W = require(path.join(RAD, "modules", "warehouse.js"));
  const SC = require(path.join(RAD, "lib", "ct-scaner.js"));
  const SP = require(path.join(RAD, "lib", "stoc-produse.js"));
  const CS = require(path.join(RAD, "modules", "calculator-stretch.js"));

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (${PF}, '${PREFIX}-F', '${PREFIX} Folie stretch jumbo 17my', 'kg'), (${PP}, '${PREFIX}-P', '${PREFIX} Pungă curier', 'buc'),
       (${PC}, '${PREFIX}-C', '${PREFIX} Bandă adezivă', 'buc'), (${PV}, '${PREFIX}-V', '${PREFIX} Carton vechi', 'buc')`);
  // Prețul e obligatoriu la intrarea în depozit (11.11.2026; test-pret-intrare.js):
  // produsele de probă au un cost, ca paleții lor să intre.
  q(`UPDATE produse SET pret_achizitie = 2 WHERE id IN (${PF}, ${PP}, ${PC}, ${PV})`);
  const R_F = receptie("REC-F", "furnizor", "finalizata");
  const LF = linie(R_F, PF, 1000, 1000, "kg", "primita", "bun");
  const R_P = receptie("REC-P", "productie", "finalizata");
  const LP = linie(R_P, PP, 500, 500, "buc", "primita", "bun");
  q(`INSERT INTO aprovizionari (id, produs_id, cantitate, sursa, status, creata_la) VALUES (${A_C}, ${PC}, 90, 'productie', 'gata', '${azi()}')`);
  const pune = (b, cant) => CT.puneMarfa({ user: DEP }, b, [[]], cant);
  const stocLaZi = async (produs) => {
    const r = (await SP.citeste({ vedeTot: true })).find((x) => Number(x.produs_id) === produs);
    return r ? [r.stoc, r.dePus] : null;
  };
  const jumbo = async () => { const j = (await CS.jumboDinStoc()).produse.find((x) => String(x.cheie) === String(PF)); return j ? j.kg : 0; };
  const inListe = async () => ({
    furnizori: (await GP.receptiiFurnizori()).filter((x) => x.id === LF).map((x) => [x.cantitate, x.pus, x.ramas]),
    productie: (await GP.receptii()).filter((x) => x.id === LP).map((x) => [x.cantitate, x.pus, x.ramas]),
    cereri: (await GP.cereri()).filter((x) => x.id === A_C).map((x) => [x.cantitate, x.pus, x.ramas]),
    scaner: [await SC.randDeAsezat(`r${LF}`), await SC.randDeAsezat(`r${LP}`), await SC.randDeAsezat(`c${A_C}`)].map((x) => (x ? x.ramas : null)),
  });

  // ------------------------------------------------------------------------
  console.log("1. Înainte de paleți: tot ce a venit e de alocat și e pe stoc");
  egal("listele: 1.000 kg de la furnizor, 500 buc din producție, 90 buc din cerere", await inListe(),
    { furnizori: [[1000, 0, 1000]], productie: [[500, 0, 500]], cereri: [[90, 0, 90]], scaner: [1000, 500, 90] });
  egal("stocul pentru comenzi numără marfa recepționată, încă fără palet", [(await W.stocPeProduse()).get(PF), (await W.stocPeProduse()).get(PP)], [1000, 500]);
  egal("calculatorul de stretch vede 1.000 kg de jumbo", await jumbo(), 1000);

  // ------------------------------------------------------------------------
  console.log("\n2. Paleții: fiecare ține minte cu cât a intrat");
  await pune({ produs_id: PF, um: "kg", receptie_id: R_F, receptie_linie_id: LF }, 600);
  await pune({ produs_id: PF, um: "kg", receptie_id: R_F, receptie_linie_id: LF }, 400);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_P, receptie_linie_id: LP }, 500);
  await pune({ produs_id: PC, um: "buc", aprovizionare_id: A_C }, 90);
  egal("cantitatea de la intrare e scrisă pe fiecare palet", [paleti(`receptie_linie_id = ${LF}`), paleti(`receptie_linie_id = ${LP}`), paleti(`aprovizionare_id = ${A_C}`)], [[[600, 600], [400, 400]], [[500, 500]], [[90, 90]]]);
  egal("un palet pus fără cantitate n-are valoare (se scrie când se numără)", (await pune({ produs_id: PV, um: "buc" }, 0), paleti(`produs_id = ${PV}`)), [[0, null]]);
  egal("totul are palet: nimic de alocat", await inListe(), { furnizori: [], productie: [], cereri: [], scaner: [null, null, null] });
  egal("stocul e același, acum pe paleți", [(await W.stocPeProduse()).get(PF), (await W.stocPeProduse()).get(PP), await jumbo()], [1000, 500, 1000]);
  const [PAL_F1] = idPaleti(`receptie_linie_id = ${LF}`);
  const [PAL_P] = idPaleti(`receptie_linie_id = ${LP}`);
  const [PAL_C] = idPaleti(`aprovizionare_id = ${A_C}`);

  // ------------------------------------------------------------------------
  console.log("\n3. Ieșiri parțiale: marfa plecată nu se întoarce la „de alocat”");
  const iese = (palet, cat) => cer("post", `${BAZA}/iesire/palet/${palet}`, DEP, { body: { destinatie: "productie", q: String(cat) } });
  let r = await iese(PAL_F1, 300);
  bine("300 kg ies din paletul de 600, spre producție", !parametri(r).eroare && Number(unul(`SELECT cantitate FROM ct_palet_linii WHERE palet_id = ${PAL_F1}`)) === 300, unde(r));
  r = await iese(PAL_P, 120);
  r = await iese(PAL_C, 20);
  egal("paleții au mai puțin pe ei, dar cu cât au intrat rămâne scris", [paleti(`receptie_linie_id = ${LF}`), paleti(`receptie_linie_id = ${LP}`), paleti(`aprovizionare_id = ${A_C}`)], [[[300, 600], [400, 400]], [[380, 500]], [[70, 90]]]);
  egal("rândurile nu reapar în nicio listă și nici pe scaner", await inListe(), { furnizori: [], productie: [], cereri: [], scaner: [null, null, null] });
  egal("stocul pentru comenzi a scăzut cu ce a plecat, nu s-a umflat la loc", [(await W.stocPeProduse()).get(PF), (await W.stocPeProduse()).get(PP), (await W.stocPeProduse()).get(PC)], [700, 380, 70]);
  egal("calculatorul de stretch: 700 kg de jumbo", await jumbo(), 700);
  const sz = await stocLaZi(PF);
  bine("Stoc la zi: 700 kg, nimic „de pus”", JSON.stringify(sz) === JSON.stringify([700, 0]) || (Array.isArray(sz) && Number(sz[0]) === 700 && !Number(sz[1])), JSON.stringify(sz));
  egal("Intrarea deschisă din rândul recepției: nimic rămas de pus", (({ primit: a, pus: b, ramas: c }) => [a, b, c])(await CT.dinReceptie(LF)), [1000, 1000, 0]);
  egal("cererea depozitului: 90 puse din 90", (({ primit: a, pus: b, ramas: c }) => [a, b, c])(await GP.cerere(A_C)), [90, 90, 0]);
  let pag = (await cer("get", `/depozit/receptie/${R_F}`, DEP)).corp;
  const ctpark = pag.slice(pag.indexOf('id="ct-park"'));
  bine("pagina recepției: „tot pus”, fără formularul de paleți", /tot pus/.test(ctpark) && !ctpark.includes(`name="paleti_${LF}"`), ctpark.slice(0, 300));
  bine("…la fiecare palet scrie cu cât a intrat și, unde a plecat ceva, cât are acum", /· 600 kg <span class="mic">\(acum 300\)<\/span>/.test(ctpark) && /· 400 kg ·/.test(ctpark) && !/\(acum 400\)/.test(ctpark), (ctpark.match(/TPI[^<]*<\/a>[^<]*(<span[^<]*<\/span>)?/g) || []).join(" | "));
  const ld = await REC.livrareDirecta(DEP, R_F, LF, "fulfillment", "", null);
  bine("livrarea directă nu mai are ce trimite din rând", /deja pus în CT-Park sau plecat/.test(ld.eroare || ""), JSON.stringify(ld));
  egal("recepția rămâne la cât a venit: ieșirile n-o ating", [primit(LF), primit(LP)], [1000, 500]);
  // Ce se adaugă pe palet după intrare nu e din recepție.
  q(`UPDATE ct_palet_linii SET cantitate = 450 WHERE palet_id = ${PAL_F1}`);
  q(`UPDATE ct_paleti SET cantitate = 450 WHERE id = ${PAL_F1}`);
  egal("marfă adăugată apoi pe palet: „pus din recepție” rămâne 1.000, stocul urcă la 850", [(await CT.dinReceptie(LF)).pus, (await W.stocPeProduse()).get(PF), (await GP.receptiiFurnizori()).filter((x) => x.id === LF).length], [1000, 850, 0]);

  // ------------------------------------------------------------------------
  console.log("\n4. Paleții de dinaintea coloanei");
  const R_V = receptie("REC-V", "furnizor", "finalizata");
  const LV = linie(R_V, PV, 200, 200, "buc", "primita", "bun");
  const vechi = (cod, cant) => {
    const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, data_intrare, receptie_id, receptie_linie_id) VALUES ('${PREFIX}-${cod}', ${PV}, ${cant}, 'buc', '2026-11-01', ${R_V}, ${LV}) RETURNING id`));
    q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (${id}, ${PV}, ${cant}, 'buc')`);
    return id;
  };
  const V1 = vechi("V1", 120);
  egal("fără valoare, paletul contează cu ce are pe el: 120 puse, 80 de alocat", (await GP.receptiiFurnizori()).filter((x) => x.id === LV).map((x) => [x.pus, x.ramas]), [[120, 80]]);
  // Completarea de la pornire, exact cum e scrisă în lib/db.js.
  const schema = fs.readFileSync(path.join(RAD, "lib", "db.js"), "utf8");
  const completare = (schema.match(/UPDATE ct_paleti p SET cantitate_intrare = [\s\S]*?;/) || [""])[0];
  bine("completarea e în schema de la pornire, după adăugarea coloanei", /ADD COLUMN IF NOT EXISTS cantitate_intrare DOUBLE PRECISION;/.test(schema) && schema.indexOf("ADD COLUMN IF NOT EXISTS cantitate_intrare") < schema.indexOf("UPDATE ct_paleti p SET cantitate_intrare") && completare.length > 100, completare.slice(0, 120));
  // V1: avea 200, au plecat 50 și 30 prin ieșiri parțiale → acum 120.
  // V2: intrat cu 60, +25 adăugate după, apoi o ieșire parțială de 10 și una care l-a golit (ea nu-i schimbă cantitatea) → antet 75.
  // V3: fără cantitate.
  const V2 = vechi("V2", 75);
  const V3 = vechi("V3", 0);
  q(`UPDATE ct_paleti SET cantitate = NULL WHERE id = ${V3}`);
  q(`UPDATE ct_paleti SET data_iesire = '${azi()}' WHERE id = ${V2}`);
  const iesire = (palet, cat, partiala) => {
    const id = Number(unul(`INSERT INTO ct_iesiri (palet_id, destinatie, data, partiala) VALUES (${palet}, 'productie', '${azi()}', ${partiala}) RETURNING id`));
    q(`INSERT INTO ct_iesiri_linii (iesire_id, cantitate, cantitate_ramasa, um) VALUES (${id}, ${cat}, 0, 'buc')`);
  };
  iesire(V1, 50, 1); iesire(V1, 30, 1);
  q(`INSERT INTO ct_palet_adaugari (palet_id, cantitate, um, data) VALUES (${V2}, 25, 'buc', '${azi()}')`);
  iesire(V2, 10, 1); iesire(V2, 75, 0);
  // Pe baza de test există deja paleți cu valoare, deci completarea, rulată întocmai, nu mai atinge nimic.
  q(completare);
  egal("rulată a doua oară (există deja paleți cu valoare), completarea nu mai atinge nimic", paleti(`id IN (${V1}, ${V2}, ${V3})`), [[120, null], [75, null], [0, null]]);
  // Aceeași expresie, doar pe paleții de test, ca la prima pornire.
  const garda = "AND NOT EXISTS (SELECT 1 FROM ct_paleti z WHERE z.cantitate_intrare IS NOT NULL)";
  bine("completarea are garda „o singură dată”", completare.includes(garda), completare.slice(-160));
  // V4 are deja valoarea lui (intrat cu 80, acum 50): completarea nu i-o rescrie.
  const V4 = vechi("V4", 50);
  q(`UPDATE ct_paleti SET cantitate_intrare = 80, receptie_id = NULL, receptie_linie_id = NULL WHERE id = ${V4}`);
  q(completare.replace(garda, `AND p.id IN (${V1}, ${V2}, ${V3}, ${V4})`));
  egal("prima oară: cât au acum, plus ieșirile parțiale, minus adăugările; paletul fără cantitate rămâne fără valoare, cel cu valoare o păstrează",
    q(`SELECT cantitate, cantitate_intrare FROM ct_paleti WHERE id IN (${V1}, ${V2}, ${V3}, ${V4}) ORDER BY id`).map((x) => [x.cantitate == null ? null : Number(x.cantitate), x.cantitate_intrare == null ? null : Number(x.cantitate_intrare)]), [[120, 200], [75, 60], [null, null], [50, 80]]);
  egal("după completare, rândul vechi e pus tot (200 + 60 din 200… deci nimic de alocat)", (await GP.receptiiFurnizori()).filter((x) => x.id === LV).length, 0);

  // ------------------------------------------------------------------------
  console.log("\n5. Recepția ia cantitatea de pe paleți doar când pe ei e mai mult");
  const R_A = receptie("REC-A", "furnizor", "finalizata");
  const LA = linie(R_A, PP, 100, 100, "buc", "primita", "bun");
  const LA_STRICAT = linie(R_A, PP, 40, 40, "buc", "primita", "deteriorat");
  const LA_RESPINS = linie(R_A, PP, 30, 0, "buc", "respinsa", null);
  const miscari = () => q(`SELECT cantitate, pret_unitar, observatii FROM miscari_stoc WHERE produs_id = ${PP} AND document_ref = '${PREFIX}-REC-A' ORDER BY id`).map((x) => [Number(x.cantitate), Number(x.pret_unitar), x.observatii]);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_A, receptie_linie_id: LA }, 70);
  egal("70 din 100 pe palet: recepția rămâne la 100 (în jos nu coboară)", [primit(LA), miscari()], [100, []]);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_A, receptie_linie_id: LA }, 30);
  egal("exact cât a venit: neschimbată, fără mișcare de stoc", [primit(LA), miscari()], [100, []]);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_A, receptie_linie_id: LA }, 12.5);
  egal("încă 12,5 peste: recepția urcă la 112,5", primit(LA), 112.5);
  egal("…iar diferența intră în mișcările de stoc, cu prețul rândului și cu cine a pus", miscari(), [[12.5, 4, "pe paleți e mai mult decât scria recepția: 112.5 față de 100 buc · TPI Depozit"]]);
  await iese(idPaleti(`receptie_linie_id = ${LA}`)[0], 50);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_A, receptie_linie_id: LA }, 7.5);
  egal("după o ieșire parțială, încă 7,5: se socotește din cât a intrat pe paleți (120), nu din cât mai e pe ei", [primit(LA), miscari().map((x) => x[0])], [120, [12.5, 7.5]]);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_A, receptie_linie_id: LA_STRICAT }, 60);
  await pune({ produs_id: PP, um: "buc", receptie_id: R_A, receptie_linie_id: LA_RESPINS }, 60);
  egal("pe rândul deteriorat și pe cel respins recepția nu se schimbă", [primit(LA_STRICAT), primit(LA_RESPINS), miscari().length], [40, 0, 2]);
  const R_N = receptie("REC-N", "furnizor", "in_lucru");
  const LN = linie(R_N, PP, 10, 10, "buc", "primita", "bun");
  await pune({ produs_id: PP, um: "buc", receptie_id: R_N, receptie_linie_id: LN }, 25);
  egal("nici la recepția încă nefinalizată: acolo se mai numără", primit(LN), 10);
  egal("chemată de-a dreptul: spune cu cât a urcat, sau zero", [
    (await REC.aliniazaLaPaleti(LA, DEP)).surplus, (await REC.aliniazaLaPaleti(LN, DEP)).surplus, (await REC.aliniazaLaPaleti(999999999, DEP)).surplus, primit(LA),
  ], [0, 0, 0, 120]);
  // Un palet legat de rând pe altă cale decât Intrarea (aici, de mână): chemată, funcția spune cu cât a urcat.
  const idManual = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare, receptie_id, receptie_linie_id) VALUES ('${PREFIX}-MAN', ${PP}, 15, 15, 'buc', '${azi()}', ${R_A}, ${LA}) RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (${idManual}, ${PP}, 15, 'buc')`);
  egal("…cu cât era înainte și cât e acum", await REC.aliniazaLaPaleti(LA, DEP), { surplus: 15, primit: 135, inainte: 120, um: "buc" });
  egal("…și a scris-o", [primit(LA), miscari().map((x) => x[0])], [135, [12.5, 7.5, 15]]);
  // Un rând fără produs din catalog (marfă scrisă ca text): recepția urcă, dar n-are ce mișcare de stoc să scrie.
  const LT = Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_text, cantitate_asteptata, cantitate_primita, um, stare, conditie) VALUES (${R_A}, '${PREFIX} marfă scrisă', 5, 5, 'buc', 'primita', 'bun') RETURNING id`));
  await pune({ produs_text: `${PREFIX} marfă scrisă`, um: "buc", pret_unitar: "2", receptie_id: R_A, receptie_linie_id: LT }, 8);
  egal("marfa scrisă ca text: recepția urcă la 8, fără mișcare de stoc", [primit(LT), Number(unul(`SELECT COUNT(*) FROM miscari_stoc WHERE document_ref = '${PREFIX}-REC-A'`))], [8, 3]);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* rămâne pentru rularea următoare */ }
  process.exit(1);
});
