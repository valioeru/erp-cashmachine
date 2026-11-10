"use strict";
// Finalizarea parțială a comenzilor de producție.
//
// CE A CERUT VALI, 10.11.2026 (cu poza listei de stări din Producție):
//   „Să am și opțiune de finalizare parțială, caz în care se duce spre alocare
//    partea indicată din marfa comandată, însă rămâne în producție până la
//    finalizarea completă."
//
// CE APĂRĂ:
//   • PARTEA GATA PLEACĂ: o recepție din producție, marcată parțială, cu
//     cantitatea scrisă și linia comenzii de producție; apare în lista „Gata
//     din producție — de alocat".
//   • COMANDA RĂMÂNE ÎN PRODUCȚIE: nici starea ei, nici a comenzii clientului,
//     nici cererea depozitului nu se închid; recepția parțială preluată în
//     depozit nu închide cererea.
//   • LA „FINALIZATĂ" PLEACĂ DOAR RESTUL; dacă totul plecase parțial, nu se mai
//     deschide altă recepție.
//   • CANTITATEA COMENZII NU E PLAFON (Vali, 10.11.2026: „Cantitatea
//     recepționată poate fi mai mare decât cea din comandă și se salvează
//     cantitatea din recepție"): peste „rămas de făcut" se trimite, iar mesajul,
//     recepția și istoricul clientului spun cu cât e peste comandă. Restul nu
//     coboară sub zero. Zero, negativ, de pe o comandă deja finalizată sau
//     anulată — tot nu se trimite.
//   • „PLECAT" E CE A PRIMIT DEPOZITUL: recepția preluată contează cu cantitatea
//     primită în stare bună, nu cu cea anunțată; cea respinsă sau primită
//     deteriorată nu e plecată din comandă. Când pe paleți ajunge mai mult
//     decât scria recepția, recepția ia cantitatea de pe paleți.
//   • RECEPȚIA PARȚIALĂ ANULATĂ își întoarce cantitatea la „rămas de făcut".
//   • LISTA: opțiunea „Finalizată parțial…" doar la comenzile în lucru; nu e o
//     stare și nu se poate scrie pe comandă.
//
// Pe PostgreSQL real (port 5433), prin psql.
const path = require("path");
const Module = require("module");
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
const orig = Module._load;
Module._load = function (req) {
  if (req === "pg") return { Pool: function () { return { on: () => {}, query: async () => ({ rows: [] }) }; } };
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); } };
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
      const out = execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", t], { env: ENV, encoding: "utf8" });
      const m = out.match(/(?:UPDATE|DELETE) (\d+)/);
      return { changes: m ? Number(m[1]) : 0 };
    }
    const r = q(sql, p);
    return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined, changes: r.length };
  },
});

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
// În ordinea din server.js.
for (const m of ["gata-productie", "ct-park", "retete", "productie", "receptie", "warehouse"]) require(path.join(RAD, "modules", m + ".js")).register(router);
const GP = require(path.join(RAD, "lib", "gata-productie.js"));
const STADIU = require(path.join(RAD, "lib", "stadiu-comanda.js"));

function res() {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = (k, v) => { o.antet[k] = v; };
  o.end = (b) => { o.corp = b || ""; };
  return o;
}
async function cer(metoda, cale, user, { body, query } = {}) {
  let h = rute[metoda][cale];
  let par = {};
  if (!h) {
    for (const [tipar, fn] of Object.entries(rute[metoda])) {
      const re = new RegExp("^" + tipar.replace(/:[^/]+/g, "([^/]+)") + "$");
      const m = re.exec(cale);
      if (m) {
        const nume = (tipar.match(/:[^/]+/g) || []).map((x) => x.slice(1));
        par = Object.fromEntries(nume.map((n, i) => [n, m[i + 1]]));
        h = fn;
        break;
      }
    }
  }
  if (!h) throw new Error("nicio rută pentru " + metoda + " " + cale);
  const r = res();
  await h({ user, params: par, query: query || {}, body: body || {}, res: r, req: { url: cale, method: metoda.toUpperCase(), headers: {} } });
  return r;
}
const unde = (r) => String((r.antet && r.antet.Location) || "");
const parametri = (r) => Object.fromEntries(new URL(unde(r), "http://erp.test").searchParams);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---- datele de test ------------------------------------------------------
const P1 = 97801, P2 = 97802;
const CLIENT = 97811;
const CMD = 97821;
const CP_LINII = 97831, CP_PLAT = 97832, CP_GATA = 97833, CP_NESCRIS = 97834, CP_TEXT = 97835, CP_ANULATA = 97836;
// Cantități scrise ca în registrul adevărat (10.11.2026) și una scrisă de ERP.
const CP_REG = 97837, CP_NOTA = 97838, CP_KG = 97839;
const A_CERERE = 97841, A_CERERE2 = 97842;
// Peste cantitatea comenzii, și „plecat" socotit din ce a primit depozitul.
const CP_PESTE = 97843, CP_PESTE2 = 97844, CP_PRIMIT = 97845;
const CMD2 = 97822;
const PREFIX = "TFP";
const TOATE_CP = [CP_LINII, CP_PLAT, CP_GATA, CP_NESCRIS, CP_TEXT, CP_ANULATA, CP_REG, CP_NOTA, CP_KG, CP_PESTE, CP_PESTE2, CP_PRIMIT];

function curata() {
  const cp = TOATE_CP.join(",");
  const rec = q(`SELECT id FROM receptii WHERE comanda_productie_id IN (${cp}) OR aprovizionare_id IN (${A_CERERE}, ${A_CERERE2})`).map((x) => Number(x.id));
  const r = rec.join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE receptie_id IN (${r}) OR produs_id IN (${P1}, ${P2})`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${P1}, ${P2})`);
  q(`DELETE FROM stoc_locuri WHERE receptie_id IN (${r}) OR produs_id IN (${P1}, ${P2})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${r}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii WHERE id IN (${r})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${cp})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${cp})`);
  q(`DELETE FROM aprovizionari WHERE id IN (${A_CERERE}, ${A_CERERE2}) OR produs_id IN (${P1}, ${P2})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${P1}, ${P2})`);
  try { q(`DELETE FROM comenzi_istoric WHERE comanda_id IN (${CMD}, ${CMD2})`); } catch (_) { /* tabela poate lipsi */ }
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${CMD}, ${CMD2})`);
  q(`DELETE FROM comenzi WHERE id IN (${CMD}, ${CMD2})`);
  q(`DELETE FROM produse WHERE id IN (${P1}, ${P2})`);
  q(`DELETE FROM interactiuni WHERE partener_id = ${CLIENT}`);
  q(`DELETE FROM parteneri WHERE id = ${CLIENT}`);
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
const ziPlus = (n) => new Date(Date.parse(azi() + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const REC = require(path.join(RAD, "modules", "receptie.js"));
const partiale = (cp) => q(`SELECT r.id, r.stare, r.partiala, r.aprovizionare_id, r.comanda_id, r.anuntata_de, r.observatii FROM receptii r WHERE r.comanda_productie_id = ${cp} AND r.partiala = 1 ORDER BY r.id`);
const randuri = (rid) => q(`SELECT produs_id, cantitate_asteptata, um, productie_linie_id FROM receptii_linii WHERE receptie_id = ${rid} ORDER BY id`).map((x) => [Number(x.produs_id) || null, Number(x.cantitate_asteptata), x.um, Number(x.productie_linie_id) || null]);
const cp = (id) => q(`SELECT status, receptie_id, trimisa_depozit_la, data_finalizare FROM comenzi_productie WHERE id = ${id}`)[0] || {};

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const MIHAI = { id: idUser, nume: "Mihai Productie", rol: "productie", sectiuni: "" };
  const DEP = { id: idUser, nume: "Om Depozit", rol: "depozit", sectiuni: "" };

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${CLIENT}, 'client', '${PREFIX} Client SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P1}, 'TFP-1', '${PREFIX} Punga curier', 'buc'), (${P2}, 'TFP-2', '${PREFIX} Folie', 'kg')`);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD}, ${CLIENT}, '${PREFIX}-1', '${azi()}', 'in_productie')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${CMD}, ${P1}, 10000, 1), (${CMD}, ${P2}, 500, 1)`);
  q(`INSERT INTO aprovizionari (id, comanda_id, produs_id, cantitate, sursa, status, creata_la) VALUES (${A_CERERE}, ${CMD}, ${P1}, 10000, 'productie', 'confirmata', '${azi()}')`);
  // Comanda cu două produse, legată de comanda clientului și de cererea depozitului.
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, data_initiere, partener_id, comanda_id, aprovizionare_id) VALUES
       (${CP_LINII}, '${PREFIX}-CP-1', ${P1}, '${PREFIX} Punga curier', '10000', 'buc', 'in_productie', '${ziPlus(-3)}', ${CLIENT}, ${CMD}, ${A_CERERE})`);
  const L1 = Number(unul(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um, ordine) VALUES (${CP_LINII}, ${P1}, '${PREFIX} Punga curier', '10000', 'buc', 1) RETURNING id`));
  const L2 = Number(unul(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um, ordine) VALUES (${CP_LINII}, ${P2}, '${PREFIX} Folie', '500', 'kg', 2) RETURNING id`));
  // Comenzi fără linii (ca în registrul vechi): nouă, finalizată, fără cantitate, cu cantitatea scrisă ca text, anulată.
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, data_initiere, client_text) VALUES
       (${CP_PLAT}, '${PREFIX}-CP-2', ${P1}, '${PREFIX} Punga curier', '1000', 'buc', 'noua', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_GATA}, '${PREFIX}-CP-3', ${P1}, '${PREFIX} Punga curier', '300', 'buc', 'finalizata', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_NESCRIS}, '${PREFIX}-CP-4', ${P1}, '${PREFIX} Punga curier', NULL, 'buc', 'in_productie', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_TEXT}, '${PREFIX}-CP-5', ${P2}, '${PREFIX} Folie', '1 200 kg', 'kg', 'in_productie', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_ANULATA}, '${PREFIX}-CP-6', ${P1}, '${PREFIX} Punga curier', '50', 'buc', 'anulata', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_REG}, '${PREFIX}-CP-7', ${P1}, '${PREFIX} Punga curier', '67,200', 'buc', 'in_productie', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_NOTA}, '${PREFIX}-CP-8', ${P1}, '${PREFIX} Punga curier', '205(65 DONE)', 'buc', 'in_productie', '${ziPlus(-2)}', 'SAMEDAY COURIER'),
       (${CP_KG}, '${PREFIX}-CP-9', ${P2}, '${PREFIX} Folie', '847.625', 'kg', 'in_productie', '${ziPlus(-2)}', 'SAMEDAY COURIER')`);
  // CP_NOTA vine dintr-o cerere a depozitului, pentru stoc (fără comandă de client).
  q(`INSERT INTO aprovizionari (id, produs_id, cantitate, sursa, status, creata_la) VALUES (${A_CERERE2}, ${P1}, 205, 'productie', 'confirmata', '${azi()}')`);
  q(`UPDATE comenzi_productie SET aprovizionare_id = ${A_CERERE2} WHERE id = ${CP_NOTA}`);

  // ------------------------------------------------------------------------
  console.log("1. Pagina de finalizare parțială");
  let pag = await cer("get", `/productie/${CP_LINII}/partial`, MIHAI, { query: { inapoi: "/productie?status=in_productie" } });
  bine("se deschide, cu cele două produse", pag.cod === 200 && pag.corp.includes(`${PREFIX} Punga curier`) && pag.corp.includes(`${PREFIX} Folie`), pag.cod);
  bine("fiecare produs are câmpul lui, cu cât e comandat și cât a rămas alături", pag.corp.includes(`name="cant_${L1}"`) && pag.corp.includes(`name="cant_${L2}"`) && pag.corp.includes("10.000 buc") && pag.corp.includes("500 kg"));
  bine("…fără limită pe câmp: cantitatea comenzii nu e plafon", !/name="cant_\d+"[^>]*\smax=/.test(pag.corp), (pag.corp.match(/name="cant_\d+"[^>]*>/) || [])[0]);
  bine("spune ce se întâmplă cu partea gata și cu comanda", /Gata din producție — de alocat/.test(pag.corp) && /rămâne în producție până o pui pe „Finalizată”/.test(pag.corp));
  bine("…și că se poate scrie mai mult decât era comandat", /cantitatea din comandă nu e o limită/.test(pag.corp) && /ce a primit depozitul, nu ce s-a anunțat/.test(pag.corp));
  bine("ține minte unde se întoarce", pag.corp.includes('name="inapoi" value="/productie?status=in_productie"'));
  pag = await cer("get", `/productie/${CP_LINII}/partial`, MIHAI, { query: { inapoi: "https://rau.example/x" } });
  bine("o adresă din afara Producției nu e crezută", pag.corp.includes(`name="inapoi" value="/productie/${CP_LINII}"`) && !pag.corp.includes("rau.example"));
  pag = await cer("get", `/productie/${CP_LINII}/partial`, null);
  egal("fără cont: la autentificare", unde(pag), "/login");
  pag = await cer("get", `/productie/${CP_GATA}/partial`, MIHAI);
  bine("la o comandă finalizată: fără formular, cu explicație", !/name="cant_/.test(pag.corp) && /nu mai e în lucru/.test(pag.corp));

  // ------------------------------------------------------------------------
  console.log("\n2. Partea gata pleacă în depozit, comanda rămâne în producție");
  let r = await cer("post", `/productie/${CP_LINII}/partial`, MIHAI, { body: { [`cant_${L1}`]: "3000", [`cant_${L2}`]: "", inapoi: "/productie?status=in_productie" } });
  bine("înapoi în listă, cu mesajul", unde(r).startsWith("/productie?status=in_productie&ok=") && /3\.000 buc au plecat în depozit/.test(parametri(r).ok || ""), unde(r));
  bine("…care spune că rămâne în producție", /rămâne în producție până o pui pe „Finalizată”/.test(parametri(r).ok || ""), parametri(r).ok);
  let pr = partiale(CP_LINII);
  egal("o recepție din producție, parțială, legată de comanda clientului și de cerere", pr.map((x) => [x.stare, Number(x.partiala), Number(x.aprovizionare_id), Number(x.comanda_id), x.anuntata_de]), [["asteptata", 1, A_CERERE, CMD, "Mihai Productie"]]);
  egal("…cu sursa „producție”", unul(`SELECT sursa FROM receptii WHERE id = ${pr[0].id}`), "productie");
  egal("…cu un singur rând: 3.000 buc, pe linia comenzii de producție", randuri(pr[0].id), [[P1, 3000, "buc", L1]]);
  bine("…și scrie pe ea că e parțială", /Finalizare parțială din comanda de producție TFP-CP-1/.test(pr[0].observatii || ""), pr[0].observatii);
  egal("comanda de producție: tot în producție, fără recepție finală, fără dată de finalizare", cp(CP_LINII), { status: "in_productie", receptie_id: null, trimisa_depozit_la: null, data_finalizare: null });
  egal("comanda clientului: tot în producție", unul(`SELECT status FROM comenzi WHERE id = ${CMD}`), "in_productie");
  egal("cererea depozitului: tot confirmată", unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE}`), "confirmata");
  bine("agentul află din istoricul clientului", Number(unul(`SELECT COUNT(*) FROM interactiuni WHERE partener_id = ${CLIENT} AND subiect LIKE '%o parte din marfă e gata%' AND descriere LIKE '%3.000 buc%'`)) === 1);
  let lista = await GP.lista();
  const xl = lista.find((x) => x.fel === "receptie" && x.receptie_id === Number(pr[0].id)) || {};
  egal("e în lista „Gata din producție — de alocat”: 3.000 buc, pentru client", [xl.ramas, xl.stare, xl.productie_numar, xl.client], [3000, "gata în producție", "TFP-CP-1", "TFP Client SRL"]);
  let s = await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_LINII}`)[0]);
  egal("situația: 3.000 plecat și 7.000 rămas la pungi; folia neatinsă", s.linii.map((l) => [l.cheie, l.comandat, l.trimis, l.rest]), [[String(L1), 10000, 3000, 7000], [String(L2), 500, 0, 500]]);

  // ------------------------------------------------------------------------
  console.log("\n3. Ce nu se poate");
  r = await cer("post", `/productie/${CP_LINII}/partial`, MIHAI, { body: { [`cant_${L1}`]: "0", [`cant_${L2}`]: "" } });
  bine("zero sau gol: refuzat", /Scrie cât s-a terminat/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("post", `/productie/${CP_LINII}/partial`, MIHAI, { body: { [`cant_${L1}`]: "-5" } });
  bine("negativ: refuzat", /Scrie cât s-a terminat/.test(parametri(r).eroare || ""), unde(r));
  egal("…deci tot o singură recepție parțială", partiale(CP_LINII).length, 1);
  r = await cer("post", `/productie/${CP_GATA}/partial`, MIHAI, { body: { cant_0: "10" } });
  bine("de pe o comandă finalizată: refuzat", /deja finalizată/.test(parametri(r).eroare || "") && partiale(CP_GATA).length === 0, unde(r));
  r = await cer("post", `/productie/${CP_ANULATA}/partial`, MIHAI, { body: { cant_0: "10" } });
  bine("de pe una anulată: refuzat", /anulată/.test(parametri(r).eroare || "") && partiale(CP_ANULATA).length === 0, unde(r));
  r = await cer("post", `/productie/${CP_LINII}/partial`, null, { body: { [`cant_${L1}`]: "10" } });
  egal("fără cont: la autentificare, fără nimic făcut", [unde(r), partiale(CP_LINII).length], ["/login", 1]);
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_LINII), status: "__partial" } });
  egal("„Finalizată parțial” nu e o stare: nu se scrie pe comandă", [r.cod, cp(CP_LINII).status], [400, "in_productie"]);

  // ------------------------------------------------------------------------
  console.log("\n4. A doua parte, apoi depozitul preia prima");
  r = await cer("post", `/productie/${CP_LINII}/partial`, MIHAI, { body: { [`cant_${L1}`]: "2.000,5".replace(".", ""), [`cant_${L2}`]: "200" } });
  pr = partiale(CP_LINII);
  egal("a doua recepție parțială, cu ambele produse (virgula e zecimală)", randuri(pr[1].id), [[P1, 2000.5, "buc", L1], [P2, 200, "kg", L2]]);
  bine("mesajul le numește pe amândouă", /2\.000,5 buc TFP Punga curier, 200 kg TFP Folie/.test(parametri(r).ok || ""), parametri(r).ok);
  s = await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_LINII}`)[0]);
  egal("situația: 5.000,5 din 10.000 și 200 din 500", s.linii.map((l) => [l.trimis, l.rest]), [[5000.5, 4999.5], [200, 300]]);
  await REC.primesteTot(Number(pr[0].id));
  const f1 = await REC.finalizeaza(Number(pr[0].id), DEP);
  bine("depozitul preia prima recepție parțială", f1.ok === true, JSON.stringify(f1));
  egal("…dar cererea depozitului NU se închide: restul încă se face", unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE}`), "confirmata");
  egal("…și comanda clientului rămâne în producție", unul(`SELECT status FROM comenzi WHERE id = ${CMD}`), "in_productie");
  egal("…ca și comanda de producție", cp(CP_LINII).status, "in_productie");

  // ------------------------------------------------------------------------
  console.log("\n5. Pagina comenzii și lista");
  pag = await cer("get", `/productie/${CP_LINII}`, MIHAI);
  bine("pagina comenzii are caseta, cu butonul", pag.corp.includes("caseta-partial") && pag.corp.includes(`href="/productie/${CP_LINII}/partial"`), pag.cod);
  bine("…și istoricul: cât a plecat din cât", /5\.000,5 buc din 10\.000 buc/.test(pag.corp) && /200 kg din 500 kg/.test(pag.corp));
  bine("…cu recepțiile și starea lor în depozit", pag.corp.includes(`href="/depozit/receptie/${pr[0].id}"`) && /preluată în depozit/.test(pag.corp) && /de preluat în depozit/.test(pag.corp));
  bine("…fără „(anunțat …)” unde depozitul a primit exact cât s-a anunțat, sau n-a preluat încă", !/\(anunțat /.test(pag.corp), (pag.corp.match(/\(anunțat [^)]*\)/) || [])[0]);
  pag = await cer("get", `/productie/${CP_GATA}`, MIHAI);
  bine("o comandă finalizată fără trimiteri parțiale n-are caseta", !pag.corp.includes("caseta-partial"));
  pag = await cer("get", "/productie", MIHAI, { query: { q: PREFIX, status: "toate" } });
  const rand = (id) => { const i = pag.corp.indexOf(`data-stare="${id}"`); return i < 0 ? "" : pag.corp.slice(i, pag.corp.indexOf("</td>", i)); };
  bine("lista: comanda în lucru are „Finalizată parțial…”, imediat după „În producție”", /<option value="in_productie" selected>În producție<\/option><option value="__partial">Finalizată parțial…<\/option>/.test(rand(CP_LINII)), rand(CP_LINII).slice(0, 300));
  bine("…și cea nouă", rand(CP_PLAT).includes('value="__partial"'));
  bine("…dar nu cea finalizată, nici cea anulată", !rand(CP_GATA).includes("__partial") && !rand(CP_ANULATA).includes("__partial"));
  bine("…iar sub stare scrie cât a plecat, pe fiecare unitate de măsură", /nota-partial[^>]*title="Plecat în depozit prin 2 finalizări parțiale[^"]*">parțial: 5\.000,5 buc \+ 200 kg în depozit/.test(rand(CP_LINII)), rand(CP_LINII).slice(-200));
  bine("…doar unde a plecat ceva", !rand(CP_PLAT).includes("nota-partial"));
  bine("scriptul listei duce la pagina de finalizare parțială, cu întoarcere", pag.corp.includes('if (s.value === "__partial")') && pag.corp.includes('"/partial?inapoi="'));

  // ------------------------------------------------------------------------
  console.log("\n6. „Finalizată”: pleacă doar restul");
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_LINII), status: "finalizata" } });
  const c1 = cp(CP_LINII);
  bine("starea se schimbă și se deschide recepția finală", r.cod === 204 && c1.status === "finalizata" && Number(c1.receptie_id) > 0 && c1.trimisa_depozit_la === new Date().toISOString().slice(0, 10), JSON.stringify(c1));
  egal("…care nu e parțială", Number(unul(`SELECT partiala FROM receptii WHERE id = ${c1.receptie_id}`)), 0);
  egal("…cu restul: 4.999,5 buc și 300 kg", randuri(c1.receptie_id), [[P1, 4999.5, "buc", L1], [P2, 300, "kg", L2]]);
  bine("…și spune că e restul", /restul, după 2 finalizări parțiale/.test(unul(`SELECT observatii FROM receptii WHERE id = ${c1.receptie_id}`) || ""));
  egal("în total a plecat exact cât era comandat", q(`SELECT rl.productie_linie_id AS l, SUM(rl.cantitate_asteptata) AS s FROM receptii r JOIN receptii_linii rl ON rl.receptie_id = r.id WHERE r.comanda_productie_id = ${CP_LINII} AND r.stare <> 'anulata' GROUP BY 1 ORDER BY 1`).map((x) => [Number(x.l), Number(x.s)]), [[L1, 10000], [L2, 500]]);
  egal("comanda clientului: producție finalizată", unul(`SELECT status FROM comenzi WHERE id = ${CMD}`), "productie_finalizata");
  egal("cererea depozitului: gata", unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE}`), "gata");
  await REC.primesteTot(Number(pr[1].id));
  await REC.finalizeaza(Number(pr[1].id), DEP);
  egal("a doua parțială preluată, dar recepția finală încă așteaptă: cererea rămâne gata", unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE}`), "gata");
  bine("…iar comanda clientului nu sare peste recepția rămasă", ["productie_finalizata", "in_stoc_depozit"].includes(unul(`SELECT status FROM comenzi WHERE id = ${CMD}`)));
  await REC.primesteTot(Number(c1.receptie_id));
  await REC.finalizeaza(Number(c1.receptie_id), DEP);
  egal("recepția finală preluată: cererea e „intrată în stoc”", unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE}`), "primita");

  // ------------------------------------------------------------------------
  console.log("\n7. Comanda fără linii: din „nouă” direct în producție, apoi totul parțial");
  r = await cer("post", `/productie/${CP_PLAT}/partial`, MIHAI, { body: { cant_0: "400" } });
  egal("fără „înapoi”: pe pagina comenzii, cu mesajul", [unde(r).split("?")[0], /400 buc au plecat/.test(parametri(r).ok || "")], [`/productie/${CP_PLAT}`, true]);
  egal("comanda „nouă” din care s-a făcut o parte e în producție", cp(CP_PLAT).status, "in_productie");
  pr = partiale(CP_PLAT);
  egal("rândul recepției: 400 buc, fără linie de comandă", randuri(pr[0].id), [[P1, 400, "buc", null]]);
  r = await cer("post", `/productie/${CP_PLAT}/partial`, MIHAI, { body: { cant_0: "600" } });
  bine("exact restul se poate trimite, cu îndemnul de a finaliza", /Nu a mai rămas nimic de făcut: pune comanda pe „Finalizată”/.test(parametri(r).ok || ""), parametri(r).ok);
  egal("…comanda fiind tot în producție", cp(CP_PLAT).status, "in_productie");
  s = await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_PLAT}`)[0]);
  egal("după asta nu a mai rămas nimic de făcut", [s.linii.map((l) => [l.trimis, l.rest]), s.restTotal], [[[1000, 0]], 0]);
  await STADIU.laSchimbareaProductiei(CP_PLAT, "in_productie", "finalizata", { user: MIHAI });
  q(`UPDATE comenzi_productie SET status = 'finalizata' WHERE id = ${CP_PLAT}`);
  let c2 = cp(CP_PLAT);
  egal("„Finalizată” fără rest: nicio recepție nouă, doar semnul că s-a trimis", [c2.receptie_id, c2.trimisa_depozit_la !== null, Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${CP_PLAT}`))], [null, true, 2]);
  pag = await cer("get", `/productie/${CP_PLAT}`, MIHAI);
  bine("pagina spune că totul a plecat parțial și că e de preluat", /totul a plecat prin finalizări parțiale/.test(pag.corp) && /de preluat în depozit/.test(pag.corp) && !pag.corp.includes(`href="/productie/${CP_PLAT}/partial"`));
  r = await cer("post", `/productie/${CP_PLAT}/trimite-depozit`, MIHAI);
  egal("„Trimit marfa în depozit” nu mai are ce deschide", [unde(r), Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${CP_PLAT}`))], [`/productie/${CP_PLAT}`, 2]);
  await STADIU.laSchimbareaProductiei(CP_PLAT, "finalizata", "in_productie", { user: MIHAI });
  q(`UPDATE comenzi_productie SET status = 'in_productie' WHERE id = ${CP_PLAT}`);
  c2 = cp(CP_PLAT);
  egal("producția revine: semnul se șterge, recepțiile parțiale rămân", [c2.trimisa_depozit_la, c2.data_finalizare, partiale(CP_PLAT).map((x) => x.stare)], [null, null, ["asteptata", "asteptata"]]);
  // Butonul „Trimit marfa în depozit" pe o comandă gata, încă nemarcată ca
  // trimisă, din care totul plecase parțial: nu are ce recepție să deschidă,
  // deci rămâne pe pagina comenzii (nu pe „/depozit/receptie/null").
  q(`UPDATE comenzi_productie SET status = 'finalizata' WHERE id = ${CP_PLAT}`);
  r = await cer("post", `/productie/${CP_PLAT}/trimite-depozit`, MIHAI);
  egal("butonul de trimitere, când totul plecase parțial: pagina comenzii, nicio recepție nouă, comanda marcată trimisă",
    [unde(r), Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${CP_PLAT}`)), cp(CP_PLAT).trimisa_depozit_la !== null], [`/productie/${CP_PLAT}`, 2, true]);
  await STADIU.laSchimbareaProductiei(CP_PLAT, "finalizata", "in_productie", { user: MIHAI });
  q(`UPDATE comenzi_productie SET status = 'in_productie' WHERE id = ${CP_PLAT}`);

  // ------------------------------------------------------------------------
  console.log("\n8. Recepția parțială anulată în depozit");
  r = await cer("post", `/depozit/receptie/${pr[0].id}/anuleaza`, DEP);
  s = await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_PLAT}`)[0]);
  egal("cantitatea ei se întoarce la „rămas de făcut”", s.linii.map((l) => [l.trimis, l.rest]), [[600, 400]]);
  await STADIU.laSchimbareaProductiei(CP_PLAT, "in_productie", "finalizata", { user: MIHAI });
  q(`UPDATE comenzi_productie SET status = 'finalizata' WHERE id = ${CP_PLAT}`);
  c2 = cp(CP_PLAT);
  egal("…iar la „Finalizată” pleacă cei 400 rămași", [Number(c2.receptie_id) > 0, randuri(c2.receptie_id)], [true, [[P1, 400, "buc", null]]]);
  await STADIU.laSchimbareaProductiei(CP_PLAT, "finalizata", "in_productie", { user: MIHAI });
  egal("producția revine: recepția finală neatinsă se retrage, cea parțială nu", [cp(CP_PLAT).receptie_id, unul(`SELECT stare FROM receptii WHERE id = ${c2.receptie_id}`), partiale(CP_PLAT).map((x) => x.stare)], [null, "anulata", ["anulata", "asteptata"]]);
  // Lista nu numără recepția parțială anulată: în depozit au plecat 600, nu 1.000.
  q(`UPDATE comenzi_productie SET status = 'in_productie' WHERE id = ${CP_PLAT}`);
  pag = await cer("get", "/productie", MIHAI, { query: { q: PREFIX, status: "toate" } });
  bine("în listă, sub stare: doar ce a plecat cu adevărat (600 buc, o finalizare parțială)",
    /nota-partial[^>]*title="Plecat în depozit prin o finalizare parțială[^"]*">parțial: 600 buc în depozit/.test(rand(CP_PLAT)), rand(CP_PLAT).slice(-220));

  // ------------------------------------------------------------------------
  console.log("\n9. Cantități scrise ca text sau nescrise");
  egal("citirea cantității: număr, text cu spații și unitate, virgulă, gol", ["700000", "1 200 kg", "12,5", "", null].map((v) => STADIU.cantNr(v)), [700000, 1200, 12.5, 0, 0]);
  egal("„1 200 kg” se citește 1.200", (await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_TEXT}`)[0])).linii.map((l) => [l.comandat, l.rest]), [[1200, 1200]]);
  r = await cer("post", `/productie/${CP_TEXT}/partial`, MIHAI, { body: { cant_0: "200" } });
  await STADIU.laSchimbareaProductiei(CP_TEXT, "in_productie", "finalizata", { user: MIHAI });
  egal("…iar restul de la „Finalizată” e 1.000 kg", randuri(cp(CP_TEXT).receptie_id), [[P2, 1000, "kg", null]]);
  r = await cer("post", `/productie/${CP_NESCRIS}/partial`, MIHAI, { body: { cant_0: "75" } });
  bine("fără cantitate pe comandă: se trimite cât scrie omul", /75 buc au plecat/.test(parametri(r).ok || "") && randuri(partiale(CP_NESCRIS)[0].id)[0][1] === 75, unde(r));
  egal("…și, neștiind cât e comandat, recepția spune că restul e încă în lucru", partiale(CP_NESCRIS)[0].observatii, "Finalizare parțială din comanda de producție TFP-CP-4; restul e încă în lucru.");
  bine("…fără vreun „peste comandă” în mesaj", !/peste cât era comandat/.test(parametri(r).ok || ""), parametri(r).ok);
  pag = await cer("get", `/productie/${CP_NESCRIS}/partial`, MIHAI);
  bine("…iar pagina spune că acolo cantitatea e nescrisă", /name="cant_0"/.test(pag.corp) && /nescris/.test(pag.corp));
  // Registrul scrie miile cu virgulă: „67,200" sunt 67.200 de bucăți, nu 67,2.
  // Citită greșit, comanda n-ar fi putut trimite parțial mai mult de 67 de bucăți.
  pag = await cer("get", `/productie/${CP_REG}/partial`, MIHAI);
  egal("„67,200” buc sunt 67.200: atât scrie pagina la comandat și la rămas", [(pag.corp.match(/67\.200 buc/g) || []).length, /67,2 buc/.test(pag.corp)], [2, false]);
  r = await cer("post", `/productie/${CP_REG}/partial`, MIHAI, { body: { cant_0: "20000" } });
  bine("…din care pleacă 20.000", /20\.000 buc au plecat/.test(parametri(r).ok || ""), unde(r));
  egal("…și rămân 47.200", (await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_REG}`)[0])).linii.map((l) => [l.trimis, l.rest]), [[20000, 47200]]);
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_REG), status: "finalizata" } });
  egal("…și la „Finalizată” pleacă restul de 47.200", randuri(cp(CP_REG).receptie_id), [[P1, 47200, "buc", null]]);
  // „205(65 DONE)": cantitatea e 205; nota de după nu se lipește de ea.
  pag = await cer("get", `/productie/${CP_NOTA}/partial`, MIHAI);
  bine("„205(65 DONE)” sunt 205 bucăți", (pag.corp.match(/>205 buc</g) || []).length === 2, (pag.corp.match(/>\d[\d.]* buc</g) || []).join(" "));
  r = await cer("post", `/productie/${CP_NOTA}/partial`, MIHAI, { body: { cant_0: "65" } });
  egal("…din care 65 pleacă și rămân 140", (await STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${CP_NOTA}`)[0])).linii.map((l) => [l.comandat, l.trimis, l.rest]), [[205, 65, 140]]);
  // Tot ce era de făcut pleacă parțial și e preluat ÎNAINTE ca producția să
  // pună „Finalizată": cererea depozitului se închide abia atunci, fiindcă
  // până atunci comanda era încă în lucru.
  r = await cer("post", `/productie/${CP_NOTA}/partial`, MIHAI, { body: { cant_0: "140" } });
  for (const x of partiale(CP_NOTA)) {
    await REC.primesteTot(Number(x.id));
    await REC.finalizeaza(Number(x.id), DEP);
  }
  egal("totul plecat parțial și preluat, comanda încă în lucru: cererea rămâne deschisă", [partiale(CP_NOTA).map((x) => x.stare), unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE2}`)], [["finalizata", "finalizata"], "confirmata"]);
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_NOTA), status: "finalizata" } });
  egal("…iar la „Finalizată” nu se mai deschide nicio recepție și cererea e „intrată în stoc”", [cp(CP_NOTA).receptie_id, cp(CP_NOTA).trimisa_depozit_la !== null, Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${CP_NOTA}`)), unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE2}`)], [null, true, 2, "primita"]);
  // Fără nicio recepție preluată cererea nu se închide — de pildă dacă depozitul
  // le-a anulat pe toate: marfa n-a intrat nicăieri.
  q(`UPDATE receptii SET stare = 'anulata' WHERE comanda_productie_id = ${CP_NOTA}`);
  q(`UPDATE aprovizionari SET status = 'gata' WHERE id = ${A_CERERE2}`);
  egal("comandă gata, dar cu toate recepțiile anulate: cererea rămâne „gata”", [await STADIU.inchideCerereaDacaAIntratTot(CP_NOTA), unul(`SELECT status FROM aprovizionari WHERE id = ${A_CERERE2}`)], [false, "gata"]);
  // Cantitatea scrisă de ERP dintr-o cerere a depozitului, la kg: punctul e zecimală.
  pag = await cer("get", `/productie/${CP_KG}/partial`, MIHAI);
  bine("„847.625” kg rămân 847,625 kg, nu 847.625", (pag.corp.match(/>847,625 kg</g) || []).length === 2 && !/847\.625 kg/.test(pag.corp), (pag.corp.match(/>[\d.,]+ kg</g) || []).join(" "));
  r = await cer("post", `/productie/${CP_KG}/partial`, MIHAI, { body: { cant_0: "800" } });
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_KG), status: "finalizata" } });
  egal("…după 800 kg trimise parțial, restul e 47,625 kg", randuri(cp(CP_KG).receptie_id), [[P2, 47.625, "kg", null]]);

  // ------------------------------------------------------------------------
  console.log("\n10. Fără finalizări parțiale nu se schimbă nimic");
  q(`UPDATE comenzi_productie SET status = 'in_productie', receptie_id = NULL, trimisa_depozit_la = NULL WHERE id = ${CP_GATA}`);
  await STADIU.laSchimbareaProductiei(CP_GATA, "in_productie", "finalizata", { user: MIHAI });
  const c3 = cp(CP_GATA);
  egal("„Finalizată” deschide recepția cu toată cantitatea, neparțială", [randuri(c3.receptie_id), Number(unul(`SELECT partiala FROM receptii WHERE id = ${c3.receptie_id}`)), unul(`SELECT observatii FROM receptii WHERE id = ${c3.receptie_id}`)], [[[P1, 300, "buc", null]], 0, "Din comanda de producție TFP-CP-3"]);
  bine("starea pe care o dau comenzile de producție ține cont de recepțiile deschise",
    STADIU.stareDinProductie([{ status: "finalizata", receptie_id: 5, receptie_stare: "finalizata", receptii_deschise: 1 }]) === "productie_finalizata" &&
    STADIU.stareDinProductie([{ status: "finalizata", receptie_id: 5, receptie_stare: "finalizata", receptii_deschise: 0 }]) === null &&
    STADIU.stareDinProductie([{ status: "finalizata", receptie_id: null, cerere_stare: "gata", receptii_deschise: 0, receptii_preluate: 2 }]) === null &&
    STADIU.stareDinProductie([{ status: "in_productie", receptii_deschise: 1 }]) === "in_productie");

  // ------------------------------------------------------------------------
  console.log("\n10b. Cantitatea comenzii nu e plafon");
  const sit = async (id) => STADIU.situatiePartiala(q(`SELECT * FROM comenzi_productie WHERE id = ${id}`)[0]);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD2}, ${CLIENT}, '${PREFIX}-2', '${azi()}', 'in_productie')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${CMD2}, ${P1}, 100, 1), (${CMD2}, ${P2}, 50, 1)`);
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, data_initiere, client_text) VALUES
       (${CP_PESTE}, '${PREFIX}-CP-10', ${P1}, '${PREFIX} Punga curier', '1000', 'buc', 'in_productie', '${ziPlus(-1)}', 'SAMEDAY COURIER'),
       (${CP_PRIMIT}, '${PREFIX}-CP-12', ${P1}, '${PREFIX} Punga curier', '1000', 'buc', 'in_productie', '${ziPlus(-1)}', 'SAMEDAY COURIER')`);
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, data_initiere, partener_id, comanda_id) VALUES
       (${CP_PESTE2}, '${PREFIX}-CP-11', ${P1}, '${PREFIX} Punga curier', '100', 'buc', 'in_productie', '${ziPlus(-1)}', ${CLIENT}, ${CMD2})`);
  const M1 = Number(unul(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um, ordine) VALUES (${CP_PESTE2}, ${P1}, '${PREFIX} Punga curier', '100', 'buc', 1) RETURNING id`));
  const M2 = Number(unul(`INSERT INTO comenzi_productie_linii (comanda_id, produs_id, denumire, cantitate, um, ordine) VALUES (${CP_PESTE2}, ${P2}, '${PREFIX} Folie', '50', 'kg', 2) RETURNING id`));
  r = await cer("post", `/productie/${CP_PESTE}/partial`, MIHAI, { body: { cant_0: "700" } });
  r = await cer("post", `/productie/${CP_PESTE}/partial`, MIHAI, { body: { cant_0: "400" } });
  let ok = parametri(r).ok || "";
  bine("peste ce a rămas (400, când mai erau 300 de făcut): pleacă", unde(r).startsWith(`/productie/${CP_PESTE}?ok=`) && /400 buc au plecat în depozit/.test(ok) && !parametri(r).eroare, unde(r));
  bine("…iar mesajul spune cu cât e peste comandă", /E cu 100 buc peste cât era comandat\. /.test(ok), ok);
  bine("…și că nu a mai rămas nimic de făcut", /Nu a mai rămas nimic de făcut: pune comanda pe „Finalizată”/.test(ok), ok);
  pr = partiale(CP_PESTE);
  egal("recepția are cantitatea scrisă de producție, nu restul comenzii", pr.map((x) => randuri(x.id)), [[[P1, 700, "buc", null]], [[P1, 400, "buc", null]]]);
  egal("…pe ea scrie cu cât e peste comandă, fără „restul e încă în lucru”", pr[1].observatii, "Finalizare parțială din comanda de producție TFP-CP-10, cu 100 buc peste cât era comandat.");
  egal("cea de sub rest spune, ca înainte, că restul e în lucru", pr[0].observatii, "Finalizare parțială din comanda de producție TFP-CP-10; restul e încă în lucru.");
  s = await sit(CP_PESTE);
  egal("situația: 1.100 plecate din 1.000, restul e zero, nu negativ", [s.linii.map((l) => [l.comandat, l.trimis, l.rest]), s.restTotal], [[[1000, 1100, 0]], 0]);
  pag = await cer("get", `/productie/${CP_PESTE}/partial`, MIHAI);
  bine("pagina arată 1.100 plecate, zero rămase, și lasă în continuare să scrii", />1\.100 buc</.test(pag.corp) && />0 buc</.test(pag.corp) && /name="cant_0"/.test(pag.corp), (pag.corp.match(/>[\d.]+ buc</g) || []).join(" "));
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_PESTE), status: "finalizata" } });
  egal("„Finalizată”, după ce a plecat mai mult decât comanda: nicio recepție nouă", [cp(CP_PESTE).status, cp(CP_PESTE).receptie_id, cp(CP_PESTE).trimisa_depozit_la !== null, Number(unul(`SELECT COUNT(*) FROM receptii WHERE comanda_productie_id = ${CP_PESTE}`))], ["finalizata", null, true, 2]);
  // Două produse: unul trece de comandă, celălalt mai are de făcut.
  r = await cer("post", `/productie/${CP_PESTE2}/partial`, MIHAI, { body: { [`cant_${M1}`]: "150", [`cant_${M2}`]: "20" } });
  ok = parametri(r).ok || "";
  bine("la mai multe produse, mesajul numește produsul trecut de comandă", /E cu 50 buc TFP Punga curier peste cât era comandat\. /.test(ok), ok);
  bine("…și spune că, având folia de făcut, comanda rămâne în producție", /rămâne în producție până o pui pe „Finalizată”/.test(ok), ok);
  egal("recepția spune și ea, iar restul e încă în lucru", partiale(CP_PESTE2)[0].observatii, "Finalizare parțială din comanda de producție TFP-CP-11, cu 50 buc TFP Punga curier peste cât era comandat; restul e încă în lucru.");
  egal("agentul află din istoricul clientului, cu tot cu surplus", q(`SELECT descriere FROM interactiuni WHERE partener_id = ${CLIENT} AND descriere LIKE '%TFP-CP-11%' ORDER BY id`).map((x) => x.descriere),
    ["Producția (Mihai Productie) a trimis în depozit 150 buc TFP Punga curier, 20 kg TFP Folie din comanda de producție TFP-CP-11, cu 50 buc TFP Punga curier peste cât era comandat. Restul e încă în lucru."]);
  r = await cer("post", `/productie/${CP_PESTE2}/partial`, MIHAI, { body: { [`cant_${M2}`]: "30" } });
  egal("când pleacă exact restul, istoricul spune că e gata toată", q(`SELECT descriere FROM interactiuni WHERE partener_id = ${CLIENT} AND descriere LIKE '%TFP-CP-11%' ORDER BY id`).map((x) => x.descriere)[1],
    "Producția (Mihai Productie) a trimis în depozit 30 kg din comanda de producție TFP-CP-11. Cu asta, cantitatea comandată e gata toată.");
  egal("…și recepția nu mai spune că e ceva în lucru", partiale(CP_PESTE2)[1].observatii, "Finalizare parțială din comanda de producție TFP-CP-11.");
  s = await sit(CP_PESTE2);
  egal("situația pe cele două produse: 150 din 100 și 50 din 50, fără rest", s.linii.map((l) => [l.comandat, l.trimis, l.rest]), [[100, 150, 0], [50, 50, 0]]);

  // ------------------------------------------------------------------------
  console.log("\n10c. „Plecat” e ce a primit depozitul, nu ce s-a anunțat");
  const linieRec = (rid) => Number(unul(`SELECT id FROM receptii_linii WHERE receptie_id = ${rid} ORDER BY id LIMIT 1`));
  const primit = (lid) => Number(unul(`SELECT cantitate_primita FROM receptii_linii WHERE id = ${lid}`));
  r = await cer("post", `/productie/${CP_PRIMIT}/partial`, MIHAI, { body: { cant_0: "400" } });
  let pp = partiale(CP_PRIMIT);
  egal("anunțată, nepreluată: contează cu ce a anunțat producția", (await sit(CP_PRIMIT)).linii.map((l) => [l.trimis, l.rest]), [[400, 600]]);
  r = await cer("post", `/depozit/receptie/${pp[0].id}/linie/${linieRec(pp[0].id)}`, DEP, { body: { cantitate_primita: "430" } });
  bine("depozitul numără mai mult decât s-a anunțat: rândul se salvează fără motiv", !parametri(r).eroare && primit(linieRec(pp[0].id)) === 430, unde(r));
  bine("…și spune cât e în plus", /Rând salvat: 30 în plus față de cât s-a anunțat\./.test(parametri(r).ok || ""), parametri(r).ok);
  egal("numărată, dar încă nefinalizată: tot cu ce s-a anunțat", (await sit(CP_PRIMIT)).linii.map((l) => [l.trimis, l.rest]), [[400, 600]]);
  let fz = await REC.finalizeaza(Number(pp[0].id), DEP);
  s = await sit(CP_PRIMIT);
  egal("preluată: „plecat” e ce a primit depozitul (430), nu ce s-a anunțat (400)", [fz.ok, s.linii.map((l) => [l.trimis, l.rest])], [true, [[430, 570]]]);
  egal("…iar trimiterea ține minte și cât se anunțase", s.trimiteri.map((t) => t.randuri.map((x) => [x.cantitate, x.anuntat])), [[[430, 400]]]);
  pag = await cer("get", `/productie/${CP_PRIMIT}`, MIHAI);
  bine("pagina comenzii scrie 430 buc din 1.000", /430 buc din 1\.000 buc/.test(pag.corp));
  bine("…și, lângă trimitere, cât se anunțase", /430 buc <span class="mic">\(anunțat 400 buc\)<\/span>/.test(pag.corp), (pag.corp.match(/430 buc[^<]*<[^>]*>[^<]*/) || [])[0]);
  // A doua trimitere: respinsă de depozit (zero primit, cu motiv).
  r = await cer("post", `/productie/${CP_PRIMIT}/partial`, MIHAI, { body: { cant_0: "100" } });
  pp = partiale(CP_PRIMIT);
  r = await cer("post", `/depozit/receptie/${pp[1].id}/linie/${linieRec(pp[1].id)}`, DEP, { body: { cantitate_primita: "0", motiv: "marfa nu corespunde" } });
  fz = await REC.finalizeaza(Number(pp[1].id), DEP);
  egal("recepția respinsă de depozit nu e plecată din comandă", [fz.ok, unul(`SELECT stare FROM receptii_linii WHERE id = ${linieRec(pp[1].id)}`), (await sit(CP_PRIMIT)).linii.map((l) => [l.trimis, l.rest])], [true, "respinsa", [[430, 570]]]);
  // A treia: primită, dar deteriorată.
  r = await cer("post", `/productie/${CP_PRIMIT}/partial`, MIHAI, { body: { cant_0: "200" } });
  pp = partiale(CP_PRIMIT);
  r = await cer("post", `/depozit/receptie/${pp[2].id}/linie/${linieRec(pp[2].id)}`, DEP, { body: { cantitate_primita: "200", conditie: "deteriorat" } });
  fz = await REC.finalizeaza(Number(pp[2].id), DEP);
  egal("nici cea primită deteriorată: tot de făcut rămâne", [fz.ok, (await sit(CP_PRIMIT)).linii.map((l) => [l.trimis, l.rest])], [true, [[430, 570]]]);
  // Un rând numărat și apoi respins (cantitatea rămâne scrisă pe el): tot neplecat.
  q(`UPDATE receptii_linii SET cantitate_primita = 100 WHERE id = ${linieRec(pp[1].id)}`);
  egal("rândul respins nu e plecat nici când are o cantitate scrisă pe el", (await sit(CP_PRIMIT)).linii.map((l) => [l.trimis, l.rest]), [[430, 570]]);
  // A patra: luată „cum a fost anunțată", dar pe palet se pune mai mult.
  r = await cer("post", `/productie/${CP_PRIMIT}/partial`, MIHAI, { body: { cant_0: "50" } });
  pp = partiale(CP_PRIMIT);
  const lid4 = linieRec(pp[3].id);
  const gata4 = await require(path.join(RAD, "modules", "gata-productie.js")).receptiaGata(lid4, DEP);
  egal("luată cum a fost anunțată: 50 primite", [gata4.ok, primit(lid4)], [true, 50]);
  const CT = require(path.join(RAD, "modules", "ct-park.js"));
  const nrRec4 = unul(`SELECT numar FROM receptii WHERE id = ${pp[3].id}`);
  const miscari4 = () => q(`SELECT cantitate, observatii FROM miscari_stoc WHERE produs_id = ${P1} AND document_ref = '${nrRec4}' ORDER BY id`).map((x) => [Number(x.cantitate), x.observatii]);
  await CT.puneMarfa({ user: DEP }, { produs_id: P1, um: "buc", receptie_id: Number(pp[3].id), receptie_linie_id: lid4 }, [[]], 30);
  egal("30 din 50 puse pe palet: recepția rămâne la 50", [primit(lid4), miscari4().length], [50, 1]);
  await CT.puneMarfa({ user: DEP }, { produs_id: P1, um: "buc", receptie_id: Number(pp[3].id), receptie_linie_id: lid4 }, [[]], 30);
  egal("încă 30, deci 60 pe paleți: recepția ia cantitatea de pe paleți", primit(lid4), 60);
  egal("…iar diferența intră în mișcările de stoc, sub numărul recepției", miscari4(), [[50, null], [10, "pe paleți e mai mult decât scria recepția: 60 față de 50 buc · Om Depozit"]]);
  egal("…și comanda de producție arată 490 plecate", (await sit(CP_PRIMIT)).linii.map((l) => [l.trimis, l.rest]), [[490, 510]]);
  await CT.puneMarfa({ user: DEP }, { produs_id: P1, um: "buc", receptie_id: Number(pp[1].id), receptie_linie_id: linieRec(pp[1].id) }, [[]], 5);
  egal("pe un rând respins recepția nu se schimbă, orice s-ar pune pe palet", [primit(linieRec(pp[1].id)), (await sit(CP_PRIMIT)).linii.map((l) => l.trimis)], [100, [490]]);
  pag = await cer("get", "/productie", MIHAI, { query: { q: PREFIX, status: "toate" } });
  bine("în listă, sub stare: ce a primit depozitul din cele patru trimiteri", /nota-partial[^>]*title="Plecat în depozit prin 4 finalizări parțiale[^"]*">parțial: 490 buc în depozit/.test(rand(CP_PRIMIT)), rand(CP_PRIMIT).slice(-220));
  r = await cer("post", "/productie/stare", MIHAI, { body: { comanda_id: String(CP_PRIMIT), status: "finalizata" } });
  egal("la „Finalizată” pleacă restul socotit din ce a primit depozitul: 510", randuri(cp(CP_PRIMIT).receptie_id), [[P1, 510, "buc", null]]);

  // ------------------------------------------------------------------------
  console.log("\n11. În browser: alegerea din listă deschide pagina, fără să schimbe starea");
  q(`UPDATE comenzi_productie SET status = 'in_productie', receptie_id = NULL, trimisa_depozit_la = NULL, data_finalizare = NULL WHERE id = ${CP_GATA}`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (SELECT id FROM receptii WHERE comanda_productie_id = ${CP_GATA})`);
  q(`DELETE FROM receptii WHERE comanda_productie_id = ${CP_GATA}`);
  const fs = require("fs");
  const { chromium } = require("playwright");
  const STIL = fs.readFileSync(path.join(RAD, "public", "style.css"), "utf8");
  const browser = await chromium.launch();
  const erori = [];
  const cereri = [];
  try {
    const p = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
    p.on("pageerror", (e) => erori.push(e.message));
    await p.route("http://erp.test/**", async (rt) => {
      const u = new URL(rt.request().url());
      cereri.push(rt.request().method() + " " + u.pathname);
      if (u.pathname.endsWith("/style.css")) return rt.fulfill({ status: 200, contentType: "text/css", body: STIL });
      if (u.pathname === "/productie" && rt.request().method() === "GET") {
        const h = await cer("get", "/productie", MIHAI, { query: Object.fromEntries(u.searchParams) });
        return rt.fulfill({ status: 200, contentType: "text/html", body: h.corp });
      }
      if (u.pathname === `/productie/${CP_GATA}/partial` && rt.request().method() === "GET") {
        const h = await cer("get", `/productie/${CP_GATA}/partial`, MIHAI, { query: Object.fromEntries(u.searchParams) });
        return rt.fulfill({ status: 200, contentType: "text/html", body: h.corp });
      }
      if (u.pathname === `/productie/${CP_GATA}/partial` && rt.request().method() === "POST") {
        const h = await cer("post", `/productie/${CP_GATA}/partial`, MIHAI, { body: Object.fromEntries(new URLSearchParams(rt.request().postData() || "")) });
        // Redirecționarea serverului, jucată din pagină: cererile de după un 302
        // servit de test nu mai trec prin `route`.
        egal("trimiterea răspunde cu redirecționare", h.cod, 302);
        return rt.fulfill({ status: 200, contentType: "text/html", body: `<script>location.replace(${JSON.stringify(unde(h))})</script>` });
      }
      return rt.fulfill({ status: 204, body: "" });
    });
    await p.goto(`http://erp.test/productie?q=${PREFIX}&status=toate`);
    const sel = `select[data-stare="${CP_GATA}"]`;
    egal("comanda e „în producție” și are alegerea „Finalizată parțial…”", [await p.inputValue(sel), await p.$$eval(`${sel} option`, (o) => o.map((x) => x.value))], ["in_productie", ["noua", "in_productie", "__partial", "finalizata", "facturata", "anulata"]]);
    await Promise.all([p.waitForURL(/\/partial\?inapoi=/), p.selectOption(sel, "__partial")]);
    const u2 = new URL(p.url());
    egal("alegerea deschide pagina de finalizare parțială, cu întoarcere în aceeași listă", [u2.pathname, u2.searchParams.get("inapoi")], [`/productie/${CP_GATA}/partial`, `/productie?q=${PREFIX}&status=toate`]);
    bine("…fără să ceară schimbarea stării", !cereri.includes("POST /productie/stare"), cereri.filter((c) => c.startsWith("POST")).join(", "));
    egal("…și starea comenzii a rămas", cp(CP_GATA).status, "in_productie");
    await p.fill('input[name="cant_0"]', "120");
    await Promise.all([p.waitForURL(/\/productie\?q=.*ok=/), p.click(`form[action="/productie/${CP_GATA}/partial"] button[type="submit"]`)]);
    bine("după trimitere se întoarce în listă, cu mesajul", /120 buc au plecat în depozit/.test(await p.textContent("p.badge.verde")), p.url());
    bine("…unde sub stare scrie cât a plecat", /parțial: 120 buc în depozit/.test(await p.textContent(`td:has(${sel})`)));
    egal("…iar comanda e tot în producție, cu o recepție parțială de 120", [await p.inputValue(sel), partiale(CP_GATA).map((r) => randuri(r.id))], ["in_productie", [[[P1, 120, "buc", null]]]]);
    if (process.env.POZA) await p.screenshot({ path: process.env.POZA, fullPage: false });
  } finally {
    await browser.close();
  }
  egal("nicio eroare de JavaScript", erori, []);

  curata();
  console.log(esecuri ? `\n${esecuri} verificări căzute.` : "\nToate verificările trec.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
