"use strict";
// Prezentarea mărfii la recepție și drumul ei până la raft.
//
// CE A CERUT VALI, 13.11.2026:
//   „La recepție marfă să se scrie și prezentarea mărfii, nr. de paleți și buc.
//    pe paleți, iar apoi marfa să aștepte alocarea pe rafturi în depozit ca și
//    marfa venită din producție, în aceeași listă."
//
// CE APĂRĂ:
//   • PREZENTAREA (lib/prezentare.js): N paleți a câte Q, ultimul poate fi mai
//     gol; nu trece dacă nu încape sau dacă un palet ar rămâne gol.
//   • RECEPȚIA DIN PROCUREMENT: fără prezentare (sau cu una greșită) nu se
//     salvează nimic, nici pe comandă. Cu ea, cantitatea se scrie pe comandă
//     și ce a venit acum intră în depozit: o recepție legată de comandă,
//     finalizată, cu prețul în lei și cu prezentarea; stocul crește o dată.
//     A doua recepție trimite doar ce e în plus; o scădere nu trimite nimic.
//   • LISTA „DE ALOCAT PE RAFT": rândul de la furnizor e acolo, cu „a venit:
//     3 paleți…", cu comanda la furnizor și cu căsuța „Fă paleții și
//     etichetele" completată din prezentare.
//   • „FĂ PALEȚII ȘI ETICHETELE": toți paleții odată, fără loc, cu prețul din
//     recepție; rândul iese din listă, paleții apar „fără loc pe raft".
//     Fără preț cere prețul; textul greșit e refuzat.
//   • „TRIMITE ÎN DEPOZIT": comenzile primite înainte, cât n-a intrat încă,
//     cu paleții intrați de mână care seamănă; nu trimite mai mult decât a
//     rămas, nici fără prezentare, nici de două ori. Nu apare la comenzile
//     recepționate înainte de 13.11.2026.
//   • RECEPȚIA DIN DEPOZIT: prezentarea e obligatorie la marfa bună de la
//     furnizor, nu și la producție; se vede pe pagină și propune paleții.
//   • Cine n-are dreptul nu recepționează și nu trimite nimic.
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
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); }, trimiteDeLa: async () => { throw new Error("test: fără email"); } };
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

// Coloanele noi (lib/db.js, ALTERARI), ca testul să meargă și pe o bază
// pornită înaintea lor.
q(`ALTER TABLE receptii_linii ADD COLUMN IF NOT EXISTS paleti_nr INTEGER;
   ALTER TABLE receptii_linii ADD COLUMN IF NOT EXISTS paleti_pe DOUBLE PRECISION;
   ALTER TABLE receptii ADD COLUMN IF NOT EXISTS comanda_furnizor_id INTEGER;
   ALTER TABLE receptii_linii ADD COLUMN IF NOT EXISTS comanda_furnizor_linie_id INTEGER;`);

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
// În ordinea din server.js.
for (const m of ["gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie", "comenzi-furnizor"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const PZ = require(path.join(RAD, "lib", "prezentare.js"));
const SC = require(path.join(RAD, "lib", "ct-scaner.js"));
const GPM = require(path.join(RAD, "modules", "gata-productie.js"));
const REC = require(path.join(RAD, "modules", "receptie.js"));

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
const P1 = 96201, P2 = 96202, P3 = 96203, P4 = 96204;
const FURNIZOR = 96211;
const PREFIX = "TRP";
const PRODUSE = [P1, P2, P3, P4];

function curata() {
  const pr = PRODUSE.join(",");
  const cf = q(`SELECT id FROM comenzi_furnizor WHERE numar LIKE '${PREFIX}-%' OR furnizor_id = ${FURNIZOR}`).map((x) => Number(x.id));
  const c = cf.join(",") || "0";
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-%' OR comanda_furnizor_id IN (${c}) OR partener_id = ${FURNIZOR}`).map((x) => Number(x.id));
  const r = rec.join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE receptie_id IN (${r}) OR produs_id IN (${pr}) OR produs_text LIKE '${PREFIX} %'`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM stoc_locuri WHERE receptie_id IN (${r}) OR produs_id IN (${pr})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${r}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii WHERE id IN (${r})`);
  q(`DELETE FROM comenzi_furnizor_istoric WHERE comanda_id IN (${c})`);
  q(`DELETE FROM comenzi_furnizor_linii WHERE comanda_id IN (${c})`);
  q(`DELETE FROM comenzi_furnizor WHERE id IN (${c})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM interactiuni WHERE partener_id = ${FURNIZOR}`);
  q(`DELETE FROM parteneri WHERE id = ${FURNIZOR}`);
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
function comanda(numar, { moneda = "RON", curs = null, status = "trimisa", data = "2026-11-10", dataReceptie = null } = {}) {
  return Number(unul(`INSERT INTO comenzi_furnizor (numar, furnizor_id, data, data_receptie, status, moneda, curs)
     VALUES ('${PREFIX}-${numar}', ${FURNIZOR}, '${data}', ${dataReceptie ? "'" + dataReceptie + "'" : "NULL"}, '${status}', '${moneda}', ${curs == null ? "NULL" : curs}) RETURNING id`));
}
function linieCf(cid, produs, denumire, cant, um, pret, primit) {
  return Number(unul(`INSERT INTO comenzi_furnizor_linii (comanda_id, produs_id, denumire, cantitate, um, pret_unitar, cantitate_primita)
     VALUES (${cid}, ${produs || "NULL"}, '${denumire}', ${cant}, '${um}', ${pret == null ? "NULL" : pret}, ${primit || 0}) RETURNING id`));
}
const receptiiCf = (cid) => q(`SELECT * FROM receptii WHERE comanda_furnizor_id = ${cid} ORDER BY id`);
const liniiRec = (rid) => q(`SELECT * FROM receptii_linii WHERE receptie_id = ${rid} ORDER BY id`);
const sectiunea = (html) => { const i = html.indexOf('id="gata-productie"'); return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i)); };
const randul = (html, lid) => { const i = html.indexOf(`/gata/receptie/${lid}/raft`); if (i < 0) return ""; const a = html.lastIndexOf("<tr>", i); return html.slice(a, html.indexOf("</tr>", i)); };
const bucata = (html, id, pana) => { const i = html.indexOf(`id="${id}"`); if (i < 0) return ""; const j = pana ? html.indexOf(pana, i) : -1; return html.slice(i, j > i ? j : html.length); };

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: "Om Depozit", rol: "depozit", sectiuni: "" };
  const AGENT = { id: idUser, nume: "Agent", rol: "vanzari", sectiuni: "/crm" };

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor Folie SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (${P1}, 'TRP-1', '${PREFIX} Jumbo Virgin Transparent', 'kg'), (${P2}, 'TRP-2', '${PREFIX} Banda Fragil', 'buc'), (${P3}, 'TRP-3', '${PREFIX} Granula', 'kg'),
       (${P4}, 'TRP-4', '${PREFIX} Folie din productie', 'buc')`);

  // ------------------------------------------------------------------------
  console.log("1. Prezentarea");
  egal("1.000 pe 3 paleți de 400: 400 + 400 + 200", PZ.citeste("3", "400", 1000).cantitati, [400, 400, 200]);
  egal("…sau toți plini", PZ.citeste("3", "400", 1200).cantitati, [400, 400, 400]);
  egal("un singur palet, mai gol", PZ.citeste("1", "500", 200).cantitati, [200]);
  egal("virgula e zecimală", PZ.citeste("2", "12,5", 20).cantitati, [12.5, 7.5]);
  bine("nu încape → spune cât încape", /încap 1\.200, dar s-au primit 1\.300/.test(PZ.citeste("3", "400", 1300).eroare || ""), PZ.citeste("3", "400", 1300).eroare);
  bine("un palet ar rămâne gol → spune", /al 3-lea palet ar rămâne gol/.test(PZ.citeste("3", "400", 800).eroare || ""), PZ.citeste("3", "400", 800).eroare);
  bine("doar unul din două scris → cere amândouă", /amândouă/.test(PZ.citeste("2", "", 5).eroare || ""));
  bine("paleți cu zecimale, zero pe palet, prea mulți paleți: refuzate", PZ.citeste("2,5", "400", 900).eroare && PZ.citeste("1", "0", 5).eroare && PZ.citeste(String(PZ.MAX_PALETI + 1), "1", PZ.MAX_PALETI + 1).eroare);
  egal("…zero pe palet, spus pe nume", PZ.citeste("1", "0", 5).eroare, "Cât e pe un palet trebuie să fie mai mult ca zero.");
  egal("nimic scris = gol, nu eroare", PZ.citeste("", " ", 5), { gol: true });
  bine("…dar la zero primit nu se scrie prezentare", /doar pentru marfa primită/.test(PZ.citeste("1", "5", 0).eroare || ""));
  egal("prezentarea salvată care nu se mai potrivește cu cantitatea nu se folosește", [PZ.dinRand({ paleti_nr: 3, paleti_pe: 400 }, 700), PZ.dinRand({ paleti_nr: 3, paleti_pe: 400 }, 1000).cantitati], [null, [400, 400, 200]]);
  egal("textul pe pagină", [PZ.text(PZ.citeste("3", "400", 1000), "buc"), PZ.text(PZ.citeste("3", "400", 1200), "buc"), PZ.text(PZ.citeste("1", "500", 200), "kg")],
    ["3 paleți: 2 × 400 + 200 buc", "3 paleți × 400 buc", "un palet cu 200 kg"]);
  egal("căsuța „Fă paleții”", [PZ.pentruFormular(PZ.citeste("3", "400", 1000)), PZ.pentruFormular(PZ.citeste("3", "400", 1200)), PZ.pentruFormular(PZ.citeste("2", "400", 700)), PZ.pentruFormular(PZ.citeste("1", "500", 200))],
    ["2 x 400 + 200", "3 x 400", "400 + 300", "200"]);
  egal("…peste câți se fac odată: întâi atâția, plini", PZ.pentruFormular(PZ.citeste("80", "20", 1590)), `${PZ.MAX_ODATA} x 20`);
  egal("restul, la fel de plin ca la recepție", [PZ.pentruFormular(PZ.pentruRest(400, 800)), PZ.pentruFormular(PZ.pentruRest(400, 700)), PZ.pentruRest(null, 700)], ["2 x 400", "400 + 300", null]);
  egal("scanerul citește ce scrie căsuța", ["2 x 400 + 200", "400 + 300", "3 x 400", "1 x 12,5 + 7,5"].map((t) => SC.cantitatiDinText(t)), [[400, 400, 200], [400, 300], [400, 400, 400], [12.5, 7.5]]);
  bine("…și refuză ce nu e număr", SC.cantitatiDinText("2 x 400 + abc").some((x) => Number.isNaN(x)));

  // ------------------------------------------------------------------------
  console.log("\n2. Recepția din Procurement: prezentarea e obligatorie");
  const O1 = comanda("CF-1", { moneda: "EUR", curs: 5 });
  const LA = linieCf(O1, P1, `${PREFIX} Jumbo Virgin Transparent`, 1000, "kg", 2, 0);
  const LB = linieCf(O1, null, `${PREFIX} Cutii de carton`, 300, "buc", null, 0);
  const corp = (primit, nrP, peP, extra) => Object.assign({ "linie_id[]": [String(LA), String(LB)], "primit[]": primit, "paleti_nr[]": nrP, "paleti_pe[]": peP, data_receptie: "2026-11-13" }, extra || {});
  let r = await cer("post", `/procurement/comenzi/${O1}/receptie`, DEP, { body: corp(["1000", ""], ["", ""], ["", ""]) });
  bine("fără prezentare: înapoi cu eroarea, pe rândul care o cere", /scrie câți paleți au venit acum \(1\.000 kg\)/.test(parametri(r).eroare_receptie || "") && (parametri(r).eroare_receptie || "").includes(`${PREFIX} Jumbo Virgin Transparent`), unde(r));
  egal("…și nu s-a salvat nimic: nici pe comandă, nici în depozit", [Number(unul(`SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE id = ${LA}`)), unul(`SELECT status FROM comenzi_furnizor WHERE id = ${O1}`), receptiiCf(O1).length], [0, "trimisa", 0]);
  r = await cer("post", `/procurement/comenzi/${O1}/receptie`, DEP, { body: corp(["1000", ""], ["2", ""], ["400", ""]) });
  bine("prezentare care nu încape: spune de ce, nu salvează", /încap 800, dar s-au primit 1\.000/.test(parametri(r).eroare_receptie || "") && Number(unul(`SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE id = ${LA}`)) === 0 && !receptiiCf(O1).length, parametri(r).eroare_receptie);
  r = await cer("post", `/procurement/comenzi/${O1}/receptie`, AGENT, { body: corp(["1000", ""], ["3", ""], ["400", ""]) });
  bine("agentul de vânzări nu recepționează", unde(r) === `/procurement/comenzi/${O1}` && !receptiiCf(O1).length && Number(unul(`SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE id = ${LA}`)) === 0, unde(r));

  console.log("\n3. …cu prezentarea, marfa intră în depozit");
  const stocInainte = Number(unul(`SELECT COALESCE(SUM(cantitate), 0) FROM miscari_stoc WHERE produs_id = ${P1}`));
  r = await cer("post", `/procurement/comenzi/${O1}/receptie`, DEP, { body: corp(["1000", ""], ["3", ""], ["400", ""]) });
  const rec1 = receptiiCf(O1);
  egal("cantitatea e pe comandă, comanda e parțială", [Number(unul(`SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE id = ${LA}`)), unul(`SELECT status FROM comenzi_furnizor WHERE id = ${O1}`)], [1000, "partial"]);
  egal("o recepție în depozit, de la furnizor, legată de comandă, finalizată", rec1.map((x) => [x.sursa, Number(x.partener_id), x.document_extern, x.stare, x.data]), [["furnizor", FURNIZOR, `${PREFIX}-CF-1`, "finalizata", "2026-11-13"]]);
  const l1 = rec1.length ? liniiRec(rec1[0].id) : [];
  egal("…doar cu ce a venit: produsul, 1.000 kg, prezentarea, prețul în lei (2 EUR × 5)", l1.map((x) => [Number(x.produs_id), Number(x.cantitate_primita), x.um, x.stare, x.conditie, Number(x.paleti_nr), Number(x.paleti_pe), Number(x.pret_unitar), Number(x.comanda_furnizor_linie_id)]),
    [[P1, 1000, "kg", "primita", "bun", 3, 400, 10, LA]]);
  egal("stocul crește o dată, cu 1.000", Number(unul(`SELECT COALESCE(SUM(cantitate), 0) FROM miscari_stoc WHERE produs_id = ${P1}`)) - stocInainte, 1000);
  bine("pagina spune unde e marfa acum, cu recepția", (parametri(r).ok_receptie || "").includes(`recepția ${rec1[0] && rec1[0].numar}`) && /„De alocat pe raft”/.test(parametri(r).ok_receptie || "") && parametri(r).rec === String(rec1[0] && rec1[0].id), unde(r));
  const ist = q(`SELECT ce, nou FROM comenzi_furnizor_istoric WHERE comanda_id = ${O1} ORDER BY id`);
  bine("istoricul comenzii: primit, stare, data și intrarea în depozit, cu prezentarea", ist.map((x) => x.ce).join("|") === `Primit · ${PREFIX} Jumbo Virgin Transparent|Stare|Data recepției|Intrată în depozit` && /3 paleți: 2 × 400 \+ 200/.test(ist[ist.length - 1].nou || ""), JSON.stringify(ist));
  let pag = await cer("get", `/procurement/comenzi/${O1}`, DEP, { query: { ok_receptie: "Gata.", rec: String(rec1[0].id) } });
  bine("pagina comenzii arată mesajul, cu recepția și lista", pag.corp.includes('id="receptie-ok"') && pag.corp.includes(`href="/depozit/receptie/${rec1[0].id}"`) && pag.corp.includes('href="/stocuri/ct-park/intrare#gata-productie"'));
  bine("…formularul de recepție are prezentarea pe fiecare rând și verificarea pe pagină", (pag.corp.match(/name="paleti_nr\[\]"/g) || []).length === 2 && (pag.corp.match(/name="paleti_pe\[\]"/g) || []).length === 2 && pag.corp.includes("data-prez-form") && pag.corp.includes('data-inainte="1000"') && pag.corp.includes("function verifica(tr, form)"));
  bine("…și nimic de „Trimite în depozit”: a intrat tot ce s-a primit", !pag.corp.includes('id="in-depozit"'));

  console.log("\n4. În Intrare marfă, în aceeași listă cu producția");
  let x1 = (await GPM.deAlocat()).find((x) => x.id === Number(l1[0].id));
  egal("rândul e de alocat: 1.000 kg, cu prezentarea și căsuța completată", x1 && [x1.ramas, x1.prezentare_text, x1.paleti_propusi, x1.comanda_furnizor_numar], [1000, "3 paleți: 2 × 400 + 200 kg", "2 x 400 + 200", `${PREFIX}-CF-1`]);
  pag = await cer("get", "/stocuri/ct-park/intrare", DEP);
  let sec = sectiunea(pag.corp);
  let rd = randul(sec, l1[0].id);
  bine("pe pagină: „a venit: 3 paleți…”, legătura spre comanda la furnizor", rd.includes("a venit: <strong>3 paleți: 2 × 400 + 200 kg</strong>") && rd.includes(`href="/procurement/comenzi/${O1}"`) && rd.includes(`${PREFIX} Furnizor Folie SRL`), rd.slice(0, 600));
  bine("…„Fă paleții și etichetele” completat, fără căsuță de preț (prețul e știut)", rd.includes(`action="/stocuri/ct-park/gata/receptie/${l1[0].id}/paleti"`) && rd.includes('name="paleti" value="2 x 400 + 200"') && !rd.includes('name="pret"'), (rd.match(/<form[^>]*\/paleti"[\s\S]{0,500}/) || ["lipsește"])[0]);

  console.log("\n5. A doua recepție trimite doar ce e în plus; scăderea nu trimite nimic");
  r = await cer("post", `/procurement/comenzi/${O1}/receptie`, DEP, { body: corp(["", "300"], ["", "1"], ["", "300"]) });
  let rec2 = receptiiCf(O1);
  egal("a doua recepție, doar cu cutiile", rec2.length, 2);
  const l2 = rec2.length > 1 ? liniiRec(rec2[1].id) : [];
  egal("…scrise liber, fără preț (comanda n-are)", l2.map((x) => [x.produs_id, x.produs_text, Number(x.cantitate_primita), x.um, x.pret_unitar, Number(x.paleti_nr), Number(x.paleti_pe)]), [[null, `${PREFIX} Cutii de carton`, 300, "buc", null, 1, 300]]);
  egal("comanda e primită", unul(`SELECT status FROM comenzi_furnizor WHERE id = ${O1}`), "primita");
  r = await cer("post", `/procurement/comenzi/${O1}/receptie`, DEP, { body: corp(["900", ""], ["", ""], ["", ""]) });
  egal("scăderea la 900: nicio recepție nouă, comanda ia 900", [receptiiCf(O1).length, Number(unul(`SELECT cantitate_primita FROM comenzi_furnizor_linii WHERE id = ${LA}`))], [2, 900]);
  bine("…și spune că depozitul nu se schimbă singur", /Ai scăzut cantitatea primită la .*Ce intrase deja în depozit nu se schimbă singur/.test(parametri(r).ok_receptie || ""), parametri(r).ok_receptie);
  r = await cer("post", `/procurement/comenzi/${O1}/receptie`, DEP, { body: corp(["1000", ""], ["1", ""], ["100", ""]) });
  egal("înapoi la 1.000: trimite doar cele 100 în plus", receptiiCf(O1).length === 3 ? liniiRec(receptiiCf(O1)[2].id).map((x) => [Number(x.cantitate_primita), Number(x.paleti_nr), Number(x.paleti_pe)]) : receptiiCf(O1).length, [[100, 1, 100]]);

  console.log("\n6. „Fă paleții și etichetele”");
  const lidA = Number(l1[0].id);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidA}/paleti`, DEP, { body: { paleti: "două paleți" } });
  bine("text care nu e cantitate: refuzat, cu exemplu", /nu e o listă de cantități.*3 x 400/.test(parametri(r).gata_eroare || ""), unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidA}/paleti`, AGENT, { body: { paleti: "2 x 400 + 200" } });
  egal("cine n-are Intrarea nu face paleți", [unde(r), Number(unul(`SELECT count(*) FROM ct_paleti WHERE receptie_linie_id = ${lidA}`))], ["/stocuri/ct-park", 0]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidA}/paleti`, DEP, { body: { paleti: "400" } });
  const primul = String(unde(r).match(/paleti=(\d+)/) ? unde(r).match(/paleti=(\d+)/)[1] : "");
  x1 = (await GPM.deAlocat()).find((x) => x.id === lidA);
  egal("un palet de 400 făcut întâi: rămân 600, propuse la fel de pline: 400 + 200", x1 && [x1.ramas, x1.paleti_propusi, x1.prezentare_text], [600, "400 + 200", "3 paleți: 2 × 400 + 200 kg"]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidA}/paleti`, DEP, { body: { paleti: "400 + 200" } });
  const pal = q(`SELECT id, cantitate, um, pret_unitar, receptie_id FROM ct_paleti WHERE receptie_linie_id = ${lidA} ORDER BY id`);
  egal("trei paleți: 400, 400, 200 kg, cu prețul recepției", pal.map((p) => [Number(p.cantitate), p.um, Number(p.pret_unitar), Number(p.receptie_id)]), [[400, "kg", 10, Number(rec1[0].id)], [400, "kg", 10, Number(rec1[0].id)], [200, "kg", 10, Number(rec1[0].id)]]);
  egal("…fără loc, iar pagina deschide etichetele lor, cu drumul înapoi la Intrare", [Number(unul(`SELECT count(*) FROM ct_ocupari WHERE palet_id IN (${pal.map((p) => p.id).join(",") || 0})`)), primul, unde(r)], [0, String(pal[0] && pal[0].id), `/stocuri/ct-park/etichete?paleti=${pal.slice(1).map((p) => p.id).join(",")}&de_la=intrare`]);
  const et = await cer("get", "/stocuri/ct-park/etichete", DEP, { query: { paleti: pal.map((p) => p.id).join(","), de_la: "intrare" } });
  bine("pagina etichetelor duce înapoi la paleții fără loc", et.corp.includes('href="/stocuri/ct-park/intrare#fara-loc"'));
  bine("rândul a ieșit din listă (are palet)", !(await GPM.deAlocat()).some((x) => x.id === lidA));
  sec = sectiunea((await cer("get", "/stocuri/ct-park/intrare", DEP)).corp);
  const fl = bucata(sec, "fara-loc", 'id="pregatite"');
  bine("…iar paleții stau la „fără loc pe raft”, cu „Pune pe raft”", pal.every((p) => fl.includes(`/stocuri/ct-park/scaner/intrare/palet/${p.id}"`)), fl.slice(0, 300));

  const lidB = Number(l2[0].id);
  bine("cutiile fără preț cer prețul în listă", randul(sec, lidB).includes('<input name="pret" inputmode="decimal" autocomplete="off" required placeholder="preț lei / buc"'), (randul(sec, lidB).match(/<form[^>]*\/paleti"[\s\S]{0,700}/) || ["lipsește"])[0]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidB}/paleti`, DEP, { body: { paleti: "300" } });
  bine("…fără preț nu se face paletul, iar mesajul spune unde se scrie", /Scrie-l în căsuța de preț a rândului/.test(parametri(r).gata_eroare || "") && Number(unul(`SELECT count(*) FROM ct_paleti WHERE receptie_linie_id = ${lidB}`)) === 0, parametri(r).gata_eroare);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidB}/paleti`, DEP, { body: { paleti: "300", pret: "1,5" } });
  egal("…cu prețul scris, paletul se face", q(`SELECT cantitate, pret_unitar, produs_text FROM ct_paleti WHERE receptie_linie_id = ${lidB}`).map((p) => [Number(p.cantitate), Number(p.pret_unitar), p.produs_text]), [[300, 1.5, `${PREFIX} Cutii de carton`]]);
  const lidC = Number(liniiRec(receptiiCf(O1)[2].id)[0].id);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidC}/paleti`, DEP, { body: { paleti: "2 x 100" } });
  bine("mai mult decât a rămas: întreabă, nu face", /mai erau de pus 100 kg.*bifează „a venit mai mult”/.test(parametri(r).gata_eroare || "") && Number(unul(`SELECT count(*) FROM ct_paleti WHERE receptie_linie_id = ${lidC}`)) === 0, parametri(r).gata_eroare);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lidC}/paleti`, DEP, { body: { paleti: "2 x 100", peste: "1" } });
  egal("…cu bifa „a venit mai mult”, îi face", q(`SELECT cantitate FROM ct_paleti WHERE receptie_linie_id = ${lidC} ORDER BY id`).map((p) => Number(p.cantitate)), [100, 100]);

  // ------------------------------------------------------------------------
  console.log("\n7. „Trimite în depozit”, la comenzile primite înainte");
  const O2 = comanda("CF-2", { status: "primita", data: "2026-11-09", dataReceptie: "2026-11-13" });
  const LC = linieCf(O2, P2, `${PREFIX} Banda Fragil 48x60`, 500, "buc", 3, 500);
  const O3 = comanda("CF-3", { status: "primita", data: "2026-11-01", dataReceptie: "2026-11-10" });
  linieCf(O3, P3, `${PREFIX} Granula`, 700, "kg", 4, 700);
  // Un palet pus de mână pe 12.11, cu aceeași bandă: poate e chiar ea.
  const palMana = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare) VALUES ('${PREFIX}-PAL-MANA', ${P2}, 120, 120, 'buc', '2026-11-12') RETURNING id`));
  // …și unul vechi, de dinainte: nu.
  q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare) VALUES ('${PREFIX}-PAL-VECHI', ${P2}, 50, 50, 'buc', '2026-11-02')`);
  // …și una cu alt produs, care are în comun doar „bandă": nu.
  q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, cantitate_intrare, um, data_intrare) VALUES ('${PREFIX}-PAL-ALTA', '${PREFIX} Bandă transparentă', 40, 40, 'buc', '2026-11-12')`);
  pag = await cer("get", `/procurement/comenzi/${O2}`, DEP);
  const sd = bucata(pag.corp, "in-depozit", "Istoric — cine a modificat");
  bine("comanda primită pe 13.11 are „Trimite în depozit”, cu ce a rămas: 500", sd.includes(`action="/procurement/comenzi/${O2}/in-depozit"`) && sd.includes(`value="${LC}"`) && sd.includes('name="cant[]" data-cant inputmode="decimal" autocomplete="off" value="500"'), sd.slice(0, 500));
  bine("…cu paletul pus de mână după comandă, nu și cu cel vechi sau cu alta marfă", sd.includes("Poate e deja pe raft") && sd.includes(`/stocuri/ct-park/palet/${palMana}`) && sd.includes(`${PREFIX}-PAL-MANA`) && !sd.includes(`${PREFIX}-PAL-VECHI`) && !sd.includes(`${PREFIX}-PAL-ALTA`), (sd.match(/Poate e deja pe raft[\s\S]{0,400}/) || ["lipsește"])[0]);
  bine("…și întrebarea înainte de trimitere", sd.includes('data-confirma="Marfa intră în depozit și pe stoc. Ai verificat că nu e deja pe raft?"'));
  pag = await cer("get", `/procurement/comenzi/${O3}`, DEP);
  bine("comanda recepționată înainte de 13.11 nu-l are (a intrat de mână, s-ar dubla)", pag.cod === 200 && !pag.corp.includes('id="in-depozit"'));
  pag = await cer("get", `/procurement/comenzi/${O2}`, AGENT);
  bine("agentul nu-l vede", !pag.corp.includes('id="in-depozit"'));

  const trimite = (cant, nrP, peP, user) => cer("post", `/procurement/comenzi/${O2}/in-depozit`, user || DEP, { body: { "linie_id[]": [String(LC)], "cant[]": [cant], "paleti_nr[]": [nrP], "paleti_pe[]": [peP] } });
  r = await trimite("300", "", "");
  bine("fără prezentare: nu trimite", /scrie câți paleți și cât e pe un palet plin/.test(parametri(r).eroare_receptie || "") && !receptiiCf(O2).length, unde(r));
  r = await trimite("600", "2", "300");
  bine("mai mult decât s-a primit: nu", /au rămas de trimis doar 500 buc/.test(parametri(r).eroare_receptie || "") && !receptiiCf(O2).length, parametri(r).eroare_receptie);
  r = await trimite("300", "1", "300", AGENT);
  bine("agentul nu trimite", unde(r) === `/procurement/comenzi/${O2}` && !receptiiCf(O2).length, unde(r));
  r = await trimite("300", "2", "150");
  const rc2 = receptiiCf(O2);
  egal("trimise 300: recepția în depozit, finalizată, cu prețul (3 lei) și prezentarea", rc2.map((x) => [x.stare, x.data, liniiRec(x.id).map((l) => [Number(l.produs_id), Number(l.cantitate_primita), Number(l.pret_unitar), Number(l.paleti_nr), Number(l.paleti_pe), Number(l.comanda_furnizor_linie_id)])]),
    [["finalizata", "2026-11-13", [[P2, 300, 3, 2, 150, LC]]]]);
  bine("…spus pe pagină și în istoric", /Marfa a intrat în depozit pe recepția/.test(parametri(r).ok_receptie || "") && unul(`SELECT ce FROM comenzi_furnizor_istoric WHERE comanda_id = ${O2} ORDER BY id DESC LIMIT 1`) === "Trimisă în depozit", unde(r));
  pag = await cer("get", `/procurement/comenzi/${O2}`, DEP);
  bine("au rămas 200 de trimis, iar 300 sunt deja în depozit", bucata(pag.corp, "in-depozit", "Istoric").includes('value="200"') && bucata(pag.corp, "in-depozit", "Istoric").includes("300 buc"));
  r = await trimite("200", "1", "200");
  pag = await cer("get", `/procurement/comenzi/${O2}`, DEP);
  egal("tot: două recepții, 500 în depozit, iar caseta dispare", [receptiiCf(O2).length, Number(unul(`SELECT SUM(rl.cantitate_primita) FROM receptii_linii rl JOIN receptii r ON r.id = rl.receptie_id WHERE r.comanda_furnizor_id = ${O2}`)), pag.corp.includes('id="in-depozit"')], [2, 500, false]);
  r = await trimite("200", "1", "200");
  bine("a doua oară nu mai trimite nimic", /a intrat deja în depozit/.test(parametri(r).eroare_receptie || "") && receptiiCf(O2).length === 2, parametri(r).eroare_receptie);

  // ------------------------------------------------------------------------
  console.log("\n8. Recepția din depozit");
  const RF = Number(await REC.creeaza({ sursa: "furnizor", partener_id: FURNIZOR, numar: `${PREFIX}-REC-F`, document_extern: "AVIZ 7" }, [{ produs_id: P2, cantitate: 100, um: "buc" }, { produs_id: P2, cantitate: 10, um: "buc" }]));
  const [lf, lf0] = liniiRec(RF).map((x) => Number(x.id));
  pag = await cer("get", `/depozit/receptie/${RF}`, DEP);
  bine("pe pagină, sub „Primit”: paleți × pe palet, cu explicația", pag.corp.includes(`<input form="lin-${lf}" name="paleti_nr"`) && pag.corp.includes(`<input form="lin-${lf}" name="paleti_pe"`) && /La marfa de la furnizor e obligatorie/.test(pag.corp));
  r = await cer("post", `/depozit/receptie/${RF}/linie/${lf}`, DEP, { body: { cantitate_primita: "100", conditie: "bun" } });
  bine("marfa bună de la furnizor fără prezentare: nu trece", /Scrie și prezentarea/.test(parametri(r).eroare || "") && unul(`SELECT stare FROM receptii_linii WHERE id = ${lf}`) === "de_primit", unde(r));
  r = await cer("post", `/depozit/receptie/${RF}/linie/${lf}`, DEP, { body: { cantitate_primita: "100", conditie: "bun", paleti_nr: "1", paleti_pe: "60" } });
  bine("…nici cu una care nu încape", /^Prezentarea: Pe un palet a câte 60 încap 60/.test(parametri(r).eroare || "") && unul(`SELECT stare FROM receptii_linii WHERE id = ${lf}`) === "de_primit", parametri(r).eroare);
  r = await cer("post", `/depozit/receptie/${RF}/linie/${lf}`, DEP, { body: { cantitate_primita: "100", conditie: "bun", paleti_nr: "2", paleti_pe: "60" } });
  egal("cu ea, rândul se salvează cu prezentarea", q(`SELECT stare, cantitate_primita, paleti_nr, paleti_pe FROM receptii_linii WHERE id = ${lf}`).map((x) => [x.stare, Number(x.cantitate_primita), Number(x.paleti_nr), Number(x.paleti_pe)]), [["primita", 100, 2, 60]]);
  r = await cer("post", `/depozit/receptie/${RF}/linie/${lf0}`, DEP, { body: { cantitate_primita: "0", motiv: "n-a venit" } });
  egal("ce n-a venit (0) n-are nevoie de prezentare", [unul(`SELECT stare FROM receptii_linii WHERE id = ${lf0}`), unul(`SELECT paleti_nr FROM receptii_linii WHERE id = ${lf0}`)], ["respinsa", null]);
  r = await cer("post", `/depozit/receptie/${RF}/finalizeaza`, DEP);
  pag = await cer("get", `/depozit/receptie/${RF}`, DEP);
  bine("după finalizare se vede „2 paleți: 1 × 60 + 40 buc”, sub „Primit”…", pag.corp.includes('<strong>100</strong><div class="mic">2 paleți: 1 × 60 + 40 buc</div>'), (pag.corp.match(/<strong>100<\/strong>[^\n]{0,80}/) || ["lipsește"])[0]);
  bine("…și la „A venit”, în CT-Park", pag.corp.includes('100 buc<div class="mic">2 paleți: 1 × 60 + 40 buc</div>'), (pag.corp.match(/100 buc<div[^\n]{0,80}/) || ["lipsește"])[0]);
  bine("…iar „Paleți și etichete” vine completat din ea", pag.corp.includes(`name="paleti_${lf}" value="60 + 40"`), (pag.corp.match(new RegExp(`name="paleti_${lf}"[^>]*`)) || ["lipsește"])[0]);
  const RP = Number(await REC.creeaza({ sursa: "productie", numar: `${PREFIX}-REC-P` }, [{ produs_id: P1, cantitate: 50, um: "kg" }]));
  const lp = Number(liniiRec(RP)[0].id);
  r = await cer("post", `/depozit/receptie/${RP}/linie/${lp}`, DEP, { body: { cantitate_primita: "50" } });
  egal("la producție nu e obligatorie", unul(`SELECT stare FROM receptii_linii WHERE id = ${lp}`), "primita");
  r = await cer("post", `/depozit/receptie/${RP}/linie/${lp}`, DEP, { body: { cantitate_primita: "50", paleti_nr: "2", paleti_pe: "25" } });
  egal("…dar se poate scrie, și atunci propune paleții în listă", [Number(unul(`SELECT paleti_nr FROM receptii_linii WHERE id = ${lp}`)), ((await GPM.deAlocat()).find((x) => x.id === lp) || {}).paleti_propusi], [2, "2 x 25"]);
  const RP2 = Number(await REC.creeaza({ sursa: "productie", numar: `${PREFIX}-REC-P2` }, [{ produs_id: P4, cantitate: 30, um: "buc" }]));
  const lp2 = Number(liniiRec(RP2)[0].id);
  sec = sectiunea((await cer("get", "/stocuri/ct-park/intrare", DEP)).corp);
  bine("marfa din producție fără preț nu primește căsuța de preț (intră și fără)", randul(sec, lp2).includes(`/gata/receptie/${lp2}/paleti`) && !randul(sec, lp2).includes('name="pret"'), randul(sec, lp2).slice(0, 300));

  curata();
  console.log(esecuri ? `\n${esecuri} ESEC(URI)` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
