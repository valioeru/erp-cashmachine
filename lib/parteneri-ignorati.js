"use strict";
// Partenerii pe care ERP-ul nu-i mai arată și pe care importul îi sare.
//
// DE UNDE VINE. În SmartBill rămăseseră date de test: BSI A/S cu 19.222.500
// RON și Rovenma Elektronik Sanayi cu 2.462.236 EUR în soldul de furnizori,
// sume care nu există nicăieri în contabilitate. Cuvintele lui Vali: „sunt
// teste ceva, șterge-le și ignoră-le pentru totdeauna din ERP".
//
// CE ÎNSEAMNĂ „ȘTERGE" AICI. Nu ștergem rândul. Dacă partenerul are facturi
// în spate, ștergerea ar rupe legăturile și n-ar mai exista cale înapoi — iar
// „pentru totdeauna" nu înseamnă „ireversibil", înseamnă „să nu se mai
// întoarcă singur". Deci: partenerul se marchează `ignorat`, facturile lui se
// scot din calcul prin `activ = 0` (mecanismul care exista deja în aplicație
// și pe care toate rapoartele îl respectă), iar regula rămâne scrisă într-o
// tabelă. La următorul import, același nume e sărit înainte să se nască.
//
// Ridicarea regulii pune totul la loc, dar NUMAI ce a scos ignorarea: o
// factură pe care a scos-o cineva de mână, din alt motiv, rămâne scoasă.
const db = require("./db");

// Numele normalizat pe care se face potrivirea. Fără diacritice, fără semne,
// un singur spațiu între cuvinte. „BSI A/S" și „bsi a s" sunt același lucru.
function cheieNume(nume) {
  return String(nume || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cuiCurat(cui) {
  return String(cui || "").toUpperCase().replace(/[^0-9]/g, "");
}

async function reguli() {
  return await db
    .prepare("SELECT id, nume, cheie, cui, motiv, adaugat_la FROM parteneri_ignorati ORDER BY nume")
    .all()
    .catch(() => []);
}

// Setul cu care se verifică repede, în timpul unui import, dacă un partener e
// ignorat. Se citește o dată pe import, nu o dată pe rând.
async function set() {
  const r = await reguli();
  return {
    nume: new Set(r.map((x) => x.cheie).filter(Boolean)),
    cui: new Set(r.map((x) => cuiCurat(x.cui)).filter(Boolean)),
  };
}

function esteIgnorat(s, nume, cui) {
  if (!s) return false;
  if (nume && s.nume.has(cheieNume(nume))) return true;
  const c = cuiCurat(cui);
  return !!(c && s.cui.has(c));
}

// Aplică o regulă peste ce există deja în bază: marchează partenerii care se
// potrivesc și scoate din calcul facturile lor.
async function aplica(regula) {
  const cheie = regula.cheie || cheieNume(regula.nume);
  const cui = cuiCurat(regula.cui);
  const gasiti = await db
    .prepare("SELECT id, nume, cui FROM parteneri WHERE COALESCE(ignorat,0) = 0")
    .all()
    .catch(() => []);
  const ids = gasiti
    .filter((p) => cheieNume(p.nume) === cheie || (cui && cuiCurat(p.cui) === cui))
    .map((p) => Number(p.id));
  if (!ids.length) return { parteneri: 0, facturi: 0 };

  const lista = ids.map(() => "?").join(",");
  await db.prepare(`UPDATE parteneri SET ignorat = 1 WHERE id IN (${lista})`).run(...ids);
  const f = await db
    .prepare(
      `UPDATE facturi SET activ = 0, scos_de_ignorare = 1
        WHERE partener_id IN (${lista}) AND activ = 1`
    )
    .run(...ids);
  return { parteneri: ids.length, facturi: (f && f.changes) || 0 };
}

// Ridică regula: partenerii redevin vizibili, iar facturile scoase DE
// IGNORARE se repun. Cele scoase de mână rămân scoase.
async function ridica(id) {
  const r = await db.prepare("SELECT id, nume, cheie, cui FROM parteneri_ignorati WHERE id = ?").get(id);
  if (!r) return { parteneri: 0, facturi: 0 };
  const cheie = r.cheie || cheieNume(r.nume);
  const cui = cuiCurat(r.cui);
  const toti = await db.prepare("SELECT id, nume, cui FROM parteneri WHERE COALESCE(ignorat,0) = 1").all().catch(() => []);
  const ids = toti
    .filter((p) => cheieNume(p.nume) === cheie || (cui && cuiCurat(p.cui) === cui))
    .map((p) => Number(p.id));

  await db.prepare("DELETE FROM parteneri_ignorati WHERE id = ?").run(r.id);
  if (!ids.length) return { parteneri: 0, facturi: 0 };
  const lista = ids.map(() => "?").join(",");
  await db.prepare(`UPDATE parteneri SET ignorat = 0 WHERE id IN (${lista})`).run(...ids);
  const f = await db
    .prepare(
      `UPDATE facturi SET activ = 1, scos_de_ignorare = 0
        WHERE partener_id IN (${lista}) AND scos_de_ignorare = 1`
    )
    .run(...ids);
  return { parteneri: ids.length, facturi: (f && f.changes) || 0 };
}

// Adaugă o regulă nouă și o aplică pe loc.
async function adauga({ nume, cui, motiv, utilizatorId }) {
  const curat = String(nume || "").trim();
  const cheie = cheieNume(curat);
  if (!cheie) return { eroare: "Scrie numele partenerului." };
  const exista = await db.prepare("SELECT id FROM parteneri_ignorati WHERE cheie = ?").get(cheie);
  if (exista) return { eroare: `„${curat}" e deja în listă.` };
  await db
    .prepare("INSERT INTO parteneri_ignorati (nume, cheie, cui, motiv, adaugat_de) VALUES (?, ?, ?, ?, ?)")
    .run(curat, cheie, String(cui || "").trim() || null, String(motiv || "").trim() || null, utilizatorId || null);
  const efect = await aplica({ nume: curat, cheie, cui });
  return { ok: true, ...efect };
}

// Rulată la pornire: pune în aplicare regulile care n-au apucat să prindă
// partenerii (de exemplu cele adăugate prin migrare, înainte să existe
// partenerul în bază).
async function aplicaTot() {
  let parteneri = 0, facturi = 0;
  for (const r of await reguli()) {
    const e = await aplica(r);
    parteneri += e.parteneri;
    facturi += e.facturi;
  }
  return { parteneri, facturi };
}

module.exports = { cheieNume, reguli, set, esteIgnorat, aplica, ridica, adauga, aplicaTot };
