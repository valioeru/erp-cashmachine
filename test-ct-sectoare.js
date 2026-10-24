"use strict";
// Un rând cu porțiuni de înălțimi diferite. Pe PostgreSQL real (prin psql).
//
// DE CE EXISTĂ. Până acum un rând avea o singură cifră de niveluri, pe toată
// lungimea lui. În hală nu e așa, și Vali a spus-o scurt: „trebuie sa pot
// configura pe acelasi rand si 3 si 2 si 5 si 1 nivel pe orice interval
// adica nu sunt toate de 3". Rafturile s-au montat pe cât loc era: trei
// niveluri pe o bucată, cinci unde tavanul permite, unul lângă ușă.
//
// CE APĂRĂ TESTUL ĂSTA:
//
//   • LOCURILE SE GENEREAZĂ DUPĂ CÂMP, NU DUPĂ RÂND. Dacă o porțiune are 2
//     niveluri, acolo nu trebuie să existe locuri la nivelul 3 — altfel
//     sistemul trimite oamenii să pună paleți pe un raft care nu există.
//
//   • UN SECTOR POATE FI MAI ÎNALT DECÂT RÂNDUL. Cinci niveluri pe un rând
//     declarat de trei: nivelurile 4 și 5 chiar trebuie să apară.
//
//   • DESENUL NU SE DECALEAZĂ. Grila se desenează nivel cu nivel; un câmp
//     mai scund trebuie să lase un gol de aceeași lățime, altfel câmpurile
//     de după el urcă cu un rând și harta minte.
//
//   • NU SE TAIE RAFTUL DE SUB MARFĂ. Dacă o porțiune ar coborî sub o
//     paletă care încă e în depozit, nu se salvează nimic.
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const RAD = __dirname;
const ENV = Object.assign({}, process.env, {
  PGHOST: "127.0.0.1", PGPORT: "5433", PGUSER: "postgres", PGDATABASE: "erp",
});
const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
function csv(t) {
  const R = []; let c = "", r = [], qq = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (qq) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else qq = false; } else c += ch; }
    else if (ch === '"') qq = true;
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
  catch (e) { throw new Error("SQL a picat:\n" + s.slice(0, 300) + "\n-> " + (e.stderr || e.message)); }
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

const mod = require(path.join(RAD, "modules", "ct-park.js"));
const rute = { get: {}, post: {} };
mod.register({ get: (p, h) => { rute.get[p] = h; }, post: (p, h) => { rute.post[p] = h; } });

const res = () => {
  const o = { cod: 0, antet: null, corp: "" };
  o.writeHead = (c, h) => { o.cod = c; o.antet = h; return o; };
  o.setHeader = () => {};
  o.end = (b) => { o.corp = b || ""; };
  return o;
};
async function cer(cale, { params = {}, query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
// Mesajul dintr-un redirect, ca să se poată verifica ce i se spune omului.
const mesajul = (r) => {
  const loc = (r.antet && (r.antet.Location || r.antet.location)) || "";
  const m = loc.match(/[?&](ok|eroare)=([^&]*)/);
  return m ? { fel: m[1], text: decodeURIComponent(m[2]) } : { fel: null, text: loc };
};

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}
const egal = (d, avut, asteptat) =>
  bine(d + " = " + JSON.stringify(asteptat), JSON.stringify(avut) === JSON.stringify(asteptat), JSON.stringify(avut));

const NUMAR_TEST = 98;
function curata() {
  const r = unul("SELECT id FROM ct_randuri WHERE numar = " + NUMAR_TEST);
  if (r) {
    q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
    q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_sectoare WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_niveluri WHERE rand_id = ${r}`);
    q(`DELETE FROM ct_randuri WHERE id = ${r}`);
  }
  q("DELETE FROM ct_paleti WHERE produs_text = 'TEST-SECTOARE'");
}

(async () => {
  // Tabelul se creează la pornirea aplicației; testul vorbește direct cu
  // baza, deci și-l face singur dacă lipsește.
  q(`CREATE TABLE IF NOT EXISTS ct_sectoare (
       id SERIAL PRIMARY KEY,
       rand_id INTEGER NOT NULL REFERENCES ct_randuri(id),
       camp_de_la INTEGER NOT NULL,
       camp_pana_la INTEGER NOT NULL,
       niveluri INTEGER NOT NULL)`);
  curata();

  console.log("\n1. Socoteala curată, fără bază de date");
  {
    const r = { campuri: 10, niveluri: 3 };
    const s = [
      { de_la: 3, pana_la: 4, niveluri: 2 },
      { de_la: 5, pana_la: 7, niveluri: 5 },
      { de_la: 8, pana_la: 10, niveluri: 1 },
    ];
    const h = mod.nivelurilePeCamp(r, s, 10);
    egal("exact cum a cerut: 3, 2, 5 și 1 pe același rând",
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => h.get(c)), [3, 3, 2, 2, 5, 5, 5, 1, 1, 1]);
    egal("câmpurile fără porțiune rămân la cifra rândului", [h.get(1), h.get(2)], [3, 3]);

    // Bucățile se citesc din forma REALĂ a rândului, nu din ce s-a scris în
    // formular: vecinii cu același număr de niveluri se strâng la un loc.
    egal("bucățile se strâng, oricât de fărâmițat ar fi scris",
      mod.bucatiRand(h, 10).map((b) => [b.de_la, b.pana_la, b.niveluri]),
      [[1, 2, 3], [3, 4, 2], [5, 7, 5], [8, 10, 1]]);

    // Două porțiuni care se calcă: câștigă ultima. E singura regulă care se
    // poate explica în hală fără diagramă.
    const h2 = mod.nivelurilePeCamp(r, [{ de_la: 1, pana_la: 6, niveluri: 5 }, { de_la: 4, pana_la: 6, niveluri: 2 }], 6);
    egal("când două porțiuni se suprapun, câștigă ultima",
      [1, 2, 3, 4, 5, 6].map((c) => h2.get(c)), [5, 5, 5, 2, 2, 2]);

    // O porțiune scrisă peste capătul rândului nu inventează câmpuri.
    const h3 = mod.nivelurilePeCamp({ campuri: 4, niveluri: 3 }, [{ de_la: 2, pana_la: 99, niveluri: 1 }], 4);
    egal("o porțiune care trece de capăt se oprește la ultimul câmp",
      [1, 2, 3, 4].map((c) => h3.get(c)), [3, 1, 1, 1]);
  }

  // Un rând adevărat: 10 câmpuri, 3 niveluri implicit, 2 paleți pe câmp.
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, inaltime_nivel, activ)
     VALUES (${NUMAR_TEST}, 'rand cu sectoare', 10, 3, 2, 800, 1200, 1800, 1)`);
  const rand = Number(unul("SELECT id FROM ct_randuri WHERE numar = " + NUMAR_TEST));
  await cer("/stocuri/ct-park/configurare/:id", { params: { id: String(rand) } }); // doar ca să nu crape pe gol
  const r0 = await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(rand);

  console.log("\n2. Rândul uniform, ca înainte");
  {
    // Locurile nu există încă: le cere regenerarea, pe care o face salvarea.
    await cer("/stocuri/ct-park/configurare/:id/sectoare", { params: { id: String(rand) }, body: {}, metoda: "post" });
    const n = Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand}`));
    egal("10 câmpuri × 3 niveluri × 2 locuri", n, 60);
    const plan = await mod.planRand(r0);
    bine("rândul se declară uniform", plan.uniform === true, plan.uniform);
  }

  console.log("\n3. Porțiunile cerute: 3, 2, 5 și 1");
  {
    const p = await cer("/stocuri/ct-park/configurare/:id/sectoare", {
      params: { id: String(rand) },
      metoda: "post",
      body: {
        s0_de_la: "3", s0_pana_la: "4", s0_niveluri: "2",
        s1_de_la: "5", s1_pana_la: "7", s1_niveluri: "5",
        s2_de_la: "8", s2_pana_la: "10", s2_niveluri: "1",
      },
    });
    const m = mesajul(p);
    bine("salvarea trece și spune ce a ieșit", m.fel === "ok", m.text);

    // Câte niveluri are fiecare câmp, citite din LOCURILE chiar generate.
    const peCamp = q(`SELECT camp, MAX(nivel) AS sus, COUNT(*) AS n FROM ct_locuri WHERE rand_id = ${rand} GROUP BY camp ORDER BY camp`);
    egal("fiecare câmp are exact nivelurile porțiunii lui",
      peCamp.map((x) => Number(x.sus)), [3, 3, 2, 2, 5, 5, 5, 1, 1, 1]);
    egal("și locurile pe măsură (2 pe nivel)",
      peCamp.map((x) => Number(x.n)), [6, 6, 4, 4, 10, 10, 10, 2, 2, 2]);

    // Asta e miezul: pe o porțiune de 2 niveluri NU trebuie să existe raft
    // la nivelul 3, altfel trimitem oameni cu paleți la un raft inexistent.
    const fantome = Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand} AND camp IN (3,4) AND nivel > 2`));
    egal("niciun loc fantomă peste porțiunea de 2 niveluri", fantome, 0);
    // Și invers: sectorul de 5 e mai înalt decât rândul, deci nivelurile 4
    // și 5 chiar trebuie să existe, deși rândul e declarat de 3.
    const inalte = Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand} AND camp IN (5,6,7) AND nivel IN (4,5)`));
    egal("porțiunea de 5 urcă peste cifra rândului", inalte, 12);

    const total = Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand}`));
    egal("în total", total, 56);
    const plan = await mod.planRand(await db.prepare("SELECT * FROM ct_randuri WHERE id = ?").get(rand));
    egal("planul numără la fel ca baza", plan.locuri, total);
    egal("și știe până unde urcă rândul", plan.varf, 5);
  }

  console.log("\n4. Desenul nu se decalează");
  {
    const p = await cer("/stocuri/ct-park/rand/:id", { params: { id: String(rand) } });
    bine("harta se deschide", p.cod === 200, p.cod);
    // Grila se desenează nivel cu nivel. La nivelul 5 există raft doar pe
    // câmpurile 5-7; celelalte 7 câmpuri trebuie să lase un gol, altfel
    // câmpurile de după ele s-ar muta la stânga.
    const nivele = p.corp.split('<div class="ct-nivel">').slice(1);
    egal("se desenează 5 niveluri, cât cel mai înalt sector", nivele.length, 5);
    // Atenție la tipar: „ct-camp" prinde și ct-camp-locuri, și
    // ct-camp-eticheta, deci numără de trei ori. Ghilimeaua de după e tot
    // ce desparte câmpul de copiii lui.
    const campuriPeNivel = nivele.map((x) => (x.match(/class="ct-camp(?:"| gol")/g) || []).length);
    egal("fiecare nivel are toate cele 10 câmpuri, pline sau goale", campuriPeNivel, [10, 10, 10, 10, 10]);
    // Nivelul desenat primul e cel de sus (5): acolo 7 câmpuri sunt goale.
    const goluriSus = (nivele[0].match(/class="ct-camp gol"/g) || []).length;
    egal("sus, 7 câmpuri sunt gol", goluriSus, 7);
    const goluriJos = (nivele[4].match(/class="ct-camp gol"/g) || []).length;
    egal("jos, la nivelul 1, niciun gol", goluriJos, 0);
    bine("golul se vede ca lipsă de raft, nu ca loc liber", /class="ct-loc fara-raft"/.test(p.corp));
    bine("și nu e bifabil", !/fara-raft[^>]*>\s*<input/.test(p.corp));
    bine("pagina spune cum e împărțit rândul", /cu 2 niveluri/.test(p.corp) && /cu 5 niveluri/.test(p.corp), p.corp.slice(p.corp.indexOf("câmpuri,"), p.corp.indexOf("câmpuri,") + 200));
  }

  console.log("\n5. Nu se taie raftul de sub marfă");
  {
    // Punem o paletă sus de tot, pe câmpul 6 nivelul 5 — adică fix pe
    // porțiunea înaltă, singura care poate fi coborâtă.
    q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, um, data_intrare)
       VALUES ('TS-1', 'TEST-SECTOARE', 1, 'buc', '2026-10-24')`);
    const palet = Number(unul("SELECT id FROM ct_paleti WHERE cod = 'TS-1'"));
    const locSus = Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND camp=6 AND nivel=5 AND pozitie=1`));
    q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${palet}, ${locSus})`);

    const p = await cer("/stocuri/ct-park/configurare/:id/sectoare", {
      params: { id: String(rand) },
      metoda: "post",
      body: { s0_de_la: "5", s0_pana_la: "7", s0_niveluri: "2" },
    });
    const m = mesajul(p);
    bine("refuză să coboare porțiunea de sub paletă", m.fel === "eroare", m.text);
    bine("și spune pe ce adresă stă marfa", /R98-06-5-1|-5-1/.test(m.text), m.text);
    const inca = Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand} AND camp=6 AND nivel=5`));
    bine("nu s-a șters nimic", inca > 0, inca);
    const sectoareInca = Number(unul(`SELECT COUNT(*) FROM ct_sectoare WHERE rand_id = ${rand}`));
    egal("și porțiunile au rămas cum erau", sectoareInca, 3);

    q(`DELETE FROM ct_ocupari WHERE palet_id = ${palet}`);
    q(`DELETE FROM ct_paleti WHERE id = ${palet}`);
  }

  console.log("\n6. Ce se refuză din start");
  {
    const cazuri = [
      [{ s0_de_la: "3", s0_niveluri: "2" }, /incomplet/i, "jumătate de porțiune"],
      [{ s0_de_la: "5", s0_pana_la: "2", s0_niveluri: "2" }, /invers/i, "interval scris invers"],
      [{ s0_de_la: "1", s0_pana_la: "99", s0_niveluri: "2" }, /iese din el/i, "interval peste capătul rândului"],
      [{ s0_de_la: "1", s0_pana_la: "2", s0_niveluri: "40" }, /între 1 și 12/i, "mai multe niveluri decât se poate"],
    ];
    for (const [body, tipar, ce] of cazuri) {
      const p = await cer("/stocuri/ct-park/configurare/:id/sectoare", { params: { id: String(rand) }, metoda: "post", body });
      const m = mesajul(p);
      bine("refuză " + ce + " și spune de ce", m.fel === "eroare" && tipar.test(m.text), m.text);
    }
    const sectoareInca = Number(unul(`SELECT COUNT(*) FROM ct_sectoare WHERE rand_id = ${rand}`));
    egal("nicio greșeală n-a stricat ce era salvat", sectoareInca, 3);
  }

  console.log("\n7. Golirea formularului șterge porțiunile");
  {
    const p = await cer("/stocuri/ct-park/configurare/:id/sectoare", {
      params: { id: String(rand) },
      metoda: "post",
      body: { s0_de_la: "", s0_pana_la: "", s0_niveluri: "", s1_de_la: "", s1_pana_la: "", s1_niveluri: "" },
    });
    const m = mesajul(p);
    bine("se salvează și spune că rândul e iar uniform", m.fel === "ok" && /tot rândul/.test(m.text), m.text);
    egal("nu mai există nicio porțiune", Number(unul(`SELECT COUNT(*) FROM ct_sectoare WHERE rand_id = ${rand}`)), 0);
    const peCamp = q(`SELECT camp, MAX(nivel) AS sus FROM ct_locuri WHERE rand_id = ${rand} GROUP BY camp ORDER BY camp`);
    egal("toate câmpurile sunt iar de 3 niveluri", peCamp.map((x) => Number(x.sus)), [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    egal("și locurile s-au întors la 60", Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand}`)), 60);
  }

  console.log("\n8. Formularul de configurare arată porțiunile");
  {
    await cer("/stocuri/ct-park/configurare/:id/sectoare", {
      params: { id: String(rand) },
      metoda: "post",
      body: { s0_de_la: "8", s0_pana_la: "10", s0_niveluri: "1" },
    });
    const p = await cer("/stocuri/ct-park/configurare/:id", { params: { id: String(rand) } });
    bine("pagina se deschide", p.cod === 200, p.cod);
    bine("are formularul de porțiuni", /action="\/stocuri\/ct-park\/configurare\/\d+\/sectoare"/.test(p.corp));
    bine("cu porțiunea salvată completată în el", /name="s0_de_la"[^>]*value="8"/.test(p.corp));
    bine("și cu rânduri goale pentru încă una", /name="s1_de_la"[^>]*value=""/.test(p.corp));
    bine("spune cum arată rândul acum", /câmpurile <strong>1–7<\/strong> cu 3 niveluri, <strong>8–10<\/strong> cu 1 nivel/.test(p.corp),
      p.corp.slice(p.corp.indexOf("Cum arată rândul"), p.corp.indexOf("Cum arată rândul") + 220));
    bine("zice limpede ce se întâmplă cu câmpurile nelistate", /rămân la 3 niveluri/.test(p.corp));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} probleme.\n` : "\nTotul curat.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("\nTestul a crăpat:", e && e.stack ? e.stack : e);
  try { curata(); } catch (x) { /* nimic */ }
  process.exit(1);
});
