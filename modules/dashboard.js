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

    const facturi = await db.prepare("SELECT * FROM facturi WHERE directie = 'vanzare'").all();
    let totalFacturat = 0;
    let totalIncasat = 0;
    let totalRestant = 0;
    for (const f of facturi) {
      const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(f.id);
      const { total } = calcTotals(linii);
      const platit = (await db.prepare("SELECT COALESCE(SUM(suma),0) AS s FROM plati WHERE factura_id = ?").get(f.id)).s;
      if (f.status !== "anulata") {
        totalFacturat += total;
        totalIncasat += platit;
        totalRestant += Math.max(0, total - platit);
      }
    }

    const facturiAchizitie = await db.prepare("SELECT * FROM facturi WHERE directie = 'achizitie' AND status != 'anulata'").all();
    let totalAchizitionat = 0;
    for (const f of facturiAchizitie) {
      const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(f.id);
      totalAchizitionat += calcTotals(linii).total;
    }

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
