"use strict";
// Modul Rapoarte — un hub cu rapoarte grupate pe categorii (financiare,
// operaționale, comerciale), fiecare la propriul URL. Toate calculele se fac
// agregat, în SQL: baza reală are mii de facturi importate din SmartBill, iar
// varianta "aduc tot în memorie și calculez în JS" ar face paginile inutilizabile.
const db = require("../lib/db");
const grup = require("../lib/grup");
const costuri = require("./costuri");
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
        href: "/rapoarte/consolidat",
        nume: "Situație consolidată — grup",
        desc: "Cash Machine + Warehouse All adunate, cu facturile dintre ele eliminate. Vânzări, costuri, marjă, solduri — pe firme și pe total grup.",
      },
      {
        href: "/rapoarte/scadentar-grup",
        nume: "Scadențar grup — de încasat & de plătit",
        desc: "Tot ce ai de încasat și de plătit, pe ambele firme, într-o singură fereastră, cu poziția netă pe fiecare zi.",
      },
      {
        href: "/rapoarte/comisioane",
        nume: "Comisioane agenți (pe grup)",
        desc: "Vânzările fiecărui agent din ambele firme și comisionul aferent, la încasat sau la facturat.",
      },
      {
        href: "/rapoarte/profit-produs",
        nume: "Profit pe produs (marja reală)",
        desc: "Vânzări nete, costul bunurilor vândute, profit și marjă pe fiecare produs — cu costul real din gestiune, plus produsele vândute în pierdere.",
      },
      {
        href: "/rapoarte/produse-fara-cost",
        nume: "Produse care se vând, dar n-au cost",
        desc: "Pe ele marja iese 100%, adică fals. Ordonate după cât s-au vândut, ca să știi pe care merită să pui prețul de achiziție de mână.",
      },
      {
        href: "/rapoarte/cashflow",
        nume: "Cash flow la zi + proiecție",
        desc: "Cash disponibil azi, intrări/ieșiri așteptate pe scadențe zi cu zi, cu adăugare manuală de plăți/încasări viitoare pentru forecast.",
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
      { href: "/rapoarte/indicatori", nume: "Indicatori financiari — ochii băncii", desc: "DSO, concentrare clienți, restanțe, trend — cu estimare de sumă finanțabilă și sugestii de îmbunătățire." },
      { href: "/rapoarte/comparatie", nume: "Comparație la zi cu anii trecuți", desc: "1 ianuarie → azi: vânzări, costuri, încasări, clienți — anul curent față de ultimii doi ani." },
      { href: "/rapoarte/incasari?directie=achizitie&zile=15", nume: "Plăți furnizori (pe zile)", desc: "Cât ai de plătit în fiecare zi din săptămâna/perioada următoare, cu totaluri pe furnizor." },
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
      { href: "/rapoarte/produse-top", nume: "Top produse & marjă pe produs", desc: "Ce se vinde cel mai bine și cu ce marjă — pe toată firma sau pe portofoliul unui agent." },
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

// Interval de raportare cu preseturi: ultimele N luni, anul curent, anul
// trecut sau o perioadă custom aleasă de om. Folosit de rapoartele cu filtru
// de perioadă, ca toate să se comporte la fel.
function intervalDinQuery(ctx, implicitLuni = 12) {
  const aziStr = azi();
  const an = Number(aziStr.slice(0, 4));
  const preset = String(ctx.query.perioada || `${implicitLuni}luni`);
  let deLa;
  let panaLa = aziStr;
  if (preset === "an_curent") deLa = `${an}-01-01`;
  else if (preset === "an_trecut") {
    deLa = `${an - 1}-01-01`;
    panaLa = `${an - 1}-12-31`;
  } else if (preset === "tot") deLa = "2000-01-01";
  else if (preset === "custom") {
    deLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.de_la || "")) ? String(ctx.query.de_la) : `${an}-01-01`;
    panaLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.pana_la || "")) ? String(ctx.query.pana_la) : aziStr;
  } else {
    const n = Math.min(120, Math.max(1, parseInt(preset, 10) || implicitLuni));
    deLa = lunileUltimele(n)[0] + "-01";
  }
  return { preset, deLa, panaLa };
}

function selectorPerioada(actiune, interval, extraCampuri = "") {
  const { preset, deLa, panaLa } = interval;
  const opt = (v, t) => `<option value="${v}"${preset === v ? " selected" : ""}>${t}</option>`;
  return `
    <form class="filtre" method="get" action="${actiune}">
      <select name="perioada" onchange="if(this.value!=='custom')this.form.submit(); else {this.form.querySelector('.datele-custom').style.display='flex';}">
        ${opt("3", "ultimele 3 luni")}
        ${opt("6", "ultimele 6 luni")}
        ${opt("12", "ultimele 12 luni")}
        ${opt("24", "ultimele 24 de luni")}
        ${opt("an_curent", "anul curent")}
        ${opt("an_trecut", "anul trecut")}
        ${opt("tot", "tot istoricul")}
        ${opt("custom", "perioadă custom…")}
      </select>
      <span class="datele-custom" style="display:${preset === "custom" ? "flex" : "none"};gap:8px;align-items:center">
        <input type="date" name="de_la" value="${deLa}">
        <span style="font-size:13px">→</span>
        <input type="date" name="pana_la" value="${panaLa}">
        <button class="btn small" type="submit">Aplică</button>
      </span>
      ${extraCampuri}
      <span style="font-size:12px;color:var(--text-muted)">${deLa} → ${panaLa}</span>
    </form>`;
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
         WHERE f.directie = ? AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0
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
        directie === "achizitie" && facturi.length
          ? (() => {
              const peFurnizor = new Map();
              for (const f of facturi) {
                if (!peFurnizor.has(f.partener_id)) peFurnizor.set(f.partener_id, { nume: f.partener_nume, id: f.partener_id, suma: 0, nr: 0 });
                const g = peFurnizor.get(f.partener_id);
                g.suma += Number(f.restant);
                g.nr++;
              }
              const listaF = [...peFurnizor.values()].sort((a, b) => b.suma - a.suma);
              return `<h2>Total pe furnizor în perioada selectată</h2>` + table(
                ["Furnizor", "Documente", "Total de plătit"],
                listaF.map((x) => [`<a href="/parteneri/${x.id}">${esc(x.nume)}</a>`, x.nr, money(x.suma)])
              );
            })()
          : ""
      }

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
         WHERE f.directie = ? AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0 AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5
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
    const interval = intervalDinQuery(ctx, 12);
    const { deLa, panaLa } = interval;
    // lista lunilor din interval (max 48, ca graficul să rămână lizibil)
    const luni = [];
    {
      let [a, l] = [Number(deLa.slice(0, 4)), Number(deLa.slice(5, 7))];
      const [aF, lF] = [Number(panaLa.slice(0, 4)), Number(panaLa.slice(5, 7))];
      while ((a < aF || (a === aF && l <= lF)) && luni.length < 48) {
        luni.push(`${a}-${String(l).padStart(2, "0")}`);
        l++;
        if (l > 12) {
          l = 1;
          a++;
        }
      }
    }

    const randuri = await db
      .prepare(
        `SELECT f.directie, SUBSTR(f.data_emiterii, 1, 7) AS luna, COALESCE(SUM(l.total), 0) AS valoare, COUNT(*) AS nr
         FROM facturi f
         JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         WHERE f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND f.data_emiterii <= ?
         GROUP BY f.directie, SUBSTR(f.data_emiterii, 1, 7)`
      )
      .all(deLa, panaLa);

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

    const continut = `
      ${selectorPerioada("/rapoarte/vanzari", interval)}
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


  // ---- GRUP: situație financiară consolidată -----------------------------
  // Cash Machine + Warehouse All lucrează ca o singură afacere: aceiași
  // clienți, aceiași furnizori, aceiași oameni de vânzări. Raportul le
  // adună, dar ELIMINĂ facturile dintre ele — altfel același leu ar fi
  // numărat de două ori (venit la una, cost la cealaltă), iar cifra de
  // afaceri a grupului ar fi umflată artificial.
  router.get("/rapoarte/consolidat", async (ctx) => {
    const interval = intervalDinQuery(ctx, 12);
    const { deLa, panaLa } = interval;
    const firme = await grup.listaFirmeOperationale();

    async function cifre(filtruFirma) {
      const q = async (sql, ...args) => (await db.prepare(sql).get(...args)) || {};
      const vanzari = await q(
        `SELECT COALESCE(SUM(n.net),0) AS net, COALESCE(SUM(t.total),0) AS total, COUNT(*) AS nr
         FROM facturi f
         JOIN (SELECT factura_id, SUM(cantitate*pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n ON n.factura_id=f.id
         JOIN ${SUB_TOTAL} t ON t.factura_id=f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.data_emiterii >= ? AND f.data_emiterii <= ? ${filtruFirma.sql}`,
        deLa, panaLa, ...filtruFirma.args
      );
      const achizitii = await q(
        `SELECT COALESCE(SUM(n.net),0) AS net, COALESCE(SUM(t.total),0) AS total, COUNT(*) AS nr
         FROM facturi f
         JOIN (SELECT factura_id, SUM(cantitate*pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n ON n.factura_id=f.id
         JOIN ${SUB_TOTAL} t ON t.factura_id=f.id
         WHERE f.directie='achizitie' AND f.status NOT IN ('anulata','ciorna') AND f.data_emiterii >= ? AND f.data_emiterii <= ? ${filtruFirma.sql}`,
        deLa, panaLa, ...filtruFirma.args
      );
      const incasari = await q(
        `SELECT COALESCE(SUM(pl.suma),0) AS s FROM plati pl JOIN facturi f ON f.id=pl.factura_id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','ciorna') AND pl.data >= ? AND pl.data <= ? ${filtruFirma.sql}`,
        deLa, panaLa, ...filtruFirma.args
      );
      const plati = await q(
        `SELECT COALESCE(SUM(pl.suma),0) AS s FROM plati pl JOIN facturi f ON f.id=pl.factura_id
         WHERE f.directie='achizitie' AND f.status NOT IN ('anulata','ciorna') AND pl.data >= ? AND pl.data <= ? ${filtruFirma.sql}`,
        deLa, panaLa, ...filtruFirma.args
      );
      // soldurile sunt "la zi", nu pe perioadă
      const solduri = await db
        .prepare(
          `SELECT f.directie, COALESCE(SUM(COALESCE(l.total,0)-COALESCE(pl.platit,0)),0) AS sold
           FROM facturi f
           LEFT JOIN ${SUB_TOTAL} l ON l.factura_id=f.id
           LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id=f.id
           WHERE f.status NOT IN ('anulata','necunoscut') AND COALESCE(l.total,0)-COALESCE(pl.platit,0) > 0.5 ${filtruFirma.sql}
           GROUP BY f.directie`
        )
        .all(...filtruFirma.args);
      const sV = solduri.find((x) => x.directie === "vanzare") || { sold: 0 };
      const sA = solduri.find((x) => x.directie === "achizitie") || { sold: 0 };
      return {
        vanzariNet: Number(vanzari.net), vanzariTotal: Number(vanzari.total), nrVanzari: Number(vanzari.nr),
        achizitiiNet: Number(achizitii.net), achizitiiTotal: Number(achizitii.total),
        incasari: Number(incasari.s), plati: Number(plati.s),
        deIncasat: Number(sV.sold), dePlatit: Number(sA.sold),
      };
    }

    const peFirma = [];
    for (const f of firme) peFirma.push({ firma: f, c: await cifre({ sql: " AND f.firma_id = ?", args: [f.id] }) });
    const totalGrup = await cifre({ sql: " AND f.intercompany = 0", args: [] });
    const intercompany = await cifre({ sql: " AND f.intercompany = 1", args: [] });

    const rand = (eticheta, camp, semnBun = 1) => [
      eticheta,
      ...peFirma.map((x) => money(x.c[camp])),
      `<strong>${money(totalGrup[camp])}</strong>`,
      `<span style="color:var(--text-muted)">${money(intercompany[camp])}</span>`,
    ];

    const marjaGrup = totalGrup.vanzariNet - totalGrup.achizitiiNet;
    const marjaPct = totalGrup.vanzariNet > 0 ? (marjaGrup / totalGrup.vanzariNet) * 100 : 0;

    const continut = `
      ${selectorPerioada("/rapoarte/consolidat", interval)}

      <div class="cards">
        <div class="card"><div class="label">Vânzări grup (net, fără TVA)</div><div class="value">${money(totalGrup.vanzariNet)}</div></div>
        <div class="card"><div class="label">Costuri grup (achiziții, net)</div><div class="value">${money(totalGrup.achizitiiNet)}</div></div>
        <div class="card"><div class="label">Marjă brută grup</div><div class="value" style="color:${marjaGrup >= 0 ? "var(--success)" : "var(--danger)"}">${money(marjaGrup)} <span style="font-size:14px">(${marjaPct.toFixed(1)}%)</span></div></div>
        <div class="card"><div class="label">De încasat − de plătit</div><div class="value">${money(totalGrup.deIncasat - totalGrup.dePlatit)}</div></div>
      </div>

      ${
        intercompany.vanzariNet > 0
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">
              În perioada aleasă, firmele grupului și-au facturat reciproc <strong>${money(intercompany.vanzariNet)}</strong> (net).
              Suma NU intră în totalul grupului — la nivel de grup nu s-a creat valoare, banul doar s-a mutat dintr-un buzunar în altul.
              O vezi separat în ultima coloană, ca să știi cât e volumul intern.
            </div>`
          : ""
      }

      <h2>Situația pe firme și consolidat</h2>
      ${table(
        ["Indicator", ...peFirma.map((x) => esc(x.firma.nume)), "TOTAL GRUP", "din care intern (eliminat)"],
        [
          rand("Vânzări (net, fără TVA)", "vanzariNet"),
          rand("Vânzări (cu TVA)", "vanzariTotal"),
          rand("Achiziții (net)", "achizitiiNet"),
          rand("Încasări efective", "incasari"),
          rand("Plăți efective", "plati"),
          rand("De încasat de la clienți (la zi)", "deIncasat"),
          rand("De plătit către furnizori (la zi)", "dePlatit"),
        ]
      )}
      <p style="font-size:12px;color:var(--text-muted)">
        Coloanele pe firme arată tot ce a facturat fiecare, inclusiv către cealaltă firmă din grup.
        Coloana TOTAL GRUP e consolidată: adună firmele și scade facturile dintre ele.
        Partenerii (clienți și furnizori) și angajații sunt comuni pe tot grupul — o singură listă, un singur istoric.
      </p>
    `;
    send(ctx.res, 200, pagina(ctx, "Situație consolidată — grupul de firme", "/rapoarte/consolidat", continut));
  });

  // ---- GRUP: de încasat și de plătit, într-o singură fereastră ------------
  router.get("/rapoarte/scadentar-grup", async (ctx) => {
    const aziStr = azi();
    const zile = Math.min(120, Math.max(7, parseInt(ctx.query.zile || "30", 10) || 30));
    const pana = new Date(Date.now() + zile * 86400000).toISOString().slice(0, 10);

    const randuri = await db
      .prepare(
        `SELECT f.id, f.directie, f.serie, f.numar, f.document_extern, f.data_scadenta, f.data_emiterii,
                fi.nume AS firma_nume, p.id AS partener_id, p.nume AS partener_nume,
                COALESCE(l.total,0) - COALESCE(pl.platit,0) AS rest
         FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN firme fi ON fi.id = f.firma_id
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0 AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5
         ORDER BY (f.data_scadenta IS NULL OR f.data_scadenta = ''), f.data_scadenta ASC`
      )
      .all();

    const deIncasat = randuri.filter((r) => r.directie === "vanzare");
    const dePlatit = randuri.filter((r) => r.directie === "achizitie");
    const sum = (l) => l.reduce((s, r) => s + Number(r.rest), 0);
    const restant = (l) => l.filter((r) => r.data_scadenta && r.data_scadenta < aziStr);
    const inOrizont = (l) => l.filter((r) => r.data_scadenta && r.data_scadenta >= aziStr && r.data_scadenta <= pana);

    // poziția netă pe zile: cât intră minus cât iese, în orizontul ales
    const peZi = new Map();
    for (const r of [...inOrizont(deIncasat), ...inOrizont(dePlatit)]) {
      const zi = r.data_scadenta;
      if (!peZi.has(zi)) peZi.set(zi, { zi, incasez: 0, platesc: 0 });
      const g = peZi.get(zi);
      if (r.directie === "vanzare") g.incasez += Number(r.rest);
      else g.platesc += Number(r.rest);
    }
    const zileOrd = [...peZi.values()].sort((a, b) => (a.zi < b.zi ? -1 : 1));
    let cumulat = 0;
    for (const z of zileOrd) {
      z.net = z.incasez - z.platesc;
      cumulat += z.net;
      z.cumulat = cumulat;
    }

    const tabelDocumente = (lista, etichetaPartener) =>
      table(
        ["Scadența", "Firma", etichetaPartener, "Document", "Sumă", "Stare"],
        lista.slice(0, 200).map((r) => [
          r.data_scadenta ? (r.data_scadenta < aziStr ? `<span class="badge rosu">${esc(r.data_scadenta)}</span>` : esc(r.data_scadenta)) : '<span class="badge gri">fără scadență</span>',
          `<span style="font-size:12px">${esc(r.firma_nume || "—")}</span>`,
          `<a href="/parteneri/${r.partener_id}">${esc(r.partener_nume)}</a>`,
          `<a href="/facturi/${r.id}">${esc(r.document_extern || `${r.serie}-${r.numar}`)}</a>`,
          money(r.rest),
          r.data_scadenta && r.data_scadenta < aziStr ? '<span class="badge rosu">restant</span>' : '<span class="badge galben">de urmărit</span>',
        ])
      );

    const optiuni = [7, 14, 30, 60, 90].map((z) => `<option value="${z}"${zile === z ? " selected" : ""}>următoarele ${z} de zile</option>`).join("");

    const continut = `
      <form class="filtre" method="get" action="/rapoarte/scadentar-grup">
        <select name="zile" onchange="this.form.submit()">${optiuni}</select>
      </form>

      <div class="cards">
        <div class="card"><div class="label">Total de încasat</div><div class="value" style="color:var(--success)">${money(sum(deIncasat))}</div></div>
        <div class="card"><div class="label">din care restant</div><div class="value" style="color:var(--danger)">${money(sum(restant(deIncasat)))}</div></div>
        <div class="card"><div class="label">Total de plătit</div><div class="value" style="color:var(--danger)">${money(sum(dePlatit))}</div></div>
        <div class="card"><div class="label">din care restant</div><div class="value" style="color:var(--danger)">${money(sum(restant(dePlatit)))}</div></div>
        <div class="card"><div class="label">Poziție netă</div><div class="value" style="color:${sum(deIncasat) - sum(dePlatit) >= 0 ? "var(--success)" : "var(--danger)"}">${money(sum(deIncasat) - sum(dePlatit))}</div></div>
      </div>

      <h2>Pe zile, în următoarele ${zile} de zile</h2>
      ${
        zileOrd.length
          ? table(
              ["Ziua", "Încasez", "Plătesc", "Net pe zi", "Cumulat"],
              zileOrd.map((z) => [
                esc(z.zi),
                z.incasez ? `<span style="color:var(--success)">${money(z.incasez)}</span>` : "",
                z.platesc ? `<span style="color:var(--danger)">−${money(z.platesc)}</span>` : "",
                money(z.net),
                `<strong style="color:${z.cumulat >= 0 ? "inherit" : "var(--danger)"}">${money(z.cumulat)}</strong>`,
              ])
            )
          : "<p>Nimic scadent în orizontul ales.</p>"
      }

      <h2>De încasat de la clienți (${deIncasat.length} documente)</h2>
      ${tabelDocumente(deIncasat, "Client")}

      <h2>De plătit către furnizori (${dePlatit.length} documente)</h2>
      ${tabelDocumente(dePlatit, "Furnizor")}

      <p style="font-size:12px;color:var(--text-muted)">Cumulat pe tot grupul, cu facturile dintre firmele grupului eliminate. Documentele fără scadență apar la final și nu intră în proiecția pe zile.</p>
    `;
    send(ctx.res, 200, pagina(ctx, "Scadențar grup — de încasat și de plătit", "/rapoarte/scadentar-grup", continut));
  });

  // ---- GRUP: comisioane agenți de vânzări --------------------------------
  // Agenții lucrează pentru tot grupul, deci comisionul se calculează pe
  // vânzările din AMBELE firme, fără facturile interne. Procentul se
  // setează per agent în pagina Utilizatori (implicit 0 = fără comision).
  router.get("/rapoarte/comisioane", async (ctx) => {
    const interval = intervalDinQuery(ctx, 3);
    const { deLa, panaLa } = interval;
    const bazaIncasat = String(ctx.query.baza || "incasat") === "facturat" ? "facturat" : "incasat";

    const agenti = await db
      .prepare(
        `SELECT u.id, u.nume, u.rol, COALESCE(u.comision_procent,0) AS pct,
                COUNT(DISTINCT f.id) AS nr_facturi,
                COUNT(DISTINCT p.id) AS nr_clienti,
                COALESCE(SUM(n.net),0) AS facturat_net,
                COALESCE(SUM(t.total),0) AS facturat_total
         FROM utilizatori u
         LEFT JOIN parteneri p ON p.agent_id = u.id
         LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie='vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0
              AND f.data_emiterii >= ? AND f.data_emiterii <= ?
         LEFT JOIN (SELECT factura_id, SUM(cantitate*pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n ON n.factura_id=f.id
         LEFT JOIN ${SUB_TOTAL} t ON t.factura_id=f.id
         WHERE u.activ = 1
         GROUP BY u.id, u.nume, u.rol, u.comision_procent
         ORDER BY facturat_net DESC`
      )
      .all(deLa, panaLa);

    // încasat efectiv pe agent (baza corectă pentru comision, de regulă)
    const incasat = await db
      .prepare(
        `SELECT p.agent_id AS agent, COALESCE(SUM(pl.suma),0) AS s
         FROM plati pl JOIN facturi f ON f.id=pl.factura_id JOIN parteneri p ON p.id=f.partener_id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND pl.data >= ? AND pl.data <= ? AND p.agent_id IS NOT NULL
         GROUP BY p.agent_id`
      )
      .all(deLa, panaLa);
    const incasatPeAgent = new Map(incasat.map((r) => [r.agent, Number(r.s)]));

    // costul lunar al fiecărui agent (salariu + CAM + mașină + carburant),
    // ca să se vadă nu doar ce încasează, ci și cât costă
    const luniInterval = [];
    {
      let d = new Date(deLa + "T00:00:00Z");
      const pana = new Date(panaLa + "T00:00:00Z");
      while (d <= pana && luniInterval.length < 36) {
        luniInterval.push(d.toISOString().slice(0, 7));
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
    }
    const costPeAgent = new Map();
    for (const luna of luniInterval) {
      for (const l of await costuri.costuriPeLuna(luna)) {
        costPeAgent.set(l.utilizator.id, (costPeAgent.get(l.utilizator.id) || 0) + l.sume.total);
      }
    }

    const randuri = agenti
      .filter((a) => Number(a.facturat_net) > 0 || Number(a.pct) > 0)
      .map((a) => {
        const inc = incasatPeAgent.get(a.id) || 0;
        const baza = bazaIncasat === "incasat" ? inc : Number(a.facturat_total);
        const comision = (baza * Number(a.pct)) / 100;
        const cost = costPeAgent.get(a.id) || 0;
        return { ...a, incasat: inc, baza, comision, cost, costTotal: cost + comision, net: inc - cost - comision };
      });
    const totalComision = randuri.reduce((s, r) => s + r.comision, 0);
    const totalCost = randuri.reduce((s, r) => s + r.cost, 0);

    const continut = `
      ${selectorPerioada(
        "/rapoarte/comisioane",
        interval,
        `<select name="baza" onchange="this.form.submit()">
           <option value="incasat"${bazaIncasat === "incasat" ? " selected" : ""}>comision la ÎNCASAT</option>
           <option value="facturat"${bazaIncasat === "facturat" ? " selected" : ""}>comision la FACTURAT</option>
         </select>`
      )}

      <div class="cards">
        <div class="card"><div class="label">Total comisioane de plată</div><div class="value">${money(totalComision)}</div></div>
        <div class="card"><div class="label">Baza de calcul</div><div class="value" style="font-size:16px">${bazaIncasat === "incasat" ? "încasările efective" : "valoarea facturată"}</div></div>
        <div class="card"><div class="label">Agenți cu vânzări</div><div class="value">${randuri.length}</div></div>
        <div class="card"><div class="label">Cost echipă în perioadă (salariu+CAM+mașină)</div><div class="value">${money(totalCost)}</div></div>
        <div class="card"><div class="label">Cost total cu comisioane</div><div class="value">${money(totalCost + totalComision)}</div></div>
      </div>

      ${table(
        ["Agent", "Clienți", "Facturi", "Facturat (net)", "Încasat", "Comision %", "Comision", "Cost lunar (sal.+CAM+mașină)", "Încasat − cost − comision"],
        randuri.map((r) => [
          `<a href="/crm/birou?agent=${r.id}">${esc(r.nume)}</a>`,
          r.nr_clienti,
          r.nr_facturi,
          money(r.facturat_net),
          money(r.incasat),
          Number(r.pct) > 0 ? `${Number(r.pct).toFixed(2)}%` : '<span class="badge gri">nesetat</span>',
          `<strong>${money(r.comision)}</strong>`,
          r.cost ? money(r.cost) : `<a class="link-btn" href="/costuri/nou?utilizator_id=${r.id}">setează</a>`,
          r.cost ? `<strong style="color:${r.net >= 0 ? "var(--success)" : "var(--danger)"}">${money(r.net)}</strong>` : "—",
        ])
      )}

      <p style="font-size:12px;color:var(--text-muted)">
        Comisionul se calculează pe vânzările din <strong>tot grupul</strong> (Cash Machine + Warehouse All), fără facturile interne —
        agenții lucrează pentru ambele firme, deci portofoliul lor e unul singur. Procentul fiecărui agent se setează în
        <a href="/admin/utilizatori">Utilizatori</a>; cât timp e 0, comisionul iese 0 (nu ghicesc procente).
        Recomandarea uzuală e comisionul la încasat, nu la facturat — altfel plătești comision pe bani care n-au intrat încă.
      </p>
    `;
    send(ctx.res, 200, pagina(ctx, "Comisioane agenți — pe grup", "/rapoarte/comisioane", continut));
  });

  // ---- Financiar: top parteneri ----------------------------------------
  // Excluderea unor parteneri din top e DOAR pe vizualizarea curentă (stă în
  // URL, nu în baza de date) — la o nouă deschidere a raportului reapar toți.
  // Procentele se recalculează pe ce rămâne după excludere.
  router.get("/rapoarte/parteneri", async (ctx) => {
    const interval = intervalDinQuery(ctx, 12);
    const { deLa, panaLa } = interval;
    const excluse = String(ctx.query.exclude || "")
      .split(",")
      .map((x) => parseInt(x, 10))
      .filter((x) => Number.isFinite(x) && x > 0);

    async function top(directie) {
      const filtruExcl = excluse.length ? `AND p.id NOT IN (${excluse.map(() => "?").join(",")})` : "";
      return await db
        .prepare(
          `SELECT p.id, p.nume, p.cui, COALESCE(SUM(l.total), 0) AS valoare, COUNT(*) AS nr, MAX(f.data_emiterii) AS ultima
           FROM facturi f
           JOIN parteneri p ON p.id = f.partener_id
           JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
           WHERE f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.directie = ? AND f.data_emiterii >= ? AND f.data_emiterii <= ? ${filtruExcl}
           GROUP BY p.id, p.nume, p.cui
           ORDER BY valoare DESC
           LIMIT 25`
        )
        .all(directie, deLa, panaLa, ...excluse);
    }
    const clienti = await top("vanzare");
    const furnizori = await top("achizitie");
    const totalC = clienti.reduce((s, c) => s + Number(c.valoare), 0);
    const totalF = furnizori.reduce((s, c) => s + Number(c.valoare), 0);

    const numeExcluse = excluse.length
      ? await db.prepare(`SELECT id, nume FROM parteneri WHERE id IN (${excluse.map(() => "?").join(",")})`).all(...excluse)
      : [];

    const urlCu = (lista) => {
      const u = new URLSearchParams();
      u.set("perioada", interval.preset);
      if (interval.preset === "custom") {
        u.set("de_la", deLa);
        u.set("pana_la", panaLa);
      }
      if (lista.length) u.set("exclude", lista.join(","));
      return "/rapoarte/parteneri?" + u.toString();
    };
    const linkExclude = (id) => urlCu([...excluse, id]);

    const randuriTop = (lista, total, etichetaValoare) =>
      table(
        ["Partener", "CUI", etichetaValoare, "% din top (recalculat)", "Facturi", "Ultima factură", ""],
        lista.map((c) => [
          `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
          esc(c.cui || "—"),
          money(c.valoare),
          total > 0 ? `${((Number(c.valoare) / total) * 100).toFixed(1)}%` : "—",
          c.nr,
          esc((c.ultima || "").slice(0, 10)),
          `<a class="link-btn danger" href="${linkExclude(c.id)}" title="Scoate din această vizualizare (revine la regenerare)">elimină</a>`,
        ])
      );

    const continut = `
      ${selectorPerioada("/rapoarte/parteneri", interval, excluse.length ? `<input type="hidden" name="exclude" value="${excluse.join(",")}">` : "")}

      ${
        numeExcluse.length
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">
              Excluși din această vizualizare (procentele sunt recalculate fără ei):
              ${numeExcluse.map((e) => `<strong>${esc(e.nume)}</strong> <a href="${urlCu(excluse.filter((x) => x !== e.id))}" style="color:inherit">✕</a>`).join(" · ")}
              — <a href="${urlCu([])}">readu-i pe toți</a>. Excluderea NU se salvează: la o nouă deschidere a raportului reapar toți.
            </div>`
          : ""
      }

      <h2>Top clienți</h2>
      ${randuriTop(clienti, totalC, "Valoare facturată")}

      <h2>Top furnizori</h2>
      ${
        furnizori.length
          ? randuriTop(furnizori, totalF, "Valoare achiziționată")
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



  // ---- Financiar: indicatorii la care se uită o bancă --------------------
  // Calculați DOAR din ce există în ERP, cu afișarea explicită a lipsurilor:
  // o bancă va cere bilanț + balanță complete, iar aici arătăm exact aceiași
  // indicatori pe datele disponibile, plus cât valorează firma ca dosar de
  // finanțare și ce ar îmbunătăți punctajul.
  router.get("/rapoarte/indicatori", async (ctx) => {
    const aziStr = azi();
    const acum12 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const acum24 = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);

    const agg = async (directie, deLa, panaLa) =>
      await db
        .prepare(
          `SELECT COALESCE(SUM(n.net),0) AS net, COUNT(*) AS nr
           FROM facturi f JOIN (SELECT factura_id, SUM(cantitate*pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n ON n.factura_id = f.id
           WHERE f.directie = ? AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND f.data_emiterii <= ?`
        )
        .get(directie, deLa, panaLa);

    const v12 = await agg("vanzare", acum12, aziStr);
    const v24 = await agg("vanzare", acum24, acum12);
    const a12 = await agg("achizitie", acum12, aziStr);

    const solduri = await db
      .prepare(
        `SELECT f.directie,
                COALESCE(SUM(COALESCE(l.total,0) - COALESCE(pl.platit,0)), 0) AS sold,
                COALESCE(SUM(CASE WHEN f.data_scadenta <> '' AND f.data_scadenta < ? THEN COALESCE(l.total,0) - COALESCE(pl.platit,0) ELSE 0 END), 0) AS depasit
         FROM facturi f
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0 AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5
         GROUP BY f.directie`
      )
      .all(aziStr);
    const sV = solduri.find((s) => s.directie === "vanzare") || { sold: 0, depasit: 0 };
    const sA = solduri.find((s) => s.directie === "achizitie") || { sold: 0, depasit: 0 };

    const vanzariNet12 = Number(v12.net);
    const vanzariNetPrec = Number(v24.net);
    const achizitiiNet12 = Number(a12.net);
    const creanteClienti = Number(sV.sold);
    const datoriiFurnizori = Number(sA.sold);

    // Concentrarea clienților — primul lucru la care se uită analistul de credit.
    const topClienti = await db
      .prepare(
        `SELECT p.nume, COALESCE(SUM(n.net),0) AS net FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         JOIN (SELECT factura_id, SUM(cantitate*pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n ON n.factura_id = f.id
         WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ?
         GROUP BY p.id, p.nume ORDER BY net DESC LIMIT 5`
      )
      .all(acum12);
    const top1 = topClienti.length && vanzariNet12 > 0 ? (Number(topClienti[0].net) / vanzariNet12) * 100 : 0;
    const top5 = vanzariNet12 > 0 ? (topClienti.reduce((s, c) => s + Number(c.net), 0) / vanzariNet12) * 100 : 0;

    const dso = vanzariNet12 > 0 ? (creanteClienti / (vanzariNet12 * 1.19)) * 365 : null; // creanțele sunt cu TVA
    const dpo = achizitiiNet12 > 0 ? (datoriiFurnizori / (achizitiiNet12 * 1.19)) * 365 : null;
    const crestere = vanzariNetPrec > 0 ? (vanzariNet12 / vanzariNetPrec - 1) * 100 : null;
    const pctDepasit = creanteClienti > 0 ? (Number(sV.depasit) / creanteClienti) * 100 : 0;

    const areSolduriInitiale = Number((await db.prepare("SELECT COUNT(*) AS n FROM inregistrari_contabile WHERE sursa = 'sold_initial'").get()).n) > 0;
    const areAchizitii = achizitiiNet12 > 0;

    // Estimarea de finanțabilitate — pe logica standard a produselor bancare:
    //  - linie de credit pentru capital de lucru: uzual ~8–12% din cifra anuală;
    //  - factoring: ~80% din creanțele nedepășite (sub 90 de zile întârziere).
    const creanteEligibile = Math.max(0, creanteClienti - Number(sV.depasit));
    const linieCreditMin = vanzariNet12 * 0.08;
    const linieCreditMax = vanzariNet12 * 0.12;
    const factoring = creanteEligibile * 0.8;

    const nota = (ok, avert) => (ok ? '<span class="badge verde">bun</span>' : avert ? '<span class="badge galben">atenție</span>' : '<span class="badge rosu">slab</span>');

    const indicatori = [
      {
        nume: "Cifra de afaceri (12 luni, fără TVA)",
        valoare: money(vanzariNet12),
        tinta: "—",
        stare: "",
        explicatie: "Baza oricărei analize de credit.",
      },
      {
        nume: "Creștere an/an",
        valoare: crestere !== null ? crestere.toFixed(1) + "%" : "—",
        tinta: "> 0%",
        stare: crestere !== null ? nota(crestere > 5, crestere > -5) : "",
        explicatie: "Trend pozitiv = capacitate de rambursare în creștere.",
      },
      {
        nume: "DSO — zile medii de încasare",
        valoare: dso !== null ? Math.round(dso) + " zile" : "—",
        tinta: "< 60 de zile",
        stare: dso !== null ? nota(dso < 60, dso < 90) : "",
        explicatie: "Cât stau banii la clienți. Peste 90 de zile = presiune pe cash și punctaj slab.",
      },
      {
        nume: "DPO — zile medii de plată furnizori",
        valoare: dpo !== null ? Math.round(dpo) + " zile" : "n/a (fără facturi de achiziție)",
        tinta: "≈ DSO sau mai mare",
        stare: dpo !== null ? nota(dso === null || dpo >= dso * 0.7, true) : "",
        explicatie: "Dacă plătești mult mai repede decât încasezi, finanțezi tu piața.",
      },
      {
        nume: "Creanțe cu scadența depășită",
        valoare: money(sV.depasit) + ` (${pctDepasit.toFixed(0)}% din sold)`,
        tinta: "< 20% din sold",
        stare: nota(pctDepasit < 20, pctDepasit < 40),
        explicatie: "Banca scade creanțele vechi din garanții — și din încredere.",
      },
      {
        nume: "Concentrarea pe primul client",
        valoare: topClienti.length ? `${top1.toFixed(0)}% (${esc(topClienti[0].nume)})` : "—",
        tinta: "< 30%",
        stare: nota(top1 < 30, top1 < 50),
        explicatie: "Dependența de un singur client e primul risc semnalat de analist.",
      },
      {
        nume: "Concentrarea pe top 5 clienți",
        valoare: `${top5.toFixed(0)}%`,
        tinta: "< 60%",
        stare: nota(top5 < 60, top5 < 80),
        explicatie: "",
      },
      {
        nume: "Fond de rulment operațional (creanțe − furnizori)",
        valoare: money(creanteClienti - datoriiFurnizori),
        tinta: "pozitiv",
        stare: nota(creanteClienti - datoriiFurnizori > 0, true),
        explicatie: areAchizitii ? "" : "Parțial: facturile de furnizori nu sunt încă în ERP.",
      },
    ];

    const sugestii = [];
    if (dso !== null && dso > 60)
      sugestii.push(
        `<strong>Scade DSO-ul (${Math.round(dso)} zile).</strong> Folosește zilnic <a href="/rapoarte/incasari">scadențarul</a> și task-urile de încasare; renegociază termenele cu clienții mari. Fiecare 10 zile de DSO în minus eliberează ≈ ${money((vanzariNet12 * 1.19 * 10) / 365)} cash permanent.`
      );
    if (pctDepasit > 20)
      sugestii.push(
        `<strong>Curăță restanțele (${pctDepasit.toFixed(0)}% din sold e depășit).</strong> Creanțele sub 90 de zile sunt eligibile la factoring; cele peste — nu. Recuperarea lor crește direct plafonul finanțabil.`
      );
    if (top1 > 30)
      sugestii.push(
        `<strong>Diversifică portofoliul.</strong> ${esc(topClienti.length ? topClienti[0].nume : "")} = ${top1.toFixed(0)}% din vânzări. Băncile taie punctajul peste 30%. Pipeline-ul CRM și lead-urile sunt unealta — fiecare client nou mare scade riscul.`
      );
    if (!areAchizitii)
      sugestii.push(
        `<strong>Importă facturile de furnizori.</strong> Fără ele, DPO, marja și fondul de rulment sunt incomplete — iar dosarul de credit se face pe cifre complete. Ai pagina <a href="/import">Import</a> pregătită.`
      );
    if (!areSolduriInitiale)
      sugestii.push(
        `<strong>Preia soldurile din balanța Conta.</strong> Lichiditatea curentă, gradul de îndatorare și capitalurile proprii — exact ce cere banca — se pot calcula abia după <a href="/rapoarte/balanta/solduri-initiale">preluarea soldurilor inițiale</a>.`
      );
    sugestii.push(
      `<strong>Ține istoricul de încasări curat în ERP.</strong> Un raport de aging + scadențar exportabile, cu cifre care se leagă cu extrasul de cont (modulul <a href="/banca">Bancă</a>), scurtează analiza de credit de la săptămâni la zile.`
    );

    // --- indicatori REALI din balanțele Conta încărcate (snapshoturi) ------
    const etichete = await db
      .prepare("SELECT eticheta, MIN(data_pana) AS pana FROM balante_snapshot GROUP BY eticheta ORDER BY MIN(data_pana) ASC")
      .all();
    const analizeBilant = [];
    for (const e of etichete) {
      const conturi = await db.prepare("SELECT cont, r_d, r_c, sf_d, sf_c FROM balante_snapshot WHERE eticheta = ?").all(e.eticheta);
      // Notă de calcul: SmartBill Conta închide LUNAR clasele 6/7 prin 121,
      // deci rulajele debit=credit pe 6xx/7xx și "venituri - cheltuieli" ar
      // ieși mereu zero. De-aia: cifra de afaceri = rulajul CREDITOR al
      // grupei 70x (fără închideri), iar profitul = soldul contului 121
      // (credit = profit, debit = pierdere) — exact cum îl citește și banca.
      let capitaluri = 0, datoriiTL = 0, datoriiCurente = 0, activeImob = 0, activeCirc = 0, ca = 0, profit = 0, cash = 0;
      for (const c of conturi) {
        const g2 = c.cont.slice(0, 2);
        const cls = c.cont.charAt(0);
        const netD = Number(c.sf_d) - Number(c.sf_c);
        if (["10", "11", "12"].includes(g2)) capitaluri += -netD;
        else if (["16"].includes(g2)) datoriiTL += Math.max(0, -netD);
        else if (cls === "2") activeImob += Math.max(0, netD);
        else if (cls === "3") activeCirc += Math.max(0, netD);
        else if (cls === "4") {
          if (netD > 0) activeCirc += netD;
          else datoriiCurente += -netD;
        } else if (cls === "5") {
          if (c.cont.startsWith("519")) datoriiCurente += Math.max(0, -netD);
          else {
            activeCirc += Math.max(0, netD);
            if (["51", "53", "54"].includes(g2) && !c.cont.startsWith("519")) cash += Math.max(0, netD);
          }
        }
        if (g2 === "70" && !c.cont.startsWith("709")) ca += Number(c.r_c);
        if (c.cont.startsWith("709")) ca -= Number(c.r_d);
        if (c.cont === "121") profit = Number(c.sf_c) - Number(c.sf_d);
      }
      analizeBilant.push({
        eticheta: e.eticheta,
        capitaluri, datoriiTL, datoriiCurente, activeImob, activeCirc, cash, ca,
        profit,
        totalActiv: activeImob + activeCirc,
        lichiditate: datoriiCurente > 0 ? activeCirc / datoriiCurente : null,
        indatorare: activeImob + activeCirc > 0 ? ((datoriiTL + datoriiCurente) / (activeImob + activeCirc)) * 100 : null,
      });
    }
    const ultimBilant = analizeBilant.length ? analizeBilant[analizeBilant.length - 1] : null;

    const sectiuneBilant = analizeBilant.length
      ? `
      <h2>Cifrele reale din balanțele Conta (ce vede banca în bilanț)</h2>
      ${table(
        ["Perioada", "Cifra de afaceri (rulaj 70x)", "Profit / (pierdere) — sold 121", "Capitaluri proprii", "Datorii bănci/leasing (16x, 519)", "Datorii curente", "Cash (51x+53x)", "Lichiditate curentă", "Grad îndatorare"],
        analizeBilant.map((a) => [
          esc(a.eticheta),
          money(a.ca),
          `<span style="color:${a.profit >= 0 ? "var(--success)" : "var(--danger)"}">${money(a.profit)}</span>`,
          money(a.capitaluri),
          money(a.datoriiTL),
          money(a.datoriiCurente),
          money(a.cash),
          a.lichiditate !== null ? `${a.lichiditate.toFixed(2)} ${a.lichiditate >= 1.2 ? '<span class="badge verde">bun</span>' : a.lichiditate >= 1 ? '<span class="badge galben">la limită</span>' : '<span class="badge rosu">sub 1</span>'}` : "—",
          a.indatorare !== null ? `${a.indatorare.toFixed(0)}% ${a.indatorare <= 60 ? '<span class="badge verde">ok</span>' : a.indatorare <= 80 ? '<span class="badge galben">ridicat</span>' : '<span class="badge rosu">critic</span>'}` : "—",
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted)">Ținte uzuale de bancă: lichiditate curentă ≥ 1,2 · grad de îndatorare ≤ 60–70% · capitaluri proprii pozitive și în creștere. Calculat direct din balanțele SmartBill Conta încărcate la <a href="/rapoarte/balanta/istoric">Balanțe istorice</a>.</p>`
      : `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">Pentru indicatorii de bilanț REALI (capitaluri proprii, lichiditate, grad de îndatorare — exact ce cere banca), încarcă balanțele anuale din SmartBill Conta la <a href="/rapoarte/balanta/istoric">Balanțe istorice</a>.</div>`;

    const continut = `
      ${sectiuneBilant}
      <div class="cards">
        <div class="card"><div class="label">Linie de credit estimată (capital de lucru)</div><div class="value">${money(linieCreditMin)} – ${money(linieCreditMax)}</div></div>
        <div class="card"><div class="label">Plafon factoring estimat (80% din creanțe eligibile)</div><div class="value">${money(factoring)}</div></div>
        <div class="card"><div class="label">Creanțe eligibile (nedepășite)</div><div class="value">${money(creanteEligibile)}</div></div>
      </div>
      <p style="font-size:12px;color:var(--text-muted)">Estimări orientative pe practica uzuală a băncilor din România (linie de capital de lucru ≈ 8–12% din cifra anuală; factoring ≈ 80% din creanțele nedepășite). Suma reală depinde de bilanț, garanții, istoric bancar și politica fiecărei bănci — nu e o ofertă.</p>

      <h2>Indicatorii dosarului de credit</h2>
      ${table(
        ["Indicator", "Valoare", "Ținta băncii", "Stare", "De ce contează"],
        indicatori.map((i) => [i.nume, i.valoare, i.tinta, i.stare, `<span style="font-size:12px;color:var(--text-muted)">${i.explicatie}</span>`])
      )}

      <h2>Top 5 clienți (concentrarea riscului)</h2>
      ${table(
        ["Client", "Vânzări 12 luni (net)", "% din total"],
        topClienti.map((c) => [esc(c.nume), money(c.net), vanzariNet12 > 0 ? ((Number(c.net) / vanzariNet12) * 100).toFixed(1) + "%" : "—"])
      )}

      <h2>Ce ar îmbunătăți punctajul</h2>
      <ol style="line-height:1.7">${sugestii.map((s) => `<li>${s}</li>`).join("")}</ol>
      <p style="font-size:12px;color:var(--text-muted)">Nu sunt consultant de credit — raportul arată indicatorii standard pe datele din ERP; dosarul final se face cu banca și contabilul.</p>
    `;
    send(ctx.res, 200, pagina(ctx, "Indicatori financiari — ochii băncii", "/rapoarte/indicatori", continut));
  });

  // ---- Financiar: comparație la zi cu anii precedenți ---------------------
  router.get("/rapoarte/comparatie", async (ctx) => {
    const aziStr = azi();
    const anCurent = Number(aziStr.slice(0, 4));
    const mmzz = aziStr.slice(5, 10);
    const ani = [anCurent, anCurent - 1, anCurent - 2];

    async function perioada(an) {
      const deLa = `${an}-01-01`;
      const panaLa = `${an}-${mmzz}`;
      const vanzari = await db
        .prepare(
          `SELECT COALESCE(SUM(n.net),0) AS net, COALESCE(SUM(t.total),0) AS total, COUNT(*) AS nr, COUNT(DISTINCT f.partener_id) AS clienti
           FROM facturi f
           JOIN (SELECT factura_id, SUM(cantitate*pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n ON n.factura_id = f.id
           JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
           WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND f.data_emiterii <= ?`
        )
        .get(deLa, panaLa);
      const achizitii = await db
        .prepare(
          `SELECT COALESCE(SUM(t.total),0) AS total FROM facturi f JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
           WHERE f.directie = 'achizitie' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND f.data_emiterii <= ?`
        )
        .get(deLa, panaLa);
      const incasari = await db
        .prepare(
          `SELECT COALESCE(SUM(pl.suma),0) AS s FROM plati pl JOIN facturi f ON f.id = pl.factura_id
           WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND pl.data >= ? AND pl.data <= ?`
        )
        .get(deLa, panaLa);
      return {
        an,
        net: Number(vanzari.net),
        total: Number(vanzari.total),
        nr: Number(vanzari.nr),
        clienti: Number(vanzari.clienti),
        mediaFactura: Number(vanzari.nr) > 0 ? Number(vanzari.total) / Number(vanzari.nr) : 0,
        achizitii: Number(achizitii.total),
        incasari: Number(incasari.s),
      };
    }
    const date = [];
    for (const an of ani) date.push(await perioada(an));
    const [c, p1, p2] = date;

    const delta = (a, b) => (b > 0 ? (((a - b) / b) * 100).toFixed(1) + "%" : "—");
    const culoare = (a, b) => (b > 0 ? (a >= b ? "var(--success)" : "var(--danger)") : "inherit");
    const rand = (nume, camp, fmt = money) => [
      nume,
      fmt(c[camp]),
      `${fmt(p1[camp])} <span style="color:${culoare(c[camp], p1[camp])};font-size:12px">(${delta(c[camp], p1[camp])})</span>`,
      `${fmt(p2[camp])} <span style="color:${culoare(c[camp], p2[camp])};font-size:12px">(${delta(c[camp], p2[camp])})</span>`,
    ];
    const nrFmt = (x) => String(Math.round(x));

    // Vânzări lunare pe cei 3 ani, pentru grafic comparativ.
    const lunar = await db
      .prepare(
        `SELECT SUBSTR(f.data_emiterii,1,4) AS an, SUBSTR(f.data_emiterii,6,2) AS luna, COALESCE(SUM(t.total),0) AS v
         FROM facturi f JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ?
         GROUP BY SUBSTR(f.data_emiterii,1,4), SUBSTR(f.data_emiterii,6,2)`
      )
      .all(`${anCurent - 2}-01-01`);
    const gr = {};
    for (const r of lunar) (gr[r.luna] ||= {})[r.an] = Number(r.v);
    const maxLunar = Math.max(1, ...lunar.map((r) => Number(r.v)));

    const continut = `
      <p style="color:var(--text-muted);font-size:13px">Aceeași perioadă în fiecare an: <strong>1 ianuarie → ${esc(mmzz.replace("-", "."))}</strong> — mere cu mere, la zi.</p>
      ${table(
        ["Indicator", `${anCurent} (curent)`, `${anCurent - 1} (vs. curent)`, `${anCurent - 2} (vs. curent)`],
        [
          rand("Vânzări (cu TVA)", "total"),
          rand("Vânzări (net, fără TVA)", "net"),
          rand("Încasări efective", "incasari"),
          rand("Costuri (facturi furnizori, cu TVA)", "achizitii"),
          rand("Facturi emise", "nr", nrFmt),
          rand("Clienți activi (au cumpărat)", "clienti", nrFmt),
          rand("Valoarea medie a facturii", "mediaFactura"),
        ]
      )}
      ${c.achizitii === 0 ? '<p style="font-size:12px;color:var(--warn)">Costurile arată 0 pentru că facturile de furnizori nu sunt încă importate în ERP.</p>' : ""}

      <h2>Vânzări pe luni — ${anCurent} vs. ${anCurent - 1} vs. ${anCurent - 2}</h2>
      <div class="chart">
        ${["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]
          .map((luna) => {
            const v = (an) => (gr[luna] || {})[String(an)] || 0;
            return `<div class="chart-row">
              <div class="chart-label">luna ${luna}</div>
              <div class="chart-bars">
                ${bar((v(anCurent) / maxLunar) * 100, "verde")}
                ${bar((v(anCurent - 1) / maxLunar) * 100, "rosu")}
                ${bar((v(anCurent - 2) / maxLunar) * 100, "galbena")}
              </div>
              <div class="chart-values">${money(v(anCurent))} / ${money(v(anCurent - 1))} / ${money(v(anCurent - 2))}</div>
            </div>`;
          })
          .join("")}
      </div>
      <p style="font-size:12px;color:var(--text-muted)">Verde = ${anCurent}, roșu = ${anCurent - 1}, galben = ${anCurent - 2}. Luna curentă e parțială.</p>
    `;
    send(ctx.res, 200, pagina(ctx, `Comparație la zi: ${anCurent} vs. ${anCurent - 1} vs. ${anCurent - 2}`, "/rapoarte/comparatie", continut));
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
         LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ?
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
           LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ?
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
         WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0
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


  // ---- Comercial: top produse & profitabilitate pe produs ----------------
  // Onest despre acoperire: facturile importate din SmartBill au o singură
  // linie sumar, FĂRĂ produse — deci topul acoperă doar facturile emise din
  // ERP cu linii reale de produs. Raportul afișează explicit procentul de
  // venit care are detaliu pe produse, ca să nu tragă nimeni concluzii de pe
  // date parțiale fără să știe.
  router.get("/rapoarte/produse-top", async (ctx) => {
    const interval = intervalDinQuery(ctx, 12);
    const { deLa, panaLa } = interval;
    const agentAles = parseInt(ctx.query.agent, 10) || null;
    const agenti = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();

    const filtruAgent = agentAles ? "AND p.agent_id = ?" : "";
    const argsAgent = agentAles ? [agentAles] : [];

    const produse = await db
      .prepare(
        `SELECT pr.id, pr.denumire, pr.cod, pr.pret_achizitie,
                SUM(fl.cantitate) AS cantitate,
                SUM(fl.cantitate * fl.pret_unitar) AS venit,
                SUM(fl.cantitate * COALESCE(pr.pret_achizitie, 0)) AS cost,
                COUNT(DISTINCT f.id) AS facturi,
                COUNT(DISTINCT f.partener_id) AS clienti
         FROM facturi_linii fl
         JOIN facturi f ON f.id = fl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         JOIN produse pr ON pr.id = fl.produs_id
         WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND f.data_emiterii <= ? ${filtruAgent}
         GROUP BY pr.id, pr.denumire, pr.cod, pr.pret_achizitie
         ORDER BY venit DESC
         LIMIT 50`
      )
      .all(deLa, panaLa, ...argsAgent);

    const acoperire = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN fl.produs_id IS NOT NULL THEN fl.cantitate * fl.pret_unitar ELSE 0 END), 0) AS cuProdus,
                COALESCE(SUM(fl.cantitate * fl.pret_unitar), 0) AS total
         FROM facturi_linii fl JOIN facturi f ON f.id = fl.factura_id JOIN parteneri p ON p.id = f.partener_id
         WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND f.data_emiterii <= ? ${filtruAgent}`
      )
      .get(deLa, panaLa, ...argsAgent);
    const pctAcoperire = Number(acoperire.total) > 0 ? (Number(acoperire.cuProdus) / Number(acoperire.total)) * 100 : 0;

    const totalVenit = produse.reduce((s, p) => s + Number(p.venit), 0);
    const totalMarja = produse.reduce((s, p) => s + (Number(p.venit) - Number(p.cost)), 0);

    const continut = `
      ${selectorPerioada(
        "/rapoarte/produse-top",
        interval,
        `<select name="agent" onchange="this.form.submit()">
           <option value="">toți agenții</option>
           ${agenti.map((a) => `<option value="${a.id}"${agentAles === a.id ? " selected" : ""}>doar clienții lui ${esc(a.nume)}</option>`).join("")}
         </select>`
      )}

      <div class="cards">
        <div class="card"><div class="label">Venit pe produse identificate</div><div class="value">${money(totalVenit)}</div></div>
        <div class="card"><div class="label">Marjă totală (unde există cost)</div><div class="value">${money(totalMarja)}</div></div>
        <div class="card"><div class="label">Acoperire: venit cu detaliu pe produs</div><div class="value" style="color:${pctAcoperire > 50 ? "inherit" : "var(--warn)"}">${pctAcoperire.toFixed(0)}%</div></div>
      </div>
      ${
        pctAcoperire < 50
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">Doar ${pctAcoperire.toFixed(0)}% din venitul perioadei are detaliu pe produse — facturile importate din SmartBill vin fără linii de produs. Topul de mai jos e valabil pentru facturile emise din ERP; pe măsură ce facturezi din aplicație, acoperirea crește singură.</div>`
          : ""
      }

      <h2>Top produse vândute${agentAles ? " (portofoliul agentului ales)" : ""}</h2>
      ${
        produse.length
          ? table(
              ["Produs", "Cod", "Cantitate", "Venit (net)", "Cost", "Marjă", "Marjă %", "Facturi", "Clienți"],
              produse.map((p) => {
                const marja = Number(p.venit) - Number(p.cost);
                const pct = Number(p.venit) > 0 && Number(p.cost) > 0 ? ((marja / Number(p.venit)) * 100).toFixed(1) + "%" : "—";
                return [
                  `<a href="/produse/${p.id}">${esc(p.denumire)}</a>`,
                  esc(p.cod || "—"),
                  Number(p.cantitate).toLocaleString("ro-RO"),
                  money(p.venit),
                  Number(p.cost) > 0 ? money(p.cost) : "—",
                  Number(p.cost) > 0 ? money(marja) : "—",
                  pct,
                  p.facturi,
                  p.clienti,
                ];
              })
            )
          : '<p style="color:var(--text-muted)">Nicio linie de factură cu produs identificat în perioada aleasă. Emite facturi din ERP (cu produse din catalog) sau importă stocul ca să existe catalogul.</p>'
      }
      <p style="font-size:12px;color:var(--text-muted)">Costul = cantitate × prețul de achiziție din catalogul de produse. Fără preț de achiziție completat, marja produsului nu se afișează (nu e zero — e necunoscută).</p>
    `;
    send(ctx.res, 200, pagina(ctx, "Top produse & profitabilitate pe produs", "/rapoarte/produse-top", continut));
  });

  // ---- Comercial: clienți activi / inactivi -----------------------------
  router.get("/rapoarte/clienti", async (ctx) => {
    const prag = Math.min(1095, Math.max(30, parseInt(ctx.query.prag || "180", 10) || 180));
    const limita = new Date(Date.now() - prag * 86400000).toISOString().slice(0, 10);

    const clienti = await db
      .prepare(
        `SELECT p.id, p.nume, COUNT(*) AS nr, COALESCE(SUM(l.total),0) AS valoare, MAX(f.data_emiterii) AS ultima
         FROM parteneri p
         JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0
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
