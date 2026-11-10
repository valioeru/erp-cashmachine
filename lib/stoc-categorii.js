"use strict";
// Cele două categorii din „Stoc la zi", puse de aici pe produs.
//
// CEREREA LUI VALI, 10.11.2026:
//   „În Stoc la zi, categoria nomenclator mut-o ca a doua coloană și pune la
//    toate categorii, clasate după cele care au. La fel completează și
//    încadrează și la categoria simplă."
//
// Sunt două lucruri diferite:
//
//   Categoria din nomenclator — `produse.categorie`: „Cartoane", „Pungi
//     curier", „Folie stretch manuală". E a produsului și atât.
//
//   Categoria simplă — una din cele patru din depozit (produse finite, produse
//     intermediare, consumabile, materie primă). Până acum stătea DOAR pe
//     palet, aleasă la intrare; cum alegerea era opțională, 133 din cele 148
//     de produse din stoc n-aveau niciuna. De-aia stă acum și pe produs
//     (`produse.categorie_depozit`): produsul își știe categoria, iar paletul
//     nou o moștenește dacă omul nu alege alta (modules/ct-park.js, puneMarfa).
//     Paletul își păstrează categoria lui, pentru excepții.
//
// Când se pune categoria simplă pe produs, se scrie și pe paleții lui din stoc:
//   - pe cei fără categorie, mereu;
//   - pe cei care au alta, doar dacă pe palet e numai produsul ăsta. Un palet
//     mixt cu categoria lui rămâne cum e: e și al altor produse.
//
// Fiecare schimbare lasă un rând în `produse_categorii_jurnal`, cu ce era
// înainte, ca o încadrare greșită să poată fi găsită și întoarsă.

const db = require("./db");

const TIPURI = ["produse finite", "produse intermediare", "consumabile", "materie primă"];
const LUNGIME_MAX = 80;

function curataCategorie(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, LUNGIME_MAX);
}

// Categoriile din nomenclator folosite deja, pentru lista din care alege omul.
async function categoriiNomenclator() {
  const r = await db
    .prepare(
      `SELECT TRIM(categorie) AS categorie, COUNT(*) AS n FROM produse
        WHERE categorie IS NOT NULL AND TRIM(categorie) <> '' AND COALESCE(activ, 1) = 1
        GROUP BY TRIM(categorie) ORDER BY LOWER(TRIM(categorie))`
    )
    .all()
    .catch(() => []);
  return r.map((x) => x.categorie);
}

// Paleții din stoc ai produsului care primesc categoria simplă (regula de sus).
//
// Al produsului e paletul care are pe el marfă din produs sau, dacă pe palet nu
// e scrisă nicio cantitate, cel pus pe raft pentru produsul ăsta. Al doilea caz
// lipsea: pe 10.11.2026, 24 de paleți puși pe raft fără cantitate (se scrie
// după numărare) au rămas fără categorie la încadrare, fiindcă regula se uita
// doar la liniile cu cantitate.
const PALETII_PRODUSULUI = `p.data_iesire IS NULL
     AND (EXISTS (SELECT 1 FROM ct_palet_linii l WHERE l.palet_id = p.id AND l.produs_id = ? AND l.cantitate > 0)
          OR (p.produs_id = ? AND NOT EXISTS (SELECT 1 FROM ct_palet_linii l WHERE l.palet_id = p.id AND l.cantitate > 0)))
     AND (COALESCE(TRIM(p.categorie), '') = ''
          OR NOT EXISTS (SELECT 1 FROM ct_palet_linii l2
                          WHERE l2.palet_id = p.id AND l2.cantitate > 0 AND COALESCE(l2.produs_id, 0) <> ?))`;

// `schimb` = { categorie, tip }; câmpul lipsă (undefined) nu se atinge.
// Cu `opt.doarGoi`, categoria simplă se scrie doar pe paleții care n-au una
// (așa s-a făcut încadrarea de pe 10.11.2026: ce alesese deja omul a rămas).
// Întoarce { ok, mesaj, schimbat: [...], paleti } sau { eroare }.
async function seteaza(produsId, schimb, user, opt) {
  const id = Number(produsId) || 0;
  const p = id ? await db.prepare("SELECT id, denumire, categorie, categorie_depozit FROM produse WHERE id = ?").get(id).catch(() => null) : null;
  if (!p) return { eroare: "Produsul nu există." };
  const s = schimb || {};
  const cine = (user && user.nume) || null;
  const cand = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19);
  const schimbat = [];
  let paleti = 0;
  const scrie = (camp, vechi, nou, n) =>
    db
      .prepare("INSERT INTO produse_categorii_jurnal (produs_id, camp, vechi, nou, paleti, de, la) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, camp, vechi || null, nou || null, n || 0, cine, cand)
      .catch((e) => console.error("[stoc-categorii] jurnal:", e.message));

  if (s.categorie !== undefined) {
    const nou = curataCategorie(s.categorie);
    const vechi = curataCategorie(p.categorie);
    if (nou !== vechi) {
      await db.prepare("UPDATE produse SET categorie = ? WHERE id = ?").run(nou || null, id);
      await scrie("categorie", vechi, nou, 0);
      schimbat.push(nou ? `categoria din nomenclator: ${nou}` : "fără categorie în nomenclator");
    }
  }

  if (s.tip !== undefined) {
    const nou = String(s.tip || "").trim();
    if (nou && !TIPURI.includes(nou)) return { eroare: `Categoria simplă e una din: ${TIPURI.join(", ")}.` };
    const vechi = String(p.categorie_depozit || "").trim();
    let atinse = 0;
    if (nou) {
      const doarGoi = opt && opt.doarGoi ? " AND COALESCE(TRIM(p.categorie), '') = ''" : "";
      const r = await db
        .prepare(`UPDATE ct_paleti p SET categorie = ? WHERE ${PALETII_PRODUSULUI}${doarGoi} AND COALESCE(p.categorie, '') <> ?`)
        .run(nou, id, id, id, nou);
      atinse = Number((r && r.changes) || 0);
    }
    if (nou !== vechi || atinse) {
      if (nou !== vechi) await db.prepare("UPDATE produse SET categorie_depozit = ? WHERE id = ?").run(nou || null, id);
      await scrie("categorie_depozit", vechi, nou, atinse);
      paleti = atinse;
      schimbat.push(nou ? `categoria simplă: ${nou}${atinse ? ` (scrisă și pe ${atinse} ${atinse === 1 ? "palet" : "paleți"})` : ""}` : "fără categorie simplă pe produs");
    }
  }

  return {
    ok: true,
    schimbat,
    paleti,
    mesaj: schimbat.length ? `${p.denumire} — ${schimbat.join("; ")}.` : `${p.denumire}: nimic de schimbat.`,
  };
}

// Categoria simplă a unui palet nou, când omul n-a ales una: a produsului,
// sau — dacă produsul n-are — cea pe care o au cei mai mulți paleți ai lui.
async function tipPentruPaletNou(produsId) {
  const id = Number(produsId) || 0;
  if (!id) return null;
  const p = await db.prepare("SELECT categorie_depozit FROM produse WHERE id = ?").get(id).catch(() => null);
  const alProdusului = String((p && p.categorie_depozit) || "").trim();
  if (TIPURI.includes(alProdusului)) return alProdusului;
  const r = await db
    .prepare(
      `SELECT categorie, COUNT(*) AS n FROM ct_paleti
        WHERE produs_id = ? AND data_iesire IS NULL AND categorie IS NOT NULL AND TRIM(categorie) <> ''
        GROUP BY categorie ORDER BY COUNT(*) DESC, categorie LIMIT 1`
    )
    .get(id)
    .catch(() => null);
  return r && TIPURI.includes(String(r.categorie)) ? String(r.categorie) : null;
}

module.exports = { TIPURI, LUNGIME_MAX, curataCategorie, categoriiNomenclator, seteaza, tipPentruPaletNou };
