"use strict";
// Costul mărfii vândute — într-un singur loc.
//
// De ce există fișierul ăsta: până acum formula era copiată în trei module
// (CRM, rapoarte, decont) și suna așa: „costul unei linii = cantitate ×
// prețul de achiziție scris pe produs". Când linia n-avea produs identificat,
// sau produsul n-avea preț de achiziție, costul ieșea ZERO — adică vânzarea
// aia intra în calcul cu marjă 100%. Cu o treime din liniile de factură în
// situația asta, marja firmei ieșea cu vreo șapte puncte mai bună decât spune
// contabilitatea (34,2% în ERP față de 27,5% în raportul „Profit pe produs").
//
// Acum costul se ia în patru trepte, în ordinea încrederii, și nu mai rămâne
// niciodată zero cât timp știm rata firmei:
//
//   1. RATA REALĂ A PRODUSULUI (`produse.cost_rata`) — cost ÷ vânzări nete,
//      luată din raportul „Profit pe produs" al contabilității. E costul
//      adevărat al mărfii, așa cum îl vede gestiunea, și se aplică pe valoarea
//      liniei. Merge și când același produs se vinde la prețuri diferite.
//   2. COSTUL DIN REȚETĂ (`produse.cost_reteta`) — pentru ce facem noi. Suma
//      componentelor, la cantitatea de pe o bucată. Nu depinde de cât s-a
//      vândut, deci există din prima zi a produsului, înainte să existe orice
//      raport de contabilitate despre el.
//   3. PREȚUL DE ACHIZIȚIE de pe produs, dacă e plauzibil. Prețul e static
//      (nu știe de scumpiri), dar e o cifră reală, scrisă de om.
//   4. RATA FIRMEI (`setari_app.cost_rata_firma`) — media pe toată firma din
//      același raport. E o estimare declarată ca atare, dar e infinit mai
//      aproape de adevăr decât zero.
//
// „Plauzibil" la treptele 2 și 3 înseamnă același prag cu verificarea „cost de
// marfă aberant" din modules/verificari.js: o linie cu cost de peste cinci ori
// mai mare decât ce s-a încasat pe ea (plus 100 de lei, ca să nu se agațe de
// fleacuri) nu e marjă proastă, e o greșeală de date — 1.720 de bucăți la 1 leu
// în loc de o rolă la 1.720 de lei. Astfel de linii cad la treapta următoare.
//
// Toate expresiile cer în interogare aliasurile `fl` (facturi_linii) și `pr`
// (produse, prin LEFT JOIN). Așa erau deja toate interogările de marjă.

const db = require("./db");

// Cost scris pe produs, dar de necrezut față de ce s-a facturat.
const ABERANT = "fl.cantitate * COALESCE(pr.pret_achizitie, 0) > 5 * (fl.cantitate * fl.pret_unitar) + 100";
const ARE_PRET_BUN = `COALESCE(pr.pret_achizitie, 0) > 0 AND NOT (${ABERANT})`;
const ARE_RATA = "COALESCE(pr.cost_rata, 0) > 0";
// Cost din rețetă: aceeași plasă de siguranță ca la prețul de achiziție — o
// rețetă strâmbă (unități amestecate) ar da un cost de zece ori mai mare decât
// vânzarea, iar aia nu e marjă proastă, e o greșeală de rețetă.
const RETETA_ABERANTA = "fl.cantitate * COALESCE(pr.cost_reteta, 0) > 5 * (fl.cantitate * fl.pret_unitar) + 100";
const ARE_RETETA = `COALESCE(pr.cost_reteta, 0) > 0 AND NOT (${RETETA_ABERANTA})`;

// Rata firmei se citește o dată și se ține în memorie: e o singură cifră,
// folosită în zeci de interogări pe pagină.
let _rata = null;

function uitaRata() {
  _rata = null;
}

async function rataFirma() {
  if (_rata !== null) return _rata;
  const r = await db
    .prepare("SELECT valoare FROM setari_app WHERE cheie = 'cost_rata_firma'")
    .get()
    .catch(() => null);
  const v = r ? Number(r.valoare) : 0;
  _rata = Number.isFinite(v) && v > 0 && v < 3 ? v : 0;
  return _rata;
}

// Expresia SQL a costului unei linii. Primește rata firmei ca număr, ca să nu
// facem o interogare în plus pentru fiecare loc din care se cheamă.
function costLinie(rata) {
  const r = Number(rata) > 0 && Number(rata) < 3 ? Number(rata) : 0;
  return `CASE
    WHEN ${ARE_RATA} THEN fl.cantitate * fl.pret_unitar * pr.cost_rata
    WHEN ${ARE_RETETA} THEN fl.cantitate * COALESCE(pr.cost_reteta, 0)
    WHEN ${ARE_PRET_BUN} THEN fl.cantitate * COALESCE(pr.pret_achizitie, 0)
    ELSE fl.cantitate * fl.pret_unitar * ${r}
  END`;
}

// Cât din venit are cost REAL în spate (treapta 1 sau 2) — restul e estimat cu
// rata firmei. Asta e cifra pe care o arătăm ca „acoperire", ca nimeni să nu
// citească o estimare drept măsurătoare.
const VENIT_CU_COST_REAL = `CASE WHEN ${ARE_RATA} OR (${ARE_RETETA}) OR (${ARE_PRET_BUN}) THEN fl.cantitate * fl.pret_unitar ELSE 0 END`;

// Câte linii sunt estimate (ultima treaptă, rata firmei).
const LINII_ESTIMATE = `CASE WHEN ${ARE_RATA} OR (${ARE_RETETA}) OR (${ARE_PRET_BUN}) THEN 0 ELSE 1 END`;

// Pe ce s-a sprijinit costul unei linii — pentru tabele care arată rând cu rând.
function temeiLinie(l) {
  if (Number(l && l.cost_rata) > 0) return "cost real din contabilitate";
  const venit = Number((l && l.cantitate) || 0) * Number((l && l.pret_unitar) || 0);
  const reteta = Number((l && l.cost_reteta) || 0);
  if (reteta > 0 && Number(l.cantitate) * reteta <= 5 * venit + 100) return "cost din rețeta produsului";
  const pret = Number((l && l.pret_achizitie) || 0);
  if (pret > 0 && Number(l.cantitate) * pret <= 5 * venit + 100) return "preț de achiziție de pe produs";
  return "estimat cu rata firmei";
}

// ---------------------------------------------------------------------------
// Recalculul ratelor din raportul „Profit pe produs".
//
// Raportul vine prin punte din SmartBill Gestiune și are, pe fiecare produs,
// vânzările nete și costul real al bunurilor vândute. Din ele iese rata: cât
// din fiecare leu vândut a fost marfă. Rata e mai bună decât un preț unitar
// fiindcă nu depinde de unitatea de măsură și nici de prețul la care s-a vândut
// unui client sau altuia.
//
// Rândurile cu vânzări zero sau cu rate imposibile (peste 3, adică ai fi vândut
// la sub o treime din cost) se sar — sunt greșeli de raport, nu marjă proastă.
async function recalculeazaRate() {
  const randuri = await db
    .prepare("SELECT produs_id, vanzari_nete, cost, perioada FROM profit_produs WHERE produs_id IS NOT NULL")
    .all()
    .catch(() => []);

  // Un produs poate apărea pe mai multe gestiuni în același raport: adunăm.
  const peProdus = new Map();
  for (const r of randuri) {
    const id = Number(r.produs_id);
    if (!id) continue;
    const g = peProdus.get(id) || { venit: 0, cost: 0, perioada: r.perioada || null };
    g.venit += Number(r.vanzari_nete) || 0;
    g.cost += Number(r.cost) || 0;
    peProdus.set(id, g);
  }

  let scrise = 0;
  for (const [id, g] of peProdus) {
    if (!(g.venit > 0) || !(g.cost > 0)) continue;
    const rata = g.cost / g.venit;
    if (!(rata > 0) || rata > 3) continue;
    await db
      .prepare("UPDATE produse SET cost_rata = ?, cost_rata_sursa = ? WHERE id = ?")
      .run(Math.round(rata * 100000) / 100000, g.perioada || null, id);
    scrise++;
  }

  // Rata firmei: din TOT raportul, inclusiv rândurile nelegate de un produs din
  // ERP. Ele n-au cui să-i dea o rată proprie, dar spun corect cât costă marfa
  // firmei în medie — exact ce ne trebuie pentru treapta 3.
  const t = await db
    .prepare("SELECT SUM(vanzari_nete) AS venit, SUM(cost) AS cost FROM profit_produs")
    .get()
    .catch(() => null);
  const venit = Number((t && t.venit) || 0);
  const cost = Number((t && t.cost) || 0);
  let rata = 0;
  if (venit > 0 && cost > 0) rata = Math.round((cost / venit) * 100000) / 100000;
  if (!(rata > 0) || rata >= 3) rata = 0;

  await scrieSetare("cost_rata_firma", rata ? String(rata) : "");
  uitaRata();
  return { produse: scrise, rata_firma: rata, venit_raport: venit, cost_raport: cost };
}

// Șterge tot ce a scris recalculul — ca să se poată da înapoi dintr-un click,
// fără să atingem nimic altceva din date.
async function stergeRate() {
  const n = await db.prepare("SELECT COUNT(*) AS n FROM produse WHERE cost_rata IS NOT NULL").get().catch(() => ({ n: 0 }));
  await db.prepare("UPDATE produse SET cost_rata = NULL, cost_rata_sursa = NULL").run();
  await scrieSetare("cost_rata_firma", "");
  uitaRata();
  return { sterse: Number((n && n.n) || 0) };
}

async function scrieSetare(cheie, valoare) {
  const acum = new Date().toISOString();
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(valoare, acum, cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, valoare, acum);
}

// Câte produse au rată reală — pentru textele care spun pe ce stă marja.
async function acoperire() {
  const r = await db
    .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(cost_rata,0) > 0 THEN 1 ELSE 0 END) AS cu_rata, SUM(CASE WHEN COALESCE(pret_achizitie,0) > 0 THEN 1 ELSE 0 END) AS cu_pret FROM produse")
    .get()
    .catch(() => null);
  return {
    total: Number((r && r.total) || 0),
    cu_rata: Number((r && r.cu_rata) || 0),
    cu_pret: Number((r && r.cu_pret) || 0),
  };
}

// ---------------------------------------------------------------------------
// Costul din rețetă.
//
// Rețeta spune, pentru o bucată de produs finit, ce componente intră și în ce
// cantitate (`retete_componente.cantitate` e pe unitatea de produs finit).
// Costul produsului e suma: cantitate × costul componentei.
//
// O componentă poate fi la rândul ei făcută de noi — atunci costul ei vine tot
// din rețeta ei, și tot așa în jos. Coborâm cel mult ADANCIME trepte și ținem
// minte pe unde am trecut, ca o rețetă scrisă circular din greșeală (A din B,
// B din A) să nu învârtă serverul la nesfârșit.
//
// Componentele fără niciun cost nu se inventează: se numără separat, iar
// produsul spune pe față „rețetă acoperită pe 4 din 6 componente". Un cost
// parțial e util — e o limită de jos — dar nu are voie să se dea drept complet.
const ADANCIME = 6;

function costComponenta(id, indexProduse, indexRetete, vizitate, adancime) {
  const p = indexProduse.get(Number(id));
  if (!p) return { cost: 0, lipsa: 1 };

  // Ce cumpărăm are preț de achiziție — ăla e costul, direct.
  const pret = Number(p.pret_achizitie) || 0;
  const componente = indexRetete.get(Number(id)) || [];

  // Ce facem noi, și are rețetă, își ia costul din ea — chiar dacă are și un
  // preț de achiziție vechi scris pe el, fiindcă rețeta e mai proaspătă.
  if (componente.length && adancime < ADANCIME && !vizitate.has(Number(id))) {
    vizitate.add(Number(id));
    let cost = 0;
    let lipsa = 0;
    for (const c of componente) {
      const sub = costComponenta(c.componenta_id, indexProduse, indexRetete, vizitate, adancime + 1);
      if (sub.cost > 0) cost += Number(c.cantitate) * sub.cost;
      else lipsa++;
    }
    vizitate.delete(Number(id));
    if (cost > 0) return { cost, lipsa };
  }

  if (pret > 0) return { cost: pret, lipsa: 0 };
  return { cost: 0, lipsa: 1 };
}

// Costul pe bucată al fiecărui produs cu rețetă, scris în `produse.cost_reteta`.
// Se cheamă după orice schimbare de rețetă și după fiecare import de costuri.
async function recalculeazaRetete() {
  const produse = await db.prepare("SELECT id, pret_achizitie FROM produse").all().catch(() => []);
  const randuri = await db.prepare("SELECT produs_id, componenta_id, cantitate FROM retete_componente").all().catch(() => []);

  const indexProduse = new Map(produse.map((p) => [Number(p.id), p]));
  const indexRetete = new Map();
  for (const r of randuri) {
    const k = Number(r.produs_id);
    if (!indexRetete.has(k)) indexRetete.set(k, []);
    indexRetete.get(k).push({ componenta_id: Number(r.componenta_id), cantitate: Number(r.cantitate) || 0 });
  }

  const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
  let scrise = 0, complete = 0, partiale = 0, fara = 0;

  for (const [id, componente] of indexRetete) {
    if (!indexProduse.has(id)) continue;
    let cost = 0;
    let lipsa = 0;
    for (const c of componente) {
      const sub = costComponenta(c.componenta_id, indexProduse, indexRetete, new Set([id]), 1);
      if (sub.cost > 0) cost += c.cantitate * sub.cost;
      else lipsa++;
    }
    if (cost > 0) {
      await db
        .prepare("UPDATE produse SET cost_reteta = ?, cost_reteta_lipsa = ?, cost_reteta_la = ? WHERE id = ?")
        .run(Math.round(cost * 1000000) / 1000000, lipsa, acum, id);
      scrise++;
      if (lipsa === 0) complete++;
      else partiale++;
    } else {
      await db
        .prepare("UPDATE produse SET cost_reteta = NULL, cost_reteta_lipsa = ?, cost_reteta_la = ? WHERE id = ?")
        .run(componente.length, acum, id);
      fara++;
    }
  }

  // Produsele care n-au (mai) au rețetă nu trebuie să rămână cu un cost vechi.
  const cuReteta = [...indexRetete.keys()];
  if (cuReteta.length) {
    await db
      .prepare(`UPDATE produse SET cost_reteta = NULL, cost_reteta_lipsa = NULL WHERE cost_reteta IS NOT NULL AND id NOT IN (${cuReteta.map(() => "?").join(",")})`)
      .run(...cuReteta)
      .catch(() => null);
  } else {
    await db.prepare("UPDATE produse SET cost_reteta = NULL, cost_reteta_lipsa = NULL").run().catch(() => null);
  }

  return { produse_cu_reteta: indexRetete.size, cu_cost: scrise, complete, partiale, fara_cost: fara };
}

// Costul unei rețete, calculat pe loc pentru un singur produs — pentru pagina
// de editare, unde vrem și detaliul pe componentă, nu doar totalul.
async function detaliuReteta(produsId) {
  const produse = await db.prepare("SELECT id, denumire, unitate_masura, pret_achizitie, cost_rata FROM produse").all().catch(() => []);
  const randuri = await db.prepare("SELECT produs_id, componenta_id, cantitate FROM retete_componente").all().catch(() => []);
  const indexProduse = new Map(produse.map((p) => [Number(p.id), p]));
  const indexRetete = new Map();
  for (const r of randuri) {
    const k = Number(r.produs_id);
    if (!indexRetete.has(k)) indexRetete.set(k, []);
    indexRetete.get(k).push({ componenta_id: Number(r.componenta_id), cantitate: Number(r.cantitate) || 0 });
  }
  const ale = indexRetete.get(Number(produsId)) || [];
  const linii = ale.map((c) => {
    const sub = costComponenta(c.componenta_id, indexProduse, indexRetete, new Set([Number(produsId)]), 1);
    const p = indexProduse.get(c.componenta_id) || {};
    const areReteta = (indexRetete.get(c.componenta_id) || []).length > 0;
    return {
      componenta_id: c.componenta_id,
      denumire: p.denumire || "necunoscut",
      um: p.unitate_masura || "",
      cantitate: c.cantitate,
      cost_unitar: sub.cost,
      temei: sub.cost > 0 ? (areReteta && sub.lipsa >= 0 && Number(p.pret_achizitie) !== sub.cost ? "din rețeta ei" : "preț de achiziție") : "fără cost",
      cost: c.cantitate * sub.cost,
    };
  });
  const total = linii.reduce((s2, l) => s2 + l.cost, 0);
  const lipsa = linii.filter((l) => !(l.cost_unitar > 0)).length;
  return { linii, total, lipsa };
}

module.exports = {
  costLinie,
  recalculeazaRetete,
  detaliuReteta,
  rataFirma,
  uitaRata,
  recalculeazaRate,
  stergeRate,
  acoperire,
  temeiLinie,
  VENIT_CU_COST_REAL,
  LINII_ESTIMATE,
  ABERANT,
};
