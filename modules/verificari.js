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
const { send, redirect } = require("../lib/router");

const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)";

const nr = (v) => Number(v || 0);
const LIMITA = 25;

// Fiecare verificare întoarce { n, sumar, antet, randuri } — pagina le redă
// la fel pe toate, deci se adaugă una nouă scriind doar interogarea.
// ---------------------------------------------------------------------------
// Ce inseamna, de fapt, "duplicat"
//
// Un NUMAR de document care se repeta nu inseamna duplicat. La achizitii,
// bonurile fiscale isi reiau numerele la nesfarsit: "Bon fiscal 42" de la OMV
// apare de doua ori, cu 35,00 lei si cu 523,79 lei — sunt doua alimentari
// diferite, nu o greseala de import. Prima varianta a verificarii se uita doar
// la numar si le raporta pe amandoua ca duplicate, iar butonul de curatare
// le-ar fi dezactivat pe cele bune.
//
// Un duplicat adevarat are TOT la fel: acelasi document, acelasi partener,
// aceeasi data de emitere si aceeasi suma la banut. Asta se cere aici, si
// asta se cere si la curatare — cele doua trebuie sa vada exact aceleasi
// randuri, altfel butonul ar sterge ce raportul nu arata.
//
// Raman false pozitive posibile: doua livrari identice catre acelasi client,
// in aceeasi zi, la aceeasi suma. Sunt rare, se vad in lista, iar curatarea
// nu porneste niciodata singura.
// Butonul de reparare al unei verificări.
//
// „actiune" e un obiect: {href, eticheta, confirmare}. Pagina îl punea direct
// în șablon — `${r.rez.actiune || ""}` — și un obiect pus într-un șablon se
// scrie „[object Object]". Adică butonul de curățare a facturilor duplicate
// era scris în cod, testat în cap, și NU A EXISTAT NICIODATĂ pe ecran: în
// locul lui stătea textul ăla, pe care ochiul îl citește ca pe un artefact.
// Curățarea din 20.09 s-a făcut lovind ruta direct, nu apăsând butonul.
//
// De-aia randarea stă acum într-o funcție, cu un test care cere ca fiecare
// verificare cu acțiune să scoată un formular adevărat către ruta ei.
function butonulVerificarii(actiune) {
  if (!actiune || !actiune.href) return "";
  const confirmare = String(actiune.confirmare || "Continui?").replace(/'/g, "\\'");
  return `<form method="post" action="${esc(actiune.href)}" style="margin:8px 0 12px"
            onsubmit="return confirm('${esc(confirmare)}')">
            <button class="btn danger" type="submit">${esc(actiune.eticheta || "Repară")}</button>
          </form>`;
}

// Același număr de factură de vânzare, la aceeași firmă.
//
// Verificarea strictă de mai sus cere și suma egală la bănuț, și tocmai de-aia
// a scăpat cazul care contează: CSHMUPA-40 a intrat o dată din fișier (cu
// liniile de produse: 3.353,39 lei) și o dată prin punte (cu o singură linie
// „conform document", cu TVA-ul reconstituit: 3.353,40 lei). UN BAN diferență,
// și cele două exemplare nu se mai grupau.
//
// La vânzări numerotarea e a noastră și e unică prin lege, deci un număr
// repetat la aceeași firmă e întotdeauna o greșeală. Curățarea se face însă
// doar acolo unde e sigur că e același document: același client și aceeași
// dată. Restul rămân în listă, de citit cu ochiul.
const SQL_NUMAR_REFOLOSIT = `
  SELECT COALESCE(f.firma_id, 0) AS firma_id, UPPER(f.serie) AS serie, f.numar,
         COUNT(*) AS n,
         COUNT(DISTINCT f.partener_id) AS clienti_diferiti,
         COUNT(DISTINCT SUBSTR(COALESCE(f.data_emiterii, ''), 1, 10)) AS date_diferite,
         string_agg(CAST(f.id AS TEXT), ',' ORDER BY f.id) AS ids,
         string_agg(DISTINCT COALESCE(p.nume, '?'), ' · ') AS clienti,
         string_agg(DISTINCT SUBSTR(COALESCE(f.data_emiterii, ''), 1, 10), ' · ') AS date,
         string_agg(DISTINCT COALESCE(f.sursa_import, 'scrisă de mână'), ' · ') AS surse
    FROM (SELECT * FROM facturi WHERE activ = 1) f
    LEFT JOIN parteneri p ON p.id = f.partener_id
   WHERE f.directie = 'vanzare' AND f.numar IS NOT NULL AND f.serie IS NOT NULL
     AND f.sursa_import IS NOT NULL
   GROUP BY 1, 2, 3
  HAVING COUNT(*) > 1
   ORDER BY COUNT(*) DESC, 2, 3`;

// Din fiecare grup rămâne exemplarul cu CELE MAI MULTE LINII — adică cel cu
// detaliul pe produse, nu cel cu „conform document". La egalitate, cel mai
// vechi id. Invers ar fi însemnat să păstrăm rândul mai sărac și să aruncăm
// produsele.
async function exemplareDeScosDinNumereRefolosite() {
  const grupuri = await db.prepare(SQL_NUMAR_REFOLOSIT).all().catch(() => []);
  const sigure = grupuri.filter((g) => Number(g.clienti_diferiti) === 1 && Number(g.date_diferite) === 1);
  if (!sigure.length) return { deScos: [], grupuri: sigure };

  const toateIds = [];
  for (const g of sigure) for (const id of String(g.ids || "").split(",").filter(Boolean)) toateIds.push(Number(id));
  if (!toateIds.length) return { deScos: [], grupuri: sigure };

  const linii = await db
    .prepare(
      `SELECT f.id, COALESCE(l.n, 0) AS linii
         FROM facturi f
         LEFT JOIN (SELECT factura_id, COUNT(*) AS n FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
        WHERE f.id IN (${toateIds.map(() => "?").join(",")})`
    )
    .all(...toateIds);
  const cateLinii = new Map(linii.map((x) => [Number(x.id), Number(x.linii)]));

  const deScos = [];
  for (const g of sigure) {
    const ids = String(g.ids || "").split(",").map(Number).filter((x) => x > 0);
    if (ids.length < 2) continue;
    const pastrat = ids.slice().sort((a, b) => (cateLinii.get(b) || 0) - (cateLinii.get(a) || 0) || a - b)[0];
    for (const id of ids) if (id !== pastrat) deScos.push(id);
  }
  return { deScos, grupuri: sigure };
}

function sqlDuplicate(directie) {
  const doc =
    directie === "achizitie"
      ? "NULLIF(f.document_extern,'')"
      : "COALESCE(NULLIF(f.document_extern,''), f.serie || CAST(f.numar AS TEXT))";
  return `
    SELECT ${doc} AS doc,
           f.partener_id,
           f.data_emiterii,
           ROUND(CAST(COALESCE(t.total,0) AS NUMERIC), 2) AS suma,
           COUNT(*) AS n,
           string_agg(CAST(f.id AS TEXT), ',' ORDER BY f.id) AS ids,
           MIN(p.nume) AS partener
      FROM (SELECT * FROM facturi WHERE activ = 1) f
      LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) AS total
                   FROM facturi_linii GROUP BY factura_id) t ON t.factura_id = f.id
      LEFT JOIN parteneri p ON p.id = f.partener_id
     WHERE f.directie = '${directie}' AND f.status NOT IN ('anulata')
       AND ${doc} IS NOT NULL AND ${doc} <> ''
     GROUP BY 1, f.partener_id, f.data_emiterii, 4
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, 1`;
}

// ---------------------------------------------------------------------------
// „Încasat peste factură" — cauzele, separat
//
// Prima variantă a verificării arunca 455 de facturi și 5,7 milioane de lei
// într-un singur număr. Cifra aia nu se putea repara, pentru că nu însemna un
// singur lucru: un storno de −4.000 lei cu o încasare pe el intra la fel de
// „roșu" ca o plată importată de două ori. Acum fiecare rând primește o cauză,
// iar banii se adună pe cauză. Interogarea și clasificarea stau aici, la
// vedere, ca să poată fi verificate una câte una în test.
const SQL_INCASARI_PESTE = `
  SELECT f.id, f.serie, f.numar, f.data_emiterii, f.status, p.nume AS partener,
         COALESCE(t.total,0) AS total, COALESCE(pl.platit,0) AS platit,
         COALESCE(l.linii,0) AS linii,
         (SELECT COUNT(*) FROM (SELECT * FROM plati WHERE activ = 1) x WHERE x.factura_id = f.id) AS nr_plati,
         COALESCE(d.dublat,0) AS dublat,
         COALESCE(i.imprastiat,0) AS imprastiat, COALESCE(i.pe_cate,0) AS pe_cate
    FROM (SELECT * FROM facturi WHERE activ = 1) f
    JOIN parteneri p ON p.id = f.partener_id
    LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
    LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
    LEFT JOIN (SELECT factura_id, COUNT(*) AS linii FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
    LEFT JOIN (SELECT factura_id, SUM((n - 1) * suma) AS dublat
                 FROM (SELECT factura_id, suma, COUNT(*) AS n
                         FROM (SELECT * FROM plati WHERE activ = 1) plati
                        GROUP BY factura_id, suma HAVING COUNT(*) > 1) g
                GROUP BY factura_id) d ON d.factura_id = f.id
    LEFT JOIN (
      -- Aceeași încasare pusă întreagă pe mai multe facturi ale aceluiași
      -- client. Se vede pe datele reale: 123.126,66 lei stau, la bănuț, pe
      -- patru facturi diferite de la DELIVERY SOLUTIONS, fiecare cu o singură
      -- plată. Banii au intrat o dată; importul i-a scris pe fiecare factură
      -- pe care trebuiau împărțiți. Se cere aceeași sumă ȘI aceeași dată, la
      -- același partener — două plăți reale nimerite fix la același bănuț, în
      -- aceeași zi, pe două facturi, nu prea există.
      -- Scris în două treceri, nu cu subinterogare pe fiecare rând: pe baza
      -- adevărată sunt mii de plăți, iar varianta corelată ar fi ținut pagina
      -- minute întregi.
      SELECT pp.factura_id, SUM(pp.suma) AS imprastiat, MAX(gr.pe_cate) AS pe_cate
        FROM (SELECT pl.factura_id, pl.suma, pl.data, fx.partener_id
                FROM (SELECT * FROM plati WHERE activ = 1) pl
                JOIN (SELECT * FROM facturi WHERE activ = 1) fx ON fx.id = pl.factura_id
               WHERE fx.directie = 'vanzare') pp
        JOIN (SELECT fx.partener_id, pl.suma, pl.data, COUNT(DISTINCT pl.factura_id) AS pe_cate
                FROM (SELECT * FROM plati WHERE activ = 1) pl
                JOIN (SELECT * FROM facturi WHERE activ = 1) fx ON fx.id = pl.factura_id
               WHERE fx.directie = 'vanzare'
               GROUP BY 1, 2, 3
              HAVING COUNT(DISTINCT pl.factura_id) > 1) gr
          ON gr.partener_id = pp.partener_id AND gr.suma = pp.suma AND gr.data = pp.data
       GROUP BY pp.factura_id) i ON i.factura_id = f.id
   WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
     AND COALESCE(pl.platit,0) > COALESCE(t.total,0) + 1
   ORDER BY (COALESCE(pl.platit,0) - COALESCE(t.total,0)) DESC`;

// „bani" e altceva la fiecare cauză, și de-aia se calculează separat. La un
// storno, „platit − total" e chiar valoarea stornoului, care n-are nicio
// legătură cu niște bani în plus; a o aduna acolo era jumătate din motivul
// pentru care cele 5,7 milioane nu însemnau nimic.
const CAUZE_INCASARI = {
  "fara-linii": {
    eticheta: "Factură fără nicio linie",
    ce_e: "valoarea nu e în bază, nu banii sunt în plus — se repară importând liniile",
    real: false,
    bani: (r) => nr(r.platit),
    bani_zice: "încasări pe facturi care în bază valorează zero",
  },
  storno: {
    eticheta: "Storno (total negativ)",
    ce_e: "nu e o greșeală: valoarea e negativă prin definiție, iar încasarea aparține facturii stornate",
    real: false,
    bani: () => 0,
    bani_zice: "nimic de recuperat",
  },
  "plata-imprastiata": {
    eticheta: "Aceeași încasare, pusă pe mai multe facturi",
    ce_e: "un singur bon de bancă scris întreg pe fiecare factură pe care trebuia împărțit — se repară la alocări",
    real: true,
    bani: (r) => nr(r.platit) - nr(r.total),
    bani_zice: "numărați de mai multe ori",
  },
  "plati-duplicate": {
    eticheta: "Plăți identice, importate de două ori",
    ce_e: "surplusul e explicat exact de plățile duplicate de pe aceeași factură — se repară ștergându-le",
    real: true,
    bani: (r) => nr(r.dublat),
    bani_zice: "de șters",
  },
  "incasat-in-plus": {
    eticheta: "Chiar s-a încasat mai mult",
    ce_e: "totalul e pozitiv, plățile nu se repetă și nu vin de pe altă factură — se verifică una câte una",
    real: true,
    bani: (r) => nr(r.platit) - nr(r.total),
    bani_zice: "în plus față de facturat",
  },
};

// Ordinea contează: se verifică de la cel mai explicativ către cel mai vag, iar
// un rând primește prima cauză care i se potrivește. O factură fără linii e
// întâi fără linii, chiar dacă are și plăți duplicate — până nu intră liniile,
// n-ai de unde ști dacă plata aia chiar e în plus.
function clasificaIncasare(r) {
  const total = nr(r.total);
  const surplus = nr(r.platit) - total;
  if (!Number(r.linii)) return "fara-linii";
  if (total < 0) return "storno";
  // „Explicat exact": dacă scoți ce vine din altă parte, factura nu mai e
  // încasată peste. Dacă rămâne tot peste, cauza aia nu e explicația.
  if (nr(r.imprastiat) > 0 && surplus - nr(r.imprastiat) <= 1) return "plata-imprastiata";
  if (nr(r.dublat) > 0 && surplus - nr(r.dublat) <= 1) return "plati-duplicate";
  return "incasat-in-plus";
}

const VERIFICARI = [
  {
    cheie: "plati-peste-factura",
    titlu: "Facturi încasate peste valoarea lor",
    de_ce:
      "Suma plăților trece de totalul facturii cu mai mult de un leu. Nu toate sunt greșeli: o factură fără linii valorează zero în bază, iar un storno valorează negativ — pe amândouă orice încasare le face să pară „plătite în plus”. Verificarea le desparte pe cauze și numără banii separat, ca să știi care cifră chiar trebuie reparată.",
    gravitate: "rosu",
    async ruleaza() {
      const randuri = await db.prepare(SQL_INCASARI_PESTE).all();
      const CAUZE = CAUZE_INCASARI;

      const grupe = new Map();
      for (const r of randuri) {
        const c = clasificaIncasare(r);
        if (!grupe.has(c)) grupe.set(c, { n: 0, bani: 0, exemple: [] });
        const g = grupe.get(c);
        g.n++;
        g.bani += CAUZE[c].bani(r);
        if (g.exemple.length < 3) g.exemple.push(r);
      }

      const ordine = ["plata-imprastiata", "plati-duplicate", "incasat-in-plus", "fara-linii", "storno"];
      const reale = ordine.filter((c) => CAUZE[c].real && grupe.has(c));
      const nReale = reale.reduce((s, c) => s + grupe.get(c).n, 0);
      const baniReali = reale.reduce((s, c) => s + grupe.get(c).bani, 0);

      const randuriTabel = [];
      for (const c of ordine) {
        const g = grupe.get(c);
        if (!g) continue;
        randuriTabel.push([
          `<strong${CAUZE[c].real ? ' style="color:var(--danger)"' : ""}>${esc(CAUZE[c].eticheta)}</strong>`,
          String(g.n),
          `${money(g.bani)}<br><span style="font-size:11px;color:var(--text-muted)">${esc(CAUZE[c].bani_zice)}</span>`,
          CAUZE[c].real ? "de reparat" : "nu e greșeală",
          esc(CAUZE[c].ce_e),
          g.exemple
            .map(
              (r) =>
                `<a href="/facturi/${r.id}">${esc(String(r.serie || "") + String(r.numar || ""))}</a>` +
                ` <span style="font-size:11px;color:var(--text-muted)">${esc(String(r.partener || "").slice(0, 28))}</span>`
            )
            .join("<br>"),
        ]);
      }

      return {
        // „n" hotărăște dacă verificarea apare roșie. Numărăm doar ce chiar e
        // de reparat: altfel pagina ar striga la tine din cauza stornourilor,
        // adică exact din cauza lucrurilor corecte.
        n: nReale,
        sumar: nReale
          ? `${nReale} facturi de reparat, ${money(baniReali)} de recuperat — din ${randuri.length} care par încasate peste`
          : `niciuna de reparat (${randuri.length} par încasate peste, dar toate au explicație)`,
        antet: ["Cauza", "Facturi", "Banii", "Verdict", "Ce înseamnă", "Exemple"],
        randuri: randuriTabel,
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
      // Pe ce luni stau. Contează: dacă sunt împrăștiate, e o scurgere care
      // continuă; dacă sunt strânse pe două luni, e un import prost dintr-o
      // singură rundă — și atunci se repară cu puntea, într-o singură trecere.
      const peLuna = new Map();
      for (const r of randuri) {
        const l = String(r.data_emiterii || "").slice(0, 7);
        if (l) peLuna.set(l, (peLuna.get(l) || 0) + 1);
      }
      const varf = [...peLuna.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const unde = varf.length ? `; mai ales ${varf.map((x) => `${x[0]} (${x[1]})`).join(", ")}` : "";
      return {
        n: randuri.length,
        sumar:
          `${randuri.length} facturi fără linii, pe care s-au înregistrat ${money(platit)} încasări${unde}. ` +
          `Se completează din SmartBill cu puntea: /punte/facturi-linii.js, apoi await __punte.totul(2026).`,
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
    titlu: "Facturi de achiziție înregistrate de două ori",
    de_ce:
      "Aceeași factură de furnizor înregistrată de două ori dublează datoria. E prima suspectă când „de plătit” din ERP nu seamănă cu soldul din balanță. Se raportează doar când TOTUL e la fel — document, furnizor, dată și sumă — fiindcă numerele de bon fiscal se reiau la nesfârșit și singure nu dovedesc nimic.",
    gravitate: "rosu",
    async ruleaza() {
      const grupuri = await db.prepare(sqlDuplicate("achizitie")).all();
      let inPlus = 0;
      const detalii = [];
      for (const g of grupuri) {
        const ids = String(g.ids || "").split(",").filter(Boolean);
        inPlus += nr(g.suma) * (ids.length - 1);
        if (detalii.length < LIMITA) {
          detalii.push([
            `<strong>${esc(g.doc)}</strong>`,
            esc(g.partener || "—"),
            esc(String(g.data_emiterii || "").slice(0, 10)),
            money(g.suma),
            g.n,
            ids.map((id) => `<a href="/facturi/${id}">#${esc(id)}</a>`).join(" · "),
          ]);
        }
      }
      return {
        n: grupuri.length,
        sumar: `${grupuri.length} documente înregistrate de mai multe ori, ${money(inPlus)} datorie în plus`,
        antet: ["Document", "Furnizor", "Data", "Suma", "De câte ori", "Facturile"],
        randuri: detalii,
      };
    },
  },
  {
    cheie: "vanzari-duplicate",
    titlu: "Facturi de vânzare înregistrate de mai multe ori",
    de_ce:
      "Aceeași factură emisă, intrată de mai multe ori din import, umflă „de încasat” și apare de două-trei ori în scadențar. Se raportează doar exemplarele identice în tot — același număr, același client, aceeași dată și aceeași sumă la bănuț; un număr care se repetă, singur, nu dovedește nimic.",
    gravitate: "rosu",
    async ruleaza() {
      const grupuri = await db.prepare(sqlDuplicate("vanzare")).all();
      // Paza din bază se pune abia când nu mai sunt duplicate (un index unic nu
      // se poate crea peste rânduri care îl încalcă), deci starea ei nu se poate
      // ghici din cod — se întreabă baza și se scrie pe pagină. Altfel nu se
      // poate ști dacă plasa e întinsă sau doar scrisă în comentarii.
      const paza = await db
        .prepare("SELECT 1 AS da FROM pg_indexes WHERE indexname = 'idx_facturi_vanzare_import_unic'")
        .get()
        .catch(() => null);
      let inPlus = 0;
      const detalii = [];
      for (const g of grupuri) {
        const ids = String(g.ids || "").split(",").filter(Boolean);
        inPlus += nr(g.suma) * (ids.length - 1);
        if (detalii.length < LIMITA) {
          detalii.push([
            `<strong>${esc(g.doc)}</strong>`,
            esc(g.partener || "—"),
            esc(String(g.data_emiterii || "").slice(0, 10)),
            money(g.suma),
            g.n,
            ids
              .map((id, i) => `<a href="/facturi/${id}">#${esc(id)}</a>${i === 0 ? ' <span class="badge verde">se păstrează</span>' : ""}`)
              .join("<br>"),
          ]);
        }
      }
      return {
        n: grupuri.length,
        sumar: `${grupuri.length} facturi intrate de mai multe ori, ${money(inPlus)} creanțe care nu există`,
        nota: paza
          ? "Baza are pusă paza: aceeași factură de vânzare, adusă din import, nu mai poate intra de două ori la aceeași firmă. Dacă puntea încearcă, refuză baza și scrie în log."
          : "Paza din bază NU e pusă încă — indexul unic se creează la prima pornire de după ce nu mai există niciun duplicat. Curăță exemplarele în plus, apoi repornește aplicația.",
        antet: ["Document", "Client", "Data", "Suma", "Exemplare", "Facturile"],
        randuri: detalii,
        actiune: grupuri.length
          ? {
              href: "/admin/date/duplicate/curata",
              eticheta: "Scoate exemplarele în plus",
              confirmare:
                "Se dezactivează exact rândurile marcate în tabelul de mai sus — din fiecare grup rămâne exemplarul cu cel mai mic id, restul trec pe inactiv. Nu se șterge nimic: se poate anula oricând din istoricul de curățări de mai jos. Continui?",
            }
          : null,
      };
    },
  },
  {
    cheie: "numar-refolosit",
    titlu: "Același număr de factură de vânzare, folosit de două ori",
    de_ce:
      "Verificarea de deasupra cere ca exemplarele să fie identice în tot — număr, client, dată și sumă. Asta lasă pe dinafară cazul mai urât: același număr, la aceeași firmă, dar cu client sau sumă diferite. La vânzări numerotarea e a noastră și e unică prin lege, deci nu există „două facturi CSHM-3168”: ori una e greșit numerotată, ori una e intrată de două ori și ceva s-a schimbat pe drum. Sunt și rândurile care împiedică baza să-și pună paza automată împotriva dublurilor.",
    gravitate: "rosu",
    async ruleaza() {
      const randuri = await db.prepare(SQL_NUMAR_REFOLOSIT).all().catch(() => []);
      const { deScos } = await exemplareDeScosDinNumereRefolosite();
      const nesigure = randuri.filter((x) => Number(x.clienti_diferiti) > 1 || Number(x.date_diferite) > 1);
      return {
        n: randuri.length,
        sumar: `${randuri.length} numere folosite de mai multe ori`,
        nota: nesigure.length
          ? `${nesigure.length} dintre ele au client sau dată diferite — alea nu se curăță cu butonul, se citesc cu ochiul: ori sunt două facturi chiar diferite, prost numerotate, ori s-a schimbat ceva între importuri.`
          : "Toate au același client și aceeași dată, deci sunt sigur același document — butonul păstrează exemplarul cu detaliul pe produse și îl scoate pe celălalt.",
        antet: ["Serie și număr", "Exemplare", "Clienți", "Date", "Venite din", "Facturile"],
        randuri: randuri.slice(0, LIMITA).map((x) => [
          `<strong>${esc(x.serie)}-${esc(x.numar)}</strong>`,
          x.n,
          esc(String(x.clienti || "").slice(0, 80)),
          esc(String(x.date || "")),
          esc(String(x.surse || "")),
          String(x.ids || "")
            .split(",")
            .filter(Boolean)
            .map((id) => `<a href="/facturi/${id}">#${esc(id)}</a>`)
            .join(" "),
        ]),
        actiune: deScos.length
          ? {
              href: "/admin/date/numar-refolosit/curata",
              eticheta: `Scoate cele ${deScos.length} exemplare sigure`,
              confirmare:
                "Se dezactivează doar exemplarele din grupurile cu ACELAȘI client și ACEEAȘI dată. Din fiecare grup rămâne cel cu detaliul pe produse (cele mai multe linii), la egalitate cel mai vechi. Nu se șterge nimic — se poate anula din istoricul de curățări. Continui?",
            }
          : null,
      };
    },
  },
  {
    cheie: "facturi-sume-uriase",
    titlu: "Facturi de peste un milion de lei",
    de_ce:
      "Sunt puține și se verifică din ochi. Aici ies la iveală documentele de test rămase în bază: pe 19.09.2026, două facturi de la BSI A/S cu numere tastate la întâmplare („23123123”, „1213123”) țineau 19,2 milioane în „de plătit”. Restul trebuie să fie utilaje sau contracte reale — dacă nu recunoști unul, ăla e.",
    gravitate: "galben",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id, f.directie, f.serie, f.numar, f.document_extern, f.data_emiterii, f.status,
                  f.moneda, f.total_valuta, p.nume AS partener, COALESCE(t.total,0) AS total
             FROM (SELECT * FROM facturi WHERE activ = 1) f
             LEFT JOIN parteneri p ON p.id = f.partener_id
             LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
            WHERE f.status NOT IN ('anulata') AND COALESCE(t.total,0) >= 1000000
            ORDER BY COALESCE(t.total,0) DESC`
        )
        .all();
      const total = randuri.reduce((s, r) => s + nr(r.total), 0);
      return {
        n: randuri.length,
        sumar: `${randuri.length} documente, ${money(total)} în total`,
        antet: ["Document", "Fel", "Partener", "Data", "Sumă", "Valută", ""],
        randuri: randuri.slice(0, LIMITA).map((r) => [
          `<a href="/facturi/${r.id}">${esc(r.document_extern || String(r.serie || "") + String(r.numar || ""))}</a>`,
          r.directie === "achizitie" ? "achiziție" : "vânzare",
          esc(r.partener || "—"),
          esc(String(r.data_emiterii || "").slice(0, 10)),
          `<strong>${money(r.total)}</strong>`,
          r.moneda && r.moneda !== "RON" ? `${esc(r.moneda)} ${money(r.total_valuta)}` : "",
          // Un document de test se cunoaște din ochi, nu după o regulă: „Fact
          // 23123123" de 10 milioane de la BSI A/S e greșeală, „Fact
          // RVM2022000000045" de la Rovenma e utilaj adevărat. Nicio
          // interogare nu poate face deosebirea, și n-are rost să încerce —
          // de-aia butonul e pe rând, apăsat de cine recunoaște documentul.
          // Nu șterge nimic: scoate din calcule (activ = 0) și rămâne în
          // istoricul de jos, de unde se poate readuce.
          `<a class="link-btn danger" href="/admin/date/document/${r.id}/scoate">scoate din bază</a>`,
        ]),
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

  // ---- Unitatea de măsură înlocuită cu denumirea produsului ---------------
  //
  // Acelasi soi de import strambat, dar in tabelul de produse: in coloana
  // „UM" a ajuns denumirea produsului, sau „cod - denumire". Se vede pe orice
  // ecran cu produse: „1720 JUMBO BD 1620MMX 4050" in loc de „1 buc".
  //
  // Nu atingem unitatile adevarate, oricat de lungi ar fi: „o mie de bucati",
  // „centimetru patrat" si „unitate activa" sunt unitati reale din SmartBill.
  // Se repara doar cele care REPETA denumirea, sau care sunt doar cifre.
  //
  // Cu ce se inlocuieste: daca acelasi produs exista si sub alt rand, cu o
  // unitate sanatoasa, se ia aia — e cea mai buna dovada pe care o avem.
  // Altfel „buc", care e si valoarea implicita a coloanei.
  function umCurata(v) {
    return String(v || "").trim();
  }
  function umSanatoasa(v) {
    const u = umCurata(v);
    if (!u || u.length > 24) return false;
    if (/^[\d.,\s]+$/.test(u)) return false;
    return true;
  }
  function cheieDenumire(v) {
    // Același produs apare uneori scris „Cerneala Galbena" și alteori
    // „Cerneala Galbena (25PC0010-5)" sau „25PC0010-5 - Cerneala Galbena".
    // Le aducem la aceeași cheie, ca să se poată împrumuta unitatea între ele.
    return String(v || "")
      .toLowerCase()
      .replace(/\s*\([^()]*\)\s*$/, "")
      .replace(/^[a-z0-9._\/-]+\s+-\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function umStrambe() {
    const produse = await db.prepare("SELECT id, cod, denumire, unitate_masura FROM produse ORDER BY denumire, id").all();

    // Unitățile sănătoase, grupate pe denumire și pe cod — dovada pentru cele
    // stricate. Codul e dovada mai bună când există.
    const dovezi = new Map();
    const dovezi0 = new Map();
    for (const p of produse) {
      const den = cheieDenumire(p.denumire);
      const um = umCurata(p.unitate_masura);
      if (!umSanatoasa(um)) continue;
      if (den && cheieDenumire(um) === den) continue;
      const pune = (harta, cheie) => {
        if (!cheie) return;
        if (!harta.has(cheie)) harta.set(cheie, new Map());
        const h = harta.get(cheie);
        h.set(um, (h.get(um) || 0) + 1);
      };
      pune(dovezi, den);
      pune(dovezi0, String(p.cod || "").trim().toLowerCase());
    }

    const deReparat = [];
    for (const p of produse) {
      const den = umCurata(p.denumire);
      const um = umCurata(p.unitate_masura);
      if (!um) continue;
      const repetaDenumirea = den && (cheieDenumire(um) === cheieDenumire(den) || (den.length >= 8 && cheieDenumire(um).includes(cheieDenumire(den))));
      const doarCifre = /^[\d.,\s]+$/.test(um);
      if (!repetaDenumirea && !doarCifre) continue;

      let nou = "buc";
      let sursa = "implicit";
      const hCod = dovezi0.get(String(p.cod || "").trim().toLowerCase());
      const hDen = dovezi.get(cheieDenumire(den));
      const h = hCod && hCod.size ? hCod : hDen;
      if (h && h.size) {
        const [cel] = [...h.entries()].sort((a, b) => b[1] - a[1]);
        nou = cel[0];
        sursa = hCod && hCod.size ? `același cod, alt rând (${cel[1]}×)` : `același produs, alt rând (${cel[1]}×)`;
      }
      if (umCurata(nou) === um) continue;
      deReparat.push({ ...p, um, nou, sursa, motiv: doarCifre ? "doar cifre" : "repetă denumirea" });
    }
    return deReparat;
  }

  // Reparările făcute până acum, cu cele netrase încă înapoi. Butonul de
  // desfăcut se arată numai dacă există ceva de desfăcut.
  async function reparariUm() {
    return await db
      .prepare(
        `SELECT r.id, r.facut_la, r.nr_produse, r.anulata_la, u.nume AS autor
           FROM reparatii_um r LEFT JOIN utilizatori u ON u.id = r.facut_de
          ORDER BY r.id DESC`
      )
      .all()
      .catch(() => []);
  }

  router.get("/admin/date/um-strambe", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const d = await umStrambe();
    const dinDovada = d.filter((x) => x.sursa !== "implicit").length;
    const facute = await reparariUm();

    const body = `
      <div class="toolbar"><a class="btn secondary" href="/admin/date">← Înapoi la verificări</a></div>
      <h1 style="margin:6px 0 2px">Unitatea de măsură ține denumirea produsului</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:880px">
        În coloana <strong>UM</strong> a ajuns denumirea produsului, nu o unitate — importul a citit coloanele pe dos.
        De-aia cantitățile se citesc aiurea peste tot: „1720 JUMBO BD 1620MMX 4050" în loc de „1 buc".
        Unitățile adevărate, oricât de neobișnuite (<em>o mie de bucăți</em>, <em>centimetru pătrat</em>,
        <em>unitate activă</em>), rămân neatinse — se repară doar cele care repetă denumirea sau sunt doar cifre.
      </p>

      <div class="cards">
        <div class="card"><div class="label">Produse de reparat</div><div class="value">${d.length}</div></div>
        <div class="card"><div class="label">Cu unitate dovedită</div><div class="value" style="color:var(--success)">${dinDovada}</div>
          <div style="font-size:12px;color:var(--text-muted)">luată de la același produs, alt rând</div></div>
        <div class="card"><div class="label">Puse pe „buc"</div><div class="value">${d.length - dinDovada}</div>
          <div style="font-size:12px;color:var(--text-muted)">n-avem altă dovadă</div></div>
      </div>

      <h2>Ce se schimbă</h2>
      ${table(
        ["Produs", "Cod", "UM acum", "Devine", "De unde", "De ce"],
        d.slice(0, 300).map((p) => [
          `<a href="/produse/${p.id}">${esc(String(p.denumire || "").slice(0, 60))}</a>`,
          esc(p.cod || "—"),
          `<span style="color:var(--danger)">${esc(String(p.um).slice(0, 40))}</span>`,
          `<strong style="color:var(--success)">${esc(p.nou)}</strong>`,
          esc(p.sursa),
          esc(p.motiv),
        ])
      )}
      ${d.length > 300 ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele 300 din ${d.length}.</p>` : ""}

      ${
        d.length
          ? `<form method="post" action="/admin/date/repara-um" style="margin-top:18px"
                   onsubmit="return confirm('Se schimbă unitatea de măsură la ${d.length} produse. Nimic altceva nu se atinge. Continui?')">
               <button class="btn" type="submit">Repară unitățile la cele ${d.length} produse</button>
               <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Se poate da înapoi — ce era înainte rămâne scris.</span>
             </form>`
          : `<p style="color:var(--success)">Nu e nimic de reparat.</p>`
      }

      ${
        facute.length
          ? `<h2 style="margin-top:26px">Reparări făcute</h2>
             ${table(
               ["Când", "Cine", "Produse", "Stare", ""],
               facute.map((r) => [
                 esc(r.facut_la || ""),
                 esc(r.autor || "—"),
                 String(r.nr_produse),
                 r.anulata_la
                   ? `<span style="color:var(--text-muted)">dată înapoi ${esc(r.anulata_la)}</span>`
                   : '<span style="color:var(--success)">în vigoare</span>',
                 r.anulata_la
                   ? ""
                   : `<form method="post" action="/admin/date/repara-um/desfa" class="inline-form"
                            onsubmit="return confirm('Pun unitățile înapoi cum erau înainte de reparare?')">
                        <input type="hidden" name="id" value="${Number(r.id)}">
                        <button class="link-btn" type="submit">dă înapoi</button>
                      </form>`,
               ])
             )}`
          : ""
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Unități de măsură", active: "/admin/date", body }));
  });

  router.post("/admin/date/repara-um", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const d = await umStrambe();
    if (!d.length) return redirect(ctx.res, "/admin/date/um-strambe");

    // Ce era înainte se scrie PRIMUL. Dacă scrierea asta pică, nu se schimbă
    // nimic: mai bine o reparare nefăcută decât una fără drum de întoarcere.
    const vechi = d.map((p) => [Number(p.id), String(p.um || ""), String(p.nou || "")]);
    const r = await db
      .prepare("INSERT INTO reparatii_um (facut_de, nr_produse, vechi) VALUES (?, ?, ?) RETURNING id")
      .run(ctx.user.id || null, d.length, JSON.stringify(vechi));

    let n = 0;
    for (const p of d) {
      await db.prepare("UPDATE produse SET unitate_masura = ? WHERE id = ?").run(p.nou, p.id);
      n++;
    }
    const dinDovada = d.filter((x) => x.sursa !== "implicit").length;
    const body = `
      <h2>Reparat</h2>
      <p>Am pus unitatea de măsură la <strong>${n}</strong> ${n === 1 ? "produs" : "produse"}:
      ${dinDovada} cu unitatea luată de la același produs de pe alt rând, ${n - dinDovada} pe „buc".</p>
      <p style="color:var(--text-muted);font-size:13px">Nimic altceva nu s-a schimbat — nici prețuri, nici stocuri, nici linii de factură.
      Ce era înainte e scris: se poate da înapoi din pagina de unități${r && r.lastInsertRowid ? ` (reparare #${r.lastInsertRowid})` : ""}.</p>
      <a class="btn secondary" href="/admin/date/um-strambe">Înapoi la unități</a>
      <a class="btn secondary" href="/admin/date">Înapoi la verificări</a>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Reparare unități", active: "/admin/date", body }));
  });

  // Drumul de întoarcere. Se pune înapoi DOAR acolo unde unitatea curentă e
  // încă cea pusă de buton — un produs pe care l-a corectat un om între timp
  // rămâne cum l-a lăsat el.
  router.post("/admin/date/repara-um/desfa", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");
    const id = parseInt((ctx.body || {}).id, 10);
    if (!id) return redirect(ctx.res, "/admin/date/um-strambe");
    const rep = await db.prepare("SELECT id, vechi, anulata_la FROM reparatii_um WHERE id = ?").get(id);
    if (!rep || rep.anulata_la) return redirect(ctx.res, "/admin/date/um-strambe");

    let randuri = [];
    try {
      randuri = JSON.parse(rep.vechi || "[]");
    } catch (e) {
      randuri = [];
    }
    let pusiInapoi = 0;
    let lasati = 0;
    for (const [pid, umVeche, umNoua] of randuri) {
      const p = await db.prepare("SELECT unitate_masura FROM produse WHERE id = ?").get(pid);
      if (!p) continue;
      if (String(p.unitate_masura || "") !== String(umNoua || "")) {
        lasati++;
        continue;
      }
      await db.prepare("UPDATE produse SET unitate_masura = ? WHERE id = ?").run(umVeche, pid);
      pusiInapoi++;
    }
    await db
      .prepare("UPDATE reparatii_um SET anulata_la = ?, anulata_de = ? WHERE id = ?")
      .run(new Date().toISOString().slice(0, 19).replace("T", " "), ctx.user.id || null, id);

    const body = `
      <h2>Dat înapoi</h2>
      <p>Am pus unitatea veche la <strong>${pusiInapoi}</strong> ${pusiInapoi === 1 ? "produs" : "produse"}.
      ${lasati ? `${lasati} ${lasati === 1 ? "a rămas" : "au rămas"} cum ${lasati === 1 ? "e" : "sunt"} — ${lasati === 1 ? "i-a" : "le-a"} schimbat cineva între timp.` : ""}</p>
      <a class="btn secondary" href="/admin/date/um-strambe">Înapoi la unități</a>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Dat înapoi", active: "/admin/date", body }));
  });

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
          ${r.rez.n === 0 ? '<p style="color:var(--success);font-size:13px">Nimic de semnalat.</p>' : `<p style="font-size:13px"><strong>${esc(r.rez.sumar)}</strong></p>${butonulVerificarii(r.rez.actiune)}${table(r.rez.antet, r.rez.randuri)}${r.rez.n > LIMITA ? `<p style="font-size:12px;color:var(--text-muted)">Se arată primele ${LIMITA} din ${r.rez.n}.</p>` : ""}`}
          ${r.rez.nota ? `<p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">${esc(r.rez.nota)}</p>` : ""}`;
      })
      .join("");

    // Curățările de duplicate făcute până acum, cu butonul de anulare.
    let curatariDupl = [];
    try {
      curatariDupl = await db
        .prepare(
          `SELECT c.*, u.nume AS autor FROM curatari_duplicate c
             LEFT JOIN utilizatori u ON u.id = c.facut_de ORDER BY c.id DESC LIMIT 10`
        )
        .all();
    } catch (e) {
      curatariDupl = [];
    }
    const blocCuratari = curatariDupl.length
      ? `<h2>Documente scoase din bază</h2>${table(
          ["Când", "Cine", "De ce", "Documente scoase", "Sumă", ""],
          curatariDupl.map((c) => [
            esc(String(c.facut_la || "").slice(0, 16)),
            esc(c.autor || "—"),
            String(c.directie || "").endsWith("-test")
              ? '<span class="badge gri">document de test</span>'
              : '<span class="badge gri">exemplar duplicat</span>',
            String(c.nr_documente),
            money(c.suma),
            c.anulata_la
              ? `<span class="badge gri">anulată ${esc(String(c.anulata_la).slice(0, 10))}</span>`
              : `<form method="post" action="/admin/date/duplicate/${c.id}/anuleaza" class="inline-form" onsubmit="return confirm('Pun la loc cele ${c.nr_documente} documente?')"><button class="link-btn danger" type="submit">Anulează</button></form>`,
          ])
        )}`
      : "";

    const curatare = await incasariDeCuratat();
    const curatareSuma = curatare.deScos.reduce((s2, r) => s2 + nr(r.suma), 0);
    const strambe = await cantitatiStrambe();
    const umRele = await umStrambe();
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
      ${
        umRele.length
          ? `<div class="card" style="border-left:4px solid var(--warn);margin-bottom:16px">
               <div class="label">Unitatea de măsură ține denumirea produsului</div>
               <div class="value">${umRele.length} produse</div>
               <p style="font-size:13px;margin:8px 0 10px;color:var(--text-muted)">
                 În coloana „UM" a ajuns denumirea produsului, nu o unitate — de-aia cantitățile se citesc
                 „1720 JUMBO BD 1620MMX 4050" în loc de „1 buc". Unitățile adevărate rămân neatinse.
               </p>
               <p style="font-size:12px;margin:0;color:var(--text-muted)">
                 <a href="/admin/date/um-strambe">Vezi ce se schimbă la fiecare produs →</a>
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
      ${blocCuratari}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Verificări date", active: "/admin/date", body }));
  });

  // ---- curățarea facturilor duplicate -------------------------------------
  // Butonul folosește EXACT interogarea care alimentează raportul
  // („vanzari-duplicate”, prin sqlDuplicate), ca să nu poată atinge niciodată
  // altceva decât rândurile pe care le vezi acolo. Din fiecare grup rămâne
  // exemplarul cu id-ul cel mai mic — primul intrat, adică originalul — iar
  // restul trec pe activ = 0. Id-urile atinse rămân scrise, deci se poate da
  // înapoi întreg.
  router.post("/admin/date/duplicate/curata", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/admin/date");
    const grupuri = await db.prepare(sqlDuplicate("vanzare")).all();

    const deScos = [];
    let suma = 0;
    for (const g of grupuri) {
      const ids = String(g.ids || "")
        .split(",")
        .map((x) => Number(x))
        .filter((x) => x > 0)
        .sort((a, b) => a - b);
      if (ids.length < 2) continue;
      for (const id of ids.slice(1)) deScos.push(id);
      suma += nr(g.suma) * (ids.length - 1);
    }
    if (!deScos.length) return redirect(ctx.res, "/admin/date#vanzari-duplicate");

    const LOT = 200;
    for (let i = 0; i < deScos.length; i += LOT) {
      const lot = deScos.slice(i, i + LOT);
      await db.prepare(`UPDATE facturi SET activ = 0 WHERE id IN (${lot.map(() => "?").join(",")})`).run(...lot);
    }
    await db
      .prepare("INSERT INTO curatari_duplicate (facut_de, directie, nr_documente, suma, ids) VALUES (?, 'vanzare', ?, ?, ?)")
      .run(ctx.user.id, deScos.length, suma, JSON.stringify(deScos));
    redirect(ctx.res, "/admin/date?curatate=" + deScos.length + "#vanzari-duplicate");
  });

  // ---- curățarea numerelor de factură refolosite --------------------------
  // Folosește EXACT aceeași funcție ca raportul, deci nu poate atinge alt rând
  // decât cel numărat în eticheta butonului. Intră în același istoric ca
  // duplicatele stricte, ca să meargă și readucerea.
  router.post("/admin/date/numar-refolosit/curata", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/admin/date");
    const { deScos } = await exemplareDeScosDinNumereRefolosite();
    if (!deScos.length) return redirect(ctx.res, "/admin/date#numar-refolosit");

    const sume = await db
      .prepare(
        `SELECT COALESCE(SUM(t.total), 0) AS suma
           FROM facturi f
           LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
          WHERE f.id IN (${deScos.map(() => "?").join(",")})`
      )
      .get(...deScos);

    const LOT = 200;
    for (let i = 0; i < deScos.length; i += LOT) {
      const lot = deScos.slice(i, i + LOT);
      await db.prepare(`UPDATE facturi SET activ = 0 WHERE id IN (${lot.map(() => "?").join(",")})`).run(...lot);
    }
    await db
      .prepare("INSERT INTO curatari_duplicate (facut_de, directie, nr_documente, suma, ids) VALUES (?, 'vanzare', ?, ?, ?)")
      .run(ctx.user.id, deScos.length, nr(sume && sume.suma), JSON.stringify(deScos));
    redirect(ctx.res, "/admin/date?curatate=" + deScos.length + "#numar-refolosit");
  });

  // ---- scoaterea unui document de test din bază ---------------------------
  //
  // Vali a recunoscut două facturi de la BSI A/S, cu numere tastate la
  // întâmplare, care țineau 19,2 milioane în „de plătit". Nu-s de șters: se
  // scot din calcule (activ = 0) și rămân în istoric, de unde se pot readuce
  // cu butonul „Anulează" ca orice curățare. Se trece prin aceeași pagină de
  // confirmare ca la căsuțe: întâi vezi ce document e și cât ține, apoi apeși.
  router.get("/admin/date/document/:id/scoate", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    if (ctx.user.rol !== "admin") return redirect(ctx.res, "/admin/date");
    const id = Number(ctx.params.id);
    if (!(id > 0)) return redirect(ctx.res, "/admin/date");
    const f = await db
      .prepare(
        `SELECT f.id, f.directie, f.serie, f.numar, f.document_extern, f.data_emiterii, f.status,
                p.nume AS partener, COALESCE(t.total,0) AS total,
                (SELECT COUNT(*) FROM facturi_linii WHERE factura_id = f.id) AS linii,
                (SELECT COUNT(*) FROM (SELECT * FROM plati WHERE activ = 1) x WHERE x.factura_id = f.id) AS plati
           FROM (SELECT * FROM facturi WHERE activ = 1) f
           LEFT JOIN parteneri p ON p.id = f.partener_id
           LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
          WHERE f.id = ?`
      )
      .get(id);
    if (!f) return redirect(ctx.res, "/admin/date#facturi-sume-uriase");

    const nume = esc(f.document_extern || String(f.serie || "") + String(f.numar || ""));
    const body = `
      <h2>Scoți documentul ${nume} din bază?</h2>
      <div class="card" style="max-width:720px;border-left:4px solid var(--danger)">
        <ul style="margin:0 0 12px 18px">
          <li><strong>${nume}</strong> — ${f.directie === "achizitie" ? "achiziție" : "vânzare"} de la ${esc(f.partener || "—")}</li>
          <li>emisă ${esc(String(f.data_emiterii || "").slice(0, 10))}, ${money(f.total)}</li>
          <li>${Number(f.linii)} linii, ${Number(f.plati)} plăți legate de ea</li>
        </ul>
        <p style="margin:0 0 12px">Documentul <strong>nu se șterge</strong>: iese din toate calculele — „de plătit", „de încasat", rapoarte, scadențar — și rămâne în istoricul de jos, de unde îl poți readuce oricând cu „Anulează".</p>
        <p style="margin:0 0 16px;color:var(--danger)">Fă asta doar dacă recunoști documentul ca fiind de test. Un contract sau un utilaj adevărat, scos de aici, dispare din toate cifrele firmei.</p>
        <form method="post" action="/admin/date/document/${f.id}/scoate" class="inline-form">
          <input type="hidden" name="da" value="1">
          <button class="btn" type="submit" style="background:var(--danger);border-color:var(--danger)">Scoate ${nume} din bază</button>
          <a class="btn secondary" href="/admin/date#facturi-sume-uriase">Renunță</a>
        </form>
      </div>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Scoate un document din bază", active: "/admin/date", body }));
  });

  router.post("/admin/date/document/:id/scoate", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/admin/date");
    const id = Number(ctx.params.id);
    if (!(id > 0) || String((ctx.body || {}).da) !== "1") return redirect(ctx.res, "/admin/date");
    const f = await db
      .prepare(
        `SELECT f.id, f.directie, COALESCE(t.total,0) AS total
           FROM (SELECT * FROM facturi WHERE activ = 1) f
           LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
          WHERE f.id = ?`
      )
      .get(id);
    if (!f) return redirect(ctx.res, "/admin/date#facturi-sume-uriase");
    await db.prepare("UPDATE facturi SET activ = 0 WHERE id = ?").run(id);
    // Intră în același istoric ca duplicatele, ca să meargă și readucerea:
    // butonul „Anulează" de acolo repune activ = 1 după lista de id-uri.
    await db
      .prepare("INSERT INTO curatari_duplicate (facut_de, directie, nr_documente, suma, ids) VALUES (?, ?, 1, ?, ?)")
      .run(ctx.user.id, f.directie === "achizitie" ? "achizitie-test" : "vanzare-test", nr(f.total), JSON.stringify([id]));
    redirect(ctx.res, "/admin/date#facturi-sume-uriase");
  });

  router.post("/admin/date/duplicate/:id/anuleaza", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/admin/date");
    const c = await db.prepare("SELECT * FROM curatari_duplicate WHERE id = ?").get(ctx.params.id);
    if (!c || c.anulata_la) return redirect(ctx.res, "/admin/date");
    let ids = [];
    try { ids = JSON.parse(c.ids || "[]"); } catch (e) { ids = []; }
    const LOT = 200;
    for (let i = 0; i < ids.length; i += LOT) {
      const lot = ids.slice(i, i + LOT);
      await db.prepare(`UPDATE facturi SET activ = 1 WHERE id IN (${lot.map(() => "?").join(",")})`).run(...lot);
    }
    await db
      .prepare("UPDATE curatari_duplicate SET anulata_la = ?, anulata_de = ? WHERE id = ?")
      .run(new Date().toISOString().slice(0, 19).replace("T", " "), ctx.user.id, c.id);
    redirect(ctx.res, "/admin/date#vanzari-duplicate");
  });
}

module.exports = { register, clasificaIncasare, CAUZE_INCASARI, SQL_INCASARI_PESTE };
