"use strict";
// Termenul de plată: pe partener, copiat pe comandă, dus pe factură ca
// scadență și de acolo în SmartBill (lib/termen-plata.js).
//
// Cererea lui Vali, 17.11.2026: „Vreau la orice client sau furnizor să se poată
// defini termen de plată. Orice comandă preia implicit termenul de plată al
// partenerului, dar se poate modifica punctual la fiecare comandă; facturile
// emise și transmise către SmartBill să preia automat și acest termen de plată."
//
// CE APĂRĂ:
//
//   • TERMENUL SE SCRIE ÎN ZILE ÎNTREGI. „30,5", „abc", „-5" sau 400 sunt
//     refuzate cu mesaj, nu ghicite și nu transformate tăcut în „nimic".
//   • COMANDA ÎL COPIAZĂ LA PLASARE. Gol = cel din fișă; scris = acela. O
//     schimbare ulterioară pe fișă nu mută comenzile deja plasate.
//   • MODIFICAREA INTRĂ ÎN ISTORIC, cu text omenesc („30 de zile → 60 de
//     zile"), iar o comandă veche fără termen nu primește în istoric o
//     schimbare pe care n-a făcut-o nimeni.
//   • FACTURA FĂCUTĂ DIN COMANDĂ ARE SCADENȚA = data + termen, și o scadență
//     scrisă de mână nu se rescrie la validare. SmartBill o primește ca dueDate.
//   • LA FURNIZOR LA FEL, plus rândul din PDF și din email, în română și engleză.
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
  try { out = execFileSync("psql", ["-X", "--csv", "-c", s], { env: ENV, encoding: "utf8" }); }
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 500) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const exec = (s) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:5433/erp";
// SmartBill nu e configurat în test: validarea facturii nu trimite nimic.
for (const k of Object.keys(process.env)) if (/^SMARTBILL/.test(k)) delete process.env[k];
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail$/.test(req)) return { trimite: async () => ({ ok: true }), trimiteDeLa: async () => ({ ok: true }), configUtilizator: async () => null };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const TP = require(path.join(RAD, "lib", "termen-plata.js"));
const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["parteneri", "comenzi", "facturi", "comenzi-furnizor"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97411, nume: "Vali Test", rol: "admin", email: "v.tp@test.ro" };
const AGENT = { id: 97412, nume: "Gabriela Test", rol: "vanzari", email: "g.tp@test.ro" };

async function cer(cale, { user = ADMIN, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));

const CLIENT30 = 97401; // client cu 30 de zile
const CLIENT_FARA = 97402; // client fără termen
const FURNIZOR60 = 97403; // furnizor cu 60 de zile
const FURNIZOR_FARA = 97404;
const PRODUS = 97421;
const azi = new Date().toISOString().slice(0, 10);

function curata() {
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id IN (SELECT id FROM facturi WHERE partener_id BETWEEN 97401 AND 97409)",
    "UPDATE comenzi SET factura_id = NULL WHERE partener_id BETWEEN 97401 AND 97409",
    "DELETE FROM facturi WHERE partener_id BETWEEN 97401 AND 97409",
    "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97401 AND 97409)",
    "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97401 AND 97409)",
    "DELETE FROM emailuri WHERE partener_id BETWEEN 97401 AND 97409",
    "DELETE FROM comenzi WHERE partener_id BETWEEN 97401 AND 97409",
    "DELETE FROM comenzi_furnizor_linii WHERE comanda_id IN (SELECT id FROM comenzi_furnizor WHERE numar LIKE 'CF-2097-%' OR furnizor_id BETWEEN 97401 AND 97409)",
    "DELETE FROM comenzi_furnizor WHERE numar LIKE 'CF-2097-%' OR furnizor_id BETWEEN 97401 AND 97409",
    "DELETE FROM interactiuni WHERE partener_id BETWEEN 97401 AND 97409",
    "DELETE FROM parteneri WHERE id BETWEEN 97401 AND 97409 OR nume LIKE 'TP-TEST %'",
    "DELETE FROM produse WHERE id BETWEEN 97421 AND 97429",
    "DELETE FROM utilizatori WHERE id BETWEEN 97411 AND 97419",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

const comanda = (id) => q("SELECT * FROM comenzi WHERE id = ?", [id])[0];
const istoricComanda = (id) => q("SELECT ce, vechi, nou FROM comenzi_istoric WHERE comanda_id = ? ORDER BY id", [id]);
const comandaF = (id) => q("SELECT * FROM comenzi_furnizor WHERE id = ?", [id])[0];
const istoricF = (id) => q("SELECT ce, vechi, nou FROM comenzi_furnizor_istoric WHERE comanda_id = ? ORDER BY id", [id]);

const corpComanda = (partener, termen, extra) =>
  Object.assign(
    {
      partener_id: String(partener),
      numar: "",
      livrare_partiala: "nu", livrare_mod: "intern",
      branding: "nepersonalizat",
      moneda: "RON",
      termen_plata_zile: termen,
      "produs_id[]": [String(PRODUS)],
      "cantitate[]": ["5"],
      "pret_unitar[]": ["12"],
      "um[]": ["buc"],
    },
    extra || {}
  );
const idDinLocatie = (r) => Number((String(locatie(r)).match(/\/(\d+)(\?|$)/) || [])[1] || 0);

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97411,'Vali Test','v.tp@test.ro','x','y','admin')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97412,'Gabriela Test','g.tp@test.ro','x','y','vanzari')`,
    `INSERT INTO parteneri (id, nume, cui, tip, termen_plata_zile) VALUES
       (97401,'TP CLIENT 30 SRL','RO-TP-1','client',30),
       (97402,'TP CLIENT FARA SRL','RO-TP-2','client',NULL),
       (97403,'TP FURNIZOR 60 SRL','RO-TP-3','furnizor',60),
       (97404,'TP FURNIZOR FARA SRL','RO-TP-4','furnizor',NULL)`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, cota_tva) VALUES (97421,'TP-1','Folie stretch termen de plată','buc',10,21)",
  ]) exec(s);

  // ===== 1. citirea câmpului și textul ======================================
  console.log("\n── Citirea termenului și textul lui ─────────────────────────");
  egal("gol = nedefinit", TP.citeste("  "), { ok: true, zile: null });
  egal("30 cu spații", TP.citeste(" 30 ").zile, 30);
  egal("0 e un termen adevărat (plată la factură)", TP.citeste("0").zile, 0);
  egal("365 trece", TP.citeste("365").zile, 365);
  for (const rau_ of ["366", "30,5", "30.5", "-5", "30 zile", "1e2", "abc"]) egal(`„${rau_}" e refuzat`, TP.citeste(rau_).ok, false);
  egal("textul la 1", TP.zileText(1), "1 zi");
  egal("textul la 19", TP.zileText(19), "19 zile");
  egal("textul la 20", TP.zileText(20), "20 de zile");
  egal("textul la 101", TP.zileText(101), "101 zile");
  egal("textul la 120", TP.zileText(120), "120 de zile");
  egal("textul la 0", TP.zileText(0), "0 zile (plată la data facturii)");
  egal("în engleză", [TP.zileText(1, true), TP.zileText(60, true)], ["1 day", "60 days"]);
  egal("scadența peste lună", TP.scadenta("2026-11-17", 30), "2026-12-17");
  egal("scadența peste an, din data cu oră", TP.scadenta("2026-12-15 10:22:00", 30), "2027-01-14");
  egal("anul bisect", TP.scadenta("2028-02-28", 1), "2028-02-29");
  egal("peste schimbarea orei (25.10.2026)", TP.scadenta("2026-10-24", 2), "2026-10-26");
  egal("o dată care nu există nu dă scadență", TP.scadenta("2026-02-30", 5), "");
  egal("fără termen nu dă scadență", TP.scadenta("2026-11-17", null), "");

  // ===== 2. fișa partenerului ================================================
  console.log("\n── Fișa partenerului ────────────────────────────────────────");
  const formP = await cer("/parteneri/nou");
  are(formP.corp, 'name="termen_plata_zile"', "formularul de partener are câmpul");
  let r = await cer("/parteneri", { metoda: "post", body: { tip: "client", nume: "TP-TEST CLIENT NOU", cui: "RO97405", localitate: "Sector 2", adresa: "Str. Test 1", telefon: "0722000000", email: "a@firma.ro", persoana_contact: "Ana Test", termen_plata_zile: "45" } });
  egal("partenerul nou se scrie cu termenul", nr((q("SELECT termen_plata_zile FROM parteneri WHERE nume = 'TP-TEST CLIENT NOU'")[0] || {}).termen_plata_zile), 45);
  r = await cer("/parteneri", { metoda: "post", body: { tip: "client", nume: "TP-TEST CLIENT RAU", termen_plata_zile: "30,5" } });
  egal("„30,5” nu se salvează", q("SELECT id FROM parteneri WHERE nume = 'TP-TEST CLIENT RAU'").length, 0);
  egal("…și se spune de ce", [r.cod, r.corp.includes("număr întreg de zile")], [400, true]);
  // Vali, 18.11.2026: partenerul NOU se scrie întreg — cu termen de plată cu tot.
  r = await cer("/parteneri", { metoda: "post", body: { tip: "client", nume: "TP-TEST CLIENT GOL", cui: "RO97406", localitate: "Sector 2", adresa: "Str. Test 1", telefon: "0722000000", email: "a@firma.ro", persoana_contact: "Ana Test", termen_plata_zile: "" } });
  egal("partenerul nou fără termen de plată nu se salvează, iar formularul spune ce lipsește", [q("SELECT id FROM parteneri WHERE nume = 'TP-TEST CLIENT GOL'").length, r.cod, r.corp.includes("La un partener nou mai trebuie: Termen de plată (zile).")], [0, 400, true]);
  r = await cer("/parteneri", { metoda: "post", body: { tip: "client", nume: "TP-TEST CLIENT GOL", termen_plata_zile: "0" } });
  egal("…și nici fără restul: le spune pe toate o dată", [q("SELECT id FROM parteneri WHERE nume = 'TP-TEST CLIENT GOL'").length, r.corp.includes("La un partener nou mai trebuie: CUI / CIF, Localitatea, Adresa, Telefon, Email, Persoană de contact.")], [0, true]);
  r = await cer("/parteneri", { metoda: "post", body: { tip: "client", nume: "TP-TEST CLIENT GOL", cui: "RO97406", localitate: "Sector 2", adresa: "Str. Test 1", telefon: "0722000000", email: "a@firma.ro", persoana_contact: "Ana Test", termen_plata_zile: "0" } });
  const randGol = q("SELECT id, termen_plata_zile FROM parteneri WHERE nume = 'TP-TEST CLIENT GOL'");
  egal("cu toate scrise și termen 0 (plată la factură) se salvează", [randGol.length, nr(randGol[0] && randGol[0].termen_plata_zile)], [1, 0]);
  const idGol = Number(q("SELECT id FROM parteneri WHERE nume = 'TP-TEST CLIENT GOL'")[0].id);
  exec(`UPDATE parteneri SET termen_plata_zile = 20 WHERE id = ${idGol}`);
  r = await cer("/parteneri/:id/editare", { metoda: "post", params: { id: String(idGol) }, body: { tip: "client", nume: "TP-TEST CLIENT GOL", termen_plata_zile: "abc" } });
  egal("la editare, „abc” nu șterge tăcut termenul", [r.cod, nr(q("SELECT id, termen_plata_zile FROM parteneri WHERE id = ?", [idGol])[0].termen_plata_zile)], [400, 20]);
  r = await cer("/parteneri/:id/editare", { metoda: "post", params: { id: String(idGol) }, body: { tip: "client", nume: "TP-TEST CLIENT GOL", termen_plata_zile: "0" } });
  egal("la editare se poate pune 0", nr(q("SELECT termen_plata_zile FROM parteneri WHERE id = ?", [idGol])[0].termen_plata_zile), 0);
  const fisa = await cer("/parteneri/:id", { params: { id: String(CLIENT30) } });
  are(fisa.corp, "Termen de plată", "fișa arată termenul");
  are(fisa.corp, "30 de zile", "…în zile, cu „de”");
  const fisaFara = await cer("/parteneri/:id", { params: { id: String(CLIENT_FARA) } });
  are(fisaFara.corp, "nedefinit", "fișa fără termen spune că e nedefinit");

  // ===== 3. comanda de client ================================================
  console.log("\n── Comanda de client ────────────────────────────────────────");
  const formC = await cer("/comenzi/nou", { user: AGENT });
  are(formC.corp, 'name="termen_plata_zile"', "formularul de comandă are câmpul");
  are(formC.corp, '"97401":30', "termenul clientului ajunge în pagină, pentru completarea la alegere");
  fara(formC.corp, '"97402":', "clientul fără termen nu apare în hartă");
  // Completarea la alegere e în browser: căsuța de client anunță alegerea, iar
  // scriptul câmpului o ascultă. Aici se verifică doar că amândouă sunt în pagină.
  are(formC.corp, 'new CustomEvent("client-ales"', "căsuța de client anunță clientul ales");
  are(formC.corp, 'addEventListener("client-ales"', "…iar câmpul de termen îl ascultă");

  r = await cer("/comenzi", { metoda: "post", user: AGENT, body: corpComanda(CLIENT30, "") });
  const c1 = idDinLocatie(r);
  egal("câmp gol → termenul din fișa clientului, copiat pe comandă", nr(comanda(c1) && comanda(c1).termen_plata_zile), 30);
  r = await cer("/comenzi", { metoda: "post", user: AGENT, body: corpComanda(CLIENT30, "45") });
  const c2 = idDinLocatie(r);
  egal("termen scris punctual → acela", nr(comanda(c2).termen_plata_zile), 45);
  r = await cer("/comenzi", { metoda: "post", user: AGENT, body: corpComanda(CLIENT_FARA, "") });
  const c3 = idDinLocatie(r);
  egal("client fără termen și câmp gol → fără termen", comanda(c3).termen_plata_zile, null);
  const inainte = Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id BETWEEN 97401 AND 97409")[0].n);
  r = await cer("/comenzi", { metoda: "post", user: AGENT, body: corpComanda(CLIENT30, "30 zile") });
  egal("termen scris greșit → nu se salvează comanda", Number(q("SELECT COUNT(*) AS n FROM comenzi WHERE partener_id BETWEEN 97401 AND 97409")[0].n), inainte);
  are(r.corp, "număr întreg de zile", "…și se spune de ce");
  are(r.corp, 'value="30 zile"', "…cu ce scrisese omul întors în câmp");

  const pag1 = await cer("/comenzi/:id", { params: { id: String(c1) } });
  are(pag1.corp, "30 de zile", "pagina comenzii arată termenul");
  are(pag1.corp, "scadența = data facturii + termen", "…și ce face el pe factură");

  // Schimbarea de pe fișă nu mută comenzile deja plasate.
  exec(`UPDATE parteneri SET termen_plata_zile = 90 WHERE id = ${CLIENT30}`);
  egal("fișa trece pe 90 → comanda plasată rămâne cu 30", nr(comanda(c1).termen_plata_zile), 30);
  exec(`UPDATE parteneri SET termen_plata_zile = 30 WHERE id = ${CLIENT30}`);

  // --- modificarea --------------------------------------------------------
  const corpMod = (id, termen, extra) => Object.assign(corpComanda(CLIENT30, termen), { "pret_exact[]": ["12"], motiv: "test" }, extra || {});
  const formMod = await cer("/comenzi/:id/editare", { params: { id: String(c1) } });
  are(formMod.corp, 'name="termen_plata_zile" value="30"', "formularul de modificare are termenul comenzii");
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: corpMod(c1, "60") });
  egal("termenul schimbat pe comandă", nr(comanda(c1).termen_plata_zile), 60);
  egal("…intră în istoric, cu text", istoricComanda(c1).filter((x) => x.ce === "Termen de plată").map((x) => [x.vechi, x.nou]), [["30 de zile", "60 de zile"]]);
  await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: corpMod(c1, "") });
  egal("golit pe o comandă cu termen → înapoi la cel din fișă", nr(comanda(c1).termen_plata_zile), 30);
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c1) }, body: corpMod(c1, "-1") });
  egal("termen greșit la modificare → nu se schimbă nimic", nr(comanda(c1).termen_plata_zile), 30);
  are(r.corp, "număr întreg de zile", "…și se spune de ce");

  // O comandă veche, fără termen: salvarea ei fără să atingi termenul nu scrie
  // în istoric o schimbare pe care n-a făcut-o nimeni.
  exec(`UPDATE comenzi SET termen_plata_zile = NULL WHERE id = ${c2}`);
  exec(`DELETE FROM comenzi_istoric WHERE comanda_id = ${c2}`);
  r = await cer("/comenzi/:id/editare", { metoda: "post", params: { id: String(c2) }, body: corpMod(c2, "") });
  egal("comanda veche, salvată fără schimbări → „nimic de schimbat”", /ok=nimic/.test(locatie(r)), true);
  egal("…și rămâne fără termen copiat", comanda(c2).termen_plata_zile, null);
  egal("…fără rând fantomă în istoric", istoricComanda(c2).length, 0);
  const pagVeche = await cer("/comenzi/:id", { params: { id: String(c2) } });
  are(pagVeche.corp, "din fișa clientului, la facturare", "pagina comenzii vechi spune de unde vine termenul");

  // Comenzile făcute pe alte drumuri (ofertă, contract, calculator, emailul zilei).
  const ins = q(`INSERT INTO comenzi (partener_id, status) VALUES (${CLIENT30}, 'noua') RETURNING id`)[0];
  await TP.copiazaPeComanda(db, "comenzi", Number(ins.id));
  egal("comanda din alt drum primește termenul fișei", nr(comanda(Number(ins.id)).termen_plata_zile), 30);
  exec(`UPDATE comenzi SET termen_plata_zile = 7 WHERE id = ${ins.id}`);
  await TP.copiazaPeComanda(db, "comenzi", Number(ins.id));
  egal("…dar nu calcă un termen deja scris", nr(comanda(Number(ins.id)).termen_plata_zile), 7);
  await TP.copiazaPeComanda(db, "parteneri; DROP TABLE x", Number(ins.id));
  ok("un nume de tabel din afara listei e ignorat");

  // ===== 4. factura din comandă ==============================================
  console.log("\n── Factura făcută din comandă ───────────────────────────────");
  exec(`UPDATE comenzi SET status = 'in_stoc_depozit' WHERE id IN (${c1}, ${c3})`);
  r = await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c1) } });
  const f1 = q("SELECT * FROM facturi WHERE comanda_id = ?", [c1])[0];
  egal("ciorna din comanda cu 30 de zile are scadența = azi + 30", f1 && f1.data_scadenta, TP.scadenta(azi, 30));
  r = await cer("/comenzi/:id/factureaza", { metoda: "post", params: { id: String(c3) } });
  const f3 = q("SELECT * FROM facturi WHERE comanda_id = ?", [c3])[0];
  egal("comanda fără termen → ciorna fără scadență, ca până acum", f3 && f3.data_scadenta, null);

  // Ciorna fără scadență (făcută înainte de 17.11) o primește la validare.
  const fVeche = q(
    `INSERT INTO facturi (partener_id, comanda_id, directie, status, data_emiterii, serie)
     VALUES (${CLIENT30}, ${c2}, 'vanzare', 'ciorna', '2026-11-10', 'TPT') RETURNING id`
  )[0];
  exec(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${fVeche.id}, 'linie de test fără produs', 1, 100, 21)`);
  exec(`UPDATE comenzi SET termen_plata_zile = 15 WHERE id = ${c2}`);
  await cer("/facturi/:id/valideaza", { metoda: "post", params: { id: String(fVeche.id) } });
  const fv = q("SELECT status, data_scadenta FROM facturi WHERE id = ?", [fVeche.id])[0];
  egal("la validare, ciorna veche primește scadența = data ei + termenul comenzii", [fv.status, fv.data_scadenta], ["emisa", "2026-11-25"]);

  const fScrisa = q(
    `INSERT INTO facturi (partener_id, comanda_id, directie, status, data_emiterii, data_scadenta, serie)
     VALUES (${CLIENT30}, ${c2}, 'vanzare', 'ciorna', '2026-11-10', '2026-12-31', 'TPT') RETURNING id`
  )[0];
  exec(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${fScrisa.id}, 'linie de test fără produs', 1, 100, 21)`);
  await cer("/facturi/:id/valideaza", { metoda: "post", params: { id: String(fScrisa.id) } });
  egal("o scadență scrisă de mână nu se rescrie", q("SELECT data_scadenta FROM facturi WHERE id = ?", [fScrisa.id])[0].data_scadenta, "2026-12-31");

  // SmartBill primește scadența ca dueDate.
  const SB = require(path.join(RAD, "lib", "smartbill.js"));
  const payload = SB.construiesteFactura(
    { partener_nume: "TP CLIENT 30 SRL", data_emiterii: "2026-11-17", data_scadenta: TP.scadenta("2026-11-17", 30), moneda: "RON" },
    [{ denumire: "x", cantitate: 1, pret_unitar: 10, cota_tva: 21 }]
  );
  egal("SmartBill primește dueDate = data facturii + termen", [payload.issueDate, payload.dueDate], ["2026-11-17", "2026-12-17"]);

  // Facturile scrise de mână, cu scadența lăsată goală.
  await cer("/facturi", {
    metoda: "post",
    body: { partener_id: String(CLIENT30), data_scadenta: "", observatii: "TP manual", "denumire[]": ["serviciu"], "cantitate[]": ["1"], "pret_unitar[]": ["10"], "cota_tva[]": ["21"], "produs_id[]": [""] },
  });
  egal("factura de vânzare scrisă de mână: scadența = azi + termenul clientului",
    (q("SELECT data_scadenta FROM facturi WHERE partener_id = ? AND observatii = 'TP manual'", [CLIENT30])[0] || {}).data_scadenta, TP.scadenta(azi, 30));
  await cer("/facturi/achizitii", {
    metoda: "post",
    body: { partener_id: String(FURNIZOR60), serie: "TPF", numar: "7", data_emiterii: "2026-11-01", data_scadenta: "", observatii: "TP achizitie",
            "denumire[]": ["granulă"], "cantitate[]": ["1"], "pret_unitar[]": ["10"], "cota_tva[]": ["21"], "produs_id[]": [""] },
  });
  egal("factura de achiziție: scadența = data ei + termenul furnizorului",
    (q("SELECT data_scadenta FROM facturi WHERE partener_id = ? AND observatii = 'TP achizitie'", [FURNIZOR60])[0] || {}).data_scadenta, "2026-12-31");
  await cer("/facturi/achizitii", {
    metoda: "post",
    body: { partener_id: String(FURNIZOR60), serie: "TPF", numar: "8", data_emiterii: "2026-11-01", data_scadenta: "2026-11-20", observatii: "TP achizitie scrisa",
            "denumire[]": ["granulă"], "cantitate[]": ["1"], "pret_unitar[]": ["10"], "cota_tva[]": ["21"], "produs_id[]": [""] },
  });
  egal("…dar scadența scrisă de mână rămâne a ei",
    (q("SELECT data_scadenta FROM facturi WHERE partener_id = ? AND observatii = 'TP achizitie scrisa'", [FURNIZOR60])[0] || {}).data_scadenta, "2026-11-20");

  // ===== 5. comanda către furnizor ==========================================
  console.log("\n── Comanda către furnizor ───────────────────────────────────");
  const corpCF = (furnizor, termen, extra) =>
    Object.assign(
      { furnizor_id: String(furnizor), data: "2097-03-02", moneda: "RON", curs: "", curs_eur: "", termen_plata_zile: termen,
        "denumire[]": ["Granulă PP"], "produs_id[]": [""], "cantitate[]": ["1000"], "um[]": ["kg"], "pret_unitar[]": ["7,35"] },
      extra || {}
    );
  const formCF = await cer("/procurement/comenzi/noua", { query: { furnizor: String(FURNIZOR60) } });
  are(formCF.corp, 'name="termen_plata_zile" value="60"', "furnizorul ales din adresă vine cu termenul lui în câmp");
  are(formCF.corp, '"97403":60', "termenul furnizorilor e în pagină, pentru alegerea din listă");
  r = await cer("/procurement/comenzi", { metoda: "post", body: corpCF(FURNIZOR60, "") });
  const cf1 = idDinLocatie(r);
  egal("gol → termenul furnizorului, copiat pe comandă", nr(comandaF(cf1).termen_plata_zile), 60);
  are(istoricF(cf1).map((x) => x.nou).join(" "), "termen de plată 60 de zile", "crearea spune termenul în istoric");
  r = await cer("/procurement/comenzi", { metoda: "post", body: corpCF(FURNIZOR60, "10") });
  const cf2 = idDinLocatie(r);
  egal("scris punctual → acela", nr(comandaF(cf2).termen_plata_zile), 10);
  r = await cer("/procurement/comenzi", { metoda: "post", body: corpCF(FURNIZOR_FARA, "") });
  egal("furnizor fără termen, câmp gol → fără termen", comandaF(idDinLocatie(r)).termen_plata_zile, null);
  r = await cer("/procurement/comenzi", { metoda: "post", body: corpCF(FURNIZOR60, "zece") });
  egal("scris greșit → înapoi cu eroare=termen", /eroare=termen/.test(locatie(r)), true);
  const formEroare = await cer("/procurement/comenzi/noua", { query: { eroare: "termen" } });
  are(formEroare.corp, "număr întreg de zile", "mesajul pentru termenul greșit");

  const pagCF = await cer("/procurement/comenzi/:id", { params: { id: String(cf1) } });
  are(pagCF.corp, "Termen de plată", "pagina comenzii către furnizor arată termenul");
  are(pagCF.corp, "60 de zile", "…în zile");
  const pdf = await cer("/procurement/comenzi/:id/pdf", { params: { id: String(cf1) } });
  are(pdf.corp, "Termen de plată", "PDF-ul în română are termenul");
  const pdfEn = await cer("/procurement/comenzi/:id/pdf", { params: { id: String(cf1) }, query: { limba: "en" } });
  are(pdfEn.corp, "Payment terms", "PDF-ul în engleză are termenul");
  are(pdfEn.corp, "60 days", "…în engleză");
  const LG = require(path.join(RAD, "lib", "comenzi-furnizor-logica.js"));
  const email = LG.corpEmail({ comanda: Object.assign({}, comandaF(cf1)), linii: [{ denumire: "x", cantitate: 1, um: "kg", pret_unitar: 1 }], furnizor: {} });
  are(email, "Termen de plată: 60 de zile", "emailul către furnizor spune termenul");
  are(LG.corpEmail({ comanda: Object.assign({}, comandaF(cf1)), linii: [], furnizor: {}, limba: "en" }), "Payment terms: 60 days", "…și în engleză");

  // Modificarea.
  const corpModCF = (termen, extra) => Object.assign(corpCF(FURNIZOR60, termen), { "linie_id[]": [String(q("SELECT id FROM comenzi_furnizor_linii WHERE comanda_id = ?", [cf1])[0].id)] }, extra || {});
  const formModCF = await cer("/procurement/comenzi/:id/modifica", { params: { id: String(cf1) } });
  are(formModCF.corp, 'name="termen_plata_zile" value="60"', "formularul de modificare are termenul comenzii");
  await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(cf1) }, body: corpModCF("30") });
  egal("termenul schimbat pe comanda către furnizor", nr(comandaF(cf1).termen_plata_zile), 30);
  egal("…intră în istoric", istoricF(cf1).filter((x) => x.ce === "Termen de plată").map((x) => [x.vechi, x.nou]), [["60 de zile", "30 de zile"]]);
  r = await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(cf1) }, body: corpModCF("-3") });
  egal("termen greșit la modificare → formularul se întoarce, nimic schimbat", [r.cod, nr(comandaF(cf1).termen_plata_zile)], [400, 30]);
  // Comanda veche către furnizor, fără termen: salvată neatinsă, fără rând fantomă.
  exec(`UPDATE comenzi_furnizor SET termen_plata_zile = NULL WHERE id = ${cf2}`);
  exec(`DELETE FROM comenzi_furnizor_istoric WHERE comanda_id = ${cf2}`);
  const linieCf2 = String(q("SELECT id FROM comenzi_furnizor_linii WHERE comanda_id = ?", [cf2])[0].id);
  r = await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(cf2) }, body: Object.assign(corpCF(FURNIZOR60, ""), { "linie_id[]": [linieCf2] }) });
  egal("comanda veche către furnizor, neatinsă → „nimic de schimbat”", [/ok=nimic/.test(locatie(r)), comandaF(cf2).termen_plata_zile, istoricF(cf2).length], [true, null, 0]);
  // Alt furnizor, câmp gol → termenul noului furnizor.
  await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(cf2) }, body: Object.assign(corpCF(FURNIZOR_FARA, ""), { "linie_id[]": [linieCf2] }) });
  egal("furnizorul schimbat, câmp gol → termenul noului furnizor (aici niciunul)", comandaF(cf2).termen_plata_zile, null);
  await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(cf2) }, body: Object.assign(corpCF(FURNIZOR60, ""), { "linie_id[]": [linieCf2] }) });
  egal("înapoi la furnizorul cu 60, câmp gol → 60", nr(comandaF(cf2).termen_plata_zile), 60);

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
