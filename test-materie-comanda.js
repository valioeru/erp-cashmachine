"use strict";
// Materia primă, aleasă pe comanda de producție din aceeași casetă cu furnizorul ei.
//
// CE A CERUT VALI, 10.11.2026, cu poza comenzii de producție la caseta
// „Furnizorul materialului": „Și să poată alege și materia primă tot de aici."
//
// CE APĂRĂ:
//   • CASETA are acum și „Materia primă": lista vine din stocul CT-Park
//     (paleții „materie primă" și „produse intermediare", încă în depozit), cu
//     cât e și de la cine; produsele finite nu apar.
//   • CE SCRIE OMUL devine produs din catalog după denumirea exactă sau după
//     cod; două produse cu același nume sau un nume necunoscut rămân text.
//   • FURNIZORUL vine singur doar când nu e nimic de ales: comanda n-are
//     furnizor, iar materia e pe stoc de la unul singur. Ajunge și pe linia
//     clientului, „din producție". Un furnizor deja ales nu se rescrie.
//   • DIN REȚETĂ: materialele rețetei aflate pe stoc apar ca butoane.
//   • DOAR producția, depozitul și adminul aleg materia primă.
//   • FIȘA DE LOT o arată, cu furnizorul; fără materie primă, fișa e ca înainte.
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
for (const m of ["gata-productie", "ct-park", "retete", "productie", "receptie", "warehouse"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const FC = require(path.join(RAD, "lib", "furnizor-comanda.js"));

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
const M1 = 97901, M2 = 97902, P_FINIT = 97903, P_NESTOC = 97904, P_PROD = 97905, P_RETETA = 97906, DUBLU_A = 97907, DUBLU_B = 97908;
// M_NESCRIS: pe stoc de la un furnizor știut, plus un palet fără niciun furnizor scris.
const M_NESCRIS = 97909;
const CLIENT = 97911, S1 = 97912, S2 = 97913;
const CMD = 97921;
const CP = 97931, CP_RETETA = 97932, CP_CU_FURNIZOR = 97933;
// CP_SCRIS: comandă din registrul vechi, cu produsul scris de mână (fără produs din catalog).
const CP_SCRIS = 97934;
const PREFIX = "TMC";
const PRODUSE = [M1, M2, P_FINIT, P_NESTOC, P_PROD, P_RETETA, DUBLU_A, DUBLU_B, M_NESCRIS];

function curata() {
  const pr = PRODUSE.join(",");
  const cp = [CP, CP_RETETA, CP_CU_FURNIZOR, CP_SCRIS].join(",");
  const pal = q(`SELECT id FROM ct_paleti WHERE cod LIKE '${PREFIX}-PAL-%' OR produs_id IN (${pr})`).map((x) => Number(x.id)).join(",") || "0";
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${pal})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${pal})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${pal})`);
  q(`DELETE FROM alocari_productie WHERE comanda_productie_id IN (${cp})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${cp})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${cp})`);
  try { q(`DELETE FROM comenzi_istoric WHERE comanda_id = ${CMD}`); } catch (_) { /* tabela poate lipsi */ }
  q(`DELETE FROM comenzi_linii WHERE comanda_id = ${CMD}`);
  q(`DELETE FROM comenzi WHERE id = ${CMD}`);
  q(`DELETE FROM retete_componente WHERE produs_id IN (${pr}) OR componenta_id IN (${pr})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM interactiuni WHERE partener_id IN (${CLIENT}, ${S1}, ${S2})`);
  q(`DELETE FROM parteneri WHERE id IN (${CLIENT}, ${S1}, ${S2})`);
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
const rand = (id) => q(`SELECT materie_produs_id, materie_text, materie_aleasa_de, materie_aleasa_la, furnizor_id, furnizor_text FROM comenzi_productie WHERE id = ${id}`)[0] || {};
const caseta = (html) => { const i = html.indexOf('class="caseta-materie"'); return i < 0 ? "" : html.slice(i, html.indexOf("Furnizorul materialului", i)); };
let nrPalet = 0;
function palet(produs, cant, um, categorie, furnizorId, furnizorText, iesit) {
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, categorie, data_intrare, data_iesire, furnizor_id, furnizor_text)
     VALUES ('${PREFIX}-PAL-${++nrPalet}', ${produs}, ${cant}, '${um}', '${categorie}', '${azi()}', ${iesit ? "'" + azi() + "'" : "NULL"}, ${furnizorId || "NULL"}, ${furnizorText ? "'" + furnizorText + "'" : "NULL"}) RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (${id}, ${produs}, ${cant}, '${um}')`);
  return id;
}

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const MIHAI = { id: idUser, nume: "Mihai Productie", rol: "productie", sectiuni: "" };
  const AGENT = { id: idUser, nume: "Agent", rol: "vanzari", sectiuni: "/crm" };

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${CLIENT}, 'client', '${PREFIX} Client SRL'), (${S1}, 'furnizor', '${PREFIX} Carton Unu SRL'), (${S2}, 'furnizor', '${PREFIX} Carton Doi SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (${M1}, 'TMC-CO3', '${PREFIX} Carton ondulat CO3', 'buc'),
       (${M2}, 'TMC-CO5', '${PREFIX} Carton ondulat CO5', 'buc'),
       (${P_FINIT}, 'TMC-FIN', '${PREFIX} Cutie gata făcută', 'buc'),
       (${P_NESTOC}, 'TMC-NS', '${PREFIX} Carton fără stoc', 'buc'),
       (${P_PROD}, 'TMC-D5', '${PREFIX} Cutie D5-530/375/170', 'buc'),
       (${P_RETETA}, 'TMC-D7', '${PREFIX} Cutie cu rețetă', 'buc'),
       (${DUBLU_A}, 'TMC-DA', '${PREFIX} Carton dublat', 'buc'),
       (${DUBLU_B}, 'TMC-DB', '${PREFIX} Carton dublat', 'buc'),
       (${M_NESCRIS}, 'TMC-NSC', '${PREFIX} Hartie kraft', 'kg')`);
  q(`INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (${P_RETETA}, ${M1}, 1.2), (${P_RETETA}, ${P_NESTOC}, 0.1)`);
  // Stocul din CT-Park: CO3 de la un singur furnizor (doi paleți) și un palet ieșit, de la altul;
  // CO5 de la doi furnizori; o cutie gata făcută (produs finit).
  palet(M1, 400, "buc", "materie primă", S1);
  palet(M1, 600, "buc", "materie primă", S1);
  palet(M1, 999, "buc", "materie primă", S2, null, true);
  palet(M2, 300, "buc", "produse intermediare", S1);
  palet(M2, 200, "buc", "materie primă", null, "TMC Furnizor scris de mână");
  palet(P_FINIT, 50, "buc", "produse finite", S2);
  palet(M_NESCRIS, 700, "kg", "materie primă", S1);
  palet(M_NESCRIS, 300, "kg", "materie primă", null, null);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD}, ${CLIENT}, '${PREFIX}-1', '${azi()}', 'in_productie')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${CMD}, ${P_PROD}, 500, 2)`);
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, partener_id, comanda_id) VALUES
       (${CP}, '${PREFIX}-CP-1', ${P_PROD}, '${PREFIX} Cutie D5-530/375/170', '500', 'buc', 'in_productie', ${CLIENT}, ${CMD})`);
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, client_text) VALUES
       (${CP_RETETA}, '${PREFIX}-CP-2', ${P_RETETA}, '${PREFIX} Cutie cu rețetă', '100', 'buc', 'in_productie', 'TMC Alt client')`);
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, client_text, furnizor_id, furnizor_ales_de) VALUES
       (${CP_CU_FURNIZOR}, '${PREFIX}-CP-3', ${P_PROD}, '${PREFIX} Cutie D5-530/375/170', '100', 'buc', 'in_productie', 'TMC Alt client', ${S2}, 'Cineva')`);
  q(`INSERT INTO comenzi_productie (id, numar, tip_produs, cantitate, um, status, client_text) VALUES
       (${CP_SCRIS}, '${PREFIX}-CP-4', '${PREFIX} produs scris de mână', '250', 'buc', 'in_productie', 'TMC Alt client')`);
  const linieClient = () => q(`SELECT furnizor_id, furnizor_sursa FROM comenzi_linii WHERE comanda_id = ${CMD}`)[0];

  // ------------------------------------------------------------------------
  console.log("1. Caseta de pe comanda de producție");
  let pag = (await cer("get", `/productie/${CP}`, MIHAI)).corp;
  let cas = caseta(pag);
  bine("are „Materia primă”, deasupra furnizorului, și spune că nu e aleasă", cas.includes("Materia primă") && /Nealeasă\. O alegi de aici/.test(cas) && pag.includes("Furnizorul materialului"), cas.slice(0, 200));
  bine("formularul ei scrie în /materie și se întoarce pe comandă", cas.includes(`action="/productie/${CP}/materie"`) && cas.includes(`name="inapoi" value="/productie/${CP}"`) && cas.includes("Salvează materia primă"));
  bine("lista: cartonul CO3, cu cât e pe stoc și de la cine (fără paletul ieșit)", cas.includes(`<option value="${PREFIX} Carton ondulat CO3" label="1.000 buc pe stoc · ${PREFIX} Carton Unu SRL · TMC-CO3">`), (cas.match(/<option value="TMC Carton ondulat CO3"[^>]*>/) || [""])[0]);
  bine("…și CO5, de la doi furnizori, adunat din „materie primă” și „produse intermediare”", /<option value="TMC Carton ondulat CO5" label="500 buc pe stoc · [^"]*TMC Carton Unu SRL[^"]*">/.test(cas) && /label="500 buc pe stoc · [^"]*TMC Furnizor scris de mână/.test(cas));
  bine("…dar nu produsul finit și nu ce nu e pe stoc", !cas.includes(`${PREFIX} Cutie gata făcută`) && !cas.includes(`${PREFIX} Carton fără stoc`));
  bine("produsul fără rețetă n-are butoane „din rețetă”", !cas.includes("materie-sugestii"));
  cas = caseta((await cer("get", `/productie/${CP}`, AGENT)).corp);
  bine("agentul vede caseta, dar fără formular", cas.includes("Materia primă") && !cas.includes(`action="/productie/${CP}/materie"`));

  // ------------------------------------------------------------------------
  console.log("\n2. Alegerea materiei prime");
  let r = await cer("post", `/productie/${CP}/materie`, AGENT, { body: { materie: `${PREFIX} Carton ondulat CO3` } });
  egal("agentul nu alege materia primă", [unde(r), rand(CP).materie_produs_id], [`/productie/${CP}`, null]);
  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `  tmc carton ondulat co3 `, inapoi: `/productie/${CP}/necesar` } });
  let x = rand(CP);
  egal("denumirea exactă, fără majuscule: produsul din catalog; întoarcerea pe necesar", [unde(r), Number(x.materie_produs_id), x.materie_text, x.materie_aleasa_de], [`/productie/${CP}/necesar`, M1, null, "Mihai Productie"]);
  bine("…cu data la care s-a ales", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.materie_aleasa_la || ""), x.materie_aleasa_la);
  egal("fiind pe stoc de la un singur furnizor, vine și furnizorul", [Number(x.furnizor_id), x.furnizor_text], [S1, null]);
  egal("…care ajunge pe linia clientului, „din producție”", [Number(linieClient().furnizor_id), linieClient().furnizor_sursa], [S1, "productie"]);
  pag = (await cer("get", `/productie/${CP}`, MIHAI)).corp;
  cas = caseta(pag);
  bine("caseta arată materia aleasă, cu codul și cine a ales-o", cas.includes(`<a href="/produse/${M1}">${PREFIX} Carton ondulat CO3</a>`) && cas.includes("· TMC-CO3") && cas.includes("aleasă de Mihai Productie"), cas.slice(0, 400));
  bine("…și stocul ei: 1.000 buc pe 2 paleți, de la furnizorul lor", /Pe stoc în CT-Park: 1\.000 buc pe 2 paleți \(TMC Carton Unu SRL\)\./.test(cas));
  bine("…iar butonul devine „Schimbă materia primă”", cas.includes("Schimbă materia primă") && cas.includes(`value="${PREFIX} Carton ondulat CO3"`));

  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: "tmc-co5", inapoi: "/altundeva" } });
  x = rand(CP);
  egal("codul exact merge și el; întoarcerea doar pe paginile comenzii", [unde(r), Number(x.materie_produs_id)], [`/productie/${CP}`, M2]);
  egal("furnizorul ales înainte nu se rescrie", Number(x.furnizor_id), S1);
  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: "Carton adus de client, 3 straturi" } });
  x = rand(CP);
  egal("ce nu e în catalog rămâne text", [x.materie_produs_id, x.materie_text], [null, "Carton adus de client, 3 straturi"]);
  cas = caseta((await cer("get", `/productie/${CP}`, MIHAI)).corp);
  bine("…și caseta spune că nu i se vede stocul", cas.includes("<strong>Carton adus de client, 3 straturi</strong>") && /Scrisă ca text/.test(cas));
  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton fără` } });
  x = rand(CP);
  egal("o bucată din numele unui produs nu e produsul: rămâne text", [x.materie_produs_id, x.materie_text], [null, `${PREFIX} Carton fără`]);
  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton dublat` } });
  x = rand(CP);
  egal("două produse cu același nume: rămâne text, nu se ghicește", [x.materie_produs_id, x.materie_text], [null, `${PREFIX} Carton dublat`]);
  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie_produs_id: String(P_NESTOC), materie: "altceva" } });
  egal("produsul trimis de buton bate textul", Number(rand(CP).materie_produs_id), P_NESTOC);
  cas = caseta((await cer("get", `/productie/${CP}`, MIHAI)).corp);
  bine("un produs din catalog care nu e pe stoc: spune că nu e", /Nu e pe stoc în CT-Park acum\./.test(cas));
  r = await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: "   " } });
  x = rand(CP);
  egal("gol și salvat: fără materie primă", [x.materie_produs_id, x.materie_text, x.materie_aleasa_de, x.materie_aleasa_la], [null, null, null, null]);
  r = await cer("post", `/productie/99999999/materie`, MIHAI, { body: { materie: "x" } });
  egal("comandă inexistentă: înapoi în listă", unde(r), "/productie");

  // ------------------------------------------------------------------------
  console.log("\n3. Furnizorul vine singur doar când nu e nimic de ales");
  q(`UPDATE comenzi_productie SET furnizor_id = NULL, furnizor_text = NULL WHERE id = ${CP}`);
  q(`UPDATE comenzi_linii SET furnizor_id = NULL, furnizor_text = NULL, furnizor_sursa = NULL WHERE comanda_id = ${CMD}`);
  await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton ondulat CO5` } });
  x = rand(CP);
  egal("materia pe stoc de la doi furnizori: furnizorul rămâne de ales", [Number(x.materie_produs_id), x.furnizor_id, x.furnizor_text, linieClient().furnizor_id], [M2, null, null, null]);
  pag = (await cer("get", `/productie/${CP}`, MIHAI)).corp;
  bine("…dar caseta îi propune pe cei de pe stocul materiei alese", /furnizor-sugestii[\s\S]*TMC Carton Unu SRL/.test(pag) && /furnizor-sugestii[\s\S]*TMC Furnizor scris de mână/.test(pag));
  await cer("post", `/productie/${CP_CU_FURNIZOR}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton ondulat CO3` } });
  x = rand(CP_CU_FURNIZOR);
  egal("comanda care avea deja furnizor și-l păstrează", [Number(x.materie_produs_id), Number(x.furnizor_id)], [M1, S2]);
  await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton fără stoc` } });
  egal("materia care nu e pe stoc nu aduce niciun furnizor", [Number(rand(CP).materie_produs_id), rand(CP).furnizor_id], [P_NESTOC, null]);
  // Un singur furnizor știut, dar și un palet fără furnizor scris: nu se poate
  // spune de la cine e materia care va intra în comandă.
  await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `${PREFIX} Hartie kraft` } });
  x = rand(CP);
  egal("un furnizor știut și un palet fără furnizor scris: furnizorul rămâne de ales", [Number(x.materie_produs_id), x.furnizor_id, x.furnizor_text], [M_NESCRIS, null, null]);
  // Comanda din registrul vechi, cu produsul scris de mână: n-are rețetă din
  // care să se afle materialul, deci furnizorii se propun după materia aleasă.
  pag = (await cer("get", `/productie/${CP_SCRIS}`, MIHAI)).corp;
  bine("comanda cu produsul scris de mână, fără materie: niciun furnizor propus", !/furnizor-sugestii[\s\S]*TMC Carton Unu SRL/.test(pag));
  await cer("post", `/productie/${CP_SCRIS}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton ondulat CO5` } });
  pag = (await cer("get", `/productie/${CP_SCRIS}`, MIHAI)).corp;
  bine("…iar după ce își alege materia, îi propune furnizorii de pe stocul ei", /furnizor-sugestii[\s\S]*TMC Carton Unu SRL/.test(pag) && /furnizor-sugestii[\s\S]*TMC Furnizor scris de mână/.test(pag), (pag.match(/furnizor-sugestii[\s\S]{0,300}/) || ["fără sugestii"])[0]);

  // ------------------------------------------------------------------------
  console.log("\n4. Materialele din rețetă, pe stoc");
  cas = caseta((await cer("get", `/productie/${CP_RETETA}`, MIHAI)).corp);
  bine("apar ca butoane, cu cât e pe stoc", /materie-sugestii[\s\S]*name="materie_produs_id" value="97901"[\s\S]*TMC Carton ondulat CO3 <span class="mic">· 1\.000 buc<\/span>/.test(cas), cas.slice(0, 600));
  bine("…doar cele care sunt pe stoc", !/name="materie_produs_id" value="97904"/.test(cas));
  await cer("post", `/productie/${CP_RETETA}/materie`, MIHAI, { body: { materie_produs_id: String(M1) } });
  cas = caseta((await cer("get", `/productie/${CP_RETETA}`, MIHAI)).corp);
  bine("materia deja aleasă nu mai e propusă", !cas.includes("materie-sugestii") && Number(rand(CP_RETETA).materie_produs_id) === M1);

  // ------------------------------------------------------------------------
  console.log("\n5. Necesarul și fișa de lot");
  const nec = (await cer("get", `/productie/${CP}/necesar`, MIHAI)).corp;
  bine("necesarul are aceeași casetă, cu întoarcerea pe el", caseta(nec).includes(`action="/productie/${CP}/materie"`) && caseta(nec).includes(`name="inapoi" value="/productie/${CP}/necesar"`));
  await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: `${PREFIX} Carton ondulat CO3` } });
  let fisa = (await cer("get", `/productie/${CP}/pdf`, MIHAI)).corp;
  bine("fișa de lot arată materia primă, cu codul și furnizorul", /Raw material<div class="mic">Materie primă<\/div><\/th>\s*<td colspan="3">TMC Carton ondulat CO3 \(TMC-CO3\) · supplier \/ furnizor: TMC Carton Unu SRL<\/td>/.test(fisa), (fisa.match(/Raw material[\s\S]{0,200}/) || [""])[0]);
  bine("…iar codul de bare se întinde și peste rândul ei", /class="cod-lot" rowspan="4"/.test(fisa));
  await cer("post", `/productie/${CP}/materie`, MIHAI, { body: { materie: "" } });
  fisa = (await cer("get", `/productie/${CP}/pdf`, MIHAI)).corp;
  bine("fără materie primă, fișa e ca înainte", !/Raw material<div/.test(fisa) && /class="cod-lot" rowspan="3"/.test(fisa));

  // ------------------------------------------------------------------------
  console.log("\n6. Socoteala din spate");
  const stoc = await FC.materiiPeStoc();
  const ale = stoc.filter((m) => PRODUSE.includes(Number(m.produs_id))).map((m) => [Number(m.produs_id), Number(m.cantitate), Number(m.paleti)]);
  egal("materia primă de pe stoc: CO3 (1.000 pe 2 paleți), CO5 (500 pe 2 paleți), hârtia (1.000 pe 2 paleți)", ale, [[M1, 1000, 2], [M2, 500, 2], [M_NESCRIS, 1000, 2]]);
  egal("categoriile din care se alege", FC.CATEGORII_MATERIE, ["materie primă", "produse intermediare"]);
  egal("ce scrie omul → produs: denumire, cod, dublură, necunoscut, gol",
    [await FC.rezolvaMaterie({ materie: "TMC CARTON ONDULAT CO3" }), await FC.rezolvaMaterie({ materie: "TMC-NS" }), await FC.rezolvaMaterie({ materie: "TMC Carton dublat" }), await FC.rezolvaMaterie({ materie: "ceva nou" }), await FC.rezolvaMaterie({ materie: "" })]
      .map((m) => [m.produs_id || null, m.text || null, Boolean(m.gol)]),
    [[M1, null, false], [P_NESTOC, null, false], [null, "TMC Carton dublat", false], [null, "ceva nou", false], [null, null, true]]);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
