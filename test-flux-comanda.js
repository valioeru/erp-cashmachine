"use strict";
// Fluxul complet al comenzii, de la producție la client, pe PostgreSQL real
// (portul 5433), prin rutele adevărate.
//
// CEREREA LUI VALI, 05.11.2026:
//   „Când schimbăm status în finalizată, comanda să se schimbe automat peste
//    tot în ERP. Adică în comenzi să apară producție finalizată, la depozit să
//    apară de preluat în depozit, când apare în depozit să apară în comenzi în
//    depozit, apoi când din depozit e gata de livrare etc. Adică un flux
//    complet frumos."
//
// CE APĂRĂ, în ordinea drumului:
//
//   • „FINALIZATĂ" DIN LISTA DE PRODUCȚIE ajunge peste tot: comanda clientului
//     „producție finalizată" (abia când TOATE comenzile ei de producție sunt
//     gata), cererea depozitului „gata", recepția „de preluat" deschisă
//     singură, data finalizării pusă.
//   • DEPOZITUL VEDE CE ARE DE PRELUAT: pe /depozit și pe comanda din depozit.
//   • O „FINALIZATĂ" PUSĂ DIN GREȘEALĂ se retrage: comanda revine „în
//     producție", recepția neîncepută se anulează.
//   • PRELUAREA (recepția finalizată) pune comanda „în stoc depozit" doar când
//     a intrat tot; până atunci rămâne „producție finalizată".
//   • „GATA DE LIVRARE" din depozit, apoi „PE DRUM" și „LIVRATĂ" din
//     logistică mută comanda până la capăt.
//   • ÎNAPOI NU SE MERGE: verificarea depozitului nu strică o comandă
//     pregătită, iar o comandă plecată nu mai stă în lista depozitului.
//   • PRODUCȚIA NU ANULEAZĂ COMANDA CLIENTULUI: o comandă de producție anulată
//     o pune pe „așteaptă marfă", iar depozitul vede cererea refuzată.
//   • REGISTRUL VECHI, fără legături, nu umple depozitul cu recepții.
//   • MARFA CU RECEPȚIE DESCHISĂ nu intră a doua oară pe „Intră în stoc".
//   • FIECARE PAS e scris în istoricul clientului.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
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
      const out = execFileSync("psql", ["-X", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
// În ordinea din server.js.
for (const m of ["ct-park", "productie", "warehouse", "comenzi", "facturi", "receptie", "logistica"]) {
  require(path.join(RAD, "modules", m + ".js")).register(router);
}

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(metoda, cale, user, params, body, query) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params: params || {}, query: query || {}, body: body || {}, res: r, req: { url: cale, headers: {} } });
  return r;
}
const loc = (r) => decodeURIComponent(String((r.antet && r.antet.Location) || ""));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

const PREFIX = "TEST-FLUX";
const RAND_HARTA = 93;
function curata() {
  const rand = unul(`SELECT id FROM ct_randuri WHERE numar = ${RAND_HARTA}`);
  if (rand) {
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${rand})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${rand}`);
    q(`DELETE FROM ct_sectoare WHERE rand_id = ${rand}`);
    q(`DELETE FROM ct_randuri WHERE id = ${rand}`);
  }
  const parteneri = q(`SELECT id FROM parteneri WHERE nume LIKE '${PREFIX} %'`).map((r) => Number(r.id));
  const comenzi = q(`SELECT id FROM comenzi WHERE numar LIKE '${PREFIX}-%'`).map((r) => Number(r.id));
  const produse = q(`SELECT id FROM produse WHERE cod LIKE 'TST-FLUX-%'`).map((r) => Number(r.id));
  const cp = q(`SELECT id FROM comenzi_productie WHERE observatii LIKE '%${PREFIX}%' OR comanda_id IN (${comenzi.join(",") || 0})`).map((r) => Number(r.id));
  const rec = q(`SELECT id FROM receptii WHERE comanda_productie_id IN (${cp.join(",") || 0}) OR comanda_id IN (${comenzi.join(",") || 0})`).map((r) => Number(r.id));
  const l = (a) => a.join(",") || "0";
  const fact = q(`SELECT id FROM facturi WHERE serie = 'TSTFLUX' OR comanda_id IN (${l(comenzi)})`).map((r) => Number(r.id));
  q(`DELETE FROM notificari_facturi WHERE factura_id IN (${l(fact)})`);
  q(`DELETE FROM plati WHERE factura_id IN (${l(fact)})`);
  q(`DELETE FROM facturi_linii WHERE factura_id IN (${l(fact)})`);
  q(`UPDATE comenzi SET factura_id = NULL WHERE factura_id IN (${l(fact)})`);
  q(`DELETE FROM facturi WHERE id IN (${l(fact)})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${l(rec)}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${l(rec)})`);
  q(`DELETE FROM receptii WHERE id IN (${l(rec)})`);
  q(`DELETE FROM stoc_locuri WHERE produs_id IN (${l(produse)})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${l(produse)})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${l(produse)})`);
  q(`DELETE FROM transport_curse WHERE comanda_id IN (${l(comenzi)})`);
  q(`DELETE FROM comenzi_productie_caracteristici WHERE comanda_id IN (${l(cp)})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${l(cp)})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${l(cp)})`);
  q(`DELETE FROM aprovizionari WHERE comanda_id IN (${l(comenzi)}) OR produs_id IN (${l(produse)})`);
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${l(comenzi)})`);
  q(`DELETE FROM comenzi WHERE id IN (${l(comenzi)})`);
  q(`DELETE FROM interactiuni WHERE partener_id IN (${l(parteneri)})`);
  q(`DELETE FROM produse WHERE id IN (${l(produse)})`);
  q(`DELETE FROM parteneri WHERE id IN (${l(parteneri)})`);
}

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const VALI = { id: idUser, nume: "Vali", rol: "admin" };
  const MIHAI = { id: idUser, nume: "Mihai Mosneanu", rol: "productie" };
  const DEPOZIT = { id: idUser, nume: "Om Depozit", rol: "depozit" };
  const depozitId = Number(unul("SELECT id FROM depozite ORDER BY id LIMIT 1"));

  const client = Number(q(`INSERT INTO parteneri (nume, tip) VALUES ('${PREFIX} Client', 'client') RETURNING id`)[0].id);
  const p1 = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-FLUX-P1', 'TEST-FLUX Pungă curier', 'buc') RETURNING id")[0].id);
  const p2 = Number(q("INSERT INTO produse (cod, denumire, unitate_masura) VALUES ('TST-FLUX-P2', 'TEST-FLUX Bandă', 'buc') RETURNING id")[0].id);
  const comanda = Number(q(`INSERT INTO comenzi (partener_id, numar, data, status) VALUES (${client}, '${PREFIX}-1', '2026-11-05', 'noua') RETURNING id`)[0].id);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${comanda}, ${p1}, 100, 1), (${comanda}, ${p2}, 50, 2)`);
  const a1 = Number(q(`INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, status, termen_cerut) VALUES (${comanda}, ${p1}, 100, 'productie', 'ceruta', '2026-11-20') RETURNING id`)[0].id);
  const a2 = Number(q(`INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, status, termen_cerut) VALUES (${comanda}, ${p2}, 50, 'productie', 'ceruta', '2026-11-20') RETURNING id`)[0].id);
  const status = () => unul(`SELECT status FROM comenzi WHERE id = ${comanda}`);
  const istoric = () => q(`SELECT subiect FROM interactiuni WHERE partener_id = ${client} ORDER BY id`).map((r) => r.subiect);

  console.log("\n1. Producția confirmă cererile depozitului");
  await cer("post", "/productie/cereri/:id/confirma", MIHAI, { id: String(a1) }, { termen: "2026-11-20" });
  await cer("post", "/productie/cereri/:id/confirma", MIHAI, { id: String(a2) }, { termen: "2026-11-20" });
  const cp1 = Number(unul(`SELECT id FROM comenzi_productie WHERE aprovizionare_id = ${a1}`));
  const cp2 = Number(unul(`SELECT id FROM comenzi_productie WHERE aprovizionare_id = ${a2}`));
  bine("s-au deschis două comenzi de producție", cp1 && cp2 && cp1 !== cp2, [cp1, cp2]);
  bine("comanda clientului e „în producție”", status() === "in_productie", status());

  console.log("\n2. „Finalizată” din LISTA de producție, pe prima comandă");
  let r = await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(cp1), status: "finalizata" });
  bine("lista primește 204, ca până acum", r.cod === 204, r.cod);
  const c1 = q(`SELECT * FROM comenzi_productie WHERE id = ${cp1}`)[0];
  bine("data finalizării e pusă", Boolean(c1.data_finalizare), c1.data_finalizare);
  bine("cererea depozitului e „gata”", unul(`SELECT status FROM aprovizionari WHERE id = ${a1}`) === "gata");
  const r1 = Number(c1.receptie_id);
  bine("recepția „din producție” s-a deschis singură, anunțată", r1 && unul(`SELECT stare FROM receptii WHERE id = ${r1}`) === "asteptata" && unul(`SELECT sursa FROM receptii WHERE id = ${r1}`) === "productie", r1);
  bine("cu produsul și cantitatea făcută", unul(`SELECT cantitate_asteptata FROM receptii_linii WHERE receptie_id = ${r1} AND produs_id = ${p1}`) === "100");
  bine("comanda clientului rămâne „în producție”: a doua comandă încă se face", status() === "in_productie", status());

  console.log("\n3. „Finalizată” și pe a doua: abia acum „producție finalizată”");
  await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(cp2), status: "finalizata" });
  bine("comanda clientului e „producție finalizată”", status() === "productie_finalizata", status());
  bine("și scrie asta în istoricul clientului", istoric().some((s) => /producție finalizată/.test(s)), istoric().join(" | "));
  const r2 = Number(unul(`SELECT receptie_id FROM comenzi_productie WHERE id = ${cp2}`));
  bine("a doua recepție s-a deschis", r2 && r2 !== r1);

  console.log("\n4. Depozitul vede ce are de preluat");
  const dep = await cer("get", "/depozit", DEPOZIT);
  bine("/depozit are secțiunea „De preluat din producție”", /id="de-preluat"/.test(dep.corp) && /De preluat din producție/.test(dep.corp));
  bine("cu amândouă recepțiile și butonul „Preia în depozit”", dep.corp.includes(`/depozit/receptie/${r1}"`) && dep.corp.includes(`/depozit/receptie/${r2}"`) && /Preia în depozit/.test(dep.corp));
  bine("în lista de comenzi, comanda apare „producție finalizată”", /badge verde">producție finalizată</.test(dep.corp));
  const depC = await cer("get", "/depozit/comanda/:id", DEPOZIT, { id: String(comanda) });
  bine("și pe comanda din depozit: „De preluat din producție”", /De preluat din producție:/.test(depC.corp) && depC.corp.includes(`/depozit/receptie/${r1}"`));
  const agent = await cer("get", "/comenzi/:id", VALI, { id: String(comanda) });
  bine("agentul vede pe comandă „producție finalizată” și marfa „de preluat în depozit”", /producție finalizată/.test(agent.corp) && /de preluat în depozit/.test(agent.corp));
  bine("și nu poate factura încă (marfa n-a văzut-o depozitul)", !/action="\/comenzi\/\d+\/factureaza"/.test(agent.corp));
  // Butonul „Depozit" din bară duce pe harta CT-Park: și acolo trebuie să se vadă.
  if (!Number(unul("SELECT COUNT(*) FROM ct_randuri"))) {
    q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
       VALUES (${RAND_HARTA}, 'produse finite', 1, 1, 1, 800, 1200, 1)`);
    const rid = Number(unul(`SELECT id FROM ct_randuri WHERE numar = ${RAND_HARTA}`));
    q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${rid}, 1, 1, 1, 'R${RAND_HARTA}-01-1-1', 0)`);
  }
  const harta = await cer("get", "/stocuri/ct-park", DEPOZIT);
  bine("pe harta depozitului: „De preluat din producție: 2”, cu buton", /De preluat din producție: 2<\/strong>/.test(harta.corp) && /href="\/depozit#de-preluat"/.test(harta.corp));
  const hartaAgent = await cer("get", "/stocuri/ct-park", { id: idUser, nume: "Agent", rol: "vanzari", sectiuni: "/crm" });
  bine("cine n-are acces la depozit nu vede banda", !/De preluat din producție/.test(hartaAgent.corp));

  console.log("\n5. „Finalizată” din greșeală: producția revine");
  await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(cp2), status: "in_productie" });
  bine("comanda clientului revine „în producție”", status() === "in_productie", status());
  bine("recepția neîncepută s-a anulat", unul(`SELECT stare FROM receptii WHERE id = ${r2}`) === "anulata");
  const c2 = q(`SELECT * FROM comenzi_productie WHERE id = ${cp2}`)[0];
  bine("comanda de producție nu mai e „trimisă în depozit”, iar data finalizării s-a șters", !c2.receptie_id && !c2.trimisa_depozit_la && !c2.data_finalizare, JSON.stringify(c2).slice(0, 200));
  bine("cererea depozitului e iar „confirmată”", unul(`SELECT status FROM aprovizionari WHERE id = ${a2}`) === "confirmata");
  // Și din fișă (calea cealaltă), din nou „Finalizată".
  await cer("post", "/productie/:id/actualizeaza", MIHAI, { id: String(cp2) }, { status: "finalizata" });
  const r2b = Number(unul(`SELECT receptie_id FROM comenzi_productie WHERE id = ${cp2}`));
  bine("din fișă, „Finalizată” face același lucru: recepție nouă", r2b && r2b !== r2 && unul(`SELECT stare FROM receptii WHERE id = ${r2b}`) === "asteptata");
  bine("și comanda clientului e iar „producție finalizată”", status() === "productie_finalizata", status());

  console.log("\n6. „Intră în stoc” nu dublează o recepție deschisă");
  const inainteStoc = Number(unul(`SELECT COUNT(*) FROM miscari_stoc WHERE produs_id = ${p1}`));
  r = await cer("post", "/depozit/aprovizionare/:id/primita", DEPOZIT, { id: String(a1) }, { depozit_id: String(depozitId) });
  bine("refuzat, cu trimitere la recepție", /are deja recepția/.test(loc(r)), loc(r));
  bine("și nicio mișcare de stoc", Number(unul(`SELECT COUNT(*) FROM miscari_stoc WHERE produs_id = ${p1}`)) === inainteStoc);

  console.log("\n7. Depozitul preia prima recepție");
  const linie1 = Number(unul(`SELECT id FROM receptii_linii WHERE receptie_id = ${r1}`));
  r = await cer("post", "/depozit/receptie/:id/linie/:lid", DEPOZIT, { id: String(r1), lid: String(linie1) }, { cantitate_primita: "100" });
  bine("rândul se salvează", /Rând salvat/.test(loc(r)), loc(r));
  // Producția se răzgândește după ce depozitul a început recepția: recepția
  // rămâne (are cantități numărate), iar la o nouă „Finalizată" nu se
  // deschide a doua.
  await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(cp1), status: "in_productie" });
  bine("o recepție începută nu se anulează la o revenire a producției", unul(`SELECT stare FROM receptii WHERE id = ${r1}`) === "in_lucru" && Number(unul(`SELECT receptie_id FROM comenzi_productie WHERE id = ${cp1}`)) === r1);
  bine("comanda clientului arată că încă se lucrează", status() === "in_productie", status());
  await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(cp1), status: "finalizata" });
  bine("„Finalizată” din nou nu deschide a doua recepție", Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${cp1} AND stare <> 'anulata'`)) === 1);
  bine("iar comanda e iar „producție finalizată”", status() === "productie_finalizata", status());
  r = await cer("post", "/depozit/receptie/:id/finalizeaza", DEPOZIT, { id: String(r1) });
  bine("recepția se finalizează", /Recepție finalizată/.test(loc(r)), loc(r));
  bine("marfa e pe stoc", Number(unul(`SELECT COALESCE(SUM(cantitate), 0) FROM miscari_stoc WHERE produs_id = ${p1} AND tip = 'intrare'`)) === 100);
  bine("comanda rămâne „producție finalizată”: a doua marfă încă e de preluat", status() === "productie_finalizata", status());

  console.log("\n8. Și pe a doua: comanda e „în stoc depozit”");
  const linie2 = Number(unul(`SELECT id FROM receptii_linii WHERE receptie_id = ${r2b}`));
  await cer("post", "/depozit/receptie/:id/linie/:lid", DEPOZIT, { id: String(r2b), lid: String(linie2) }, { cantitate_primita: "50" });
  r = await cer("post", "/depozit/receptie/:id/finalizeaza", DEPOZIT, { id: String(r2b) });
  bine("comanda clientului e „în stoc depozit”", status() === "in_stoc_depozit", status());
  bine("pagina recepției spune unde a ajuns comanda", /Comanda clientului e acum „în stoc depozit”/.test(loc(r)), loc(r));
  bine("în istoric: marfa a intrat", istoric().some((s) => /în stoc depozit/.test(s)), istoric().join(" | "));
  const fisaProd = await cer("get", "/productie/:id", MIHAI, { id: String(cp2) });
  bine("producția vede pe fișă că marfa a fost preluată", /preluată în depozit/.test(fisaProd.corp) && /în stoc depozit/.test(fisaProd.corp));
  const agent2 = await cer("get", "/comenzi/:id", VALI, { id: String(comanda) });
  bine("agentul poate factura acum", /action="\/comenzi\/\d+\/factureaza"/.test(agent2.corp));
  bine("pe comanda lui, marfa e „preluată în depozit”", (agent2.corp.match(/preluată în depozit/g) || []).length === 2);
  const depGol = await cer("get", "/depozit", DEPOZIT);
  bine("în depozit nu mai e nimic de preluat pentru comanda asta", !depGol.corp.includes(`/depozit/receptie/${r1}"`) && !depGol.corp.includes(`/depozit/receptie/${r2b}"`));

  console.log("\n9. Gata de livrare");
  r = await cer("post", "/depozit/comanda/:id/gata-livrare", DEPOZIT, { id: String(comanda) });
  bine("depozitul o pune „gata de livrare”", status() === "gata_livrare" && /Gata de livrare/.test(loc(r)), status() + " " + loc(r));
  bine("cu cine și când", Boolean(unul(`SELECT gata_livrare_la FROM comenzi WHERE id = ${comanda}`)) && unul(`SELECT gata_livrare_de FROM comenzi WHERE id = ${comanda}`) === "Om Depozit");
  await cer("post", "/depozit/comanda/:id/confirma", DEPOZIT, { id: String(comanda) });
  bine("o nouă verificare de stoc n-o dă înapoi", status() === "gata_livrare", status());
  const log = await cer("get", "/logistica", DEPOZIT, {}, {}, {});
  bine("în Logistică apare la „Gata de livrat”, cu starea ei", log.corp.includes(`${PREFIX}-1`) && /gata de livrare/.test(log.corp));

  console.log("\n10. Pe drum, apoi livrată");
  await cer("post", "/logistica/cursa/din-comanda/:id", DEPOZIT, { id: String(comanda) });
  const cursa = Number(unul(`SELECT id FROM transport_curse WHERE comanda_id = ${comanda}`));
  r = await cer("post", "/logistica/cursa/:id/pe-drum", DEPOZIT, { id: String(cursa) });
  bine("o cursă nealocată nu pleacă", /doar o cursă alocată/.test(loc(r)), loc(r));
  q(`UPDATE transport_curse SET stare = 'alocata' WHERE id = ${cursa}`);
  const pagCursa = await cer("get", "/logistica/cursa/:id", DEPOZIT, { id: String(cursa) });
  bine("cursa alocată are butoanele „Pe drum” și „Livrată”", /Pe drum — a plecat mașina/.test(pagCursa.corp) && /Livrată — a ajuns la client/.test(pagCursa.corp));
  await cer("post", "/logistica/cursa/:id/pe-drum", DEPOZIT, { id: String(cursa) });
  bine("cursa e pe drum", unul(`SELECT stare FROM transport_curse WHERE id = ${cursa}`) === "in_curs");
  bine("comanda clientului e „în livrare”", status() === "in_livrare", status());
  const depDupa = await cer("get", "/depozit", DEPOZIT);
  bine("plecată, nu mai stă în lista depozitului", !depDupa.corp.includes(`>${PREFIX}-1<`));
  await cer("post", "/logistica/cursa/:id/livrata", DEPOZIT, { id: String(cursa) }, { data: "2026-11-06" });
  bine("cursa e livrată, cu data", unul(`SELECT stare FROM transport_curse WHERE id = ${cursa}`) === "livrata" && unul(`SELECT data_livrare_reala FROM transport_curse WHERE id = ${cursa}`) === "2026-11-06");
  bine("comanda clientului e „livrată”", status() === "livrata", status());
  bine("în istoric: în livrare, livrată", istoric().some((s) => /în livrare/.test(s)) && istoric().some((s) => /: livrată$/.test(s)), istoric().join(" | "));
  // Marfa a plecat cu aviz, iar factura se validează după. Comanda nu se
  // întoarce de la „livrată” la „facturată”.
  const fid = Number(q(`INSERT INTO facturi (serie, partener_id, comanda_id, directie, status) VALUES ('TSTFLUX', ${client}, ${comanda}, 'vanzare', 'ciorna') RETURNING id`)[0].id);
  q(`INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${fid}, ${p1}, 'TEST-FLUX Pungă curier', 100, 1, 21)`);
  await cer("post", "/facturi/:id/valideaza", VALI, { id: String(fid) });
  bine("factura s-a validat", unul(`SELECT status FROM facturi WHERE id = ${fid}`) === "emisa");
  bine("dar comanda livrată rămâne „livrată”, nu se întoarce la „facturată”", status() === "livrata", status());

  console.log("\n11. Producția nu anulează comanda clientului");
  const comanda2 = Number(q(`INSERT INTO comenzi (partener_id, numar, data, status) VALUES (${client}, '${PREFIX}-2', '2026-11-05', 'noua') RETURNING id`)[0].id);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${comanda2}, ${p1}, 900, 1)`);
  const a3 = Number(q(`INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, status, termen_cerut) VALUES (${comanda2}, ${p1}, 900, 'productie', 'ceruta', '2026-11-25') RETURNING id`)[0].id);
  await cer("post", "/productie/cereri/:id/confirma", MIHAI, { id: String(a3) }, { termen: "2026-11-25" });
  const cp3 = Number(unul(`SELECT id FROM comenzi_productie WHERE aprovizionare_id = ${a3}`));
  await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(cp3), status: "anulata" });
  const st2 = unul(`SELECT status FROM comenzi WHERE id = ${comanda2}`);
  bine("comanda clientului NU e anulată: „așteaptă marfă”", st2 === "asteapta_marfa", st2);
  bine("cererea depozitului e refuzată, cu motivul", unul(`SELECT status FROM aprovizionari WHERE id = ${a3}`) === "refuzata" && /anulată de Mihai/.test(unul(`SELECT raspuns FROM aprovizionari WHERE id = ${a3}`) || ""));
  const depC2 = await cer("get", "/depozit/comanda/:id", DEPOZIT, { id: String(comanda2) });
  bine("depozitul are butonul de anulare, ca la un termen refuzat", /Anulează comanda/.test(depC2.corp));

  console.log("\n12. Registrul vechi, fără legături, nu umple depozitul");
  const vechi = Number(q(`INSERT INTO comenzi_productie (numar, client_text, tip_produs, cantitate, status, sursa, observatii) VALUES ('${PREFIX}-VECHI', 'Client vechi', 'Folie', '10', 'noua', 'registru', '${PREFIX} vechi') RETURNING id`)[0].id);
  await cer("post", "/productie/stare", MIHAI, {}, { comanda_id: String(vechi), status: "finalizata" });
  const cv = q(`SELECT * FROM comenzi_productie WHERE id = ${vechi}`)[0];
  bine("se finalizează, cu dată", cv.status === "finalizata" && Boolean(cv.data_finalizare));
  bine("dar fără recepție în depozit", !cv.receptie_id && Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${vechi}`)) === 0);

  console.log("\n13. Comenzile puse pe „Finalizată” înainte de update se aduc la zi");
  const comanda3 = Number(q(`INSERT INTO comenzi (partener_id, numar, data, status) VALUES (${client}, '${PREFIX}-3', '2026-11-04', 'in_productie') RETURNING id`)[0].id);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${comanda3}, ${p2}, 30, 2)`);
  const a4 = Number(q(`INSERT INTO aprovizionari (comanda_id, produs_id, cantitate, sursa, status, termen_cerut) VALUES (${comanda3}, ${p2}, 30, 'productie', 'confirmata', '2026-11-10') RETURNING id`)[0].id);
  // Cum le lăsa lista veche: producția „finalizată”, nimic altceva mișcat.
  const cp4 = Number(q(`INSERT INTO comenzi_productie (numar, comanda_id, aprovizionare_id, partener_id, tip_produs, cantitate, um, status, sursa, observatii)
     VALUES ('${PREFIX}-P4', ${comanda3}, ${a4}, ${client}, 'TEST-FLUX Bandă', '30', 'buc', 'finalizata', 'depozit', '${PREFIX} vechi') RETURNING id`)[0].id);
  q(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um) VALUES (${cp4}, ${p2}, 'TEST-FLUX Bandă', '30', 'buc')`);
  // A doua comandă de producție a ei e deja trimisă în depozit (recepție
  // neîncepută): nu primește încă una.
  const cp4b = Number(q(`INSERT INTO comenzi_productie (numar, comanda_id, partener_id, tip_produs, cantitate, um, status, sursa, observatii)
     VALUES ('${PREFIX}-P4B', ${comanda3}, ${client}, 'TEST-FLUX Bandă', '5', 'buc', 'finalizata', 'manual', '${PREFIX} vechi') RETURNING id`)[0].id);
  const r4b = Number(q(`INSERT INTO receptii (numar, sursa, comanda_productie_id, comanda_id, stare, data) VALUES ('REC-TESTFLUX-4B', 'productie', ${cp4b}, ${comanda3}, 'asteptata', '2026-11-04') RETURNING id`)[0].id);
  q(`UPDATE comenzi_productie SET trimisa_depozit_la = '2026-11-04', receptie_id = ${r4b} WHERE id = ${cp4b}`);
  // Și una cu ceva încă în lucru, care NU e rămasă în urmă.
  const comanda4 = Number(q(`INSERT INTO comenzi (partener_id, numar, data, status) VALUES (${client}, '${PREFIX}-4', '2026-11-04', 'in_productie') RETURNING id`)[0].id);
  q(`INSERT INTO comenzi_productie (numar, comanda_id, status, sursa, observatii) VALUES ('${PREFIX}-P5', ${comanda4}, 'finalizata', 'manual', '${PREFIX} vechi'), ('${PREFIX}-P6', ${comanda4}, 'in_productie', 'manual', '${PREFIX} vechi')`);
  const lista = await cer("get", "/productie", VALI);
  bine("adminul vede comanda rămasă în urmă, cu butonul", lista.corp.includes(`>${PREFIX}-3<`) && /Du-le mai departe/.test(lista.corp));
  bine("dar nu și pe cea care încă se produce", !lista.corp.includes(`>${PREFIX}-4<`));
  const listaMihai = await cer("get", "/productie", MIHAI);
  bine("producția nu vede butonul (e o schimbare pe comenzi reale)", !/Du-le mai departe/.test(listaMihai.corp));
  await cer("post", "/productie/adu-la-zi", MIHAI);
  bine("și nici nu-l poate apăsa pe ascuns", unul(`SELECT status FROM comenzi WHERE id = ${comanda3}`) === "in_productie");
  r = await cer("post", "/productie/adu-la-zi", VALI);
  bine("aduse la zi, cu mesaj", /„producție finalizată”/.test(loc(r)) && /recepți/.test(loc(r)), loc(r));
  bine("comanda clientului e „producție finalizată”", unul(`SELECT status FROM comenzi WHERE id = ${comanda3}`) === "productie_finalizata");
  bine("cererea depozitului e „gata”", unul(`SELECT status FROM aprovizionari WHERE id = ${a4}`) === "gata");
  const c4 = q(`SELECT * FROM comenzi_productie WHERE id = ${cp4}`)[0];
  bine("marfa e la „De preluat din producție”, cu cantitatea", c4.receptie_id && unul(`SELECT stare FROM receptii WHERE id = ${c4.receptie_id}`) === "asteptata" && unul(`SELECT cantitate_asteptata FROM receptii_linii WHERE receptie_id = ${c4.receptie_id}`) === "30");
  bine("data finalizării nu se inventează", !c4.data_finalizare);
  bine("comanda de producție deja trimisă nu primește a doua recepție", Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${cp4b}`)) === 1);
  bine("cealaltă comandă rămâne „în producție”", unul(`SELECT status FROM comenzi WHERE id = ${comanda4}`) === "in_productie");
  r = await cer("post", "/productie/adu-la-zi", VALI);
  bine("a doua apăsare nu mai face nimic (nici a doua recepție)", Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${cp4}`)) === 1 && /^\/productie\?ok=0 /.test(loc(r)), loc(r));

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
