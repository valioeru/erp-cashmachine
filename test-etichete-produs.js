"use strict";
// Etichetele de produs pe loturi (Producție → Etichete produs).
//
// CE A CERUT VALI, 13.11.2026:
//   „Un generator de etichete de produs cu denumire, caracteristici, număr lot
//    etc., configurabil, cu sigla Cash Machine, adresa, tel. și emailul de
//    office. Să alegi ce câmpuri adaugi pe etichetă și formatul 100×150 sau
//    100×50. Alegi la final câte să printezi cu acel nr. de lot; ulterior mai
//    poți printa suplimentar. Și cu cod de bare pe fiecare produs, ca să le
//    poți urca pe raft ușor cu scanerul. În zona de producție."
//   „Să țină minte fiecare lot de etichete imprimate, data și cine le-a
//    imprimat."
//   „Grafica să rămână mereu la fel, doar conținutul se va modifica."
//
// CE APĂRĂ:
//   • GRAFICA FIXĂ: aceeași schemă de zone și căsuțe cu toate câmpurile sau cu
//     niciunul; un câmp nebifat lasă căsuța goală. În Chromium: nicio zonă nu
//     se revarsă, zonele stau la aceeași înălțime pe orice etichetă.
//   • CÂMPURILE: ce nu e bifat nu apare; ce nu încape pe 100×50 nu ajunge pe
//     el; denumirea, lotul și codul de bare sunt mereu.
//   • CODUL DE BARE e codul produsului (cel pe care îl recunoaște scanerul);
//     al doilea, al lotului, doar pe 100×150 și doar dacă e bifat.
//   • LOTUL: curățat (litere mari, fără spații și diacritice); propus din fișa
//     de lot a comenzii de producție sau L<zi>-<nn>; un lot pe produs.
//   • TIPĂRIRILE: prima (1–N), „suplimentar" (numerotarea continuă), „din nou"
//     (aceleași numere, cu motiv); fiecare cu data și cine; ce s-a scris altfel
//     la o tipărire rămâne doar pe ea.
//   • SETĂRILE: doar administratorul; datele firmei, sigla (PNG/JPG/SVG, după
//     conținut, cel mult 300 KB), câmpurile implicite.
//   • LOTUL AJUNGE ÎN DEPOZIT: recepția din producție ia lotul etichetelor.
//   • DREPTURILE: fără Producție, nimic.
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
  if (/(^|\/)mail$/.test(req)) return { configUtilizator: () => null, trimite: async () => { throw new Error("test: fără email"); }, trimiteDeLa: async () => { throw new Error("test: fără email"); } };
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

// Tabelele noi (lib/db.js, ALTERARI), ca testul să meargă și pe o bază pornită înaintea lor.
q(`CREATE TABLE IF NOT EXISTS etichete_loturi (id SERIAL PRIMARY KEY, lot TEXT NOT NULL, produs_id INTEGER, comanda_productie_id INTEGER,
     format TEXT NOT NULL DEFAULT '100x150', campuri TEXT NOT NULL, continut TEXT NOT NULL, tiparite INTEGER NOT NULL DEFAULT 0,
     creat_de_id INTEGER, creat_de TEXT, creat_la TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_etichete_loturi_lot_produs ON etichete_loturi (UPPER(lot), produs_id);
   CREATE TABLE IF NOT EXISTS etichete_tiparite (id SERIAL PRIMARY KEY, lot_id INTEGER NOT NULL REFERENCES etichete_loturi(id) ON DELETE CASCADE,
     fel TEXT NOT NULL, de_la INTEGER NOT NULL, pana_la INTEGER NOT NULL, modificari TEXT, motiv TEXT, tiparit_de_id INTEGER, tiparit_de TEXT, tiparit_la TEXT);`);

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "etichete-produs.js")).register(router);
const E = require(path.join(RAD, "lib", "etichete-produs.js"));
const EM = require(path.join(RAD, "modules", "etichete-produs.js"));
const FL = require(path.join(RAD, "lib", "fisa-lot.js"));
const ST = require(path.join(RAD, "lib", "stadiu-comanda.js"));

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
const unde = (r) => String((r.antet && (r.antet.Location || r.antet.location)) || "");
const parametri = (r) => Object.fromEntries(new URL(unde(r), "http://erp.test").searchParams);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 400) : "")); esecuri++; }
}
const egal = (d, a, b) => bine(d + " = " + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
const cate = (text, ce) => (String(text).match(new RegExp(ce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
// Schema etichetei: zonele, locurile și căsuțele, fără ce e conținut (textul,
// sigla, codurile de bare, rândurile de caracteristici, semnul „gol").
const schema = (html) =>
  String(html)
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<img[^>]*>/g, "")
    .replace(/<div>[^<]*<\/div>/g, "")
    .replace(/>[^<]*</g, "><")
    .replace(/ style="font-size:[^"]*"/g, "")
    .replace(/ gol"/g, '"');

// ---- datele de test ------------------------------------------------------
const P1 = 96301, P2 = 96302;
const PARTENER = 96311;
const CP = 96321;
const CC1 = 96341, CC2 = 96342;
const PC1 = 96351, PC2 = 96352;
const PREFIX = "TEP";
const PRODUSE = [P1, P2];
const ADMIN = { id: 96331, nume: "Vali Admin", rol: "admin", sectiuni: "" };
const PROD = { id: 96332, nume: "Ion Producție", rol: "productie", sectiuni: "" };
const PROD2 = { id: 96334, nume: "Maria Producție", rol: "productie", sectiuni: "" };
const AGENT = { id: 96333, nume: "Agent", rol: "vanzari", sectiuni: "/crm" };

function curata() {
  const pr = PRODUSE.join(",");
  q(`DELETE FROM etichete_tiparite WHERE lot_id IN (SELECT id FROM etichete_loturi WHERE produs_id IN (${pr}))`);
  q(`DELETE FROM etichete_loturi WHERE produs_id IN (${pr})`);
  const rec = q(`SELECT id FROM receptii WHERE comanda_productie_id = ${CP}`).map((x) => Number(x.id));
  if (rec.length) {
    q(`DELETE FROM receptii_linii WHERE receptie_id IN (${rec.join(",")})`);
    q(`DELETE FROM receptii WHERE id IN (${rec.join(",")})`);
  }
  q(`DELETE FROM comenzi_productie_caracteristici WHERE comanda_id = ${CP}`);
  q(`DELETE FROM produse_caracteristici WHERE id IN (${PC1}, ${PC2}) OR produs_id IN (${pr})`);
  q(`DELETE FROM comenzi_productie_linii WHERE comanda_id = ${CP}`);
  q(`DELETE FROM comenzi_productie WHERE id = ${CP}`);
  q(`DELETE FROM produse_cod_valori WHERE produs_id IN (${pr})`);
  q(`DELETE FROM cod_caracteristici WHERE id IN (${CC1}, ${CC2})`);
  q(`DELETE FROM miscari_stoc WHERE produs_id IN (${pr})`);
  q(`DELETE FROM produse WHERE id IN (${pr})`);
  q(`DELETE FROM parteneri WHERE id = ${PARTENER}`);
  q(`DELETE FROM setari_app WHERE cheie LIKE 'etichete\\_%'`);
}
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
const firma = { nume: "CASH MACHINE S.R.L.", adresa: "Str. Exemplu 1, Voluntari", telefon: "+40 21 000 0000", email: "office@cashmachine.ro" };
// Un PNG de 1×1, valid.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

(async () => {
  curata();

  // ------------------------------------------------------------------------
  console.log("1. Câmpurile, lotul, numerotarea");
  egal("pe 100×150: cele alese plus cele obligatorii, în ordinea lor", E.campuriAlese("100x150", ["client", "lot", "nimic", "sigla"]), ["sigla", "denumire", "lot", "client", "cod_bare"]);
  egal("pe 100×50 nu ajunge ce nu încape (greutatea, clientul, codul lotului)", E.campuriAlese("100x50", ["greutate_neta", "client", "cod_bare_lot", "cantitate"]), ["denumire", "lot", "cantitate", "cod_bare"]);
  egal("și ca „a,b,c” (cum vin din previzualizare)", E.campuriAlese("100x150", "cod,operator"), ["denumire", "cod", "lot", "operator", "cod_bare"]);
  egal("formatul necunoscut e 100×150", E.format("A4"), "100x150");
  egal("lotul: litere mari, fără diacritice, spațiul devine „-”", E.curataLot(" lot ăîșț 12 "), { lot: "LOT-AIST-12" });
  bine("lotul cu semne ciudate sau prea lung e refuzat", E.curataLot("L#1").eroare && E.curataLot("X".repeat(31)).eroare && E.curataLot("").eroare);
  egal("lotul propus din comanda de producție e codul fișei ei de lot", E.lotPropus({ codLotProductie: "cm-261111-1553" }), "CM-261111-1553");
  egal("fără comandă: L<zi>-<nn>, primul liber", E.lotPropus({ zi: "2026-11-13", existente: ["L261113-01", "l261113-02"] }), "L261113-03");
  egal("prima tipărire: 1–N", E.interval({ fel: "nou", tiparite: 0, cate: "5" }), { de_la: 1, pana_la: 5, cate: 5 });
  egal("suplimentar: numerotarea continuă", E.interval({ fel: "suplimentar", tiparite: 5, cate: 3 }), { de_la: 6, pana_la: 8, cate: 3 });
  egal("din nou: aceleași numere", E.interval({ fel: "din_nou", tiparite: 8, de: 2, pana: 3 }), { de_la: 2, pana_la: 3, cate: 2 });
  bine("din nou peste ce s-a tipărit, sau invers, e refuzat", /Peste 8/.test(E.interval({ fel: "din_nou", tiparite: 8, de: 7, pana: 9 }).eroare || "") && E.interval({ fel: "din_nou", tiparite: 8, de: 5, pana: 4 }).eroare);
  bine("zero etichete sau peste plafon: refuzat", E.interval({ fel: "nou", cate: 0 }).eroare && E.interval({ fel: "nou", cate: E.MAX_TIPAR + 1 }).eroare && !E.interval({ fel: "nou", cate: E.MAX_TIPAR }).eroare);
  bine("din nou: peste plafon sau dintr-un lot netipărit, refuzat", E.interval({ fel: "din_nou", tiparite: 999, de: 1, pana: E.MAX_TIPAR + 1 }).eroare && !E.interval({ fel: "din_nou", tiparite: 999, de: 1, pana: E.MAX_TIPAR }).eroare && /nu s-a tipărit încă nimic/.test(E.interval({ fel: "din_nou", tiparite: 0, de: 1, pana: 1 }).eroare || ""));
  egal("la o tipărire se poate schimba doar ce ține de ea", E.modificari({ cantitate: " 20 buc ", client: "ALTUL", lot: "X", operator: "Maria", observatii: "" }), { cantitate: "20 buc", operator: "Maria" });

  // ------------------------------------------------------------------------
  console.log("\n2. Eticheta: grafica fixă, conținutul ales");
  const c = E.continut({ denumire: "Folie <stretch> automată", cod: "FSV23", cod_scan: "FSV23", caracteristici: "Grosime: 23 µm\nLățime: 500 mm\n\nCuloare: transparent", data_productiei: "2026-11-13", cantitate: "1 rolă", greutate_neta: "16 kg", client: "CLIENT SRL", comanda: "CMD-9", valabilitate: "2027-11-13", operator: "Ion", observatii: "uscat" });
  c.lot = "CM-261113-7";
  egal("caracteristicile, câte una pe rând, fără rânduri goale", c.caracteristici, ["Grosime: 23 µm", "Lățime: 500 mm", "Culoare: transparent"]);
  const toate = E.CAMPURI_FORMAT["100x150"];
  const plina = E.eticheta(c, toate, "100x150", firma, { numar: 7, tiparitLa: "2026-11-13 18:20:00" });
  const goala = E.eticheta(c, [], "100x150", firma, { numar: 7, tiparitLa: "2026-11-13 18:20:00" });
  egal("100×150: aceeași schemă cu toate câmpurile și cu niciunul", schema(goala) === schema(plina), true);
  egal("…șase zone și opt căsuțe de date, mereu", [cate(plina, 'class="z '), cate(goala, 'class="z '), cate(plina, 'data-camp="'), cate(goala, 'data-camp="')], [6, 6, 8, 8]);
  bine("cu toate: firma, adresa, telefonul, emailul, codul, caracteristicile, clientul, comanda, operatorul, observațiile", ["CASH MACHINE S.R.L.", "Str. Exemplu 1", "Tel. +40 21 000 0000", "office@cashmachine.ro", "Cod produs: FSV23", "Lățime: 500 mm", "CLIENT SRL", "CMD-9", "Ion", "uscat", "13.11.2026", "13.11.2027", "16 kg"].every((x) => plina.includes(x)));
  bine("…numărul etichetei și data tipăririi", plina.includes("Nr. 7 · tipărit 13.11.2026"));
  bine("…sigla implicită „CM”", plina.includes('aria-label="Cash Machine"'));
  bine("fără ele: nimic din toate astea, nici numele căsuțelor", !["CASH MACHINE", "Str. Exemplu", "office@", "Cod produs", "Lățime", "CLIENT SRL", "CMD-9", "uscat", "Nr. 7", "tipărit", "Client", "Operator", "aria-label=\"Cash Machine\""].some((x) => goala.includes(x)), goala.slice(0, 300));
  bine("denumirea și lotul sunt mereu, cu codul de bare al produsului", goala.includes("Folie &lt;stretch&gt; automată") && goala.includes("CM-261113-7") && goala.includes('aria-label="cod de bare FSV23"'));
  bine("textul e scăpat (nu intră HTML în etichetă)", !plina.includes("<stretch>"));
  bine("codul lotului ca bare doar dacă e bifat", plina.includes('aria-label="cod de bare CM-261113-7"') && !goala.includes('aria-label="cod de bare CM-261113-7"'));
  const mica = E.eticheta(c, E.CAMPURI_FORMAT["100x50"].concat(["cod_bare_lot", "client"]), "100x50", firma, { numar: 3, tiparitLa: "2026-11-13" });
  const micaGoala = E.eticheta(c, [], "100x50", firma, { numar: 3 });
  egal("100×50: aceeași schemă cu toate și cu niciunul", schema(micaGoala) === schema(mica), true);
  bine("100×50: fără codul lotului și fără client, chiar bifate; doar primul rând de caracteristici", !mica.includes('aria-label="cod de bare CM-261113-7"') && !mica.includes("CLIENT SRL") && mica.includes("Grosime: 23 µm") && !mica.includes("Lățime"));
  bine("…dar cu codul de bare al produsului, lotul și numărul", mica.includes('aria-label="cod de bare FSV23"') && mica.includes("CM-261113-7") && mica.includes("Nr. 3"));
  const SG = "data:image/png;base64,QUJD";
  const cuSigla = [1, 2, 3].map((n) => E.eticheta(c, ["sigla"], "100x150", firma, { numar: n, sigla: SG }));
  bine("sigla încărcată: fiecare etichetă trimite la ea; ce nu e imagine rămâne „CM”", cuSigla.every((x) => x.includes('<use href="#sigla-inc"/>') && !x.includes(SG)) && E.siglaHtml("javascript:alert(1)") === E.SIGLA_CM && E.siglaHtml('data:image/png;base64,"><script>') === E.SIGLA_CM);
  bine("…iar pagina o poartă o singură dată, oricâte etichete are", cate(E.pagina(cuSigla, "100x150", { sigla: SG }), SG) === 1 && cate(E.pagina(cuSigla, "100x150", { sigla: SG }), 'href="#sigla-inc"') === 3);
  bine("…și deloc, dacă nicio etichetă n-o cere", !E.pagina([goala], "100x150", { sigla: SG }).includes(SG));
  bine("pagina de tipărit are foaia cât eticheta", E.pagina([plina], "100x150").includes("@page { size: 100mm 150mm; margin: 0; }") && E.pagina([mica], "100x50").includes("@page { size: 100mm 50mm; margin: 0; }"));

  // ------------------------------------------------------------------------
  console.log("\n3. Etichetă nouă: din comanda de producție sau din nomenclator");
  q(`INSERT INTO parteneri (id, tip, nume) VALUES (${PARTENER}, 'client', '${PREFIX} Client Folie SRL')`);
  q(`INSERT INTO produse (id, cod, denumire, unitate_masura) VALUES (${P1}, 'TEP-FOLIE', '${PREFIX} Folie stretch automată 23 µm', 'buc'), (${P2}, NULL, '${PREFIX} Sac fără cod', 'buc')`);
  q(`INSERT INTO cod_caracteristici (id, nume, um, ordine) VALUES (${CC1}, 'Grosime', 'µm', 1), (${CC2}, 'Lățime', 'mm', 2)`);
  q(`INSERT INTO produse_cod_valori (produs_id, caracteristica_id, nume, valoare) VALUES (${P1}, ${CC2}, 'Lățime', '500'), (${P1}, ${CC1}, 'Grosime', '23')`);
  q(`INSERT INTO comenzi_productie (id, numar, partener_id, tip_produs, cantitate, um, status, data_initiere, produs_id)
     VALUES (${CP}, '${PREFIX}-CP-1', ${PARTENER}, '${PREFIX} Folie stretch automată 23 µm', '100', 'buc', 'in_productie', '2026-11-12', ${P1})`);
  q(`INSERT INTO produse_caracteristici (id, produs_id, denumire, unitate, ordine) VALUES (${PC1}, ${P1}, 'Grosime', 'µm', 1), (${PC2}, ${P1}, 'Diametru miez', 'mm', 2)`);
  q(`INSERT INTO comenzi_productie_caracteristici (comanda_id, caracteristica_id, denumire, valoare, unitate) VALUES (${CP}, ${PC1}, 'Grosime', '23', 'µm'), (${CP}, ${PC2}, 'Diametru miez', '76', 'mm')`);
  const lotCP = FL.codLot(q(`SELECT * FROM comenzi_productie WHERE id = ${CP}`)[0]);

  let r = await cer("get", "/productie/etichete", PROD);
  bine("lista se deschide, cu „Etichetă nouă”, comanda de producție și produsul de ales", r.cod === 200 && r.corp.includes('action="/productie/etichete/noua"') && r.corp.includes(`<option value="${CP}">`) && r.corp.includes(`#${P1} TEP-FOLIE`), r.cod);
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { productie: String(CP) } });
  bine("din comanda de producție: lotul fișei de lot, clientul, caracteristicile comenzii", r.cod === 200 && r.corp.includes(`name="lot" value="${lotCP}"`) && r.corp.includes(`name="client" value="${PREFIX} Client Folie SRL"`) && r.corp.includes("Diametru miez: 76 mm") && r.corp.includes(`name="comanda" value="${PREFIX}-CP-1"`), (r.corp.match(/name="lot"[^>]*/) || [""])[0]);
  bine("…cu previzualizarea și câmpurile de bifat", r.corp.includes('id="et-mostra"') && r.corp.includes('name="campuri[]" value="client"') && r.corp.includes("function reface()"));
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: `#${P1} TEP-FOLIE — ceva` } });
  const lotL = "L" + azi().slice(2).replace(/-/g, "") + "-01";
  bine("din nomenclator: lotul L<zi>-01 și caracteristicile din fișa produsului, în ordinea lor", r.cod === 200 && r.corp.includes(`name="lot" value="${lotL}"`) && r.corp.includes("Grosime: 23 µm\nLățime: 500 mm"), (r.corp.match(/<textarea name="caracteristici"[^>]*>[^<]*/) || [""])[0]);
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie" } });
  bine("codul scris de mână găsește produsul", r.cod === 200 && r.corp.includes(`name="produs_id" value="${P1}"`));
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "nu exista" } });
  bine("fără produs: înapoi la listă, cu mesajul", unde(r).startsWith("/productie/etichete?eroare=") && /Alege produsul/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("get", "/productie/etichete/previzualizare", PROD, { query: { produs_id: String(P1), format: "100x50", campuri: "cantitate,client,cod", lot: "l 1", cantitate: "36 buc", client: "NU" } });
  bine("previzualizarea: o etichetă, cu câmpurile din „a,b,c”, pe formatul ales", r.cod === 200 && cate(r.corp, 'class="et ') === 1 && r.corp.includes("et-100x50") && r.corp.includes("36 buc") && r.corp.includes("Cod TEP-FOLIE") && !r.corp.includes(">NU<") && r.corp.includes("L-1"), r.corp.slice(0, 200));
  r = await cer("get", "/productie/etichete/previzualizare", PROD, { query: { produs_id: String(P1), format: "100x150", campuri: "firma,adresa,telefon,email", lot: "L1" } });
  bine("fără setări: adresa depozitului (Vila Ana), telefonul și emailul de office — nu sediul social", r.corp.includes("CASH MACHINE S.R.L.") && r.corp.includes("Str. Vila Ana nr. 6, Depozit B2, CTPark Bucharest North, Afumați, Ilfov") && r.corp.includes("Tel. +40 (741) 162 460 · office@cashmachine.ro") && !r.corp.includes("Racovita") && !r.corp.includes("4046404046"), r.corp.slice(r.corp.indexOf('class="firma"'), r.corp.indexOf('class="firma"') + 400));
  egal("adresa, telefonul și emailul de office sunt bifate implicit pe ambele formate", ["100x150", "100x50"].map((f) => ["adresa", "telefon", "email"].every((k) => E.IMPLICITE[f].includes(k))), [true, true]);

  // ------------------------------------------------------------------------
  console.log("\n4. Lotul nou și prima tipărire");
  const corp = (x) => Object.assign({ produs_id: String(P1), comanda_productie_id: String(CP), format: "100x150", "campuri[]": ["client", "cantitate", "numar", "data_tiparirii", "cod_bare_lot"], lot: lotCP.toLowerCase(), data_productiei: "2026-11-13", cantitate: "1 rolă", client: "Client X", denumire: "", caracteristici: "Grosime: 23 µm", cate: "4", cod: "ALTUL", cod_scan: "ALTUL" }, x || {});
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ lot: "lot #1" }) });
  bine("lot greșit: înapoi în formular, cu ce era scris și câmpurile bifate", unde(r).startsWith("/productie/etichete/noua?") && /litere, cifre/.test(parametri(r).eroare || "") && parametri(r).campuri === "client,cantitate,numar,data_tiparirii,cod_bare_lot" && parametri(r).cantitate === "1 rolă" && parametri(r).productie === String(CP), unde(r));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ cate: "0" }) });
  bine("zero etichete: înapoi, cu mesajul", /cel puțin una/.test(parametri(r).eroare || ""));
  r = await cer("post", "/productie/etichete", AGENT, { body: corp() });
  bine("fără Producție: nu face loturi", unde(r) === "/" && !Number(unul(`SELECT count(*) FROM etichete_loturi WHERE produs_id = ${P1}`)));
  r = await cer("post", "/productie/etichete", PROD, { body: corp() });
  const L1 = q(`SELECT * FROM etichete_loturi WHERE produs_id = ${P1}`)[0] || {};
  egal("lotul: curățat, pe produs și pe comanda de producție, cu 4 etichete", [L1.lot, Number(L1.comanda_productie_id), L1.format, Number(L1.tiparite), L1.creat_de], [lotCP, CP, "100x150", 4, PROD.nume]);
  const C1 = JSON.parse(L1.continut || "{}");
  egal("ce scrie pe etichete: codul și codul de bare din nomenclator (nu din formular), denumirea din produs dacă nu s-a scris alta", [C1.cod, C1.cod_scan, C1.denumire, C1.cantitate, C1.client], ["TEP-FOLIE", "TEP-FOLIE", `${PREFIX} Folie stretch automată 23 µm`, "1 rolă", "Client X"]);
  egal("câmpurile alese, cu cele obligatorii", JSON.parse(L1.campuri || "[]"), ["denumire", "lot", "cantitate", "client", "numar", "data_tiparirii", "cod_bare", "cod_bare_lot"]);
  const T1 = q(`SELECT * FROM etichete_tiparite WHERE lot_id = ${L1.id || 0} ORDER BY id`);
  egal("prima tipărire: 1–4, cine și când", T1.map((t) => [t.fel, Number(t.de_la), Number(t.pana_la), Number(t.tiparit_de_id), t.tiparit_de, String(t.tiparit_la || "").slice(0, 10)]), [["nou", 1, 4, PROD.id, PROD.nume, azi()]]);
  egal("…și deschide pagina ei de tipărit", unde(r), `/productie/etichete/${L1.id}/tipar/${T1[0] && T1[0].id}`);
  r = await cer("get", unde(r), PROD);
  bine("pagina: patru etichete, nr. 1–4, cu codul de bare al produsului și al lotului", r.cod === 200 && cate(r.corp, 'class="et et-100x150"') === 4 && ["Nr. 1 ", "Nr. 2 ", "Nr. 3 ", "Nr. 4 "].every((x) => r.corp.includes(x)) && cate(r.corp, 'aria-label="cod de bare TEP-FOLIE"') === 4 && cate(r.corp, `aria-label="cod de bare ${lotCP}"`) === 4, r.corp.slice(0, 300));
  bine("…cu butonul „Tipărește” pentru cel care tocmai a cerut", r.corp.includes('onclick="window.print()"'));
  r = await cer("get", `/productie/etichete/${L1.id}/tipar/${T1[0].id}`, PROD2);
  bine("altcineva o vede doar, fără buton: încă o tipărire trece prin „Din nou”", r.cod === 200 && !r.corp.includes('onclick="window.print()"') && /Doar vizualizare/.test(r.corp));
  r = await cer("post", "/productie/etichete", PROD2, { body: corp({ lot: lotCP.toLowerCase(), cate: "2" }) });
  bine("același lot pentru același produs: duce la lotul existent, nu face altul", unde(r).startsWith(`/productie/etichete/${L1.id}?eroare=`) && /există deja/.test(parametri(r).eroare || "") && Number(unul(`SELECT count(*) FROM etichete_loturi WHERE produs_id = ${P1}`)) === 1, unde(r));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P2), comanda_productie_id: "", lot: lotCP, cate: "1", format: "100x50" }) });
  const L2 = q(`SELECT * FROM etichete_loturi WHERE produs_id = ${P2}`)[0] || {};
  bine("același lot la alt produs e alt lot; produsul fără cod are pe bare P-<id>", L2.lot === lotCP && JSON.parse(L2.continut || "{}").cod_scan === "P-" + P2 && L2.format === "100x50", JSON.stringify(L2).slice(0, 200));

  // ------------------------------------------------------------------------
  console.log("\n5. Suplimentar și din nou, cu istoricul");
  r = await cer("post", `/productie/etichete/${L1.id}/tipareste`, PROD2, { body: { fel: "suplimentar", cate: "3", cantitate: "20 buc", motiv: "ultima cutie" } });
  let T = q(`SELECT * FROM etichete_tiparite WHERE lot_id = ${L1.id} ORDER BY id`);
  egal("suplimentar: 5–7, cu ce s-a scris altfel și de ce, pe numele celui care a tipărit", T.slice(-1).map((t) => [t.fel, Number(t.de_la), Number(t.pana_la), t.tiparit_de, JSON.parse(t.modificari || "{}").cantitate, t.motiv]), [["suplimentar", 5, 7, PROD2.nume, "20 buc", "ultima cutie"]]);
  egal("lotul are acum 7 etichete, iar ce scrie pe el a rămas", [Number(unul(`SELECT tiparite FROM etichete_loturi WHERE id = ${L1.id}`)), JSON.parse(unul(`SELECT continut FROM etichete_loturi WHERE id = ${L1.id}`)).cantitate], [7, "1 rolă"]);
  r = await cer("get", unde(r), PROD2);
  bine("pe etichetele 5–7: „20 buc”, nu „1 rolă”", cate(r.corp, 'class="et et-100x150"') === 3 && r.corp.includes("Nr. 5 ") && r.corp.includes("Nr. 7 ") && !r.corp.includes("Nr. 4 ") && cate(r.corp, ">20 buc<") === 3 && !r.corp.includes(">1 rolă<"), r.corp.slice(0, 200));
  r = await cer("post", `/productie/etichete/${L1.id}/tipareste`, PROD, { body: { fel: "din_nou", de: "2", pana: "3" } });
  bine("din nou fără motiv: refuzat", /Spune de ce/.test(parametri(r).eroare || "") && q(`SELECT id FROM etichete_tiparite WHERE lot_id = ${L1.id}`).length === 2);
  r = await cer("post", `/productie/etichete/${L1.id}/tipareste`, PROD, { body: { fel: "din_nou", de: "6", pana: "9", motiv: "x" } });
  bine("din nou peste ce s-a tipărit: refuzat", /Peste 7/.test(parametri(r).eroare || ""), parametri(r).eroare);
  r = await cer("post", `/productie/etichete/${L1.id}/tipareste`, PROD, { body: { fel: "din_nou", de: "2", pana: "3", motiv: "eticheta 2 și 3 s-au rupt" } });
  T = q(`SELECT * FROM etichete_tiparite WHERE lot_id = ${L1.id} ORDER BY id`);
  egal("din nou 2–3: aceleași numere, numerotarea lotului nu se mișcă", [T.slice(-1)[0].fel, Number(T.slice(-1)[0].de_la), Number(T.slice(-1)[0].pana_la), Number(unul(`SELECT tiparite FROM etichete_loturi WHERE id = ${L1.id}`))], ["din_nou", 2, 3, 7]);
  r = await cer("post", `/productie/etichete/${L1.id}/tipareste`, AGENT, { body: { fel: "suplimentar", cate: "1" } });
  bine("fără Producție: nu tipărește", unde(r) === "/" && q(`SELECT id FROM etichete_tiparite WHERE lot_id = ${L1.id}`).length === 3);
  r = await cer("get", `/productie/etichete/${L1.id}`, PROD);
  bine("pagina lotului: istoricul cu toate trei, cine, ce numere, ce s-a schimbat și de ce", r.cod === 200 && ["Prima tipărire", "Suplimentar", "Din nou", PROD.nume, PROD2.nume, "1–4", "5–7", "2–3", "Cantitate pe ambalaj: 20 buc", "ultima cutie", "eticheta 2 și 3 s-au rupt"].every((x) => r.corp.includes(x)), r.corp.slice(0, 200));
  bine("…cu formularele „Suplimentar” (de la nr. 8) și „Din nou” (1–7)", r.corp.includes("de la nr. 8 încolo") && r.corp.includes("numerele 1–7") && r.corp.includes(`action="/productie/etichete/${L1.id}/tipareste"`));
  r = await cer("get", "/productie/etichete", PROD, { query: { q: "tep folie" } });
  bine("lista: lotul cu 7 etichete în 3 tipăriri și ultima tipărire", r.corp.includes(`<strong>${lotCP}</strong>`) && r.corp.includes("<strong>7</strong>") && r.corp.includes("în 3 tipăriri") && r.corp.includes(PROD.nume));
  r = await cer("get", `/productie/etichete/${L1.id}/mostra`, PROD);
  bine("mostra lotului: eticheta nr. 1 cu ce scrie pe lot", r.cod === 200 && cate(r.corp, 'class="et ') === 1 && r.corp.includes(">1 rolă<"));

  // ------------------------------------------------------------------------
  console.log("\n6. Setările: doar administratorul");
  r = await cer("get", "/productie/etichete/setari", PROD);
  bine("altcineva nu intră", unde(r) === "/productie/etichete");
  r = await cer("post", "/productie/etichete/setari", PROD, { body: { nume: "ALTA FIRMA" } });
  bine("…nici nu schimbă", unde(r) === "/productie/etichete" && !unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_firma'"));
  r = await cer("get", "/productie/etichete/setari", ADMIN);
  bine("administratorul vede implicit numele de pe aviz, adresa depozitului, telefonul și emailul de office", r.cod === 200 && r.corp.includes('value="CASH MACHINE S.R.L."') && r.corp.includes('value="Str. Vila Ana nr. 6, Depozit B2, CTPark Bucharest North, Afumați, Ilfov"') && r.corp.includes('value="+40 (741) 162 460"') && r.corp.includes('value="office@cashmachine.ro"') && !r.corp.includes("Racovita"));
  r = await cer("post", "/productie/etichete/setari", ADMIN, { body: { nume: "CASH MACHINE SRL", adresa: "CTPark Afumați", telefon: "0722 000 000", email: "office@cashmachine.ro", "implicite_100x50[]": ["cantitate", "client"], __files: { sigla: [{ filename: "sigla.png", contentType: "application/octet-stream", data: PNG }] } } });
  const fi = JSON.parse(unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_firma'") || "{}");
  egal("firma salvată", [fi.nume, fi.adresa, fi.telefon], ["CASH MACHINE SRL", "CTPark Afumați", "0722 000 000"]);
  egal("câmpurile implicite pe 100×50, fără ce nu încape", JSON.parse(unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_campuri_100x50'") || "[]"), ["denumire", "lot", "cantitate", "cod_bare"]);
  bine("sigla PNG, recunoscută după conținut, ținută ca imagine", String(unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_sigla'")).startsWith("data:image/png;base64,iVBOR"));
  r = await cer("get", "/productie/etichete/previzualizare", PROD, { query: { produs_id: String(P1), format: "100x150", campuri: "sigla,firma,adresa,telefon,email", lot: "L1" } });
  bine("etichetele de acum încolo o folosesc, cu datele noi ale firmei", cate(r.corp, "data:image/png;base64,iVBOR") === 1 && r.corp.includes('<use href="#sigla-inc"/>') && r.corp.includes("CTPark Afumați") && r.corp.includes("CASH MACHINE SRL") && r.corp.includes("Tel. 0722 000 000"), r.corp.slice(0, 300));
  r = await cer("get", `/productie/etichete/${L1.id}/mostra`, PROD);
  bine("…dar pe un lot fără sigla și firma bifate, ele nu apar", !r.corp.includes("sigla-inc") && !r.corp.includes("iVBOR") && !r.corp.includes("CTPark Afumați"));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P1), comanda_productie_id: "", lot: "SIGLA-1", "campuri[]": ["sigla", "firma"], cate: "60" }) });
  const tSigla = unde(r);
  r = await cer("get", tSigla, PROD);
  bine("o tipărire de 60 de etichete cu sigla: imaginea e o singură dată pe pagină", cate(r.corp, 'class="et et-100x150"') === 60 && cate(r.corp, 'href="#sigla-inc"') === 60 && cate(r.corp, "data:image/png;base64,iVBOR") === 1, tSigla);
  r = await cer("post", "/productie/etichete/setari", ADMIN, { body: { nume: "X", __files: { sigla: [{ filename: "a.png", contentType: "image/png", data: Buffer.from("nu e imagine") }] } } });
  bine("un fișier care nu e imagine: refuzat, chiar dacă se numește .png", /PNG, JPG sau SVG/.test(parametri(r).eroare || "") && JSON.parse(unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_firma'")).nume === "CASH MACHINE SRL");
  r = await cer("post", "/productie/etichete/setari", ADMIN, { body: { nume: "X", __files: { sigla: [{ filename: "mare.png", contentType: "image/png", data: Buffer.concat([PNG, Buffer.alloc(301 * 1024)]) }] } } });
  bine("o siglă peste 300 KB: refuzată", /300 KB/.test(parametri(r).eroare || ""));
  egal("SVG-ul se recunoaște, textul nu", [EM.siglaTip({ data: Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>') }), EM.siglaTip({ data: Buffer.from("<html><svg>") })], ["image/svg+xml", null]);
  r = await cer("post", "/productie/etichete/setari", ADMIN, { body: { nume: "CASH MACHINE SRL", fara_sigla: "1" } });
  bine("„scoate sigla încărcată” revine la „CM”", unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_sigla'") === null || unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_sigla'") === "");

  // ------------------------------------------------------------------------
  console.log("\n7. Lotul etichetelor ajunge pe recepția din producție");
  egal("lotul etichetelor comenzii, pe produs", [await EM.lotPentruProductie(CP, P1), await EM.lotPentruProductie(CP, P2), await EM.lotPentruProductie(0, P1)], [lotCP, null, null]);
  const randuriRec = (id) => q(`SELECT produs_id, lot, cantitate_asteptata FROM receptii_linii WHERE receptie_id = ${Number(id) || 0}`).map((x) => [Number(x.produs_id), x.lot, Number(x.cantitate_asteptata)]);
  const part = await ST.finalizeazaPartial(CP, { 0: "40" }, { user: PROD });
  egal("finalizată parțial: rândul recepției are lotul etichetelor", [part.eroare || null, randuriRec(part.receptieId)], [null, [[P1, lotCP, 40]]]);
  const recId = await ST.trimiteInDepozit(q(`SELECT * FROM comenzi_productie WHERE id = ${CP}`)[0], { user: PROD });
  egal("restul, trimis în depozit la „Finalizată”: tot cu lotul", randuriRec(recId), [[P1, lotCP, 60]]);

  // ------------------------------------------------------------------------
  console.log("\n8. Pe hârtie: nicio zonă nu se revarsă, zonele stau pe loc");
  let pw = null;
  try { pw = require("playwright"); } catch (_) { pw = null; }
  if (!pw) console.log("  (fără Playwright aici — sar peste)");
  else {
    const lung = E.continut({ denumire: "Sac Blue PE 860*1000 CM (860*1000) cu imprimare personalizată pe ambele fețe, pentru deșeuri menajere și industriale, rezistent și foarte lung de tot", cod: "SACBLUE860-FOARTE-LUNG", cod_scan: "SACBLUE860-FOARTE-LUNG", caracteristici: "Dimensiune: 860 × 1000 mm cu pliuri laterale și fund stea\nGrosime: 40 µm\nCuloare: albastru\nMaterial: PE reciclat\nImprimare: 2 culori\nAmbalare: 25 buc/rolă\nÎncă un rând care nu mai încape", data_productiei: "2026-11-13", cantitate: "100 buc", greutate_neta: "16,25 kg", greutate_bruta: "16,95 kg", client: "DELIVERY SOLUTIONS S.A. — DEPOZIT CENTRAL CHIAJNA", comanda: "4500024459 / CMD-118", valabilitate: "2027-11-13", operator: "Ionela-Alexandra Popescu-Vasilescu", observatii: "A se depozita la adăpost de soare și umezeală, la cel mult 30 °C" });
    lung.lot = "CM-261113-1553-SUPLIMENTAR";
    const firmaLunga = { nume: "CASH MACHINE S.R.L. — PRODUCȚIE ȘI DISTRIBUȚIE AMBALAJE", adresa: "Str. Emil Racovita 31-33, Vila F16, Voluntari, Jud. Ilfov, România, cod 077190", telefon: "+40 21 404 6404 / +40 722 000 000", email: "office@cashmachine.ro" };
    const b = await pw.chromium.launch();
    const p = await b.newPage();
    for (const fmt of ["100x150", "100x50"]) {
      // A treia: o denumire de 200 de litere late, care fără plafonul de rânduri ar împinge codul afară.
      const lata = Object.assign({}, c, { denumire: "MWMWMWMWMW ".repeat(19).slice(0, 200) });
      // A patra: datele firmei de acum (Vila Ana, telefonul și emailul de office), pe câmpurile implicite.
      const firmaAzi = Object.assign({ nume: "CASH MACHINE S.R.L." }, E.FIRMA_IMPLICITA);
      const et = [E.eticheta(lung, E.CAMPURI_FORMAT[fmt], fmt, firmaLunga, { numar: 300, tiparitLa: "2026-11-13" }), E.eticheta(c, [], fmt, firma, { numar: 1 }), E.eticheta(lata, E.CAMPURI_FORMAT[fmt], fmt, firma, { numar: 2 }), E.eticheta(c, E.IMPLICITE[fmt], fmt, firmaAzi, { numar: 3, tiparitLa: "2026-11-14" })];
      await p.setContent(E.pagina(et, fmt));
      const m = await p.evaluate(() =>
        [...document.querySelectorAll(".et")].map((et) => ({
          h: Math.round(et.getBoundingClientRect().height),
          peste: [...et.querySelectorAll(".z")].filter((z) => z.scrollHeight > z.clientHeight + 1 || z.scrollWidth > z.clientWidth + 1).map((z) => z.className),
          afara: [...et.querySelectorAll(".z")].filter((z) => z.getBoundingClientRect().bottom > et.getBoundingClientRect().bottom - parseFloat(getComputedStyle(et).paddingBottom) + 1).map((z) => z.className),
          sus: [...et.querySelectorAll(".z")].map((z) => Math.round(z.getBoundingClientRect().top - et.getBoundingClientRect().top)),
          randuri: (() => { const d = et.querySelector(".den"); return d.getBoundingClientRect().height / parseFloat(getComputedStyle(d).lineHeight); })(),
          taiat: [".f-nume", ".f-adr", ".f-ct"].map((k) => et.querySelector(k)).filter((x) => x && (x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1)).map((x) => x.className),
        }))
      );
      const h = fmt === "100x150" ? 567 : 189;
      bine(`${fmt}: eticheta are exact mărimea ei, cu text lung sau scurt`, m.every((x) => Math.abs(x.h - h) <= 1), JSON.stringify(m.map((x) => x.h)));
      bine(`${fmt}: nicio zonă nu se revarsă, nici cu textele cele mai lungi`, m.every((x) => !x.peste.length), JSON.stringify(m.map((x) => x.peste)));
      bine(`${fmt}: toate zonele încap pe etichetă, cu marginea de jos`, m.every((x) => !x.afara.length), JSON.stringify(m.map((x) => x.afara)));
      const maxRanduri = fmt === "100x150" ? 4 : 2;
      bine(`${fmt}: denumirea are cel mult ${maxRanduri} rânduri întregi (restul se taie cu „…”)`, m.every((x) => x.randuri <= maxRanduri + 0.05), JSON.stringify(m.map((x) => x.randuri)));
      bine(`${fmt}: cu datele de acum, numele, adresa, telefonul și emailul încap întregi`, !m[3].taiat.length, JSON.stringify(m[3].taiat));
      bine(`${fmt}: zonele stau la aceeași înălțime pe toate etichetele`, m.every((x) => JSON.stringify(x.sus) === JSON.stringify(m[0].sus)), JSON.stringify(m.map((x) => x.sus)));
    }
    await b.close();
  }

  curata();
  console.log(esecuri ? `\n${esecuri} ESEC(URI)` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { curata(); } catch (_) { /* */ }
  process.exit(2);
});
