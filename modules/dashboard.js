"use strict";
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send } = require("../lib/router");
const { calcTotals, STATUS_LABEL: FACTURA_STATUS } = require("./facturi");
const { STATUS_LABEL: COMANDA_STATUS } = require("./comenzi");

function register(router) {
  router.get("/", async (ctx) => {
    const nrParteneri = (await db.prepare("SELECT COUNT(*) AS n FROM parteneri").get()).n;
    const nrProduse = (await db.prepare("SELECT COUNT(*) AS n FROM produse").get()).n;
    const nrAngajati = (await db.prepare("SELECT COUNT(*) AS n FROM angajati").get()).n;

    // Totalurile se calculează din DOUĂ interogări agregate, nu prin
    // parcurgerea facturilor una câte una. Cu un istoric real importat din
    // SmartBill (mii de facturi) varianta rând-cu-rând însemna mii de
    // interogări per încărcare de dashboard — câteva secunde de așteptare.
    const totaluri = await db
      .prepare(
        `SELECT f.directie,
                COALESCE(SUM(l.total), 0) AS facturat,
                COALESCE(SUM(pl.platit), 0) AS incasat,
                COALESCE(SUM(GREATEST(COALESCE(l.total,0) - COALESCE(pl.platit,0), 0)), 0) AS restant
         FROM facturi f
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id) pl ON pl.factura_id = f.id
         WHERE f.status <> 'anulata'
         GROUP BY f.directie`
      )
      .all();
    const vanzari = totaluri.find((t) => t.directie === "vanzare") || {};
    const achizitii = totaluri.find((t) => t.directie === "achizitie") || {};
    const totalFacturat = Number(vanzari.facturat || 0);
    const totalIncasat = Number(vanzari.incasat || 0);
    const totalRestant = Number(vanzari.restant || 0);
    const totalAchizitionat = Number(achizitii.facturat || 0);

    const produseSubStoc = await db
      .prepare(
        `SELECT p.denumire, p.stoc_minim,
                COALESCE(SUM(CASE WHEN m.tip='intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS stoc
         FROM produse p LEFT JOIN miscari_stoc m ON m.produs_id = p.id
         GROUP BY p.id, p.denumire, p.stoc_minim HAVING COALESCE(SUM(CASE WHEN m.tip='intrare' THEN m.cantitate ELSE -m.cantitate END), 0) <= p.stoc_minim AND p.stoc_minim > 0`
      )
      .all();

    const ultimeleComenzi = await db
      .prepare(
        `SELECT c.id, c.numar, c.status, c.data, p.nume AS partener_nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id ORDER BY c.id DESC LIMIT 5`
      )
      .all();

    const lunaCurenta = new Date().toISOString().slice(0, 7);
    const cheltuieliSalariale = (
      await db.prepare("SELECT COALESCE(SUM(salariu_net + cas + cass + impozit),0) AS s FROM salarii WHERE luna = ?").get(lunaCurenta)
    ).s;

    const body = `
      <div class="cards">
        <div class="card"><div class="label">Parteneri</div><div class="value">${nrParteneri}</div></div>
        <div class="card"><div class="label">Produse</div><div class="value">${nrProduse}</div></div>
        <div class="card"><div class="label">Angajați</div><div class="value">${nrAngajati}</div></div>
        <div class="card"><div class="label">Facturat (nete de anulate)</div><div class="value">${money(totalFacturat)}</div></div>
        <div class="card"><div class="label">Încasat</div><div class="value">${money(totalIncasat)}</div></div>
        <div class="card"><div class="label">Restant de încasat</div><div class="value">${money(totalRestant)}</div></div>
        <div class="card"><div class="label">Achiziționat (facturi furnizori)</div><div class="value">${money(totalAchizitionat)}</div></div>
        <div class="card"><div class="label">Cost salarial lună curentă</div><div class="value">${money(cheltuieliSalariale)}</div></div>
      </div>
      <div class="toolbar"><a href="/rapoarte" class="btn secondary small">Vezi rapoarte detaliate →</a></div>

      <h2>Produse sub stocul minim</h2>
      ${
        produseSubStoc.length
          ? table(
              ["Produs", "Stoc curent", "Stoc minim"],
              produseSubStoc.map((p) => [esc(p.denumire), p.stoc, p.stoc_minim])
            )
          : "<p>Niciun produs sub stocul minim.</p>"
      }

      <h2>Ultimele comenzi</h2>
      ${
        ultimeleComenzi.length
          ? table(
              ["Nr.", "Client", "Data", "Status"],
              ultimeleComenzi.map((c) => [
                `<a href="/comenzi/${c.id}">${esc(c.numar || "#" + c.id)}</a>`,
                esc(c.partener_nume),
                esc(c.data),
                COMANDA_STATUS[c.status] || esc(c.status),
              ])
            )
          : "<p>Nicio comandă încă.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Dashboard", active: "/", body }));
  });
}

module.exports = { register };
