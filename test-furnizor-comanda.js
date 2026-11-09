"use strict";
// Furnizorul pe comandă. PostgreSQL real + Chromium.
//
// CEREREA LUI VALI, 06.11.2026:
//   „La comandă, dacă marfa nu e în stoc, n-ai cum să alegi furnizor."
//   „Să fie furnizor obligatoriu doar dacă găsește produsul în stoc, altfel să
//    fie pusă fără, și furnizorul se alocă când se alocă materialul în
//    producție."
//
// CE APĂRĂ:
//   • REGULA (lib/furnizor-linie.js): furnizorii se strâng din paleții de pe
//     stoc, cei mai plini întâi; se cer doar dacă se știe măcar unul; paleții
//     fără furnizor sunt o opțiune în plus, nu un blocaj.
//   • STOCUL: doar paleții încă în CT-Park, doar liniile cu marfă, doar la
//     produsele din familii cu caracteristica „Furnizor".
//   • PANOUL „CONFIGUREAZĂ" nu mai cere furnizorul: produsul iese fără el,
//     chiar dacă formularul l-ar trimite.
//   • SALVAREA COMENZII: oprită fără furnizor doar când produsul e pe stoc cu
//     furnizor știut; furnizorul trebuie să fie dintre cei de pe stoc; numărul
//     liniei din mesaj e rândul din formular.
//   • MODIFICAREA: liniile vechi nu sunt oprite și își păstrează furnizorul,
//     chiar dacă paleții lui au plecat; schimbarea intră în istoric.
//   • PRODUCȚIA: furnizorul ales la alocarea materialului ajunge pe liniile
//     clientului fără furnizor (și le corectează pe cele puse tot de ea), nu
//     atinge ce a ales agentul din stoc, intră în istoricul comenzii și pleacă
//     la recepție pe paleți. Doar producția, depozitul și adminul îl aleg.
//   • DEPOZITUL: comanda la un furnizor anume dă linia fără furnizor lui.
//   • BROWSERUL: lista apare doar la produsul pe stoc și e obligatorie; nota
//     altfel; rândul nou pornește gol; câmpurile rămân aliniate.
const path = require("path");
const Module = require("module");
const fs = require("fs");
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
// Niciun email nu pleacă din test: anunțul de comandă nouă găsește un modul de
// mail fără niciun cont configurat și se scrie în istoric ca „eșuat".
const MAIL = { configUtilizator: () => null, trimite: async () => { throw new Error("din test nu pleacă mailuri"); } };
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail(\.js)?$/.test(req)) return MAIL;
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length }; },
});

const rute = { get: {}, post: {} };
const inreg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
for (const m of ["comenzi", "warehouse", "productie", "retete", "ct-park", "receptie"]) require(path.join(RAD, "modules", m + ".js")).register(inreg);

const FL = require(path.join(RAD, "lib", "furnizor-linie.js"));
const FC = require(path.join(RAD, "lib", "furnizor-comanda.js"));
const K = require(path.join(RAD, "lib", "comanda-config.js"));
const CP = require(path.join(RAD, "modules", "cod-produs.js"));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- fixturi ----------------------------------------------------------------
const FAM = 98801, C_TIP = 98811, C_FURN = 98812;
// Familia de revânzare, cu furnizorul scris ca TEXT în produs (WBVFOL01).
const FAM2 = 98802, C2_FURN = 98813, C2_DEN = 98814;
const P_M = 98831, P_FARA = 98832, P_NESCRIS = 98833, P_BANDA = 98834, P_A = 98835, P_REV = 98836;
const S1 = 98841, S2 = 98842, CLIENT = 98843, AMBELE = 98844, DUBLU1 = 98845, DUBLU2 = 98846;
const PALETI = [98851, 98852, 98853, 98854, 98855, 98856, 98857, 98858, 98859, 98860, 98861];
const REC = 98871, REC_L = 98872;

function curata() {
  const com = q(`SELECT id FROM comenzi WHERE partener_id = ${CLIENT}`).map((r) => Number(r.id));
  const cps = q(`SELECT id FROM comenzi_productie WHERE numar LIKE 'TFC-P%' OR comanda_id IN (${com.concat([0]).join(",")})`).map((r) => Number(r.id));
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (SELECT id FROM ct_paleti WHERE receptie_id = ${REC})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (SELECT id FROM ct_paleti WHERE receptie_id = ${REC})`);
  q(`DELETE FROM ct_paleti WHERE receptie_id = ${REC}`);
  q(`DELETE FROM receptii_linii WHERE receptie_id = ${REC}`);
  q(`DELETE FROM receptii WHERE id = ${REC}`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${cps.concat([0]).join(",")})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${cps.concat([0]).join(",")})`);
  q(`DELETE FROM aprovizionari WHERE comanda_id IN (${com.concat([0]).join(",")})`);
  q(`DELETE FROM rezervari_stoc WHERE comanda_id IN (${com.concat([0]).join(",")})`);
  q(`DELETE FROM comenzi_istoric WHERE comanda_id IN (${com.concat([0]).join(",")})`);
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${com.concat([0]).join(",")})`);
  q(`DELETE FROM emailuri WHERE partener_id = ${CLIENT}`);
  q(`DELETE FROM comenzi WHERE id IN (${com.concat([0]).join(",")})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${PALETI.join(",")})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${PALETI.join(",")})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${PALETI.join(",")})`);
  q(`DELETE FROM retete_componente WHERE produs_id IN (${P_FARA}, ${P_BANDA})`);
  const prod = q(`SELECT id FROM produse WHERE cod_familie_id IN (${FAM}, ${FAM2}) OR id IN (${P_M},${P_FARA},${P_NESCRIS},${P_BANDA},${P_A},${P_REV})`).map((r) => Number(r.id));
  q(`DELETE FROM produse_cod_valori WHERE produs_id IN (${prod.concat([0]).join(",")})`);
  q(`DELETE FROM produse WHERE id IN (${prod.concat([0]).join(",")})`);
  q(`DELETE FROM cod_valori WHERE caracteristica_id IN (${C_TIP}, ${C_FURN}, ${C2_FURN}, ${C2_DEN})`);
  q(`DELETE FROM cod_caracteristici WHERE familie_id IN (${FAM}, ${FAM2})`);
  q(`DELETE FROM cod_familii WHERE id IN (${FAM}, ${FAM2})`);
  q(`DELETE FROM parteneri WHERE id IN (${S1},${S2},${CLIENT},${AMBELE},${DUBLU1},${DUBLU2})`);
}

function fixturi() {
  q(`INSERT INTO cod_familii (id, nume, prefix, activ, ordine) VALUES (${FAM}, 'TFC Folie test', NULL, 1, 999)`);
  q(`INSERT INTO cod_caracteristici (id, familie_id, nume, fel, in_cod, ordine, obligatoriu, activ) VALUES
       (${C_TIP}, ${FAM}, 'Tip TFC', 'lista', 1, 1, 1, 1),
       (${C_FURN}, ${FAM}, 'Furnizor', 'lista', 1, 2, 1, 1)`);
  q(`INSERT INTO cod_valori (caracteristica_id, valoare, cod, ordine, activ) VALUES
       (${C_TIP}, 'Manuală', 'QQM', 1, 1), (${C_TIP}, 'Automată', 'QQA', 2, 1), (${C_FURN}, 'WBV', 'W', 1, 1)`);
  q(`INSERT INTO cod_familii (id, nume, prefix, activ, ordine) VALUES (${FAM2}, 'TFC Revânzare test', NULL, 1, 999)`);
  q(`INSERT INTO cod_caracteristici (id, familie_id, nume, fel, in_cod, ordine, obligatoriu, activ, in_denumire) VALUES
       (${C2_FURN}, ${FAM2}, 'Furnizor', 'text', 1, 1, 1, 1, 0),
       (${C2_DEN}, ${FAM2}, 'Denumire', 'text', 1, 2, 1, 1, 1)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, activ, cod_familie_id, categorie) VALUES
       (${P_M}, 'TFCM', 'TFC Folie M', 'rolă', 10, 1, ${FAM}, 'TFC'),
       (${P_FARA}, 'TFCF', 'TFC Folie fără stoc', 'rolă', 11, 1, ${FAM}, 'TFC'),
       (${P_NESCRIS}, 'TFCN', 'TFC Folie nescris', 'rolă', 12, 1, ${FAM}, 'TFC'),
       (${P_BANDA}, 'TFCB', 'TFC Bandă', 'buc', 3, 1, NULL, 'TFC'),
       (${P_A}, 'TFCA', 'TFC Folie A', 'rolă', 13, 1, ${FAM}, 'TFC'),
       (${P_REV}, 'TFCR', 'TFC Revânzare', 'buc', 14, 1, ${FAM2}, 'TFC')`);
  q(`INSERT INTO parteneri (id, tip, nume) VALUES
       (${S1}, 'furnizor', 'TFC Furnizor Unu SRL'), (${S2}, 'furnizor', 'TFC Furnizor Doi SRL'),
       (${CLIENT}, 'client', 'TFC Client SRL'), (${AMBELE}, 'ambele', 'TFC Ambele SRL'),
       (${DUBLU1}, 'furnizor', 'TFC Dublu SRL'), (${DUBLU2}, 'furnizor', 'TFC DUBLU S.R.L.')`);
  // [palet, produs, furnizor_id, furnizor_text, cantitate pe linie, ieșit?]
  const P = [
    [98851, P_M, S1, null, 10, false],
    [98852, P_M, S1, null, 5, false],
    [98853, P_M, S2, null, 3, false],
    [98854, P_M, null, null, 2, false],
    [98855, P_M, S2, null, 7, true], // plecat din depozit: nu contează
    [98856, P_M, null, "Furnizor Liber SRL", 4, false],
    [98857, P_NESCRIS, null, null, 6, false],
    [98858, P_BANDA, S1, null, 9, false],
    [98859, P_M, S2, null, 0, false], // linie golită: nu contează
    [98860, P_A, S1, null, 8, false],
    [98861, P_REV, S1, null, 5, false],
  ];
  for (const [id, prod, fid, ftext, cant, iesit] of P) {
    q(`INSERT INTO ct_paleti (id, cod, produs_id, cantitate, um, data_intrare, data_iesire, furnizor_id, furnizor_text)
       VALUES (?, ?, ?, ?, 'rolă', '2026-11-01', ?, ?, ?)`, [id, "TFC-" + id, prod, cant, iesit ? "2026-11-02" : null, fid, ftext]);
    q(`INSERT INTO ct_palet_linii (palet_id, produs_id, cantitate, um) VALUES (?, ?, ?, 'rolă')`, [id, prod, cant]);
  }
  // Rețeta: folia fără stoc se face din bandă (doar ca să aibă material pe stoc).
  q(`INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (${P_FARA}, ${P_BANDA}, 1)`);
}

const VALI = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Vali Test", email: "vali@test", rol: "admin" };
const AGENT = Object.assign({}, VALI, { nume: "Agent Test", rol: "vanzari" });

async function cer(metoda, cale, { user = VALI, params = {}, query = {}, body = {} } = {}) {
  const r = { cod: 0, antet: {}, corp: "" };
  r.writeHead = (c, h) => { r.cod = c; r.antet = h || {}; return r; };
  r.setHeader = () => {};
  r.end = (b) => { r.corp = b || ""; };
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsă: " + metoda + " " + cale);
  await h({ user, params, query, body, res: r, req: { url: cale } });
  return r;
}
const comenziClient = () => q(`SELECT id FROM comenzi WHERE partener_id = ${CLIENT} ORDER BY id`).map((r) => Number(r.id));
const liniile = (cid) => q(`SELECT id, produs_id, furnizor_id, furnizor_text, furnizor_sursa, cantitate FROM comenzi_linii WHERE comanda_id = ? ORDER BY id`, [cid]);
// Harnașul citește șirul gol ca NULL; în istoric „gol” e același lucru.
const istoric = (cid) => q(`SELECT ce, COALESCE(vechi, '') AS vechi, COALESCE(nou, '') AS nou FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id`, [cid]).map((h) => ({ ce: h.ce, vechi: h.vechi || "", nou: h.nou || "" }));

function corpComanda(linii, extra) {
  return Object.assign(
    {
      partener_id: String(CLIENT), client_cautat: "TFC Client SRL", numar: "TFC", observatii: "", data_livrare_ceruta: "2099-12-01",
      livrare_partiala: "da", moneda: "RON",
      "produs_id[]": linii.map((l) => String(l[0] || "")),
      "cantitate[]": linii.map((l) => String(l[1] == null ? "" : l[1])),
      "pret_unitar[]": linii.map(() => "10"),
      "um[]": linii.map(() => "rolă"),
      "furnizor_ales[]": linii.map((l) => l[2] || ""),
    },
    extra || {}
  );
}
async function plaseaza(linii) {
  const inainte = comenziClient();
  const r = await cer("post", "/comenzi", { body: corpComanda(linii) });
  const noi = comenziClient().filter((id) => !inainte.includes(id));
  return { r, id: noi[0] || null, noi };
}

(async () => {
  curata();
  fixturi();

  // ---------------------------------------------------------------------------
  console.log("\n1. Regula, fără bază de date");
  const s0 = FL.optiuniDinStoc([
    { furnizor_id: 1, furnizor_nume: "Alfa", cantitate: 5, um: "rolă", paleti: 1 },
    { furnizor_id: 1, furnizor_nume: "Alfa", cantitate: "2.5", um: "rolă", paleti: 1 },
    { furnizor_id: null, furnizor_text: " Liber ", cantitate: 10, um: "rolă", paleti: 2 },
    { furnizor_id: null, furnizor_text: "", cantitate: 1, um: "rolă", paleti: 1 },
    { furnizor_id: 2, furnizor_nume: "Beta", cantitate: 0, paleti: 1 },
    { furnizor_id: 3, furnizor_nume: "Gama", cantitate: 7.5, um: "rolă", paleti: 1 },
  ]);
  egal("opțiunile, cele mai pline întâi, egalitatea după nume", s0.optiuni.map((o) => o.cheie + "=" + o.cantitate), ["t:Liber=10", "p:1=7.5", "p:3=7.5", "n=1"]);
  egal("paleții se adună pe furnizor", s0.optiuni.find((o) => o.cheie === "p:1").paleti, 2);
  egal("se cere furnizor", s0.cere, true);
  egal("totalul, cu paleții nescriși", s0.total, 26);
  const s1 = FL.optiuniDinStoc([{ furnizor_id: null, furnizor_text: null, cantitate: 6, um: "rolă", paleti: 1 }]);
  egal("doar paleți fără furnizor: nu se cere", [s1.cere, s1.optiuni.length, s1.nescris.cantitate], [false, 0, 6]);
  egal("fără stoc", [FL.optiuniDinStoc([]).cere, FL.optiuniDinStoc([]).total, FL.optiuniDinStoc(null).total], [false, 0, 0]);
  egal("furnizor din Parteneri fără nume", FL.optiuniDinStoc([{ furnizor_id: 9, cantitate: 1 }]).optiuni[0].nume, "furnizor #9");
  bine("mesaj: nu e pe stoc", /^Nu e pe stoc: furnizorul se alege în producție/.test(FL.mesaj(FL.optiuniDinStoc([]))));
  bine("mesaj: pe stoc cu furnizori", /alege furnizorul/.test(FL.mesaj(s0)));
  egal("mesaj: pe stoc fără furnizor scris", FL.mesaj(s1), "Pe stoc: 6 rolă, fără furnizor scris pe palet.");
  egal("alegerea p:", FL.citesteAlegerea("p:12"), { furnizor_id: 12, furnizor_text: null });
  egal("alegerea t:", FL.citesteAlegerea("t: WBV GmbH "), { furnizor_id: null, furnizor_text: "WBV GmbH" });
  egal("alegerea n", FL.citesteAlegerea("n"), { furnizor_id: null, furnizor_text: FL.NESCRIS });
  egal("alegeri care nu se citesc", ["", null, "p:abc", "x", "p:", "t:"].map((v) => FL.citesteAlegerea(v)), [null, null, null, null, null, null]);
  egal("cheia liniei", [FL.cheiaLiniei({ furnizor_id: "12" }), FL.cheiaLiniei({ furnizor_text: "WBV" }), FL.cheiaLiniei({ furnizor_text: FL.NESCRIS }), FL.cheiaLiniei({}), FL.cheiaLiniei(null)], ["p:12", "t:WBV", "n", "", ""]);
  egal("eticheta", [FL.eticheta({ furnizor_id: 12 }, "Alfa"), FL.eticheta({ furnizor_id: 12 }), FL.eticheta({ furnizor_text: FL.NESCRIS }), FL.eticheta({ furnizor_text: " X " }), FL.eticheta(null)], ["Alfa", "furnizor #12", "paleții fără furnizor scris", "X", ""]);
  egal("sursa", [FL.sursa("stoc"), FL.sursa("productie"), FL.sursa("aprovizionare"), FL.sursa("x"), FL.sursa(null)], ["ales din stoc", "din producție", "comandat de depozit", "", ""]);
  egal("caracteristica Furnizor", [FL.eFurnizor({ nume: "Furnizor" }), FL.eFurnizor({ nume: "furnizorul rolei" }), FL.eFurnizor({ nume: "Grosime" }), FL.eFurnizor(null)], [true, true, false, false]);
  egal("se mută pe linie doar cel ales din listă, nu cel scris ca text", [
    FL.eFurnizorDeLinie({ nume: "Furnizor", fel: "lista" }),
    FL.eFurnizorDeLinie({ nume: "Furnizor" }),
    FL.eFurnizorDeLinie({ nume: "Furnizor", fel: "text" }),
    FL.eFurnizorDeLinie({ nume: "Cod furnizor", fel: "text" }),
    FL.eFurnizorDeLinie({ nume: "Tip", fel: "lista" }),
  ], [true, true, false, false, false]);
  const campuri = K.campuriFamiliei([
    { id: 1, nume: "Furnizor", fel: "lista", ordine: 2 },
    { id: 2, nume: "Tip", fel: "lista", ordine: 1 },
    { id: 3, nume: "Cod furnizor", fel: "text", ordine: 3 },
  ]);
  egal("panoul primește semnul „furnizor” doar pe Furnizor din listă", campuri.map((c) => c.nume + ":" + (c.furnizor || 0)), ["Tip:0", "Furnizor:1", "Cod furnizor:0"]);

  // ---------------------------------------------------------------------------
  console.log("\n2. Stocul pe furnizori, din CT-Park");
  const st = await FC.pentruProdus(P_M);
  egal("produsul din familia cu Furnizor e relevant", st.relevant, true);
  egal("opțiunile de pe stoc", st.optiuni.map((o) => o.cheie + "=" + o.cantitate + "/" + o.paleti), [`p:${S1}=15/2`, "t:Furnizor Liber SRL=4/1", `p:${S2}=3/1`, "n=2/1"]);
  egal("numele din Parteneri", st.optiuni[0].nume, "TFC Furnizor Unu SRL");
  egal("se cere, totalul fără paletul plecat și linia goală", [st.cere, st.total], [true, 24]);
  const fara = await FC.pentruProdus(P_FARA);
  egal("fără stoc: nu se cere", [fara.relevant, fara.cere, fara.total, fara.optiuni.length], [true, false, 0, 0]);
  const nescris = await FC.pentruProdus(P_NESCRIS);
  egal("doar paleți fără furnizor: nu se cere", [nescris.cere, nescris.mesaj], [false, "Pe stoc: 6 rolă, fără furnizor scris pe palet."]);
  const banda = await FC.pentruProdus(P_BANDA);
  egal("produsul fără Furnizor în familie nu e relevant, deși are stoc", [banda.relevant, banda.cere, banda.optiuni.length], [false, false, 0]);
  egal("fără produs", (await FC.pentruProdus(0)).relevant, false);
  const rev = await FC.pentruProdus(P_REV);
  egal("furnizorul scris în produs (text liber): nu se mai cere pe linie", [rev.relevant, rev.cere], [false, false]);
  q(`UPDATE cod_caracteristici SET activ = 0 WHERE id = ${C_FURN}`);
  egal("caracteristica Furnizor dezactivată: nu mai e relevant", (await FC.pentruProdus(P_M)).relevant, false);
  q(`UPDATE cod_caracteristici SET activ = 1 WHERE id = ${C_FURN}`);

  // ---------------------------------------------------------------------------
  console.log("\n3. Ruta /comenzi/furnizori-stoc");
  const rj = await cer("get", "/comenzi/furnizori-stoc", { query: { produs: String(P_M) } });
  const j = JSON.parse(rj.corp);
  egal("răspunde JSON cu ce trebuie formularului", [rj.cod, j.relevant, j.cere, j.total, j.optiuni.length, j.optiuni[0].cheie, j.optiuni[0].um], [200, true, true, 24, 4, `p:${S1}`, "rolă"]);
  bine("mesajul e acolo", /alege furnizorul/.test(j.mesaj));
  const r403 = await cer("get", "/comenzi/furnizori-stoc", { user: null, query: { produs: String(P_M) } });
  egal("fără autentificare: 403", r403.cod, 403);

  // ---------------------------------------------------------------------------
  console.log("\n4. Panoul „configurează” nu mai cere furnizorul");
  const g1 = await CP.genereaza({ [C_TIP]: "Manuală" }, FAM);
  bine("în nomenclator Furnizor rămâne obligatoriu", !g1.ok && g1.lipsa.includes("Furnizor"), JSON.stringify(g1.lipsa));
  const g2 = await CP.genereaza({ [C_TIP]: "Manuală" }, FAM, { faraFurnizor: true });
  egal("pe comandă iese fără el", [g2.ok, g2.cod], [true, "QQM"]);
  const g3 = await CP.genereaza({ [C_TIP]: "Manuală", [C_FURN]: "WBV" }, FAM, { faraFurnizor: true });
  egal("…chiar dacă formularul îl trimite", [g3.ok, g3.cod, g3.bucati_toate.map((b) => b.nume)], [true, "QQM", ["Tip TFC"]]);
  const pv = await cer("post", "/comenzi/produs-configurat", { body: { familie: String(FAM), ["c_" + C_TIP]: "Manuală", ["c_" + C_FURN]: "WBV" } });
  const pvj = JSON.parse(pv.corp);
  egal("previzualizarea", [pvj.cod, pvj.sePoate], ["QQM", true]);
  const cr = await cer("post", "/comenzi/produs-configurat/creeaza", { body: { familie: String(FAM), ["c_" + C_TIP]: "Manuală", um: "rolă" } });
  const crj = JSON.parse(cr.corp);
  egal("produsul scris pe comandă n-are furnizor în cod", [cr.cod, crj.cod], [200, "QQM"]);
  egal("…și nici în caracteristicile lui", q(`SELECT nume FROM produse_cod_valori WHERE produs_id = ?`, [crj.id]).map((r) => r.nume), ["Tip TFC"]);
  const pag = await cer("get", "/comenzi/nou");
  const familii = JSON.parse(pag.corp.match(/var COMENZI_FAMILII = (.*?);\n/)[1]);
  const fam = familii.find((f) => f.id === FAM);
  egal("formularul primește familia cu Furnizor semnat", fam.campuri.map((c) => c.nume + ":" + (c.furnizor || 0)), ["Tip TFC:0", "Furnizor:1"]);
  egal("…iar la revânzare Furnizor rămâne căsuță de completat", familii.find((f) => f.id === FAM2).campuri.map((c) => c.nume + ":" + c.fel + ":" + (c.furnizor || 0)), ["Furnizor:text:0", "Denumire:text:0"]);
  const g4 = await CP.genereaza({ [C2_FURN]: "TFC Revânzare GmbH", [C2_DEN]: "Folie test" }, FAM2, { faraFurnizor: true });
  bine("…și intră în codul produsului și pe comandă", g4.ok && /^TFCFOL\d+$/.test(g4.cod), g4.cod);
  const g5 = await CP.genereaza({ [C2_DEN]: "Folie test" }, FAM2, { faraFurnizor: true });
  bine("…fără el, produsul de revânzare nu se poate face", !g5.ok && g5.lipsa.includes("Furnizor"), JSON.stringify(g5.lipsa));

  // ---------------------------------------------------------------------------
  console.log("\n5. Salvarea comenzii");
  let p = await plaseaza([[P_M, 2, ""]]);
  bine("produs pe stoc fără furnizor: oprită", p.r.cod === 200 && p.r.corp.includes("Produsul de pe linia 1 e pe stoc: alege furnizorul"), p.r.corp.slice(0, 200));
  egal("…și nu s-a scris nimic", p.noi.length, 0);
  bine("…iar formularul păstrează alegerile", p.r.corp.includes('name="furnizor_ales[]" value=""'));
  p = await plaseaza([[P_M, 2, ""], [P_M, 1, ""]]);
  bine("mesajul la plural", p.r.corp.includes("Produsele de pe liniile 1, 2 sunt pe stoc"), p.r.corp.match(/Produs[^<]{0,80}/));
  p = await plaseaza([[P_FARA, 1, ""], ["", "", ""], [P_M, 1, ""]]);
  bine("numărul liniei e rândul din formular", p.r.corp.includes("Produsul de pe linia 3 e pe stoc"), p.r.corp.match(/Produs[^<]{0,80}/));
  p = await plaseaza([[P_M, 2, "p:99999"]]);
  bine("furnizor care nu e pe stoc: oprită", p.r.corp.includes("Furnizorul ales pe linia 1 nu mai are marfa asta pe stoc") && p.noi.length === 0, p.r.corp.match(/Furnizor[^<]{0,80}/));
  p = await plaseaza([[P_M, 2, "p:" + S2]]);
  const A = p.id;
  egal("cu furnizorul de pe stoc: salvată", [p.r.cod, String(p.r.antet.Location || "").replace(/\d+/, "N")], [302, "/comenzi/N?ok=plasata"]);
  egal("linia ține furnizorul și de unde vine", liniile(A).map((l) => [Number(l.produs_id), Number(l.furnizor_id), l.furnizor_text, l.furnizor_sursa]), [[P_M, S2, null, "stoc"]]);
  p = await plaseaza([[P_M, 1, "n"], [P_FARA, 1, ""], [P_BANDA, 4, "p:" + S1], ["", "", ""]]);
  const B = p.id;
  egal("paleții fără furnizor / fără stoc / produs fără Furnizor", liniile(B).map((l) => [Number(l.produs_id), l.furnizor_id, l.furnizor_text, l.furnizor_sursa]), [
    [P_M, null, FL.NESCRIS, "stoc"],
    [P_FARA, null, null, null],
    [P_BANDA, null, null, null],
  ]);
  p = await plaseaza([[P_M, 1, "t:Furnizor Liber SRL"]]);
  egal("furnizor scris doar ca text pe palet", liniile(p.id).map((l) => [l.furnizor_id, l.furnizor_text]), [[null, "Furnizor Liber SRL"]]);
  p = await plaseaza([[P_NESCRIS, 1, ""]]);
  bine("pe stoc doar fără furnizor scris: trece", Boolean(p.id));

  // ---------------------------------------------------------------------------
  console.log("\n6. Pagina comenzii");
  const pgB = (await cer("get", "/comenzi/:id", { params: { id: String(B) } })).corp;
  bine("arată paleții fără furnizor, aleși din stoc", pgB.includes("furnizor: <b>paleții fără furnizor scris</b>") && pgB.includes("· ales din stoc"));
  bine("la produsul fără stoc spune că-l alege producția", pgB.includes("furnizor: încă neales — se alege în producție"));
  egal("la produsul fără Furnizor în familie nu scrie nimic", (pgB.match(/furnizor-pe-linie/g) || []).length, 2);
  const pgA = (await cer("get", "/comenzi/:id", { params: { id: String(A) } })).corp;
  bine("furnizorul din Parteneri, cu numele", pgA.includes("furnizor: <b>TFC Furnizor Doi SRL</b>"));

  // ---------------------------------------------------------------------------
  console.log("\n7. Modificarea comenzii");
  const ed = (await cer("get", "/comenzi/:id/editare", { params: { id: String(A) } })).corp;
  bine("rândul vechi știe ce furnizor avea", ed.includes(`data-produs-vechi="${P_M}" data-furnizor-vechi="p:${S2}" data-furnizor-vechi-nume="TFC Furnizor Doi SRL"`));
  bine("…și îl trimite mai departe dacă nu-l atinge nimeni", ed.includes(`name="furnizor_ales[]" value="p:${S2}"`));
  const corpEd = (linii, extra) => {
    const c = corpComanda(linii, extra);
    c["pret_exact[]"] = linii.map(() => "");
    c.motiv = "test";
    return c;
  };
  let re = await cer("post", "/comenzi/:id/editare", { params: { id: String(A) }, body: corpEd([[P_M, 3, "p:" + S2]]) });
  egal("cantitate schimbată, furnizor neatins: salvat", [re.cod, liniile(A).map((l) => [Number(l.cantitate), Number(l.furnizor_id), l.furnizor_sursa])], [302, [[3, S2, "stoc"]]]);
  bine("…fără rând de furnizor în istoric", !istoric(A).some((h) => /^Furnizor/.test(h.ce)), JSON.stringify(istoric(A)));
  q(`UPDATE ct_paleti SET data_iesire = '2026-11-03' WHERE id = 98853`);
  re = await cer("post", "/comenzi/:id/editare", { params: { id: String(A) }, body: corpEd([[P_M, 4, "p:" + S2]]) });
  egal("paleții furnizorului au plecat: linia veche nu e oprită și își ține furnizorul", [re.cod, liniile(A).map((l) => Number(l.furnizor_id))], [302, [S2]]);
  q(`UPDATE ct_paleti SET data_iesire = NULL WHERE id = 98853`);
  re = await cer("post", "/comenzi/:id/editare", { params: { id: String(A) }, body: corpEd([[P_M, 5, ""]]) });
  egal("alegere goală pe linia veche: rămâne ce era", [re.cod, liniile(A).map((l) => Number(l.furnizor_id))], [302, [S2]]);
  re = await cer("post", "/comenzi/:id/editare", { params: { id: String(A) }, body: corpEd([[P_M, 5, "p:" + S1]]) });
  egal("alt furnizor de pe stoc: schimbat", [re.cod, liniile(A).map((l) => [Number(l.furnizor_id), l.furnizor_sursa])], [302, [[S1, "stoc"]]]);
  egal("…și scris în istoric", istoric(A).filter((h) => /^Furnizor/.test(h.ce)).map((h) => [h.ce, h.vechi, h.nou]), [["Furnizor · TFC Folie M", "TFC Furnizor Doi SRL", "TFC Furnizor Unu SRL"]]);
  re = await cer("post", "/comenzi/:id/editare", { params: { id: String(A) }, body: corpEd([[P_M, 5, "p:" + S1], [P_A, 2, ""]]) });
  bine("linie nouă cu produs pe stoc, fără furnizor: oprită", re.cod === 200 && re.corp.includes("Produsul de pe linia 2 e pe stoc"), re.corp.match(/Produs[^<]{0,80}/));
  egal("…și nu s-a scris", liniile(A).length, 1);
  bine("…formularul întors ține minte furnizorul vechi al rândului", re.corp.includes(`data-produs-vechi="${P_M}" data-furnizor-vechi="p:${S1}"`));
  re = await cer("post", "/comenzi/:id/editare", { params: { id: String(A) }, body: corpEd([[P_M, 5, "p:" + S1], [P_A, 2, "p:" + S1]]) });
  egal("cu furnizor: linia nouă intră cu el", [re.cod, liniile(A).map((l) => [Number(l.produs_id), Number(l.furnizor_id), l.furnizor_sursa])], [302, [[P_M, S1, "stoc"], [P_A, S1, "stoc"]]]);
  bine("…iar istoricul o spune", istoric(A).some((h) => h.ce === "Furnizor · TFC Folie A" && h.vechi === "" && h.nou === "TFC Furnizor Unu SRL"));

  // ---------------------------------------------------------------------------
  console.log("\n8. Depozitul: comanda la un furnizor anume");
  const lB = liniile(B);
  const lFara = lB.find((l) => Number(l.produs_id) === P_FARA);
  const lM = lB.find((l) => Number(l.produs_id) === P_M);
  const apro = (linie, sursa, fid) => cer("post", "/depozit/comanda/:id/aprovizionare", { params: { id: String(B) }, body: { linie_id: String(linie), cantitate: "5", sursa, furnizor_id: fid ? String(fid) : "", termen_cerut: "2099-12-31" } });
  await apro(lFara.id, "productie", S1);
  egal("din producție: linia rămâne fără furnizor", liniile(B).find((l) => l.id === lFara.id).furnizor_id, null);
  await apro(lFara.id, "tert", S2);
  egal("de la terț, cu furnizor: linia îl primește", ["furnizor_id", "furnizor_sursa"].map((k) => liniile(B).find((l) => l.id === lFara.id)[k]), [String(S2), "aprovizionare"]);
  await apro(lM.id, "tert", S1);
  egal("linia care avea furnizor nu se rescrie", [liniile(B).find((l) => l.id === lM.id).furnizor_text, liniile(B).find((l) => l.id === lM.id).furnizor_id], [FL.NESCRIS, null]);
  const dep = (await cer("get", "/depozit/comanda/:id", { params: { id: String(B) } })).corp;
  bine("pagina depozitului arată furnizorul liniei", dep.includes("furnizor: <b>TFC Furnizor Doi SRL</b>") && dep.includes("comandat de depozit"));

  // ---------------------------------------------------------------------------
  console.log("\n9. Producția alege furnizorul la alocarea materialului");
  p = await plaseaza([[P_FARA, 10, ""], [P_A, 2, "p:" + S1]]);
  const C = p.id;
  const cp = Number(unul(`INSERT INTO comenzi_productie (numar, comanda_id, produs_id, tip_produs, cantitate, um, status, partener_id)
                          VALUES ('TFC-P1', ?, ?, 'TFC Folie fără stoc', '10', 'rolă', 'noua', ?) RETURNING id`, [C, P_FARA, CLIENT]));
  q(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um, ordine) VALUES (?, ?, 'TFC Folie A', '2', 'rolă', 10)`, [cp, P_A]);
  const fz = (k) => liniile(C).find((l) => Number(l.produs_id) === k);
  const cpRand = () => q(`SELECT furnizor_id, furnizor_text, furnizor_ales_de, furnizor_ales_la FROM comenzi_productie WHERE id = ?`, [cp])[0];
  let rp = await cer("post", "/productie/:id/furnizor", { user: AGENT, params: { id: String(cp) }, body: { furnizor: "TFC Furnizor Unu SRL" } });
  egal("agentul nu alege furnizorul producției", [rp.antet.Location, cpRand().furnizor_id, fz(P_FARA).furnizor_id], [`/productie/${cp}`, null, null]);
  const cas0 = (await cer("get", "/productie/:id", { params: { id: String(cp) } })).corp;
  bine("caseta spune că furnizorul e încă neales", cas0.includes("Furnizorul materialului") && cas0.includes("Încă neales"));
  bine("…și ce linie a clientului îl așteaptă", cas0.includes("Comanda clientului așteaptă furnizorul pe „TFC Folie fără stoc\""));
  bine("…cu furnizorii de pe stocul materialelor din rețetă întâi", /furnizor-sugestii[\s\S]*TFC Furnizor Unu SRL/.test(cas0) && cas0.includes(`name="furnizor_id" value="${S1}"`));
  bine("…și căutare în toți furnizorii", cas0.includes(`list="furnizori-productie-${cp}"`) && cas0.includes('<option value="TFC Furnizor Doi SRL">'));
  const casAg = (await cer("get", "/productie/:id", { user: AGENT, params: { id: String(cp) } })).corp;
  bine("agentul vede caseta, dar fără formular", casAg.includes("Furnizorul materialului") && !casAg.includes(`action="/productie/${cp}/furnizor"`));

  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor: "S.C. TFC Furnizor Unu SRL", inapoi: `/productie/${cp}/necesar` } });
  egal("scris după litere („S.C. …”) cade pe furnizorul din Parteneri", [rp.antet.Location, Number(cpRand().furnizor_id), cpRand().furnizor_text, cpRand().furnizor_ales_de], [`/productie/${cp}/necesar`, S1, null, "Vali Test"]);
  egal("linia clientului fără furnizor îl primește, „din producție”", [Number(fz(P_FARA).furnizor_id), fz(P_FARA).furnizor_sursa], [S1, "productie"]);
  egal("linia aleasă de agent din stoc rămâne a lui", [Number(fz(P_A).furnizor_id), fz(P_A).furnizor_sursa], [S1, "stoc"]);
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor: "tfc furnizor doi srl", inapoi: "/altundeva" } });
  egal("numele exact, fără majuscule; întoarcerea doar pe paginile producției", [rp.antet.Location, Number(cpRand().furnizor_id)], [`/productie/${cp}`, S2]);
  egal("corectura ajunge pe linia pusă de producție", [Number(fz(P_FARA).furnizor_id), fz(P_FARA).furnizor_sursa], [S2, "productie"]);
  egal("…dar nu pe cea aleasă din stoc", [Number(fz(P_A).furnizor_id), fz(P_A).furnizor_sursa], [S1, "stoc"]);
  egal("istoricul comenzii clientului", istoric(C).filter((h) => /^Furnizor/.test(h.ce)).map((h) => [h.ce, h.vechi, h.nou]), [
    ["Furnizor · TFC Folie fără stoc", "", "TFC Furnizor Unu SRL (din producția TFC-P1)"],
    ["Furnizor · TFC Folie fără stoc", "TFC Furnizor Unu SRL", "TFC Furnizor Doi SRL (din producția TFC-P1)"],
  ]);
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor: "tfc furnizor doi srl" } });
  egal("același furnizor din nou: istoricul nu crește", istoric(C).filter((h) => /^Furnizor/.test(h.ce)).length, 2);
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor: "S.C. TFC Dublu SRL" } });
  egal("două firme cu aceleași litere: rămâne text, nu se ghicește", [cpRand().furnizor_id, cpRand().furnizor_text], [null, "S.C. TFC Dublu SRL"]);
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor: "  Furnizor   Necunoscut SRL " } });
  egal("nume care nu e în Parteneri: text, cu spațiile curățate", [cpRand().furnizor_id, cpRand().furnizor_text, fz(P_FARA).furnizor_id, fz(P_FARA).furnizor_text], [null, "Furnizor Necunoscut SRL", null, "Furnizor Necunoscut SRL"]);
  egal("TFC Ambele SRL (client și furnizor) se găsește", (await FC.rezolvaFurnizor({ furnizor: "TFC Ambele SRL" })).furnizor_id, AMBELE);
  egal("clientul nu e luat drept furnizor", (await FC.rezolvaFurnizor({ furnizor: "TFC Client SRL" })).furnizor_id, null);
  egal("butonul din sugestii trimite id-ul", (await FC.rezolvaFurnizor({ furnizor_id: String(S2), furnizor: "orice" })).furnizor_id, S2);
  egal("gol = fără furnizor", await FC.rezolvaFurnizor({ furnizor: "   " }), { gol: true });

  // Recepția din producție duce furnizorul pe paleți.
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor_id: String(S2), furnizor: "TFC Furnizor Doi SRL" } });
  egal("recepția din producție: furnizorul ales acolo", await FC.furnizorReceptiei({ sursa: "productie", comanda_productie_id: cp }), { furnizor_id: S2, furnizor_text: null, nume: "TFC Furnizor Doi SRL" });
  egal("recepția de la furnizor: furnizorul recepției", (await FC.furnizorReceptiei({ sursa: "furnizor", partener_id: S1 })).furnizor_id, S1);
  egal("returul: nimic", await FC.furnizorReceptiei({ sursa: "retur", partener_id: CLIENT }), { furnizor_id: null, furnizor_text: null, nume: "" });
  q(`INSERT INTO receptii (id, numar, sursa, comanda_productie_id, comanda_id, stare) VALUES (${REC}, 'TFC-R1', 'productie', ?, ?, 'finalizata')`, [cp, C]);
  q(`INSERT INTO receptii_linii (id, receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie) VALUES (${REC_L}, ${REC}, ${P_FARA}, 10, 10, 'rolă', 'primita', 'bun')`);
  if (Number(unul("SELECT COUNT(*) FROM ct_randuri")) > 0) {
    const intr = await cer("get", "/stocuri/ct-park/intrare", { query: { receptie_linie: String(REC_L) } });
    bine("intrarea în CT-Park pornește cu furnizorul producției ales", intr.corp.includes(`<option value="${S2}" selected>TFC Furnizor Doi SRL</option>`), intr.cod);
    q(`UPDATE comenzi_productie SET furnizor_id = ${AMBELE}, furnizor_text = NULL WHERE id = ?`, [cp]);
    const intr2 = await cer("get", "/stocuri/ct-park/intrare", { query: { receptie_linie: String(REC_L) } });
    bine("…și când firma e „ambele”, deci lipsește din lista de furnizori", intr2.corp.includes(`<option value="${AMBELE}" selected>TFC Ambele SRL</option>`));
    q(`UPDATE comenzi_productie SET furnizor_id = NULL, furnizor_text = 'Furnizor Necunoscut SRL' WHERE id = ?`, [cp]);
    const intr3 = await cer("get", "/stocuri/ct-park/intrare", { query: { receptie_linie: String(REC_L) } });
    bine("…iar furnizorul scris ca text ajunge în căsuța de text", intr3.corp.includes('name="furnizor_text" placeholder="dacă nu e în listă" value="Furnizor Necunoscut SRL"'));
    q(`UPDATE comenzi_productie SET furnizor_id = ${S2}, furnizor_text = NULL WHERE id = ?`, [cp]);
  } else {
    console.log("  (sărit: în baza locală CT-Park n-are rânduri, intrarea marfă nu se deschide)");
  }
  const liv = await cer("post", "/depozit/receptie/:id/linie/:lid/livrare", { params: { id: String(REC), lid: String(REC_L) }, body: { destinatie: "productie" } });
  const pal = q(`SELECT furnizor_id, furnizor_text FROM ct_paleti WHERE receptie_linie_id = ${REC_L}`);
  egal("direct la livrare: paletul din producție poartă furnizorul ales acolo", [liv.cod, pal.map((x) => [Number(x.furnizor_id), x.furnizor_text])], [302, [[S2, null]]]);
  // Paletul ăsta ar pune folia „fără stoc” pe stoc: îl scoatem, ca restul să rămână cum e gândit.
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (SELECT id FROM ct_paleti WHERE receptie_id = ${REC})`);
  q(`DELETE FROM ct_paleti WHERE receptie_id = ${REC}`);

  const nec = (await cer("get", "/productie/:id/necesar", { params: { id: String(cp) } })).corp;
  bine("necesarul arată furnizorul fiecărui palet", nec.includes("#98858") && /#98858<\/a><span class="mic"> · 9 · 01\.11\.2026 · TFC Furnizor Unu SRL/.test(nec), (nec.match(/#98858[^\n]{0,160}/) || [""])[0]);
  bine("…și caseta, cu întoarcerea pe necesar", nec.includes("Furnizorul materialului") && nec.includes(`name="inapoi" value="/productie/${cp}/necesar"`));
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: String(cp) }, body: { furnizor: "" } });
  egal("gol: furnizorul se șterge din producție și de pe linia pusă de ea", [cpRand().furnizor_id, cpRand().furnizor_ales_la, fz(P_FARA).furnizor_id, fz(P_FARA).furnizor_sursa], [null, null, null, null]);
  egal("…dar nu de pe linia aleasă din stoc", Number(fz(P_A).furnizor_id), S1);
  rp = await cer("post", "/productie/:id/furnizor", { params: { id: "999999999" }, body: { furnizor: "x" } });
  egal("producție inexistentă", rp.antet.Location, "/productie");

  // ---------------------------------------------------------------------------
  console.log("\n10. În browser");
  const { chromium } = require("playwright");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const browser = await chromium.launch();
  const erori = [];
  // Cât e pus, verificarea stocului de sub produs pică (rețea, server căzut).
  let picaVerificarea = false;
  try {
    const servire = async (pagina, html) => {
      await pagina.route("http://erp.test/**", async (rt) => {
        const req = rt.request();
        const u = new URL(req.url());
        if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
        if (u.pathname === "/comenzi/furnizori-stoc") {
          if (picaVerificarea) return rt.abort();
          const r = await cer("get", "/comenzi/furnizori-stoc", { query: Object.fromEntries(u.searchParams) });
          return rt.fulfill({ status: r.cod, contentType: "application/json", body: r.corp });
        }
        if (req.method() === "POST" && (u.pathname === "/comenzi/produs-configurat" || u.pathname === "/comenzi/produs-configurat/creeaza")) {
          const r = await cer("post", u.pathname, { body: JSON.parse(req.postData() || "{}") });
          return rt.fulfill({ status: r.cod, contentType: "application/json", body: r.corp });
        }
        if (u.pathname.startsWith("/comenzi")) return rt.fulfill({ status: 200, contentType: "text/html", body: html });
        return rt.fulfill({ status: 204, body: "" });
      });
    };
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => erori.push(e.message));
    await servire(pg, (await cer("get", "/comenzi/nou")).corp);
    await pg.goto("http://erp.test/comenzi/nou");
    const randuri = () => pg.$$("#linii-body > tr:not(.rand-config)");
    const alege = async (rand, text, id) => {
      const c = await rand.$(".cauta-produs");
      await c.fill(text);
      await pg.waitForSelector(`.rezultat-produs[data-id="${id}"]`, { state: "visible" });
      await pg.click(`.rezultat-produs[data-id="${id}"]`);
    };
    const asteaptaFurnizor = (rand) => pg.waitForFunction((r) => { const g = r.querySelector(".furnizor-linie"); return g && !/se verifică/.test(g.textContent); }, rand);
    let [r1] = await randuri();
    await alege(r1, "TFC Folie M", P_M);
    await pg.waitForSelector("#linii-body .furnizor-select");
    const opt = await r1.$$eval(".furnizor-select option", (os) => os.map((o) => o.value + "|" + o.textContent));
    egal("produsul pe stoc: lista de furnizori", opt, [
      "|— alege furnizorul —",
      `p:${S1}|TFC Furnizor Unu SRL — 15 rolă pe stoc`,
      "t:Furnizor Liber SRL|Furnizor Liber SRL — 4 rolă pe stoc",
      `p:${S2}|TFC Furnizor Doi SRL — 3 rolă pe stoc`,
      "n|furnizor nescris pe palet — 2 rolă pe stoc",
    ]);
    egal("…obligatorie și goală la început", await r1.$eval(".furnizor-select", (s) => [s.required, s.validity.valueMissing]), [true, true]);
    await r1.$eval(".furnizor-select", (s, v) => { s.value = v; s.dispatchEvent(new Event("change")); }, "p:" + S2);
    egal("alegerea ajunge în câmpul care pleacă", await r1.$eval('input[name="furnizor_ales[]"]', (i) => i.value), "p:" + S2);
    // Produsul se schimbă, iar verificarea stocului pică: furnizorul ales
    // pentru produsul de dinainte nu are voie să plece cu cel nou.
    picaVerificarea = true;
    await alege(r1, "TFC Folie fără stoc", P_FARA);
    await asteaptaFurnizor(r1);
    egal("verificarea pică: alegerea de la produsul vechi nu rămâne pe cel nou",
      await r1.$eval(".furnizor-linie", (g) => [/Nu am putut verifica stocul/.test(g.textContent), g.parentNode.querySelector('input[name="furnizor_ales[]"]').value]), [true, ""]);
    picaVerificarea = false;
    await alege(r1, "TFC Bandă", P_BANDA);
    await asteaptaFurnizor(r1);
    egal("alt produs, fără Furnizor: lista dispare, alegerea se golește", await r1.$eval(".furnizor-linie", (g) => [g.innerHTML, g.parentNode.querySelector('input[name="furnizor_ales[]"]').value]), ["", ""]);
    await alege(r1, "TFC Folie M", P_M);
    await pg.waitForSelector("#linii-body .furnizor-select");
    egal("înapoi la produsul pe stoc: lista pornește goală", await r1.$eval(".furnizor-select", (s) => s.value), "");
    await r1.$eval(".furnizor-select", (s, v) => { s.value = v; s.dispatchEvent(new Event("change")); }, "p:" + S1);
    await pg.click("text=+ Adaugă linie");
    let toate = await randuri();
    const r2 = toate[1];
    egal("rândul nou pornește fără furnizor", await r2.$eval(".furnizor-linie", (g) => [g.innerHTML, g.parentNode.querySelector('input[name="furnizor_ales[]"]').value, g.getAttribute("data-produs")]), ["", "", null]);
    await alege(r2, "TFC Folie fără stoc", P_FARA);
    await asteaptaFurnizor(r2);
    egal("fără stoc: doar nota, fără listă", await r2.$eval(".furnizor-linie", (g) => [g.querySelector("select") === null, g.textContent.trim()]), [true, "Nu e pe stoc: furnizorul se alege în producție, când se alocă materialul."]);
    await pg.click("text=+ Adaugă linie");
    toate = await randuri();
    await alege(toate[2], "TFC Folie nescris", P_NESCRIS);
    await asteaptaFurnizor(toate[2]);
    egal("pe stoc fără furnizor scris: nota", await toate[2].$eval(".furnizor-linie", (g) => [g.querySelector("select") === null, g.textContent.trim()]), [true, "Pe stoc: 6 rolă, fără furnizor scris pe palet."]);
    egal("primul rând și-a păstrat alegerea", await r1.$eval('input[name="furnizor_ales[]"]', (i) => i.value), "p:" + S1);
    egal("câmpurile rămân aliniate: câte un furnizor pe rând", await pg.$$eval("#linii-body", ([b]) => [b.querySelectorAll('input[name="produs_id[]"]').length, b.querySelectorAll('input[name="furnizor_ales[]"]').length]), [3, 3]);

    // Panoul „configurează”: Furnizor nu se mai cere.
    await r2.$eval(".configureaza-linie", (b) => b.click());
    await pg.selectOption("tr.rand-config .config-familie", String(FAM));
    egal("Furnizor apare ca notă, nu ca listă de ales", await pg.$$eval("tr.rand-config", ([t], id) => [t.querySelector(`.config-val[data-id="${id}"]`) === null, Boolean(t.querySelector(".config-furnizor-nota"))], C_FURN), [true, true]);
    await pg.selectOption(`tr.rand-config .config-val[data-id="${C_TIP}"]`, "Manuală");
    await pg.waitForFunction(() => { const t = document.querySelector("tr.rand-config"); return t && t.querySelector(".config-cod").textContent === "QQM" && !t.querySelector(".config-ia").disabled; });
    bine("doar cu Tip completat, produsul se poate pune pe comandă", true);
    await pg.click("tr.rand-config .config-ia");
    await pg.waitForFunction(() => !document.querySelector("tr.rand-config"));
    await asteaptaFurnizor(r2);
    egal("produsul configurat intră pe rând, iar furnizorul se verifică pentru el", await r2.$eval(".furnizor-linie", (g) => [g.parentNode.querySelector('input[name="produs_id[]"]').value, /^Nu e pe stoc/.test(g.textContent.trim())]), [String(crj.id), true]);

    // Modificarea: rândul vechi nu e obligatoriu și pornește de la ce avea.
    q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar, um, furnizor_text, furnizor_sursa) VALUES (?, ?, 1, 10, 'rolă', 'Vechi Furnizor SRL', 'productie')`, [B, P_M]);
    q(`DELETE FROM comenzi_linii WHERE comanda_id = ? AND produs_id = ? AND furnizor_text = ?`, [B, P_M, FL.NESCRIS]);
    const pe = await ctx.newPage();
    pe.on("pageerror", (e) => erori.push(e.message));
    await servire(pe, (await cer("get", "/comenzi/:id/editare", { params: { id: String(B) } })).corp);
    await pe.goto("http://erp.test/comenzi/" + B + "/editare");
    await pe.waitForSelector("#linii-body .furnizor-select");
    const rv = await pe.$$eval("#linii-body > tr:not(.rand-config)", (rs, pm) => {
      const r = rs.find((x) => x.querySelector('input[name="produs_id[]"]').value === String(pm));
      const s = r.querySelector(".furnizor-select");
      return [s.required, s.value, s.options[s.selectedIndex].textContent, r.querySelector('input[name="furnizor_ales[]"]').value];
    }, P_M);
    egal("rândul vechi: neobligatoriu, cu furnizorul de dinainte ales", rv, [false, "t:Vechi Furnizor SRL", "Vechi Furnizor SRL (ales înainte)", "t:Vechi Furnizor SRL"]);
    egal("nicio eroare de JavaScript în pagini", erori, []);
  } finally {
    await browser.close();
  }

  curata();
  console.log(esecuri ? `\n${esecuri} ESECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (x) { console.error("curățarea a picat:", x.message); }
  process.exit(1);
});
