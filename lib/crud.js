"use strict";

const db = require("./db");
const { esc, layout, table, actionLinks } = require("./render");
const { send, redirect } = require("./router");

// Generator generic de rute CRUD (listă / adăugare / editare / ștergere)
// pentru entități simple, fără linii asociate (parteneri, produse, depozite, angajați).
function registerCrud(router, opts) {
  const { path, table: tbl, title, singular, fields, listColumns, extraBody } = opts;

  function renderForm(values, isEdit) {
    const rows = fields
      .map((f) => {
        const val = values ? values[f.name] : f.default !== undefined ? f.default : "";
        let input;
        if (f.type === "select") {
          const opts = (typeof f.options === "function" ? f.options() : f.options) || [];
          input = `<select name="${f.name}" ${f.required ? "required" : ""}>${opts
            .map(
              (o) =>
                `<option value="${esc(o.value)}" ${String(val) === String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`
            )
            .join("")}</select>`;
        } else if (f.type === "textarea") {
          input = `<textarea name="${f.name}" rows="3">${esc(val)}</textarea>`;
        } else {
          input = `<input type="${f.type || "text"}" name="${f.name}" value="${esc(val)}" ${
            f.step ? `step="${f.step}"` : ""
          } ${f.required ? "required" : ""}>`;
        }
        return `<label class="field"><span>${esc(f.label)}</span>${input}</label>`;
      })
      .join("");

    return `<form method="post" action="${isEdit ? `${path}/${values.id}/editare` : path}" class="form">
      ${rows}
      <div class="form-actions">
        <button type="submit" class="btn">${isEdit ? "Salvează modificările" : `Adaugă ${singular}`}</button>
        <a href="${path}" class="btn secondary">Renunță</a>
      </div>
    </form>`;
  }

  router.get(path, async (ctx) => {
    const rows = await db.prepare(`SELECT * FROM ${tbl} ORDER BY id DESC`).all();
    const cols = listColumns || fields.map((f) => ({ key: f.name, label: f.label }));
    const body = `
      <div class="toolbar"><a href="${path}/nou" class="btn">+ ${singular} nou${singular.endsWith("ă") ? "ă" : ""}</a></div>
      ${table(
        [...cols.map((c) => c.label), "Acțiuni"],
        rows.map((r) => [
          // Notă: c.render(r), dacă e definit, e considerat HTML "sigur" (deja
          // scăpat/construit corect de apelant, ex. un link <a>) — nu-l mai
          // scăpăm din nou. Valorile brute (fără render) sunt scăpate normal.
          ...cols.map((c) => (c.render ? c.render(r) : esc(r[c.key]))),
          actionLinks([
            { href: `${path}/${r.id}/editare`, label: "Editează" },
            { href: `${path}/${r.id}/sterge`, label: "Șterge", method: "post", danger: true, confirm: "Ștergi definitiv acest rând?" },
          ]),
        ])
      )}
      ${extraBody ? extraBody(rows) : ""}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title, active: path, body }));
  });

  router.get(`${path}/nou`, (ctx) => {
    const body = renderForm(null, false);
    send(ctx.res, 200, layout({ user: ctx.user, title: `${singular} nou`, active: path, body }));
  });

  router.post(path, async (ctx) => {
    const cols = fields.map((f) => f.name);
    const placeholders = cols.map(() => "?").join(",");
    const values = cols.map((c) => ctx.body[c] ?? "");
    await db.prepare(`INSERT INTO ${tbl} (${cols.join(",")}) VALUES (${placeholders})`).run(...values);
    redirect(ctx.res, path);
  });

  router.get(`${path}/:id/editare`, async (ctx) => {
    const row = await db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(ctx.params.id);
    if (!row) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: path, body: "<p>Rând inexistent.</p>" }));
    const body = renderForm(row, true);
    send(ctx.res, 200, layout({ user: ctx.user, title: `Editare ${singular}`, active: path, body }));
  });

  router.post(`${path}/:id/editare`, async (ctx) => {
    const cols = fields.map((f) => f.name);
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    const values = cols.map((c) => ctx.body[c] ?? "");
    await db.prepare(`UPDATE ${tbl} SET ${setClause} WHERE id = ?`).run(...values, ctx.params.id);
    redirect(ctx.res, path);
  });

  router.post(`${path}/:id/sterge`, async (ctx) => {
    try {
      await db.prepare(`DELETE FROM ${tbl} WHERE id = ?`).run(ctx.params.id);
      redirect(ctx.res, path);
    } catch (e) {
      if (e.code === "23503") {
        return send(
          ctx.res,
          409,
          layout({ user: ctx.user,
            title: "Nu se poate șterge",
            active: path,
            body: `<p>Acest rând nu poate fi șters pentru că este folosit în alte înregistrări (comenzi, facturi, mișcări de stoc etc.). Șterge mai întâi înregistrările asociate, sau editează rândul în loc să-l ștergi.</p><a href="${path}" class="btn secondary">Înapoi</a>`,
          })
        );
      }
      throw e;
    }
  });
}

module.exports = { registerCrud };
