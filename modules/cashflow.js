"use strict";
// Cash flow la zi + proiecție.
//
// Trei straturi, combinate transparent:
//   1. POZIȚIA DE CASH — soldul conturilor de trezorerie (5121, 5124, 5311…)
//      din balanța ancorată pe Conta + mișcările ERP de după ancoră. Fără
//      ancoră, arătăm doar fluxurile (intrări/ieșiri), nu soldul absolut —
//      un sold inventat e mai rău decât unul lipsă.
//   2. ISTORICUL — încasările și plățile reale, pe luni.
//   3. PROIECȚIA — facturile deschise puse pe scadență (încasări de la
//      clienți, plăți către furnizori) + intrările MANUALE de forecast
//      (chirii, rate, salarii, taxe, încasări promise), inclusiv recurente
//      lunar. Sold zi cu zi înainte.
const db = require("../lib/db");
const conta = require("../lib/contabilitate");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id)";
const CONTURI_CASH = ["5121", "5124", "5125", "5311", "5314", "541", "542"];

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function plusZile(bazaStr, zile) {
  const d = new Date(bazaStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + zile);
  return d.toISOString().slice(0, 10);
}
function plusLuni(bazaStr, luni) {
  const d = new Date(bazaStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + luni);
  return d.toISOString().slice(0, 10);
}

function register(router) {
  router.get("/rapoarte/cashflow", async (ctx) => {
    const aziStr = azi();
    const zile = Math.min(120, Math.max(14, parseInt(ctx.query.zile || "30", 10) || 30));
    const pana = plusZile(aziStr, zile);

    // --- 1. Poziția de cash -------------------------------------------------
    const ancora = await conta.ancoraSolduri();
    let soldCash = null;
    if (ancora) {
      const ph = CONTURI_CASH.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS net
           FROM inregistrari_contabile
           WHERE cont IN (${ph}) AND (sursa <> 'auto' OR data > ?)`
        )
        .get(...CONTURI_CASH, ancora);
      soldCash = conta.BANI(Number(r.net || 0));
    }

    // --- 2. Istoric lunar ---------------------------------------------------
    const istoric = await db
      .prepare(
        `SELECT SUBSTR(pl.data, 1, 7) AS luna,
                SUM(CASE WHEN f.directie = 'vanzare' THEN pl.suma ELSE 0 END) AS intrari,
                SUM(CASE WHEN f.directie = 'achizitie' THEN pl.suma ELSE 0 END) AS iesiri
         FROM plati pl JOIN facturi f ON f.id = pl.factura_id
         WHERE f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0
         GROUP BY SUBSTR(pl.data, 1, 7)
         ORDER BY luna DESC LIMIT 12`
      )
      .all();

    // --- 3. Proiecția pe zile -----------------------------------------------
    const facturiDeschise = await db
      .prepare(
        `SELECT f.directie, f.data_scadenta, f.document_extern, f.serie, f.numar,
                p.nume AS partener_nume, COALESCE(l.total,0) - COALESCE(pl.platit,0) AS rest
         FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0 AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5`
      )
      .all();

    const manuale = await db.prepare("SELECT * FROM cashflow_manual ORDER BY data ASC").all();

    // Construim evenimentele pe zile în orizont. Facturile cu scadența deja
    // depășită se pun pe „azi" (banii sunt exigibili acum, nu în trecut).
    const evenimente = [];
    for (const f of facturiDeschise) {
      let scad = (f.data_scadenta || "").slice(0, 10);
      if (!scad) continue; // fără scadență — nu putem proiecta cinstit
      if (scad < aziStr) scad = aziStr;
      if (scad > pana) continue;
      const suma = f.directie === "vanzare" ? Number(f.rest) : -Number(f.rest);
      evenimente.push({ zi: scad, suma, ce: `${f.directie === "vanzare" ? "Încasare" : "Plată"} ${f.document_extern || `${f.serie}-${f.numar}`} — ${f.partener_nume}`, sursa: "facturi" });
    }
    for (const m of manuale) {
      const semn = m.tip === "intrare" ? 1 : -1;
      if (m.recurent_lunar) {
        const limita = m.pana_la && m.pana_la <= pana ? m.pana_la : pana;
        for (let k = 0; k < 24; k++) {
          const zi = plusLuni(m.data, k);
          if (zi > limita) break;
          if (zi < aziStr) continue;
          evenimente.push({ zi, suma: semn * Number(m.suma), ce: `${m.descriere} (lunar)`, sursa: "manual", id: m.id });
        }
      } else {
        if (m.data >= aziStr && m.data <= pana) evenimente.push({ zi: m.data, suma: semn * Number(m.suma), ce: m.descriere, sursa: "manual", id: m.id });
      }
    }

    const peZi = new Map();
    for (const e of evenimente) {
      if (!peZi.has(e.zi)) peZi.set(e.zi, { zi: e.zi, intrari: 0, iesiri: 0, detalii: [] });
      const g = peZi.get(e.zi);
      if (e.suma >= 0) g.intrari += e.suma;
      else g.iesiri += -e.suma;
      g.detalii.push(e);
    }
    const zileOrd = [...peZi.values()].sort((a, b) => (a.zi < b.zi ? -1 : 1));
    let sold = soldCash;
    for (const z of zileOrd) {
      z.net = conta.BANI(z.intrari - z.iesiri);
      if (sold !== null) {
        sold = conta.BANI(sold + z.net);
        z.soldDupa = sold;
      }
    }
    const totalIntrari = zileOrd.reduce((s, z) => s + z.intrari, 0);
    const totalIesiri = zileOrd.reduce((s, z) => s + z.iesiri, 0);
    const primaZiNegativa = soldCash !== null ? zileOrd.find((z) => z.soldDupa < 0) : null;

    const optiuni = [14, 30, 60, 90, 120].map((z) => `<option value="${z}"${zile === z ? " selected" : ""}>următoarele ${z} de zile</option>`).join("");

    const body = `
      <div class="subnav">
        <a href="/rapoarte" class="subnav-link">Toate rapoartele</a>
        <a href="/rapoarte/cashflow" class="subnav-link activ">Cash flow</a>
        <a href="/rapoarte/incasari" class="subnav-link">Scadențar încasări</a>
        <a href="/banca" class="subnav-link">Bancă</a>
      </div>

      <div class="cards">
        ${
          soldCash !== null
            ? `<div class="card"><div class="label">Cash disponibil azi (bancă + casă)</div><div class="value" style="color:${soldCash >= 0 ? "inherit" : "var(--danger)"}">${money(soldCash)}</div></div>`
            : `<div class="card"><div class="label">Cash disponibil azi</div><div class="value" style="font-size:14px;color:var(--text-muted)">necunoscut — <a href="/rapoarte/balanta/solduri-initiale">preia soldurile din balanța Conta</a></div></div>`
        }
        <div class="card"><div class="label">Intrări așteptate (${zile} zile)</div><div class="value" style="color:var(--success)">${money(totalIntrari)}</div></div>
        <div class="card"><div class="label">Ieșiri așteptate (${zile} zile)</div><div class="value" style="color:var(--danger)">${money(totalIesiri)}</div></div>
        <div class="card"><div class="label">Net pe orizont</div><div class="value">${money(totalIntrari - totalIesiri)}</div></div>
      </div>

      ${
        primaZiNegativa
          ? `<div class="flash" style="background:#f8e5e3;border-color:#e8bdb8;color:var(--danger)"><strong>Atenție:</strong> pe ${esc(primaZiNegativa.zi)} soldul proiectat scade sub zero (${money(primaZiNegativa.soldDupa)}). Mută plăți sau accelerează încasările dinainte de ziua aia.</div>`
          : ""
      }

      <form class="filtre" method="get" action="/rapoarte/cashflow">
        <select name="zile" onchange="this.form.submit()">${optiuni}</select>
      </form>

      <h2>Proiecția zi cu zi</h2>
      ${
        zileOrd.length
          ? table(
              ["Ziua", "Intrări", "Ieșiri", "Net", soldCash !== null ? "Sold după" : "", "Ce se întâmplă"].filter(Boolean),
              zileOrd.map((z) =>
                [
                  esc(z.zi) + (z.zi === aziStr ? ' <span class="badge galben">azi</span>' : ""),
                  z.intrari ? `<span style="color:var(--success)">${money(z.intrari)}</span>` : "",
                  z.iesiri ? `<span style="color:var(--danger)">−${money(z.iesiri)}</span>` : "",
                  money(z.net),
                  soldCash !== null ? `<strong style="color:${z.soldDupa >= 0 ? "inherit" : "var(--danger)"}">${money(z.soldDupa)}</strong>` : null,
                  `<span style="font-size:12px;color:var(--text-muted)">${z.detalii
                    .slice(0, 4)
                    .map((d) => esc(d.ce))
                    .join("; ")}${z.detalii.length > 4 ? ` +${z.detalii.length - 4} altele` : ""}</span>`,
                ].filter((x) => x !== null)
              )
            )
          : "<p>Nimic programat pe orizontul ales.</p>"
      }
      <p style="font-size:12px;color:var(--text-muted)">Facturile cu scadența deja depășită sunt puse pe „azi" (exigibile acum). Facturile fără scadență nu intră în proiecție — completează-le scadența din <a href="/rapoarte/incasari">scadențar</a>.</p>

      <h2>Adaugă în forecast (ce nu e în facturi)</h2>
      <form class="form" method="post" action="/rapoarte/cashflow/manual">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
          <label class="field">Tip
            <select name="tip"><option value="iesire">Ieșire (plată)</option><option value="intrare">Intrare (încasare)</option></select>
          </label>
          <label class="field">Suma (lei)<input type="number" step="0.01" name="suma" required></label>
          <label class="field">Data<input type="date" name="data" required value="${esc(aziStr)}"></label>
        </div>
        <label class="field">Descriere<input name="descriere" required placeholder="Ex: Chirie depozit / Rată leasing / Salarii / TVA de plată"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="recurent_lunar" value="1"> se repetă lunar</label>
          <label class="field">Până la (pentru recurente)<input type="date" name="pana_la"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Adaugă în forecast</button></div>
      </form>

      <h2>Intrările manuale existente</h2>
      ${
        manuale.length
          ? table(
              ["Data", "Tip", "Suma", "Descriere", "Recurență", ""],
              manuale.map((m) => [
                esc(m.data),
                m.tip === "intrare" ? '<span class="badge verde">intrare</span>' : '<span class="badge rosu">ieșire</span>',
                money(m.suma),
                esc(m.descriere),
                m.recurent_lunar ? `lunar${m.pana_la ? " până la " + esc(m.pana_la) : ""}` : "o singură dată",
                `<form method="post" action="/rapoarte/cashflow/manual/${m.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi intrarea din forecast?')"><button class="link-btn danger" type="submit">Șterge</button></form>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Nimic adăugat manual încă — proiecția folosește doar facturile.</p>'
      }

      <h2>Istoric — încasări vs. plăți pe luni (bani reali mișcați)</h2>
      ${table(
        ["Luna", "Încasări", "Plăți", "Net"],
        istoric.map((l) => [esc(l.luna), money(l.intrari), money(l.iesiri), money(Number(l.intrari) - Number(l.iesiri))])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cash flow la zi", active: "/rapoarte", body }));
  });

  router.post("/rapoarte/cashflow/manual", async (ctx) => {
    const b = ctx.body;
    const suma = Math.abs(Number(String(b.suma || "").replace(",", ".")) || 0);
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(b.data || "")) ? String(b.data) : null;
    if (suma > 0 && data && String(b.descriere || "").trim()) {
      await db
        .prepare("INSERT INTO cashflow_manual (tip, suma, data, descriere, recurent_lunar, pana_la, creat_de) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          b.tip === "intrare" ? "intrare" : "iesire",
          suma,
          data,
          String(b.descriere).trim(),
          b.recurent_lunar ? 1 : 0,
          /^\d{4}-\d{2}-\d{2}$/.test(String(b.pana_la || "")) ? String(b.pana_la) : null,
          ctx.user ? ctx.user.id : null
        );
    }
    redirect(ctx.res, "/rapoarte/cashflow");
  });

  router.post("/rapoarte/cashflow/manual/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM cashflow_manual WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/rapoarte/cashflow");
  });
}

module.exports = { register };
