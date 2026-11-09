"use strict";
// Calculatorul de cost al rolei stretch făcute din jumbo.
//
// Vali, 09.11.2026, cu „Calculator_cost_rola_stretch_2.xlsx": „Urcă apoi și
// calculatorul — asta, unde sunt și celelalte." Calculatorul stă acum lângă
// celelalte (preț pe categorie, plicuri AWB, pungi, cutii), la
// /calculator/stretch.
//
// Ce se verifică:
//   1. socoteala dă cifră cu cifră ce dă foaia de calcul pe exemplul din ea
//      (14,4 kg, 23 µm, 500 mm, core automat, mașina de prestretch, 1,69 €/kg
//      la 5,35, jumbo 50 / 48,4 kg);
//   2. variantele: doar role întregi, adaos, contribuții, comandă de mai multe
//      role, mașina normală cu un core care nu e al ei, împărțiri la zero;
//   3. prețul folosit: de mână, media stocului, un jumbo anume, lipsa lui;
//   4. stocul de jumbo din CT-Park: liniile de pe paleți, paleții vechi fără
//      linii și recepțiile finalizate încă fără raft; nu intră paleții ieșiți,
//      banda adezivă jumbo, stretch-ul care nu e jumbo, unitățile altele
//      decât kg (se spun doar); media e ponderată cu kilogramele cu preț;
//   5. pagina: în lista de calculatoare, cifrele din Excel, prețul din stoc,
//      avertismentele, cursul BNR, parametrii doar pentru administrator;
//   6. salvarea parametrilor: doar administratorul, valorile greșite nu
//      strică nimic, pagina calculează apoi cu cei noi.
//
// Pe baza Postgres locală (port 5433), cu paginile adevărate.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8" }); }
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
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const SC = require(path.join(RAD, "lib", "stretch-cost.js"));
const CS = require(path.join(RAD, "modules", "calculator-stretch.js"));
const { selectorCalculator } = require(path.join(RAD, "lib", "render.js"));

const rute = { get: {}, post: {} };
const reg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; } };
CS.register(reg);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { query, body } = {}) {
  const r = res();
  const h = rute[metoda][cale];
  if (!h) throw new Error("nicio rută pentru " + metoda + " " + cale);
  await h({ user, params: {}, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase() } });
  return r;
}
const unde = (r) => r.antet.Location || r.antet.location || "";

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
function egal(descriere, a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  bine(descriere + " = " + y, x === y, x);
}
function aprox(descriere, a, b, tol = 1e-9) {
  const ok = Number.isFinite(a) && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  bine(`${descriere} = ${b}`, ok, a);
}
// Textul unei celule din tabelele de rezultate: rândul cu eticheta dată.
function rand(html, eticheta) {
  const i = html.indexOf(`<td>${eticheta}</td>`);
  if (i < 0) return "";
  return html.slice(i, html.indexOf("</tr>", i)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const ADMIN = { id: 1, nume: "Vali Test", rol: "admin", sectiuni: "" };
const VANZARI = { id: 2, nume: "Ana Test", rol: "vanzari", sectiuni: "" };
const CHEIE = "stretch_cost_asumptii";

// ---- datele de test ------------------------------------------------------
const P_JUMBO = 97901; // „TCS Stretch jumbo 23my": paleți cu preț, fără preț, un palet vechi, un palet ieșit, bucăți
const P_GUM = 97902; // „TCS Bandă adezivă jumbo" — nu e stretch
const P_MANUAL = 97903; // „TCS Folie stretch manuală 2kg" — nu e jumbo
const P_STRECH = 97904; // „TCS Strech jumbo 17my" (scris greșit) — în recepție, o parte pe raft
const P_FARA = 97905; // „TCS stretch JUMBO fără preț" — doar paleți fără preț
const REC = 97931, RL = 97941, RL_INCHIS = 97942;
const ZI_CURS = "2026-11-09";
let cursCreat = false;
let salvatInainte = null;

function curata() {
  q("DELETE FROM ct_palet_linii WHERE palet_id BETWEEN 97911 AND 97925");
  q("DELETE FROM ct_paleti WHERE id BETWEEN 97911 AND 97925");
  q(`DELETE FROM receptii_linii WHERE id IN (${RL}, ${RL_INCHIS})`);
  q(`DELETE FROM receptii WHERE id = ${REC}`);
  q("DELETE FROM produse WHERE id BETWEEN 97901 AND 97905");
}

(async () => {
  const s0 = q("SELECT valoare FROM setari_app WHERE cheie = ?", [CHEIE])[0];
  salvatInainte = s0 ? s0.valoare : null;
  q("DELETE FROM setari_app WHERE cheie = ?", [CHEIE]);
  curata();
  try {
    await ruleaza();
  } finally {
    curata();
    q("DELETE FROM setari_app WHERE cheie = ?", [CHEIE]);
    if (salvatInainte != null) q("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)", [CHEIE, salvatInainte, "2026-11-09"]);
    if (cursCreat) q("DELETE FROM cursuri_bnr WHERE data = ? AND moneda = 'EUR'", [ZI_CURS]);
  }
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function ruleaza() {
  const core = (k) => SC.CORE.find((c) => c.cheie === k);
  const masina = (k) => SC.MASINI.find((m) => m.cheie === k);

  // ------------------------------------------------------------------------
  console.log("1. Exemplul din foaia de calcul, cifră cu cifră");
  const pretExcel = 1.69 * 5.35;
  const r = SC.calculeaza(SC.INTRARI, SC.PARAMETRI, core("automat"), masina("prestretch"), pretExcel);
  aprox("B25 preț stretch folosit (lei/kg)", r.pretRonKg, 9.0415);
  aprox("B26 preț în EUR/kg", r.pretEurKg, 1.69);
  aprox("B29 lungime folie (m)", r.lungime, 1361.0586011342155);
  aprox("B32 timp bobinare (s)", r.bobinare, 81.66351606805293);
  aprox("B35 timp ciclu (s)", r.ciclu, 276.6635160680529);
  aprox("B36 role pe oră", r.rolePeOra, 13.012196371835607);
  egal("B37 verificare mașină / produs", r.atentie, "");
  aprox("B40 cost jumbo (lei)", r.costJumbo, 452.07499999999993);
  aprox("B41 role dintr-un jumbo", r.roleDinJumbo, 3.3611111111111107);
  aprox("B42 material pe rolă (lei)", r.material, 134.501652892562);
  aprox("B43 core (lei)", r.core, 5);
  aprox("B44 electricitate (lei)", r.electricitate, 0.3842548834278513);
  aprox("B45 manoperă (lei)", r.manopera, 3.6023895321361055);
  aprox("B47 cost total pe rolă (lei)", r.costRola, 143.48829730812594);
  aprox("B48 cost total pe rolă (EUR)", r.costRolaEur, 26.820242487500177);
  aprox("B49 preț de vânzare pe rolă, fără adaos (lei)", r.pretRola, 143.48829730812594);
  aprox("B53 material fără pierderi (lei)", r.materialFaraPierderi, 130.1976);
  aprox("B54 cost pierderi jumbo (lei)", r.costPierderi, 4.304052892561998);
  aprox("B55 pierdere jumbo", r.pierdere, 0.03305785123966953);
  aprox("B56 cost pe kg livrat (lei)", r.costPeKg, 9.96446509084208);
  aprox("B57 greutate core (kg)", r.kgCore, 1.64);
  aprox("B58 greutate brută rolă (kg)", r.kgBrut, 16.04);
  egal("B61 jumbo necesare", r.jumboNecesare, 1);
  aprox("B62 stretch net livrat (kg)", r.netLivrat, 14.4);
  aprox("B63 greutate brută comandă (kg)", r.brutComanda, 16.04);
  aprox("B64 ore mașină", r.oreMasina, 0.07685097668557024);
  aprox("B65 cost total comandă (lei)", r.costTotal, 143.48829730812594);
  aprox("B68 profit, fără adaos", r.profit, 0);

  // ------------------------------------------------------------------------
  console.log("\n2. Variantele");
  const x = (o) => Object.assign({}, SC.INTRARI, o);
  const intregi = SC.calculeaza(x({ intregi: "DA" }), SC.PARAMETRI, core("automat"), masina("prestretch"), pretExcel);
  egal("doar role întregi: 3 role dintr-un jumbo", intregi.roleDinJumbo, 3);
  aprox("doar role întregi: materialul = 452,075 ÷ 3", intregi.material, 452.075 / 3);
  const adaos = SC.calculeaza(x({ adaos: 20, role: 10 }), SC.PARAMETRI, core("automat"), masina("prestretch"), pretExcel);
  aprox("adaos 20%: prețul = costul × 1,2", adaos.pretRola, adaos.costRola * 1.2);
  egal("10 role: 3 jumbo (10 ÷ 3,36 = 2,98, rotunjit în sus)", adaos.jumboNecesare, 3);
  aprox("10 role: profitul = 10 × (preț − cost)", adaos.profit, 10 * (adaos.pretRola - adaos.costRola));
  aprox("10 role: 144 kg net", adaos.netLivrat, 144);
  const contrib = SC.calculeaza(SC.INTRARI, Object.assign({}, SC.PARAMETRI, { contributii: 2.25, operatori: 2 }), core("automat"), masina("prestretch"), pretExcel);
  aprox("contribuții 2,25% și 2 operatori: manopera × 2 × 1,0225", contrib.manopera, r.manopera * 2 * 1.0225);
  const normala = SC.calculeaza(x({ masina: "normala" }), SC.PARAMETRI, core("automat"), masina("normala"), pretExcel);
  bine("mașina normală cu core automat: ATENȚIE", /ATENȚIE/.test(normala.atentie), normala.atentie);
  aprox("mașina normală: bobinare la 500 m/min", normala.bobinare, (1361.0586011342155 / 500) * 60);
  const normalaOk = SC.calculeaza(x({ masina: "normala" }), SC.PARAMETRI, core("manual"), masina("normala"), pretExcel);
  egal("mașina normală cu core de rolă manuală: fără avertisment", normalaOk.atentie, "");
  const zero = SC.calculeaza(x({ kg: 0, curs: 0, jumbo_util: 0 }), SC.PARAMETRI, core("automat"), masina("prestretch"), pretExcel);
  const nefinite = Object.entries(zero).filter(([, v]) => typeof v === "number" && !Number.isFinite(v)).map(([k]) => k);
  egal("împărțiri la zero: nicio cifră infinită sau NaN", nefinite, []);
  egal("împărțiri la zero: 0 jumbo necesare", zero.jumboNecesare, 0);

  // ------------------------------------------------------------------------
  console.log("\n3. Prețul folosit");
  const stocDemo = { medie: { pret: 9.5, kgCuPret: 800, kg: 1000 }, produse: [{ cheie: "7", denumire: "J7", pret: 10.02 }, { cheie: "8", denumire: "J8", pret: 0 }] };
  aprox("de mână: EUR/kg × curs", SC.pretFolosit(x({ sursa: "manual" }), stocDemo).pret, 9.0415);
  aprox("media stocului", SC.pretFolosit(x({ sursa: "medie" }), stocDemo).pret, 9.5);
  bine("media fără niciun preț în stoc: lipsă", SC.pretFolosit(x({ sursa: "medie" }), { medie: { pret: 0, kgCuPret: 0 }, produse: [] }).lipsa === true);
  aprox("un jumbo anume", SC.pretFolosit(x({ sursa: "produs", produs_id: "7" }), stocDemo).pret, 10.02);
  bine("jumbo fără preț: lipsă", SC.pretFolosit(x({ sursa: "produs", produs_id: "8" }), stocDemo).lipsa === true);
  bine("jumbo neales: lipsă", SC.pretFolosit(x({ sursa: "produs", produs_id: "" }), stocDemo).lipsa === true);

  // ------------------------------------------------------------------------
  console.log("\n4. Stocul de jumbo din CT-Park");
  const inainte = await CS.jumboDinStoc();
  bine("baza nu are deja produsele de test", !inainte.produse.some((p) => Number(p.cheie) >= 97901 && Number(p.cheie) <= 97905));
  q(`INSERT INTO produse (id, cod, denumire) VALUES
       (${P_JUMBO}, 'TCS-J23', 'TCS Stretch jumbo 23my'),
       (${P_GUM}, 'TCS-GUM', 'TCS Bandă adezivă jumbo'),
       (${P_MANUAL}, 'TCS-M2', 'TCS Folie stretch manuală 2kg'),
       (${P_STRECH}, 'TCS-J17', 'TCS Strech jumbo 17my'),
       (${P_FARA}, 'TCS-JF', 'TCS stretch JUMBO fără preț')`);
  // P_JUMBO: un palet cu trei linii (500 kg × 9, 300 kg × 11, 200 kg fără
  // preț), unul vechi fără linii (100 kg × 10), unul ieșit (1000 kg × 1, nu
  // intră) și 3 bucăți × 500 lei (altă unitate, nu intră în kg).
  q(`INSERT INTO ct_paleti (id, cod, produs_id, produs_text, cantitate, um, data_intrare, data_iesire, pret_unitar) VALUES
       (97911, 'TCS-PAL-1', ${P_JUMBO}, NULL, 1000, 'kg', '2026-11-01', NULL, NULL),
       (97912, 'TCS-PAL-2', ${P_JUMBO}, NULL, 100, 'kg', '2026-11-01', NULL, 10),
       (97913, 'TCS-PAL-3', ${P_JUMBO}, NULL, 1000, 'kg', '2026-10-01', '2026-11-02', 1),
       (97914, 'TCS-PAL-4', ${P_GUM}, NULL, 400, 'kg', '2026-11-01', NULL, 3),
       (97915, 'TCS-PAL-5', ${P_MANUAL}, NULL, 100, 'kg', '2026-11-01', NULL, 12),
       (97916, 'TCS-PAL-6', ${P_STRECH}, NULL, 100, 'kg', '2026-11-03', NULL, 8),
       (97917, 'TCS-PAL-7', ${P_FARA}, NULL, 300, '', '2026-11-03', NULL, NULL),
       (97918, 'TCS-PAL-8', ${P_JUMBO}, NULL, 3, 'Buc.', '2026-11-03', NULL, 500)`);
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um, pret_unitar) VALUES
       (97911, ${P_JUMBO}, 500, 'kg', 9), (97911, ${P_JUMBO}, 300, 'kg', 11), (97911, ${P_JUMBO}, 200, 'kg', NULL),
       (97913, ${P_JUMBO}, 1000, 'kg', 1),
       (97914, ${P_GUM}, 400, 'kg', 3),
       (97915, ${P_MANUAL}, 100, 'kg', 12),
       (97916, ${P_STRECH}, 100, 'kg', 8),
       (97917, ${P_FARA}, 300, NULL, NULL),
       (97918, ${P_JUMBO}, 3, 'Buc.', 500)`);
  // P_STRECH: 250 kg primite într-o recepție finalizată, din care 100 kg au
  // ajuns pe raft (paletul 97916) → încă 150 kg fără raft, tot la 8 lei.
  // Un al doilea rând, scos din „Gata din producție", nu mai e în depozit.
  q(`INSERT INTO receptii (id, numar, sursa, stare, finalizata_la) VALUES (${REC}, 'TCS-REC-1', 'furnizor', 'finalizata', '2026-11-03 10:00:00')`);
  q(`INSERT INTO receptii_linii (id, receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, pret_unitar, stare, conditie, ct_inchis_la) VALUES
       (${RL}, ${REC}, ${P_STRECH}, 250, 250, 'kg', 8, 'primita', 'bun', NULL),
       (${RL_INCHIS}, ${REC}, ${P_STRECH}, 70, 70, 'kg', 8, 'primita', 'bun', '2026-11-04 09:00:00')`);
  q(`UPDATE ct_paleti SET receptie_id = ${REC}, receptie_linie_id = ${RL} WHERE id = 97916`);

  const stoc = await CS.jumboDinStoc();
  const al = (id) => stoc.produse.find((p) => p.cheie === String(id));
  const j = al(P_JUMBO), s = al(P_STRECH), f = al(P_FARA);
  bine("banda adezivă jumbo nu e în listă", !al(P_GUM));
  bine("stretch-ul care nu e jumbo nu e în listă", !al(P_MANUAL));
  bine("„strech” scris greșit intră", Boolean(s));
  aprox("jumbo 23my: 1100 kg (palet cu linii + palet vechi; nu cel ieșit, nu bucățile)", j && j.kg, 1100);
  aprox("jumbo 23my: 900 kg cu preț", j && j.kgCuPret, 900);
  aprox("jumbo 23my: media ponderată (4500 + 3300 + 1000) ÷ 900", j && j.pret, 8800 / 900);
  egal("jumbo 23my: bucățile se spun, nu se adună", j && j.alteUm, { buc: 3 });
  aprox("strech 17my: 100 kg pe raft + 150 kg din recepție fără raft (nu și rândul scos)", s && s.kg, 250);
  aprox("strech 17my: 8 lei/kg", s && s.pret, 8);
  aprox("jumbo fără preț: 300 kg (unitatea goală = kg)", f && f.kg, 300);
  egal("jumbo fără preț: preț 0", f && f.pret, 0);
  const kgInainte = inainte.medie.kgCuPret, valInainte = inainte.medie.pret * inainte.medie.kgCuPret;
  aprox("media stocului: ponderată cu kilogramele cu preț", stoc.medie.pret, (valInainte + 8800 + 2000) / (kgInainte + 900 + 250));

  // ------------------------------------------------------------------------
  console.log("\n5. Pagina");
  bine("e în lista de calculatoare, lângă celelalte", /<option value="\/calculator\/stretch" selected>Role stretch — cost din jumbo<\/option>/.test(selectorCalculator("/calculator/stretch")));
  bine("lista are în continuare și cutiile", /\/calculator\/cutii/.test(selectorCalculator("/calculator/stretch")));
  const fara = await cer("get", "/calculator/stretch", null);
  egal("fără utilizator: la login", unde(fara), "/login");

  if (!unul("SELECT 1 FROM cursuri_bnr WHERE data = ? AND moneda = 'EUR'", [ZI_CURS])) {
    q("INSERT INTO cursuri_bnr (data, moneda, valoare) VALUES (?, 'EUR', 5.0912)", [ZI_CURS]);
    cursCreat = true;
  }
  const curs = Number(unul("SELECT valoare FROM cursuri_bnr WHERE moneda = 'EUR' ORDER BY data DESC LIMIT 1"));
  const implicit = await cer("get", "/calculator/stretch", VANZARI);
  egal("se deschide pentru vânzări", implicit.cod, 200);
  const h0 = implicit.corp;
  bine("titlul", /Calculator cost rolă stretch/.test(h0));
  bine("cursul implicit e cel mai nou de la BNR", h0.includes(`name="curs" inputmode="decimal" value="${String(curs).replace(".", ",")}"`), (h0.match(/name="curs"[^>]*>/) || [""])[0]);
  bine("lista de jumbo din stoc are produsele de test, nu și banda", h0.includes(`<option value="${P_JUMBO}">`) && h0.includes(`<option value="${P_STRECH}">`) && !h0.includes(`<option value="${P_GUM}">`));
  bine("în listă: bucățile se spun ca nesocotite", /TCS Stretch jumbo 23my \(TCS-J23\) — 1\.100 kg · 9,78 lei\/kg · plus 3 buc, nesocotite/.test(h0), (h0.match(/TCS Stretch jumbo 23my[^<]*/) || [""])[0]);
  bine("vânzări: parametrii nu se pot schimba", !/Salvează parametrii/.test(h0) && /Parametrii îi schimbă un administrator/.test(h0));

  const qExcel = { kg: "14,4", grosime: "23", latime: "500", core: "automat", masina: "prestretch", sursa: "manual", pret_eur: "1,69", curs: "5,35", jumbo_teoretic: "50", jumbo_util: "48,4", alte: "0", adaos: "0", role: "1", intregi: "NU" };
  const h1 = (await cer("get", "/calculator/stretch", ADMIN, { query: qExcel })).corp;
  bine("cost pe rolă: 143,49 lei", /COST TOTAL PE ROLĂ 143,49 lei 26,82 EUR/.test(rand(h1, "COST TOTAL PE ROLĂ")), rand(h1, "COST TOTAL PE ROLĂ"));
  bine("material pe rolă: 134,50 lei", /134,50 lei/.test(rand(h1, "Material pe rolă")), rand(h1, "Material pe rolă"));
  bine("productivitate: 13,01 role/oră", /13,01 role\/oră/.test(rand(h1, "Productivitate")), rand(h1, "Productivitate"));
  bine("timp ciclu: 276,7 s", /276,7 s\/rolă/.test(rand(h1, "Timp ciclu")), rand(h1, "Timp ciclu"));
  bine("lungime: 1.361,1 m", /1\.361,1 m/.test(rand(h1, "Lungime folie pe rolă")), rand(h1, "Lungime folie pe rolă"));
  bine("pierdere jumbo: 3,31%", /3,31%/.test(rand(h1, "Pierdere jumbo")), rand(h1, "Pierdere jumbo"));
  bine("verificarea mașinii: OK", /badge verde">OK/.test(h1));
  bine("administratorul vede câmpurile parametrilor", /name="p_salariu"/.test(h1) && /Salvează parametrii/.test(h1));

  const hMedie = (await cer("get", "/calculator/stretch", ADMIN, { query: Object.assign({}, qExcel, { sursa: "medie" }) })).corp;
  const pm = stoc.medie.pret.toLocaleString("ro-RO", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  bine(`media stocului folosită: ${pm} lei/kg`, rand(hMedie, "Preț stretch folosit").includes(pm + " lei/kg"), rand(hMedie, "Preț stretch folosit"));
  const hProdus = (await cer("get", "/calculator/stretch", ADMIN, { query: Object.assign({}, qExcel, { sursa: "produs", produs_id: String(P_STRECH) }) })).corp;
  bine("jumbo ales: 8,0000 lei/kg", rand(hProdus, "Preț stretch folosit").includes("8,0000 lei/kg"), rand(hProdus, "Preț stretch folosit"));
  bine("jumbo ales: rămâne selectat", hProdus.includes(`<option value="${P_STRECH}" selected>`));
  const hFara = (await cer("get", "/calculator/stretch", ADMIN, { query: Object.assign({}, qExcel, { sursa: "produs", produs_id: String(P_FARA) }) })).corp;
  bine("jumbo fără preț: avertisment, nu un cost fals", /Prețul jumbo nu se poate lua din stoc/.test(hFara));
  const hNormala = (await cer("get", "/calculator/stretch", ADMIN, { query: Object.assign({}, qExcel, { masina: "normala" }) })).corp;
  bine("mașina normală cu core automat: avertisment", /flash flash-rosu[^>]*>ATENȚIE: mașina normală face doar role manuale simple/.test(hNormala));
  const hRau = (await cer("get", "/calculator/stretch", ADMIN, { query: { kg: "abc", grosime: "-5", core: "nu-exista", masina: "x", sursa: "y" } })).corp;
  bine("intrări greșite: rămân valorile din foaie", hRau.includes('name="kg" inputmode="decimal" value="14,4"') && hRau.includes('name="grosime" inputmode="decimal" value="23"') && /<option value="automat" selected>/.test(hRau));

  // ------------------------------------------------------------------------
  console.log("\n6. Parametrii: doar administratorul, valorile greșite nu strică");
  const rv = await cer("post", "/calculator/stretch/asumptii", VANZARI, { body: { p_salariu: "1" } });
  egal("vânzări: trimis înapoi", unde(rv), "/calculator/stretch");
  egal("vânzări: nu s-a salvat nimic", unul("SELECT count(*) FROM setari_app WHERE cheie = ?", [CHEIE]), "0");
  const ra = await cer("post", "/calculator/stretch/asumptii", ADMIN, {
    body: { p_salariu: "8000", p_contributii: "2,25", p_ore_luna: "abc", p_operatori: "-1", p_energie: "1,2", c_automat_pret: "5,5", m_prestretch_viteza: "900" },
  });
  egal("administrator: înapoi la parametri", unde(ra), "/calculator/stretch?salvat=1#parametri");
  const salvat = JSON.parse(unul("SELECT valoare FROM setari_app WHERE cheie = ?", [CHEIE]) || "{}");
  egal("salariu 8000, contribuții 2,25, energie 1,2", [salvat.parametri.salariu, salvat.parametri.contributii, salvat.parametri.energie], [8000, 2.25, 1.2]);
  egal("„abc” și „-1” păstrează ce era (160 ore, 1 operator)", [salvat.parametri.ore_luna, salvat.parametri.operatori], [160, 1]);
  egal("core automat 5,5 lei, mașina de prestretch 900 m/min", [salvat.core.find((c) => c.cheie === "automat").pret, salvat.masini.find((m) => m.cheie === "prestretch").viteza], [5.5, 900]);
  egal("se știe cine i-a schimbat", salvat.de, "Vali Test");
  const a = await CS.citesteAsumptii();
  const asteptat = SC.calculeaza(SC.INTRARI, a.parametri, a.core.find((c) => c.cheie === "automat"), a.masini.find((m) => m.cheie === "prestretch"), pretExcel);
  const h2 = (await cer("get", "/calculator/stretch", ADMIN, { query: Object.assign({ salvat: "1" }, qExcel) })).corp;
  const costNou = asteptat.costRola.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  bine(`pagina calculează cu parametrii noi: ${costNou} lei pe rolă`, rand(h2, "COST TOTAL PE ROLĂ").includes(costNou + " lei"), rand(h2, "COST TOTAL PE ROLĂ"));
  aprox("manopera nouă = 8000 × 1,0225 ÷ 160 ÷ role pe oră", asteptat.manopera, ((8000 * 1.0225) / 160) / asteptat.rolePeOra);
  bine("după salvare: mesajul și cine a schimbat", /Parametrii s-au salvat/.test(h2) && /de Vali Test/.test(h2));
  const ra2 = await cer("post", "/calculator/stretch/asumptii", ADMIN, { body: { p_manipulare: "120" } });
  egal("a doua salvare: înapoi la parametri", unde(ra2), "/calculator/stretch?salvat=1#parametri");
  const salvat2 = JSON.parse(unul("SELECT valoare FROM setari_app WHERE cheie = ?", [CHEIE]) || "{}");
  egal("a doua salvare: doar manipularea s-a schimbat, restul a rămas", [salvat2.parametri.manipulare, salvat2.parametri.salariu, salvat2.core.find((c) => c.cheie === "automat").pret], [120, 8000, 5.5]);
}
