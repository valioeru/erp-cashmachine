"use strict";
// Test pentru raportul „Clienți cheie vs. restul".
//
// Ce apără, în ordinea în care doare dacă se strică:
//   • sumele sunt FĂRĂ TVA. Dacă se strecoară cota, fiecare cifră e cu 19%
//     mai mare și procentele par corecte — adică greșeala nu se vede;
//   • excluderile se aplică ÎNAINTE de procente. Altfel numitorul conține
//     exact ce am scos, iar procentele sunt minciuni rotunde;
//   • „POȘTA ROMÂNĂ S.A." și „Posta Romana SA" sunt aceeași firmă. Numărate
//     separat, raportul arată două firme mici în loc de una mare;
//   • pragul Warehouse All taie DOAR facturile de la Warehouse All, nu pe
//     toate cele mari.
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
  run: async (...p) => { const r = q(sql, p); return { lastInsertRowid: r[0] && r[0].id ? Number(r[0].id) : undefined }; },
});

const mod = require(path.join(RAD, "modules", "clienti-cheie.js"));
const rute = { get: {}, post: {} };
mod.register({
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
const VALI = { id: 1, nume: "Vali", rol: "admin" };
async function cer(cale, { query = {} } = {}) {
  const h = rute.get[cale];
  if (!h) throw new Error("ruta lipsește: GET " + cale);
  const r = res();
  await h({ user: VALI, params: {}, query, body: {}, res: r, req: { url: cale } });
  return r;
}

let rele = 0;
const ok = (e) => console.log("  ok       " + e);
const rau = (e, d) => { console.log("  PROBLEMĂ " + e + (d ? ": " + d : "")); rele++; };
function egal(eticheta, avut, asteptat) {
  const a = JSON.stringify(avut), b = JSON.stringify(asteptat);
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta + " = " + b);
}
const rot = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  // Toate facturile fixturii sunt în ianuarie și februarie 2026, ca raportul
  // să aibă exact două luni și cifrele să se poată număra pe degete.
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id BETWEEN 96501 AND 96599",
    "DELETE FROM facturi WHERE id BETWEEN 96501 AND 96599",
    "DELETE FROM parteneri WHERE cui LIKE 'RO-CK-%'",
    "DELETE FROM firme WHERE cui IN ('CK-CM','CK-WH')",
    `INSERT INTO firme (id, nume, cui, culoare, in_grup, implicita, operationala) VALUES
       (96601,'Cash Machine SRL test','CK-CM','#000',1,0,1),
       (96602,'Warehouse All SRL test','CK-WH','#000',1,0,1)
     ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO parteneri (id, nume, cui, tip) VALUES
       (96501,'DELIVERY SOLUTIONS S.A.','RO-CK-1','client'),
       (96502,'URGENT CARGUS SA','RO-CK-2','client'),
       (96503,'DANTE INTERNATIONAL SA (eMAG Retail)','RO-CK-3','client'),
       (96504,'COMPANIA NATIONALA POSTA ROMANA S.A.','RO-CK-4','client'),
       (96505,'Posta Romana SA','RO-CK-5','client'),
       (96506,'UN CLIENT OARECARE SRL','RO-CK-6','client'),
       (96507,'NEGRU AND NEGRU SRL','RO-CK-7','client'),
       (96508,'BCR LEASING IFN SA','RO-CK-8','client'),
       (96520,'DEPANERO SRL','RO-CK-20','client'),
       (96521,'Stoc Depanero','RO-CK-21','client')`,
  ]) exec(s);

  // O factură = un rând aici. Net-ul se scrie ca o singură linie, cu TVA 19%,
  // ca să se vadă dacă raportul scapă cota în sumă.
  const F = [
    // id, partener, luna, firma, net
    [96501, 96501, "2026-01-10", 96601, 10000],  // Delivery
    [96502, 96502, "2026-01-12", 96601, 5000],   // Cargus
    [96503, 96503, "2026-01-15", 96601, 3000],   // eMAG (Dante)
    // Poșta nu mai e grup din 24.10.2026 — banii ei trebuie să apară la
    // „Ceilalți", nu să dispară. Două nume scrise diferit, ca înainte: dacă
    // vreodată se întoarce ca grup, tot o singură coloană trebuie să facă.
    [96504, 96504, "2026-01-20", 96601, 1000],   // Poșta, nume lung → Ceilalți
    [96505, 96505, "2026-01-22", 96601, 1000],   // Poșta, alt nume → Ceilalți
    // Depanero, grupul nou. „Stoc Depanero" e contul de marfă în custodie al
    // aceluiași client: aceeași bucată de nume, deci aceeași coloană.
    [96520, 96520, "2026-01-23", 96601, 1200],   // DEPANERO SRL
    [96521, 96521, "2026-01-24", 96601, 800],    // Stoc Depanero — TOT Depanero
    [96506, 96506, "2026-01-25", 96601, 3000],   // ceilalți
    [96507, 96507, "2026-01-26", 96601, 90000],  // Negru and Negru — se scoate
    [96508, 96508, "2026-01-27", 96601, 70000],  // BCR Leasing — se scoate
    // februarie
    [96509, 96501, "2026-02-05", 96601, 20000],  // Delivery
    [96510, 96506, "2026-02-06", 96601, 30000],  // ceilalți
    [96511, 96506, "2026-02-07", 96602, 250000], // Warehouse All, peste ambele praguri
    [96512, 96506, "2026-02-08", 96602, 150000], // Warehouse All: iese la 100.000, rămâne la 200.000
    [96513, 96506, "2026-02-09", 96601, 250000], // mare, dar NU Warehouse — rămâne
  ];
  for (const [id, part, data, firma, net] of F) {
    exec(
      `INSERT INTO facturi (id, serie, numar, partener_id, firma_id, directie, data_emiterii, status, activ, intercompany)
       VALUES (${id},'CK',${id},${part},${firma},'vanzare','${data}','emisa',1,0)`
    );
    exec(
      `INSERT INTO facturi_linii (factura_id, denumire, cantitate, pret_unitar, cota_tva)
       VALUES (${id},'marfa',1,${net},19)`
    );
  }
  // O factură fără nicio linie: trebuie numărată și semnalată, nu ascunsă.
  exec(
    `INSERT INTO facturi (id, serie, numar, partener_id, firma_id, directie, data_emiterii, status, activ, intercompany)
     VALUES (96514,'CK',96514,96506,96601,'vanzare','2026-02-10','emisa',1,0)`
  );

  // Pragul implicit e acum 100.000 — coborât de Vali de la 200.000.
  egal("pragul implicit e 100.000", mod.PRAG_IMPLICIT, 100000);

  // --- împreună (cum se vede din start) -------------------------------------
  const d = await mod.culege({ deLa: "2026-01-01", panaLa: "2026-02-28", prag: 100000 });
  egal("grupurile sunt Delivery+Cargus, eMAG și Depanero — fără Poșta",
    d.grupuri.map((g) => g.nume), ["Delivery + Cargus", "eMAG Retail", "Depanero"]);

  const ian = d.luni.find((x) => x[0] === "2026-01")[1];
  egal("ianuarie: sumele sunt fără TVA, cu curierii adunați",
    [rot(ian.curieri), rot(ian.emag), rot(ian.depanero), rot(ian.altii), rot(ian.total)],
    [15000, 3000, 2000, 5000, 25000]);
  ok("Depanero apare o singură dată, deși are două conturi (1200 + 800)");

  // Poșta a ieșit dintre grupuri, dar banii ei nu s-au evaporat: 1000 + 1000
  // trebuie să fie în „Ceilalți", lângă cei 3000 ai clientului oarecare.
  egal("Poșta nu mai are coloană, dar cei 2000 ai ei sunt la Ceilalți", rot(ian.altii), 5000);
  egal("și nu mai există deloc o cheie «posta» în lună", ian.posta === undefined, true);

  // 15000/25000 = 60%
  egal("procentele se calculează după excluderi", rot((ian.curieri / ian.total) * 100), 60);

  // --- februarie: pragul de 100.000 taie AMBELE facturi Warehouse ------------
  const feb = d.luni.find((x) => x[0] === "2026-02")[1];
  egal("februarie: la 100.000 ies ambele facturi Warehouse, cea mare non-Warehouse rămâne",
    [rot(feb.curieri), rot(feb.altii), rot(feb.total)],
    [20000, 280000, 300000]);
  egal("factura fără linii e numărată, dar valorează zero", [feb.nr, feb.faraLinii], [4, 1]);

  // --- excluderile --------------------------------------------------------
  egal("Negru and Negru + BCR Leasing, scoase cu tot cu sumă",
    [d.scoase.excluse, rot(d.scoase.sumaExcluse)], [2, 160000]);
  egal("două facturi Warehouse peste prag",
    [d.scoase.warehouse, rot(d.scoase.sumaWarehouse)], [2, 400000]);

  // --- totalul ------------------------------------------------------------
  egal("totalul e suma lunilor", rot(d.total.total), rot(ian.total + feb.total));

  // --- separat, la cerere ---------------------------------------------------
  const ds = await mod.culege({ deLa: "2026-01-01", panaLa: "2026-02-28", prag: 100000, separat: true });
  egal("cu separat=1 revin patru coloane",
    ds.grupuri.map((g) => g.nume), ["Delivery Solutions", "Cargus", "eMAG Retail", "Depanero"]);
  const ianS = ds.luni.find((x) => x[0] === "2026-01")[1];
  egal("separat, suma lor e aceeași ca împreună",
    rot(ianS.delivery + ianS.cargus), rot(ian.curieri));
  egal("și nu se schimbă nici totalul, nici ceilalți",
    [rot(ianS.total), rot(ianS.altii)], [rot(ian.total), rot(ian.altii)]);

  // --- pragul se poate schimba din pagină -----------------------------------
  const d2 = await mod.culege({ deLa: "2026-01-01", panaLa: "2026-02-28", prag: 200000 });
  egal("înapoi la 200.000, iese o singură factură Warehouse", d2.scoase.warehouse, 1);
  egal("iar februarie urcă la loc cu cea de 150.000",
    rot(d2.luni.find((x) => x[0] === "2026-02")[1].total), 450000);

  // --- pagina --------------------------------------------------------------
  const r = await cer("/rapoarte/clienti-cheie", { query: { de_la: "2026-01-01", pana_la: "2026-02-28" } });
  const fara = r.corp.replace(/<script[\s\S]*?<\/script>/g, "");
  if (r.cod !== 200) rau("pagina nu se deschide", String(r.cod));
  else if (/NaN|Infinity|undefined</.test(fara)) rau("NaN/undefined în pagină");
  else {
    const lipsa = ["Delivery + Cargus", "eMAG Retail", "Depanero", "Ceilalți", "60,0%", "n-au nicio linie", "Vezi-i separat"]
      .filter((b) => !fara.includes(b));
    if (lipsa.length) rau("lipsește din pagină", lipsa.join(", "));
    else ok("pagina arată grupurile, procentele și avertismentul (" + r.corp.length + " octeți)");
  }
  // Atenție la verificarea asta: numele „Poșta Română" APARE în pagină, în
  // rândul care explică de ce a ieșit. Ce nu trebuie să mai existe e CAPUL
  // DE COLOANĂ. Prima variantă a testului căuta numele oriunde și se plângea
  // de propria explicație.
  if (/<th[^>]*>\s*Poșta Română\s*<\/th>/.test(fara))
    rau("Poșta Română încă are coloană, deși a fost scoasă dintre grupuri");
  else ok("Poșta Română nu mai are cap de coloană, doar lămurirea de dedesubt");
  if (!fara.includes("DELIVERY SOLUTIONS S.A.") || !fara.includes("URGENT CARGUS SA"))
    rau("pagina nu spune ce firme au intrat în grupul comun");
  else ok("pagina spune ce firme au intrat în fiecare grup, inclusiv amândouă la curieri");

  // --- clienți activi -------------------------------------------------------
  // „Nr de clienti activi (adica facturi la clienti distincti pe luna)".
  //
  // Ianuarie: opt facturi intră în raport, de la opt fișe de client —
  // Delivery, Cargus, Dante, cele două fișe de Poșta, cele două de Depanero,
  // clientul oarecare. Negru and Negru și BCR Leasing sunt scoase cu totul,
  // deci nu se numără: coloana trebuie să arate clienții DIN raport, nu din
  // facturier.
  //
  // Cele două fișe de Poșta și cele două de Depanero se numără separat,
  // intenționat: sunt fișe distincte în baza de parteneri. Dacă e o
  // dublare reală, se repară în parteneri, nu aici.
  egal("ianuarie: 8 clienți distincți din 8 facturi care au intrat", [ian.clienti.size, ian.nr], [8, 8]);
  // Februarie: Delivery o dată, clientul oarecare de trei ori (a patra lui
  // factură e cea Warehouse, scoasă la pragul de 100.000). Patru facturi,
  // doi clienți — exact ce trebuie să arate coloana.
  egal("februarie: 4 facturi, dar numai 2 clienți", [feb.nr, feb.clienti.size], [4, 2]);
  // Totalul NU e suma lunilor: Delivery și clientul oarecare cumpără în
  // ambele luni, deci 8 + 2 ar da 10, iar distincți sunt 8.
  egal("totalul numără clienții o singură dată, nu lună de lună",
    [d.total.clienti.size, ian.clienti.size + feb.clienti.size], [8, 10]);
  {
    if (!/<th[^>]*>\s*Clienți activi\s*<\/th>/.test(fara)) rau("lipsește coloana „Clienți activi” din tabel");
    else if (!fara.includes("distincți, nu suma")) rau("totalul nu spune că nu e o sumă");
    else ok("tabelul are coloana „Clienți activi”, iar totalul spune că nu e o sumă");
    if (!fara.includes("facturi · 8 clienți")) rau("cardul de sus nu arată numărul de clienți");
    else ok("cardul de sus arată și câți clienți distincți sunt");
  }

  const rs = await cer("/rapoarte/clienti-cheie", { query: { de_la: "2026-01-01", pana_la: "2026-02-28", separat: "1" } });
  if (!rs.corp.includes("Numără-i împreună")) rau("din pagina separată nu se poate reveni");
  else ok("din pagina separată se revine la coloana comună");

  // eMAG se prinde după numele juridic, nu după cel de pe cutie.
  egal("eMAG Retail se recunoaște și ca Dante International",
    !!mod.potrivit(mod.grupuri(true), mod.strans("DANTE INTERNATIONAL S.A.")), true);

  // Luna cea mai recentă stă sus. Tabelul pornește de acum un an, iar luna
  // care interesează pe oricine deschide pagina e ultima — cu cea mai veche
  // sus trebuia derulat până jos de fiecare dată.
  {
    const p = await cer("/rapoarte/clienti-cheie", { de_la: "2025-10-01", pana_la: "2026-10-24" });
    const luni = (p.corp.match(/>(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec) (\d{4})</g) || [])
      .map((x) => x.replace(/[><]/g, ""));
    if (luni.length < 2) ok("prea puține luni ca să verific ordinea (" + luni.length + ")");
    else {
      const L = ["ian","feb","mar","apr","mai","iun","iul","aug","sep","oct","nov","dec"];
      const cheie = (t) => { const [m, a2] = t.split(" "); return Number(a2) * 12 + L.indexOf(m); };
      const descrescator = luni.every((t, i) => i === 0 || cheie(t) <= cheie(luni[i - 1]));
      if (descrescator) ok("lunile vin de la cea mai recentă în jos (" + luni[0] + " prima)");
      else rau("lunile nu sunt în ordine inversă: " + luni.slice(0, 4).join(" → "));
    }
  }

  // --- curățenie după noi ----------------------------------------------------
  for (const s of [
    "DELETE FROM facturi_linii WHERE factura_id BETWEEN 96501 AND 96599",
    "DELETE FROM facturi WHERE id BETWEEN 96501 AND 96599",
    "DELETE FROM parteneri WHERE cui LIKE 'RO-CK-%'",
    "DELETE FROM firme WHERE cui IN ('CK-CM','CK-WH')",
  ]) execFileSync("psql", ["-X", "-q", "-c", s], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });

  console.log("\n" + interogari + " interogări SQL reale.");
  console.log(rele ? rele + " probleme." : "Totul curat.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error("A crăpat:", e.message); process.exit(1); });
