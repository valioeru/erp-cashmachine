"use strict";
// Comanda către furnizor: moneda cu cursul pus de noi, lei și euro, PDF,
// modificarea ulterioară și istoricul ei — pe rute și pe PostgreSQL adevărat.
//
// Cererea lui Vali, 05.11.2026: „Comanda furnizor să poți adăuga moneda și
// schimb la curs pus de noi, să se calculeze și în RON automat și în EUR dacă
// moneda standard e RON, buton de export PDF și de modificare ulterioară.
// Dacă se modifică ceva rămâne în istoric cine a modificat ce și când."
//
// CE APĂRĂ:
//
//   • CURSUL PUS DE OM RĂMÂNE AL LUI. Gol → BNR-ul din ziua comenzii; scris →
//     exact ce a scris, și nu se mai mișcă.
//   • FIECARE SCHIMBARE INTRĂ ÎN ISTORIC, cu numele omului și ora României.
//     O salvare fără nimic schimbat nu scrie nimic — istoricul plin de zgomot
//     nu se mai citește.
//   • O POZIȚIE CU MARFĂ INTRATĂ NU SE ȘTERGE, iar starea se recalculează
//     când i se schimbă cantitatea.
//   • COMANDA ANULATĂ NU SE MODIFICĂ, iar cine n-are drept nu modifică.
//   • LINIA ALTEI COMENZI NU POATE FI ATINSĂ prin ID-ul ei pus în formular.
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
const orig = Module._load;
// Emailul nu pleacă nicăieri din test: lib/mail e înlocuit cu unul care
// doar ține minte ce i s-a cerut.
const trimise = [];
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)lib\/mail$/.test(req)) return { trimiteDeLa: async (user, m) => { trimise.push(m); return { ok: true }; } };
  return orig.apply(this, arguments);
};
const db = require(path.join(RAD, "lib", "db.js"));
db.prepare = (sql) => ({
  all: async (...p) => q(sql, p),
  get: async (...p) => q(sql, p)[0] || null,
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const modul = require(path.join(RAD, "modules", "comenzi-furnizor.js"));
const rute = { get: {}, post: {} };
modul.register({
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
const ADMIN = { id: 97311, nume: "Mirella", rol: "admin", email: "m.cfm@test.ro" };
const DEPOZIT = { id: 97312, nume: "Ion Depozit", rol: "depozit", email: "d.cfm@test.ro" };
const AGENT = { id: 97313, nume: "Gabriela", rol: "vanzari", email: "g.cfm@test.ro" };

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

const FURNIZOR = 97601;
const FURNIZOR2 = 97602;
const PRODUS = 97611;

function curata() {
  for (const s of [
    "DELETE FROM comenzi_furnizor_linii WHERE comanda_id IN (SELECT id FROM comenzi_furnizor WHERE numar LIKE 'CF-2098-%' OR furnizor_id BETWEEN 97601 AND 97609)",
    "DELETE FROM comenzi_furnizor WHERE numar LIKE 'CF-2098-%' OR furnizor_id BETWEEN 97601 AND 97609",
    "DELETE FROM interactiuni WHERE partener_id BETWEEN 97601 AND 97609",
    "DELETE FROM parteneri WHERE id BETWEEN 97601 AND 97609",
    "DELETE FROM produse WHERE id BETWEEN 97611 AND 97619",
    "DELETE FROM cursuri_bnr WHERE data LIKE '2098-%'",
    "DELETE FROM utilizatori WHERE id BETWEEN 97311 AND 97319",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const istoric = (id) => q("SELECT ce, vechi, nou, utilizator_nume, utilizator_id, la FROM comenzi_furnizor_istoric WHERE comanda_id = ? ORDER BY id", [id]);
const comanda = (id) => q("SELECT * FROM comenzi_furnizor WHERE id = ?", [id])[0];
const liniiDe = (id) => q("SELECT * FROM comenzi_furnizor_linii WHERE comanda_id = ? ORDER BY id", [id]);

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97311,'Mirella','m.cfm@test.ro','x','y','admin')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97312,'Ion Depozit','d.cfm@test.ro','x','y','depozit')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97313,'Gabriela','g.cfm@test.ro','x','y','vanzari')`,
    `INSERT INTO parteneri (id, nume, cui, tip, email, adresa) VALUES (${FURNIZOR}, 'CFMTEST WBV GMBH', 'DE97601', 'furnizor', 'order@cfm-wbv.de', 'Industriestr. 1, Greven')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${FURNIZOR2}, 'CFMTEST ALT FURNIZOR SRL', 'RO97602', 'furnizor')`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, activ) VALUES (${PRODUS}, 'CFM1', 'CFMTEST bandă acrilică 48x60', 'buc', 1)`,
    // BNR-ul zilelor de test, în viitorul îndepărtat ca să nu se amestece cu
    // cursurile adevărate: 01.03 și, pentru schimbarea datei, 01.06.
    `INSERT INTO cursuri_bnr (data, moneda, valoare) VALUES ('2098-03-01','EUR',5.0912), ('2098-03-01','USD',4.5), ('2098-03-01','GBP',5.9), ('2098-03-01','XAU',600), ('2098-06-01','EUR',5.2)`,
  ]) exec(s);

  // ------------------------------------------------- moneda și cursul
  console.log("\nComandă în euro, cursul lăsat gol → BNR-ul zilei ei:");
  const r1 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: {
      furnizor_id: String(FURNIZOR), data: "2098-03-04", moneda: "EUR", curs: "", curs_eur: "",
      observatii: "Bucharest, CTPark, Warehouse B2",
      "denumire[]": ["Packtape acrylic 48mm*60m", "CFM1 · CFMTEST bandă acrilică 48x60", ""],
      "produs_id[]": ["", String(PRODUS), ""],
      "cantitate[]": ["28", "5", ""],
      "um[]": ["PALLET", "PALLET", ""],
      "pret_unitar[]": ["", "812,50", ""],
    },
  });
  const id1 = Number(String(locatie(r1)).split("/").pop());
  if (!id1) { rau("comanda nu s-a creat", locatie(r1)); process.exit(1); }
  const c1 = comanda(id1);
  egal("numărul pe anul comenzii", c1.numar, "CF-2098-0001");
  egal("cursul EUR = BNR din ziua de dinainte (01.03)", Number(c1.curs), 5.0912);
  egal("la o comandă în euro, cursul euro e același", Number(c1.curs_eur), 5.0912);
  egal("prețul scris cu virgulă s-a citit", Number(liniiDe(id1)[1].pret_unitar), 812.5);
  const h1 = istoric(id1);
  egal("istoricul începe cu „Comandă creată”", h1.map((x) => x.ce), ["Comandă creată"]);
  egal("…scris pe numele omului", [h1[0].utilizator_nume, Number(h1[0].utilizator_id)], ["Mirella", ADMIN.id]);
  are(h1[0].nou, "2 poziții", "rândul de creare spune câte poziții");
  are(h1[0].nou, "curs 5,0912 lei/EUR", "…și cu ce curs");
  // Ora României, nu UTC.
  const oraRo = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).replace("T", " ").slice(0, 16);
  const oraScrisa = String(h1[0].la).slice(0, 16);
  const minute = Math.abs(Date.parse(oraScrisa.replace(" ", "T") + ":00Z") - Date.parse(oraRo.replace(" ", "T") + ":00Z")) / 60000;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(h1[0].la) && minute <= 2) ok("ora din istoric e ora României (" + h1[0].la + ")");
  else rau("ora din istoric nu e ora României", h1[0].la + " față de " + oraRo);

  console.log("\nComandă în lei cu cursul euro pus de noi:");
  const r2 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-04", moneda: "RON", curs: "9,99", curs_eur: "4,9",
      "denumire[]": ["Granulă PP"], "produs_id[]": [""], "cantitate[]": ["1000"], "um[]": ["kg"], "pret_unitar[]": ["7,35"],
    },
  });
  const id2 = Number(String(locatie(r2)).split("/").pop());
  const c2 = comanda(id2);
  egal("la RON nu există curs al comenzii (cel trimis se ignoră)", c2.curs, null);
  egal("cursul euro e exact cel scris, nu BNR-ul", Number(c2.curs_eur), 4.9);

  console.log("\nComandă în dolari: cursul dolarului scris, cel euro lăsat gol:");
  const r3 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-04", moneda: "USD", curs: "4.6", curs_eur: "",
      "denumire[]": ["Pigment"], "produs_id[]": [""], "cantitate[]": ["10"], "um[]": ["kg"], "pret_unitar[]": ["10"],
    },
  });
  const c3 = comanda(Number(String(locatie(r3)).split("/").pop()));
  egal("USD: cursul dolarului e cel scris", Number(c3.curs), 4.6);
  egal("USD: cursul euro vine de la BNR", Number(c3.curs_eur), 5.0912);

  console.log("\nCe nu e număr nu se salvează:");
  const r4 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: { furnizor_id: String(FURNIZOR), data: "2098-03-04", moneda: "EUR", curs_eur: "cinci", "denumire[]": ["x"], "produs_id[]": [""], "cantitate[]": ["1"], "um[]": [""], "pret_unitar[]": [""] },
  });
  egal("cursul scris greșit se întoarce cu eroare", /eroare=curs/.test(locatie(r4)), true);
  const r5 = await cer("/procurement/comenzi", {
    metoda: "post",
    body: { furnizor_id: String(FURNIZOR), data: "2098-03-04", moneda: "EUR", "denumire[]": ["x"], "produs_id[]": [""], "cantitate[]": ["1"], "um[]": [""], "pret_unitar[]": ["1.234,50"] },
  });
  egal("prețul „1.234,50” nu se ghicește", /eroare=pret/.test(locatie(r5)), true);
  egal("niciuna din cele două nu s-a salvat", Number(q("SELECT COUNT(*) AS n FROM comenzi_furnizor WHERE furnizor_id IN (?, ?)", [FURNIZOR, FURNIZOR2])[0].n), 3);
  const noua = await cer("/procurement/comenzi/noua", { query: { eroare: "pret" } });
  are(noua.corp, "fără puncte de mii", "mesajul pentru prețul greșit");
  are(noua.corp, '<option value="GBP"', "monedele BNR apar în listă");
  if (noua.corp.includes('<option value="XAU"')) rau("aurul (XAU) a apărut ca monedă de plată");
  else ok("aurul și DST-ul BNR nu sunt monede de comandă");
  are(noua.corp, "Curs EUR — lei pentru 1 EUR", "câmpul cursului euro");

  console.log("\nCursul BNR pentru formular:");
  const cj = await cer("/procurement/comenzi/curs.json", { query: { data: "2098-06-15" } });
  const j = JSON.parse(cj.corp);
  egal("ia ultima zi de dinainte", [j.cursuri.EUR.valoare, j.cursuri.EUR.data], [5.2, "2098-06-01"]);
  egal("dolarul rămâne pe ultima lui zi", j.cursuri.USD.valoare, 4.5);

  console.log("\nPagina comenzii arată lei și euro:");
  const p1 = await cer("/procurement/comenzi/:id", { params: { id: String(id1) } });
  egal("pagina răspunde 200", p1.cod, 200);
  are(p1.corp, "4.062,50 EUR", "valoarea în euro (5 × 812,50)");
  are(p1.corp, "20.683,00 lei", "în lei la cursul comenzii (4.062,50 × 5,0912)");
  are(p1.corp, "= BNR din 01.03.2098", "cursul e spus de unde vine");
  are(p1.corp, "Export PDF");
  are(p1.corp, "/procurement/comenzi/" + id1 + "/modifica", "butonul de modificare");
  are(p1.corp, "Istoric — cine a modificat ce și când");
  const p2 = await cer("/procurement/comenzi/:id", { params: { id: String(id2) } });
  are(p2.corp, "1.500,00 EUR", "comanda în lei arată și euro (7.350 / 4,9)");
  are(p2.corp, "BNR 01.03.2098: 5,0912 (-3,8%)", "cursul pus diferă de BNR și se spune cu cât");
  const lista = await cer("/procurement/comenzi", { query: { furnizor: String(FURNIZOR2) } });
  are(lista.corp, "Total în lei", "lista are totalul în lei");
  are(lista.corp, "7.810,00 lei", "lei: 7.350 + 460 (10 × 10 USD × 4,6)");
  are(lista.corp, "1.590,35 EUR", "euro: 1.500 + 90,35 (460 / 5,0912)");

  console.log("\nPDF:");
  const pdf = await cer("/procurement/comenzi/:id/pdf", { params: { id: String(id1) }, query: { limba: "ro" } });
  egal("PDF-ul răspunde 200", pdf.cod, 200);
  are(pdf.corp, "COMANDĂ DE ACHIZIȚIE");
  are(pdf.corp, "CF-2098-0001");
  are(pdf.corp, "CFMTEST WBV GMBH");
  are(pdf.corp, "Industriestr. 1, Greven", "adresa furnizorului");
  are(pdf.corp, "Mirella", "cine a întocmit-o");
  are(pdf.corp, "Echivalent în lei: 20.683,00 lei");
  are(pdf.corp, "Orar de descărcare:", "orarul de descărcare pe PDF");
  const pdfEn = await cer("/procurement/comenzi/:id/pdf", { params: { id: String(id1) }, query: { limba: "en", tipar: "1" } });
  are(pdfEn.corp, "PURCHASE ORDER");
  are(pdfEn.corp, "window.print()", "cu tipar=1 se deschide fereastra de tipar");
  const pdfImplicit = await cer("/procurement/comenzi/:id/pdf", { params: { id: String(id1) }, query: {} });
  are(pdfImplicit.corp, "PURCHASE ORDER", "furnizor cu CIF DE…: fără limbă cerută, PDF-ul e în engleză");
  const pdfRoImplicit = await cer("/procurement/comenzi/:id/pdf", { params: { id: String(id2) }, query: {} });
  are(pdfRoImplicit.corp, "COMANDĂ DE ACHIZIȚIE", "furnizor cu CIF RO…: PDF-ul e în română");
  are(p1.corp, "/pdf?limba=en&amp;tipar=1", "pe comanda furnizorului german, „Export PDF” e în engleză");
  are(p1.corp, "Export PDF (engleză)");
  are(p1.corp, "PDF în română", "varianta în română rămâne la un click");
  are(p2.corp, "/pdf?limba=ro&amp;tipar=1", "la furnizorul românesc, „Export PDF” e în română");
  are(p2.corp, "PDF în engleză");

  // ------------------------------------------------- modificarea
  console.log("\nCine poate modifica:");
  const fAgent = await cer("/procurement/comenzi/:id/modifica", { params: { id: String(id1) }, user: AGENT });
  egal("agentul care n-a scris comanda e trimis înapoi", [fAgent.cod, locatie(fAgent)], [302, "/procurement/comenzi/" + id1]);
  await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(id1) }, user: AGENT, body: { furnizor_id: String(FURNIZOR2), "denumire[]": ["y"], "cantitate[]": ["1"] } });
  egal("…și nu poate salva nimic", Number(comanda(id1).furnizor_id), FURNIZOR);
  const fAdmin = await cer("/procurement/comenzi/:id/modifica", { params: { id: String(id1) } });
  egal("administratorul deschide formularul", fAdmin.cod, 200);
  are(fAdmin.corp, 'value="5,0912"', "cursul comenzii e în câmp");
  are(fAdmin.corp, 'data-atins="1"', "cursul scris pe comandă nu e suprascris de BNR");
  are(fAdmin.corp, 'value="812,5"', "prețul cu virgulă");
  are(fAdmin.corp, "De ce modifici?");
  const lin1 = liniiDe(id1);

  // Comanda agentului: el a scris-o, el o poate modifica.
  const rA = await cer("/procurement/comenzi", {
    metoda: "post", user: AGENT,
    body: { furnizor_id: String(FURNIZOR2), data: "2098-03-05", moneda: "EUR", "denumire[]": ["Etichete"], "produs_id[]": [""], "cantitate[]": ["100"], "um[]": ["buc"], "pret_unitar[]": ["0,2"] },
  });
  const idA = Number(String(locatie(rA)).split("/").pop());
  egal("agentul își deschide propria comandă", (await cer("/procurement/comenzi/:id/modifica", { params: { id: String(idA) }, user: AGENT })).cod, 200);

  console.log("\nO modificare scrie în istoric fiecare schimbare:");
  const corpMod = (extra) =>
    Object.assign(
      {
        furnizor_id: String(FURNIZOR), data: "2098-03-04", data_solicitata: "", moneda: "EUR", curs: "", curs_eur: "5,0912",
        observatii: "Bucharest, CTPark, Warehouse B2",
        "linie_id[]": [String(lin1[0].id), String(lin1[1].id), ""],
        "denumire[]": ["Packtape acrylic 48mm*60m", "CFM1 · CFMTEST bandă acrilică 48x60", ""],
        "produs_id[]": ["", String(PRODUS), ""],
        "cantitate[]": ["28", "5", ""],
        "um[]": ["PALLET", "PALLET", ""],
        "pret_unitar[]": ["", "812,5", ""],
      },
      extra || {}
    );
  const nimic = await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(id1) }, body: corpMod() });
  egal("salvat fără nicio schimbare → „nimic”", locatie(nimic), "/procurement/comenzi/" + id1 + "?ok=nimic");
  egal("…și istoricul n-a primit niciun rând", istoric(id1).length, 1);

  const mod = await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(id1) }, user: DEPOZIT,
    body: corpMod({
      curs_eur: "5,10",
      data_solicitata: "2098-03-20",
      "denumire[]": ["Packtape acrylic 48mm*60m", "CFM1 · CFMTEST bandă acrilică 48x60", "Miez carton 76"],
      "produs_id[]": ["", String(PRODUS), ""],
      "cantitate[]": ["30", "5", "200"],
      "um[]": ["PALLET", "PALLET", "buc"],
      "pret_unitar[]": ["790", "812,5", ""],
      motiv: "furnizorul a confirmat prețul",
    }),
  });
  egal("salvarea duce înapoi cu numărul de schimbări", locatie(mod), "/procurement/comenzi/" + id1 + "?ok=modificat&n=5");
  const h2 = istoric(id1).slice(1);
  egal("ce s-a scris în istoric", h2.map((x) => x.ce), [
    "Data solicitată",
    "Curs",
    "Cantitate · Packtape acrylic 48mm*60m",
    "Preț unitar · Packtape acrylic 48mm*60m",
    "Poziție adăugată",
    "Motivul modificării",
  ]);
  egal("cursul vechi și cel nou, cu moneda lor", [h2[1].vechi, h2[1].nou], ["5,0912 lei/EUR", "5,1000 lei/EUR"]);
  egal("prețul pus unde era de confirmat", [h2[3].vechi, h2[3].nou], ["fără preț", "790,00 EUR"]);
  egal("toate pe numele celui care a modificat", [...new Set(h2.map((x) => x.utilizator_nume))], ["Ion Depozit"]);
  const c1b = comanda(id1);
  egal("cursul nou e pe comandă", [Number(c1b.curs), Number(c1b.curs_eur)], [5.1, 5.1]);
  egal("comanda știe cine a modificat-o", Number(c1b.modificata_de), DEPOZIT.id);
  egal("au rămas trei poziții, prima cu ID-ul ei de dinainte", liniiDe(id1).map((l) => Number(l.id)).slice(0, 2), lin1.map((l) => Number(l.id)));
  const pagMod = await cer("/procurement/comenzi/:id", { params: { id: String(id1) }, query: { ok: "modificat", n: "5" } });
  are(pagMod.corp, "Salvat. 5 schimbări scrise în istoricul comenzii.");
  are(pagMod.corp, "furnizorul a confirmat prețul", "motivul se vede în istoric");
  are(pagMod.corp, "Ion Depozit", "numele omului în istoric");

  console.log("\nȘtergerea unei poziții:");
  const lin2 = liniiDe(id1);
  const corpCu3 = (extra) =>
    corpMod(Object.assign({
      curs_eur: "5,1", data_solicitata: "2098-03-20",
      "linie_id[]": lin2.map((l) => String(l.id)),
      "denumire[]": lin2.map((l) => l.denumire),
      "produs_id[]": lin2.map((l) => (l.produs_id ? String(l.produs_id) : "")),
      "cantitate[]": lin2.map((l) => l.cantitate),
      "um[]": lin2.map((l) => l.um || ""),
      "pret_unitar[]": lin2.map((l) => (l.pret_unitar === null ? "" : l.pret_unitar)),
    }, extra || {}));
  await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(id1) }, body: corpCu3({ "sterge_id[]": [String(lin2[2].id)] }) });
  egal("poziția bifată „șterge” a dispărut", liniiDe(id1).length, 2);
  egal("…și e în istoric", istoric(id1).slice(-1)[0].ce, "Poziție ștearsă");

  console.log("\nPoziția cu marfă intrată nu se șterge:");
  await cer("/procurement/comenzi/:id/receptie", {
    metoda: "post", params: { id: String(id1) },
    body: { "linie_id[]": [String(lin2[0].id), String(lin2[1].id)], "primit[]": ["30", "5"], data_receptie: "2098-03-22" },
  });
  egal("recepția completă → primită", comanda(id1).status, "primita");
  const hRec = istoric(id1).slice(-4).map((x) => x.ce);
  egal("recepția e în istoric, linie cu linie, cu starea", hRec, ["Primit · Packtape acrylic 48mm*60m", "Primit · CFM1 · CFMTEST bandă acrilică 48x60", "Stare", "Data recepției"]);
  const lin3 = liniiDe(id1);
  const corpCu2 = (extra) =>
    corpMod(Object.assign({
      curs_eur: "5,1", data_solicitata: "2098-03-20",
      "linie_id[]": lin3.map((l) => String(l.id)),
      "denumire[]": lin3.map((l) => l.denumire),
      "produs_id[]": lin3.map((l) => (l.produs_id ? String(l.produs_id) : "")),
      "cantitate[]": lin3.map((l) => l.cantitate),
      "um[]": lin3.map((l) => l.um || ""),
      "pret_unitar[]": lin3.map((l) => (l.pret_unitar === null ? "" : l.pret_unitar)),
    }, extra || {}));
  const nuSterge = await cer("/procurement/comenzi/:id/modifica", { metoda: "post", params: { id: String(id1) }, body: corpCu2({ "sterge_id[]": [String(lin3[0].id)] }) });
  egal("se întoarce în formular cu eroare", nuSterge.cod, 400);
  are(nuSterge.corp, "are deja marfă intrată", "spune de ce");
  are(nuSterge.corp, 'name="linie_id[]" value="' + lin3[1].id + '"', "formularul întors păstrează pozițiile");
  are(nuSterge.corp, "are marfă", "pozițiile cu marfă n-au bifă de ștergere");
  egal("poziția a rămas", liniiDe(id1).length, 2);

  console.log("\nCantitatea mărită pe o comandă primită o face iar parțială:");
  const mai = await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(id1) },
    body: corpCu2({ "cantitate[]": ["30", "8"] }),
  });
  egal("salvat", /ok=modificat/.test(locatie(mai)), true);
  egal("starea s-a recalculat", comanda(id1).status, "partial");
  const ultimele = istoric(id1).slice(-2);
  egal("istoricul are și cantitatea, și starea", ultimele.map((x) => [x.ce, x.vechi, x.nou]), [
    ["Cantitate · CFM1 · CFMTEST bandă acrilică 48x60", "5", "8"],
    ["Stare", "Primită", "Primită parțial"],
  ]);

  console.log("\nLinia altei comenzi nu poate fi atinsă:");
  const linieStraina = liniiDe(id2)[0];
  await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(idA) }, user: AGENT,
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-05", moneda: "EUR", curs_eur: "",
      "linie_id[]": [String(liniiDe(idA)[0].id), String(linieStraina.id)],
      "denumire[]": ["Etichete", "Granulă furată"], "produs_id[]": ["", ""], "cantitate[]": ["100", "1"], "um[]": ["buc", "kg"], "pret_unitar[]": ["0,2", "0"],
    },
  });
  egal("linia celeilalte comenzi a rămas neatinsă", [liniiDe(id2)[0].denumire, Number(liniiDe(id2)[0].pret_unitar)], ["Granulă PP", 7.35]);
  egal("pe comanda agentului s-a adăugat o poziție nouă, nu s-a mutat una străină", liniiDe(idA).length, 2);

  console.log("\nComandă veche, fără curs scris: prima modificare nu inventează o schimbare de curs:");
  exec(`UPDATE comenzi_furnizor SET curs = NULL, curs_eur = NULL WHERE id = ${id2}`);
  const lv = liniiDe(id2);
  const veche = await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(id2) },
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-04", moneda: "RON", curs: "", curs_eur: "5,0912",
      "linie_id[]": [String(lv[0].id)], "denumire[]": ["Granulă PP"], "produs_id[]": [""], "cantitate[]": ["1200"], "um[]": ["kg"], "pret_unitar[]": ["7,35"],
    },
  });
  egal("salvat", /ok=modificat&n=1/.test(locatie(veche)), true);
  egal("singura schimbare e cantitatea", istoric(id2).slice(-1).map((x) => x.ce), ["Cantitate · Granulă PP"]);

  console.log("\nPrețul cu multe zecimale, neatins, nu se rotunjește și nu apare în istoric:");
  exec(`UPDATE comenzi_furnizor_linii SET pret_unitar = 7.123456 WHERE id = ${lv[0].id}`);
  const nIst = istoric(id2).length;
  await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(id2) },
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-04", moneda: "RON", curs_eur: "5,0912",
      // câmpul arată 4 zecimale (7,1235); omul schimbă doar cantitatea
      "linie_id[]": [String(lv[0].id)], "denumire[]": ["Granulă PP"], "produs_id[]": [""], "cantitate[]": ["1250"], "um[]": ["kg"], "pret_unitar[]": ["7,1235"],
    },
  });
  egal("prețul exact a rămas în bază", Number(liniiDe(id2)[0].pret_unitar), 7.123456);
  egal("în istoric doar cantitatea", istoric(id2).slice(nIst).map((x) => x.ce), ["Cantitate · Granulă PP"]);
  const fZec = await cer("/procurement/comenzi/:id/modifica", { params: { id: String(id2) } });
  are(fZec.corp, 'value="7,1235"', "în câmp prețul are patru zecimale, cu virgulă");

  console.log("\nTrimisă, apoi modificată: se spune că furnizorul are varianta veche:");
  exec(`UPDATE comenzi_furnizor SET trimisa_la = '2026-01-04 10:00:00', trimisa_catre = 'order@cfm-wbv.de', status = 'trimisa', modificata_la = '2026-01-03 09:00:00' WHERE id = ${id2}`);
  const pInainte = await cer("/procurement/comenzi/:id", { params: { id: String(id2) } });
  if (pInainte.corp.includes("modificată după ce a plecat")) rau("banda apare și fără nicio modificare după trimitere");
  else ok("modificată ÎNAINTE de trimitere: fără bandă");
  const fTrimisa = await cer("/procurement/comenzi/:id/modifica", { params: { id: String(id2) } });
  are(fTrimisa.corp, "a plecat deja la furnizor", "avertisment înainte de salvare");
  await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(id2) },
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-04", moneda: "RON", curs_eur: "5,0912",
      "linie_id[]": [String(lv[0].id)], "denumire[]": ["Granulă PP"], "produs_id[]": [""], "cantitate[]": ["1300"], "um[]": ["kg"], "pret_unitar[]": ["7,35"],
    },
  });
  const pTrimisa = await cer("/procurement/comenzi/:id", { params: { id: String(id2) } });
  are(pTrimisa.corp, "modificată după ce a plecat la furnizor", "banda de pe pagina comenzii");

  console.log("\nTrimiterea pe email intră în istoric:");
  const nT = istoric(idA).length;
  const tr = await cer("/procurement/comenzi/:id/trimite", {
    metoda: "post", params: { id: String(idA) },
    body: { "catre[]": ["order@cfm-wbv.de"], subiect: "Purchase order", corp: "Dear WBV", de_la: "comercial@cashmachine.ro" },
  });
  egal("trimisă, fără eroare", locatie(tr), "/procurement/comenzi/" + idA);
  egal("a plecat un singur email, către cine trebuia", trimise.map((m) => m.catre), [["order@cfm-wbv.de"]]);
  egal("istoricul: trimiterea și starea", istoric(idA).slice(nT).map((x) => [x.ce, x.nou]), [
    ["Trimisă pe email", "către order@cfm-wbv.de"],
    ["Stare", "Trimisă"],
  ]);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(comanda(idA).trimisa_la)) ok("ora trimiterii e scrisă întreagă: " + comanda(idA).trimisa_la);
  else rau("ora trimiterii arată ciudat", comanda(idA).trimisa_la);
  // Formularul de trimitere apare doar unde furnizorul are email: comanda 1.
  // Furnizorul ei are CIF german, deci mesajul pornește în engleză singur.
  const pEn = await cer("/procurement/comenzi/:id", { params: { id: String(id1) }, query: {} });
  are(pEn.corp, "furnizor din afară — pornește în engleză");
  are(pEn.corp, "Unloading hours: Monday to Friday, 09:00 – 17:30", "orarul în emailul în engleză");
  const pRo = await cer("/procurement/comenzi/:id", { params: { id: String(id1) }, query: { limba: "ro" } });
  are(pRo.corp, "Bună ziua, CFMTEST WBV GMBH", "cu limba=ro, mesajul e în română");
  are(pRo.corp, "Orar de descărcare: luni – vineri, 09:00 – 17:30", "orarul în emailul în română");
  are(pEn.corp, "Purchase order CF-2098-", "subiectul în engleză");
  are(pEn.corp, "Please find below our purchase order", "mesajul în engleză");

  console.log("\nAnularea intră în istoric, iar comanda anulată nu se mai modifică:");
  await cer("/procurement/comenzi/:id/anuleaza", { metoda: "post", params: { id: String(idA) } });
  egal("anularea e în istoric", istoric(idA).slice(-1).map((x) => [x.ce, x.nou]), [["Stare", "Anulată"]]);
  const fAnulata = await cer("/procurement/comenzi/:id/modifica", { params: { id: String(idA) } });
  egal("formularul unei comenzi anulate nu se deschide", fAnulata.cod, 302);
  const nAnulata = istoric(idA).length;
  const lA = liniiDe(idA);
  const postAnulata = await cer("/procurement/comenzi/:id/modifica", {
    metoda: "post", params: { id: String(idA) },
    body: {
      furnizor_id: String(FURNIZOR2), data: "2098-03-05", moneda: "EUR", curs_eur: "",
      "linie_id[]": lA.map((l) => String(l.id)), "denumire[]": lA.map((l) => l.denumire), "produs_id[]": lA.map(() => ""),
      "cantitate[]": lA.map(() => "999"), "um[]": lA.map((l) => l.um || ""), "pret_unitar[]": lA.map((l) => l.pret_unitar || ""),
    },
  });
  egal("nici trimisă direct, modificarea pe o comandă anulată nu trece", [postAnulata.cod, liniiDe(idA).map((l) => Number(l.cantitate)), istoric(idA).length],
    [302, lA.map((l) => Number(l.cantitate)), nAnulata]);
  const pAnulata = await cer("/procurement/comenzi/:id", { params: { id: String(idA) } });
  if (pAnulata.corp.includes("/procurement/comenzi/" + idA + "/modifica")) rau("comanda anulată are încă buton de modificare");
  else ok("comanda anulată nu mai are buton de modificare");

  console.log("\nComanda de dinainte de istoric își arată totuși crearea:");
  exec(`DELETE FROM comenzi_furnizor_istoric WHERE comanda_id = ${id2}`);
  const pFara = await cer("/procurement/comenzi/:id", { params: { id: String(id2) } });
  are(pFara.corp, "înainte de istoric", "rândul de creare, din ce știe comanda");

  // Scripturile din pagină au „isNaN” și „undefined” în cod, pe drept; se
  // caută doar în ce vede omul.
  let scapate = 0;
  for (const p of [p1, p2, pagMod, pTrimisa, fAdmin, pdf, pdfEn]) {
    const vizibil = String(p.corp).replace(/<script[\s\S]*?<\/script>/g, "");
    const m = vizibil.match(/[\s\S]{0,60}(\bundefined\b|\bNaN\b|\[object Object\])[\s\S]{0,60}/);
    if (m) { scapate++; rau("a scăpat un undefined/NaN într-o pagină", m[0].replace(/\s+/g, " ")); }
  }
  if (!scapate) ok("fără undefined/NaN în ce se vede pe pagini");

  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try { curata(); } catch (_) {}
  process.exit(1);
});
