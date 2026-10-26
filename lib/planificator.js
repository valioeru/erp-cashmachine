"use strict";
// Propunerea de planificare: cine stă la ce utilaj, în ce schimb, în ce zi.
//
// Omul spune trei lucruri — ce utilaje merg și în câte schimburi, cine poate
// veni în fiecare zi, și cât durează un schimb. Restul e o problemă de
// împărțit oameni pe posturi, și e genul de problemă la care oamenii se
// descurcă prost nu pentru că ar fi greu de gândit, ci pentru că sunt prea
// multe combinații ca să le ții minte pe toate în timp ce sună telefonul.
//
// CUM ÎMPARTE, ȘI DE CE AȘA
//
//   1. POSTURILE GREU DE ACOPERIT SE DAU PRIMELE. Flexo e știut de un singur
//      om. Dacă îl pui pe Giri la extruder fiindcă acolo ai ajuns întâi cu
//      lista, flexo rămâne gol, deși exista o soluție în care mergeau
//      amândouă. De-aia sloturile se iau în ordinea numărului de candidați,
//      nu în ordinea utilajelor.
//
//   2. OMUL CU MAI PUȚINE CALIFICĂRI INTRĂ ÎNAINTEA CELUI POLIVALENT. Cine
//      știe șapte mașini e bun oriunde — deci e păcat să-l consumi pe prima.
//
//   3. NIMENI NU PRINDE ACELAȘI SCHIMB DOUĂ SĂPTĂMÂNI LA RÂND. Regula e a
//      lor, nu a mea. Nu e absolută: dacă altfel postul rămâne gol, se încalcă
//      — dar se SPUNE că s-a încălcat, pentru fiecare om în parte.
//
//   4. ÎNCĂRCAREA SE ÎMPARTE. Între doi oameni la fel de potriviți îl ia cel
//      cu mai puține zile lucrate în săptămâna propusă.
//
//   5. CINE ABIA ÎNVAȚĂ NU RĂMÂNE SINGUR pe un post, dacă există altcineva.
//
// CE NU FACE: nu promite optimul matematic. E o euristică, iar diferența
// contează mai puțin decât faptul că fiecare alegere poate fi explicată — un
// plan pe care șeful de tură nu-l înțelege nu se aplică, oricât ar fi de bun.
const S = require("./schimburi");

const cheieZi = (resursaId, data) => String(resursaId) + "|" + String(data).slice(0, 10);

// Motivele pentru care un post rămâne gol. Scrise în clar, fiindcă „nu s-a
// putut" nu ajută pe nimeni să rezolve: una e că n-ai pe cine califica, alta
// e că toți cei buni erau deja puși în ziua aia.
const MOTIVE = {
  NIMENI_CALIFICAT: "niciun om nu e trecut pe utilajul ăsta",
  NIMENI_DISPONIBIL: "cei calificați nu sunt disponibili în ziua asta",
  TOTI_OCUPATI: "toți cei calificați sunt deja puși în altă parte în ziua asta",
};

function propune(intrare) {
  const d = intrare || {};
  const zile = (d.zile || []).map((z) => String(z).slice(0, 10));
  const oameni = d.oameni || [];
  const disponibil = d.disponibil || {};
  const schimbAnterior = d.schimbAnterior || {};
  const ordineSchimburi = (d.schimburi && d.schimburi.length ? d.schimburi : ["S1", "S2", "S3"]).map(
    (x) => S.normalizeaza(x) || x
  );

  // Posturile cerute: utilaj + în câte schimburi merge.
  const posturi = (d.posturi || [])
    .map((p) => ({
      utilaj_id: Number(p.utilaj_id),
      cod: String(p.cod || ""),
      denumire: String(p.denumire || p.cod || ""),
      schimburi: Math.max(0, Math.min(ordineSchimburi.length, Math.round(Number(p.schimburi) || 0))),
      // Câți oameni stau pe utilaj într-un schimb. La AWB sunt doi („op. 1" și
      // „op. 2" în planul lor), la prestretch tot doi în tura de zi. Fără asta
      // propunerea ar pune un singur om acolo unde realitatea cere doi, iar
      // planul ar arăta acoperit fiind de fapt pe jumătate.
      pePost: Math.max(1, Math.min(6, Math.round(Number(p.pePost) || 1))),
    }))
    .filter((p) => p.utilaj_id && p.schimburi > 0);

  const dupaId = new Map(oameni.map((o) => [Number(o.id), o]));
  const stieUtilajul = (o, utilajId) => (o.competente || []).map(Number).includes(Number(utilajId));
  const nivelul = (o, utilajId) => Number((o.nivel || {})[utilajId] || (o.nivel || {})[String(utilajId)] || 2);

  const zilePePersoana = new Map(); // câte zile a prins fiecare în propunere
  const schimburiPrinse = new Map(); // resursaId -> Set de schimburi din propunere
  const incalcariRotatie = [];
  const rezultat = [];

  for (const data of zile) {
    const ocupatAzi = new Set();
    const sloturi = [];
    for (const p of posturi) {
      for (let i = 0; i < p.schimburi; i++) {
        for (let k = 0; k < p.pePost; k++) {
          sloturi.push({
            utilaj_id: p.utilaj_id, cod: p.cod, denumire: p.denumire,
            schimb: ordineSchimburi[i],
            pozitie: p.pePost > 1 ? k + 1 : 0,
          });
        }
      }
    }

    // Candidații fiecărui slot, înainte de orice alegere. Se recalculează pe
    // măsură ce oamenii se ocupă, dar ordinea sloturilor se fixează acum, după
    // cât de strâmt e fiecare.
    const calificatiPe = new Map();
    for (const p of posturi) {
      calificatiPe.set(
        p.utilaj_id,
        oameni.filter((o) => stieUtilajul(o, p.utilaj_id))
      );
    }
    const liberiPe = (utilajId) =>
      (calificatiPe.get(utilajId) || []).filter((o) => disponibil[cheieZi(o.id, data)]);

    sloturi.sort((a, b) => {
      const na = liberiPe(a.utilaj_id).length;
      const nb = liberiPe(b.utilaj_id).length;
      if (na !== nb) return na - nb;
      if (a.cod !== b.cod) return a.cod < b.cod ? -1 : 1;
      return ordineSchimburi.indexOf(a.schimb) - ordineSchimburi.indexOf(b.schimb);
    });

    for (const slot of sloturi) {
      const calificati = calificatiPe.get(slot.utilaj_id) || [];
      const liberi = liberiPe(slot.utilaj_id);
      const candidati = liberi.filter((o) => !ocupatAzi.has(Number(o.id)));

      if (!candidati.length) {
        slot.resursa_id = null;
        slot.motiv = !calificati.length
          ? MOTIVE.NIMENI_CALIFICAT
          : !liberi.length
            ? MOTIVE.NIMENI_DISPONIBIL
            : MOTIVE.TOTI_OCUPATI;
        continue;
      }

      const scor = (o) => [
        // 1. să nu prindă același schimb ca săptămâna trecută
        S.normalizeaza(schimbAnterior[o.id]) === slot.schimb ? 1 : 0,
        // 2. cine a lucrat mai puțin în propunere
        zilePePersoana.get(Number(o.id)) || 0,
        // 3. cine abia învață intră ultimul
        nivelul(o, slot.utilaj_id) === 1 ? 1 : 0,
        // 4. cine știe mai puține mașini e consumat primul
        (o.competente || []).length,
        // 5. ca două rulări să dea același plan
        String(o.nume || o.id),
      ];
      candidati.sort((a, b) => {
        const sa = scor(a);
        const sb = scor(b);
        for (let i = 0; i < sa.length; i++) {
          if (sa[i] === sb[i]) continue;
          return sa[i] < sb[i] ? -1 : 1;
        }
        return 0;
      });

      const ales = candidati[0];
      slot.resursa_id = Number(ales.id);
      slot.nume = ales.nume;
      slot.nivel = nivelul(ales, slot.utilaj_id);
      slot.motiv = null;
      ocupatAzi.add(Number(ales.id));
      zilePePersoana.set(Number(ales.id), (zilePePersoana.get(Number(ales.id)) || 0) + 1);
      if (!schimburiPrinse.has(Number(ales.id))) schimburiPrinse.set(Number(ales.id), new Set());
      schimburiPrinse.get(Number(ales.id)).add(slot.schimb);
      if (S.normalizeaza(schimbAnterior[ales.id]) === slot.schimb) {
        incalcariRotatie.push({ data, resursa_id: Number(ales.id), nume: ales.nume, schimb: slot.schimb });
      }
    }

    // La afișare vrem ordinea firească (utilaj, apoi schimb), nu ordinea în
    // care a lucrat algoritmul.
    sloturi.sort((a, b) => {
      if (a.cod !== b.cod) return a.cod < b.cod ? -1 : 1;
      if (a.schimb !== b.schimb) return ordineSchimburi.indexOf(a.schimb) - ordineSchimburi.indexOf(b.schimb);
      return (a.pozitie || 0) - (b.pozitie || 0);
    });

    rezultat.push({
      data,
      sloturi,
      acoperite: sloturi.filter((s) => s.resursa_id).length,
      neacoperite: sloturi.filter((s) => !s.resursa_id).length,
      nefolositi: oameni
        .filter((o) => disponibil[cheieZi(o.id, data)] && !ocupatAzi.has(Number(o.id)))
        .map((o) => ({ id: Number(o.id), nume: o.nume })),
    });
  }

  // Programul pe om, exact în forma în care se scrie în „resurse_program".
  const program = [];
  for (const zi of rezultat) {
    for (const s of zi.sloturi) {
      if (!s.resursa_id) continue;
      program.push({
        resursa_id: s.resursa_id, data: zi.data, schimb: s.schimb,
        post: s.denumire + (s.pozitie ? " · op. " + s.pozitie : ""),
      });
    }
  }

  return {
    zile: rezultat,
    program,
    total: program.length,
    neacoperite: rezultat.reduce((n, z) => n + z.neacoperite, 0),
    incalcariRotatie,
    zilePePersoana: Object.fromEntries(zilePePersoana),
    // Cine prinde două schimburi diferite în aceeași săptămână. Nu e interzis,
    // dar e obositor și merită văzut înainte, nu reclamat după.
    schimburiAmestecate: [...schimburiPrinse.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([id, set]) => ({ resursa_id: id, nume: (dupaId.get(id) || {}).nume, schimburi: [...set] })),
  };
}

module.exports = { propune, MOTIVE, cheieZi };
