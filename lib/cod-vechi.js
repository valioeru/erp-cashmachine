"use strict";
// Produsele cu cod vechi, la alegere: eticheta „cod vechi" și parcarea.
//
// CEREREA LUI VALI, 17.11.2026: „Toate produsele vechi fără stoc să le marcăm
// (să apară, dar să fie marcate ca produs cu cod vechi, nu selecta); ulterior,
// dacă nu mai sunt folosite o lună de zile, le parchezi undeva și nici nu le
// mai sugerezi."
//
// TREI STĂRI, pentru un produs activ și neunificat:
//
//   • BUN: făcut din configurator (are familie) sau trecut de om ca „E bun
//     așa" în Configurări → Unificare coduri. Se alege ca până acum.
//   • PROASPĂT: făcut în ultimele 30 de zile (`nascut_la`, pusă de bază la
//     naștere; produsele de dinainte de 17.11.2026 n-o au). Se alege ca până
//     acum: un produs abia scris de om n-are cum fi „cod vechi" din prima zi.
//     După 30 de zile, dacă n-are familie, stoc sau „E bun așa", e cod vechi.
//   • COD VECHI: restul. Cel CU stoc se alege ca până acum (marfa lui trebuie
//     vândută; locul lui e în lista de unificat). Cel FĂRĂ stoc apare la
//     alegere cu eticheta „COD VECHI — nu selecta".
//   • PARCAT: cod vechi fără stoc, nefolosit de 30 de zile. Nu mai apare la
//     alegere deloc. Rămâne în nomenclator și în documentele vechi și se poate
//     scoate din parcare din pagina de unificare.
//
// „Folosit" = pus pe o comandă de client, ofertă, factură, comandă la
// furnizor, comandă de producție, recepție, palet sau aviz. Parcarea începe la
// 30 de zile după ziua în care a apărut eticheta (`MARCAT_DE_LA`): omul are o
// lună în care vede „cod vechi" înainte ca produsul să dispară din liste.
const db = require("./db");

const MARCAT_DE_LA = "2026-11-17";
const ZILE = 30;
const ETICHETA = "COD VECHI — nu selecta";

const eBun = (p) => Number(p && p.cod_familie_id) > 0 || Number(p && (p.cod_vechi_exceptat != null ? p.cod_vechi_exceptat : p.exceptat)) === 1;
const eParcat = (p) => String((p && p.parcat_la) || "").trim() !== "";

const ziua = (d) => String(d || "").slice(0, 10);
function plusZile(zi, n) {
  const d = new Date(ziua(zi) + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// De când se poate parca: la 30 de zile după apariția etichetei.
const PARCARE_DE_LA = plusZile(MARCAT_DE_LA, ZILE);

// Făcut în ultimele 30 de zile față de `azi`.
const eProaspat = (p, azi) => {
  const n = ziua(p && p.nascut_la);
  return Boolean(n) && n >= plusZile(azi, -ZILE);
};

// Ce produse se parchează azi. Fără bază.
//   produse:  [{ id, cod_familie_id, cod_vechi_exceptat, parcat_la, neparcat_la }] — active, neunificate
//   cuStoc:   Set cu id-urile care au marfă în CT-Park
//   folosit:  Map id → ultima zi în care produsul a fost pus pe un document
//   azi:      „YYYY-MM-DD"
function deParcat({ produse, cuStoc, folosit, azi }) {
  const zi = ziua(azi);
  if (!zi || zi < PARCARE_DE_LA) return [];
  const prag = plusZile(zi, -ZILE);
  const out = [];
  for (const p of produse || []) {
    const id = Number(p.id);
    if (eBun(p) || eParcat(p) || eProaspat(p, zi) || (cuStoc && cuStoc.has(id))) continue;
    // Scos din parcare de om: socotit folosit în ziua aceea, altfel s-ar
    // parca la loc în aceeași noapte.
    const ultima = [ziua(folosit && folosit.get(id)), ziua(p.neparcat_la)].filter(Boolean).sort().pop() || "";
    if (ultima && ultima >= prag) continue;
    out.push(id);
  }
  return out;
}

// ---- cu bază ---------------------------------------------------------------

const SQL_FOLOSIT = `
  SELECT produs_id, MAX(zi) AS zi FROM (
    SELECT l.produs_id, LEFT(c.data::text, 10) AS zi FROM comenzi_linii l JOIN comenzi c ON c.id = l.comanda_id
    UNION ALL SELECT l.produs_id, LEFT(f.data_emiterii::text, 10) FROM facturi_linii l JOIN facturi f ON f.id = l.factura_id
    UNION ALL SELECT l.produs_id, LEFT(o.creat_la::text, 10) FROM oferte_linii l JOIN oferte o ON o.id = l.oferta_id
    UNION ALL SELECT l.produs_id, LEFT(c.data::text, 10) FROM comenzi_furnizor_linii l JOIN comenzi_furnizor c ON c.id = l.comanda_id
    UNION ALL SELECT produs_id, LEFT(COALESCE(data_initiere, creat_la)::text, 10) FROM comenzi_productie
    UNION ALL SELECT l.produs_id, LEFT(COALESCE(c.data_initiere, c.creat_la)::text, 10) FROM comenzi_productie_linii l JOIN comenzi_productie c ON c.id = l.comanda_id
    UNION ALL SELECT l.produs_id, LEFT(r.data::text, 10) FROM receptii_linii l JOIN receptii r ON r.id = l.receptie_id
    UNION ALL SELECT produs_id, LEFT(data_intrare::text, 10) FROM ct_paleti
    UNION ALL SELECT l.produs_id, LEFT(a.data::text, 10) FROM avize_linii l JOIN avize a ON a.id = l.aviz_id
  ) x WHERE produs_id IS NOT NULL AND zi IS NOT NULL GROUP BY produs_id`;

// Ultima folosire a fiecărui produs: Map id → „YYYY-MM-DD".
async function folosite() {
  const m = new Map();
  for (const r of await db.prepare(SQL_FOLOSIT).all()) m.set(Number(r.produs_id), ziua(r.zi));
  return m;
}

async function stocuri() {
  const SP = require("./stoc-produse");
  const s = new Set();
  for (const r of await SP.citeste({ vedeTot: true })) if (r.produs_id && r.stoc > SP.EPS) s.add(Number(r.produs_id));
  return s;
}

// Starea, ținută un minut: paginile cu liste de produse o cer la fiecare
// deschidere, iar stocul nu se schimbă de la o secundă la alta.
let tinut = null;
const TINE_MS = 60 * 1000;
function goleste() {
  tinut = null;
}
async function stare() {
  if (tinut && Date.now() - tinut.la < TINE_MS) return tinut.v;
  const produse = await db
    .prepare(
      `SELECT id, cod_familie_id, COALESCE(cod_vechi_exceptat, 0) AS cod_vechi_exceptat, parcat_la, nascut_la
         FROM produse WHERE COALESCE(activ, 1) = 1 AND fuzionat_in IS NULL`
    )
    .all();
  const cuStoc = await stocuri();
  const azi = new Date().toISOString().slice(0, 10);
  const parcate = new Set();
  const vechiFaraStoc = new Set();
  const bune = new Set();
  for (const p of produse) {
    const id = Number(p.id);
    if (eBun(p)) bune.add(id);
    if (eParcat(p)) parcate.add(id);
    else if (!eBun(p) && !eProaspat(p, azi) && !cuStoc.has(id)) vechiFaraStoc.add(id);
  }
  const v = { parcate, vechiFaraStoc, bune };
  tinut = { la: Date.now(), v };
  return v;
}

// Lista de produse a unei pagini de alegere: fără cele parcate, iar cele cu
// cod vechi fără stoc poartă `cod_vechi: true`. Dacă starea nu se poate citi,
// lista rămâne cum era — o comandă nu se oprește pentru o etichetă.
// `pastreaza`: id-uri care rămân în listă chiar parcate (produsul deja pus pe
// documentul care se modifică).
async function pentruAles(produse, pastreaza) {
  let s;
  try {
    s = await stare();
  } catch (e) {
    console.error("[cod-vechi] starea produselor nu s-a putut citi:", e.message);
    return produse || [];
  }
  const tin = new Set((pastreaza || []).map(Number));
  const out = [];
  for (const p of produse || []) {
    const id = Number(p.id);
    if (s.parcate.has(id) && !tin.has(id)) continue;
    if (s.vechiFaraStoc.has(id) || s.parcate.has(id)) p.cod_vechi = true;
    out.push(p);
  }
  return inOrdine(out, s.bune);
}

// Ordinea la alegere (cererea lui Vali, 26.11.2026: „în lista asta să arate
// întâi codurile noi"). Lista de la comanda nouă se deschidea cu „COD VECHI —
// nu selecta" în cap, pentru că era doar alfabetică. Acum:
//   1. codurile noi — produsele bune (din configurator sau trecute „E bun așa");
//   2. restul produselor care se aleg normal (proaspete, sau cod vechi cu stoc);
//   3. cele marcate „COD VECHI — nu selecta", la coadă.
// În fiecare grupă rămâne ordinea în care a venit lista (alfabetică).
function inOrdine(produse, bune) {
  const treapta = (p) => (p.cod_vechi ? 2 : bune && bune.has(Number(p.id)) ? 0 : 1);
  return (produse || [])
    .map((p, i) => ({ p, i, t: treapta(p) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.p);
}

// Denumirea, cum se scrie într-o listă de ales.
const cuEticheta = (text, p) => (p && p.cod_vechi ? `${text} — ${ETICHETA}` : text);

// Parcarea de noapte. Întoarce câte a parcat.
async function parcheaza(azi) {
  const zi = ziua(azi || new Date().toISOString());
  if (zi < PARCARE_DE_LA) return 0;
  const produse = await db
    .prepare(
      `SELECT id, cod_familie_id, COALESCE(cod_vechi_exceptat, 0) AS cod_vechi_exceptat, parcat_la, neparcat_la, nascut_la
         FROM produse WHERE COALESCE(activ, 1) = 1 AND fuzionat_in IS NULL`
    )
    .all();
  const ids = deParcat({ produse, cuStoc: await stocuri(), folosit: await folosite(), azi: zi });
  for (let i = 0; i < ids.length; i += 500) {
    await db.prepare(`UPDATE produse SET parcat_la = ?, parcat_fel = 'auto' WHERE id IN (${ids.slice(i, i + 500).join(",")}) AND parcat_la IS NULL`).run(zi);
  }
  goleste();
  if (ids.length) console.log(`[cod-vechi] parcate: ${ids.length} produse cu cod vechi, fără stoc, nefolosite de ${ZILE} de zile`);
  return ids.length;
}

async function parcheazaDeMana(id, azi) {
  await db.prepare("UPDATE produse SET parcat_la = ?, parcat_fel = 'mana' WHERE id = ?").run(ziua(azi || new Date().toISOString()), id);
  goleste();
}
async function scoateDinParcare(id, azi) {
  await db.prepare("UPDATE produse SET parcat_la = NULL, parcat_fel = NULL, neparcat_la = ? WHERE id = ?").run(ziua(azi || new Date().toISOString()), id);
  goleste();
}

module.exports = {
  MARCAT_DE_LA, PARCARE_DE_LA, ZILE, ETICHETA,
  eBun, eParcat, eProaspat, plusZile, deParcat, folosite, stare, goleste, pentruAles, inOrdine, cuEticheta, parcheaza, parcheazaDeMana, scoateDinParcare,
};
