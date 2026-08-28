"use strict";
// Decontul lunar al agentului de vânzări.
//
// Regula, așa cum a dat-o Vali (din august 2026 încolo):
//
//   1. Salariul brut vine din statele de plată din Drive — diferă de la lună
//      la lună și ARE deja comisionul în el. De-aia comisionul nu se mai scade
//      încă o dată din marjă: ar fi numărat de două ori.
//   2. Din încasările aduse de agent se scoate costul mărfii → asta e marja.
//   3. Mașina și carburantul ies tot din marjă. Cost total = brut + CAM +
//      mașină + carburant + alte.
//   4. Ce rămâne din marjă după costul lui se împarte: cât ia firma, cât ia el
//      — în lei și în procente.
//   5. Comisionul câștigat în lună:
//        • vânzări încasate (fără TVA) peste prag  → cel mai mare dintre
//          10% din marjă și 2% din vânzările încasate;
//        • sub prag                                 → 10% din marjă.
//      Dacă luna iese pe minus, minusul nu se șterge: se reportează și se
//      scade din comisionul lunii următoare.
//
// Reportul nu se ține într-un tabel, ci se recalculează de fiecare dată din
// luna de start încoace. Așa, dacă se corectează o factură veche, tot lanțul
// se îndreaptă singur — nu rămâne un sold greșit înghețat undeva.
const db = require("../lib/db");
const { esc, money, layout, table, subnavFinanciar } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const costuri = require("./costuri");

// Parametrii regulii. Se pot schimba din pagină — nu sunt bătuți în cod,
// fiindcă un prag și un procent se schimbă mai des decât o aplicație.
const IMPLICITE = {
  decont_de_la: "2026-08",
  decont_prag: "250000",
  decont_pct_marja: "10",
  decont_pct_vanzari: "2",
};

async function setare(cheie) {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(cheie);
    if (r && r.valoare !== null && r.valoare !== undefined && r.valoare !== "") return r.valoare;
  } catch (e) {
    /* tabelul poate lipsi la prima pornire */
  }
  return IMPLICITE[cheie];
}

async function scrieSetare(cheie, valoare) {
  const t = new Date().toISOString().slice(0, 19).replace("T", " ");
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(valoare, t, cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, valoare, t);
}

function lunaCurenta() {
  return new Date().toISOString().slice(0, 7);
}

function sfarsitLuna(luna) {
  const [a, l] = luna.split("-").map(Number);
  const d = new Date(Date.UTC(a, l, 0));
  return d.toISOString().slice(0, 10);
}

function lunaUrmatoare(luna) {
  const [a, l] = luna.split("-").map(Number);
  const d = new Date(Date.UTC(a, l, 1));
  return d.toISOString().slice(0, 7);
}

function luniIntre(de, pana) {
  const out = [];
  let l = de;
  for (let i = 0; i < 120 && l <= pana; i++) {
    out.push(l);
    l = lunaUrmatoare(l);
  }
  return out;
}

// Încasările lunii, pe agent, aduse la valoare FĂRĂ TVA.
//
// Plățile se fac pe total factură, cu TVA. Ca să știm cât din ele e bază de
// comision, fiecare plată se împarte în proporția netului din brutul facturii
// ei. La fel se face și cu costul mărfii: dacă s-a încasat jumătate din
// factură, intră jumătate din costul mărfii de pe ea.
async function incasariPeAgent(luna) {
  const de = `${luna}-01`;
  const pana = sfarsitLuna(luna);
  const randuri = await db
    .prepare(
      `SELECT p.agent_id AS agent_id,
              f.id AS factura_id,
              COALESCE(pl.suma, 0) AS platit,
              COALESCE(n.net, 0) AS net,
              COALESCE(b.brut, 0) AS brut,
              COALESCE(c.cost, 0) AS cost_marfa
         FROM plati pl
         JOIN facturi f ON f.id = pl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n
              ON n.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) AS brut FROM facturi_linii GROUP BY factura_id) b
              ON b.factura_id = f.id
         LEFT JOIN (SELECT fl.factura_id, SUM(fl.cantitate * COALESCE(pr.pret_achizitie, 0)) AS cost
                      FROM facturi_linii fl LEFT JOIN produse pr ON pr.id = fl.produs_id
                     GROUP BY fl.factura_id) c
              ON c.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND p.agent_id IS NOT NULL AND pl.data >= ? AND pl.data <= ?`
    )
    .all(de, pana);

  const peAgent = new Map();
  for (const r of randuri) {
    const brut = Number(r.brut) || 0;
    const net = Number(r.net) || 0;
    const platit = Number(r.platit) || 0;
    // cât din factură s-a încasat în luna asta
    const parte = brut > 0 ? Math.min(1, platit / brut) : net > 0 ? Math.min(1, platit / net) : 0;
    const incasatNet = net * parte;
    const costMarfa = (Number(r.cost_marfa) || 0) * parte;
    const a = peAgent.get(r.agent_id) || { incasat_net: 0, cost_marfa: 0, facturi: new Set(), fara_cost: 0 };
    a.incasat_net += incasatNet;
    a.cost_marfa += costMarfa;
    a.facturi.add(r.factura_id);
    if (!Number(r.cost_marfa)) a.fara_cost += incasatNet;
    peAgent.set(r.agent_id, a);
  }
  return peAgent;
}

// Ce a facturat agentul în lună — nu intră în comision, dar e bun de văzut
// alături de încasări: diferența dintre ele e ce a vândut și n-a încasat.
async function facturatPeAgent(luna) {
  const randuri = await db
    .prepare(
      `SELECT p.agent_id AS agent_id, COALESCE(SUM(n.net), 0) AS net
         FROM facturi f JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar) AS net FROM facturi_linii GROUP BY factura_id) n
              ON n.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND p.agent_id IS NOT NULL AND f.data_emiterii >= ? AND f.data_emiterii <= ?
        GROUP BY p.agent_id`
    )
    .all(`${luna}-01`, sfarsitLuna(luna));
  return new Map(randuri.map((r) => [r.agent_id, Number(r.net) || 0]));
}

// Comisionul câștigat într-o lună, după regula lui Vali.
function comisionLunar(marja, incasatNet, reguli) {
  const dinMarja = (marja * reguli.pctMarja) / 100;
  if (marja < 0) return { valoare: dinMarja, dupa: "marjă negativă" };
  if (incasatNet > reguli.prag) {
    const dinVanzari = (incasatNet * reguli.pctVanzari) / 100;
    return dinVanzari > dinMarja
      ? { valoare: dinVanzari, dupa: `${reguli.pctVanzari}% din încasări` }
      : { valoare: dinMarja, dupa: `${reguli.pctMarja}% din marjă` };
  }
  return { valoare: dinMarja, dupa: `${reguli.pctMarja}% din marjă` };
}

// Decontul complet, lună cu lună, de la data de start până la luna cerută.
// Reportul negativ se plimbă de la o lună la alta.
async function calculeaza(panaLaLuna) {
  const deLa = await setare("decont_de_la");
  const reguli = {
    prag: Number(await setare("decont_prag")) || 0,
    pctMarja: Number(await setare("decont_pct_marja")) || 0,
    pctVanzari: Number(await setare("decont_pct_vanzari")) || 0,
    deLa,
  };
  const agenti = await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
  const luni = luniIntre(deLa, panaLaLuna);
  const report = new Map(); // agent_id -> report negativ purtat mai departe
  let ultima = null;

  for (const luna of luni) {
    const incasari = await incasariPeAgent(luna);
    const facturat = await facturatPeAgent(luna);
    const costuriLuna = new Map();
    for (const c of await costuri.costuriPeLuna(luna)) costuriLuna.set(c.utilizator.id, c);

    const randuri = [];
    for (const a of agenti) {
      const inc = incasari.get(a.id) || { incasat_net: 0, cost_marfa: 0, facturi: new Set(), fara_cost: 0 };
      const c = costuriLuna.get(a.id);
      const sume = c ? c.sume : null;
      const costTotal = sume ? sume.total : 0;
      const marja = inc.incasat_net - inc.cost_marfa;
      const marjaNeta = marja - costTotal;
      const castigat = comisionLunar(marja, inc.incasat_net, reguli);
      const reportVechi = report.get(a.id) || 0;
      const cuReport = castigat.valoare + reportVechi;
      const dePlata = Math.max(0, cuReport);
      const reportNou = Math.min(0, cuReport);
      report.set(a.id, reportNou);

      randuri.push({
        agent: a,
        facturat: facturat.get(a.id) || 0,
        incasat_net: inc.incasat_net,
        cost_marfa: inc.cost_marfa,
        fara_cost: inc.fara_cost,
        nr_facturi: inc.facturi.size,
        marja,
        cost: sume,
        cost_total: costTotal,
        marja_neta: marjaNeta,
        castigat: castigat.valoare,
        dupa: castigat.dupa,
        report_vechi: reportVechi,
        de_plata: dePlata,
        report_nou: reportNou,
        // cât din marja adusă rămâne firmei și cât se duce în costul agentului
        cota_agent: marja > 0 ? (costTotal / marja) * 100 : null,
        cota_firma: marja > 0 ? (marjaNeta / marja) * 100 : null,
        // cât din încasări vin de pe facturi la care ȘTIM costul mărfii
        acoperire: inc.incasat_net > 0 ? ((inc.incasat_net - inc.fara_cost) / inc.incasat_net) * 100 : null,
      });
    }
    ultima = { luna, randuri };
  }

  return { reguli, luni, ultima: ultima || { luna: panaLaLuna, randuri: [] } };
}

function procent(v) {
  return v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}

function register(router) {
  router.get("/costuri/decont", async (ctx) => {
    if (!ctx.user || !["admin", "financiar"].includes(ctx.user.rol)) return redirect(ctx.res, "/");
    const luna = /^\d{4}-\d{2}$/.test(String(ctx.query.luna || "")) ? String(ctx.query.luna) : lunaCurenta();
    const { reguli, ultima } = await calculeaza(luna);
    const randuri = ultima.randuri.filter((r) => r.incasat_net > 0 || r.cost_total > 0 || r.report_vechi < 0);

    const totalMarja = randuri.reduce((s, r) => s + r.marja, 0);
    const totalCost = randuri.reduce((s, r) => s + r.cost_total, 0);
    const totalComision = randuri.reduce((s, r) => s + r.de_plata, 0);
    const faraCost = randuri.reduce((s, r) => s + r.fara_cost, 0);
    const totalIncasat = randuri.reduce((s, r) => s + r.incasat_net, 0);
    const acoperireTotala = totalIncasat > 0 ? ((totalIncasat - faraCost) / totalIncasat) * 100 : null;

    const body = `
      ${subnavFinanciar("/costuri", ctx.user)}
      <div class="toolbar" style="gap:10px;flex-wrap:wrap">
        <form method="get" action="/costuri/decont" class="inline-form">
          <label class="field" style="margin:0"><span style="font-size:12px">Luna</span>
            <input type="month" name="luna" value="${esc(luna)}" onchange="this.form.submit()">
          </label>
        </form>
        <a class="btn secondary" href="/costuri">Cost company</a>
      </div>

      <p style="max-width:820px;color:var(--text-muted)">
        Din încasările aduse de agent se scade costul mărfii — asta e marja. Din marjă ies mașina, carburantul și
        salariul lui. Salariul brut vine din statele de plată și are deja comisionul în el, de-aia comisionul nu se
        mai scade încă o dată. Comisionul din tabel e cel <strong>câștigat în luna asta</strong> — el se plătește
        mai departe, prin salariul unei luni următoare.
      </p>

      ${
        acoperireTotala !== null && acoperireTotala < 95
          ? `<div class="detail-box" style="border-left:4px solid #b3261e;margin-bottom:14px">
               <strong>Marja de mai jos nu e încă marjă adevărată.</strong>
               ${money(faraCost)} din ${money(totalIncasat)} încasați vin de pe facturi la care nu știm costul mărfii
               (acoperire ${acoperireTotala.toFixed(0)}%), așa că acolo marja iese egală cu încasarea, iar comisionul
               calculat pe ea e prea mare. Se îndreaptă singur pe măsură ce intră costurile de achiziție —
               vezi <a href="/rapoarte/produse-fara-cost">produsele fără cost</a>.
             </div>`
          : ""
      }
      <div class="cards">
        <div class="card"><div class="label">Marjă adusă în ${esc(luna)}</div><div class="value">${money(totalMarja)}</div>
          ${acoperireTotala !== null && acoperireTotala < 95 ? `<div style="font-size:12px;color:#b3261e">estimare — cost marfă cunoscut pe ${acoperireTotala.toFixed(0)}% din încasări</div>` : ""}</div>
        <div class="card"><div class="label">Cost cu agenții</div><div class="value">${money(totalCost)}</div>
          <div style="font-size:12px;color:var(--text-muted)">brut + CAM + mașină + carburant</div></div>
        <div class="card"><div class="label">Rămâne firmei</div>
          <div class="value" style="color:${totalMarja - totalCost >= 0 ? "var(--success)" : "var(--danger)"}">${money(totalMarja - totalCost)}</div></div>
        <div class="card"><div class="label">Comision câștigat</div><div class="value">${money(totalComision)}</div>
          <div style="font-size:12px;color:var(--text-muted)">peste ${money(reguli.prag)}: max(${reguli.pctMarja}% marjă, ${reguli.pctVanzari}% încasări)</div></div>
      </div>

      ${table(
        ["Agent", "Facturat", "Încasat (fără TVA)", "Cost marfă", "Marjă", "Cost agent", "Rămâne firmei", "Firma / agentul", "Comision câștigat", "Report", "De plată"],
        randuri.map((r) => [
          `${esc(r.agent.nume)}<br><span style="font-size:12px;color:var(--text-muted)">${esc(r.agent.rol === "vanzari" ? "agent vânzări" : r.agent.rol)}</span>`,
          money(r.facturat),
          `${money(r.incasat_net)}<br><span style="font-size:12px;color:var(--text-muted)">${r.nr_facturi} facturi</span>`,
          `${money(r.cost_marfa)}${
            r.acoperire !== null && r.acoperire < 95
              ? `<br><span style="font-size:12px;color:#b3261e">cunoscut pe ${r.acoperire.toFixed(0)}%</span>`
              : ""
          }`,
          `<strong>${money(r.marja)}</strong>${r.acoperire !== null && r.acoperire < 95 ? '<br><span style="font-size:12px;color:#b3261e">estimare</span>' : ""}`,
          `${money(r.cost_total)}${r.cost ? `<br><span style="font-size:12px;color:var(--text-muted)">brut ${money(r.cost.brut)} · mașină ${money(r.cost.masina)} · carburant ${money(r.cost.carburant)}</span>` : '<br><span class="badge gri">fără cost definit</span>'}`,
          `<span style="color:${r.marja_neta >= 0 ? "var(--success)" : "var(--danger)"}">${money(r.marja_neta)}</span>`,
          `${procent(r.cota_firma)} / ${procent(r.cota_agent)}`,
          `${money(r.castigat)}<br><span style="font-size:12px;color:var(--text-muted)">${esc(r.dupa)}</span>`,
          r.report_vechi < 0 ? `<span style="color:var(--danger)">${money(r.report_vechi)}</span>` : "—",
          `<strong${r.acoperire !== null && r.acoperire < 95 ? ' style="color:#b3261e"' : ""}>${money(r.de_plata)}</strong>${
            r.report_nou < 0 ? `<br><span style="font-size:12px;color:var(--danger)">rămâne ${money(r.report_nou)} pentru luna viitoare</span>` : ""
          }`,
        ])
      )}

      ${
        ctx.user.rol === "admin"
          ? `<details style="margin-top:16px">
               <summary style="cursor:pointer;color:var(--text-muted)">Regula de comision</summary>
               <form method="post" action="/costuri/decont/reguli" class="form" style="max-width:640px;margin-top:10px">
                 <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                   <label class="field"><span>Se aplică din luna</span><input type="month" name="decont_de_la" value="${esc(reguli.deLa)}"></label>
                   <label class="field"><span>Prag vânzări încasate / lună (lei, fără TVA)</span><input type="number" step="1" name="decont_prag" value="${esc(String(reguli.prag))}"></label>
                 </div>
                 <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                   <label class="field"><span>Procent din marjă</span><input type="number" step="0.1" name="decont_pct_marja" value="${esc(String(reguli.pctMarja))}"></label>
                   <label class="field"><span>Procent din încasări, peste prag</span><input type="number" step="0.1" name="decont_pct_vanzari" value="${esc(String(reguli.pctVanzari))}"></label>
                 </div>
                 <div class="form-actions"><button class="btn" type="submit">Salvează regula</button></div>
               </form>
             </details>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Decont agenți — ${luna}`, active: "/costuri", body }));
  });

  router.post("/costuri/decont/reguli", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/costuri/decont");
    const b = ctx.body || {};
    if (/^\d{4}-\d{2}$/.test(String(b.decont_de_la || ""))) await scrieSetare("decont_de_la", String(b.decont_de_la));
    for (const k of ["decont_prag", "decont_pct_marja", "decont_pct_vanzari"]) {
      const v = Number(String(b[k] ?? "").replace(",", "."));
      if (Number.isFinite(v)) await scrieSetare(k, String(v));
    }
    redirect(ctx.res, "/costuri/decont");
  });
}

module.exports = { register, calculeaza, comisionLunar };
