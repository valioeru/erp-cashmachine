"use strict";
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send } = require("../lib/router");
const { calcTotals } = require("./facturi");

function lunileUltimele(n) {
  const azi = new Date();
  const rez = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(azi.getFullYear(), azi.getMonth() - i, 1);
    rez.push(d.toISOString().slice(0, 7));
  }
  return rez;
}

function bar(pct, cls) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="bar-track"><div class="bar-fill ${cls}" style="width:${p}%"></div></div>`;
}

function register(router) {
  router.get("/rapoarte", async (ctx) => {
    const facturi = await db.prepare("SELECT * FROM facturi WHERE status != 'anulata'").all();
    const linii = await db.prepare("SELECT * FROM facturi_linii").all();
    const liniiPerFactura = {};
    for (const l of linii) (liniiPerFactura[l.factura_id] ||= []).push(l);

    const luni = lunileUltimele(12);
    const perLuna = Object.fromEntries(luni.map((l) => [l, { vanzari: 0, achizitii: 0 }]));
    let totalVanzari = 0;
    let totalAchizitii = 0;
    const perClient = {};
    const perFurnizor = {};

    for (const f of facturi) {
      const { total } = calcTotals(liniiPerFactura[f.id] || []);
      const luna = (f.data_emiterii || "").slice(0, 7);
      if (f.directie === "achizitie") {
        totalAchizitii += total;
        if (perLuna[luna]) perLuna[luna].achizitii += total;
        perFurnizor[f.partener_id] = (perFurnizor[f.partener_id] || 0) + total;
      } else {
        totalVanzari += total;
        if (perLuna[luna]) perLuna[luna].vanzari += total;
        perClient[f.partener_id] = (perClient[f.partener_id] || 0) + total;
      }
    }

    const parteneri = await db.prepare("SELECT id, nume FROM parteneri").all();
    const numeParteneri = Object.fromEntries(parteneri.map((p) => [p.id, p.nume]));

    const topClienti = Object.entries(perClient).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topFurnizori = Object.entries(perFurnizor).sort((a, b) => b[1] - a[1]).slice(0, 8);

    const maxLuna = Math.max(1, ...luni.map((l) => Math.max(perLuna[l].vanzari, perLuna[l].achizitii)));

    const facturiRestante = [];
    for (const f of facturi) {
      if (f.directie !== "vanzare") continue;
      const { total } = calcTotals(liniiPerFactura[f.id] || []);
      const platit = (await db.prepare("SELECT COALESCE(SUM(suma),0) AS s FROM plati WHERE factura_id = ?").get(f.id)).s;
      const restant = total - platit;
      if (restant > 0.5) facturiRestante.push({ f, restant, scadenta: f.data_scadenta });
    }
    facturiRestante.sort((a, b) => (a.scadenta || "9999").localeCompare(b.scadenta || "9999"));

    const body = `
      <div class="cards">
        <div class="card"><div class="label">Vânzări (ultimele 12 luni)</div><div class="value">${money(totalVanzari)}</div></div>
        <div class="card"><div class="label">Achiziții (ultimele 12 luni)</div><div class="value">${money(totalAchizitii)}</div></div>
        <div class="card"><div class="label">Marjă brută estimată</div><div class="value">${money(totalVanzari - totalAchizitii)}</div></div>
      </div>

      <h2>Vânzări vs. achiziții pe lună</h2>
      <div class="chart">
        ${luni
          .map(
            (l) => `
          <div class="chart-row">
            <div class="chart-label">${esc(l)}</div>
            <div class="chart-bars">
              ${bar((perLuna[l].vanzari / maxLuna) * 100, "verde")}
              ${bar((perLuna[l].achizitii / maxLuna) * 100, "rosu")}
            </div>
            <div class="chart-values">${money(perLuna[l].vanzari)} / ${money(perLuna[l].achizitii)}</div>
          </div>`
          )
          .join("")}
      </div>
      <p style="font-size:12px;color:var(--text-muted)">Bară verde = vânzări, bară roșie = achiziții. Luna curentă e ultima din listă.</p>

      <h2>Top clienți (după valoare facturată, nete de anulate)</h2>
      ${table(
        ["Client", "Valoare"],
        topClienti.map(([id, v]) => [`<a href="/parteneri/${id}">${esc(numeParteneri[id] || "—")}</a>`, money(v)])
      )}

      <h2>Top furnizori (după valoare achiziționată)</h2>
      ${table(
        ["Furnizor", "Valoare"],
        topFurnizori.map(([id, v]) => [`<a href="/parteneri/${id}">${esc(numeParteneri[id] || "—")}</a>`, money(v)])
      )}

      <h2>Facturi restante (de încasat de la clienți)</h2>
      ${
        facturiRestante.length
          ? table(
              ["Factură", "Scadență", "Restant"],
              facturiRestante.map((x) => [`<a href="/facturi/${x.f.id}">${esc(x.f.serie)}-${x.f.numar}</a>`, esc(x.scadenta) || "—", money(x.restant)])
            )
          : "<p>Nicio factură restantă.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Rapoarte", active: "/rapoarte", body }));
  });
}

module.exports = { register };
