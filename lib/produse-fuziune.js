"use strict";
// Unificarea codurilor de produs.
//
// În ERP același articol a ajuns sub mai multe coduri: o dată din facturare, o
// dată din registrul de producție, o dată scris de mână. Rezultatul e că stocul
// se vede pe jumătate, marja pe produs iese greșit și rețetele trimit la
// componente care nu se adună.
//
// Unificarea mută toate trimiterile de la produsele înghițite la cel păstrat.
// Două reguli pe care le respectă mereu:
//
//   1. Produsul înghițit NU se șterge. Rămâne în bază, dezactivat, cu
//      `fuzionat_in` completat. Dacă am ratat o referință undeva, ea nu cade
//      într-un id inexistent, iar operațiunea poate fi citită înapoi din
//      `produse_fuziuni`.
//   2. Nimic nu se mută fără previzualizare. `previzualizeaza()` numără, rând
//      cu rând și tabel cu tabel, ce urmează să se întâmple.
//
// Lista de mai jos trebuie ținută la zi: dacă apare un tabel nou cu produs_id
// și nu e aici, fuziunea îl lasă în urmă și datele se rup în tăcere. Testul
// test-fuziune.js verifică exact asta, citind schema.
const db = require("./db");

// tabel, coloană, și (opțional) coloanele care formează o restricție de
// unicitate împreună cu coloana de produs
const TABELE = [
  { tabel: "facturi_linii", coloana: "produs_id" },
  { tabel: "comenzi_linii", coloana: "produs_id" },
  { tabel: "oferte_linii", coloana: "produs_id" },
  { tabel: "miscari_stoc", coloana: "produs_id" },
  { tabel: "rezervari_stoc", coloana: "produs_id" },
  { tabel: "aprovizionari", coloana: "produs_id" },
  { tabel: "ach_articole", coloana: "produs_id" },
  { tabel: "cereri_materie_prima", coloana: "produs_id" },
  { tabel: "retete_componente", coloana: "produs_id" },
  { tabel: "retete_componente", coloana: "componenta_id" },
  { tabel: "comenzi_productie", coloana: "produs_id" },
  { tabel: "comenzi_productie_linii", coloana: "produs_id" },
  { tabel: "produse_caracteristici", coloana: "produs_id" },
  { tabel: "concurenta_preturi", coloana: "produs_id" },
  { tabel: "ct_paleti", coloana: "produs_id" },
  { tabel: "profit_produs", coloana: "produs_id" },
  { tabel: "utilaje_capacitate", coloana: "produs_id" },
  { tabel: "inventare_linii", coloana: "produs_id", unic: ["inventar_id"] },
];

const cheie = (t) => `${t.tabel}.${t.coloana}`;

// Numără, fără să schimbe nimic. Pentru tabelele cu restricție de unicitate
// separă rândurile care se pot muta de cele care s-ar ciocni.
async function previzualizeaza(pastratId, inghititeIds) {
  const pastrat = Number(pastratId);
  const inghitite = (inghititeIds || []).map(Number).filter((x) => x && x !== pastrat);
  if (!pastrat || !inghitite.length) return { pastrat, inghitite, randuri: [], total: 0, blocate: 0 };

  const lista = inghitite.join(",");
  const randuri = [];
  for (const t of TABELE) {
    let muta = 0;
    let blocat = 0;
    try {
      if (t.unic) {
        const cond = t.unic.map((c) => `x.${c} = y.${c}`).join(" AND ");
        muta = (
          await db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${t.tabel} x WHERE x.${t.coloana} IN (${lista})
                 AND NOT EXISTS (SELECT 1 FROM ${t.tabel} y WHERE y.${t.coloana} = ? AND ${cond})`
            )
            .get(pastrat)
        ).n;
        blocat = (
          await db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${t.tabel} x WHERE x.${t.coloana} IN (${lista})
                 AND EXISTS (SELECT 1 FROM ${t.tabel} y WHERE y.${t.coloana} = ? AND ${cond})`
            )
            .get(pastrat)
        ).n;
      } else {
        muta = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t.tabel} WHERE ${t.coloana} IN (${lista})`).get()).n;
      }
    } catch (e) {
      // Un tabel care nu există încă pe baza asta nu e o eroare: schema crește
      // în timp, iar previzualizarea trebuie să meargă oricum.
      randuri.push({ cheie: cheie(t), muta: 0, blocat: 0, eroare: e.message.slice(0, 120) });
      continue;
    }
    if (muta || blocat) randuri.push({ cheie: cheie(t), muta: Number(muta), blocat: Number(blocat) });
  }
  return {
    pastrat,
    inghitite,
    randuri,
    total: randuri.reduce((a, r) => a + r.muta, 0),
    blocate: randuri.reduce((a, r) => a + r.blocat, 0),
  };
}

// Mută efectiv. Întoarce aceeași formă ca previzualizarea, dar cu ce s-a
// întâmplat, nu cu ce urma să se întâmple.
async function fuzioneaza(pastratId, inghititeIds, utilizatorId) {
  const pastrat = Number(pastratId);
  const inghitite = (inghititeIds || []).map(Number).filter((x) => x && x !== pastrat);
  if (!pastrat || !inghitite.length) throw new Error("Alege produsul păstrat și cel puțin unul de unificat.");

  const tinta = await db.prepare("SELECT * FROM produse WHERE id = ?").get(pastrat);
  if (!tinta) throw new Error("Produsul păstrat nu există.");
  // Codul păstrat nu poate fi el însuși unul unificat: altfel s-ar face un lanț
  // A→B→C, iar cine caută A ar nimeri pe B, care e dezactivat.
  if (tinta.fuzionat_in) {
    const final = await db.prepare("SELECT cod, denumire FROM produse WHERE id = ?").get(tinta.fuzionat_in);
    throw new Error(
      `Produsul pe care vrei să-l păstrezi a fost deja unificat în ${
        final ? (final.cod ? final.cod + " " : "") + final.denumire : "alt cod"
      }. Alege codul final ca produs păstrat.`
    );
  }

  const lista = inghitite.join(",");
  const mutari = {};
  for (const t of TABELE) {
    try {
      let r;
      if (t.unic) {
        const cond = t.unic.map((c) => `x.${c} = y.${c}`).join(" AND ");
        r = await db
          .prepare(
            `UPDATE ${t.tabel} x SET ${t.coloana} = ? WHERE x.${t.coloana} IN (${lista})
               AND NOT EXISTS (SELECT 1 FROM ${t.tabel} y WHERE y.${t.coloana} = ? AND ${cond})`
          )
          .run(pastrat, pastrat);
      } else {
        r = await db.prepare(`UPDATE ${t.tabel} SET ${t.coloana} = ? WHERE ${t.coloana} IN (${lista})`).run(pastrat);
      }
      if (r && r.changes) mutari[cheie(t)] = r.changes;
    } catch (e) {
      mutari[cheie(t) + " (eroare)"] = e.message.slice(0, 120);
    }
  }

  // Ce arăta spre un produs înghițit arată de acum direct spre cel păstrat.
  // Fără asta s-ar forma lanțuri (A→B, apoi B→C), iar `fuzionat_in` n-ar mai
  // putea fi citit dintr-un pas: cine caută A ar ajunge pe B, dezactivat.
  // Graficul rămâne plat, deci COALESCE(fuzionat_in, id) e mereu răspunsul bun.
  await db
    .prepare(`UPDATE produse SET fuzionat_in = ? WHERE fuzionat_in IN (${lista})`)
    .run(pastrat);

  // Produsele înghițite rămân în bază, dezactivate și legate de cel păstrat.
  for (const id of inghitite) {
    const vechi = await db.prepare("SELECT cod, denumire FROM produse WHERE id = ?").get(id);
    await db.prepare("UPDATE produse SET activ = 0, fuzionat_in = ? WHERE id = ?").run(pastrat, id);
    await db
      .prepare(
        `INSERT INTO produse_fuziuni (pastrat_id, inghitit_id, inghitit_cod, inghitit_denumire, mutari, facut_de)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(pastrat, id, vechi ? vechi.cod : null, vechi ? vechi.denumire : null, JSON.stringify(mutari), utilizatorId || null);
  }
  return { pastrat, inghitite, mutari, total: Object.values(mutari).filter((x) => typeof x === "number").reduce((a, b) => a + b, 0) };
}

// Produse care par a fi același lucru: aceeași denumire normalizată, sau
// același cod. Nu unește nimic — doar arată unde merită să te uiți.
async function posibileDuplicate(limita) {
  const toate = await db.prepare("SELECT id, cod, denumire, unitate_masura FROM produse WHERE activ = 1 ORDER BY denumire").all();
  const normal = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const grupe = new Map();
  for (const p of toate) {
    const k = normal(p.denumire);
    if (!k) continue;
    if (!grupe.has(k)) grupe.set(k, []);
    grupe.get(k).push(p);
  }
  const out = [];
  for (const [k, v] of grupe) if (v.length > 1) out.push({ cheie: k, produse: v });
  out.sort((a, b) => b.produse.length - a.produse.length);
  return out.slice(0, limita || 100);
}

module.exports = { TABELE, previzualizeaza, fuzioneaza, posibileDuplicate };
