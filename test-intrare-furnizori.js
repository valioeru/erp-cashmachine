"use strict";
// Marfa recepționată de la furnizori, în lista de sus din Depozit → Intrare
// marfă, lângă cea gata din producție.
//
// CE A CERUT VALI, 10.11.2026:
//   „La Intrare marfă în CT-Park, la fel ca și comenzile intrate din producție,
//    în lista de sus apar și altele, de la furnizori, imediat după ce au fost
//    recepționate, ca să poată fi alocate pe raft."
//
// CE APĂRĂ:
//   • LISTA: rândurile recepțiilor FINALIZATE de la furnizori (și ale
//     retururilor), primite în stare bună, cât timp marfa lor n-are palet. Nu:
//     recepția încă nenumărată, marfa deteriorată sau respinsă, rândul pus tot
//     pe paleți, rândul scos din listă cu motiv.
//   • PAGINA: titlul „Recepționat de la furnizori — de alocat", furnizorul și
//     documentul pe fiecare rând, aceleași butoane ca la producție; lista din
//     producție rămâne cum era, cu trimitere spre ce e mai jos.
//   • PE RAFT: Intrarea se deschide completată, cu furnizorul recepției.
//   • RECEPȚIA DE LA FURNIZOR NENUMĂRATĂ NU SE IA PE CUVÂNT: butonul n-o
//     finalizează singur, cum face cu cea din producție.
//   • PE CANTITĂȚI: o parte la client, o parte pe raft; restul rămâne în listă.
//   • „NU MAI E DE ALOCAT" scoate rândul, cu motiv.
//   • PALEȚII CU ETICHETĂ, FĂRĂ LOC: făcuți la recepție, apar dedesubt cu
//     „Pune pe raft"; nu și cei cu loc, nici cei pregătiți pentru ieșire.
//   • SCANERUL arată aceleași rânduri (o singură regulă).
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
const P1 = 96101, P2 = 96102, P3 = 96103, P4 = 96104;
const CLIENT = 96111, FURNIZOR = 96112;
const CMD = 96121;
const PREFIX = "TIF";
const PRODUSE = [P1, P2, P3, P4];

function curata() {
  const pr = PRODUSE.join(",");
  const rec = q(`SELECT id FROM receptii WHERE numar LIKE '${PREFIX}-%'`).map((x) => Number(x.id));
  const r = rec.join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE receptie_id IN (${r}) OR produs_id IN (${pr})`).map((x) => Number(x.id));
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
  q(`DELETE FROM aprovizionari WHERE produs_id IN (${pr})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${pr})`);
  try { q(`DELETE FROM comenzi_istoric WHERE comanda_id = ${CMD}`); } catch (_) { /* tabela poate lipsi */ }
  q(`DELETE FROM comenzi_linii WHERE comanda_id = ${CMD}`);
  q(`DELETE FROM comenzi WHERE id = ${CMD}`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM interactiuni WHERE partener_id IN (${CLIENT}, ${FURNIZOR})`);
  q(`DELETE FROM parteneri WHERE id IN (${CLIENT}, ${FURNIZOR})`);
}
function locLiber(afara) {
  return q(`SELECT l.id, l.rand_id, l.adresa FROM ct_locuri l JOIN ct_randuri rr ON rr.id = l.rand_id AND rr.activ = 1
             WHERE COALESCE(l.blocat, 0) = 0
               AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
               AND l.id NOT IN (${(afara || []).join(",") || 0})
             ORDER BY l.id LIMIT 1`)[0];
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
let nrPalet = 0;
// Un palet legat de un rând de recepție; cu loc, dacă se dă unul.
function palet(receptie, linie, produs, cant, um, { loc, plan } = {}) {
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, data_intrare, receptie_id, receptie_linie_id, iesire_plan)
     VALUES ('${PREFIX}-PAL-${++nrPalet}', ${produs}, ${cant}, '${um}', '${azi()}', ${receptie}, ${linie}, ${plan ? "'" + plan + "'" : "NULL"}) RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (${id}, ${produs}, ${cant}, '${um}')`);
  if (loc) q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${id}, ${loc})`);
  return id;
}
function receptie(numar, sursa, stare, { partener, comanda, document } = {}) {
  return Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, comanda_id, document_extern, data, stare, finalizata_la)
     VALUES ('${PREFIX}-${numar}', '${sursa}', ${partener || "NULL"}, ${comanda || "NULL"}, ${document ? "'" + document + "'" : "NULL"}, '${azi()}', '${stare}', ${stare === "finalizata" ? "'" + azi() + " 10:00:00'" : "NULL"}) RETURNING id`));
}
function linie(rid, produs, asteptat, primit, um, stare, conditie) {
  return Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie)
     VALUES (${rid}, ${produs}, ${asteptat}, ${primit == null ? "NULL" : primit}, '${um}', '${stare}', ${conditie ? "'" + conditie + "'" : "NULL"}) RETURNING id`));
}
const sectiunea = (html) => { const i = html.indexOf('id="gata-productie"'); return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i)); };
const bucata = (html, id, pana) => { const i = html.indexOf(`id="${id}"`); if (i < 0) return ""; const j = pana ? html.indexOf(`id="${pana}"`, i) : -1; return html.slice(i, j > i ? j : html.length); };
const randul = (html, lid) => { const i = html.indexOf(`/gata/receptie/${lid}/raft`); if (i < 0) return ""; const a = html.lastIndexOf("<tr>", i); return html.slice(a, html.indexOf("</tr>", i)); };

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: "Om Depozit", rol: "depozit", sectiuni: "" };
  const AGENT = { id: idUser, nume: "Agent", rol: "vanzari", sectiuni: "/crm" };

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${CLIENT}, 'client', '${PREFIX} Client SRL'), (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor Carton SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (${P1}, 'TIF-1', '${PREFIX} Carton CO3', 'buc'), (${P2}, 'TIF-2', '${PREFIX} Folie jumbo', 'kg'),
       (${P3}, 'TIF-3', '${PREFIX} Banda', 'buc'), (${P4}, 'TIF-4', '${PREFIX} Pungi', 'buc')`);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD}, ${CLIENT}, '${PREFIX}-CMD-1', '${azi()}', 'confirmata')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${CMD}, ${P1}, 100, 1)`);

  // Recepția de la furnizor, numărată și finalizată.
  const R_FIN = receptie("REC-1", "furnizor", "finalizata", { partener: FURNIZOR, comanda: CMD, document: "FACT 123" });
  const L1 = linie(R_FIN, P1, 500, 480, "buc", "primita", "bun"); // 480 venite; 80 deja pe raft
  const L2 = linie(R_FIN, P2, 200, 200, "kg", "primita", "deteriorat"); // marfă deteriorată
  const L3 = linie(R_FIN, P3, 50, 50, "buc", "respinsa", null); // numărată, apoi respinsă
  const L4 = linie(R_FIN, P4, 60, 60, "buc", "primita", "bun"); // toată pe un palet cu etichetă, fără loc
  const loc1 = locLiber([]);
  const PAL_RAFT = palet(R_FIN, L1, P1, 80, "buc", { loc: loc1.id });
  const PAL_FARA_LOC = palet(R_FIN, L4, P4, 60, "buc");
  // Recepția de la furnizor încă în numărare.
  const R_NENUM = receptie("REC-2", "furnizor", "in_lucru", { partener: FURNIZOR });
  const L5 = linie(R_NENUM, P3, 300, null, "buc", "de_primit", null);
  // …cu un rând deja numărat: nu apare până nu se finalizează toată recepția.
  const L5B = linie(R_NENUM, P1, 20, 20, "buc", "primita", "bun");
  // Un retur de la client, finalizat.
  const R_RETUR = receptie("REC-3", "retur_tert", "finalizata", { partener: CLIENT });
  const L6 = linie(R_RETUR, P3, 12, 12, "buc", "primita", "bun");
  // Un rând scos din listă de depozit, cu motiv.
  const R_INCHIS = receptie("REC-4", "furnizor", "finalizata", { partener: FURNIZOR });
  const L7 = linie(R_INCHIS, P2, 30, 30, "kg", "primita", "bun");
  q(`UPDATE receptii_linii SET ct_inchis_la = '${azi()} 09:00:00', ct_inchis_de = 'Cineva', ct_motiv = 'e deja pe raft' WHERE id = ${L7}`);
  // Și una din producție, anunțată: lista ei rămâne cum era.
  const R_PROD = receptie("REC-5", "productie", "asteptata", {});
  const L8 = linie(R_PROD, P4, 40, null, "buc", "de_primit", null);

  // ------------------------------------------------------------------------
  console.log("1. Ce intră în listă");
  const ale = (lista) => lista.filter((x) => [L1, L2, L3, L4, L5, L5B, L6, L7, L8].includes(x.id));
  let fz = ale(await GP.receptiiFurnizori());
  egal("rândurile de la furnizori: cartonul (400 rămase din 480) și returul (12)", fz.map((x) => [x.id, x.ramas, x.um, x.cantitate, x.pus]), [[L1, 400, "buc", 480, 80], [L6, 12, "buc", 12, 0]]);
  egal("…cu sursa, furnizorul, documentul și comanda pe ele", fz.map((x) => [x.sursa, x.sursa_text, x.partener, x.document, x.comanda_numar, x.client]),
    [["furnizor", "de la furnizor", `${PREFIX} Furnizor Carton SRL`, "FACT 123", `${PREFIX}-CMD-1`, `${PREFIX} Client SRL`], ["retur_tert", "retur de la client", `${PREFIX} Client SRL`, "", "", ""]]);
  egal("…numărate, cu starea lor și data finalizării", fz.map((x) => [x.fel, x.cheie, x.numarata, x.stare, x.data]), [["receptie", "r" + L1, true, "recepționată, de alocat", azi()], ["receptie", "r" + L6, true, "recepționată, de alocat", azi()]]);
  bine("nu: marfa deteriorată, cea respinsă, rândul pus tot pe paleți, recepția nefinalizată (nici rândul ei deja numărat), rândul scos din listă", ![L2, L3, L4, L5, L5B, L7].some((id) => fz.some((x) => x.id === id)));
  bine("lista din producție nu le amestecă: are doar recepția din producție", ale(await GP.lista()).map((x) => x.id).join() === String(L8), ale(await GP.lista()).map((x) => x.id).join());
  egal("rândul se găsește după linie, oricare i-ar fi sursa", [(await GP.randReceptie(L1)).ramas, (await GP.randReceptie(L8)).ramas, await GP.randReceptie(L5), await GP.randReceptie(0)], [400, 40, null, null]);

  // ------------------------------------------------------------------------
  console.log("\n2. Pagina Intrare marfă");
  let pag = (await cer("get", "/stocuri/ct-park/intrare", DEP)).corp;
  let sec = sectiunea(pag);
  const nFz = (await GP.receptiiFurnizori()).length;
  bine("titlul listei de la furnizori, cu numărul de rânduri", sec.includes(`Recepționat de la furnizori — de alocat <span class="badge galben">${nFz}</span>`), (sec.match(/Recepționat de la furnizori[^<]*<span[^>]*>\d+<\/span>/) || ["lipsește"])[0]);
  bine("…și explicația: apar imediat ce recepția e finalizată", /apar aici imediat ce recepția lor e finalizată/.test(sec));
  bine("lista din producție e tot prima, cu titlul ei", sec.indexOf("Gata din producție — de alocat") >= 0 && sec.indexOf("Gata din producție — de alocat") < sec.indexOf('id="de-la-furnizori"'));
  bine("…și trimite spre ce e mai jos", new RegExp(`Tot aici, mai jos: <a href="#de-la-furnizori">de la furnizori \\(${nFz}\\)</a>`).test(sec) && /<a href="#fara-loc">paleți fără loc pe raft \(\d+\)<\/a>/.test(sec), (sec.match(/Tot aici, mai jos:[^<]*(<a[^>]*>[^<]*<\/a>[^<]*)*/) || ["lipsește"])[0]);
  const furn = bucata(sec, "de-la-furnizori", "fara-loc");
  let r1 = randul(furn, L1);
  bine("rândul cartonului: produsul, codul și cât e de alocat", r1.includes(`<strong>${PREFIX} Carton CO3</strong>`) && r1.includes("TIF-1") && r1.includes("<strong>400 buc</strong>") && r1.includes("din 480; alocat deja 80"), r1.slice(0, 300));
  bine("…de unde: recepția, „de la furnizor”, numele lui și documentul", r1.includes(`/depozit/receptie/${R_FIN}`) && r1.includes(`de la furnizor <strong>${PREFIX} Furnizor Carton SRL</strong>`) && r1.includes("FACT 123"), r1.slice(r1.indexOf("recepția"), r1.indexOf("recepția") + 260));
  bine("…pentru cine: comanda clientului de pe recepție", r1.includes(`/comenzi/${CMD}`) && r1.includes(`${PREFIX} Client SRL`));
  bine("…cu aceleași butoane ca la producție", r1.includes(`action="/stocuri/ct-park/gata/receptie/${L1}/raft"`) && r1.includes(`action="/stocuri/ct-park/gata/receptie/${L1}/aloca"`) && r1.includes(`action="/stocuri/ct-park/gata/receptie/${L1}/inchide"`) && r1.includes("Pune pe raft →"));
  bine("…și starea „recepționată, de alocat”", r1.includes("recepționată, de alocat"));
  bine("returul scrie de unde vine", randul(furn, L6).includes(`retur de la client <strong>${PREFIX} Client SRL</strong>`), randul(furn, L6).slice(0, 200));
  bine("recepția nefinalizată și rândul scos din listă nu apar nicăieri în casetă", !sec.includes(`/gata/receptie/${L5}/`) && !sec.includes(`/gata/receptie/${L5B}/`) && !sec.includes(`/gata/receptie/${L7}/`) && !sec.includes(`/gata/receptie/${L2}/`) && !sec.includes(`/gata/receptie/${L3}/`));
  bine("recepția din producție e în lista ei, nu la furnizori", randul(bucata(sec, "gata-productie", "de-la-furnizori"), L8).includes("gata în producție") && !furn.includes(`/gata/receptie/${L8}/`));

  // Fără nimic din producție, caseta tot apare: marfa de la furnizori nu
  // depinde de lista de deasupra ei.
  const [listaVeche, pregatiteVechi] = [GP.lista, GP.pregatite];
  GP.lista = async () => [];
  GP.pregatite = async () => [];
  const faraProductie = sectiunea((await cer("get", "/stocuri/ct-park/intrare", DEP)).corp);
  GP.lista = listaVeche;
  GP.pregatite = pregatiteVechi;
  bine("fără nimic din producție, lista de la furnizori și paleții fără loc tot apar", faraProductie.includes('id="de-la-furnizori"') && faraProductie.includes(`/gata/receptie/${L1}/raft`) && faraProductie.includes('id="fara-loc"') && /Nimic de alocat acum/.test(faraProductie), faraProductie.slice(0, 200) || "caseta lipsește");

  // ------------------------------------------------------------------------
  console.log("\n3. Paleții cu etichetă, fără loc pe raft");
  const fl = bucata(sec, "fara-loc", "pregatite");
  bine("paletul făcut la recepție apare, cu produsul, cantitatea și de unde e", fl.includes(`${PREFIX}-PAL-2`) && fl.includes(`<strong>${PREFIX} Pungi</strong>`) && fl.includes("<strong>60 buc</strong>") && fl.includes("de la furnizor") && fl.includes(`/depozit/receptie/${R_FIN}`), fl.slice(0, 400));
  bine("…cu „Pune pe raft”, care deschide paletul cu locurile propuse", fl.includes(`href="/stocuri/ct-park/scaner/intrare/palet/${PAL_FARA_LOC}"`) && fl.includes("Pune pe raft →") && fl.includes(`/stocuri/ct-park/etichete?paleti=${PAL_FARA_LOC}`));
  bine("paletul care are loc nu apare", !fl.includes(`${PREFIX}-PAL-1`) && !fl.includes(`/scaner/intrare/palet/${PAL_RAFT}"`));
  const pagPalet = await cer("get", `/stocuri/ct-park/scaner/intrare/palet/${PAL_FARA_LOC}`, DEP);
  bine("pagina paletului se deschide și spune că n-are loc", pagPalet.cod === 200 && pagPalet.corp.includes(`${PREFIX}-PAL-2`) && /Fără loc pe raft/.test(pagPalet.corp), pagPalet.cod);

  // ------------------------------------------------------------------------
  console.log("\n4. „Pune pe raft”");
  let r = await cer("post", `/stocuri/ct-park/gata/receptie/${L1}/raft`, DEP);
  egal("deschide Intrarea pe rândul recepției", unde(r), `/stocuri/ct-park/intrare?receptie_linie=${L1}`);
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L1) } })).corp;
  bine("Intrarea e completată: recepția, produsul, cât a venit și cât mai e de pus", pag.includes(`${PREFIX}-REC-1`) && pag.includes(`<strong>${PREFIX} Carton CO3</strong>`) && /au venit 480 buc/.test(pag) && /de pus acum: <strong>400 buc<\/strong>/.test(pag), (pag.match(/Din recepția[\s\S]{0,300}/) || ["lipsește"])[0]);
  bine("…cu furnizorul recepției ales", new RegExp(`<option value="${FURNIZOR}" selected>`).test(pag));
  bine("…și fără lista de sus (ești deja pe un rând)", !pag.includes('id="gata-productie"'));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L5}/raft`, DEP);
  bine("recepția de la furnizor nenumărată: refuzat, cu ce e de făcut", unde(r).startsWith("/stocuri/ct-park/intrare?gata_eroare=") && /nu e încă numărată/.test(parametri(r).gata_eroare || "") && (parametri(r).gata_eroare || "").includes(`${PREFIX}-REC-2`), unde(r));
  egal("…și NU se finalizează singură, cum face cea din producție", [unul(`SELECT stare FROM receptii WHERE id = ${R_NENUM}`), unul(`SELECT stare FROM receptii_linii WHERE id = ${L5}`), unul(`SELECT cantitate_primita FROM receptii_linii WHERE id = ${L5}`)], ["in_lucru", "de_primit", null]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L8}/raft`, DEP);
  egal("cea din producție se ia tot cum a fost anunțată", [unde(r), unul(`SELECT stare FROM receptii WHERE id = ${R_PROD}`)], [`/stocuri/ct-park/intrare?receptie_linie=${L8}`, "finalizata"]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/99999999/raft`, DEP);
  bine("rând inexistent: mesaj, nu eroare", /Rândul de recepție nu există/.test(parametri(r).gata_eroare || ""), unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L1}/raft`, AGENT);
  egal("cine n-are Intrarea marfă nu folosește butonul", unde(r), "/stocuri/ct-park");

  // ------------------------------------------------------------------------
  console.log("\n5. „Alocă pe cantități”");
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L1}/aloca`, DEP, { body: { q_client: "100", comanda_id: String(CMD), q_raft: "50" } });
  egal("partea de raft deschide Intrarea cu cantitatea ei", unde(r), `/stocuri/ct-park/intrare?receptie_linie=${L1}&cantitate=50`);
  const pl = q(`SELECT cantitate, iesire_plan, iesire_comanda_id, furnizor_id FROM ct_paleti WHERE receptie_linie_id = ${L1} AND iesire_plan IS NOT NULL`);
  egal("partea pentru client are paletul ei, pe comandă, cu furnizorul recepției", pl.map((x) => [Number(x.cantitate), x.iesire_plan, Number(x.iesire_comanda_id), Number(x.furnizor_id)]), [[100, "comanda", CMD, FURNIZOR]]);
  egal("în listă rămân 300 (partea de raft nu e încă pusă)", (await GP.randReceptie(L1)).ramas, 300);
  pag = (await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(L1), cantitate: "50" } })).corp;
  bine("Intrarea spune că restul rămâne de alocat (nu „în Gata din producție”)", /Pe raft pui acum <strong>50 buc<\/strong>; restul rămâne de alocat, în lista de sus din Intrare marfă/.test(pag), (pag.match(/Pe raft pui acum[\s\S]{0,120}/) || ["lipsește"])[0]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L1}/aloca`, DEP, { body: { q_fulfillment: "1000" } });
  bine("mai mult decât a rămas: refuzat", /sunt de alocat doar 300 buc/.test(parametri(r).gata_eroare || ""), unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L5}/aloca`, DEP, { body: { q_raft: "10" } });
  bine("recepția nenumărată nu se alocă nici pe cantități", /nu e încă numărată/.test(parametri(r).gata_eroare || ""), unde(r));
  sec = sectiunea((await cer("get", "/stocuri/ct-park/intrare", DEP)).corp);
  bine("paletul pentru client e jos, la „Pregătite pentru ieșire”, nu la paleții fără loc", bucata(sec, "pregatite").includes(`${PREFIX} Carton CO3`) && !bucata(sec, "fara-loc", "pregatite").includes(`${PREFIX} Carton CO3`));

  // ------------------------------------------------------------------------
  console.log("\n6. Iese din listă");
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L6}/inchide`, DEP, { body: { motiv: "pus de mână pe R1" } });
  bine("„Nu mai e de alocat”, cu motiv: returul iese din listă", /a ieșit din listă/.test(parametri(r).gata_ok || "") && !(await GP.receptiiFurnizori()).some((x) => x.id === L6), unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${L1}/inchide`, DEP, { body: { motiv: "x" } });
  bine("fără motiv adevărat nu se scoate", /Scrie de ce/.test(parametri(r).gata_eroare || "") && (await GP.receptiiFurnizori()).some((x) => x.id === L1), unde(r));
  const loc2 = locLiber([loc1.id]);
  palet(R_FIN, L1, P1, 300, "buc", { loc: loc2.id });
  bine("rândul pus tot pe paleți iese singur", !(await GP.receptiiFurnizori()).some((x) => x.id === L1));
  q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${PAL_FARA_LOC}, ${locLiber([loc1.id, loc2.id]).id})`);
  sec = sectiunea((await cer("get", "/stocuri/ct-park/intrare", DEP)).corp);
  bine("paletul care și-a primit locul iese din „fără loc”", !sec.includes(`/scaner/intrare/palet/${PAL_FARA_LOC}"`));
  bine("fără nimic de la furnizori, titlul lor nu mai apare pentru rândurile testului", !sec.includes(`${PREFIX} Furnizor Carton SRL`) && !sec.includes(`/gata/receptie/${L1}/`) && !sec.includes(`/gata/receptie/${L6}/`));

  // ------------------------------------------------------------------------
  console.log("\n7. Scanerul arată aceleași rânduri");
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (SELECT id FROM ct_paleti WHERE receptie_linie_id = ${L1})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (SELECT id FROM ct_paleti WHERE receptie_linie_id = ${L1})`);
  q(`DELETE FROM ct_paleti WHERE receptie_linie_id = ${L1}`);
  const SCAN = require(path.join(RAD, "lib", "ct-scaner.js"));
  const sc = (await SCAN.deAsezat("furnizor")).filter((x) => x.id === L1 || x.id === L5 || x.id === L6);
  egal("în scaner, la „De la furnizor”: cartonul întreg, cu recepția și furnizorul", sc.map((x) => [x.cheie, x.ramas, x.sursa, x.detaliu]), [["r" + L1, 480, "furnizor", `recepția ${PREFIX}-REC-1 · ${PREFIX} Furnizor Carton SRL`]]);
  egal("…aceeași cantitate ca în lista din Intrare marfă", (await GP.randReceptie(L1)).ramas, 480);
  bine("…iar la „Din producție” nu apare", !(await SCAN.deAsezat("productie")).some((x) => x.id === L1));

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
