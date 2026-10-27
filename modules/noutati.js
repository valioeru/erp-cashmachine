"use strict";
// Pagina „Noutăți”: ce s-a adăugat în ERP, cel mai nou sus.
//
// Textele sunt în lib/noutati.js, ca date. Aici e doar ecranul.
const { esc, layout, dataRo } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const N = require("../lib/noutati");

const CALE = "/noutati";

function register(router) {
  router.get(CALE, async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    // „Arată tot” pentru cine vrea să caute ceva mai vechi. Implicit, ultimele
    // 30 — atâtea a cerut Vali, și atâtea se citesc fără să obosești.
    const tot = String(ctx.query.tot || "") === "1";
    const toate = N.toate();
    const lista = tot ? toate : N.ultimele(N.CATE);
    const zile = N.peZile(lista);

    const corp = zile
      .map(
        (z) => `
      <section class="zi-noutati">
        <h2 class="data-noutati">${esc(dataRo(z.data))}</h2>
        ${z.randuri
          .map(
            (r) => `
          <article class="noutate">
            <h3>${esc(r.titlu)}</h3>
            <p>${esc(r.text)}</p>
            ${r.unde ? `<p class="unde"><a href="${esc(r.unde)}">Vezi în ERP: ${esc(r.unde)}</a></p>` : ""}
          </article>`
          )
          .join("")}
      </section>`
      )
      .join("");

    const body = `
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:760px">
        Tot ce s-a adăugat în ERP, cel mai nou sus. Se scrie odată cu modificarea, nu după — dacă ceva n-a ajuns
        în aplicație, nu apare nici aici.
      </p>
      ${corp || "<p>Încă nimic scris.</p>"}
      ${
        !tot && toate.length > lista.length
          ? `<p style="margin-top:18px"><a class="btn secondary" href="${CALE}?tot=1">Arată tot (${toate.length})</a></p>`
          : tot
            ? `<p style="margin-top:18px"><a class="btn secondary" href="${CALE}">Arată doar ultimele ${N.CATE}</a></p>`
            : ""
      }
      <style>
        .zi-noutati { margin: 0 0 22px; }
        .data-noutati {
          margin: 0 0 8px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
          color: var(--text-muted); border-bottom: 1px solid var(--border, #e1e4e9); padding-bottom: 5px;
        }
        .noutate {
          background: var(--surface, #fff); border: 1px solid var(--border, #e1e4e9); border-radius: 10px;
          padding: 12px 14px; margin: 0 0 8px; max-width: 760px;
        }
        .noutate h3 { margin: 0 0 5px; font-size: 15px; }
        .noutate p { margin: 0; font-size: 14px; line-height: 1.5; }
        .noutate .unde { margin-top: 7px; font-size: 13px; }
        .noutate .unde a { color: var(--primary, #2f5d9c); }
      </style>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Noutăți în ERP", active: CALE, body }));
  });

  // Vali i-a spus „updates”, meniul scrie „Noutăți”. Amândouă duc în același
  // loc — o adresă scrisă din memorie nu trebuie să dea 404.
  router.get("/updates", async (ctx) => redirect(ctx.res, CALE));
}

module.exports = { register, CALE };
