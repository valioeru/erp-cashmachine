"use strict";
// Task-uri — sarcini care se pot atribui oricărui utilizator din ERP și se pot
// lega de orice entitate (partener, lead, oportunitate, comandă, factură).
// Sunt „liantul” dintre module: un task de pe o factură restantă e de fapt o
// acțiune de încasare, unul de pe un lead e un follow-up de vânzare.
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const TIPURI = [
  ["general", "Task general"],
  ["apel", "Apel telefonic"],
  ["email", "Email"],
  ["intalnire", "Întâlnire"],
  ["oferta", "Pregătire ofertă"],
  ["livrare", "Livrare / logistică"],
  ["incasare", "Încasare / urmărire plată"],
  ["depozit", "Operațiune de depozit"],
];

const PRIORITATI = [
  ["joasa", "Joasă", "gri"],
  ["normala", "Normală", "gri"],
  ["ridicata", "Ridicată", "galben"],
  ["urgenta", "Urgentă", "rosu"],
];

const STATUSURI = [
  ["deschis", "Deschis", "gri"],
  ["in_lucru", "În lucru", "galben"],
  ["blocat", "Blocat", "rosu"],
  ["finalizat", "Finalizat", "verde"],
  ["anulat", "Anulat", "gri"],
];

const DESCHISE = ["deschis", "in_lucru", "blocat"];

function eticheta(lista, valoare) {
  const g = lista.find((x) => x[0] === valoare);
  return g ? g[1] : valoare;
}
function badge(lista, valoare) {
  const g = lista.find((x) => x[0] === valoare);
  return g ? `<span class="badge ${g[2]}">${esc(g[1])}</span>` : esc(valoare);
}
function optiuni(lista, selectat) {
  return lista.map(([v, t]) => `<option value="${v}"${v === selectat ? " selected" : ""}>${esc(t)}</option>`).join("");
}
function azi() {
  return new Date().toISOString().slice(0, 10);
}

async function utilizatoriActivi() {
  return await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
}

// Interogarea de bază: task + numele persoanei atribuite + contextul la care e
// legat, într-un singur SELECT (fără N+1).
const SELECT_TASK = `
  SELECT t.*,
         ua.nume AS atribuit_nume,
         uc.nume AS creator_nume,
         p.nume AS partener_nume,
         le.nume AS lead_nume,
         o.titlu AS oportunitate_titlu,
         f.serie AS factura_serie, f.numar AS factura_numar, f.document_extern AS factura_document
  FROM taskuri t
  LEFT JOIN utilizatori ua ON ua.id = t.atribuit_lui
  LEFT JOIN utilizatori uc ON uc.id = t.creat_de
  LEFT JOIN parteneri p ON p.id = t.partener_id
  LEFT JOIN leaduri le ON le.id = t.lead_id
  LEFT JOIN oportunitati o ON o.id = t.oportunitate_id
  LEFT JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = t.factura_id
`;

function contextLink(t) {
  if (t.partener_id) return `<a href="/parteneri/${t.partener_id}">${esc(t.partener_nume || "partener")}</a>`;
  if (t.lead_id) return `<a href="/crm/leaduri/${t.lead_id}">${esc(t.lead_nume || "lead")}</a>`;
  if (t.oportunitate_id) return `<a href="/crm">${esc(t.oportunitate_titlu || "oportunitate")}</a>`;
  if (t.factura_id) return `<a href="/facturi/${t.factura_id}">${esc(t.factura_document || `${t.factura_serie}-${t.factura_numar}`)}</a>`;
  if (t.comanda_id) return `<a href="/comenzi/${t.comanda_id}">comanda #${t.comanda_id}</a>`;
  return "—";
}

function randTask(t, aziStr) {
  const intarziat = t.scadenta && t.scadenta < aziStr && DESCHISE.includes(t.status);
  return [
    `<a href="/taskuri/${t.id}"><strong>${esc(t.titlu)}</strong></a><div style="font-size:12px;color:var(--text-muted)">${esc(eticheta(TIPURI, t.tip))}</div>`,
    esc(t.atribuit_nume || "neatribuit"),
    contextLink(t),
    t.scadenta ? (intarziat ? `<span class="badge rosu">${esc(t.scadenta)}</span>` : esc(t.scadenta)) : "—",
    badge(PRIORITATI, t.prioritate),
    badge(STATUSURI, t.status),
  ];
}

const CAPETE = ["Task", "Atribuit lui", "Legat de", "Scadență", "Prioritate", "Status"];

function register(router) {
  // ---- Listă / board ---------------------------------------------------
  router.get("/taskuri", async (ctx) => {
    const aziStr = azi();
    const useri = await utilizatoriActivi();
    const filtruUser = ctx.query.user === "toti" ? "toti" : ctx.query.user ? String(ctx.query.user) : ctx.user ? String(ctx.user.id) : "toti";
    const filtruStatus = String(ctx.query.status || "deschise");

    const where = [];
    const args = [];
    if (filtruUser !== "toti") {
      where.push("t.atribuit_lui = ?");
      args.push(parseInt(filtruUser, 10));
    }
    if (filtruStatus === "deschise") where.push(`t.status IN ('${DESCHISE.join("','")}')`);
    else if (filtruStatus !== "toate") {
      where.push("t.status = ?");
      args.push(filtruStatus);
    }
    const clauza = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const taskuri = await db
      .prepare(`${SELECT_TASK} ${clauza} ORDER BY (t.scadenta IS NULL), t.scadenta ASC, t.id DESC LIMIT 300`)
      .all(...args);

    const intarziate = taskuri.filter((t) => t.scadenta && t.scadenta < aziStr && DESCHISE.includes(t.status));
    const aziTaskuri = taskuri.filter((t) => t.scadenta === aziStr && DESCHISE.includes(t.status));

    const contorPerUser = await db
      .prepare(
        `SELECT u.id, u.nume, COUNT(t.id) AS nr
         FROM utilizatori u LEFT JOIN taskuri t ON t.atribuit_lui = u.id AND t.status IN ('${DESCHISE.join("','")}')
         WHERE u.activ = 1 GROUP BY u.id, u.nume ORDER BY u.nume`
      )
      .all();

    const body = `
      <div class="toolbar">
        <a href="/taskuri/nou" class="btn">+ Task nou</a>
        <a href="/crm" class="btn secondary">CRM</a>
      </div>

      <div class="cards">
        <div class="card"><div class="label">Task-uri deschise (filtrul curent)</div><div class="value">${taskuri.filter((t) => DESCHISE.includes(t.status)).length}</div></div>
        <div class="card"><div class="label">Cu scadența depășită</div><div class="value" style="color:${intarziate.length ? "var(--danger)" : "inherit"}">${intarziate.length}</div></div>
        <div class="card"><div class="label">Scadente azi</div><div class="value">${aziTaskuri.length}</div></div>
      </div>

      <form class="filtre" method="get" action="/taskuri">
        <select name="user" onchange="this.form.submit()">
          <option value="toti"${filtruUser === "toti" ? " selected" : ""}>Toți utilizatorii</option>
          ${useri
            .map((u) => `<option value="${u.id}"${filtruUser === String(u.id) ? " selected" : ""}>${esc(u.nume)}${ctx.user && ctx.user.id === u.id ? " (eu)" : ""}</option>`)
            .join("")}
        </select>
        <select name="status" onchange="this.form.submit()">
          <option value="deschise"${filtruStatus === "deschise" ? " selected" : ""}>Doar deschise</option>
          <option value="toate"${filtruStatus === "toate" ? " selected" : ""}>Toate</option>
          ${STATUSURI.map(([v, t]) => `<option value="${v}"${filtruStatus === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
      </form>

      ${
        intarziate.length
          ? `<h2 style="color:var(--danger)">Depășite (${intarziate.length})</h2>${table(CAPETE, intarziate.map((t) => randTask(t, aziStr)))}`
          : ""
      }

      <h2>Încărcarea echipei (task-uri deschise)</h2>
      ${table(
        ["Utilizator", "Task-uri deschise"],
        contorPerUser.map((u) => [`<a href="/taskuri?user=${u.id}">${esc(u.nume)}</a>`, u.nr])
      )}

      <h2>Toate task-urile din filtru ${taskuri.length >= 300 ? "(primele 300)" : ""}</h2>
      ${table(CAPETE, taskuri.map((t) => randTask(t, aziStr)))}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Task-uri", active: "/taskuri", body }));
  });

  // ---- Formular de creare ----------------------------------------------
  router.get("/taskuri/nou", async (ctx) => {
    const useri = await utilizatoriActivi();
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 2000").all();
    const leaduri = await db.prepare("SELECT id, nume, companie FROM leaduri WHERE stadiu <> 'convertit' ORDER BY id DESC LIMIT 500").all();
    const oportunitati = await db.prepare("SELECT id, titlu FROM oportunitati WHERE stadiu NOT IN ('castigat','pierdut') ORDER BY id DESC LIMIT 500").all();

    const body = `
      <form class="form" method="post" action="/taskuri">
        <input type="hidden" name="redirect" value="${esc(String(ctx.query.redirect || "/taskuri"))}">
        <label class="field">Titlu
          <input name="titlu" required placeholder="Ex: Sună clientul pentru confirmarea comenzii" value="${esc(String(ctx.query.titlu || ""))}">
        </label>
        <label class="field">Descriere
          <textarea name="descriere" rows="4" placeholder="Detalii, context, ce trebuie făcut concret"></textarea>
        </label>
        <label class="field">Atribuit lui
          <select name="atribuit_lui">
            <option value="">— neatribuit —</option>
            ${useri.map((u) => `<option value="${u.id}"${ctx.user && ctx.user.id === u.id ? " selected" : ""}>${esc(u.nume)} (${esc(u.rol)})</option>`).join("")}
          </select>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Tip<select name="tip">${optiuni(TIPURI, String(ctx.query.tip || "general"))}</select></label>
          <label class="field">Prioritate<select name="prioritate">${optiuni(PRIORITATI, "normala")}</select></label>
        </div>
        <label class="field">Scadență
          <input type="date" name="scadenta" value="${esc(String(ctx.query.scadenta || ""))}">
        </label>
        <label class="field">Legat de partener
          <select name="partener_id">
            <option value="">— niciunul —</option>
            ${parteneri.map((p) => `<option value="${p.id}"${String(ctx.query.partener_id) === String(p.id) ? " selected" : ""}>${esc(p.nume)}</option>`).join("")}
          </select>
        </label>
        <label class="field">Legat de lead
          <select name="lead_id">
            <option value="">— niciunul —</option>
            ${leaduri.map((l) => `<option value="${l.id}"${String(ctx.query.lead_id) === String(l.id) ? " selected" : ""}>${esc(l.nume)}${l.companie ? " · " + esc(l.companie) : ""}</option>`).join("")}
          </select>
        </label>
        <label class="field">Legat de oportunitate
          <select name="oportunitate_id">
            <option value="">— niciuna —</option>
            ${oportunitati.map((o) => `<option value="${o.id}"${String(ctx.query.oportunitate_id) === String(o.id) ? " selected" : ""}>${esc(o.titlu)}</option>`).join("")}
          </select>
        </label>
        <input type="hidden" name="factura_id" value="${esc(String(ctx.query.factura_id || ""))}">
        <input type="hidden" name="comanda_id" value="${esc(String(ctx.query.comanda_id || ""))}">
        <div class="form-actions">
          <button class="btn" type="submit">Creează task</button>
          <a class="btn secondary" href="/taskuri">Renunță</a>
        </div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Task nou", active: "/taskuri", body }));
  });

  router.post("/taskuri", async (ctx) => {
    const b = ctx.body;
    const nr = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    if (!String(b.titlu || "").trim()) return redirect(ctx.res, "/taskuri/nou");
    await db
      .prepare(
        `INSERT INTO taskuri (titlu, descriere, tip, prioritate, status, scadenta, atribuit_lui, creat_de, partener_id, lead_id, oportunitate_id, comanda_id, factura_id)
         VALUES (?, ?, ?, ?, 'deschis', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(b.titlu).trim(),
        String(b.descriere || "").trim() || null,
        String(b.tip || "general"),
        String(b.prioritate || "normala"),
        String(b.scadenta || "") || null,
        nr(b.atribuit_lui),
        ctx.user ? ctx.user.id : null,
        nr(b.partener_id),
        nr(b.lead_id),
        nr(b.oportunitate_id),
        nr(b.comanda_id),
        nr(b.factura_id)
      );
    redirect(ctx.res, String(b.redirect || "/taskuri"));
  });

  // ---- Detaliu ----------------------------------------------------------
  router.get("/taskuri/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const t = await db.prepare(`${SELECT_TASK} WHERE t.id = ?`).get(id);
    if (!t) return send(ctx.res, 404, layout({ user: ctx.user, title: "Task inexistent", active: "/taskuri", body: "<p>Task-ul nu există.</p>" }));

    const useri = await utilizatoriActivi();
    const comentarii = await db
      .prepare("SELECT c.*, u.nume AS autor FROM taskuri_comentarii c LEFT JOIN utilizatori u ON u.id = c.utilizator_id WHERE c.task_id = ? ORDER BY c.id ASC")
      .all(id);

    const body = `
      <div class="detail-box">
        <h1 style="margin-top:0">${esc(t.titlu)}</h1>
        <div class="detail-grid">
          <div><div class="k">Status</div>${badge(STATUSURI, t.status)}</div>
          <div><div class="k">Prioritate</div>${badge(PRIORITATI, t.prioritate)}</div>
          <div><div class="k">Tip</div>${esc(eticheta(TIPURI, t.tip))}</div>
          <div><div class="k">Atribuit lui</div>${esc(t.atribuit_nume || "neatribuit")}</div>
          <div><div class="k">Scadență</div>${esc(t.scadenta || "—")}</div>
          <div><div class="k">Legat de</div>${contextLink(t)}</div>
          <div><div class="k">Creat de</div>${esc(t.creator_nume || "—")}</div>
          <div><div class="k">Creat la</div>${esc((t.creat_la || "").slice(0, 16))}</div>
        </div>
        ${t.descriere ? `<p style="margin-top:14px;white-space:pre-wrap">${esc(t.descriere)}</p>` : ""}
      </div>

      <form class="form" method="post" action="/taskuri/${t.id}/actualizeaza">
        <h2 style="margin-top:0">Actualizează</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Status<select name="status">${optiuni(STATUSURI, t.status)}</select></label>
          <label class="field">Prioritate<select name="prioritate">${optiuni(PRIORITATI, t.prioritate)}</select></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Atribuit lui
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${t.atribuit_lui === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
          <label class="field">Scadență<input type="date" name="scadenta" value="${esc(t.scadenta || "")}"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button> <a class="btn secondary" href="/taskuri">Înapoi la listă</a></div>
      </form>

      <h2>Comentarii</h2>
      ${
        comentarii.length
          ? comentarii
              .map(
                (c) => `<div class="detail-box" style="padding:12px">
                  <div style="font-size:12px;color:var(--text-muted)">${esc(c.autor || "—")} · ${esc((c.creat_la || "").slice(0, 16))}</div>
                  <div style="white-space:pre-wrap;margin-top:4px">${esc(c.text)}</div>
                </div>`
              )
              .join("")
          : "<p style=\"color:var(--text-muted)\">Niciun comentariu încă.</p>"
      }
      <form class="form" method="post" action="/taskuri/${t.id}/comentariu">
        <label class="field">Adaugă un comentariu<textarea name="text" rows="3" required placeholder="Ce s-a întâmplat, ce urmează"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Adaugă</button></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Task", active: "/taskuri", body }));
  });

  router.post("/taskuri/:id/actualizeaza", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const status = String(ctx.body.status || "deschis");
    const finalizat = status === "finalizat" || status === "anulat" ? azi() : null;
    const atribuit = parseInt(ctx.body.atribuit_lui, 10);
    await db
      .prepare("UPDATE taskuri SET status = ?, prioritate = ?, atribuit_lui = ?, scadenta = ?, finalizat_la = ? WHERE id = ?")
      .run(status, String(ctx.body.prioritate || "normala"), Number.isFinite(atribuit) && atribuit > 0 ? atribuit : null, String(ctx.body.scadenta || "") || null, finalizat, id);
    redirect(ctx.res, `/taskuri/${id}`);
  });

  router.post("/taskuri/:id/comentariu", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const text = String(ctx.body.text || "").trim();
    if (text) {
      await db.prepare("INSERT INTO taskuri_comentarii (task_id, utilizator_id, text) VALUES (?, ?, ?)").run(id, ctx.user ? ctx.user.id : null, text);
    }
    redirect(ctx.res, `/taskuri/${id}`);
  });

  // Schimbare rapidă de status din alte pagini (CRM, listă).
  router.post("/taskuri/:id/status", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const status = String(ctx.body.status || "");
    if (STATUSURI.some((s) => s[0] === status)) {
      const finalizat = status === "finalizat" || status === "anulat" ? azi() : null;
      await db.prepare("UPDATE taskuri SET status = ?, finalizat_la = ? WHERE id = ?").run(status, finalizat, id);
    }
    redirect(ctx.res, String(ctx.body.redirect || "/taskuri"));
  });
}

module.exports = { register, TIPURI, PRIORITATI, STATUSURI, DESCHISE, SELECT_TASK, randTask, CAPETE, badge, optiuni };
