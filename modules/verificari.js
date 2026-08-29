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
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id)";

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
                  (SELECT COUNT(*) FROM plati x WHERE x.factura_id = f.id) AS nr_plati
             FROM facturi f
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
             FROM plati pl
             JOIN facturi f ON f.id = pl.factura_id
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
            `SELECT f.id, f.serie, f.numar, p.nume AS partener FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`
          )
          .get(g.factura_id);
        const zile = await db
          .prepare("SELECT data, metoda, observatii FROM plati WHERE factura_id = ? AND suma = ? ORDER BY data")
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
             FROM facturi f
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
             FROM plati pl
             JOIN facturi f ON f.id = pl.factura_id
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
    cheie: "facturi-fara-agent",
    titlu: "Facturi de vânzare fără agent",
    de_ce: "Fără agent, factura nu intră în comision și nu apare în raportul pe agenți. Recalcularea din Alocări le pune pe administrator.",
    gravitate: "info",
    async ruleaza() {
      const randuri = await db
        .prepare(
          `SELECT f.id, f.serie, f.numar, f.data_emiterii, p.nume AS partener
             FROM facturi f JOIN parteneri p ON p.id = f.partener_id
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

function register(router) {
  router.get("/admin/date", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return send(ctx.res, 403, "Doar administratorul.");

    // Facturat vs încasat, an cu an: dacă undeva încasările sar peste
    // facturi, anul acela e locul de unde se începe săpatul.
    const peAn = await db
      .prepare(
        `SELECT an, SUM(facturat) AS facturat, SUM(incasat) AS incasat FROM (
           SELECT SUBSTR(f.data_emiterii,1,4) AS an, COALESCE(t.total,0) AS facturat, 0 AS incasat
             FROM facturi f LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
           UNION ALL
           SELECT SUBSTR(pl.data,1,4) AS an, 0 AS facturat, pl.suma AS incasat
             FROM plati pl JOIN facturi f ON f.id = pl.factura_id
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

    const body = `
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
