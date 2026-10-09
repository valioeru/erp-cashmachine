"use strict";
// Comanda de producție cu MAI MULTE produse, și căutarea clientului în toată baza.
//
// DE CE EXISTĂ TESTUL. Două lucruri se pot strica aici fără să se vadă:
//
//   1. Caracteristicile trebuie să rămână lipite de produsul lor. Formularul
//      trimite liste paralele; dacă valorile s-ar lega de POZIȚIA rândului,
//      ștergerea unui rând din mijloc ar muta grosimea de la al treilea produs
//      pe al doilea. Nimic nu crapă, nimeni nu vede nimic — se produce greșit
//      în atelier, peste trei zile. De-aia fiecare rând are o cheie proprie,
//      iar testul chiar șterge un rând din mijloc și verifică unde au ajuns
//      valorile.
//
//   2. Coloanele plate de pe comandă (tip_produs, cantitate, um) NU au voie să
//      rămână goale. Vreo douăzeci de locuri le citesc direct: comision,
//      utilaje, rapoarte, punte. Dacă le-am goli când trecem pe linii, s-ar
//      vedea abia la raportul de comision, peste o lună.
//
// Plus: clientul se caută în toată baza (inclusiv clienții colegilor, cu numele
// agentului lângă), nu dintr-un <select> nativ care caută după prima literă.
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

const mod = require(path.join(RAD, "modules", "productie.js"));
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
const GABI = { id: 96503, nume: "Gabriela Test", rol: "vanzari" };

async function cer(cale, { user = GABI, params = {}, query = {}, body = null, metoda = "get" } = {}) {
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
  if (a !== b) rau(eticheta, "am " + a + ", așteptam " + b); else ok(eticheta);
}
const bine = (e, cond, d) => (cond ? ok(e) : rau(e, d));

// Id-uri de test, într-un interval numai al lor, ca să se poată curăța.
const P1 = 96601, P2 = 96602, P3 = 96603; // produse
const C1 = 96701, C2 = 96702;             // clienți
const AG = 96503, AG2 = 96504;            // agenți

(async () => {
  console.log("Comanda de producție cu mai multe produse\n");

  const curata = () => {
    for (const s of [
      `DELETE FROM comenzi_productie_caracteristici WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE partener_id IN (${C1},${C2}))`,
      `DELETE FROM comenzi_productie_linii WHERE comanda_id IN (SELECT id FROM comenzi_productie WHERE partener_id IN (${C1},${C2}))`,
      `DELETE FROM comenzi_productie WHERE partener_id IN (${C1},${C2})`,
      `DELETE FROM produse_caracteristici WHERE produs_id IN (${P1},${P2},${P3})`,
      `DELETE FROM produse_fuziuni WHERE pastrat_id IN (${P1},${P2},${P3}) OR inghitit_id IN (${P1},${P2},${P3})`,
      `DELETE FROM produse WHERE id IN (${P1},${P2},${P3})`,
      `DELETE FROM parteneri WHERE id IN (${C1},${C2})`,
    ]) exec(s);
  };
  curata();

  for (const s of [
    `INSERT INTO utilizatori (id, nume, email, parola_hash, parola_salt, rol) VALUES
       (${AG},'Gabriela Test','gabi.test@x.ro','x','y','vanzari'),
       (${AG2},'Florentin Test','flo.test@x.ro','x','y','vanzari') ON CONFLICT (id) DO NOTHING`,
    // Al doilea client e AL ALTUI AGENT: trebuie să apară totuși în căutare.
    `INSERT INTO parteneri (id, nume, cui, tip, agent_id) VALUES
       (${C1},'AAA CLIENTUL MEU SRL','RO-CP-1','client',${AG}),
       (${C2},'DYNAMIC PARCEL DISTRIBUTION TEST SA','RO-CP-2','client',${AG2})`,
    `INSERT INTO produse (id, cod, denumire, unitate_masura, pret_vanzare, activ) VALUES
       (${P1},'CP-1','Folie stretch CP','kg',10,1),
       (${P2},'CP-2','Pungi curier CP','buc',2,1),
       (${P3},'CP-3','Banda adeziva CP','rola',5,1)`,
    // Primul produs are două caracteristici obligatorii, al doilea una cu listă.
    `INSERT INTO produse_caracteristici (produs_id, denumire, tip, unitate, valori, obligatoriu, ordine) VALUES
       (${P1},'Grosime','numar','µm',NULL,1,10),
       (${P1},'Latime','numar','mm',NULL,1,20),
       (${P2},'Culoare','lista',NULL,'transparent|negru|alb',1,10)`,
  ]) exec(s);

  const cGrosime = Number(q(`SELECT id FROM produse_caracteristici WHERE produs_id = ${P1} AND denumire = 'Grosime'`)[0].id);
  const cLatime = Number(q(`SELECT id FROM produse_caracteristici WHERE produs_id = ${P1} AND denumire = 'Latime'`)[0].id);
  const cCuloare = Number(q(`SELECT id FROM produse_caracteristici WHERE produs_id = ${P2} AND denumire = 'Culoare'`)[0].id);

  // --- 1. formularul ---------------------------------------------------------
  console.log("formularul de comandă nouă");
  const f = await cer("/productie/noua");
  bine("are rânduri de produs adăugabile", f.corp.includes('id="adauga-produs"') && f.corp.includes('id="linii-produse"'));
  bine("rândul trimite liste paralele", f.corp.includes("linie_produs[]") && f.corp.includes("linie_cantitate[]"));
  bine("fiecare rând are cheia lui, nu poziția", f.corp.includes("linie_cheie[]"));
  bine("caracteristicile se numesc după cheia rândului", /carac_" \+ cheie \+ "_/.test(f.corp));
  bine("nu mai are un singur câmp de produs", !/<select name="produs_id"/.test(f.corp));
  bine("nu mai are câmp liber pentru produs", !/name="tip_produs"/.test(f.corp));
  bine("trimite la Produse pentru articole noi", f.corp.includes("/produse/nou"));

  console.log("\ncăutarea clientului");
  bine("clientul se caută, nu se derulează", f.corp.includes('class="cauta-client"'));
  bine("nu mai există listă derulantă de clienți", !/<select[^>]*name="partener_id"/.test(f.corp));
  bine("nici datalist cu toți clienții", !f.corp.includes("lista-clienti"));
  bine("clientul altui agent apare în căutare", f.corp.includes("DYNAMIC PARCEL DISTRIBUTION TEST"));
  bine("și se vede al cui e", f.corp.includes("clientul lui Florentin Test"));
  bine("se caută și după CUI", f.corp.includes("ro-cp-2"), "cheia de căutare trebuie să conțină CUI-ul, fără diacritice");
  bine("lista pleacă o singură dată, ca date", (f.corp.match(/window\.__alegeClient/g) || []).length >= 1);

  // --- 2. salvarea cu trei produse ------------------------------------------
  console.log("\ncomanda cu trei produse");
  const corpTrei = {
    numar: "CP-TEST-1",
    partener_id: String(C1),
    client_nou: "AAA CLIENTUL MEU SRL",
    agent_id: String(AG),
    "linie_cheie[]": ["r0", "r1", "r2"],
    "linie_produs[]": [String(P1), String(P2), String(P3)],
    "linie_cantitate[]": ["15000", "300", "12"],
    "linie_um[]": ["kg", "buc", "rola"],
    ["carac_r0_" + cGrosime]: "23",
    ["carac_r0_" + cLatime]: "500",
    ["carac_r1_" + cCuloare]: "negru",
    data_initiere: "2026-10-05",
  };
  const r1 = await cer("/productie", { metoda: "post", body: corpTrei });
  bine("comanda s-a înregistrat", r1.cod === 302, "cod " + r1.cod + " " + String(r1.corp).slice(0, 180));
  const id1 = Number(String(locatie(r1)).replace("/productie/", ""));
  const linii = q(`SELECT l.*, p.cod FROM comenzi_productie_linii l JOIN produse p ON p.id = l.produs_id
                   WHERE l.comanda_id = ${id1} ORDER BY l.ordine, l.id`);
  egal("are trei linii de produs", linii.length, 3);
  egal("în ordinea din formular", linii.map((l) => l.cod), ["CP-1", "CP-2", "CP-3"]);
  egal("cu cantitățile lor", linii.map((l) => l.cantitate), ["15000", "300", "12"]);
  egal("cu unitățile lor", linii.map((l) => l.um), ["kg", "buc", "rola"]);

  const carac = q(`SELECT c.*, l.produs_id FROM comenzi_productie_caracteristici c
                   LEFT JOIN comenzi_productie_linii l ON l.id = c.linie_id
                   WHERE c.comanda_id = ${id1} ORDER BY c.id`);
  egal("caracteristicile sunt legate de linia lor", carac.every((x) => x.linie_id), true);
  egal("grosimea a ajuns pe folie", (carac.find((x) => x.denumire === "Grosime") || {}).produs_id, String(P1));
  egal("culoarea a ajuns pe pungi", (carac.find((x) => x.denumire === "Culoare") || {}).produs_id, String(P2));
  egal("valoarea grosimii", (carac.find((x) => x.denumire === "Grosime") || {}).valoare, "23");

  // --- 3. coloanele vechi rămân umplute ------------------------------------
  console.log("\ncompatibilitatea cu ce citește restul ERP-ului");
  const c1 = q(`SELECT * FROM comenzi_productie WHERE id = ${id1}`)[0];
  bine("tip_produs adună denumirile", String(c1.tip_produs).includes("Folie stretch CP") && String(c1.tip_produs).includes("Pungi curier CP"));
  egal("cantitatea e a primei linii", c1.cantitate, "15000");
  egal("UM e a primei linii", c1.um, "kg");
  egal("produs_id e al primei linii", Number(c1.produs_id), P1);
  bine("rezumatul caracteristicilor e scris în coloana veche", String(c1.caracteristici).includes("Grosime: 23"));
  bine("și spune pentru care produs", String(c1.caracteristici).includes("Folie stretch CP"));

  // --- 4. ștergerea unui rând din mijloc -----------------------------------
  // Aici se vede de ce cheia nu e poziția: formularul trimite r0 și r2, fără
  // r1. Cu indici de poziție, culoarea cerută pentru pungi ar fi căutată la
  // indicele 1 — adică pe banda adezivă — și comanda ar fi fost refuzată sau,
  // mai rău, salvată cu valoarea pe produsul greșit.
  console.log("\nun rând șters din mijloc nu amestecă valorile");
  const corpDoua = {
    numar: "CP-TEST-2",
    partener_id: String(C1),
    agent_id: String(AG),
    "linie_cheie[]": ["r0", "r2"],
    "linie_produs[]": [String(P1), String(P2)],
    "linie_cantitate[]": ["900", "40"],
    "linie_um[]": ["kg", "buc"],
    ["carac_r0_" + cGrosime]: "17",
    ["carac_r0_" + cLatime]: "250",
    ["carac_r2_" + cCuloare]: "alb",
  };
  const r2 = await cer("/productie", { metoda: "post", body: corpDoua });
  bine("comanda s-a înregistrat", r2.cod === 302, "cod " + r2.cod + " " + String(r2.corp).slice(0, 180));
  const id2 = Number(String(locatie(r2)).replace("/productie/", ""));
  const carac2 = q(`SELECT c.denumire, c.valoare, l.produs_id FROM comenzi_productie_caracteristici c
                    JOIN comenzi_productie_linii l ON l.id = c.linie_id
                    WHERE c.comanda_id = ${id2} ORDER BY c.id`);
  egal("culoarea e pe pungi, nu pe altceva", (carac2.find((x) => x.denumire === "Culoare") || {}).produs_id, String(P2));
  egal("cu valoarea cerută", (carac2.find((x) => x.denumire === "Culoare") || {}).valoare, "alb");
  egal("grosimea e pe folie", (carac2.find((x) => x.denumire === "Grosime") || {}).produs_id, String(P1));

  // --- 5. validarea, pe fiecare linie --------------------------------------
  console.log("\nvalidarea merge pe fiecare produs al comenzii");
  const faraCuloare = await cer("/productie", {
    metoda: "post",
    body: {
      numar: "CP-TEST-3", partener_id: String(C1), agent_id: String(AG),
      "linie_cheie[]": ["r0", "r1"],
      "linie_produs[]": [String(P1), String(P2)],
      "linie_cantitate[]": ["100", "100"], "linie_um[]": ["kg", "buc"],
      ["carac_r0_" + cGrosime]: "23", ["carac_r0_" + cLatime]: "500",
      // culoarea pungilor lipsește
    },
  });
  egal("refuză comanda dacă al doilea produs n-are caracteristicile lui", faraCuloare.cod, 400);
  bine("și spune care produs și care caracteristică", /Culoare/.test(faraCuloare.corp) && /Pungi curier CP/.test(faraCuloare.corp),
    String(faraCuloare.corp).slice(0, 200));

  const valoareRea = await cer("/productie", {
    metoda: "post",
    body: {
      numar: "CP-TEST-4", partener_id: String(C1), agent_id: String(AG),
      "linie_cheie[]": ["r0"], "linie_produs[]": [String(P1)],
      "linie_cantitate[]": ["100"], "linie_um[]": ["kg"],
      ["carac_r0_" + cGrosime]: "gros", ["carac_r0_" + cLatime]: "500",
    },
  });
  egal("refuză un număr care nu e număr", valoareRea.cod, 400);

  const listaRea = await cer("/productie", {
    metoda: "post",
    body: {
      numar: "CP-TEST-5", partener_id: String(C1), agent_id: String(AG),
      "linie_cheie[]": ["r0"], "linie_produs[]": [String(P2)],
      "linie_cantitate[]": ["100"], "linie_um[]": ["buc"],
      ["carac_r0_" + cCuloare]: "movlila",
    },
  });
  egal("refuză o valoare care nu e în listă", listaRea.cod, 400);

  const farăProdus = await cer("/productie", {
    metoda: "post",
    body: { numar: "CP-TEST-6", partener_id: String(C1), agent_id: String(AG), "linie_cheie[]": ["r0"], "linie_produs[]": [""] },
  });
  egal("refuză comanda fără niciun produs din nomenclator", farăProdus.cod, 400);

  // --- 6. formularul vechi, cu un singur produs ----------------------------
  // Un ecran rămas deschis de ieri nu trebuie să dea 400.
  console.log("\nformularul vechi, cu un singur produs, merge în continuare");
  const vechi = await cer("/productie", {
    metoda: "post",
    body: {
      numar: "CP-TEST-7", partener_id: String(C1), agent_id: String(AG),
      produs_id: String(P1), cantitate: "700", um: "kg",
      ["carac_" + cGrosime]: "19", ["carac_" + cLatime]: "400",
    },
  });
  bine("se înregistrează", vechi.cod === 302, "cod " + vechi.cod + " " + String(vechi.corp).slice(0, 180));
  const idV = Number(String(locatie(vechi)).replace("/productie/", ""));
  egal("și scrie o linie, ca toate celelalte", q(`SELECT COUNT(*) AS n FROM comenzi_productie_linii WHERE comanda_id = ${idV}`)[0].n, "1");

  // --- 7. pagina comenzii arată toate produsele ----------------------------
  console.log("\npagina comenzii");
  const pag = await cer("/productie/:id", { params: { id: String(id1) } });
  bine("are tabelul produselor comenzii", pag.corp.includes("Produsele comenzii"));
  bine("cu toate trei", ["Folie stretch CP", "Pungi curier CP", "Banda adeziva CP"].every((d) => pag.corp.includes(d)));
  bine("și cu caracteristicile fiecăruia", pag.corp.includes("Grosime") && pag.corp.includes("Culoare"));

  const fisa = await cer("/productie/:id/pdf", { params: { id: String(id1) } });
  bine("fișa tipărită arată toate produsele", ["Folie stretch CP", "Pungi curier CP", "Banda adeziva CP"].every((d) => fisa.corp.includes(d)),
    "atelierul citește fișa: dacă arată doar primul produs, restul se produce greșit");

  // --- 8. produsele unificate nu mai pot fi alese --------------------------
  console.log("\nprodusele unificate nu se mai pot alege");
  exec(`UPDATE produse SET activ = 0, fuzionat_in = ${P1} WHERE id = ${P3}`);
  const f2 = await cer("/productie/noua");
  bine("codul unificat a dispărut din nomenclator", !f2.corp.includes("Banda adeziva CP"));
  bine("cel păstrat a rămas", f2.corp.includes("Folie stretch CP"));
  const dupaUnificare = await cer("/productie", {
    metoda: "post",
    body: {
      numar: "CP-TEST-8", partener_id: String(C1), agent_id: String(AG),
      "linie_cheie[]": ["r0"], "linie_produs[]": [String(P3)],
      "linie_cantitate[]": ["5"], "linie_um[]": ["rola"],
    },
  });
  egal("și nu se poate trimite nici direct", dupaUnificare.cod, 400);
  exec(`UPDATE produse SET activ = 1, fuzionat_in = NULL WHERE id = ${P3}`);

  curata();
  console.log(rele ? `\n${rele} verificări au picat.` : "\nToate verificările au trecut.");
  process.exit(rele ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
