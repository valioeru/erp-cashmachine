"use strict";
// Cereri de preț (RFQ): agentul întreabă, achizițiile află, agentul ofertează.
//
// CE APĂRĂ, în ordinea în care doare dacă se strică:
//
//   • FURNIZORUL ȘI PREȚUL DE ACHIZIȚIE NU AJUNG LA AGENT. Nici pe ecran,
//     nici ascunse în HTML — un câmp invizibil e tot acolo pentru cine
//     deschide sursa paginii, iar de aici pleacă marja firmei. Testul caută
//     șirurile în TOT corpul răspunsului, nu doar în ce s-ar vedea.
//
//   • O COLOANĂ NOUĂ E INTERNĂ PÂNĂ SE DECIDE ALTFEL. Despărțirea se face
//     prin `pentruOchiiLui`, care ȘTERGE ce e intern, deci un câmp adăugat
//     peste un an ajunge la agent doar dacă cineva îl trece anume pe listă.
//     Verificăm chiar lista, nu doar efectul ei.
//
//   • PREȚUL DE OFERTARE SE CALCULEAZĂ, nu se stochează. Dacă s-ar scrie în
//     bază, o schimbare de adaos ar lăsa prețuri vechi care arată exact ca
//     unele proaspete.
//
//   • ADAOSUL PE CERERE BATE IMPLICITUL, iar implicitul e 20%. Adminul le
//     mută pe amândouă; altcineva pe niciunul.
//
//   • CINE RĂSPUNDE. Un agent care trimite POST direct pe /raspunde nu-și
//     poate pune singur prețul de achiziție — ar însemna să-și scrie singur
//     marja.
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
  run: async (...p) => { const r = q(sql, p); return { changes: r.length, lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const rfq = require(path.join(RAD, "modules", "rfq.js"));
const rute = { get: {}, post: {} };
rfq.register({
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
const AGENT = { id: 97101, nume: "Gabriela", rol: "vanzari" };
const ALT_AGENT = { id: 97102, nume: "Radu", rol: "vanzari" };
const ACHIZITII = { id: 97103, nume: "Mirela", rol: "depozit" };
const ADMIN = { id: 97104, nume: "Vali", rol: "admin" };

async function cer(cale, { user = AGENT, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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

const FURNIZOR = 97201;
const CLIENT = 97202;
const SECRET_FURNIZOR = "FURNIZORUL SECRET SRL";
const SECRET_NOTA = "marja buna, mai putem negocia";
// 137,50 × 1,20 = 165,00. Niciuna nu e bucată din cealaltă, deci căutarea
// în text nu dă fals pozitiv.
const COST = 137.5;

function curata() {
  for (const s of [
    "DELETE FROM rfq WHERE agent_id BETWEEN 97101 AND 97199 OR denumire LIKE 'RFQTEST%'",
    "DELETE FROM setari_app WHERE cheie = 'rfq_adaos_implicit'",
    "DELETE FROM parteneri WHERE id BETWEEN 97201 AND 97299",
    "DELETE FROM utilizatori WHERE id BETWEEN 97101 AND 97199",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}

(async () => {
  curata();
  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97101,'Gabriela','g.rfq@test.ro','x','y','vanzari')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97102,'Radu','r.rfq@test.ro','x','y','vanzari')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97103,'Mirela','m.rfq@test.ro','x','y','depozit')`,
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97104,'Vali','v.rfq@test.ro','x','y','admin')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${FURNIZOR}, '${SECRET_FURNIZOR}', 'RO97201', 'furnizor')`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES (${CLIENT}, 'CLIENTUL RFQ SRL', 'RO97202', 'client')`,
  ]) exec(s);

  // ---------------------------------------------------------- regula, curată
  console.log("\nRegula de ascundere, fără bază de date:");
  const brut = {
    id: 1, denumire: "X", furnizor_id: 5, furnizor_text: "ceva", furnizor_nume: SECRET_FURNIZOR,
    pret_achizitie: COST, moneda_achizitie: "EUR", note_interne: SECRET_NOTA, preluat_de: 3, preluat_nume: "Mirela",
  };
  const laAgent = rfq.pentruOchiiLui(AGENT, brut);
  for (const c of rfq.CAMPURI_INTERNE) {
    if (c in laAgent) rau("câmpul intern a ajuns la agent", c);
  }
  ok("niciun câmp intern nu trece de filtru (" + rfq.CAMPURI_INTERNE.length + " verificate)");
  if (!("denumire" in laAgent)) rau("filtrul a tăiat și ce era public");
  else ok("ce e public rămâne public");
  egal("achizițiile văd tot", rfq.pentruOchiiLui(ACHIZITII, brut).furnizor_nume, SECRET_FURNIZOR);
  egal("adminul vede tot", rfq.pentruOchiiLui(ADMIN, brut).pret_achizitie, COST);
  egal("prețul de ofertare la 20% implicit", rfq.pretOfertare({ pret_achizitie: 100 }, 20), 120);
  egal("adaosul cererii bate implicitul", rfq.pretOfertare({ pret_achizitie: 100, adaos: 35 }, 20), 135);
  egal("adaos 0 e o valoare, nu „lipsă”", rfq.pretOfertare({ pret_achizitie: 100, adaos: 0 }, 20), 100);
  egal("fără cost nu există preț de ofertare", rfq.pretOfertare({ pret_achizitie: 0 }, 20), null);
  // Capcana care a scăpat prima dată: coloana e NULL cât timp nimeni n-a
  // scris un adaos, iar Number(null) e 0 — un zero care trece de orice
  // verificare și dă agentului exact prețul de achiziție.
  egal("adaos NULL din bază = implicit, nu zero", rfq.pretOfertare({ pret_achizitie: 100, adaos: null }, 20), 120);
  egal("adaos șir gol = tot implicit", rfq.pretOfertare({ pret_achizitie: 100, adaos: "" }, 20), 120);
  egal("adaos ca text, din bază, se citește", rfq.pretOfertare({ pret_achizitie: 100, adaos: "35" }, 20), 135);
  // Ordinea din deAfisat: prețul se calculează ÎNAINTE de tăiere.
  const afisat = rfq.deAfisat(AGENT, { pret_achizitie: 100 }, 20);
  egal("agentul primește prețul calculat, nu costul", [afisat.pret_ofertare, "pret_achizitie" in afisat], [120, false]);

  // ------------------------------------------------------------ cererea nouă
  console.log("\nCererea agentului:");
  let r = await cer("/rfq", {
    metoda: "post",
    body: { denumire: "", cantitate: "10" },
  });
  if (!r.corp.includes("denumirea produsului")) rau("nu cere denumirea");
  else ok("fără denumire nu trece");
  r = await cer("/rfq", { metoda: "post", body: { denumire: "RFQTEST Folie speciala", cantitate: "0" } });
  if (!r.corp.includes("cantitatea")) rau("nu cere cantitatea");
  else ok("fără cantitate nu trece");

  r = await cer("/rfq", {
    metoda: "post",
    body: {
      denumire: "RFQTEST Folie speciala", descriere: "1200mm, 23 microni", categorie: "Folie stretch manuala",
      cantitate: "500", um: "kg", pret_tinta: "9.5", partener_id: String(CLIENT),
      termen_ofertare: "2026-10-25", termen_comanda: "2026-11-10",
    },
  });
  const m = /^\/rfq\/(\d+)$/.exec(locatie(r));
  if (!m) throw new Error("cererea nu s-a creat: " + (locatie(r) || r.corp.slice(0, 200)));
  const ID = Number(m[1]);
  const din = () => q("SELECT * FROM rfq WHERE id = ?", [ID])[0] || {};
  egal("cererea e pe agentul care a scris-o", Number(din().agent_id), AGENT.id);
  egal("pornește ca „nouă”", din().status, "noua");
  egal("ține cantitatea, UM și categoria", [Number(din().cantitate), din().um, din().categorie], [500, "kg", "Folie stretch manuala"]);

  // ------------------------------------------------------------- achizițiile
  console.log("\nAchizițiile:");
  await cer("/rfq/:id/preia", { metoda: "post", user: ACHIZITII, params: { id: String(ID) } });
  egal("preluarea mută pe „la achiziții”", [din().status, Number(din().preluat_de)], ["in_lucru", ACHIZITII.id]);

  // Un agent nu poate răspunde în locul achizițiilor.
  await cer("/rfq/:id/raspunde", {
    metoda: "post", user: AGENT, params: { id: String(ID) },
    body: { pret_achizitie: "1", furnizor_id: String(FURNIZOR) },
  });
  egal("agentul nu-și poate scrie singur prețul de achiziție", din().pret_achizitie, null);

  await cer("/rfq/:id/raspunde", {
    metoda: "post", user: ACHIZITII, params: { id: String(ID) },
    body: {
      furnizor_id: String(FURNIZOR), pret_achizitie: String(COST), moneda_achizitie: "RON",
      termen_livrare: "3 saptamani", valabil_pana: "2026-11-30", note_interne: SECRET_NOTA,
      categorie: "Folie stretch manuala",
    },
  });
  egal("răspunsul trece cererea pe „are preț”", din().status, "ofertata");
  egal("costul e în bază", Number(din().pret_achizitie), COST);
  egal("se știe cine a răspuns", Number(din().raspuns_de), ACHIZITII.id);

  // ------------------------------------------------ SCURGEREA, partea serioasă
  console.log("\nCe NU ajunge la agent:");
  const secrete = [SECRET_FURNIZOR, SECRET_NOTA, "137,50", "137.5"];
  const pagini = [
    ["fișa cererii", await cer("/rfq/:id", { user: AGENT, params: { id: String(ID) } })],
    ["lista lui", await cer("/rfq", { user: AGENT })],
    ["oferte interne", await cer("/rfq/oferte", { user: AGENT })],
  ];
  for (const [nume, pag] of pagini) {
    const scapate = secrete.filter((s) => pag.corp.includes(s));
    if (scapate.length) rau("secret scăpat în " + nume, scapate.join(" / "));
    else ok("nimic secret în " + nume);
  }
  // Și chiar vede prețul de ofertare: 137,50 × 1,20 = 165,00
  const fisaAgent = pagini[0][1].corp;
  if (!fisaAgent.includes("165,00")) rau("agentul nu vede prețul de ofertare");
  else ok("agentul vede prețul de ofertare, 165,00");
  if (!fisaAgent.includes("adaos 20%")) rau("nu scrie cu ce adaos s-a calculat");
  else ok("scrie cu ce adaos s-a calculat");

  // Achizițiile, în schimb, văd tot.
  const fisaAchizitii = (await cer("/rfq/:id", { user: ACHIZITII, params: { id: String(ID) } })).corp;
  const vazute = secrete.filter((s) => fisaAchizitii.includes(s));
  if (!fisaAchizitii.includes(SECRET_FURNIZOR) || !fisaAchizitii.includes(SECRET_NOTA))
    rau("achizițiile nu-și văd propriile date", vazute.join(" / "));
  else ok("achizițiile văd furnizorul, costul și notele");

  // ------------------------------------------------------------------ adaosul
  console.log("\nAdaosul:");
  await cer("/rfq/:id/adaos", { metoda: "post", user: ADMIN, params: { id: String(ID) }, body: { adaos: "35" } });
  egal("adminul pune adaos pe cerere", Number(din().adaos), 35);
  const cu35 = (await cer("/rfq/:id", { user: AGENT, params: { id: String(ID) } })).corp;
  if (!cu35.includes("185,63")) rau("prețul nu s-a recalculat cu adaosul nou", "137,50 × 1,35 = 185,625");
  else ok("prețul se recalculează singur: 185,63");

  await cer("/rfq/:id/adaos", { metoda: "post", user: ACHIZITII, params: { id: String(ID) }, body: { adaos: "5" } });
  egal("achizițiile NU umblă la adaos", Number(din().adaos), 35);
  await cer("/rfq/:id/adaos", { metoda: "post", user: AGENT, params: { id: String(ID) }, body: { adaos: "500" } });
  egal("nici agentul", Number(din().adaos), 35);

  // Golit înseamnă „ia-l pe cel implicit", nu „zero".
  await cer("/rfq/:id/adaos", { metoda: "post", user: ADMIN, params: { id: String(ID) }, body: { adaos: "" } });
  egal("gol = revine la implicit", din().adaos, null);

  await cer("/rfq/adaos", { metoda: "post", user: ADMIN, body: { adaos: "30" } });
  const cuImplicit30 = (await cer("/rfq/:id", { user: AGENT, params: { id: String(ID) } })).corp;
  if (!cuImplicit30.includes("178,75")) rau("implicitul schimbat nu se aplică", "137,50 × 1,30 = 178,75");
  else ok("implicitul schimbat se aplică: 178,75");
  await cer("/rfq/adaos", { metoda: "post", user: AGENT, body: { adaos: "1" } });
  const totImplicit30 = q("SELECT valoare FROM setari_app WHERE cheie = 'rfq_adaos_implicit'")[0];
  egal("agentul nu schimbă implicitul", totImplicit30 && totImplicit30.valoare, "30");

  // --------------------------------------------------------------- anularea
  console.log("\nAnularea:");
  const r2 = await cer("/rfq", { metoda: "post", body: { denumire: "RFQTEST A doua", cantitate: "1" } });
  const ID2 = Number(/^\/rfq\/(\d+)$/.exec(locatie(r2))[1]);
  await cer("/rfq/:id/anuleaza", { metoda: "post", user: ALT_AGENT, params: { id: String(ID2) } });
  egal("un alt agent nu-ți anulează cererea",
    (q("SELECT status FROM rfq WHERE id = ?", [ID2])[0] || {}).status, "noua");
  await cer("/rfq/:id/anuleaza", { metoda: "post", user: AGENT, params: { id: String(ID2) } });
  egal("agentul își anulează cererea lui",
    (q("SELECT status FROM rfq WHERE id = ?", [ID2])[0] || {}).status, "anulata");

  // ------------------------------------------------------------- acces la meniu
  console.log("\nAccesul:");
  const auth = require(path.join(RAD, "lib", "auth.js"));
  const render = require(path.join(RAD, "lib", "render.js"));
  for (const rol of ["admin", "vanzari", "depozit"]) {
    if (!auth.poateAccesa({ rol }, "/rfq")) rau("rolul " + rol + " nu ajunge la /rfq");
    else ok("rolul " + rol + " ajunge la /rfq");
  }
  const navAgent = render.NAV.filter((i) => auth.poateAccesa({ rol: "vanzari" }, i.zona || i.href)).map((i) => i.label);
  if (!navAgent.includes("Cereri de preț")) rau("agentul nu vede intrarea în bară", JSON.stringify(navAgent));
  else ok("agentul vede intrarea în bară");
  const navAchizitii = render.NAV.filter((i) => auth.poateAccesa({ rol: "depozit" }, i.zona || i.href)).map((i) => i.label);
  if (!navAchizitii.includes("Cereri de preț")) rau("achizițiile nu văd intrarea în bară");
  else ok("achizițiile văd intrarea în bară");

  curata();
  console.log("\n" + interogari + " interogări SQL rulate pe PostgreSQL real.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { curata(); console.error("A crăpat:", e.message); process.exit(1); });
