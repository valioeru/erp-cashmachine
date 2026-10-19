"use strict";
// Test pentru nomenclatorul de produse: categorie, gestiune, cost de bază,
// adaos, preț de listă, preț minim și cota de TVA.
//
// Ce apără, în ordinea în care doare dacă se strică:
//
//   • UN CÂMP NUMERIC LĂSAT GOL TREBUIE SĂ AJUNGĂ NULL, nu șirul vid. Postgres
//     refuză '' pentru o coloană REAL, iar formularul generic trimitea până
//     acum exact asta. Până la câmpurile noi nu s-a văzut, fiindcă toate
//     numerele aveau valoare implicită. „Nu știu costul de producție" e un
//     răspuns valid și n-are voie nici să crape, nici să devină zero.
//
//   • PREȚUL DE LISTĂ NU SE STOCHEAZĂ, se calculează. Formula e una singură:
//     cost × (1 + adaos/100). Dacă ar fi fost coloană, ar fi rămas în urmă la
//     prima schimbare de cost, iar un preț vechi arată exact ca unul proaspăt.
//
//   • COSTUL DE BAZĂ are trei trepte: rețeta bate costul de producție scris de
//     mână, care bate prețul de achiziție. Rețeta prima pentru că se reface
//     singură când se schimbă prețul materiilor prime.
//
//   • FĂRĂ COST NU EXISTĂ PREȚ DE LISTĂ. Nu zero — un cost zero ar da un preț
//     de listă egal cu adaosul și ar arăta ca o cifră serioasă.
//
//   • ADAOS ≠ MARJĂ. 30% adaos peste un cost de 100 dă 130; o marjă de 30% din
//     preț ar da 142,86. Pagina arată amândouă tocmai ca să nu se confunde.
//
//   • TVA: trecerea pe 21% atinge EXACT rândurile cu 19, nu cotele reduse de
//     9% și 5%, care sunt în continuare valabile.
//
//   • Câmpurile calculate NU se scriu în bază — n-au coloană, iar un INSERT
//     care le-ar include ar pica.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => {
    const esteSelect = /^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql);
    if (esteSelect) { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; }
    let i = 0;
    const s = String(sql).replace(/\?/g, () => lit(p[i++]));
    const out = execFileSync("psql", ["-X", "-c", s], { env: ENV, encoding: "utf8" });
    const m = out.match(/(?:INSERT 0|UPDATE|DELETE)\s+(\d+)/);
    return { changes: m ? Number(m[1]) : 0 };
  },
});

const produse = require(path.join(RAD, "modules", "produse.js"));

// Captăm rutele și răspunsurile.
const rute = { get: {}, post: {} };
produse.register({
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});
const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function cer(cale, { query = {}, params = {} } = {}) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipsește: GET " + cale);
  const r = res();
  await h({ user: VALI, params, query, body: {}, res: r, req: { url: cale } });
  return r;
}
async function trimite(cale, body, { params = {}, user = VALI } = {}) {
  const h = rute.post[cale];
  if (!h) throw new Error("ruta lipsește: POST " + cale);
  const r = res();
  await h({ user, params, query: {}, body, res: r, req: { url: cale } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const bine = (e, cond, d) => (cond ? ok(e) : rau(e, d));
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const rot = (v) => Math.round(Number(v) * 100) / 100;
const PFX = "TSTNOM-";

(async () => {
  exec(`DELETE FROM produse WHERE cod LIKE '${PFX}%'`);
  exec(`DELETE FROM setari_app WHERE cheie = 'adaos_lista_implicit'`);

  console.log("\n1. Adaosul implicit al firmei");
  await trimite("/produse/adaos", { adaos: "30" });
  egal("se salvează 30%", (await db.prepare("SELECT valoare FROM setari_app WHERE cheie='adaos_lista_implicit'").get()).valoare, "30");
  await trimite("/produse/adaos", { adaos: "-5" });
  egal("un adaos negativ e refuzat", (await db.prepare("SELECT valoare FROM setari_app WHERE cheie='adaos_lista_implicit'").get()).valoare, "30");
  await trimite("/produse/adaos", { adaos: "25" }, { user: { id: 2, rol: "agent" } });
  egal("un neadmin nu poate schimba adaosul", (await db.prepare("SELECT valoare FROM setari_app WHERE cheie='adaos_lista_implicit'").get()).valoare, "30");

  console.log("\n2. Produs nou: câmpurile goale nu crapă și nu devin zero");
  await trimite("/produse", {
    cod: PFX + "GOL", denumire: "TST produs fara costuri", categorie: "Ambalaje", gestiune: "Depozit central",
    unitate_masura: "buc", pret_achizitie: "", pret_productie: "", adaos_lista: "", pret_minim: "",
    pret_vanzare: "", cota_tva: "21", stoc_minim: "",
  });
  const gol = await db.prepare(`SELECT * FROM produse WHERE cod = ?`).get(PFX + "GOL");
  bine("produsul s-a creat", !!gol, "lipsește");
  egal("pret_productie gol -> NULL", gol.pret_productie, null);
  egal("adaos_lista gol -> NULL", gol.adaos_lista, null);
  egal("pret_minim gol -> NULL", gol.pret_minim, null);
  egal("categoria s-a scris", gol.categorie, "Ambalaje");
  egal("gestiunea s-a scris", gol.gestiune, "Depozit central");

  console.log("\n3. Cele trei trepte ale costului de bază");
  const fa = async (cod, den, camp) => {
    await trimite("/produse", Object.assign({
      cod: PFX + cod, denumire: den, categorie: "Folie", gestiune: "Producție", unitate_masura: "kg",
      pret_achizitie: "", pret_productie: "", adaos_lista: "", pret_minim: "", pret_vanzare: "", cota_tva: "21", stoc_minim: "",
    }, camp));
    return (await db.prepare("SELECT * FROM produse WHERE cod = ?").get(PFX + cod)).id;
  };
  const idAch = await fa("ACH", "TST doar achizitie", { pret_achizitie: "10" });
  const idProd = await fa("PROD", "TST cu cost productie", { pret_achizitie: "10", pret_productie: "8" });
  const idRet = await fa("RET", "TST cu reteta", { pret_achizitie: "10", pret_productie: "8" });
  exec(`UPDATE produse SET cost_reteta = 6 WHERE id = ${idRet}`);

  const lista = await cer("/produse", { query: { q: PFX } });
  const corp = lista.corp;
  bine("pagina se randează", corp.length > 500, `lungime ${corp.length}`);

  // Prețul de listă, verificat pe cifre: adaos 30%
  const pl = (cost) => rot(cost * 1.3);
  bine(`achiziție 10 -> preț listă ${pl(10)}`, corp.includes("13,00") || corp.includes("13.00"), "nu găsesc 13,00 în pagină");
  bine(`cost producție 8 bate achiziția 10 -> ${pl(8)}`, corp.includes("10,40") || corp.includes("10.40"), "nu găsesc 10,40");
  bine(`rețeta 6 bate și producția, și achiziția -> ${pl(6)}`, corp.includes("7,80") || corp.includes("7.80"), "nu găsesc 7,80");
  bine("sursa costului e scrisă în listă", corp.includes("rețetă") && corp.includes("producție") && corp.includes("achiziție"));

  console.log("\n4. Fără cost nu există preț de listă");
  const randGol = corp.split("TST produs fara costuri")[1] || "";
  bine("produsul fără cost nu primește un preț inventat", !/\b0,00\b.*listă/i.test(randGol.slice(0, 400)));
  bine("se afișează liniuță, nu zero", randGol.slice(0, 600).includes("—"));

  console.log("\n5. Adaosul propriu bate adaosul implicit");
  const idOwn = await fa("ADAOS", "TST cu adaos propriu", { pret_achizitie: "100", adaos_lista: "50" });
  const c2 = (await cer("/produse", { query: { q: PFX + "ADAOS" } })).corp;
  bine("100 cu adaos 50% -> 150,00", c2.includes("150,00") || c2.includes("150.00"), "nu găsesc 150,00");
  bine("se vede că adaosul e al produsului, nu implicit", c2.includes("50%"));

  console.log("\n6. Prețul minim și marja se văd în listă");
  exec(`UPDATE produse SET pret_vanzare = 9, pret_minim = 12 WHERE id = ${idAch}`);
  const c3 = (await cer("/produse", { query: { q: PFX + "ACH" } })).corp;
  bine("preț 9 sub minimul 12 e marcat", c3.includes("sub minim"), "lipsește eticheta");
  // marja din preț: (9-10)/9 = -11,1%
  bine("marja din preț se afișează (negativă aici)", /marjă\s+-11[.,]1%/.test(c3), "nu găsesc marja -11,1%");
  exec(`UPDATE produse SET pret_vanzare = 20, pret_minim = 12 WHERE id = ${idAch}`);
  const c4 = (await cer("/produse", { query: { q: PFX + "ACH" } })).corp;
  bine("la preț 20 nu mai apare „sub minim\"", !c4.includes("sub minim"));
  bine("dar apare „sub listă\" doar când e cazul", !c4.includes("sub listă"));

  console.log("\n7. Căutarea și filtrele");
  const cCaut = (await cer("/produse", { query: { q: "cu reteta" } })).corp;
  bine("căutarea după denumire găsește produsul", cCaut.includes("TST cu reteta"));
  bine("și nu-l aduce pe cel fără legătură", !cCaut.includes("TST produs fara costuri"));
  const cFiltru = (await cer("/produse", { query: { categorie: "Ambalaje" } })).corp;
  bine("filtrul pe categorie aduce Ambalaje", cFiltru.includes("TST produs fara costuri"));
  bine("filtrul pe categorie exclude Folie", !cFiltru.includes("TST cu reteta"));
  bine("selectul de categorii conține valorile existente", cFiltru.includes(">Folie<") && cFiltru.includes(">Ambalaje<"));

  console.log("\n8. Cota de TVA");
  exec(`UPDATE produse SET cota_tva = 19 WHERE cod IN ('${PFX}ACH','${PFX}PROD')`);
  exec(`UPDATE produse SET cota_tva = 9 WHERE cod = '${PFX}RET'`);
  const cBanner = (await cer("/produse", { query: {} })).corp;
  bine("bannerul anunță produsele rămase pe 19%", cBanner.includes("încă TVA 19%"), "lipsește bannerul");
  await trimite("/produse/tva", {}, { user: { id: 2, rol: "agent" } });
  egal("un neadmin nu poate trece TVA-ul", Number((await db.prepare(`SELECT COUNT(*) AS n FROM produse WHERE cod LIKE '${PFX}%' AND cota_tva = 19`).get()).n), 2);
  await trimite("/produse/tva", {});
  egal("adminul trece cele două de la 19 la 21", Number((await db.prepare(`SELECT COUNT(*) AS n FROM produse WHERE cod LIKE '${PFX}%' AND cota_tva = 19`).get()).n), 0);
  egal("cota redusă de 9% NU se atinge", Number((await db.prepare(`SELECT cota_tva FROM produse WHERE cod = '${PFX}RET'`).get()).cota_tva), 9);

  console.log("\n9. Produsul nou intră direct cu 21%");
  const coloana = await db.prepare("SELECT column_default AS d FROM information_schema.columns WHERE table_name='produse' AND column_name='cota_tva'").get();
  egal("valoarea implicită din bază e 21", String(coloana.d), "21");

  console.log("\n10. Câmpurile calculate nu se scriu în bază");
  const coloane = (await db.prepare("SELECT column_name AS c FROM information_schema.columns WHERE table_name='produse'").all()).map((x) => x.c);
  bine("nu există coloana _cost", !coloane.includes("_cost"));
  bine("nu există coloana _lista", !coloane.includes("_lista"));
  // editarea trece prin aceleași câmpuri — nu trebuie să pice
  await trimite("/produse/:id/editare", {
    cod: PFX + "ACH", denumire: "TST doar achizitie", categorie: "Folie", gestiune: "Producție",
    unitate_masura: "kg", pret_achizitie: "11", pret_productie: "", adaos_lista: "", pret_minim: "12",
    pret_vanzare: "20", cota_tva: "21", stoc_minim: "",
  }, { params: { id: idAch } });
  const dupa = await db.prepare("SELECT * FROM produse WHERE id = ?").get(idAch);
  egal("editarea a salvat prețul de achiziție", Number(dupa.pret_achizitie), 11);
  egal("editarea a lăsat costul de producție NULL", dupa.pret_productie, null);

  console.log("\n11. Formularul de adăugare se deschide și are câmpurile noi");
  const formular = (await cer("/produse/nou")).corp;
  for (const camp of ["categorie", "gestiune", "pret_productie", "adaos_lista", "pret_minim"]) {
    bine(`formularul are câmpul ${camp}`, formular.includes(`name="${camp}"`));
  }
  bine("categoria are sugestii (datalist)", formular.includes("<datalist id=\"dl_categorie\""));
  bine("TVA-ul implicit în formular e 21", /name="cota_tva" value="21"/.test(formular));

  exec(`DELETE FROM produse WHERE cod LIKE '${PFX}%'`);
  exec(`DELETE FROM setari_app WHERE cheie = 'adaos_lista_implicit'`);

  console.log(rele ? `\n${rele} probleme.` : "\nToate verificările trec.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat testul: " + e.message); process.exit(1); });
