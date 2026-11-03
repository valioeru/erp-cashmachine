"use strict";
// Exportul lead-urilor în Excel — doar pentru administratori.
//
// CEREREA LUI VALI, 03.11.2026: „Adminii să poată exporta în xls lista”
// (pagina CRM → Lead-uri).
//
// CE APĂRĂ:
//   • butonul apare doar la admin, iar adresa exportului REFUZĂ pe ceilalți
//     (un buton ascuns se ghicește din adresă);
//   • fișierul e un .xlsx care se deschide: părțile cerute de Excel sunt acolo;
//   • are TOATE lead-urile filtrului, nu primele 300 de pe ecran;
//   • filtrul de pe ecran (căutare, stadiu) e același în fișier;
//   • telefonul rămâne text (zeroul din față), scorul e număr, datele sunt date;
//   • un „&”, un „<” sau un caracter de control dintr-un nume nu strică fișierul;
//   • ruta exportului e înregistrată înaintea lui „/crm/leaduri/:id”, altfel
//     „export.xlsx” ar fi luat drept id de lead.
//
// Rulează pe PostgreSQL real, prin psql (vezi test-depozit.js pentru de ce).
const path = require("path");
const zlib = require("zlib");
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

const rute = { get: {}, post: {} };
const ordine = [];
require(path.join(RAD, "modules", "crm.js")).register({
  get: (p, h) => { ordine.push(p); if (!rute.get[p]) rute.get[p] = h; },
  post: (p, h) => { if (!rute.post[p]) rute.post[p] = h; },
});

const res = () => {
  const o = { cod: 0, antet: {}, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h || {}; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b === undefined ? "" : b; };
  return o;
};
const VALI = { id: 1, nume: "Vali", rol: "admin" };
const AGENT = { id: 97602, nume: "Agent Test Leaduri", rol: "vanzari" };
async function cer(cale, { user = VALI, query = {}, params = {} } = {}) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipsește: GET " + cale);
  const r = res();
  await h({ user, params, query, body: {}, res: r, req: { url: cale } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}

// Arhiva desfăcută din directorul central, exact pe drumul pe care o citește Excel.
function desfa(buf) {
  const sfarsit = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (sfarsit < 0) throw new Error("fără sfârșit de arhivă");
  const nr = buf.readUInt16LE(sfarsit + 10);
  let p = buf.readUInt32LE(sfarsit + 16);
  const out = {};
  for (let i = 0; i < nr; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("intrare centrală stricată la " + p);
    const comprimat = buf.readUInt32LE(p + 20);
    const lungimeNume = buf.readUInt16LE(p + 28);
    const lungimeExtra = buf.readUInt16LE(p + 30);
    const lungimeComent = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const nume = buf.slice(p + 46, p + 46 + lungimeNume).toString("utf8");
    const nl = buf.readUInt16LE(offset + 26);
    const xl = buf.readUInt16LE(offset + 28);
    const date = buf.slice(offset + 30 + nl + xl, offset + 30 + nl + xl + comprimat);
    out[nume] = zlib.inflateRawSync(date).toString("utf8");
    p += 46 + lungimeNume + lungimeExtra + lungimeComent;
  }
  return out;
}
// Rândurile foii, ca text: fiecare <row> cu valorile celulelor lui, în ordine.
function randuri(xml) {
  return [...xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((m) =>
    [...m[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)].map((c) => {
      const t = c[3].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const v = c[3].match(/<v>([\s\S]*?)<\/v>/);
      return { col: c[1], attr: c[2], val: t ? t[1] : v ? v[1] : "" };
    })
  );
}
const celulaDin = (rand, col) => (rand.find((c) => c.col === col) || { val: "", attr: "" });

const CURATENIE = [
  "DELETE FROM interactiuni WHERE lead_id BETWEEN 97801 AND 98199",
  "DELETE FROM leaduri WHERE id BETWEEN 97801 AND 98199",
  "DELETE FROM parteneri WHERE id = 97010",
  "DELETE FROM utilizatori WHERE id = 97602",
];

(async () => {
  for (const s of CURATENIE) { try { exec(s); } catch (e) { if (!/lead_id/.test(String(e.stderr || e.message))) throw e; } }
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (1,'Vali','vali@test.ro','x','y','admin') ON CONFLICT (id) DO NOTHING");
  exec("INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES (97602,'Agent Test Leaduri','agent-lead@test.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING");
  exec("INSERT INTO parteneri (id, nume, cui, tip) VALUES (97010,'GAMMA PACK SRL','RO-LEAD-1','client')");
  exec(`INSERT INTO leaduri (id, nume, companie, persoana_contact, email, telefon, sursa, stadiu, scor, atribuit_lui, partener_id, observatii, creat_la, ultima_activitate) VALUES
    (97801,'Ana Test','Firma Alfa SRL','Ana Popescu','ana@alfa-test.ro','0722000111','site','nou',40,97602,NULL,'vrea folie stretch','2026-10-05 10:00:00','2026-11-01 09:30:00'),
    (97802,'Bogdan Test','Beta Plast SRL',NULL,NULL,'0733000222','recomandare','calificat',0,NULL,NULL,NULL,'2026-10-06 11:00:00',NULL),
    (97803,'Cristi Test','Gamma Pack',NULL,'cristi@gamma-test.ro',NULL,'telefon','convertit',75,97602,97010,NULL,'2026-10-07 12:00:00','2026-10-20 08:00:00'),
    (97804,'Dan & <Co> Test','Delta "Test" SRL' || chr(1),NULL,NULL,NULL,'site','contactat',0,NULL,NULL,'linia 1 & linia 2','2026-10-08 13:00:00',NULL)`);
  // Destule cât să treacă de cele 300 de pe ecran.
  exec(`INSERT INTO leaduri (id, nume, companie, sursa, stadiu, creat_la)
        SELECT 97900 + g, 'Masa Test ' || g, 'Masa SRL', 'campanie', 'nou', '2026-09-01 08:00:00' FROM generate_series(1, 299) g`);
  const toate = Number(q("SELECT COUNT(*) AS n FROM leaduri")[0].n);
  if (!(toate > 300)) rau("fixtura n-a trecut de 300 de lead-uri", String(toate));

  // --- ordinea rutelor --------------------------------------------------------
  const iExport = ordine.indexOf("/crm/leaduri/export.xlsx"), iId = ordine.indexOf("/crm/leaduri/:id");
  if (!(iExport >= 0 && iId >= 0 && iExport < iId)) rau("exportul nu e înregistrat înaintea lui /crm/leaduri/:id", iExport + " / " + iId);
  else ok("exportul e înregistrat înaintea lui /crm/leaduri/:id");

  // --- pagina: butonul doar la admin -----------------------------------------
  let r = await cer("/crm/leaduri", { query: { q: "alfa", stadiu: "nou" } });
  if (!r.corp.includes("↓ Export Excel")) rau("adminul nu vede butonul de export");
  else ok("adminul vede butonul de export");
  if (!/href="\/crm\/leaduri\/export\.xlsx\?q=alfa&stadiu=nou"/.test(r.corp)) rau("butonul nu duce filtrul de pe ecran", (r.corp.match(/href="\/crm\/leaduri\/export\.xlsx[^"]*"/) || [""])[0]);
  else ok("butonul duce același filtru (căutare + stadiu)");
  r = await cer("/crm/leaduri", { user: AGENT });
  if (r.corp.includes("Export Excel") || r.corp.includes("export.xlsx")) rau("agentul vede butonul de export");
  else ok("agentul nu vede butonul");
  if (!r.corp.includes("Pe ecran sunt cele mai noi 300 din " + toate)) rau("pagina nu spune că arată doar 300", "");
  else ok("pagina spune că arată cele mai noi 300 din " + toate);
  if (r.corp.includes("Exportul în Excel le are pe toate")) rau("agentului i se promite exportul");
  r = await cer("/crm/leaduri");
  if (!r.corp.includes("Exportul în Excel le are pe toate")) rau("adminului nu i se spune că exportul le are pe toate");
  else ok("adminului i se spune că exportul le are pe toate");

  // --- agentul e refuzat la adresa exportului --------------------------------
  r = await cer("/crm/leaduri/export.xlsx", { user: AGENT });
  egal("agentul primește refuz", r.cod, 403);
  if (String(r.antet["Content-Type"] || "").includes("spreadsheet")) rau("agentul a primit totuși un fișier Excel");
  else ok("agentul nu primește niciun fișier");

  // --- exportul întreg ---------------------------------------------------------
  r = await cer("/crm/leaduri/export.xlsx");
  egal("adminul primește fișierul", r.cod, 200);
  egal("tipul fișierului e xlsx", r.antet["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const azi = new Date().toISOString().slice(0, 10);
  egal("numele fișierului", r.antet["Content-Disposition"], `attachment; filename="lead-uri-cash-machine-${azi}.xlsx"`);
  const f = desfa(r.corp);
  for (const parte of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"])
    if (!(parte in f)) rau("lipsește din arhivă: " + parte);
  ok("arhiva are părțile cerute de Excel");
  if (!/<sheet name="Lead-uri"/.test(f["xl/workbook.xml"]) || !/<sheet name="Cum a fost scos"/.test(f["xl/workbook.xml"])) rau("foile nu au numele așteptate");
  else ok("foile: „Lead-uri” și „Cum a fost scos”");
  const R = randuri(f["xl/worksheets/sheet1.xml"]);
  egal("antetul", R[0].map((c) => c.val), ["Nume", "Companie", "Persoană de contact", "Email", "Telefon", "Sursă", "Stadiu", "Agent", "Scor", "Client în ERP", "Creat la", "Ultima activitate", "Observații"]);
  egal("toate lead-urile, nu primele 300", R.length - 1, toate);

  const randDe = (nume) => R.find((x) => celulaDin(x, "A").val === nume);
  const ana = randDe("Ana Test");
  if (!ana) rau("lipsește Ana din export");
  else {
    egal("telefonul rămâne text, cu zeroul din față", [celulaDin(ana, "E").val, /inlineStr/.test(celulaDin(ana, "E").attr)], ["0722000111", true]);
    egal("scorul e număr", [celulaDin(ana, "I").val, /t="inlineStr"/.test(celulaDin(ana, "I").attr)], ["40", false]);
    egal("data creării e dată Excel", [celulaDin(ana, "K").val, /s="4"/.test(celulaDin(ana, "K").attr)], ["46300", true]);
    egal("stadiul se scrie cu numele lui", celulaDin(ana, "G").val, "Nou");
    egal("agentul", celulaDin(ana, "H").val, "Agent Test Leaduri");
    egal("persoana de contact și observațiile", [celulaDin(ana, "C").val, celulaDin(ana, "M").val], ["Ana Popescu", "vrea folie stretch"]);
  }
  const bogdan = randDe("Bogdan Test");
  egal("lead-ul fără agent apare „neatribuit”", bogdan ? celulaDin(bogdan, "H").val : null, "neatribuit");
  const cristi = randDe("Cristi Test");
  egal("lead-ul convertit arată clientul din ERP", cristi ? [celulaDin(cristi, "G").val, celulaDin(cristi, "J").val] : null, ["Convertit în client", "GAMMA PACK SRL"]);
  const xml1 = f["xl/worksheets/sheet1.xml"];
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml1)) rau("un caracter de control a ajuns în fișier");
  else ok("caracterul de control din nume a fost curățat");
  if (!xml1.includes("Dan &amp; &lt;Co&gt; Test") || xml1.includes("<Co>")) rau("„&” și „<” nu sunt scrise corect în XML");
  else ok("„&” și „<” din nume sunt scrise corect");

  // --- filtrul de pe ecran e același în fișier ---------------------------------
  r = await cer("/crm/leaduri/export.xlsx", { query: { q: "alfa" } });
  let F = randuri(desfa(r.corp)["xl/worksheets/sheet1.xml"]);
  egal("căutarea „alfa” → doar Ana", F.slice(1).map((x) => celulaDin(x, "A").val), ["Ana Test"]);
  r = await cer("/crm/leaduri/export.xlsx", { query: { stadiu: "convertit" } });
  const g = desfa(r.corp);
  F = randuri(g["xl/worksheets/sheet1.xml"]);
  const convertiteBaza = Number(q("SELECT COUNT(*) AS n FROM leaduri WHERE stadiu = 'convertit'")[0].n);
  egal("stadiul „convertit” → doar convertitele", F.length - 1, convertiteBaza);
  if (!F.slice(1).every((x) => celulaDin(x, "G").val === "Convertit în client")) rau("în filtrul pe stadiu au intrat și alte stadii");
  const cum = randuri(g["xl/worksheets/sheet2.xml"]).map((x) => x.map((c) => c.val).join(" = "));
  for (const b of ["Stadiu = Convertit în client", "Căutare = (fără)", "Scos de = Vali", "Lead-uri în fișier = " + convertiteBaza])
    if (!cum.includes(b)) rau("foaia „Cum a fost scos” nu spune: " + b, cum.join(" | "));
  ok("foaia „Cum a fost scos” spune filtrul, cine și câte");

  // --- curățenie ------------------------------------------------------------------
  for (const s of CURATENIE) { try { exec(s); } catch (e) { if (!/lead_id/.test(String(e.stderr || e.message))) throw e; } }
  console.log(rele ? "\n" + rele + " probleme." : "\nTotul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => {
  console.error("A crăpat:", e.stack || e.message);
  for (const s of CURATENIE) { try { exec(s); } catch (x) { /* best-effort */ } }
  process.exit(1);
});
