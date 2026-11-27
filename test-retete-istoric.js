"use strict";
// Rețetele: rețetă nouă, modificare cu istoric, rețetă la produsul nou.
// PostgreSQL real (baza de test de pe 5433), prin rutele adevărate.
//
// CEREREA LUI VALI, 27.11.2026: „În producție, rețete: vreau să se poată adăuga
// rețetă nouă, să se poată modifica, dar să rămână istoric etc., să se poată
// alege rețeta la produs nou etc."
//
// CE APĂRĂ:
//   • rețetă nouă pentru un produs ales, de la zero sau pornind de la a altuia;
//   • cantitatea unei componente se schimbă pe loc; adăugarea și scoaterea
//     merg ca înainte;
//   • fiecare schimbare rămâne în istoric: ce era, ce a rămas, cine, de unde;
//   • copierea nu atinge rețeta-sursă și nu pune produsul în propria rețetă;
//   • rețeta schimbată de om nu mai e rescrisă de importul din SmartBill, până
//     când omul îi dă voie; importul pe o rețetă neatinsă merge și lasă urmă;
//   • la unificarea de produse, istoricul rețetei merge cu produsul păstrat.
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
require(path.join(RAD, "modules", "retete.js")).register(router);
require(path.join(RAD, "modules", "produse.js")).register(router);
require(path.join(RAD, "modules", "cod-produs.js")).register(router);
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

const RT = require(path.join(RAD, "lib", "retete.js"));
const PUNTE = require(path.join(RAD, "modules", "punte.js"));
const [F1, F2, F3, M1, M2, M3] = [98901, 98902, 98903, 98911, 98912, 98913];
const TOATE = `${F1}, ${F2}, ${F3}, ${M1}, ${M2}, ${M3}`;
const VALI = { id: 98921, nume: "Vali Rt", rol: "admin" };
const MIHAI = { id: 98922, nume: "Mihai Rt", rol: "productie" };
function curata() {
  for (const s of [
    `DELETE FROM retete_istoric WHERE produs_id IN (${TOATE})`,
    `DELETE FROM retete_componente WHERE produs_id IN (${TOATE}) OR componenta_id IN (${TOATE})`,
    `DELETE FROM produse WHERE id IN (${TOATE})`,
    "DELETE FROM utilizatori WHERE id BETWEEN 98921 AND 98929",
  ]) q(s);
}
const reteta = (p) => q(`SELECT componenta_id, cantitate FROM retete_componente WHERE produs_id = ${p} ORDER BY componenta_id`).map((x) => [Number(x.componenta_id), Number(x.cantitate)]);
const istoric = (p) => q(`SELECT fel, componenta_id, cantitate_veche, cantitate_noua, sursa, utilizator_nume, nota FROM retete_istoric WHERE produs_id = ${p} ORDER BY id`).map((x) => [x.fel, x.componenta_id == null ? null : Number(x.componenta_id), x.cantitate_veche == null ? null : Number(x.cantitate_veche), x.cantitate_noua == null ? null : Number(x.cantitate_noua), x.sursa, x.utilizator_nume]);
const deMana = (p) => Number(q(`SELECT COALESCE(reteta_de_mana, 0) AS m FROM produse WHERE id = ${p}`)[0].m);
const mesaj = (r, cheie) => decodeURIComponent((unde(r).match(new RegExp("[?&]" + cheie + "=([^&#]*)")) || [])[1] || "").replace(/\+/g, " ");
const txt = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

(async () => {
  console.log("1. Fără bază");
  egal("cantitatea scrisă: cu virgulă sau punct; zero, text sau negativ sunt refuzate", [RT.cantitateScrisa("0,85").cantitate, RT.cantitateScrisa("1.25").cantitate, RT.cantitateScrisa("0").ok, RT.cantitateScrisa("abc").ok, RT.cantitateScrisa("-2").ok, RT.cantitateScrisa("").ok], [0.85, 1.25, false, false, false, false]);
  const S = [{ componenta_id: 1, cantitate: 2 }, { componenta_id: 2, cantitate: 0.5 }, { componenta_id: 9, cantitate: 1 }];
  const T = [{ componenta_id: 1, cantitate: 2 }, { componenta_id: 2, cantitate: 0.4 }, { componenta_id: 3, cantitate: 7 }];
  egal("copiere fără înlocuire: adaugă ce lipsește și potrivește cantitățile; ce are ținta în plus rămâne; produsul nu intră în propria rețetă", RT.planCopiere(S, T, { tintaId: 9 }), [{ fel: "modificat", componenta_id: 2, veche: 0.4, noua: 0.5 }]);
  egal("copiere cu înlocuire: ce nu e în sursă se scoate", RT.planCopiere(S, T, { tintaId: 8, inlocuieste: true }).map((x) => [x.fel, x.componenta_id]), [["modificat", 2], ["adaugat", 9], ["scos", 3]]);
  egal("două rețete la fel: nimic de făcut", RT.planCopiere(S, S, { tintaId: 8, inlocuieste: true }), []);

  curata();
  q(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (98921,'Vali Rt','v.rt@test.ro','x','y','admin'), (98922,'Mihai Rt','m.rt@test.ro','x','y','productie')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, pret_achizitie, cota_tva, activ, cod_vechi_exceptat) VALUES
     (${F1}, 'RT-F1', 'RT Punga finita', 'buc', 1, 0, 21, 1, 1), (${F2}, 'RT-F2', 'RT Punga finita mare', 'buc', 2, 0, 21, 1, 1), (${F3}, 'RT-F3', 'RT Sac fara reteta', 'buc', 3, 0, 21, 1, 1),
     (${M1}, 'RT-M1', 'RT Granule', 'kg', 0, 8, 21, 1, 1), (${M2}, 'RT-M2', 'RT Colorant', 'kg', 0, 40, 21, 1, 1), (${M3}, 'RT-M3', 'RT Cutie', 'buc', 0, 2, 21, 1, 1)`);

  console.log("\n2. Rețetă nouă");
  let r = await cer("get", "/productie/retete", MIHAI);
  bine("lista are butonul „+ Rețetă nouă”", r.cod === 200 && r.corp.includes('href="/productie/retete/noua"') && r.corp.includes("+ Rețetă nouă"));
  r = await cer("get", "/productie/retete/noua", MIHAI);
  bine("pagina de rețetă nouă: alegi produsul și, opțional, de la ce rețetă pornești", r.cod === 200 && r.corp.includes('name="produs"') && r.corp.includes('name="din"') && r.corp.includes(`#${F1} · RT Punga finita [RT-F1]`));
  r = await cer("post", "/productie/retete/noua", MIHAI, { body: { produs: "RT Punga finita" } });
  egal("un nume scris fără să fie ales din listă nu deschide nimic și se spune", [/retete\/noua\?/.test(unde(r)), /Alege produsul din lista/.test(mesaj(r, "eroare"))], [true, true]);
  r = await cer("post", "/productie/retete/noua", MIHAI, { body: { produs: `#${F1} · RT Punga finita [RT-F1]` } });
  egal("produs ales, de la zero: ajungi pe pagina rețetei lui", unde(r), `/productie/retete/${F1}`);
  r = await cer("get", `/productie/retete/${F1}`, MIHAI);
  bine("rețeta goală: spune că nu e definită, are formularul de adăugat, de copiat și istoricul (gol)", /Rețeta nu e definită încă/.test(r.corp) && r.corp.includes(`/productie/retete/${F1}/adauga`) && r.corp.includes("data-copiaza-reteta") && /Nicio schimbare ținută minte/.test(r.corp));

  console.log("\n3. Adăugare, modificare, scoatere — cu istoric");
  await cer("post", `/productie/retete/${F1}/adauga`, MIHAI, { body: { componenta_id: String(M1), cantitate: "0.012" } });
  await cer("post", `/productie/retete/${F1}/adauga`, MIHAI, { body: { componenta_id: String(M2), cantitate: "0.001" } });
  egal("două componente adăugate", reteta(F1), [[M1, 0.012], [M2, 0.001]]);
  r = await cer("get", `/productie/retete/${F1}`, MIHAI);
  bine("fiecare componentă are câmpul de cantitate și „Salvează”, cu valoarea ei scrisă cu virgulă", new RegExp(`data-cantitate-componenta="${M1}"[\\s\\S]*?name="cantitate"[^>]*value="0,012"`).test(r.corp) && r.corp.includes(`/productie/retete/${F1}/cantitate`));
  r = await cer("post", `/productie/retete/${F1}/cantitate`, MIHAI, { body: { componenta_id: String(M1), cantitate: "0,015" } });
  egal("cantitatea schimbată pe loc (scrisă cu virgulă)", [reteta(F1), /Vechea valoare e în istoricul rețetei/.test(mesaj(r, "ok"))], [[[M1, 0.015], [M2, 0.001]], true]);
  r = await cer("post", `/productie/retete/${F1}/cantitate`, MIHAI, { body: { componenta_id: String(M1), cantitate: "0,015" } });
  egal("aceeași cantitate a doua oară: nimic schimbat, nimic în plus în istoric", [/nu s-a schimbat nimic/.test(mesaj(r, "ok")), istoric(F1).length], [true, 3]);
  r = await cer("post", `/productie/retete/${F1}/cantitate`, MIHAI, { body: { componenta_id: String(M1), cantitate: "0" } });
  const r0 = await cer("post", `/productie/retete/${F1}/cantitate`, MIHAI, { body: { componenta_id: String(M3), cantitate: "1" } });
  egal("zero e refuzat (pentru scos e „Scoate”); o componentă care nu e în rețetă nu se modifică de aici", [/mai mare ca zero/.test(mesaj(r, "eroare")), /nu mai e în rețetă/.test(mesaj(r0, "eroare")), reteta(F1)], [true, true, [[M1, 0.015], [M2, 0.001]]]);
  await cer("post", `/productie/retete/${F1}/sterge`, VALI, { body: { componenta_id: String(M2) } });
  egal("componenta scoasă", reteta(F1), [[M1, 0.015]]);
  egal("istoricul ține tot: adăugat, adăugat, modificat (ce era → ce a rămas), scos — cu cine a făcut-o", istoric(F1), [["adaugat", M1, null, 0.012, "om", "Mihai Rt"], ["adaugat", M2, null, 0.001, "om", "Mihai Rt"], ["modificat", M1, 0.012, 0.015, "om", "Mihai Rt"], ["scos", M2, 0.001, null, "om", "Vali Rt"]]);
  r = await cer("get", `/productie/retete/${F1}`, MIHAI);
  const ist = txt((r.corp.split('id="istoric"')[1] || ""));
  bine("pagina arată istoricul, cel mai nou sus, pe înțeles", /Vali Rt RT Colorant \[RT-M2\]: scoasă \(era 0,001\) scris de om/.test(ist) && /Mihai Rt RT Granule \[RT-M1\]: 0,012 → 0,015 scris de om/.test(ist) && ist.indexOf("scoasă") < ist.indexOf("0,012 → 0,015"), ist.slice(0, 500));
  egal("costul rețetei s-a recalculat după modificare (0,015 kg × 8 lei)", Math.round(Number(q(`SELECT cost_reteta FROM produse WHERE id = ${F1}`)[0].cost_reteta) * 10000) / 10000, 0.12);

  console.log("\n4. Rețeta luată de la alt produs");
  await cer("post", `/productie/retete/${F1}/adauga`, MIHAI, { body: { componenta_id: String(M3), cantitate: "0.01" } });
  r = await cer("post", "/productie/retete/noua", MIHAI, { body: { produs: `#${F2} · RT Punga finita mare [RT-F2]`, din: `#${F1} · RT Punga finita [RT-F1]` } });
  egal("rețetă nouă pornită de la a altui produs: componentele se copiază", [new RegExp(`/productie/retete/${F2}\\?ok=`).test(unde(r)), /2 componente copiate/.test(mesaj(r, "ok")), reteta(F2)], [true, true, [[M1, 0.015], [M3, 0.01]]]);
  egal("…rețeta-sursă rămâne neatinsă, iar în istoricul celei noi scrie de unde a venit", [reteta(F1), istoric(F2).map((x) => [x[0], x[1], x[4]]), q(`SELECT nota FROM retete_istoric WHERE produs_id = ${F2} LIMIT 1`)[0].nota], [[[M1, 0.015], [M3, 0.01]], [["adaugat", M1, "copiere"], ["adaugat", M3, "copiere"]], "din rețeta produsului „RT Punga finita”"]);
  await cer("post", `/productie/retete/${F2}/cantitate`, MIHAI, { body: { componenta_id: String(M1), cantitate: "0,03" } });
  await cer("post", `/productie/retete/${F2}/adauga`, MIHAI, { body: { componenta_id: String(M2), cantitate: "0.002" } });
  r = await cer("post", `/productie/retete/${F2}/copiaza`, MIHAI, { body: { din: `#${F1} · RT Punga finita [RT-F1]` } });
  egal("copiere peste o rețetă existentă, fără „înlocuiește”: potrivește cantitățile, păstrează ce avea în plus", reteta(F2), [[M1, 0.015], [M2, 0.002], [M3, 0.01]]);
  r = await cer("post", `/productie/retete/${F2}/copiaza`, MIHAI, { body: { din: `#${F1} · RT Punga finita [RT-F1]`, inlocuieste: "1" } });
  egal("…cu „înlocuiește”: devine exact rețeta celuilalt, iar ce s-a scos e în istoric", [reteta(F2), istoric(F2).slice(-1)[0].slice(0, 5)], [[[M1, 0.015], [M3, 0.01]], ["scos", M2, 0.002, null, "copiere"]]);
  r = await cer("post", `/productie/retete/${F2}/copiaza`, MIHAI, { body: { din: `#${F3} · RT Sac fara reteta [RT-F3]` } });
  const r1 = await cer("post", `/productie/retete/${F2}/copiaza`, MIHAI, { body: { din: `#${F2} · RT Punga finita mare [RT-F2]` } });
  const r2 = await cer("post", `/productie/retete/${F2}/copiaza`, MIHAI, { body: { din: "RT Punga" } });
  egal("refuzuri: produs fără rețetă, același produs, nume neales din listă", [/n-are rețetă/.test(mesaj(r, "eroare")), /același produs/.test(mesaj(r1, "eroare")), /Alege din listă/.test(mesaj(r2, "eroare")), reteta(F2).length], [true, true, true, 2]);
  await cer("post", `/productie/retete/${M1}/adauga`, MIHAI, { body: { componenta_id: String(M2), cantitate: "1" } });
  await RT.copiaza({ dinId: M1, inId: M2, user: MIHAI });
  egal("un produs nu ajunge în propria rețetă prin copiere", reteta(M2), []);
  q(`DELETE FROM retete_componente WHERE produs_id = ${M1}`);

  console.log("\n5. Importul din SmartBill și rețeta ținută de mână");
  egal("rețeta schimbată de om e marcată „ținută de mână”; cea neatinsă nu", [deMana(F1), deMana(F3)], [1, 0]);
  r = await cer("get", `/productie/retete/${F1}`, MIHAI);
  bine("pagina o spune și are legătura „lasă SmartBill s-o refacă”", r.corp.includes("data-reteta-de-mana") && /Rețetă ținută de mână/.test(r.corp) && r.corp.includes(`/productie/retete/${F1}/dezleaga`));
  const bon = (finit, cant, consum) => ({ finite: [{ produs: finit, cantitate: cant, um: "buc" }], consum: consum.map(([p, c]) => ({ produs: p, cantitate: c, um: "kg" })) });
  let rez = await PUNTE.HANDLERE.productie([bon("RT Punga finita", 1000, [["RT Granule", 20]]), bon("RT Sac fara reteta", 100, [["RT Granule", 5]])]);
  egal("sincronizarea nu atinge rețeta ținută de mână (rămâne 0,015, nu 0,02) și o numără", [reteta(F1), rez.reteteDeMana, istoric(F1).filter((x) => x[4] === "smartbill").length], [[[M1, 0.015], [M3, 0.01]], 1, 0]);
  egal("…dar scrie rețeta produsului neatins, cu urmă în istoric („SmartBill”)", [reteta(F3), istoric(F3), deMana(F3)], [[[M1, 0.05]], [["adaugat", M1, null, 0.05, "smartbill", null]], 0]);
  rez = await PUNTE.HANDLERE.productie([bon("RT Sac fara reteta", 1000, [["RT Granule", 50.2]])]);
  egal("o mișcare sub 1% din SmartBill se scrie în rețetă, dar nu umple istoricul", [reteta(F3), istoric(F3).length], [[[M1, 0.0502]], 1]);
  rez = await PUNTE.HANDLERE.productie([bon("RT Sac fara reteta", 1000, [["RT Granule", 70]])]);
  egal("o schimbare mare din SmartBill intră în istoric cu ce era și ce a rămas", istoric(F3).slice(-1)[0], ["modificat", M1, 0.0502, 0.07, "smartbill", null]);
  r = await cer("post", `/productie/retete/${F1}/dezleaga`, VALI);
  rez = await PUNTE.HANDLERE.productie([bon("RT Punga finita", 1000, [["RT Granule", 20]])]);
  egal("după „lasă SmartBill s-o refacă”: sincronizarea o rescrie din nou, iar dezlegarea e în istoric", [deMana(F1), reteta(F1)[0], istoric(F1).slice(-2).map((x) => [x[0], x[4]])], [0, [M1, 0.02], [["dezlegat", "om"], ["modificat", "smartbill"]]]);

  console.log("\n6. Fișa produsului și unificarea");
  await cer("post", `/produse/${F3}/reteta`, VALI, { body: { componenta_id: String(M1), cantitate: "0.08" } });
  egal("componenta adăugată din fișa produsului trece prin același loc: fără a doua linie pentru aceeași componentă, cu istoric", [reteta(F3), istoric(F3).slice(-1)[0]], [[[M1, 0.08]], ["modificat", M1, 0.07, 0.08, "om", "Vali Rt"]]);
  r = await cer("get", "/produse/nou-cu-cod", VALI);
  bine("formularul de produs nou are „Rețeta: ia-o de la produsul…”, cu produsele care au rețetă în listă (și fără cele care n-au)", r.cod === 200 && r.corp.includes("data-reteta-la-produs-nou") && r.corp.includes('name="reteta_de_la"') && r.corp.includes(`#${F1} · RT Punga finita [RT-F1]`) && !r.corp.includes(`#${M3} · RT Cutie`), String(r.cod));
  const FZ = require(path.join(RAD, "lib", "produse-fuziune.js"));
  bine("motorul de unificare a produselor știe de istoricul rețetelor (ca produs și ca materie primă)", FZ.TABELE.some((t) => t.tabel === "retete_istoric" && t.coloana === "produs_id") && FZ.TABELE.some((t) => t.tabel === "retete_istoric" && t.coloana === "componenta_id"));
  r = await cer("post", `/productie/retete/${F1}/cantitate`, null, { body: { componenta_id: String(M1), cantitate: "9" } });
  egal("fără om logat nu se schimbă nimic", [unde(r), reteta(F1)[0]], ["/login", [M1, 0.02]]);

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
