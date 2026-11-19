"use strict";
// Comanda preluată în producție se mai modifică doar cu acordul producției.
//
// CEREREA LUI VALI, 19.11.2026: „Odată preluată în producție, comanda se mai
// poate modifica doar după acordul producției." · „Și să apară cumva în top,
// de revalidat." · „Păstrează istoric modificări per comandă: cine a
// solicitat, cine a validat, data, ora."
//
// CUM MERGE
//   • „Preluată în producție" = comanda clientului are o comandă de producție
//     trecută de „nouă" (în producție, finalizată, facturată). Cât producția
//     e doar „nouă", nimeni n-a pus mâna pe ea și comanda se modifică liber.
//   • Cine NU are Producția și salvează o modificare pe o astfel de comandă
//     nu schimbă nimic: se scrie o CERERE, cu tot formularul și cu lista
//     schimbărilor (ce era → ce ar rămâne). Comanda rămâne cum era.
//   • Producția o vede sus, „De revalidat": pe pagina Producției și pe pagina
//     comenzii. O aprobă sau o respinge (respingerea cere motiv).
//   • La aprobare, modificarea se aplică prin ACELAȘI drum ca o salvare
//     obișnuită (modules/comenzi.js), pe numele celui care a cerut-o, cu
//     toate verificările de acolo, făcute pe starea de ACUM a comenzii. Dacă
//     între timp nu mai trece o verificare, cererea rămâne în așteptare și
//     producția vede de ce.
//   • Cine are Producția (sau administratorul) modifică direct: acordul e al
//     lui. Se scrie și asta în istoric.
//   • O singură cerere în așteptare pe comandă: a doua ar fi făcută peste o
//     stare care încă nu există.
//
// ISTORICUL e chiar tabela de cereri: cine a cerut și când, ce, cine a
// validat (sau respins) și când. Rândurile nu se șterg.
const db = require("./db");

const STARI = { asteapta: "așteaptă producția", aprobata: "aprobată", respinsa: "respinsă", retrasa: "retrasă" };
const acum = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 19);

// Are omul cuvântul producției? Administratorul, rolul Producție și cine are
// bifa „Producție" pusă pe nume la Utilizatori. NU oricine poate deschide
// pagina Producției: rolul Depozit o vede din oficiu, dar nu el hotărăște ce
// se mai poate schimba pe o comandă aflată în lucru.
function eProductie(user) {
  if (!user) return false;
  if (user.rol === "admin" || user.rol === "productie") return true;
  const bife = String(user.sectiuni || "").split(",").map((x) => x.trim()).filter(Boolean);
  return bife.includes("/productie");
}

// Comenzile de producție ale comenzii care au trecut de „nouă".
async function preluataInProductie(comandaId) {
  const r = await db
    .prepare("SELECT id, numar, status FROM comenzi_productie WHERE comanda_id = ? AND status IN ('in_productie', 'finalizata', 'facturata') ORDER BY id")
    .all(Number(comandaId))
    .catch(() => []);
  return r || [];
}

async function inAsteptare(comandaId) {
  return (
    (await db
      .prepare("SELECT * FROM comenzi_cereri_modificare WHERE comanda_id = ? AND stare = 'asteapta' ORDER BY id DESC LIMIT 1")
      .get(Number(comandaId))
      .catch(() => null)) || null
  );
}

// Scrie cererea. `corp` = formularul trimis, `schimbari` = [{ ce, vechi, nou }].
async function cere({ comandaId, user, corp, schimbari, motiv }) {
  // Din formular se țin doar câmpurile lui (text și liste de text).
  const curat = {};
  for (const [k, v] of Object.entries(corp || {})) {
    if (k.startsWith("__")) continue;
    if (Array.isArray(v)) curat[k] = v.map((x) => String(x == null ? "" : x));
    else if (v == null || typeof v !== "object") curat[k] = String(v == null ? "" : v);
  }
  const r = await db
    .prepare(
      `INSERT INTO comenzi_cereri_modificare (comanda_id, stare, solicitat_de_id, solicitat_de_nume, solicitat_la, corp, schimbari, motiv)
       VALUES (?, 'asteapta', ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      Number(comandaId),
      user ? Number(user.id) || null : null,
      user ? user.nume || user.email || "" : "",
      acum(),
      JSON.stringify(curat),
      JSON.stringify(schimbari || []),
      String(motiv || "").trim().slice(0, 300) || null
    );
  return r ? Number(r.id) : null;
}

async function inchide(id, stare, user, raspuns) {
  return await db
    .prepare(
      "UPDATE comenzi_cereri_modificare SET stare = ?, validat_de_id = ?, validat_de_nume = ?, validat_la = ?, raspuns = ? WHERE id = ? AND stare = 'asteapta'"
    )
    .run(stare, user ? Number(user.id) || null : null, user ? user.nume || user.email || "" : "", acum(), String(raspuns || "").trim().slice(0, 300) || null, Number(id));
}

async function citeste(id) {
  return (await db.prepare("SELECT * FROM comenzi_cereri_modificare WHERE id = ?").get(Number(id)).catch(() => null)) || null;
}

// Istoricul comenzii: toate cererile, cea mai nouă sus.
async function aleComenzii(comandaId) {
  return (await db.prepare("SELECT * FROM comenzi_cereri_modificare WHERE comanda_id = ? ORDER BY id DESC LIMIT 100").all(Number(comandaId)).catch(() => [])) || [];
}

// Tot ce așteaptă producția, cu comanda și clientul ei — pentru „De revalidat".
async function deRevalidat() {
  return (
    (await db
      .prepare(
        `SELECT m.*, c.numar AS comanda_numar, p.nume AS client
           FROM comenzi_cereri_modificare m JOIN comenzi c ON c.id = m.comanda_id LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE m.stare = 'asteapta' ORDER BY m.id`
      )
      .all()
      .catch(() => [])) || []
  );
}

function schimbarile(rand) {
  try {
    const s = JSON.parse((rand && rand.schimbari) || "[]");
    return Array.isArray(s) ? s : [];
  } catch (e) {
    return [];
  }
}
function corpul(rand) {
  try {
    const c = JSON.parse((rand && rand.corp) || "{}");
    return c && typeof c === "object" ? c : {};
  } catch (e) {
    return {};
  }
}

module.exports = { STARI, acum, eProductie, preluataInProductie, inAsteptare, cere, inchide, citeste, aleComenzii, deRevalidat, schimbarile, corpul };
