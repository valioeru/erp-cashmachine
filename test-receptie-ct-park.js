"use strict";
// Recepția duce marfa în CT-Park: pe raft (Intrare marfă, completată din
// recepție) sau direct la livrare (ieșirea din CT-Park). PostgreSQL real.
//
// CEREREA LUI VALI, 05.11.2026:
//   „Recepție marfă: când preiau spun și unde îl plasez, pe ce rafturi, loc
//    etc., sau aleg direct la livrare și apare direct eticheta de scoatere sau
//    fluxul de scoatere marfă către clienți sau către fulfilment" · „Vezi că
//    depozitul e unul singur, CT-Park, acolo preiau."
//
// CE APĂRĂ:
//   • RÂNDUL DE RECEPȚIE NU MAI CERE UN LOC DIN LISTA VECHE (locuri_depozit).
//   • DUPĂ FINALIZARE, recepția arată pentru fiecare rând bun cât a venit, cât e
//     în CT-Park (paleți, adrese) și cât mai e de pus.
//   • „PUNE ÎN CT-PARK" deschide Intrarea cu tot completat; paletul rămâne
//     legat de recepție, iar „de pus" scade.
//   • „DIRECT LA LIVRARE" face paletul fără loc, cu restul, și deschide ieșirea
//     cu el bifat și destinația aleasă; a doua oară nu se mai poate.
//   • STOCUL NU SE DUBLEAZĂ: finalizarea scrie o singură mișcare, paletul nu.
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
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
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
const inreg = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "receptie.js")).register(inreg);
require(path.join(RAD, "modules", "ct-park.js")).register(inreg);
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
  await h({ user, params: params || {}, query: query || {}, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const loc = (r) => decodeURIComponent(String((r.antet && r.antet.Location) || ""));

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

const NUMAR = "TEST-RCT-1";
function curata() {
  const rec = q(`SELECT id FROM receptii WHERE numar = '${NUMAR}'`).map((x) => Number(x.id));
  const r = rec.join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE receptie_id IN (${r})`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE document_ref = '${NUMAR}'`);
  q(`DELETE FROM stoc_locuri WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${r}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii WHERE id IN (${r})`);
  q(`DELETE FROM produse WHERE id = 97501`);
  q(`DELETE FROM parteneri WHERE id = 97511`);
  q(`DELETE FROM locuri_depozit WHERE cod = 'TEST-RCT-LOC'`);
}

(async () => {
  curata();
  const DEP = { id: Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1")), nume: "Depozit Test", rol: "depozit" };
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (97511, 'furnizor', 'TEST-RCT Furnizor SRL')`);
  // Un loc în lista veche (cum sunt în producție): rândul NU trebuie să-l mai ceară.
  q(`INSERT INTO locuri_depozit (cod, blocat) VALUES ('TEST-RCT-LOC', 0)`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (97501, 'TSTRCT1', 'TEST-RCT Folie stretch', 'kg')`);
  const rid = Number(unul(`INSERT INTO receptii (numar, sursa, partener_id, data, stare) VALUES ('${NUMAR}', 'furnizor', 97511, '2026-11-05', 'asteptata') RETURNING id`));
  const lid = Number(unul(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, um, pret_unitar, stare) VALUES (${rid}, 97501, 100, 'kg', 7.35, 'de_primit') RETURNING id`));

  console.log("\n1. Rândul se confirmă fără locul din lista veche");
  let pag = await cer("get", "/depozit/receptie/:id", DEP, { id: String(rid) });
  bine("nu mai e coloana „Loc” cu lista veche", !pag.corp.includes('name="loc_id"') && !/<th[^>]*>Loc<\/th>/.test(pag.corp));
  let r = await cer("post", "/depozit/receptie/:id/linie/:lid", DEP, { id: String(rid), lid: String(lid) }, { cantitate_primita: "100", conditie: "bun", lot: "L-77", paleti_nr: "1", paleti_pe: "100" });
  egal("rândul e primit", unul(`SELECT stare FROM receptii_linii WHERE id = ${lid}`), "primita");
  bine("încă nu se cere locul (secțiunea CT-Park apare după finalizare)", !(await cer("get", "/depozit/receptie/:id", DEP, { id: String(rid) })).corp.includes("Unde pui marfa"));
  r = await cer("post", "/depozit/receptie/:id/linie/:lid/livrare", DEP, { id: String(rid), lid: String(lid) }, { destinatie: "fulfillment" });
  bine("„direct la livrare” cere întâi finalizarea", /finalizează/.test(loc(r)), loc(r));

  console.log("\n2. Finalizarea scrie stocul o dată și arată unde se pune marfa");
  await cer("post", "/depozit/receptie/:id/finalizeaza", DEP, { id: String(rid) });
  egal("o singură mișcare de stoc, 100 kg", q(`SELECT cantitate FROM miscari_stoc WHERE document_ref = '${NUMAR}'`).map((x) => Number(x.cantitate)), [100]);
  pag = await cer("get", "/depozit/receptie/:id", DEP, { id: String(rid) });
  bine("secțiunea „Unde pui marfa — CT-Park”", pag.corp.includes("Unde pui marfa — CT-Park"));
  bine("…cu „Pune în CT-Park” spre Intrare, cu rândul recepției", pag.corp.includes(`href="/stocuri/ct-park/intrare?receptie_linie=${lid}"`));
  bine("…și cu „Direct la livrare”", pag.corp.includes(`action="/depozit/receptie/${rid}/linie/${lid}/livrare"`));

  console.log("\n3. Pune în CT-Park: Intrarea vine completată");
  const intr = await cer("get", "/stocuri/ct-park/intrare", DEP, {}, {}, { receptie_linie: String(lid) });
  bine("spune din ce recepție și cât e de pus", intr.corp.includes(NUMAR) && /de pus acum: <strong>100 kg<\/strong>/.test(intr.corp), intr.cod);
  bine("produsul e ales", intr.corp.includes('name="produs_id" value="97501" checked'));
  bine("UM, prețul și lotul sunt scrise", intr.corp.includes('name="um" placeholder="kg" value="kg"') && intr.corp.includes('value="7,35"') && intr.corp.includes('name="lot" value="L-77"'));
  bine("furnizorul e ales", intr.corp.includes('<option value="97511" selected>TEST-RCT Furnizor SRL</option>'));
  bine("cantitatea de pus e pe primul palet", intr.corp.includes('name="loc_cantitate[]" value="100"'));
  bine("legătura cu recepția pleacă în formular", intr.corp.includes(`name="receptie_linie_id" value="${lid}"`));
  const liber = q(`SELECT l.id, l.rand_id, l.adresa FROM ct_locuri l JOIN ct_randuri rr ON rr.id = l.rand_id AND rr.activ = 1
                    WHERE COALESCE(l.blocat, 0) = 0 AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
                    ORDER BY l.id LIMIT 1`)[0];
  r = await cer("post", "/stocuri/ct-park/intrare", DEP, {}, {
    produs_id: "97501", um: "kg", pret_unitar: "7,35", lot: "L-77", furnizor_id: "97511",
    receptie_id: String(rid), receptie_linie_id: String(lid),
    "loc_ids[]": String(liber.id), "loc_rand[]": String(liber.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "60",
  });
  bine("paletul se pune și duce la etichete", /\/stocuri\/ct-park\/etichete\?paleti=\d+/.test(loc(r)), loc(r));
  const p1 = q(`SELECT id, cantitate, receptie_id, receptie_linie_id, lot FROM ct_paleti WHERE receptie_linie_id = ${lid} ORDER BY id`)[0] || {};
  egal("paletul e legat de recepție, cu cantitatea și lotul", [Number(p1.cantitate), Number(p1.receptie_id), p1.lot], [60, rid, "L-77"]);
  egal("…și stă pe locul ales", unul(`SELECT l.adresa FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id WHERE o.palet_id = ${p1.id}`), liber.adresa);
  egal("stocul nu s-a dublat", q(`SELECT cantitate FROM miscari_stoc WHERE document_ref = '${NUMAR}'`).length, 1);
  pag = await cer("get", "/depozit/receptie/:id", DEP, { id: String(rid) });
  bine("recepția arată paletul cu adresa lui și „de pus” 40", pag.corp.includes(liber.adresa) && /<strong>40 kg<\/strong>/.test(pag.corp));
  const intr2 = await cer("get", "/stocuri/ct-park/intrare", DEP, {}, {}, { receptie_linie: String(lid) });
  bine("Intrarea, deschisă din nou, propune doar restul de 40", /de pus acum: <strong>40 kg<\/strong>/.test(intr2.corp) && intr2.corp.includes('name="loc_cantitate[]" value="40"'));

  // Doar rândul, fără loc exact: ERP-ul propune locul, iar confirmarea
  // (pagina a doua, /ocupa) trebuie să ducă și ea legătura cu recepția.
  r = await cer("post", "/stocuri/ct-park/intrare", DEP, {}, {
    produs_id: "97501", um: "kg", lot: "L-77", receptie_id: String(rid), receptie_linie_id: String(lid),
    "loc_ids[]": "", "loc_rand[]": String(liber.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "10",
  });
  bine("pagina de confirmare duce legătura cu recepția", r.corp.includes(`name="receptie_linie_id" value="${lid}"`), r.cod);
  const grup = (r.corp.match(/name="grup_0" value="([\d,]+)"/) || [])[1];
  r = await cer("post", "/stocuri/ct-park/ocupa", DEP, {}, {
    grup_0: grup, cant_0: "10", produs_id: "97501", um: "kg", lot: "L-77", receptie_id: String(rid), receptie_linie_id: String(lid),
  });
  egal("…iar paletul pus din confirmare e legat de recepție", q(`SELECT cantitate FROM ct_paleti WHERE receptie_linie_id = ${lid} ORDER BY id`).map((x) => Number(x.cantitate)), [60, 10]);

  console.log("\n4. Direct la livrare, cu restul");
  r = await cer("post", "/depozit/receptie/:id/linie/:lid/livrare", DEP, { id: String(rid), lid: String(lid) }, {});
  bine("fără destinație nu pleacă", /Alege unde pleacă/.test(loc(r)), loc(r));
  r = await cer("post", "/depozit/receptie/:id/linie/:lid/livrare", DEP, { id: String(rid), lid: String(lid) }, { destinatie: "fulfillment" });
  const p2 = q(`SELECT id, cantitate FROM ct_paleti WHERE receptie_linie_id = ${lid} ORDER BY id`)[2] || {};
  egal("paletul de livrare are restul de 30, fără loc", [Number(p2.cantitate), Number(unul(`SELECT COUNT(*) FROM ct_ocupari WHERE palet_id = ${p2.id || 0}`))], [30, 0]);
  const qIes = new URLSearchParams(String((r.antet && r.antet.Location) || "").split("?")[1] || "");
  bine("se deschide ieșirea cu paletul bifat, destinația și motivul",
    String((r.antet && r.antet.Location) || "").startsWith("/stocuri/ct-park/iesire?") &&
      qIes.get("palet") === String(p2.id) && qIes.get("destinatie") === "fulfillment" && qIes.get("motiv") === "livrare directă din recepția TEST-RCT-1", loc(r));
  const ies = await cer("get", "/stocuri/ct-park/iesire", DEP, {}, {}, { palet: String(p2.id), destinatie: "fulfillment", motiv: "livrare directă din recepția TEST-RCT-1" });
  bine("pe ieșire: fulfillment ales, paletul bifat, motivul scris",
    ies.corp.includes('value="fulfillment" required checked') && new RegExp(`name="paleti" value="${p2.id}"[^>]*checked`).test(ies.corp) && ies.corp.includes('value="livrare directă din recepția TEST-RCT-1"'));
  r = await cer("post", "/depozit/receptie/:id/linie/:lid/livrare", DEP, { id: String(rid), lid: String(lid) }, { destinatie: "fulfillment" });
  bine("a doua oară nu se mai poate: totul e pus sau plecat", /deja pus/.test(loc(r)), loc(r));
  pag = await cer("get", "/depozit/receptie/:id", DEP, { id: String(rid) });
  bine("recepția spune „tot pus” și nu mai are butoane", pag.corp.includes("tot pus") && !pag.corp.includes(`receptie_linie=${lid}"`));
  egal("stocul tot o singură mișcare", q(`SELECT cantitate FROM miscari_stoc WHERE document_ref = '${NUMAR}'`).length, 1);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări au picat.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); } catch (_) {}
  process.exit(1);
});
