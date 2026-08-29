"use strict";
const db = require("../lib/db");
const auth = require("../lib/auth");
const { esc, layout, avatar } = require("../lib/render");
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
  // Formularul e scos afară din rută fiindcă îl refolosim și când parola dată
  // n-a trecut verificarea: omul rămâne pe el și corectează, nu e trimis pe o
  // pagină moartă cu un singur link „Înapoi".
  //
  // autocomplete="new-password" nu e cosmetic: fără el, Chrome umple singur
  // primul câmp cu parola salvată pentru site, omul scrie doar în al doilea,
  // cele două nu coincid și pare că aplicația „nu vrea" să schimbe parola.
  function paginaProfil(user, eroare, mesaj) {
    return layout({
      user,
      title: "Profilul meu",
      active: "/profil",
      body: `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Nume</div>${esc(user.nume)}</div>
        <div><div class="k">Email</div>${esc(user.email)}</div>
        <div><div class="k">Rol</div>${esc(auth.ROLURI[user.rol] || user.rol)}</div>
      </div></div>
      ${
        user.parola_temporara
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">
              <strong>Ai încă parola implicită.</strong> Alege una proprie mai jos — până atunci nu poți folosi restul aplicației.
            </div>`
          : ""
      }
      ${eroare ? `<div class="flash" style="background:#fdecec;border-color:#f0b4b4;color:var(--danger)">${esc(eroare)}</div>` : ""}
      ${mesaj ? `<div class="flash" style="background:#e7f5ec;border-color:#b6dcc4;color:var(--success)">${esc(mesaj)}</div>` : ""}

      <h2>Poza mea</h2>
      <div class="detail-box profil-poza">
        <span class="avatar-mare-wrap">${avatar(user, 96)}</span>
        <div style="min-width:260px;flex:1">
          <p style="margin:0 0 10px;color:var(--text-muted);font-size:13px">
            ${user.poza ? "Poza apare în colțul din dreapta sus, pe orice ecran." : "N-ai încă poză. Alege una și va apărea în colțul din dreapta sus, pe orice ecran."}
          </p>
          <form method="post" action="/profil/poza" id="form-poza" class="inline-form" style="gap:10px;flex-wrap:wrap">
            <input type="hidden" name="poza" id="poza-date">
            <input type="file" id="poza-fisier" accept="image/*" style="max-width:260px">
            <button type="submit" class="btn" id="poza-buton" disabled>Salvează poza</button>
          </form>
          ${
            user.poza
              ? `<form method="post" action="/profil/poza/sterge" class="inline-form" style="margin-top:8px">
                   <button type="submit" class="link-btn" style="color:var(--danger)">Șterge poza</button>
                 </form>`
              : ""
          }
          <p style="margin:10px 0 0;color:var(--text-muted);font-size:12px">
            Poza e micșorată în browser la 256×256 și tăiată pătrat înainte să plece spre server, deci
            poți alege liniștit o fotografie mare de pe telefon — nu se încarcă tot fișierul.
          </p>
        </div>
      </div>
      <script>
      (function () {
        // Micșorăm poza aici, în pagină, și o trimitem ca text (data-URI) într-un
        // câmp normal de formular. Așa nu ne trebuie nici upload de fișiere, nici
        // un director pe disc — pe Render discul se pierde la fiecare redeploy,
        // deci pozele trebuie să stea în baza de date.
        var LATURA = 256;
        var fisier = document.getElementById("poza-fisier");
        var camp = document.getElementById("poza-date");
        var buton = document.getElementById("poza-buton");
        var previzualizare = document.querySelector(".avatar-mare-wrap");
        if (!fisier || !camp || !buton) return;
        fisier.addEventListener("change", function () {
          var f = fisier.files && fisier.files[0];
          if (!f) { camp.value = ""; buton.disabled = true; return; }
          buton.disabled = true;
          var cititor = new FileReader();
          cititor.onload = function () {
            var img = new Image();
            img.onload = function () {
              // Tăiem pătratul din mijloc, ca fața să nu iasă din bulină.
              var latura = Math.min(img.width, img.height);
              var sx = (img.width - latura) / 2;
              var sy = (img.height - latura) / 2;
              var c = document.createElement("canvas");
              c.width = LATURA; c.height = LATURA;
              var ctx = c.getContext("2d");
              ctx.drawImage(img, sx, sy, latura, latura, 0, 0, LATURA, LATURA);
              var date = c.toDataURL("image/jpeg", 0.85);
              camp.value = date;
              buton.disabled = false;
              if (previzualizare) previzualizare.innerHTML = '<img src="' + date + '" class="avatar" style="width:96px;height:96px" alt="">';
            };
            img.onerror = function () { alert("Fișierul ales nu pare să fie o imagine."); };
            img.src = cititor.result;
          };
          cititor.readAsDataURL(f);
        });
      })();
      </script>

      <h2>Schimbă parola</h2>
      <form method="post" action="/profil/parola" class="form" style="max-width:420px" autocomplete="off">
        <input type="text" name="email_ascuns" value="${esc(user.email)}" autocomplete="username" style="display:none" readonly>
        <label class="field"><span>Parolă nouă</span>
          <input type="password" name="parola" required minlength="6" autocomplete="new-password" autofocus>
          <small style="color:var(--text-muted)">Minim 6 caractere. Scrie-o tu, nu lăsa browserul s-o completeze.</small>
        </label>
        <label class="field"><span>Confirmă parola nouă</span>
          <input type="password" name="parola2" required minlength="6" autocomplete="new-password">
        </label>
        <button type="submit" class="btn">Schimbă parola</button>
      </form>
    `,
    });
  }

  router.get("/profil", async (ctx) => {
    send(ctx.res, 200, paginaProfil(ctx.user, null, ctx.query.ok ? "Poza a fost salvată." : null));
  });

  // Limita e pusă pe textul data-URI, nu pe fișierul original: 256×256 JPEG
  // înseamnă în jur de 15–25 KB, deci 300 000 de caractere e loc berechet și
  // în același timp o plasă de siguranță dacă cineva trimite altceva de mână.
  const POZA_MAX = 300000;

  router.post("/profil/poza", async (ctx) => {
    const poza = String(ctx.body.poza || "");
    let eroare = null;
    if (!poza) eroare = "N-a ajuns nicio poză. Alege un fișier imagine și încearcă din nou.";
    else if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(poza)) eroare = "Formatul pozei nu e recunoscut. Alege un fișier JPG, PNG sau WEBP.";
    else if (poza.length > POZA_MAX) eroare = "Poza e prea mare chiar și după micșorare. Alege alta.";
    if (eroare) return send(ctx.res, 200, paginaProfil(ctx.user, eroare, null));
    await db.prepare("UPDATE utilizatori SET poza = ? WHERE id = ?").run(poza, ctx.user.id);
    redirect(ctx.res, "/profil?ok=1");
  });

  router.post("/profil/poza/sterge", async (ctx) => {
    await db.prepare("UPDATE utilizatori SET poza = NULL WHERE id = ?").run(ctx.user.id);
    redirect(ctx.res, "/profil");
  });

  router.post("/profil/parola", async (ctx) => {
    const parola = String(ctx.body.parola || "");
    const parola2 = String(ctx.body.parola2 || "");
    // Spunem exact ce n-a mers. „Nu coincid sau sunt prea scurte" îl lasă pe om
    // să ghicească, iar cel mai des vinovat e câmpul de confirmare completat de
    // browser cu altceva.
    let eroare = null;
    if (!parola) eroare = "N-ai scris nicio parolă nouă.";
    else if (parola.length < 6) eroare = `Parola are ${parola.length} caractere, sunt necesare cel puțin 6.`;
    else if (!parola2) eroare = "Trebuie să scrii parola a doua oară, în câmpul de confirmare.";
    else if (parola !== parola2) eroare = "Cele două parole nu sunt identice. Verifică dacă browserul n-a completat singur primul câmp — șterge-l și scrie-le tu pe amândouă.";
    if (eroare) return send(ctx.res, 200, paginaProfil(ctx.user, eroare));
    const { hash, salt } = auth.hashParola(parola);
    await db.prepare("UPDATE utilizatori SET parola_hash = ?, parola_salt = ?, parola_temporara = 0 WHERE id = ?").run(hash, salt, ctx.user.id);
    redirect(ctx.res, ctx.user.rol === "vanzari" ? "/crm/birou" : "/");
  });
}

module.exports = { register };
