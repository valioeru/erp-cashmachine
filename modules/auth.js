"use strict";
const db = require("../lib/db");
const auth = require("../lib/auth");
const { esc, layout } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function paginaLogin(eroare, redirectTo) {
  const body = `
    <div class="form" style="max-width:360px;margin:60px auto">
      <h1 style="margin-top:0">Autentificare</h1>
      ${eroare ? `<p style="color:var(--danger);font-size:14px">${esc(eroare)}</p>` : ""}
      <form method="post" action="/login" class="form" style="padding:0;border:none">
        <input type="hidden" name="redirect" value="${esc(redirectTo || "/")}">
        <label class="field"><span>Email</span><input type="email" name="email" required autofocus></label>
        <label class="field"><span>Parolă</span><input type="password" name="parola" required></label>
        <button type="submit" class="btn">Intră în cont</button>
      </form>
    </div>
  `;
  return `<!doctype html>
<html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autentificare · ERP</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="content">${body}</main></body></html>`;
}

function register(router) {
  router.get("/login", async (ctx) => {
    send(ctx.res, 200, paginaLogin(null, ctx.query.redirect));
  });

  router.post("/login", async (ctx) => {
    const { email, parola, redirect: redirectTo } = ctx.body;
    const user = await db.prepare("SELECT * FROM utilizatori WHERE LOWER(email) = LOWER(?)").get(email || "");
    if (!user || !user.activ || !auth.verificaParola(parola || "", user.parola_hash, user.parola_salt)) {
      return send(ctx.res, 401, paginaLogin("Email sau parolă greșită.", redirectTo));
    }
    const token = await auth.creeazaSesiune(user.id);
    ctx.res.setHeader("Set-Cookie", auth.cookieSesiune(token, { secure: !/localhost|127\.0\.0\.1/.test(ctx.req.headers.host || "") }));
    redirect(ctx.res, redirectTo && redirectTo.startsWith("/") ? redirectTo : "/");
  });

  router.post("/logout", async (ctx) => {
    const cookies = auth.parseCookies(ctx.req);
    if (cookies[auth.COOKIE_NAME]) await auth.stergeSesiune(cookies[auth.COOKIE_NAME]);
    ctx.res.setHeader("Set-Cookie", auth.cookieStergere());
    redirect(ctx.res, "/login");
  });

  // Schimbare parolă proprie (orice utilizator autentificat).
  router.get("/profil", async (ctx) => {
    const body = `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Nume</div>${esc(ctx.user.nume)}</div>
        <div><div class="k">Email</div>${esc(ctx.user.email)}</div>
        <div><div class="k">Rol</div>${esc(auth.ROLURI[ctx.user.rol] || ctx.user.rol)}</div>
      </div></div>
      ${
        ctx.user.parola_temporara
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">
              <strong>Ai încă parola implicită.</strong> Alege una proprie mai jos — până atunci nu poți folosi restul aplicației.
            </div>`
          : ""
      }
      <h2>Schimbă parola</h2>
      <form method="post" action="/profil/parola" class="form" style="max-width:420px">
        <label class="field"><span>Parolă nouă</span><input type="password" name="parola" required minlength="6"></label>
        <label class="field"><span>Confirmă parola nouă</span><input type="password" name="parola2" required minlength="6"></label>
        <button type="submit" class="btn">Schimbă parola</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Profilul meu", active: "/profil", body }));
  });

  router.post("/profil/parola", async (ctx) => {
    const { parola, parola2 } = ctx.body;
    if (!parola || parola.length < 6 || parola !== parola2) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Profilul meu",
          active: "/profil",
          body: `<p style="color:var(--danger)">Parolele nu coincid sau sunt prea scurte (minim 6 caractere).</p><a href="/profil" class="btn secondary">Înapoi</a>`,
        })
      );
    }
    const { hash, salt } = auth.hashParola(parola);
    await db.prepare("UPDATE utilizatori SET parola_hash = ?, parola_salt = ?, parola_temporara = 0 WHERE id = ?").run(hash, salt, ctx.user.id);
    redirect(ctx.res, ctx.user.rol === "vanzari" ? "/crm/birou" : "/");
  });
}

module.exports = { register };
