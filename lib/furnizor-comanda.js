"use strict";
// Furnizorul pe comandă, partea care citește și scrie în bază.
//
// Regula (Vali, 06.11.2026) și socoteala ei pură sunt în lib/furnizor-linie.js.
// Aici:
//   • ce furnizori are pe stoc un produs (paleții din CT-Park);
//   • verificarea liniilor unei comenzi la salvare;
//   • furnizorul ales în producție, când se alocă materialul, și drumul lui
//     mai departe: pe liniile comenzii clientului și pe paleții produși.
const db = require("./db");
const FL = require("./furnizor-linie");
const { esc } = require("./render");

const nr = (v) => Number(v) || 0;

// Cere produsul furnizor? Doar dacă familia lui are caracteristica „Furnizor"
// aleasă dintr-o listă (azi: Folie stretch) — cea mutată de pe produs pe
// linie. La restul produselor linia rămâne cum era: nu punem un câmp
// obligatoriu nou pe toate comenzile, iar unde furnizorul e scris ca text în
// produs (WBVFOL01) produsul îl spune deja.
// Aceeași condiție și pe pagina comenzii, deci scrisă o singură dată.
const conditieFurnizor = (a) =>
  `${a}.nume ILIKE '%furniz%' AND COALESCE(${a}.fel, 'lista') <> 'text' AND COALESCE(${a}.activ, 1) = 1`;

async function relevant(produsId) {
  const r = await db
    .prepare(
      `SELECT 1 AS x FROM produse p
         JOIN cod_caracteristici c ON c.familie_id = p.cod_familie_id
        WHERE p.id = ? AND ${conditieFurnizor("c")}
        LIMIT 1`
    )
    .get(nr(produsId))
    .catch(() => null);
  return Boolean(r);
}

// Stocul produsului în CT-Park, grupat pe furnizorul paletului. Doar paleții
// încă în depozit și doar liniile cu marfă.
async function stocPeFurnizori(produsId) {
  return db
    .prepare(
      `SELECT p.furnizor_id, f.nume AS furnizor_nume, p.furnizor_text,
              SUM(pl.cantitate) AS cantitate, MAX(pl.um) AS um, COUNT(DISTINCT p.id) AS paleti
         FROM ct_palet_linii pl
         JOIN ct_paleti p ON p.id = pl.palet_id
         LEFT JOIN parteneri f ON f.id = p.furnizor_id
        WHERE pl.produs_id = ? AND p.data_iesire IS NULL AND pl.cantitate > 0
        GROUP BY p.furnizor_id, f.nume, p.furnizor_text`
    )
    .all(nr(produsId))
    .catch(() => []);
}

// Tot ce trebuie formularului pentru linia unui produs.
async function pentruProdus(produsId) {
  const id = nr(produsId);
  const gol = { relevant: false, optiuni: [], nescris: null, cere: false, total: 0, mesaj: "" };
  if (!id || !(await relevant(id))) return gol;
  const s = FL.optiuniDinStoc(await stocPeFurnizori(id));
  return Object.assign({ relevant: true }, s, { mesaj: FL.mesaj(s) });
}

const listaNr = (n) => (n.length === 1 ? `linia ${n[0]}` : `liniile ${n.join(", ")}`);

// Verificarea furnizorilor de pe liniile unei comenzi, la salvare.
//
// `linii` = [{ produs_id, cantitate, alegere, existenta, vechi }], în ordinea
// rândurilor din formular (numărul liniei din mesaj = poziția + 1, ca la preț).
//   alegere   — ce a trimis formularul („p:12", „t:…", „n" sau gol);
//   existenta — produsul era deja pe comandă (la modificare): linia nu se
//               oprește pentru un furnizor pe care nu i l-a cerut nimeni la
//               plasare, iar ce avea scris rămâne;
//   vechi     — cheia furnizorului scris deja pe linie.
//
// Întoarce { eroare, deScris }, cu `deScris` aliniat cu `linii`:
//   null                — nu se scrie nimic despre furnizor;
//   { pastreaza: true } — rămâne ce era;
//   { furnizor_id, furnizor_text, nume } — furnizorul nou, ales din stoc.
async function verificaLinii(linii) {
  const cache = new Map();
  const info = async (id) => {
    if (!cache.has(id)) cache.set(id, await pentruProdus(id));
    return cache.get(id);
  };
  const lipsa = [];
  const dusa = [];
  const deScris = [];
  for (let i = 0; i < (linii || []).length; i++) {
    const l = linii[i] || {};
    const id = nr(l.produs_id);
    if (!id || !(nr(l.cantitate) > 0)) {
      deScris.push(null);
      continue;
    }
    const cheie = String(l.alegere == null ? "" : l.alegere).trim();
    const vechi = String(l.vechi == null ? "" : l.vechi).trim();
    // Neatins la modificare: rămâne exact ce era, chiar dacă între timp
    // paleții acelui furnizor au plecat din depozit.
    if (l.existenta && (!cheie || cheie === vechi)) {
      deScris.push({ pastreaza: true });
      continue;
    }
    const s = await info(id);
    if (!s.relevant) {
      deScris.push(null);
      continue;
    }
    if (!cheie) {
      if (s.cere) lipsa.push(i + 1);
      deScris.push(null);
      continue;
    }
    const o = s.optiuni.find((x) => x.cheie === cheie);
    const ales = o ? FL.citesteAlegerea(cheie) : null;
    if (!ales) {
      dusa.push(i + 1);
      deScris.push(null);
      continue;
    }
    deScris.push(Object.assign(ales, { nume: o.cheie === "n" ? FL.eticheta(ales) : o.nume }));
  }
  const parti = [];
  if (lipsa.length) {
    parti.push(
      `${lipsa.length === 1 ? "Produsul de pe" : "Produsele de pe"} ${listaNr(lipsa)} ${lipsa.length === 1 ? "e" : "sunt"} pe stoc: ` +
        "alege furnizorul, ca depozitul să știe ce paleți scoate."
    );
  }
  if (dusa.length) {
    parti.push(
      `Furnizorul ales pe ${listaNr(dusa)} nu mai are marfa asta pe stoc — poate a plecat între timp. Alege din nou din listă.`
    );
  }
  return { eroare: parti.join(" "), deScris };
}

// ---- Producția --------------------------------------------------------------

// Furnizorul scris de om la producție → partenerul din ERP, dacă se poate
// spune sigur care e. Întâi numele exact, apoi literele lui („S.C. WBV GMBH"
// = „WBV GmbH"), ca în codul produsului. Două potriviri = niciuna: rămâne
// scris ca text, nu ghicit.
async function rezolvaFurnizor(b) {
  const id = nr(b && b.furnizor_id);
  if (id) {
    const p = await db.prepare("SELECT id, nume FROM parteneri WHERE id = ?").get(id).catch(() => null);
    if (p) return { furnizor_id: Number(p.id), furnizor_text: null, nume: p.nume };
  }
  const text = String((b && b.furnizor) || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!text) return { gol: true };
  const fz = await db
    .prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') AND COALESCE(TRIM(nume), '') <> ''")
    .all()
    .catch(() => []);
  const exact = fz.filter((p) => String(p.nume).trim().toLowerCase() === text.toLowerCase());
  if (exact.length === 1) return { furnizor_id: Number(exact[0].id), furnizor_text: null, nume: exact[0].nume };
  const { litereText } = require("./cod-produs");
  const cheie = litereText(text);
  const dupaLitere = cheie ? fz.filter((p) => litereText(p.nume) === cheie) : [];
  if (exact.length === 0 && dupaLitere.length === 1) {
    return { furnizor_id: Number(dupaLitere[0].id), furnizor_text: null, nume: dupaLitere[0].nume };
  }
  return { furnizor_id: null, furnizor_text: text, nume: text };
}

// Produsele unei comenzi de producție: cel de pe rândul ei și cele de pe
// linii. După ele se găsesc liniile comenzii clientului.
async function produseleProductiei(cp) {
  const ids = new Set();
  if (nr(cp && cp.produs_id)) ids.add(nr(cp.produs_id));
  const linii = await db
    .prepare("SELECT produs_id FROM comenzi_productie_linii WHERE comanda_id = ? AND produs_id IS NOT NULL")
    .all(nr(cp && cp.id))
    .catch(() => []);
  for (const l of linii) if (nr(l.produs_id)) ids.add(nr(l.produs_id));
  return [...ids];
}

// Liniile comenzii clientului pe care le face producția asta.
async function liniileClientului(cp) {
  if (!nr(cp && cp.comanda_id)) return [];
  const ids = await produseleProductiei(cp);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT cl.id, cl.produs_id, cl.furnizor_id, cl.furnizor_text, cl.furnizor_sursa, f.nume AS furnizor_nume,
              pr.denumire
         FROM comenzi_linii cl
         JOIN produse pr ON pr.id = cl.produs_id
         LEFT JOIN parteneri f ON f.id = cl.furnizor_id
        WHERE cl.comanda_id = ? AND cl.produs_id IN (${ids.map(() => "?").join(",")})
        ORDER BY cl.id`
    )
    .all(nr(cp.comanda_id), ...ids)
    .catch(() => []);
}

const areFurnizor = (l) => Boolean(nr(l && l.furnizor_id) || String((l && l.furnizor_text) || "").trim());

// Furnizorul ales în producție, cu drumul lui mai departe.
//
// Pe liniile clientului se scrie doar unde nu era ales nimic, sau unde îl
// pusese tot producția (o corectură ajunge și acolo). Furnizorul ales de
// agent din stoc nu se rescrie: e marfă de pe alți paleți.
async function seteazaLaProductie(cpId, ales, user) {
  const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(nr(cpId));
  if (!cp) return { gasita: false };
  const fid = ales && !ales.gol ? ales.furnizor_id || null : null;
  const ftext = ales && !ales.gol ? ales.furnizor_text || null : null;
  const cine = (user && (user.nume || user.email)) || null;
  const cand = new Date().toISOString().slice(0, 16).replace("T", " ");
  await db
    .prepare(
      `UPDATE comenzi_productie SET furnizor_id = ?, furnizor_text = ?, furnizor_ales_la = ?, furnizor_ales_de = ? WHERE id = ?`
    )
    .run(fid, ftext, fid || ftext ? cand : null, fid || ftext ? cine : null, cp.id);

  const numeNou = ales && !ales.gol ? ales.nume || ftext || "" : "";
  let liniiAtinse = 0;
  for (const l of await liniileClientului(cp)) {
    const aiProductiei = String(l.furnizor_sursa || "") === "productie";
    if (areFurnizor(l) && !aiProductiei) continue;
    const vechi = areFurnizor(l) ? FL.eticheta(l, l.furnizor_nume) : "";
    if (vechi === numeNou && nr(l.furnizor_id) === nr(fid)) continue;
    await db
      .prepare("UPDATE comenzi_linii SET furnizor_id = ?, furnizor_text = ?, furnizor_sursa = ? WHERE id = ?")
      .run(fid, ftext, fid || ftext ? "productie" : null, l.id);
    liniiAtinse++;
    // În istoricul comenzii clientului, ca orice altă schimbare de pe ea.
    try {
      await db
        .prepare(
          `INSERT INTO comenzi_istoric (comanda_id, utilizator_id, utilizator_nume, ce, vechi, nou)
           VALUES (?,?,?,?,?,?)`
        )
        .run(
          cp.comanda_id,
          user ? user.id || null : null,
          cine || "",
          "Furnizor · " + (l.denumire || "produs #" + l.produs_id),
          vechi,
          numeNou ? `${numeNou} (din producția ${cp.numar || "#" + cp.id})` : ""
        );
    } catch (e) {
      console.error("[furnizor] istoricul comenzii:", e.message);
    }
  }
  return { gasita: true, liniiAtinse, comandaId: nr(cp.comanda_id) || null };
}

// Furnizorii de pe stocul materialelor din rețeta produselor comenzii de
// producție — ce poate aloca producția chiar acum, de aceea apar întâi.
//
// Și furnizorii de pe stocul materiei prime alese pe comandă (10.11.2026): la
// un produs fără rețetă, materia aleasă e singurul loc din care se știe ce
// material intră în el.
async function sugestiiProductie(cp) {
  const ids = await produseleProductiei(cp);
  const materie = nr(cp && cp.materie_produs_id);
  if (!ids.length && !materie) return [];
  const r = await db
    .prepare(
      `SELECT p.furnizor_id, f.nume AS furnizor_nume, p.furnizor_text,
              SUM(pl.cantitate) AS cantitate, MAX(pl.um) AS um, COUNT(DISTINCT p.id) AS paleti
         FROM ct_palet_linii pl
         JOIN ct_paleti p ON p.id = pl.palet_id
         LEFT JOIN parteneri f ON f.id = p.furnizor_id
        WHERE (pl.produs_id = ?
               OR pl.produs_id IN (SELECT rc.componenta_id FROM retete_componente rc
                                    WHERE rc.produs_id IN (${ids.length ? ids.map(() => "?").join(",") : "0"})))
          AND p.data_iesire IS NULL AND pl.cantitate > 0
        GROUP BY p.furnizor_id, f.nume, p.furnizor_text`
    )
    .all(materie, ...ids)
    .catch(() => []);
  return FL.optiuniDinStoc(r).optiuni.filter((o) => o.cheie !== "n");
}

// ---- Materia primă a comenzii de producție ----------------------------------
//
// CEREREA LUI VALI, 10.11.2026, cu poza comenzii de producție la caseta
// „Furnizorul materialului": „Și să poată alege și materia primă tot de aici."
//
// Materia primă se alege din aceeași casetă cu furnizorul ei: din ce e pe stoc
// în CT-Park (paleții din categoriile „materie primă" și „produse
// intermediare"), din orice alt produs din catalog sau, dacă nu e în catalog,
// scrisă ca text. Dacă materia aleasă e pe stoc de la un singur furnizor, iar
// comanda n-are încă furnizor, îl primește și pe el — de acolo ajunge pe linia
// clientului și pe paleții produși, ca orice furnizor ales în producție.
const CATEGORII_MATERIE = ["materie primă", "produse intermediare"];
const cantText = (v, um) => `${(Number(v) || 0).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${um ? " " + um : ""}`;

// Ce materie primă e pe stoc în CT-Park, pe produs, cu furnizorii paleților.
async function materiiPeStoc() {
  return db
    .prepare(
      `SELECT pl.produs_id, pr.denumire, COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS cod,
              SUM(pl.cantitate) AS cantitate, MAX(pl.um) AS um, COUNT(DISTINCT p.id) AS paleti,
              string_agg(DISTINCT COALESCE(f.nume, NULLIF(TRIM(p.furnizor_text), '')), ', ') AS furnizori
         FROM ct_palet_linii pl
         JOIN ct_paleti p ON p.id = pl.palet_id
         JOIN produse pr ON pr.id = pl.produs_id
         LEFT JOIN parteneri f ON f.id = p.furnizor_id
        WHERE p.data_iesire IS NULL AND pl.cantitate > 0
          AND LOWER(COALESCE(p.categorie, '')) IN (${CATEGORII_MATERIE.map(() => "?").join(",")})
        GROUP BY pl.produs_id, pr.denumire, pr.cod, pr.cod_generat
        ORDER BY pr.denumire
        LIMIT 600`
    )
    .all(...CATEGORII_MATERIE)
    .catch(() => []);
}

// Stocul din CT-Park al unui produs anume, oricare i-ar fi categoria.
async function stoculMateriei(produsId) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(pl.cantitate), 0) AS cantitate, MAX(pl.um) AS um, COUNT(DISTINCT p.id) AS paleti,
              string_agg(DISTINCT COALESCE(f.nume, NULLIF(TRIM(p.furnizor_text), '')), ', ') AS furnizori
         FROM ct_palet_linii pl
         JOIN ct_paleti p ON p.id = pl.palet_id
         LEFT JOIN parteneri f ON f.id = p.furnizor_id
        WHERE pl.produs_id = ? AND p.data_iesire IS NULL AND pl.cantitate > 0`
    )
    .get(nr(produsId))
    .catch(() => null);
  return { cantitate: nr(r && r.cantitate), um: (r && r.um) || "", paleti: nr(r && r.paleti), furnizori: (r && r.furnizori) || "" };
}

// Materialele din rețeta produselor comenzii care sunt acum pe stoc — apar
// întâi, ca butoane: de cele mai multe ori materia primă e una din ele.
async function materiiDinReteta(cp) {
  const ids = await produseleProductiei(cp);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT pl.produs_id, pr.denumire, SUM(pl.cantitate) AS cantitate, MAX(pl.um) AS um
         FROM ct_palet_linii pl
         JOIN ct_paleti p ON p.id = pl.palet_id
         JOIN produse pr ON pr.id = pl.produs_id
        WHERE pl.produs_id IN (SELECT rc.componenta_id FROM retete_componente rc WHERE rc.produs_id IN (${ids.map(() => "?").join(",")}))
          AND p.data_iesire IS NULL AND pl.cantitate > 0
        GROUP BY pl.produs_id, pr.denumire
        ORDER BY SUM(pl.cantitate) DESC, pr.denumire
        LIMIT 12`
    )
    .all(...ids)
    .catch(() => []);
}

// Ce a scris omul → produsul din catalog, dacă se poate spune sigur care e:
// întâi denumirea exactă, apoi codul exact. Două potriviri = niciuna: rămâne
// text, nu ghicit (ca la furnizor).
async function rezolvaMaterie(b) {
  const id = nr(b && b.materie_produs_id);
  if (id) {
    const p = await db.prepare("SELECT id, denumire FROM produse WHERE id = ?").get(id).catch(() => null);
    if (p) return { produs_id: Number(p.id), text: null, nume: p.denumire };
  }
  const text = String((b && b.materie) || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) return { gol: true };
  const dupaNume = await db
    .prepare("SELECT id, denumire FROM produse WHERE LOWER(TRIM(denumire)) = LOWER(?) LIMIT 2")
    .all(text)
    .catch(() => []);
  if (dupaNume.length === 1) return { produs_id: Number(dupaNume[0].id), text: null, nume: dupaNume[0].denumire };
  const dupaCod = dupaNume.length
    ? []
    : await db
        .prepare("SELECT id, denumire FROM produse WHERE LOWER(TRIM(cod)) = LOWER(?) OR LOWER(TRIM(cod_generat)) = LOWER(?) LIMIT 2")
        .all(text, text)
        .catch(() => []);
  if (dupaCod.length === 1) return { produs_id: Number(dupaCod[0].id), text: null, nume: dupaCod[0].denumire };
  return { produs_id: null, text, nume: text };
}

// Materia primă scrisă pe comanda de producție: { produs_id, nume, cod }.
async function materiaComenzii(cp) {
  const id = nr(cp && cp.materie_produs_id);
  if (id) {
    const p = await db
      .prepare("SELECT id, denumire, COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod FROM produse WHERE id = ?")
      .get(id)
      .catch(() => null);
    return { produs_id: id, nume: (p && p.denumire) || "produs #" + id, cod: (p && p.cod) || "" };
  }
  return { produs_id: null, nume: String((cp && cp.materie_text) || "").trim(), cod: "" };
}

// Numele furnizorului ales pe comanda de producție (sau „").
async function furnizorulComenzii(cp) {
  if (nr(cp && cp.furnizor_id)) {
    const f = await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(nr(cp.furnizor_id)).catch(() => null);
    return (f && f.nume) || "furnizor #" + nr(cp.furnizor_id);
  }
  return String((cp && cp.furnizor_text) || "").trim();
}

// Scrie materia primă pe comandă. Întoarce { gasita, furnizorPus }.
async function seteazaMaterie(cpId, ales, user) {
  const cp = await db.prepare("SELECT * FROM comenzi_productie WHERE id = ?").get(nr(cpId));
  if (!cp) return { gasita: false };
  const pid = ales && !ales.gol ? ales.produs_id || null : null;
  const text = ales && !ales.gol && !pid ? ales.text || null : null;
  const cine = (user && (user.nume || user.email)) || null;
  const cand = new Date().toISOString().slice(0, 16).replace("T", " ");
  await db
    .prepare("UPDATE comenzi_productie SET materie_produs_id = ?, materie_text = ?, materie_aleasa_la = ?, materie_aleasa_de = ? WHERE id = ?")
    .run(pid, text, pid || text ? cand : null, pid || text ? cine : null, cp.id);

  // Furnizorul vine singur doar când nu e nimic de ales: comanda n-are încă
  // furnizor, iar materia e pe stoc de la unul singur, fără paleți nescriși.
  let furnizorPus = "";
  if (pid && !nr(cp.furnizor_id) && !String(cp.furnizor_text || "").trim()) {
    const s = FL.optiuniDinStoc(await stocPeFurnizori(pid));
    const stiuti = s.optiuni.filter((o) => o.cheie !== "n");
    if (stiuti.length === 1 && !s.nescris) {
      const a = FL.citesteAlegerea(stiuti[0].cheie);
      if (a) {
        await seteazaLaProductie(cp.id, { furnizor_id: a.furnizor_id, furnizor_text: a.furnizor_text, nume: stiuti[0].nume }, user);
        furnizorPus = stiuti[0].nume;
      }
    }
  }
  return { gasita: true, furnizorPus };
}

// Caseta „Furnizorul materialului" — pe pagina comenzii de producție și pe
// necesarul de materie primă, același formular.
async function casetaProductie(cp, { inapoi, poateScrie } = {}) {
  const ales = nr(cp.furnizor_id)
    ? await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(nr(cp.furnizor_id)).catch(() => null)
    : null;
  const numeAles = nr(cp.furnizor_id) ? (ales && ales.nume) || "furnizor #" + nr(cp.furnizor_id) : String(cp.furnizor_text || "").trim();
  const linii = await liniileClientului(cp);
  const asteapta = linii.filter((l) => !areFurnizor(l));
  const sugestii = poateScrie ? await sugestiiProductie(cp) : [];
  const furnizori = poateScrie
    ? await db
        .prepare("SELECT nume FROM parteneri WHERE tip IN ('furnizor','ambele') AND COALESCE(TRIM(nume), '') <> '' ORDER BY nume LIMIT 3000")
        .all()
        .catch(() => [])
    : [];
  const ret = esc(inapoi || `/productie/${cp.id}`);
  const cant = (o) => `${Number(o.cantitate).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${o.um ? " " + esc(o.um) : ""}`;

  // Materia primă (10.11.2026), în aceeași casetă: se alege tot de aici.
  const materie = await materiaComenzii(cp);
  const stocMaterie = materie.produs_id ? await stoculMateriei(materie.produs_id) : null;
  const dinReteta = poateScrie ? (await materiiDinReteta(cp)).filter((m) => nr(m.produs_id) !== nr(materie.produs_id)) : [];
  const peStoc = poateScrie ? await materiiPeStoc() : [];
  const blocMaterie = `
      <div class="caseta-materie">
        <h2 style="font-size:15px;margin:0 0 6px">Materia primă</h2>
        ${
          materie.nume
            ? `<p style="margin:0 0 4px"><strong>${
                materie.produs_id ? `<a href="/produse/${materie.produs_id}">${esc(materie.nume)}</a>` : esc(materie.nume)
              }</strong>${materie.cod ? ` <span class="mic">· ${esc(materie.cod)}</span>` : ""}${
                cp.materie_aleasa_de || cp.materie_aleasa_la
                  ? ` <span class="mic">· aleasă${cp.materie_aleasa_de ? " de " + esc(cp.materie_aleasa_de) : ""}${cp.materie_aleasa_la ? " la " + esc(cp.materie_aleasa_la) : ""}</span>`
                  : ""
              }</p>
               <p class="mic" style="margin:0 0 8px">${
                 !materie.produs_id
                   ? "Scrisă ca text: nu e un produs din catalog, deci nu i se vede stocul."
                   : stocMaterie.cantitate > 0
                     ? `Pe stoc în CT-Park: ${esc(cantText(stocMaterie.cantitate, stocMaterie.um))} pe ${stocMaterie.paleti} ${stocMaterie.paleti === 1 ? "palet" : "paleți"}${
                         stocMaterie.furnizori ? ` (${esc(stocMaterie.furnizori)})` : ""
                       }.`
                     : "Nu e pe stoc în CT-Park acum."
               }</p>`
            : `<p class="mic" style="margin:0 0 8px">Nealeasă. O alegi de aici: din ce e pe stoc în CT-Park sau din orice produs din catalog.</p>`
        }
        ${
          poateScrie
            ? `${
                dinReteta.length
                  ? `<div class="materie-sugestii" style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px">
                       <span class="mic" style="align-self:center">Din rețetă, pe stoc:</span>
                       ${dinReteta
                         .map(
                           (m) => `<form method="post" action="/productie/${cp.id}/materie" class="inline-form">
                             <input type="hidden" name="inapoi" value="${ret}">
                             <input type="hidden" name="materie_produs_id" value="${nr(m.produs_id)}">
                             <button class="btn small secondary" type="submit">${esc(m.denumire)} <span class="mic">· ${esc(cantText(m.cantitate, m.um))}</span></button>
                           </form>`
                         )
                         .join("")}
                     </div>`
                  : ""
              }
              <form method="post" action="/productie/${cp.id}/materie" class="inline-form" style="gap:6px;flex-wrap:wrap">
                <input type="hidden" name="inapoi" value="${ret}">
                <input name="materie" list="materii-productie-${cp.id}" value="${esc(materie.nume)}" placeholder="caută materia primă…"
                       autocomplete="off" style="min-width:320px" aria-label="Materia primă">
                <datalist id="materii-productie-${cp.id}">${peStoc
                  .map(
                    (m) =>
                      `<option value="${esc(m.denumire)}" label="${esc(
                        `${cantText(m.cantitate, m.um)} pe stoc${m.furnizori ? " · " + m.furnizori : ""}${m.cod ? " · " + m.cod : ""}`
                      )}">`
                  )
                  .join("")}</datalist>
                <button class="btn small" type="submit">${materie.nume ? "Schimbă materia primă" : "Salvează materia primă"}</button>
              </form>
              <p class="mic" style="margin:6px 0 0">În listă e materia primă de pe stocul CT-Park, cu cât e și de la cine. Poți scrie și alt produs din catalog (denumirea sau codul); ce nu e în catalog rămâne text. Dacă e pe stoc de la un singur furnizor, se completează și furnizorul. Gol și salvat = fără materie primă.</p>`
            : ""
        }
      </div>`;
  return `
    <div class="detail-box caseta-furnizor" style="margin-top:12px">
      ${blocMaterie}
      <h2 style="font-size:15px;margin:14px 0 6px">Furnizorul materialului</h2>
      ${
        numeAles
          ? `<p style="margin:0 0 8px"><strong>${esc(numeAles)}</strong>${
              cp.furnizor_ales_de || cp.furnizor_ales_la
                ? ` <span class="mic">· ales${cp.furnizor_ales_de ? " de " + esc(cp.furnizor_ales_de) : ""}${cp.furnizor_ales_la ? " la " + esc(cp.furnizor_ales_la) : ""}</span>`
                : ""
            }</p>`
          : `<p class="mic" style="margin:0 0 8px">Încă neales. Îl alegi când aloci materialul: ajunge pe comanda clientului și pe paleții care ies din producția asta.</p>`
      }
      ${
        asteapta.length
          ? `<p class="mic" style="margin:0 0 8px;color:var(--warn,#b45309)">Comanda clientului așteaptă furnizorul pe ${asteapta
              .map((l) => `„${esc(l.denumire || "")}"`)
              .join(", ")}.</p>`
          : ""
      }
      ${
        poateScrie
          ? `${
              sugestii.length
                ? `<div class="furnizor-sugestii" style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px">
                     <span class="mic" style="align-self:center">Pe stoc, în materialele rețetei:</span>
                     ${sugestii
                       .map(
                         (o) => `<form method="post" action="/productie/${cp.id}/furnizor" class="inline-form">
                           <input type="hidden" name="inapoi" value="${ret}">
                           ${o.cheie.startsWith("p:") ? `<input type="hidden" name="furnizor_id" value="${esc(o.cheie.slice(2))}">` : ""}
                           <input type="hidden" name="furnizor" value="${esc(o.nume)}">
                           <button class="btn small secondary" type="submit">${esc(o.nume)} <span class="mic">· ${cant(o)}</span></button>
                         </form>`
                       )
                       .join("")}
                   </div>`
                : ""
            }
            <form method="post" action="/productie/${cp.id}/furnizor" class="inline-form" style="gap:6px;flex-wrap:wrap">
              <input type="hidden" name="inapoi" value="${ret}">
              <input name="furnizor" list="furnizori-productie-${cp.id}" value="${esc(numeAles)}" placeholder="caută furnizorul…"
                     autocomplete="off" style="min-width:260px" aria-label="Furnizorul materialului">
              <datalist id="furnizori-productie-${cp.id}">${furnizori.map((f) => `<option value="${esc(f.nume)}">`).join("")}</datalist>
              <button class="btn small" type="submit">${numeAles ? "Schimbă furnizorul" : "Salvează furnizorul"}</button>
            </form>
            <p class="mic" style="margin:6px 0 0">Gol și salvat = fără furnizor. Un nume care nu e în Parteneri rămâne scris ca text.</p>`
          : ""
      }
    </div>`;
}

// Rândul „furnizor: …" de sub produs — pe comanda clientului și în depozit,
// unde spune de pe ce paleți se scoate. `cere_furnizor` vine din interogare:
// la produsele fără caracteristica „Furnizor" nu se scrie nimic dacă n-are.
function randFurnizor(l) {
  if (!l) return "";
  const nume = FL.eticheta(l, l.furnizor_nume);
  if (nume) {
    const s = FL.sursa(l.furnizor_sursa);
    return `<div class="mic furnizor-pe-linie" style="margin-top:2px">furnizor: <b>${esc(nume)}</b>${
      s ? ` <span style="color:var(--text-muted)">· ${esc(s)}</span>` : ""
    }</div>`;
  }
  if (Number(l.cere_furnizor) === 1) {
    return `<div class="mic furnizor-pe-linie" style="margin-top:2px;color:var(--text-muted)">furnizor: încă neales — se alege în producție, la alocarea materialului</div>`;
  }
  return "";
}

// ---- Recepția ---------------------------------------------------------------

// De la cine e marfa dintr-o recepție: furnizorul ei, sau — la cea venită din
// producție — furnizorul ales acolo pentru material.
async function furnizorReceptiei(r) {
  if (!r) return { furnizor_id: null, furnizor_text: null, nume: "" };
  if (String(r.sursa || "") === "furnizor" && nr(r.partener_id)) {
    const p = await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(nr(r.partener_id)).catch(() => null);
    return { furnizor_id: nr(r.partener_id), furnizor_text: null, nume: (p && p.nume) || "" };
  }
  if (nr(r.comanda_productie_id)) {
    const cp = await db
      .prepare(
        `SELECT cp.furnizor_id, cp.furnizor_text, f.nume FROM comenzi_productie cp
           LEFT JOIN parteneri f ON f.id = cp.furnizor_id WHERE cp.id = ?`
      )
      .get(nr(r.comanda_productie_id))
      .catch(() => null);
    if (cp && (nr(cp.furnizor_id) || String(cp.furnizor_text || "").trim())) {
      return {
        furnizor_id: nr(cp.furnizor_id) || null,
        furnizor_text: nr(cp.furnizor_id) ? null : String(cp.furnizor_text).trim(),
        nume: cp.nume || String(cp.furnizor_text || "").trim(),
      };
    }
  }
  return { furnizor_id: null, furnizor_text: null, nume: "" };
}

module.exports = {
  conditieFurnizor,
  relevant,
  stocPeFurnizori,
  pentruProdus,
  verificaLinii,
  rezolvaFurnizor,
  produseleProductiei,
  liniileClientului,
  seteazaLaProductie,
  sugestiiProductie,
  CATEGORII_MATERIE,
  materiiPeStoc,
  materiiDinReteta,
  rezolvaMaterie,
  materiaComenzii,
  furnizorulComenzii,
  seteazaMaterie,
  casetaProductie,
  randFurnizor,
  furnizorReceptiei,
};
