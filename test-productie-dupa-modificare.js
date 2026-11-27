"use strict";
// Cantitatea din producție urmează cantitatea de pe comanda clientului.
// PostgreSQL real (baza de test de pe 5433), prin rutele adevărate.
//
// CE A SPUS VALI, 27.11.2026: „La modificare comandă, cantitatea pe care o
// vede în producție pe comanda deja alocată, deși aprobă modificarea, nu se
// modifică cantitatea de produs în consecință."
//
// CE APĂRĂ:
//   • cât cererea de modificare doar AȘTEAPTĂ, producția vede cantitatea veche;
//   • la APROBARE, cererea către producție, comanda de producție, linia ei,
//     valoarea estimată și alocarea unică pe utilaj iau cantitatea nouă;
//   • cererea făcută doar pe ce LIPSEA din stoc se schimbă cu diferența, nu
//     devine toată linia;
//   • la fel la modificarea DIRECTĂ (comandă nepreluată, sau făcută de producție);
//   • NU se ating: producția finalizată, cererile către terți, alocările
//     împărțite, o cerere care ar ajunge la zero — și se spune în istoric;
//   • o schimbare doar de preț nu atinge producția.
const path = require("path");
const fs = require("fs");
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
require(path.join(RAD, "modules", "comenzi.js")).register(router);
require(path.join(RAD, "modules", "productie.js")).register(router);
const ACP = require(path.join(RAD, "lib", "acord-productie.js"));

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

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 500) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const PDM = require(path.join(RAD, "lib", "productie-dupa-modificare.js"));
const PART = 98701, P1 = 98711, P2 = 98712;
const [K1, K2, K3, K4] = [987001, 987002, 987003, 987004];
const [C1, C2, C3] = [987101, 987102, 987103];
const VALI = { id: 98721, nume: "Vali Pdm", rol: "admin" };
const AGENT = { id: 98722, nume: "Agent Pdm", rol: "vanzari" };
const PROD = { id: 98723, nume: "Productie Pdm", rol: "productie" };
const TOATE = `${K1}, ${K2}, ${K3}, ${K4}`;
function curata() {
  for (const s of [
    `DELETE FROM alocari_productie WHERE comanda_productie_id IN (${C1}, ${C2}, ${C3})`,
    `DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${C1}, ${C2}, ${C3})`,
    `DELETE FROM aprovizionari WHERE comanda_id IN (${TOATE})`,
    `DELETE FROM comenzi_cereri_modificare WHERE comanda_id IN (${TOATE})`,
    `DELETE FROM comenzi_istoric WHERE comanda_id IN (${TOATE})`,
    `DELETE FROM comenzi_productie WHERE id IN (${C1}, ${C2}, ${C3})`,
    `DELETE FROM comenzi_linii WHERE comanda_id IN (${TOATE})`,
    `DELETE FROM interactiuni WHERE partener_id = ${PART}`,
    `DELETE FROM comenzi WHERE id IN (${TOATE})`,
    `DELETE FROM parteneri WHERE id = ${PART}`,
    `DELETE FROM produse WHERE id IN (${P1}, ${P2})`,
    "DELETE FROM utilizatori WHERE id BETWEEN 98721 AND 98729",
  ]) q(s);
}
const formular = (nrComanda, linii, extra) => Object.assign({
  partener_id: String(PART), numar: nrComanda, data_livrare_ceruta: "2099-12-01",
  livrare_partiala: "da", livrare_mod: "intern", branding: "nepersonalizat", moneda: "RON", observatii: "",
  "produs_id[]": linii.map((l) => String(l[0])),
  "cantitate[]": linii.map((l) => String(l[1])),
  "pret_unitar[]": linii.map((l) => String(l[2])),
  "um[]": linii.map(() => "buc"),
}, extra || {});
const linie = (comanda, produs) => Number(q(`SELECT cantitate FROM comenzi_linii WHERE comanda_id = ${comanda} AND produs_id = ${produs}`)[0].cantitate);
const cerere = (comanda, sursa) => q(`SELECT cantitate FROM aprovizionari WHERE comanda_id = ${comanda} AND sursa = '${sursa || "productie"}' ORDER BY id`).map((x) => Number(x.cantitate));
const cp = (id) => { const x = q(`SELECT cantitate, valoare_estimata, status FROM comenzi_productie WHERE id = ${id}`)[0]; return [x.cantitate, x.valoare_estimata == null ? null : Number(x.valoare_estimata)]; };
const cpLinie = (id) => q(`SELECT cantitate FROM comenzi_productie_linii WHERE comanda_id = ${id}`).map((x) => x.cantitate);
const alocari = (id) => q(`SELECT cantitate, ore FROM alocari_productie WHERE comanda_productie_id = ${id} ORDER BY id`).map((x) => [Number(x.cantitate), Number(x.ore)]);
const istoricProd = (id) => q(`SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ${id} AND ce LIKE 'Producție%' ORDER BY id`).map((x) => [x.ce, x.vechi, x.nou]);

(async () => {
  console.log("1. Socoteala, fără bază");
  egal("cererea era pe toată linia: devine cât e linia acum", [PDM.cantitateNoua({ linieVeche: 1000, linieNoua: 1500, cerere: 1000 }), PDM.cantitateNoua({ linieVeche: 1000, linieNoua: 700, cerere: 1000 })], [1500, 700]);
  egal("cererea era doar pe ce lipsea: se schimbă cu diferența, ce era în stoc rămâne în stoc", [PDM.cantitateNoua({ linieVeche: 1000, linieNoua: 1500, cerere: 600 }), PDM.cantitateNoua({ linieVeche: 1000, linieNoua: 900, cerere: 600 })], [1100, 500]);
  egal("comanda scade sub ce era deja în stoc: nu mai rămâne nimic de cerut", [PDM.cantitateNoua({ linieVeche: 1000, linieNoua: 300, cerere: 600 }), PDM.cantitateNoua({ linieVeche: 1000, linieNoua: 400, cerere: 600 })], [null, null]);
  egal("cantități cu zecimale și scrise ca text", PDM.cantitateNoua({ linieVeche: "160,5", linieNoua: "200.25", cerere: "160.5" }), 200.25);

  curata();
  q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98721,'Vali Pdm','v.pdm@test.ro','x','y','admin'), (98722,'Agent Pdm','a.pdm@test.ro','x','y','vanzari'), (98723,'Productie Pdm','p.pdm@test.ro','x','y','productie')`);
  q(`INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES (${PART}, 'PDM Client SRL', 'RO98701', 'client', 98722)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva, activ) VALUES (${P1}, 'PDM-1', 'PDM Punga', 'buc', 0.5, 21, 1), (${P2}, 'PDM-2', 'PDM Folie', 'buc', 12, 21, 1)`);
  for (const [id, n] of [[K1, "PDM-1"], [K2, "PDM-2"], [K3, "PDM-3"], [K4, "PDM-4"]]) {
    q(`INSERT INTO comenzi (id, partener_id, numar, data, status, agent_id, creata_de, moneda, livrare_partiala, livrare_mod, branding, data_livrare_ceruta) VALUES (${id}, ${PART}, '${n}', '2099-11-19', 'in_productie', 98722, 98722, 'RON', 'da', 'intern', 'nepersonalizat', '2099-12-01')`);
    q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (${id}, ${P1}, 1000, 0.5, 'buc')`);
  }
  const idLinie = (k) => Number(q(`SELECT id FROM comenzi_linii WHERE comanda_id = ${k} AND produs_id = ${P1}`)[0].id);
  // K1: preluată în producție, cerere pe toată linia, o singură alocare pe utilaj.
  q(`INSERT INTO comenzi_productie (id, comanda_id, numar, status, cantitate, um, valoare_estimata, produs_id) VALUES (${C1}, ${K1}, 'PDM-PR-1', 'in_productie', '1000', 'buc', 500, ${P1})`);
  q(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um) VALUES (${C1}, ${P1}, 'PDM Punga', '1000', 'buc')`);
  q(`INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, um, sursa, status, productie_id, termen_cerut) VALUES (${K1}, ${idLinie(K1)}, ${P1}, 1000, 'buc', 'productie', 'confirmata', ${C1}, '2099-12-01')`);
  q(`INSERT INTO alocari_productie (comanda_productie_id, data, ora_start, ore, cantitate, status) VALUES (${C1}, '2099-11-25', 8, 6, 1000, 'planificata')`);
  // K2: producția doar „nouă", cererea doar pe ce lipsea (600 din 1.000), alocată pe două zile; plus o cerere la un terț.
  q(`INSERT INTO comenzi_productie (id, comanda_id, numar, status, cantitate, um, valoare_estimata, produs_id) VALUES (${C2}, ${K2}, 'PDM-PR-2', 'noua', '600', 'buc', 300, ${P1})`);
  q(`INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, um, sursa, status, productie_id, termen_cerut) VALUES (${K2}, ${idLinie(K2)}, ${P1}, 600, 'buc', 'productie', 'confirmata', ${C2}, '2099-12-01'), (${K2}, ${idLinie(K2)}, ${P1}, 50, 'buc', 'tert', 'ceruta', NULL, '2099-12-01')`);
  q(`INSERT INTO alocari_productie (comanda_productie_id, data, ora_start, ore, cantitate, status) VALUES (${C2}, '2099-11-25', 8, 4, 300, 'planificata'), (${C2}, '2099-11-26', 8, 4, 300, 'planificata')`);
  // K3: producția deja finalizată.
  q(`INSERT INTO comenzi_productie (id, comanda_id, numar, status, cantitate, um, produs_id) VALUES (${C3}, ${K3}, 'PDM-PR-3', 'finalizata', '1000', 'buc', ${P1})`);
  q(`INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, um, sursa, status, productie_id, termen_cerut) VALUES (${K3}, ${idLinie(K3)}, ${P1}, 1000, 'buc', 'productie', 'gata', ${C3}, '2099-12-01')`);
  // K4: cerere încă neconfirmată de producție (fără comandă de producție).
  q(`INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, um, sursa, status, termen_cerut) VALUES (${K4}, ${idLinie(K4)}, ${P1}, 1000, 'buc', 'productie', 'ceruta', '2099-12-01')`);

  console.log("\n2. Comanda preluată: cât cererea așteaptă, producția vede cantitatea veche");
  let r = await cer("post", `/comenzi/${K1}/editare`, AGENT, { body: formular("PDM-1", [[P1, 1500, 0.5]], { motiv: "clientul a mărit comanda" }) });
  const z = q(`SELECT id FROM comenzi_cereri_modificare WHERE comanda_id = ${K1} AND stare = 'asteapta'`)[0];
  egal("modificarea agentului doar așteaptă: nimic schimbat nici pe comandă, nici în producție", [/ok=asteapta_productia/.test(unde(r)), linie(K1, P1), cerere(K1), cp(C1), alocari(C1)], [true, 1000, [1000], ["1000", 500], [[1000, 6]]]);

  console.log("\n3. Producția aprobă: cantitatea ei se schimbă odată cu a comenzii");
  r = await cer("post", `/comenzi/modificari/${z.id}/aproba`, PROD, { body: { inapoi: "productie" } });
  egal("linia comenzii, cererea către producție și comanda de producție au toate 1.500", [/ok_acord=/.test(unde(r)), linie(K1, P1), cerere(K1), cp(C1)[0], cpLinie(C1)], [true, 1500, [1500], "1500", ["1500"]]);
  egal("valoarea estimată urmează cantitatea, la același preț pe unitate (500 → 750)", cp(C1)[1], 750);
  egal("alocarea unică pe utilaj ia cantitatea nouă; orele rămân de verificat de om", alocari(C1), [[1500, 6]]);
  egal("istoricul comenzii spune ce s-a schimbat în producție", istoricProd(K1), [["Producție · PDM Punga", "PDM-PR-1: 1.000 buc", "1.500 buc; alocarea pe utilaj are și ea cantitatea nouă (orele rămân cum erau — verifică-le)"]]);
  r = await cer("get", "/productie", PROD);
  const randCp = (String(r.corp).split("PDM-PR-1")[1] || "").slice(0, 1500).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  bine("pagina Producției arată comanda cu 1.500, nu cu 1.000", /1[.\s]?500/.test(randCp) && !/\b1[.\s]?000 buc/.test(randCp), randCp.slice(0, 300));

  console.log("\n4. Modificare directă; cererea era doar pe ce lipsea din stoc");
  r = await cer("post", `/comenzi/${K2}/editare`, VALI, { body: formular("PDM-2", [[P1, 1500, 0.5]]) });
  egal("linia urcă de la 1.000 la 1.500: cererea de 600 devine 1.100 (cele 400 din stoc rămân din stoc)", [/ok=modificat/.test(unde(r)), linie(K2, P1), cerere(K2), cp(C2)], [true, 1500, [1100], ["1100", 550]]);
  egal("cererea către terț nu se atinge", cerere(K2, "tert"), [50]);
  egal("alocările împărțite pe două zile rămân cum erau, iar istoricul o spune", [alocari(C2), /PDM-PR-2: 600 buc/.test(istoricProd(K2)[0][1]), /^1\.100 buc; cele 2 alocări pe utilaj au rămas cum erau — împarte tu cantitatea nouă$/.test(istoricProd(K2)[0][2])], [[[300, 4], [300, 4]], true, true]);
  r = await cer("post", `/comenzi/${K2}/editare`, VALI, { body: formular("PDM-2", [[P1, 1500, 0.6]]) });
  egal("o schimbare doar de preț nu atinge producția și nu scrie nimic despre ea", [/ok=modificat/.test(unde(r)), cerere(K2), cp(C2)[0], istoricProd(K2).length], [true, [1100], "1100", 1]);
  r = await cer("post", `/comenzi/${K2}/editare`, VALI, { body: formular("PDM-2", [[P1, 1400, 0.6], [P2, 5, 12]]) });
  egal("scade cu 100 și se adaugă alt produs: cererea scade cu 100; produsul nou n-are nimic în producție", [linie(K2, P1), cerere(K2), cp(C2)[0], istoricProd(K2).length], [1400, [1000], "1000", 2]);
  r = await cer("post", `/comenzi/${K2}/editare`, VALI, { body: formular("PDM-2", [[P1, 300, 0.6], [P2, 5, 12]]) });
  egal("scade sub ce era deja în stoc: comanda de producție nu se anulează singură, rămâne cum era și se spune", [linie(K2, P1), cerere(K2), cp(C2)[0], /nu s-a schimbat singură: comanda a scăzut sub ce era deja în stoc/.test((istoricProd(K2)[2] || [])[2] || "")], [300, [1000], "1000", true]);

  console.log("\n5. Ce nu se atinge");
  r = await cer("post", `/comenzi/${K3}/editare`, VALI, { body: formular("PDM-3", [[P1, 1300, 0.5]]) });
  egal("producția deja finalizată: cantitatea ei rămâne, iar istoricul spune că diferența trebuie cerută separat", [linie(K3, P1), cerere(K3), cp(C3)[0], /PDM-PR-3 e deja finalizată/.test((istoricProd(K3)[0] || [])[1] || ""), /rămâne 1\.000 buc; diferența de 300 buc trebuie cerută separat/.test((istoricProd(K3)[0] || [])[2] || "")], [1300, [1000], "1000", true, true]);
  r = await cer("post", `/comenzi/${K4}/editare`, AGENT, { body: formular("PDM-4", [[P1, 800, 0.5]]) });
  egal("cererea încă neconfirmată de producție (fără comandă de producție) ia și ea cantitatea nouă", [/ok=modificat/.test(unde(r)), linie(K4, P1), cerere(K4), istoricProd(K4)], [true, 800, [800], [["Producție · PDM Punga", "cererea către producție: 1.000 buc", "800 buc"]]]);

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
