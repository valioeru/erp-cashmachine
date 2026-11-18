"use strict";
// Codul nou propus din denumirea produsului vechi. Socoteala fără bază;
// configuratorul și legarea, pe PostgreSQL real.
//
// CEREREA LUI VALI, 18.11.2026: „La «cod nou sau id» sugerează tu codul, în
// funcție de denumire și de convenția noastră nouă."
//
// CE APĂRĂ:
//   • familia se ghicește doar după un cuvânt care e numai al ei; la egalitate, nimic;
//   • din denumire se completează doar ce se citește limpede: măsurile, grosimea,
//     culoarea, valoarea unică a unei liste; restul rămâne gol;
//   • „Fă codul nou…" deschide configuratorul completat, cu produsul vechi ținut minte;
//   • după salvare, produsul vechi e legat de cel nou (propunere) și se ajunge la
//     „ce se mută"; nimic nu se unifică singur;
//   • dacă produsul cu codul acela există deja, nu se face a doua oară: se leagă de el.
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

const D = require(path.join(RAD, "lib", "cod-din-denumire.js"));

const rute = { get: {}, post: {} };
const router = {
  get: (p, h) => { if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
};
for (const m of ["cod-produs", "unificare-coduri"]) require(path.join(RAD, "modules", m + ".js")).register(router);

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
const ADMIN = { id: 97811, nume: "Vali Test", rol: "admin", email: "v.uc@test.ro" };
const AGENT = { id: 97812, nume: "Gabriela Test", rol: "vanzari", email: "g.cd@test.ro" };

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
const bine = (eticheta, conditie, detaliu) => (conditie ? ok(eticheta) : rau(eticheta, detaliu));
const are = (html, ce, eticheta) => (String(html).includes(ce) ? ok(eticheta || "pagina conține „" + ce + "”") : rau("lipsește din pagină", eticheta || ce));
const fara = (html, ce, eticheta) => (String(html).includes(ce) ? rau("nu trebuia să apară", eticheta || ce) : ok(eticheta || "nu apare „" + ce + "”"));
const nr = (v) => (v === null || v === undefined ? null : Number(v));


const VECHI = 97881, FARA = 97882;
function curata() {
  for (const s of [
    "DELETE FROM produse_asocieri WHERE vechi_id BETWEEN 97881 AND 97889",
    "DELETE FROM produse_cod_valori WHERE produs_id IN (SELECT id FROM produse WHERE denumire LIKE '%TCDD%' OR creat_de = 97811)",
    "DELETE FROM produse WHERE id BETWEEN 97881 AND 97889 OR creat_de = 97811",
    "DELETE FROM utilizatori WHERE id BETWEEN 97811 AND 97819",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
}
const parametri = (r) => Object.fromEntries(new URLSearchParams(String(locatie(r)).split("?")[1] || ""));

(async () => {
  console.log("── Familia, din denumire ────────────────────────────────────");
  const FAM = [{ id: 1, nume: "Folie stretch" }, { id: 2, nume: "Pungă curier" }, { id: 3, nume: "Sac SGR" }, { id: 5, nume: "Sac menajer" }, { id: 6, nume: "Bandă adezivă" }, { id: 7, nume: "Cutie carton" }, { id: 8, nume: "Folie debitată" }, { id: 9, nume: "Folie cu bule" }];
  const f = (d, c) => D.ghicesteFamilia(d, c, FAM);
  egal("după cuvântul care e doar al ei: bandă, cutie, pungă, stretch (și jumbo), bule, debitată",
    [f("Banda adeziva acryl Alb 48mm x 60m"), f("CUTIE 360X240X300 IMP"), f("Punga curier, LDPE COEX 45 my"), f("Stretch standard automat 23mm", "SSA23/16/2000"), f("JUMBO JLP23NEGRUPF NegruCM"), f("Folie cu bule natur 40 my"), f("Folii debitate 500x700")],
    [6, 7, 2, 1, 1, 9, 8]);
  egal("fără un cuvânt numai al ei nu se alege nimic: „folie” singur, un tub, un sac care poate fi de două feluri", [f("Folie 500 mm"), f("SP 470 50/63 350 gr", "7441399"), f("Sac negru 780x1350"), f("", "")], [0, 0, 0, 0]);
  egal("…dar sacul spus pe nume, da; iar cel care le spune pe amândouă nu se alege", [f("Sac menajer 60 L negru"), f("Sac SGR 800x1200"), f("Sac SGR menajer")], [5, 3, 0]);

  console.log("\n── Caracteristicile, din denumire ───────────────────────────");
  const BANDA = [
    { id: 40, nume: "Tip", fel: "lista", valori: [{ valoare: "Bandă adezivă" }] },
    { id: 41, nume: "Zgomot", fel: "lista", valori: [{ valoare: "Low noise" }, { valoare: "Normal" }] },
    { id: 42, nume: "Culoare", fel: "lista", valori: [{ valoare: "Transparent" }, { valoare: "Maro" }, { valoare: "Alb" }] },
    { id: 43, nume: "Lățime", fel: "numar", um: "mm" },
    { id: 44, nume: "Lungime rolă", fel: "numar", um: "m" },
    { id: 45, nume: "Grosime", fel: "numar", um: "microni", min_val: 20, max_val: 60 },
    { id: 46, nume: "Diametru core", fel: "numar", um: "mm" },
    { id: 47, nume: "Marca", fel: "text" },
  ];
  egal("banda: valoarea unică a listei, zgomotul, măsurile în ordine, grosimea; culoarea nespusă și textul liber rămân goale",
    D.completeaza("Banda adeziva Low Noise 48x60 m,45 mic", "noise60", BANDA), { 43: "48", 44: "60", 40: "Bandă adezivă", 41: "Low noise", 45: "45" });
  egal("culoarea spusă se alege, și când e scrisă „TR” sau lipită în cod", [D.completeaza("Banda acryl Alb 48mm x 60m, 40 microni", "1052", BANDA)[42], D.completeaza("Banda 48x66 TR", "", BANDA)[42], D.completeaza("Banda 48x66", "BANDAMARO", BANDA)[42]], ["Alb", "Transparent", "Maro"]);
  egal("grosimea din afara limitelor caracteristicii nu se pune", D.completeaza("Banda 48x60 120 microni", "", BANDA)[45], undefined);
  const CUTIE = [{ id: 49, nume: "Lungime", fel: "numar", um: "mm" }, { id: 50, nume: "Lățime", fel: "numar", um: "mm" }, { id: 51, nume: "Înălțime", fel: "numar", um: "mm" }, { id: 48, nume: "Fel", fel: "lista", valori: [{ valoare: "Americană" }, { valoare: "Simplă" }] }, { id: 52, nume: "Tip", fel: "lista", valori: [{ valoare: "Cutie carton" }] }];
  egal("cutia: cele trei măsuri merg, în ordine, la lungime, lățime, înălțime; felul nespus rămâne gol; lista cu o singură valoare se alege și când denumirea n-o spune", D.completeaza("Cutie 485X295X335-D7 CO3", "CUTD7485295335", CUTIE), { 49: "485", 50: "295", 51: "335", 52: "Cutie carton" });
  egal("mai multe măsuri decât caracteristici de dimensiune: nu se ghicește care e care", D.completeaza("Banda 48x60x76", "", BANDA)[43], undefined);
  const STRETCH = [{ id: 5, nume: "Aplicare", fel: "lista", valori: [{ valoare: "Manuală" }, { valoare: "Automată" }] }, { id: 7, nume: "Grosime", fel: "numar", um: "microni" }, { id: 8, nume: "Lungime", fel: "numar", um: "metri" }, { id: 9, nume: "Greutate", fel: "numar", um: "kg" }];
  egal("folia: manuală/automată, grosimea, lungimea scrisă cu „m”, greutatea scrisă cu „kg”", [D.completeaza("Folie stretch manuala 17my 300 m 2,1 kg", "", STRETCH), D.completeaza("Stretch automat 23 microni", "", STRETCH)], [{ 5: "Manuală", 7: "17", 8: "300", 9: "2.1" }, { 5: "Automată", 7: "23" }]);
  egal("două valori care se potrivesc la fel de bine: nu se alege niciuna", D.completeaza("Folie manuala si automata", "", STRETCH)[5], undefined);

  console.log("\n── „Fă codul nou…”, pe bază ─────────────────────────────────");
  curata();
  const fam = q("SELECT id, nume FROM cod_familii WHERE activ = 1 ORDER BY id");
  const banda = fam.find((x) => /band/i.test(x.nume));
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97811,'Vali Unificare','v.uc@test.ro','x','y','admin')");
  exec(`INSERT INTO produse (id, cod, denumire, unitate_masura, nascut_la) VALUES (${VECHI}, 'TCDD-1052', 'Banda adeziva acryl Alb 48mm x 60m, 40 microni TCDD', 'rola', NULL), (${FARA}, 'TCDD-X', 'Ceva fara familie TCDD', 'buc', NULL)`);
  exec(`INSERT INTO ct_paleti (cod, produs_id, cantitate, cantitate_intrare, um, data_intrare) VALUES ('TUC-PAL-CDD', ${VECHI}, 10, 10, 'rola', '2026-11-10')`);
  let r = await cer("/configurari/unificare-coduri", { query: { q: "TCDD" } });
  bine("lista de unificat are butonul pe rândul produsului vechi", r.corp.includes(`data-fa-cod-nou href="/produse/nou-cu-cod?din=${VECHI}"`) && r.corp.includes("Fă codul nou…"));
  if (!banda) rau("baza de test n-are familia de benzi: configuratorul n-a fost încercat");
  else {
    r = await cer("/produse/nou-cu-cod", { query: { din: String(VECHI) } });
    const car = q("SELECT id, nume, fel FROM cod_caracteristici WHERE familie_id = ? AND activ = 1 ORDER BY ordine, id", [banda.id]);
    const idDe = (nume) => (car.find((c) => new RegExp(nume, "i").test(c.nume)) || {}).id;
    const valInput = (id) => ((r.corp.match(new RegExp(`name="c_${id}"[^>]*value="([^"]*)"`)) || [])[1]);
    bine("configuratorul se deschide pe familia ghicită, cu produsul vechi spus sus și ținut minte în formular",
      r.cod === 200 && r.corp.includes(`id="f-familie" value="${banda.id}"`) && r.corp.includes(`data-cod-nou-pentru="${VECHI}"`) && r.corp.includes("Cod nou pentru:") && r.corp.includes(`name="din" value="${VECHI}"`));
    egal("…cu lățimea, lungimea și grosimea citite din denumire și cu unitatea produsului vechi", [valInput(idDe("^l[ăa][țt]ime")), valInput(idDe("lungime")), valInput(idDe("grosime")), /name="unitate_masura" value="rola"/.test(r.corp)], ["48", "60", "40", true]);
    bine("…și cu culoarea aleasă", /<option value="Alb" selected>/.test(r.corp));
    bine("schimbarea familiei ține minte produsul vechi", r.corp.includes(`href="/produse/nou-cu-cod?familie=${banda.id}&amp;din=${VECHI}"`));
    const simplu = await cer("/produse/nou-cu-cod", { query: {} });
    bine("configuratorul deschis fără produs vechi e ca până acum", !simplu.corp.includes("Cod nou pentru:") && !simplu.corp.includes('name="din"'));
    const fara = await cer("/produse/nou-cu-cod", { query: { din: String(FARA) } });
    bine("produsul căruia nu i se poate ghici familia: configuratorul se deschide oricum, cu el ținut minte", fara.cod === 200 && fara.corp.includes(`name="din" value="${FARA}"`));

    // ce a rămas gol se completează ca un om: prima valoare din listă, un număr la cele numerice
    const corp = { familie: String(banda.id), din: String(VECHI), denumire: "", unitate_masura: "rola", cota_tva: "21" };
    for (const c of car) {
      const m = r.corp.match(new RegExp(`<select name="c_${c.id}"[\\s\\S]*?</select>`));
      if (m) {
        const ales = (m[0].match(/<option value="([^"]+)" selected>/) || [])[1];
        corp["c_" + c.id] = ales || (m[0].match(/<option value="([^"]+)"/) || [])[1] || "";
      } else corp["c_" + c.id] = valInput(c.id) || (c.fel === "numar" ? "76" : "TCDD");
    }
    r = await cer("/produse/nou-cu-cod", { metoda: "post", body: corp });
    const nou = q("SELECT id, cod, cod_familie_id, 1 AS x FROM produse WHERE creat_de = 97811 ORDER BY id DESC LIMIT 1")[0];
    bine("salvarea face produsul cu cod nou, din configurator", Boolean(nou && Number(nou.cod_familie_id) === Number(banda.id) && nou.cod), locatie(r) + " " + String(r.corp).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
    if (nou) {
      egal("…îl leagă de cel vechi, ca propunere, și duce la „ce se mută”; nimic nu s-a unificat", [String(locatie(r)).split("?")[0], parametri(r).vechi, parametri(r).nou, q("SELECT stare, fel FROM produse_asocieri WHERE vechi_id = ? AND nou_id = ?", [VECHI, nou.id]).map((x) => [x.stare, x.fel]), Number(q("SELECT activ, 1 AS x FROM produse WHERE id = ?", [VECHI])[0].activ)],
        ["/configurari/unificare-coduri/unifica", String(VECHI), String(nou.id), [["propusa", "de_mana"]], 1]);
      exec(`DELETE FROM produse_asocieri WHERE vechi_id = ${VECHI}`);
      r = await cer("/produse/nou-cu-cod", { metoda: "post", body: corp });
      egal("a doua oară produsul există deja: nu se mai face, cel vechi se leagă de cel existent", [Number(q("SELECT COUNT(*) AS n, 1 AS x FROM produse WHERE creat_de = 97811")[0].n), parametri(r).nou, q("SELECT stare FROM produse_asocieri WHERE vechi_id = ? AND nou_id = ?", [VECHI, nou.id]).map((x) => x.stare)], [1, String(nou.id), ["propusa"]]);
      const fd = Object.assign({}, corp); delete fd.din;
      r = await cer("/produse/nou-cu-cod", { metoda: "post", body: fd });
      bine("fără produs vechi, același lucru e refuzat ca până acum: „există deja”", r.cod === 400 && /Produsul există deja/.test(r.corp));
    }
  }
  execFileSync("psql", ["-X", "-q", "-c", "DELETE FROM ct_paleti WHERE cod = 'TUC-PAL-CDD'"], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  curata();
  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.stack || e.message); try { curata(); } catch (x) {} process.exit(1); });
