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
async function sugestiiProductie(cp) {
  const ids = await produseleProductiei(cp);
  if (!ids.length) return [];
  const r = await db
    .prepare(
      `SELECT p.furnizor_id, f.nume AS furnizor_nume, p.furnizor_text,
              SUM(pl.cantitate) AS cantitate, MAX(pl.um) AS um, COUNT(DISTINCT p.id) AS paleti
         FROM retete_componente rc
         JOIN ct_palet_linii pl ON pl.produs_id = rc.componenta_id
         JOIN ct_paleti p ON p.id = pl.palet_id
         LEFT JOIN parteneri f ON f.id = p.furnizor_id
        WHERE rc.produs_id IN (${ids.map(() => "?").join(",")})
          AND p.data_iesire IS NULL AND pl.cantitate > 0
        GROUP BY p.furnizor_id, f.nume, p.furnizor_text`
    )
    .all(...ids)
    .catch(() => []);
  return FL.optiuniDinStoc(r).optiuni.filter((o) => o.cheie !== "n");
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
  return `
    <div class="detail-box caseta-furnizor" style="margin-top:12px">
      <h2 style="font-size:15px;margin:0 0 6px">Furnizorul materialului</h2>
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
  casetaProductie,
  randFurnizor,
  furnizorReceptiei,
};
