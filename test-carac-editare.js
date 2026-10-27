"use strict";
// Modificarea unei caracteristici de cod. Cu o bază falsă.
//
// CE APĂRĂ:
//
//   • FELUL NU SE SCHIMBĂ. O listă trecută pe număr și-ar lăsa valorile
//     orfane; un număr trecut pe listă n-ar avea nicio valoare. În amândouă
//     cazurile codul ar înceta să iasă, fără ca nimeni să înțeleagă de ce.
//
//   • NICI FAMILIA. Mutată, caracteristica ar dispărea din codul unei familii
//     și ar apărea în al alteia — toate produsele vechi ale amândurora ar
//     deveni de nerecunoscut după cod.
//
//   • O BIFĂ SCOASĂ CHIAR SE SCOATE. Un formular HTML nu trimite deloc
//     checkbox-urile nebifate. Dacă s-ar citi „lipsește = lasă cum era",
//     nimeni n-ar mai putea scoate greutatea din cod — exact lucrul cerut.
//
//   • LA O CARACTERISTICĂ DE TIP LISTĂ, CÂMPURILE DE NUMĂR NU SE PIERD.
//     Formularul nici nu le arată, deci nu le trimite.
const Module = require("module");
let esecuri = 0;
function bine(d, cond, det) {
  if (cond) console.log("  ok     " + d);
  else { console.log("  ESEC   " + d + (det !== undefined ? "  -> " + JSON.stringify(det).slice(0, 200) : "")); esecuri++; }
}

const NUMAR = { id: 57, familie_id: 1, nume: "Greutate", fel: "numar", um: "kg", in_cod: 1, ordine: 6,
  obligatoriu: 1, cifre: 0, min_val: null, max_val: null, activ: 1 };
const LISTA = { id: 3, familie_id: 1, nume: "Culoare", fel: "lista", um: null, in_cod: 1, ordine: 3,
  obligatoriu: 1, cifre: 4, min_val: 1, max_val: 9, activ: 1 };
const BAZA = { randuri: { 57: { ...NUMAR }, 3: { ...LISTA } } };

function fals(sql) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return {
    async get(...a) {
      if (/FROM cod_caracteristici WHERE id/i.test(s)) { const r = BAZA.randuri[Number(a[0])]; return r ? { ...r } : undefined; }
      if (/COUNT\(\*\)/i.test(s)) return { n: 0 };
      return undefined;
    },
    async all() { return []; },
    async run(...a) {
      if (/UPDATE cod_caracteristici SET nume/i.test(s)) {
        const r = BAZA.randuri[Number(a[9])];
        if (r) Object.assign(r, { nume: a[0], um: a[1], in_cod: a[2], ordine: a[3], obligatoriu: a[4],
          cifre: a[5], min_val: a[6], max_val: a[7], activ: a[8] });
      }
      return { lastInsertRowid: 1 };
    },
  };
}
function inj(c, o) { const x = require.resolve(c); const m = new Module(x, null); m.filename = x; m.loaded = true; m.exports = o; require.cache[x] = m; }
inj("./lib/db", { prepare: fals, exec: async () => {}, migrate: async () => {} });

const mod = require("./modules/cod-produs");
const rute = [];
mod.register({ get: (c, h) => rute.push(["GET", c, h]), post: (c, h) => rute.push(["POST", c, h]), use: () => {} });
const CALE = "/configurari/cod-produs";
function ruta(m, c) { const r = rute.find((x) => x[0] === m && x[1] === c); if (!r) throw new Error("lipseste " + m + " " + c); return r[2]; }
async function cheama(params, corp, user) {
  let unde = null, stare = 200;
  const res = { writeHead(s, h) { stare = s; if (h && h.Location) unde = h.Location; }, end() {}, setHeader(k, v) { if (String(k).toLowerCase() === "location") unde = v; } };
  await ruta("POST", CALE + "/:id/editare")({ req: {}, res, params, query: {}, body: corp, user });
  return { unde, stare };
}
const ADMIN = { id: 1, nume: "Vali", rol: "admin" };
const AGENT = { id: 5, nume: "Agent", rol: "agent" };

(async () => {
  console.log("Scoaterea greutății din cod");
  {
    // Checkbox-ul nebifat NU se trimite deloc de browser.
    await cheama({ id: "57" }, { familie_id: "1", nume: "Greutate", ordine: "6", um: "kg", cifre: "0",
      min_val: "", max_val: "", obligatoriu: "1", activ: "1" }, ADMIN);
    const r = BAZA.randuri[57];
    bine("greutatea NU mai intră în cod", r.in_cod === 0, r.in_cod);
    bine("dar rămâne obligatorie", r.obligatoriu === 1, r.obligatoriu);
    bine("și rămâne activă", r.activ === 1, r.activ);
    bine("numele n-a fost atins", r.nume === "Greutate");
    bine("unitatea n-a fost atinsă", r.um === "kg");
  }

  console.log("Ce NU se poate schimba");
  {
    const inainte = { ...BAZA.randuri[57] };
    await cheama({ id: "57" }, { familie_id: "9", nume: "Greutate", fel: "lista", ordine: "6",
      um: "kg", cifre: "3", obligatoriu: "1", activ: "1", in_cod: "1" }, ADMIN);
    const r = BAZA.randuri[57];
    bine("felul rămâne «numar», chiar dacă formularul cere altceva", r.fel === "numar", r.fel);
    bine("familia rămâne aceeași", r.familie_id === inainte.familie_id, r.familie_id);
    bine("dar restul s-a aplicat", r.cifre === 3 && r.in_cod === 1, r);
  }

  console.log("La o caracteristică de tip listă");
  {
    // Formularul nu arata cifre/min/max la liste, deci nu le trimite.
    await cheama({ id: "3" }, { familie_id: "1", nume: "Culoare folie", ordine: "3", in_cod: "1", obligatoriu: "1", activ: "1" }, ADMIN);
    const r = BAZA.randuri[3];
    bine("numele s-a schimbat", r.nume === "Culoare folie", r.nume);
    bine("cifrele nu s-au pierdut", r.cifre === 4, r.cifre);
    bine("nici minimul și maximul", r.min_val === 1 && r.max_val === 9, r);
    bine("nici unitatea", r.um === null, r.um);
  }

  console.log("Cine poate");
  {
    const inainte = BAZA.randuri[3].nume;
    await cheama({ id: "3" }, { familie_id: "1", nume: "Furat", ordine: "3" }, AGENT);
    bine("agentul nu poate modifica", BAZA.randuri[3].nume === inainte, BAZA.randuri[3].nume);
    await cheama({ id: "3" }, { familie_id: "1", nume: "Furat", ordine: "3" }, null);
    bine("nici cineva nelogat", BAZA.randuri[3].nume === inainte);
  }

  console.log("Ce se refuză");
  {
    const inainte = BAZA.randuri[3].nume;
    await cheama({ id: "3" }, { familie_id: "1", nume: "   ", ordine: "3" }, ADMIN);
    bine("un nume gol nu trece", BAZA.randuri[3].nume === inainte, BAZA.randuri[3].nume);
    const r = await cheama({ id: "999" }, { familie_id: "1", nume: "X", ordine: "1" }, ADMIN);
    bine("o caracteristică inexistentă nu crapă", String(r.unde || "").indexOf(CALE) === 0, r);
  }

  console.log("Întoarcerea la familia la care lucra omul");
  {
    const r = await cheama({ id: "3" }, { familie_id: "4", nume: "Culoare folie", ordine: "3" }, ADMIN);
    bine("se întoarce la familia din formular", String(r.unde || "").indexOf("familie=4") !== -1, r.unde);
  }

  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error("CRAPAT:", e && e.stack ? e.stack : e); process.exit(1); });
