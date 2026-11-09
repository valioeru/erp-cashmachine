"use strict";
// Clientul cu facturi întârziate NU mai e blocat la comenzi — doar se spune.
//
// CEREREA LUI VALI, 03.11.2026: „Nu mai bloca comenzile pentru clienții
// întârziați, doar menționează că au întârzieri la plată.”
//
// Până atunci, un client ROȘU (o factură trecută de scadență cu peste 7 zile)
// nu primea comandă de la agent: pagina spunea „Comandă blocată”, iar oferta
// acceptată făcea contractul, dar nu și comanda.
//
// CE APĂRĂ:
//   • agentul plasează comanda pentru un client roșu, ca pentru oricare altul;
//   • în comanda nouă, clientul întârziat are mențiunea în rândul lui din
//     căsuța de căutare; clientul la zi n-o are;
//   • pagina comenzii spune sus că clientul are întârzieri la plată, iar la
//     clientul la zi nu spune nimic;
//   • suma din mențiune e doar ce a trecut de scadență — o factură încă
//     nescadentă nu e întârziere;
//   • oferta acceptată cu „creează comanda” face comanda și spune de
//     întârziere; „spre comandă” duce direct la comanda nouă;
//   • emailul de restanță nu mai promite „livrările noi sunt suspendate”;
//   • fișa clientului și scadențarul nu mai spun că e blocat.
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

// Niciun email nu pleacă din test.
const mail = require(path.join(RAD, "lib", "mail.js"));
mail.trimite = async () => {};
mail.trimiteDeLa = async () => {};

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["comenzi", "oferte", "scadente", "parteneri"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const scad = require(path.join(RAD, "modules", "scadente.js"));

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const AGENT = { id: 97601, nume: "Agent Test Întârzieri", rol: "vanzari" };
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function cer(cale, { user = AGENT, params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipsește: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => (r.antet && (r.antet.Location || r.antet.location)) || "";
const faraScript = (t) => String(t || "").replace(/<script[\s\S]*?<\/script>/g, "");

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
function contine(eticheta, corp, bucati, interzise) {
  const lipsa = (bucati || []).filter((b) => !corp.includes(b));
  if (lipsa.length) return rau(eticheta, "lipsește „" + lipsa.join("”, „") + "”");
  const gasite = (interzise || []).filter((b) => corp.includes(b));
  if (gasite.length) return rau(eticheta, "n-ar trebui să apară „" + gasite.join("”, „") + "”");
  ok(eticheta);
}

// ---- datele de test ---------------------------------------------------------
const azi = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.UTC(+azi.slice(0, 4), +azi.slice(5, 7) - 1, +azi.slice(8, 10) + n)).toISOString().slice(0, 10);
const ROSU = 97001, VERDE = 97002, GALBEN = 97003;

const CURATENIE = [
  "UPDATE oferte SET comanda_id = NULL WHERE partener_id BETWEEN 97001 AND 97099",
  "DELETE FROM comenzi_istoric WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97001 AND 97099)",
  "DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97001 AND 97099)",
  "DELETE FROM taskuri WHERE comanda_id IN (SELECT id FROM comenzi WHERE partener_id BETWEEN 97001 AND 97099)",
  "DELETE FROM comenzi WHERE partener_id BETWEEN 97001 AND 97099",
  "DELETE FROM contracte WHERE partener_id BETWEEN 97001 AND 97099",
  "DELETE FROM oferte_linii WHERE oferta_id IN (SELECT id FROM oferte WHERE partener_id BETWEEN 97001 AND 97099)",
  "DELETE FROM oferte WHERE partener_id BETWEEN 97001 AND 97099",
  "DELETE FROM interactiuni WHERE partener_id BETWEEN 97001 AND 97099",
  "DELETE FROM emailuri WHERE partener_id BETWEEN 97001 AND 97099",
  "DELETE FROM plati WHERE factura_id BETWEEN 97101 AND 97199",
  "DELETE FROM notificari_facturi WHERE factura_id BETWEEN 97101 AND 97199",
  "DELETE FROM facturi_linii WHERE factura_id BETWEEN 97101 AND 97199",
  "DELETE FROM facturi WHERE id BETWEEN 97101 AND 97199",
  "DELETE FROM produse WHERE id BETWEEN 97401 AND 97499",
  "DELETE FROM parteneri WHERE id BETWEEN 97001 AND 97099",
  "DELETE FROM utilizatori WHERE id = 97601",
];

const startVechi = (q("SELECT valoare FROM setari_app WHERE cheie = 'scadentar_de_la'")[0] || {}).valoare || null;

function fixture() {
  for (const s of CURATENIE) exec(s);
  const S = [
    // Scadențarul „viu” de la începutul anului: facturile de test contează.
    "DELETE FROM setari_app WHERE cheie = 'scadentar_de_la'",
    `INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('scadentar_de_la', '${azi.slice(0, 4)}-01-01', '${azi}')`,
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97601,'Agent Test Întârzieri','agent-int@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING",
    "INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING",
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES
       (${ROSU},'ROSU INTARZIAT SRL','RO-INT-1','client'),
       (${VERDE},'VERDE LA ZI SRL','RO-INT-2','client'),
       (${GALBEN},'GALBEN PUTIN SRL','RO-INT-3','client')`,
    "INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare) VALUES (97401,'INT-1','Produs de test întârzieri','buc',10)",
  ];
  // id, partener, emitere, scadență, total fără TVA (cota 0)
  const F = [
    [97101, ROSU, plus(-50), plus(-20), 1000], // 20 de zile întârziere → roșu
    [97102, ROSU, plus(-5), plus(10), 5000], // încă nescadentă: nu e întârziere
    [97103, VERDE, plus(-2), plus(28), 2000], // la zi
    [97104, GALBEN, plus(-33), plus(-3), 300], // 3 zile → galben
  ];
  for (const [id, part, em, sc, tot] of F) {
    S.push(`INSERT INTO facturi (id, serie, numar, partener_id, directie, data_emiterii, data_scadenta, status, firma_id, intercompany, activ) VALUES (${id},'TINT',${id},${part},'vanzare','${em}','${sc}','emisa',NULL,0,1)`);
    S.push(`INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (${id},'marfă',1,${tot},0)`);
  }
  // Două oferte pe clientul roșu, ale agentului: una se acceptă cu comandă,
  // cealaltă merge „spre comandă”.
  S.push(`INSERT INTO oferte (id, numar, partener_id, agent_id, titlu, status) VALUES
            (97701,'OF-INT-1',${ROSU},97601,'Ofertă test 1','trimisa'),
            (97702,'OF-INT-2',${ROSU},97601,'Ofertă test 2','trimisa')`);
  S.push(`INSERT INTO oferte_linii (oferta_id, produs_id, denumire, um, cantitate, pret_unitar, cota_tva) VALUES
            (97701,97401,'Produs de test întârzieri','buc',3,10,19),
            (97702,97401,'Produs de test întârzieri','buc',4,10,19)`);
  for (const s of S) exec(s);
}
const comenziPe = (p) => q("SELECT id FROM comenzi WHERE partener_id = ? ORDER BY id", [p]).map((x) => Number(x.id));

(async () => {
  fixture();

  // --- starea și mențiunea, direct ------------------------------------------
  const sRosu = await scad.stareClient(ROSU);
  egal("clientul cu factura de acum 20 de zile e roșu", sRosu.stare, "rosu");
  egal("suma întârziată e doar factura trecută de scadență", Math.round(sRosu.soldIntarziat), 1000);
  const mRosu = scad.mentiuneIntarziere(sRosu);
  if (!mRosu) rau("clientul roșu n-are mențiune");
  else contine("mențiunea spune că are întârzieri, cu suma și zilele", mRosu, ["întârzieri la plată", "1.000,00", "20 zile"], ["6.000", "5.000"]);
  egal("clientul la zi n-are mențiune", scad.mentiuneIntarziere(await scad.stareClient(VERDE)), null);
  const mGalben = scad.mentiuneIntarziere(await scad.stareClient(GALBEN));
  if (!mGalben || !mGalben.includes("3 zile")) rau("întârzierea mică (3 zile) nu e spusă", String(mGalben));
  else ok("și întârzierea mică e spusă: " + mGalben);

  const v = await scad.poateComanda(AGENT, ROSU);
  egal("agentul poate comanda pentru clientul roșu", v.ok, true);
  if (!v.mentiune || !v.mentiune.includes("întârzieri la plată")) rau("verdictul nu aduce mențiunea", String(v.mentiune));
  else ok("verdictul aduce mențiunea");

  // --- formularul de comandă nouă -------------------------------------------
  let r = await cer("/comenzi/nou");
  const date = (r.corp.match(/window\.__alegeClient = S;/) && r.corp.match(/var S = \{ date: (\[[\s\S]*?\]), MAX: 25 \};/)) || null;
  let randuri = [];
  try { randuri = date ? JSON.parse(date[1]) : []; } catch (e) { randuri = []; }
  if (!randuri.length) rau("nu găsesc lista de clienți din pagina comenzii noi");
  const rand = (id) => randuri.find((x) => Number(x[0]) === id) || null;
  const rr = rand(ROSU), rv = rand(VERDE);
  if (!rr || !rr[5] || !String(rr[5]).includes("întârzieri la plată")) rau("clientul roșu n-are mențiunea în căsuța de căutare", JSON.stringify(rr));
  else ok("clientul roșu are mențiunea în căsuța de căutare");
  if (!rv || rv.length !== 5) rau("clientul la zi are ceva în plus în rândul lui", JSON.stringify(rv));
  else ok("clientul la zi are rândul neschimbat");
  contine("scriptul căsuței arată mențiunea la alegere", r.corp, ["mentiune-client", "mentiune(cutie, r)"]);

  // --- agentul plasează comanda pe clientul roșu -----------------------------
  r = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: String(ROSU), numar: "CMD-INT-1", livrare_partiala: "da", branding: "nepersonalizat",
            "produs_id[]": ["97401"], "cantitate[]": ["5"], "pret_unitar[]": ["12"] },
  });
  contine("nu mai apare „Comandă blocată”", faraScript(r.corp), [], ["Comandă blocată", "Comenzile se deblochează"]);
  egal("comanda clientului roșu s-a salvat", comenziPe(ROSU).length, 1);
  if (!/^\/comenzi\/\d+\?ok=plasata$/.test(locatie(r))) rau("nu duce la comanda salvată", locatie(r) || String(r.cod));
  else ok("duce la comanda salvată — " + locatie(r));

  const idRosu = comenziPe(ROSU)[0];
  r = await cer("/comenzi/:id", { params: { id: String(idRosu) }, query: { ok: "plasata" } });
  contine("pagina comenzii spune sus că clientul are întârzieri la plată", faraScript(r.corp),
    ["intarziere-plata", "Clientul are întârzieri la plată", "1.000,00", "20 zile"]);
  // Mențiunea stă deasupra datelor comenzii, nu pierdută la final.
  const poz = r.corp.indexOf("intarziere-plata"), pozClient = r.corp.indexOf('<div class="k">Client</div>');
  if (!(poz > 0 && pozClient > 0 && poz < pozClient)) rau("mențiunea nu e sus, înaintea datelor comenzii", poz + " / " + pozClient);
  else ok("mențiunea e sus, înaintea datelor comenzii");

  // Clientul la zi: comanda trece și pagina ei nu spune nimic de întârzieri.
  r = await cer("/comenzi", {
    metoda: "post",
    body: { partener_id: String(VERDE), numar: "CMD-INT-2", livrare_partiala: "nu", branding: "nepersonalizat",
            "produs_id[]": ["97401"], "cantitate[]": ["2"], "pret_unitar[]": ["12"] },
  });
  egal("comanda clientului la zi s-a salvat", comenziPe(VERDE).length, 1);
  r = await cer("/comenzi/:id", { params: { id: String(comenziPe(VERDE)[0]) } });
  contine("pagina comenzii clientului la zi nu vorbește de întârzieri", faraScript(r.corp), [], ["intarziere-plata", "întârzieri la plată"]);

  // Plătește → mențiunea dispare singură, fără să apese cineva ceva.
  exec("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (97101, 1000, '" + azi + "', 'banca', 'test')");
  r = await cer("/comenzi/:id", { params: { id: String(idRosu) } });
  contine("după plată, mențiunea dispare de pe comandă", faraScript(r.corp), [], ["intarziere-plata"]);
  exec("DELETE FROM plati WHERE factura_id = 97101");

  // Comanda anulată nu mai poartă mențiunea.
  exec("UPDATE comenzi SET status = 'anulata' WHERE id = " + idRosu);
  r = await cer("/comenzi/:id", { params: { id: String(idRosu) } });
  contine("pe comanda anulată nu apare mențiunea", faraScript(r.corp), [], ["intarziere-plata"]);
  exec("UPDATE comenzi SET status = 'noua' WHERE id = " + idRosu);

  // --- oferta acceptată, cu „creează comanda” --------------------------------
  r = await cer("/oferte/:id/accepta", { metoda: "post", params: { id: "97701" }, body: { creeaza_comanda: "1" } });
  const legata = q("SELECT comanda_id FROM oferte WHERE id = 97701")[0].comanda_id;
  if (!legata) rau("oferta acceptată pe clientul roșu n-a făcut comanda");
  else ok("oferta acceptată pe clientul roșu a făcut comanda #" + legata);
  const loc = decodeURIComponent(locatie(r));
  if (!loc.startsWith("/oferte/97701?info=") || !loc.includes("întârzieri la plată") || loc.includes("eroare="))
    rau("după acceptare nu spune că clientul are întârzieri", loc);
  else ok("după acceptare spune că s-a creat comanda și că are întârzieri");
  r = await cer("/oferte/:id", { params: { id: "97701" }, query: { info: "Comanda s-a creat. " + mRosu } });
  contine("pagina ofertei arată mesajul", faraScript(r.corp), ["mentiune-oferta", "Comanda s-a creat.", "întârzieri la plată"]);

  // --- „spre comandă” -------------------------------------------------------
  r = await cer("/oferte/:id/spre-comanda", { metoda: "post", params: { id: "97702" } });
  const legata2 = q("SELECT comanda_id FROM oferte WHERE id = 97702")[0].comanda_id;
  if (!legata2) rau("„spre comandă” pe clientul roșu n-a făcut comanda");
  else if (locatie(r) !== "/comenzi/" + legata2) rau("„spre comandă” nu duce la comanda nouă", locatie(r));
  else ok("„spre comandă” face comanda și duce la ea — " + locatie(r));

  // --- emailul de restanță -----------------------------------------------------
  const mesaj = scad.compuneMesaj({ zile: 20, sold: 1000, scadenta: plus(-20), serie: "TINT", numar: 97101 }, { nume: "Cash Machine SRL" });
  contine("emailul de restanță nu mai promite suspendarea livrărilor", mesaj.corp,
    ["Vă rugăm să ne comunicați data la care se face plata.", "spuneți-ne — o rezolvăm"], ["suspendate"]);

  // --- fișa clientului și scadențarul ------------------------------------------
  r = await cer("/parteneri/:id", { user: VALI, params: { id: String(ROSU) } });
  contine("fișa clientului nu mai spune că agenții nu pot comanda", faraScript(r.corp),
    ["întârzieri la plată"], ["nu pot plasa comenzi"]);
  r = await cer("/scadente", { user: VALI });
  contine("scadențarul nu mai vorbește de clienți blocați", faraScript(r.corp),
    ["cu restanță", "Comenzile lor se plasează"], ["clienți blocați", "nu se pot plasa comenzi"]);

  // --- curățenie după noi -------------------------------------------------------
  for (const s of CURATENIE) exec(s);
  exec("DELETE FROM setari_app WHERE cheie = 'scadentar_de_la'");
  if (startVechi) exec(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('scadentar_de_la', ${lit(startVechi)}, '${azi}')`);

  console.log(rele ? "\n" + rele + " probleme." : "\nTotul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  try {
    for (const s of CURATENIE) exec(s);
    exec("DELETE FROM setari_app WHERE cheie = 'scadentar_de_la'");
    if (startVechi) exec(`INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES ('scadentar_de_la', ${lit(startVechi)}, '${azi}')`);
  } catch (x) { /* curățenia e best-effort */ }
  process.exit(1);
});
