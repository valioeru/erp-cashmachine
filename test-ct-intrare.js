"use strict";
// Intrarea mărfii în CT-Park: locul ales se păstrează, se vede în căsuțe, și
// „Adaugă marfă" pune paletul fix acolo, cu cantitatea lui.
// Partea întâi pe funcțiile pure (lib/ct-intrare.js), a doua pe PostgreSQL
// real, prin rutele adevărate.
//
// CE A CERUT VALI, 30.10.2026:
//   „La adaugă marfă nouă în depozit crapă, iar dacă aleg vizual unde să adaug
//    un produs nou nu reține la final locul unde să-l pun în raft; ar trebui în
//    pagina de adăugare să fie rândul, locul etc. deja completate — acum nu sunt
//    nici căsuțele pentru asta." · „Și buton la final: Adaugă marfă." ·
//   „La adaugă să putem alege clar locul, și ce și cât ocupă acolo."
//
// CE APĂRĂ:
//
//   • PASUL FINAL NU MAI CADE. /ocupa folosea o variabilă definită doar în
//     pasul dinainte („cuFurnizorLaIntrare is not defined") — nimic nu se
//     salva, nici marfa, nici locul. Niciun test nu ajungea până la el.
//
//   • LOCUL ALES SE VEDE ȘI SE FOLOSEȘTE. Venit de pe hartă, fiecare palet are
//     rândul, nivelul, câmpul și poziția completate; la salvare, paletul stă
//     fix acolo.
//
//   • FIECARE PALET CU CANTITATEA LUI. Nu un total împărțit la ochi.
//
//   • CU LOCUL ȘTIUT, „ADAUGĂ MARFĂ" PUNE DIRECT. Fără un pas de confirmare
//     care repetă ce ai ales deja.
//
//   • CE NU SE POATE NU SE GHICEȘTE. Un loc scris pe jumătate, unul care nu
//     există, unul ocupat între timp sau trecut de două ori — se spune pe
//     nume, iar restul paleților se pot pune normal.
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

const CI = require(path.join(RAD, "lib", "ct-intrare.js"));
const rute = { get: {}, post: {} };
require(path.join(RAD, "modules", "ct-park.js")).register({
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
async function cer(cale, { query = {}, body = null, metoda = "get" } = {}) {
  const h = rute[metoda][cale];
  if (!h) throw new Error("ruta lipseste: " + metoda.toUpperCase() + " " + cale);
  const r = res();
  await h({ user: { id: 1, nume: "Vali", rol: "admin" }, params: {}, query, body: body || {}, res: r, req: { url: cale } });
  return r;
}
const locatie = (r) => String((r.antet && (r.antet.Location || r.antet.location)) || "");
const paletiDin = (r) => String(locatie(r).split("paleti=")[1] || "").split(",").map(Number).filter(Boolean);

let esecuri = 0;
function bine(descriere, conditie, detaliu) {
  if (conditie) console.log("  ok     " + descriere);
  else { console.log("  ESEC   " + descriere + (detaliu !== undefined ? "  -> " + String(detaliu).slice(0, 300) : "")); esecuri++; }
}

(async () => {
  // ======================================================================
  console.log("\n1. Formularul, adus la aceeași formă");
  {
    const r = CI.randuriDinFormular({
      "loc_ids[]": ["11,12", "", ""],
      "loc_rand[]": ["3", "3", ""],
      "loc_nivel[]": ["1", "2", ""],
      "loc_camp[]": ["4", "5", ""],
      "loc_pozitie[]": ["1", "2", ""],
      "loc_latime[]": ["2", "1", "1"],
      "loc_paleti[]": ["1", "1", "1"],
      "loc_cantitate[]": ["100", "12,5", ""],
    });
    bine("al treilea rând, gol de tot, nu e un palet", r.length === 2, r.length);
    bine("rândul de pe hartă își ține locurile", JSON.stringify(r[0].ids) === "[11,12]" && r[0].latime === 2);
    bine("cantitatea cu virgulă: 12,5", r[1].cantitate === 12.5, r[1].cantitate);
    bine("rândul scris: rând 3, nivel 2, câmp 5, poziția 2", r[1].randId === 3 && r[1].nivel === 2 && r[1].camp === 5 && r[1].pozitie === 2);
    const unSingur = CI.randuriDinFormular({ "loc_ids[]": "", "loc_rand[]": "", "loc_nivel[]": "", "loc_camp[]": "", "loc_pozitie[]": "", "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "" });
    bine("un singur rând gol rămâne: „un palet, caută-i tu loc”", unSingur.length === 1 && !unSingur[0].cuLoc);
    const vechi = CI.randuriDinFormular({ paleti: "4", locuri: "2", cantitate: "100", rand_id: "7" });
    bine("forma veche: 4 paleți lați, 25 pe fiecare, în rândul 7", vechi.length === 1 && vechi[0].paleti === 4 && vechi[0].latime === 2 && vechi[0].cantitate === 25 && vechi[0].randId === 7);
    const latMare = CI.randuriDinFormular({ "loc_latime[]": "9", "loc_paleti[]": "500", "loc_cantitate[]": "1" });
    bine("lățimea se oprește la 3 locuri, paleții la 60", latMare[0].latime === 3 && latMare[0].paleti === 60);
  }

  console.log("\n2. Locurile alese pe hartă, strânse în paleți");
  {
    const L = (id, n, c, p) => ({ id, rand_id: 1, nivel: n, camp: c, pozitie: p });
    const g = CI.grupeazaLocuri([L(1, 1, 1, 1), L(2, 1, 1, 2), L(3, 1, 2, 1)], 3, false);
    bine("două lipite + unul răzleț = un palet lat și unul normal", g.length === 2 && g[0].length === 2 && g[1].length === 1);
    bine("cu „separat”, fiecare loc e paletul lui", CI.grupeazaLocuri([L(1, 1, 1, 1), L(2, 1, 1, 2)], 3, true).length === 2);
    const patru = CI.grupeazaLocuri([L(1, 1, 1, 1), L(2, 1, 1, 2), L(3, 1, 1, 3), L(4, 1, 1, 4)], 3, false);
    bine("patru lipite: 3 + 1 (un palet nu ocupă mai mult de 3)", patru.length === 2 && patru[0].length === 3 && patru[1].length === 1);
  }

  console.log("\n3. Planul: locul știut, locul greșit, locul propus");
  {
    // Un rând mic, în memorie: nivel 1, câmpurile 1-2, pozițiile 1-3.
    const locuri = [];
    let id = 100;
    for (const camp of [1, 2]) for (const poz of [1, 2, 3]) locuri.push({ id: ++id, rand_id: 5, rand_numar: 9, nivel: 1, camp, pozitie: poz, adresa: `R9-0${camp}-1-${poz}`, ocupat: 0, blocat: 0 });
    locuri.find((l) => l.camp === 2 && l.pozitie === 3).ocupat = 1;
    const rand = (o) => Object.assign({ index: 0, ids: [], randId: null, nivel: null, camp: null, pozitie: null, latime: 1, paleti: 1, cantitate: null, cuLoc: false }, o);

    const exact = CI.planifica([rand({ cuLoc: true, randId: 5, nivel: 1, camp: 1, pozitie: 2, latime: 2, cantitate: 80 })], locuri, null);
    bine("loc scris complet, lat de 2: ocupă pozițiile 2 și 3", exact.paleti.length === 1 && exact.paleti[0].locuri.map((l) => l.pozitie).join(",") === "2,3");
    bine("și se poate pune direct", exact.directe === true);
    bine("cu cantitatea lui", exact.paleti[0].cantitate === 80);

    const partial = CI.planifica([rand({ cuLoc: true, randId: 5, nivel: 1 })], locuri, null);
    bine("loc scris pe jumătate: eroare, nu ghicit", partial.erori.length === 1 && /toate patru/.test(partial.erori[0].mesaj) && !partial.directe);
    const nuExista = CI.planifica([rand({ cuLoc: true, randId: 5, nivel: 1, camp: 7, pozitie: 1 })], locuri, null);
    bine("loc care nu există: se spune", nuExista.erori.length === 1 && /nu există/.test(nuExista.erori[0].mesaj));
    const ocupat = CI.planifica([rand({ cuLoc: true, randId: 5, nivel: 1, camp: 2, pozitie: 3 })], locuri, null);
    bine("loc ocupat: se spune, cu adresa", ocupat.erori.length === 1 && /R9-02-1-3/.test(ocupat.erori[0].mesaj) && /nu e liber/.test(ocupat.erori[0].mesaj));
    const deDouaOri = CI.planifica([rand({ index: 0, cuLoc: true, randId: 5, nivel: 1, camp: 1, pozitie: 1 }), rand({ index: 1, cuLoc: true, randId: 5, nivel: 1, camp: 1, pozitie: 1 })], locuri, null);
    bine("același loc de două ori în formular: al doilea e refuzat", deDouaOri.paleti.length === 1 && deDouaOri.erori.length === 1 && /de două ori/.test(deDouaOri.erori[0].mesaj));
    const multiPeUnLoc = CI.planifica([rand({ cuLoc: true, randId: 5, nivel: 1, camp: 1, pozitie: 1, paleti: 3 })], locuri, null);
    bine("3 paleți pe un singur loc anume: refuzat, cu explicație", multiPeUnLoc.erori.length === 1 && /un singur palet/.test(multiPeUnLoc.erori[0].mesaj));

    const propuse = CI.planifica([rand({ index: 0, cuLoc: true, randId: 5, nivel: 1, camp: 1, pozitie: 1, cantitate: 10 }), rand({ index: 1, paleti: 2, cantitate: 20 })], locuri, null);
    bine("un loc știut + doi de propus: trei paleți", propuse.paleti.length === 3, propuse.paleti.length);
    bine("propunerile nu calcă locul ales", propuse.paleti.filter((p) => p.propus).every((p) => p.locuri.every((l) => !(l.camp === 1 && l.pozitie === 1))));
    bine("nici locul ocupat", propuse.paleti.every((p) => p.locuri.every((l) => !l.ocupat)));
    bine("cu propuneri, nu se pune direct — se confirmă", propuse.directe === false);
    const preMulte = CI.planifica([rand({ paleti: 9, latime: 2 })], locuri, null);
    bine("cer 9 paleți lați, încap doar 2: spune câți a găsit", preMulte.lipsa.length === 1 && preMulte.lipsa[0].gasiti === 2 && preMulte.lipsa[0].ceruti === 9, JSON.stringify(preMulte.lipsa));
  }

  // ======================================================================
  // Pe bază: un rând de test 98, 2 niveluri × 3 câmpuri × 3 poziții.
  const NUMAR = 98;
  function curata() {
    const r = unul("SELECT id FROM ct_randuri WHERE numar = " + NUMAR);
    q("DELETE FROM ct_ocupari WHERE palet_id IN (SELECT id FROM ct_paleti WHERE produs_text LIKE 'TEST-INTRARE%')");
    q("DELETE FROM ct_palet_linii WHERE palet_id IN (SELECT id FROM ct_paleti WHERE produs_text LIKE 'TEST-INTRARE%')");
    q("DELETE FROM ct_paleti WHERE produs_text LIKE 'TEST-INTRARE%'");
    if (r) {
      q(`DELETE FROM ct_ocupari WHERE loc_id IN (SELECT id FROM ct_locuri WHERE rand_id = ${r})`);
      q(`DELETE FROM ct_locuri WHERE rand_id = ${r}`);
      q(`DELETE FROM ct_randuri WHERE id = ${r}`);
    }
  }
  curata();
  q(`INSERT INTO ct_randuri (numar, eticheta, campuri, niveluri, locuri_pe_camp, latime_loc, adancime_loc, activ)
     VALUES (${NUMAR}, 'rand test intrare', 3, 2, 3, 800, 1200, 1)`);
  const rand = Number(unul("SELECT id FROM ct_randuri WHERE numar = " + NUMAR));
  for (let nivel = 1; nivel <= 2; nivel++)
    for (let camp = 1; camp <= 3; camp++)
      for (let poz = 1; poz <= 3; poz++)
        q(`INSERT INTO ct_locuri (rand_id, nivel, camp, pozitie, adresa, blocat) VALUES (${rand}, ${nivel}, ${camp}, ${poz}, 'TI-${nivel}-${camp}-${poz}', 0)`);
  const loc = (n, c, p) => Number(unul(`SELECT id FROM ct_locuri WHERE rand_id=${rand} AND nivel=${n} AND camp=${c} AND pozitie=${p}`));
  const ocupateDe = (paletId) => q(`SELECT loc_id FROM ct_ocupari WHERE palet_id = ${paletId} ORDER BY loc_id`).map((r) => Number(r.loc_id));
  const palet = (id) => q(`SELECT * FROM ct_paleti WHERE id = ${id}`)[0];

  console.log("\n4. Venit de pe hartă: rândurile de paleți vin completate");
  {
    const a = loc(1, 2, 1), b2 = loc(1, 2, 2), c = loc(2, 3, 3);
    const p = await cer("/stocuri/ct-park/intrare", { query: { rand: String(rand), locuri: [a, b2, c].join(",") } });
    bine("pagina se deschide", p.cod === 200);
    const randuriTabel = (p.corp.match(/<tr class="palet-rand din-harta">[\s\S]*?<\/tr>/g) || []);
    bine("două rânduri de palet: unul lat (2 locuri lipite) și unul normal", randuriTabel.length === 2, randuriTabel.length);
    bine("primul ține amândouă locurile", new RegExp('name="loc_ids\\[\\]" value="' + a + "," + b2 + '"').test(randuriTabel[0] || ""));
    bine("cu rândul, nivelul, câmpul și poziția completate", /value="98" aria-label="Rând"/.test(randuriTabel[0] || "") && /name="loc_nivel\[\]" value="1"/.test(randuriTabel[0] || "") && /name="loc_camp\[\]" value="2"/.test(randuriTabel[0] || "") && /name="loc_pozitie\[\]" value="1"/.test(randuriTabel[0] || ""));
    bine("și scrie cât ocupă: 2 locuri", /2 locuri/.test(randuriTabel[0] || ""));
    bine("al doilea: nivel 2, câmp 3, poziția 3", /name="loc_nivel\[\]" value="2"/.test(randuriTabel[1] || "") && /name="loc_camp\[\]" value="3"/.test(randuriTabel[1] || "") && /name="loc_pozitie\[\]" value="3"/.test(randuriTabel[1] || ""));
    bine("fiecare palet are căsuța lui de cantitate", (p.corp.match(/name="loc_cantitate\[\]"/g) || []).length >= 2);
    bine("butonul de la final: „Adaugă marfă”", />Adaugă marfă<\/button>/.test(p.corp));
    bine("„+ încă un palet” și totalul", /id="palet-adauga"/.test(p.corp) && /id="total-intrare"/.test(p.corp));
    bine("căutarea produsului nu pierde locurile alese", new RegExp('<input type="hidden" name="locuri" value="' + [a, b2, c].join(",") + '">').test(p.corp));
    bine("se poate cere câte un palet pe fiecare loc", /separat=1/.test(p.corp));
    const sep = await cer("/stocuri/ct-park/intrare", { query: { rand: String(rand), locuri: [a, b2, c].join(","), separat: "1" } });
    bine("cu „separat”, trei rânduri de palet", (sep.corp.match(/<tr class="palet-rand din-harta">/g) || []).length === 3);
    const gol = await cer("/stocuri/ct-park/intrare", { query: { rand: String(rand) } });
    bine("fără hartă: un rând gol, cu rândul ales din lista de rânduri", new RegExp('<option value="' + rand + '" selected>98').test(gol.corp) && /name="loc_nivel\[\]" placeholder/.test(gol.corp));
  }

  console.log("\n5. „Adaugă marfă” de pe hartă: fix acolo, fiecare cu cantitatea lui");
  {
    const a = loc(1, 2, 1), b2 = loc(1, 2, 2), c = loc(2, 3, 3);
    const p = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: {
        produs_text: "TEST-INTRARE folie", um: "kg", pret_unitar: "7,35", categorie: "materie primă", lot: "L-2026-10", furnizor_text: "Furnizor Test SRL",
        observatii: "fragil </script><b>atenție</b>",
        "loc_ids[]": [a + "," + b2, String(c)], "loc_rand[]": [String(rand), String(rand)],
        "loc_nivel[]": ["1", "2"], "loc_camp[]": ["2", "3"], "loc_pozitie[]": ["1", "3"],
        "loc_latime[]": ["2", "1"], "loc_paleti[]": ["1", "1"], "loc_cantitate[]": ["100", "40"],
      },
    });
    bine("se pune direct și se merge la etichete", p.cod === 302 && /\/stocuri\/ct-park\/etichete\?paleti=/.test(locatie(p)), locatie(p));
    const ids = paletiDin(p);
    bine("doi paleți", ids.length === 2, ids.join(","));
    const [p1, p2] = ids.map(palet);
    bine("primul: 100 kg, pe cele două locuri lipite", p1 && Number(p1.cantitate) === 100 && JSON.stringify(ocupateDe(ids[0])) === JSON.stringify([a, b2].sort((x, y) => x - y)));
    bine("al doilea: 40 kg, pe TI-2-3-3", p2 && Number(p2.cantitate) === 40 && JSON.stringify(ocupateDe(ids[1])) === JSON.stringify([c]));
    bine("prețul scris cu virgulă intră: 7,35", p1 && Number(p1.pret_unitar) === 7.35, p1 && p1.pret_unitar);
    bine("paletul își are linia de conținut", Number(unul(`SELECT cantitate FROM ct_palet_linii WHERE palet_id = ${ids[0]}`)) === 100);
    const et = await cer("/stocuri/ct-park/etichete", { query: { paleti: ids.join(",") } });
    bine("etichetele arată adresele", /TI-1-2-1/.test(et.corp) && /TI-2-3-3/.test(et.corp));
  }

  console.log("\n6. Loc scris de mână");
  {
    const p = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: {
        produs_text: "TEST-INTRARE scris", um: "buc",
        "loc_ids[]": "", "loc_rand[]": String(rand), "loc_nivel[]": "2", "loc_camp[]": "1", "loc_pozitie[]": "2",
        "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "12,5",
      },
    });
    const ids = paletiDin(p);
    bine("loc complet: se pune direct", p.cod === 302 && ids.length === 1, locatie(p));
    bine("fix pe TI-2-1-2, cu 12,5", ids.length === 1 && JSON.stringify(ocupateDe(ids[0])) === JSON.stringify([loc(2, 1, 2)]) && Number(palet(ids[0]).cantitate) === 12.5);

    const ocupat = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: { produs_text: "TEST-INTRARE ocupat", "loc_ids[]": "", "loc_rand[]": String(rand), "loc_nivel[]": "2", "loc_camp[]": "1", "loc_pozitie[]": "2", "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "5" },
    });
    bine("același loc, acum ocupat: nu se pune, se spune de ce", ocupat.cod === 200 && /TI-2-1-2/.test(ocupat.corp) && /nu e liber/.test(ocupat.corp));
    const jumatate = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: { produs_text: "TEST-INTRARE jumatate", "loc_ids[]": "", "loc_rand[]": String(rand), "loc_nivel[]": "1", "loc_camp[]": "", "loc_pozitie[]": "", "loc_latime[]": "1", "loc_paleti[]": "1", "loc_cantitate[]": "5" },
    });
    bine("loc scris pe jumătate: se cere tot, nu se ghicește", jumatate.cod === 200 && /toate patru/.test(jumatate.corp));
  }

  console.log("\n7. Un loc știut + paleți de propus → confirmare → /ocupa nu mai cade");
  {
    const p = await cer("/stocuri/ct-park/intrare", {
      metoda: "post",
      body: {
        produs_text: "TEST-INTRARE mixt", um: "kg",
        "loc_ids[]": ["", ""], "loc_rand[]": [String(rand), String(rand)],
        "loc_nivel[]": ["1", ""], "loc_camp[]": ["1", ""], "loc_pozitie[]": ["1", ""],
        "loc_latime[]": ["1", "1"], "loc_paleti[]": ["1", "2"], "loc_cantitate[]": ["7", "9"],
      },
    });
    bine("cu propuneri, se arată pagina de confirmare", p.cod === 200 && /Adaugă marfă<\/button>/.test(p.corp));
    const grupuri = [...p.corp.matchAll(/name="(grup_\d+)" value="([\d,]+)"/g)].map((m) => [m[1], m[2]]);
    const cant = [...p.corp.matchAll(/name="(cant_\d+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    bine("trei paleți de pus: 1 ales + 2 propuși", grupuri.length === 3, grupuri.length);
    bine("fiecare cu cantitatea lui (7, 9, 9)", cant.map((c) => c[1]).join(",") === "7,9,9", cant.map((c) => c[1]).join(","));
    bine("locul ales e marcat „ales de tine”, celelalte „propus”", (p.corp.match(/ales de tine/g) || []).length === 1 && (p.corp.match(/>propus</g) || []).length === 2);

    const corp = {};
    for (const [k, v] of grupuri) corp[k] = v;
    for (const [k, v] of cant) corp[k] = v;
    Object.assign(corp, { produs_text: "TEST-INTRARE mixt", um: "kg" });
    let o;
    try { o = await cer("/stocuri/ct-park/ocupa", { metoda: "post", body: corp }); } catch (e) { o = { eroare: e.message }; }
    bine("„Adaugă marfă” de pe confirmare nu mai cade", o && !o.eroare && o.cod === 302, o && (o.eroare || o.cod));
    const ids = o && !o.eroare ? paletiDin(o) : [];
    bine("trei paleți puși", ids.length === 3, ids.join(","));
    bine("cu 7, 9 și 9 kg", ids.map((i) => Number(palet(i).cantitate)).join(",") === "7,9,9", ids.map((i) => palet(i) && palet(i).cantitate).join(","));
    bine("primul fix pe locul ales, TI-1-1-1", ids.length && JSON.stringify(ocupateDe(ids[0])) === JSON.stringify([loc(1, 1, 1)]));
  }

  console.log("\n8. Forma veche a confirmării merge și ea");
  {
    const l = loc(2, 2, 1);
    let o;
    try { o = await cer("/stocuri/ct-park/ocupa", { metoda: "post", body: { grup_0: String(l), cantitate_palet: "3", produs_text: "TEST-INTRARE vechi", um: "buc" } }); } catch (e) { o = { eroare: e.message }; }
    bine("nu mai cade cu „cuFurnizorLaIntrare is not defined”", o && !o.eroare && o.cod === 302, o && (o.eroare || o.cod));
    const ids = o && !o.eroare ? paletiDin(o) : [];
    bine("paletul e pus, cu 3 bucăți", ids.length === 1 && Number(palet(ids[0]).cantitate) === 3 && JSON.stringify(ocupateDe(ids[0])) === JSON.stringify([l]));
  }

  console.log("\n9. Pe hartă, la mouseover: fișa paletului");
  {
    // Ruta are parametru; o chem direct, cu params.
    const r = res();
    await rute.get["/stocuri/ct-park/rand/:id"]({ user: { id: 1, nume: "Vali", rol: "admin" }, params: { id: String(rand) }, query: {}, body: {}, res: r, req: { url: "/stocuri/ct-park/rand/" + rand } });
    bine("harta rândului se deschide", r.cod === 200);
    const m = r.corp.match(/<script type="application\/json" id="ct-info-paleti">([\s\S]*?)<\/script>/);
    let info = {};
    try { info = JSON.parse(m ? m[1] : "{}"); } catch (e) { info = { eroare: e.message }; }
    const p = Object.values(info).find((x) => /TEST-INTRARE folie/.test(x.produs || "") && /100/.test(x.cantitate || ""));
    bine("fișa există pentru paletul pus", !!p, Object.keys(info).length + " paleți în fișe");
    if (p) {
      bine("cu codul paletului", /^CT\d{6}-\d{4}$/.test(p.cod), p.cod);
      bine("adresele lui (palet lat: două)", p.adrese === "TI-1-2-1 + TI-1-2-2", p.adrese);
      bine("cantitatea cu UM", p.cantitate === "100 kg", p.cantitate);
      bine("lotul, categoria, furnizorul", p.lot === "L-2026-10" && p.categorie === "materie primă" && p.furnizor === "Furnizor Test SRL", JSON.stringify([p.lot, p.categorie, p.furnizor]));
      bine("prețul de intrare și de unde vine", /^7,35 lei \/ kg \(scris la intrare\)$/.test(p.pret), p.pret);
      bine("valoarea: 735,00 lei", p.valoare === "735,00 lei", p.valoare);
      bine("când a intrat și de când stă", /^\d{2}\.\d{2}\.\d{4} · azi$/.test(p.intrat), p.intrat);
      bine("cine l-a pus și observațiile", p.pus_de === "Vali" && /fragil/.test(p.observatii));
      // Vali, 30.10.2026: un produs pe mai multe locuri se vede ca O poziție
      // dublă sau triplă, nu ca două-trei căsuțe separate.
      const celule = r.corp.match(new RegExp('<a href="/stocuri/ct-park/palet/' + p.id + '"[^>]*>', "g")) || [];
      bine("paletul lat e o singură căsuță pe hartă, nu două", celule.length === 1, celule.length);
      bine("dublă: cât două locuri plus golul dintre ele", celule.length === 1 && /data-latime="2"/.test(celule[0]) && /flex:2 2 2px;/.test(celule[0]), celule[0]);
      bine("cu eticheta 1–2 și ambele adrese", r.corp.includes('ct-loc-adresa">1–2<') && celule.length === 1 && /data-adresa="TI-1-2-1 \+ TI-1-2-2"/.test(celule[0]));
    }
    bine("un text cu </script> nu închide fișele (scris \\u003c)", m && !/<\/script><b>/.test(m[1]) && /\\u003c\/script>/.test(m[1]));
    bine("locul ocupat n-are title (n-ar apărea două etichete)", !/class="ct-loc ocupat[^"]*"\s+title=/.test(r.corp));
    bine("dar are text pentru cititoarele de ecran", /class="ct-loc ocupat[^"]*"\s+aria-label="TI-/.test(r.corp));
    bine("scriptul fișei e în pagină", /id="ct-fisa"/.test(r.corp) && /addEventListener\("pointerover"/.test(r.corp));
    // Pe iPhone, o fișă arătată la atingere înghite click-ul: paletul s-ar
    // deschide abia la a doua atingere. Fișa e doar pentru mouse.
    bine("fișa apare doar cu mouse-ul, nu la atingere pe telefon", /ev\.pointerType === "mouse"/.test(r.corp) && !/addEventListener\("mouseover"/.test(r.corp));    // Barele „Pune marfă…" / „Mută aici" și banda de editare au hidden, dar
    // display:flex din foaia de stil îl bătea — stăteau la vedere tot timpul.
    bine("ce are hidden chiar se ascunde pe harta rândului", /\[hidden\] \{ display:none !important; \}/.test(r.corp));
    // Poza lui Vali, 30.10.2026: un nivel cu un cuvânt lung pe un palet se
    // lățea după text, iar câmpurile nu mai stăteau unul sub altul. Măsurat în
    // Chromium: 135 px decalaj pe 12 câmpuri fără regula asta, 0 cu ea.
    bine("câmpurile stau unul sub altul pe toate nivelurile (min-width:0)", /\.ct-nivel-campuri \{[^}]*min-width:0;/.test(r.corp));
    bine("textul lung se rupe în căsuță, nu o lățește", /\.ct-loc-marfa \{[^}]*overflow-wrap:anywhere;/.test(r.corp));
  }

  curata();
  console.log(esecuri ? `\n${esecuri} PROBLEME` : "\nToate verificările au trecut.");
  process.exit(esecuri ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
