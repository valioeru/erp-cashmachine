"use strict";
// Angajații. Rândurile vin în mare parte din statele de plată din Drive
// (vezi modules/sincronizare.js) — de-aia lista arată și firma, și de unde
// știm rândul, și dacă persoana mai e pe stat.
const db = require("../lib/db");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table, subnavFinanciar } = require("../lib/render");
const { send } = require("../lib/router");

function register(router) {
  // Lista proprie, înaintea CRUD-ului generic: are nevoie de firmă și de
  // starea „mai e pe stat sau nu", pe care lista generică nu le știe.
  router.get("/angajati", async (ctx) => {
    const oameni = await db
      .prepare(
        `SELECT a.*, f.nume AS firma FROM angajati a LEFT JOIN firme f ON f.id = a.firma_id
         ORDER BY COALESCE(a.activ,1) DESC, f.nume, a.nume`
      )
      .all();
    const activi = oameni.filter((o) => o.activ === undefined || o.activ === null || Number(o.activ) === 1);
    const costLunar = activi.reduce((s, o) => s + Number(o.salariu_baza || 0) * 1.0225, 0);
    const peFirma = new Map();
    for (const o of activi) {
      const k = o.firma || "fără firmă";
      peFirma.set(k, (peFirma.get(k) || 0) + 1);
    }

    const body = `
      ${subnavFinanciar("/angajati")}
      <div class="cards">
        <div class="card"><div class="label">Angajați activi</div><div class="value">${activi.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">${[...peFirma].map(([f, n]) => `${esc(f)}: ${n}`).join(" · ")}</div></div>
        <div class="card"><div class="label">Cost salarial lunar (brut + CAM)</div><div class="value">${money(costLunar)}</div>
          <div style="font-size:12px;color:var(--text-muted)">CAM 2,25% peste brut</div></div>
        <div class="card"><div class="label">Ieșiți de pe stat</div><div class="value">${oameni.length - activi.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">păstrați pentru istoric</div></div>
      </div>
      <div class="toolbar"><a class="btn" href="/angajati/nou">+ Angajat</a></div>
      ${table(
        ["Nume", "Firmă", "Funcție", "Sediu", "Angajat din", "Brut", "Net", "Stare", ""],
        oameni.map((o) => [
          esc(o.nume),
          esc(o.firma || "—"),
          esc(o.functie || "—"),
          esc(o.sediu || o.departament || "—"),
          esc(o.data_angajarii || "—"),
          money(o.salariu_baza),
          o.salariu_net ? money(o.salariu_net) : "—",
          Number(o.activ) === 0 ? '<span class="badge gri">ieșit</span>' : '<span class="badge verde">activ</span>',
          `<a class="btn small secondary" href="/angajati/${o.id}/editare">Editează</a>`,
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted);max-width:760px">
        Rândurile marcate „state de plată Drive" se împrospătează singure la fiecare pornire, din
        <code>date/angajati.json</code>. CNP-urile din statele de plată nu se citesc și nu se rețin nicăieri —
        ERP-ul n-are ce face cu ele.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Angajați", active: "/angajati", body }));
  });

  registerCrud(router, {
    path: "/angajati",
    table: "angajati",
    title: "Angajați",
    singular: "angajat",
    fields: [
      { name: "nume", label: "Nume complet", required: true },
      { name: "functie", label: "Funcție" },
      { name: "departament", label: "Departament" },
      { name: "sediu", label: "Sediu / punct de lucru" },
      { name: "email", label: "Email", type: "email" },
      { name: "telefon", label: "Telefon" },
      { name: "data_angajarii", label: "Data angajării", type: "date" },
      { name: "salariu_baza", label: "Salariu de bază brut (lei)", type: "number", step: "0.01", default: 0 },
      { name: "salariu_net", label: "Salariu net (lei)", type: "number", step: "0.01", default: 0 },
    ],
    listColumns: [
      { key: "nume", label: "Nume" },
      { key: "functie", label: "Funcție" },
      { key: "sediu", label: "Sediu" },
      { key: "salariu_baza", label: "Salariu brut", render: (r) => money(r.salariu_baza) },
    ],
  });
}

module.exports = { register };
