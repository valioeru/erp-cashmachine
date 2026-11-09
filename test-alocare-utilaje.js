"use strict";
// Alocarea în producție arată TOATE utilajele, fără sugestii.
//
// Vali, 09.11.2026, cu poza alocării comenzii 20261109-020 („Folie manuala
// 12my rigid, 1,9 kg CM"): „Aici nu sugera utilaje, lasă-le pe toate, să
// aleagă operatorul." Derulanta era tăiată după fluxul comenzii, iar fluxul
// ghicit după denumire („folie" → Folie debitată) lăsase doar Extruderul și
// Slitterul — tocmai mașinile pe care comanda nu merge.
//
// Ce se verifică:
//   1. pagina arată toate utilajele active (și pe cele din afara fluxului),
//      fără cele scoase din uz, cu nimic preselectat și fără textul de flux;
//   2. orele estimate apar doar lângă utilajul cu capacitate scrisă, iar
//      câmpul „Ore" pornește de la un schimb (8), nu de la estimarea altuia;
//   3. alocarea pe un utilaj din afara fluxului trece; oamenii fără
//      competență pe el nu intră; utilajul scos din uz e refuzat;
//   4. ghicitul fluxului pentru fișa de lot: „Folie manuală" e stretch manual,
//      „Folie automată" e stretch automat, restul foliei rămâne debitată;
//   5. în browser: orele urmează utilajul ales, dar nu peste ce a scris omul.
//
// Pe baza Postgres locală (port 5433), cu paginile adevărate, plus Chromium.
const fs = require("fs");
const path = require("path");
const qs = require("querystring");
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
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length || (/^\s*UPDATE/i.test(sql) ? 1 : 0) };
  },
});
const { fluxulComenzii } = require(path.join(RAD, "lib", "flux-comanda.js"));

const rute = { get: {}, post: {} };
const reg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; } };
require(path.join(RAD, "modules", "utilaje.js")).register(reg);

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { query, body } = {}) {
  const r = res();
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
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase() } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
function egal(descriere, a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  bine(descriere + " = " + y, x === y, x);
}

const ADMIN = { id: 1, nume: "Vali Test", rol: "admin", sectiuni: "" };

// ---- datele de test ------------------------------------------------------
const U_EXT = 98961, U_SLIT = 98962, U_STRETCH = 98963, U_VECHI = 98964, U_STANDBY = 98965;
const CMD = 98971, CMD2 = 98972;
const OM_STRETCH = 98981, OM_EXT = 98982;
const ZI = "2026-11-11";
const FLUX_TEST = "F-TAU-TEST";
// Fluxurile pe care le caută ghicitul; se creează doar dacă baza nu le are
// și se șterg la final doar cele create aici.
const FLUXURI_GHICIT = [["F-STRETCH-MAN", "Stretch manual"], ["F-STRETCH-AUT", "Stretch automat"], ["F-STRETCH-PRE", "Prestretch"], ["F-FOLIE-DEBITATA", "Folie debitată"]];
const fluxuriCreate = [];

function curata() {
  q(`DELETE FROM alocari_resurse WHERE alocare_id IN (SELECT id FROM alocari_productie WHERE comanda_productie_id = ${CMD})`);
  q(`DELETE FROM alocari_productie WHERE comanda_productie_id IN (${CMD}, ${CMD2})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${CMD}, ${CMD2})`);
  q(`DELETE FROM resurse_program WHERE resursa_id IN (${OM_STRETCH}, ${OM_EXT})`);
  q(`DELETE FROM resurse_competente WHERE resursa_id IN (${OM_STRETCH}, ${OM_EXT})`);
  q(`DELETE FROM resurse WHERE id IN (${OM_STRETCH}, ${OM_EXT})`);
  q(`DELETE FROM utilaje_capacitate WHERE utilaj_id BETWEEN 98961 AND 98965`);
  q(`DELETE FROM fluxuri_pasi WHERE flux_id IN (SELECT id FROM fluxuri WHERE cod = '${FLUX_TEST}')`);
  q(`DELETE FROM fluxuri WHERE cod = '${FLUX_TEST}'`);
  q(`DELETE FROM utilaje WHERE id BETWEEN 98961 AND 98965`);
}
function curataGhicit() {
  for (const cod of fluxuriCreate) q("DELETE FROM fluxuri WHERE cod = ?", [cod]);
}

(async () => {
  curata();
  q(`INSERT INTO utilaje (id, cod, denumire, activ, status_date) VALUES
       (${U_EXT}, 'TAU-01', 'TAU Extruder', 1, 'COMPLET'),
       (${U_SLIT}, 'TAU-02', 'TAU Slitter', 1, 'COMPLET'),
       (${U_STRETCH}, 'TAU-15', 'TAU Stretch manual', 1, 'COMPLET'),
       (${U_VECHI}, 'TAU-99', 'TAU Mașină veche', 0, 'COMPLET'),
       (${U_STANDBY}, 'TAU-14', 'TAU Etichete', 1, 'STANDBY')`);
  // Doar mașina de stretch are capacitate scrisă: 80 role/oră, plus o jumătate
  // de oră de reglaj → 720 role = 9,5 h.
  q(`INSERT INTO utilaje_capacitate (utilaj_id, produs_text, cantitate_ora, timp_pregatire) VALUES (${U_STRETCH}, 'TAU Folie manuala 12my', 80, 0.5)`);
  // Fluxul comenzii trece doar prin extruder și slitter — ca în poza lui Vali.
  const flux = Number(unul(`INSERT INTO fluxuri (cod, denumire, activ) VALUES ('${FLUX_TEST}', 'TAU Folie debitată', 1) RETURNING id`));
  q(`INSERT INTO fluxuri_pasi (flux_id, pas_nr, utilaj_cod, operatie) VALUES (${flux}, 1, 'TAU-01', 'Extrudare'), (${flux}, 2, 'TAU-02', 'Debitare/rebobinare')`);
  q(`INSERT INTO comenzi_productie (id, numar, tip_produs, cantitate, um, status, flux_id, client_text)
       VALUES (${CMD}, 'TAU-20261109-020', 'TAU Folie manuala 12my', '720', 'buc', 'noua', ${flux}, 'TAU Client'),
              (${CMD2}, 'TAU-20261109-021', 'TAU Folie manuala 12my', 'cât iese din jumbo', 'buc', 'noua', NULL, 'TAU Client')`);
  q(`INSERT INTO resurse (id, nume, activ) VALUES (${OM_STRETCH}, 'TAU Om Stretch', 1), (${OM_EXT}, 'TAU Om Extruder', 1)`);
  q(`INSERT INTO resurse_competente (resursa_id, utilaj_id, nivel) VALUES (${OM_STRETCH}, ${U_STRETCH}, 2), (${OM_EXT}, ${U_EXT}, 2)`);
  q(`INSERT INTO resurse_program (resursa_id, data, schimb) VALUES (${OM_STRETCH}, '${ZI}', 'S1'), (${OM_EXT}, '${ZI}', 'S1')`);

  // ------------------------------------------------------------------------
  console.log("1. Pagina de alocare: toate utilajele active, nimic preselectat");
  const pag = await cer("get", `/productie/aloca/${CMD}`, ADMIN);
  egal("pagina se deschide", pag.cod, 200);
  const html = pag.corp;
  const select = (html.match(/<select name="utilaj_id"[\s\S]*?<\/select>/) || [""])[0];
  const optiuni = [...select.matchAll(/<option value="(\d*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ id: m[1], atr: m[2], text: m[3] }));
  const ids = optiuni.map((o) => o.id);
  bine("apare și utilajul din afara fluxului (stretch manual)", ids.includes(String(U_STRETCH)), ids);
  bine("apar și utilajele din flux (extruder, slitter)", ids.includes(String(U_EXT)) && ids.includes(String(U_SLIT)), ids);
  bine("apare și utilajul în standby, marcat", ids.includes(String(U_STANDBY)) && /în standby/.test(optiuni.find((o) => o.id === String(U_STANDBY)).text), JSON.stringify(optiuni));
  bine("utilajul scos din uz nu apare", !ids.includes(String(U_VECHI)), ids);
  const selectate = optiuni.filter((o) => /\bselected\b/.test(o.atr)).map((o) => o.id);
  egal("preselectat e doar „— alege —”", selectate, [""]);
  const ext = optiuni.find((o) => o.id === String(U_STRETCH));
  bine("lângă utilajul cu capacitate: orele estimate (720 / 80 + 0,5 reglaj = 9,5 h)", ext && /data-ore="9.5"/.test(ext.atr) && /~9,5 h/.test(ext.text), ext && ext.atr + " " + ext.text);
  const faraCap = optiuni.find((o) => o.id === String(U_EXT));
  bine("lângă utilajul fără capacitate: fără ore", faraCap && /data-ore=""/.test(faraCap.atr) && !/~\d/.test(faraCap.text), faraCap && faraCap.atr + " " + faraCap.text);
  bine("eticheta are și codul utilajului", ext && /TAU Stretch manual \(TAU-15\)/.test(ext.text), ext && ext.text);
  bine("„Ore” pornește de la un schimb (8), nu de la estimarea unui utilaj neales", /<input type="number" name="ore" id="alocOre"[^>]*value="8"/.test(html));
  bine("fără textul de flux și fără lista de sugestii",
    !/Restul mașinilor din hală|Utilajele de mai jos sunt cele din fluxul|Utilajele care pot face comanda|n-are flux tehnologic/.test(html));
  bine("pagina spune că apar toate utilajele", /Apar toate utilajele active din hală/.test(html));
  // Cantitate care nu se poate citi ca număr: capacitatea există, dar nu se
  // estimează nimic — doar reglajul nu e o estimare a comenzii.
  const html2 = (await cer("get", `/productie/aloca/${CMD2}`, ADMIN)).corp;
  const opt2 = (html2.match(new RegExp(`<option value="${U_STRETCH}"[^>]*>[^<]*</option>`)) || [""])[0];
  bine("cantitate necitibilă: fără ore estimate lângă utilaj", /data-ore=""/.test(opt2) && !/~\d/.test(opt2), opt2);

  // ------------------------------------------------------------------------
  console.log("\n2. Alocarea: utilajul ales de om trece, chiar dacă nu e în flux");
  const r1 = await cer("post", `/productie/aloca/${CMD}`, ADMIN, {
    body: { utilaj_id: String(U_STRETCH), data: ZI, ora_start: "8", ore: "9", cantitate: "720", [`resursa_${OM_STRETCH}`]: "1", [`resursa_${OM_EXT}`]: "1" },
  });
  egal("trimite la planificare", [r1.cod, r1.antet.Location], [302, `/productie/planificare?de_la=${ZI}`]);
  const aloc = q(`SELECT id, utilaj_id, ore, cantitate FROM alocari_productie WHERE comanda_productie_id = ${CMD}`);
  egal("alocarea e pe stretch manual, 9 h, 720", aloc.map((a) => [Number(a.utilaj_id), Number(a.ore), Number(a.cantitate)]), [[U_STRETCH, 9, 720]]);
  const oameni = aloc.length ? q(`SELECT resursa_id FROM alocari_resurse WHERE alocare_id = ${aloc[0].id} ORDER BY resursa_id`).map((x) => Number(x.resursa_id)) : [];
  egal("intră doar omul care știe mașina (cel de pe extruder nu)", oameni, [OM_STRETCH]);
  egal("comanda trece în producție", unul(`SELECT status FROM comenzi_productie WHERE id = ${CMD}`), "in_productie");

  const r2 = await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U_EXT), data: ZI, ora_start: "14", ore: "4" } });
  egal("și pe un utilaj din flux merge la fel", r2.cod, 302);

  const r3 = await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: String(U_VECHI), data: ZI, ora_start: "8", ore: "2" } });
  bine("utilajul scos din uz e refuzat, cu motiv", r3.cod === 400 && /Utilajul nu mai e activ/.test(r3.corp) && /TAU-99 · TAU Mașină veche/.test(r3.corp), r3.cod);
  egal("…și nu se scrie nimic pe el", Number(unul(`SELECT COUNT(*) FROM alocari_productie WHERE comanda_productie_id = ${CMD} AND utilaj_id = ${U_VECHI}`)), 0);
  const r4 = await cer("post", `/productie/aloca/${CMD}`, ADMIN, { body: { utilaj_id: "98969", data: ZI, ora_start: "8", ore: "2" } });
  bine("utilaj inexistent: refuzat", r4.cod === 400 && /nu mai există/.test(r4.corp), r4.cod);

  // ------------------------------------------------------------------------
  console.log("\n3. Fluxul ghicit pentru fișa de lot");
  for (const [cod, den] of FLUXURI_GHICIT) {
    if (!unul("SELECT id FROM fluxuri WHERE cod = ?", [cod])) {
      q("INSERT INTO fluxuri (cod, denumire, activ) VALUES (?, ?, 1)", [cod, den]);
      fluxuriCreate.push(cod);
    }
  }
  const ghicit = async (text) => {
    const f = await fluxulComenzii({ tip_produs: text }, []);
    return [f.flux ? f.flux.cod : null, f.cum];
  };
  egal("„Folie manuala 12my rigid,1,9 kg CM” → stretch manual", await ghicit("Folie manuala 12my rigid,1,9 kg CM"), ["F-STRETCH-MAN", "guessed from name"]);
  egal("„Folie automata 23my 17 kg” → stretch automat", await ghicit("Folie automata 23my 17 kg"), ["F-STRETCH-AUT", "guessed from name"]);
  egal("„Folie stretch manuala 2 kg” → stretch manual (ca înainte)", await ghicit("Folie stretch manuala 2 kg"), ["F-STRETCH-MAN", "guessed from name"]);
  egal("„Rola prestretch 500 mm” → prestretch (ca înainte)", await ghicit("Rola prestretch 500 mm"), ["F-STRETCH-PRE", "guessed from name"]);
  egal("„Folie LDPE 50my 1000 mm” → folie debitată (ca înainte)", await ghicit("Folie LDPE 50my 1000 mm"), ["F-FOLIE-DEBITATA", "guessed from name"]);
  curataGhicit();

  // ------------------------------------------------------------------------
  console.log("\n4. În browser: orele urmează utilajul, dar nu peste ce scrie omul");
  // Pagina se reîncarcă după alocările de mai sus; contează doar formularul.
  const pagina2 = (await cer("get", `/productie/aloca/${CMD}`, ADMIN)).corp;
  const { chromium } = require("playwright");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const browser = await chromium.launch();
  const erori = [];
  try {
    const p = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    p.on("pageerror", (e) => erori.push(e.message));
    await p.route("http://erp.test/**", async (rt) => {
      const u = new URL(rt.request().url());
      if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      if (u.pathname === `/productie/aloca/${CMD}`) return rt.fulfill({ status: 200, contentType: "text/html", body: pagina2 });
      return rt.fulfill({ status: 204, body: "" });
    });
    await p.goto(`http://erp.test/productie/aloca/${CMD}`);
    await p.fill('input[name="data"]', ZI);
    await p.dispatchEvent('input[name="data"]', "change");
    egal("la început: niciun utilaj ales, 8 ore", [await p.inputValue("#alocUtilaj"), await p.inputValue("#alocOre")], ["", "8"]);
    await p.selectOption("#alocUtilaj", String(U_STRETCH));
    egal("aleg stretch manual: orele estimate (9,5)", await p.inputValue("#alocOre"), "9.5");
    bine("…și apare omul care îl știe și e în tură", await p.isVisible(`.om-optiune[data-resursa="${OM_STRETCH}"]`) && !(await p.isVisible(`.om-optiune[data-resursa="${OM_EXT}"]`)));
    await p.selectOption("#alocUtilaj", String(U_SLIT));
    egal("trec pe slitter (fără estimare): orele revin la 8, nu rămân 9,5", await p.inputValue("#alocOre"), "8");
    await p.fill("#alocOre", "5");
    await p.selectOption("#alocUtilaj", String(U_EXT));
    egal("orele scrise de mână rămân când trec pe alt utilaj fără estimare", await p.inputValue("#alocOre"), "5");
    await p.selectOption("#alocUtilaj", String(U_STRETCH));
    egal("pe un utilaj cu estimare, estimarea se pune din nou", await p.inputValue("#alocOre"), "9.5");
    const n = await p.$$eval("#alocUtilaj option", (o) => o.length);
    bine("derulanta are toate utilajele active (+ „— alege —”)", n >= 5, n);
    if (process.env.POZA) await p.screenshot({ path: process.env.POZA, fullPage: true });
  } finally {
    await browser.close();
  }
  egal("nicio eroare de JavaScript", erori, []);

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); curataGhicit(); } catch (_) {}
  process.exit(1);
});
