"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Calcul simplificat de salarizare (model România, orientativ):
// CAS 25%, CASS 10%, impozit pe venit 10% aplicat după CAS/CASS.
// Nu ține cont de deduceri personale, facilități fiscale sectoriale etc.
// A se verifica întotdeauna cu un contabil / soft de salarizare autorizat
// înainte de plata efectivă a salariilor.
function calculeazaSalariu({ brut, bonusuri, deduceri }) {
  const bazaCalcul = Number(brut || 0) + Number(bonusuri || 0);
  const cas = round2(bazaCalcul * 0.25);
  const cass = round2(bazaCalcul * 0.1);
  const bazaImpozit = Math.max(0, bazaCalcul - cas - cass);
  const impozit = round2(bazaImpozit * 0.1);
  const net = round2(bazaCalcul - cas - cass - impozit - Number(deduceri || 0));
  return { cas, cass, impozit, net };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function register(router) {
  router.get("/salarii", async (ctx) => {
    const rows = await db
      .prepare(
        `SELECT s.*, a.nume AS angajat_nume FROM salarii s JOIN angajati a ON a.id = s.angajat_id ORDER BY s.luna DESC, a.nume`
      )
      .all();
    const body = `
      <div class="toolbar"><a href="/salarii/nou" class="btn">+ Stat de plată nou</a></div>
      ${table(
        ["Lună", "Angajat", "Brut", "Net", "Plătit", "Acțiuni"],
        rows.map((r) => [
          esc(r.luna),
          esc(r.angajat_nume),
          money(r.salariu_brut),
          money(r.salariu_net),
          r.platit ? '<span class="badge verde">da</span>' : '<span class="badge gri">nu</span>',
          actionLinks([
            { href: `/salarii/${r.id}`, label: "Detalii" },
            { href: `/salarii/${r.id}/sterge`, label: "Șterge", method: "post", danger: true, confirm: "Ștergi acest stat de plată?" },
          ]),
        ])
      )}
      <p style="color:var(--text-muted);font-size:13px;margin-top:14px">
        Calculul este simplificat (CAS 25%, CASS 10%, impozit 10%) și are scop orientativ — verifică sumele cu un contabil înainte de plată.
      </p>
    `;
    send(ctx.res, 200, layout({ title: "Salarizare", active: "/salarii", body }));
  });

  router.get("/salarii/nou", async (ctx) => {
    const angajati = await db.prepare("SELECT id, nume, salariu_baza FROM angajati ORDER BY nume").all();
    if (angajati.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ title: "Stat de plată nou", active: "/salarii", body: `<p>Adaugă mai întâi cel puțin un <a href="/angajati/nou">angajat</a>.</p>` })
      );
    }
    const body = `<form method="post" action="/salarii" class="form">
      <label class="field"><span>Angajat</span>
        <select name="angajat_id" id="angajat_id" onchange="salariiFillBrut()">
          ${angajati.map((a) => `<option value="${a.id}" data-brut="${a.salariu_baza}">${esc(a.nume)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Luna</span><input type="month" name="luna" required></label>
      <label class="field"><span>Salariu brut</span><input type="number" step="0.01" name="salariu_brut" id="salariu_brut" required></label>
      <label class="field"><span>Bonusuri</span><input type="number" step="0.01" name="bonusuri" value="0"></label>
      <label class="field"><span>Alte deduceri (rate, popriri etc.)</span><input type="number" step="0.01" name="deduceri" value="0"></label>
      <div class="form-actions">
        <button type="submit" class="btn">Calculează și salvează</button>
        <a href="/salarii" class="btn secondary">Renunță</a>
      </div>
    </form>
    <script>
      function salariiFillBrut() {
        var sel = document.getElementById('angajat_id');
        var opt = sel.options[sel.selectedIndex];
        document.getElementById('salariu_brut').value = opt.getAttribute('data-brut');
      }
      salariiFillBrut();
    </script>`;
    send(ctx.res, 200, layout({ title: "Stat de plată nou", active: "/salarii", body }));
  });

  router.post("/salarii", async (ctx) => {
    const { angajat_id, luna, salariu_brut, bonusuri, deduceri } = ctx.body;
    const { cas, cass, impozit, net } = calculeazaSalariu({ brut: salariu_brut, bonusuri, deduceri });
    try {
      const info = await db
        .prepare(
          `INSERT INTO salarii (angajat_id, luna, salariu_brut, bonusuri, deduceri, cas, cass, impozit, salariu_net)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .run(angajat_id, luna, Number(salariu_brut || 0), Number(bonusuri || 0), Number(deduceri || 0), cas, cass, impozit, net);
      redirect(ctx.res, `/salarii/${info.lastInsertRowid}`);
    } catch (e) {
      // Cod 23505 = încălcare constrângere UNIQUE în PostgreSQL
      // (deja există un stat de plată pentru acest angajat în luna respectivă).
      if (e.code !== "23505") throw e;
      send(
        ctx.res,
        400,
        layout({
          title: "Eroare",
          active: "/salarii",
          body: `<p>Există deja un stat de plată pentru acest angajat în luna selectată.</p><a href="/salarii/nou" class="btn secondary">Înapoi</a>`,
        })
      );
    }
  });

  router.get("/salarii/:id", async (ctx) => {
    const s = await db
      .prepare(`SELECT s.*, a.nume AS angajat_nume, a.functie FROM salarii s JOIN angajati a ON a.id = s.angajat_id WHERE s.id = ?`)
      .get(ctx.params.id);
    if (!s) return send(ctx.res, 404, layout({ title: "Negăsit", active: "/salarii", body: "<p>Stat de plată inexistent.</p>" }));

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Angajat</div>${esc(s.angajat_nume)}</div>
          <div><div class="k">Funcție</div>${esc(s.functie) || "—"}</div>
          <div><div class="k">Lună</div>${esc(s.luna)}</div>
          <div><div class="k">Status plată</div>${s.platit ? '<span class="badge verde">plătit</span>' : '<span class="badge gri">neplătit</span>'}</div>
        </div>
      </div>
      ${table(
        ["Element", "Sumă"],
        [
          ["Salariu brut", money(s.salariu_brut)],
          ["Bonusuri", money(s.bonusuri)],
          ["CAS (25%)", money(s.cas)],
          ["CASS (10%)", money(s.cass)],
          ["Impozit pe venit (10%)", money(s.impozit)],
          ["Alte deduceri", money(s.deduceri)],
          ["<strong>Salariu net</strong>", `<strong>${money(s.salariu_net)}</strong>`],
        ]
      )}
      <div class="toolbar" style="margin-top:14px">
        <form method="post" action="/salarii/${s.id}/platit" class="inline-form">
          <button type="submit" class="btn secondary small">${s.platit ? "Marchează ca neplătit" : "Marchează ca plătit"}</button>
        </form>
      </div>
    `;
    send(ctx.res, 200, layout({ title: `Stat de plată — ${s.angajat_nume} (${s.luna})`, active: "/salarii", body }));
  });

  router.post("/salarii/:id/platit", async (ctx) => {
    const s = await db.prepare("SELECT platit FROM salarii WHERE id = ?").get(ctx.params.id);
    await db.prepare("UPDATE salarii SET platit = ? WHERE id = ?").run(s.platit ? 0 : 1, ctx.params.id);
    redirect(ctx.res, `/salarii/${ctx.params.id}`);
  });

  router.post("/salarii/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM salarii WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/salarii");
  });
}

module.exports = { register, calculeazaSalariu };
