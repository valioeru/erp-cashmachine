"use strict";
const db = require("../lib/db");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function register(router) {
  registerCrud(router, {
    path: "/produse",
    table: "produse",
    title: "Produse",
    singular: "produs",
    fields: [
      { name: "cod", label: "Cod produs" },
      { name: "denumire", label: "Denumire", required: true },
      { name: "unitate_masura", label: "Unitate de măsură", default: "buc" },
      { name: "pret_vanzare", label: "Preț vânzare (fără TVA)", type: "number", step: "0.01", default: 0 },
      { name: "pret_achizitie", label: "Preț achiziție", type: "number", step: "0.01", default: 0 },
      { name: "cota_tva", label: "Cotă TVA (%)", type: "number", step: "0.01", default: 19 },
      { name: "stoc_minim", label: "Stoc minim (alertă)", type: "number", step: "0.01", default: 0 },
    ],
    listColumns: [
      { key: "cod", label: "Cod" },
      { key: "denumire", label: "Denumire", render: (r) => `<a href="/produse/${r.id}">${esc(r.denumire)}</a>` },
      { key: "unitate_masura", label: "UM" },
      { key: "pret_vanzare", label: "Preț vânzare", render: (r) => money(r.pret_vanzare) },
      { key: "cota_tva", label: "TVA", render: (r) => `${esc(r.cota_tva)}%` },
    ],
  });

  // Pagină de detaliu produs: stoc pe depozite + rețetă de fabricație (BOM) —
  // din ce alte produse (componente) e format acest produs, util pentru
  // producție. Înregistrată după registerCrud, ca să nu intre în conflict cu
  // rutele literale /produse/nou, /produse/:id/editare etc.
  router.get("/produse/:id", async (ctx) => {
    const produs = await db.prepare("SELECT * FROM produse WHERE id = ?").get(ctx.params.id);
    if (!produs) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/produse", body: "<p>Produs inexistent.</p>" }));

    const stocPeDepozite = await db
      .prepare(
        `SELECT d.denumire AS depozit,
                COALESCE(SUM(CASE WHEN m.tip='intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS stoc
         FROM miscari_stoc m JOIN depozite d ON d.id = m.depozit_id
         WHERE m.produs_id = ? GROUP BY d.id, d.denumire ORDER BY d.denumire`
      )
      .all(produs.id);
    const stocTotal = stocPeDepozite.reduce((s, r) => s + Number(r.stoc || 0), 0);

    const componente = await db
      .prepare(
        `SELECT rc.id, rc.cantitate, c.id AS componenta_id, c.denumire, c.unitate_masura
         FROM retete_componente rc JOIN produse c ON c.id = rc.componenta_id
         WHERE rc.produs_id = ? ORDER BY c.denumire`
      )
      .all(produs.id);

    const toateProdusele = await db.prepare("SELECT id, denumire FROM produse WHERE id != ? ORDER BY denumire").all(produs.id);

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Cod</div>${esc(produs.cod) || "—"}</div>
          <div><div class="k">Preț vânzare</div>${money(produs.pret_vanzare)}</div>
          <div><div class="k">Preț achiziție</div>${money(produs.pret_achizitie)}</div>
          <div><div class="k">TVA</div>${esc(produs.cota_tva)}%</div>
          <div><div class="k">Stoc minim</div>${esc(produs.stoc_minim)} ${esc(produs.unitate_masura)}</div>
          <div><div class="k">Stoc total curent</div>${esc(stocTotal)} ${esc(produs.unitate_masura)}</div>
        </div>
        <div class="toolbar" style="margin-top:10px"><a href="/produse/${produs.id}/editare" class="btn secondary small">Editează datele</a></div>
      </div>

      <h2>Stoc pe depozite / gestiuni</h2>
      ${table(
        ["Depozit", "Cantitate"],
        stocPeDepozite.map((r) => [esc(r.depozit), r.stoc])
      )}

      <h2>Rețetă de fabricație (componente)</h2>
      <p style="color:var(--text-muted);font-size:13px">Din ce alte produse (materii prime / semifabricate) e format acest produs, și în ce cantitate.</p>
      ${table(
        ["Componentă", "Cantitate necesară", "UM", ""],
        componente.map((c) => [
          esc(c.denumire),
          c.cantitate,
          esc(c.unitate_masura),
          `<form method="post" action="/produse/${produs.id}/reteta/${c.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi componenta din rețetă?')"><button type="submit" class="link-btn danger">Șterge</button></form>`,
        ])
      )}
      ${
        toateProdusele.length
          ? `<form method="post" action="/produse/${produs.id}/reteta" class="form" style="max-width:480px">
              <label class="field"><span>Adaugă componentă</span>
                <select name="componenta_id" required>${toateProdusele.map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`).join("")}</select>
              </label>
              <label class="field"><span>Cantitate necesară</span><input type="number" step="0.0001" name="cantitate" value="1" required></label>
              <button type="submit" class="btn small">Adaugă în rețetă</button>
            </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Produs: ${produs.denumire}`, active: "/produse", body }));
  });

  router.post("/produse/:id/reteta", async (ctx) => {
    const { componenta_id, cantitate } = ctx.body;
    if (componenta_id && Number(cantitate) > 0) {
      await db
        .prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)")
        .run(ctx.params.id, componenta_id, Number(cantitate));
    }
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/reteta/:randId/sterge", async (ctx) => {
    await db.prepare("DELETE FROM retete_componente WHERE id = ? AND produs_id = ?").run(ctx.params.randId, ctx.params.id);
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });
}

module.exports = { register };
