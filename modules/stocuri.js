"use strict";
const db = require("../lib/db");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function register(router) {
  // Gestiune depozite (CRUD generic)
  registerCrud(router, {
    path: "/depozite",
    table: "depozite",
    title: "Depozite",
    singular: "depozit",
    fields: [
      { name: "denumire", label: "Denumire depozit", required: true },
      { name: "locatie", label: "Locație" },
    ],
  });

  router.get("/stocuri", async (ctx) => {
    const stocCurent = await db
      .prepare(
        `SELECT p.id AS produs_id, p.denumire, p.unitate_masura, p.stoc_minim, d.denumire AS depozit,
                COALESCE(SUM(CASE WHEN m.tip = 'intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS stoc
         FROM miscari_stoc m
         JOIN produse p ON p.id = m.produs_id
         JOIN depozite d ON d.id = m.depozit_id
         GROUP BY p.id, d.id, p.denumire, p.unitate_masura, p.stoc_minim, d.denumire
         ORDER BY p.denumire`
      )
      .all();

    const miscari = await db
      .prepare(
        `SELECT m.*, p.denumire AS produs, d.denumire AS depozit
         FROM miscari_stoc m
         JOIN produse p ON p.id = m.produs_id
         JOIN depozite d ON d.id = m.depozit_id
         ORDER BY m.id DESC LIMIT 40`
      )
      .all();

    const body = `
      <div class="toolbar">
        <a href="/stocuri/miscare/nou" class="btn">+ Mișcare de stoc</a>
        <a href="/depozite" class="btn secondary">Gestionează depozite</a>
      </div>
      <h2>Stoc curent pe depozite</h2>
      ${table(
        ["Produs", "Depozit", "Cantitate", "UM", "Alertă"],
        stocCurent.map((r) => [
          esc(r.denumire),
          esc(r.depozit),
          r.stoc,
          esc(r.unitate_masura),
          Number(r.stoc) <= Number(r.stoc_minim || 0)
            ? '<span class="badge rosu">sub stoc minim</span>'
            : '<span class="badge verde">ok</span>',
        ])
      )}
      <h2>Ultimele mișcări de stoc</h2>
      ${table(
        ["Data", "Produs", "Depozit", "Tip", "Cantitate", "Preț unitar", "Document", "Acțiuni"],
        miscari.map((m) => [
          esc(m.data),
          esc(m.produs),
          esc(m.depozit),
          m.tip === "intrare" ? '<span class="badge verde">intrare</span>' : '<span class="badge rosu">ieșire</span>',
          m.cantitate,
          money(m.pret_unitar),
          esc(m.document_ref),
          actionLinks([
            { href: `/stocuri/miscare/${m.id}/sterge`, label: "Șterge", method: "post", danger: true, confirm: "Ștergi această mișcare de stoc?" },
          ]),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Stocuri & inventar", active: "/stocuri", body }));
  });

  router.get("/stocuri/miscare/nou", async (ctx) => {
    const produse = await db.prepare("SELECT id, denumire FROM produse ORDER BY denumire").all();
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY denumire").all();
    if (produse.length === 0 || depozite.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user,
          title: "Mișcare de stoc nouă",
          active: "/stocuri",
          body: `<p>Adaugă mai întâi cel puțin un <a href="/produse/nou">produs</a> și un <a href="/depozite/nou">depozit</a>.</p>`,
        })
      );
    }
    const body = `<form method="post" action="/stocuri/miscare" class="form">
      <label class="field"><span>Produs</span>
        <select name="produs_id" required>${produse.map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Depozit</span>
        <select name="depozit_id" required>${depozite.map((d) => `<option value="${d.id}">${esc(d.denumire)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Tip mișcare</span>
        <select name="tip" required><option value="intrare">Intrare (achiziție / recepție)</option><option value="iesire">Ieșire (vânzare / consum)</option></select>
      </label>
      <label class="field"><span>Cantitate</span><input type="number" step="0.01" name="cantitate" required></label>
      <label class="field"><span>Preț unitar</span><input type="number" step="0.01" name="pret_unitar"></label>
      <label class="field"><span>Document referință</span><input type="text" name="document_ref" placeholder="ex: NIR 123 / Factură 456"></label>
      <label class="field"><span>Observații</span><textarea name="observatii" rows="2"></textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn">Salvează mișcarea</button>
        <a href="/stocuri" class="btn secondary">Renunță</a>
      </div>
    </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Mișcare de stoc nouă", active: "/stocuri", body }));
  });

  router.post("/stocuri/miscare", async (ctx) => {
    const { produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, observatii } = ctx.body;
    await db
      .prepare(
        `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(produs_id, depozit_id, tip, Number(cantitate || 0), Number(pret_unitar || 0), document_ref || "", observatii || "");
    redirect(ctx.res, "/stocuri");
  });

  router.post("/stocuri/miscare/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM miscari_stoc WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/stocuri");
  });
}

module.exports = { register };
