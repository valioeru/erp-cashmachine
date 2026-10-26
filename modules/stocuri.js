"use strict";
const db = require("../lib/db");
const { SUB_STOC } = require("../lib/stoc");
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
    // Lista de stoc are mii de randuri, cate unul pe produs si depozit. Fara
    // filtre, singura cale sa afli cat ai dintr-o marfa era Ctrl+F in pagina —
    // si aia merge doar pe ce a apucat sa se incarce. Vali, 26.10.2026:
    // „search pe o marfa plus filtre pe depozite etc".
    const cauta = String(ctx.query.q || "").trim();
    const depozitId = parseInt(ctx.query.depozit, 10) || 0;
    const doarAlerta = String(ctx.query.alerta || "") === "1";

    const unde = [];
    const args = [];
    if (cauta) {
      unde.push("(p.denumire ILIKE ? OR p.cod ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`);
    }
    if (depozitId) {
      unde.push("d.id = ?");
      args.push(depozitId);
    }
    // „Sub stoc minim" se filtreaza in SQL, nu dupa ce s-au adus randurile:
    // altfel ar fi aratat doar alertele dintre primele cateva mii de randuri.
    if (doarAlerta) unde.push("COALESCE(s.stoc, 0) <= COALESCE(p.stoc_minim, 0)");
    const clauza = unde.length ? "WHERE " + unde.join(" AND ") : "";

    const stocCurent = await db
      .prepare(
        `SELECT p.id AS produs_id, p.denumire, p.cod, p.unitate_masura, p.stoc_minim, d.denumire AS depozit,
                COALESCE(s.stoc, 0) AS stoc
         FROM ${SUB_STOC} s
         JOIN produse p ON p.id = s.produs_id
         JOIN depozite d ON d.id = s.depozit_id
         ${clauza}
         ORDER BY p.denumire
         LIMIT 2000`
      )
      .all(...args);

    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY denumire").all();

    // Mișcările urmează aceleași filtre: dacă te uiți la o marfă, vrei să vezi
    // mișcările ei, nu ultimele 40 din toată firma.
    const undeM = [];
    const argsM = [];
    if (cauta) {
      undeM.push("(p.denumire ILIKE ? OR p.cod ILIKE ?)");
      argsM.push(`%${cauta}%`, `%${cauta}%`);
    }
    if (depozitId) {
      undeM.push("d.id = ?");
      argsM.push(depozitId);
    }
    const miscari = await db
      .prepare(
        `SELECT m.*, p.denumire AS produs, d.denumire AS depozit
         FROM miscari_stoc m
         JOIN produse p ON p.id = m.produs_id
         JOIN depozite d ON d.id = m.depozit_id
         ${undeM.length ? "WHERE " + undeM.join(" AND ") : ""}
         ORDER BY m.id DESC LIMIT 40`
      )
      .all(...argsM);

    const totalStoc = stocCurent.reduce((s, r) => s + Number(r.stoc || 0), 0);
    const subMinim = stocCurent.filter((r) => Number(r.stoc) <= Number(r.stoc_minim || 0)).length;
    const filtre = `
      <form class="filtre" method="get" action="/stocuri">
        <input type="search" name="q" value="${esc(cauta)}" autofocus
               style="min-width:260px;flex:1 1 320px" placeholder="Caută o marfă după denumire sau cod…">
        <select name="depozit" onchange="this.form.submit()">
          <option value="">Toate depozitele</option>
          ${depozite
            .map((d) => `<option value="${d.id}"${depozitId === Number(d.id) ? " selected" : ""}>${esc(d.denumire)}</option>`)
            .join("")}
        </select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="checkbox" name="alerta" value="1"${doarAlerta ? " checked" : ""} onchange="this.form.submit()">
          doar sub stoc minim
        </label>
        <button class="btn small" type="submit">Caută</button>
        ${cauta || depozitId || doarAlerta ? `<a class="link-btn" href="/stocuri">Șterge filtrele</a>` : ""}
      </form>
      <p style="margin:-6px 0 10px;font-size:13px;color:var(--text-muted)">
        ${stocCurent.length}${stocCurent.length === 2000 ? "+" : ""}
        ${stocCurent.length === 1 ? "rând" : "rânduri"},
        ${totalStoc.toLocaleString("ro-RO", { maximumFractionDigits: 3 })} bucăți în total,
        ${subMinim} sub stoc minim.
      </p>`;

    const body = `
      <div class="toolbar">
        <a href="/stocuri/miscare/nou" class="btn">+ Mișcare de stoc</a>
        <a href="/depozite" class="btn secondary">Gestionează depozite</a>
      </div>
      <h2>Stoc curent pe depozite</h2>
      ${filtre}
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
      <h2>Ultimele mișcări de stoc${cauta || depozitId ? " — pentru ce ai filtrat" : ""}</h2>
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
    const produse = await db.prepare("SELECT id, denumire FROM produse WHERE activ = 1 ORDER BY denumire").all();
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
