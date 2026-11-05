"use strict";
// Regulile fluxului comenzii (lib/stadiu-comanda.js, lib/comenzi-stari.js),
// fără bază de date. Drumul întreg, pe rutele adevărate și pe PostgreSQL, e în
// test-flux-comanda.js; aici sunt cazurile de margine, care acolo ar cere câte
// o comandă întreagă.
const Module = require("module");

let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else {
    console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 260) : ""));
    esecuri++;
  }
}

// O bază falsă cu o singură comandă, cât să se vadă ce scrie fluxul.
const BAZA = { comanda: null, rest: 0, scrieri: [] };
function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get() {
      if (/FROM comenzi WHERE id/i.test(s)) return BAZA.comanda ? { ...BAZA.comanda } : null;
      if (/SUM\(cantitate - COALESCE\(cantitate_livrata/i.test(s)) return { r: BAZA.rest };
      return null;
    },
    async all() { return []; },
    async run(...a) {
      BAZA.scrieri.push({ s, a });
      if (/^UPDATE comenzi SET status = \? WHERE id = \? AND status = \?/i.test(s)) {
        if (BAZA.comanda && BAZA.comanda.status === a[2]) { BAZA.comanda.status = a[0]; return { changes: 1 }; }
        return { changes: 0 };
      }
      return { changes: 1 };
    },
  };
}
function injecteaza(cale, obiect) {
  const abs = require.resolve(cale);
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = obiect;
  require.cache[abs] = m;
}
injecteaza("./lib/db", { prepare: fals, exec: async () => {} });

const S = require("./lib/stadiu-comanda");
const STARI = require("./lib/comenzi-stari");

(async () => {
  console.log("Starea pe care o dau comenzile de producție");
  const st = S.stareDinProductie;
  bine("fără producție: nimic de spus", st([]) === null);
  bine("toate anulate: așteaptă marfă, NU anulată", st([{ status: "anulata" }, { status: "anulata" }]) === "asteapta_marfa");
  bine("una încă se face: în producție", st([{ status: "finalizata", receptie_id: 1, receptie_stare: "asteptata" }, { status: "in_productie" }]) === "in_productie");
  bine("una nouă (nealocată) tot în producție e", st([{ status: "noua" }]) === "in_productie");
  bine("toate gata, una nepreluată: producție finalizată",
    st([{ status: "finalizata", receptie_id: 1, receptie_stare: "finalizata" }, { status: "finalizata", receptie_id: 2, receptie_stare: "in_lucru" }]) === "productie_finalizata");
  bine("toate gata și preluate: decide stocul, nu producția",
    st([{ status: "finalizata", receptie_id: 1, receptie_stare: "finalizata" }, { status: "anulata" }]) === null);
  bine("fără recepție, intrată pe „Intră în stoc”: preluată", st([{ status: "finalizata", cerere_stare: "primita" }]) === null);
  bine("fără recepție, cererea doar „gata”: nepreluată", st([{ status: "finalizata", cerere_stare: "gata" }]) === "productie_finalizata");
  bine("„Facturată” în registru e tot marfă făcută", st([{ status: "facturata", receptie_id: 3, receptie_stare: "asteptata" }]) === "productie_finalizata");
  bine("o recepție anulată nu ține marfa „de preluat”", st([{ status: "finalizata", receptie_id: 4, receptie_stare: "anulata" }]) === null);
  bine("merge și cu stări simple, ca șiruri", st(["finalizata"]) === "productie_finalizata" && st(["anulata"]) === "asteapta_marfa");

  console.log("\nDrumul și facturarea");
  const i = (x) => STARI.FLUX.indexOf(x);
  bine("producție finalizată stă între producție și depozit", i("in_productie") < i("productie_finalizata") && i("productie_finalizata") < i("in_stoc_depozit"));
  bine("gata de livrare, apoi facturată, în livrare, livrată",
    i("in_stoc_depozit") < i("gata_livrare") && i("gata_livrare") < i("facturata") && i("facturata") < i("in_livrare") && i("in_livrare") < i("livrata"));
  bine("cu „producție finalizată” nu se poate factura: marfa n-a văzut-o depozitul", !STARI.poateFactura({ status: "productie_finalizata" }));
  bine("din „în stoc depozit” încolo, da", ["in_stoc_depozit", "gata_livrare", "in_livrare", "livrata"].every((s) => STARI.poateFactura({ status: s })));
  bine("culorile cerute de Vali: finalizată verde, în livrare negru",
    STARI.culoare("productie_finalizata") === "verde" && STARI.culoare("gata_livrare") === "verde" && STARI.culoare("in_livrare") === "negru");
  bine("au etichete, nu numele coloanei", /producție finalizată/.test(STARI.eticheta("productie_finalizata")) && /gata de livrare/.test(STARI.eticheta("gata_livrare")) && /în livrare/.test(STARI.eticheta("in_livrare")));
  const fara = STARI.bara({ status: "in_stoc_depozit" }, { cuProductie: false });
  bine("pe o comandă servită din stoc, bara nu bifează pași de producție", !/în producție/.test(fara) && !/producție finalizată/.test(fara));
  const cu = STARI.bara({ status: "productie_finalizata" }, { cuProductie: true });
  bine("pe una din producție, îi arată, cu pasul de acum aprins", /✓ în producție/.test(cu) && /font-weight:600[^>]*>producție finalizată/.test(cu));
  bine("fără informație, bara arată ca înainte", /în producție/.test(STARI.bara({ status: "noua" })));

  console.log("\nGata de livrare");
  BAZA.comanda = { id: 7, numar: "C-7", status: "productie_finalizata", partener_id: 3 };
  let r = await S.gataDeLivrare(7, { user: { id: 1, nume: "Om Depozit" } });
  bine("nu se poate înainte ca marfa să fie în depozit", !r.ok && /în stoc depozit/.test(r.motiv) && BAZA.comanda.status === "productie_finalizata", r);
  BAZA.comanda.status = "in_stoc_depozit";
  r = await S.gataDeLivrare(7, { user: { id: 1, nume: "Om Depozit" } });
  bine("din „în stoc depozit”, da", r.ok && BAZA.comanda.status === "gata_livrare");
  bine("cu cine și când", BAZA.scrieri.some((x) => /gata_livrare_la = \?, gata_livrare_de = \?/.test(x.s) && x.a[1] === "Om Depozit"));
  BAZA.comanda.status = "facturata";
  r = await S.gataDeLivrare(7, {});
  bine("una facturată nu se întoarce la „gata de livrare”", !r.ok && BAZA.comanda.status === "facturata");

  console.log("\nCursa de transport");
  BAZA.comanda = { id: 8, numar: "C-8", status: "livrata", partener_id: 3 };
  r = await S.dupaCursa(8, "in_curs", {});
  bine("o comandă livrată nu se întoarce „în livrare” de la o cursă veche", !r.schimbat && BAZA.comanda.status === "livrata");
  BAZA.comanda = { id: 9, numar: "C-9", status: "productie_finalizata", partener_id: 3 };
  r = await S.dupaCursa(9, "livrata", {});
  bine("nici una încă la producție nu se dă „livrată”", !r.schimbat && BAZA.comanda.status === "productie_finalizata");
  BAZA.comanda = { id: 10, numar: "C-10", status: "facturata", partener_id: 3, decizie_agent: "facturat_partial" };
  BAZA.rest = 25;
  r = await S.dupaCursa(10, "livrata", {});
  bine("facturată parțial, cu rest pe comandă: „livrată parțial”", r.schimbat && BAZA.comanda.status === "livrata_partial", BAZA.comanda.status);
  BAZA.comanda = { id: 11, numar: "C-11", status: "gata_livrare", partener_id: 3 };
  BAZA.rest = 0;
  r = await S.dupaCursa(11, "in_curs", {});
  bine("pregătită și plecată: „în livrare”", r.schimbat && BAZA.comanda.status === "in_livrare");
  r = await S.dupaCursa(11, "livrata", {});
  bine("apoi „livrată”", r.schimbat && BAZA.comanda.status === "livrata");

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
