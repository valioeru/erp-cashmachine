"use strict";
// Comanda zilei Sameday, făcută de ERP din raportul de consumabile — și cine
// are voie să urce ziua.
//
// Cererea lui Vali, 05.11.2026:
//   „La Gabi Tecuceanu adaugă rapoarte doar cu comenzi Sameday, unde să-mi
//    urce ea comenzile zilnice." · „După ce se urcă acel raport, generează o
//    comandă nouă, cum face Gabi oricum zilnic, cu produsele zilnice." ·
//   „Dacă urcă și Gabi o zi și tu preiei singur, nu da două comenzi pe
//    aceeași zi." · „După ce apeși Comandă aici, să se schimbe culoarea
//    butonului."
//
// CE APĂRĂ:
//   • O ZI = O COMANDĂ. A doua urcare a aceleiași zile nu face a doua comandă,
//     nici când cele două urcări vin în aceeași clipă.
//   • COMANDA SE PUNE LA ZI DOAR CÂT E „NOUĂ". Una confirmată nu o rescrie un
//     import; una scrisă de mână e adoptată, nu dublată și nu rescrisă.
//   • PRODUSUL NELEGAT LA NOMENCLATOR NU DISPARE TĂCUT — se spune pe nume.
//   • COMANDA SCRISĂ DE MÂNĂ E ADOPTATĂ DOAR DACĂ E CHIAR A ZILEI (12.11.2026):
//     scrisă în ziua raportului (sau a doua zi) și cu valoarea zilei. Pe 12.11
//     ziua a luat drept a ei comanda #40 — o folie scrisă pe 03.11, cu livrare
//     pe 12.11 — și comanda zilei n-a mai ieșit deloc. O comandă adoptată
//     greșit se dezleagă din raport („nu e a zilei”) și ERP-ul o face pe a lui.
//   • COMANDA ZILEI SE VEDE ÎN RAPORT ȘI SE POATE CERE DIN BUTON (11.11.2026:
//     „Avem aici o problemă la import care mergea dar nu mai merge” — comanda
//     zilei nu s-a făcut, fiindcă niciun produs nu era legat la nomenclator).
//     După legare nu mai trebuie urcat fișierul a doua oară: rândul zilei are
//     „Fă comanda”. Doar pentru zilele proaspete, doar pentru cine poate urca
//     ziua, și tot o singură comandă pe zi.
//   • GABI ARE DOAR RAPORTUL SAMEDAY, nu toate rapoartele; cine are toate
//     rapoartele îl are în continuare.
//   • LINIA DEJA COMANDATĂ DIN DEPOZIT ARE BUTONUL VERDE și întreabă înainte
//     de a doua comandă.
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
let interogari = 0;
function q(sql, p) {
  interogari++;
  let i = 0;
  const s = String(sql).replace(/\?/g, () => lit((p || [])[i++]));
  let out;
  // -q: fără eticheta „UPDATE 0" de după rânduri — altfel un UPDATE … RETURNING
  // care n-a atins nimic ar părea că a atins un rând (cursa de legare).
  try { out = execFileSync("psql", ["-X", "-q", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
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
  // Emailul de anunț nu pleacă nicăieri din test.
  if (/(^|\/)lib\/mail$/.test(req)) return { trimite: async () => {}, trimiteDeLa: async () => {}, configUtilizator: () => null };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const CZ = require(path.join(RAD, "modules", "comenzi-zi.js"));
const auth = require(path.join(RAD, "lib", "auth.js"));
const warehouse = require(path.join(RAD, "modules", "warehouse.js"));
const ruteDepozit = { get: {}, post: {} };
warehouse.register({ get: (p, h) => { if (!ruteDepozit.get[p]) ruteDepozit.get[p] = h; }, post: (p, h) => { if (!ruteDepozit.post[p]) ruteDepozit.post[p] = h; } });

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
const bine2 = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

const ADMIN = { id: 97321, nume: "Vali", rol: "admin", email: "v.sd@test.ro" };
const GABI = { id: 97322, nume: "Gabriela Tecuceanu", rol: "vanzari", email: "g.sd@test.ro", sectiuni: "/rapoarte/comenzi-la-zi" };
const RAPOARTE = { id: 97323, nume: "Contabil", rol: "financiar", email: "c.sd@test.ro", sectiuni: "/rapoarte" };
const FARA = { id: 97324, nume: "Ion", rol: "vanzari", email: "i.sd@test.ro", sectiuni: "/crm" };
const DEPOZIT = { id: 97325, nume: "Depozit", rol: "depozit", email: "d.sd@test.ro" };
const PARTENER = 97331;
const P1 = 97341, P2 = 97342;
const Z1 = "2097-05-05", Z2 = "2097-05-06", Z3 = "2097-05-07", Z4 = "2097-05-08";
// Pentru butonul din raport: „azi” e 10.05.2097, deci 09.05 e proaspătă, 01.05 e veche.
const AZI_TEST = "2097-05-10", Z5 = "2097-05-09", Z6 = "2097-05-01", Z7 = "2097-05-10";
// Pentru adoptare și „nu e a zilei”: „azi” e 21.05.2097.
const AZI_DESFA = "2097-05-21", ZA = "2097-05-15", ZB = "2097-05-16", ZC = "2097-05-17", ZD = "2097-05-18", ZE = "2097-05-19", ZF = "2097-05-20", ZG = "2097-05-21";

function curata() {
  for (const s of [
    "UPDATE consumabile_zile SET comanda_id = NULL WHERE data LIKE '2097-%'",
    "DELETE FROM aprovizionari WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 97331)",
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 97331)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id = 97331)",
    "DELETE FROM comenzi WHERE partener_id = 97331",
    "DELETE FROM emailuri WHERE partener_id = 97331",
    "DELETE FROM consumabile_linii WHERE zi_id IN (SELECT id FROM consumabile_zile WHERE data LIKE '2097-%')",
    "DELETE FROM consumabile_zile WHERE data LIKE '2097-%'",
    "DELETE FROM consumabile_produse WHERE cod LIKE 'TSTSD%'",
    "DELETE FROM produse WHERE id IN (97341, 97342)",
    "DELETE FROM interactiuni WHERE partener_id = 97331",
    "DELETE FROM parteneri WHERE id = 97331",
    "DELETE FROM setari_app WHERE cheie = 'sameday_partener_id'",
    "DELETE FROM utilizatori WHERE id BETWEEN 97321 AND 97329",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
// Următoarea zi lucrătoare, socotită aici pe altă cale decât în modul.
const ziLucratoareDupa = (zi) => { const d = new Date(zi + "T12:00:00Z"); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); return d.toISOString().slice(0, 10); };
// O comandă scrisă de mână: numărul, când a fost scrisă, livrarea cerută, liniile [produs, cantitate, preț].
function scrieDeMana(numar, data, livrare, linii, stare) {
  exec(`INSERT INTO comenzi (partener_id, numar, data, data_livrare_ceruta, status, agent_id) VALUES (${PARTENER}, '${numar}', '${data}', ${livrare ? "'" + livrare + "'" : "NULL"}, '${stare || "noua"}', 97322)`);
  const c = q("SELECT id FROM comenzi WHERE partener_id = ? AND numar = ?", [PARTENER, numar])[0];
  for (const [produs, cant, pret] of linii || []) exec(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${c.id}, ${produs}, ${cant}, ${pret})`);
  return Number(c.id);
}
const comenziClient = () => q("SELECT id, status, sursa, numar, agent_id, data_livrare_ceruta FROM comenzi WHERE partener_id = ? ORDER BY id", [PARTENER]);
const liniiComanda = (id) => q("SELECT produs_id, cantitate, pret_unitar, um FROM comenzi_linii WHERE comanda_id = ? ORDER BY produs_id", [id]).map((l) => [Number(l.produs_id), Number(l.cantitate), Number(l.pret_unitar)]);
const ziua = (data) => q("SELECT id, comanda_id FROM consumabile_zile WHERE client = 'Sameday' AND data = ?", [data])[0];
function puneZi(data, linii) {
  exec(`INSERT INTO consumabile_zile (client, data, sursa) VALUES ('Sameday', '${data}', 'comenzi aprobate') ON CONFLICT (client, data) DO NOTHING`);
  const z = ziua(data);
  exec(`DELETE FROM consumabile_linii WHERE zi_id = ${z.id}`);
  for (const [cod, cant, pret] of linii) {
    exec(`INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret) SELECT ${z.id}, id, ${cant}, ${pret} FROM consumabile_produse WHERE cod = '${cod}'`);
  }
  return z;
}

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97321,'Vali','v.sd@test.ro','x','y','admin'), (97322,'Gabriela Tecuceanu','g.sd@test.ro','x','y','vanzari'), (97325,'Depozit','d.sd@test.ro','x','y','depozit')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${PARTENER}, 'DELIVERY SOLUTIONS TEST SA', 'RO97331', 'client')`,
    `INSERT INTO setari_app (cheie, valoare) VALUES ('sameday_partener_id', '${PARTENER}')`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${P1}, 'TSTSDP1', 'TSTSD Plic C5 de test', 'buc', 1), (${P2}, 'TSTSDP2', 'TSTSD Cutie medie de test', 'buc', 1)`,
    `INSERT INTO consumabile_produse (cod, denumire, um, pret, produs_id, ordine) VALUES ('TSTSD1', 'Plic C5 (raport)', 'buc', 0.09, ${P1}, 1), ('TSTSD2', 'Cutie medie (raport)', 'buc', 3.3, ${P2}, 2), ('TSTSD3', 'Pungă nelegată (raport)', 'buc', 0.5, NULL, 3)`,
  ]) exec(s);

  console.log("\nPlanul, fără bază de date:");
  const L = [{ produs_id: P1, denumire: "a", cantitate: 1000, pret: 0.09 }, { produs_id: null, denumire: "nelegat", cantitate: 10, pret: 0.5 }];
  egal("zi nouă → comandă nouă", CZ.planComandaZi({ linii: L }).actiune, "creeaza");
  egal("produsul nelegat se spune, cu valoarea", CZ.planComandaZi({ linii: L }).nelegate, [{ denumire: "nelegat", cantitate: 10, valoare: 5 }]);
  egal("niciun produs legat → nicio comandă", CZ.planComandaZi({ linii: [L[1]] }).actiune, "nimic");
  const ex = (o) => Object.assign({ id: 1, status: "noua", sursa: "sameday", linii: [{ produs_id: P1, cantitate: 1000, pret_unitar: 0.09 }] }, o);
  egal("aceeași zi, aceleași cifre → nimic de făcut", CZ.planComandaZi({ linii: L, existenta: ex() }).actiune, "lasa");
  egal("cantitate schimbată, comanda nouă → se pune la zi", CZ.planComandaZi({ linii: [Object.assign({}, L[0], { cantitate: 1200 })], existenta: ex() }).actiune, "actualizeaza");
  egal("comanda confirmată nu se rescrie", CZ.planComandaZi({ linii: [Object.assign({}, L[0], { cantitate: 1200 })], existenta: ex({ status: "confirmata" }) }).actiune, "lasa");
  egal("comanda scrisă de mână nu se rescrie", CZ.planComandaZi({ linii: [Object.assign({}, L[0], { cantitate: 1200 })], existenta: ex({ sursa: null }) }).actiune, "lasa");
  const pAnulata = CZ.planComandaZi({ linii: L, existenta: ex({ status: "anulata" }) });
  egal("comanda anulată nu se reface, și se spune de ce", [pAnulata.actiune, /anulată/.test(pAnulata.motiv)], ["lasa", true]);
  egal("două produse ale raportului pe același produs, același preț → o linie",
    CZ.planComandaZi({ linii: [{ produs_id: 5, denumire: "a", cantitate: 100, pret: 0.5 }, { produs_id: 5, denumire: "b", cantitate: 50, pret: 0.5 }] }).linii.map((l) => [l.produs_id, l.cantitate]), [[5, 150]]);

  console.log("\nPrima urcare a zilei face comanda:");
  puneZi(Z1, [["TSTSD1", 8000, 0.09], ["TSTSD2", 125, 3.3], ["TSTSD3", 40, 0.5]]);
  const r1 = await CZ.comandaZilei(Z1, GABI, "comenzile aprobate");
  egal("acțiunea", r1.actiune, "creeaza");
  const c1 = comenziClient();
  egal("o singură comandă pe client", c1.length, 1);
  egal("numărul, sursa și starea", [c1[0].numar, c1[0].sursa, c1[0].status], ["Sameday 05.05.2097", "sameday", "noua"]);
  egal("livrarea cerută: următoarea zi lucrătoare, cum scria Gabi", [c1[0].data_livrare_ceruta, c1[0].data_livrare_ceruta !== Z1], [ziLucratoareDupa(Z1), true]);
  const ZL = CZ.__test.ziuaLivrarii;
  egal("…miercuri → joi, joi → vineri, vineri → luni, sâmbătă → luni, duminică → luni",
    [ZL("2026-11-11"), ZL("2026-11-12"), ZL("2026-11-13"), ZL("2026-11-14"), ZL("2026-11-15")],
    ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-16", "2026-11-16"]);
  egal("liniile: produsele legate, cu prețul zilei", liniiComanda(c1[0].id), [[P1, 8000, 0.09], [P2, 125, 3.3]]);
  egal("ziua știe comanda ei", Number(ziua(Z1).comanda_id), Number(c1[0].id));
  egal("pungă nelegată spusă pe nume", (r1.nelegate || []).map((n) => n.denumire), ["Pungă nelegată (raport)"]);
  egal("agentul: Gabi, care a urcat (clientul n-avea comenzi)", Number(c1[0].agent_id), GABI.id);
  const ist1 = q("SELECT ce, utilizator_nume FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id", [c1[0].id]);
  egal("istoricul spune că e făcută de ERP, la urcarea lui Gabi", ist1.map((x) => [x.ce, x.utilizator_nume]), [["Comandă creată automat", "Gabriela Tecuceanu"]]);

  console.log("\nA doua urcare a aceleiași zile nu face a doua comandă:");
  const r2 = await CZ.comandaZilei(Z1, ADMIN, "AWB-urile");
  egal("acțiunea", r2.actiune, "lasa");
  egal("tot o comandă", comenziClient().length, 1);

  console.log("\nZiua urcată din nou cu alte cifre pune comanda la zi:");
  const iduriInainte = q("SELECT id, produs_id FROM comenzi_linii WHERE comanda_id = ? ORDER BY id", [c1[0].id]).map((x) => [Number(x.produs_id), Number(x.id)]);
  puneZi(Z1, [["TSTSD1", 9000, 0.09], ["TSTSD2", 125, 3.3]]);
  const r3 = await CZ.comandaZilei(Z1, ADMIN, "AWB-urile");
  egal("acțiunea", r3.actiune, "actualizeaza");
  egal("tot o comandă", comenziClient().length, 1);
  egal("liniile noi", liniiComanda(c1[0].id), [[P1, 9000, 0.09], [P2, 125, 3.3]]);
  // Cererile din depozit și rezervările țin de id-ul liniei: punerea la zi
  // schimbă cifra pe același rând, nu face rânduri noi.
  egal("liniile își păstrează rândul (id-ul)", q("SELECT id, produs_id FROM comenzi_linii WHERE comanda_id = ? ORDER BY id", [c1[0].id]).map((x) => [Number(x.produs_id), Number(x.id)]), iduriInainte);
  const ist3 = q("SELECT ce FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id", [c1[0].id]).map((x) => x.ce);
  egal("schimbarea e în istoricul comenzii", ist3.slice(1), ["Cantitate · TSTSD Plic C5 de test", "Pusă la zi automat"]);

  console.log("\nProdusul scos din zi iese și de pe comandă:");
  puneZi(Z1, [["TSTSD1", 9000, 0.09]]);
  const r3b = await CZ.comandaZilei(Z1, ADMIN, "AWB-urile");
  egal("acțiunea", r3b.actiune, "actualizeaza");
  egal("pe comandă a rămas doar ce e în zi", liniiComanda(c1[0].id), [[P1, 9000, 0.09]]);

  console.log("\nComanda confirmată nu o mai rescrie un import:");
  exec(`UPDATE comenzi SET status = 'confirmata' WHERE id = ${c1[0].id}`);
  puneZi(Z1, [["TSTSD1", 1, 0.09]]);
  const r4 = await CZ.comandaZilei(Z1, ADMIN, "AWB-urile");
  egal("acțiunea", r4.actiune, "lasa");
  egal("liniile au rămas", liniiComanda(c1[0].id), [[P1, 9000, 0.09]]);

  console.log("\nComanda scrisă de mână pentru o zi e adoptată, nu dublată:");
  // Cum scria Gabi: în ziua raportului, cu livrarea a doua zi și cu valoarea zilei (500 × 0,09 = 45 lei).
  scrieDeMana("scrisă de Gabi", `${Z2} 15:49:00`, Z3, [[P1, 500, 0.09]]);
  const deMana = comenziClient().find((c) => c.numar === "scrisă de Gabi");
  puneZi(Z2, [["TSTSD1", 500, 0.09]]);
  const r5 = await CZ.comandaZilei(Z2, GABI, "comenzile aprobate");
  egal("acțiunea", r5.actiune, "adoptata");
  egal("nicio comandă în plus", comenziClient().length, 2);
  egal("ziua e legată de comanda scrisă de mână", Number(ziua(Z2).comanda_id), Number(deMana.id));
  const r6 = await CZ.comandaZilei(Z2, GABI, "comenzile aprobate");
  egal("la a doua urcare n-o rescrie", [r6.actiune, comenziClient().length], ["lasa", 2]);

  console.log("\nDouă urcări în aceeași clipă fac o singură comandă:");
  puneZi(Z3, [["TSTSD2", 300, 3.3]]);
  const [a, b] = await Promise.all([CZ.comandaZilei(Z3, GABI, "comenzile aprobate"), CZ.comandaZilei(Z3, ADMIN, "AWB-urile")]);
  const pentruZ3 = comenziClient().filter((c) => c.numar === "Sameday 07.05.2097");
  egal("o singură comandă pentru zi", pentruZ3.length, 1);
  egal("ziua e legată de ea", Number(ziua(Z3).comanda_id), Number(pentruZ3[0].id));
  egal("una a făcut-o, cealaltă a lăsat-o", [a.actiune, b.actiune].sort(), ["creeaza", "lasa"]);
  egal("agentul vine de pe ultima comandă a clientului", Number(pentruZ3[0].agent_id), GABI.id);

  console.log("\nO comandă de mână ANULATĂ nu se adoptă; agentul nu e cine urcă:");
  scrieDeMana("anulată de Gabi", `${Z4} 15:10:00`, Z4, [[P2, 10, 3.3]], "anulata");
  puneZi(Z4, [["TSTSD2", 10, 3.3]]);
  const r7 = await CZ.comandaZilei(Z4, ADMIN, "AWB-urile");
  egal("acțiunea", r7.actiune, "creeaza");
  const pentruZ4 = comenziClient().filter((c) => c.numar === "Sameday 08.05.2097" && c.status !== "anulata");
  egal("comanda nouă, nu cea anulată, e a zilei", [pentruZ4.length, Number(ziua(Z4).comanda_id)], [1, Number(pentruZ4[0] && pentruZ4[0].id)]);
  egal("agentul: de pe ultima comandă (Gabi), nu Vali care a urcat", Number(pentruZ4[0] && pentruZ4[0].agent_id), GABI.id);

  console.log("\nCe comandă scrisă de mână e chiar a zilei (12.11.2026: ziua a luat comanda #40, o folie cu livrare în ziua aia):");
  const EZ = CZ.__test.eComandaZilei;
  egal("aceeași valoare, sau la un leu / 2% de ea: e a zilei; altfel nu",
    [EZ(45, 45), EZ(45.36, 45), EZ(46.5, 45), EZ(13630.65, 13630.65), EZ(13800, 13630.65), EZ(14000, 13630.65), EZ(229, 9675.5), EZ(1180223.4, 7659.39)],
    [true, true, false, true, true, false, false, false]);
  egal("fără valoare de o parte sau de alta nu e nimic de comparat", [EZ(0, 0), EZ(0, 45), EZ(45, 0), EZ(null, undefined)], [false, false, false, false]);
  egal("la sume mici ține leul, nu procentul: 10,80 față de 10 e a zilei, 11,50 nu", [EZ(10.8, 10), EZ(11.5, 10), EZ(9.2, 10), EZ(8.5, 10)], [true, false, true, false]);
  const cate = () => comenziClient().length;
  // Cazul din 12.11: comandă veche, cu altă marfă, care doar are livrarea cerută în ziua raportului.
  const folie = scrieDeMana("folie veche, livrare în ziua raportului", "2097-04-20 09:17:00", ZA, [[P2, 10, 22.9]]);
  puneZi(ZA, [["TSTSD1", 1000, 0.09]]);
  let nA = cate();
  let ra = await CZ.comandaZilei(ZA, GABI, "comenzile aprobate");
  egal("comanda cu livrarea în ziua raportului, dar scrisă altă dată și cu altă valoare, NU e luată drept a zilei", [ra.actiune, cate(), Number(ziua(ZA).comanda_id) === folie], ["creeaza", nA + 1, false]);
  egal("…ERP-ul face comanda zilei", comenziClient().filter((c) => c.numar === "Sameday 15.05.2097").map((c) => liniiComanda(c.id)), [[[P1, 1000, 0.09]]]);
  // Comanda mare a clientului, scrisă chiar în ziua raportului (ca #62, de 1,18 milioane).
  const mare = scrieDeMana("comanda mare din ziua raportului", `${ZB} 15:08:00`, "2097-05-30", [[P1, 756700, 0.09], [P2, 5000, 3.3]]);
  puneZi(ZB, [["TSTSD1", 1000, 0.09]]);
  nA = cate();
  ra = await CZ.comandaZilei(ZB, GABI, "comenzile aprobate");
  egal("comanda scrisă în ziua raportului, dar cu altă valoare, nu e a zilei", [ra.actiune, cate(), Number(ziua(ZB).comanda_id) === mare], ["creeaza", nA + 1, false]);
  // Scrisă a doua zi dimineață, cu valoarea zilei: e a zilei.
  const aDouaZi = scrieDeMana("scrisă a doua zi", `${ZD} 08:05:00`, ZD, [[P1, 2000, 0.09]]);
  puneZi(ZC, [["TSTSD1", 2000, 0.09]]);
  nA = cate();
  ra = await CZ.comandaZilei(ZC, GABI, "comenzile aprobate");
  egal("comanda scrisă a doua zi, cu valoarea zilei, e adoptată", [ra.actiune, cate(), Number(ziua(ZC).comanda_id)], ["adoptata", nA, aDouaZi]);
  // Scrisă cu două zile mai târziu: nu.
  scrieDeMana("scrisă peste două zile", `${ZF} 08:05:00`, ZF, [[P1, 3000, 0.09]]);
  puneZi(ZD, [["TSTSD1", 3000, 0.09]]);
  nA = cate();
  ra = await CZ.comandaZilei(ZD, GABI, "comenzile aprobate");
  egal("…cea scrisă peste două zile, nu", [ra.actiune, cate()], ["creeaza", nA + 1]);
  // Aproape aceeași valoare (un rând în plus de 1,50 lei la 99 de lei, adică sub 2%): tot a zilei. La 3% diferență, nu.
  const aproape = scrieDeMana("aproape valoarea zilei", `${ZE} 15:00:00`, ZF, [[P2, 30, 3.3], [P1, 30, 0.05]]);
  puneZi(ZE, [["TSTSD2", 30, 3.3]]);
  ra = await CZ.comandaZilei(ZE, GABI, "comenzile aprobate");
  egal("la 1,50 lei de valoarea zilei (99 de lei): tot a zilei", [ra.actiune, Number(ziua(ZE).comanda_id)], ["adoptata", aproape]);
  exec(`UPDATE comenzi SET data = '${ZF} 15:00:00' WHERE numar = 'scrisă peste două zile'`);
  puneZi(ZF, [["TSTSD1", 3100, 0.09]]);
  nA = cate();
  ra = await CZ.comandaZilei(ZF, GABI, "comenzile aprobate");
  egal("la 3% de valoarea zilei (270 față de 279): nu e a zilei", [ra.actiune, cate()], ["creeaza", nA + 1]);

  // Valoarea zilei are și produsele nelegate la nomenclator: comanda lui Gabi le avea pe toate.
  const cuNelegat = scrieDeMana("cu tot cu produsul nelegat", "2097-05-23 15:30:00", "2097-05-24", [[P1, 1000, 0.09], [P2, 20, 0.5]]);
  puneZi("2097-05-23", [["TSTSD1", 1000, 0.09], ["TSTSD3", 20, 0.5]]);
  ra = await CZ.comandaZilei("2097-05-23", GABI, "comenzile aprobate");
  egal("valoarea zilei se socotește cu tot cu produsele nelegate (90 + 10 lei)", [ra.actiune, Number(ziua("2097-05-23").comanda_id)], ["adoptata", cuNelegat]);

  console.log("\nPagina raportului se deschide, cu perioadele de facturare ale lui Vali (29.10):");
  const ruteZi = { get: {}, post: {} };
  CZ.register({ get: (p, h) => { if (!ruteZi.get[p]) ruteZi.get[p] = h; }, post: (p, h) => { if (!ruteZi.post[p]) ruteZi.post[p] = h; } });
  const pag = await (async () => {
    const r = { cod: 0, corp: "", writeHead(c) { this.cod = c; }, setHeader() {}, end(x) { this.corp = x || ""; } };
    await ruteZi.get["/rapoarte/comenzi-la-zi"]({ user: GABI, params: {}, query: { luna: "2097-05" }, body: {}, res: r, req: { url: "/rapoarte/comenzi-la-zi?luna=2097-05" } });
    return r;
  })();
  egal("se deschide pentru Gabi", pag.cod || 200, 200);
  egal("rândul de facturare al primei chenzine (1–15 mai 2097)", /De facturat (la zi )?01\.05\.2097/.test(pag.corp), true);

  console.log("\nComanda zilei în raport: ce comandă are fiecare zi și butonul care o face:");
  CZ.__test.azi = AZI_TEST;
  const C0 = "/rapoarte/comenzi-la-zi";
  const cere = async (metoda, cale, user, o) => {
    const r = { cod: 0, corp: "", antet: {}, writeHead(c, h) { this.cod = c; this.antet = h || {}; }, setHeader(k, v) { this.antet[k] = v; }, end(x) { this.corp = x || ""; } };
    await ruteZi[metoda][cale]({ user, params: {}, query: (o && o.query) || {}, body: (o && o.body) || {}, res: r, req: { url: cale, method: metoda.toUpperCase() } });
    return r;
  };
  // Rândul unei zile din tabelul „Pe zi” (primul din pagină; „Pe luni” vine după).
  const randul = (corp, zi) => {
    const ro = zi.slice(8, 10) + "\\." + zi.slice(5, 7) + "\\." + zi.slice(0, 4);
    const m = String(corp).match(new RegExp("<tr[^>]*>\\s*<td[^>]*><strong>" + ro + "</strong>[\\s\\S]*?</tr>"));
    return m ? m[0] : "";
  };
  const Zd = CZ.__test.ziDeComanda;
  egal("fereastra butonului: ultimele 7 zile și mâine, nimic altceva",
    [Zd("2097-05-03", AZI_TEST), Zd("2097-05-02", AZI_TEST), Zd("2097-05-11", AZI_TEST), Zd("2097-05-12", AZI_TEST), Zd("prostie", AZI_TEST), Zd("", AZI_TEST)],
    [true, false, true, false, false, false]);
  puneZi(Z5, [["TSTSD1", 700, 0.09], ["TSTSD3", 5, 0.5]]);
  puneZi(Z6, [["TSTSD1", 100, 0.09]]);
  let pg = await cere("get", C0, GABI, { query: { luna: "2097-05" } });
  if (process.env.SALVEAZA_PAGINI) require("fs").writeFileSync(path.join(process.env.SALVEAZA_PAGINI, "comenzi-zi-raport.html"), pg.corp);
  egal("tabelul zilelor are coloana „Comanda zilei”", /<th[^>]*>Comanda zilei<\/th>/.test(pg.corp), true);
  const r1z = randul(pg.corp, Z1), r2z = randul(pg.corp, Z2), r5z = randul(pg.corp, Z5), r6z = randul(pg.corp, Z6);
  egal("ziua cu comanda făcută de ERP o arată, cu link", [r1z.includes(`href="/comenzi/${c1[0].id}"`), r1z.includes("făcută de ERP")], [true, true]);
  egal("ziua cu comanda lui Gabi o arată ca scrisă de mână", [r2z.includes(`href="/comenzi/${deMana.id}"`), r2z.includes("scrisă de mână")], [true, true]);
  egal("ziua cu comandă nu are buton", [r1z.includes("fa-comanda"), r2z.includes("fa-comanda")], [false, false]);
  egal("ziua proaspătă fără comandă are butonul, cu ziua ei și cu întrebare",
    [r5z.includes(`action="${C0}/comanda-zilei"`), r5z.includes(`name="zi" value="${Z5}"`), />Fă comanda<\/button>/.test(r5z), /onsubmit="return confirm\('Fac comanda pentru DELIVERY SOLUTIONS pe ziua 09\.05\.2097/.test(r5z)],
    [true, true, true, true]);
  egal("ziua veche fără comandă nu are buton", [r6z !== "", r6z.includes("fa-comanda")], [true, false]);
  const pgFara = await cere("get", C0, FARA, { query: { luna: "2097-05" } });
  egal("cine n-are voie să urce ziua nu vede butonul", [randul(pgFara.corp, Z5) !== "", pgFara.corp.includes("fa-comanda")], [true, false]);

  let rz = await cere("post", C0 + "/comanda-zilei", FARA, { body: { zi: Z5 } });
  egal("cine n-are voie e trimis înapoi, fără comandă", [rz.cod, rz.antet.Location, ziua(Z5).comanda_id], [302, C0, null]);
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: "ieri" } });
  egal("fără zi: spune că lipsește", [rz.cod, /Lipsește ziua/.test(rz.corp)], [400, true]);
  const cateInainte = comenziClient().length;
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: Z6 } });
  egal("ziua veche: refuzată, cu motivul", [rz.cod, /doar pentru ultimele 7 zile/.test(rz.corp), /Ziua 01\.05\.2097 e mai veche/.test(rz.corp)], [422, true, true]);
  egal("…și nicio comandă făcută", [comenziClient().length, ziua(Z6).comanda_id], [cateInainte, null]);
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: "2097-05-12" } });
  egal("nici o zi de peste două zile nu se comandă", [rz.cod, comenziClient().length], [422, cateInainte]);

  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: Z5 } });
  const c5 = comenziClient().filter((c) => c.numar === "Sameday 09.05.2097");
  egal("butonul face comanda zilei", [rz.cod, c5.length, c5[0] && c5[0].sursa, c5[0] && c5[0].status], [200, 1, "sameday", "noua"]);
  egal("…cu livrarea cerută în următoarea zi lucrătoare", c5[0].data_livrare_ceruta, ziLucratoareDupa(Z5));
  egal("…cu produsele legate, la prețul zilei", liniiComanda(c5[0].id), [[P1, 700, 0.09]]);
  egal("ziua știe comanda ei", Number(ziua(Z5).comanda_id), Number(c5[0].id));
  egal("pagina spune că a făcut-o și duce la ea", [/Am făcut comanda zilei 09\.05\.2097\./.test(rz.corp), rz.corp.includes(`href="/comenzi/${c5[0].id}"`)], [true, true]);
  egal("…spune pe nume ce n-a intrat, unde se leagă și că fișierul nu mai trebuie urcat",
    [/Pungă nelegată \(raport\) \(5 buc/.test(rz.corp), rz.corp.includes(`href="${C0}?legare=1"`), /apasă „Fă comanda” pe rândul zilei/.test(rz.corp), /urcă ziua din nou/.test(rz.corp)],
    [true, true, true, false]);
  egal("…și are drumul înapoi la ziua din raport", rz.corp.includes(`href="${C0}?perioada=custom&de=${Z5}&pana=${Z5}"`), true);
  const ist5 = q("SELECT ce, nou FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id", [c5[0].id]);
  egal("istoricul comenzii spune că a fost cerută din buton, și de cine", [ist5[0].ce, /butonul din raport/.test(ist5[0].nou || ""), /urcată de Gabriela Tecuceanu/.test(ist5[0].nou || "")], ["Comandă creată automat", true, true]);
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: Z5 } });
  egal("a doua apăsare nu face a doua comandă", [rz.cod, comenziClient().filter((c) => c.numar === "Sameday 09.05.2097").length, /e deja la zi/.test(rz.corp)], [200, 1, true]);
  pg = await cere("get", C0, GABI, { query: { luna: "2097-05" } });
  egal("după, rândul zilei arată comanda, nu butonul", [randul(pg.corp, Z5).includes(`href="/comenzi/${c5[0].id}"`), randul(pg.corp, Z5).includes("fa-comanda")], [true, false]);

  // Exact ce s-a întâmplat pe 11.11.2026: ziua urcată, niciun produs legat.
  puneZi(Z7, [["TSTSD3", 5, 0.5]]);
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: Z7 } });
  egal("zi cu produse nelegate: comanda nu se face, și se spune de ce",
    [rz.cod, /nu s-a făcut: niciun produs al zilei nu e legat la nomenclator/.test(rz.corp), rz.corp.includes(`href="${C0}?legare=1"`), ziua(Z7).comanda_id],
    [200, true, true, null]);
  exec(`UPDATE consumabile_produse SET produs_id = ${P2} WHERE cod = 'TSTSD3'`);
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: Z7 } });
  const c7 = comenziClient().filter((c) => c.numar === "Sameday 10.05.2097");
  egal("după legare, butonul o face — fără a urca fișierul din nou", [c7.length, c7[0] ? liniiComanda(c7[0].id) : null, /Nu au intrat pe comandă/.test(rz.corp)], [1, [[P2, 5, 0.5]], false]);
  exec(`UPDATE consumabile_produse SET produs_id = NULL WHERE cod = 'TSTSD3'`);

  exec(`UPDATE comenzi SET status = 'anulata' WHERE id = ${c5[0].id}`);
  pg = await cere("get", C0, GABI, { query: { luna: "2097-05" } });
  egal("comanda anulată se vede ca anulată, fără buton", [/făcută de ERP, anulată/.test(randul(pg.corp, Z5)), randul(pg.corp, Z5).includes("fa-comanda")], [true, false]);
  rz = await cere("post", C0 + "/comanda-zilei", GABI, { body: { zi: Z5 } });
  egal("…și cererea n-o reface", [comenziClient().filter((c) => c.numar === "Sameday 09.05.2097").length, /a fost anulată/.test(rz.corp)], [1, true]);
  CZ.__test.azi = null;

  console.log("\n„Nu e a zilei”: comanda adoptată greșit se dezleagă din raport, iar ERP-ul o face pe a lui:");
  CZ.__test.azi = AZI_DESFA;
  // Starea lăsată pe live de regula veche: ziua legată de o comandă care n-are legătură cu ea.
  const straina = scrieDeMana("folie pentru altceva", "2097-05-03 09:17:00", ZG, [[P2, 10, 22.9]]);
  puneZi(ZG, [["TSTSD1", 4000, 0.09]]);
  exec(`UPDATE consumabile_zile SET comanda_id = ${straina} WHERE data = '${ZG}'`);
  pg = await cere("get", C0, GABI, { query: { luna: "2097-05" } });
  const rg0 = randul(pg.corp, ZG);
  egal("ziua legată de o comandă scrisă de mână are butonul „nu e a zilei”, cu ziua, comanda și întrebarea",
    [rg0.includes(`href="/comenzi/${straina}"`), rg0.includes(`action="${C0}/comanda-zilei/desfa"`), rg0.includes(`name="zi" value="${ZG}"`), rg0.includes(`name="comanda" value="${straina}"`), />nu e a zilei<\/button>/.test(rg0),
     new RegExp(`onsubmit="return confirm\\('Comanda #${straina} nu e comanda zilei 21\\.05\\.2097\\?`).test(rg0)],
    [true, true, true, true, true, true]);
  egal("ziua cu comanda făcută de ERP nu-l are; nici ziua veche cu comandă scrisă de mână", [randul(pg.corp, ZA).includes("nu-e-a-zilei"), randul(pg.corp, Z2).includes("nu-e-a-zilei"), randul(pg.corp, Z2).includes("scrisă de mână")], [false, false, true]);
  egal("cine n-are voie să urce ziua nu-l vede", (await cere("get", C0, FARA, { query: { luna: "2097-05" } })).corp.includes("nu-e-a-zilei"), false);
  const D = C0 + "/comanda-zilei/desfa";
  const legataDe = (zi) => Number(ziua(zi).comanda_id) || null;
  rz = await cere("post", D, FARA, { body: { zi: ZG, comanda: String(straina) } });
  egal("cine n-are voie e trimis înapoi, iar legătura rămâne", [rz.cod, rz.antet.Location, legataDe(ZG)], [302, C0, straina]);
  rz = await cere("post", D, GABI, { body: { zi: "azi" } });
  egal("fără zi: spune că lipsește", [rz.cod, /Lipsește ziua/.test(rz.corp)], [400, true]);
  rz = await cere("post", D, GABI, { body: { zi: Z2, comanda: String(deMana.id) } });
  egal("ziua veche: legătura nu se mai schimbă", [rz.cod, /doar pentru ultimele 7 zile/.test(rz.corp), legataDe(Z2)], [422, true, Number(deMana.id)]);
  rz = await cere("post", D, GABI, { body: { zi: "2097-05-22" } });
  egal("ziua care nu e în raport", [rz.cod, /nu e în raport/.test(rz.corp)], [404, true]);
  exec(`UPDATE consumabile_zile SET comanda_id = NULL WHERE data = '${ZB}'`);
  rz = await cere("post", D, GABI, { body: { zi: ZB } });
  egal("ziua fără comandă legată: n-are ce dezlega", [rz.cod, /n-are nicio comandă legată/.test(rz.corp)], [409, true]);
  const aErp = legataDe(ZF);
  rz = await cere("post", D, GABI, { body: { zi: ZF, comanda: String(aErp) } });
  egal("comanda făcută de ERP nu se dezleagă: e chiar a zilei", [rz.cod, /e făcută de ERP din raport/.test(rz.corp), legataDe(ZF)], [422, true, aErp]);
  rz = await cere("post", D, GABI, { body: { zi: ZG, comanda: String(aErp) } });
  egal("dacă între timp ziua are altă comandă decât cea de pe pagină, nu se atinge nimic", [rz.cod, /a primit altă comandă/.test(rz.corp), legataDe(ZG)], [409, true, straina]);

  const jurnalD = [];
  const scrieD = console.log;
  console.log = (...a) => { jurnalD.push(a.join(" ")); };
  try { rz = await cere("post", D, GABI, { body: { zi: ZG, comanda: String(straina) } }); } finally { console.log = scrieD; }
  const nouaG = comenziClient().filter((c) => c.numar === "Sameday 21.05.2097");
  egal("dezlegată, ziua își primește comanda făcută din raport", [rz.cod, nouaG.length, nouaG[0] && liniiComanda(nouaG[0].id), legataDe(ZG) === Number(nouaG[0] && nouaG[0].id)], [200, 1, [[P1, 4000, 0.09]], true]);
  egal("…iar comanda dezlegată rămâne neatinsă", [q("SELECT status, numar FROM comenzi WHERE id = ?", [straina]).map((c) => [c.status, c.numar]), liniiComanda(straina)], [[["noua", "folie pentru altceva"]], [[P2, 10, 22.9]]]);
  egal("pagina spune ce a dezlegat și ce a făcut", [rz.corp.includes(`Am dezlegat comanda <a href="/comenzi/${straina}">#${straina}</a> de ziua 21.05.2097`), /Comanda a rămas neatinsă/.test(rz.corp), /Am făcut comanda zilei 21\.05\.2097\./.test(rz.corp), rz.corp.includes(`href="/comenzi/${nouaG[0] && nouaG[0].id}"`)], [true, true, true, true]);
  bine2("jurnalul spune cine a dezlegat ce", jurnalD.some((x) => x.includes(`Gabriela Tecuceanu a dezlegat comanda #${straina} de ziua ${ZG}`)), jurnalD.join(" | ").slice(0, 200));
  const istG = q("SELECT nou FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id LIMIT 1", [nouaG[0].id])[0] || {};
  egal("…iar istoricul comenzii noi spune de unde vine", new RegExp(`după ce comanda #${straina} a fost dezlegată de zi`).test(istG.nou || ""), true);
  rz = await cere("post", D, GABI, { body: { zi: ZG, comanda: String(straina) } });
  egal("a doua apăsare nu mai are ce dezlega", [rz.cod, legataDe(ZG) === Number(nouaG[0].id), comenziClient().filter((c) => c.numar === "Sameday 21.05.2097").length], [409, true, 1]);

  // Comanda care chiar seamănă cu a zilei (scrisă în ziua ei, aceeași valoare), dar despre care omul spune că nu e.
  exec(`UPDATE consumabile_zile SET comanda_id = NULL WHERE data = '${ZE}'`);
  let re = await CZ.comandaZilei(ZE, GABI, "comenzile aprobate");
  egal("comanda cu valoarea zilei e luată iar drept a zilei", [re.actiune, legataDe(ZE)], ["adoptata", aproape]);
  rz = await cere("post", D, GABI, { body: { zi: ZE, comanda: String(aproape) } });
  const nouaE = comenziClient().filter((c) => c.numar === "Sameday 19.05.2097");
  egal("…dar după „nu e a zilei” nu mai e luată înapoi: ERP-ul face alta", [rz.cod, nouaE.length, legataDe(ZE) === Number(nouaE[0] && nouaE[0].id), /Am făcut comanda zilei 19\.05\.2097/.test(rz.corp)], [200, 1, true, true]);
  re = await CZ.comandaZilei(ZE, GABI, "AWB-urile");
  egal("…iar următoarea urcare o lasă pe cea făcută de ERP", [re.actiune, comenziClient().filter((c) => c.numar === "Sameday 19.05.2097").length], ["lasa", 1]);
  CZ.__test.azi = null;

  console.log("\nCine are voie la raportul Sameday:");
  const C = "/rapoarte/comenzi-la-zi";
  egal("Gabi intră în raportul Sameday", auth.poateAccesa(GABI, C), true);
  egal("…și în pagina unei zile din el", auth.poateAccesa(GABI, C + "/awb"), true);
  egal("…dar nu în restul rapoartelor", [auth.poateAccesa(GABI, "/rapoarte"), auth.poateAccesa(GABI, "/rapoarte/vanzari")], [false, false]);
  egal("cine are toate rapoartele îl are și pe ăsta", auth.poateAccesa(RAPOARTE, C), true);
  egal("cine n-are nicio bifă de rapoarte nu intră", auth.poateAccesa(FARA, C), false);
  egal("Gabi poate urca ziua", CZ.poateUrca(GABI), true);
  egal("agentul fără bifă nu", CZ.poateUrca(FARA), false);
  egal("bifa nouă apare în lista din Utilizatori", auth.ZONE.some((z) => z.cheie === C), true);
  // Ce vede Gabi în bare: raportul ei, nu linkuri care-i răspund „Nu ai acces”.
  const rapoarteMod = require(path.join(RAD, "modules", "rapoarte.js"));
  const render = require(path.join(RAD, "lib", "render.js"));
  const paginaGabi = rapoarteMod.pagina({ user: GABI }, "Comenzi Sameday", C, "");
  const bara = (paginaGabi.match(/<div class="subnav">[\s\S]*?<\/div>/) || [""])[0];
  egal("bara rapoartelor la Gabi: doar raportul Sameday",
    [bara.includes(`href="${C}"`), bara.includes("Toate rapoartele"), bara.includes('href="/rapoarte/vanzari"')], [true, false, false]);
  const baraRapoarte = (rapoarteMod.pagina({ user: RAPOARTE }, "R", C, "").match(/<div class="subnav">[\s\S]*?<\/div>/) || [""])[0];
  egal("…cine are toate rapoartele le vede pe toate", [baraRapoarte.includes("Toate rapoartele"), baraRapoarte.includes(`href="${C}"`)], [true, true]);
  egal("din Comenzi, Gabi are linkul „Comenzi Sameday”", render.subnavComenzi("/comenzi", GABI).includes(`href="${C}"`), true);
  egal("…agentul fără bifă nu", render.subnavComenzi("/comenzi", FARA).includes(`href="${C}"`), false);

  console.log("\nÎn depozit, linia deja comandată are butonul verde:");
  const cmd = Number(pentruZ3[0].id);
  const linie = q("SELECT id FROM comenzi_linii WHERE comanda_id = ?", [cmd])[0];
  const fara = await (async () => {
    const r = { cod: 0, corp: "" , writeHead(c) { this.cod = c; }, setHeader() {}, end(x) { this.corp = x || ""; } };
    await ruteDepozit.get["/depozit/comanda/:id"]({ user: DEPOZIT, params: { id: String(cmd) }, query: {}, body: {}, res: r, req: { url: "/" } });
    return r.corp;
  })();
  if (fara.includes(">Comandă</button>") && !fara.includes("✓ Comandat")) ok("înainte de comandă: butonul obișnuit");
  else rau("butonul de dinainte de comandă nu e cel obișnuit");
  exec(`INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, sursa, status, cerut_de, creata_la) VALUES (${cmd}, ${linie.id}, ${P2}, 300, 'tert', 'ceruta', 'Depozit', '2097-05-07 10:00:00')`);
  const dupa = await (async () => {
    const r = { cod: 0, corp: "", writeHead(c) { this.cod = c; }, setHeader() {}, end(x) { this.corp = x || ""; } };
    await ruteDepozit.get["/depozit/comanda/:id"]({ user: DEPOZIT, params: { id: String(cmd) }, query: {}, body: {}, res: r, req: { url: "/" } });
    return r.corp;
  })();
  if (dupa.includes("✓ Comandat") && dupa.includes("background:var(--success)")) ok("după comandă: butonul verde „✓ Comandat”");
  else rau("butonul nu și-a schimbat culoarea după comandă");
  if (dupa.includes("comandat 300 de la terț")) ok("dedesubt scrie ce s-a comandat");
  else rau("nu scrie ce s-a comandat");
  if (/onsubmit="return confirm\('Pentru linia asta ai comandat deja 300/.test(dupa)) ok("a doua apăsare întreabă înainte");
  else rau("a doua comandă pe aceeași linie pleacă fără întrebare");
  // Două cereri pe aceeași linie: întrebarea spune totalul, ca număr.
  exec(`INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, sursa, status, cerut_de, creata_la) VALUES (${cmd}, ${linie.id}, ${P2}, 1250, 'productie', 'ceruta', 'Depozit', '2097-05-07 11:00:00')`);
  const doua = await (async () => {
    const r = { cod: 0, corp: "", writeHead(c) { this.cod = c; }, setHeader() {}, end(x) { this.corp = x || ""; } };
    await ruteDepozit.get["/depozit/comanda/:id"]({ user: DEPOZIT, params: { id: String(cmd) }, query: {}, body: {}, res: r, req: { url: "/" } });
    return r.corp;
  })();
  if (/ai comandat deja 1\.550\. Mai comanzi/.test(doua) && doua.includes("comandat 1.250 din producție")) ok("două cereri: întrebarea spune totalul (1.550)");
  else rau("totalul cererilor de pe linie e greșit în întrebare");
  exec(`UPDATE aprovizionari SET status = 'anulata' WHERE comanda_id = ${cmd}`);
  const anulat = await (async () => {
    const r = { cod: 0, corp: "", writeHead(c) { this.cod = c; }, setHeader() {}, end(x) { this.corp = x || ""; } };
    await ruteDepozit.get["/depozit/comanda/:id"]({ user: DEPOZIT, params: { id: String(cmd) }, query: {}, body: {}, res: r, req: { url: "/" } });
    return r.corp;
  })();
  if (!anulat.includes("✓ Comandat")) ok("cererea anulată nu mai ține butonul verde");
  else rau("butonul a rămas verde după anularea cererii");

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); } catch (_) {}
  process.exit(1);
});
