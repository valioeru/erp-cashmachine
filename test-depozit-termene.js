"use strict";
// Termenele pe fluxul depozitului, si raspunsul vizibil la apasarea unui
// buton. Pe PostgreSQL real (prin psql).
//
// CE APARA:
//
//   • O CERERE NU PLEACA FARA TERMEN. Se lua din comanda, iar daca aceasta
//     n-avea data de livrare, cererea pleca spre productie sau spre furnizor
//     cu termenul gol. Ce n-are termen nu poate intarzia, deci nu se poate
//     urmari, deci nimeni nu afla ca s-a uitat de ea.
//
//   • FURNIZORUL ARE UNDE SA-SI SCRIE TERMENUL. Pana acum fluxul spre tert
//     avea doar „intra in stoc” si „anuleaza”: ce promitea furnizorul la
//     telefon nu ajungea nicaieri.
//
//   • UN TERMEN MAI TARZIU CERE MOTIV. Peste doua saptamani „de ce
//     intarzie" trebuie sa aiba un raspuns scris.
//
//   • BUTONUL SPUNE CE A FACUT. Apasai „Confirmă”, pagina se reincarca, si
//     daca rezultatul era „asteapta marfa” parea ca nu s-a intamplat nimic.
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 400) + "\n-> " + (e.stderr || e.message)); }
  const L = csv(out).filter((x) => x.length && !(x.length === 1 && x[0] === ""));
  if (!L.length) return [];
  const h = L[0];
  return L.slice(1).map((x) => { const o = {}; h.forEach((k, j) => (o[k] = x[j] === "" ? null : x[j])); return o; });
}
const unul = (sql) => { const r = q(sql); return r[0] ? Object.values(r[0])[0] : null; };

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

const mod = require(path.join(RAD, "modules", "warehouse.js"));
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
async function cer(cale, { params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: VALI, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const unde = (r) => decodeURIComponent((r.antet && r.antet.Location) || "");

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 220) : "")); esecuri++; }
}

const ZI = 86400000;
const peste10 = new Date(Date.now() + 10 * ZI).toISOString().slice(0, 10);
const trecut = new Date(Date.now() - 5 * ZI).toISOString().slice(0, 10);

function curata() {
  q("DELETE FROM aprovizionari WHERE cerut_de = 'Vali' OR comanda_id IN (SELECT id FROM comenzi WHERE numar LIKE 'TT-%')");
  q("DELETE FROM rezervari_stoc WHERE comanda_id IN (SELECT id FROM comenzi WHERE numar LIKE 'TT-%')");
  q("DELETE FROM comenzi_linii WHERE comanda_id IN (SELECT id FROM comenzi WHERE numar LIKE 'TT-%')");
  q("DELETE FROM interactiuni WHERE subiect LIKE 'Comanda TT-%'");
  q("DELETE FROM comenzi WHERE numar LIKE 'TT-%'");
  q("DELETE FROM parteneri WHERE nume IN ('Client Termene SRL','Furnizor Termene SRL')");
}

(async () => {
  curata();
  q("INSERT INTO parteneri (tip, nume) VALUES ('client','Client Termene SRL')");
  q("INSERT INTO parteneri (tip, nume) VALUES ('furnizor','Furnizor Termene SRL')");
  const client = Number(unul("SELECT id FROM parteneri WHERE nume='Client Termene SRL'"));
  const furnizor = Number(unul("SELECT id FROM parteneri WHERE nume='Furnizor Termene SRL'"));
  const produs = Number(unul("SELECT id FROM produse ORDER BY id LIMIT 1"));

  // O comanda FARA data de livrare — exact cazul in care pana acum cererea
  // pleca fara termen.
  q(`INSERT INTO comenzi (partener_id, numar, status) VALUES (${client}, 'TT-1', 'noua')`);
  const c1 = Number(unul("SELECT id FROM comenzi WHERE numar='TT-1'"));
  q(`INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (${c1}, ${produs}, 10, 5)`);
  const l1 = Number(unul(`SELECT id FROM comenzi_linii WHERE comanda_id=${c1}`));

  console.log("\n1. O cerere nu pleacă fără termen");
  {
    const r = await cer("/depozit/comanda/:id/aprovizionare", {
      metoda: "post", params: { id: String(c1) },
      body: { linie_id: String(l1), cantitate: "10", sursa: "tert", furnizor_id: String(furnizor) },
    });
    bine("nu s-a scris nimic", Number(unul(`SELECT count(*) FROM aprovizionari WHERE comanda_id=${c1}`)) === 0);
    bine("si se spune de ce", /urmărită/.test(unde(r)), unde(r));
    bine("cu ce are omul de făcut", /scrie termenul aici|completeaz-o pe comandă/.test(unde(r)));

    const rT = await cer("/depozit/comanda/:id/aprovizionare", {
      metoda: "post", params: { id: String(c1) },
      body: { linie_id: String(l1), cantitate: "10", sursa: "tert", furnizor_id: String(furnizor), termen_cerut: trecut },
    });
    bine("nici cu un termen din trecut", Number(unul(`SELECT count(*) FROM aprovizionari WHERE comanda_id=${c1}`)) === 0);
    bine("si scrie ca e în trecut", /în trecut/.test(unde(rT)), unde(rT));

    await cer("/depozit/comanda/:id/aprovizionare", {
      metoda: "post", params: { id: String(c1) },
      body: { linie_id: String(l1), cantitate: "10", sursa: "tert", furnizor_id: String(furnizor), termen_cerut: peste10 },
    });
    const a = q(`SELECT * FROM aprovizionari WHERE comanda_id=${c1}`)[0];
    bine("cu termen scris pe formular, trece", !!a, "nicio cerere");
    bine("si termenul chiar se scrie", a.termen_cerut === peste10, a.termen_cerut);
    bine("furnizorul se păstrează", Number(a.furnizor_id) === furnizor);
  }

  console.log("\n2. Furnizorul își scrie termenul — pasul care lipsea");
  {
    const a = q(`SELECT * FROM aprovizionari WHERE comanda_id=${c1}`)[0];
    bine("înainte de răspuns e gol", a.termen_confirmat === null);

    // Un termen mai tarziu, fara motiv: refuzat.
    const peste20 = new Date(Date.now() + 20 * ZI).toISOString().slice(0, 10);
    const r = await cer("/depozit/aprovizionare/:id/confirma", {
      metoda: "post", params: { id: String(a.id) }, body: { termen: peste20 },
    });
    bine("mai târziu fără motiv: refuzat", unul(`SELECT termen_confirmat FROM aprovizionari WHERE id=${a.id}`) === null);
    bine("și se spune de ce", /motivul/.test(unde(r)), unde(r));

    // Cu motiv: trece, si se vede cu cat s-a mutat.
    const r2 = await cer("/depozit/aprovizionare/:id/confirma", {
      metoda: "post", params: { id: String(a.id) },
      body: { termen: peste20, motiv: "nu are marfă pe stoc" },
    });
    const d = q(`SELECT * FROM aprovizionari WHERE id=${a.id}`)[0];
    bine("cu motiv, se scrie", d.termen_confirmat === peste20, d.termen_confirmat);
    bine("statusul devine confirmată", d.status === "confirmata");
    bine("motivul rămâne scris", /nu are marfă pe stoc/.test(d.raspuns || ""), d.raspuns);
    bine("și e marcat ca amânare, cu zilele", /amânat cu 10 zile/.test(d.raspuns || ""), d.raspuns);
    // Butonul spune ce a facut.
    bine("pagina confirmă în scris ce s-a salvat", /ok=/.test(unde(r2)) && /amânat cu 10 zile/.test(unde(r2)), unde(r2));
  }

  console.log("\n3. Cererea pentru stoc, scrisă de mână");
  {
    const r = await cer("/depozit/aprovizionare", {
      metoda: "post", body: { produs_id: String(produs), cantitate: "5", sursa: "tert", furnizor_id: String(furnizor) },
    });
    bine("fără termen nu intră", /urmărită/.test(unde(r)), unde(r));
    await cer("/depozit/aprovizionare", {
      metoda: "post",
      body: { produs_id: String(produs), cantitate: "5", sursa: "tert", furnizor_id: String(furnizor), termen_cerut: peste10 },
    });
    const a = q("SELECT * FROM aprovizionari WHERE comanda_id IS NULL AND cerut_de = 'Vali' ORDER BY id DESC LIMIT 1")[0];
    bine("cu termen, intră", !!a && a.termen_cerut === peste10, a && a.termen_cerut);
  }

  console.log("\n4. „Confirmă” spune ce a făcut");
  {
    const r = await cer("/depozit/comanda/:id/confirma", { metoda: "post", params: { id: String(c1) } });
    const u = unde(r);
    bine("redirectul duce înapoi pe comandă", /\/depozit\/comanda\//.test(u));
    bine("cu un mesaj, nu în tăcere", /\?ok=|&ok=/.test(u), u);
    // Cazul care parea ca nu face nimic: marfa nu e pe stoc, comanda ramane
    // in lista, si pana acum pagina arata la fel ca inainte de apasare.
    bine("și mesajul zice ce se întâmplă mai departe", /așteaptă aprovizionarea|pleacă spre livrare|livrare parțială/.test(u), u);
    bine("și că agentul a fost anunțat", /Agentul a fost anunțat/.test(u));
    bine("comanda chiar a fost verificată", unul(`SELECT verificata_depozit_de FROM comenzi WHERE id=${c1}`) === "Vali");
  }

  console.log("\n5. Mesajul chiar se vede pe pagină");
  {
    const p = await cer("/depozit/comanda/:id", { params: { id: String(c1) }, query: { ok: "Verificat de depozit. Nimic nu e pe stoc." } });
    bine("bannerul verde apare", /badge verde[^>]*>Verificat de depozit/.test(p.corp));
    const p2 = await cer("/depozit/comanda/:id", { params: { id: String(c1) }, query: { eroare: "Ceva n-a mers" } });
    bine("și cel roșu, la eroare", /badge rosu[^>]*>Ceva n-a mers/.test(p2.corp));
    const p3 = await cer("/depozit/comanda/:id", { params: { id: String(c1) } });
    bine("fără mesaj, nu apare nimic", !/badge verde[^>]*>Verificat/.test(p3.corp));
  }

  curata();
  console.log(esecuri ? "\n" + esecuri + " ESEC(URI)\n" : "\nToate trecute.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
