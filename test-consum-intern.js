"use strict";
// Ieșirea din CT-Park pentru consum intern — și transferul parțial în fulfillment.
//
// CE A CERUT VALI, 10.11.2026:
//   „Trebuie pusă și varianta când scoți pentru depozit, pentru consum intern,
//    caz în care spui un motiv pentru ce ai scos și persoana care a solicitat."
//
// CE APĂRĂ:
//   • A PATRA DESTINAȚIE, „Consum intern", în toate cele trei locuri din care se
//     scoate marfă: Ieșire marfă (paletul întreg), „Scoate marfă de pe palet"
//     din fișa paletului (o parte) și scanerul (întreg sau o parte).
//   • MOTIVUL ȘI PERSOANA SUNT OBLIGATORII la consum intern: fără oricare din
//     ele nu iese nimic. La celelalte destinații nu se scriu, orice ar veni.
//   • RĂMÂN SCRISE pe ieșire și se văd: în fișa paletului, pe eticheta de
//     ieșire, în mesajul de după și în lista Depozit → Consum intern (cu marfa,
//     cantitatea, cine a scos și costul; filtru pe lună).
//   • FORMULARELE NU SE BLOCHEAZĂ: câmpurile de consum sunt obligatorii doar
//     când destinația e „Consum intern" — ascunse și obligatorii, ar opri
//     orice altă ieșire din depozit.
//   • TRANSFERUL PARȚIAL ÎN FULFILLMENT (găsit pe 10.11.2026): scădea doar
//     antetul paletului, nu și linia lui, deci Stoc la zi număra în continuare
//     marfa plecată, și nu lăsa nicio ieșire. Acum e o ieșire parțială obișnuită.
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
for (const m of ["gata-productie", "ct-scaner", "ct-park", "warehouse", "receptie", "fulfillment"]) require(path.join(RAD, "modules", m + ".js")).register(router);
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
const PREFIX = "TCI";
const P1 = 98101, P2 = 98102, P3 = 98103, P4 = 98104, P5 = 98105;
const PRODUSE = [P1, P2, P3, P4, P5];
const BAZA = "/stocuri/ct-park/scaner";

function curata() {
  const pr = PRODUSE.join(",");
  const pal = q(`SELECT id FROM ct_paleti WHERE produs_id IN (${pr}) OR cod LIKE '${PREFIX}-%'`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_tipar WHERE creat_de IN ('TCI Depozit', 'TCI Altul')`);
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_adaugari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ff_miscari WHERE produs_id IN (${pr})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
}
const azi = () => new Date().toISOString().slice(0, 10);
let nrPalet = 0;
// Un palet cu linia lui; `linii` = alte produse pe același palet.
function palet(produs, cant, um, pret, { linii, data } = {}) {
  const id = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare, pret_unitar, pret_sursa)
     VALUES ('${PREFIX}-PAL-${++nrPalet}', ${linii ? "NULL" : produs}, ${cant}, ${cant}, '${um}', '${data || "2026-11-01"}', ${pret}, 'scris la intrare') RETURNING id`));
  q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar) VALUES (${id}, ${produs}, (SELECT denumire FROM produse WHERE id = ${produs}), ${cant}, '${um}', ${pret})`);
  for (const [p2, c2] of linii || []) q(`INSERT INTO ct_palet_linii (palet_id, produs_id, produs_text, cantitate, um, pret_unitar) VALUES (${id}, ${p2}, (SELECT denumire FROM produse WHERE id = ${p2}), ${c2}, '${um}', ${pret})`);
  return id;
}
const stare = (id) => q(`SELECT cantitate, cantitate_intrare, data_iesire FROM ct_paleti WHERE id = ${id}`).map((x) => [x.cantitate == null ? null : Number(x.cantitate), Number(x.cantitate_intrare), x.data_iesire ? "iesit" : "in depozit"])[0];
const linia = (id) => q(`SELECT cantitate FROM ct_palet_linii WHERE palet_id = ${id} ORDER BY id`).map((x) => Number(x.cantitate));
const iesiri = (id) => q(`SELECT destinatie, partiala, consum_motiv, consum_solicitant, creat_de, cost FROM ct_iesiri WHERE palet_id = ${id} ORDER BY id`).map((x) => [x.destinatie, Number(x.partiala), x.consum_motiv, x.consum_solicitant, x.creat_de, x.cost == null ? null : Number(x.cost)]);
const liniiIesiri = (id) => q(`SELECT il.cantitate, il.cantitate_ramasa FROM ct_iesiri_linii il JOIN ct_iesiri i ON i.id = il.iesire_id WHERE i.palet_id = ${id} ORDER BY il.id`).map((x) => [Number(x.cantitate), Number(x.cantitate_ramasa)]);
const fara = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: "TCI Depozit", rol: "depozit", sectiuni: "" };
  const AGENT = { id: idUser, nume: "TCI Agent", rol: "vanzari", sectiuni: "/crm" };
  const CT = require(path.join(RAD, "modules", "ct-park.js"));
  const W = require(path.join(RAD, "modules", "warehouse.js"));
  const AUTH = require(path.join(RAD, "lib", "auth.js"));

  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES
       (${P1}, '${PREFIX}-1', '${PREFIX} Folie stretch manuala', 'buc'), (${P2}, '${PREFIX}-2', '${PREFIX} Banda adeziva', 'buc'),
       (${P3}, '${PREFIX}-3', '${PREFIX} Granula', 'kg'), (${P4}, '${PREFIX}-4', '${PREFIX} Punga curier', 'buc'), (${P5}, '${PREFIX}-5', '${PREFIX} Eticheta', 'buc')`);
  const PA = palet(P1, 100, "buc", 2);
  const PB = palet(P2, 100, "buc", 3);
  const PC = palet(P3, 50, "kg", 4);
  const PD = palet(P4, 100, "buc", 0.5);
  const PE = palet(P4, 40, "buc", 0.5, { linii: [[P5, 10]], data: "2026-11-02" });

  // ------------------------------------------------------------------------
  console.log("1. Ce se cere la consum intern");
  egal("la altă destinație nu se scrie nimic, orice ar veni", [CT.consumIntern({ consum_motiv: "x y z", consum_solicitant: "Ion" }, "productie"), CT.consumIntern({}, "comanda"), CT.consumIntern(null, "fulfillment")],
    [{ motiv: null, solicitant: null }, { motiv: null, solicitant: null }, { motiv: null, solicitant: null }]);
  egal("fără motiv, cu motiv prea scurt, fără persoană, cu o singură literă", [
    CT.consumIntern({ consum_solicitant: "Ion Pop" }, "consum").eroare, CT.consumIntern({ consum_motiv: " ab ", consum_solicitant: "Ion Pop" }, "consum").eroare,
    CT.consumIntern({ consum_motiv: "pentru ambalat" }, "consum").eroare, CT.consumIntern({ consum_motiv: "pentru ambalat", consum_solicitant: " I " }, "consum").eroare, CT.consumIntern(null, "consum").eroare,
  ], ["La consum intern scrie pentru ce s-a scos marfa.", "La consum intern scrie pentru ce s-a scos marfa.", "La consum intern scrie cine a cerut marfa.", "La consum intern scrie cine a cerut marfa.", "La consum intern scrie pentru ce s-a scos marfa."]);
  egal("textele se curăță de spații și se scurtează", (({ motiv, solicitant }) => [CT.consumIntern({ consum_motiv: "  pentru   ambalat \n paleți ", consum_solicitant: "  Ion   Pop " }, "consum"), motiv.length, solicitant.length])(CT.consumIntern({ consum_motiv: "m".repeat(500), consum_solicitant: "s".repeat(500) }, "consum")),
    [{ motiv: "pentru ambalat paleți", solicitant: "Ion Pop" }, 300, 120]);
  egal("cele patru destinații, cu „Consum intern” a patra", CT.DESTINATII.map((d) => d[0]), ["productie", "fulfillment", "comanda", "consum"]);
  egal("…și numele ei", CT.etichetaDestinatie("consum"), "Consum intern");

  // ------------------------------------------------------------------------
  console.log("\n2. Ieșire marfă: paletul întreg");
  const scoate = (body) => cer("post", "/stocuri/ct-park/iesire", DEP, { body });
  let r = await scoate({ paleti: String(PA), destinatie: "consum", consum_solicitant: "Ion Pop" });
  egal("fără motiv: nu iese nimic", [parametri(r).eroare, stare(PA)[2], iesiri(PA).length], ["La consum intern scrie pentru ce s-a scos marfa.", "in depozit", 0]);
  r = await scoate({ paleti: String(PA), destinatie: "consum", consum_motiv: "folie pentru înfoliat paleții" });
  egal("fără persoana care a cerut: nu iese nimic", [parametri(r).eroare, stare(PA)[2], iesiri(PA).length], ["La consum intern scrie cine a cerut marfa.", "in depozit", 0]);
  r = await scoate({ paleti: String(PA), destinatie: "altundeva", consum_motiv: "folie", consum_solicitant: "Ion Pop" });
  egal("o destinație necunoscută: mesajul le numește pe toate patru", [parametri(r).eroare, stare(PA)[2]], ["Alege unde se duce marfa: producție, fulfillment, comandă sau consum intern.", "in depozit"]);
  r = await scoate({ paleti: String(PA), destinatie: "consum", consum_motiv: "  folie pentru   înfoliat paleții ", consum_solicitant: " Ion Pop ", observatii: "luat de la poartă" });
  egal("cu amândouă: paletul iese, se deschid etichetele", [unde(r), stare(PA)[2]], [`/stocuri/ct-park/etichete?paleti=${PA}`, "iesit"]);
  egal("pe ieșire rămân destinația, motivul, persoana, cine a scos și costul", iesiri(PA), [["consum", 0, "folie pentru înfoliat paleții", "Ion Pop", "TCI Depozit", 200]]);
  r = await scoate({ paleti: String(PC), destinatie: "productie", consum_motiv: "n-ar trebui să rămână", consum_solicitant: "Nimeni" });
  egal("la producție, câmpurile de consum nu se scriu, chiar dacă vin în formular", [stare(PC)[2], iesiri(PC)], ["iesit", [["productie", 0, null, null, "TCI Depozit", 200]]]);

  // ------------------------------------------------------------------------
  console.log("\n3. Fișa paletului: o parte din palet");
  const linieB = Number(unul(`SELECT id FROM ct_palet_linii WHERE palet_id = ${PB}`));
  const scoateParte = (body) => cer("post", `/stocuri/ct-park/palet/${PB}/scoate-partial`, DEP, { body });
  r = await scoateParte({ destinatie: "consum", [`pleaca_${linieB}`]: "30", [`ramane_${linieB}`]: "70", consum_motiv: "bandă pentru cutiile de arhivă" });
  egal("fără persoana care a cerut: nimic scos", [parametri(r).eroare, linia(PB), iesiri(PB).length], ["La consum intern scrie cine a cerut marfa.", [100], 0]);
  r = await scoateParte({ destinatie: "consum", [`pleaca_${linieB}`]: "30", [`ramane_${linieB}`]: "70", consum_solicitant: "Maria Ene" });
  egal("fără motiv: nimic scos", [parametri(r).eroare, linia(PB), iesiri(PB).length], ["La consum intern scrie pentru ce s-a scos marfa.", [100], 0]);
  r = await scoateParte({ destinatie: "consum", [`pleaca_${linieB}`]: "30", [`ramane_${linieB}`]: "70", consum_motiv: "bandă pentru cutiile de arhivă", consum_solicitant: "Maria Ene" });
  bine("cu amândouă: mesajul spune unde a plecat și la cererea cui", /^A plecat 30 buc TCI Banda adeziva spre consum intern, cerut de Maria Ene\. Pe palet rămân 70 buc; paletul stă pe loc\.$/.test(parametri(r).ok || ""), parametri(r).ok || parametri(r).eroare);
  egal("paletul rămâne în depozit cu 70; cu cât a intrat nu se schimbă", [stare(PB), linia(PB)], [[70, 100, "in depozit"], [70]]);
  egal("ieșirea parțială are motivul, persoana și costul părții plecate", [iesiri(PB), liniiIesiri(PB)], [[["consum", 1, "bandă pentru cutiile de arhivă", "Maria Ene", "TCI Depozit", 90]], [[30, 70]]]);

  // ------------------------------------------------------------------------
  console.log("\n4. Scanerul");
  const peScaner = (id, body) => cer("post", `${BAZA}/iesire/palet/${id}`, DEP, { body });
  r = await peScaner(PB, { destinatie: "consum", q: "20", consum_motiv: "bandă pentru birou", observatii: "din raftul de jos" });
  egal("fără persoană: înapoi pe paginа paletului, cu ce a scris omul", [new URL(unde(r), "http://x").pathname, parametri(r).eroare, parametri(r).consum_motiv, parametri(r).q, parametri(r).destinatie, linia(PB)],
    [`${BAZA}/iesire/palet/${PB}`, "La consum intern scrie cine a cerut marfa.", "bandă pentru birou", "20", "consum", [70]]);
  let pag = await cer("get", `${BAZA}/iesire/palet/${PB}`, DEP, { query: parametri(r) });
  bine("pagina întoarsă păstrează motivul scris și are câmpul pentru persoană", /name="consum_motiv"[^>]*value="bandă pentru birou"/.test(pag.corp) && /name="consum_solicitant"[^>]*value=""/.test(pag.corp) && /id="sc-consum"/.test(pag.corp));
  bine("…și „Consum intern” printre destinații, aleasă", /name="destinatie" value="consum" required checked>Consum intern/.test(pag.corp), (pag.corp.match(/value="consum"[^>]*>[^<]*/) || [])[0]);
  r = await peScaner(PB, { destinatie: "consum", q: "20", consum_motiv: "bandă pentru birou", consum_solicitant: "Dan Luca" });
  bine("o parte, cu amândouă: mesajul scanerului", new URL(unde(r), "http://x").pathname === `${BAZA}/iesire/gata` && /A plecat 20 buc TCI Banda adeziva spre consum intern, cerut de Dan Luca\./.test(parametri(r).ok || ""), unde(r));
  egal("a doua ieșire parțială, cu persoana ei", [linia(PB), iesiri(PB).slice(-1)], [[50], [["consum", 1, "bandă pentru birou", "Dan Luca", "TCI Depozit", 60]]]);
  r = await peScaner(PB, { destinatie: "consum", consum_motiv: "restul, pentru inventar", consum_solicitant: "Dan Luca" });
  bine("tot restul: paletul iese, mesajul spune la cererea cui", /a ieșit spre consum intern, cerut de Dan Luca\./.test(parametri(r).ok || "") && stare(PB)[2] === "iesit", parametri(r).ok);
  egal("eticheta de ieșire e la tipărit, cu destinația în titlu", q(`SELECT titlu, url FROM ct_tipar WHERE creat_de = 'TCI Depozit' ORDER BY id DESC LIMIT 1`).map((x) => [/consum intern, cerut de Dan Luca/.test(x.titlu), x.url]), [[true, `/stocuri/ct-park/etichete?paleti=${PB}`]]);

  // ------------------------------------------------------------------------
  console.log("\n5. Unde se văd");
  pag = await cer("get", `/stocuri/ct-park/palet/${PA}`, DEP);
  bine("fișa paletului: ieșirea, cu pentru ce, cine a cerut și cine a scos", /→ Consum intern/.test(pag.corp) && /Pentru: folie pentru înfoliat paleții · cerut de <strong>Ion Pop<\/strong> · scos de TCI Depozit/.test(pag.corp), (pag.corp.match(/Ieșire:<\/strong>[\s\S]{0,300}/) || [])[0]);
  pag = await cer("get", `/stocuri/ct-park/palet/${PC}`, DEP);
  bine("…iar la o ieșire spre producție nu apare nimic de consum", /→ Producție/.test(pag.corp) && !/cerut de/.test(fara(pag.corp)));
  pag = await cer("get", "/stocuri/ct-park/etichete", DEP, { query: { paleti: String(PA) } });
  bine("eticheta de ieșire: destinația, persoana și motivul", /et-destinatie">Consum intern</.test(pag.corp) && /et-client">Ion Pop</.test(pag.corp) && /et-comanda">folie pentru înfoliat paleții</.test(pag.corp), (pag.corp.match(/et-destinatie[\s\S]{0,260}/) || [])[0]);
  pag = await cer("get", "/stocuri/ct-park/etichete", DEP, { query: { paleti: String(PC) } });
  bine("…pe eticheta unei ieșiri spre producție nu apar", /et-destinatie">Producție</.test(pag.corp) && !/Nimeni/.test(pag.corp) && !/n-ar trebui/.test(pag.corp));
  pag = await cer("get", "/stocuri/ct-park/consum", DEP);
  const randuri = (html) => (fara(html).match(/<tbody>([\s\S]*?)<\/tbody>/) || ["", ""])[1].split("</tr>").map((tr) => tr.split(/<td[^>]*>/).slice(1).map((c) => c.replace(/<br>/g, " / ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())).filter((x) => x.length);
  const ziRo = azi().split("-").reverse().join(".");
  const ale = randuri(pag.corp).filter((x) => /^TCI-PAL-/.test(x[1]));
  egal("lista „Consum intern”: cele patru ieșiri, cea mai nouă sus, cu marfa, cantitatea, motivul, persoana, cine a scos și costul", ale, [
    [ziRo, "TCI-PAL-2", "TCI Banda adeziva", "50 buc", "restul, pentru inventar", "Dan Luca", "TCI Depozit", "150,00 lei"],
    [ziRo, "TCI-PAL-2", "TCI Banda adeziva", "20 buc", "bandă pentru birou", "Dan Luca", "TCI Depozit", "60,00 lei"],
    [ziRo, "TCI-PAL-2", "TCI Banda adeziva", "30 buc", "bandă pentru cutiile de arhivă", "Maria Ene", "TCI Depozit", "90,00 lei"],
    [ziRo, "TCI-PAL-1", "TCI Folie stretch manuala", "100 buc", "folie pentru înfoliat paleții / luat de la poartă", "Ion Pop", "TCI Depozit", "200,00 lei"],
  ]);
  bine("…fără ieșirea spre producție", !/TCI-PAL-3/.test(pag.corp) && !/TCI Granula/.test(pag.corp));
  bine("…cu legătura spre fișa paletului și cu butonul care deschide Ieșirea pe „Consum intern”", pag.corp.includes(`href="/stocuri/ct-park/palet/${PA}">TCI-PAL-1</a>`) && pag.corp.includes('href="/stocuri/ct-park/iesire?destinatie=consum"'));
  bine("…și în submeniul depozitului", /href="\/stocuri\/ct-park\/consum" class="subnav-link activ">Consum intern<\/a>/.test(pag.corp));
  const luna = azi().slice(0, 7);
  pag = await cer("get", "/stocuri/ct-park/consum", DEP, { query: { luna } });
  bine("filtrul pe luna de acum le arată, cu luna aleasă în listă", randuri(pag.corp).filter((x) => /^TCI-PAL-/.test(x[1])).length === 4 && new RegExp(`<option value="${luna}" selected>`).test(pag.corp));
  pag = await cer("get", "/stocuri/ct-park/consum", DEP, { query: { luna: "2019-01" } });
  bine("pe o lună fără ieșiri: mesaj, nu tabel", /Nimic scos pentru consum intern în luna aleasă\./.test(pag.corp) && !/TCI-PAL-/.test(pag.corp));
  pag = await cer("get", "/stocuri/ct-park/consum", DEP, { query: { luna: "2026-11' OR '1'='1" } });
  bine("o lună scrisă aiurea e ignorată: lista întreagă, nicio eroare", pag.cod === 200 && randuri(pag.corp).filter((x) => /^TCI-PAL-/.test(x[1])).length === 4);
  egal("cine o vede: depozitul da, agentul de vânzări nu", [AUTH.poateAccesa(DEP, "/stocuri/ct-park/consum"), AUTH.poateAccesa(AGENT, "/stocuri/ct-park/consum")], [true, false]);
  pag = await cer("get", "/stocuri/ct-park/iesire", DEP, { query: { destinatie: "consum" } });
  bine("Ieșire marfă: destinația „Consum intern”, aleasă din adresă, cu cele două câmpuri", /name="destinatie" value="consum" required checked/.test(pag.corp) && /id="camp-consum"/.test(pag.corp) && /name="consum_motiv"/.test(pag.corp) && /name="consum_solicitant"/.test(pag.corp));

  // ------------------------------------------------------------------------
  console.log("\n6. Transferul în fulfillment: o parte din palet");
  const aduce = (body) => cer("post", "/fulfillment/intrare", DEP, { body });
  const ff = () => q(`SELECT cantitate, fel, palet_id FROM ff_miscari WHERE produs_id = ${P4} ORDER BY id`).map((x) => [Number(x.cantitate), x.fel, Number(x.palet_id)]);
  egal("înainte: 100 buc pe palet, 150 pe stocul CT-Park (cu paletul mixt)", [stare(PD), linia(PD), (await W.stocPeProduse()).get(P4)], [[100, 100, "in depozit"], [100], 140]);
  r = await aduce({ palet_id: String(PD), cantitate: "30", observatii: "pentru comenzile de marți" });
  bine("30 din 100: mesajul spune cât a venit și cât rămâne pe palet", /30 buc TCI Punga curier — pe palet mai rămân 70\./.test(parametri(r).ok || ""), unde(r));
  egal("paletul are 70 și pe antet, și pe LINIE (înainte rămânea 100 pe linie)", [stare(PD), linia(PD)], [[70, 100, "in depozit"], [70]]);
  egal("stocul CT-Park a scăzut cu ce a plecat", (await W.stocPeProduse()).get(P4), 110);
  egal("rămâne o ieșire parțială spre fulfillment, cu linia ei", [iesiri(PD).map((x) => [x[0], x[1], x[4]]), liniiIesiri(PD), unul(`SELECT observatii FROM ct_iesiri WHERE palet_id = ${PD}`)], [[["fulfillment", 1, "TCI Depozit"]], [[30, 70]], "transfer în gestiunea de fulfillment — pentru comenzile de marți"]);
  egal("…și intrarea în fulfillment, o singură dată", ff(), [[30, "intrare_depozit", PD]]);
  r = await aduce({ palet_id: String(PD), cantitate: "71" });
  bine("mai mult decât e pe palet: refuzat, nimic schimbat", /Pe palet sunt 70 buc, nu 71/.test(parametri(r).eroare || "") && linia(PD)[0] === 70 && ff().length === 1, unde(r));
  r = await aduce({ palet_id: String(PE), cantitate: "5" });
  bine("un palet cu mai multe produse nu se aduce de aici (n-are un singur produs)", /Paletul n-are produs din nomenclator/.test(parametri(r).eroare || "") && ff().length === 1, unde(r));
  // Un palet cu produs pe antet, dar fără linia lui (date vechi sau stricate): o parte nu se poate scădea de nicăieri.
  const PG = Number(unul(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare) VALUES ('${PREFIX}-PAL-FARA-LINIE', ${P4}, 20, 20, 'buc', '2026-11-04') RETURNING id`));
  r = await aduce({ palet_id: String(PG), cantitate: "5" });
  egal("fără linia paletului, o parte e refuzată și nu intră nimic în fulfillment", [parametri(r).eroare, stare(PG), ff().length],
    ["Din paletul ăsta nu pot aduce doar o parte: adu-l întreg, sau scoate partea din fișa paletului, cu destinația Fulfillment.", [20, 20, "in depozit"], 1]);
  q(`DELETE FROM ct_paleti WHERE id = ${PG}`);
  // Antetul spune 100, linia 60 (date stricate): 80 nu se pot scoate din 60. Nimic nu iese și nimic nu intră în fulfillment.
  const PH = palet(P4, 60, "buc", 0.5, { data: "2026-11-05" });
  q(`UPDATE ct_paleti SET cantitate = 100 WHERE id = ${PH}`);
  r = await aduce({ palet_id: String(PH), cantitate: "80" });
  egal("antetul paletului spune mai mult decât e pe el: refuzat, cu unde să te uiți, și nu intră nimic în fulfillment", [parametri(r).eroare, linia(PH), ff().length, iesiri(PH).length],
    ["Pe palet sunt de fapt 60 buc, nu 80: cantitatea scrisă pe palet nu se potrivește cu marfa de pe el. Verifică fișa paletului.", [60], 1, 0]);
  r = await aduce({ palet_id: String(PH), cantitate: "60" });
  egal("…dar exact cât e pe el se poate aduce, iar paletul rămâne în depozit cu zero pe linie", [parametri(r).eroare, linia(PH), ff().slice(-1)], [undefined, [0], [[60, "intrare_depozit", PH]]]);
  q(`DELETE FROM ff_miscari WHERE palet_id = ${PH}`);
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id = ${PH})`);
  q(`DELETE FROM ct_iesiri WHERE palet_id = ${PH}`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id = ${PH}`);
  q(`DELETE FROM ct_paleti WHERE id = ${PH}`);
  r = await aduce({ palet_id: String(PD) });
  egal("fără cantitate: vine tot ce a rămas, paletul iese", [stare(PD)[2], ff(), iesiri(PD).map((x) => [x[0], x[1]])], ["iesit", [[30, "intrare_depozit", PD], [70, "intrare_depozit", PD]], [["fulfillment", 1], ["fulfillment", 0]]]);
  egal("stocul CT-Park: a rămas doar paletul mixt", (await W.stocPeProduse()).get(P4), 40);

  // ------------------------------------------------------------------------
  console.log("\n7. În browser: câmpurile de consum sunt obligatorii doar la „Consum intern”");
  const PF = palet(P5, 60, "buc", 1, { data: "2026-11-03" });
  const { chromium } = require("playwright");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const browser = await chromium.launch();
  const erori = [];
  try {
    const p = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    p.on("pageerror", (e) => erori.push(e.message));
    await p.route("http://erp.test/**", async (rt) => {
      const u = new URL(rt.request().url());
      if (u.pathname.endsWith(".css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      if (rt.request().method() === "GET" && [`/stocuri/ct-park/iesire`, `/stocuri/ct-park/palet/${PF}`, `${BAZA}/iesire/palet/${PF}`].includes(u.pathname)) {
        const h = await cer("get", u.pathname, DEP, { query: Object.fromEntries(u.searchParams) });
        return rt.fulfill({ status: 200, contentType: "text/html", body: h.corp });
      }
      return rt.fulfill({ status: 204, body: "" });
    });
    const starea = (cutie) => p.evaluate((sel) => { const c = document.querySelector(sel); const v = c && !c.hidden && getComputedStyle(c).display !== "none"; return [Boolean(v), [...c.querySelectorAll("input")].map((i) => i.required)]; }, cutie);
    const alege = (v) => p.check(`input[name="destinatie"][value="${v}"]`);
    for (const [nume, adresa, cutie] of [["Ieșire marfă", "/stocuri/ct-park/iesire", "#camp-consum"], ["fișa paletului", `/stocuri/ct-park/palet/${PF}`, ".ct-pa-consum"], ["scanerul", `${BAZA}/iesire/palet/${PF}`, "#sc-consum"]]) {
      await p.goto("http://erp.test" + adresa);
      egal(`${nume}: la deschidere câmpurile de consum sunt ascunse și neobligatorii`, await starea(cutie), [false, [false, false]]);
      await alege("consum");
      egal(`${nume}: la „Consum intern” apar și sunt obligatorii`, await starea(cutie), [true, [true, true]]);
      await alege("productie");
      egal(`${nume}: la „Producție” se ascund și nu mai sunt obligatorii`, await starea(cutie), [false, [false, false]]);
      await alege("consum");
      await alege("comanda");
      egal(`${nume}: la fel când treci de pe „Consum intern” pe „Comandă”`, await starea(cutie), [false, [false, false]]);
    }
    await p.goto("http://erp.test/stocuri/ct-park/iesire?destinatie=consum");
    egal("Ieșire marfă deschisă cu „Consum intern” ales: câmpurile sunt la vedere din prima", await starea("#camp-consum"), [true, [true, true]]);
    if (process.env.POZA) await p.screenshot({ path: process.env.POZA, fullPage: false });
  } finally {
    await browser.close();
  }
  egal("nicio eroare de JavaScript", erori, []);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* rămâne pentru rularea următoare */ }
  process.exit(1);
});
