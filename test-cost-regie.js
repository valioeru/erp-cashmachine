"use strict";
// Costul marfă din rețete: fără regie și fără rețetele scrise pe lot.
// Pe PostgreSQL real (prin psql), ca restul testelor de producție.
//
// CE A OBSERVAT VALI, 29.10.2026: „la cost marfă, comenzi din producție, din
// rețete — în rețete sunt activele firmei și nu e corect."
//
// CE APĂRĂ:
//
//   • SALARIILE, TRANSPORTUL ȘI ENERGIA NU SUNT MARFĂ. Rapoartele de producție
//     din SmartBill le repartizează pe lot, iar puntea le aducea în rețetă ca
//     pe niște componente oarecare. Costul din rețetă trebuie să fie doar
//     materialele. Liniile rămân în rețetă — nu se șterg date — doar nu se
//     adună, și nu se numără nici „fără cost".
//
//   • RECUNOAȘTEREA E STRICTĂ. „Folie stretch transport palet" e folie, nu
//     transport. Un material luat drept regie ar ieși în tăcere din cost.
//
//   • O REȚETĂ SCRISĂ PE LOT NU INTRĂ ÎN TOTALUL COMENZILOR. Una singură (pe
//     1.000 de plicuri, citită pe un plic, ori 700.000 de plicuri) făcea 23,6
//     milioane din 23,75 pe cardul „Cost marfă, comenzi deschise". Comanda se
//     scoate din total și se arată separat, cu link spre rețetă; pagina
//     comenzii și necesarul de materie primă spun același lucru.
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
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const REG = require(path.join(RAD, "lib", "regie.js"));
const COST = require(path.join(RAD, "lib", "cost.js"));

// Rutele: prima înregistrare câștigă, ca în router.
const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; } };
require(path.join(RAD, "modules", "retete.js")).register(router);
require(path.join(RAD, "modules", "productie.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, params, query) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipsește: GET " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params: params || {}, query: query || {}, body: {}, res: r, req: { url: cale } });
  return r;
}

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 260) : "")); esecuri++; }
}
const aproape = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

const PFX = "TSTREG-";
function curata() {
  q(`DELETE FROM comenzi_productie WHERE numar LIKE '${PFX}%'`);
  q(`DELETE FROM retete_componente WHERE produs_id IN (SELECT id FROM produse WHERE cod LIKE '${PFX}%')
        OR componenta_id IN (SELECT id FROM produse WHERE cod LIKE '${PFX}%')`);
  q(`DELETE FROM produse WHERE cod LIKE '${PFX}%'`);
}
function produs(cod, denumire, pretAchizitie, pretVanzare) {
  return Number(unul(`INSERT INTO produse (cod, denumire, unitate_masura, pret_achizitie, pret_vanzare)
                      VALUES (${lit(PFX + cod)}, ${lit(denumire)}, 'buc', ${lit(pretAchizitie)}, ${lit(pretVanzare)}) RETURNING id`));
}
function reteta(produsId, componente) {
  for (const [id, cant] of componente) q(`INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (${produsId}, ${id}, ${cant})`);
}
function comanda(numar, produsId, cantitate, status, valoare) {
  return Number(unul(`INSERT INTO comenzi_productie (numar, tip_produs, produs_id, cantitate, um, status, data_initiere, valoare_estimata)
                      VALUES (${lit(PFX + numar)}, 'Test regie', ${produsId}, ${lit(cantitate)}, 'buc', ${lit(status || "noua")}, '2026-10-29', ${lit(valoare == null ? null : valoare)}) RETURNING id`));
}

(async () => {
  console.log("\n1. Ce e regie și ce e marfă (după nume)");
  for (const n of [
    "Salarii - Salarii", "Transport - Transport", "Energie electrica - Electricitate", "Energie electrică",
    "Manopera", "Chirie hala", "Amortizare utilaje", "Utilitati - Utilitati", "Gaze naturale", "SALARII",
  ]) bine(`regie: „${n}"`, REG.eRegie(n));
  for (const n of [
    "Folie stretch transport palet", "Banda transportoare 2m", "Cutie transport 600x400x400",
    "ALTE MATERESLE CONSUMABILE - consumabile (hot melt + release liner)", "Hartie release liner 40 g/m2",
    "Granule LDPE", "Plicuri autoadezive AWB C5 CM (AWBCM)", "", null,
    // Începe cu „transport", dar e descrierea lungă a unei folii — liniile de
    // regie din SmartBill sunt scurte („Transport - Transport").
    "Transport paleti folie stretch 23my 500mm 2,2kg",
  ]) bine(`marfă: „${n}"`, !REG.eRegie(n));

  console.log("\n2. Costul din rețetă = doar materialele");
  curata();
  const folie = produs("FOLIE", "Folie LDPE test", 2, null);
  const adeziv = produs("ADEZ", "Adeziv test", 0.5, null);
  const sal = produs("SAL", "Salarii - Salarii", 1, null);
  const tr = produs("TR", "Transport - Transport", 1, null);
  const en = produs("EN", "Energie electrica - Electricitate", 1, null);
  const stretch = produs("STR", "Folie stretch transport palet", 0.25, null);
  const fara = produs("FARA", "Componenta fara pret test", null, null);

  const punga = produs("PUNGA", "Punga test cu regie", null, 10);
  reteta(punga, [[folie, 1], [adeziv, 2], [sal, 3], [tr, 0.5], [en, 1], [stretch, 4]]);
  const doarRegie = produs("DOARREG", "Produs test doar regie", null, 10);
  reteta(doarRegie, [[sal, 2], [en, 2]]);
  const partial = produs("PART", "Produs test partial", null, 10);
  reteta(partial, [[folie, 1], [fara, 1], [tr, 5]]);
  const cutie = produs("CUTIE", "Set test din pungi", null, 50);
  reteta(cutie, [[punga, 2], [sal, 10]]);

  const r = await COST.recalculeazaRetete();
  const citeste = (id) => q(`SELECT cost_reteta, cost_reteta_lipsa FROM produse WHERE id = ${id}`)[0];
  // 1×2 + 2×0,5 + 4×0,25 = 4 lei; regia (3 + 0,5 + 1 = 4,5 lei) nu intră.
  bine("punga: 4 lei (folie + adeziv + stretch), fără cei 4,5 lei de regie", aproape(citeste(punga).cost_reteta, 4), citeste(punga).cost_reteta);
  bine("punga: nicio componentă „fără cost” — regia nu se numără ca lipsă", Number(citeste(punga).cost_reteta_lipsa) === 0, citeste(punga).cost_reteta_lipsa);
  bine("folia stretch „transport palet” RĂMÂNE în cost (e marfă)", aproape(citeste(punga).cost_reteta, 4) && !aproape(citeste(punga).cost_reteta, 3));
  bine("rețeta doar cu regie: fără cost, dar și fără lipsuri inventate", citeste(doarRegie).cost_reteta === null && Number(citeste(doarRegie).cost_reteta_lipsa) === 0, JSON.stringify(citeste(doarRegie)));
  bine("parțial: 2 lei, 1 componentă de marfă fără cost (transportul nu e lipsă)", aproape(citeste(partial).cost_reteta, 2) && Number(citeste(partial).cost_reteta_lipsa) === 1, JSON.stringify(citeste(partial)));
  bine("în cascadă: setul din 2 pungi = 8 lei, fără salariile lui și fără ale pungii", aproape(citeste(cutie).cost_reteta, 8), citeste(cutie).cost_reteta);
  bine("recalculul spune câte rețete aveau regie", Number(r.cu_regie) >= 4, JSON.stringify(r));

  console.log("\n3. Detaliul rețetei: regia separat, nu în total");
  const d = await COST.detaliuReteta(punga);
  bine("liniile de marfă: 3", d.linii.length === 3, d.linii.map((l) => l.denumire).join(", "));
  bine("liniile de regie: 3", d.regie.length === 3, d.regie.map((l) => l.denumire).join(", "));
  bine("totalul = 4 lei", aproape(d.total, 4), d.total);
  bine("regia lăsată deoparte = 4,5 lei pe bucată", aproape(d.totalRegie, 4.5), d.totalRegie);
  bine("nicio linie de regie printre liniile de marfă", !d.linii.some((l) => REG.eRegie(l.denumire)));

  const pag = await cer("/productie/retete/:id", { id: String(punga) });
  const t = text(pag.corp);
  bine("pagina rețetei se randează", pag.cod === 200 && pag.corp.length > 1000, pag.cod);
  bine("pagina are secțiunea costurilor firmei", t.includes("Costuri ale firmei") && t.includes("nu intră în costul marfă"));
  bine("salariile apar în secțiunea lor, după tabelul de marfă", pag.corp.indexOf("Salarii - Salarii") > pag.corp.indexOf("Costuri ale firmei"), pag.corp.indexOf("Salarii - Salarii"));
  bine("totalul pe bucată afișat e 4,00 lei", /TOTAL pe bucată.{0,200}4,00 lei/.test(t), (t.match(/TOTAL pe bucată.{0,120}/) || [""])[0]);
  bine("regia lăsată deoparte se vede: 4,50 lei", /Lăsat deoparte, pe bucată.{0,200}4,50 lei/.test(t), (t.match(/Lăsat deoparte.{0,120}/) || [""])[0]);
  bine("linia de regie se poate scoate din rețetă", (pag.corp.match(/name="componenta_id" value="(\d+)"/g) || []).some((m) => m.includes(`"${sal}"`)));

  console.log("\n4. Necesarul de materie primă nu cere salarii din depozit");
  const cPunga = comanda("PUNGA", punga, "100", "noua", 1000);
  const nec = await cer("/productie/:id/necesar", { id: String(cPunga) });
  const tabelNec = (nec.corp.split("<table")[1] || "").split("</table>")[0];
  bine("necesarul se randează", nec.cod === 200, nec.cod);
  bine("în tabel: folia, adezivul și stretch-ul", tabelNec.includes("Folie LDPE test") && tabelNec.includes("Adeziv test") && tabelNec.includes("Folie stretch transport palet"));
  bine("în tabel NU: salarii, transport, energie", !tabelNec.includes("Salarii - Salarii") && !tabelNec.includes("Transport - Transport") && !tabelNec.includes("Energie electrica"));
  bine("regia e pomenită sub tabel, ca să nu pară pierdută", text(nec.corp).includes("costuri ale firmei"));
  bine("costul materiei prime = 100 × 4 = 400,00 lei", /Cost materie primă\s*400,00 lei/.test(text(nec.corp)), (text(nec.corp).match(/Cost materie primă.{0,40}/) || [""])[0]);
  bine("o rețetă plauzibilă n-are avertismentul de lot", !nec.corp.includes("reteta-pe-lot"));

  console.log("\n5. Cardul „Cost marfă, comenzi deschise” nu adună rețetele pe lot");
  // Plicul: rețetă scrisă pe 1.000 de bucăți — 40 m² de hârtie „pe plic".
  const hartie = produs("HART", "Hartie release test", 0.5, null);
  const plic = produs("PLIC", "Plic test AWB", null, 0.04);
  reteta(plic, [[hartie, 40], [sal, 9]]);
  await COST.recalculeazaRetete();
  bine("rețeta plicului: 20 lei pe „bucată” (40 m² × 0,5), fără salarii", aproape(citeste(plic).cost_reteta, 20), citeste(plic).cost_reteta);
  const cPlic = comanda("PLIC", plic, "700000", "noua", 28000);
  const cFinal = comanda("FIN", punga, "50", "finalizata", 500);
  comanda("FACT", punga, "1000", "facturata", 10000); // închisă: nu se numără deloc

  const pur = COST.costMarfaComenzi(
    [
      { id: 1, numar: "A", cantitate: "100", produs_id: 1, produs: "x", cost_reteta: 4, pret_vanzare: 10 },
      { id: 2, numar: "B", cantitate: "700000", produs_id: 2, produs: "plic", cost_reteta: 20, pret_vanzare: 0.04 },
      { id: 3, numar: "C", cantitate: "5", produs_id: 3, produs: "fără rețetă", cost_reteta: null, pret_vanzare: 3 },
      { id: 4, numar: "D", cantitate: "10", produs_id: 4, produs: "fără preț", cost_reteta: 7, pret_vanzare: null, valoare_estimata: null },
      { id: 5, numar: "E", cantitate: "10", produs_id: 5, produs: "lot după valoarea comenzii", cost_reteta: 50, pret_vanzare: null, valoare_estimata: 100 },
    ],
    new Map()
  );
  bine("calcul: 100 × 4 + 10 × 7 = 470 lei", aproape(pur.cost, 470), pur.cost);
  bine("calcul: 2 comenzi cu cost cunoscut din 5 deschise", pur.cuCost === 2 && pur.deschise === 5, JSON.stringify({ cuCost: pur.cuCost, deschise: pur.deschise }));
  bine("calcul: plicul și comanda E sunt de verificat", pur.deVerificat.map((x) => x.numar).join(",") === "B,E", pur.deVerificat.map((x) => x.numar).join(","));
  bine("calcul: plicul ar fi adus 14 milioane", aproape(pur.deVerificat[0].total, 14000000), pur.deVerificat[0].total);
  bine("calcul: fără preț de referință, costul intră (n-avem cu ce compara)", pur.cost >= 70);
  bine("calcul: media facturată bate prețul de catalog", COST.pretReperProdus(new Map([[9, { mediu: 2, linii: 3 }]]), 9, 50, 0).pret === 2);
  bine("calcul: cantitatea „1 200 buc” se citește 1200", COST.cantitateComanda("1 200 buc") === 1200);

  const lista = await cer("/productie", {}, {});
  const tl = text(lista.corp);
  const card = (tl.match(/Cost marfă, comenzi deschise\s*([\d.]+,\d\d) lei/) || [])[1];
  // Pe baza de test pot exista și alte comenzi deschise; cifra noastră trebuie
  // să fie exact cea fără plic: punga 100 × 4 + punga finalizată 50 × 4 = 600.
  const altele = Number(unul(`SELECT COALESCE(SUM(pr.cost_reteta * NULLIF(regexp_replace(c.cantitate, '[^0-9.]', '', 'g'), '')::numeric), 0)
                                FROM comenzi_productie c JOIN produse pr ON pr.id = c.produs_id
                               WHERE c.status IN ('noua','in_productie','finalizata') AND c.numar NOT LIKE '${PFX}%'`)) || 0;
  const asteptat = 600 + altele;
  const citit = card ? Number(card.replace(/\./g, "").replace(",", ".")) : NaN;
  bine(`cardul arată ${asteptat.toFixed(2)} lei — fără cele 14 milioane ale plicului`, aproape(citit, asteptat), card);
  bine("cardul spune că a lăsat deoparte o comandă", /fără 1 comandă cu rețetă de verificat/.test(tl), (tl.match(/din rețete, doar materialele.{0,60}/) || [""])[0]);
  bine("sub carduri: comanda plicului, cu link spre ea și spre rețetă", lista.corp.includes(`href="/productie/${cPlic}"`) && lista.corp.includes(`href="/productie/retete/${plic}"`));
  bine("se spune cât ar fi adăugat: 14.000.000,00 lei", tl.includes("14.000.000,00 lei"), (tl.match(/ar fi adăugat.{0,40}/) || [""])[0]);
  bine("de câte ori depășește prețul: 500", /de 500 ori/.test(tl), (tl.match(/de [\d.]+ ori/) || [""])[0]);
  bine("comanda facturată nu intră nicăieri", !lista.corp.includes(`TSTREG-FACT</a> —`));

  console.log("\n6. Pagina comenzii și necesarul spun același lucru");
  const det = await cer("/productie/:id", { id: String(cPlic) });
  const td = text(det.corp);
  bine("pagina comenzii se randează", det.cod === 200, det.cod);
  bine("costul e marcat „de verificat”, nu dat drept cifră", det.corp.includes("reteta-pe-lot") && td.includes("Cost din rețetă: de verificat"));
  bine("pagina comenzii nu prezintă cele 14 milioane ca cost pe comandă", !/14\.000\.000,00 lei\s*pe toată comanda/.test(td));
  const detBun = await cer("/productie/:id", { id: String(cPunga) });
  bine("o comandă cu rețetă bună își arată costul normal: 400,00 lei pe toată comanda", /400,00 lei\s*pe toată comanda/.test(text(detBun.corp)) && !detBun.corp.includes("reteta-pe-lot"), (text(detBun.corp).match(/Cost din rețetă.{0,120}/) || [""])[0]);
  const necPlic = await cer("/productie/:id/necesar", { id: String(cPlic) });
  bine("necesarul plicului avertizează să nu se comande marfă după el", necPlic.corp.includes("reteta-pe-lot") && text(necPlic.corp).includes("Nu comanda marfă după lista asta"));
  void cFinal;

  curata();
  await COST.recalculeazaRetete();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
