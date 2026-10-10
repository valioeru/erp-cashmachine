"use strict";
// Test pentru importul AWB-urilor în raportul „Comenzi consumabile la zi".
//
// Ce apără, în ordinea în care doare dacă se strică:
//
//   • ULTIMELE TREI CIFRE ALE AWB-ULUI SUNT NUMĂRUL COLETULUI, iar eticheta
//     fiecărui colet repetă comanda ÎNTREAGĂ. NOVATECH PRO a primit într-o zi
//     60 de etichete cu „300 Top hârtie A4" pe fiecare: comanda e 300, nu
//     18.000. Numărate pe etichetă, cele trei zile verificate pe date reale
//     (07–09.10.2026, 419 etichete) dădeau 384.503 lei în loc de 22.417 — de
//     șaptesprezece ori mai mult, pe un raport care arăta impecabil.
//
//   • ZIUA DE RAPORT E CU O ZI ÎNAINTEA DATEI DE PE ETICHETĂ. Eticheta
//     tipărită pe 09.10 duce comanda zilei de 08.10. S-a văzut comparând
//     ziua parsată cu rândul din Excel: 08.10 nu dădea, 07.10 dădea exact.
//
//   • NUMELE PRODUSULUI DE PE ETICHETĂ NU E CEL DIN EXCEL. Două din 15 diferă
//     („Banda adeziva FRAGIL" față de „Bandă adezivă, acrilic, Fragil"), deci
//     recunoașterea merge și pe alias și pe semnătură (felul + codul).
//     Dar „Plic format A4" și „Top hârtie A4" NU au voie să se confunde:
//     amândouă au codul „a4", le desparte felul.
//
//   • DACĂ UN ARTICOL NU SE RECUNOAȘTE, ZIUA NU SE SCRIE. Nici parțial. Un
//     import pe jumătate arată ca o zi slabă de vânzări și nimeni nu se mai
//     uită după ea.
//
//   • COSTUL VINE DIN NOMENCLATOR, în ordinea: rețetă (ce facem noi) → ultima
//     intrare de marfă (ce cumpărăm) → preț de achiziție. Un cost de peste
//     cinci ori prețul de vânzare nu e marjă proastă, e legătură greșită, și
//     cade la treapta următoare.
//
//   • CLIENȚII DE PE AWB NU SE OFERTEAZĂ. Sunt clienții Sameday. „S.C.
//     NOVATECH PRO S.R.L." și „novatech pro srl" trebuie să fie același client.
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
    const r = q(sql, p);
    return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined };
  },
});

const mod = require(path.join(RAD, "modules", "comenzi-zi.js"));
const curierat = require(path.join(RAD, "lib", "clienti-curierat.js"));
const T = mod.__test;

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const bine = (e, cond, d) => (cond ? ok(e) : rau(e, d));
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const rot = (v) => Math.round(Number(v) * 100) / 100;

// ---------------------------------------------------------------------------
// Fixtura. Codurile și ID-urile stau în plaja 967xx, ca să nu atingă nimic.
const PRODUSE = [
  { cod: "tst-awb-c5", den: "Plic autoadeziv AWB C5", pret: 0.09 },
  { cod: "tst-plic-a4", den: "Plic format A4 (300x400mm)", pret: 0.22 },
  { cod: "tst-top-a4", den: "Top hârtie A4", pret: 15.04 },
  { cod: "tst-fragil", den: "Bandă adezivă, acrilic, Fragil", pret: 4.14, alias: "Banda adeziva FRAGIL" },
  { cod: "tst-cutie", den: "Cutie mare, dimensiuni 460x410x373", pret: 4.33, alias: "Cutie mare SD1 (460 x 410 x 373)" },
];

// O comandă pe mai multe colete: AWB-ul se termină în 001, 002, 003… iar
// eticheta fiecăruia repetă comanda întreagă.
function colete(baza, cate, eticheta) {
  const out = [];
  for (let i = 1; i <= cate; i++) {
    out.push(Object.assign({}, eticheta, { awb: baza + String(i).padStart(3, "0"), kg: 10.2 }));
  }
  return out;
}

const ETICHETE = [].concat(
  // 60 de colete, o singură comandă de 300 topuri de hârtie. Capcana principală.
  colete("1SDY96700000001", 60, {
    data: "2026-10-08",
    destinatar: "NOVATECH PRO S.R.L.",
    adresa: "sat Poarta Alba 12 (Poarta Alba), Constanta",
    oras: "Poarta Alba", judet: "Constanta", agentie: "CT_OVIDIU_A03",
    articole: [{ cantitate: 300, produs: "Top hârtie A4" }],
  }),
  // Două colete, două produse pe fiecare etichetă.
  colete("1SDY96700000002", 2, {
    data: "2026-10-08",
    destinatar: "WIFISTORE.RO S.R.L.",
    adresa: "str oituz 33 Mangalia (Mangalia), Constanta",
    oras: "Mangalia", judet: "Constanta", agentie: "CT_MANGALIA_A07",
    articole: [
      { cantitate: 500, produs: "Plic autoadeziv AWB C5" },
      { cantitate: 100, produs: "Plic format A4 (300x400mm)" },
    ],
  }),
  // Un singur colet, cu numele scris ca pe etichetă (aliasul), și cu numele
  // firmei stricat de cp1252 — exact cum vine din unele PDF-uri.
  colete("1SDY96700000003", 1, {
    data: "2026-10-08",
    destinatar: "NICHIDUÅ¢Ä‚ TRADING SRL",
    adresa: "str Fabricii 5 (Cluj-Napoca), Cluj",
    oras: "Cluj-Napoca", judet: "Cluj", agentie: "CJ_CLUJ_A01",
    articole: [
      { cantitate: 12, produs: "Banda adeziva FRAGIL" },
      { cantitate: 5, produs: "Cutie mare SD1 (460 x 410 x 373)" },
    ],
  }),
  // Altă zi: eticheta de 09.10 duce comanda zilei de 08.10.
  colete("1SDY96700000004", 1, {
    data: "2026-10-09",
    destinatar: "S.C. NOVATECH PRO S.R.L.",
    adresa: "sat Poarta Alba 12 (Poarta Alba), Constanta",
    oras: "Poarta Alba", judet: "Constanta", agentie: "CT_OVIDIU_A03",
    articole: [{ cantitate: 1000, produs: "Plic autoadeziv AWB C5" }],
  })
);

// Cifrele așteptate, numărate pe comenzi (nu pe colete):
//   07.10 = 300 × 15,04 + 500 × 0,09 + 100 × 0,22 + 12 × 4,14 + 5 × 4,33
//         = 4.512,00 + 45,00 + 22,00 + 49,68 + 21,65 = 4.650,33
//   08.10 = 1000 × 0,09 = 90,00
const ZI1 = "2026-10-07", ZI2 = "2026-10-08";
const VENIT1 = 4650.33, VENIT2 = 90;

(async () => {
  for (const s of [
    "DELETE FROM consumabile_awb_linii WHERE awb_id IN (SELECT id FROM consumabile_awb WHERE awb LIKE '1SDY967%')",
    "DELETE FROM consumabile_awb WHERE awb LIKE '1SDY967%'",
    `DELETE FROM consumabile_linii WHERE produs_id IN (SELECT id FROM consumabile_produse WHERE cod LIKE 'tst-%')`,
    `DELETE FROM consumabile_zile WHERE client = 'Sameday' AND data IN ('${ZI1}','${ZI2}')`,
    "DELETE FROM consumabile_clienti WHERE cheie IN ('NOVATECH PRO','WIFISTORE RO','NICHIDUTA TRADING')",
    "DELETE FROM consumabile_produse WHERE cod LIKE 'tst-%'",
    "DELETE FROM miscari_stoc WHERE produs_id IN (SELECT id FROM produse WHERE denumire LIKE 'TST %')",
    "DELETE FROM produse WHERE denumire LIKE 'TST %'",
  ]) { try { exec(s); } catch (e) { /* tabelul poate lipsi la prima rulare */ } }

  for (const p of PRODUSE) {
    exec(`INSERT INTO consumabile_produse (cod, denumire, pret, ordine, aliasuri) VALUES (${lit(p.cod)}, ${lit(p.den)}, ${p.pret}, 90, ${lit(p.alias || null)})`);
  }

  // Fixtura folosește DENUMIRILE ADEVĂRATE de pe etichete — altfel n-ar testa
  // nimic din recunoaștere. Dar baza de dezvoltare are deja cele 15 produse
  // reale, cu exact aceleași denumiri, iar atunci „Plic autoadeziv AWB C5" e
  // ambiguu și potrivirea nimerește produsul real, nu pe cel de test.
  // Deci produsele reale se trec pe inactiv cât ține testul și se pun înapoi
  // la final, inclusiv dacă testul crapă pe drum.
  exec("UPDATE consumabile_produse SET activ = 0 WHERE cod NOT LIKE 'tst-%' AND activ = 1");
  const deReactivat = (await db.prepare("SELECT cod FROM consumabile_produse WHERE cod NOT LIKE 'tst-%' AND activ = 0").all()).map((x) => x.cod);
  const reactiveaza = () => {
    if (!deReactivat.length) return;
    try { exec(`UPDATE consumabile_produse SET activ = 1 WHERE cod IN (${deReactivat.map(lit).join(",")})`); } catch (e) { /* las-o */ }
  };
  process.on("exit", reactiveaza);

  console.log("\n1. Coletele se adună în comenzi, nu se adună comenzile pe colete");
  const grupe = T.grupeazaColete(ETICHETE);
  egal("64 etichete → 4 comenzi", grupe.length, 4);
  egal("cheia comenzii taie ultimele 3 cifre", T.cheieExpeditie("1SDY96700000001060"), "1SDY96700000001");
  const nova = grupe.find((g) => g.colete === 60);
  bine("comanda de 60 colete are 300 topuri, nu 18.000", nova && nova.articole[0].cantitate === 300, nova ? String(nova.articole[0].cantitate) : "lipsă");
  egal("kilogramele SE adună pe colete", rot(nova.kg), rot(60 * 10.2));

  console.log("\n2. Ziua de raport e cu o zi înaintea etichetei");
  egal("eticheta de 09.10 → ziua 08.10", mod.ziuaDeRaport("2026-10-09"), "2026-10-08");
  egal("prima zi a lunii nu sare luna", mod.ziuaDeRaport("2026-03-01"), "2026-02-28");
  egal("dată invalidă → null", mod.ziuaDeRaport("nu-e-dată"), null);

  console.log("\n3. Recunoașterea produsului");
  const prod = await db.prepare("SELECT * FROM consumabile_produse WHERE cod LIKE 'tst-%' ORDER BY cod").all();
  const index = T.indexeazaProduse(prod);
  egal("nicio semnătură ambiguă", [...index.ambigue], []);
  const potr = (n) => { const p = T.potrivesteProdus(n, index); return p ? p.cod : null; };
  egal("nume identic", potr("Plic autoadeziv AWB C5"), "tst-awb-c5");
  egal("alias de pe etichetă", potr("Banda adeziva FRAGIL"), "tst-fragil");
  egal("alias cu dimensiuni altfel scrise", potr("Cutie mare SD1 (460 x 410 x 373)"), "tst-cutie");
  egal("fără diacritice", potr("Plic autoadeziv AWB C5".replace("ă", "a")), "tst-awb-c5");
  egal("„Plic format A4\" NU devine „Top hârtie A4\"", potr("Plic format A4 (300x400mm)"), "tst-plic-a4");
  egal("„Top hârtie A4\" NU devine plic", potr("Top hârtie A4"), "tst-top-a4");
  egal("felul desparte codul comun „a4\"", [T.semnatura("Plic format A4"), T.semnatura("Top hârtie A4")], ["plic:a4", "top:a4"]);
  egal("produs inventat → nerecunoscut", potr("Pungă cu bule, model inventat"), null);

  console.log("\n4. Proba uscată nu scrie nimic");
  const n0 = Number((await db.prepare("SELECT COUNT(*) AS n FROM consumabile_awb").get()).n);
  const uscat = await mod.importaAwb(ETICHETE, { uscat: true });
  egal("proba uscată nu scrie", Number((await db.prepare("SELECT COUNT(*) AS n FROM consumabile_awb").get()).n), n0);
  egal("nicio necunoscută", uscat.necunoscute.length, 0);
  egal("două zile", uscat.zile, [ZI1, ZI2]);
  const u1 = uscat.detaliu.find((d) => d.zi === ZI1);
  egal(`${ZI1}: venitul calculat`, rot(u1.venit), VENIT1);
  egal(`${ZI1}: comenzi`, u1.awb_uri, 3);
  egal(`${ZI1}: colete`, u1.colete, 63);

  console.log("\n5. Un articol nerecunoscut oprește toată ziua");
  const stricat = JSON.parse(JSON.stringify(ETICHETE));
  stricat[0].articole.push({ cantitate: 7, produs: "Pungă cu bule, model inventat" });
  const refuz = await mod.importaAwb(stricat, {});
  bine("nu s-a scris nimic", refuz.scris === false, JSON.stringify(refuz.motiv));
  egal("necunoscuta e raportată cu numele exact", refuz.necunoscute.map((x) => x.nume), ["Pungă cu bule, model inventat"]);
  egal("baza a rămas neatinsă", Number((await db.prepare("SELECT COUNT(*) AS n FROM consumabile_awb").get()).n), n0);

  console.log("\n6. Importul adevărat");
  const scris = await mod.importaAwb(ETICHETE, {});
  bine("s-a scris", scris.scris === true);
  const d1 = scris.detaliu.find((d) => d.zi === ZI1);
  const d2 = scris.detaliu.find((d) => d.zi === ZI2);
  egal(`${ZI1}: venit`, rot(d1.venit), VENIT1);
  egal(`${ZI2}: venit`, rot(d2.venit), VENIT2);
  const linii = await db
    .prepare(`SELECT p.cod, l.cantitate FROM consumabile_linii l JOIN consumabile_zile z ON z.id = l.zi_id JOIN consumabile_produse p ON p.id = l.produs_id WHERE z.data = ? ORDER BY p.cod`)
    .all(ZI1);
  egal(`${ZI1}: cantitățile pe produs`, linii.map((l) => [l.cod, Number(l.cantitate)]),
    [["tst-awb-c5", 500], ["tst-cutie", 5], ["tst-fragil", 12], ["tst-plic-a4", 100], ["tst-top-a4", 300]]);

  console.log("\n7. Al doilea import nu dublează");
  const din2 = await mod.importaAwb(ETICHETE, {});
  egal(`${ZI1}: același venit la reimport`, rot(din2.detaliu.find((d) => d.zi === ZI1).venit), VENIT1);
  egal("tot 4 comenzi în bază", Number((await db.prepare("SELECT COUNT(*) AS n FROM consumabile_awb WHERE awb LIKE '1SDY967%'").get()).n), 4);

  console.log("\n8. Clienții");
  const cl = await db.prepare("SELECT cheie, nume, oras, judet, prima_comanda, ultima_comanda FROM consumabile_clienti WHERE cheie IN ('NOVATECH PRO','WIFISTORE RO','NICHIDUTA TRADING') ORDER BY cheie").all();
  egal("trei clienți, pe chei normalizate", cl.map((c) => c.cheie), ["NICHIDUTA TRADING", "NOVATECH PRO", "WIFISTORE RO"]);
  const n = cl.find((c) => c.cheie === "NOVATECH PRO");
  egal("„NOVATECH PRO S.R.L.\" și „S.C. NOVATECH PRO S.R.L.\" sunt un singur client", cl.filter((c) => c.cheie === "NOVATECH PRO").length, 1);
  egal("prima și ultima comandă", [n.prima_comanda, n.ultima_comanda], [ZI1, ZI2]);
  egal("orașul vine de pe etichetă", n.oras, "Poarta Alba");
  const nich = cl.find((c) => c.cheie === "NICHIDUTA TRADING");
  bine("mojibake reparat la salvare (NICHIDUŢĂ, nu NICHIDUÅ¢Ä‚)", nich && nich.nume.indexOf("Å") === -1, nich ? nich.nume : "lipsă");

  console.log("\n9. Suma pe clienți = suma pe zile");
  const pc = await db
    .prepare(`SELECT COALESCE(SUM(l.cantitate * l.pret), 0) AS v FROM consumabile_awb_linii l JOIN consumabile_awb a ON a.id = l.awb_id WHERE a.awb LIKE '1SDY967%'`)
    .get();
  egal("venitul repartizat pe clienți", rot(pc.v), rot(VENIT1 + VENIT2));

  console.log("\n10. Regula: clienții Sameday nu se ofertează");
  const e1 = await curierat.esteClientCurierat("S.C. NOVATECH PRO S.R.L.");
  bine("„S.C. NOVATECH PRO S.R.L.\" e recunoscut", !!e1, "null");
  bine("și scris cu litere mici, fără puncte", !!(await curierat.esteClientCurierat("novatech pro srl")));
  bine("o firmă care nu e pe AWB-uri nu e marcată", !(await curierat.esteClientCurierat("Firma Inventată Pentru Test SRL")));
  bine("un nume scurt nu prinde pe prefix", !(await curierat.esteClientCurierat("NOVA")));
  bine("avertismentul numește firma și curierul", e1 && curierat.avertisment(e1).indexOf("NOVATECH") >= 0 && curierat.avertisment(e1).indexOf("Sameday") >= 0);
  egal("cheia ignoră forma juridică", curierat.cheieClient("WIFISTORE.RO S.R.L."), "WIFISTORE RO");
  egal("și pe numele tăiat de etichetă", curierat.cheieClient("WELL PROFESIONAL SOLUTIONS S.R.L. -..."), "WELL PROFESIONAL SOLUTIONS");
  bine("numele tăiat e recunoscut ca tăiat", curierat.esteTrunchiat("WELL PROFESIONAL SOLUTIONS S.R.L. -..."));

  console.log("\n11. Costul vine din nomenclator, în trei trepte");
  const faProdus = (den, achizitie, reteta) => {
    const r = q("INSERT INTO produse (denumire, unitate_masura, pret_achizitie, cost_reteta) VALUES (?,?,?,?) RETURNING id", [den, "buc", achizitie, reteta]);
    return Number(r[0].id);
  };
  let dep = await db.prepare("SELECT id FROM depozite ORDER BY id LIMIT 1").get();
  if (!dep) dep = q("INSERT INTO depozite (denumire) VALUES ('Test AWB') RETURNING id", [])[0];

  const pReteta = faProdus("TST plic cu rețetă", 0.5, 0.062);
  const pIntrare = faProdus("TST cutie cumpărată", 2.1, null);
  const pDoarPret = faProdus("TST bandă doar cu preț", 3.33, null);
  const pAberant = faProdus("TST rolă uriașă", 1720, null);
  exec(`INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, data) VALUES (${pIntrare}, ${dep.id}, 'intrare', 100, 1.80, '2026-03-01')`);
  exec(`INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, data) VALUES (${pIntrare}, ${dep.id}, 'intrare', 100, 2.45, '2026-09-20')`);
  exec(`UPDATE consumabile_produse SET produs_id = ${pReteta} WHERE cod = 'tst-awb-c5'`);
  exec(`UPDATE consumabile_produse SET produs_id = ${pIntrare} WHERE cod = 'tst-cutie'`);
  exec(`UPDATE consumabile_produse SET produs_id = ${pDoarPret} WHERE cod = 'tst-fragil'`);
  exec(`UPDATE consumabile_produse SET produs_id = ${pAberant} WHERE cod = 'tst-plic-a4'`);

  await mod.recalculeazaCosturi();
  const c = await db.prepare("SELECT cod, cost, cost_sursa FROM consumabile_produse WHERE cod LIKE 'tst-%' ORDER BY cod").all();
  const cost = (cod) => c.find((x) => x.cod === cod);
  egal("rețeta bate tot", Math.round(Number(cost("tst-awb-c5").cost) * 1000) / 1000, 0.062);
  bine("temeiul spune „cost producție\"", String(cost("tst-awb-c5").cost_sursa).indexOf("producție") >= 0, cost("tst-awb-c5").cost_sursa);
  egal("ULTIMA intrare de marfă, nu prima", rot(cost("tst-cutie").cost), 2.45);
  bine("temeiul dă data intrării", String(cost("tst-cutie").cost_sursa).indexOf("20.09.2026") >= 0, cost("tst-cutie").cost_sursa);
  egal("prețul de achiziție, când nu e nici rețetă nici intrare", rot(cost("tst-fragil").cost), 3.33);
  bine("legătura greșită (1.720 lei la un plic de 22 bani) NU devine cost", cost("tst-plic-a4").cost === null, JSON.stringify(cost("tst-plic-a4")));
  bine("și spune de ce", String(cost("tst-plic-a4").cost_sursa).indexOf("plauzibil") >= 0, cost("tst-plic-a4").cost_sursa);
  bine("produsul nelegat nu primește cost inventat", cost("tst-top-a4").cost === null);
  egal("costPlauzibil taie peste 5× prețul", [T.costPlauzibil(1.4, 0.3), T.costPlauzibil(1.6, 0.3), T.costPlauzibil(0, 0.3)], [true, false, false]);

  console.log("\n12. Costul se îngheață pe liniile vechi, dar nu le rescrie");
  exec(`UPDATE consumabile_linii SET cost = NULL WHERE produs_id IN (SELECT id FROM consumabile_produse WHERE cod LIKE 'tst-%')`);
  await mod.umpleCosturiLipsa();
  const dupa = await db
    .prepare(`SELECT p.cod, l.cost FROM consumabile_linii l JOIN consumabile_zile z ON z.id = l.zi_id JOIN consumabile_produse p ON p.id = l.produs_id WHERE z.data = ? AND p.cod = 'tst-awb-c5'`)
    .get(ZI1);
  egal("linia a primit costul produsului", Math.round(Number(dupa.cost) * 1000) / 1000, 0.062);
  exec(`UPDATE consumabile_linii l SET cost = 0.99 FROM consumabile_produse p WHERE p.id = l.produs_id AND p.cod = 'tst-awb-c5'`);
  await mod.umpleCosturiLipsa();
  const pastrat = await db
    .prepare(`SELECT l.cost FROM consumabile_linii l JOIN consumabile_zile z ON z.id = l.zi_id JOIN consumabile_produse p ON p.id = l.produs_id WHERE z.data = ? AND p.cod = 'tst-awb-c5'`)
    .get(ZI1);
  egal("un cost deja înghețat NU se rescrie", rot(pastrat.cost), 0.99);

  // Curățenie: fixtura nu are ce căuta în baza de dezvoltare după test.
  for (const s of [
    "DELETE FROM consumabile_awb_linii WHERE awb_id IN (SELECT id FROM consumabile_awb WHERE awb LIKE '1SDY967%')",
    "DELETE FROM consumabile_awb WHERE awb LIKE '1SDY967%'",
    `DELETE FROM consumabile_linii WHERE produs_id IN (SELECT id FROM consumabile_produse WHERE cod LIKE 'tst-%')`,
    `DELETE FROM consumabile_zile WHERE client = 'Sameday' AND data IN ('${ZI1}','${ZI2}')`,
    "DELETE FROM consumabile_clienti WHERE cheie IN ('NOVATECH PRO','WIFISTORE RO','NICHIDUTA TRADING')",
    "DELETE FROM consumabile_produse WHERE cod LIKE 'tst-%'",
    "DELETE FROM miscari_stoc WHERE produs_id IN (SELECT id FROM produse WHERE denumire LIKE 'TST %')",
    "DELETE FROM produse WHERE denumire LIKE 'TST %'",
  ]) { try { exec(s); } catch (e) { /* las-o */ } }

  reactiveaza();
  console.log(rele ? `\n${rele} probleme.` : "\nToate verificările trec.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat testul: " + e.message); process.exit(1); });
