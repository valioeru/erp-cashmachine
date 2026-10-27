"use strict";
// Modificarea unei oferte de furnizor deja salvate. Cu o bază falsă.
//
// CE APĂRĂ:
//
//   • UN PREȚ DE ZERO NU TRECE. Zero ar ieși cea mai bună ofertă din istoric
//     și ar rămâne așa în comparația de prețuri — fără nicio eroare, doar cu o
//     decizie de achiziție luată pe o cifră care nu există.
//
//   • OFERTA NU-ȘI SCHIMBĂ ARTICOLUL. Mutată pe alt articol, ar dispărea un
//     preț dintr-un istoric și ar apărea în altul unul care n-a fost cerut
//     niciodată. Două istorice stricate dintr-o singură greșeală de click.
//
//   • DOAR ADMINUL. Prețurile de la furnizori sunt baza negocierilor.
//
//   • CE A SCRIS OMUL SE ÎNTOARCE CU EL. Un formular refuzat care se golește
//     îl face pe om să rescrie tot — și a doua oară scrie mai pe fugă.
const Module = require("module");
let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 220) : "")); esecuri++; }
}

const OFERTA = {
  id: 7, articol_id: 3, furnizor_id: 12, furnizor_text: null, pret: 1.42, moneda: "EUR", um: "kg",
  cantitate_min: 1000, conditii: "FCA", termen_livrare: "3 saptamani", data_ofertei: "2026-10-01",
  valabil_pana: "2026-11-30", sursa: "email", observatii: "pret contract", activ: 1,
  email_subiect: "Oferta folie", email_de_la: "vanzari@furnizor.ro",
};
const BAZA = { oferta: { ...OFERTA }, scrieri: [] };

function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get(...a) {
      if (/FROM ach_oferte WHERE id/i.test(s)) return Number(a[0]) === 7 ? { ...BAZA.oferta } : undefined;
      if (/FROM ach_articole WHERE id/i.test(s)) return { id: 3, nume: "Folie stretch jumbo" };
      if (/COUNT\(\*\)/i.test(s)) return { n: 0 };
      return undefined;
    },
    async all() {
      if (/FROM parteneri/i.test(s)) return [{ id: 12, nume: "Furnizor Unu" }, { id: 13, nume: "Furnizor Doi" }];
      if (/FROM ach_categorii/i.test(s)) return [];
      return [];
    },
    async run(...a) {
      BAZA.scrieri.push(s);
      if (/UPDATE ach_oferte SET furnizor_id/i.test(s)) {
        Object.assign(BAZA.oferta, {
          furnizor_id: a[0], furnizor_text: a[1], pret: a[2], moneda: a[3], um: a[4],
          cantitate_min: a[5], conditii: a[6], termen_livrare: a[7], data_ofertei: a[8],
          valabil_pana: a[9], sursa: a[10], observatii: a[11],
        });
      }
      return { lastInsertRowid: 1 };
    },
  };
}
function inj(c, o) { const x = require.resolve(c); const m = new Module(x, null); m.filename = x; m.loaded = true; m.exports = o; require.cache[x] = m; }
inj("./lib/db", { prepare: fals, exec: async () => {}, migrate: async () => {} });

const proc = require("./modules/procurement");
const rute = [];
proc.register({ get: (c, h) => rute.push(["GET", c, h]), post: (c, h) => rute.push(["POST", c, h]), use: () => {} });
function ruta(m, c) { const r = rute.find((x) => x[0] === m && x[1] === c); if (!r) throw new Error("ruta lipseste: " + m + " " + c); return r[2]; }
async function cheama(metoda, cale, params, corp, user) {
  let stare = 200, text = "", unde = null;
  const res = { writeHead(s, h) { stare = s; if (h && h.Location) unde = h.Location; }, end(t) { text = String(t || ""); }, setHeader(k, v) { if (String(k).toLowerCase() === "location") unde = v; } };
  await ruta(metoda, cale)({ req: {}, res, params: params || {}, query: {}, body: corp || {}, user });
  return { stare, text, unde };
}
const ADMIN = { id: 1, nume: "Vali", rol: "admin" };
const AGENT = { id: 5, nume: "Agent", rol: "agent" };
const bun = (extra) => ({ furnizor_id: "13", pret: "1.55", moneda: "EUR", um: "kg", cantitate_min: "500",
  conditii: "DAP", termen_livrare: "2 saptamani", data_ofertei: "2026-10-20", valabil_pana: "2026-12-31",
  sursa: "telefon", observatii: "renegociat", ...(extra || {}) });

(async () => {
  console.log("Cine ajunge la formular");
  {
    bine("adminul intră", (await cheama("GET", "/procurement/oferta/:id/editare", { id: "7" }, {}, ADMIN)).stare === 200);
    // Cererea lui Vali: modificarea e pentru oricine are acces la Procurement,
    // nu doar pentru administrator. Dreptul pe zona e verificat de lib/auth
    // inainte sa ajunga cererea in ruta, deci aici e destul sa fie cineva logat.
    bine("oricine are acces la Procurement intră",
      (await cheama("GET", "/procurement/oferta/:id/editare", { id: "7" }, {}, AGENT)).stare === 200);
    const n = await cheama("GET", "/procurement/oferta/:id/editare", { id: "7" }, {}, null);
    bine("dar nu cineva nelogat", n.stare !== 200, n.stare);
    bine("o ofertă inexistentă dă 404", (await cheama("GET", "/procurement/oferta/:id/editare", { id: "99" }, {}, ADMIN)).stare === 404);
  }

  console.log("Formularul vine completat");
  {
    const r = await cheama("GET", "/procurement/oferta/:id/editare", { id: "7" }, {}, ADMIN);
    bine("are prețul de acum", r.text.indexOf('value="1.42"') !== -1);
    bine("are furnizorul ales", r.text.indexOf('value="12" selected') !== -1);
    bine("are data ofertei", r.text.indexOf('value="2026-10-01"') !== -1);
    bine("spune că articolul nu se schimbă de aici", r.text.indexOf("Articolul nu se schimbă") !== -1);
    bine("pomenește emailul din care a venit", r.text.indexOf("Oferta folie") !== -1);
    bine("prețul se poate scrie cu patru zecimale", r.text.indexOf('step="0.0001"') !== -1);
  }

  console.log("Salvarea");
  {
    BAZA.scrieri = [];
    const r = await cheama("POST", "/procurement/oferta/:id/editare", { id: "7" }, bun(), ADMIN);
    bine("se întoarce la articol", String(r.unde || "").indexOf("/procurement/articol/3") === 0, r.unde);
    bine("prețul s-a schimbat", BAZA.oferta.pret === 1.55, BAZA.oferta.pret);
    bine("furnizorul s-a schimbat", Number(BAZA.oferta.furnizor_id) === 13, BAZA.oferta.furnizor_id);
    bine("și restul câmpurilor", BAZA.oferta.conditii === "DAP" && BAZA.oferta.sursa === "telefon", BAZA.oferta);
    bine("articolul a rămas același", BAZA.oferta.articol_id === 3, BAZA.oferta.articol_id);
    bine("nu s-a scris un rând nou", !BAZA.scrieri.some((x) => /^INSERT INTO ach_oferte/i.test(x)), BAZA.scrieri);
  }

  console.log("Ce se refuză");
  {
    const inainte = BAZA.oferta.pret;
    const z = await cheama("POST", "/procurement/oferta/:id/editare", { id: "7" }, bun({ pret: "0" }), ADMIN);
    bine("prețul zero e refuzat", z.text.indexOf("mai mare ca zero") !== -1, z.stare);
    bine("și oferta a rămas neatinsă", BAZA.oferta.pret === inainte, BAZA.oferta.pret);
    bine("ce-a scris omul se întoarce cu el", z.text.indexOf('value="DAP"') !== -1);

    const f = await cheama("POST", "/procurement/oferta/:id/editare", { id: "7" }, bun({ furnizor_id: "", furnizor_text: "" }), ADMIN);
    bine("fără furnizor e refuzat", f.text.indexOf("de la cine e oferta") !== -1);
    const d = await cheama("POST", "/procurement/oferta/:id/editare", { id: "7" }, bun({ data_ofertei: "" }), ADMIN);
    bine("fără dată e refuzat", d.text.indexOf("Data ofertei lipsește") !== -1);

    await cheama("POST", "/procurement/oferta/:id/editare", { id: "7" }, bun({ pret: "9.99" }), AGENT);
    bine("cine are acces la Procurement poate salva", BAZA.oferta.pret === 9.99, BAZA.oferta.pret);
    await cheama("POST", "/procurement/oferta/:id/editare", { id: "7" }, bun({ pret: "0.11" }), null);
    bine("cineva nelogat NU poate salva", BAZA.oferta.pret !== 0.11, BAZA.oferta.pret);
  }

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error("CRAPAT:", e && e.stack ? e.stack : e); process.exit(1); });
