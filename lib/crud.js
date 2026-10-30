"use strict";

const db = require("./db");
const { esc, layout, table, actionLinks } = require("./render");
const { send, redirect } = require("./router");

// Generator generic de rute CRUD (listă / adăugare / editare / ștergere)
// pentru entități simple, fără linii asociate (parteneri, produse, depozite, angajați).
//
// Opțiuni adăugate în 19.10.2026, toate OPȚIONALE — paginile care nu le dau se
// comportă exact ca înainte:
//
//   search    ["cod","denumire"]  — casetă de căutare peste coloanele date
//   filtre    [{name,label}]      — select cu valorile distincte din coloană
//   limita    200                 — câte rânduri pe pagină (nomenclatorul de
//                                   produse are peste 4.000; fără limită pagina
//                                   devine nefolosibilă)
//   ordine    "denumire"          — ORDER BY, altul decât id DESC
//   banner    async (ctx) => html — bandă deasupra listei
//   inainte   async (ctx) => {}    — rulează la începutul FIECĂREI rute, pentru
//                                   setările de care depind câmpurile calculate
//   valideaza async (valori, { ctx, id, vechi }) => mesaj | null
//                                 — se uită la ce urmează să se scrie, la
//                                   adăugare (id și vechi sunt null) și la
//                                   editare (vechi = rândul de dinainte). Un
//                                   mesaj înseamnă „nu scrie": formularul se
//                                   arată din nou, cu ce a scris omul în el și
//                                   cu mesajul deasupra. Mesajul e HTML gata
//                                   scăpat (poate avea un link).
//
// Pe câmpuri:
//   type: "calculat", calc(row)   — se afișează, NU se scrie în bază
//   datalist: true                — sugestii din valorile deja existente
//   ajutor: "text"                — un rând de explicație sub câmp
function registerCrud(router, opts) {
  const { path, table: tbl, title, singular, fields, listColumns, extraBody, search, filtre, limita, ordine, banner, inainte, valideaza } = opts;

  // Câmpurile calculate nu au coloană în bază: se afișează, dar nu se scriu.
  const campuriScrise = fields.filter((f) => f.type !== "calculat");

  // Un câmp numeric lăsat gol trebuie să ajungă NULL în bază, nu șirul vid:
  // Postgres refuză '' pentru o coloană REAL cu "invalid input syntax". Până
  // acum nu s-a văzut pentru că toate câmpurile numerice aveau valoare
  // implicită, deci formularul trimitea mereu ceva. Câmpurile noi (cost de
  // producție, adaos, preț minim) au voie să fie goale — „nu știu" e un
  // răspuns valid și nu trebuie să devină zero.
  function valoareCamp(f, brut) {
    const v = brut == null ? "" : String(brut).trim();
    if (f.type === "number") {
      if (v === "") return null;
      const n = Number(v.replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    return v;
  }

  // Valorile distincte dintr-o coloană, pentru filtre și datalist.
  async function valoriDistincte(coloana) {
    const r = await db
      .prepare(`SELECT DISTINCT ${coloana} AS v FROM ${tbl} WHERE ${coloana} IS NOT NULL AND ${coloana} <> '' ORDER BY 1`)
      .all()
      .catch(() => []);
    return r.map((x) => String(x.v));
  }

  function renderForm(values, isEdit, sugestii) {
    const rows = fields
      .map((f) => {
        const val = values ? values[f.name] : f.default !== undefined ? f.default : "";
        let input;
        if (f.type === "calculat") {
          // Nu are name: nu se trimite și nu se scrie nicăieri.
          const t = values ? f.calc(values) : "—";
          input = `<div class="camp-calculat" style="padding:7px 0;font-weight:600">${t}</div>`;
        } else if (f.datalist) {
          const lista = (sugestii && sugestii[f.name]) || [];
          const idl = `dl_${f.name}`;
          input = `<input type="text" name="${f.name}" value="${esc(val)}" list="${idl}" ${f.required ? "required" : ""}>
            <datalist id="${idl}">${lista.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`;
        } else if (f.type === "select") {
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
        const ajutor = f.ajutor ? `<small style="display:block;color:var(--text-muted);font-size:12px;margin-top:3px">${esc(f.ajutor)}</small>` : "";
        return `<label class="field"><span>${esc(f.label)}</span>${input}${ajutor}</label>`;
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
    if (inainte) await inainte(ctx);
    const q = String((ctx.query && ctx.query.q) || "").trim();
    const toate = String((ctx.query && ctx.query.toate) || "") === "1";

    // WHERE se construiește din căutare + filtre. Fără ele, interogarea e
    // identică cu cea de dinainte.
    const unde = [];
    const param = [];
    if (search && search.length && q) {
      unde.push("(" + search.map((c) => `COALESCE(${c}, '') ILIKE ?`).join(" OR ") + ")");
      for (const _ of search) param.push(`%${q}%`);
    }
    const valoriFiltre = {};
    for (const f of filtre || []) {
      const v = String((ctx.query && ctx.query[f.name]) || "").trim();
      valoriFiltre[f.name] = v;
      if (v) { unde.push(`COALESCE(${f.name}, '') = ?`); param.push(v); }
    }
    const clauza = unde.length ? ` WHERE ${unde.join(" AND ")}` : "";
    const ordonare = ordine ? ` ORDER BY ${ordine}` : " ORDER BY id DESC";

    const totalR = await db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}${clauza}`).get(...param).catch(() => ({ n: 0 }));
    const total = Number((totalR && totalR.n) || 0);
    const nLimita = toate ? 0 : Number(limita) || 0;
    const rows = await db
      .prepare(`SELECT * FROM ${tbl}${clauza}${ordonare}${nLimita ? ` LIMIT ${nLimita}` : ""}`)
      .all(...param);

    // Sugestiile pentru selectele de filtru se iau din toată tabela, nu din
    // pagina curentă — altfel filtrul ar ascunde chiar valorile după care vrei
    // să filtrezi.
    const optFiltre = {};
    for (const f of filtre || []) optFiltre[f.name] = await valoriDistincte(f.name);

    const areCautare = (search && search.length) || (filtre && filtre.length);
    const formCautare = !areCautare
      ? ""
      : `<form class="filtre" method="get" action="${path}" style="margin-bottom:12px">
          ${search && search.length ? `<label>Caută <input name="q" value="${esc(q)}" placeholder="cod sau denumire" style="min-width:220px"></label>` : ""}
          ${(filtre || [])
            .map(
              (f) => `<label>${esc(f.label)}
                <select name="${f.name}" onchange="this.form.submit()">
                  <option value="">toate</option>
                  ${(optFiltre[f.name] || [])
                    .map((v) => `<option value="${esc(v)}"${v === valoriFiltre[f.name] ? " selected" : ""}>${esc(v)}</option>`)
                    .join("")}
                </select></label>`
            )
            .join("")}
          <button class="btn small" type="submit">Caută</button>
          ${q || Object.values(valoriFiltre).some(Boolean) ? `<a class="btn small secondary" href="${path}">Șterge filtrele</a>` : ""}
        </form>`;

    const nota =
      nLimita && total > rows.length
        ? `<p style="font-size:12px;color:var(--text-muted);margin:-6px 0 10px">Se văd ${rows.length} din ${total.toLocaleString("ro-RO")}. Caută ca să ajungi la ce-ți trebuie, sau <a href="${path}?${new URLSearchParams(
            Object.assign({ toate: "1" }, q ? { q } : {}, valoriFiltre)
          ).toString()}">arată-le pe toate</a> (pagina va fi mare).</p>`
        : areCautare
          ? `<p style="font-size:12px;color:var(--text-muted);margin:-6px 0 10px">${total.toLocaleString("ro-RO")} ${total === 1 ? "rând" : "rânduri"}.</p>`
          : "";

    const cols = listColumns || fields.map((f) => ({ key: f.name, label: f.label }));
    const body = `
      ${banner ? await banner(ctx) : ""}
      <div class="toolbar"><a href="${path}/nou" class="btn">+ ${singular} nou${singular.endsWith("ă") ? "ă" : ""}</a></div>
      ${formCautare}
      ${nota}
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

  router.get(`${path}/nou`, async (ctx) => {
    if (inainte) await inainte(ctx);
    const sugestii = {};
    for (const f of fields) if (f.datalist) sugestii[f.name] = await valoriDistincte(f.name);
    const body = renderForm(null, false, sugestii);
    send(ctx.res, 200, layout({ user: ctx.user, title: `${singular} nou`, active: path, body }));
  });

  // Formularul arătat din nou, când `valideaza` a spus nu: cu ce a scris omul,
  // ca să nu o ia de la capăt, și cu motivul deasupra.
  async function formularRefuzat(ctx, valori, isEdit, mesaj) {
    if (inainte) await inainte(ctx);
    const sugestii = {};
    for (const f of fields) if (f.datalist) sugestii[f.name] = await valoriDistincte(f.name);
    const body = `<div class="flash flash-rosu">${mesaj}</div>` + renderForm(valori, isEdit, sugestii);
    send(ctx.res, 400, layout({ user: ctx.user, title: isEdit ? `Editare ${singular}` : `${singular} nou`, active: path, body }));
  }

  router.post(path, async (ctx) => {
    const cols = campuriScrise.map((f) => f.name);
    const placeholders = cols.map(() => "?").join(",");
    const values = campuriScrise.map((f) => valoareCamp(f, ctx.body[f.name]));
    if (valideaza) {
      const valori = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
      const mesaj = await valideaza(valori, { ctx, id: null, vechi: null });
      if (mesaj) return formularRefuzat(ctx, valori, false, mesaj);
    }
    await db.prepare(`INSERT INTO ${tbl} (${cols.join(",")}) VALUES (${placeholders})`).run(...values);
    redirect(ctx.res, path);
  });

  router.get(`${path}/:id/editare`, async (ctx) => {
    if (inainte) await inainte(ctx);
    const row = await db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(ctx.params.id);
    if (!row) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: path, body: "<p>Rând inexistent.</p>" }));
    const sugestii = {};
    for (const f of fields) if (f.datalist) sugestii[f.name] = await valoriDistincte(f.name);
    const body = renderForm(row, true, sugestii);
    send(ctx.res, 200, layout({ user: ctx.user, title: `Editare ${singular}`, active: path, body }));
  });

  router.post(`${path}/:id/editare`, async (ctx) => {
    const cols = campuriScrise.map((f) => f.name);
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    const values = campuriScrise.map((f) => valoareCamp(f, ctx.body[f.name]));
    if (valideaza) {
      const vechi = await db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(ctx.params.id);
      const valori = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
      const id = vechi ? vechi.id : ctx.params.id;
      const mesaj = await valideaza(valori, { ctx, id, vechi: vechi || null });
      // Peste rândul vechi, ca și câmpurile calculate (care citesc și coloane
      // din afara formularului) să iasă ca înainte; `id` pentru acțiunea lui.
      if (mesaj) return formularRefuzat(ctx, Object.assign({}, vechi || {}, valori, { id }), true, mesaj);
    }
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
