"use strict";
// „Gata din producție — de alocat" în Depozit → Intrare marfă.
//
// CE A CERUT VALI, 09.11.2026:
//   „Produsele gata din producție trebuie să intre în depozit, iar în Intrare
//    marfă să fie lista cu produse gata, de unde le bagi automat pe rafturi
//    sau le dai direct în fulfillment sau direct la livrare."
//   „La finalizare comandă, când schimbi statusul, să se ducă în depozit,
//    unde va aștepta alocare pe depozit, fulfillment sau livrare."
//   Și, cu poza cererilor „intrată în stoc": „Astea intrate în stoc e stoc
//    CT-Park și ar trebui alocate pe rafturi; nu există alt stoc decât cel din
//    CT-Park."
//
// CE APĂRĂ:
//   • FINALIZATĂ → RECEPȚIE: comanda de producție pornită recent, fără
//     comandă de client sau cerere (Sameday, DELIVERY SOLUTIONS…), deschide
//     recepția din producție; una veche din registru (peste 90 de zile) nu.
//   • LISTA din Intrare marfă: recepțiile din producție cu marfă fără palet,
//     cererile gata din producție fără recepție și cererile vechi „intrată în
//     stoc" fără palet. Nu: cererile scoase din listă, cele cu tot pus.
//   • PE RAFT: recepția nenumărată se ia cum a anunțat-o producția, se
//     finalizează, iar Intrarea se deschide completată; ce se pune scade din
//     listă.
//   • DIRECT: paletul fără loc, legat de recepție/cerere, și ieșirea deschisă
//     cu el bifat; lista nu-l mai arată.
//   • CEREREA PUSĂ PE RAFT devine „intrată în stoc", iar comanda clientului
//     merge mai departe când stocul o acoperă.
//   • „NU MAI E DE ALOCAT" cere motiv și nu face stoc.
//   • „INTRĂ ÎN STOC" din De aprovizionat deschide Intrarea completată, fără
//     mișcare în tabela veche.
//   • CINE N-ARE INTRAREA MARFĂ nu folosește butoanele.
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
for (const m of ["gata-productie", "ct-park", "warehouse", "receptie"]) require(path.join(RAD, "modules", m + ".js")).register(router);
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
const P1 = 97701, P2 = 97702, P3 = 97703;
const CLIENT = 97711, FURNIZOR = 97712;
const CMD = 97721, CMD_LIVRATA = 97722;
const CP_NOU = 97731, CP_VECHI = 97732;
// Cererea gata are id-ul cel mai mare: lista o pune totuși înaintea celor vechi.
const A_GATA = 97749, A_VECHE = 97742, A_VECHE2 = 97743, A_INCHISA = 97744, A_PUSA = 97745, A_TERT = 97746, A_CU_RECEPTIE = 97748, A_LIVRATA = 97747;
const PREFIX = "TGP";

function curata() {
  const cp = [CP_NOU, CP_VECHI].join(",");
  const aprov = [A_GATA, A_VECHE, A_VECHE2, A_INCHISA, A_PUSA, A_TERT, A_CU_RECEPTIE, A_LIVRATA].join(",");
  const rec = q(`SELECT id FROM receptii WHERE comanda_productie_id IN (${cp}) OR aprovizionare_id IN (${aprov}) OR numar LIKE 'TGP-%'`).map((x) => Number(x.id));
  const r = rec.join(",") || "0";
  const pal = q(`SELECT id FROM ct_paleti WHERE receptie_id IN (${r}) OR aprovizionare_id IN (${aprov}) OR produs_id IN (${P1}, ${P2}, ${P3})`).map((x) => Number(x.id));
  const p = pal.join(",") || "0";
  q(`DELETE FROM ct_iesiri_linii WHERE iesire_id IN (SELECT id FROM ct_iesiri WHERE palet_id IN (${p}))`);
  q(`DELETE FROM ct_iesiri WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_ocupari WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_palet_linii WHERE palet_id IN (${p})`);
  q(`DELETE FROM ct_paleti WHERE id IN (${p})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${P1}, ${P2}, ${P3})`);
  q(`DELETE FROM stoc_locuri WHERE receptie_id IN (${r}) OR produs_id IN (${P1}, ${P2}, ${P3})`);
  q(`DELETE FROM receptii_linii_locuri WHERE linie_id IN (SELECT id FROM receptii_linii WHERE receptie_id IN (${r}))`);
  q(`DELETE FROM receptii_linii WHERE receptie_id IN (${r})`);
  q(`DELETE FROM receptii WHERE id IN (${r})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id IN (${cp})`);
  q(`DELETE FROM comenzi_productie WHERE id IN (${cp})`);
  q(`DELETE FROM aprovizionari WHERE id IN (${aprov}) OR produs_id IN (${P1}, ${P2}, ${P3})`);
  q(`DELETE FROM rezervari_stoc WHERE produs_id IN (${P1}, ${P2}, ${P3})`);
  try { q(`DELETE FROM comenzi_istoric WHERE comanda_id IN (${CMD}, ${CMD_LIVRATA})`); } catch (_) { /* tabela poate lipsi */ }
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${CMD}, ${CMD_LIVRATA})`);
  q(`DELETE FROM comenzi WHERE id IN (${CMD}, ${CMD_LIVRATA})`);
  q(`DELETE FROM produse WHERE id IN (${P1}, ${P2}, ${P3})`);
  q(`DELETE FROM interactiuni WHERE partener_id IN (${CLIENT}, ${FURNIZOR})`);
  q(`DELETE FROM parteneri WHERE id IN (${CLIENT}, ${FURNIZOR})`);
}

// Un loc liber din CT-Park, altul decât cele deja folosite în test.
function locLiber(afara) {
  return q(`SELECT l.id, l.rand_id, l.adresa FROM ct_locuri l JOIN ct_randuri rr ON rr.id = l.rand_id AND rr.activ = 1
             WHERE COALESCE(l.blocat, 0) = 0
               AND NOT EXISTS (SELECT 1 FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL WHERE o.loc_id = l.id)
               AND l.id NOT IN (${(afara || []).join(",") || 0})
             ORDER BY l.id LIMIT 1`)[0];
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
const ziPlus = (n) => new Date(Date.parse(azi() + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

(async () => {
  curata();
  const idUser = Number(unul("SELECT id FROM utilizatori ORDER BY id LIMIT 1"));
  const DEP = { id: idUser, nume: "Om Depozit", rol: "depozit", sectiuni: "" };
  const MIHAI = { id: idUser, nume: "Mihai Productie", rol: "productie", sectiuni: "" };
  const AGENT = { id: idUser, nume: "Agent", rol: "vanzari", sectiuni: "/crm" };

  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${CLIENT}, 'client', '${PREFIX} Client SRL'), (${FURNIZOR}, 'furnizor', '${PREFIX} Furnizor SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P1}, 'TGP-1', '${PREFIX} Folie manuala 12my', 'buc'), (${P2}, 'TGP-2', '${PREFIX} Pungă curier', 'buc'), (${P3}, 'TGP-3', '${PREFIX} Bandă', 'buc')`);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD}, ${CLIENT}, '${PREFIX}-1', '${azi()}', 'productie_finalizata')`);
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${CMD}, ${P2}, 20, 1)`);
  q(`INSERT INTO comenzi (id, partener_id, numar, data, status) VALUES (${CMD_LIVRATA}, ${CLIENT}, '${PREFIX}-2', '2026-10-01', 'livrata')`);
  // Producție scrisă direct în registru, fără comandă de client: una nouă și
  // una veche (din registrul adus din Excel).
  q(`INSERT INTO comenzi_productie (id, numar, produs_id, tip_produs, cantitate, um, status, data_initiere, client_text) VALUES
       (${CP_NOU}, '${PREFIX}-CP-1', ${P1}, '${PREFIX} Folie manuala 12my', '50', 'buc', 'in_productie', '${ziPlus(-5)}', 'SAMEDAY COURIER'),
       (${CP_VECHI}, '${PREFIX}-CP-2', ${P1}, '${PREFIX} Folie manuala 12my', '70', 'buc', 'in_productie', '2026-01-10', 'SAMEDAY COURIER')`);
  // Cererile depozitului.
  q(`INSERT INTO aprovizionari (id, comanda_id, produs_id, cantitate, sursa, status, creata_la) VALUES
       (${A_GATA}, ${CMD}, ${P2}, 20, 'productie', 'gata', '2026-11-08'),
       (${A_VECHE}, NULL, ${P3}, 30, 'productie', 'primita', '2026-10-20'),
       (${A_VECHE2}, NULL, ${P3}, 12, 'productie', 'primita', '2026-10-21'),
       (${A_INCHISA}, NULL, ${P3}, 5, 'productie', 'primita', '2026-10-22'),
       (${A_PUSA}, NULL, ${P3}, 8, 'productie', 'primita', '2026-10-23'),
       (${A_CU_RECEPTIE}, NULL, ${P3}, 9, 'productie', 'gata', '2026-11-07'),
       (${A_LIVRATA}, ${CMD_LIVRATA}, ${P3}, 14, 'productie', 'primita', '2026-10-02')`);
  // Cererea cu recepția ei deschisă se alocă din recepție, nu de două ori.
  q(`INSERT INTO receptii (numar, sursa, aprovizionare_id, data, stare) VALUES ('TGP-REC-CERERE', 'productie', ${A_CU_RECEPTIE}, '${azi()}', 'asteptata')`);
  q(`INSERT INTO aprovizionari (id, comanda_id, produs_id, cantitate, sursa, status, furnizor_id, creata_la) VALUES (${A_TERT}, NULL, ${P3}, 40, 'tert', 'confirmata', ${FURNIZOR}, '2026-11-01')`);
  q(`UPDATE aprovizionari SET ct_inchis_la = '2026-11-01 10:00:00', ct_motiv = 'era deja pe raft' WHERE id = ${A_INCHISA}`);
  q(`INSERT INTO ct_paleti (cod, produs_id, cantitate, um, aprovizionare_id, data_intrare) VALUES ('TGP-PUS-1', ${P3}, 8, 'buc', ${A_PUSA}, '${azi()}')`);
  // O recepție din producție deja numărată, cu un rând bun și unul stricat:
  // de alocat e doar cel bun.
  const rStricat = Number(unul(`INSERT INTO receptii (numar, sursa, data, stare) VALUES ('TGP-REC-NUMARATA', 'productie', '${azi()}', 'finalizata') RETURNING id`));
  q(`INSERT INTO receptii_linii (receptie_id, produs_id, cantitate_asteptata, cantitate_primita, um, stare, conditie) VALUES
       (${rStricat}, ${P3}, 6, 6, 'buc', 'primita', 'deteriorata'), (${rStricat}, ${P2}, 4, 4, 'buc', 'primita', 'bun')`);

  // ------------------------------------------------------------------------
  console.log("1. „Finalizată” trimite marfa în depozit");
  await STADIU.laSchimbareaProductiei(CP_NOU, "in_productie", "finalizata", { user: MIHAI });
  const rNou = Number(unul(`SELECT receptie_id FROM comenzi_productie WHERE id = ${CP_NOU}`));
  bine("producția nouă, fără comandă de client: recepție din producție", rNou > 0 && unul(`SELECT sursa FROM receptii WHERE id = ${rNou}`) === "productie", rNou);
  egal("…cu produsul și cantitatea anunțate", q(`SELECT produs_id, cantitate_asteptata FROM receptii_linii WHERE receptie_id = ${rNou}`).map((x) => [Number(x.produs_id), Number(x.cantitate_asteptata)]), [[P1, 50]]);
  await STADIU.laSchimbareaProductiei(CP_VECHI, "in_productie", "finalizata", { user: MIHAI });
  egal("producția veche din registru (peste 90 de zile): fără recepție", unul(`SELECT receptie_id FROM comenzi_productie WHERE id = ${CP_VECHI}`), null);
  bine("pornitaRecent: fără dată = nouă; 10.01.2026 = veche; 05.11.2026 (zz.ll.aaaa) = nouă",
    STADIU.pornitaRecent({}, "2026-11-09") && !STADIU.pornitaRecent({ data_initiere: "2026-01-10" }, "2026-11-09") && STADIU.pornitaRecent({ data_initiere: "05.11.2026" }, "2026-11-09"));
  egal("rândul adus din registrul Excel fără dată e istorie, chiar dacă importul e recent; cu dată recentă, nu",
    [STADIU.pornitaRecent({ sursa: "import_registru" }, "2026-11-09"), STADIU.pornitaRecent({ sursa: "import_excel", creat_la: "2026-11-01 10:00:00" }, "2026-11-09"),
     STADIU.pornitaRecent({ sursa: "import_excel", data_initiere: "2026-11-01" }, "2026-11-09"), STADIU.pornitaRecent({ sursa: "manual", creat_la: "2026-11-01 10:00:00" }, "2026-11-09")],
    [false, false, true, true]);

  // ------------------------------------------------------------------------
  console.log("\n2. Lista din Intrare marfă");
  let lista = await GP.lista();
  const chei = lista.map((x) => x.fel + ":" + (x.fel === "receptie" ? "r" + x.receptie_id : x.id));
  const lid = Number(unul(`SELECT id FROM receptii_linii WHERE receptie_id = ${rNou}`));
  egal("recepția nouă, cererea gata, apoi cererile vechi (fără cea scoasă, cea pusă și cea a unei comenzi livrate)",
    chei.filter((k) => k === "receptie:r" + rNou || [A_GATA, A_VECHE, A_VECHE2, A_INCHISA, A_PUSA, A_TERT, A_CU_RECEPTIE, A_LIVRATA].some((a) => k === "cerere:" + a)),
    ["receptie:r" + rNou, "cerere:" + A_GATA, "cerere:" + A_VECHE, "cerere:" + A_VECHE2]);
  egal("recepția numărată: doar rândul bun e de alocat", lista.filter((x) => x.fel === "receptie" && x.receptie_id === rStricat).map((x) => [x.produs_id, x.ramas, x.stare]), [[P2, 4, "numărată, de alocat"]]);
  const xr = lista.find((x) => x.fel === "receptie" && x.receptie_id === rNou) || {};
  egal("rândul recepției: 50 buc, gata în producție, producția TGP-CP-1, pentru Sameday", [xr.ramas, xr.stare, xr.productie_numar, xr.client], [50, "gata în producție", "TGP-CP-1", "SAMEDAY COURIER"]);
  let pag = await cer("get", "/stocuri/ct-park/intrare", DEP);
  bine("pagina Intrare marfă are secțiunea, cu numărul de rânduri", /id="gata-productie"/.test(pag.corp) && /Gata din producție — de alocat <span class="badge galben">\d+<\/span>/.test(pag.corp), pag.cod);
  bine("…cu butoanele rândului de recepție", pag.corp.includes(`action="/stocuri/ct-park/gata/receptie/${lid}/raft"`) && pag.corp.includes(`action="/stocuri/ct-park/gata/receptie/${lid}/livrare"`));
  bine("…„Nu mai e de alocat” doar la cererile vechi", pag.corp.includes(`action="/stocuri/ct-park/gata/cerere/${A_VECHE}/inchide"`) && !pag.corp.includes(`action="/stocuri/ct-park/gata/cerere/${A_GATA}/inchide"`));
  bine("…iar la cererea legată de comandă, „livrare pe comanda clientului” e aleasă", new RegExp(`gata/cerere/${A_GATA}/livrare"[\\s\\S]{0,400}<option value="comanda" selected>`).test(pag.corp));

  // ------------------------------------------------------------------------
  console.log("\n3. Pune pe raft, din recepția din producție");
  let r = await cer("post", `/stocuri/ct-park/gata/receptie/${lid}/raft`, AGENT);
  egal("fără Intrare marfă: înapoi, fără nimic făcut", [unde(r), unul(`SELECT stare FROM receptii WHERE id = ${rNou}`)], ["/stocuri/ct-park", "asteptata"]);
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lid}/raft`, DEP);
  egal("deschide Intrarea cu rândul recepției", unde(r), `/stocuri/ct-park/intrare?receptie_linie=${lid}`);
  egal("recepția e luată cum a anunțat-o producția și finalizată",
    [unul(`SELECT stare FROM receptii WHERE id = ${rNou}`), unul(`SELECT stare FROM receptii_linii WHERE id = ${lid}`), Number(unul(`SELECT cantitate_primita FROM receptii_linii WHERE id = ${lid}`)), unul(`SELECT conditie FROM receptii_linii WHERE id = ${lid}`)],
    ["finalizata", "primita", 50, "bun"]);
  pag = await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { receptie_linie: String(lid) } });
  bine("Intrarea vine completată: 50 buc de pus, produs finit", /de pus acum: <strong>50 buc<\/strong>/.test(pag.corp) && pag.corp.includes('<option value="produse finite" selected>'), pag.cod);
  bine("…și fără lista de alocat deasupra (ești deja pe un rând)", !/id="gata-productie"/.test(pag.corp));
  const loc1 = locLiber();
  r = await cer("post", "/stocuri/ct-park/intrare", DEP, {
    body: { produs_id: String(P1), um: "buc", categorie: "produse finite", receptie_id: String(rNou), receptie_linie_id: String(lid),
      "loc_ids[]": String(loc1.id), "loc_rand[]": String(loc1.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "30" },
  });
  bine("paletul se pune și duce la etichete", /\/stocuri\/ct-park\/etichete\?paleti=\d+/.test(unde(r)), unde(r));
  lista = await GP.lista();
  const xr2 = lista.find((x) => x.fel === "receptie" && x.id === lid) || {};
  egal("în listă rămân 20, cu „alocat deja 30”, numărată", [xr2.ramas, xr2.pus, xr2.stare], [20, 30, "numărată, de alocat"]);

  // ------------------------------------------------------------------------
  console.log("\n4. Restul, direct în fulfillment");
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lid}/livrare`, DEP, { body: {} });
  bine("fără destinație: mesaj, nimic făcut", /gata_eroare=/.test(unde(r)) && /Alege unde pleacă/.test(parametri(r).gata_eroare || ""), unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lid}/livrare`, DEP, { body: { destinatie: "comanda" } });
  bine("la comandă fără comandă aleasă: mesaj", /Alege comanda clientului/.test(parametri(r).gata_eroare || ""), unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/receptie/${lid}/livrare`, DEP, { body: { destinatie: "fulfillment" } });
  const pr = parametri(r);
  const pal2 = q(`SELECT id, cantitate FROM ct_paleti WHERE receptie_linie_id = ${lid} ORDER BY id`)[1] || {};
  egal("paletul cu restul de 20, fără loc", [Number(pal2.cantitate), Number(unul(`SELECT COUNT(*) FROM ct_ocupari WHERE palet_id = ${pal2.id || 0}`))], [20, 0]);
  bine("se deschide ieșirea cu el bifat, spre fulfillment", unde(r).startsWith("/stocuri/ct-park/iesire?") && pr.palet === String(pal2.id) && pr.destinatie === "fulfillment", unde(r));
  bine("rândul nu mai e în listă", !(await GP.lista()).some((x) => x.fel === "receptie" && x.id === lid));

  // ------------------------------------------------------------------------
  console.log("\n5. Cererea gata din producție, pe raft");
  r = await cer("post", `/stocuri/ct-park/gata/cerere/${A_GATA}/raft`, DEP);
  egal("deschide Intrarea cu cererea", unde(r), `/stocuri/ct-park/intrare?aprovizionare=${A_GATA}`);
  pag = await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { aprovizionare: String(A_GATA) } });
  bine("spune din ce cerere și cât e de pus", pag.corp.includes(`Din cererea #${A_GATA} (gata din producție)`) && /de pus acum: <strong>20 buc<\/strong>/.test(pag.corp), pag.cod);
  bine("produsul cererii e ales, produs finit, cantitatea pe primul palet",
    pag.corp.includes(`name="produs_id" value="${P2}" checked`) && pag.corp.includes('<option value="produse finite" selected>') && pag.corp.includes('name="loc_cantitate[]" value="20"'));
  bine("legătura cu cererea pleacă în formular", pag.corp.includes(`name="aprovizionare_id" value="${A_GATA}"`));
  const loc2 = locLiber([loc1.id]);
  r = await cer("post", "/stocuri/ct-park/intrare", DEP, {
    body: { produs_id: String(P2), um: "buc", categorie: "produse finite", aprovizionare_id: String(A_GATA),
      "loc_ids[]": String(loc2.id), "loc_rand[]": String(loc2.rand_id), "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "20" },
  });
  bine("paletul se pune", /\/stocuri\/ct-park\/etichete\?paleti=\d+/.test(unde(r)), unde(r));
  egal("paletul e legat de cerere", q(`SELECT cantitate FROM ct_paleti WHERE aprovizionare_id = ${A_GATA}`).map((x) => Number(x.cantitate)), [20]);
  egal("cererea e „intrată în stoc”", unul(`SELECT status FROM aprovizionari WHERE id = ${A_GATA}`), "primita");
  egal("comanda clientului: marfa o acoperă, e în stoc depozit", unul(`SELECT status FROM comenzi WHERE id = ${CMD}`), "in_stoc_depozit");
  bine("cererea nu mai e în listă", !(await GP.lista()).some((x) => x.fel === "cerere" && x.id === A_GATA));

  // ------------------------------------------------------------------------
  console.log("\n6. Cererea veche „intrată în stoc”, direct la livrare pe comandă");
  r = await cer("post", `/stocuri/ct-park/gata/cerere/${A_VECHE}/livrare`, DEP, { body: { destinatie: "comanda", comanda_id: String(CMD) } });
  const pv = parametri(r);
  const palV = q(`SELECT id, cantitate FROM ct_paleti WHERE aprovizionare_id = ${A_VECHE}`)[0] || {};
  egal("paletul de 30, fără loc, legat de cerere", [Number(palV.cantitate), Number(unul(`SELECT COUNT(*) FROM ct_ocupari WHERE palet_id = ${palV.id || 0}`))], [30, 0]);
  egal("ieșirea: paletul, comanda, motivul", [pv.palet, pv.destinatie, pv.comanda_id, pv.motiv], [String(palV.id), "comanda", String(CMD), `livrare directă din cererea #${A_VECHE}`]);
  r = await cer("post", `/stocuri/ct-park/gata/cerere/${A_VECHE}/livrare`, DEP, { body: { destinatie: "fulfillment" } });
  bine("a doua oară nu se mai poate: totul are palet", /are deja palet/.test(parametri(r).gata_eroare || ""), unde(r));

  // ------------------------------------------------------------------------
  console.log("\n7. „Nu mai e de alocat”");
  r = await cer("post", `/stocuri/ct-park/gata/cerere/${A_VECHE2}/inchide`, DEP, { body: { motiv: " " } });
  bine("fără motiv: refuzat", /Scrie de ce/.test(parametri(r).gata_eroare || "") && unul(`SELECT ct_inchis_la FROM aprovizionari WHERE id = ${A_VECHE2}`) === null, unde(r));
  r = await cer("post", `/stocuri/ct-park/gata/cerere/${A_VECHE2}/inchide`, DEP, { body: { motiv: "e deja pe raft, pusă de mână" } });
  bine("cu motiv: iese din listă, cu mesaj", /a ieșit din listă/.test(parametri(r).gata_ok || ""), unde(r));
  egal("motivul și cine, scrise; niciun palet", [unul(`SELECT ct_motiv FROM aprovizionari WHERE id = ${A_VECHE2}`), unul(`SELECT ct_inchis_de FROM aprovizionari WHERE id = ${A_VECHE2}`), Number(unul(`SELECT COUNT(*) FROM ct_paleti WHERE aprovizionare_id = ${A_VECHE2}`))], ["e deja pe raft, pusă de mână", "Om Depozit", 0]);
  r = await cer("post", `/stocuri/ct-park/gata/cerere/${A_VECHE2}/inchide`, DEP, { body: { motiv: "din nou" } });
  bine("a doua oară: deja scoasă", /deja scoasă/.test(parametri(r).gata_eroare || ""), unde(r));
  pag = await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { gata_ok: "Cererea a ieșit din listă." } });
  bine("mesajul apare pe Intrare marfă", pag.corp.includes("Cererea a ieșit din listă."));

  // ------------------------------------------------------------------------
  console.log("\n8. „Intră în stoc” din De aprovizionat");
  const inainte = Number(unul(`SELECT COUNT(*) FROM miscari_stoc WHERE produs_id = ${P3}`));
  r = await cer("post", "/depozit/aprovizionare/:id/primita".replace(":id", String(A_TERT)), DEP, { body: {} });
  egal("deschide Intrarea completată cu cererea", unde(r), `/stocuri/ct-park/intrare?aprovizionare=${A_TERT}`);
  egal("…fără mișcare în tabela veche și fără să schimbe cererea", [Number(unul(`SELECT COUNT(*) FROM miscari_stoc WHERE produs_id = ${P3}`)), unul(`SELECT status FROM aprovizionari WHERE id = ${A_TERT}`)], [inainte, "confirmata"]);
  pag = await cer("get", "/stocuri/ct-park/intrare", DEP, { query: { aprovizionare: String(A_TERT) } });
  bine("marfa de la terț: furnizorul cererii e ales, categoria n-o impunem",
    pag.corp.includes(`<option value="${FURNIZOR}" selected>`) && pag.corp.includes(`Din cererea #${A_TERT} (de la furnizor)`) && !pag.corp.includes('<option value="produse finite" selected>'), pag.cod);

  curata();
  console.log(esecuri ? `\n${esecuri} EȘECURI` : "\nTOATE BUNE");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) {}
  process.exit(1);
});
