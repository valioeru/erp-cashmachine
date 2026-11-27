"use strict";
// Cantitatea din producție urmează cantitatea de pe comanda clientului.
//
// CE A SPUS VALI, 27.11.2026: „La modificare comandă, cantitatea pe care o
// vede în producție pe comanda deja alocată, deși aprobă modificarea, nu se
// modifică cantitatea de produs în consecință."
//
// DE CE. Drumul unei cantități: linia din comanda clientului → cererea
// depozitului către producție (`aprovizionari`, cu cât lipsește din stoc) →
// comanda de producție, făcută la confirmare cu cantitatea cererii
// (`comenzi_productie.cantitate`). Fiecare își ține cifra ei. La modificarea
// comenzii (cu acordul producției — lib/acord-productie.js) se schimba doar
// linia; cererea și comanda de producție rămâneau cu cifra veche, deci
// producția aproba „1.000 → 1.500" și vedea în continuare 1.000.
//
// REGULA. Când cantitatea unei linii se schimbă, cererea DESCHISĂ către
// producție pentru linia aceea se schimbă cu aceeași diferență:
//   • cererea era pe toată linia (1.000 din 1.000) → devine cât e linia acum;
//   • cererea era doar pe ce lipsea (600 din 1.000, 400 erau în stoc) și linia
//     urcă la 1.500 → cererea devine 1.100: ce era în stoc rămâne în stoc.
// Odată cu cererea se schimbă comanda de producție făcută din ea, linia ei de
// produs, valoarea estimată (proporțional) și alocarea pe utilaj, dacă e una
// singură și ținea toată cantitatea.
//
// CE NU SE ATINGE, și se spune în istoricul comenzii:
//   • producția deja finalizată, facturată sau anulată;
//   • o cerere care ar ajunge la zero sau sub (comanda a scăzut sub ce era
//     deja în stoc): nu se anulează singură o comandă de producție;
//   • alocările împărțite pe mai multe zile sau utilaje: cum se împarte noua
//     cantitate hotărăște producția.
//
// Partea de sus e fără bază de date, ca să se poată verifica într-un test.

const EPS = 0.0005;
const nr = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const rotund = (v) => Math.round(nr(v) * 1000) / 1000;
const scris = (v, um) => rotund(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 }) + (um ? " " + um : "");

// Noua cantitate a cererii. null = nu mai rămâne nimic de cerut.
function cantitateNoua({ linieVeche, linieNoua, cerere }) {
  const v = nr(linieVeche), n = nr(linieNoua), c = nr(cerere);
  const rezultat = Math.abs(c - v) < EPS ? n : c + (n - v);
  return rezultat > EPS ? rotund(rezultat) : null;
}

const DESCHISE_PRODUCTIE = ["noua", "in_productie"];
const STARE = { finalizata: "finalizată", facturata: "facturată", anulata: "anulată" };

// Aplică schimbările de cantitate.
//   comandaId
//   linii: [{ linieId, produsId, denumire, um, veche, noua }] — doar liniile a căror cantitate s-a schimbat
// Întoarce rândurile de pus în istoricul comenzii: [{ ce, vechi, nou }].
async function aplica({ comandaId, linii }) {
  const db = require("./db");
  const istoric = [];
  for (const l of linii || []) {
    if (Math.abs(nr(l.veche) - nr(l.noua)) < EPS) continue;
    const cereri = await db
      .prepare(
        `SELECT a.id, a.cantitate, a.um, a.status, a.productie_id,
                cp.numar AS cp_numar, cp.status AS cp_status, cp.cantitate AS cp_cantitate, cp.um AS cp_um, cp.valoare_estimata AS cp_valoare
           FROM aprovizionari a LEFT JOIN comenzi_productie cp ON cp.id = a.productie_id
          WHERE a.comanda_id = ? AND a.sursa = 'productie' AND a.status IN ('ceruta', 'confirmata', 'gata')
            AND (a.linie_id = ? OR (a.linie_id IS NULL AND a.produs_id = ?))
          ORDER BY a.id DESC`
      )
      .all(comandaId, l.linieId, l.produsId)
      .catch(() => []);
    if (!cereri.length) continue;
    const nume = l.denumire || "produs #" + l.produsId;
    // Diferența merge pe cea mai nouă cerere care se mai poate schimba.
    const a = cereri.find((c) => !c.productie_id || DESCHISE_PRODUCTIE.includes(String(c.cp_status || "")));
    if (!a) {
      const c = cereri[0];
      istoric.push({
        ce: "Producție · " + nume,
        vechi: `${c.cp_numar || "comanda de producție"} e deja ${STARE[c.cp_status] || "închisă"}`,
        nou: `cantitatea ei rămâne ${scris(c.cp_cantitate != null ? c.cp_cantitate : c.cantitate, c.cp_um || c.um)}; diferența de ${scris(nr(l.noua) - nr(l.veche), l.um)} trebuie cerută separat`,
      });
      continue;
    }
    const um = String(a.um || l.um || "").trim();
    const noua = cantitateNoua({ linieVeche: l.veche, linieNoua: l.noua, cerere: a.cantitate });
    if (noua === null) {
      istoric.push({
        ce: "Producție · " + nume,
        vechi: `${a.cp_numar || "cererea către producție"}: ${scris(a.cantitate, um)}`,
        nou: "nu s-a schimbat singură: comanda a scăzut sub ce era deja în stoc — dacă producția nu mai are ce face, anulează comanda de producție",
      });
      continue;
    }
    if (Math.abs(noua - nr(a.cantitate)) < EPS) continue;
    await db.prepare("UPDATE aprovizionari SET cantitate = ? WHERE id = ?").run(noua, a.id);
    let alocare = "";
    if (a.productie_id) {
      const vecheCp = nr(a.cp_cantitate);
      // Valoarea estimată urmează cantitatea, la același preț pe unitate.
      const valoare = nr(a.cp_valoare) > 0 && vecheCp > EPS ? Math.round((nr(a.cp_valoare) / vecheCp) * noua * 100) / 100 : a.cp_valoare;
      await db.prepare("UPDATE comenzi_productie SET cantitate = ?, valoare_estimata = ? WHERE id = ?").run(String(noua), valoare == null ? null : valoare, a.productie_id);
      await db
        .prepare("UPDATE comenzi_productie_linii SET cantitate = ? WHERE comanda_id = ? AND produs_id = ?")
        .run(String(noua), a.productie_id, l.produsId)
        .catch(() => null);
      // Alocarea pe utilaj: o singură alocare, care ținea toată cantitatea.
      const alocari = await db
        .prepare("SELECT id, cantitate FROM alocari_productie WHERE comanda_productie_id = ? AND status <> 'anulata'")
        .all(a.productie_id)
        .catch(() => []);
      if (alocari.length === 1 && Math.abs(nr(alocari[0].cantitate) - vecheCp) < EPS) {
        await db.prepare("UPDATE alocari_productie SET cantitate = ? WHERE id = ?").run(noua, alocari[0].id);
        alocare = "; alocarea pe utilaj are și ea cantitatea nouă (orele rămân cum erau — verifică-le)";
      } else if (alocari.length) {
        alocare = `; cele ${alocari.length === 1 ? "o alocare" : alocari.length + " alocări"} pe utilaj au rămas cum erau — împarte tu cantitatea nouă`.replace("cele o alocare", "alocarea");
      }
    }
    istoric.push({
      ce: "Producție · " + nume,
      vechi: `${a.cp_numar || "cererea către producție"}: ${scris(a.cantitate, um)}`,
      nou: scris(noua, um) + alocare,
    });
  }
  return istoric;
}

module.exports = { cantitateNoua, aplica, scris };
