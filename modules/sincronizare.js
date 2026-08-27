"use strict";
// Sincronizarea lucrurilor care NU se pot afla din baza noastră de date:
// întâlnirile din Google Calendar, task-urile programate la Claude și știrile
// relevante pentru business. ERP-ul n-are cum să întrebe singur Google-ul sau
// internetul, așa că i le împinge Claude, periodic.
//
// De ce un endpoint și nu un import prin interfață: pentru că trebuie să se
// întâmple singur, zilnic, fără ca Vali să apese nimic. De-aia are un secret
// propriu (SYNC_TOKEN, variabilă de mediu), nu sesiunea unui utilizator.
//
// Ce poate face endpoint-ul ăsta e strict limitat: scrie DOAR în „agenda_externa"
// și „stiri", și doar prin înlocuire completă. Nu atinge facturi, parteneri,
// stocuri sau utilizatori. Dacă secretul nu e setat, ruta e închisă complet —
// nu există variantă „fără parolă".
const db = require("../lib/db");
const { esc, layout } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function tokenValid(req, body) {
  const asteptat = process.env.SYNC_TOKEN;
  if (!asteptat || asteptat.length < 16) return false; // fără secret, ruta e închisă
  const dat = (req.headers["x-sync-token"] || (body && body.token) || "").toString();
  if (dat.length !== asteptat.length) return false;
  // comparație în timp constant, ca să nu se poată ghici secretul din durată
  let dif = 0;
  for (let i = 0; i < asteptat.length; i++) dif |= asteptat.charCodeAt(i) ^ dat.charCodeAt(i);
  return dif === 0;
}

function raspunde(res, cod, obiect) {
  const text = JSON.stringify(obiect);
  res.writeHead(cod, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function register(router) {
  // Înlocuiește agenda (calendar + task-uri programate).
  router.post("/api/agenda", async (ctx) => {
    if (!tokenValid(ctx.req, ctx.body)) return raspunde(ctx.res, 401, { eroare: "token invalid" });
    const randuri = Array.isArray(ctx.body && ctx.body.randuri) ? ctx.body.randuri : [];
    if (randuri.length > 500) return raspunde(ctx.res, 400, { eroare: "prea multe rânduri" });

    await db.prepare("DELETE FROM agenda_externa").run();
    const t = acum();
    let n = 0;
    for (const r of randuri) {
      const titlu = String((r && r.titlu) || "").trim();
      if (!titlu) continue;
      await db
        .prepare(
          `INSERT INTO agenda_externa (sursa, titlu, detalii, incepe_la, se_termina_la, link, cheie_externa, actualizat_la)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          String(r.sursa || "calendar").slice(0, 40),
          titlu.slice(0, 300),
          r.detalii ? String(r.detalii).slice(0, 1000) : null,
          r.incepe_la ? String(r.incepe_la).slice(0, 25) : null,
          r.se_termina_la ? String(r.se_termina_la).slice(0, 25) : null,
          r.link ? String(r.link).slice(0, 500) : null,
          r.cheie_externa ? String(r.cheie_externa).slice(0, 200) : null,
          t
        );
      n++;
    }
    raspunde(ctx.res, 200, { ok: true, scrise: n });
  });

  // Înlocuiește știrile.
  router.post("/api/stiri", async (ctx) => {
    if (!tokenValid(ctx.req, ctx.body)) return raspunde(ctx.res, 401, { eroare: "token invalid" });
    const randuri = Array.isArray(ctx.body && ctx.body.randuri) ? ctx.body.randuri : [];
    if (randuri.length > 100) return raspunde(ctx.res, 400, { eroare: "prea multe rânduri" });

    await db.prepare("DELETE FROM stiri").run();
    const t = acum();
    let n = 0;
    for (const r of randuri) {
      const titlu = String((r && r.titlu) || "").trim();
      if (!titlu) continue;
      await db
        .prepare(
          `INSERT INTO stiri (titlu, sursa, url, rezumat, zona, relevanta, publicat_la, adaugat_la)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          titlu.slice(0, 300),
          r.sursa ? String(r.sursa).slice(0, 120) : null,
          r.url ? String(r.url).slice(0, 500) : null,
          r.rezumat ? String(r.rezumat).slice(0, 1000) : null,
          String(r.zona) === "extern" ? "extern" : "local",
          r.relevanta ? String(r.relevanta).slice(0, 500) : null,
          r.publicat_la ? String(r.publicat_la).slice(0, 25) : null,
          t
        );
      n++;
    }
    raspunde(ctx.res, 200, { ok: true, scrise: n });
  });

  // Pagină de stare, pentru admin: ce s-a sincronizat și când.
  router.get("/admin/sincronizare", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const a = await db.prepare("SELECT COUNT(*) AS n, MAX(actualizat_la) AS d FROM agenda_externa").get();
    const s = await db.prepare("SELECT COUNT(*) AS n, MAX(adaugat_la) AS d FROM stiri").get();
    const areToken = !!(process.env.SYNC_TOKEN && process.env.SYNC_TOKEN.length >= 16);
    const body = `
      <h1>Sincronizare externă</h1>
      <p style="max-width:700px;color:var(--text-muted)">
        Agenda (Google Calendar + task-urile programate) și știrile de pe dashboard nu se pot afla din baza noastră
        de date — le împinge Claude, periodic, printr-un endpoint protejat cu un secret separat de conturile de
        utilizator. Endpoint-ul poate scrie DOAR în tabelele astea două, prin înlocuire completă.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Agenda</div><div class="value">${Number(a.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${a.d ? "actualizat " + esc(String(a.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Știri</div><div class="value">${Number(s.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.d ? "actualizat " + esc(String(s.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Secret configurat</div>
          <div class="value">${areToken ? '<span class="badge verde">da</span>' : '<span class="badge rosu">nu</span>'}</div>
          <div style="font-size:12px;color:var(--text-muted)">variabila SYNC_TOKEN</div></div>
      </div>
      ${
        areToken
          ? ""
          : `<p style="color:var(--danger);max-width:700px">Cât timp SYNC_TOKEN nu e setat în variabilele de mediu,
               ruta de sincronizare e închisă și dashboard-ul rămâne fără agendă și fără știri.</p>`
      }
      <a class="btn secondary" href="/">Înapoi la dashboard</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Sincronizare", active: "/", body }));
  });
}

module.exports = { register };
