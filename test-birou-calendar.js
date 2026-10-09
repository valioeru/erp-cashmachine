"use strict";
// Patru lucruri cerute deodată, toate pe agentul din spatele ecranului:
//
// 1. BIROUL. Adminul alege din listă al cui birou citește, iar TOT ce e în
//    pagină se schimbă cu el. Bugul păzit: „Clienți sugerați" arăta ce luase
//    ADMINUL, nu agentul la care se uita, iar butonul „Îl iau eu" scria
//    clientul în portofoliul adminului. Un client dat Isabelei ajungea la Vali.
//
// 2. CALENDARUL. O lună pe ecran, alegi ziua, pui pe ea ce ai de făcut.
//    Intrările sunt aceleași task-uri — nu o a doua listă de uitat.
//
// 3. LEAD-UL se poate modifica după ce a fost creat. Până acum se putea
//    schimba doar stadiul: un nume tastat greșit la telefon rămânea greșit.
//
// 4. OFERTA pleacă pe email cu textul ei în corp, iar starea se mută singură.
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

// Nimic nu pleacă nicăieri în test.
const mail = require(path.join(RAD, "lib", "mail.js"));
let plecat = null;
mail.trimite = async () => {};
mail.trimiteDeLa = async (u, m) => { plecat = m; };
mail.configUtilizator = () => ({ expeditor: "agent@cashmachine.ro", prinGmail: true });

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
require(path.join(RAD, "modules", "crm.js")).register(router);
require(path.join(RAD, "modules", "calendar.js")).register(router);
require(path.join(RAD, "modules", "oferte.js")).register(router);
require(path.join(RAD, "modules", "contacte.js")).register(router);
require(path.join(RAD, "modules", "email.js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 96501, nume: "Vali Oeru", rol: "admin", email: "vali@test.ro" };
const ISABELA = { id: 96502, nume: "Isabela Radu", rol: "vanzari", email: "isabela@test.ro" };

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
const unu = (sql, p) => { const r = q(sql, p); return r[0] ? Object.values(r[0])[0] : null; };

const LUNA = "2026-11";
const ZI = "2026-11-18";

// Curățenia merge în ordinea legăturilor, dinspre frunze spre rădăcină.
// Fișa de client pe care o naște preluarea unei sugestii se șterge și ea: nu
// e în intervalul de id-uri rezervat testului, fiindcă o face aplicația.
// „TEST CLIENT" fără cratimă prinde și fișele pe care le naște singură
// aplicația: deschiderea biroului rulează genereazaSugestii(), care face
// lead-uri pentru clienții nelucrați — inclusiv pentru clientul de test.
const PART_TEST = "(id BETWEEN 96601 AND 96699 OR nume LIKE 'TEST-CAL %' OR nume LIKE 'TEST CLIENT %')";
const LEAD_TEST = `(nume LIKE 'TEST-CAL %' OR nume LIKE 'TEST CLIENT %' OR companie LIKE 'TEST%' OR partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST}))`;
async function curat() {
  for (const s of [
    `DELETE FROM emailuri WHERE partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST})
       OR oferta_id IN (SELECT id FROM oferte WHERE partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST}))
       OR utilizator_id BETWEEN 96501 AND 96599`,
    `DELETE FROM interactiuni WHERE partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST})
       OR lead_id IN (SELECT id FROM leaduri WHERE ${LEAD_TEST})
       OR utilizator_id BETWEEN 96501 AND 96599`,
    `DELETE FROM taskuri_participanti WHERE utilizator_id BETWEEN 96501 AND 96599
       OR task_id IN (SELECT id FROM taskuri WHERE atribuit_lui BETWEEN 96501 AND 96599 OR creat_de BETWEEN 96501 AND 96599)`,
    `DELETE FROM taskuri WHERE atribuit_lui BETWEEN 96501 AND 96599 OR creat_de BETWEEN 96501 AND 96599
       OR lead_id IN (SELECT id FROM leaduri WHERE ${LEAD_TEST})
       OR partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST})`,
    `DELETE FROM oferte_linii WHERE oferta_id IN (SELECT id FROM oferte WHERE partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST}))`,
    `DELETE FROM oferte WHERE partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST})`,
    `DELETE FROM alocari_clienti WHERE partener_id IN (SELECT id FROM parteneri WHERE ${PART_TEST}) OR utilizator_id BETWEEN 96501 AND 96599`,
    `DELETE FROM leaduri WHERE ${LEAD_TEST}`,
    `DELETE FROM parteneri WHERE ${PART_TEST}`,
    "DELETE FROM utilizatori WHERE id BETWEEN 96501 AND 96599",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  await curat();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol, activ, comision_procent) VALUES
       (96501,'Vali Oeru','vali@test.ro','x','y','admin',1,2),
       (96502,'Isabela Radu','isabela@test.ro','x','y','vanzari',1,2)`,
    `INSERT INTO parteneri (id, nume, cui, tip, email, persoana_contact) VALUES
       (96601,'TEST CLIENT CALENDAR SRL','RO-CAL-1','client','client@test.ro','Dl. Popescu')`,
    // O sugestie nelucrată: adminul trebuie s-o poată da Isabelei, nu lui.
    `INSERT INTO leaduri (nume, companie, sursa, stadiu, motiv_sugestie, observatii)
       VALUES ('TEST-CAL Sugestie SRL','TEST-CAL Sugestie SRL','sugestie','nou','n-a mai cumpărat de 120 de zile','de sunat')`,
    // Un lead al Isabelei, scris greșit, pe care trebuie să-l poată corecta.
    `INSERT INTO leaduri (nume, companie, email, telefon, sursa, stadiu, atribuit_lui)
       VALUES ('TEST-CAL Nume Gresit','Firma SRL','gresit@test.ro','070','telefon','nou',96502)`,
  ]) exec(s);
  const idSugestie = Number(unu("SELECT id FROM leaduri WHERE nume = 'TEST-CAL Sugestie SRL'"));
  const idLead = Number(unu("SELECT id FROM leaduri WHERE nume = 'TEST-CAL Nume Gresit'"));

  // =====================================================================
  console.log("\n— Biroul: adminul alege agentul, datele îl urmează —");
  // =====================================================================
  let r = await cer("/crm/birou", { query: { agent: String(ISABELA.id) } });
  // Lista trebuie să stea ÎNAINTEA datelor, nu după ele. Se măsoară față de
  // blocurile de conținut, nu față de meniu: meniul conține „Comisionul meu"
  // și ar fi dat mereu un fals pozitiv.
  const unde = r.corp.indexOf("Biroul lui:");
  const dupaMeniu = r.corp.indexOf("</nav>") + 1 || 0;
  const primulBloc = Math.min(
    ...['class="cards"', "Clienți în portofoliu", "Clienți de contactat", "Clienți sugerați"]
      .map((x) => r.corp.indexOf(x))
      .filter((x) => x > dupaMeniu)
  );
  if (unde < 0) rau("lista de agenți lipsește din biroul adminului");
  else if (unde > primulBloc) rau("lista de agenți stă DUPĂ date", `listă la ${unde}, primul bloc la ${primulBloc}`);
  else ok("lista de agenți stă înaintea datelor");

  if (!r.corp.includes("te uiți în biroul lui Isabela Radu")) rau("nu scrie în pagină al cui birou e");
  else ok("scrie limpede al cui birou e");
  if (!r.corp.includes("Vali Oeru — biroul meu")) rau("adminul nu se poate întoarce la biroul lui din listă");
  else ok("adminul e în listă, cu biroul lui");
  if (!r.corp.includes("I-l dau lui Isabela")) rau("butonul de sugestii scrie tot «Îl iau eu» în biroul altuia");
  else ok("sugestia se dă agentului, nu adminului");
  if (!/name="pentru" value="96502"/.test(r.corp)) rau("formularul de sugestie nu spune cui se dă clientul");
  else ok("formularul poartă cu el agentul");
  if (!/name="inapoi" value="[^"]*agent=96502/.test(r.corp)) rau("după salvare adminul ar pica înapoi în biroul lui");
  else ok("formularele se întorc în biroul agentului");

  // Biroul propriu NU trebuie să spună „al lui X" și nici să ceară «pentru».
  r = await cer("/crm/birou");
  if (r.corp.includes("te uiți în biroul lui")) rau("biroul propriu se crede al altcuiva");
  else ok("biroul propriu rămâne al tău");
  if (/name="pentru"/.test(r.corp)) rau("în biroul propriu sugestia încă poartă un destinatar");
  else ok("în biroul propriu sugestia e «Îl iau eu»");

  // Agentul nu vede lista deloc.
  r = await cer("/crm/birou", { user: ISABELA, query: { agent: String(ADMIN.id) } });
  if (r.corp.includes("Biroul lui:")) rau("agentul vede lista de agenți");
  else ok("agentul nu vede lista de agenți");
  if (r.corp.includes("Vali Oeru")) rau("agentul a ajuns în biroul adminului cu ?agent=");
  else ok("?agent= e ignorat pentru agent");

  // --- clientul dat din biroul altuia intră la EL ------------------------
  await cer("/crm/sugestii/:id/preia", {
    metoda: "post", params: { id: String(idSugestie) },
    body: { pentru: String(ISABELA.id), persoana_contact: "Dl. Ionescu", mod_contact: "telefon", inapoi: "/crm/birou?agent=96502" },
  });
  egal("sugestia a intrat la Isabela, nu la admin",
    Number(unu("SELECT atribuit_lui FROM leaduri WHERE id = ?", [idSugestie])), ISABELA.id);
  egal("și clientul e alocat tot ei",
    Number(unu("SELECT utilizator_id FROM alocari_clienti WHERE partener_id = (SELECT partener_id FROM leaduri WHERE id = ?) ORDER BY id DESC LIMIT 1", [idSugestie])),
    ISABELA.id);
  egal("task-ul de contactat e al ei",
    Number(unu("SELECT atribuit_lui FROM taskuri WHERE lead_id = ? ORDER BY id DESC LIMIT 1", [idSugestie])), ISABELA.id);
  const nota = String(unu("SELECT descriere FROM interactiuni WHERE lead_id IS NULL AND subiect = 'Client preluat din sugestii' ORDER BY id DESC LIMIT 1") || "");
  if (!/Dat lui Isabela Radu de Vali Oeru/.test(nota)) rau("nota nu spune cine cui a dat clientul", nota);
  else ok("nota scrie cine cui a dat clientul");

  // --- un agent NU poate da un client altui agent -------------------------
  exec("UPDATE leaduri SET atribuit_lui = NULL, stadiu = 'nou' WHERE id = " + idSugestie);
  exec("DELETE FROM alocari_clienti WHERE utilizator_id BETWEEN 96501 AND 96599");
  await cer("/crm/sugestii/:id/preia", {
    metoda: "post", user: ISABELA, params: { id: String(idSugestie) },
    body: { pentru: String(ADMIN.id), mod_contact: "telefon" },
  });
  egal("un agent nu poate scrie în portofoliul altuia",
    Number(unu("SELECT atribuit_lui FROM leaduri WHERE id = ?", [idSugestie])), ISABELA.id);

  // =====================================================================
  console.log("\n— Lead-ul se poate modifica după ce a fost creat —");
  // =====================================================================
  r = await cer("/crm/leaduri/:id", { user: ISABELA, params: { id: String(idLead) } });
  if (!r.corp.includes("Modifică lead-ul")) rau("agentul nu are unde să-și modifice lead-ul");
  else ok("agentul are formular de modificare pe lead-ul lui");
  if (!/name="nume"[^>]*value="TEST-CAL Nume Gresit"/.test(r.corp)) rau("numele nu vine precompletat în formular");
  else ok("câmpurile vin precompletate cu ce e în bază");
  if (!/name="atribuit_lui" disabled/.test(r.corp)) rau("agentul își poate muta singur lead-ul la altcineva");
  else ok("agentul nu poate schimba agentul responsabil");

  await cer("/crm/leaduri/:id/actualizeaza", {
    metoda: "post", user: ISABELA, params: { id: String(idLead) },
    body: { nume: "TEST-CAL Nume Corect", companie: "Firma Corectă SRL", email: "corect@test.ro",
            telefon: "0722 111 222", sursa: "recomandare", stadiu: "calificat",
            atribuit_lui: String(ADMIN.id), observatii: "vrea folie 23 mic" },
  });
  egal("numele s-a corectat", unu("SELECT nume FROM leaduri WHERE id = ?", [idLead]), "TEST-CAL Nume Corect");
  egal("emailul s-a corectat", unu("SELECT email FROM leaduri WHERE id = ?", [idLead]), "corect@test.ro");
  egal("telefonul s-a corectat", unu("SELECT telefon FROM leaduri WHERE id = ?", [idLead]), "0722 111 222");
  egal("stadiul s-a mutat", unu("SELECT stadiu FROM leaduri WHERE id = ?", [idLead]), "calificat");
  egal("observațiile s-au scris", unu("SELECT observatii FROM leaduri WHERE id = ?", [idLead]), "vrea folie 23 mic");
  egal("dar lead-ul a RĂMAS al Isabelei",
    Number(unu("SELECT atribuit_lui FROM leaduri WHERE id = ?", [idLead])), ISABELA.id);

  // Un formular cu numele gol nu golește numele din bază.
  await cer("/crm/leaduri/:id/actualizeaza", {
    metoda: "post", user: ISABELA, params: { id: String(idLead) }, body: { nume: "  ", stadiu: "calificat" },
  });
  egal("numele gol nu șterge numele vechi", unu("SELECT nume FROM leaduri WHERE id = ?", [idLead]), "TEST-CAL Nume Corect");

  // Adminul poate muta lead-ul.
  await cer("/crm/leaduri/:id/actualizeaza", {
    metoda: "post", params: { id: String(idLead) },
    body: { nume: "TEST-CAL Nume Corect", stadiu: "calificat", atribuit_lui: String(ADMIN.id) },
  });
  egal("adminul poate muta lead-ul", Number(unu("SELECT atribuit_lui FROM leaduri WHERE id = ?", [idLead])), ADMIN.id);

  // Un agent străin nu umblă în lead-ul altuia.
  r = await cer("/crm/leaduri/:id", { user: ISABELA, params: { id: String(idLead) } });
  if (r.corp.includes("Modifică lead-ul")) rau("agentul vede formular pe lead-ul altuia");
  else ok("lead-ul altuia e doar de citit");
  await cer("/crm/leaduri/:id/actualizeaza", {
    metoda: "post", user: ISABELA, params: { id: String(idLead) }, body: { nume: "FURAT", stadiu: "nou" },
  });
  egal("și nici pe ascuns nu i-l poate schimba", unu("SELECT nume FROM leaduri WHERE id = ?", [idLead]), "TEST-CAL Nume Corect");

  // =====================================================================
  console.log("\n— Calendarul: alegi ziua, pui pe ea ce ai de făcut —");
  // =====================================================================
  r = await cer("/crm/calendar", { user: ISABELA, query: { luna: LUNA } });
  if (!r.corp.includes("noiembrie 2026")) rau("calendarul nu arată luna cerută");
  else ok("calendarul arată luna cerută");
  if (!/<table class="calendar">/.test(r.corp)) rau("nu există grila lunii");
  else ok("grila lunii e pe ecran");
  // 1 noiembrie 2026 e duminică: prima săptămână are șase celule goale.
  egal("zilele lunii sunt toate în grilă", (r.corp.match(/class="cal-nr"/g) || []).length, 30);
  if (r.corp.includes("Calendarul lui:")) rau("agentul vede lista de agenți în calendar");
  else ok("agentul nu vede lista de agenți");

  r = await cer("/crm/calendar", { query: { luna: LUNA, zi: ZI } });
  if (!r.corp.includes("Miercuri, 18 noiembrie 2026")) rau("ziua aleasă nu se deschide", "18.11.2026 e miercuri");
  else ok("ziua aleasă se deschide cu numele ei");
  if (!r.corp.includes("Pune în calendar")) rau("nu există formular de adăugare pe zi");
  else ok("ziua are formular de adăugare");

  // --- o intrare simplă ---------------------------------------------------
  r = await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: ZI, luna: LUNA, titlu: "Întâlnire la Delivery", tip: "intalnire", ora: "10:30",
            durata_minute: "90", locatie: "la ei", partener_id: "96601", descriere: "prețuri 2027" },
  });
  const t1 = q("SELECT * FROM taskuri WHERE atribuit_lui = 96502 AND titlu = 'Întâlnire la Delivery'");
  egal("intrarea s-a scris o singură dată", t1.length, 1);
  if (t1.length) {
    egal("pe ziua aleasă", String(t1[0].scadenta).slice(0, 10), ZI);
    egal("cu ora", t1[0].ora, "10:30");
    egal("cu durata", Number(t1[0].durata_minute), 90);
    egal("cu locul", t1[0].locatie, "la ei");
    egal("legată de client", Number(t1[0].partener_id), 96601);
    egal("și e un task deschis, ca oricare altul", t1[0].status, "deschis");
  }
  if (!/#zi$/.test(locatie(r))) rau("nu se întoarce la ziua deschisă", locatie(r));
  else ok("se întoarce la ziua deschisă — " + locatie(r));

  // Și se vede în grilă, cu ora pe ea.
  r = await cer("/crm/calendar", { user: ISABELA, query: { luna: LUNA } });
  if (!r.corp.includes("<strong>10:30</strong> Întâlnire la Delivery")) rau("intrarea nu apare în grilă cu ora");
  else ok("intrarea apare în grilă, cu ora pe ea");

  // --- un târg de trei zile ------------------------------------------------
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: "2026-11-25", luna: LUNA, titlu: "Târg RotaPack", tip: "intalnire",
            pana_la: "2026-11-27", locatie: "Budapesta" },
  });
  egal("târgul de trei zile are un rând pe fiecare zi",
    q("SELECT scadenta FROM taskuri WHERE atribuit_lui = 96502 AND titlu LIKE 'Târg RotaPack%' ORDER BY scadenta").map((x) => String(x.scadenta).slice(0, 10)),
    ["2026-11-25", "2026-11-26", "2026-11-27"]);
  egal("și fiecare zi spune a câta e",
    q("SELECT titlu FROM taskuri WHERE atribuit_lui = 96502 AND titlu LIKE 'Târg RotaPack%' ORDER BY scadenta").map((x) => x.titlu),
    ["Târg RotaPack (1/3)", "Târg RotaPack (2/3)", "Târg RotaPack (3/3)"]);

  // O dată tastată greșit nu umple baza.
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: "2026-11-02", luna: LUNA, titlu: "An tastat greșit", pana_la: "2036-11-02" },
  });
  egal("o dată greșită se oprește la 60 de zile",
    Number(unu("SELECT COUNT(*) FROM taskuri WHERE atribuit_lui = 96502 AND titlu LIKE 'An tastat greșit%'")), 60);

  // --- nici adminul nu scrie DIRECT în calendarul altuia --------------------
  //
  // Regula s-a schimbat la cererea lui Vali: „indiferent că e admin". Înainte,
  // adminul care se uita în calendarul Isabelei scria acolo pe loc, fără s-o
  // întrebe nimeni. Acum o invită, ca oricine altcineva, iar ea confirmă.
  await cer("/crm/calendar", {
    metoda: "post",
    body: { zi: ZI, luna: LUNA, titlu: "Vizită propusă de admin", tip: "apel", agent: String(ISABELA.id),
            participanti: [String(ISABELA.id)] },
  });
  egal("intrarea rămâne a adminului, el a scris-o",
    Number(unu("SELECT atribuit_lui FROM taskuri WHERE titlu = 'Vizită propusă de admin'")), ADMIN.id);
  egal("iar agentul o primește ca invitație, nu ca fapt împlinit",
    unu("SELECT stare FROM taskuri_participanti WHERE task_id = (SELECT id FROM taskuri WHERE titlu = 'Vizită propusă de admin')"),
    "neconfirmat");

  // --- „agent=" din formular nu mai mută proprietatea intrării ---------------
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: ZI, luna: LUNA, titlu: "Încercare în calendarul altuia", agent: String(ADMIN.id) },
  });
  egal("agentul nu scrie în calendarul altuia",
    Number(unu("SELECT atribuit_lui FROM taskuri WHERE titlu = 'Încercare în calendarul altuia'")), ISABELA.id);

  // --- intrarea fără titlu nu se scrie --------------------------------------
  const inainte = Number(unu("SELECT COUNT(*) FROM taskuri WHERE atribuit_lui = 96502"));
  await cer("/crm/calendar", { metoda: "post", user: ISABELA, body: { zi: ZI, luna: LUNA, titlu: "   " } });
  egal("o intrare fără titlu nu se scrie", Number(unu("SELECT COUNT(*) FROM taskuri WHERE atribuit_lui = 96502")), inainte);

  // =====================================================================
  console.log("\n— Invitații: pui ceva la altcineva, el confirmă —");
  // =====================================================================
  //
  // Cererea lui Vali, cuvânt cu cuvânt: „un agent sa adauge in calendarul
  // altuia sau mai multor persoane o activitate, indiferent ca e admin; apare
  // neconfirmata la acel user, iar dupa confirmare apare confirmata la toti".
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: ZI, luna: LUNA, titlu: "Ședință de preț", tip: "intalnire", ora: "09:00",
            participanti: [String(ADMIN.id)] },
  });
  const sed = q("SELECT id, atribuit_lui FROM taskuri WHERE titlu = 'Ședință de preț'");
  egal("intrarea rămâne a celui care a scris-o", sed.length && Number(sed[0].atribuit_lui), ISABELA.id);
  egal("celălalt primește o invitație neconfirmată",
    q("SELECT u.id, p.stare FROM taskuri_participanti p JOIN utilizatori u ON u.id = p.utilizator_id WHERE p.task_id = ?", [sed[0].id])
      .map((x) => x.id + ":" + x.stare),
    [ADMIN.id + ":neconfirmat"]);
  egal("și cine l-a invitat se vede",
    Number(unu("SELECT invitat_de FROM taskuri_participanti WHERE task_id = ?", [sed[0].id])), ISABELA.id);

  // Apare în calendarul adminului, marcată „neconfirmată", cu buton de răspuns.
  r = await cer("/crm/calendar", { query: { luna: LUNA, zi: ZI } });
  if (!r.corp.includes("Ședință de preț")) rau("invitația nu apare în calendarul celui invitat");
  else ok("invitația apare în calendarul celui invitat");
  if (!r.corp.includes("neconfirmată")) rau("nu scrie nicăieri că e neconfirmată");
  else ok("scrie limpede că e neconfirmată");
  if (!r.corp.includes("Isabela Radu te-a pus în calendar")) rau("nu spune cine l-a invitat");
  else ok("spune cine l-a invitat");
  if (!r.corp.includes(`/crm/calendar/${sed[0].id}/raspund`)) rau("lipsesc butoanele de confirmare");
  else ok("are butoane de confirmare");

  // --- nimeni nu confirmă în locul altuia ------------------------------------
  await cer("/crm/calendar/:id/raspund", {
    metoda: "post", user: ISABELA, params: { id: String(sed[0].id) },
    body: { raspuns: "confirmat", inapoi: "/crm/calendar" },
  });
  egal("organizatorul nu poate confirma în locul invitatului",
    unu("SELECT stare FROM taskuri_participanti WHERE task_id = ?", [sed[0].id]), "neconfirmat");

  // --- confirmarea ------------------------------------------------------------
  r = await cer("/crm/calendar/:id/raspund", {
    metoda: "post", params: { id: String(sed[0].id) },
    body: { raspuns: "confirmat", inapoi: "/crm/calendar?luna=" + LUNA + "&zi=" + ZI },
  });
  egal("după confirmare, starea e confirmat",
    unu("SELECT stare FROM taskuri_participanti WHERE task_id = ?", [sed[0].id]), "confirmat");
  if (!/^\/crm\/calendar\?luna=/.test(locatie(r))) rau("nu se întoarce în ziua din care a răspuns", locatie(r));
  else ok("se întoarce în ziua din care a răspuns");

  // Acum o vede confirmată și organizatorul, și cel invitat.
  r = await cer("/crm/calendar", { user: ISABELA, query: { luna: LUNA, zi: ZI } });
  if (!/Vali Oeru ✓/.test(r.corp)) rau("organizatorul nu vede că celălalt a confirmat");
  else ok("organizatorul vede confirmarea");
  r = await cer("/crm/calendar", { query: { luna: LUNA, zi: ZI } });
  if (r.corp.includes("te-a pus în calendar")) rau("invitatul e întrebat din nou după ce a confirmat");
  else ok("invitatul nu mai e întrebat după ce a confirmat");

  // --- refuzul o scoate din calendarul lui, dar nu din al organizatorului ----
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: "2026-11-19", luna: LUNA, titlu: "Vizită pe care n-o pot face", participanti: [String(ADMIN.id)] },
  });
  const viz = Number(unu("SELECT id FROM taskuri WHERE titlu = 'Vizită pe care n-o pot face'"));
  await cer("/crm/calendar/:id/raspund", {
    metoda: "post", params: { id: String(viz) }, body: { raspuns: "refuzat", inapoi: "/crm/calendar" },
  });
  r = await cer("/crm/calendar", { query: { luna: LUNA } });
  if (r.corp.includes("Vizită pe care n-o pot face")) rau("ce am refuzat îmi stă în continuare în calendar");
  else ok("ce am refuzat dispare din calendarul meu");
  r = await cer("/crm/calendar", { user: ISABELA, query: { luna: LUNA, zi: "2026-11-19" } });
  if (!r.corp.includes("Vizită pe care n-o pot face")) rau("refuzul a șters intrarea și de la organizator");
  else ok("organizatorul își păstrează intrarea");
  if (!/Vali Oeru ✗/.test(r.corp)) rau("organizatorul nu vede că celălalt a refuzat");
  else ok("organizatorul vede refuzul");

  // --- un târg de trei zile se confirmă o singură dată ------------------------
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: "2026-11-04", luna: LUNA, titlu: "Târg cu colegul", pana_la: "2026-11-06",
            participanti: [String(ADMIN.id)] },
  });
  const grup = q("SELECT id FROM taskuri WHERE titlu LIKE 'Târg cu colegul%' ORDER BY scadenta");
  egal("târgul are trei zile", grup.length, 3);
  egal("și o invitație pe fiecare zi",
    Number(unu(`SELECT COUNT(*) FROM taskuri_participanti WHERE task_id IN (${grup.map((x) => x.id).join(",")})`)), 3);
  await cer("/crm/calendar/:id/raspund", {
    metoda: "post", params: { id: String(grup[0].id) }, body: { raspuns: "confirmat", inapoi: "/crm/calendar" },
  });
  egal("o singură confirmare acoperă tot târgul",
    q(`SELECT stare FROM taskuri_participanti WHERE task_id IN (${grup.map((x) => x.id).join(",")})`).map((x) => x.stare),
    ["confirmat", "confirmat", "confirmat"]);

  // --- invitație către mai mulți deodată --------------------------------------
  exec(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol, activ) VALUES
          (96503,'Catalin Georgescu','catalin@test.ro','x','y','vanzari',1) ON CONFLICT (id) DO NOTHING`);
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: "2026-11-10", luna: LUNA, titlu: "Ședința de luni", participanti: [String(ADMIN.id), "96503"] },
  });
  const sedinta = Number(unu("SELECT id FROM taskuri WHERE titlu = 'Ședința de luni'"));
  egal("toți cei bifați primesc invitație",
    q("SELECT utilizator_id FROM taskuri_participanti WHERE task_id = ? ORDER BY utilizator_id", [sedinta]).map((x) => Number(x.utilizator_id)),
    [96501, 96503]);

  // --- nu te poți invita pe tine, și nici un utilizator inexistent -------------
  await cer("/crm/calendar", {
    metoda: "post", user: ISABELA,
    body: { zi: "2026-11-11", luna: LUNA, titlu: "Singur cu mine", participanti: [String(ISABELA.id), "999999"] },
  });
  egal("nu te inviți pe tine și nici pe cineva inexistent",
    Number(unu("SELECT COUNT(*) FROM taskuri_participanti WHERE task_id = (SELECT id FROM taskuri WHERE titlu = 'Singur cu mine')")), 0);

  // --- modificarea și ștergerea unei intrări ---------------------------------
  r = await cer("/crm/calendar", { user: ISABELA, query: { luna: LUNA, zi: ZI } });
  if (!r.corp.includes("Modifică sau șterge")) rau("nu poți modifica o intrare de-a ta din calendar");
  else ok("intrările tale se pot modifica din calendar");

  await cer("/crm/calendar/:id/modifica", {
    metoda: "post", user: ISABELA, params: { id: String(sed[0].id) },
    body: { titlu: "Ședință de preț — mutată", tip: "intalnire", scadenta: "2026-11-20", ora: "15:30",
            durata_minute: "45", locatie: "online", descriere: "am mutat-o", inapoi: "/crm/calendar?luna=" + LUNA },
  });
  egal("titlul s-a schimbat", unu("SELECT titlu FROM taskuri WHERE id = ?", [sed[0].id]), "Ședință de preț — mutată");
  egal("ziua s-a mutat", String(unu("SELECT scadenta FROM taskuri WHERE id = ?", [sed[0].id])).slice(0, 10), "2026-11-20");
  egal("ora s-a mutat", unu("SELECT ora FROM taskuri WHERE id = ?", [sed[0].id]), "15:30");
  egal("iar confirmarea s-a cerut din nou — omul confirmase alt ceas",
    unu("SELECT stare FROM taskuri_participanti WHERE task_id = ?", [sed[0].id]), "neconfirmat");

  // Cel invitat NU poate umbla la intrarea altuia.
  await cer("/crm/calendar/:id/modifica", {
    metoda: "post", user: { id: 96503, nume: "Catalin Georgescu", rol: "vanzari" },
    params: { id: String(sed[0].id) }, body: { titlu: "FURAT", inapoi: "/crm/calendar" },
  });
  egal("un coleg nu poate modifica intrarea altuia",
    unu("SELECT titlu FROM taskuri WHERE id = ?", [sed[0].id]), "Ședință de preț — mutată");

  // Ștergerea unei singure zile dintr-un târg.
  const inainteGrup = q("SELECT id FROM taskuri WHERE titlu LIKE 'Târg cu colegul%'").length;
  await cer("/crm/calendar/:id/sterge", {
    metoda: "post", user: ISABELA, params: { id: String(grup[1].id) }, body: { inapoi: "/crm/calendar" },
  });
  egal("se poate scoate o singură zi dintr-un târg",
    q("SELECT id FROM taskuri WHERE titlu LIKE 'Târg cu colegul%'").length, inainteGrup - 1);
  egal("și i-au plecat și invitațiile",
    Number(unu("SELECT COUNT(*) FROM taskuri_participanti WHERE task_id = ?", [grup[1].id])), 0);

  // Ștergerea întregului grup.
  await cer("/crm/calendar/:id/sterge", {
    metoda: "post", user: ISABELA, params: { id: String(grup[0].id) },
    body: { tot_grupul: "1", inapoi: "/crm/calendar" },
  });
  egal("se poate șterge tot târgul dintr-o dată",
    q("SELECT id FROM taskuri WHERE titlu LIKE 'Târg cu colegul%'").length, 0);

  // Un coleg nu poate șterge intrarea altuia.
  await cer("/crm/calendar/:id/sterge", {
    metoda: "post", user: { id: 96503, nume: "Catalin Georgescu", rol: "vanzari" },
    params: { id: String(sed[0].id) }, body: { inapoi: "/crm/calendar" },
  });
  egal("un coleg nu poate șterge intrarea altuia",
    Number(unu("SELECT COUNT(*) FROM taskuri WHERE id = ?", [sed[0].id])), 1);

  // --- lista de agenți din Birou: oricine are clienți alocați -------------------
  exec(`INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol, activ) VALUES
          (96504,'Florentin Udrea','florentin@test.ro','x','y','operational',1) ON CONFLICT (id) DO NOTHING`);
  exec("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, valabil_de_la) VALUES (96601, 96504, 100, '2026-01-01')");
  r = await cer("/crm/birou");
  if (!r.corp.includes("Florentin Udrea")) rau("un om cu clienți alocați dar alt rol nu apare în listă");
  else ok("oricine are clienți alocați apare în listă, indiferent de rol");

  // =====================================================================
  console.log("\n— Oferta pleacă pe email, cu textul ei în corp —");
  // =====================================================================
  exec(`INSERT INTO oferte (id, numar, partener_id, agent_id, status, versiune, valabil_pana)
          VALUES (96701,'OF-TEST-1',96601,96502,'ciorna',1,'2026-12-31')`);
  exec(`INSERT INTO oferte_linii (oferta_id, denumire, um, cantitate, pret_unitar, cota_tva) VALUES
          (96701,'Folie stretch 23 mic','rola',100,12.5,21),
          (96701,'Bandă adezivă 48mm','buc',250,3.2,21)`);

  r = await cer("/oferte/:id", { user: ISABELA, params: { id: "96701" } });
  if (!r.corp.includes("/crm/email/nou?oferta_id=96701&sablon=oferta")) rau("nu există butonul de trimitere pe email");
  else ok("fișa ofertei are butonul de trimitere pe email");

  r = await cer("/crm/email/nou", { user: ISABELA, query: { oferta_id: "96701", sablon: "oferta" } });
  for (const bucata of ["Dl. Popescu", "OF-TEST-1", "Folie stretch 23 mic", "Bandă adezivă 48mm",
                        "1.250,00 lei", "800,00 lei", "2.050,00 lei", "2.480,50 lei", "31.12.2026"]) {
    if (!r.corp.includes(bucata)) rau("lipsește din corpul emailului", bucata);
  }
  ok("oferta e scrisă în corp: persoana, liniile, valorile, totalul cu TVA, valabilitatea");
  if (!r.corp.includes('value="client@test.ro"')) rau("destinatarul nu vine completat din fișa clientului");
  else ok("destinatarul vine din fișa clientului");
  if (!/name="oferta_id" value="96701"/.test(r.corp)) rau("formularul nu duce oferta mai departe");
  else ok("formularul duce oferta mai departe");
  if (/<table|<td|<tr/i.test(r.corp.split("<textarea")[1].split("</textarea>")[0])) rau("corpul emailului conține HTML — pe text simplu ajunge cod la client");
  else ok("corpul e text curat, fără HTML");

  r = await cer("/crm/email", {
    metoda: "post", user: ISABELA,
    body: { catre: "client@test.ro", subiect: "Ofertă OF-TEST-1 — Cash Machine",
            corp: "Bună ziua, Dl. Popescu,\n\nOferta...", partener_id: "96601",
            oferta_id: "96701", inregistreaza: "1" },
  });
  egal("oferta a trecut singură pe «trimisă»", unu("SELECT status FROM oferte WHERE id = 96701"), "trimisa");
  egal("emailul e legat de ofertă", Number(unu("SELECT oferta_id FROM emailuri WHERE oferta_id = 96701 ORDER BY id DESC LIMIT 1")), 96701);
  egal("și a intrat în istoricul clientului",
    Number(unu("SELECT COUNT(*) FROM interactiuni WHERE partener_id = 96601 AND tip = 'email'")), 1);
  egal("se întoarce la ofertă, nu la fișa mesajului", locatie(r), "/oferte/96701");
  if (!plecat || !/client@test\.ro/.test(String(plecat.catre))) rau("mesajul n-a plecat către client");
  else ok("mesajul a plecat către client");

  r = await cer("/oferte/:id", { user: ISABELA, params: { id: "96701" } });
  if (!r.corp.includes("Trimisă pe email (1)")) rau("fișa ofertei nu arată ce a plecat");
  else ok("fișa ofertei arată ce a plecat, când și către cine");

  // O ofertă deja acceptată nu se întoarce la „trimisă" dacă mai pleacă o copie.
  exec("UPDATE oferte SET status = 'acceptata' WHERE id = 96701");
  await cer("/crm/email", {
    metoda: "post", user: ISABELA,
    body: { catre: "client@test.ro", subiect: "copie", corp: "copie", partener_id: "96601", oferta_id: "96701" },
  });
  egal("o ofertă acceptată nu se întoarce la «trimisă»", unu("SELECT status FROM oferte WHERE id = 96701"), "acceptata");

  // --- curățenie după noi --------------------------------------------------
  await curat();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch(async (e) => { console.error("A crăpat:", e.message); try { await curat(); } catch (x) {} process.exit(1); });
