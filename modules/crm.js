"use strict";
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const STADII = [
  { key: "lead", label: "Lead" },
  { key: "calificat", label: "Calificat" },
  { key: "oferta", label: "Ofertă trimisă" },
  { key: "negociere", label: "Negociere" },
  { key: "castigat", label: "Câștigat" },
  { key: "pierdut", label: "Pierdut" },
];
const STADIU_LABEL = Object.fromEntries(STADII.map((s) => [s.key, s.label]));

function register(router) {
  router.get("/crm", async (ctx) => {
    const oportunitati = await db
      .prepare(`SELECT o.*, p.nume AS partener_nume FROM oportunitati o JOIN parteneri p ON p.id = o.partener_id ORDER BY o.id DESC`)
      .all();

    const azi = new Date().toISOString().slice(0, 10);
    const deContactat = await db
      .prepare(
        `SELECT i.*, p.nume AS partener_nume, p.id AS partener_id
         FROM interactiuni i JOIN parteneri p ON p.id = i.partener_id
         WHERE i.data_urmatoare_actiune IS NOT NULL AND i.data_urmatoare_actiune != '' AND i.data_urmatoare_actiune <= ?
         ORDER BY i.data_urmatoare_actiune ASC`
      )
      .all(azi);

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
          </a>`
            )
            .join("") || `<div class="crm-col-empty">—</div>`
        }
      </div>`;
    }).join("");

    const body = `
      <div class="toolbar"><a href="/crm/oportunitati/noua" class="btn">+ Oportunitate nouă</a></div>
      <div class="crm-board">${coloane}</div>

      <h2>De contactat (scadent sau azi)</h2>
      ${
        deContactat.length
          ? table(
              ["Partener", "Subiect", "Data programată"],
              deContactat.map((i) => [
                `<a href="/parteneri/${i.partener_id}">${esc(i.partener_nume)}</a>`,
                esc(i.subiect) || "—",
                `${esc(i.data_urmatoare_actiune)}${i.data_urmatoare_actiune < azi ? ' <span class="badge rosu">întârziat</span>' : ""}`,
              ])
            )
          : "<p>Nimic programat pentru azi.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "CRM — pipeline vânzări", active: "/crm", body }));
  });

  router.get("/crm/oportunitati/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume").all();
    const presetPartener = ctx.query.partener_id || "";
    if (parteneri.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user, title: "Oportunitate nouă", active: "/crm", body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">partener</a>.</p>` })
      );
    }
    const body = `<form method="post" action="/crm/oportunitati" class="form" style="max-width:520px">
      <label class="field"><span>Partener</span>
        <select name="partener_id" required>${parteneri
          .map((p) => `<option value="${p.id}" ${String(p.id) === String(presetPartener) ? "selected" : ""}>${esc(p.nume)}</option>`)
          .join("")}</select>
      </label>
      <label class="field"><span>Titlu oportunitate</span><input type="text" name="titlu" required></label>
      <label class="field"><span>Valoare estimată (lei)</span><input type="number" step="0.01" name="valoare_estimata"></label>
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
    const { partener_id, titlu, valoare_estimata, stadiu, data_estimata_inchidere, observatii } = ctx.body;
    const info = await db
      .prepare(
        "INSERT INTO oportunitati (partener_id, titlu, valoare_estimata, stadiu, data_estimata_inchidere, observatii) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
      )
      .run(partener_id, titlu, Number(valoare_estimata || 0), stadiu || "lead", data_estimata_inchidere || null, observatii || "");
    redirect(ctx.res, `/crm/oportunitati/${info.lastInsertRowid}`);
  });

  router.get("/crm/oportunitati/:id", async (ctx) => {
    const o = await db
      .prepare(`SELECT o.*, p.nume AS partener_nume FROM oportunitati o JOIN parteneri p ON p.id = o.partener_id WHERE o.id = ?`)
      .get(ctx.params.id);
    if (!o) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/crm", body: "<p>Oportunitate inexistentă.</p>" }));

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Partener</div><a href="/parteneri/${o.partener_id}">${esc(o.partener_nume)}</a></div>
          <div><div class="k">Valoare estimată</div>${money(o.valoare_estimata)}</div>
          <div><div class="k">Dată estimată închidere</div>${esc(o.data_estimata_inchidere) || "—"}</div>
          <div><div class="k">Observații</div>${esc(o.observatii) || "—"}</div>
        </div>
      </div>
      <form method="post" action="/crm/oportunitati/${o.id}/stadiu" class="form" style="max-width:320px">
        <label class="field"><span>Stadiu</span>
          <select name="stadiu">${STADII.map((s) => `<option value="${s.key}" ${s.key === o.stadiu ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
        </label>
        <button type="submit" class="btn small">Actualizează stadiul</button>
      </form>
      <div class="toolbar" style="margin-top:14px">
        <form method="post" action="/crm/oportunitati/${o.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv oportunitatea?')">
          <button type="submit" class="link-btn danger">Șterge</button>
        </form>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Oportunitate: ${o.titlu}`, active: "/crm", body }));
  });

  router.post("/crm/oportunitati/:id/stadiu", async (ctx) => {
    await db.prepare("UPDATE oportunitati SET stadiu = ? WHERE id = ?").run(ctx.body.stadiu, ctx.params.id);
    redirect(ctx.res, `/crm/oportunitati/${ctx.params.id}`);
  });

  router.post("/crm/oportunitati/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM oportunitati WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/crm");
  });
}

module.exports = { register, STADII, STADIU_LABEL };
