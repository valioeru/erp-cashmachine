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
       niveluri INTEGER)`);
  q("ALTER TABLE ct_sectoare ADD COLUMN IF NOT EXISTS locuri_pe_camp INTEGER");
  q("ALTER TABLE ct_sectoare ALTER COLUMN niveluri DROP NOT NULL");
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

    // Lățimea: aceeași socoteală, pe paleți. „Acum ia 3 paleti peste tot
    // trebuie sa pot pune si 2 si 1."
    const p = mod.paletiPeCamp(r, [{ de_la: 2, pana_la: 3, locuri: 2 }, { de_la: 9, pana_la: 10, locuri: 1 }], 10);
    egal("paleții se pun tot pe interval",
      [1, 2, 3, 4, 9, 10].map((c) => (p.has(c) ? p.get(c) : null)), [null, 2, 2, null, 1, 1]);
    // `null` nu e 0: înseamnă „lasă cum e rândul". Un sector care schimbă
    // doar înălțimea nu trebuie să atingă lățimea, și invers.
    const doarNiv = mod.paletiPeCamp(r, [{ de_la: 1, pana_la: 5, niveluri: 2, locuri: null }], 10);
    egal("un sector care schimbă doar nivelurile nu atinge paleții", doarNiv.size, 0);
    const doarPal = mod.nivelurilePeCamp(r, [{ de_la: 1, pana_la: 5, niveluri: null, locuri: 2 }], 10);
    egal("și invers: unul doar de paleți lasă nivelurile rândului",
      [1, 2, 3].map((c) => doarPal.get(c)), [3, 3, 3]);
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
    bine("spune cum arată rândul acum, cu niveluri ȘI paleți",
      /câmpurile <strong>1–7<\/strong> cu 3 niveluri × 2 paleți, <strong>8–10<\/strong> cu 1 nivel × 2 paleți/.test(p.corp),
      p.corp.slice(p.corp.indexOf("Cum arată rândul"), p.corp.indexOf("Cum arată rândul") + 220));
    bine("zice limpede ce înseamnă o căsuță lăsată goală",
      /înseamnă „ca rândul"/.test(p.corp) && /3 niveluri și 2 paleți pe câmp/.test(p.corp));
    bine("are și coloana de paleți în formular", /name="s0_paleti"/.test(p.corp));
    bine("și trimite spre editarea de pe desen", /apasă „Editez raftul"/.test(p.corp));
  }

  console.log("\n9. Paleți pe interval: 3 peste tot, dar 2 aici și 1 dincolo");
  {
    const p = await cer("/stocuri/ct-park/configurare/:id/sectoare", {
      params: { id: String(rand) },
      metoda: "post",
      body: {
        s0_de_la: "3", s0_pana_la: "4", s0_paleti: "1",
        s1_de_la: "5", s1_pana_la: "6", s1_niveluri: "2", s1_paleti: "1",
      },
    });
    bine("se salvează", mesajul(p).fel === "ok", mesajul(p).text);
    // Rândul are 2 paleți pe câmp implicit, 3 niveluri.
    const peCamp = q(`SELECT camp, MAX(nivel) AS sus, MAX(pozitie) AS lat, COUNT(*) AS n
                        FROM ct_locuri WHERE rand_id = ${rand} GROUP BY camp ORDER BY camp`);
    egal("câmpurile 3-4 au un singur palet, restul doi",
      peCamp.map((x) => Number(x.lat)), [2, 2, 1, 1, 1, 1, 2, 2, 2, 2]);
    egal("iar 5-6 au și nivelurile tăiate la 2",
      peCamp.map((x) => Number(x.sus)), [3, 3, 3, 3, 2, 2, 3, 3, 3, 3]);
    egal("locurile per câmp ies pe măsură",
      peCamp.map((x) => Number(x.n)), [6, 6, 3, 3, 2, 2, 6, 6, 6, 6]);
    const fantome = Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand} AND camp IN (3,4,5,6) AND pozitie > 1`));
    egal("niciun loc fantomă la dreapta într-un câmp îngust", fantome, 0);
  }

  console.log("\n10. Desenul păstrează lățimea câmpului îngust");
  {
    const p = await cer("/stocuri/ct-park/rand/:id", { params: { id: String(rand) } });
    const nivele = p.corp.split('<div class="ct-nivel">').slice(1);
    const jos = nivele[nivele.length - 1];
    const campuri = jos.split(/class="ct-camp(?:"| gol")/).slice(1);
    egal("la nivelul 1 sunt tot 10 câmpuri", campuri.length, 10);
    // Un câmp de 1 palet are o căsuță, unul de 2 are două — dar .ct-camp e
    // flex:1, deci câmpul rămâne la fel de lat. Asta nu se poate verifica
    // din HTML, așa că verificăm ce se poate: numărul de căsuțe.
    egal("câte căsuțe are fiecare câmp jos",
      campuri.map((c) => (c.match(/class="ct-loc /g) || []).length), [2, 2, 1, 1, 1, 1, 2, 2, 2, 2]);
    bine("rezumatul spune și paleții", /cu 3 niveluri × 2 paleți/.test(p.corp) && /cu 2 niveluri × 1 palet/.test(p.corp),
      p.corp.slice(p.corp.indexOf("nu e la fel"), p.corp.indexOf("nu e la fel") + 240));
  }

  console.log("\n11. Editarea de pe hartă, cu salvare pe loc");
  {
    const json = (r) => { try { return JSON.parse(r.corp); } catch (e) { return { ok: false, corp: r.corp.slice(0, 120) }; } };

    // Un câmp, dintr-o apăsare: fără interval scris de mână.
    let p = await cer("/stocuri/ct-park/rand/:id/editeaza", {
      params: { id: String(rand) }, metoda: "post", body: { ce: "camp", camp: "8", paleti: "1" },
    });
    let j = json(p);
    bine("− pe un câmp îi scade paleții și spune ce a ieșit", j.ok === true, JSON.stringify(j));
    egal("câmpul 8 are acum un palet pe nivel",
      Number(unul(`SELECT MAX(pozitie) FROM ct_locuri WHERE rand_id=${rand} AND camp=8`)), 1);
    egal("și restul n-au fost atinse",
      Number(unul(`SELECT MAX(pozitie) FROM ct_locuri WHERE rand_id=${rand} AND camp=7`)), 2);

    // A doua apăsare pe același câmp nu trebuie să lase porțiuni suprapuse.
    await cer("/stocuri/ct-park/rand/:id/editeaza", {
      params: { id: String(rand) }, metoda: "post", body: { ce: "camp", camp: "8", niveluri: "1" },
    });
    const peCamp8 = q(`SELECT MAX(nivel) AS sus, MAX(pozitie) AS lat FROM ct_locuri WHERE rand_id=${rand} AND camp=8`)[0];
    egal("a doua apăsare o ține pe prima: 1 nivel × 1 palet", [Number(peCamp8.sus), Number(peCamp8.lat)], [1, 1]);
    const cateSectoare = Number(unul(`SELECT COUNT(*) FROM ct_sectoare WHERE rand_id=${rand} AND camp_de_la=8 AND camp_pana_la=8`));
    egal("și nu lasă două porțiuni peste același câmp", cateSectoare, 1);

    // Un interval, dintr-o apăsare.
    p = await cer("/stocuri/ct-park/rand/:id/editeaza", {
      params: { id: String(rand) }, metoda: "post", body: { ce: "interval", de_la: "1", pana_la: "2", niveluri: "4", paleti: "1" },
    });
    bine("intervalul se aplică la toate câmpurile din el", json(p).ok === true, JSON.stringify(json(p)));
    egal("1 și 2 au acum 4 niveluri × 1 palet",
      q(`SELECT camp, MAX(nivel) AS sus, MAX(pozitie) AS lat FROM ct_locuri WHERE rand_id=${rand} AND camp IN (1,2) GROUP BY camp ORDER BY camp`)
        .map((x) => [Number(x.sus), Number(x.lat)]), [[4, 1], [4, 1]]);

    // Un câmp întors exact pe cifrele rândului nu mai are nevoie de porțiune.
    await cer("/stocuri/ct-park/rand/:id/editeaza", {
      params: { id: String(rand) }, metoda: "post", body: { ce: "camp", camp: "1", niveluri: "3", paleti: "2" },
    });
    egal("câmpul întors la cifrele rândului își pierde porțiunea",
      Number(unul(`SELECT COUNT(*) FROM ct_sectoare WHERE rand_id=${rand} AND camp_de_la=1`)), 0);
    egal("dar locurile lui sunt cele ale rândului",
      [Number(unul(`SELECT MAX(nivel) FROM ct_locuri WHERE rand_id=${rand} AND camp=1`)),
       Number(unul(`SELECT MAX(pozitie) FROM ct_locuri WHERE rand_id=${rand} AND camp=1`))], [3, 2]);

    // Un loc scos din uz: „sterg spatii".
    const unLoc = Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND camp=7 AND nivel=1 AND pozitie=1`));
    p = await cer("/stocuri/ct-park/rand/:id/editeaza", { params: { id: String(rand) }, metoda: "post", body: { ce: "loc", loc: String(unLoc) } });
    bine("un loc se scoate din uz dintr-un click", json(p).ok === true, JSON.stringify(json(p)));
    egal("și chiar e marcat blocat", Number(unul(`SELECT blocat FROM ct_locuri WHERE id=${unLoc}`)), 1);
    // Scos din uz, nu șters: adresa rămâne a lui, eticheta de pe raft nu minte.
    bine("dar nu e șters din tabel", Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE id=${unLoc}`)) === 1);
    p = await cer("/stocuri/ct-park/rand/:id/editeaza", { params: { id: String(rand) }, metoda: "post", body: { ce: "loc", loc: String(unLoc) } });
    egal("al doilea click îl repune în uz", Number(unul(`SELECT blocat FROM ct_locuri WHERE id=${unLoc}`)), 0);

    // Încă o coloană, din buton.
    const inainte = Number(unul(`SELECT campuri FROM ct_randuri WHERE id=${rand}`));
    p = await cer("/stocuri/ct-park/rand/:id/editeaza", { params: { id: String(rand) }, metoda: "post", body: { ce: "adauga" } });
    bine("se activează încă un câmp", json(p).ok === true, JSON.stringify(json(p)));
    egal("rândul are un câmp în plus", Number(unul(`SELECT campuri FROM ct_randuri WHERE id=${rand}`)), inainte + 1);
    bine("și chiar are locuri pe el", Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id=${rand} AND camp=${inainte + 1}`)) > 0);
    await cer("/stocuri/ct-park/rand/:id/editeaza", { params: { id: String(rand) }, metoda: "post", body: { ce: "scoate" } });
    egal("și se poate scoate la loc", Number(unul(`SELECT campuri FROM ct_randuri WHERE id=${rand}`)), inainte);

    // Marfa oprește și editarea de pe hartă, nu doar formularul.
    q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, um, data_intrare) VALUES ('TS-2', 'TEST-SECTOARE', 1, 'buc', '2026-10-24')`);
    const palet = Number(unul("SELECT id FROM ct_paleti WHERE cod = 'TS-2'"));
    const locLat = Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND camp=7 AND nivel=1 AND pozitie=2`));
    q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${palet}, ${locLat})`);
    p = await cer("/stocuri/ct-park/rand/:id/editeaza", { params: { id: String(rand) }, metoda: "post", body: { ce: "camp", camp: "7", paleti: "1" } });
    j = json(p);
    bine("nu îngustează un câmp de sub o paletă", j.ok === false && /stă marfă/.test(j.mesaj || ""), JSON.stringify(j));
    p = await cer("/stocuri/ct-park/rand/:id/editeaza", { params: { id: String(rand) }, metoda: "post", body: { ce: "loc", loc: String(locLat) } });
    j = json(p);
    bine("nici nu scoate din uz un loc ocupat", j.ok === false && /stă marfă/.test(j.mesaj || ""), JSON.stringify(j));
    q(`DELETE FROM ct_ocupari WHERE palet_id = ${palet}`);
    q(`DELETE FROM ct_paleti WHERE id = ${palet}`);
  }

  console.log("\n12. Pagina are cu ce se edita");
  {
    const p = await cer("/stocuri/ct-park/rand/:id", { params: { id: String(rand) } });
    bine("are butonul de editare", /id="buton-editez"/.test(p.corp));
    bine("are banda de comenzi pe câmp", /class="ct-nivel ct-banda-editare"/.test(p.corp));
    bine("cu − și + pe niveluri și pe paleți",
      /data-ce="niveluri" data-pas="-1"/.test(p.corp) && /data-ce="paleti" data-pas="1"/.test(p.corp));
    bine("cu butoane de câmp nou și de scos", /data-rand-camp="adauga"/.test(p.corp) && /data-rand-camp="scoate"/.test(p.corp));
    bine("cu bife pentru mai multe câmpuri deodată", /class="bifa-camp"/.test(p.corp));
    bine("fiecare loc își știe id-ul, ca să poată fi scos din uz", /class="ct-loc liber alegibil"[\s\S]{0,160}data-loc="\d+"/.test(p.corp));
    // Cele două moduri nu trebuie să se calce: în editare, selecția de marfă
    // se golește, altfel un click ar face două lucruri deodată.
    bine("intrarea în editare golește selecția de marfă", /golim selectia de marfa|Golim selectia de marfa/i.test(p.corp));
  }

  console.log("\n13. Categoriile de zonă");
  {
    // „Sa fie si produse intermediare aici in lista." Lista e sursa unică:
    // o singură constantă hrănește lista derulantă de pe zone, eticheta
    // rândului, formularul de intrare, legenda ȘI filtrul care validează ce
    // se salvează. Testul se uită în toate, nu doar în prima.
    const p = await cer("/stocuri/ct-park/rand/:id", { params: { id: String(rand) } });
    const optiuniZone = [...p.corp.matchAll(/<option value="([^"]+)"[^>]*>[^<]*<\/option>/g)].map((m) => m[1]);
    for (const c of ["produse finite", "produse intermediare", "consumabile", "materie primă"])
      bine("zonele pot fi „" + c + "”", optiuniZone.includes(c), optiuniZone.slice(0, 8).join(" | "));
    bine("și categoria nouă are culoarea ei în legendă, nu grina implicită",
      /background:#1a6e8e"><\/i>produse intermediare/.test(p.corp),
      (p.corp.match(/<span><i style="background:[^"]+"><\/i>[^<]+<\/span>/g) || []).join(" "));

    // Filtrul de validare e același lista: dacă ar fi rămas pe trei, zona
    // s-ar fi salvat ca NULL și omul ar fi crezut că n-a mers click-ul.
    const nivelUnu = 1;
    await cer("/stocuri/ct-park/rand/:id/zone", {
      params: { id: String(rand) },
      metoda: "post",
      body: { [`z_${nivelUnu}_1`]: "produse intermediare" },
    });
    egal("o zonă chiar se salvează pe categoria nouă",
      String(unul(`SELECT categorie FROM ct_locuri WHERE rand_id=${rand} AND nivel=${nivelUnu} AND camp=1 AND pozitie=1`)),
      "produse intermediare");

    // Și lista de pe intrarea de marfă, care e alt ecran cu aceeași sursă.
    const i = await cer("/stocuri/ct-park/intrare", { query: { rand: String(rand) } });
    bine("și la intrarea de marfă se poate alege", />produse intermediare</.test(i.corp));
  }

  console.log("\n14. Mutarea unei palete, pe rute reale");
  {
    // Rândul vine din secțiunile de dinainte ciopârțit — câmpul 2 avea 4
    // niveluri × 1 palet, 8–10 un singur nivel. Îl aducem la o formă știută
    // înainte să ne legăm de adrese, altfel testul ăsta se strică de fiecare
    // dată când se schimbă unul de mai sus, și pare că e vina mutării.
    await cer("/stocuri/ct-park/configurare/:id/sectoare", {
      params: { id: String(rand) }, metoda: "post",
      body: { s0_de_la: "", s0_pana_la: "", s0_niveluri: "", s0_paleti: "" },
    });
    egal("pornim de la un rând uniform: 10 × 3 × 2",
      Number(unul(`SELECT COUNT(*) FROM ct_locuri WHERE rand_id = ${rand}`)), 60);

    // Punem o paletă lată de 2 locuri în câmpul 2, nivelul 1, și o mutăm.
    q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, um, data_intrare) VALUES ('TS-M', 'TEST-SECTOARE', 10, 'buc', '2026-10-24')`);
    const palet = Number(unul("SELECT id FROM ct_paleti WHERE cod = 'TS-M'"));
    const locul = (c, n, p) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND camp=${c} AND nivel=${n} AND pozitie=${p}`));
    const a1 = locul(2, 1, 1), a2 = locul(2, 1, 2);
    q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${palet}, ${a1}), (${palet}, ${a2})`);

    const unde = (r) => ((r.antet && (r.antet.Location || r.antet.location)) || "");

    // Pagina de mutare o găsește în listă.
    let p = await cer("/stocuri/ct-park/muta", {});
    bine("meniul «Mută marfă» se deschide", p.cod === 200, p.cod);
    bine("și paleta e în listă cu adresele ei", /TEST-SECTOARE|marfă/.test(p.corp) && p.corp.includes("Mut-o"), p.corp.length);

    // Cu paleta aleasă, propune unde încape.
    p = await cer("/stocuri/ct-park/muta", { query: { palet: String(palet) } });
    bine("cu paleta aleasă, spune pe ce stă acum", p.cod === 200 && /2 locuri/.test(p.corp), p.cod);
    bine("și propune ferestre de câte 2 locuri lipite", (p.corp.match(/name="locuri" value="\d+,\d+"/g) || []).length > 0,
      (p.corp.match(/name="locuri" value="[^"]*"/g) || []).slice(0, 3).join(" "));
    bine("are și formularul scris, cu rând/nivel/câmp/poziție",
      /name="rand_id"/.test(p.corp) && /name="nivel"/.test(p.corp) && /name="camp"/.test(p.corp) && /name="pozitie"/.test(p.corp));

    // Mutare scrisă: rândul, nivelul 2, câmpul 4, poziția 1.
    p = await cer("/stocuri/ct-park/muta", {
      metoda: "post",
      body: { palet: String(palet), rand_id: String(rand), nivel: "2", camp: "4", pozitie: "1" },
    });
    bine("mutarea scrisă duce înapoi la rând, cu mesaj", /\/stocuri\/ct-park\/rand\/\d+\?ok=/.test(unde(p)), unde(p));
    egal("paleta stă acum pe nivelul 2, câmpul 4, pozițiile 1-2",
      q(`SELECT l.nivel, l.camp, l.pozitie FROM ct_ocupari o JOIN ct_locuri l ON l.id=o.loc_id
           WHERE o.palet_id=${palet} ORDER BY l.pozitie`).map((x) => [Number(x.nivel), Number(x.camp), Number(x.pozitie)]),
      [[2, 4, 1], [2, 4, 2]]);
    egal("și locurile vechi sunt libere",
      Number(unul(`SELECT COUNT(*) FROM ct_ocupari WHERE loc_id IN (${a1},${a2})`)), 0);

    // Paleta nu trebuie să se spargă: un câmp cu o singură poziție liberă
    // de la cea cerută încolo n-o poate primi. Câmpurile 8-10 au 1 nivel ×
    // 2 paleți; cerem poziția 2, deci rămâne o singură poziție.
    p = await cer("/stocuri/ct-park/muta", {
      metoda: "post",
      body: { palet: String(palet), rand_id: String(rand), nivel: "1", camp: "9", pozitie: "2" },
    });
    bine("nu o mută unde nu încap amândouă locurile", /eroare=/.test(unde(p)) && /sunt doar 1/.test(decodeURIComponent(unde(p))),
      decodeURIComponent(unde(p)));

    // Peste altă marfă: nu.
    q(`INSERT INTO ct_paleti (cod, produs_text, cantitate, um, data_intrare) VALUES ('TS-M2', 'TEST-SECTOARE', 1, 'buc', '2026-10-24')`);
    const palet2 = Number(unul("SELECT id FROM ct_paleti WHERE cod = 'TS-M2'"));
    const b1 = locul(6, 1, 1);
    q(`INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (${palet2}, ${b1})`);
    p = await cer("/stocuri/ct-park/muta", {
      metoda: "post",
      body: { palet: String(palet), locuri: b1 + "," + locul(6, 1, 2) },
    });
    bine("nu o mută peste altă paletă", /eroare=/.test(unde(p)) && /stă deja altă marfă/.test(decodeURIComponent(unde(p))),
      decodeURIComponent(unde(p)));

    // Locuri răzlețe: „atentie daca ocupa mai multe spatii sa aibe loc in
    // partea aia". Două locuri din câmpuri diferite nu fac o paletă lată.
    p = await cer("/stocuri/ct-park/muta", {
      metoda: "post",
      body: { palet: String(palet), locuri: locul(3, 1, 1) + "," + locul(5, 1, 1) },
    });
    bine("nu o mută pe locuri răzlețe", /eroare=/.test(unde(p)) && /nu sunt lipite/.test(decodeURIComponent(unde(p))),
      decodeURIComponent(unde(p)));

    // Un loc scos din uz nu primește marfă nici prin mutare.
    const blocat = locul(3, 1, 1);
    q(`UPDATE ct_locuri SET blocat = 1 WHERE id = ${blocat}`);
    p = await cer("/stocuri/ct-park/muta", {
      metoda: "post",
      body: { palet: String(palet), locuri: blocat + "," + locul(3, 1, 2) },
    });
    bine("nici pe un loc scos din uz", /eroare=/.test(unde(p)) && /scos din uz/.test(decodeURIComponent(unde(p))),
      decodeURIComponent(unde(p)));
    q(`UPDATE ct_locuri SET blocat = 0 WHERE id = ${blocat}`);

    // Mutarea cu un loc mai încolo, peste propriile locuri: trebuie să meargă.
    p = await cer("/stocuri/ct-park/muta", {
      metoda: "post",
      body: { palet: String(palet), locuri: locul(4, 2, 2) + "," + locul(4, 2, 1) },
    });
    bine("mutarea în aceleași locuri se refuză cu «e deja acolo»",
      /eroare=/.test(unde(p)) && /deja acolo/.test(decodeURIComponent(unde(p))), decodeURIComponent(unde(p)));

    // Harta rândului știe ce paletă e pe fiecare loc și câte locuri ține.
    const h = await cer("/stocuri/ct-park/rand/:id", { params: { id: String(rand) } });
    bine("harta are butonul «Mut marfă»", /id="buton-mut"/.test(h.corp));
    bine("și fiecare paletă își spune câte locuri ține", /data-palet-locuri="2"/.test(h.corp),
      (h.corp.match(/data-palet-locuri="\d+"/g) || []).slice(0, 4).join(" "));
    bine("bara de mutare duce la ruta de mutare", /action="\/stocuri\/ct-park\/muta"/.test(h.corp));
    bine("iar bara de intrare tace cât timp se mută", /classList.contains\("ct-mut"\)/.test(h.corp));

    q(`DELETE FROM ct_ocupari WHERE palet_id IN (${palet}, ${palet2})`);
    q(`DELETE FROM ct_paleti WHERE id IN (${palet}, ${palet2})`);
  }

  curata();
  console.log(esecuri ? `\n${esecuri} probleme.\n` : "\nTotul curat.\n");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error("\nTestul a crăpat:", e && e.stack ? e.stack : e);
  try { curata(); } catch (x) { /* nimic */ }
  process.exit(1);
});
