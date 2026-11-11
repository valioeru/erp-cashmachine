"use strict";
// Scanerul din CT-Park: intrarea și ieșirea mărfii cu terminalul în mână.
//
// CE A CERUT VALI, 10.11.2026:
//   „Vreau când iese marfa din producție, cu cod pe ea, să o scaneze cineva,
//    să scaneze codul raftului și să dea OK, și să se înregistreze automat
//    marfa ca a intrat în depozit CT-Park pe raftul, locul X (sau locurile
//    X). La fel și la ieșire."
//   „Două butoane pe display, intrare/ieșire marfă, cu opțiune de unde vine:
//    din producție, de la terț etc. La intrare se scanează marfa, locul pe
//    raft, se apasă Efectuează și se realizează mutarea."
//   „Iar la recepție marfă să te asiguri că se generează etichete pentru
//    fiecare palet — se lipește pe palet, apoi se scanează și se pun pe
//    rafturi."
//   „La pune pe raft poți să și alegi locul: se sugerează inițial unul unde
//    sunt produse din categorii similare, sau poți alege tu unul, sau poți
//    scana direct un loc."
//
// CUM MERGE:
//   1. La recepție (sau din „Gata din producție") marfa se împarte pe paleți:
//      fiecare palet se face în CT-Park FĂRĂ loc, cu codul lui (CT…), și i se
//      tipărește eticheta. Eticheta se lipește pe palet.
//   2. Intrare: scanezi eticheta paletului, scanezi locul (sau locurile, la
//      paletul lat), Efectuează. Paletul fără loc primește locul; paletul care
//      avea deja loc se MUTĂ — aceeași regulă ca la „Mută marfă"
//      (lib/ct-mutare.js): locuri libere, lipite, câte ține paletul.
//      Marfa fără etichetă (încă nepusă pe paleți) se poate alege din listă și
//      pune direct: se face paletul pe locul scanat.
//   3. Ieșire: scanezi paletul (sau locul pe care stă), alegi unde pleacă și
//      cât; restul e ieșirea obișnuită din CT-Park (modules/ct-park.js,
//      iesireIntreaga / iesirePartiala), cu avizul la comanda clientului.
//
// Aici sunt datele și regulile; paginile sunt în modules/ct-scaner.js.

const db = require("./db");
const GP = require("./gata-productie");
const CTM = require("./ct-mutare");
const { curataScanat } = require("./scan");

const nr = (v) => Number(v) || 0;
const rotunjit = (v) => Math.round(nr(v) * 1000) / 1000;
const EPS = GP.EPS;

// Adresa unui loc, cum o scrie modules/ct-park.js (adresaLoc): R<rând>-<câmp
// pe două cifre>-<nivel>-<poziție>. Ea e și codul de bare de pe raft.
const RE_LOC = /^R\d{1,3}-\d{2,3}-\d{1,2}-\d{1,2}$/;
const RE_PALET = /^CT\d{6}-\d{1,9}$/;

function curat(cod) {
  return curataScanat(cod).toUpperCase();
}
const eLoc = (cod) => RE_LOC.test(curat(cod));
const ePalet = (cod) => RE_PALET.test(curat(cod));

// De unde vine marfa: cele trei butoane de la intrare. „retur" adună returul
// de la client și pe cel din fulfillment; „toate" nu filtrează.
const SURSE = [
  ["productie", "Din producție"],
  ["furnizor", "De la furnizor"],
  ["retur", "Retururi"],
  ["toate", "Toate"],
];
function sursaPotrivita(sursa, filtru) {
  const f = String(filtru || "toate");
  if (f === "toate") return true;
  if (f === "retur") return /^retur/.test(String(sursa || ""));
  if (f === "furnizor") return sursa === "furnizor" || sursa === "inventar_initial";
  return String(sursa || "") === f;
}

// ---- Locurile ---------------------------------------------------------------
const SELECT_LOC = `SELECT l.id, l.rand_id, l.nivel, l.camp, l.pozitie, l.adresa, l.categorie, l.blocat,
         r.numar AS rand_numar, r.eticheta AS rand_eticheta, r.activ AS rand_activ,
         (SELECT o.palet_id FROM ct_ocupari o JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
           WHERE o.loc_id = l.id LIMIT 1) AS ocupat_de
    FROM ct_locuri l JOIN ct_randuri r ON r.id = l.rand_id`;

async function locDupaAdresa(cod) {
  const a = curat(cod);
  if (!a) return null;
  return db.prepare(`${SELECT_LOC} WHERE UPPER(l.adresa) = ?`).get(a).catch(() => null);
}

async function locuriDupaId(ids) {
  const curate = [...new Set((ids || []).map((x) => Math.round(nr(x))).filter((x) => x > 0))];
  if (!curate.length) return [];
  return db
    .prepare(`${SELECT_LOC} WHERE l.id IN (${curate.map(() => "?").join(",")})`)
    .all(...curate)
    .catch(() => []);
}

// ---- Paleții ----------------------------------------------------------------
// Paletul cu tot ce trebuie arătat pe terminal: marfa, de unde vine, unde stă,
// unde e plănuit să plece.
async function palet(id) {
  const p = await db
    .prepare(
      `SELECT p.*, COALESCE(pr.denumire, NULLIF(p.produs_text, ''), 'marfă') AS denumire,
              COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS produs_cod, pr.categorie AS produs_categorie,
              pr.cod_familie_id,
              rc.sursa AS receptie_sursa, rc.numar AS receptie_numar,
              a.sursa AS cerere_sursa,
              co.numar AS iesire_comanda_numar, pa.nume AS iesire_client
         FROM ct_paleti p
         LEFT JOIN produse pr ON pr.id = p.produs_id
         LEFT JOIN receptii rc ON rc.id = p.receptie_id
         LEFT JOIN aprovizionari a ON a.id = p.aprovizionare_id
         LEFT JOIN comenzi co ON co.id = p.iesire_comanda_id
         LEFT JOIN parteneri pa ON pa.id = co.partener_id
        WHERE p.id = ?`
    )
    .get(Math.round(nr(id)))
    .catch(() => null);
  if (!p) return null;
  const locuri = await db
    .prepare(
      `SELECT l.id, l.adresa, l.rand_id, l.nivel, l.camp, l.pozitie FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id
        WHERE o.palet_id = ? ORDER BY l.camp, l.pozitie`
    )
    .all(p.id)
    .catch(() => []);
  const linii = await db
    .prepare(
      `SELECT pl.id, pl.produs_id, pl.cantitate, pl.um, pl.lot, COALESCE(NULLIF(pl.produs_text, ''), pr.denumire) AS produs_text
         FROM ct_palet_linii pl LEFT JOIN produse pr ON pr.id = pl.produs_id
        WHERE pl.palet_id = ? AND pl.cantitate > 0 ORDER BY pl.id`
    )
    .all(p.id)
    .catch(() => []);
  return Object.assign(p, { locuri, linii, sursa: sursaPalet(p) });
}

function sursaPalet(p) {
  if (p.receptie_sursa) return p.receptie_sursa;
  if (p.cerere_sursa) return p.cerere_sursa === "productie" ? "productie" : "furnizor";
  return "alta";
}

async function paletDupaCod(cod) {
  const c = curat(cod);
  if (!c) return null;
  const r = await db.prepare("SELECT id FROM ct_paleti WHERE UPPER(cod) = ? ORDER BY id DESC LIMIT 1").get(c).catch(() => null);
  return r ? palet(r.id) : null;
}

// Paleții fără loc, care așteaptă raftul: făcuți la recepție, cu eticheta
// lipită. Nu și cei pregătiți pentru o ieșire directă (au iesire_plan): ei
// așteaptă camionul, nu raftul.
async function faraLoc(filtru) {
  const randuri = await db
    .prepare(
      `SELECT p.id, p.cod, p.cantitate, p.um, p.lot, p.data_intrare, p.receptie_id, p.aprovizionare_id, p.produs_id,
              COALESCE(pr.denumire, NULLIF(p.produs_text, ''), 'marfă') AS denumire,
              COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS produs_cod,
              rc.sursa AS receptie_sursa, rc.numar AS receptie_numar, a.sursa AS cerere_sursa,
              COALESCE(rc.comanda_productie_id, (SELECT MIN(cp.id) FROM comenzi_productie cp WHERE cp.aprovizionare_id = a.id)) AS productie_id,
              COALESCE(rc.comanda_id, a.comanda_id) AS comanda_id
         FROM ct_paleti p
         LEFT JOIN produse pr ON pr.id = p.produs_id
         LEFT JOIN receptii rc ON rc.id = p.receptie_id
         LEFT JOIN aprovizionari a ON a.id = p.aprovizionare_id
        WHERE p.data_iesire IS NULL AND p.iesire_plan IS NULL
          AND NOT EXISTS (SELECT 1 FROM ct_ocupari o WHERE o.palet_id = p.id)
        ORDER BY p.data_intrare, p.id`
    )
    .all()
    .catch(() => []);
  return randuri.map((p) => Object.assign(p, { sursa: sursaPalet(p) })).filter((p) => sursaPotrivita(p.sursa, filtru));
}

// ---- Marfa încă nepusă pe paleți ------------------------------------------
// Recepțiile numărate de la furnizori (și retururile), cu ce n-a primit încă
// palet. Recepțiile din producție și cererile sunt deja în „Gata din
// producție" (lib/gata-productie.js) — se iau de acolo, ca regula să fie una.
async function receptiiNumarate() {
  // Regula e în lib/gata-productie.js (receptiiFurnizori), aceeași pe care o
  // folosește lista de sus din Intrare marfă.
  return (await GP.receptiiFurnizori().catch(() => [])).map((l) => ({
    fel: "receptie",
    cheie: l.cheie,
    id: l.id,
    receptie_id: l.receptie_id,
    receptie_numar: l.receptie_numar,
    sursa: l.sursa,
    produs_id: l.produs_id,
    denumire: l.denumire,
    cod: l.cod,
    um: l.um,
    ramas: l.ramas,
    detaliu: `recepția ${l.receptie_numar}${l.partener ? " · " + l.partener : ""}`,
    data: l.data,
  }));
}

async function deAsezat(filtru) {
  const dinProductie = (await GP.receptii().catch(() => [])).map((r) =>
    Object.assign({}, r, {
      sursa: "productie",
      detaliu: [
        r.productie_numar ? "producția " + r.productie_numar : "",
        r.comanda_numar ? "comanda " + r.comanda_numar : "",
        r.client || "",
        r.numarata ? "" : "nenumărată",
      ]
        .filter(Boolean)
        .join(" · "),
    })
  );
  const cereri = (await GP.cereri().catch(() => [])).map((c) =>
    Object.assign({}, c, {
      sursa: c.sursa === "productie" ? "productie" : "furnizor",
      detaliu: [`cererea #${c.id}`, c.comanda_numar ? "comanda " + c.comanda_numar : "", c.client || c.furnizor || "", c.stare].filter(Boolean).join(" · "),
    })
  );
  const furnizori = await receptiiNumarate();
  return dinProductie.concat(furnizori, cereri).filter((r) => sursaPotrivita(r.sursa, filtru));
}

async function randDeAsezat(cheie) {
  const k = String(cheie || "");
  if (!/^[rc]\d+$/.test(k)) return null;
  return (await deAsezat("toate")).find((r) => r.cheie === k) || null;
}

// Ce se potrivește cu un cod scanat la intrare, dintre rândurile încă
// nepuse pe paleți: fișa de lot a producției (CM-…), codul produsului,
// comanda clientului (CMD-… sau numărul ei), numărul recepției.
function potrivesteRand(r, cod, forme) {
  const c = curat(cod);
  if (!c) return false;
  for (const f of forme) {
    if (f.fel === "productie" && r.productie_id && Number(r.productie_id) === Number(f.id)) return true;
    if (f.fel === "comanda" && r.comanda_id && Number(r.comanda_id) === Number(f.id)) return true;
    if (f.fel === "produs_id" && r.produs_id && Number(r.produs_id) === Number(f.id)) return true;
  }
  return (
    (r.cod && String(r.cod).toUpperCase() === c) ||
    (r.comanda_numar && String(r.comanda_numar).toUpperCase() === c) ||
    (r.productie_numar && String(r.productie_numar).toUpperCase() === c) ||
    (r.receptie_numar && String(r.receptie_numar).toUpperCase() === c)
  );
}

// La fel pentru paleții făcuți deja (cu etichetă, fără loc): cine scanează
// fișa de lot sau codul produsului în loc de eticheta paletului îi găsește.
function potrivestePalet(p, cod, forme) {
  const c = curat(cod);
  if (!c) return false;
  for (const f of forme) {
    if (f.fel === "productie" && p.productie_id && Number(p.productie_id) === Number(f.id)) return true;
    if (f.fel === "comanda" && p.comanda_id && Number(p.comanda_id) === Number(f.id)) return true;
    if (f.fel === "produs_id" && p.produs_id && Number(p.produs_id) === Number(f.id)) return true;
  }
  return (
    (p.produs_cod && String(p.produs_cod).toUpperCase() === c) ||
    (p.lot && String(p.lot).toUpperCase() === c) ||
    (p.receptie_numar && String(p.receptie_numar).toUpperCase() === c)
  );
}

// ---- Locul propus -------------------------------------------------------------
// Vali: „se sugerează inițial unul unde sunt produse din categorii similare".
// Pe rând, cât de aproape e marfa înrudită: întâi lângă același produs (în
// același câmp, apoi pe același rând), apoi lângă produse din aceeași familie
// sau categorie, apoi în zona marcată pentru categoria paletului (produse
// finite, materie primă…). La egalitate: nivelul de jos întâi — se pune și
// se scoate fără stivuitor înalt —, apoi în ordinea rândurilor.
async function propuneLocuri(t, cate, limita) {
  const n = Math.max(1, Math.min(CTM.LATIME_MAX, Math.round(nr(cate)) || 1));
  const toate = await db.prepare(`${SELECT_LOC} WHERE r.activ = 1`).all().catch(() => []);
  const ocupate = await db
    .prepare(
      `SELECT l.rand_id, l.camp, p.produs_id, p.categorie, pr.categorie AS produs_categorie, pr.cod_familie_id
         FROM ct_ocupari o
         JOIN ct_paleti p ON p.id = o.palet_id AND p.data_iesire IS NULL
         JOIN ct_locuri l ON l.id = o.loc_id
         LEFT JOIN produse pr ON pr.id = p.produs_id`
    )
    .all()
    .catch(() => []);
  const ce = {
    produs: nr(t && t.produs_id),
    familie: nr(t && t.cod_familie_id),
    categorieProdus: String((t && t.produs_categorie) || "").trim().toLowerCase(),
    categorie: String((t && t.categorie) || "").trim(),
  };
  const peCamp = new Map();
  const peRand = new Map();
  const adauga = (h, k, o) => {
    if (!h.has(k)) h.set(k, { produse: new Set(), familii: new Set(), catProdus: new Set(), categorii: new Set() });
    const x = h.get(k);
    if (nr(o.produs_id)) x.produse.add(nr(o.produs_id));
    if (nr(o.cod_familie_id)) x.familii.add(nr(o.cod_familie_id));
    if (o.produs_categorie) x.catProdus.add(String(o.produs_categorie).trim().toLowerCase());
    if (o.categorie) x.categorii.add(String(o.categorie));
  };
  for (const o of ocupate) {
    adauga(peCamp, `${o.rand_id}|${o.camp}`, o);
    adauga(peRand, String(o.rand_id), o);
  }
  const inrudit = (x) => {
    if (!x) return null;
    if (ce.produs && x.produse.has(ce.produs)) return "produs";
    if ((ce.familie && x.familii.has(ce.familie)) || (ce.categorieProdus && x.catProdus.has(ce.categorieProdus))) return "familie";
    if (ce.categorie && x.categorii.has(ce.categorie)) return "categorie";
    return null;
  };
  const libere = toate.filter((l) => !nr(l.blocat) && !l.ocupat_de);
  const grupuri = n === 1 ? libere.map((l) => [l]) : CTM.undeIncape(libere, n);
  const PUNCTE = { produs: 0, familie: 1, categorie: 2 };
  const evaluate = grupuri.map((g) => {
    const l = g[0];
    const inCamp = inrudit(peCamp.get(`${l.rand_id}|${l.camp}`));
    const peRandul = inrudit(peRand.get(String(l.rand_id)));
    const zona = ce.categorie && l.categorie === ce.categorie ? 0 : l.categorie ? 2 : 1;
    const randEt = ce.categorie && l.rand_eticheta === ce.categorie ? 0 : 1;
    const scor =
      (inCamp ? PUNCTE[inCamp] : peRandul ? 3 + PUNCTE[peRandul] : 6) * 1000 + zona * 100 + randEt * 50 + nr(l.nivel) * 5;
    let motiv;
    if (inCamp === "produs") motiv = "lângă același produs";
    else if (inCamp === "familie") motiv = "lângă produse din aceeași familie";
    else if (inCamp === "categorie") motiv = `lângă alte ${ce.categorie}`;
    else if (peRandul === "produs") motiv = "pe rândul cu același produs";
    else if (peRandul === "familie") motiv = "pe rândul cu produse din aceeași familie";
    else if (peRandul === "categorie") motiv = `pe rândul cu alte ${ce.categorie}`;
    else if (zona === 0 || randEt === 0) motiv = `în zona de ${ce.categorie}`;
    else motiv = nr(l.nivel) === 1 ? "loc liber, la nivelul de jos" : "loc liber";
    return { locuri: g, adresa: g.map((x) => x.adresa).join(" + "), ids: g.map((x) => Number(x.id)), motiv, scor };
  });
  evaluate.sort(
    (a, b) =>
      a.scor - b.scor ||
      nr(a.locuri[0].rand_numar) - nr(b.locuri[0].rand_numar) ||
      nr(a.locuri[0].camp) - nr(b.locuri[0].camp) ||
      nr(a.locuri[0].pozitie) - nr(b.locuri[0].pozitie)
  );
  return evaluate.slice(0, Math.max(1, nr(limita) || 8));
}

// ---- Pune paletul pe loc (sau mută-l) -----------------------------------------
// Paletul fără loc: locurile scanate trebuie să existe, să fie libere, în uz și
// lipite (paletul lat stă pe poziții una lângă alta, în același câmp și nivel).
// Paletul care are loc: e o mutare, cu regula de la „Mută marfă".
async function pune(user, paletId, locIds) {
  const p = await palet(paletId);
  if (!p) return { eroare: "Paletul nu există." };
  if (p.data_iesire) return { eroare: `Paletul ${p.cod} a ieșit din depozit pe ${String(p.data_iesire).slice(0, 10)}.` };
  const ids = [...new Set((locIds || []).map((x) => Math.round(nr(x))).filter((x) => x > 0))];
  if (!ids.length) return { eroare: "Scanează locul de pe raft (sau alege-l din listă)." };
  const tinta = await locuriDupaId(ids);
  if (tinta.length !== ids.length) return { eroare: "Unul dintre locuri nu mai există." };
  const inactive = tinta.filter((l) => !nr(l.rand_activ));
  if (inactive.length) return { eroare: `${inactive.map((l) => l.adresa).join(", ")} e pe un rând scos din uz.` };
  const nume = `${p.cod} (${p.denumire})`;

  if (p.locuri.length) {
    const v = CTM.validareMutare({ id: p.id, cod: p.cod, nume }, p.locuri, tinta);
    if (!v.ok) return { eroare: v.motiv };
    await db.prepare("DELETE FROM ct_ocupari WHERE palet_id = ?").run(p.id);
    for (const l of v.locuri) await db.prepare("INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (?, ?)").run(p.id, l.id);
    console.log(`[ct-scaner] ${p.cod} mutat de pe ${v.de_la} pe ${v.unde} de ${(user && user.nume) || "?"}`);
    return { ok: true, mutare: true, palet: p, de_la: v.de_la, unde: v.unde };
  }

  if (tinta.length > CTM.LATIME_MAX) return { eroare: `Un palet ține cel mult ${CTM.LATIME_MAX} locuri; ai scanat ${tinta.length}.` };
  const blocate = tinta.filter((l) => nr(l.blocat));
  if (blocate.length) return { eroare: `${blocate.map((l) => l.adresa).join(", ")} e scos din uz.` };
  const ocupate = tinta.filter((l) => l.ocupat_de && Number(l.ocupat_de) !== Number(p.id));
  if (ocupate.length) return { eroare: `Pe ${ocupate.map((l) => l.adresa).join(", ")} stă deja altă marfă. Alege alt loc.` };
  const grupuri = CTM.grupeazaLipite(tinta);
  if (grupuri.length > 1) {
    return {
      eroare: `Locurile nu sunt lipite: ${grupuri.map((g) => g.map((l) => l.adresa).join(", ")).join(" / ")}. Un palet lat stă pe poziții una lângă alta, în același câmp și nivel.`,
    };
  }
  for (const l of grupuri[0]) await db.prepare("INSERT INTO ct_ocupari (palet_id, loc_id) VALUES (?, ?)").run(p.id, l.id);
  const unde = grupuri[0].map((l) => l.adresa).join(" + ");
  console.log(`[ct-scaner] ${p.cod} pus pe ${unde} de ${(user && user.nume) || "?"}`);
  return { ok: true, mutare: false, palet: p, unde };
}

// ---- Paleții făcuți dintr-un rând (recepție sau cerere) ---------------------
// `cantitati` — câte un număr pe palet. Fără `locIds` paleții se fac fără loc
// (cu eticheta, de pus pe raft prin scanare); cu `locIds` se face un singur
// palet, pus direct acolo.
//
// SUMA POATE TRECE DE CE MAI E DE PUS. Vali, 10.11.2026: „Cantitatea
// recepționată poate fi mai mare decât cea din comandă și se salvează
// cantitatea din recepție." Până atunci scanerul refuza („ai împărțit 6.000,
// dar mai sunt de pus doar 4.000"), deci ultimul palet al unei comenzi din
// care producția făcuse mai mult nu putea intra cu cât avea pe el.
// Acum intră, dar nu dintr-o greșeală de tastare: prima oară se întoarce cu
// întrebarea (`peste`), iar paleții se fac când cererea vine confirmată —
// `opt.confirmaPeste` egal cu suma scrisă (scanerul: a doua apăsare) sau
// `opt.peste` (formularele cu bifă). Recepția ia apoi cantitatea de pe paleți
// (modules/receptie.js, aliniazaLaPaleti).
async function faPaleti(user, cheie, cantitati, locIds, opt) {
  const k = String(cheie || "");
  const qs = (cantitati || []).map((x) => rotunjit(x));
  if (!qs.length || qs.some((q) => !(q > EPS))) return { eroare: "Scrie cantitatea de pe fiecare palet (numere mai mari ca zero)." };
  if (qs.length > 60) return { eroare: "Cel mult 60 de paleți odată." };
  const locuri = [...new Set((locIds || []).map((x) => Math.round(nr(x))).filter((x) => x > 0))];
  if (locuri.length && qs.length > 1) return { eroare: "Pe locurile scanate se pune un singur palet." };

  // Locurile, verificate înainte să se facă paletul — altfel ar rămâne un
  // palet fără loc dintr-o scanare greșită.
  if (locuri.length) {
    const tinta = await locuriDupaId(locuri);
    if (tinta.length !== locuri.length) return { eroare: "Unul dintre locuri nu mai există." };
    const rele = tinta.filter((l) => nr(l.blocat) || !nr(l.rand_activ));
    if (rele.length) return { eroare: `${rele.map((l) => l.adresa).join(", ")} e scos din uz.` };
    const ocupate = tinta.filter((l) => l.ocupat_de);
    if (ocupate.length) return { eroare: `Pe ${ocupate.map((l) => l.adresa).join(", ")} stă deja altă marfă. Alege alt loc.` };
    if (tinta.length > CTM.LATIME_MAX) return { eroare: `Un palet ține cel mult ${CTM.LATIME_MAX} locuri.` };
    if (CTM.grupeazaLipite(tinta).length > 1) return { eroare: "Locurile nu sunt lipite: un palet lat stă pe poziții una lângă alta, în același câmp și nivel." };
  }

  const CT = require("../modules/ct-park");
  let marfa;
  let ramas;
  let um;
  if (/^r\d+$/.test(k)) {
    const lid = Number(k.slice(1));
    const l = await db
      .prepare("SELECT rl.id, r.id AS receptie_id, r.stare, r.sursa FROM receptii_linii rl JOIN receptii r ON r.id = rl.receptie_id WHERE rl.id = ?")
      .get(lid)
      .catch(() => null);
    if (!l) return { eroare: "Rândul de recepție nu există." };
    if (l.stare === "anulata") return { eroare: "Recepția e anulată." };
    if (l.stare !== "finalizata") {
      // Producția: se ia „cum a anunțat-o", ca la „Gata din producție".
      if (l.sursa !== "productie") return { eroare: "Recepția nu e încă numărată. Termin-o întâi, apoi fă paleții." };
      const x = await require("../modules/gata-productie").receptiaGata(lid, user);
      if (x.eroare) return { eroare: x.eroare };
    }
    const d = await CT.dinReceptie(lid);
    if (!d) return { eroare: "Rândul de recepție nu există." };
    ramas = d.ramas;
    um = d.um;
    marfa = {
      produs_id: d.produs_id || "",
      produs_text: d.produs_text || "",
      um: d.um,
      lot: d.lot,
      pret_unitar: d.pret,
      furnizor_id: d.furnizor_id || "",
      furnizor_text: d.furnizor_text || "",
      categorie: d.categorie,
      receptie_id: d.receptie_id,
      receptie_linie_id: d.linie_id,
      observatii: `Din recepția ${d.numar}`,
    };
  } else if (/^c\d+$/.test(k)) {
    const a = await GP.cerere(Number(k.slice(1)));
    if (!a) return { eroare: "Cererea nu există." };
    if (a.inchisa) return { eroare: "Cererea e scoasă din listă." };
    ramas = a.ramas;
    um = a.um;
    marfa = {
      produs_id: a.produs_id || "",
      um: a.um,
      furnizor_id: a.furnizor_id || "",
      categorie: a.categorie,
      aprovizionare_id: a.aprovizionare_id,
      observatii: `Din ${a.numar}`,
    };
  } else return { eroare: "Nu știu ce marfă e." };

  // Prețul de intrare (modules/ct-park.js, pretDeIntrare): ce a scris omul pe
  // pagină sau ce știe ERP-ul din recepție ori de pe produs. Fără el paleții
  // nu se fac — pagina se întoarce cu căsuța de preț. Înaintea întrebării de
  // mai jos, ca omul să nu confirme o cantitate și apoi să fie oprit iar.
  if (opt && opt.pret != null && String(opt.pret).trim() !== "") marfa.pret_unitar = String(opt.pret);
  // Fără denumire nu se face palet (modules/ct-park.js, areNume): un rând de
  // recepție scris fără produs și fără nume se completează întâi în recepție.
  if (!CT.areNume(marfa)) return { eroare: "Rândul n-are denumirea mărfii. Scrie-o în recepție, apoi fă paleții.", faraNume: true };
  if (!(await CT.pretInRegula(marfa))) return { eroare: CT.MESAJ_FARA_PRET, faraPret: true };

  const total = rotunjit(qs.reduce((s, q) => s + q, 0));
  if (!(ramas > EPS)) return { eroare: "Tot ce era pe rândul ăsta are deja palet." };
  const peste = rotunjit(total - ramas);
  if (peste > EPS) {
    const o = opt || {};
    // Suma scrisă e mereu peste zero, deci o confirmare lipsă (citită ca 0) nu se potrivește.
    const confirmat = o.peste === true || Math.abs(nr(o.confirmaPeste) - total) <= EPS;
    if (!confirmat) {
      const f = (v) => `${Number(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${um ? " " + um : ""}`;
      // Doar constatarea; cum se confirmă spune pagina care a întrebat
      // (scanerul: încă o apăsare; formularele: bifa).
      return {
        eroare: `Ai scris ${f(total)}, dar mai erau de pus ${f(ramas)} — cu ${f(peste)} mai mult.`,
        peste: { total, ramas, cu: peste, um: um || "", paleti: qs.length },
      };
    }
  }
  const ids = [];
  for (const q of qs) ids.push(...(await CT.puneMarfa({ user }, marfa, [locuri], q)));
  if (ids.length !== qs.length) return { eroare: "Paleții nu s-au putut face toți — verifică locurile.", ids };
  console.log(`[ct-scaner] ${ids.length} palet(i) din ${k}: ${qs.join(", ")} ${um || ""} de ${(user && user.nume) || "?"}${peste > EPS ? ` — cu ${peste} peste ce era de pus` : ""}`);
  return { ok: true, ids, ramas: Math.max(0, rotunjit(ramas - total)), peste: peste > EPS ? peste : 0, um };
}

// Ce știe ERP-ul despre prețul mărfii de pe un rând de pus pe raft („r12" e
// un rând de recepție, „c7" o cerere a depozitului). Paginile îl arată dacă
// există și cer prețul dacă nu.
async function pretRand(cheie) {
  const k = String(cheie || "");
  const CT = require("../modules/ct-park");
  if (/^r\d+$/.test(k)) {
    const l = await db.prepare("SELECT id, produs_id FROM receptii_linii WHERE id = ?").get(Number(k.slice(1))).catch(() => null);
    return l ? CT.pretStiut({ receptie_linie_id: Number(l.id), produs_id: l.produs_id }) : null;
  }
  if (/^c\d+$/.test(k)) {
    const a = await GP.cerere(Number(k.slice(1)));
    return a ? CT.pretStiut({ produs_id: a.produs_id }) : null;
  }
  return null;
}

// Cantitățile paleților, cum le scrie omul: „400, 400, 200", „400+400+200",
// „400 400 200" sau „3 x 400". Virgula zecimală românească rămâne zecimală:
// „12,5" e un singur palet de 12,5. Ce nu e număr iese NaN, ca pagina să
// spună că e greșit, nu să ghicească.
function cantitatiDinText(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s) return [];
  const m = s.match(/^(\d{1,2})\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/i);
  if (m) return Array(Math.max(1, Number(m[1]))).fill(Number(m[2].replace(",", ".")));
  let n = s.replace(/,\s+/g, ";").replace(/[+\s]+/g, ";");
  if (!n.includes(";") && (n.match(/,/g) || []).length > 1) n = n.replace(/,/g, ";");
  return n
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const v = Number(x.replace(",", "."));
      return Number.isFinite(v) ? v : NaN;
    });
}

// ---- Ieșirea: ce paleți se potrivesc cu un cod -------------------------------
// Eticheta paletului → paletul; locul de pe raft → paletul de pe el; codul
// produsului → paleții lui, cel mai vechi întâi (FIFO).
async function paletiPentruIesire(cod) {
  const c = curat(cod);
  if (!c) return { paleti: [] };
  if (RE_PALET.test(c)) {
    const p = await paletDupaCod(c);
    return { paleti: p ? [p] : [], fel: "palet" };
  }
  if (RE_LOC.test(c)) {
    const l = await locDupaAdresa(c);
    if (!l) return { paleti: [], fel: "loc", lipsaLoc: true };
    return { paleti: l.ocupat_de ? [await palet(l.ocupat_de)] : [], fel: "loc", loc: l };
  }
  const randuri = await db
    .prepare(
      `SELECT p.id FROM ct_paleti p LEFT JOIN produse pr ON pr.id = p.produs_id
        WHERE p.data_iesire IS NULL
          AND (UPPER(COALESCE(NULLIF(TRIM(pr.cod), ''), '')) = ? OR UPPER(COALESCE(pr.cod_generat, '')) = ? OR UPPER(COALESCE(p.lot, '')) = ?)
        ORDER BY p.data_intrare, p.id LIMIT 30`
    )
    .all(c, c, c)
    .catch(() => []);
  const paleti = [];
  for (const r of randuri) paleti.push(await palet(r.id));
  return { paleti: paleti.filter(Boolean), fel: "produs" };
}

// Paleții mai vechi din aceeași marfă, încă în depozit (FIFO): ieșirea îi
// spune omului înainte să scoată unul mai nou.
async function maiVechi(p) {
  if (!p) return [];
  return db
    .prepare(
      `SELECT x.id, x.cod, x.data_intrare,
              (SELECT STRING_AGG(l.adresa, ' + ') FROM ct_ocupari o JOIN ct_locuri l ON l.id = o.loc_id WHERE o.palet_id = x.id) AS adrese
         FROM ct_paleti x LEFT JOIN produse xr ON xr.id = x.produs_id
        WHERE x.data_iesire IS NULL AND x.id <> ?
          AND LOWER(COALESCE(xr.denumire, x.produs_text, '')) = LOWER(COALESCE(?, ''))
          AND (x.data_intrare < ? OR (x.data_intrare = ? AND x.id < ?))
        ORDER BY x.data_intrare, x.id LIMIT 5`
    )
    .all(p.id, p.denumire, p.data_intrare, p.data_intrare, p.id)
    .catch(() => []);
}

// Comenzile clientului pe care poate pleca paletul: întâi cele care au
// produsul paletului pe ele, apoi restul comenzilor deschise.
async function comenziPentru(p) {
  const toate = await db
    .prepare(
      `SELECT c.id, c.numar, c.data, c.status, pa.nume AS client,
              EXISTS (SELECT 1 FROM comenzi_linii cl WHERE cl.comanda_id = c.id AND cl.produs_id = ?) AS are_produsul
         FROM comenzi c JOIN parteneri pa ON pa.id = c.partener_id
        WHERE c.status NOT IN ('anulata', 'livrata', 'ciorna')
        ORDER BY c.id DESC LIMIT 300`
    )
    .all(nr(p && p.produs_id))
    .catch(() => []);
  const da = (v) => v === true || v === 1 || v === "t" || v === "true" || v === "1";
  return toate
    .map((c) => Object.assign(c, { are_produsul: da(c.are_produsul) }))
    .sort((a, b) => Number(b.are_produsul) - Number(a.are_produsul) || Number(b.id) - Number(a.id));
}

// ---- De tipărit -----------------------------------------------------------------
// Terminalul din mână n-are imprimantă. Ce trebuie să iasă pe hârtie după o
// mișcare făcută cu scanerul — etichetele paleților, avizul, comanda
// clientului — se pune la coadă aici, iar calculatorul de lângă imprimantă,
// cu pagina „De tipărit" deschisă, le scoate singur (modules/ct-scaner.js).
// `fel`: „etichete" (100 × 150, pe Zebra) sau „a4".
const FELURI_TIPAR = ["etichete", "a4"];
const oraRo = (d) => (d || new Date()).toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19);

async function laTipar(fel, titlu, url, user) {
  if (!FELURI_TIPAR.includes(fel) || !/^\/[^/]/.test(String(url || ""))) return null;
  try {
    const r = await db
      .prepare("INSERT INTO ct_tipar (fel, titlu, url, creat_la, creat_de) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .run(fel, String(titlu || "document").slice(0, 200), String(url).slice(0, 500), oraRo(), (user && user.nume) || null);
    return r && r.lastInsertRowid ? Number(r.lastInsertRowid) : null;
  } catch (e) {
    // Coada de tipărit nu oprește mișcarea mărfii: paletul e făcut, ieșirea e
    // scrisă; documentul se poate tipări oricând din pagina lui.
    console.error("[ct-scaner] nu am putut pune la tipărit:", e.message);
    return null;
  }
}

// Ce așteaptă să fie tipărit, din ultimele `ore` ore (implicit 36: ce e mai
// vechi nu mai iese singur pe imprimantă — altfel, prima bifă ar scoate
// hârtiile unei săptămâni întregi).
async function deTiparit(fel, ore) {
  const de = oraRo(new Date(Date.now() - Math.max(1, nr(ore) || 36) * 3600 * 1000));
  const cuFel = FELURI_TIPAR.includes(fel);
  return db
    .prepare(`SELECT * FROM ct_tipar WHERE tiparit_la IS NULL AND creat_la >= ?${cuFel ? " AND fel = ?" : ""} ORDER BY id LIMIT 50`)
    .all(...(cuFel ? [de, fel] : [de]))
    .catch(() => []);
}

async function tiparit(id, user, eroare) {
  const e = String(eroare || "").trim().slice(0, 300);
  // O eroare NU marchează documentul ca tipărit: scrie doar motivul, ca
  // verificarea următoare să-l mai încerce o dată.
  if (e) return db.prepare("UPDATE ct_tipar SET eroare = ? WHERE id = ?").run(e, Math.round(nr(id)));
  return db
    .prepare("UPDATE ct_tipar SET tiparit_la = ?, tiparit_de = ?, eroare = NULL WHERE id = ?")
    .run(oraRo(), (user && user.nume) || null, Math.round(nr(id)));
}

module.exports = {
  FELURI_TIPAR,
  laTipar,
  deTiparit,
  tiparit,
  oraRo,
  pretRand,
  EPS,
  RE_LOC,
  RE_PALET,
  SURSE,
  curat,
  eLoc,
  ePalet,
  sursaPotrivita,
  locDupaAdresa,
  locuriDupaId,
  palet,
  paletDupaCod,
  faraLoc,
  deAsezat,
  randDeAsezat,
  potrivesteRand,
  potrivestePalet,
  propuneLocuri,
  pune,
  faPaleti,
  cantitatiDinText,
  paletiPentruIesire,
  maiVechi,
  comenziPentru,
};
