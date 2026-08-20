"use strict";
// Modul Rapoarte — un hub cu rapoarte grupate pe categorii (financiare,
// operaționale, comerciale), fiecare la propriul URL. Toate calculele se fac
// agregat, în SQL: baza reală are mii de facturi importate din SmartBill, iar
// varianta "aduc tot în memorie și calculez în JS" ar face paginile inutilizabile.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Subinterogări refolosite: totalul fiecărei facturi (calculat din liniile ei)
// și cât s-a încasat/plătit pe ea. Scrise o singură dată ca să nu divergă
// între rapoarte — dacă se schimbă formula, se schimbă într-un singur loc.
const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id)";

const CATEGORII = [
  {
    titlu: "Financiare",
    descriere: "Bani: ce ai facturat, ce ai încasat, ce mai ai de încasat și când.",
    rapoarte: [
      {
        href: "/rapoarte/balanta",
        nume: "Balanță de verificare (la zi)",
        desc: "Balanță contabilă pe planul de conturi RO, generată automat din documente: solduri inițiale, rulaje, total sume, solduri finale — pe orice perioadă sau zi.",
      },
      {
        href: "/rapoarte/tva",
        nume: "TVA de plată (la zi)",
        desc: "TVA colectată minus TVA deductibilă, în orice moment: pe luna curentă, pe orice perioadă și cumulat la zi.",
      },
      {
        href: "/rapoarte/incasari",
        nume: "Scadențar încasări (pe zile)",
        desc: "Cât ai de încasat în fiecare zi, după scadența facturii. Statusul se poate schimba direct din listă.",
      },
      {
        href: "/rapoarte/restante",
        nume: "Restanțe & vechime (aging)",
        desc: "Facturi neîncasate grupate pe întârziere: nescadente, 1–30, 31–60, 61–90 și peste 90 de zile.",
      },
      { href: "/rapoarte/vanzari", nume: "Vânzări vs. achiziții", desc: "Evoluția lunară a facturării și diferența dintre vânzări și achiziții." },
      { href: "/rapoarte/parteneri", nume: "Top clienți & furnizori", desc: "Cine aduce cei mai mulți bani și către cine pleacă cei mai mulți." },
    ],
  },
  {
    titlu: "Operaționale",
    descriere: "Marfă și execuție: stocuri, comenzi, ce e blocat.",
    rapoarte: [
      { href: "/rapoarte/stocuri", nume: "Situația stocurilor", desc: "Stoc curent pe produs și pe depozit, cu alertă la produsele sub stocul minim." },
      { href: "/rapoarte/comenzi", nume: "Comenzi pe status", desc: "Câte comenzi sunt în fiecare stadiu și care sunt cele mai vechi nefinalizate." },
    ],
  },
  {
    titlu: "Comerciale",
    descriere: "Clienți și vânzare: pipeline, activitate, clienți în risc de pierdere.",
    rapoarte: [
      { href: "/rapoarte/forecast", nume: "Forecast vânzări", desc: "Proiecție pe următoarele luni din sezonalitatea și trendul istoricului real, cu scenarii pesimist/probabil/optimist și pipeline-ul CRM ponderat." },
      { href: "/rapoarte/agenti", nume: "Profitabilitate pe agent & client", desc: "Venit, marjă (unde există costuri), pipeline și solduri pe fiecare agent — cu detaliu pe clienții lui." },
      { href: "/rapoarte/pipeline", nume: "Pipeline oportunități", desc: "Valoarea oportunităților deschise pe fiecare stadiu din CRM." },
      { href: "/rapoarte/clienti", nume: "Clienți activi & inactivi", desc: "Cine a cumpărat recent și cine n-a mai cumpărat de mult." },
    ],
  },
];

// Lista lunilor, construită din componente locale (NU din toISOString pe o
// dată locală — asta putea sări o lună în urmă pentru fusurile cu offset
// pozitiv, exact cazul României).
function lunileUltimele(n) {
  const azi = new Date();
  const rez = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(azi.getFullYear(), azi.getMonth() - i, 1);
    rez.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return rez;
}

function bar(pct, cls) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="bar-track"><div class="bar-fill ${cls}" style="width:${p}%"></div></div>`;
}

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function subnav(activ) {
  const linkuri = CATEGORII.flatMap((c) => c.rapoarte)
    .map((r) => `<a href="${r.href}" class="subnav-link${activ === r.href ? " activ" : ""}">${esc(r.nume)}</a>`)
    .join("");
  return `<div class="subnav"><a href="/rapoarte" class="subnav-link${activ === "/rapoarte" ? " activ" : ""}">Toate rapoartele</a>${linkuri}</div>`;
}

function pagina(ctx, titlu, activ, continut) {
  return layout({ user: ctx.user, title: titlu, active: "/rapoarte", body: subnav(activ) + continut });
}

function register(router) {
  // ---- Hub -------------------------------------------------------------
  router.get("/rapoarte", async (ctx) => {
    const continut = CATEGORII.map(
      (c) => `
      <h2>${esc(c.titlu)}</h2>
      <p style="color:var(--text-muted);font-size:13px;margin:-4px 0 12px">${esc(c.descriere)}</p>
      <div class="rapoarte-grid">
        ${c.rapoarte
          .map(
            (r) => `<a class="raport-card" href="${r.href}">
              <div class="raport-nume">${esc(r.nume)}</div>
              <div class="raport-desc">${esc(r.desc)}</div>
            </a>`
          )
          .join("")}
      </div>`
    ).join("");
    send(ctx.res, 200, pagina(ctx, "Rapoarte", "/rapoarte", continut));
  });

  // ---- Financiar: scadențar încasări pe zile ---------------------------
  router.get("/rapoarte/incasari", async (ctx) => {
    const directie = ctx.query.directie === "achizitie" ? "achizitie" : "vanzare";
    const zile = Math.min(365, Math.max(7, parseInt(ctx.query.zile || "60", 10) || 60));
    const includeVechi = ctx.query.vechi !== "0";
    const aziStr = azi();
    const pana = new Date(Date.now() + zile * 86400000).toISOString().slice(0, 10);

    const facturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.data_scadenta, f.status, f.moneda,
                p.id AS partener_id, p.nume AS partener_nume,
                COALESCE(l.total, 0) AS total,
                COALESCE(pl.platit, 0) AS platit,
                COALESCE(l.total, 0) - COALESCE(pl.platit, 0) AS restant
         FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE f.directie = ? AND f.status <> 'anulata'
           AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5
           AND (f.data_scadenta <= ? OR f.data_scadenta = '' OR f.data_scadenta IS NULL)
         ORDER BY f.data_scadenta ASC, f.id ASC`
      )
      .all(directie, pana);

    const peZi = new Map();
    let totalRestant = 0;
    let totalDepasit = 0;
    for (const f of facturi) {
      const scad = (f.data_scadenta || "").slice(0, 10);
      const depasita = Boolean(scad) && scad < aziStr;
      if (depasita && !includeVechi) continue;
      const cheie = scad || "(fără scadență)";
      if (!peZi.has(cheie)) peZi.set(cheie, { zi: cheie, depasita, facturi: [], suma: 0 });
      const g = peZi.get(cheie);
      g.facturi.push(f);
      g.suma += Number(f.restant);
      totalRestant += Number(f.restant);
      if (depasita) totalDepasit += Number(f.restant);
    }
    // Facturile fără scadență (există în export — 158 în istoricul real) merg
    // la finalul listei, nu la început: altfel un singur document mare fără
    // dată domină raportul și ascunde ce chiar e scadent zilele astea.
    const grupuri = [...peZi.values()].sort((a, b) => {
      const aFara = a.zi === "(fără scadență)";
      const bFara = b.zi === "(fără scadență)";
      if (aFara !== bFara) return aFara ? 1 : -1;
      return a.zi < b.zi ? -1 : a.zi > b.zi ? 1 : 0;
    });
    const maxZi = Math.max(1, ...grupuri.map((g) => g.suma));

    const eticheta = directie === "achizitie" ? "de plătit" : "de încasat";
    const optiuniZile = [15, 30, 60, 90, 180, 365]
      .map((z) => `<option value="${z}"${zile === z ? " selected" : ""}>următoarele ${z} de zile</option>`)
      .join("");

    const continut = `
      <div class="cards">
        <div class="card"><div class="label">Total ${eticheta}</div><div class="value">${money(totalRestant)}</div></div>
        <div class="card"><div class="label">Din care depășit (scadență trecută)</div><div class="value" style="color:var(--danger)">${money(totalDepasit)}</div></div>
        <div class="card"><div class="label">Documente</div><div class="value">${grupuri.reduce((s, g) => s + g.facturi.length, 0)}</div></div>
      </div>

      <form class="filtre" method="get" action="/rapoarte/incasari">
        <select name="directie">
          <option value="vanzare"${directie === "vanzare" ? " selected" : ""}>Încasări de la clienți</option>
          <option value="achizitie"${directie === "achizitie" ? " selected" : ""}>Plăți către furnizori</option>
        </select>
        <select name="zile">${optiuniZile}</select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="checkbox" name="vechi" value="1"${includeVechi ? " checked" : ""}> include scadențele depășite
        </label>
        <button class="btn small" type="submit">Aplică</button>
      </form>

      ${
        grupuri.length === 0
          ? `<p>Nimic ${eticheta} în intervalul selectat.</p>`
          : grupuri
              .map(
                (g) => `
        <div class="zi-bloc${g.depasita ? " depasita" : ""}">
          <div class="zi-antet">
            <div class="zi-data">${esc(g.zi)}${
                  g.depasita ? ' <span class="badge rosu">depășit</span>' : g.zi === aziStr ? ' <span class="badge galben">azi</span>' : ""
                }</div>
            <div class="zi-suma">${money(g.suma)}</div>
          </div>
          ${bar((g.suma / maxZi) * 100, g.depasita ? "rosu" : "verde")}
          <table class="table" style="margin-top:10px">
            <tr><th>Document</th><th>${directie === "achizitie" ? "Furnizor" : "Client"}</th><th>Total</th><th>Achitat</th><th>Rest</th><th>Status</th></tr>
            ${g.facturi
              .map(
                (f) => `<tr>
                  <td><a href="/facturi/${f.id}">${esc(f.document_extern || `${f.serie}-${f.numar}`)}</a></td>
                  <td><a href="/parteneri/${f.partener_id}">${esc(f.partener_nume)}</a></td>
                  <td>${money(f.total)}</td>
                  <td>${money(f.platit)}</td>
                  <td><strong>${money(f.restant)}</strong></td>
                  <td>
                    <form method="post" action="/rapoarte/incasari/status" class="status-form">
                      <input type="hidden" name="factura_id" value="${f.id}">
                      <input type="hidden" name="redirect" value="${esc(ctx.req.url)}">
                      <select name="actiune" onchange="this.form.submit()">
                        <option value="">${f.status === "platita_partial" ? "achitat parțial" : "neachitat"}${g.depasita ? " · depășit" : ""}</option>
                        <option value="incasata">→ marchează achitat integral</option>
                        <option value="amana">→ amână scadența cu 30 de zile</option>
                        <option value="anulata">→ anulează documentul</option>
                      </select>
                    </form>
                    <form method="post" action="/rapoarte/incasari/status" class="status-form" style="margin-top:4px">
                      <input type="hidden" name="factura_id" value="${f.id}">
                      <input type="hidden" name="redirect" value="${esc(ctx.req.url)}">
                      <input type="hidden" name="actiune" value="scadenta">
                      <input type="date" name="scadenta" value="${esc((f.data_scadenta || "").slice(0, 10))}" onchange="this.form.submit()" title="Setează scadența">
                    </form>
                  </td>
                </tr>`
              )
              .join("")}
          </table>
        </div>`
              )
              .join("")
      }
      <p style="font-size:12px;color:var(--text-muted);margin-top:18px">
        „Depășit” nu e un status stocat, ci se calculează automat din scadență față de ziua curentă — așa nu poate rămâne niciodată nesincronizat.
        Statusul stocat pe factură (neachitat / achitat parțial / achitat / anulat) se schimbă din coloana Status.
      </p>
    `;
    send(ctx.res, 200, pagina(ctx, `Scadențar ${directie === "achizitie" ? "plăți" : "încasări"}`, "/rapoarte/incasari", continut));
  });

  router.post("/rapoarte/incasari/status", async (ctx) => {
    const id = parseInt(ctx.body.factura_id, 10);
    const actiune = String(ctx.body.actiune || "");
    const inapoi = String(ctx.body.redirect || "/rapoarte/incasari");
    if (!id || !actiune) return redirect(ctx.res, inapoi);

    const f = await db
      .prepare(
        `SELECT f.id, f.data_scadenta, COALESCE(l.total,0) AS total, COALESCE(pl.platit,0) AS platit
         FROM facturi f
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE f.id = ?`
      )
      .get(id);
    if (!f) return redirect(ctx.res, inapoi);

    if (actiune === "incasata") {
      const rest = Number(f.total) - Number(f.platit);
      if (rest > 0.005) {
        await db
          .prepare("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (?, ?, ?, 'manual', ?)")
          .run(id, rest, azi(), `Marcat achitat din scadențar de ${ctx.user ? ctx.user.nume : "utilizator"}`);
      }
      await db.prepare("UPDATE facturi SET status = 'platita' WHERE id = ?").run(id);
    } else if (actiune === "anulata") {
      await db.prepare("UPDATE facturi SET status = 'anulata' WHERE id = ?").run(id);
    } else if (actiune === "scadenta") {
      // 158 de facturi din exportul SmartBill n-au scadență completată —
      // câmpul de dată din raport permite setarea ei fără să deschizi factura.
      const noua = String(ctx.body.scadenta || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(noua)) await db.prepare("UPDATE facturi SET data_scadenta = ? WHERE id = ?").run(noua, id);
    } else if (actiune === "amana") {
      const baza = f.data_scadenta && f.data_scadenta >= azi() ? f.data_scadenta.slice(0, 10) : azi();
      const noua = new Date(baza + "T00:00:00Z");
      noua.setUTCDate(noua.getUTCDate() + 30);
      await db.prepare("UPDATE facturi SET data_scadenta = ? WHERE id = ?").run(noua.toISOString().slice(0, 10), id);
    }
    redirect(ctx.res, inapoi);
  });

  // ---- Financiar: restanțe cu vechime (aging) --------------------------
  router.get("/rapoarte/restante", async (ctx) => {
    const directie = ctx.query.directie === "achizitie" ? "achizitie" : "vanzare";
    const facturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.data_scadenta,
                p.id AS partener_id, p.nume AS partener_nume,
                COALESCE(l.total,0) - COALESCE(pl.platit,0) AS restant
         FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE f.directie = ? AND f.status <> 'anulata' AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5
         ORDER BY f.data_scadenta ASC`
      )
      .all(directie);

    const aziStr = azi();
    const intervale = [
      { nume: "Nescadente încă", test: (z) => z === null || z < 0, suma: 0, nr: 0, cls: "verde" },
      { nume: "1–30 zile întârziere", test: (z) => z !== null && z >= 0 && z <= 30, suma: 0, nr: 0, cls: "galben" },
      { nume: "31–60 zile", test: (z) => z !== null && z > 30 && z <= 60, suma: 0, nr: 0, cls: "galben" },
      { nume: "61–90 zile", test: (z) => z !== null && z > 60 && z <= 90, suma: 0, nr: 0, cls: "rosu" },
      { nume: "Peste 90 de zile", test: (z) => z !== null && z > 90, suma: 0, nr: 0, cls: "rosu" },
    ];
    const perPartener = new Map();
    const detalii = [];
    for (const f of facturi) {
      const scad = (f.data_scadenta || "").slice(0, 10);
      const zileInt = scad ? Math.floor((Date.parse(aziStr) - Date.parse(scad)) / 86400000) : null;
      const rest = Number(f.restant);
      const interval = intervale.find((i) => i.test(zileInt)) || intervale[0];
      interval.suma += rest;
      interval.nr++;
      if (!perPartener.has(f.partener_id))
        perPartener.set(f.partener_id, { nume: f.partener_nume, id: f.partener_id, suma: 0, nr: 0, celMaiVechi: null });
      const pp = perPartener.get(f.partener_id);
      pp.suma += rest;
      pp.nr++;
      if (zileInt !== null && (pp.celMaiVechi === null || zileInt > pp.celMaiVechi)) pp.celMaiVechi = zileInt;
      if (zileInt !== null && zileInt > 0) detalii.push({ f, rest, zileInt });
    }
    detalii.sort((a, b) => b.zileInt - a.zileInt);
    const topPartener = [...perPartener.values()].sort((a, b) => b.suma - a.suma).slice(0, 20);
    const totalRestant = intervale.reduce((s, i) => s + i.suma, 0);
    const maxInterval = Math.max(1, ...intervale.map((i) => i.suma));

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/restante">
        <select name="directie" onchange="this.form.submit()">
          <option value="vanzare"${directie === "vanzare" ? " selected" : ""}>De încasat de la clienți</option>
          <option value="achizitie"${directie === "achizitie" ? " selected" : ""}>De plătit către furnizori</option>
        </select>
      </form>
      <div class="cards">
        <div class="card"><div class="label">Total deschis</div><div class="value">${money(totalRestant)}</div></div>
        <div class="card"><div class="label">Documente deschise</div><div class="value">${facturi.length}</div></div>
        <div class="card"><div class="label">Parteneri implicați</div><div class="value">${perPartener.size}</div></div>
      </div>

      <h2>Vechimea sumelor (aging)</h2>
      <div class="chart">
        ${intervale
          .map(
            (i) => `<div class="chart-row">
              <div class="chart-label" style="width:auto">${esc(i.nume)}</div>
              <div class="chart-bars">${bar((i.suma / maxInterval) * 100, i.cls)}</div>
              <div class="chart-values">${money(i.suma)} · ${i.nr} doc.</div>
            </div>`
          )
          .join("")}
      </div>

      <h2>Parteneri cu cele mai mari solduri</h2>
      ${table(
        ["Partener", "Sold", "Documente", "Cea mai veche întârziere"],
        topPartener.map((p) => [
          `<a href="/parteneri/${p.id}">${esc(p.nume)}</a>`,
          money(p.suma),
          p.nr,
          p.celMaiVechi !== null && p.celMaiVechi > 0
            ? `<span class="badge ${p.celMaiVechi > 60 ? "rosu" : "galben"}">${p.celMaiVechi} zile</span>`
            : "—",
        ])
      )}

      <h2>Documente cu scadența depășită ${detalii.length > 100 ? "(primele 100, cele mai vechi)" : ""}</h2>
      ${table(
        ["Document", "Partener", "Scadență", "Întârziere", "Rest"],
        detalii.slice(0, 100).map((d) => [
          `<a href="/facturi/${d.f.id}">${esc(d.f.document_extern || `${d.f.serie}-${d.f.numar}`)}</a>`,
          `<a href="/parteneri/${d.f.partener_id}">${esc(d.f.partener_nume)}</a>`,
          esc((d.f.data_scadenta || "").slice(0, 10)) || "—",
          `<span class="badge ${d.zileInt > 60 ? "rosu" : "galben"}">${d.zileInt} zile</span>`,
          money(d.rest),
        ])
      )}
    `;
    send(ctx.res, 200, pagina(ctx, "Restanțe & vechime", "/rapoarte/restante", continut));
  });

  // ---- Financiar: vânzări vs. achiziții --------------------------------
  router.get("/rapoarte/vanzari", async (ctx) => {
    const nrLuni = Math.min(36, Math.max(6, parseInt(ctx.query.luni || "12", 10) || 12));
    const luni = lunileUltimele(nrLuni);
    const deLa = luni[0] + "-01";

    const randuri = await db
      .prepare(
        `SELECT f.directie, SUBSTR(f.data_emiterii, 1, 7) AS luna, COALESCE(SUM(l.total), 0) AS valoare, COUNT(*) AS nr
         FROM facturi f
         JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         WHERE f.status <> 'anulata' AND f.data_emiterii >= ?
         GROUP BY f.directie, SUBSTR(f.data_emiterii, 1, 7)`
      )
      .all(deLa);

    const perLuna = Object.fromEntries(luni.map((l) => [l, { vanzari: 0, achizitii: 0, nrV: 0 }]));
    let totalV = 0;
    let totalA = 0;
    for (const r of randuri) {
      const v = Number(r.valoare || 0);
      if (!perLuna[r.luna]) continue;
      if (r.directie === "achizitie") {
        perLuna[r.luna].achizitii += v;
        totalA += v;
      } else {
        perLuna[r.luna].vanzari += v;
        perLuna[r.luna].nrV += Number(r.nr);
        totalV += v;
      }
    }
    const maxLuna = Math.max(1, ...luni.map((l) => Math.max(perLuna[l].vanzari, perLuna[l].achizitii)));
    const optiuni = [6, 12, 24, 36].map((n) => `<option value="${n}"${nrLuni === n ? " selected" : ""}>ultimele ${n} de luni</option>`).join("");

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/vanzari">
        <select name="luni" onchange="this.form.submit()">${optiuni}</select>
      </form>
      <div class="cards">
        <div class="card"><div class="label">Vânzări</div><div class="value">${money(totalV)}</div></div>
        <div class="card"><div class="label">Achiziții</div><div class="value">${money(totalA)}</div></div>
        <div class="card"><div class="label">Diferență</div><div class="value">${money(totalV - totalA)}</div></div>
        <div class="card"><div class="label">Medie vânzări / lună</div><div class="value">${money(totalV / luni.length)}</div></div>
      </div>

      <h2>Evoluție lunară</h2>
      <div class="chart">
        ${luni
          .map(
            (l) => `<div class="chart-row">
              <div class="chart-label">${esc(l)}</div>
              <div class="chart-bars">
                ${bar((perLuna[l].vanzari / maxLuna) * 100, "verde")}
                ${bar((perLuna[l].achizitii / maxLuna) * 100, "rosu")}
              </div>
              <div class="chart-values">${money(perLuna[l].vanzari)} / ${money(perLuna[l].achizitii)}</div>
            </div>`
          )
          .join("")}
      </div>
      <p style="font-size:12px;color:var(--text-muted)">Bară verde = vânzări, bară roșie = achiziții (sume cu TVA).</p>

      <h2>Detaliu pe luni</h2>
      ${table(
        ["Luna", "Vânzări", "Facturi emise", "Achiziții", "Diferență"],
        luni
          .slice()
          .reverse()
          .map((l) => [esc(l), money(perLuna[l].vanzari), perLuna[l].nrV, money(perLuna[l].achizitii), money(perLuna[l].vanzari - perLuna[l].achizitii)])
      )}
    `;
    send(ctx.res, 200, pagina(ctx, "Vânzări vs. achiziții", "/rapoarte/vanzari", continut));
  });

  // ---- Financiar: top parteneri ----------------------------------------
  router.get("/rapoarte/parteneri", async (ctx) => {
    const nrLuni = Math.min(240, Math.max(1, parseInt(ctx.query.luni || "12", 10) || 12));
    const luni = lunileUltimele(nrLuni);
    const deLa = luni[0] + "-01";

    async function top(directie) {
      return await db
        .prepare(
          `SELECT p.id, p.nume, p.cui, COALESCE(SUM(l.total), 0) AS valoare, COUNT(*) AS nr, MAX(f.data_emiterii) AS ultima
           FROM facturi f
           JOIN parteneri p ON p.id = f.partener_id
           JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
           WHERE f.status <> 'anulata' AND f.directie = ? AND f.data_emiterii >= ?
           GROUP BY p.id, p.nume, p.cui
           ORDER BY valoare DESC
           LIMIT 25`
        )
        .all(directie, deLa);
    }
    const clienti = await top("vanzare");
    const furnizori = await top("achizitie");
    const totalC = clienti.reduce((s, c) => s + Number(c.valoare), 0);
    const optiuni = [3, 6, 12, 24, 240]
      .map((n) => `<option value="${n}"${nrLuni === n ? " selected" : ""}>${n >= 240 ? "tot istoricul" : `ultimele ${n} de luni`}</option>`)
      .join("");

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/parteneri">
        <select name="luni" onchange="this.form.submit()">${optiuni}</select>
      </form>

      <h2>Top clienți</h2>
      ${table(
        ["Client", "CUI", "Valoare facturată", "% din top", "Facturi", "Ultima factură"],
        clienti.map((c) => [
          `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
          esc(c.cui || "—"),
          money(c.valoare),
          totalC > 0 ? `${((Number(c.valoare) / totalC) * 100).toFixed(1)}%` : "—",
          c.nr,
          esc((c.ultima || "").slice(0, 10)),
        ])
      )}

      <h2>Top furnizori</h2>
      ${
        furnizori.length
          ? table(
              ["Furnizor", "CUI", "Valoare achiziționată", "Facturi", "Ultima factură"],
              furnizori.map((c) => [
                `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                esc(c.cui || "—"),
                money(c.valoare),
                c.nr,
                esc((c.ultima || "").slice(0, 10)),
              ])
            )
          : '<p>Nu există încă facturi de achiziție în ERP. Le poți importa din pagina <a href="/import">Import</a> sau adăuga manual din <a href="/facturi/achizitii">Achiziții</a>.</p>'
      }
    `;
    send(ctx.res, 200, pagina(ctx, "Top clienți & furnizori", "/rapoarte/parteneri", continut));
  });

  // ---- Operațional: stocuri --------------------------------------------
  router.get("/rapoarte/stocuri", async (ctx) => {
    const stocuri = await db
      .prepare(
        `SELECT p.id, p.denumire, p.cod, p.unitate_masura, p.stoc_minim, p.pret_achizitie,
                COALESCE(SUM(CASE WHEN m.tip = 'intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS stoc
         FROM produse p
         LEFT JOIN miscari_stoc m ON m.produs_id = p.id
         GROUP BY p.id, p.denumire, p.cod, p.unitate_masura, p.stoc_minim, p.pret_achizitie
         ORDER BY p.denumire`
      )
      .all();
    const subMinim = stocuri.filter((s) => Number(s.stoc_minim) > 0 && Number(s.stoc) <= Number(s.stoc_minim));
    const valoareTotala = stocuri.reduce((s, p) => s + Number(p.stoc) * Number(p.pret_achizitie || 0), 0);

    const peDepozit = await db
      .prepare(
        `SELECT d.denumire AS depozit, COUNT(DISTINCT m.produs_id) AS produse,
                COALESCE(SUM(CASE WHEN m.tip = 'intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS bucati
         FROM depozite d LEFT JOIN miscari_stoc m ON m.depozit_id = d.id
         GROUP BY d.id, d.denumire ORDER BY d.denumire`
      )
      .all();

    const continut = `
      <div class="cards">
        <div class="card"><div class="label">Produse în catalog</div><div class="value">${stocuri.length}</div></div>
        <div class="card"><div class="label">Sub stocul minim</div><div class="value" style="color:${subMinim.length ? "var(--danger)" : "inherit"}">${subMinim.length}</div></div>
        <div class="card"><div class="label">Valoare stoc (preț de achiziție)</div><div class="value">${money(valoareTotala)}</div></div>
      </div>

      ${
        stocuri.length === 0
          ? '<p>Nu există încă produse în ERP. Importă stocul din SmartBill din pagina <a href="/import">Import</a>.</p>'
          : `
      <h2>Produse sub stocul minim</h2>
      ${
        subMinim.length
          ? table(
              ["Produs", "Cod", "Stoc curent", "Stoc minim", "Lipsă"],
              subMinim.map((p) => [
                `<a href="/produse/${p.id}">${esc(p.denumire)}</a>`,
                esc(p.cod || "—"),
                `<span class="badge rosu">${p.stoc} ${esc(p.unitate_masura || "")}</span>`,
                p.stoc_minim,
                Math.max(0, Number(p.stoc_minim) - Number(p.stoc)),
              ])
            )
          : "<p>Niciun produs sub stocul minim.</p>"
      }

      <h2>Stoc pe depozite / gestiuni</h2>
      ${table(["Depozit", "Produse distincte", "Cantitate totală"], peDepozit.map((d) => [esc(d.depozit), d.produse, d.bucati]))}

      <h2>Situația completă a stocurilor</h2>
      ${table(
        ["Produs", "Cod", "Stoc", "UM", "Stoc minim", "Valoare"],
        stocuri.map((p) => [
          `<a href="/produse/${p.id}">${esc(p.denumire)}</a>`,
          esc(p.cod || "—"),
          p.stoc,
          esc(p.unitate_masura || "—"),
          p.stoc_minim || "—",
          money(Number(p.stoc) * Number(p.pret_achizitie || 0)),
        ])
      )}`
      }
    `;
    send(ctx.res, 200, pagina(ctx, "Situația stocurilor", "/rapoarte/stocuri", continut));
  });

  // ---- Operațional: comenzi --------------------------------------------
  router.get("/rapoarte/comenzi", async (ctx) => {
    const peStatus = await db.prepare("SELECT status, COUNT(*) AS nr FROM comenzi GROUP BY status ORDER BY nr DESC").all();
    const vechi = await db
      .prepare(
        `SELECT c.id, c.numar, c.data, c.status, p.nume AS partener_nume, p.id AS partener_id
         FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
         WHERE c.status NOT IN ('livrata', 'anulata', 'finalizata')
         ORDER BY c.data ASC LIMIT 50`
      )
      .all();
    const total = peStatus.reduce((s, r) => s + Number(r.nr), 0);
    const maxStatus = Math.max(1, ...peStatus.map((r) => Number(r.nr)));

    const continut = `
      <div class="cards">
        <div class="card"><div class="label">Comenzi în total</div><div class="value">${total}</div></div>
        <div class="card"><div class="label">Nefinalizate</div><div class="value">${vechi.length}</div></div>
      </div>
      ${
        total === 0
          ? '<p>Nu există încă comenzi în ERP. Le poți adăuga din <a href="/comenzi">Comenzi</a>.</p>'
          : `
      <h2>Comenzi pe status</h2>
      <div class="chart">
        ${peStatus
          .map(
            (r) => `<div class="chart-row">
              <div class="chart-label" style="width:auto">${esc(r.status)}</div>
              <div class="chart-bars">${bar((Number(r.nr) / maxStatus) * 100, "verde")}</div>
              <div class="chart-values">${r.nr} comenzi</div>
            </div>`
          )
          .join("")}
      </div>

      <h2>Cele mai vechi comenzi nefinalizate</h2>
      ${table(
        ["Comandă", "Client", "Data", "Status"],
        vechi.map((c) => [
          `<a href="/comenzi/${c.id}">#${esc(String(c.numar || c.id))}</a>`,
          `<a href="/parteneri/${c.partener_id}">${esc(c.partener_nume)}</a>`,
          esc((c.data || "").slice(0, 10)),
          esc(c.status),
        ])
      )}`
      }
    `;
    send(ctx.res, 200, pagina(ctx, "Comenzi pe status", "/rapoarte/comenzi", continut));
  });

  // ---- Comercial: pipeline ---------------------------------------------
  router.get("/rapoarte/pipeline", async (ctx) => {
    const peStadiu = await db
      .prepare("SELECT stadiu, COUNT(*) AS nr, COALESCE(SUM(valoare_estimata),0) AS valoare FROM oportunitati GROUP BY stadiu")
      .all();
    const total = peStadiu.reduce((s, r) => s + Number(r.valoare), 0);
    const maxV = Math.max(1, ...peStadiu.map((r) => Number(r.valoare)));

    const continut = `
      <div class="cards">
        <div class="card"><div class="label">Valoare totală pipeline</div><div class="value">${money(total)}</div></div>
        <div class="card"><div class="label">Oportunități</div><div class="value">${peStadiu.reduce((s, r) => s + Number(r.nr), 0)}</div></div>
      </div>
      ${
        peStadiu.length === 0
          ? '<p>Nu există încă oportunități. Adaugă-le din <a href="/crm">CRM</a>.</p>'
          : `<h2>Valoare pe stadiu</h2>
      <div class="chart">
        ${peStadiu
          .map(
            (r) => `<div class="chart-row">
              <div class="chart-label" style="width:auto">${esc(r.stadiu)}</div>
              <div class="chart-bars">${bar((Number(r.valoare) / maxV) * 100, r.stadiu === "pierdut" ? "rosu" : "verde")}</div>
              <div class="chart-values">${money(r.valoare)} · ${r.nr}</div>
            </div>`
          )
          .join("")}
      </div>
      <p style="margin-top:14px"><a href="/crm" class="btn secondary small">Deschide pipeline-ul complet →</a></p>`
      }
    `;
    send(ctx.res, 200, pagina(ctx, "Pipeline oportunități", "/rapoarte/pipeline", continut));
  });


  // ---- Comercial: profitabilitate pe agent și pe client -----------------
  // Marja reală se poate calcula doar acolo unde liniile de factură au produs
  // cu preț de achiziție cunoscut. Facturile importate din SmartBill au o
  // singură linie sumar, fără produse — pentru ele arătăm venitul, iar
  // coloana de marjă spune explicit cât din venit ARE cost cunoscut, ca să nu
  // pretindem o profitabilitate pe care n-avem de unde s-o știm.
  router.get("/rapoarte/agenti", async (ctx) => {
    const nrLuni = Math.min(240, Math.max(1, parseInt(ctx.query.luni || "12", 10) || 12));
    const luni = lunileUltimele(nrLuni);
    const deLa = luni[0] + "-01";
    const agentAles = parseInt(ctx.query.agent, 10) || null;

    const SUB_COST =
      "(SELECT fl.factura_id, SUM(fl.cantitate * COALESCE(pr.pret_achizitie, 0)) AS cost, SUM(CASE WHEN fl.produs_id IS NOT NULL AND COALESCE(pr.pret_achizitie,0) > 0 THEN fl.cantitate * fl.pret_unitar ELSE 0 END) AS venit_cu_cost FROM facturi_linii fl LEFT JOIN produse pr ON pr.id = fl.produs_id GROUP BY fl.factura_id)";
    const SUB_NET = "(SELECT factura_id, SUM(cantitate * pret_unitar) AS net FROM facturi_linii GROUP BY factura_id)";

    const peAgent = await db
      .prepare(
        `SELECT u.id, u.nume,
                COUNT(DISTINCT p.id) AS clienti,
                COUNT(DISTINCT f.id) AS facturi,
                COALESCE(SUM(n.net), 0) AS venit,
                COALESCE(SUM(c.cost), 0) AS cost,
                COALESCE(SUM(c.venit_cu_cost), 0) AS venit_cu_cost,
                COALESCE(SUM(COALESCE(t.total,0) - COALESCE(pl.platit,0)), 0) AS sold
         FROM utilizatori u
         LEFT JOIN parteneri p ON p.agent_id = u.id AND p.tip IN ('client','ambele')
         LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status <> 'anulata' AND f.data_emiterii >= ?
         LEFT JOIN ${SUB_NET} n ON n.factura_id = f.id
         LEFT JOIN ${SUB_COST} c ON c.factura_id = f.id
         LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE u.activ = 1
         GROUP BY u.id, u.nume
         ORDER BY venit DESC`
      )
      .all(deLa);

    const pipelineAgent = await db
      .prepare(
        `SELECT COALESCE(o.atribuit_lui, p.agent_id) AS agent_id, COALESCE(SUM(o.valoare_estimata),0) AS valoare
         FROM oportunitati o LEFT JOIN parteneri p ON p.id = o.partener_id
         WHERE o.stadiu NOT IN ('castigat','pierdut')
         GROUP BY COALESCE(o.atribuit_lui, p.agent_id)`
      )
      .all();
    const pipelineMap = Object.fromEntries(pipelineAgent.map((r) => [r.agent_id, Number(r.valoare)]));

    let detaliuClienti = "";
    if (agentAles) {
      const agent = await db.prepare("SELECT nume FROM utilizatori WHERE id = ?").get(agentAles);
      const clienti = await db
        .prepare(
          `SELECT p.id, p.nume,
                  COUNT(DISTINCT f.id) AS facturi,
                  COALESCE(SUM(n.net), 0) AS venit,
                  COALESCE(SUM(c.cost), 0) AS cost,
                  COALESCE(SUM(c.venit_cu_cost), 0) AS venit_cu_cost,
                  COALESCE(SUM(COALESCE(t.total,0) - COALESCE(pl.platit,0)), 0) AS sold
           FROM parteneri p
           LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status <> 'anulata' AND f.data_emiterii >= ?
           LEFT JOIN ${SUB_NET} n ON n.factura_id = f.id
           LEFT JOIN ${SUB_COST} c ON c.factura_id = f.id
           LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
           LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
           WHERE p.agent_id = ? AND p.tip IN ('client','ambele')
           GROUP BY p.id, p.nume
           ORDER BY venit DESC`
        )
        .all(deLa, agentAles);
      detaliuClienti = `
        <h2>Clienții lui ${esc(agent ? agent.nume : "?")} — profitabilitate pe client</h2>
        ${table(
          ["Client", "Facturi", "Venit net", "Marjă (unde există cost)", "% venit cu cost cunoscut", "Sold de încasat"],
          clienti.map((c) => {
            const marja = Number(c.venit_cu_cost) - Number(c.cost);
            const acoperire = Number(c.venit) > 0 ? (Number(c.venit_cu_cost) / Number(c.venit)) * 100 : 0;
            return [
              `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
              c.facturi,
              money(c.venit),
              Number(c.venit_cu_cost) > 0 ? `${money(marja)} (${((marja / Number(c.venit_cu_cost)) * 100).toFixed(1)}%)` : "—",
              `${acoperire.toFixed(0)}%`,
              money(Math.max(0, c.sold)),
            ];
          })
        )}`;
    }

    const optiuni = [3, 6, 12, 24, 240]
      .map((n) => `<option value="${n}"${nrLuni === n ? " selected" : ""}>${n >= 240 ? "tot istoricul" : `ultimele ${n} de luni`}</option>`)
      .join("");

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/agenti">
        <select name="luni" onchange="this.form.submit()">${optiuni}</select>
        <select name="agent" onchange="this.form.submit()">
          <option value="">— alege un agent pentru detaliu pe clienți —</option>
          ${peAgent.map((a) => `<option value="${a.id}"${agentAles === a.id ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
        </select>
      </form>

      <h2>Profitabilitate pe agent</h2>
      ${table(
        ["Agent", "Clienți", "Facturi", "Venit net", "Marjă (unde există cost)", "% venit cu cost cunoscut", "Pipeline deschis", "Sold de încasat", ""],
        peAgent.map((a) => {
          const marja = Number(a.venit_cu_cost) - Number(a.cost);
          const acoperire = Number(a.venit) > 0 ? (Number(a.venit_cu_cost) / Number(a.venit)) * 100 : 0;
          return [
            esc(a.nume),
            a.clienti,
            a.facturi,
            money(a.venit),
            Number(a.venit_cu_cost) > 0 ? `${money(marja)} (${((marja / Number(a.venit_cu_cost)) * 100).toFixed(1)}%)` : "—",
            `${acoperire.toFixed(0)}%`,
            money(pipelineMap[a.id] || 0),
            money(Math.max(0, a.sold)),
            `<a class="link-btn" href="/rapoarte/agenti?luni=${nrLuni}&agent=${a.id}">clienții lui →</a> <a class="link-btn" href="/crm/birou?agent=${a.id}">biroul lui →</a>`,
          ];
        })
      )}
      <p style="font-size:12px;color:var(--text-muted)">
        Marja se calculează DOAR pe liniile de factură care au produs cu preț de achiziție completat — facturile importate din
        SmartBill n-au detaliu pe produse, deci pentru ele se arată venitul, nu marja. Coloana „% venit cu cost cunoscut" spune
        cât de acoperit e calculul: la 0% marja lipsește complet, nu e zero.
      </p>
      ${detaliuClienti}
    `;
    send(ctx.res, 200, pagina(ctx, "Profitabilitate pe agent & client", "/rapoarte/agenti", continut));
  });


  // ---- Comercial: forecast de vânzări ------------------------------------
  // Două surse, combinate transparent:
  //  1. Istoricul de facturare (10 ani de facturi importate) → sezonalitate
  //     (media aceleiași luni calendaristice din ultimii ani) × trendul
  //     ultimelor 12 luni față de precedentele 12.
  //  2. Pipeline-ul CRM → oportunitățile deschise, ponderate pe stadiu.
  // Scenariile optimist/pesimist vin din volatilitatea reală a ultimelor 12
  // luni (deviația față de medie), nu dintr-un procent inventat.
  router.get("/rapoarte/forecast", async (ctx) => {
    const aziStr = azi();
    const lunaCurenta = aziStr.slice(0, 7);
    const nrLuniForecast = Math.min(12, Math.max(3, parseInt(ctx.query.luni || "6", 10) || 6));

    const istoric = await db
      .prepare(
        `SELECT SUBSTR(f.data_emiterii, 1, 7) AS luna, COALESCE(SUM(l.total), 0) AS valoare, COUNT(*) AS nr
         FROM facturi f
         JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         WHERE f.directie = 'vanzare' AND f.status <> 'anulata'
         GROUP BY SUBSTR(f.data_emiterii, 1, 7)
         ORDER BY luna`
      )
      .all();
    const valoarePeLuna = new Map(istoric.map((r) => [r.luna, Number(r.valoare)]));

    // Trend: ultimele 12 luni ÎNTREGI vs. precedentele 12.
    const luniIntregi = istoric.filter((r) => r.luna < lunaCurenta).map((r) => r.luna);
    const ultimele12 = luniIntregi.slice(-12);
    const precedente12 = luniIntregi.slice(-24, -12);
    const suma = (list) => list.reduce((s, l) => s + (valoarePeLuna.get(l) || 0), 0);
    const s12 = suma(ultimele12);
    const s24 = suma(precedente12);
    const crestere = precedente12.length >= 6 && s24 > 0 ? s12 / s24 : 1;

    // Volatilitate: cât de mult sar lunile față de media lor (ultimele 12).
    const media12 = ultimele12.length ? s12 / ultimele12.length : 0;
    const abateri = ultimele12.map((l) => Math.abs((valoarePeLuna.get(l) || 0) - media12));
    const abatereMedie = abateri.length ? abateri.reduce((a, b) => a + b, 0) / abateri.length : 0;
    const banda = media12 > 0 ? Math.min(0.5, abatereMedie / media12) : 0.2;

    // Forecast pe lunile următoare (inclusiv restul lunii curente).
    const randuri = [];
    const anCurent = Number(aziStr.slice(0, 4));
    const lunaCurentaNr = Number(aziStr.slice(5, 7));
    for (let i = 0; i < nrLuniForecast; i++) {
      const d = new Date(Date.UTC(anCurent, lunaCurentaNr - 1 + i, 1));
      const luna = d.toISOString().slice(0, 7);
      const mm = luna.slice(5, 7);
      // Sezonalitate: media aceleiași luni calendaristice din ultimii 3 ani.
      const istoriceAceeasiLuna = [];
      for (let an = anCurent - 1; an >= anCurent - 3; an--) {
        const v = valoarePeLuna.get(`${an}-${mm}`);
        if (v && v > 0) istoriceAceeasiLuna.push(v);
      }
      const baza = istoriceAceeasiLuna.length
        ? istoriceAceeasiLuna.reduce((a, b) => a + b, 0) / istoriceAceeasiLuna.length
        : media12;
      let probabil = baza * crestere;
      let nota = istoriceAceeasiLuna.length
        ? `media lunii ${mm} din ultimii ${istoriceAceeasiLuna.length} ani × trend ${(crestere * 100 - 100).toFixed(1)}%`
        : "media ultimelor 12 luni (fără istoric pe luna asta)";

      let realizat = null;
      if (luna === lunaCurenta) {
        realizat = valoarePeLuna.get(lunaCurenta) || 0;
        const zileTrecute = Number(aziStr.slice(8, 10));
        const zileTotal = new Date(Date.UTC(anCurent, lunaCurentaNr, 0)).getUTCDate();
        const proiectieRunRate = zileTrecute >= 3 ? (realizat / zileTrecute) * zileTotal : probabil;
        // Luna în curs: media dintre proiecția sezonieră și ritmul real de
        // până acum — ritmul real contează mai mult pe măsură ce avansează luna.
        const pondere = zileTrecute / zileTotal;
        probabil = proiectieRunRate * pondere + probabil * (1 - pondere);
        nota = `mix: ritmul de până azi (${money(proiectieRunRate)}) și sezonalitatea, ponderat cu ${(pondere * 100).toFixed(0)}% / ${(100 - pondere * 100).toFixed(0)}%`;
      }

      randuri.push({
        luna,
        realizat,
        probabil: Math.max(0, probabil),
        pesimist: Math.max(0, probabil * (1 - banda)),
        optimist: probabil * (1 + banda),
        nota,
      });
    }
    const totalProbabil = randuri.reduce((s, r) => s + r.probabil, 0);
    const totalPesimist = randuri.reduce((s, r) => s + r.pesimist, 0);
    const totalOptimist = randuri.reduce((s, r) => s + r.optimist, 0);

    // Pipeline-ul CRM, ponderat pe stadiu.
    const PROBABILITATI = { lead: 0.1, calificat: 0.25, oferta: 0.5, negociere: 0.75 };
    const pipeline = await db
      .prepare(
        `SELECT o.stadiu, COUNT(*) AS nr, COALESCE(SUM(o.valoare_estimata),0) AS valoare
         FROM oportunitati o WHERE o.stadiu NOT IN ('castigat','pierdut') GROUP BY o.stadiu`
      )
      .all();
    const pipelinePonderat = pipeline.reduce((s, r) => s + Number(r.valoare) * (PROBABILITATI[r.stadiu] || 0.1), 0);
    const pipelineBrut = pipeline.reduce((s, r) => s + Number(r.valoare), 0);

    const maxV = Math.max(1, ...randuri.map((r) => r.optimist));
    const optiuni = [3, 6, 9, 12].map((n) => `<option value="${n}"${nrLuniForecast === n ? " selected" : ""}>următoarele ${n} luni</option>`).join("");

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/forecast">
        <select name="luni" onchange="this.form.submit()">${optiuni}</select>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Forecast probabil (${nrLuniForecast} luni)</div><div class="value">${money(totalProbabil)}</div></div>
        <div class="card"><div class="label">Scenariu pesimist</div><div class="value" style="color:var(--warn)">${money(totalPesimist)}</div></div>
        <div class="card"><div class="label">Scenariu optimist</div><div class="value" style="color:var(--success)">${money(totalOptimist)}</div></div>
        <div class="card"><div class="label">Trend an/an (ultimele 12 luni)</div><div class="value" style="color:${crestere >= 1 ? "var(--success)" : "var(--danger)"}">${((crestere - 1) * 100).toFixed(1)}%</div></div>
        <div class="card"><div class="label">Pipeline CRM ponderat</div><div class="value">${money(pipelinePonderat)}</div></div>
      </div>

      <h2>Forecast pe luni</h2>
      <div class="chart">
        ${randuri
          .map(
            (r) => `<div class="chart-row">
              <div class="chart-label">${esc(r.luna)}</div>
              <div class="chart-bars">
                ${bar((r.probabil / maxV) * 100, "verde")}
                ${r.realizat !== null ? bar((r.realizat / maxV) * 100, "rosu") : ""}
              </div>
              <div class="chart-values">${money(r.probabil)}${r.realizat !== null ? ` / realizat: ${money(r.realizat)}` : ""}</div>
            </div>`
          )
          .join("")}
      </div>
      <p style="font-size:12px;color:var(--text-muted)">Bară verde = forecast probabil; bară roșie = cât s-a facturat deja în luna curentă.</p>

      ${table(
        ["Luna", "Pesimist", "Probabil", "Optimist", "Cum e calculat"],
        randuri.map((r) => [
          esc(r.luna) + (r.luna === lunaCurenta ? ' <span class="badge galben">în curs</span>' : ""),
          money(r.pesimist),
          `<strong>${money(r.probabil)}</strong>`,
          money(r.optimist),
          `<span style="font-size:12px;color:var(--text-muted)">${esc(r.nota)}</span>`,
        ])
      )}

      <h2>Pipeline CRM — ce se poate adăuga peste forecast</h2>
      ${
        pipeline.length
          ? table(
              ["Stadiu", "Oportunități", "Valoare brută", "Probabilitate", "Valoare ponderată"],
              pipeline.map((r) => [
                esc(r.stadiu),
                r.nr,
                money(r.valoare),
                `${((PROBABILITATI[r.stadiu] || 0.1) * 100).toFixed(0)}%`,
                money(Number(r.valoare) * (PROBABILITATI[r.stadiu] || 0.1)),
              ])
            ) +
            `<p style="font-size:12px;color:var(--text-muted)">Total brut ${money(pipelineBrut)} → ponderat ${money(pipelinePonderat)}. Pipeline-ul e PESTE forecastul istoric doar în măsura în care oportunitățile sunt clienți/afaceri noi — vânzările recurente către clienții existenți sunt deja prinse în istoric.</p>`
          : '<p style="color:var(--text-muted)">Nu există oportunități deschise în CRM. Forecastul de mai sus se bazează exclusiv pe istoricul de facturare.</p>'
      }

      <p style="font-size:12px;color:var(--text-muted)">
        Metodă: sezonalitate (media aceleiași luni calendaristice din ultimii ≤3 ani) × trendul an/an al ultimelor 12 luni întregi
        (${money(s12)} vs. ${money(s24)}). Banda pesimist–optimist = abaterea medie reală a ultimelor 12 luni față de media lor
        (±${(banda * 100).toFixed(0)}%). Luna în curs amestecă ritmul zilnic real cu sezonalitatea. E o proiecție statistică, nu o promisiune.
      </p>
    `;
    send(ctx.res, 200, pagina(ctx, "Forecast vânzări", "/rapoarte/forecast", continut));
  });

  // ---- Comercial: clienți activi / inactivi -----------------------------
  router.get("/rapoarte/clienti", async (ctx) => {
    const prag = Math.min(1095, Math.max(30, parseInt(ctx.query.prag || "180", 10) || 180));
    const limita = new Date(Date.now() - prag * 86400000).toISOString().slice(0, 10);

    const clienti = await db
      .prepare(
        `SELECT p.id, p.nume, COUNT(*) AS nr, COALESCE(SUM(l.total),0) AS valoare, MAX(f.data_emiterii) AS ultima
         FROM parteneri p
         JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status <> 'anulata'
         JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         GROUP BY p.id, p.nume`
      )
      .all();

    const activi = clienti.filter((c) => (c.ultima || "") >= limita).sort((a, b) => Number(b.valoare) - Number(a.valoare));
    const inactivi = clienti.filter((c) => (c.ultima || "") < limita).sort((a, b) => Number(b.valoare) - Number(a.valoare));
    const valoareInactivi = inactivi.reduce((s, c) => s + Number(c.valoare), 0);
    const optiuni = [90, 180, 365, 730].map((n) => `<option value="${n}"${prag === n ? " selected" : ""}>fără cumpărături de peste ${n} de zile</option>`).join("");

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/clienti">
        <select name="prag" onchange="this.form.submit()">${optiuni}</select>
      </form>
      <div class="cards">
        <div class="card"><div class="label">Clienți activi</div><div class="value">${activi.length}</div></div>
        <div class="card"><div class="label">Clienți inactivi</div><div class="value" style="color:var(--warn)">${inactivi.length}</div></div>
        <div class="card"><div class="label">Valoare istorică a celor inactivi</div><div class="value">${money(valoareInactivi)}</div></div>
      </div>

      <h2>Clienți inactivi — de recontactat ${inactivi.length > 50 ? "(primii 50 după valoare)" : ""}</h2>
      ${
        inactivi.length
          ? table(
              ["Client", "Ultima factură", "Total istoric", "Facturi"],
              inactivi
                .slice(0, 50)
                .map((c) => [
                  `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                  `<span class="badge galben">${esc((c.ultima || "").slice(0, 10))}</span>`,
                  money(c.valoare),
                  c.nr,
                ])
            )
          : "<p>Toți clienții au cumpărat recent.</p>"
      }

      <h2>Clienți activi ${activi.length > 50 ? "(primii 50 după valoare)" : ""}</h2>
      ${table(
        ["Client", "Ultima factură", "Total istoric", "Facturi"],
        activi.slice(0, 50).map((c) => [`<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`, esc((c.ultima || "").slice(0, 10)), money(c.valoare), c.nr])
      )}
    `;
    send(ctx.res, 200, pagina(ctx, "Clienți activi & inactivi", "/rapoarte/clienti", continut));
  });
}

module.exports = { register };
