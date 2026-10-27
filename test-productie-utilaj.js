"use strict";
// Coloana „Utilaj" din registrul de comenzi producție. Cu o bază falsă.
//
// CE APĂRĂ:
//
//   • NUMĂRUL DE COLOANE. Registrul are nouăsprezece. O celulă în plus sau în
//     minus pe un rând mută TOT ce urmează cu o poziție: „Facturat" ajunge sub
//     „Rețetă" și nimeni nu observă, fiindcă ambele arată a text scurt. De-aia
//     se numără capul și fiecare rând, nu se citește cu ochiul.
//
//   • UTILAJUL SE VEDE DOAR LA „ÎN PRODUCȚIE". Până atunci o alocare e o
//     intenție, nu un fapt — se mai schimbă de două ori până pornește lotul.
//     Asta a cerut Vali explicit.
//
//   • O COMANDĂ ÎN PRODUCȚIE FĂRĂ UTILAJ NU TACE. Scrie „nealocată", pe
//     galben: e exact situația pe care trebuie s-o vadă cineva dimineața.
//
//   • ACELAȘI UTILAJ NU SE SCRIE DE DOUĂ ORI. O comandă are câte o alocare pe
//     schimb; trei schimburi pe aceeași mașină ar fi scris-o de trei ori.
let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + String(det).slice(0, 160) : "")); esecuri++; }
}

const Module = require("module");
const R = __dirname;
const COMENZI = [
  { id: 1, numar: "20261027-001", status: "in_productie", client_text: "Sameday", partener_id: null,
    produs_comandat: "Pungi curier", cantitate: "25000", um: "buc", data_initiere: "2026-10-26", data_livrare: "2026-10-30" },
  { id: 2, numar: "20261027-002", status: "noua", client_text: "Delivery", partener_id: null,
    produs_comandat: "Saci", cantitate: "100", um: "buc", data_initiere: "2026-10-26", data_livrare: "2026-10-30" },
  { id: 3, numar: "20261027-003", status: "in_productie", client_text: "X", partener_id: null,
    produs_comandat: "Banda", cantitate: "10", um: "buc", data_initiere: "2026-10-26", data_livrare: "2026-10-30" },
];
function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get() { if (/COUNT\(\*\)/i.test(s)) return { n: 0, deschise: 0, cu_reteta: 0, cost: 0 }; return undefined; },
    async all() {
      if (/FROM comenzi_productie c LEFT JOIN parteneri/i.test(s) || /FROM comenzi_productie c/i.test(s)) return COMENZI;
      if (/FROM alocari_productie a JOIN utilaje/i.test(s)) {
        return [
          { cid: 1, cod: "UT03", denumire: "Mașina de confecționat pungi" },
          { cid: 1, cod: "UT03", denumire: "Mașina de confecționat pungi" }, // duplicat intentionat
          { cid: 1, cod: "UT11", denumire: "Flexo 6 culori" },
        ];
      }
      if (/GROUP BY status/i.test(s)) return [];
      return [];
    },
    async run() { return { lastInsertRowid: 1 }; },
  };
}
function inj(c, o) { const a = require.resolve(c); const m = new Module(a, null); m.filename = a; m.loaded = true; m.exports = o; require.cache[a] = m; }
inj(R + "/lib/db", { prepare: fals, exec: async () => {}, migrate: async () => {} });
const prod = require(R + "/modules/productie");
const rute = [];
prod.register({ get: (c, h) => rute.push(["GET", c, h]), post: (c, h) => rute.push(["POST", c, h]), use: () => {} });
(async () => {
  let corp = "";
  const res = { writeHead() {}, end(t) { corp = String(t || ""); }, setHeader() {} };
  const h = rute.find((r) => r[0] === "GET" && r[1] === "/productie")[2];
  await h({ req: {}, res, params: {}, query: {}, body: {}, user: { id: 1, nume: "Vali", rol: "admin" } });
  const tabel = corp.slice(corp.indexOf("tabel-inghetat"));
  const th = (tabel.slice(0, tabel.indexOf("</thead>")).match(/<th[ >]/g) || []).length;
  const randuri = tabel.slice(tabel.indexOf("<tbody>"), tabel.indexOf("</tbody>")).split("<tr>").slice(1);
  const td = randuri.map((r) => (r.match(/<td[ >]/g) || []).length);
  console.log("Registrul de comenzi producție");
  bine("antetul are coloana Utilaj", tabel.indexOf(">Utilaj<") !== -1);
  bine(`fiecare rând are tot atâtea celule câte coloane (${th})`, td.every((n) => n === th), "cap " + th + ", randuri " + td.join("/"));
  bine("comanda în producție își arată utilajele",
    randuri[0].indexOf("UT03") !== -1 && randuri[0].indexOf("UT11") !== -1);
  bine("același utilaj nu se scrie de două ori", (randuri[0].match(/UT03/g) || []).length === 1,
    (randuri[0].match(/UT03/g) || []).length);
  bine("comanda nouă NU arată niciun utilaj",
    randuri[1].indexOf("UT03") === -1 && randuri[1].indexOf("nealocat") === -1);
  bine("comanda în producție fără alocare scrie «nealocată»", randuri[2].indexOf("nealocată") !== -1);

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error("CRAPAT:", e && e.stack ? e.stack : e); process.exit(1); });
