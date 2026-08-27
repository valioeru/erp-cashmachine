"use strict";
// Grupul de firme — Cash Machine + Warehouse All (și oricare altele adăugate
// ulterior). Două reguli, care sunt toată logica de consolidare:
//
//   1. PARTENERII SUNT COMUNI. Nu dublăm lista de clienți/furnizori pe firmă:
//      același client cumpără de la ambele, deci e un singur rând în ERP,
//      cu istoricul complet. Facturile poartă firma emitentă (firma_id).
//
//   2. FACTURILE ÎNTRE FIRMELE GRUPULUI SE ELIMINĂ din rapoartele de grup.
//      Când Cash Machine îi facturează lui Warehouse All, la nivel de grup
//      nu s-a creat valoare — banul doar s-a mutat dintr-un buzunar în
//      altul. Dacă nu le-am elimina, cifra de afaceri a grupului ar fi
//      umflată artificial, iar costurile la fel. (În balanța Cash Machine,
//      Warehouse All apare ca primul furnizor, cu 3,57 mil. lei — exact
//      genul de sumă care ar denatura totul.)
//
// Marcarea se face automat: orice factură al cărei partener are CUI-ul unei
// firme din grup primește intercompany = 1.
const db = require("./db");

const FIRME_INITIALE = [
  { nume: "Cash Machine SRL", cui: "27244210", culoare: "#2f5d9c", implicita: 1 },
  { nume: "Warehouse All SRL", cui: "44140650", culoare: "#1a7f42", implicita: 0 },
];

function normCui(cui) {
  return String(cui || "")
    .toUpperCase()
    .replace(/[^0-9]/g, ""); // "RO27244210" și "27244210" sunt același CUI
}

async function asiguraFirme() {
  const existente = Number((await db.prepare("SELECT COUNT(*) AS n FROM firme").get()).n);
  if (existente === 0) {
    for (const f of FIRME_INITIALE) {
      await db
        .prepare("INSERT INTO firme (nume, cui, culoare, in_grup, implicita) VALUES (?, ?, ?, 1, ?)")
        .run(f.nume, f.cui, f.culoare, f.implicita);
    }
  }
  // Facturile de dinaintea introducerii firmelor aparțin firmei implicite.
  const implicita = await firmaImplicita();
  if (implicita) {
    await db.prepare("UPDATE facturi SET firma_id = ? WHERE firma_id IS NULL").run(implicita.id);
  }
  return await listaFirme();
}

async function listaFirme() {
  return await db.prepare("SELECT * FROM firme ORDER BY implicita DESC, nume").all();
}

async function firmaImplicita() {
  return (
    (await db.prepare("SELECT * FROM firme WHERE implicita = 1").get()) ||
    (await db.prepare("SELECT * FROM firme ORDER BY id LIMIT 1").get())
  );
}

// Leagă partenerii care SUNT firme din grup (ca să știm pe cine eliminăm) și
// marchează facturile către/de la ei ca intercompany. Idempotent — se poate
// rula după fiecare import.
async function marcheazaIntercompany() {
  const firme = await db.prepare("SELECT id, nume, cui FROM firme WHERE in_grup = 1").all();
  let parteneriLegati = 0;
  let facturiMarcate = 0;

  // 1. găsim partenerii care sunt de fapt firmele noastre (după CUI, apoi nume)
  const parteneri = await db.prepare("SELECT id, nume, cui FROM parteneri").all();
  for (const f of firme) {
    const cuiF = normCui(f.cui);
    if (!cuiF) continue;
    const numeF = String(f.nume || "").toLowerCase().replace(/\s+(srl|sa|s\.r\.l\.|s\.a\.)\.?$/i, "").trim();
    for (const p of parteneri) {
      const potrivitCui = normCui(p.cui) && normCui(p.cui) === cuiF;
      const potrivitNume = !normCui(p.cui) && numeF && String(p.nume || "").toLowerCase().includes(numeF);
      if (potrivitCui || potrivitNume) {
        await db.prepare("UPDATE parteneri SET firma_grup_id = ? WHERE id = ? AND (firma_grup_id IS NULL OR firma_grup_id <> ?)").run(f.id, p.id, f.id);
        parteneriLegati++;
      }
    }
  }

  // 2. facturile către/de la acești parteneri sunt intercompany
  const r = await db
    .prepare(
      `UPDATE facturi SET intercompany = 1
       WHERE intercompany = 0 AND partener_id IN (SELECT id FROM parteneri WHERE firma_grup_id IS NOT NULL)`
    )
    .run();
  facturiMarcate = r.changes || 0;

  return { parteneriLegati, facturiMarcate };
}

// Clauza SQL de filtrare pentru rapoarte. `mod` poate fi:
//   "grup"  — toate firmele, FĂRĂ facturile dintre ele (consolidat)
//   "toate" — chiar tot, inclusiv intercompany (pentru verificări)
//   un id   — o singură firmă, cu tot ce a facturat ea (inclusiv în grup)
function clauzaFirma(mod, alias = "f") {
  if (mod === "toate") return { sql: "", args: [] };
  if (mod === "grup" || !mod) return { sql: ` AND ${alias}.intercompany = 0`, args: [] };
  const id = parseInt(mod, 10);
  if (!Number.isFinite(id)) return { sql: ` AND ${alias}.intercompany = 0`, args: [] };
  return { sql: ` AND ${alias}.firma_id = ?`, args: [id] };
}

module.exports = { asiguraFirme, listaFirme, firmaImplicita, marcheazaIntercompany, clauzaFirma, normCui, FIRME_INITIALE };
