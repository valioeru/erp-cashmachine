"use strict";
// Marfa gata din producție care așteaptă să fie alocată în CT-Park.
//
// CE A CERUT VALI, 09.11.2026:
//   „Produsele gata din producție trebuie să intre în depozit, iar în Intrare
//    marfă să fie lista cu produse gata, de unde le bagi automat pe rafturi
//    sau le dai direct în fulfillment sau direct la livrare."
//   „La finalizare comandă, când schimbi statusul, să se ducă în depozit,
//    unde va aștepta alocare pe depozit, fulfillment sau livrare."
//   Și, cu poza cererilor marcate „intrată în stoc": „Astea intrate în stoc e
//    stoc CT-Park și ar trebui alocate pe rafturi; nu există alt stoc decât
//    cel din CT-Park."
//
// DE UNDE VINE LISTA:
//   1. Recepțiile din producție. Comanda de producție pusă pe „Finalizată"
//      deschide singură o recepție (lib/stadiu-comanda.js, trimiteInDepozit);
//      cât timp marfa ei n-are palet în CT-Park — nici pe raft, nici plecată
//      direct —, stă aici. Recepția încă nenumărată se ia „cum a anunțat-o
//      producția" când o aloci de aici (modules/receptie.js, primesteTot);
//      cine vrea să numere altceva deschide recepția.
//   2. Cererile depozitului (aprovizionari) fără recepție: cele gata în
//      producție și cele deja marcate „intrată în stoc" — butonul vechi scria
//      doar în tabela miscari_stoc, fără palet și fără loc. Cât s-a alocat se
//      citește din paleții legați de cerere (ct_paleti.aprovizionare_id),
//      inclusiv cei plecați direct la livrare.
//
// Cererea legată de o comandă de client deja plecată (în livrare sau livrată)
// nu apare: marfa ei a ieșit. O cerere veche a cărei marfă e deja pe raft
// (pusă de mână, fără legătură) sau a plecat altfel se scoate din listă cu
// motiv, fără să facă stoc.
//
//
// MARFA DE LA FURNIZORI (Vali, 10.11.2026):
//   „La Intrare marfă în CT-Park, la fel ca și comenzile intrate din producție,
//    în lista de sus apar și altele, de la furnizori, imediat după ce au fost
//    recepționate, ca să poată fi alocate pe raft."
//   Recepțiile de la furnizori (și retururile) intră în listă din clipa în
//   care sunt finalizate: fiecare rând primit în stare bună stă acolo cât timp
//   marfa lui n-are palet (receptiiFurnizori). Spre deosebire de producție,
//   recepția de la furnizor nenumărată nu apare: ce scrie pe aviz nu e neapărat
//   ce a venit, deci întâi se numără.
//
// Aici sunt doar datele; pagina și butoanele sunt în modules/gata-productie.js.

const db = require("./db");

const EPS = 0.0005;

// Rândul unei recepții finalizate care încă așteaptă raft — aceeași regulă
// pentru lista de aici și pentru stocul din CT-Park (lib/stoc-produse.js,
// modules/warehouse.js), ca „de pus" să nu spună două lucruri diferite.
// Nu mai așteaptă: rândul scos din listă de depozit (e deja pe raft, pus de
// mână, sau a plecat altfel) și marfa comenzii de client deja plecate (în
// livrare sau livrată) — ea a ieșit din depozit, chiar dacă n-a avut palet.
// Aliasurile: rl = receptii_linii, r = receptii.
const LINIE_DESCHISA = `rl.ct_inchis_la IS NULL
          AND NOT EXISTS (SELECT 1 FROM comenzi cx WHERE cx.id = r.comanda_id AND cx.status IN ('in_livrare', 'livrata'))`;
// Cât dintr-un rând (de recepție sau de cerere) a ajuns pe un palet: cantitatea
// cu care a INTRAT paletul, nu cea de pe el acum. După o ieșire parțială pe
// palet rămâne mai puțin, iar socotit din „acum" rândul reapărea în listă cu
// marfa plecată ca „de alocat" și ca stoc „de pus" (găsit pe 10.11.2026: 1000 kg
// puse, 300 scoase în producție → „300 kg de alocat"). Paleții de dinaintea
// coloanei au valoarea completată la pornire (lib/db.js); unde lipsește,
// rămâne cantitatea de pe palet. `alias` = aliasul lui ct_paleti din interogare.
const cantPusa = (alias) => `COALESCE(${alias}.cantitate_intrare, ${alias}.cantitate)`;
const nr = (v) => Number(v) || 0;
const rotunjit = (v) => Math.round(nr(v) * 1000) / 1000;

async function receptii() {
  const randuri = await db
    .prepare(
      `SELECT r.id AS receptie_id, r.numar AS receptie_numar, r.stare AS receptie_stare, r.comanda_id,
              r.comanda_productie_id, r.creata_la, r.data,
              cp.numar AS productie_numar, co.numar AS comanda_numar,
              COALESCE(pc.nume, pp.nume, NULLIF(TRIM(cp.client_text), '')) AS client,
              rl.id AS linie_id, rl.produs_id, COALESCE(p.denumire, rl.produs_text) AS denumire,
              COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS cod, COALESCE(rl.um, p.unitate_masura) AS um,
              rl.cantitate_asteptata, rl.cantitate_primita, COALESCE(rl.stare, 'de_primit') AS linie_stare, rl.conditie,
              COALESCE((SELECT SUM(${cantPusa("x")}) FROM ct_paleti x WHERE x.receptie_linie_id = rl.id), 0) AS pus
         FROM receptii r
         JOIN receptii_linii rl ON rl.receptie_id = r.id
         LEFT JOIN produse p ON p.id = rl.produs_id
         LEFT JOIN comenzi_productie cp ON cp.id = r.comanda_productie_id
         LEFT JOIN comenzi co ON co.id = r.comanda_id
         LEFT JOIN parteneri pc ON pc.id = co.partener_id
         LEFT JOIN parteneri pp ON pp.id = cp.partener_id
        WHERE r.sursa = 'productie' AND r.stare IN ('asteptata', 'in_lucru', 'finalizata')
          AND ${LINIE_DESCHISA}
        ORDER BY r.id, rl.id`
    )
    .all()
    .catch(() => []);
  const out = [];
  for (const l of randuri) {
    const finalizata = l.receptie_stare === "finalizata";
    if (l.linie_stare === "respinsa") continue;
    // Recepția numărată: intră doar ce e primit și bun. Încă nenumărată:
    // cât a anunțat producția (se poate număra pe recepție).
    if (finalizata && (l.linie_stare !== "primita" || (l.conditie && l.conditie !== "bun"))) continue;
    const cantitate = finalizata ? nr(l.cantitate_primita) : nr(l.cantitate_primita) || nr(l.cantitate_asteptata);
    const ramas = rotunjit(cantitate - nr(l.pus));
    if (ramas <= EPS) continue;
    out.push({
      fel: "receptie",
      cheie: "r" + l.linie_id,
      id: Number(l.linie_id),
      receptie_id: Number(l.receptie_id),
      receptie_numar: l.receptie_numar || "#" + l.receptie_id,
      numarata: finalizata,
      produs_id: Number(l.produs_id) || null,
      denumire: l.denumire || "(fără denumire)",
      cod: l.cod || "",
      um: l.um || "",
      cantitate: rotunjit(cantitate),
      pus: rotunjit(l.pus),
      ramas,
      comanda_id: Number(l.comanda_id) || null,
      comanda_numar: l.comanda_numar || "",
      client: l.client || "",
      productie_id: Number(l.comanda_productie_id) || null,
      productie_numar: l.productie_numar || "",
      data: String(l.data || l.creata_la || "").slice(0, 10),
      stare: finalizata ? "numărată, de alocat" : "gata în producție",
    });
  }
  return out;
}

// De unde a venit o recepție care nu e din producție, pe înțelesul omului.
const SURSE_TEXT = {
  furnizor: "de la furnizor",
  retur_tert: "retur de la client",
  retur_fulfilment: "retur din fulfillment",
  inventar_initial: "stoc inițial",
};

// Marfa recepționată de la furnizori (și retururile), numărată, care n-a
// primit încă palet în CT-Park. Aceeași regulă pentru lista din Intrare marfă
// și pentru scaner (lib/ct-scaner.js).
async function receptiiFurnizori() {
  const randuri = await db
    .prepare(
      `SELECT r.id AS receptie_id, r.numar AS receptie_numar, r.sursa, r.comanda_id, r.data, r.finalizata_la, r.document_extern,
              pa.nume AS partener, co.numar AS comanda_numar, pc.nume AS client,
              rl.id AS linie_id, rl.produs_id, COALESCE(p.denumire, rl.produs_text) AS denumire,
              COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS cod, COALESCE(rl.um, p.unitate_masura) AS um,
              rl.cantitate_primita,
              COALESCE((SELECT SUM(${cantPusa("x")}) FROM ct_paleti x WHERE x.receptie_linie_id = rl.id), 0) AS pus
         FROM receptii r
         JOIN receptii_linii rl ON rl.receptie_id = r.id
         LEFT JOIN produse p ON p.id = rl.produs_id
         LEFT JOIN parteneri pa ON pa.id = r.partener_id
         LEFT JOIN comenzi co ON co.id = r.comanda_id
         LEFT JOIN parteneri pc ON pc.id = co.partener_id
        WHERE r.sursa <> 'productie' AND r.stare = 'finalizata'
          AND rl.stare = 'primita' AND COALESCE(rl.conditie, 'bun') = 'bun'
          AND ${LINIE_DESCHISA}
        ORDER BY r.id, rl.id`
    )
    .all()
    .catch(() => []);
  const out = [];
  for (const l of randuri) {
    const ramas = rotunjit(nr(l.cantitate_primita) - nr(l.pus));
    if (ramas <= EPS) continue;
    out.push({
      fel: "receptie",
      cheie: "r" + l.linie_id,
      id: Number(l.linie_id),
      receptie_id: Number(l.receptie_id),
      receptie_numar: l.receptie_numar || "#" + l.receptie_id,
      sursa: l.sursa,
      sursa_text: SURSE_TEXT[l.sursa] || String(l.sursa || ""),
      partener: l.partener || "",
      document: l.document_extern || "",
      numarata: true,
      produs_id: Number(l.produs_id) || null,
      denumire: l.denumire || "(fără denumire)",
      cod: l.cod || "",
      um: l.um || "",
      cantitate: rotunjit(l.cantitate_primita),
      pus: rotunjit(l.pus),
      ramas,
      comanda_id: Number(l.comanda_id) || null,
      comanda_numar: l.comanda_numar || "",
      client: l.client || "",
      productie_id: null,
      productie_numar: "",
      data: String(l.finalizata_la || l.data || "").slice(0, 10),
      stare: "recepționată, de alocat",
    });
  }
  return out;
}

// Rândul de recepție care așteaptă alocare, oricare i-ar fi sursa.
async function randReceptie(linieId) {
  const id = Number(linieId) || 0;
  if (!id) return null;
  return (await receptii()).concat(await receptiiFurnizori()).find((r) => r.id === id) || null;
}

async function cereri() {
  const randuri = await db
    .prepare(
      `SELECT a.id, a.produs_id, a.cantitate, a.sursa, a.status, a.comanda_id, a.furnizor_id, a.creata_la,
              p.denumire, COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS cod, p.unitate_masura AS um,
              co.numar AS comanda_numar, pa.nume AS client, f.nume AS furnizor,
              (SELECT MIN(cp.id) FROM comenzi_productie cp WHERE cp.aprovizionare_id = a.id) AS productie_id,
              (SELECT MIN(cp.numar) FROM comenzi_productie cp WHERE cp.aprovizionare_id = a.id) AS productie_numar,
              COALESCE((SELECT SUM(${cantPusa("x")}) FROM ct_paleti x WHERE x.aprovizionare_id = a.id), 0) AS pus
         FROM aprovizionari a
         JOIN produse p ON p.id = a.produs_id
         LEFT JOIN comenzi co ON co.id = a.comanda_id
         LEFT JOIN parteneri pa ON pa.id = co.partener_id
         LEFT JOIN parteneri f ON f.id = a.furnizor_id
        WHERE ((a.sursa = 'productie' AND a.status = 'gata') OR a.status = 'primita')
          AND a.ct_inchis_la IS NULL
          AND NOT EXISTS (SELECT 1 FROM receptii r WHERE r.aprovizionare_id = a.id AND r.stare <> 'anulata')
          -- Comanda clientului deja plecată (pe drum sau livrată): marfa ei nu
          -- mai e în depozit, n-are ce raft să primească.
          AND (co.id IS NULL OR co.status NOT IN ('in_livrare', 'livrata'))
        ORDER BY a.id`
    )
    .all()
    .catch(() => []);
  const out = [];
  for (const a of randuri) {
    const ramas = rotunjit(nr(a.cantitate) - nr(a.pus));
    if (ramas <= EPS) continue;
    out.push({
      fel: "cerere",
      cheie: "c" + a.id,
      id: Number(a.id),
      sursa: a.sursa,
      status: a.status,
      produs_id: Number(a.produs_id) || null,
      denumire: a.denumire || "(fără denumire)",
      cod: a.cod || "",
      um: a.um || "",
      cantitate: rotunjit(a.cantitate),
      pus: rotunjit(a.pus),
      ramas,
      comanda_id: Number(a.comanda_id) || null,
      comanda_numar: a.comanda_numar || "",
      client: a.client || "",
      furnizor: a.furnizor || "",
      productie_id: Number(a.productie_id) || null,
      productie_numar: a.productie_numar || "",
      data: String(a.creata_la || "").slice(0, 10),
      stare: a.status === "gata" ? "gata în producție" : "„intrată în stoc”, fără raft",
      veche: a.status === "primita",
    });
  }
  return out;
}

// Tot ce așteaptă alocare: întâi ce e gata acum în producție, apoi cererile
// vechi rămase fără loc.
async function lista() {
  const r = await receptii();
  const c = await cereri();
  return r.concat(c.filter((x) => !x.veche), c.filter((x) => x.veche));
}

// Cererea, pentru precompletarea Intrării marfă: ce e, cât, cât s-a pus deja.
async function cerere(id) {
  const a = await db
    .prepare(
      `SELECT a.*, p.denumire, p.unitate_masura, f.nume AS furnizor_nume,
              COALESCE((SELECT SUM(${cantPusa("x")}) FROM ct_paleti x WHERE x.aprovizionare_id = a.id), 0) AS pus
         FROM aprovizionari a
         JOIN produse p ON p.id = a.produs_id
         LEFT JOIN parteneri f ON f.id = a.furnizor_id
        WHERE a.id = ?`
    )
    .get(Number(id) || 0)
    .catch(() => null);
  if (!a) return null;
  const cantitate = rotunjit(a.cantitate);
  const pus = rotunjit(a.pus);
  return {
    aprovizionare_id: Number(a.id),
    linie_id: null,
    receptie_id: null,
    numar: "cererea #" + a.id,
    sursa: a.sursa,
    status: a.status,
    comanda_id: Number(a.comanda_id) || null,
    produs_id: Number(a.produs_id) || null,
    denumire: a.denumire || "",
    produs_text: "",
    um: a.unitate_masura || "",
    lot: "",
    pret: "",
    furnizor_id: a.sursa === "tert" ? Number(a.furnizor_id) || null : null,
    furnizor_text: "",
    furnizor_nume: a.sursa === "tert" ? a.furnizor_nume || "" : "",
    // Ce vine din producția noastră e produs finit; marfa de la terți rămâne
    // cum o încadrează omul.
    categorie: a.sursa === "productie" ? "produse finite" : "",
    primit: cantitate,
    pus,
    ramas: Math.max(0, rotunjit(cantitate - pus)),
    inchisa: Boolean(a.ct_inchis_la),
  };
}

// După ce marfa unei cereri a primit palet (pe raft sau direct la livrare):
// cererea e „intrată în stoc", iar comanda clientului merge mai departe pe
// același drum ca la recepție (lib/stadiu-comanda.js).
async function dupaPunere(aprovizionareId, user) {
  const id = Number(aprovizionareId) || 0;
  if (!id) return;
  const a = await db.prepare("SELECT id, comanda_id, sursa FROM aprovizionari WHERE id = ?").get(id).catch(() => null);
  if (!a) return;
  await db.prepare("UPDATE aprovizionari SET status = 'primita' WHERE id = ? AND status <> 'primita'").run(id);
  if (a.comanda_id) {
    try {
      await require("./stadiu-comanda").dupaIntrareMarfa(a.comanda_id, {
        user,
        motiv: `Marfa ${a.sursa === "productie" ? "din producție" : "de la furnizor"} a primit loc în CT-Park (${(user && user.nume) || "depozit"}).`,
        potrivire: require("../modules/warehouse").potrivire,
      });
    } catch (e) {
      console.error("[gata-productie] nu am putut muta comanda clientului:", e.message);
    }
  }
}

async function inchide(id, motiv, user) {
  const m = String(motiv || "").trim();
  if (m.length < 3) return { eroare: "Scrie de ce nu mai e de alocat (e deja pe raft, a plecat la client…)." };
  const a = await db.prepare("SELECT id, status, ct_inchis_la FROM aprovizionari WHERE id = ?").get(Number(id) || 0);
  if (!a) return { eroare: "Cererea nu există." };
  if (a.ct_inchis_la) return { eroare: "Cererea e deja scoasă din listă." };
  await db
    .prepare("UPDATE aprovizionari SET ct_inchis_la = ?, ct_inchis_de = ?, ct_motiv = ? WHERE id = ? AND ct_inchis_la IS NULL")
    .run(new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19), (user && user.nume) || null, m.slice(0, 300), Number(a.id));
  return { ok: true, mesaj: `Cererea #${a.id} a ieșit din listă: ${m}.` };
}

// Rândul unei recepții deja numărate, scos din listă: marfa e pe raft (pusă
// de mână, fără legătură) sau a plecat altfel. Din clipa asta nu mai e „de
// pus" nici în stocul din CT-Park (LINIE_DESCHISA). Recepția nenumărată nu se
// scoate de aici — ea se anulează din recepție, dacă n-a venit nimic.
async function inchideReceptie(lid, motiv, user) {
  const m = String(motiv || "").trim();
  if (m.length < 3) return { eroare: "Scrie de ce nu mai e de alocat (e deja pe raft, a plecat la client…)." };
  const l = await db
    .prepare(
      `SELECT rl.id, rl.stare, rl.ct_inchis_la, r.stare AS receptie_stare, r.numar, r.id AS receptie_id
         FROM receptii_linii rl JOIN receptii r ON r.id = rl.receptie_id WHERE rl.id = ?`
    )
    .get(Number(lid) || 0);
  if (!l) return { eroare: "Rândul de recepție nu există." };
  if (l.ct_inchis_la) return { eroare: "Rândul e deja scos din listă." };
  if (l.receptie_stare !== "finalizata" || l.stare !== "primita") {
    return { eroare: "Doar marfa deja numărată se scoate din listă. Recepția nenumărată se anulează din recepție." };
  }
  await db
    .prepare("UPDATE receptii_linii SET ct_inchis_la = ?, ct_inchis_de = ?, ct_motiv = ? WHERE id = ? AND ct_inchis_la IS NULL")
    .run(new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19), (user && user.nume) || null, m.slice(0, 300), Number(l.id));
  return { ok: true, mesaj: `Rândul din recepția ${l.numar || "#" + l.receptie_id} a ieșit din listă: ${m}.` };
}

// Paleții făcuți pentru o ieșire directă (la client pe comandă sau în
// fulfillment), încă neieșiți și fără loc pe raft. Stau sub lista de alocat,
// fiecare cu butonul lui de ieșire, ca nimic să nu rămână uitat între
// alocare și ieșire.
async function pregatite() {
  const randuri = await db
    .prepare(
      `SELECT p.id, p.cod, p.cantitate, p.um, p.iesire_plan, p.iesire_comanda_id, p.data_intrare,
              p.receptie_id, p.receptie_linie_id, p.aprovizionare_id,
              COALESCE(pr.denumire, p.produs_text) AS denumire,
              co.numar AS comanda_numar, pa.nume AS client, rc.numar AS receptie_numar
         FROM ct_paleti p
         LEFT JOIN produse pr ON pr.id = p.produs_id
         LEFT JOIN comenzi co ON co.id = p.iesire_comanda_id
         LEFT JOIN parteneri pa ON pa.id = co.partener_id
         LEFT JOIN receptii rc ON rc.id = p.receptie_id
        WHERE p.iesire_plan IS NOT NULL AND p.data_iesire IS NULL
          AND NOT EXISTS (SELECT 1 FROM ct_ocupari o WHERE o.palet_id = p.id)
        ORDER BY p.id`
    )
    .all()
    .catch(() => []);
  return randuri.map((p) => {
    const din = p.receptie_id ? `recepția ${p.receptie_numar || "#" + p.receptie_id}` : p.aprovizionare_id ? `cererea #${p.aprovizionare_id}` : "CT-Park";
    const q = new URLSearchParams({
      palet: String(p.id),
      destinatie: p.iesire_plan,
      ...(p.iesire_plan === "comanda" && p.iesire_comanda_id ? { comanda_id: String(p.iesire_comanda_id) } : {}),
      motiv: `livrare directă din ${din}`,
    });
    return {
      id: Number(p.id),
      cod: p.cod,
      denumire: p.denumire || "(fără denumire)",
      cantitate: rotunjit(p.cantitate),
      um: p.um || "",
      destinatie: p.iesire_plan,
      comanda_id: Number(p.iesire_comanda_id) || null,
      comanda_numar: p.comanda_numar || "",
      client: p.client || "",
      din,
      iesire: "/stocuri/ct-park/iesire?" + q.toString(),
    };
  });
}

// Paletul pregătit pentru ieșire, desfăcut: cantitatea lui se întoarce în
// lista de alocat. Doar cât n-a ieșit și n-a primit loc pe raft — altfel e
// marfă care s-a mișcat, iar paletul ei rămâne.
async function renunta(paletId) {
  const p = await db
    .prepare("SELECT id, cod, iesire_plan, data_iesire FROM ct_paleti WHERE id = ?")
    .get(Number(paletId) || 0)
    .catch(() => null);
  if (!p || !p.iesire_plan) return { eroare: "Paletul nu e unul pregătit pentru ieșire." };
  if (p.data_iesire) return { eroare: `Paletul ${p.cod} a ieșit deja.` };
  const pe = await db.prepare("SELECT COUNT(*) AS n FROM ct_ocupari WHERE palet_id = ?").get(p.id);
  const ies = await db.prepare("SELECT COUNT(*) AS n FROM ct_iesiri WHERE palet_id = ?").get(p.id).catch(() => ({ n: 0 }));
  if (nr(pe && pe.n) || nr(ies && ies.n)) return { eroare: `Paletul ${p.cod} are deja loc sau ieșiri; nu se mai desface de aici.` };
  await db.prepare("DELETE FROM ct_palet_linii WHERE palet_id = ?").run(p.id);
  await db.prepare("DELETE FROM ct_paleti WHERE id = ?").run(p.id);
  return { ok: true, mesaj: `Paletul ${p.cod} s-a desfăcut; cantitatea lui e din nou de alocat.` };
}

module.exports = { EPS, LINIE_DESCHISA, cantPusa, SURSE_TEXT, receptii, receptiiFurnizori, randReceptie, cereri, lista, cerere, dupaPunere, inchide, inchideReceptie, pregatite, renunta };
