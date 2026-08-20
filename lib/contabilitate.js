"use strict";
// Motorul de contabilitate în partidă dublă.
//
// ERP-ul ține documente (facturi, plăți, salarii), nu note contabile. Modulul
// ăsta traduce documentele în înregistrări contabile pe planul de conturi
// românesc, ca să se poată scoate o balanță de verificare reală.
//
// Principiul de bază: înregistrările "auto" sunt DERIVATE, nu introduse.
// Regenerarea le șterge pe toate și le reconstruiește din documente. Așa nu
// pot rămâne desincronizate față de facturi, și nu contează de câte ori
// rulezi. Notele introduse manual și soldurile inițiale au sursă diferită și
// NU se ating la regenerare.
//
// Ce NU postează automat (intenționat):
//   - mișcările de stoc importate din SmartBill. Stocul inițial importat nu
//     are factură de achiziție în ERP; dacă l-am posta pe 371, contul ar
//     ajunge dublat față de facturile de achiziție, sau negativ. Mai bine
//     lipsă și declarat decât prezent și greșit.
//   - amortizări, provizioane, închideri de TVA și de lună — sunt operațiuni
//     de contabil, se introduc ca note manuale.

const db = require("./db");
const { CONTURI, CONTURI_IMPLICITE, clasa, grupa } = require("./plan-conturi");

const BANI = (x) => Math.round((Number(x) || 0) * 100) / 100;

// --- planul de conturi ------------------------------------------------------

async function asiguraPlanConturi() {
  const existente = (await db.prepare("SELECT COUNT(*) AS n FROM plan_conturi").get()).n;
  if (Number(existente) > 0) return 0;
  for (let i = 0; i < CONTURI.length; i += 100) {
    const lot = CONTURI.slice(i, i + 100);
    const ph = lot.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const args = [];
    for (const [simbol, denumire, functiune] of lot) args.push(simbol, denumire, functiune, clasa(simbol), grupa(simbol));
    await db.prepare(`INSERT INTO plan_conturi (simbol, denumire, functiune, clasa, grupa) VALUES ${ph}`).run(...args);
  }
  return CONTURI.length;
}

async function hartaConturi() {
  const randuri = await db.prepare("SELECT simbol, denumire, functiune FROM plan_conturi").all();
  return new Map(randuri.map((r) => [r.simbol, r]));
}

// --- construirea unei note contabile ---------------------------------------

// O notă = mai multe linii care TREBUIE să se echilibreze (Σdebit = Σcredit).
// Dacă din rotunjiri rămâne o diferență de bani, o trimitem pe 473
// „Decontări din operațiuni în curs de clarificare" — exact rolul contului.
// Alternativa (a lăsa nota dezechilibrată) ar strica balanța în tăcere.
function echilibreaza(linii, context) {
  let d = 0;
  let c = 0;
  for (const l of linii) {
    d += l.debit || 0;
    c += l.credit || 0;
  }
  const dif = BANI(d - c);
  if (dif === 0) return linii;
  if (Math.abs(dif) <= 0.05) {
    linii.push({
      cont: CONTURI_IMPLICITE.clarificare,
      debit: dif < 0 ? Math.abs(dif) : 0,
      credit: dif > 0 ? dif : 0,
      explicatie: `Diferență de rotunjire (${context})`,
    });
    return linii;
  }
  // Diferență mare = eroare de date, nu rotunjire. O ducem tot pe 473, dar
  // marcată explicit, ca să sară în ochi în fișa contului.
  linii.push({
    cont: CONTURI_IMPLICITE.clarificare,
    debit: dif < 0 ? Math.abs(dif) : 0,
    credit: dif > 0 ? dif : 0,
    explicatie: `DE VERIFICAT — document neechilibrat (${context})`,
  });
  return linii;
}

// --- regenerarea completă ---------------------------------------------------

async function regenereaza(declansatDe = "manual") {
  const t0 = Date.now();
  await asiguraPlanConturi();

  const C = { ...CONTURI_IMPLICITE };
  const linii = [];
  let documente = 0;

  const adauga = (notaId, data, set, meta) => {
    for (const l of echilibreaza(set, meta.explicatie)) {
      const debit = BANI(l.debit);
      const credit = BANI(l.credit);
      if (debit === 0 && credit === 0) continue;
      linii.push({
        nota_id: notaId,
        data,
        cont: l.cont,
        debit,
        credit,
        explicatie: l.explicatie || meta.explicatie,
        document_tip: meta.tip,
        document_id: meta.id,
        partener_id: meta.partenerId || null,
      });
    }
    documente++;
  };

  // 1. Facturi (vânzare şi achiziţie), cu totalul calculat din linii.
  const facturi = await db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.document_extern, f.directie, f.data_emiterii, f.partener_id, p.nume AS partener_nume,
              COALESCE(l.net, 0) AS net, COALESCE(l.tva, 0) AS tva
       FROM facturi f
       JOIN parteneri p ON p.id = f.partener_id
       LEFT JOIN (
         SELECT factura_id,
                SUM(cantitate * pret_unitar) AS net,
                SUM(cantitate * pret_unitar * COALESCE(cota_tva,0) / 100.0) AS tva
         FROM facturi_linii GROUP BY factura_id
       ) l ON l.factura_id = f.id
       WHERE f.status <> 'anulata'`
    )
    .all();

  for (const f of facturi) {
    const data = (f.data_emiterii || "").slice(0, 10);
    if (!data) continue;
    const net = BANI(f.net);
    const tva = BANI(f.tva);
    const total = BANI(net + tva);
    const doc = f.document_extern || `${f.serie}-${f.numar}`;

    if (f.directie === "achizitie") {
      adauga(
        `ACH-${f.id}`,
        data,
        [
          { cont: C.marfuri, debit: net, credit: 0 },
          { cont: C.tvaDeductibila, debit: tva, credit: 0 },
          { cont: C.furnizori, debit: 0, credit: total },
        ],
        { tip: "factura_achizitie", id: f.id, partenerId: f.partener_id, explicatie: `Factură achiziție ${doc} — ${f.partener_nume}` }
      );
    } else {
      adauga(
        `VNZ-${f.id}`,
        data,
        [
          { cont: C.clienti, debit: total, credit: 0 },
          { cont: C.venitMarfuri, debit: 0, credit: net },
          { cont: C.tvaColectata, debit: 0, credit: tva },
        ],
        { tip: "factura_vanzare", id: f.id, partenerId: f.partener_id, explicatie: `Factură ${doc} — ${f.partener_nume}` }
      );
    }
  }

  // 2. Plăţi (încasări de la clienţi / plăţi către furnizori).
  const plati = await db
    .prepare(
      `SELECT pl.id, pl.factura_id, pl.suma, pl.data, pl.metoda, f.directie, f.serie, f.numar, f.document_extern,
              f.partener_id, p.nume AS partener_nume
       FROM plati pl
       JOIN facturi f ON f.id = pl.factura_id
       JOIN parteneri p ON p.id = f.partener_id
       WHERE f.status <> 'anulata'`
    )
    .all();

  for (const pl of plati) {
    const data = (pl.data || "").slice(0, 10);
    if (!data) continue;
    const suma = BANI(pl.suma);
    if (suma === 0) continue;
    const doc = pl.document_extern || `${pl.serie}-${pl.numar}`;
    // Numerarul merge pe casă, restul pe bancă. Metoda "import" vine din
    // reconstituirea plăţilor pe baza statusului din SmartBill — nu ştim prin
    // ce a intrat banul, deci îl punem pe bancă (cazul dominant).
    const contTrezorerie = /numerar|cash|casa/i.test(pl.metoda || "") ? C.casa : C.banca;

    if (pl.directie === "achizitie") {
      adauga(
        `PLT-${pl.id}`,
        data,
        [
          { cont: C.furnizori, debit: suma, credit: 0 },
          { cont: contTrezorerie, debit: 0, credit: suma },
        ],
        { tip: "plata_furnizor", id: pl.id, partenerId: pl.partener_id, explicatie: `Plată furnizor ${doc} — ${pl.partener_nume}` }
      );
    } else {
      adauga(
        `INC-${pl.id}`,
        data,
        [
          { cont: contTrezorerie, debit: suma, credit: 0 },
          { cont: C.clienti, debit: 0, credit: suma },
        ],
        { tip: "incasare", id: pl.id, partenerId: pl.partener_id, explicatie: `Încasare ${doc} — ${pl.partener_nume}` }
      );
    }
  }

  // 3. Salarii — se postează în ultima zi a lunii de stat.
  const salarii = await db
    .prepare(
      `SELECT s.id, s.luna, s.salariu_brut, s.bonusuri, s.cas, s.cass, s.impozit, s.salariu_net, a.nume AS angajat
       FROM salarii s JOIN angajati a ON a.id = s.angajat_id`
    )
    .all();

  for (const s of salarii) {
    const luna = String(s.luna || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(luna)) continue;
    const [an, mn] = luna.split("-").map(Number);
    const data = new Date(Date.UTC(an, mn, 0)).toISOString().slice(0, 10); // ultima zi din lună
    const brut = BANI(Number(s.salariu_brut) + Number(s.bonusuri || 0));
    adauga(
      `SAL-${s.id}`,
      data,
      [
        { cont: C.cheltuialaSalarii, debit: brut, credit: 0 },
        { cont: C.salariiDatorate, debit: 0, credit: BANI(s.salariu_net) },
        { cont: C.cas, debit: 0, credit: BANI(s.cas) },
        { cont: C.cass, debit: 0, credit: BANI(s.cass) },
        { cont: C.impozitSalarii, debit: 0, credit: BANI(s.impozit) },
      ],
      { tip: "stat_salarii", id: s.id, explicatie: `Salarii ${luna} — ${s.angajat}` }
    );
  }

  // --- scrierea în bază ----------------------------------------------------
  // Ştergem doar înregistrările "auto"; soldurile iniţiale şi notele manuale
  // rămân neatinse.
  await db.prepare("DELETE FROM inregistrari_contabile WHERE sursa = 'auto'").run();

  for (let i = 0; i < linii.length; i += 300) {
    const lot = linii.slice(i, i + 300);
    const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')").join(", ");
    const args = [];
    for (const l of lot) args.push(l.nota_id, l.data, l.cont, l.debit, l.credit, l.explicatie, l.document_tip, l.document_id, l.partener_id);
    await db
      .prepare(
        `INSERT INTO inregistrari_contabile (nota_id, data, cont, debit, credit, explicatie, document_tip, document_id, partener_id, sursa) VALUES ${ph}`
      )
      .run(...args);
  }

  const durata = Date.now() - t0;
  await db
    .prepare("INSERT INTO contabilitate_rulari (linii_generate, documente, durata_ms, declansat_de) VALUES (?, ?, ?, ?)")
    .run(linii.length, documente, durata, declansatDe);

  return { linii: linii.length, documente, durataMs: durata };
}

// --- balanţa de verificare --------------------------------------------------

// Întoarce balanţa pentru intervalul [deLa, panaLa], în forma clasică cu patru
// serii de coloane: solduri iniţiale, rulaje ale perioadei, total sume,
// solduri finale — plus totalurile de control.
async function balanta(deLa, panaLa, doarCuMiscari = true) {
  const randuri = await db
    .prepare(
      `SELECT i.cont,
              SUM(CASE WHEN i.data < ? THEN i.debit ELSE 0 END) AS di,
              SUM(CASE WHEN i.data < ? THEN i.credit ELSE 0 END) AS ci,
              SUM(CASE WHEN i.data >= ? AND i.data <= ? THEN i.debit ELSE 0 END) AS dp,
              SUM(CASE WHEN i.data >= ? AND i.data <= ? THEN i.credit ELSE 0 END) AS cp,
              COUNT(*) AS nr
       FROM inregistrari_contabile i
       WHERE i.data <= ?
       GROUP BY i.cont
       ORDER BY i.cont`
    )
    .all(deLa, deLa, deLa, panaLa, deLa, panaLa, panaLa);

  const plan = await hartaConturi();
  const conturi = [];
  const total = { siD: 0, siC: 0, rD: 0, rC: 0, tsD: 0, tsC: 0, sfD: 0, sfC: 0 };

  for (const r of randuri) {
    const netInitial = BANI(Number(r.di) - Number(r.ci));
    const siD = netInitial > 0 ? netInitial : 0;
    const siC = netInitial < 0 ? -netInitial : 0;
    const rD = BANI(r.dp);
    const rC = BANI(r.cp);
    const tsD = BANI(siD + rD);
    const tsC = BANI(siC + rC);
    const netFinal = BANI(tsD - tsC);
    const sfD = netFinal > 0 ? netFinal : 0;
    const sfC = netFinal < 0 ? -netFinal : 0;

    if (doarCuMiscari && siD === 0 && siC === 0 && rD === 0 && rC === 0) continue;

    const info = plan.get(r.cont) || { denumire: "(cont necunoscut în planul de conturi)", functiune: "B" };
    conturi.push({
      cont: r.cont,
      denumire: info.denumire,
      functiune: info.functiune,
      clasa: clasa(r.cont),
      siD,
      siC,
      rD,
      rC,
      tsD,
      tsC,
      sfD,
      sfC,
      nr: Number(r.nr),
    });
    total.siD += siD;
    total.siC += siC;
    total.rD += rD;
    total.rC += rC;
    total.tsD += tsD;
    total.tsC += tsC;
    total.sfD += sfD;
    total.sfC += sfC;
  }

  for (const k of Object.keys(total)) total[k] = BANI(total[k]);

  // Verificările care dau numele raportului. Toleranţa de un ban acoperă
  // rotunjirile de afişare; orice peste înseamnă o problemă reală.
  const verificari = [
    { nume: "Total solduri inițiale debitoare = creditoare", d: total.siD, c: total.siC },
    { nume: "Total rulaje debitoare = creditoare", d: total.rD, c: total.rC },
    { nume: "Total sume debitoare = creditoare", d: total.tsD, c: total.tsC },
    { nume: "Total solduri finale debitoare = creditoare", d: total.sfD, c: total.sfC },
  ].map((v) => ({ ...v, diferenta: BANI(v.d - v.c), ok: Math.abs(BANI(v.d - v.c)) <= 0.01 }));

  return { conturi, total, verificari, deLa, panaLa };
}

// Fişa unui cont: toate înregistrările din interval, cu sold curent rulant.
async function fisaCont(cont, deLa, panaLa) {
  const initial = await db
    .prepare("SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM inregistrari_contabile WHERE cont = ? AND data < ?")
    .get(cont, deLa);
  const miscari = await db
    .prepare(
      `SELECT i.*, p.nume AS partener_nume
       FROM inregistrari_contabile i
       LEFT JOIN parteneri p ON p.id = i.partener_id
       WHERE i.cont = ? AND i.data >= ? AND i.data <= ?
       ORDER BY i.data ASC, i.id ASC
       LIMIT 500`
    )
    .all(cont, deLa, panaLa);

  let sold = BANI(Number(initial.d) - Number(initial.c));
  const soldInitial = sold;
  for (const m of miscari) {
    sold = BANI(sold + Number(m.debit) - Number(m.credit));
    m.sold = sold;
  }
  const plan = await hartaConturi();
  return { cont, info: plan.get(cont) || null, soldInitial, soldFinal: sold, miscari };
}

// Evoluţia zilnică a soldului unor conturi — pentru graficul „balanţa la zi".
async function evolutieZilnica(conturi, deLa, panaLa) {
  const ph = conturi.map(() => "?").join(",");
  const initiale = await db
    .prepare(`SELECT cont, COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS net FROM inregistrari_contabile WHERE cont IN (${ph}) AND data < ? GROUP BY cont`)
    .all(...conturi, deLa);
  const zilnic = await db
    .prepare(
      `SELECT data, cont, COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS net
       FROM inregistrari_contabile WHERE cont IN (${ph}) AND data >= ? AND data <= ?
       GROUP BY data, cont ORDER BY data ASC`
    )
    .all(...conturi, deLa, panaLa);

  const sold = Object.fromEntries(conturi.map((c) => [c, 0]));
  for (const r of initiale) sold[r.cont] = BANI(r.net);

  const peZi = new Map();
  for (const r of zilnic) {
    if (!peZi.has(r.data)) peZi.set(r.data, {});
    peZi.get(r.data)[r.cont] = BANI((peZi.get(r.data)[r.cont] || 0) + Number(r.net));
  }

  const rezultat = [];
  for (const [zi, miscari] of [...peZi.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const c of conturi) sold[c] = BANI(sold[c] + (miscari[c] || 0));
    rezultat.push({ zi, solduri: { ...sold } });
  }
  return rezultat;
}

module.exports = { regenereaza, balanta, fisaCont, evolutieZilnica, asiguraPlanConturi, hartaConturi, BANI, CONTURI_IMPLICITE };
