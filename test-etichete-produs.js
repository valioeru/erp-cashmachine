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
// ADĂUGAT PE 16.11.2026:
//   • PE COMANDA CLIENTULUI („selectezi comanda și faci etichete pentru ea"):
//     liniile comenzii, fiecare cu loturile de până acum; linia cu comandă de
//     producție ia lotul fișei ei, celelalte un lot propus; lotul ține minte
//     comanda; butonul de pe pagina comenzii spune câte loturi are.
//   • BIFA „Etichete produs (doar generatorul)" („Gabi să aibă acces la
//     generatorul de etichete"): Gabi intră în generator și nicăieri altundeva
//     în Producție; butonul ei de Producție duce la generator; comenzile de
//     producție îi apar fără link.
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
     fel TEXT NOT NULL, de_la INTEGER NOT NULL, pana_la INTEGER NOT NULL, modificari TEXT, motiv TEXT, tiparit_de_id INTEGER, tiparit_de TEXT, tiparit_la TEXT);
   ALTER TABLE etichete_loturi ADD COLUMN IF NOT EXISTS comanda_id INTEGER;`);

const rute = { get: {}, post: {} };
const router = { get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; }, post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; }, put: () => {}, delete: () => {} };
require(path.join(RAD, "modules", "etichete-produs.js")).register(router);
// Pagina comenzii clientului, pentru butonul „Etichete produs” de pe ea.
require(path.join(RAD, "modules", "comenzi.js")).register(router);
const auth = require(path.join(RAD, "lib", "auth.js"));
const render = require(path.join(RAD, "lib", "render.js"));
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
// Gabi, 16.11.2026: doar generatorul de etichete, fără restul Producției.
const GABI = { id: 96335, nume: "Gabi Etichete", rol: "depozit", sectiuni: "/avize,/productie/etichete" };
const BIFA_PROD = { id: 96336, nume: "Cu bifa Producție", rol: "depozit", sectiuni: "/productie" };
// Comenzile clientului: CO cu două linii (P1, P2), CO2 cu una (P2).
const CO = 96361, CO2 = 96362;
const LA = 96371, LB = 96372, LC = 96373;

function curata() {
  const pr = PRODUSE.join(",");
  q(`DELETE FROM etichete_tiparite WHERE lot_id IN (SELECT id FROM etichete_loturi WHERE produs_id IN (${pr}))`);
  q(`DELETE FROM etichete_loturi WHERE produs_id IN (${pr})`);
  q(`DELETE FROM aprovizionari WHERE id = 96381 OR comanda_id IN (${CO}, ${CO2})`);
  q(`DELETE FROM comenzi_linii WHERE comanda_id IN (${CO}, ${CO2})`);
  q(`DELETE FROM comenzi WHERE id IN (${CO}, ${CO2})`);
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
  console.log("\n2b. Câmp bifat fără valoare: rămâne numele lui, cu loc de scris de mână");
  // Vali, 17.11.2026: „Chiar dacă nu am greutatea brută și netă, unde lași loc
  // pune denumirea câmpului, fără valoare."
  const casutaDin = (html, camp) => (new RegExp('<div class="c[^"]*" data-camp="' + camp + '"><span>([^<]*)</span><b[^>]*>([^<]*)</b></div>').exec(html) || []).slice(1);
  const LOC = "&emsp;&emsp;&emsp;&ensp;";
  const fara = E.continut({ denumire: "Folie", cod: "F1", cod_scan: "F1", data_productiei: "2026-11-17" });
  fara.lot = "L261117-01";
  const etG = (plus, campuri, fmt) => E.eticheta(Object.assign({}, fara, plus), campuri, fmt || "100x150", firma, { numar: 1 });
  const AMBELE = ["greutate_neta", "greutate_bruta"];
  let e2 = etG({}, AMBELE.concat(["operator", "cantitate"]));
  egal("greutățile bifate, fără valoare: numele căsuței și bara dintre ele, cu loc de scris în față", casutaDin(e2, "greutate"), ["Greutate netă / brută", LOC + " / "]);
  egal("…la fel operatorul și cantitatea: numele, fără valoare", [casutaDin(e2, "operator"), casutaDin(e2, "cantitate")], [["Operator", ""], ["Cantitate pe ambalaj", ""]]);
  egal("câmpul nebifat rămâne alb, fără nume", [casutaDin(e2, "client"), casutaDin(e2, "comanda"), casutaDin(e2, "valabilitate")], [["", ""], ["", ""], ["", ""]]);
  bine("…și doar el e marcat gol", /class="c gol" data-camp="comanda"/.test(e2) && /class="c lat gol" data-camp="client"/.test(e2) && /class="c" data-camp="greutate"/.test(e2) && /class="c" data-camp="operator"/.test(e2) && cate(e2, " gol\"") === 4, cate(e2, " gol\""));
  egal("doar neta scrisă: valoarea ei, bara și loc pentru brută", casutaDin(etG({ greutate_neta: "15,2 kg" }, AMBELE), "greutate"), ["Greutate netă / brută", "15,2 kg / "]);
  egal("doar bruta scrisă: loc pentru netă, bara și valoarea", casutaDin(etG({ greutate_bruta: "16 kg" }, AMBELE), "greutate"), ["Greutate netă / brută", LOC + " / 16 kg"]);
  egal("amândouă scrise: ca până acum", casutaDin(etG({ greutate_neta: "15,2 kg", greutate_bruta: "16 kg" }, AMBELE), "greutate"), ["Greutate netă / brută", "15,2 kg / 16 kg"]);
  egal("doar neta bifată: numele ei, cu sau fără valoare — bruta scrisă nu apare", [casutaDin(etG({ greutate_bruta: "16 kg" }, ["greutate_neta"]), "greutate"), casutaDin(etG({ greutate_neta: "15,2 kg", greutate_bruta: "16 kg" }, ["greutate_neta"]), "greutate")], [["Greutate netă", ""], ["Greutate netă", "15,2 kg"]]);
  egal("doar bruta bifată", [casutaDin(etG({ greutate_neta: "15,2 kg" }, ["greutate_bruta"]), "greutate"), casutaDin(etG({ greutate_neta: "15,2 kg", greutate_bruta: "16 kg" }, ["greutate_bruta"]), "greutate")], [["Greutate brută", ""], ["Greutate brută", "16 kg"]]);
  egal("niciuna bifată: căsuța albă, chiar dacă greutățile sunt scrise", casutaDin(etG({ greutate_neta: "15,2 kg", greutate_bruta: "16 kg" }, ["operator"]), "greutate"), ["", ""]);
  egal("pe lat, la fel", casutaDin(etG({}, AMBELE, "150x100"), "greutate"), ["Greutate netă / brută", LOC + " / "]);
  egal("pe 100 × 50, pe lat și pe înalt: cantitatea bifată și goală își ține numele; nebifată, nu",
    ["100x50", "50x100"].map((f) => [casutaDin(etG({}, ["cantitate"], f), "cantitate"), casutaDin(etG({}, [], f), "cantitate"), casutaDin(etG({ data_productiei: "" }, ["data_productiei"], f), "data_productiei")]),
    [[["Cantitate", ""], ["", ""], ["Data producției", ""]], [["Cantitate", ""], ["", ""], ["Data producției", ""]]]);
  egal("ce scrie omul la greutate rămâne scăpat", casutaDin(etG({ greutate_neta: "<b>1", greutate_bruta: "2&3" }, AMBELE), "greutate"), ["Greutate netă / brută", "&lt;b&gt;1 / 2&amp;3"]);
  bine("…și cu o singură greutate, sau cu locul de scris în față", etG({ greutate_neta: "<b>1", greutate_bruta: "2&3" }, AMBELE).includes("&lt;b&gt;1 / 2&amp;3") && etG({ greutate_bruta: "<i>" }, AMBELE).includes(LOC + " / &lt;i&gt;") && etG({ greutate_neta: "<i>" }, ["greutate_neta"]).includes("<b>&lt;i&gt;</b>"));
  const rau = etG({ client: "<u>C", operator: "<i>O", comanda: "a&b", cantitate: "<s>", valabilitate: "<x>" }, ["client", "operator", "comanda", "cantitate", "valabilitate"]);
  egal("…la fel în celelalte căsuțe: clientul, operatorul, comanda, cantitatea, valabilitatea", [casutaDin(rau, "client")[1], casutaDin(rau, "operator")[1], casutaDin(rau, "comanda")[1], casutaDin(rau, "cantitate")[1], casutaDin(rau, "valabilitate")[1], /<(u|i|s|x)>/.test(rau)],
    ["&lt;u&gt;C", "&lt;i&gt;O", "a&amp;b", "&lt;s&gt;", "&lt;x&gt;", false]);
  egal("greutățile sunt bifate implicit pe hârtia mare, în ambele orientări; pe cea mică nu au loc", ["100x150", "150x100", "100x50", "50x100"].map((f) => AMBELE.every((k) => E.IMPLICITE[f].includes(k))), [true, true, false, false]);
  egal("eticheta implicită, fără nicio greutate scrisă, are căsuța greutăților cu numele ei", casutaDin(etG({}, E.IMPLICITE["100x150"]), "greutate"), ["Greutate netă / brută", LOC + " / "]);
  // Numele lung al clientului: litera scade, ca să încapă în căsuță.
  const marimeB = (html, camp) => ((new RegExp('data-camp="' + camp + '"><span>[^<]*</span><b style="font-size:([0-9.]+)pt"').exec(html) || [])[1] || "");
  egal("clientul: litera scade cu lungimea numelui, pe înalt și pe lat",
    [["Client SRL", "100x150"], ["DELIVERY SOLUTIONS S.A.", "100x150"], ["O FIRMĂ CU NUME LUNG S.R.L.", "100x150"], ["DELIVERY SOLUTIONS S.A.", "150x100"], ["O FIRMĂ CU NUMELE FOARTE LUNG S.R.L.", "150x100"]].map(([n, f]) => marimeB(etG({ client: n }, ["client"], f), "client")),
    ["9.5", "8.5", "7.5", "10", "7"]);
  egal("…iar căsuța nebifată n-are nici mărime", marimeB(etG({ client: "DELIVERY SOLUTIONS S.A." }, [], "100x150"), "client"), "");

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
  console.log("\n6b. Greutățile, bifate implicit — și aduse o singură dată în lista salvată înainte");
  {
    const cheieL = (h) => `etichete_campuri_${h}`;
    const salvat = (h) => unul(`SELECT valoare FROM setari_app WHERE cheie = '${cheieL(h)}'`);
    const pune = (cheie, v) => { q(`DELETE FROM setari_app WHERE cheie = '${cheie}'`); if (v !== null) q(`INSERT INTO setari_app (cheie, valoare) VALUES ('${cheie}', '${String(v).replace(/'/g, "''")}')`); };
    const inainte = { mare: salvat("100x150"), mic: salvat("100x50") };
    const bifatG = (html, k) => html.includes(`name="campuri[]" value="${k}" checked`);
    egal("după prima deschidere, versiunea listelor e ținută minte", unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_campuri_versiune'"), "2");
    // O listă salvată înainte de 17.11.2026, fără greutăți.
    pune("etichete_campuri_versiune", null);
    pune(cheieL("100x150"), JSON.stringify(["denumire", "lot", "cantitate", "client", "cod_bare"]));
    pune(cheieL("100x50"), JSON.stringify(["denumire", "lot", "cantitate", "cod_bare"]));
    r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie" } });
    egal("lista salvată înainte primește greutățile: sunt bifate în formular, lângă ce era", [bifatG(r.corp, "greutate_neta"), bifatG(r.corp, "greutate_bruta"), bifatG(r.corp, "client"), bifatG(r.corp, "cantitate"), bifatG(r.corp, "operator")], [true, true, true, true, false]);
    egal("…și scrise în ea, la locul lor între câmpuri", JSON.parse(salvat("100x150")), ["denumire", "lot", "cantitate", "greutate_neta", "greutate_bruta", "client", "cod_bare"]);
    egal("…iar lista hârtiei mici rămâne neatinsă", JSON.parse(salvat("100x50")), ["denumire", "lot", "cantitate", "cod_bare"]);
    egal("…o singură dată: versiunea e ținută minte", unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_campuri_versiune'"), "2");
    await cer("post", "/productie/etichete/setari", ADMIN, { body: { nume: "CASH MACHINE SRL", "implicite_100x150[]": ["client"], "implicite_100x50[]": ["cantitate"] } });
    r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie" } });
    egal("scoase din Setări, scoase rămân", [bifatG(r.corp, "greutate_neta"), bifatG(r.corp, "greutate_bruta"), bifatG(r.corp, "client"), JSON.parse(salvat("100x150")).includes("greutate_neta")], [false, false, true, false]);
    // Fără nimic salvat: lista din cod, cu greutățile — și nu se scrie nimic în locul omului.
    pune("etichete_campuri_versiune", null);
    pune(cheieL("100x150"), null);
    r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie" } });
    egal("fără nimic salvat: greutățile sunt bifate, din lista implicită, și nu se scrie nicio listă", [bifatG(r.corp, "greutate_neta"), bifatG(r.corp, "greutate_bruta"), salvat("100x150"), unul("SELECT valoare FROM setari_app WHERE cheie = 'etichete_campuri_versiune'")], [true, true, null, "2"]);
    bine("formularul spune ce se întâmplă cu un câmp bifat și lăsat gol", r.corp.includes("Un câmp bifat și lăsat gol iese cu numele lui și cu loc de scris de mână"));
    r = await cer("get", "/productie/etichete/previzualizare", PROD, { query: { produs_id: String(P1), format: "100x150", campuri: "greutate_neta,greutate_bruta,operator", lot: "L1" } });
    egal("previzualizarea, fără nicio greutate scrisă: căsuța are numele și bara; operatorul, doar numele", [casutaDin(r.corp, "greutate"), casutaDin(r.corp, "operator")], [["Greutate netă / brută", LOC + " / "], ["Operator", ""]]);
    r = await cer("get", "/productie/etichete/setari", ADMIN);
    bine("setările: exemplele arată căsuța greutăților cu numele ei", r.cod === 200 && cate(r.corp, "Greutate netă / brută") >= 2 && r.corp.includes("iese cu numele lui și cu loc de scris de mână"), cate(r.corp, "Greutate netă / brută"));
    // Înapoi cum era după secțiunea 6, ca restul testului să nu depindă de asta.
    pune(cheieL("100x150"), inainte.mare);
    pune(cheieL("100x50"), inainte.mic);
  }

  // ------------------------------------------------------------------------
  console.log("\n7. Lotul etichetelor ajunge pe recepția din producție");
  egal("lotul etichetelor comenzii, pe produs", [await EM.lotPentruProductie(CP, P1), await EM.lotPentruProductie(CP, P2), await EM.lotPentruProductie(0, P1)], [lotCP, null, null]);
  const randuriRec = (id) => q(`SELECT produs_id, lot, cantitate_asteptata FROM receptii_linii WHERE receptie_id = ${Number(id) || 0}`).map((x) => [Number(x.produs_id), x.lot, Number(x.cantitate_asteptata)]);
  const part = await ST.finalizeazaPartial(CP, { 0: "40" }, { user: PROD });
  egal("finalizată parțial: rândul recepției are lotul etichetelor", [part.eroare || null, randuriRec(part.receptieId)], [null, [[P1, lotCP, 40]]]);
  const recId = await ST.trimiteInDepozit(q(`SELECT * FROM comenzi_productie WHERE id = ${CP}`)[0], { user: PROD });
  egal("restul, trimis în depozit la „Finalizată”: tot cu lotul", randuriRec(recId), [[P1, lotCP, 60]]);

  // ------------------------------------------------------------------------
  // Vali, 16.11.2026: „Să poți genera și etichetele pentru o comandă: selectezi
  // comanda și faci etichete pentru ea.”
  console.log("\n8. Pe comanda clientului");
  q(`INSERT INTO comenzi (id, partener_id, numar, status, data) VALUES (${CO}, ${PARTENER}, '${PREFIX}-CMD-1', 'noua', '${azi()} 09:00:00'), (${CO2}, ${PARTENER}, '${PREFIX}-CMD-2', 'noua', '${azi()} 09:05:00')`);
  q(`INSERT INTO comenzi_linii (id, comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (${LA}, ${CO}, ${P1}, 100, 10, 'rola'), (${LB}, ${CO}, ${P2}, 5, 2, NULL), (${LC}, ${CO2}, ${P2}, 2, 2, NULL)`);
  q(`UPDATE comenzi_productie SET comanda_id = ${CO} WHERE id = ${CP}`);
  const randul = (corp, ce) => (String(corp).split("<tr>").find((t) => t.includes(ce)) || "");
  r = await cer("get", "/productie/etichete", PROD);
  bine("lista: „din comanda clientului”, cu numărul, clientul și câte linii are", r.corp.includes('name="comanda_client"') && r.corp.includes(`<option value="${CO}">${PREFIX}-CMD-1 · ${PREFIX} Client Folie SRL · 2 linii</option>`) && r.corp.includes(`<option value="${CO2}">${PREFIX}-CMD-2 · ${PREFIX} Client Folie SRL · 1 linie</option>`), (r.corp.match(/name="comanda_client"[\s\S]{0,300}/) || [""])[0]);
  // Lotul L1 e făcut din comanda de producție înainte ca ea să fie legată de
  // comandă: comanda îl găsește prin comanda de producție.
  egal("lotul comenzii de producție se numără la comandă și fără comanda scrisă pe el", [unul(`SELECT comanda_id FROM etichete_loturi WHERE id = ${L1.id}`), await EM.numarLoturiComanda(CO)], [null, 1]);
  r = await cer("get", `/productie/etichete/comanda/${CO}`, PROD);
  const rA = randul(r.corp, `${PREFIX} Folie stretch`), rB = randul(r.corp, `${PREFIX} Sac fără cod`);
  bine("pagina comenzii: cele două linii, cu cantitatea și unitatea lor", r.cod === 200 && rA.includes("100 rola") && rB.includes("5 buc") && r.corp.includes(`href="/comenzi/${CO}"`), r.corp.slice(0, 200));
  bine("linia cu comandă de producție: lotul fișei, lotul de etichete de până acum și „Alt lot…” pe comanda de producție", rA.includes(`lot ${lotCP}`) && rA.includes(`href="/productie/etichete/${L1.id}"`) && rA.includes(`comanda_client=${CO}&amp;linie=${LA}&amp;produs_id=${P1}&amp;productie=${CP}`) && rA.includes("Alt lot…"), rA);
  bine("linia fără comandă de producție: încă niciun lot, „Etichete →” pe comanda clientului", rB.includes("încă niciunul") && rB.includes(`comanda_client=${CO}&amp;linie=${LB}&amp;produs_id=${P2}"`) && !rB.includes("productie=") && rB.includes("Etichete →"), rB);
  // Comanda de producție cerută din depozit pentru o anumită linie ține de
  // linia aia: altă linie cu același produs nu-i ia lotul.
  q(`INSERT INTO aprovizionari (id, comanda_id, linie_id, produs_id, cantitate, sursa, status) VALUES (96381, ${CO}, ${LA}, ${P1}, 100, 'productie', 'confirmata')`);
  q(`UPDATE comenzi_productie SET aprovizionare_id = 96381 WHERE id = ${CP}`);
  q(`INSERT INTO comenzi_linii (id, comanda_id, produs_id, cantitate, pret_unitar, um) VALUES (96374, ${CO}, ${P1}, 20, 10, 'rola')`);
  r = await cer("get", `/productie/etichete/comanda/${CO}`, PROD);
  const rD = String(r.corp).split("<tr>").filter((t) => t.includes(`${PREFIX} Folie stretch`));
  bine("linia cerută din depozit își are comanda de producție; a doua linie cu același produs, nu", rD.length === 2 && rD.filter((t) => t.includes(`productie=${CP}`)).length === 1 && rD.some((t) => t.includes(`linie=${LA}&amp;produs_id=${P1}&amp;productie=${CP}`)) && rD.some((t) => t.includes("20 rola") && !t.includes("productie=")), rD.map((t) => t.slice(0, 200)).join(" || "));
  q(`DELETE FROM comenzi_linii WHERE id = 96374`);
  q(`UPDATE comenzi_productie SET aprovizionare_id = NULL WHERE id = ${CP}`);
  q(`DELETE FROM aprovizionari WHERE id = 96381`);
  // Migrarea din lib/db.js: loturile făcute din comenzile de producție ale unei
  // comenzi de client primesc comanda. Se rulează exact textul de acolo.
  const migrare = (require("fs").readFileSync(path.join(RAD, "lib", "db.js"), "utf8").match(/UPDATE etichete_loturi l SET comanda_id = cp\.comanda_id[\s\S]*?;/) || [""])[0];
  bine("migrarea există în lib/db.js", /comanda_id IS NULL/.test(migrare), migrare);
  if (migrare) q(migrare);
  egal("…și lotul făcut din comanda de producție a primit comanda clientului", Number(unul(`SELECT comanda_id FROM etichete_loturi WHERE id = ${L1.id}`)), CO);
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { comanda_client: String(CO), linie: String(LB), produs_id: String(P2) } });
  bine("formularul din comandă: clientul, numărul comenzii, lot nou propus, comanda ținută minte", r.cod === 200 && r.corp.includes(`name="client" value="${PREFIX} Client Folie SRL"`) && r.corp.includes(`name="comanda" value="${PREFIX}-CMD-1"`) && r.corp.includes(`name="lot" value="${lotL}"`) && r.corp.includes(`name="comanda_id" value="${CO}"`) && r.corp.includes(`name="comanda_productie_id" value=""`), (r.corp.match(/name="comanda_id"[^>]*/) || [""])[0]);
  bine("…cu drumul înapoi la etichetele comenzii și linkul spre comandă", r.corp.includes(`href="/productie/etichete/comanda/${CO}">← Etichetele comenzii`) && r.corp.includes(`pentru comanda clientului <a href="/comenzi/${CO}">`));
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { comanda_client: String(CO), linie: String(LA), produs_id: String(P1), productie: String(CP) } });
  bine("linia cu comandă de producție: lotul fișei ei de lot și tot comanda clientului", r.cod === 200 && r.corp.includes(`name="lot" value="${lotCP}"`) && r.corp.includes(`name="comanda_id" value="${CO}"`) && r.corp.includes(`name="comanda_productie_id" value="${CP}"`));
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { comanda_client: String(CO) } });
  egal("comanda cu mai multe linii, fără linie aleasă: pagina comenzii", unde(r), `/productie/etichete/comanda/${CO}`);
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { comanda_client: String(CO2) } });
  bine("comanda cu o singură linie: direct formularul", r.cod === 200 && r.corp.includes(`name="produs_id" value="${P2}"`) && r.corp.includes(`name="comanda" value="${PREFIX}-CMD-2"`) && r.corp.includes(`name="comanda_id" value="${CO2}"`));
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { comanda_client: "99999999" } });
  bine("comanda care nu există: înapoi la listă, cu mesajul", unde(r).startsWith("/productie/etichete?eroare=") && /nu există/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("get", "/productie/etichete/comanda/99999999", PROD);
  bine("…la fel pagina unei comenzi care nu există", unde(r).startsWith("/productie/etichete?eroare="));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P2), comanda_productie_id: "", comanda_id: String(CO), lot: "lot #1" }) });
  bine("lot greșit: înapoi în formular, tot pe comanda clientului", parametri(r).comanda_client === String(CO) && /litere, cifre/.test(parametri(r).eroare || ""), unde(r));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P2), comanda_productie_id: "", comanda_id: String(CO), lot: "tep-cmd-l1", cate: "2" }) });
  const LC1 = q(`SELECT * FROM etichete_loturi WHERE lot = 'TEP-CMD-L1'`)[0] || {};
  egal("lotul făcut din comandă ține minte comanda, fără comandă de producție", [Number(LC1.comanda_id), LC1.comanda_productie_id, Number(LC1.tiparite)], [CO, null, 2]);
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P2), comanda_productie_id: "", comanda_id: "99999999", lot: "TEP-FARA-CMD", cate: "1" }) });
  egal("o comandă care nu există nu se scrie pe lot", unul(`SELECT comanda_id FROM etichete_loturi WHERE lot = 'TEP-FARA-CMD'`), null);
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P1), comanda_productie_id: String(CP), comanda_id: "", lot: "TEP-CP-CMD", cate: "1" }) });
  egal("lotul făcut din comanda de producție ia comanda clientului ei", Number(unul(`SELECT comanda_id FROM etichete_loturi WHERE lot = 'TEP-CP-CMD'`)), CO);
  egal("câte loturi are comanda (pentru butonul de pe ea)", [await EM.numarLoturiComanda(CO), await EM.numarLoturiComanda(CO2), await EM.numarLoturiComanda(0)], [3, 0, 0]);
  r = await cer("get", `/productie/etichete/comanda/${CO}`, PROD);
  bine("pagina comenzii arată acum lotul făcut pe a doua linie", randul(r.corp, `${PREFIX} Sac fără cod`).includes("TEP-CMD-L1") && randul(r.corp, `${PREFIX} Sac fără cod`).includes("2 etichete") && !r.corp.includes("TEP-FARA-CMD"));
  r = await cer("get", "/productie/etichete", PROD, { query: { q: "tep-cmd-1" } });
  bine("lista loturilor: comanda clientului, cu link spre etichetele ei; se caută și după ea", r.corp.includes(`href="/productie/etichete/comanda/${CO}">${PREFIX}-CMD-1</a>`) && r.corp.includes("<strong>TEP-CMD-L1</strong>") && !r.corp.includes("<strong>TEP-FARA-CMD</strong>"));
  r = await cer("get", `/productie/etichete/${LC1.id}`, PROD);
  bine("pagina lotului spune comanda clientului", r.corp.includes(`comanda clientului <a href="/productie/etichete/comanda/${CO}">${PREFIX}-CMD-1</a>`));
  r = await cer("get", `/comenzi/${CO}`, PROD);
  bine("pe pagina comenzii: butonul „Etichete produs”, cu câte loturi are", r.corp.includes(`href="/productie/etichete/comanda/${CO}">Etichete produs (3 loturi)</a>`), (r.corp.match(/[^>]{0,80}Etichete produs[^<]{0,40}/) || [r.cod])[0]);
  r = await cer("get", `/comenzi/${CO2}`, PROD);
  bine("…fără paranteză, când comanda n-are încă etichete", r.corp.includes(`href="/productie/etichete/comanda/${CO2}">Etichete produs</a>`));
  r = await cer("get", `/comenzi/${CO}`, AGENT);
  bine("…pe care agentul fără generator nu-l vede", r.cod !== 500 && !r.corp.includes("/productie/etichete/comanda/"), r.cod);
  r = await cer("get", `/productie/etichete/comanda/${CO}`, AGENT);
  bine("…și nici pagina etichetelor comenzii", unde(r) === "/");

  // ------------------------------------------------------------------------
  // Vali, 16.11.2026: „Gabi să aibă acces la generatorul de etichete.”
  console.log("\n9. Bifa „Etichete produs (doar generatorul)”");
  egal("bifa nouă apare în lista din Utilizatori", auth.ZONE.some((z) => z.cheie === "/productie/etichete" && /doar generatorul/.test(z.eticheta)), true);
  egal("paginile generatorului țin de zona ei, restul Producției de Producție", [auth.sectiune("/productie/etichete"), auth.sectiune(`/productie/etichete/comanda/${CO}`), auth.sectiune("/productie/12"), auth.sectiune("/productie")], ["/productie/etichete", "/productie/etichete", "/productie", "/productie"]);
  egal("Gabi intră în generator, cu toate paginile lui", ["/productie/etichete", "/productie/etichete/noua", `/productie/etichete/comanda/${CO}`, `/productie/etichete/${L1.id}`, "/productie/etichete/previzualizare"].map((x) => auth.poateAccesa(GABI, x)), [true, true, true, true, true]);
  egal("…dar nu în restul Producției", ["/productie", `/productie/${CP}`, "/productie/utilaje", "/productie/retete"].map((x) => auth.poateAccesa(GABI, x)), [false, false, false, false]);
  egal("cine are Producția (bifă sau rol) îl are în continuare; agentul nu", [auth.poateAccesa(BIFA_PROD, "/productie/etichete"), auth.poateAccesa(PROD, "/productie/etichete"), auth.poateAccesa(AGENT, "/productie/etichete")], [true, true, false]);
  const butonProductie = (u) => (render.navPentru(u).find((x) => x.label === "Producție") || {}).href || null;
  egal("butonul Producție: la Gabi duce la generator, la ceilalți la comenzi; agentul nu-l are", [butonProductie(GABI), butonProductie(PROD), butonProductie(BIFA_PROD), butonProductie(AGENT)], ["/productie/etichete", "/productie", "/productie", null]);
  const pag = (u, active) => render.layout({ user: u, title: "T", active, body: "" });
  const pGabi = pag(GABI, "/productie/etichete");
  const subnavGabi = (pGabi.match(/<div class="subnav">[\s\S]*?<\/div>/) || [""])[0];
  bine("pe generator, la Gabi: Producție aprins și din subnav doar „Etichete produs”", pGabi.includes('<a href="/productie/etichete" class="navlink active">Producție</a>') && subnavGabi.includes('href="/productie/etichete"') && !subnavGabi.includes('href="/productie/planificare"') && !subnavGabi.includes('href="/productie"'), subnavGabi);
  const pProd = pag(PROD, "/productie/etichete");
  bine("…iar la Producție: butonul aprins și toată subnavigația", pProd.includes('<a href="/productie" class="navlink active">Producție</a>') && pProd.includes('href="/productie/planificare"') && pProd.includes('href="/productie/etichete" class="subnav-link activ"'));
  bine("pe celelalte pagini, Producție nu se aprinde", !pag(PROD, "/comenzi").includes('class="navlink active">Producție'));
  r = await cer("get", "/productie/etichete", GABI);
  bine("Gabi deschide lista; comenzile de producție apar fără link", r.cod === 200 && r.corp.includes(`<strong>${lotCP}</strong>`) && r.corp.includes(`${PREFIX}-CP-1`) && !r.corp.includes(`href="/productie/${CP}"`), r.cod);
  r = await cer("get", "/productie/etichete", PROD);
  bine("…la Producție, cu link", r.corp.includes(`href="/productie/${CP}"`));
  r = await cer("get", `/productie/etichete/comanda/${CO}`, GABI);
  bine("Gabi deschide etichetele comenzii, tot fără link spre producție", r.cod === 200 && r.corp.includes(`${PREFIX}-CP-1`) && !r.corp.includes(`href="/productie/${CP}"`));
  r = await cer("get", "/productie/etichete/noua", GABI, { query: { comanda_client: String(CO), linie: String(LA), produs_id: String(P1), productie: String(CP) } });
  bine("…și formularul, cu comanda de producție fără link", r.cod === 200 && r.corp.includes(`din comanda de producție ${PREFIX}-CP-1`) && !r.corp.includes(`href="/productie/${CP}"`));
  r = await cer("post", "/productie/etichete", GABI, { body: corp({ produs_id: String(P2), comanda_productie_id: "", comanda_id: String(CO2), lot: "TEP-GABI-1", cate: "3" }) });
  const LG = q(`SELECT * FROM etichete_loturi WHERE lot = 'TEP-GABI-1'`)[0] || {};
  egal("Gabi face un lot pe comanda clientului, pe numele ei", [Number(LG.comanda_id), LG.creat_de, Number(LG.tiparite)], [CO2, GABI.nume, 3]);
  r = await cer("get", `/productie/etichete/${LG.id}`, GABI);
  bine("…și îi vede pagina", r.cod === 200 && r.corp.includes("Lot TEP-GABI-1"));
  r = await cer("get", "/productie/etichete/setari", GABI);
  bine("setările rămân ale administratorului", unde(r) === "/productie/etichete");
  r = await cer("get", `/comenzi/${CO2}`, GABI);
  bine("pe pagina comenzii Gabi are butonul, cu lotul ei", r.corp.includes(`href="/productie/etichete/comanda/${CO2}">Etichete produs (1 lot)</a>`));

  // ------------------------------------------------------------------------
  // Vali, 17.11.2026: „La etichete generator să poți selecta și format landscape
  // sau portrait la ambele formate, și regenerezi tu în funcție de asta."
  console.log("\n9b. Portret sau peisaj, pe ambele hârtii");
  egal("patru grafici: fiecare hârtie, pe înalt și pe lat", Object.entries(E.FORMATE).map(([k, f]) => [k, f.latime, f.inaltime, f.hartie, f.orientare]),
    [["100x150", 100, 150, "100x150", "portret"], ["150x100", 150, 100, "100x150", "peisaj"], ["100x50", 100, 50, "100x50", "peisaj"], ["50x100", 50, 100, "100x50", "portret"]]);
  egal("hârtia + orientarea dau graficul", [E.format("100x150", "peisaj"), E.format("100x150", "portret"), E.format("100x50", "portret"), E.format("100x50", "peisaj"), E.format("150x100", "portret"), E.format("50x100", "peisaj")],
    ["150x100", "100x150", "50x100", "100x50", "100x150", "100x50"]);
  egal("fără orientare sau cu una necunoscută, formatul rămâne cum e (loturile vechi)", [E.format("100x150"), E.format("100x50", ""), E.format("150x100", "pe dos"), E.format("ceva", "peisaj")], ["100x150", "100x50", "150x100", "150x100"]);
  egal("câmpurile țin de hârtie, nu de orientare", [JSON.stringify(E.CAMPURI_FORMAT["150x100"]) === JSON.stringify(E.CAMPURI_FORMAT["100x150"]), JSON.stringify(E.CAMPURI_FORMAT["50x100"]) === JSON.stringify(E.CAMPURI_FORMAT["100x50"]),
    E.campuriAlese("50x100", ["greutate_neta", "client", "cod_bare_lot", "cantitate"])], [true, true, ["denumire", "lot", "cantitate", "cod_bare"]]);
  const cOri = E.continut({ denumire: "Folie stretch", cod: "FSV23", cod_scan: "FSV23", caracteristici: "Grosime: 23 µm\nLățime: 500 mm\nCuloare: transparent", data_productiei: "2026-11-17", cantitate: "36 buc", client: "Client SRL", comanda: "CMD-1" });
  cOri.lot = "CM-261117-1579";
  const peLat = E.eticheta(cOri, E.CAMPURI_FORMAT["150x100"], "150x100", firma, { numar: 3, tiparitLa: "2026-11-17" });
  bine("100×150 pe lat: grafica ei, cu cele opt căsuțe, codul produsului și al lotului", peLat.includes('class="et et-150x100"') && cate(peLat, 'data-camp="') === 8 && cate(peLat, 'class="cod-bare"') === 2 && peLat.includes("Nr. 3 · tipărit 17.11.2026"), peLat.slice(0, 300));
  const ordinea = (html) => (html.match(/data-camp="[a-z_]+"/g) || []).map((x) => x.slice(11, -1));
  egal("…căsuțele, în aceeași ordine ca pe înalt", [ordinea(peLat), JSON.stringify(ordinea(peLat)) === JSON.stringify(ordinea(E.eticheta(cOri, E.CAMPURI_FORMAT["100x150"], "100x150", firma, { numar: 3 })))],
    [["lot", "data_productiei", "cantitate", "greutate", "client", "comanda", "valabilitate", "operator"], true]);
  bine("…lotul, greutățile, clientul și operatorul au câte un rând întreg (pe lat coloana e îngustă), pe șase rânduri",
    /class="c lot"[^>]*data-camp="lot"/.test(peLat) && /class="c lat"[^>]*data-camp="client"/.test(peLat) &&
      E.STIL.includes('.et-150x100 .date .lot, .et-150x100 .date .lat, .et-150x100 .date [data-camp="greutate"], .et-150x100 .date [data-camp="operator"] { grid-column: 1 / -1; }') &&
      /\.et-150x100 \.date \{[^}]*grid-template-rows: repeat\(6, 1fr\)/.test(E.STIL));
  const peInalt = E.eticheta(cOri, E.CAMPURI_FORMAT["50x100"], "50x100", firma, { numar: 3, tiparitLa: "2026-11-17" });
  bine("100×50 pe înalt: grafica ei, cu codul de bare culcat pe latura lungă și fără codul lotului", peInalt.includes('class="et et-50x100"') && peInalt.includes('<div class="rot"><svg class="cod-bare"') && cate(peInalt, 'class="cod-bare"') === 1 && cate(peInalt, 'data-camp="') === 3 && peInalt.includes("Grosime: 23 µm · Lățime: 500 mm") && !peInalt.includes("Culoare"), peInalt.slice(0, 300));
  egal("foaia de tipărit ia mărimea graficii", ["100x150", "150x100", "100x50", "50x100"].map((f) => (E.pagina([""], f).match(/@page \{ size: ([^;]+);/) || [])[1]), ["100mm 150mm", "150mm 100mm", "100mm 50mm", "50mm 100mm"]);

  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie" } });
  bine("formularul întreabă hârtia și orientarea; implicit 100 × 150 pe înalt", cate(r.corp, 'name="format" value="') === 2 && cate(r.corp, 'name="orientare" value="') === 2 && r.corp.includes('name="format" value="100x150" checked') && r.corp.includes('name="orientare" value="portret" checked'));
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie", format: "100x50", orientare: "portret" } });
  bine("…și ține minte ce s-a ales când se întoarce cu o eroare", r.corp.includes('name="format" value="100x50" checked') && r.corp.includes('name="orientare" value="portret" checked') && r.corp.includes("width:210px;height:430px"));
  r = await cer("get", "/productie/etichete/previzualizare", PROD, { query: { produs_id: String(P1), format: "100x150", orientare: "peisaj", campuri: "cantitate", lot: "L1" } });
  bine("previzualizarea pe lat", r.cod === 200 && r.corp.includes("et-150x100") && r.corp.includes("size: 150mm 100mm"));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ lot: "lot #1", orientare: "peisaj" }) });
  egal("eroare la salvare: orientarea se întoarce în formular", parametri(r).orientare, "peisaj");
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P1), comanda_productie_id: "", lot: "ORI-LAT", orientare: "peisaj", cate: "2" }) });
  const LO = q("SELECT id, format, campuri FROM etichete_loturi WHERE lot = 'ORI-LAT'")[0] || {};
  egal("lotul făcut pe lat ține minte grafica", LO.format, "150x100");
  r = await cer("get", unde(r), PROD);
  bine("…și se tipărește pe lat, pe foaia de 150 × 100", cate(r.corp, 'class="et et-150x100"') === 2 && r.corp.includes("size: 150mm 100mm"));
  r = await cer("post", "/productie/etichete", PROD, { body: corp({ produs_id: String(P1), comanda_productie_id: "", lot: "ORI-INALT", format: "100x50", orientare: "portret", cate: "1" }) });
  egal("100 × 50 pe înalt", (q("SELECT id, format FROM etichete_loturi WHERE lot = 'ORI-INALT'")[0] || {}).format, "50x100");
  // Întoarcerea unui lot deja făcut.
  r = await cer("get", `/productie/etichete/${LO.id}`, PROD);
  bine("pagina lotului arată orientarea și o poate întoarce", r.corp.includes(`action="/productie/etichete/${LO.id}/orientare"`) && r.corp.includes('name="orientare" value="peisaj" checked') && r.corp.includes("100 × 150 mm, peisaj") && r.corp.includes("width:630px;height:430px"));
  r = await cer("post", `/productie/etichete/${LO.id}/orientare`, PROD, { body: { orientare: "portret" } });
  egal("întors pe înalt: aceeași hârtie, altă grafică; câmpurile rămân", [unde(r), q(`SELECT id, format FROM etichete_loturi WHERE id = ${LO.id}`)[0].format, q(`SELECT id, campuri FROM etichete_loturi WHERE id = ${LO.id}`)[0].campuri], [`/productie/etichete/${LO.id}`, "100x150", LO.campuri]);
  r = await cer("get", `/productie/etichete/${LO.id}/mostra`, PROD);
  bine("…și de acum se tipărește pe înalt", r.corp.includes("et-100x150") && r.corp.includes("size: 100mm 150mm"));
  await cer("post", `/productie/etichete/${LO.id}/orientare`, PROD, { body: { orientare: "anapoda" } });
  egal("o orientare necunoscută nu schimbă nimic", q(`SELECT id, format FROM etichete_loturi WHERE id = ${LO.id}`)[0].format, "100x150");
  r = await cer("post", `/productie/etichete/${LO.id}/orientare`, AGENT, { body: { orientare: "peisaj" } });
  egal("fără Producție nu se întoarce nimic", [unde(r), q(`SELECT id, format FROM etichete_loturi WHERE id = ${LO.id}`)[0].format], ["/", "100x150"]);
  // Câmpurile bifate implicit se aleg pe hârtie și sunt aceleași în ambele orientări.
  r = await cer("get", "/productie/etichete/setari", ADMIN);
  bine("setările: câmpurile implicite pe cele două hârtii și exemplul fiecărei grafici", cate(r.corp, "(pe înalt și pe lat)") === 2 && cate(r.corp, "<iframe title=\"Exemplu ") === 4 && r.corp.includes('name="implicite_100x150[]"') && !r.corp.includes('name="implicite_150x100[]"'));
  await cer("post", "/productie/etichete/setari", ADMIN, { body: { nume: "CASH MACHINE SRL", "implicite_100x50[]": ["numar"], "implicite_100x150[]": ["client"] } });
  const bifat = (html, k) => html.includes(`name="campuri[]" value="${k}" checked`);
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie", format: "100x50", orientare: "portret" } });
  egal("ce s-a bifat implicit pe 100 × 50 e bifat și pe înalt", [bifat(r.corp, "numar"), bifat(r.corp, "cantitate")], [true, false]);
  r = await cer("get", "/productie/etichete/noua", PROD, { query: { produs: "tep-folie", format: "100x150", orientare: "peisaj" } });
  egal("…iar ce s-a bifat pe 100 × 150, și pe lat", [bifat(r.corp, "client"), bifat(r.corp, "cantitate")], [true, false]);

  // ------------------------------------------------------------------------
  console.log("\n10. Pe hârtie: nicio zonă nu se revarsă, zonele stau pe loc");
  let pw = null;
  try { pw = require("playwright"); } catch (_) { pw = null; }
  if (!pw) console.log("  (fără Playwright aici — sar peste)");
  else {
    const lung = E.continut({ denumire: "Sac Blue PE 860*1000 CM (860*1000) cu imprimare personalizată pe ambele fețe, pentru deșeuri menajere și industriale, rezistent și foarte lung de tot", cod: "SACBLUE860-FOARTE-LUNG", cod_scan: "SACBLUE860-FOARTE-LUNG", caracteristici: "Dimensiune: 860 × 1000 mm cu pliuri laterale și fund stea\nGrosime: 40 µm\nCuloare: albastru\nMaterial: PE reciclat\nImprimare: 2 culori\nAmbalare: 25 buc/rolă\nÎncă un rând care nu mai încape", data_productiei: "2026-11-13", cantitate: "100 buc", greutate_neta: "16,25 kg", greutate_bruta: "16,95 kg", client: "DELIVERY SOLUTIONS S.A. — DEPOZIT CENTRAL CHIAJNA", comanda: "4500024459 / CMD-118", valabilitate: "2027-11-13", operator: "Ionela-Alexandra Popescu-Vasilescu", observatii: "A se depozita la adăpost de soare și umezeală, la cel mult 30 °C" });
    lung.lot = "CM-261113-1553-SUPLIMENTAR";
    const firmaLunga = { nume: "CASH MACHINE S.R.L. — PRODUCȚIE ȘI DISTRIBUȚIE AMBALAJE", adresa: "Str. Emil Racovita 31-33, Vila F16, Voluntari, Jud. Ilfov, România, cod 077190", telefon: "+40 21 404 6404 / +40 722 000 000", email: "office@cashmachine.ro" };
    const b = await pw.chromium.launch();
    const p = await b.newPage();
    for (const fmt of ["100x150", "150x100", "100x50", "50x100"]) {
      // A treia: o denumire de 200 de litere late, care fără plafonul de rânduri ar împinge codul afară.
      const lata = Object.assign({}, c, { denumire: "MWMWMWMWMW ".repeat(19).slice(0, 200) });
      // A patra: datele firmei de acum (Vila Ana, telefonul și emailul de office), pe câmpurile implicite.
      const firmaAzi = Object.assign({ nume: "CASH MACHINE S.R.L." }, E.FIRMA_IMPLICITA);
      const et = [E.eticheta(lung, E.CAMPURI_FORMAT[fmt], fmt, firmaLunga, { numar: 300, tiparitLa: "2026-11-13" }), E.eticheta(c, [], fmt, firma, { numar: 1 }), E.eticheta(lata, E.CAMPURI_FORMAT[fmt], fmt, firma, { numar: 2 }), E.eticheta(c, E.IMPLICITE[fmt], fmt, firmaAzi, { numar: 3, tiparitLa: "2026-11-14" }),
        // A cincea: lotul unei comenzi de producție obișnuite, de 14 caractere.
        E.eticheta(Object.assign({}, c, { lot: "CM-261117-1579" }), E.IMPLICITE[fmt], fmt, firmaAzi, { numar: 4, tiparitLa: "2026-11-17" })];
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
      const h = Math.round(E.FORMATE[fmt].inaltime * 3.7795);
      bine(`${fmt}: eticheta are exact mărimea ei, cu text lung sau scurt`, m.every((x) => Math.abs(x.h - h) <= 1), JSON.stringify(m.map((x) => x.h)));
      bine(`${fmt}: nicio zonă nu se revarsă, nici cu textele cele mai lungi`, m.every((x) => !x.peste.length), JSON.stringify(m.map((x) => x.peste)));
      bine(`${fmt}: toate zonele încap pe etichetă, cu marginea de jos`, m.every((x) => !x.afara.length), JSON.stringify(m.map((x) => x.afara)));
      const maxRanduri = { "100x150": 4, "150x100": 3, "100x50": 2, "50x100": 7 }[fmt];
      bine(`${fmt}: denumirea are cel mult ${maxRanduri} rânduri întregi (restul se taie cu „…”)`, m.every((x) => x.randuri <= maxRanduri + 0.05), JSON.stringify(m.map((x) => x.randuri)));
      bine(`${fmt}: cu datele de acum, numele, adresa, telefonul și emailul încap întregi`, !m[3].taiat.length, JSON.stringify(m[3].taiat));
      bine(`${fmt}: zonele stau la aceeași înălțime pe toate etichetele`, m.every((x) => JSON.stringify(x.sus) === JSON.stringify(m[0].sus)), JSON.stringify(m.map((x) => x.sus)));
      // Lățimea, lotul întreg și codul de bare pe etichetă — mai ales la cele două grafici noi.
      const g = await p.evaluate(() =>
        [...document.querySelectorAll(".et")].map((et) => {
          const e = et.getBoundingClientRect();
          const lot = et.querySelector(".lot b");
          return {
            w: Math.round(e.width),
            lotTaiat: lot ? lot.scrollWidth > lot.clientWidth + 1 : false,
            bareAfara: [...et.querySelectorAll("svg.cod-bare")].filter((s) => { const b = s.getBoundingClientRect(); return b.left < e.left - 1 || b.right > e.right + 1 || b.top < e.top - 1 || b.bottom > e.bottom + 1; }).length,
            bareInalte: [...et.querySelectorAll("svg.cod-bare")].map((s) => { const b = s.getBoundingClientRect(); return b.height > b.width; }),
          };
        })
      );
      bine(`${fmt}: eticheta are și lățimea ei`, g.every((x) => Math.abs(x.w - Math.round(E.FORMATE[fmt].latime * 3.7795)) <= 1), JSON.stringify(g.map((x) => x.w)));
      bine(`${fmt}: lotul unei comenzi de producție (CM-261117-1579) se vede întreg`, !g[4].lotTaiat && !g[3].lotTaiat, JSON.stringify(g.map((x) => x.lotTaiat)));
      bine(`${fmt}: codurile de bare stau pe etichetă`, g.every((x) => !x.bareAfara), JSON.stringify(g.map((x) => x.bareAfara)));
      if (fmt === "50x100") bine("50x100: codul de bare e culcat pe latura lungă", g.every((x) => x.bareInalte.length === 1 && x.bareInalte[0] === true), JSON.stringify(g.map((x) => x.bareInalte)));
      // Căsuțele de completat de mână: numele lor se văd întregi, iar căsuțele nu ies din rândul lor.
      const gol = E.continut({ denumire: "Folie stretch automată", cod: "FSV23", cod_scan: "FSV23", data_productiei: "" });
      gol.lot = "L261117-01";
      const cuClient = Object.assign({}, gol, { client: "DELIVERY SOLUTIONS S.A.", greutate_neta: "576 kg", greutate_bruta: "598 kg", cantitate: "36 role", data_productiei: "2026-11-17" });
      await p.setContent(E.pagina([E.eticheta(gol, E.CAMPURI_FORMAT[fmt], fmt, firma, { numar: 1 }), E.eticheta(cuClient, E.CAMPURI_FORMAT[fmt], fmt, firma, { numar: 2 })], fmt));
      const k = await p.evaluate(() =>
        [...document.querySelectorAll(".et")].map((et) => ({
          nume: [...et.querySelectorAll(".date .c span")].map((x) => x.textContent).filter(Boolean),
          taiate: [...et.querySelectorAll(".date .c span, .date .c b")].filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.parentElement.getAttribute("data-camp") + ":" + x.tagName),
          iesite: [...et.querySelectorAll(".date .c")].filter((x) => x.scrollHeight > x.clientHeight + 1).map((x) => x.getAttribute("data-camp")),
          bara: (() => { const b = et.querySelector('[data-camp="greutate"] b'); if (!b) return null; const r = document.createRange(); r.selectNodeContents(b); const t = b.textContent; const i = t.indexOf("/"); if (i < 0) return null; r.setStart(b.firstChild, i); r.setEnd(b.firstChild, i + 1); return Math.round((r.getBoundingClientRect().left - b.getBoundingClientRect().left) / 3.7795); })(),
        }))
      );
      const mare = E.FORMATE[fmt].hartie === "100x150";
      egal(`${fmt}: fără nicio valoare, fiecare căsuță bifată își arată numele`, k[0].nume, mare ? ["Lot", "Data producției", "Cantitate pe ambalaj", "Greutate netă / brută", "Client", "Comanda", "Valabil până la", "Operator"] : ["Lot", "Data producției", "Cantitate"]);
      bine(`${fmt}: numele căsuțelor se văd întregi, goale sau pline — și clientul cu nume lung`, !k[0].taiate.length && !k[1].taiate.length, JSON.stringify(k.map((x) => x.taiate)));
      bine(`${fmt}: nicio căsuță nu iese din rândul ei`, !k[0].iesite.length && !k[1].iesite.length, JSON.stringify(k.map((x) => x.iesite)));
      if (mare) bine(`${fmt}: în fața barei rămân cel puțin 10 mm de scris pentru greutatea netă`, k[0].bara >= 10 && k[0].bara <= 16, k[0].bara);
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
