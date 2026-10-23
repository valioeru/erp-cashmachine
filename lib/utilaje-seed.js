"use strict";
// Scrierea fisei tehnice in baza, la pornire.
//
// REGULA DE AUR A ACESTUI FISIER: pune doar ce LIPSESTE, nu rescrie nimic.
//
// Datele vin dintr-un fisier Excel (lib/utilaje-date.js). Daca seed-ul ar
// face UPDATE, atunci fiecare repornire a aplicatiei ar sterge corecturile
// facute de oameni in ERP si le-ar pune la loc pe cele din Excel — iar omul
// care a corectat o grosime maxima gresita ar gasi-o gresita a doua zi,
// fara sa inteleaga de ce. Asa ca:
//
//   • un utilaj care exista deja (dupa cod) nu se atinge;
//   • un parametru care exista deja (utilaj + cod) nu se rescrie;
//   • completarea campurilor goale pe un utilaj existent se face DOAR acolo
//     unde coloana e NULL — adica se umple un gol, nu se schimba o valoare.
//
// Ce se intampla la a doua pornire: nimic. Asta e si testul.

const db = require("./db");
const D = require("./utilaje-date");

function nr(v) {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(String(v).replace(",", "."));
  return isFinite(x) ? x : null;
}
function txt(v) {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? null : s;
}
function intreg(v) {
  const x = nr(v);
  return x == null ? null : Math.round(x);
}

// Codurile de utilaj din fisier (UT01…UT15) → id-urile din baza.
async function hartaUtilaje() {
  const randuri = await db.prepare("SELECT id, cod FROM utilaje WHERE cod IS NOT NULL").all();
  const h = new Map();
  for (const r of randuri) h.set(String(r.cod).trim().toUpperCase(), Number(r.id));
  return h;
}

async function seed() {
  let puse = {
    utilaje: 0, parametri: 0, setup: 0, reguli: 0, consumabile: 0, cilindri: 0, rute: 0,
    fluxuri: 0, pasi: 0, produse: 0, legaturi: 0, norme: 0, formule: 0, deschise: 0,
  };

  // --- 1. Utilajele ------------------------------------------------------
  for (const u of D.UTILAJE) {
    const cod = txt(u.utilaj_id);
    if (!cod) continue;
    const exista = await db.prepare("SELECT id FROM utilaje WHERE upper(cod) = upper(?)").get(cod);
    if (exista) {
      // Utilajul exista deja (scris de mana, inainte sa avem fisa). Se umplu
      // DOAR golurile: COALESCE pastreaza ce e scris acolo.
      await db
        .prepare(
          `UPDATE utilaje SET
             scop = COALESCE(scop, ?), categorie = COALESCE(categorie, ?),
             regim_lucru = COALESCE(regim_lucru, ?),
             timp_disponibil_schimb_min = COALESCE(timp_disponibil_schimb_min, ?),
             schimburi_zi = COALESCE(schimburi_zi, ?),
             nr_helperi = COALESCE(nr_helperi, ?),
             consum_kw = COALESCE(consum_kw, ?), consum_alt = COALESCE(consum_alt, ?),
             status_date = COALESCE(status_date, ?), observatii = COALESCE(observatii, ?)
           WHERE id = ?`
        )
        .run(
          txt(u.scop), txt(u.categorie), txt(u.regim_lucru), nr(u.timp_disponibil_schimb_min),
          nr(u.schimburi_zi), intreg(u.nr_helperi), nr(u.consum_kw), txt(u.consum_alt),
          txt(u.status_date), txt(u.observatii), exista.id
        );
      continue;
    }
    // ore_pe_zi se deduce din timpul pe schimb si numarul de schimburi: 480
    // de minute × 3 schimburi la extruder inseamna 24 de ore, nu 8. Restul
    // modulului (planificarea) citeste ore_pe_zi, deci trebuie sa fie adevarat.
    const minPeSchimb = nr(u.timp_disponibil_schimb_min);
    const schimburi = nr(u.schimburi_zi) || 1;
    const orePeZi = minPeSchimb ? Math.round(((minPeSchimb * schimburi) / 60) * 100) / 100 : 8;
    await db
      .prepare(
        `INSERT INTO utilaje (cod, denumire, descriere, operatori_necesari, ore_pe_zi, activ,
                              scop, categorie, regim_lucru, timp_disponibil_schimb_min, schimburi_zi,
                              nr_helperi, consum_kw, consum_alt, status_date, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cod, txt(u.nume) || cod, txt(u.scop),
        intreg(u.nr_operatori) == null ? 1 : intreg(u.nr_operatori),
        orePeZi,
        // UT14 e in STANDBY, fara date tehnice. Intra in lista ca sa se stie
        // ca exista, dar inactiv — ca sa nu se aloce comenzi pe el.
        String(u.status_date || "").toUpperCase() === "STANDBY" ? 0 : 1,
        txt(u.scop), txt(u.categorie), txt(u.regim_lucru), minPeSchimb, nr(u.schimburi_zi),
        intreg(u.nr_helperi), nr(u.consum_kw), txt(u.consum_alt), txt(u.status_date), txt(u.observatii)
      );
    puse.utilaje++;
  }

  const harta = await hartaUtilaje();
  const idUtilaj = (cod) => harta.get(String(cod || "").trim().toUpperCase()) || null;

  // --- 2. Parametrii tehnici ---------------------------------------------
  for (const p of D.PARAMETRI) {
    const uid = idUtilaj(p.utilaj_id);
    const cod = txt(p.parametru_cod);
    if (!uid || !cod) continue;
    const e = await db.prepare("SELECT id FROM utilaje_parametri WHERE utilaj_id = ? AND parametru_cod = ?").get(uid, cod);
    if (e) continue;
    await db
      .prepare(
        `INSERT INTO utilaje_parametri (utilaj_id, parametru_cod, parametru, valoare_num, valoare_text,
                                        unitate, sursa, confirmat, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uid, cod, txt(p.parametru), nr(p.valoare_num), txt(p.valoare_text), txt(p.unitate),
           txt(p.sursa), txt(p.confirmat), txt(p.observatii));
    puse.parametri++;
  }

  // --- 3. Timpii de setup -------------------------------------------------
  for (const s of D.SETUP) {
    const uid = idUtilaj(s.utilaj_id);
    const cod = txt(s.eveniment_cod);
    if (!uid || !cod) continue;
    const e = await db.prepare("SELECT id FROM utilaje_setup WHERE utilaj_id = ? AND eveniment_cod = ?").get(uid, cod);
    if (e) continue;
    await db
      .prepare(
        `INSERT INTO utilaje_setup (utilaj_id, eveniment_cod, descriere, durata_min, frecventa,
                                    interval_valoare, interval_unitate, sursa, confirmat, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uid, cod, txt(s.descriere), nr(s.durata_min), txt(s.frecventa), nr(s.interval_valoare),
           txt(s.interval_unitate), txt(s.sursa), txt(s.confirmat), txt(s.observatii));
    puse.setup++;
  }

  // --- 4. Regulile de alocare ---------------------------------------------
  for (const r of D.REGULI) {
    const cod = txt(r.regula_id);
    if (!cod) continue;
    const e = await db.prepare("SELECT id FROM utilaje_reguli WHERE regula_cod = ?").get(cod);
    if (e) continue;
    await db
      .prepare("INSERT INTO utilaje_reguli (regula_cod, tip, domeniu, conditie, actiune, utilaje, sursa) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(cod, txt(r.tip), txt(r.domeniu), txt(r.conditie), txt(r.actiune), txt(r.utilaje), txt(r.sursa));
    puse.reguli++;
  }

  // --- 5. Consumabile si scule --------------------------------------------
  for (const c of D.CONSUMABILE) {
    const uid = idUtilaj(c.utilaj_id);
    const den = txt(c.denumire);
    if (!uid || !den) continue;
    const e = await db.prepare("SELECT id FROM utilaje_consumabile WHERE utilaj_id = ? AND denumire = ?").get(uid, den);
    if (e) continue;
    await db
      .prepare("INSERT INTO utilaje_consumabile (utilaj_id, tip, denumire, observatii) VALUES (?, ?, ?, ?)")
      .run(uid, txt(c.tip), den, txt(c.observatii));
    puse.consumabile++;
  }

  // --- 6. Cilindrii flexo --------------------------------------------------
  for (const c of D.CILINDRI) {
    const circ = nr(c.circumferinta_mm);
    if (circ == null) continue;
    const e = await db.prepare("SELECT id FROM cilindri_flexo WHERE circumferinta_mm = ?").get(circ);
    if (e) continue;
    await db
      .prepare("INSERT INTO cilindri_flexo (circumferinta_mm, bucati, max_culori, observatii) VALUES (?, ?, ?, ?)")
      .run(circ, intreg(c.bucati) || 0, intreg(c.max_culori), txt(c.observatii));
    puse.cilindri++;
  }

  // --- 7. Rutele produs × utilaj -------------------------------------------
  for (const r of D.RUTE) {
    const cod = txt(r.ruta_id);
    if (!cod) continue;
    const e = await db.prepare("SELECT id FROM utilaje_rute WHERE ruta_cod = ?").get(cod);
    if (e) continue;
    await db
      .prepare(
        `INSERT INTO utilaje_rute (ruta_cod, produs_cod, utilaj_id, descriere, unitate, timp_disponibil_min,
                                   timp_mort_fix_min, viteza_plan_unit_min, viteza_max_unit_min,
                                   rola1_unitati, rola1_schimb_min, rola2_unitati, rola2_schimb_min,
                                   rola3_unitati, rola3_schimb_min, min_schimbari_per_unit,
                                   capacitate_calculata_schimb, capacitate_declarata_schimb,
                                   capacitate_plan_schimb, masa_bucata_kg, capacitate_plan_buc_schimb,
                                   setup_comanda_min, prioritate, sursa, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cod, txt(r.produs_id), idUtilaj(r.utilaj_id), txt(r.descriere), txt(r.unitate),
        nr(r.timp_disponibil_min), nr(r.timp_mort_fix_min), nr(r.viteza_plan_unit_min), nr(r.viteza_max_unit_min),
        nr(r.rola1_unitati), nr(r.rola1_schimb_min), nr(r.rola2_unitati), nr(r.rola2_schimb_min),
        nr(r.rola3_unitati), nr(r.rola3_schimb_min), nr(r.min_schimbari_per_unit),
        nr(r.capacitate_calculata_schimb), nr(r.capacitate_declarata_schimb), nr(r.capacitate_plan_schimb),
        nr(r.masa_bucata_kg), nr(r.capacitate_plan_buc_schimb), nr(r.setup_comanda_min),
        intreg(r.prioritate), txt(r.sursa), txt(r.observatii)
      );
    puse.rute++;
  }

  // --- 8. Fluxurile tehnologice --------------------------------------------
  // Fisierul are o linie per PAS. Fluxul in sine se naste din codul lor.
  const denumiriFlux = {
    "F-PUNGA": "Pungă curier",
    "F-SAC-SGR": "Sac SGR / Fresful",
    "F-AWB": "Plic AWB",
    "F-CUTIE-AM": "Cutie americană",
    "F-CUTIE-SIMPLA": "Cutie simplă",
    "F-SAC-MENAJ": "Sac menajer",
    "F-BANDA": "Bandă adezivă",
    "F-STRETCH-PRE": "Stretch prestretch",
    "F-STRETCH-MAN": "Stretch manual",
    "F-STRETCH-AUT": "Stretch automat",
    "F-FOLIE-DEBITATA": "Folie debitată",
    "F-ETICHETE": "Etichete autoadezive",
  };
  const fluxId = new Map();
  for (const p of D.FLUXURI) {
    const cod = txt(p.flux_id);
    if (!cod || fluxId.has(cod)) continue;
    let f = await db.prepare("SELECT id FROM fluxuri WHERE cod = ?").get(cod);
    if (!f) {
      const ins = await db
        .prepare("INSERT INTO fluxuri (cod, denumire, familie, activ) VALUES (?, ?, ?, 1) RETURNING id")
        .run(cod, denumiriFlux[cod] || cod, cod.replace(/^F-/, ""));
      f = { id: ins.lastInsertRowid };
      puse.fluxuri++;
    }
    fluxId.set(cod, Number(f.id));
  }
  for (const p of D.FLUXURI) {
    const cod = txt(p.flux_id);
    const fid = fluxId.get(cod);
    const pas = intreg(p.pas_nr);
    if (!fid || pas == null) continue;
    const e = await db.prepare("SELECT id FROM fluxuri_pasi WHERE flux_id = ? AND pas_nr = ?").get(fid, pas);
    if (e) continue;
    // „UT10|UT11" inseamna doua utilaje alternative: codul se pastreaza intreg,
    // iar utilaj_id se completeaza doar cand pasul merge pe unul singur.
    const codUtilaj = txt(p.utilaj_id);
    const unul = codUtilaj && !codUtilaj.includes("|") ? idUtilaj(codUtilaj) : null;
    await db
      .prepare(
        "INSERT INTO fluxuri_pasi (flux_id, pas_nr, utilaj_cod, utilaj_id, operatie, tip_pas, conditie) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(fid, pas, codUtilaj, unul, txt(p.operatie), txt(p.tip_pas) || "OBLIGATORIU", txt(p.conditie));
    puse.pasi++;
  }

  // --- 9. Formatele de produs din fisa ------------------------------------
  // In tabelul LOR, nu in nomenclator: codurile fisei (P-PG-300x400) nu sunt
  // codurile din nomenclator, iar turnate acolo ar face 22 de dubluri peste
  // produse reale. Si oricum randurile astea nu descriu ce vindem, ci cum se
  // face: latimea foliei desfasurate, masa pe bucata, ce cilindru trebuie.
  for (const p of D.PRODUSE_FISA) {
    const cod = txt(p.produs_id);
    if (!cod) continue;
    const e = await db.prepare("SELECT id FROM produse_fisa WHERE produs_cod = ?").get(cod);
    if (e) continue;
    await db
      .prepare(
        `INSERT INTO produse_fisa (produs_cod, familie, denumire, latime_mm, inaltime_mm, clapa_mm, grosime_um,
                                   densitate_g_cm3, folie_pliata, latime_folie_desfasurata_mm, latime_la_print_mm,
                                   masa_folie_g_buc, buc_per_cutie, cilindru_flexo_mm, buc_per_rotatie,
                                   max_culori_print, imprimabil, utilaje_permise, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cod, txt(p.familie), txt(p.denumire), nr(p.latime_mm), nr(p.inaltime_mm), nr(p.clapa_mm), nr(p.grosime_um),
        nr(p.densitate_g_cm3), txt(p.folie_pliata), nr(p.latime_folie_desfasurata_mm), nr(p.latime_la_print_mm),
        nr(p.masa_folie_g_buc), nr(p.buc_per_cutie), nr(p.cilindru_flexo_mm), nr(p.buc_per_rotatie),
        nr(p.max_culori_print), txt(p.imprimabil), txt(p.utilaje_permise), txt(p.observatii)
      );
    puse.produse = (puse.produse || 0) + 1;
  }

  // Legatura cu nomenclatorul, acolo unde exista deja un produs cu acelasi
  // cod sau cu aceeasi denumire. Nu se inventeaza produse: daca nu se
  // gaseste, randul ramane nelegat si se vede pe pagina.
  const neLegate = await db.prepare("SELECT id, produs_cod, denumire FROM produse_fisa WHERE produs_id IS NULL").all();
  for (const f of neLegate) {
    const gasit =
      (await db.prepare("SELECT id FROM produse WHERE upper(cod) = upper(?)").get(f.produs_cod)) ||
      (f.denumire ? await db.prepare("SELECT id FROM produse WHERE lower(denumire) = lower(?)").get(f.denumire) : null);
    if (gasit) {
      await db.prepare("UPDATE produse_fisa SET produs_id = ? WHERE id = ?").run(gasit.id, f.id);
      puse.legaturi = (puse.legaturi || 0) + 1;
    }
  }

  // --- 10. Normele de consum ----------------------------------------------
  for (const n of D.NORME) {
    const cod = txt(n.produs_id);
    const material = txt(n.material);
    if (!cod || !material) continue;
    const e = await db.prepare("SELECT id FROM norme_consum WHERE produs_cod = ? AND material = ?").get(cod, material);
    if (e) continue;
    await db
      .prepare(
        "INSERT INTO norme_consum (produs_cod, material, tip, cantitate, unitate, per, sursa, observatii) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(cod, material, txt(n.tip), nr(n.cantitate), txt(n.unitate), txt(n.per), txt(n.sursa), txt(n.observatii));
    puse.norme = (puse.norme || 0) + 1;
  }

  // --- 11. Formulele, scrise in clar --------------------------------------
  for (const f of D.FORMULE) {
    const cod = txt(f.formula_id);
    if (!cod) continue;
    const e = await db.prepare("SELECT id FROM formule_productie WHERE cod = ?").get(cod);
    if (e) continue;
    await db
      .prepare("INSERT INTO formule_productie (cod, denumire, expresie, folosita_in) VALUES (?, ?, ?, ?)")
      .run(cod, txt(f.denumire), txt(f.expresie), txt(f.folosita_in));
    puse.formule = (puse.formule || 0) + 1;
  }

  // --- 12. Ce nu se stie inca ---------------------------------------------
  for (const x of D.DESCHISE) {
    const cod = txt(x.id);
    if (!cod) continue;
    const e = await db.prepare("SELECT id FROM intrebari_deschise WHERE cod = ?").get(cod);
    if (e) continue;
    await db
      .prepare("INSERT INTO intrebari_deschise (cod, referinta, descriere, rezolvata) VALUES (?, ?, ?, 0)")
      .run(cod, txt(x.referinta), txt(x.descriere));
    puse.deschise = (puse.deschise || 0) + 1;
  }

  const total = Object.values(puse).reduce((a, b) => a + b, 0);
  if (total) {
    console.log(
      "[utilaje] fisa tehnica: " +
        Object.entries(puse).filter(([, v]) => v).map(([k, v]) => v + " " + k).join(", ")
    );
  }
  return puse;
}

module.exports = { seed };
