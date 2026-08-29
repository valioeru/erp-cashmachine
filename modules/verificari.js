"use strict";
// Verificări de integritate a datelor.
//
// Un ERP alimentat din importuri repetate strânge, în timp, greșeli tăcute:
// o plată intrată de două ori pe căi diferite, o factură rămasă fără linii,
// un cod de produs folosit la două articole. Niciuna nu dă eroare — doar
// strică cifrele din rapoarte, iar când te prinzi e greu de spus de unde a
// pornit. Pagina asta le caută pe toate deodată și arată rândurile vinovate,
// nu doar un număr.
//
// Totul e citire. Nimic nu se șterge de aici: mai întâi te uiți la ce a
// găsit, abia apoi se decide ce se face cu ele.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send } = require("../lib/router");

const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)";

const nr = (v) => Number(v || 0);
const LIMITA = 25;

// Fiecare verificare întoarce { n, sumar, antet, randuri } — pagina le redă
// la fel pe toate, deci se adaugă una nouă scriind doar interogarea.
const VERIFICARI = [
  {
    cheie: "plati-peste-factura",
    titlu: "Facturi încasate peste valoarea lor",
    de_ce:
      "Suma plăților trece de totalul facturii cu mai mult de un leu. De obicei înseamnă că aceeași încasare a intrat de două ori, pe două căi diferite (o dată reconstituită din statusul SmartBill, o dată din raportul de încasări).",
    gravitate: "rosu",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id, f.serie, f.numar, f.data_emiterii, p.nume AS partener,
                  COALESCE(t.total,0) AS total, COALESCE(pl.platit,0) AS platit,
                  (SELECT COUNT(*) FROM (SELECT * FROM plati WHERE activ = 1) x WHERE x.factura_id = f.id) AS nr_plati
             FROM (SELECT * FROM facturi WHERE activ = 1) f
             JOIN parteneri p ON p.id = f.partener_id
             LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
             LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
              AND COALESCE(pl.platit,0) > COALESCE(t.total,0) + 1
            ORDER BY (COALESCE(pl.platit,0) - COALESCE(t.total,0)) DESC`
        )
        .all();
      const surplus = randuri.reduce((s, r) => s + (nr(r.platit) - nr(r.total)), 0);
      return {
        n: randuri.length,
        sumar: `${randuri.length} facturi, ${money(surplus)} încasați în plus față de cât s-a facturat`,
        antet: ["Factură", "Data", "Partener", "Facturat", "Încasat", "În plus", "Nr. plăți"],
        randuri: randuri.slice(0, LIMITA).map((r) => [
          `<a href="/facturi/${r.id}">${esc(String(r.serie || "") + String(r.numar || ""))}</a>`,
          esc(String(r.data_emiterii || "").slice(0, 10)),
          esc(r.partener),
          money(r.total),
          money(r.platit),
          `<strong style="color:var(--danger)">${money(nr(r.platit) - nr(r.total))}</strong>`,
          r.nr_plati,
        ]),
      };
    },
  },
  {
    cheie: "plati-duplicate",
    titlu: "Plăți identice pe aceeași factură",
    de_ce:
      "Aceeași sumă apare de mai multe ori pe aceeași factură, la date diferite. O plată reală repetată la fix aceeași sumă e rară; de obicei e același ban importat de două ori.",
    gravitate: "rosu",
    async ruleaza() {
      const grupuri = await db
        .prepare(
          `SELECT pl.factura_id, pl.suma, COUNT(*) AS n
             FROM (SELECT * FROM plati WHERE activ = 1) pl
             JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
            WHERE f.directie = 'vanzare'
            GROUP BY pl.factura_id, pl.suma
           HAVING COUNT(*) > 1
            ORDER BY COUNT(*) * pl.suma DESC`
        )
        .all();
      const surplus = grupuri.reduce((s, g) => s + (nr(g.n) - 1) * nr(g.suma), 0);
      const primele = grupuri.slice(0, LIMITA);
      const detalii = [];
      for (const g of primele) {
        const f = await db
          .prepare(
            `SELECT f.id, f.serie, f.numar, p.nume AS partener FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`
          )
          .get(g.factura_id);
        const zile = await db
          .prepare("SELECT data, metoda, observatii FROM (SELECT * FROM plati WHERE activ = 1) plati WHERE factura_id = ? AND suma = ? ORDER BY data")
          .all(g.factura_id, g.suma);
        detalii.push([
          f ? `<a href="/facturi/${f.id}">${esc(String(f.serie || "") + String(f.numar || ""))}</a>` : String(g.factura_id),
          f ? esc(f.partener) : "—",
          money(g.suma),
          g.n,
          esc(zile.map((z) => String(z.data || "").slice(0, 10)).join(", ")),
          esc([...new Set(zile.map((z) => z.observatii || z.metoda || "—"))].join(" / ").slice(0, 90)),
        ]);
      }
      return {
        n: grupuri.length,
        sumar: `${grupuri.length} perechi de plăți identice, ${money(surplus)} numărați de două ori`,
        antet: ["Factură", "Partener", "Suma", "De câte ori", "Datele", "Proveniență"],
        randuri: detalii,
      };
    },
  },
  {
    cheie: "facturi-fara-linii",
    titlu: "Facturi de vânzare fără nicio linie",
    de_ce:
      "Fără linii, factura valorează zero în toate rapoartele — dar plățile ei se numără la încasări. Așa iese „încasat mai mult decât facturat” fără ca vreo plată să fie duplicată.",
    gravitate: "galben",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id, f.serie, f.numar, f.data_emiterii, p.nume AS partener, COALESCE(pl.platit,0) AS platit
             FROM (SELECT * FROM facturi WHERE activ = 1) f
             JOIN parteneri p ON p.id = f.partener_id
             LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
              AND NOT EXISTS (SELECT 1 FROM facturi_linii l WHERE l.factura_id = f.id)
            ORDER BY COALESCE(pl.platit,0) DESC, f.id DESC`
        )
        .all();
      const platit = randuri.reduce((s, r) => s + nr(r.platit), 0);
      return {
        n: randuri.length,
        sumar: `${randuri.length} facturi fără linii, pe care s-au înregistrat ${money(platit)} încasări`,
        antet: ["Factură", "Data", "Partener", "Încasat pe ea"],
        randuri: randuri.slice(0, LIMITA).map((r) => [
          `<a href="/facturi/${r.id}">${esc(String(r.serie || "") + String(r.numar || ""))}</a>`,
          esc(String(r.data_emiterii || "").slice(0, 10)),
          esc(r.partener),
          money(r.platit),
        ]),
      };
    },
  },
  {
    cheie: "plati-pe-anulate",
    titlu: "Plăți pe facturi anulate sau ciornă",
    de_ce: "O factură anulată nu se încasează. Dacă are plăți, ori anularea e greșită, ori plata e pusă pe documentul greșit.",
    gravitate: "galben",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id, f.serie, f.numar, f.status, p.nume AS partener, SUM(pl.suma) AS suma, COUNT(*) AS n
             FROM (SELECT * FROM plati WHERE activ = 1) pl
             JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
             JOIN parteneri p ON p.id = f.partener_id
            WHERE f.status IN ('anulata','ciorna')
            GROUP BY f.id, f.serie, f.numar, f.status, p.nume
            ORDER BY SUM(pl.suma) DESC`
        )
        .all();
      return {
        n: randuri.length,
        sumar: `${randuri.length} facturi anulate/ciornă cu plăți, în total ${money(randuri.reduce((s, r) => s + nr(r.suma), 0))}`,
        antet: ["Factură", "Status", "Partener", "Plăți", "Sumă"],
        randuri: randuri.slice(0, LIMITA).map((r) => [
          `<a href="/facturi/${r.id}">${esc(String(r.serie || "") + String(r.numar || ""))}</a>`,
          esc(r.status),
          esc(r.partener),
          r.n,
          money(r.suma),
        ]),
      };
    },
  },
  {
    cheie: "coduri-duplicate",
    titlu: "Coduri de produs folosite la mai multe articole",
    de_ce: "Codul e cheia după care puntea potrivește produsele la import. Dacă îl poartă două articole, costul și stocul ajung pe cine nimerește.",
    gravitate: "galben",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT cod, COUNT(*) AS n FROM produse
            WHERE cod IS NOT NULL AND cod <> ''
            GROUP BY cod HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC, cod`
        )
        .all();
      const detalii = [];
      for (const r of randuri.slice(0, LIMITA)) {
        const p = await db.prepare("SELECT id, denumire FROM produse WHERE cod = ? ORDER BY id").all(r.cod);
        detalii.push([
          `<strong>${esc(r.cod)}</strong>`,
          r.n,
          p.map((x) => `<a href="/produse/${x.id}">${esc(x.denumire)}</a>`).join("<br>"),
        ]);
      }
      return {
        n: randuri.length,
        sumar: `${randuri.length} coduri purtate de mai multe produse`,
        antet: ["Cod", "Articole", "Care sunt"],
        randuri: detalii,
      };
    },
  },
  {
    cheie: "parteneri-acelasi-cui",
    titlu: "Parteneri cu același CUI",
    de_ce: "Același client apărut de două ori își împarte istoricul, soldul și alocarea la agent între cele două fișe.",
    gravitate: "galben",
    async ruleaza() {
      const toti = await db.prepare("SELECT id, nume, cui FROM parteneri WHERE cui IS NOT NULL AND cui <> ''").all();
      const dupaCui = new Map();
      for (const p of toti) {
        const k = String(p.cui).toUpperCase().replace(/[^0-9]/g, "");
        if (!k) continue;
        if (!dupaCui.has(k)) dupaCui.set(k, []);
        dupaCui.get(k).push(p);
      }
      const grupuri = [...dupaCui.entries()].filter(([, v]) => v.length > 1);
      return {
        n: grupuri.length,
        sumar: `${grupuri.length} CUI-uri cu mai multe fișe de partener`,
        antet: ["CUI", "Fișe", "Care sunt"],
        randuri: grupuri.slice(0, LIMITA).map(([k, v]) => [
          `<strong>${esc(k)}</strong>`,
          v.length,
          v.map((x) => `<a href="/parteneri/${x.id}">${esc(x.nume)}</a>`).join("<br>"),
        ]),
      };
    },
  },
  {
    cheie: "cost-aberant",
    titlu: "Linii de factură cu cost de marfă aberant",
    de_ce:
      "Costul liniei (cantitate × prețul de achiziție al produsului) sare de câteva ori peste cât s-a vândut linia. Se compară în valoare absolută, altfel orice storno ar apărea aici degeaba: cu cantitate negativă, comparația se inversează. De obicei prețul de achiziție al produsului e greșit — luat în altă unitate de măsură, sau calculat dintr-o intrare cu cantitate aproape zero. Un singur produs stricat aici poate scoate marja firmei pe minus cu zeci de milioane.",
    gravitate: "rosu",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id AS factura_id, f.serie, f.numar, f.data_emiterii,
                  pr.id AS produs_id, pr.denumire, pr.cod, pr.unitate_masura, pr.pret_achizitie,
                  fl.cantitate, fl.pret_unitar,
                  ABS(fl.cantitate) * COALESCE(pr.pret_achizitie, 0) AS cost,
                  ABS(fl.cantitate * fl.pret_unitar) AS venit
             FROM facturi_linii fl
             JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
             JOIN produse pr ON pr.id = fl.produs_id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
              AND COALESCE(pr.pret_achizitie, 0) > 0
              AND ABS(fl.cantitate) * COALESCE(pr.pret_achizitie, 0) > 5 * ABS(fl.cantitate * fl.pret_unitar) + 100
            ORDER BY ABS(fl.cantitate) * COALESCE(pr.pret_achizitie, 0) DESC`
        )
        .all();
      const cost = randuri.reduce((s, r) => s + nr(r.cost), 0);
      const venit = randuri.reduce((s, r) => s + nr(r.venit), 0);
      const produse = new Set(randuri.map((r) => r.produs_id));
      return {
        n: randuri.length,
        sumar: `${randuri.length} linii, pe ${produse.size} produse: cost ${money(cost)} pentru marfă vândută cu ${money(venit)}`,
        antet: ["Factură", "Data", "Produs", "Cantitate", "Preț vânzare", "Preț achiziție", "Cost linie", "Venit linie"],
        randuri: randuri.slice(0, LIMITA).map((r) => [
          `<a href="/facturi/${r.factura_id}">${esc(String(r.serie || "") + String(r.numar || ""))}</a>`,
          esc(String(r.data_emiterii || "").slice(0, 10)),
          `<a href="/produse/${r.produs_id}">${esc(r.denumire)}</a>${r.cod ? ` <span style="color:var(--text-muted)">(${esc(r.cod)})</span>` : ""}`,
          `${nr(r.cantitate)} ${esc(r.unitate_masura || "")}`,
          money(r.pret_unitar),
          `<strong style="color:var(--danger)">${money(r.pret_achizitie)}</strong>`,
          `<strong style="color:var(--danger)">${money(r.cost)}</strong>`,
          money(r.venit),
        ]),
      };
    },
  },
  {
    cheie: "achizitii-duplicate",
    titlu: "Facturi de achiziție cu același număr de document",
    de_ce:
      "Aceeași factură de furnizor înregistrată de două ori dublează datoria. E prima suspectă când „de plătit” din ERP nu seamănă cu soldul din balanță.",
    gravitate: "rosu",
    async ruleaza() {
      const grupuri = await db
        .prepare(
          `SELECT f.document_extern AS doc, f.partener_id, COUNT(*) AS n
             FROM (SELECT * FROM facturi WHERE activ = 1) f
            WHERE f.directie = 'achizitie' AND f.status NOT IN ('anulata')
              AND f.document_extern IS NOT NULL AND f.document_extern <> ''
            GROUP BY f.document_extern, f.partener_id
           HAVING COUNT(*) > 1
            ORDER BY COUNT(*) DESC`
        )
        .all();
      const detalii = [];
      let inPlus = 0;
      for (const g of grupuri) {
        const f = await db
          .prepare(
            `SELECT f.id, p.nume AS partener,
                    COALESCE((SELECT SUM(l.cantitate * l.pret_unitar * (1 + COALESCE(l.cota_tva,0)/100.0)) FROM facturi_linii l WHERE l.factura_id = f.id), 0) AS total
               FROM (SELECT * FROM facturi WHERE activ = 1) f LEFT JOIN parteneri p ON p.id = f.partener_id
              WHERE f.directie = 'achizitie' AND f.document_extern = ? AND f.partener_id ${g.partener_id === null ? "IS NULL" : "= ?"}
              ORDER BY f.id`
          )
          .all(...(g.partener_id === null ? [g.doc] : [g.doc, g.partener_id]));
        const sume = f.map((x) => nr(x.total));
        inPlus += sume.slice(1).reduce((a, b) => a + b, 0);
        if (detalii.length < LIMITA) {
          detalii.push([
            `<strong>${esc(g.doc)}</strong>`,
            esc((f[0] && f[0].partener) || "—"),
            g.n,
            f.map((x) => `<a href="/facturi/${x.id}">#${x.id}</a> ${money(x.total)}`).join("<br>"),
          ]);
        }
      }
      return {
        n: grupuri.length,
        sumar: `${grupuri.length} documente înregistrate de mai multe ori, ${money(inPlus)} datorie în plus`,
        antet: ["Document", "Furnizor", "De câte ori", "Facturile"],
        randuri: detalii,
      };
    },
  },
  {
    cheie: "facturi-fara-agent",
    titlu: "Facturi de vânzare fără agent",
    de_ce: "Fără agent, factura nu intră în comision și nu apare în raportul pe agenți. Recalcularea din Alocări le pune pe administrator.",
    gravitate: "info",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id, f.serie, f.numar, f.data_emiterii, p.nume AS partener
             FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN parteneri p ON p.id = f.partener_id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.agent_id IS NULL
            ORDER BY f.data_emiterii DESC`
        )
        .all();
      return {
        n: randuri.length,
        sumar: `${randuri.length} facturi fără agent`,
        antet: ["Factură", "Data", "Partener"],
        randuri: randuri.slice(0, LIMITA).map((r) => [
          `<a href="/facturi/${r.id}">${esc(String(r.serie || "") + String(r.numar || ""))}</a>`,
          esc(String(r.data_emiterii || "").slice(0, 10)),
          esc(r.partener),
        ]),
      };
    },
  },
];

// Plățile născocite din statusul facturii, nu din extras. Vezi comentariul
// din modules/import.js: importul vechi le scria pe data facturii, cu suma
// întreagă, doar pentru că SmartBill zicea „platită".
const RECONSTITUITE = [
  "Plată reconstituită automat din statusul din SmartBill",
  "Încasare adusă prin punte din SmartBill",
];

// Încasările numărate de mai multe ori.
//
// De unde vin: raportul de încasări din SmartBill se importă pe perioade care
// se suprapun, iar o încasare poate lista mai multe facturi deodată. Suma se
// împarte între ele proporțional cu soldul rămas — dar soldul se schimbă după
// primul import, deci a doua oară aceeași încasare se împarte altfel. Cheia de
// dedublare (factură + zi + sumă) nu mai prinde nimic și banul intră a doua
// oară. Așa a ajuns CSHM1762 să aibă cinci plăți pe o factură de 987.607 lei,
// adică exact de patru ori cât s-a facturat.
//
// Curățarea are două trepte, aplicate DOAR pe facturile încasate peste total:
//   1. repetările identice — pe aceeași factură, două plăți de exact aceeași
//      sumă, iar factura rămâne acoperită și fără a doua. Se ține prima (cea
//      mai veche), se scot copiile.
//   2. plățile născocite din statusul facturii, pe facturi care au și încasări
//      adevărate și rămân supraîncasate. Ele erau doar un surogat pentru
//      „SmartBill zice că e plătită" — adevărul e raportul de încasări.
//
// Ce nu se atinge: facturile care nu sunt supraîncasate, și excesul care
// rămâne după cele două trepte. Un singur plătit mai mare decât factura nu e
// dublură, e o încasare pusă pe factura greșită — aia se rezolvă de mână.
const SUB_TOTAL_FACTURA =
  "(SELECT factura_id, SUM(cantitate*pret_unitar*(1+COALESCE(cota_tva,0)/100.0)) AS total FROM facturi_linii GROUP BY factura_id)";

async function incasariDeCuratat() {
  const supra = await db
    .prepare(
      `SELECT f.id, f.numar, f.serie, f.data_emiterii, t.total, s.platit, p.nume AS partener
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN ${SUB_TOTAL_FACTURA} t ON t.factura_id = f.id
         JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id) s
           ON s.factura_id = f.id
         LEFT JOIN parteneri p ON p.id = f.partener_id
        WHERE f.directie = 'vanzare' AND s.platit > t.total + 1
        ORDER BY (s.platit - t.total) DESC`
    )
    .all();
  if (!supra.length) return { deScos: [], facturi: [], curate: 0, ramas: 0 };

  const ids = supra.map((f) => f.id);
  const toate = await db
    .prepare(
      `SELECT id, factura_id, suma, data, observatii FROM (SELECT * FROM plati WHERE activ = 1) plati
        WHERE factura_id IN (${ids.map(() => "?").join(", ")}) ORDER BY data, id`
    )
    .all(...ids);
  const peFactura = new Map();
  for (const p of toate) {
    if (!peFactura.has(Number(p.factura_id))) peFactura.set(Number(p.factura_id), []);
    peFactura.get(Number(p.factura_id)).push(p);
  }

  const deScos = [];
  const facturi = [];
  let curate = 0;
  let ramas = 0;
  for (const f of supra) {
    const plati = peFactura.get(Number(f.id)) || [];
    const total = nr(f.total);
    let platit = nr(f.platit);
    const scos = new Set();

    // 1. repetări.
    //
    // „Aceeași sumă" cu o toleranță de un leu, nu la bănuț: când o încasare
    // acoperă mai multe facturi, suma se împarte proporțional și se rotunjește,
    // iar la al doilea import soldurile sunt altele — așa ies două copii de
    // 987.607,85 și 987.607,90. La bănuț nu s-ar recunoaște.
    //
    // Condiția care ține totul în siguranță e a doua: copia se scoate DOAR
    // dacă factura rămâne acoperită și fără ea. O factură plătită cinstit în
    // două rate egale nu e supraîncasată, deci nici nu ajunge aici.
    //
    // Și pragul „rămâne acoperită" are aceeași toleranță: patru copii de
    // 987.607,90 pe o factură de 987.607,85 se împart în bani diferiți, iar
    // ultima scoatere lasă 987.607,80 — cu cinci bani sub total. La bănuț,
    // copia aia ar rămâne pe veci în cifre.
    const vazute = [];
    for (const p of plati) {
      const suma = nr(p.suma);
      const toleranta = Math.max(1, Math.abs(suma) * 0.001);
      const prag = Math.max(1, Math.abs(total) * 0.001);
      const repeta = vazute.some((v) => Math.abs(v - suma) <= toleranta);
      if (repeta && platit - suma >= total - prag) {
        scos.add(p.id);
        platit -= suma;
        deScos.push({ ...p, factura: f, motiv: "repetare" });
      } else vazute.push(suma);
    }

    // 2. surogate rămase, dar numai dacă pe factură a mai rămas o încasare adevărată
    const areReale = plati.some((p) => !scos.has(p.id) && !RECONSTITUITE.includes(p.observatii));
    if (areReale && platit > total + 1) {
      for (const p of plati) {
        if (scos.has(p.id) || !RECONSTITUITE.includes(p.observatii)) continue;
        if (platit - nr(p.suma) <= 0) continue;
        scos.add(p.id);
        platit -= nr(p.suma);
        deScos.push({ ...p, factura: f, motiv: "plată născocită din status" });
      }
    }

    const excesRamas = platit - total;
    if (excesRamas > 1) {
      ramas += excesRamas;
      facturi.push({ ...f, dupa: platit, exces: excesRamas, scoase: scos.size });
    } else curate++;
  }
  return { deScos, facturi, curate, ramas, supra: supra.length };
}

// --- Prețuri de achiziție aberante ----------------------------------------
//
// De unde vin: importul de balanță a stocului calculează costul unitar ca
// valoare / cantitate. Când produsul are stoc negativ, sau cantitatea e
// trecută în altă unitate decât cea de pe factură (kg în loc de bucăți),
// raportul explodează: un sac vândut cu 0,57 lei ajunge să aibă „preț de
// achiziție" 499,42 lei. O singură linie de 50.000 de bucăți scoate atunci
// marja firmei pe minus cu 25 de milioane.
//
// Reparația are două trepte, în ordinea asta:
//   1. dacă produsul are rețetă, costul se recalculează din componente
//      (cantitate × costul fiecărei componente) — adevărul pentru un produs
//      finit e ce intră în el, nu ce a ieșit dintr-o balanță stricată
//   2. dacă nu are rețetă, sau costul din rețetă e la fel de aberant, prețul
//      se golește. Zero nu e o minciună: înseamnă „nu știm cât ne-a costat",
//      iar rapoartele numără linia la „fără cost" și spun asta pe față.
//
// Referința față de care judecăm: cât se vinde produsul în realitate — prețul
// lui de vânzare sau media de pe liniile de factură, care e mai mare. Peste
// cinci ori referința, e greșit, nu marjă proastă.
const PRAG_ABERANT = 5;

async function costuriDeReparat() {
  const produse = await db
    .prepare(
      `SELECT pr.id, pr.cod, pr.denumire, pr.unitate_masura, pr.pret_vanzare, pr.pret_achizitie,
              COALESCE(v.pret_mediu, 0) AS pret_mediu,
              COALESCE(r.cost_reteta, 0) AS cost_reteta,
              COALESCE(r.componente, 0) AS componente,
              COALESCE(r.componente_fara_cost, 0) AS componente_fara_cost
         FROM produse pr
         LEFT JOIN (SELECT fl.produs_id,
                           SUM(fl.cantitate * fl.pret_unitar) / NULLIF(SUM(fl.cantitate), 0) AS pret_mediu
                      FROM facturi_linii fl
                      JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
                     WHERE f.directie = 'vanzare' AND fl.cantitate > 0
                     GROUP BY fl.produs_id) v ON v.produs_id = pr.id
         LEFT JOIN (SELECT rc.produs_id,
                           SUM(rc.cantitate * COALESCE(c.pret_achizitie, 0)) AS cost_reteta,
                           COUNT(*) AS componente,
                           SUM(CASE WHEN COALESCE(c.pret_achizitie, 0) > 0 THEN 0 ELSE 1 END) AS componente_fara_cost
                      FROM retete_componente rc
                      JOIN produse c ON c.id = rc.componenta_id
                     GROUP BY rc.produs_id) r ON r.produs_id = pr.id
        WHERE COALESCE(pr.pret_achizitie, 0) > 0`
    )
    .all();

  const deReparat = [];
  for (const p of produse) {
    const referinta = Math.max(nr(p.pret_vanzare), nr(p.pret_mediu));
    if (!(referinta > 0)) continue; // n-avem cu ce compara, nu ne atingem de el
    if (!(nr(p.pret_achizitie) > PRAG_ABERANT * referinta)) continue;

    const costReteta = nr(p.cost_reteta);
    const potrivit = costReteta > 0 && costReteta <= PRAG_ABERANT * referinta;
    deReparat.push({
      ...p,
      referinta,
      nou: potrivit ? Math.round(costReteta * 10000) / 10000 : 0,
      sursa: potrivit ? "rețetă" : nr(p.componente) ? "rețetă tot aberantă → golit" : "fără rețetă → golit",
    });
  }
  deReparat.sort((a, b) => nr(b.pret_achizitie) - nr(a.pret_achizitie));
  return deReparat;
}

function register(router) {
  // Curățarea plăților născocite. Se șterg DOAR cele de pe facturi care au
  // deja o încasare adevărată, adusă din raportul de încasări — deci nu se
  // pierde informația „a fost plătită", ea rămâne în încasarea reală, cu data
  // ei corectă. Facturile care n-au nicio încasare reală rămân neatinse.
  router.post("/admin/date/repara-costuri", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const deReparat = await costuriDeReparat();
    let dinReteta = 0;
    let golite = 0;
    for (const p of deReparat) {
      await db.prepare("UPDATE produse SET pret_achizitie = ? WHERE id = ?").run(p.nou, p.id);
      if (p.nou > 0) dinReteta++;
      else golite++;
    }
    const body = `
      <h2>Prețuri de achiziție reparate</h2>
      <p>S-au corectat <strong>${deReparat.length}</strong> produse: <strong>${dinReteta}</strong> recalculate din rețetă,
      <strong>${golite}</strong> golite (nu avem din ce le calcula — rapoartele le vor număra la „linii fără cost").</p>
      ${table(
        ["Produs", "Preț vânzare de referință", "Preț achiziție vechi", "Preț achiziție nou", "De unde"],
        deReparat.slice(0, LIMITA).map((p) => [
          `<a href="/produse/${p.id}">${esc(p.denumire)}</a>${p.cod ? ` <span style="color:var(--text-muted)">(${esc(p.cod)})</span>` : ""}`,
          money(p.referinta),
          `<span style="color:var(--danger)">${money(p.pret_achizitie)}</span>`,
          p.nou > 0 ? `<strong style="color:var(--success)">${money(p.nou)}</strong>` : "—",
          esc(p.sursa),
        ])
      )}
      <a class="btn secondary" href="/admin/date">Înapoi la verificări</a>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Reparare prețuri de achiziție", active: "/admin/date", body }));
  });

  // ---- Cantități și prețuri inversate pe linia de factură ----------------
  //
  // Linia scrie „1720 buc x 1,00 lei" in loc de „1 buc x 1.720,00 lei", sau
  // „735 x 17 lei" in loc de „17 x 735 lei". Importul a citit cele doua
  // coloane pe dos. Totalul liniei e corect — de-aia nu s-a vazut la
  // facturare — dar costul se calculeaza din cantitate, si iese umflat de
  // sute de ori.
  //
  // Reparatia e simpla si nu inventeaza nimic: se schimba cele doua numere
  // intre ele. Totalul ramane identic la banut, prin constructie.
  //
  // Cand stim ca e chiar inversare si nu o linie corecta? Cand inversarea
  // REZOLVA problema: costul liniei, azi de cateva ori mai mare decat
  // incasarea, intra sub ea dupa schimb. Daca nu se rezolva, linia nu se
  // atinge — acolo greseala e in pretul de achizitie al produsului, si are
  // pagina ei separata.
  async function cantitatiStrambe() {
    const randuri = await db
      .prepare(
        `SELECT fl.id, fl.factura_id, fl.cantitate, fl.pret_unitar, fl.denumire AS linie,
                f.serie, f.numar, f.data_emiterii, f.document_extern,
                pr.id AS produs_id, pr.cod, pr.denumire AS produs, pr.unitate_masura,
                pr.pret_vanzare, pr.pret_achizitie
           FROM facturi_linii fl
           JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
           JOIN produse pr ON pr.id = fl.produs_id
          WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
            AND COALESCE(pr.pret_achizitie, 0) > 0
            AND ABS(fl.cantitate) * COALESCE(pr.pret_achizitie, 0) > 5 * ABS(fl.cantitate * fl.pret_unitar) + 100
          ORDER BY f.data_emiterii, fl.id`
      )
      .all();

    const reparabile = [];
    const incerte = [];
    for (const r of randuri) {
      const cant = nr(r.cantitate);
      const pret = nr(r.pret_unitar);
      const pa = nr(r.pret_achizitie);
      const total = cant * pret;
      // Inversarea propriu-zisă: cele două numere își schimbă locul.
      const cantNoua = pret;
      const pretNou = cant;
      const rand = {
        ...r,
        cant,
        pret,
        total,
        cantNoua,
        pretNou,
        totalNou: cantNoua * pretNou,
        costVechi: Math.abs(cant) * pa,
        costNou: Math.abs(cantNoua) * pa,
      };
      // Se repară doar dacă inversarea chiar rezolvă: costul intră sub
      // încasarea liniei. Și doar dacă din coloana de preț iese o cantitate
      // credibilă — cel puțin o bucată. „0,01" e un preț, nu o cantitate, deci
      // acolo nu e inversare, ci prețul de achiziție al produsului e greșit.
      const rezolva = rand.costNou <= Math.abs(total) && Math.abs(cantNoua) >= 1;
      if (rezolva) reparabile.push(rand);
      else incerte.push(rand);
    }
    const produse = new Set(reparabile.map((r) => r.produs_id));
    const facturi = new Set(reparabile.map((r) => r.factura_id));
    return {
      reparabile,
      incerte,
      produse: produse.size,
      facturi: facturi.size,
      valoare: reparabile.reduce((a, r) => a + Math.abs(r.total), 0),
      costVechi: reparabile.reduce((a, r) => a + r.costVechi, 0),
      costNou: reparabile.reduce((a, r) => a + r.costNou, 0),
    };
  }

  router.get("/admin/date/cantitati-strambe", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const d = await cantitatiStrambe();
    const doc = (r) => esc(r.document_extern || String(r.serie || "") + String(r.numar || ""));

    const body = `
      <div class="toolbar"><a class="btn secondary" href="/admin/date">← Înapoi la verificări</a></div>
      <h1 style="margin:6px 0 2px">Cantități și prețuri inversate pe linie</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:880px">
        Linia scrie <strong>1.720 buc × 1,00 lei</strong> în loc de <strong>1 buc × 1.720,00 lei</strong>.
        Totalul liniei e corect — de-aia nu s-a văzut la facturare. Ce strică e costul:
        cantitatea umflată se înmulțește cu prețul de achiziție al produsului și scoate marja pe minus
        cu milioane, iar stocul crede că s-au vândut mii de bucăți.
        Reparația schimbă <strong>doar</strong> cantitatea și prețul unitar, păstrând totalul la bănuț.
      </p>

      <div class="cards">
        <div class="card"><div class="label">Linii de reparat</div><div class="value">${d.reparabile.length}</div></div>
        <div class="card"><div class="label">Produse atinse</div><div class="value">${d.produse}</div></div>
        <div class="card"><div class="label">Facturi atinse</div><div class="value">${d.facturi}</div></div>
        <div class="card"><div class="label">Cost fals scos din calcul</div>
          <div class="value" style="color:var(--danger)">${money(d.costVechi - d.costNou)}</div>
          <div style="font-size:12px;color:var(--text-muted)">de la ${money(d.costVechi)} la ${money(d.costNou)}</div></div>
      </div>

      <h2>Ce se schimbă, linie cu linie</h2>
      ${table(
        ["Factură", "Data", "Produs", "Acum", "Devine", "Total linie", "Cost acum", "Cost după"],
        d.reparabile.slice(0, 300).map((r) => [
          `<a href="/facturi/${r.factura_id}">${doc(r)}</a>`,
          esc(String(r.data_emiterii || "").slice(0, 10)),
          `<a href="/produse/${r.produs_id}">${esc(r.produs)}</a>${r.cod ? ` <span style="color:var(--text-muted)">(${esc(r.cod)})</span>` : ""}`,
          `<span style="color:var(--danger)">${nr(r.cant)} × ${money(r.pret)}</span>`,
          `<strong style="color:var(--success)">${nr(r.cantNoua)} × ${money(r.pretNou)}</strong>`,
          money(r.total),
          `<span style="color:var(--danger)">${money(r.costVechi)}</span>`,
          money(r.costNou),
        ])
      )}
      ${d.reparabile.length > 300 ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele 300 din ${d.reparabile.length}.</p>` : ""}

      ${
        d.incerte.length
          ? `<h2>Nu le ating — inversarea nu rezolvă</h2>
             <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px;max-width:860px">
               Aici inversarea nu rezolvă nimic: costul rămâne peste încasare și după schimb. Înseamnă că nu linia
               e strâmbă, ci <strong>prețul de achiziție al produsului</strong> — se repară cu butonul
               „Repară prețurile de achiziție" din <a href="/admin/date">Verificări</a>.
             </p>
             ${table(
               ["Factură", "Data", "Produs", "Acum", "Total linie"],
               d.incerte.slice(0, 100).map((r) => [
                 `<a href="/facturi/${r.factura_id}">${doc(r)}</a>`,
                 esc(String(r.data_emiterii || "").slice(0, 10)),
                 `<a href="/produse/${r.produs_id}">${esc(r.produs)}</a>`,
                 `${nr(r.cant)} × ${money(r.pret)}`,
                 money(r.total),
               ])
             )}`
          : ""
      }

      ${
        d.reparabile.length
          ? `<form method="post" action="/admin/date/repara-cantitati" style="margin-top:18px"
                   onsubmit="return confirm('Se corectează ${d.reparabile.length} linii de factură. Totalul fiecărei linii rămâne neschimbat. Continui?')">
               <button class="btn" type="submit">Repară cele ${d.reparabile.length} linii</button>
             </form>`
          : `<p style="color:var(--success)">Nu e nimic de reparat.</p>`
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cantități inversate", active: "/admin/date", body }));
  });

  router.post("/admin/date/repara-cantitati", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const d = await cantitatiStrambe();
    let n = 0;
    for (const r of d.reparabile) {
      await db.prepare("UPDATE facturi_linii SET cantitate = ?, pret_unitar = ? WHERE id = ?").run(r.cantNoua, r.pretNou, r.id);
      n++;
    }
    const body = `
      <h2>Reparat</h2>
      <p>Am corectat <strong>${n}</strong> ${n === 1 ? "linie" : "linii"} pe ${d.facturi} ${d.facturi === 1 ? "factură" : "facturi"}, ${d.produse} ${d.produse === 1 ? "produs" : "produse"}.
      Totalul fiecărei linii a rămas neschimbat — s-au mutat doar cifrele între cantitate și preț unitar.</p>
      <p>Costul fals scos din calcul: <strong>${money(d.costVechi - d.costNou)}</strong>.</p>
      ${d.incerte.length ? `<p style="color:var(--text-muted);font-size:13px">${d.incerte.length === 1 ? "A rămas o linie pe care n-am atins-o" : `Au rămas ${d.incerte.length} linii pe care nu le-am atins`}: acolo greșeala e în prețul de achiziție al produsului, nu în linie.</p>` : ""}
      <a class="btn secondary" href="/admin/date">Înapoi la verificări</a>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Reparare cantități", active: "/admin/date", body }));
  });

  // Curățarea încasărilor numărate de mai multe ori. Nu șterge: pune
  // „activ = 0". Plățile scoase rămân în baza de date și se văd (și se pot
  // aduce înapoi) din Configurări → Date. Pe bani de zeci de milioane, o
  // ștergere ireversibilă n-are ce căuta.
  // Lista, factură cu factură, a ce s-ar scoate. Se deschide înainte de a
  // apăsa butonul: nimeni nu semnează o curățare de zeci de milioane pe
  // baza unui număr.
  router.get("/admin/date/incasari-duble", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const { deScos, facturi, curate, ramas, supra } = await incasariDeCuratat();
    const suma = deScos.reduce((a, p) => a + nr(p.suma), 0);

    const body = `
      <div class="toolbar"><a class="btn secondary" href="/admin/date">← Înapoi la verificări</a></div>
      <h1 style="margin:6px 0 2px">Încasări numărate de mai multe ori</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:860px">
        ${supra} facturi au încasat mai mult decât s-a facturat. Mai jos, plată cu plată, ce s-ar scoate din calcul
        și de ce. „Repetare" = pe aceeași factură există deja o plată de aceeași sumă (cu un leu toleranță, fiindcă împărțirea rotunjește), iar factura
        rămâne acoperită și fără copie. „Plată născocită din status" = plata pusă doar fiindcă SmartBill zicea
        „platită", pe o factură care are și încasarea adevărată.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Plăți de scos</div><div class="value">${deScos.length}</div></div>
        <div class="card"><div class="label">Sumă scoasă din calcul</div><div class="value">${money(suma)}</div></div>
        <div class="card"><div class="label">Facturi care ies curate</div><div class="value">${curate} / ${supra}</div></div>
        <div class="card"><div class="label">Exces rămas</div><div class="value">${money(ramas)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${facturi.length} facturi, de rezolvat de mână</div></div>
      </div>

      <h2>Ce se scoate</h2>
      ${table(
        ["Factură", "Data facturii", "Partener", "Facturat", "Plata scoasă", "Data plății", "De ce"],
        deScos.slice(0, 300).map((p) => [
          `<a href="/facturi/${p.factura.id}">${esc(String(p.factura.serie || "") + String(p.factura.numar || ""))}</a>`,
          esc(String(p.factura.data_emiterii || "").slice(0, 10)),
          esc(p.factura.partener || "—"),
          money(p.factura.total),
          `<strong>${money(p.suma)}</strong>`,
          esc(String(p.data || "").slice(0, 10)),
          esc(p.motiv),
        ])
      )}
      ${deScos.length > 300 ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele 300 din ${deScos.length}.</p>` : ""}

      <h2>Ce rămâne supraîncasat după curățare</h2>
      <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px;max-width:860px">
        Astea nu sunt dubluri: o singură plată mai mare decât factura înseamnă că banii au fost puși pe factura
        greșită, sau că o plată bancară care acoperea mai multe facturi a intrat toată pe una. Se rezolvă de mână,
        din pagina facturii.
      </p>
      ${table(
        ["Factură", "Data", "Partener", "Facturat", "Încasat după curățare", "Exces"],
        facturi.slice(0, 100).map((f) => [
          `<a href="/facturi/${f.id}">${esc(String(f.serie || "") + String(f.numar || ""))}</a>`,
          esc(String(f.data_emiterii || "").slice(0, 10)),
          esc(f.partener || "—"),
          money(f.total),
          money(f.dupa),
          `<span style="color:var(--danger)">${money(f.exces)}</span>`,
        ])
      )}
      ${facturi.length > 100 ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele 100 din ${facturi.length}.</p>` : ""}

      <form method="post" action="/admin/date/curata-incasari" style="margin-top:18px"
            onsubmit="return confirm('Se scot din calcul ${deScos.length} plăți (${money(suma)}). Nu se șterge nimic. Continui?')">
        <button class="btn" type="submit">Scoate cele ${deScos.length} plăți din calcul</button>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Încasări duble", active: "/admin/date", body }));
  });

  router.post("/admin/date/curata-incasari", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const { deScos, curate, ramas, supra } = await incasariDeCuratat();
    let n = 0;
    let suma = 0;
    const peMotiv = new Map();
    for (const p of deScos) {
      await db.prepare("UPDATE plati SET activ = 0 WHERE id = ?").run(p.id);
      n++;
      suma += nr(p.suma);
      peMotiv.set(p.motiv, (peMotiv.get(p.motiv) || 0) + 1);
    }
    const body = `
      <h2>Curățare făcută</h2>
      <p>Am scos din calcul <strong>${n}</strong> plăți, în valoare de <strong>${money(suma)}</strong>:</p>
      <ul>${[...peMotiv].map(([m, c]) => `<li>${esc(m)}: ${c} plăți</li>`).join("")}</ul>
      <p>Din cele ${supra} facturi încasate peste total, <strong>${curate}</strong> ies curate.
      Pe restul rămâne un exces de ${money(ramas)} — ăla nu e dublură, ci încasare pusă pe factura greșită,
      și se rezolvă de mână.</p>
      <p style="color:var(--text-muted);font-size:13px">
        Nimic nu s-a șters: plățile scoase sunt marcate inactive și se văd în
        <a href="/configurari/date">Configurări → Date</a>, de unde pot fi aduse înapoi.
      </p>
      <a class="btn secondary" href="/admin/date">Înapoi la verificări</a>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Curățare încasări", active: "/admin/date", body }));
  });

  router.get("/admin/date", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");

    // Facturat vs încasat, an cu an: dacă undeva încasările sar peste
    // facturi, anul acela e locul de unde se începe săpatul.
    const peAn = await db
      .prepare(
        `SELECT an, SUM(facturat) AS facturat, SUM(incasat) AS incasat FROM (
           SELECT SUBSTR(f.data_emiterii,1,4) AS an, COALESCE(t.total,0) AS facturat, 0 AS incasat
             FROM (SELECT * FROM facturi WHERE activ = 1) f LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
           UNION ALL
           SELECT SUBSTR(pl.data,1,4) AS an, 0 AS facturat, pl.suma AS incasat
             FROM (SELECT * FROM plati WHERE activ = 1) pl JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
         ) x
         WHERE an >= '2015'
         GROUP BY an ORDER BY an DESC`
      )
      .all();

    const rezultate = [];
    for (const v of VERIFICARI) {
      try {
        rezultate.push({ ...v, rez: await v.ruleaza() });
      } catch (e) {
        rezultate.push({ ...v, eroare: String((e && e.message) || e).slice(0, 200) });
      }
    }

    const probleme = rezultate.filter((r) => r.rez && r.rez.n > 0 && r.gravitate !== "info").length;

    const sectiuni = rezultate
      .map((r) => {
        if (r.eroare) {
          return `<h2>${esc(r.titlu)} <span class="badge rosu">verificarea a picat</span></h2>
                  <p style="color:var(--danger);font-size:13px">${esc(r.eroare)}</p>`;
        }
        const insigna =
          r.rez.n === 0
            ? '<span class="badge verde">curat</span>'
            : `<span class="badge ${r.gravitate === "rosu" ? "rosu" : r.gravitate === "galben" ? "galbena" : "gri"}">${r.rez.n}</span>`;
        return `
          <h2 id="${r.cheie}">${esc(r.titlu)} ${insigna}</h2>
          <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px">${esc(r.de_ce)}</p>
          ${r.rez.n === 0 ? '<p style="color:var(--success);font-size:13px">Nimic de semnalat.</p>' : `<p style="font-size:13px"><strong>${esc(r.rez.sumar)}</strong></p>${table(r.rez.antet, r.rez.randuri)}${r.rez.n > LIMITA ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele ${LIMITA} din ${r.rez.n}.</p>` : ""}`}`;
      })
      .join("");

    const curatare = await incasariDeCuratat();
    const curatareSuma = curatare.deScos.reduce((s2, r) => s2 + nr(r.suma), 0);
    const strambe = await cantitatiStrambe();
    const costuriRele = await costuriDeReparat();

    const body = `
      ${
        costuriRele.length
          ? `<div class="card" style="border-left:4px solid var(--danger);margin-bottom:16px">
               <div class="label">Produse cu preț de achiziție aberant</div>
               <div class="value">${costuriRele.length} produse</div>
               <p style="font-size:13px;margin:8px 0 10px;color:var(--text-muted)">
                 Prețul lor de achiziție e de peste ${PRAG_ABERANT} ori mai mare decât prețul la care se vând —
                 vine dintr-o balanță cu stoc negativ sau cu altă unitate de măsură. Din cauza lor marja
                 apare pe minus cu zeci de milioane. Reparația ia costul din rețetă acolo unde produsul are una,
                 iar unde nu are golește prețul, ca linia să fie numărată cinstit la „fără cost".
               </p>
               <form method="post" action="/admin/date/repara-costuri" onsubmit="return confirm('Se corectează prețul de achiziție la ${costuriRele.length} produse. Continui?')">
                 <button class="btn" type="submit">Repară cele ${costuriRele.length} prețuri</button>
               </form>
             </div>`
          : ""
      }
      ${
        curatare.deScos.length
          ? `<div class="card" style="border-left:4px solid var(--danger);margin-bottom:16px">
               <div class="label">Încasări numărate de mai multe ori</div>
               <div class="value">${curatare.deScos.length} plăți · ${money(curatareSuma)}</div>
               <p style="font-size:13px;margin:8px 0 10px;color:var(--text-muted)">
                 Pe ${curatare.supra} facturi s-a încasat mai mult decât s-a facturat. Cauza: raportul de încasări
                 s-a importat pe perioade care se suprapun, iar o încasare care listează mai multe facturi se împarte
                 altfel la al doilea import — deci nu se mai recunoaște ca dublură. Se scot din calcul
                 ${curatare.deScos.filter((x) => x.motiv === "repetare").length} repetări și
                 ${curatare.deScos.filter((x) => x.motiv !== "repetare").length} plăți născocite din status.
                 Ies curate ${curatare.curate} facturi din ${curatare.supra}.
               </p>
               <form method="post" action="/admin/date/curata-incasari" onsubmit="return confirm('Se scot din calcul ${curatare.deScos.length} plăți (${money(curatareSuma)}). Nu se șterge nimic — se pot aduce înapoi din Configurări → Date. Continui?')">
                 <button class="btn" type="submit">Scoate cele ${curatare.deScos.length} plăți din calcul</button>
               </form>
               <p style="font-size:12px;margin:10px 0 0;color:var(--text-muted)">
                 <a href="/admin/date/incasari-duble">Vezi exact ce plăți se scot, factură cu factură →</a>
               </p>
             </div>`
          : ""
      }
      ${
        strambe.reparabile.length
          ? `<div class="card" style="border-left:4px solid var(--warn);margin-bottom:16px">
               <div class="label">Cantități și prețuri inversate pe linie</div>
               <div class="value">${strambe.reparabile.length} linii · ${strambe.produse} produse</div>
               <p style="font-size:13px;margin:8px 0 10px;color:var(--text-muted)">
                 Linia scrie „1.720 buc × 1,00 lei" în loc de „1 buc × 1.720,00 lei" — importul a citit prețul
                 în coloana de cantitate. Totalul facturii e corect, dar costul liniei iese umflat cu
                 ${money(strambe.costVechi - strambe.costNou)} și strică marja și stocul.
               </p>
               <p style="font-size:12px;margin:0;color:var(--text-muted)">
                 <a href="/admin/date/cantitati-strambe">Vezi ce se schimbă pe fiecare linie →</a>
               </p>
             </div>`
          : ""
      }
      <p style="color:var(--text-muted);font-size:13px;margin-top:0">
        Pagina doar citește: caută greșelile tăcute adunate din importuri și arată exact ce rânduri sunt de vină.
        Nu șterge și nu repară nimic singură — te uiți întâi, apoi decizi.
      </p>

      <div class="cards">
        <div class="card"><div class="label">Verificări rulate</div><div class="value">${rezultate.length}</div></div>
        <div class="card"><div class="label">Cu probleme</div><div class="value" style="color:${probleme ? "var(--danger)" : "var(--success)"}">${probleme}</div></div>
      </div>

      <h2>Facturat vs. încasat, an cu an</h2>
      <p style="margin:-6px 0 10px;color:var(--text-muted);font-size:13px">
        Pe un an închis cele două ar trebui să fie apropiate. Unde încasările sar mult peste facturi, ceva se numără de două ori.
      </p>
      ${table(
        ["An", "Facturat", "Încasat", "Încasat / facturat"],
        peAn.map((r) => {
          const f = nr(r.facturat);
          const i = nr(r.incasat);
          const p = f > 0 ? (i / f) * 100 : 0;
          const rau = f > 0 && p > 130;
          return [
            esc(r.an),
            money(f),
            money(i),
            f > 0 ? `<span style="color:${rau ? "var(--danger)" : "var(--text)"};font-weight:${rau ? 600 : 400}">${p.toFixed(0)}%</span>` : "—",
          ];
        })
      )}

      ${sectiuni}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Verificări date", active: "/admin/date", body }));
  });
}

module.exports = { register };
