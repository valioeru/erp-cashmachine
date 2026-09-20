"use strict";
// Test pentru modulul Marketing — contacte, istoric, aniversări.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n→ " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}

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

// Emailul nu pleacă nicăieri în test: înlocuim trimiterea, dar păstrăm restul
// (configUtilizator, care decide dacă expeditorul e configurat).
const mail = require(path.join(RAD, "lib", "mail.js"));
let trimiseReal = [];
mail.trimite = async (config, mesaj) => { trimiseReal.push({ config, mesaj }); };

const auth = require(path.join(RAD, "lib", "auth.js"));
const mod = require(path.join(RAD, "modules", "marketing.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const GABI = { id: 3, nume: "Gabriela", rol: "vanzari" };

async function cer(cale, { user = VALI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
function cere(eticheta, corp, bucati, interzise) {
  const fara = corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/NaN|Infinity|undefined<|>undefined/.test(fara)) return rau(eticheta, "NaN/undefined în pagină");
  const lipsa = bucati.filter((b) => !fara.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => fara.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta + " (" + corp.length + " octeți)");
}

const azi = new Date().toISOString().slice(0, 10);
const ziLunaAzi = azi.slice(5);

(async () => {
  for (const s of [
    "TRUNCATE mk_aniversari, mk_contacte_istoric, mk_contacte RESTART IDENTITY CASCADE",
    "DELETE FROM leaduri WHERE email LIKE '%@test-mk.ro'",
    // Facturile de test se sterg primele: altfel cheia straina nu lasa
    // partenerul sa plece si fixtura nu se mai poate reface.
    "DELETE FROM facturi WHERE id = 95101",
    "DELETE FROM parteneri WHERE cui IN ('RO-MK-A','RO-MK-P')",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (3,'Gabriela','gabi@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    // Firma activă (are o factură) și una potențială (n-are nimic)
    "INSERT INTO parteneri (id, nume, cui, tip, persoana_contact, email) VALUES (95001,'CLIENT ACTIV SRL','RO-MK-A','client','Ion Popescu','ion@test-mk.ro'), (95002,'DOAR POTENTIAL SRL','RO-MK-P','client','Maria Ionescu','maria@test-mk.ro') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, status, activ, intercompany) VALUES (95101,'MK',1,95001,'vanzare','2026-05-05','emisa',1,0) ON CONFLICT (id) DO NOTHING",
    "INSERT INTO leaduri (nume, companie, email, sursa) VALUES ('Andrei Lead','LEAD SRL','andrei@test-mk.ro','test')",
  ]) execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("rute GET :", Object.keys(rute.get).join(", "));
  console.log("rute POST:", Object.keys(rute.post).join(", "));
  console.log("");

  // --- pagina goală --------------------------------------------------------
  let r = await cer("/marketing/contacte");
  cere("pagina de contacte, goală", r.corp, ["Contacte", "Niciun contact", "Contact nou"], []);

  // --- adunarea din ERP ----------------------------------------------------
  await cer("/marketing/contacte/aduna", { metoda: "post" });
  const adunate = q("SELECT nume, sursa FROM mk_contacte ORDER BY id").map((x) => x.nume + "/" + x.sursa);
  if (adunate.length < 3) rau("n-a adunat contactele din ERP", adunate.join(", "));
  else ok("adună contactele din parteneri și leaduri (" + adunate.length + ")");
  await cer("/marketing/contacte/aduna", { metoda: "post" });
  const dupaADoua = Number(q("SELECT COUNT(*) AS n FROM mk_contacte")[0].n);
  if (dupaADoua !== adunate.length) rau("a doua adunare a dublat contactele", dupaADoua);
  else ok("a doua adunare nu adaugă nimic de două ori");

  // --- un neadministrator nu poate aduna -----------------------------------
  const inainte = Number(q("SELECT COUNT(*) AS n FROM mk_contacte")[0].n);
  await cer("/marketing/contacte/aduna", { user: GABI, metoda: "post" });
  if (Number(q("SELECT COUNT(*) AS n FROM mk_contacte")[0].n) !== inainte) rau("un neadministrator a pornit adunarea");
  else ok("adunarea din ERP e doar a administratorului");

  // --- activ vs potențial se deduce ---------------------------------------
  r = await cer("/marketing/contacte");
  cere("gruparea pe firme, cu activ și potențial", r.corp,
    ["CLIENT ACTIV SRL", "DOAR POTENTIAL SRL", "activ", "potențial", "Ion Popescu", "Maria Ionescu"], []);
  // Atenție: numele firmelor apar și în lista derulantă a formularului de
  // contact nou, deci filtrul se verifică pe oameni, nu pe textul paginii.
  r = await cer("/marketing/contacte", { query: { stare: "activ" } });
  if (r.corp.includes("Maria Ionescu")) rau("filtrul «doar activi» lasă potențialii");
  else if (!r.corp.includes("Ion Popescu")) rau("filtrul «doar activi» a ascuns tot");
  else ok("filtrul activ/potențial merge — starea se deduce din facturi și oferte");

  // --- oricine poate adăuga un contact ------------------------------------
  r = await cer("/marketing/contacte", {
    user: GABI, metoda: "post",
    body: { nume: "Elena Aniversata", partener_id: "95001", functie: "achiziții", email: "elena@test-mk.ro",
            telefon: "0722", data_nastere: azi.slice(0, 4) + "-" + ziLunaAzi, observatii: "adăugată de agent" },
  });
  const idElena = Number((locatie(r).match(/contact\/(\d+)/) || [])[1]);
  if (!idElena) rau("agentul n-a putut adăuga un contact", locatie(r));
  else ok("orice utilizator logat poate adăuga un contact — #" + idElena);
  const elena = q("SELECT nastere_confirmata, sursa FROM mk_contacte WHERE id = ?", [idElena])[0];
  if (Number(elena.nastere_confirmata) !== 1) rau("data scrisă de om n-a fost marcată confirmată");
  else ok("o dată de naștere scrisă de un om e confirmată din start");

  // --- modificarea scrie în istoric ---------------------------------------
  await cer("/marketing/contact/:id", {
    user: GABI, metoda: "post", params: { id: idElena },
    body: { nume: "Elena Aniversata", partener_id: "95001", functie: "director achiziții",
            email: "elena.noua@test-mk.ro", telefon: "0722", data_nastere: azi.slice(0, 4) + "-" + ziLunaAzi },
  });
  const ist = q("SELECT camp, valoare_veche, valoare_noua FROM mk_contacte_istoric WHERE contact_id = ? ORDER BY id", [idElena]);
  const campuri = ist.map((x) => x.camp).sort().join(",");
  if (!campuri.includes("email") || !campuri.includes("functie")) rau("istoricul n-a prins modificările", campuri);
  else ok("fiecare modificare intră în istoric, cu valoarea veche și cea nouă");
  const acum = q("SELECT email FROM mk_contacte WHERE id = ?", [idElena])[0].email;
  if (acum !== "elena.noua@test-mk.ro") rau("nu se folosește adresa cea mai nouă", acum);
  else ok("adresa curentă e cea mai nouă, cea veche rămâne doar în istoric");
  r = await cer("/marketing/contact/:id", { params: { id: idElena } });
  cere("pagina contactului, cu istoricul", r.corp, ["Ce s-a schimbat", "elena@test-mk.ro", "elena.noua@test-mk.ro", "director achiziții"], []);

  // --- ștergerea e doar a administratorului, și nu pierde urma -------------
  await cer("/marketing/contact/:id/sterge", { user: GABI, metoda: "post", params: { id: idElena } });
  if (Number(q("SELECT activ FROM mk_contacte WHERE id = ?", [idElena])[0].activ) !== 1) rau("un agent a șters un contact");
  else ok("ștergerea e refuzată dacă n-o cere administratorul");

  // --- aniversările de azi -------------------------------------------------
  const azNascuti = await mod.aniversariAzi();
  if (!azNascuti.some((c) => Number(c.id) === idElena)) rau("Elena nu apare la aniversările de azi", JSON.stringify(azNascuti.map((x) => x.nume)));
  else ok("cine e născut azi apare la aniversări");
  // și una scrisă fără an, „--LL-ZZ"
  q("UPDATE mk_contacte SET data_nastere = ?, nastere_confirmata = 1 WHERE nume = 'Ion Popescu'", ["--" + ziLunaAzi]);
  const cuFaraAn = await mod.aniversariAzi();
  if (!cuFaraAn.some((c) => c.nume === "Ion Popescu")) rau("data fără an nu e recunoscută");
  else ok("merge și o zi de naștere scrisă fără an");

  r = await cer("/marketing/aniversari");
  cere("pagina de aniversări", r.corp, ["Aniversări azi", "Elena", "La mulți ani", "Trimit de pe"], []);

  // --- trimiterea de mână --------------------------------------------------
  q("UPDATE utilizatori SET smtp_host = 'smtp.test', email_expeditor = 'vali@test.ro', smtp_port = 587 WHERE id = 1");
  trimiseReal = [];
  await cer("/marketing/aniversari/trimite", {
    metoda: "post",
    body: { contact_id: String(idElena), expeditor_id: "1", subiect: "La mulți ani, Elena!", mesaj: "Text de test" },
  });
  const trimis = q("SELECT stare, email, automat FROM mk_aniversari WHERE contact_id = ?", [idElena])[0];
  if (!trimis) rau("trimiterea nu s-a înregistrat");
  else if (trimis.stare !== "trimis") rau("trimiterea a eșuat", JSON.stringify(trimis));
  else if (trimis.email !== "elena.noua@test-mk.ro") rau("s-a trimis pe adresa veche", trimis.email);
  else ok("felicitarea pleacă pe adresa cea mai nouă și rămâne în listă");

  // --- automatul de la 13 --------------------------------------------------
  // Ion are data confirmată, deci intră. Elena a primit deja azi, deci nu.
  const inaintea = Number(q("SELECT COUNT(*) AS n FROM mk_aniversari")[0].n);
  const rez = await mod.verificaAniversariAutomat(13);
  const dupa = q("SELECT c.nume, a.automat FROM mk_aniversari a JOIN mk_contacte c ON c.id = a.contact_id ORDER BY a.id");
  if (!rez.rulat) rau("automatul n-a rulat", rez.motiv);
  else if (dupa.filter((x) => x.nume === "Elena Aniversata").length !== 1) rau("automatul a trimis a doua oară Elenei");
  else if (!dupa.some((x) => x.nume === "Ion Popescu" && Number(x.automat) === 1)) rau("automatul nu i-a trimis lui Ion", JSON.stringify(dupa));
  else ok("la 13:00 pleacă automat doar către cine n-a primit încă");

  // Înainte de 13 nu face nimic.
  const inainteDe13 = await mod.verificaAniversariAutomat(9);
  if (inainteDe13.rulat) rau("automatul a plecat înainte de ora 13");
  else ok("înainte de ora 13 nu pleacă nimic");

  // O dată neconfirmată nu intră în automat.
  q("INSERT INTO mk_contacte (nume, email, data_nastere, nastere_confirmata, sursa, activ) VALUES ('Neconfirmat Ionel','ionel@test-mk.ro', ?, 0, 'parteneri', 1)", ["--" + ziLunaAzi]);
  await mod.verificaAniversariAutomat(14);
  const ionel = q("SELECT COUNT(*) AS n FROM mk_aniversari a JOIN mk_contacte c ON c.id = a.contact_id WHERE c.nume = 'Neconfirmat Ionel'")[0].n;
  if (Number(ionel) !== 0) rau("automatul a trimis pe o dată neconfirmată");
  else ok("pe o dată culeasă din import, automatul nu trimite până n-o confirmă un om");

  // ...dar după confirmare, da.
  const idIonel = Number(q("SELECT id FROM mk_contacte WHERE nume = 'Neconfirmat Ionel'")[0].id);
  await cer("/marketing/contact/:id/confirma-nastere", { metoda: "post", params: { id: idIonel } });
  await mod.verificaAniversariAutomat(14);
  if (Number(q("SELECT COUNT(*) AS n FROM mk_aniversari WHERE contact_id = ?", [idIonel])[0].n) !== 1)
    rau("după confirmare tot nu trimite");
  else ok("după ce omul confirmă data, automatul trimite");

  // --- filtrele ------------------------------------------------------------
  r = await cer("/marketing/contacte", { query: { q: "Popescu" } });
  if (!r.corp.includes("Ion Popescu")) rau("căutarea după nume nu găsește");
  else ok("căutarea după nume merge");
  r = await cer("/marketing/contacte", { query: { email: "fara" } });
  if (r.corp.includes("elena.noua@test-mk.ro")) rau("filtrul «fără email» arată contacte cu email");
  else ok("filtrul pe email merge");
  r = await cer("/marketing/contacte", { query: { luna: ziLunaAzi.slice(0, 2) } });
  if (!r.corp.includes("Ion Popescu")) rau("filtrul pe luna nașterii nu găsește");
  else ok("filtrul pe luna de naștere merge");
  r = await cer("/marketing/contacte", { query: { sursa: "leaduri" } });
  if (r.corp.includes("Ion Popescu")) rau("filtrul pe sursă nu filtrează");
  else ok("filtrul pe sursă merge");
  r = await cer("/marketing/contacte", { query: { vedere: "lista", sort: "ziua" } });
  cere("vederea listă, ordonată după ziua de naștere", r.corp, ["Ion Popescu"], []);

  // --- lista de emailuri ---------------------------------------------------
  r = await cer("/marketing/emailuri");
  cere("lista de emailuri trimise", r.corp, ["Emailuri trimise", "Elena", "automat"], []);

  // --- accesul e al tuturor ------------------------------------------------
  if (!auth.poateAccesa(GABI, "/marketing/contacte") || !auth.poateAccesa({ rol: "depozit" }, "/marketing/aniversari")) {
    rau("Marketing nu e vizibil pentru toată lumea");
  } else ok("oricine logat ajunge în Marketing");

  // --- meniul regrupat -----------------------------------------------------
  const render = require(path.join(RAD, "lib", "render.js"));
  const pag = render.layout({ user: VALI, title: "t", active: "/", body: "<p>x</p>" });
  if (!pag.includes(">Management<")) rau("meniul Management nu apare");
  else if (!pag.includes(">Marketing<")) rau("meniul Marketing nu apare");
  else if (/class="navlink[^"]*">Rapoarte</.test(pag)) rau("Rapoarte a rămas intrare separată în bara de sus");
  else ok("bara de sus are Management și Marketing, iar Rapoarte a intrat sub Management");
  if (!pag.includes('href="/rapoarte" class="subnav-link')) rau("Rapoarte nu apare în subnavigația Management");
  else ok("Dashboard, Rapoarte, Configurări și Utilizatori stau în subnavigația Management");

  // Curățăm după noi: testul depozitului își reface fixtura ștergând parteneri,
  // iar un lead rămas aici i-ar bloca ștergerea prin cheia străină.
  for (const s of [
    "TRUNCATE mk_aniversari, mk_contacte_istoric, mk_contacte RESTART IDENTITY CASCADE",
    "DELETE FROM leaduri WHERE email LIKE '%@test-mk.ro'",
    "DELETE FROM facturi WHERE id = 95101",
    "DELETE FROM parteneri WHERE cui IN ('RO-MK-A','RO-MK-P')",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
