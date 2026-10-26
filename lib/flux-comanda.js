"use strict";
// Pe ce flux tehnologic merge o comandă — și, de-aici, prin ce utilaje are
// voie să treacă.
//
// Stă în lib fiindcă răspunsul trebuie să fie ACELAȘI în două locuri care
// altfel n-ar avea de unde să știe unul de altul: fișa de lot, care tipărește
// operațiile, și pagina de alocare, care nu trebuie să lase pe nimeni să pună
// comanda pe o mașină care n-are ce căuta în fluxul ei. Scris de două ori, ar
// fi ajuns, după a treia modificare, să spună două lucruri diferite despre
// aceeași comandă.
const db = require("./db");

// Pe ce flux tehnologic merge o comandă. Trei surse, în ordinea asta:
//
//   1. ce s-a ales pe comandă — o serie de probă poate merge altfel decât
//      producția curentă, și atunci alegerea omului bate orice regulă;
//   2. fluxul produsului din catalog;
//   3. ghicit după denumire, ca ultimă soluție.
//
// Al treilea pas există fiindcă fără el fișa unui produs nelegat ar ieși cu
// zero operații — adică o hârtie care nu ajută pe nimeni. Ghicitul se SPUNE pe
// fișă („ghicit după denumire"), ca să nu treacă drept o alegere făcută de om.
const GHICIT = [
  ["F-STRETCH-PRE", /prestretch|pre-stretch/i],
  ["F-STRETCH-AUT", /stretch[^.]{0,20}automat|automat[^.]{0,20}stretch/i],
  ["F-STRETCH-MAN", /stretch/i],
  ["F-CUTIE-AM", /cutie[^.]{0,20}americ/i],
  ["F-CUTIE-SIMPLA", /cutie|carton/i],
  ["F-SAC-MENAJ", /menajer|sac[^.]{0,20}menaj/i],
  ["F-SAC-SGR", /sgr|fresful|sac/i],
  ["F-AWB", /awb|plic/i],
  ["F-PUNGA", /pung/i],
  ["F-BANDA", /band[ăa] adeziv|scotch/i],
  ["F-ETICHETE", /etichet/i],
  ["F-FOLIE-DEBITATA", /folie/i],
];
async function fluxulComenzii(c, linii) {
  const ia = async (id) => (id ? await db.prepare("SELECT * FROM fluxuri WHERE id = ? AND activ = 1").get(id) : null);
  let flux = await ia(c.flux_id);
  let cum = flux ? "set on order" : null;

  if (!flux) {
    const ids = [];
    for (const l of linii || []) if (l.produs_id) ids.push(Number(l.produs_id));
    if (c.produs_id) ids.unshift(Number(c.produs_id));
    for (const pid of ids) {
      const p = await db.prepare("SELECT flux_id FROM produse WHERE id = ?").get(pid);
      if (p && p.flux_id) {
        flux = await ia(p.flux_id);
        if (flux) { cum = "from product"; break; }
      }
    }
  }

  if (!flux) {
    const text = [c.tip_produs, c.caracteristici].concat((linii || []).map((l) => l.denumire)).filter(Boolean).join(" ");
    for (const [cod, rx] of GHICIT) {
      if (!rx.test(text)) continue;
      const f = await db.prepare("SELECT * FROM fluxuri WHERE upper(cod) = ? AND activ = 1").get(cod);
      if (f) { flux = f; cum = "guessed from name"; break; }
    }
  }

  const pasi = flux
    ? await db
        .prepare(
          `SELECT p.*, u.denumire AS utilaj_denumire FROM fluxuri_pasi p
             LEFT JOIN utilaje u ON u.id = p.utilaj_id
            WHERE p.flux_id = ? ORDER BY p.pas_nr`
        )
        .all(flux.id)
    : [];
  return { flux, pasi, cum };
}

// Utilajele prin care trece fluxul, în ordinea pașilor. „UT10|UT11" dă două
// utilaje, fiindcă pasul merge pe oricare dintre ele — alegerea o face omul
// sau regula de alocare, dar numai dintre astea două.
async function utilajeleFluxului(pasi) {
  const toate = await db.prepare("SELECT id, cod, denumire FROM utilaje WHERE activ = 1").all().catch(() => []);
  const dupaCod = new Map(toate.map((u) => [String(u.cod || "").toUpperCase(), u]));
  const dupaId = new Map(toate.map((u) => [Number(u.id), u]));
  const out = [];
  const vazute = new Set();
  for (const p of pasi || []) {
    const candidati = [];
    for (const cod of String(p.utilaj_cod || "").split("|").map((s) => s.trim().toUpperCase()).filter(Boolean)) {
      const u = dupaCod.get(cod);
      if (u) candidati.push(u);
    }
    if (!candidati.length && p.utilaj_id && dupaId.has(Number(p.utilaj_id))) candidati.push(dupaId.get(Number(p.utilaj_id)));
    for (const u of candidati) {
      if (vazute.has(Number(u.id))) continue;
      vazute.add(Number(u.id));
      out.push({ id: Number(u.id), cod: u.cod, denumire: u.denumire, operatie: p.operatie || "", pas: p.pas_nr });
    }
  }
  return out;
}

module.exports = { fluxulComenzii, utilajeleFluxului, GHICIT };
