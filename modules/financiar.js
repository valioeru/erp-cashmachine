"use strict";
// Sumarul financiar: o singură pagină din care se vede unde stau banii, cui
// îi datorăm, cine ne datorează și cât costă lună de lună oamenii. Restul
// (banca, angajați, salarizare, cost company) sunt paginile de dedesubt.
const db = require("../lib/db");
const { esc, money, layout, table, subnavFinanciar } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function poateVedea(user) {
  return user && ["admin", "financiar"].includes(user.rol);
}

async function unuSau(sql, ...p) {
  try {
    const r = await db.prepare(sql).get(...p);
    return r || {};
  } catch (e) {
    console.error("[financiar]", e.message);
    return {};
  }
}

function register(router) {
  router.get("/financiar", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");
    const zi = azi();
    const anul = zi.slice(0, 4);

    const deIncasat = await unuSau(
      `SELECT COUNT(*) AS n, COALESCE(SUM(x.rest), 0) AS suma FROM (
         SELECT f.id,
                COALESCE((SELECT SUM(fl.cantitate * fl.pret_unitar) FROM facturi_linii fl WHERE fl.factura_id = f.id), 0)
                - COALESCE((SELECT SUM(pl.suma) FROM (SELECT * FROM plati WHERE activ = 1) pl WHERE pl.factura_id = f.id), 0) AS rest
         FROM (SELECT * FROM facturi WHERE activ = 1) f WHERE f.directie = 'vanzare' AND f.status != 'anulata'
       ) x WHERE x.rest > 1`
    );
    const restante = await unuSau(
      `SELECT COUNT(*) AS n, COALESCE(SUM(x.rest), 0) AS suma FROM (
         SELECT f.id, f.data_scadenta,
                COALESCE((SELECT SUM(fl.cantitate * fl.pret_unitar) FROM facturi_linii fl WHERE fl.factura_id = f.id), 0)
                - COALESCE((SELECT SUM(pl.suma) FROM (SELECT * FROM plati WHERE activ = 1) pl WHERE pl.factura_id = f.id), 0) AS rest
         FROM (SELECT * FROM facturi WHERE activ = 1) f WHERE f.directie = 'vanzare' AND f.status != 'anulata'
       ) x WHERE x.rest > 1 AND x.data_scadenta IS NOT NULL AND x.data_scadenta < ?`,
      zi
    );
    const dePlatit = await unuSau(
      `SELECT COUNT(*) AS n, COALESCE(SUM(x.rest), 0) AS suma FROM (
         SELECT f.id,
                COALESCE((SELECT SUM(fl.cantitate * fl.pret_unitar) FROM facturi_linii fl WHERE fl.factura_id = f.id), 0)
                - COALESCE((SELECT SUM(pl.suma) FROM (SELECT * FROM plati WHERE activ = 1) pl WHERE pl.factura_id = f.id), 0) AS rest
         FROM (SELECT * FROM facturi WHERE activ = 1) f WHERE f.directie = 'achizitie' AND f.status != 'anulata'
       ) x WHERE x.rest > 1`
    );
    const banca = await unuSau(
      "SELECT COALESCE(SUM(suma), 0) AS sold, COUNT(*) AS n, MAX(data) AS ultima FROM tranzactii_banca"
    );
    const salariiLuna = await unuSau(
      "SELECT COALESCE(SUM(salariu_net), 0) AS net, COUNT(*) AS n FROM salarii WHERE luna = ?",
      zi.slice(0, 7)
    );
    const costAgenti = await unuSau(
      `SELECT COALESCE(SUM(salariu_brut * (1 + cam_procent / 100.0) + cost_masina + cost_carburant + alte_costuri), 0) AS total,
              COUNT(*) AS n
       FROM costuri_personal c
       WHERE c.valabil_de_la = (SELECT MAX(c2.valabil_de_la) FROM costuri_personal c2 WHERE c2.utilizator_id = c.utilizator_id)`
    );

    const peLuni = await db
      .prepare(
        `SELECT SUBSTR(f.data_emiterii, 1, 7) AS luna,
                COALESCE(SUM(CASE WHEN f.directie = 'vanzare' THEN l.valoare ELSE 0 END), 0) AS vanzari,
                COALESCE(SUM(CASE WHEN f.directie = 'achizitie' THEN l.valoare ELSE 0 END), 0) AS achizitii
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN (SELECT factura_id, SUM(cantitate * pret_unitar) AS valoare FROM facturi_linii GROUP BY factura_id) l
           ON l.factura_id = f.id
         WHERE f.status != 'anulata' AND SUBSTR(f.data_emiterii, 1, 4) = ?
         GROUP BY SUBSTR(f.data_emiterii, 1, 7) ORDER BY luna`
      )
      .all(anul);

    const body = `
      ${subnavFinanciar("/financiar", ctx.user)}
      <div class="cards">
        <div class="card"><div class="label">De încasat</div><div class="value">${money(deIncasat.suma)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${Number(deIncasat.n || 0)} facturi · <a href="/scadente">scadențar</a></div></div>
        <div class="card"><div class="label">Din care restante</div><div class="value" style="color:#b3261e">${money(restante.suma)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${Number(restante.n || 0)} facturi peste scadență</div></div>
        <div class="card"><div class="label">De plătit furnizori</div><div class="value">${money(dePlatit.suma)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${Number(dePlatit.n || 0)} facturi · <a href="/facturi/achizitii">achiziții</a></div></div>
        <div class="card"><div class="label">Sold bancar (din extrase)</div><div class="value">${money(banca.sold)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${banca.ultima ? "ultima mișcare " + esc(String(banca.ultima).slice(0, 10)) : "fără extrase"} · <a href="/banca">bancă</a></div></div>
        <div class="card"><div class="label">Salarii luna curentă</div><div class="value">${money(salariiLuna.net)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${Number(salariiLuna.n || 0)} state · <a href="/salarii">salarizare</a></div></div>
        <div class="card"><div class="label">Cost company / lună</div><div class="value">${money(costAgenti.total)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${Number(costAgenti.n || 0)} persoane · <a href="/costuri">detalii</a></div></div>
      </div>
      <h2>Facturat vs. cumpărat, pe luni — ${esc(anul)}</h2>
      ${table(
        ["Luna", "Vânzări", "Achiziții", "Diferență"],
        peLuni.map((r) => [
          esc(r.luna),
          money(r.vanzari),
          money(r.achizitii),
          money(Number(r.vanzari || 0) - Number(r.achizitii || 0)),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Financiar", active: "/financiar", body }));
  });
}

module.exports = { register };
