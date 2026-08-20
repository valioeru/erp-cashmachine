"use strict";
// CRM — trei componente care lucrează împreună:
//   1. Lead-uri: contacte care încă NU sunt clienți. Stau separat de parteneri
//      ca lista de clienți să nu se umple de contacte necalificate; la
//      conversie devin partener (+ opțional oportunitate).
//   2. Oportunități: pipeline-ul de vânzare pe stadii.
//   3. Activitate: task-uri, interacțiuni și emailuri trimise din aplicație.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const taskuri = require("./taskuri");

const STADII = [
  { key: "lead", label: "Lead" },
  { key: "calificat", label: "Calificat" },
  { key: "oferta", label: "Ofertă trimisă" },
  { key: "negociere", label: "Negociere" },
  { key: "castigat", label: "Câștigat" },
  { key: "pierdut", label: "Pierdut" },
];
const STADIU_LABEL = Object.fromEntries(STADII.map((s) => [s.key, s.label]));

const STADII_LEAD = [
  ["nou", "Nou", "gri"],
  ["contactat", "Contactat", "galben"],
  ["calificat", "Calificat", "verde"],
  ["necalificat", "Necalificat", "rosu"],
  ["convertit", "Convertit în client", "verde"],
];

const SURSE_LEAD = ["site", "telefon", "email", "recomandare", "târg / expoziție", "LinkedIn", "campanie", "manual", "altele"];

const TIPURI_INTERACTIUNE = [
  ["apel", "Apel telefonic"],
  ["email", "Email"],
  ["intalnire", "Întâlnire"],
  ["nota", "Notiță"],
];

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function badgeLead(stadiu) {
  const g = STADII_LEAD.find((s) => s[0] === stadiu);
  return g ? `<span class="badge ${g[2]}">${esc(g[1])}</span>` : esc(stadiu);
}
function nr(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function subnavCrm(activ) {
  const linkuri = [
    ["/crm", "Pipeline"],
    ["/crm/birou", "Biroul meu"],
    ["/crm/leaduri", "Lead-uri"],
    ["/crm/activitate", "Activitate & emailuri"],
    ["/taskuri", "Task-uri"],
  ];
  return `<div class="subnav">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

function register(router) {
  // ================= PIPELINE (oportunități) ==========================
  router.get("/crm", async (ctx) => {
    // Adminul vede pipeline-ul total sau filtrat pe un singur agent; un agent
    // de vânzări își vede DOAR pipeline-ul lui (cerință de business).
    const esteAdmin = ctx.user && ctx.user.rol === "admin";
    let filtruAgent = null;
    if (esteAdmin) {
      const a = parseInt(ctx.query.agent, 10);
      filtruAgent = Number.isFinite(a) && a > 0 ? a : null;
    } else if (ctx.user && ctx.user.rol === "vanzari") {
      filtruAgent = ctx.user.id;
    }
    const agenti = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();

    const oportunitati = await db
      .prepare(
        `SELECT o.*, p.nume AS partener_nume, u.nume AS agent_nume
         FROM oportunitati o JOIN parteneri p ON p.id = o.partener_id
         LEFT JOIN utilizatori u ON u.id = o.atribuit_lui
         ${filtruAgent ? "WHERE o.atribuit_lui = ? OR p.agent_id = ?" : ""}
         ORDER BY o.id DESC`
      )
      .all(...(filtruAgent ? [filtruAgent, filtruAgent] : []));

    const aziStr = azi();
    const deContactat = await db
      .prepare(
        `SELECT i.*, p.nume AS partener_nume, p.id AS partener_id
         FROM interactiuni i JOIN parteneri p ON p.id = i.partener_id
         WHERE i.data_urmatoare_actiune IS NOT NULL AND i.data_urmatoare_actiune != '' AND i.data_urmatoare_actiune <= ?
         ORDER BY i.data_urmatoare_actiune ASC LIMIT 100`
      )
      .all(aziStr);

    const taskuriMele = await db
      .prepare(
        `${taskuri.SELECT_TASK} WHERE t.status IN ('${taskuri.DESCHISE.join("','")}') ${ctx.user ? "AND t.atribuit_lui = ?" : ""}
         ORDER BY (t.scadenta IS NULL), t.scadenta ASC LIMIT 15`
      )
      .all(...(ctx.user ? [ctx.user.id] : []));

    const nrLeaduriNoi = (await db.prepare("SELECT COUNT(*) AS n FROM leaduri WHERE stadiu IN ('nou','contactat')").get()).n;

    const coloane = STADII.map((s) => {
      const items = oportunitati.filter((o) => o.stadiu === s.key);
      const totalValoare = items.reduce((sum, o) => sum + Number(o.valoare_estimata || 0), 0);
      return `<div class="crm-col">
        <div class="crm-col-head">${esc(s.label)} <span class="crm-col-count">${items.length}</span></div>
        <div class="crm-col-total">${money(totalValoare)}</div>
        ${
          items
            .map(
              (o) => `
          <a href="/crm/oportunitati/${o.id}" class="crm-card">
            <div class="crm-card-title">${esc(o.titlu)}</div>
            <div class="crm-card-partener">${esc(o.partener_nume)}</div>
            <div class="crm-card-valoare">${money(o.valoare_estimata)}</div>
            ${o.agent_nume ? `<div class="crm-card-partener">👤 ${esc(o.agent_nume)}</div>` : ""}
          </a>`
            )
            .join("") || `<div class="crm-col-empty">—</div>`
        }
      </div>`;
    }).join("");

    const body = `
      ${subnavCrm("/crm")}
      <div class="toolbar">
        <a href="/crm/oportunitati/noua" class="btn">+ Oportunitate</a>
        <a href="/crm/leaduri/nou" class="btn secondary">+ Lead</a>
        <a href="/taskuri/nou" class="btn secondary">+ Task</a>
        ${nrLeaduriNoi ? `<a href="/crm/leaduri" class="btn secondary">${nrLeaduriNoi} lead-uri de lucrat →</a>` : ""}
        ${
          esteAdmin
            ? `<form method="get" action="/crm" class="inline-form" style="margin-left:auto">
                <select name="agent" onchange="this.form.submit()" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px">
                  <option value="">Pipeline: toți agenții</option>
                  ${agenti.map((a) => `<option value="${a.id}"${filtruAgent === a.id ? " selected" : ""}>doar ${esc(a.nume)}</option>`).join("")}
                </select>
              </form>`
            : filtruAgent
            ? `<span style="margin-left:auto;font-size:13px;color:var(--text-muted)">Pipeline-ul tău</span>`
            : ""
        }
      </div>
      <div class="crm-board">${coloane}</div>

      <h2>Task-urile mele deschise</h2>
      ${
        taskuriMele.length
          ? table(taskuri.CAPETE, taskuriMele.map((t) => taskuri.randTask(t, aziStr)))
          : '<p style="color:var(--text-muted)">Niciun task deschis. <a href="/taskuri/nou">Creează unul</a>.</p>'
      }

      <h2>De contactat (scadent sau azi)</h2>
      ${
        deContactat.length
          ? table(
              ["Partener", "Subiect", "Data programată", "Acțiune"],
              deContactat.map((i) => [
                `<a href="/parteneri/${i.partener_id}">${esc(i.partener_nume)}</a>`,
                esc(i.subiect) || "—",
                `${esc(i.data_urmatoare_actiune)}${i.data_urmatoare_actiune < aziStr ? ' <span class="badge rosu">întârziat</span>' : ""}`,
                `<a class="link-btn" href="/crm/email/nou?partener_id=${i.partener_id}">Trimite email</a>`,
              ])
            )
          : "<p>Nimic programat pentru azi.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "CRM — pipeline vânzări", active: "/crm", body }));
  });

  router.get("/crm/oportunitati/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 3000").all();
    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const presetPartener = ctx.query.partener_id || "";
    if (parteneri.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user, title: "Oportunitate nouă", active: "/crm", body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">partener</a>.</p>` })
      );
    }
    const body = `<form method="post" action="/crm/oportunitati" class="form">
      <label class="field"><span>Partener</span>
        <select name="partener_id" required>${parteneri
          .map((p) => `<option value="${p.id}" ${String(p.id) === String(presetPartener) ? "selected" : ""}>${esc(p.nume)}</option>`)
          .join("")}</select>
      </label>
      <label class="field"><span>Titlu oportunitate</span><input type="text" name="titlu" required value="${esc(String(ctx.query.titlu || ""))}"></label>
      <label class="field"><span>Valoare estimată (lei)</span><input type="number" step="0.01" name="valoare_estimata"></label>
      <label class="field"><span>Agent responsabil</span>
        <select name="atribuit_lui">
          <option value="">— neatribuit —</option>
          ${useri.map((u) => `<option value="${u.id}"${ctx.user && ctx.user.id === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Stadiu</span>
        <select name="stadiu">${STADII.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Dată estimată închidere</span><input type="date" name="data_estimata_inchidere"></label>
      <label class="field"><span>Observații</span><textarea name="observatii" rows="2"></textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn">Salvează</button>
        <a href="/crm" class="btn secondary">Renunță</a>
      </div>
    </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Oportunitate nouă", active: "/crm", body }));
  });

  router.post("/crm/oportunitati", async (ctx) => {
    const { partener_id, titlu, valoare_estimata, stadiu, data_estimata_inchidere, observatii, atribuit_lui } = ctx.body;
    const info = await db
      .prepare(
        "INSERT INTO oportunitati (partener_id, titlu, valoare_estimata, stadiu, data_estimata_inchidere, observatii, atribuit_lui) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
      )
      .run(partener_id, titlu, Number(valoare_estimata || 0), stadiu || "lead", data_estimata_inchidere || null, observatii || "", nr(atribuit_lui));
    redirect(ctx.res, `/crm/oportunitati/${info.lastInsertRowid}`);
  });

  router.get("/crm/oportunitati/:id", async (ctx) => {
    const o = await db
      .prepare(
        `SELECT o.*, p.nume AS partener_nume, p.email AS partener_email, u.nume AS agent_nume
         FROM oportunitati o JOIN parteneri p ON p.id = o.partener_id
         LEFT JOIN utilizatori u ON u.id = o.atribuit_lui WHERE o.id = ?`
      )
      .get(ctx.params.id);
    if (!o) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/crm", body: "<p>Oportunitate inexistentă.</p>" }));

    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const taskuriLegate = await db.prepare(`${taskuri.SELECT_TASK} WHERE t.oportunitate_id = ? ORDER BY t.id DESC`).all(o.id);
    const emailuri = await db
      .prepare("SELECT e.*, u.nume AS expeditor FROM emailuri e LEFT JOIN utilizatori u ON u.id = e.utilizator_id WHERE e.oportunitate_id = ? ORDER BY e.id DESC")
      .all(o.id);

    const body = `
      ${subnavCrm("/crm")}
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Partener</div><a href="/parteneri/${o.partener_id}">${esc(o.partener_nume)}</a></div>
          <div><div class="k">Valoare estimată</div>${money(o.valoare_estimata)}</div>
          <div><div class="k">Agent</div>${esc(o.agent_nume || "neatribuit")}</div>
          <div><div class="k">Dată estimată închidere</div>${esc(o.data_estimata_inchidere) || "—"}</div>
          <div><div class="k">Observații</div>${esc(o.observatii) || "—"}</div>
        </div>
      </div>

      <div class="toolbar">
        <a class="btn secondary" href="/taskuri/nou?oportunitate_id=${o.id}&partener_id=${o.partener_id}&titlu=${encodeURIComponent("Follow-up: " + o.titlu)}">+ Task</a>
        <a class="btn secondary" href="/crm/email/nou?partener_id=${o.partener_id}&oportunitate_id=${o.id}">✉ Trimite email</a>
      </div>

      <form method="post" action="/crm/oportunitati/${o.id}/stadiu" class="form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Stadiu</span>
            <select name="stadiu">${STADII.map((s) => `<option value="${s.key}" ${s.key === o.stadiu ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
          </label>
          <label class="field"><span>Agent responsabil</span>
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${o.atribuit_lui === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="form-actions"><button type="submit" class="btn small">Actualizează</button></div>
      </form>

      <h2>Task-uri legate</h2>
      ${taskuriLegate.length ? table(taskuri.CAPETE, taskuriLegate.map((t) => taskuri.randTask(t, azi()))) : '<p style="color:var(--text-muted)">Niciun task.</p>'}

      <h2>Emailuri trimise</h2>
      ${
        emailuri.length
          ? table(
              ["Data", "Către", "Subiect", "Expeditor", "Status"],
              emailuri.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                esc(e.catre),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                esc(e.expeditor || "—"),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email trimis din aplicație.</p>'
      }

      <div class="toolbar" style="margin-top:14px">
        <form method="post" action="/crm/oportunitati/${o.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv oportunitatea?')">
          <button type="submit" class="link-btn danger">Șterge oportunitatea</button>
        </form>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Oportunitate: ${o.titlu}`, active: "/crm", body }));
  });

  router.post("/crm/oportunitati/:id/stadiu", async (ctx) => {
    await db.prepare("UPDATE oportunitati SET stadiu = ?, atribuit_lui = ? WHERE id = ?").run(ctx.body.stadiu, nr(ctx.body.atribuit_lui), ctx.params.id);
    redirect(ctx.res, `/crm/oportunitati/${ctx.params.id}`);
  });

  router.post("/crm/oportunitati/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM taskuri WHERE oportunitate_id = ?").run(ctx.params.id);
    await db.prepare("DELETE FROM oportunitati WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/crm");
  });


  // ================= BIROUL AGENTULUI =================================
  // Dashboardul personal al fiecărui agent: portofoliul lui de clienți,
  // pipeline-ul lui, calendarul de task-uri pe zile, remindere (întârziate),
  // zilele de naștere ale clienților și sugestii de clienți potențiali.
  // Adminul poate deschide biroul oricărui agent cu ?agent=ID.
  router.get("/crm/birou", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    let agentId = ctx.user.id;
    if (esteAdmin) {
      const a = parseInt(ctx.query.agent, 10);
      if (Number.isFinite(a) && a > 0) agentId = a;
    }
    const agent = await db.prepare("SELECT id, nume FROM utilizatori WHERE id = ?").get(agentId);
    if (!agent) return redirect(ctx.res, "/crm");
    const agenti = esteAdmin ? await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all() : [];

    const aziStr = azi();
    const acum12Luni = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const SUB_TOTAL =
      "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
    const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id)";

    // Portofoliul: clienții alocați agentului, cu vânzări pe 12 luni și sold.
    const clienti = await db
      .prepare(
        `SELECT p.id, p.nume, p.email, p.telefon, p.data_nastere,
                COALESCE(SUM(CASE WHEN f.data_emiterii >= ? THEN l.total ELSE 0 END), 0) AS vanzari12,
                COALESCE(SUM(COALESCE(l.total,0) - COALESCE(pl.platit,0)), 0) AS sold,
                MAX(f.data_emiterii) AS ultima
         FROM parteneri p
         LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status <> 'anulata'
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE p.agent_id = ? AND p.tip IN ('client','ambele')
         GROUP BY p.id, p.nume, p.email, p.telefon, p.data_nastere
         ORDER BY vanzari12 DESC`
      )
      .all(acum12Luni, agentId);

    // Pipeline-ul agentului, pe stadii.
    const pipeline = await db
      .prepare(
        `SELECT o.stadiu, COUNT(*) AS nr, COALESCE(SUM(o.valoare_estimata),0) AS valoare
         FROM oportunitati o LEFT JOIN parteneri p ON p.id = o.partener_id
         WHERE o.atribuit_lui = ? OR p.agent_id = ?
         GROUP BY o.stadiu`
      )
      .all(agentId, agentId);
    const pipelineDeschis = pipeline
      .filter((r) => !["castigat", "pierdut"].includes(r.stadiu))
      .reduce((s, r) => s + Number(r.valoare), 0);

    // Calendarul: task-urile pe următoarele 14 zile + cele întârziate.
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const taskuriAgent = await db
      .prepare(
        `${taskuri.SELECT_TASK} WHERE t.atribuit_lui = ? AND t.status IN ('${taskuri.DESCHISE.join("','")}')
         ORDER BY (t.scadenta IS NULL), t.scadenta ASC LIMIT 200`
      )
      .all(agentId);
    const intarziate = taskuriAgent.filter((t) => t.scadenta && t.scadenta < aziStr);
    const peZile = new Map();
    for (const t of taskuriAgent) {
      if (!t.scadenta || t.scadenta < aziStr || t.scadenta > in14) continue;
      if (!peZile.has(t.scadenta)) peZile.set(t.scadenta, []);
      peZile.get(t.scadenta).push(t);
    }
    const faraScadenta = taskuriAgent.filter((t) => !t.scadenta);

    // Zile de naștere: clienții agentului cu ziua în următoarele 30 de zile
    // (comparăm doar luna-ziua, anul nu contează).
    const zileNastere = [];
    for (const c of clienti) {
      if (!c.data_nastere) continue;
      const mz = String(c.data_nastere).slice(5, 10);
      if (!/^\d{2}-\d{2}$/.test(mz)) continue;
      const anCurent = Number(aziStr.slice(0, 4));
      let urmatoarea = `${anCurent}-${mz}`;
      if (urmatoarea < aziStr) urmatoarea = `${anCurent + 1}-${mz}`;
      const inZile = Math.round((Date.parse(urmatoarea) - Date.parse(aziStr)) / 86400000);
      if (inZile <= 30) zileNastere.push({ ...c, urmatoarea, inZile });
    }
    zileNastere.sort((a, b) => a.inZile - b.inZile);

    // Sugestii de clienți potențiali, pe baza portofoliului:
    //  1. clienții LUI care n-au mai cumpărat de peste 90 de zile (reactivare);
    //  2. clienți fără agent dedicat (alocați adminului implicit), ordonați
    //     după valoarea istorică — potriviti de preluat în portofoliu.
    const acum90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const deReactivat = clienti.filter((c) => c.ultima && c.ultima.slice(0, 10) < acum90 && Number(c.vanzari12) > 0).slice(0, 10);
    const admin = await db.prepare("SELECT id FROM utilizatori WHERE rol = 'admin' ORDER BY id LIMIT 1").get();
    const dePreluat =
      admin && admin.id !== agentId
        ? await db
            .prepare(
              `SELECT p.id, p.nume, COALESCE(SUM(l.total),0) AS valoare, MAX(f.data_emiterii) AS ultima
               FROM parteneri p
               JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status <> 'anulata'
               JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
               WHERE (p.agent_id = ? OR p.agent_id IS NULL) AND p.tip IN ('client','ambele')
               GROUP BY p.id, p.nume ORDER BY valoare DESC LIMIT 10`
            )
            .all(admin.id)
        : [];

    // Top produse vândute în portofoliul agentului (doar liniile cu produs
    // identificat — facturile importate din SmartBill n-au detaliu pe produse).
    const topProduse = await db
      .prepare(
        `SELECT pr.id, pr.denumire, SUM(fl.cantitate) AS cantitate, SUM(fl.cantitate * fl.pret_unitar) AS venit
         FROM facturi_linii fl
         JOIN facturi f ON f.id = fl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         JOIN produse pr ON pr.id = fl.produs_id
         WHERE f.directie = 'vanzare' AND f.status <> 'anulata' AND f.data_emiterii >= ? AND p.agent_id = ?
         GROUP BY pr.id, pr.denumire ORDER BY venit DESC LIMIT 8`
      )
      .all(acum12Luni, agentId);

    const vanzari12Total = clienti.reduce((s, c) => s + Number(c.vanzari12), 0);
    const soldTotal = clienti.reduce((s, c) => s + Math.max(0, Number(c.sold)), 0);

    const body = `
      ${subnavCrm("/crm/birou")}
      ${
        esteAdmin && agenti.length
          ? `<form method="get" action="/crm/birou" class="filtre">
              <span style="font-size:13px">Biroul lui:</span>
              <select name="agent" onchange="this.form.submit()">
                ${agenti.map((a) => `<option value="${a.id}"${a.id === agentId ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
              </select>
            </form>`
          : ""
      }
      <div class="cards">
        <div class="card"><div class="label">Clienți în portofoliu</div><div class="value">${clienti.length}</div></div>
        <div class="card"><div class="label">Vânzări portofoliu (12 luni)</div><div class="value">${money(vanzari12Total)}</div></div>
        <div class="card"><div class="label">De încasat din portofoliu</div><div class="value">${money(soldTotal)}</div></div>
        <div class="card"><div class="label">Pipeline deschis</div><div class="value">${money(pipelineDeschis)}</div></div>
        <div class="card"><div class="label">Task-uri întârziate</div><div class="value" style="color:${intarziate.length ? "var(--danger)" : "inherit"}">${intarziate.length}</div></div>
      </div>

      ${
        intarziate.length
          ? `<h2 style="color:var(--danger)">Remindere — task-uri întârziate</h2>${table(taskuri.CAPETE, intarziate.map((t) => taskuri.randTask(t, aziStr)))}`
          : ""
      }

      ${
        zileNastere.length
          ? `<h2>🎂 Zile de naștere (următoarele 30 de zile)</h2>
             ${table(
               ["Client", "Ziua", "Când", "Acțiune"],
               zileNastere.map((c) => [
                 `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                 esc(c.urmatoarea),
                 c.inZile === 0 ? '<span class="badge verde">AZI</span>' : `în ${c.inZile} zile`,
                 c.email
                   ? `<a class="link-btn" href="/crm/email/nou?partener_id=${c.id}&sablon=zi_nastere">Trimite urarea</a>`
                   : '<span style="color:var(--text-muted)">fără email salvat</span>',
               ])
             )}`
          : ""
      }

      <h2>Calendarul următoarelor 14 zile</h2>
      ${
        peZile.size
          ? [...peZile.entries()]
              .map(
                ([zi, lista]) => `
            <div class="zi-bloc">
              <div class="zi-antet"><div class="zi-data">${esc(zi)}${zi === aziStr ? ' <span class="badge galben">azi</span>' : ""}</div><div class="zi-suma">${lista.length} task-uri</div></div>
              ${table(taskuri.CAPETE, lista.map((t) => taskuri.randTask(t, aziStr)))}
            </div>`
              )
              .join("")
          : '<p style="color:var(--text-muted)">Nimic programat în următoarele 14 zile. <a href="/taskuri/nou">Adaugă un task</a>.</p>'
      }
      ${faraScadenta.length ? `<h2>Task-uri fără termen (${faraScadenta.length})</h2>${table(taskuri.CAPETE, faraScadenta.slice(0, 20).map((t) => taskuri.randTask(t, aziStr)))}` : ""}

      ${
        topProduse.length
          ? `<h2>Top produse în portofoliul lui (12 luni)</h2>${table(
              ["Produs", "Cantitate", "Venit net"],
              topProduse.map((tp) => [`<a href="/produse/${tp.id}">${esc(tp.denumire)}</a>`, Number(tp.cantitate).toLocaleString("ro-RO"), money(tp.venit)])
            )}`
          : ""
      }

      <h2>Sugestii — clienți de reactivat (n-au mai cumpărat de peste 90 de zile)</h2>
      ${
        deReactivat.length
          ? table(
              ["Client", "Ultima factură", "Vânzări 12 luni", "Acțiune"],
              deReactivat.map((c) => [
                `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                `<span class="badge galben">${esc((c.ultima || "").slice(0, 10))}</span>`,
                money(c.vanzari12),
                `<a class="link-btn" href="/taskuri/nou?partener_id=${c.id}&tip=apel&titlu=${encodeURIComponent("Reactivare " + c.nume)}&scadenta=${aziStr}">+ Task de contact</a>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Tot portofoliul e activ — nimeni de reactivat.</p>'
      }

      <h2>Sugestii — clienți potențiali de preluat (fără agent dedicat)</h2>
      ${
        dePreluat.length
          ? table(
              ["Client", "Valoare istorică", "Ultima factură"],
              dePreluat.map((c) => [`<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`, money(c.valoare), esc((c.ultima || "").slice(0, 10))])
            ) + '<p style="font-size:12px;color:var(--text-muted)">Alocarea o face administratorul, din pagina fiecărui client.</p>'
          : '<p style="color:var(--text-muted)">Toți clienții au deja un agent dedicat.</p>'
      }

      <h2>Portofoliul complet (${clienti.length} clienți)</h2>
      ${table(
        ["Client", "Vânzări 12 luni", "Sold de încasat", "Ultima factură", "Contact"],
        clienti
          .slice(0, 100)
          .map((c) => [
            `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
            money(c.vanzari12),
            money(Math.max(0, c.sold)),
            esc((c.ultima || "").slice(0, 10)) || "—",
            [c.email && `<a class="link-btn" href="/crm/email/nou?partener_id=${c.id}">email</a>`, c.telefon && esc(c.telefon)].filter(Boolean).join(" · ") || "—",
          ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Biroul lui ${agent.nume}`, active: "/crm", body }));
  });

  // ================= LEAD-URI =========================================
  router.get("/crm/leaduri", async (ctx) => {
    const stadiu = String(ctx.query.stadiu || "");
    const cauta = String(ctx.query.q || "").trim();
    const where = [];
    const args = [];
    if (stadiu) {
      where.push("l.stadiu = ?");
      args.push(stadiu);
    }
    if (cauta) {
      where.push("(l.nume ILIKE ? OR l.companie ILIKE ? OR l.email ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    const clauza = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const leaduri = await db
      .prepare(
        `SELECT l.*, u.nume AS agent_nume FROM leaduri l LEFT JOIN utilizatori u ON u.id = l.atribuit_lui
         ${clauza} ORDER BY l.id DESC LIMIT 300`
      )
      .all(...args);
    const peStadiu = await db.prepare("SELECT stadiu, COUNT(*) AS n FROM leaduri GROUP BY stadiu").all();
    const contor = Object.fromEntries(peStadiu.map((r) => [r.stadiu, r.n]));

    const body = `
      ${subnavCrm("/crm/leaduri")}
      <div class="toolbar"><a href="/crm/leaduri/nou" class="btn">+ Lead nou</a></div>
      <div class="cards">
        ${STADII_LEAD.map(([v, t]) => `<div class="card"><div class="label">${esc(t)}</div><div class="value">${contor[v] || 0}</div></div>`).join("")}
      </div>
      <form class="filtre" method="get" action="/crm/leaduri">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după nume, companie sau email…">
        <select name="stadiu" onchange="this.form.submit()">
          <option value="">Toate stadiile</option>
          ${STADII_LEAD.map(([v, t]) => `<option value="${v}"${stadiu === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <button class="btn small" type="submit">Filtrează</button>
      </form>
      ${
        leaduri.length
          ? table(
              ["Nume", "Companie", "Contact", "Sursă", "Agent", "Stadiu"],
              leaduri.map((l) => [
                `<a href="/crm/leaduri/${l.id}"><strong>${esc(l.nume)}</strong></a>`,
                esc(l.companie || "—"),
                [l.email ? esc(l.email) : "", l.telefon ? esc(l.telefon) : ""].filter(Boolean).join("<br>") || "—",
                esc(l.sursa || "—"),
                esc(l.agent_nume || "neatribuit"),
                badgeLead(l.stadiu),
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun lead încă. <a href="/crm/leaduri/nou">Adaugă primul</a>.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Lead-uri", active: "/crm", body }));
  });

  router.get("/crm/leaduri/nou", async (ctx) => {
    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const body = `
      ${subnavCrm("/crm/leaduri")}
      <form class="form" method="post" action="/crm/leaduri">
        <label class="field">Nume persoană <input name="nume" required placeholder="Ex: Ion Popescu"></label>
        <label class="field">Companie <input name="companie" placeholder="Ex: Alpha Logistics SRL"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Email <input type="email" name="email"></label>
          <label class="field">Telefon <input name="telefon"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Sursă
            <select name="sursa">${SURSE_LEAD.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>
          </label>
          <label class="field">Agent responsabil
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${ctx.user && ctx.user.id === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <label class="field">Observații <textarea name="observatii" rows="3" placeholder="Ce vrea, de unde a venit, ce s-a discutat"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează lead-ul</button> <a class="btn secondary" href="/crm/leaduri">Renunță</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Lead nou", active: "/crm", body }));
  });

  router.post("/crm/leaduri", async (ctx) => {
    const b = ctx.body;
    if (!String(b.nume || "").trim()) return redirect(ctx.res, "/crm/leaduri/nou");
    const info = await db
      .prepare(
        `INSERT INTO leaduri (nume, companie, email, telefon, sursa, stadiu, atribuit_lui, observatii, creat_de, ultima_activitate)
         VALUES (?, ?, ?, ?, ?, 'nou', ?, ?, ?, ?) RETURNING id`
      )
      .run(
        String(b.nume).trim(),
        String(b.companie || "").trim() || null,
        String(b.email || "").trim() || null,
        String(b.telefon || "").trim() || null,
        String(b.sursa || "manual"),
        nr(b.atribuit_lui),
        String(b.observatii || "").trim() || null,
        ctx.user ? ctx.user.id : null,
        azi()
      );
    redirect(ctx.res, `/crm/leaduri/${info.lastInsertRowid}`);
  });

  router.get("/crm/leaduri/:id", async (ctx) => {
    const l = await db
      .prepare("SELECT l.*, u.nume AS agent_nume FROM leaduri l LEFT JOIN utilizatori u ON u.id = l.atribuit_lui WHERE l.id = ?")
      .get(ctx.params.id);
    if (!l) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/crm", body: "<p>Lead inexistent.</p>" }));

    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const taskuriLegate = await db.prepare(`${taskuri.SELECT_TASK} WHERE t.lead_id = ? ORDER BY t.id DESC`).all(l.id);
    const emailuri = await db
      .prepare("SELECT e.*, u.nume AS expeditor FROM emailuri e LEFT JOIN utilizatori u ON u.id = e.utilizator_id WHERE e.lead_id = ? ORDER BY e.id DESC")
      .all(l.id);
    const activitate = await db
      .prepare("SELECT i.*, u.nume AS autor FROM interactiuni i LEFT JOIN utilizatori u ON u.id = i.utilizator_id WHERE i.lead_id = ? ORDER BY i.id DESC")
      .all(l.id);

    const body = `
      ${subnavCrm("/crm/leaduri")}
      <div class="detail-box">
        <h1 style="margin-top:0">${esc(l.nume)} ${badgeLead(l.stadiu)}</h1>
        <div class="detail-grid">
          <div><div class="k">Companie</div>${esc(l.companie || "—")}</div>
          <div><div class="k">Email</div>${l.email ? `<a href="/crm/email/nou?lead_id=${l.id}">${esc(l.email)}</a>` : "—"}</div>
          <div><div class="k">Telefon</div>${esc(l.telefon || "—")}</div>
          <div><div class="k">Sursă</div>${esc(l.sursa || "—")}</div>
          <div><div class="k">Agent</div>${esc(l.agent_nume || "neatribuit")}</div>
          <div><div class="k">Creat la</div>${esc((l.creat_la || "").slice(0, 10))}</div>
          ${l.partener_id ? `<div><div class="k">Client creat</div><a href="/parteneri/${l.partener_id}">vezi partenerul →</a></div>` : ""}
        </div>
        ${l.observatii ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(l.observatii)}</p>` : ""}
      </div>

      <div class="toolbar">
        <a class="btn secondary" href="/taskuri/nou?lead_id=${l.id}&titlu=${encodeURIComponent("Contactează " + l.nume)}">+ Task</a>
        ${l.email ? `<a class="btn secondary" href="/crm/email/nou?lead_id=${l.id}">✉ Trimite email</a>` : ""}
        ${l.stadiu !== "convertit" ? `<a class="btn" href="/crm/leaduri/${l.id}/converteste">→ Convertește în client</a>` : ""}
      </div>

      <form class="form" method="post" action="/crm/leaduri/${l.id}/actualizeaza">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Stadiu
            <select name="stadiu">${STADII_LEAD.filter(([v]) => v !== "convertit" || l.stadiu === "convertit")
              .map(([v, t]) => `<option value="${v}"${l.stadiu === v ? " selected" : ""}>${esc(t)}</option>`)
              .join("")}</select>
          </label>
          <label class="field">Agent responsabil
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${l.atribuit_lui === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="form-actions"><button class="btn small" type="submit">Salvează</button></div>
      </form>

      <h2>Adaugă o interacțiune</h2>
      <form class="form" method="post" action="/crm/leaduri/${l.id}/interactiune">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Tip<select name="tip">${TIPURI_INTERACTIUNE.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}</select></label>
          <label class="field">Următorul contact<input type="date" name="data_urmatoare_actiune"></label>
        </div>
        <label class="field">Subiect<input name="subiect" placeholder="Ex: Apel de calificare"></label>
        <label class="field">Ce s-a discutat<textarea name="descriere" rows="3"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează interacțiunea</button></div>
      </form>

      <h2>Istoric</h2>
      ${
        activitate.length
          ? activitate
              .map(
                (i) => `<div class="detail-box" style="padding:12px">
                  <div style="font-size:12px;color:var(--text-muted)">${esc(i.tip)} · ${esc((i.data || "").slice(0, 16))} · ${esc(i.autor || "—")}</div>
                  <div style="font-weight:600;margin-top:2px">${esc(i.subiect || "")}</div>
                  <div style="white-space:pre-wrap">${esc(i.descriere || "")}</div>
                </div>`
              )
              .join("")
          : '<p style="color:var(--text-muted)">Nicio interacțiune încă.</p>'
      }

      <h2>Task-uri</h2>
      ${taskuriLegate.length ? table(taskuri.CAPETE, taskuriLegate.map((t) => taskuri.randTask(t, azi()))) : '<p style="color:var(--text-muted)">Niciun task.</p>'}

      <h2>Emailuri</h2>
      ${
        emailuri.length
          ? table(
              ["Data", "Subiect", "Expeditor", "Status"],
              emailuri.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                esc(e.expeditor || "—"),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Lead: ${l.nume}`, active: "/crm", body }));
  });

  router.post("/crm/leaduri/:id/actualizeaza", async (ctx) => {
    await db
      .prepare("UPDATE leaduri SET stadiu = ?, atribuit_lui = ?, ultima_activitate = ? WHERE id = ?")
      .run(String(ctx.body.stadiu || "nou"), nr(ctx.body.atribuit_lui), azi(), ctx.params.id);
    redirect(ctx.res, `/crm/leaduri/${ctx.params.id}`);
  });

  router.post("/crm/leaduri/:id/interactiune", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, lead_id, utilizator_id, tip, subiect, descriere, data_urmatoare_actiune) VALUES (NULL, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        ctx.user ? ctx.user.id : null,
        String(ctx.body.tip || "nota"),
        String(ctx.body.subiect || "").trim() || null,
        String(ctx.body.descriere || "").trim() || null,
        String(ctx.body.data_urmatoare_actiune || "") || null
      );
    await db.prepare("UPDATE leaduri SET ultima_activitate = ?, stadiu = CASE WHEN stadiu = 'nou' THEN 'contactat' ELSE stadiu END WHERE id = ?").run(azi(), id);
    redirect(ctx.res, `/crm/leaduri/${id}`);
  });

  // Conversia lead → partener: creează clientul, leagă lead-ul de el și, dacă
  // se cere, deschide direct o oportunitate în pipeline.
  router.get("/crm/leaduri/:id/converteste", async (ctx) => {
    const l = await db.prepare("SELECT * FROM leaduri WHERE id = ?").get(ctx.params.id);
    if (!l) return redirect(ctx.res, "/crm/leaduri");
    const body = `
      ${subnavCrm("/crm/leaduri")}
      <form class="form" method="post" action="/crm/leaduri/${l.id}/converteste">
        <p>Lead-ul <strong>${esc(l.nume)}</strong>${l.companie ? ` (${esc(l.companie)})` : ""} devine partener în ERP.</p>
        <label class="field">Denumirea clientului<input name="nume_partener" required value="${esc(l.companie || l.nume)}"></label>
        <label class="field">CUI<input name="cui" placeholder="RO12345678"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Email<input name="email" value="${esc(l.email || "")}"></label>
          <label class="field">Telefon<input name="telefon" value="${esc(l.telefon || "")}"></label>
        </div>
        <label class="field">Adresă<input name="adresa"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="creeaza_oportunitate" value="1" checked> Creează și o oportunitate în pipeline
        </label>
        <label class="field">Titlul oportunității<input name="titlu_oportunitate" value="${esc("Oportunitate " + (l.companie || l.nume))}"></label>
        <label class="field">Valoare estimată (lei)<input type="number" step="0.01" name="valoare_estimata"></label>
        <div class="form-actions"><button class="btn" type="submit">Convertește</button> <a class="btn secondary" href="/crm/leaduri/${l.id}">Renunță</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Convertește lead-ul", active: "/crm", body }));
  });

  router.post("/crm/leaduri/:id/converteste", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const l = await db.prepare("SELECT * FROM leaduri WHERE id = ?").get(id);
    if (!l) return redirect(ctx.res, "/crm/leaduri");
    const b = ctx.body;
    const nume = String(b.nume_partener || l.companie || l.nume).trim();
    const cui = String(b.cui || "").trim();

    // Dacă firma există deja (după CUI sau nume), o refolosim în loc să creăm
    // un dublet în lista de parteneri.
    let existent = null;
    if (cui) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(cui) = LOWER(?) AND cui <> ''").get(cui);
    if (!existent) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(nume) = LOWER(?)").get(nume);

    let partenerId;
    if (existent) partenerId = existent.id;
    else {
      const ins = await db
        .prepare("INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa, sursa, stare) VALUES ('client', ?, ?, ?, ?, ?, ?, 'client_activ') RETURNING id")
        .run(nume, cui || null, String(b.email || "").trim() || null, String(b.telefon || "").trim() || null, String(b.adresa || "").trim() || null, `lead: ${l.sursa || "manual"}`);
      partenerId = ins.lastInsertRowid;
    }

    await db.prepare("UPDATE leaduri SET stadiu = 'convertit', partener_id = ?, ultima_activitate = ? WHERE id = ?").run(partenerId, azi(), id);
    // Mutăm și task-urile lead-ului pe partenerul nou, ca să nu se piardă.
    await db.prepare("UPDATE taskuri SET partener_id = ? WHERE lead_id = ?").run(partenerId, id);

    if (b.creeaza_oportunitate) {
      await db
        .prepare("INSERT INTO oportunitati (partener_id, titlu, valoare_estimata, stadiu, observatii, atribuit_lui) VALUES (?, ?, ?, 'calificat', ?, ?)")
        .run(partenerId, String(b.titlu_oportunitate || `Oportunitate ${nume}`), Number(b.valoare_estimata || 0), `Convertit din lead #${id}`, l.atribuit_lui || null);
    }
    redirect(ctx.res, `/parteneri/${partenerId}`);
  });

  // ================= ACTIVITATE =======================================
  router.get("/crm/activitate", async (ctx) => {
    const emailuri = await db
      .prepare(
        `SELECT e.*, u.nume AS expeditor, p.nume AS partener_nume, l.nume AS lead_nume
         FROM emailuri e
         LEFT JOIN utilizatori u ON u.id = e.utilizator_id
         LEFT JOIN parteneri p ON p.id = e.partener_id
         LEFT JOIN leaduri l ON l.id = e.lead_id
         ORDER BY e.id DESC LIMIT 100`
      )
      .all();
    const interactiuni = await db
      .prepare(
        `SELECT i.*, p.nume AS partener_nume, l.nume AS lead_nume, u.nume AS autor
         FROM interactiuni i
         LEFT JOIN parteneri p ON p.id = i.partener_id
         LEFT JOIN leaduri l ON l.id = i.lead_id
         LEFT JOIN utilizatori u ON u.id = i.utilizator_id
         ORDER BY i.id DESC LIMIT 100`
      )
      .all();

    const body = `
      ${subnavCrm("/crm/activitate")}
      <div class="toolbar">
        <a class="btn" href="/crm/email/nou">✉ Email nou</a>
        <a class="btn secondary" href="/profil/email">Configurează contul meu de email</a>
      </div>

      <h2>Ultimele emailuri trimise din aplicație</h2>
      ${
        emailuri.length
          ? table(
              ["Data", "Către", "Subiect", "Context", "Expeditor", "Status"],
              emailuri.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                esc(e.catre),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                e.partener_id ? `<a href="/parteneri/${e.partener_id}">${esc(e.partener_nume || "")}</a>` : e.lead_id ? `<a href="/crm/leaduri/${e.lead_id}">${esc(e.lead_nume || "")}</a>` : "—",
                esc(e.expeditor || "—"),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email trimis încă. Configurează-ți contul din <a href="/profil/email">Profilul meu → Email</a> și trimite primul.</p>'
      }

      <h2>Ultimele interacțiuni</h2>
      ${
        interactiuni.length
          ? table(
              ["Data", "Tip", "Cu cine", "Subiect", "Înregistrat de"],
              interactiuni.map((i) => [
                esc((i.data || "").slice(0, 16)),
                esc(i.tip),
                i.partener_id ? `<a href="/parteneri/${i.partener_id}">${esc(i.partener_nume || "")}</a>` : i.lead_id ? `<a href="/crm/leaduri/${i.lead_id}">${esc(i.lead_nume || "")}</a>` : "—",
                esc(i.subiect || "—"),
                esc(i.autor || "—"),
              ])
            )
          : '<p style="color:var(--text-muted)">Nicio interacțiune înregistrată.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Activitate CRM", active: "/crm", body }));
  });
}

module.exports = { register, STADII, STADIU_LABEL, STADII_LEAD, subnavCrm };
