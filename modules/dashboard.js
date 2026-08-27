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
                COALESCE(SUM(CASE WHEN f.status <> 'necunoscut' THEN GREATEST(COALESCE(l.total,0) - COALESCE(pl.platit,0), 0) ELSE 0 END), 0) AS restant
         FROM facturi f
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id) pl ON pl.factura_id = f.id
         WHERE f.status <> 'anulata' AND f.intercompany = 0
         GROUP BY f.directie`
      )
      .all();
    const vanzari = totaluri.find((t) => t.directie === "vanzare") || {};
    const achizitii = totaluri.find((t) => t.directie === "achizitie") || {};
    const totalFacturat = Number(vanzari.facturat || 0);
    const totalIncasat = Number(vanzari.incasat || 0);
    const totalRestant = Number(vanzari.restant || 0);
    const totalAchizitionat = Number(achizitii.facturat || 0);

    // ---- Comisionul meu (agenți de vânzări) -------------------------------
    // Baza: facturile clienților alocați agentului, ÎNCASATE în luna aleasă
    // (implicit luna curentă), pe tot grupul, fără facturile interne.
    // Comisionul se plătește la banii intrați, nu la cei facturați.
    const lunaAleasa = /^\d{4}-\d{2}$/.test(String(ctx.query.luna || "")) ? String(ctx.query.luna) : new Date().toISOString().slice(0, 7);
    const lunaAnterioara = (() => {
      const d = new Date(lunaAleasa + "-01T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    const lunaCurentaStr = new Date().toISOString().slice(0, 7);
    const lunaPrecedentaStr = (() => {
      const d = new Date(lunaCurentaStr + "-01T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();

    const esteAgent = ctx.user && (ctx.user.rol === "vanzari" || ctx.user.rol === "admin");
    let widgetComision = "";
    if (esteAgent) {
      const pctAgent = Number(ctx.user.comision_procent ?? 2) || 0;
      // toți agenții (admin vede tot, agentul vede doar linia lui)
      const incasariPeAgent = await db
        .prepare(
          `SELECT p.agent_id AS agent, u.nume AS agent_nume, COALESCE(u.comision_procent,2) AS pct,
                  COALESCE(SUM(pl.suma),0) AS incasat, COUNT(DISTINCT f.id) AS nr_facturi, COUNT(DISTINCT p.id) AS nr_clienti
           FROM plati pl
           JOIN facturi f ON f.id = pl.factura_id
           JOIN parteneri p ON p.id = f.partener_id
           JOIN utilizatori u ON u.id = p.agent_id
           WHERE f.directie='vanzare' AND f.status <> 'anulata' AND f.intercompany = 0
             AND SUBSTR(pl.data,1,7) = ?
           GROUP BY p.agent_id, u.nume, u.comision_procent
           ORDER BY incasat DESC`
        )
        .all(lunaAleasa);

      const linii = (ctx.user.rol === "admin" ? incasariPeAgent : incasariPeAgent.filter((r) => r.agent === ctx.user.id)).map((r) => ({
        ...r,
        incasat: Number(r.incasat),
        comision: (Number(r.incasat) * Number(r.pct)) / 100,
      }));
      const alMeu = incasariPeAgent.find((r) => r.agent === (ctx.user && ctx.user.id));
      const comisionulMeu = alMeu ? (Number(alMeu.incasat) * Number(alMeu.pct)) / 100 : 0;
      const incasatulMeu = alMeu ? Number(alMeu.incasat) : 0;
      const maxIncasat = Math.max(1, ...linii.map((l) => l.incasat));
      const totalComisioane = linii.reduce((s, l) => s + l.comision, 0);

      // evoluția ultimelor 6 luni pentru agentul curent (grafic)
      const evolutie = await db
        .prepare(
          `SELECT SUBSTR(pl.data,1,7) AS luna, COALESCE(SUM(pl.suma),0) AS incasat
           FROM plati pl JOIN facturi f ON f.id=pl.factura_id JOIN parteneri p ON p.id=f.partener_id
           WHERE f.directie='vanzare' AND f.status <> 'anulata' AND f.intercompany = 0 AND p.agent_id = ?
           GROUP BY SUBSTR(pl.data,1,7) ORDER BY luna DESC LIMIT 6`
        )
        .all(ctx.user.id);
      const evolutieOrd = evolutie.slice().reverse();
      const maxEvo = Math.max(1, ...evolutieOrd.map((e) => Number(e.incasat)));

      widgetComision = `
      <section class="comision-box">
        <div class="comision-head">
          <h2 style="margin:0">Comisionul meu</h2>
          <form method="get" action="/" class="comision-filtru">
            <select name="luna" onchange="this.form.submit()">
              <option value="${lunaCurentaStr}"${lunaAleasa === lunaCurentaStr ? " selected" : ""}>luna curentă (${lunaCurentaStr})</option>
              <option value="${lunaPrecedentaStr}"${lunaAleasa === lunaPrecedentaStr ? " selected" : ""}>luna anterioară (${lunaPrecedentaStr})</option>
            </select>
          </form>
        </div>

        <div class="comision-grid">
          <div class="comision-mare">
            <div class="label">De încasat ca și comision</div>
            <div class="suma">${money(comisionulMeu)}</div>
            <div class="sub">${(Number(alMeu ? alMeu.pct : pctAgent)).toFixed(1)}% din ${money(incasatulMeu)} încasați în ${esc(lunaAleasa)}
              ${alMeu ? ` · ${alMeu.nr_facturi} facturi · ${alMeu.nr_clienti} clienți` : ""}</div>
          </div>
          <div class="comision-evolutie">
            <div class="label">Evoluția încasărilor mele (6 luni)</div>
            <div class="mini-chart">
              ${
                evolutieOrd.length
                  ? evolutieOrd
                      .map(
                        (e) => `<div class="mini-bar" title="${esc(e.luna)}: ${money(e.incasat)}">
                          <div class="mini-fill" style="height:${Math.max(4, (Number(e.incasat) / maxEvo) * 100)}%"></div>
                          <div class="mini-eticheta">${esc(e.luna.slice(5))}</div>
                        </div>`
                      )
                      .join("")
                  : '<span style="color:var(--text-muted);font-size:12px">încă fără încasări înregistrate</span>'
              }
            </div>
          </div>
        </div>

        ${
          ctx.user.rol === "admin" && linii.length
            ? `<h3 style="font-size:14px;margin:18px 0 8px">Toți agenții — ${esc(lunaAleasa)} (total de plată: ${money(totalComisioane)})</h3>
               <div class="comision-agenti">
                 ${linii
                   .map(
                     (l) => `<div class="agent-rand">
                       <div class="agent-nume">${esc(l.agent_nume)}</div>
                       <div class="agent-bara"><div class="agent-fill" style="width:${(l.incasat / maxIncasat) * 100}%"></div></div>
                       <div class="agent-cifre"><strong>${money(l.comision)}</strong><span>din ${money(l.incasat)} · ${Number(l.pct).toFixed(1)}%</span></div>
                     </div>`
                   )
                   .join("")}
               </div>`
            : ""
        }
        ${
          !linii.length
            ? `<p style="font-size:12px;color:var(--text-muted);margin-top:12px">Nicio încasare atribuită unui agent în ${esc(lunaAleasa)}. Comisionul se calculează pe clienții alocați fiecărui agent — alocarea se face din pagina fiecărui client sau la import.</p>`
            : ""
        }
        <p style="font-size:12px;color:var(--text-muted);margin-top:10px">
          Se numără banii <strong>efectiv încasați</strong> în luna aleasă, pe tot grupul, fără facturile dintre firmele grupului.
          Procentul se poate schimba per agent din <a href="/admin/utilizatori">Utilizatori</a>.
        </p>
      </section>
      `;
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
      ${widgetComision}
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
