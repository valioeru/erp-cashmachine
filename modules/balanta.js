"use strict";
// Balanța de verificare — raport contabil real, în Rapoarte → Financiare.
//
// Cum funcționează: documentele din ERP (facturi, încasări, plăți, salarii)
// sunt traduse automat în note contabile pe planul de conturi românesc
// (lib/contabilitate.js). Regenerarea rulează automat la deschiderea
// raportului dacă au apărut documente noi de la ultima rulare — deci balanța
// e mereu „la zi" fără să apeși nimic.
const db = require("../lib/db");
const conta = require("../lib/contabilitate");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { parseFisier, normalizeHeader, parseNumar } = require("../lib/import-utils");

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function inceputAn() {
  return new Date().getFullYear() + "-01-01";
}

// Regenerăm doar dacă s-au schimbat documentele de la ultima rulare — numărul
// de facturi+plăți+salarii e un proxy suficient și ieftin.
async function regenereazaDacaENevoie() {
  const contor =
    Number((await db.prepare("SELECT COUNT(*) AS n FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE status NOT IN ('anulata','ciorna')").get()).n) * 1000000 +
    Number((await db.prepare("SELECT COUNT(*) AS n FROM plati").get()).n) * 1000 +
    Number((await db.prepare("SELECT COUNT(*) AS n FROM salarii").get()).n);
  const ultima = await db.prepare("SELECT documente FROM contabilitate_rulari ORDER BY id DESC LIMIT 1").get();
  const contorFacturi = Number((await db.prepare("SELECT COUNT(*) AS n FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE status NOT IN ('anulata','ciorna')").get()).n);
  const contorPlati = Number((await db.prepare("SELECT COUNT(*) AS n FROM plati").get()).n);
  const contorSalarii = Number((await db.prepare("SELECT COUNT(*) AS n FROM salarii").get()).n);
  const documenteAcum = contorFacturi + contorPlati + contorSalarii;
  if (!ultima || Number(ultima.documente) !== documenteAcum) {
    await conta.regenereaza("auto-la-deschidere");
    return true;
  }
  return false;
}

function nrRo(x) {
  const v = Number(x) || 0;
  if (v === 0) return '<span class="zero">0,00</span>';
  return v.toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Parser pentru balanța exportată din SmartBill Conta (XLS/CSV).
// Formatul real: câteva rânduri de antet (firmă, CIF, „Perioada: dd/mm/yyyy -
// dd/mm/yyyy"), apoi antetul tabelului pe DOUĂ rânduri („Contul | Descrierea
// contului | Solduri initiale an | Rulaje perioada | Total sume | Solduri
// finale" + „Debitoare | Creditoare" × 4), apoi conturile și totalurile pe
// clase. Verificat pe balanțele reale Cash Machine (2023, 2024, 2025, iul 2026).
function parseBalantaConta(rows) {
  let randContul = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    if (normalizeHeader(rows[i] && rows[i][0]) === "contul") {
      randContul = i;
      break;
    }
  }
  if (randContul === -1) return { eroare: "Nu am găsit antetul 'Contul' — e o balanță exportată din SmartBill Conta?" };

  let deLa = null;
  let panaLa = null;
  for (let i = 0; i < randContul; i++) {
    for (const cel of rows[i] || []) {
      const m = String(cel || "").match(/Perioada:\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/i);
      if (m) {
        deLa = `${m[3]}-${m[2]}-${m[1]}`;
        panaLa = `${m[6]}-${m[5]}-${m[4]}`;
      }
    }
  }

  const conturi = [];
  for (let r = randContul + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const brut = String(row[0] || "").trim();
    if (!/^\d/.test(brut)) continue; // sare „Debitoare/Creditoare", „Total clasa X", totalul general
    const simbol = brut.replace(/[^0-9.]/g, "");
    if (!/^\d{3,4}(\.\d+)?$/.test(simbol)) continue;
    const n = (i) => parseNumar(row[i]);
    conturi.push({
      cont: simbol,
      denumire: String(row[1] || "").trim(),
      siD: n(2), siC: n(3),
      rD: n(4), rC: n(5),
      tsD: n(6), tsC: n(7),
      sfD: n(8), sfC: n(9),
    });
  }
  if (!conturi.length) return { eroare: "Am găsit antetul, dar niciun rând de cont — verifică fișierul." };

  const tot = conturi.reduce((a, c) => ({ sfD: a.sfD + c.sfD, sfC: a.sfC + c.sfC }), { sfD: 0, sfC: 0 });
  return { conturi, deLa, panaLa, totalSfD: conta.BANI(tot.sfD), totalSfC: conta.BANI(tot.sfC) };
}

// Salvează balanța și ca „snapshot" istoric — sursa indicatorilor bancari
// reali și a comparațiilor multi-an. Aceeași etichetă = înlocuire.
async function salveazaSnapshot(eticheta, parsat, fisier) {
  await db.prepare("DELETE FROM balante_snapshot WHERE eticheta = ?").run(eticheta);
  const linii = parsat.conturi;
  for (let i = 0; i < linii.length; i += 100) {
    const lot = linii.slice(i, i + 100);
    const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const args = [];
    for (const c of lot) args.push(eticheta, parsat.deLa, parsat.panaLa, c.cont, c.denumire, c.siD, c.siC, c.rD, c.rC, c.tsD, c.tsC, c.sfD, c.sfC, fisier || null);
    await db
      .prepare(
        `INSERT INTO balante_snapshot (eticheta, data_de_la, data_pana, cont, denumire, si_d, si_c, r_d, r_c, ts_d, ts_c, sf_d, sf_c, fisier) VALUES ${ph}`
      )
      .run(...args);
  }
}

function etichetaDinPerioada(deLa, panaLa) {
  if (!deLa || !panaLa) return `balanta-${new Date().toISOString().slice(0, 10)}`;
  const anIntreg = deLa.endsWith("-01-01") && panaLa.endsWith("-12-31") && deLa.slice(0, 4) === panaLa.slice(0, 4);
  return anIntreg ? `Anul ${deLa.slice(0, 4)}` : `${deLa} → ${panaLa}`;
}

function register(router) {
  router.get("/rapoarte/balanta", async (ctx) => {
    await regenereazaDacaENevoie();

    const deLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.de_la || "")) ? String(ctx.query.de_la) : inceputAn();
    const panaLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.pana_la || "")) ? String(ctx.query.pana_la) : azi();
    const nivel = ctx.query.nivel === "clasa" ? "clasa" : "cont";

    let { conturi, total, verificari } = await conta.balanta(deLa, panaLa);

    // Balanța pe clase (sintetic de grad zero) — utilă pentru o privire rapidă.
    if (nivel === "clasa") {
      const peClasa = new Map();
      for (const c of conturi) {
        if (!peClasa.has(c.clasa)) peClasa.set(c.clasa, { cont: c.clasa, denumire: `Clasa ${c.clasa}`, siD: 0, siC: 0, rD: 0, rC: 0, tsD: 0, tsC: 0, sfD: 0, sfC: 0 });
        const g = peClasa.get(c.clasa);
        for (const k of ["siD", "siC", "rD", "rC", "tsD", "tsC", "sfD", "sfC"]) g[k] = conta.BANI(g[k] + c[k]);
      }
      conturi = [...peClasa.values()];
    }

    const ultimaRulare = await db.prepare("SELECT * FROM contabilitate_rulari ORDER BY id DESC LIMIT 1").get();
    const areSolduriInitiale = Number((await db.prepare("SELECT COUNT(*) AS n FROM inregistrari_contabile WHERE sursa = 'sold_initial'").get()).n) > 0;

    const toateOk = verificari.every((v) => v.ok);

    const body = `
      <div class="subnav">
        <a href="/rapoarte" class="subnav-link">Toate rapoartele</a>
        <a href="/rapoarte/balanta" class="subnav-link activ">Balanță de verificare</a>
        <a href="/rapoarte/balanta/solduri-initiale" class="subnav-link">Solduri inițiale (SmartBill Conta)</a>
        <a href="/rapoarte/incasari" class="subnav-link">Scadențar încasări</a>
      </div>

      ${
        toateOk
          ? '<div class="flash">Balanța se verifică: toate cele patru egalități (solduri inițiale, rulaje, total sume, solduri finale) sunt respectate.</div>'
          : `<div class="flash" style="background:#f8e5e3;border-color:#e8bdb8;color:var(--danger)">Atenție — balanța NU se închide: ${verificari
              .filter((v) => !v.ok)
              .map((v) => `${esc(v.nume)} (diferență ${money(v.diferenta)})`)
              .join("; ")}.</div>`
      }

      ${
        !areSolduriInitiale
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">Balanța e construită doar din documentele existente în ERP (facturi, încasări, plăți, salarii).
             Conturile care nu trec prin ERP (bancă — soldul real, capital, imobilizări, TVA de plată istoric) vor lipsi până
             <a href="/rapoarte/balanta/solduri-initiale">preiei soldurile inițiale din balanța SmartBill Conta</a>.</div>`
          : ""
      }

      <form class="filtre" method="get" action="/rapoarte/balanta">
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">De la <input type="date" name="de_la" value="${esc(deLa)}"></label>
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">Până la <input type="date" name="pana_la" value="${esc(panaLa)}"></label>
        <select name="nivel">
          <option value="cont"${nivel === "cont" ? " selected" : ""}>Pe conturi</option>
          <option value="clasa"${nivel === "clasa" ? " selected" : ""}>Pe clase (rezumat)</option>
        </select>
        <button class="btn small" type="submit">Afișează</button>
        <a class="btn secondary small" href="/rapoarte/balanta?de_la=${esc(panaLa)}&pana_la=${esc(panaLa)}">Doar ziua de azi</a>
      </form>

      <div style="overflow-x:auto">
      <table class="table balanta">
        <thead>
          <tr>
            <th rowspan="2">Cont</th>
            <th rowspan="2">Denumire</th>
            <th colspan="2">Solduri inițiale<br>la ${esc(deLa)}</th>
            <th colspan="2">Rulaje<br>${esc(deLa)} → ${esc(panaLa)}</th>
            <th colspan="2">Total sume</th>
            <th colspan="2">Solduri finale<br>la ${esc(panaLa)}</th>
          </tr>
          <tr>
            <th>Debit</th><th>Credit</th>
            <th>Debit</th><th>Credit</th>
            <th>Debit</th><th>Credit</th>
            <th>Debit</th><th>Credit</th>
          </tr>
        </thead>
        <tbody>
          ${conturi
            .map(
              (c) => `<tr>
                <td>${nivel === "cont" ? `<a href="/rapoarte/balanta/fisa/${esc(c.cont)}?de_la=${esc(deLa)}&pana_la=${esc(panaLa)}">${esc(c.cont)}</a>` : esc(c.cont)}</td>
                <td class="den">${esc(c.denumire)}</td>
                <td class="nr">${nrRo(c.siD)}</td><td class="nr">${nrRo(c.siC)}</td>
                <td class="nr">${nrRo(c.rD)}</td><td class="nr">${nrRo(c.rC)}</td>
                <td class="nr">${nrRo(c.tsD)}</td><td class="nr">${nrRo(c.tsC)}</td>
                <td class="nr"><strong>${nrRo(c.sfD)}</strong></td><td class="nr"><strong>${nrRo(c.sfC)}</strong></td>
              </tr>`
            )
            .join("")}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2"><strong>TOTAL</strong></td>
            <td class="nr"><strong>${nrRo(total.siD)}</strong></td><td class="nr"><strong>${nrRo(total.siC)}</strong></td>
            <td class="nr"><strong>${nrRo(total.rD)}</strong></td><td class="nr"><strong>${nrRo(total.rC)}</strong></td>
            <td class="nr"><strong>${nrRo(total.tsD)}</strong></td><td class="nr"><strong>${nrRo(total.tsC)}</strong></td>
            <td class="nr"><strong>${nrRo(total.sfD)}</strong></td><td class="nr"><strong>${nrRo(total.sfC)}</strong></td>
          </tr>
        </tfoot>
      </table>
      </div>

      <p style="font-size:12px;color:var(--text-muted);margin-top:14px">
        Generată automat din documentele ERP${ultimaRulare ? ` · ultima recalculare: ${esc((ultimaRulare.rulat_la || "").slice(0, 16))} (${ultimaRulare.linii_generate} înregistrări din ${ultimaRulare.documente} documente, ${ultimaRulare.durata_ms} ms)` : ""}.
        Click pe simbolul unui cont deschide fișa contului. Amortizările, provizioanele și închiderile de lună nu se generează automat — sunt operațiuni de contabil.
      </p>
      <form method="post" action="/rapoarte/balanta/regenereaza" class="inline-form">
        <button class="btn secondary small" type="submit">Recalculează acum</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Balanță de verificare ${deLa} → ${panaLa}`, active: "/rapoarte", body }));
  });


  // ---- TVA de plată, la zi ----------------------------------------------
  // Calculat din motorul contabil: 4427 (TVA colectată, din vânzări) minus
  // 4426 (TVA deductibilă, din achiziții), pe perioada aleasă — plus soldul
  // istoric preluat din balanța SmartBill Conta (4423/4424), dacă există.
  router.get("/rapoarte/tva", async (ctx) => {
    await regenereazaDacaENevoie();

    const aziStr = azi();
    const lunaCurenta = aziStr.slice(0, 7);
    const deLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.de_la || "")) ? String(ctx.query.de_la) : lunaCurenta + "-01";
    const panaLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.pana_la || "")) ? String(ctx.query.pana_la) : aziStr;

    const agregat = await db
      .prepare(
        `SELECT cont,
                SUM(CASE WHEN data >= ? AND data <= ? THEN credit - debit ELSE 0 END) AS perioada,
                SUM(CASE WHEN data <= ? THEN credit - debit ELSE 0 END) AS cumulat
         FROM inregistrari_contabile
         WHERE cont IN ('4426', '4427', '4423', '4424')
         GROUP BY cont`
      )
      .all(deLa, panaLa, panaLa);
    const g = Object.fromEntries(agregat.map((r) => [r.cont, r]));
    const val = (cont, camp) => conta.BANI(Number((g[cont] || {})[camp] || 0));

    // 4427 e cont de pasiv (crește pe credit) → colectat = credit - debit.
    // 4426 e cont de activ (crește pe debit) → deductibil = debit - credit = -(credit-debit).
    const colectataPerioada = val("4427", "perioada");
    const deductibilaPerioada = -val("4426", "perioada");
    const tvaPerioada = conta.BANI(colectataPerioada - deductibilaPerioada);

    // „La zi" cumulat are sens DOAR dacă există un punct de pornire ancorat
    // (soldurile inițiale din balanța Conta, care includ 4423/4424 și implicit
    // faptul că TVA-ul istoric a fost deja regularizat). Fără ele, cumulatul
    // ar aduna 10 ani de TVA colectată ca și cum nu s-ar fi plătit niciodată —
    // un număr uriaș și fals. În lipsa lor arătăm luna PRECEDENTĂ, adică exact
    // ce se declară și se plătește pe 25 ale lunii curente.
    const areAncora =
      Number((await db.prepare("SELECT COUNT(*) AS n FROM inregistrari_contabile WHERE sursa = 'sold_initial' AND cont IN ('4423','4424','4427','4426')").get()).n) > 0;

    const soldIstoric = conta.BANI(val("4423", "cumulat") - -val("4424", "cumulat"));
    let tvaLaZi = null;
    if (areAncora) {
      const ancora = (await db.prepare("SELECT MIN(data) AS d FROM inregistrari_contabile WHERE sursa = 'sold_initial'").get()).d;
      const dupaAncora = await db
        .prepare(
          `SELECT SUM(CASE WHEN cont = '4427' THEN credit - debit ELSE 0 END) AS col,
                  SUM(CASE WHEN cont = '4426' THEN debit - credit ELSE 0 END) AS ded
           FROM inregistrari_contabile WHERE sursa = 'auto' AND data >= ? AND data <= ?`
        )
        .get(ancora, panaLa);
      tvaLaZi = conta.BANI(soldIstoric + Number(dupaAncora.col || 0) - Number(dupaAncora.ded || 0));
    }

    // Luna precedentă — cea care se plătește pe 25.
    const lunaTrecuta = (() => {
      const d = new Date(aziStr + "T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    const lp = await db
      .prepare(
        `SELECT SUM(CASE WHEN cont = '4427' THEN credit - debit ELSE 0 END) AS col,
                SUM(CASE WHEN cont = '4426' THEN debit - credit ELSE 0 END) AS ded
         FROM inregistrari_contabile WHERE SUBSTR(data, 1, 7) = ?`
      )
      .get(lunaTrecuta);
    const tvaLunaTrecuta = conta.BANI(Number(lp.col || 0) - Number(lp.ded || 0));

    // Defalcare pe luni (ultimele 13, ca să prindă și luna curentă parțială).
    const peLuni = await db
      .prepare(
        `SELECT SUBSTR(data, 1, 7) AS luna,
                SUM(CASE WHEN cont = '4427' THEN credit - debit ELSE 0 END) AS colectata,
                SUM(CASE WHEN cont = '4426' THEN debit - credit ELSE 0 END) AS deductibila
         FROM inregistrari_contabile
         WHERE cont IN ('4426', '4427')
         GROUP BY SUBSTR(data, 1, 7)
         ORDER BY luna DESC
         LIMIT 13`
      )
      .all();

    const areAchizitii = Number((await db.prepare("SELECT COUNT(*) AS n FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'achizitie' AND status NOT IN ('anulata','ciorna')").get()).n) > 0;

    const body = `
      <div class="subnav">
        <a href="/rapoarte" class="subnav-link">Toate rapoartele</a>
        <a href="/rapoarte/balanta" class="subnav-link">Balanță de verificare</a>
        <a href="/rapoarte/tva" class="subnav-link activ">TVA de plată</a>
        <a href="/rapoarte/incasari" class="subnav-link">Scadențar încasări</a>
      </div>

      <div class="cards">
        <div class="card"><div class="label">TVA colectată (${esc(deLa)} → ${esc(panaLa)})</div><div class="value">${money(colectataPerioada)}</div></div>
        <div class="card"><div class="label">TVA deductibilă (perioadă)</div><div class="value">${money(deductibilaPerioada)}</div></div>
        <div class="card"><div class="label">${tvaPerioada >= 0 ? "TVA de plată (perioadă)" : "TVA de recuperat (perioadă)"}</div>
          <div class="value" style="color:${tvaPerioada >= 0 ? "var(--danger)" : "var(--success)"}">${money(Math.abs(tvaPerioada))}</div></div>
        ${
          tvaLaZi !== null
            ? `<div class="card"><div class="label">${tvaLaZi >= 0 ? "TVA de plată LA ZI (cumulat, cu sold istoric)" : "TVA de recuperat LA ZI"}</div>
                <div class="value" style="color:${tvaLaZi >= 0 ? "var(--danger)" : "var(--success)"}">${money(Math.abs(tvaLaZi))}</div></div>`
            : `<div class="card"><div class="label">${tvaLunaTrecuta >= 0 ? `TVA de plată pe ${esc(lunaTrecuta)} (scadent pe 25)` : `TVA de recuperat pe ${esc(lunaTrecuta)}`}</div>
                <div class="value" style="color:${tvaLunaTrecuta >= 0 ? "var(--danger)" : "var(--success)"}">${money(Math.abs(tvaLunaTrecuta))}</div></div>`
        }
      </div>

      <form class="filtre" method="get" action="/rapoarte/tva">
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">De la <input type="date" name="de_la" value="${esc(deLa)}"></label>
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">Până la <input type="date" name="pana_la" value="${esc(panaLa)}"></label>
        <button class="btn small" type="submit">Calculează</button>
        <a class="btn secondary small" href="/rapoarte/tva">Luna curentă</a>
      </form>

      ${
        !areAchizitii
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">
              În ERP nu există încă facturi de achiziție, deci TVA-ul deductibil e 0 și „TVA de plată" de mai sus e de fapt
              doar TVA-ul colectat. Cifra reală de plată va fi mai mică — importă facturile de achiziție din
              <a href="/import">Import</a> ca să se scadă automat deductibilul.</div>`
          : ""
      }

      <h2>Defalcare pe luni</h2>
      ${table(
        ["Luna", "TVA colectată", "TVA deductibilă", "De plată / (de recuperat)"],
        peLuni.map((l) => {
          const dif = conta.BANI(Number(l.colectata) - Number(l.deductibila));
          return [
            esc(l.luna),
            money(l.colectata),
            money(l.deductibila),
            dif >= 0 ? money(dif) : `<span style="color:var(--success)">(${money(Math.abs(dif))})</span>`,
          ];
        })
      )}
      <p style="font-size:12px;color:var(--text-muted)">
        Calcul informativ, pe baza documentelor din ERP — decontul oficial (D300) rămâne la contabil.
        TVA-ul e exigibil la data emiterii facturii (nu la încasare); dacă firma e pe TVA la încasare, cifra reală diferă.
        ${soldIstoric !== 0 ? `Include soldul istoric preluat din balanța Conta: ${money(soldIstoric)}.` : "Cumulatul „la zi\u201d apare după ce preiei soldurile inițiale din balanța Conta — fără ele ar aduna tot istoricul ca și cum TVA-ul n-ar fi fost plătit niciodată."}
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "TVA de plată — la zi", active: "/rapoarte", body }));
  });

  router.post("/rapoarte/balanta/regenereaza", async (ctx) => {
    await conta.regenereaza(ctx.user ? ctx.user.nume : "manual");
    redirect(ctx.res, "/rapoarte/balanta");
  });

  // ---- Fișa contului ----------------------------------------------------
  router.get("/rapoarte/balanta/fisa/:cont", async (ctx) => {
    const deLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.de_la || "")) ? String(ctx.query.de_la) : inceputAn();
    const panaLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.pana_la || "")) ? String(ctx.query.pana_la) : azi();
    const { cont, info, soldInitial, soldFinal, miscari } = await conta.fisaCont(ctx.params.cont, deLa, panaLa);

    const body = `
      <div class="detail-box">
        <h1 style="margin-top:0">Fișa contului ${esc(cont)} — ${esc(info ? info.denumire : "?")}</h1>
        <div class="detail-grid">
          <div><div class="k">Sold inițial la ${esc(deLa)}</div>${money(Math.abs(soldInitial))} ${soldInitial >= 0 ? "D" : "C"}</div>
          <div><div class="k">Sold final la ${esc(panaLa)}</div><strong>${money(Math.abs(soldFinal))} ${soldFinal >= 0 ? "D" : "C"}</strong></div>
          <div><div class="k">Mișcări în perioadă</div>${miscari.length}${miscari.length >= 500 ? " (primele 500)" : ""}</div>
        </div>
      </div>
      ${table(
        ["Data", "Explicație", "Partener", "Debit", "Credit", "Sold"],
        miscari.map((m) => [
          esc(m.data),
          esc(m.explicatie || "—") + (m.sursa !== "auto" ? ` <span class="badge gri">${esc(m.sursa)}</span>` : ""),
          m.partener_id ? `<a href="/parteneri/${m.partener_id}">${esc(m.partener_nume || "")}</a>` : "—",
          m.debit ? money(m.debit) : "",
          m.credit ? money(m.credit) : "",
          `${money(Math.abs(m.sold))} ${m.sold >= 0 ? "D" : "C"}`,
        ])
      )}
      <p style="margin-top:12px"><a class="btn secondary small" href="/rapoarte/balanta?de_la=${esc(deLa)}&pana_la=${esc(panaLa)}">← Înapoi la balanță</a></p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Fișa contului ${cont}`, active: "/rapoarte", body }));
  });

  // ---- Solduri inițiale din balanța SmartBill Conta ---------------------
  // SmartBill Conta NU are API (verificat în documentația lor — API-ul acoperă
  // doar Facturare). Balanța se exportă însă din Conta în XLS/CSV, și o
  // preluăm de aici ca solduri de deschidere.
  router.get("/rapoarte/balanta/solduri-initiale", async (ctx) => {
    const existente = await db
      .prepare(
        "SELECT cont, SUM(debit) AS d, SUM(credit) AS c, MIN(data) AS data FROM inregistrari_contabile WHERE sursa = 'sold_initial' GROUP BY cont ORDER BY cont"
      )
      .all();

    const body = `
      <div class="subnav">
        <a href="/rapoarte" class="subnav-link">Toate rapoartele</a>
        <a href="/rapoarte/balanta" class="subnav-link">Balanță de verificare</a>
        <a href="/rapoarte/balanta/solduri-initiale" class="subnav-link activ">Solduri inițiale (SmartBill Conta)</a>
      </div>

      <div class="detail-box">
        <h2 style="margin-top:0">De ce e nevoie de asta</h2>
        <p>SmartBill <strong>nu oferă API pentru Conta</strong> (doar pentru Facturare — verificat în documentația lor), deci soldurile
        contabile nu se pot trage automat. În schimb, balanța din SmartBill Conta se exportă în XLS/CSV:
        <em>SmartBill Conta → Rapoarte → Balanță → Export</em>. Încarci fișierul aici o singură dată (de regulă la început de an),
        iar de la data aleasă încolo ERP-ul mișcă singur soldurile, zilnic, din documentele lui.</p>
      </div>

      <form class="form" method="post" action="/rapoarte/balanta/solduri-initiale" enctype="multipart/form-data">
        <label class="field">Balanța exportată din SmartBill Conta (XLS sau CSV)
          <input type="file" name="fisier" accept=".xls,.xlsx,.csv" required>
        </label>
        <label class="field">Data soldurilor (ziua de la care sunt valabile — ex. 01.01.2026)
          <input type="date" name="data" required value="${new Date().getFullYear()}-01-01">
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="inlocuieste" value="1" checked> Înlocuiește soldurile inițiale existente (recomandat)
        </label>
        <div class="form-actions"><button class="btn" type="submit">Preia soldurile</button></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted)">Fișierul trebuie să aibă coloanele: simbol cont, denumire (opțional), sold inițial/final debit și credit.
      Coloanele sunt recunoscute automat după denumire, indiferent de diacritice. Se preiau <strong>soldurile finale</strong> din balanța încărcată.</p>

      <h2>Solduri inițiale existente (${existente.length} conturi)</h2>
      ${
        existente.length
          ? table(
              ["Cont", "Valabile de la", "Debit", "Credit"],
              existente.map((e) => [
                `<a href="/rapoarte/balanta/fisa/${esc(e.cont)}">${esc(e.cont)}</a>`,
                esc(e.data),
                money(e.d),
                money(e.c),
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun sold inițial preluat încă — balanța pornește de la zero, doar din documentele ERP.</p>'
      }
      ${
        existente.length
          ? `<form method="post" action="/rapoarte/balanta/solduri-initiale/sterge" class="inline-form" onsubmit="return confirm('Ștergi toate soldurile inițiale?')" style="margin-top:10px">
              <button class="link-btn danger" type="submit">Șterge toate soldurile inițiale</button>
            </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Solduri inițiale", active: "/rapoarte", body }));
  });

  router.post("/rapoarte/balanta/solduri-initiale", async (ctx) => {
    const files = (ctx.body.__files && ctx.body.__files.fisier) || [];
    const file = files[0];
    if (!file) return redirect(ctx.res, "/rapoarte/balanta/solduri-initiale");

    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Eroare", active: "/rapoarte", body: `<p>${esc(e.message)}</p><a class="btn" href="/rapoarte/balanta/solduri-initiale">Înapoi</a>` }));
    }

    const parsat = parseBalantaConta(rows);
    if (parsat.eroare) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Format nerecunoscut",
          active: "/rapoarte",
          body: `<h1>${esc(parsat.eroare)}</h1><pre style="background:var(--surface);padding:12px;border-radius:8px;overflow-x:auto">${esc(rows.slice(0, 8).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n"))}</pre><a class="btn" href="/rapoarte/balanta/solduri-initiale">Înapoi</a>`,
        })
      );
    }

    // Data ancorei: ultima zi a perioadei din balanță (sau ce alege omul).
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.body.data || "")) ? String(ctx.body.data) : parsat.panaLa || azi();

    if (ctx.body.inlocuieste) {
      await db.prepare("DELETE FROM inregistrari_contabile WHERE sursa = 'sold_initial'").run();
    }

    let preluate = 0;
    const linii = parsat.conturi.filter((c) => c.sfD !== 0 || c.sfC !== 0);
    for (let i = 0; i < linii.length; i += 200) {
      const lot = linii.slice(i, i + 200);
      const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, 'sold_initial')").join(", ");
      const args = [];
      for (const l of lot) args.push(`SI-${l.cont}`, data, l.cont, l.sfD, l.sfC, `Sold inițial din balanța Conta ${parsat.deLa || ""} → ${parsat.panaLa || ""} (${file.filename})`);
      await db.prepare(`INSERT INTO inregistrari_contabile (nota_id, data, cont, debit, credit, explicatie, sursa) VALUES ${ph}`).run(...args);
      preluate += lot.length;
    }

    // Conturile noi (analitice de la contabil: 1171, 1174, 1682…) intră în plan.
    const planExistent = new Set((await db.prepare("SELECT simbol FROM plan_conturi").all()).map((r) => r.simbol));
    for (const c of linii) {
      if (planExistent.has(c.cont)) continue;
      planExistent.add(c.cont);
      await db
        .prepare("INSERT INTO plan_conturi (simbol, denumire, functiune, clasa, grupa) VALUES (?, ?, 'B', ?, ?)")
        .run(c.cont, c.denumire || "(din balanța Conta)", c.cont.charAt(0), c.cont.slice(0, 2));
    }

    // Salvăm și ca snapshot istoric + regenerăm contabilitatea pe noua ancoră.
    await salveazaSnapshot(etichetaDinPerioada(parsat.deLa, parsat.panaLa), parsat, file.filename);
    await conta.regenereaza("solduri-initiale");

    const dif = conta.BANI(parsat.totalSfD - parsat.totalSfC);
    const body = `
      <h1>Solduri preluate din balanța Conta</h1>
      <div class="cards">
        <div class="card"><div class="label">Perioada balanței</div><div class="value" style="font-size:16px">${esc(parsat.deLa || "?")} → ${esc(parsat.panaLa || "?")}</div></div>
        <div class="card"><div class="label">Conturi cu sold preluate</div><div class="value">${preluate}</div></div>
        <div class="card"><div class="label">Total debit / credit</div><div class="value" style="font-size:16px">${money(parsat.totalSfD)}<br>${money(parsat.totalSfC)}</div></div>
        <div class="card"><div class="label">Diferență D−C</div><div class="value" style="color:${Math.abs(dif) <= 0.01 ? "var(--success)" : "var(--danger)"}">${money(dif)}</div></div>
      </div>
      ${
        Math.abs(dif) <= 0.01
          ? '<div class="flash">Balanța de pornire se echilibrează perfect. Din ziua următoare ancorei, ERP-ul mișcă singur soldurile; facturile istorice deja importate nu se mai numără dublu (sunt excluse automat până la ancoră).</div>'
          : '<div class="flash" style="background:#f8e5e3;border-color:#e8bdb8;color:var(--danger)">Soldurile nu se echilibrează — verifică dacă fișierul e balanța completă.</div>'
      }
      <a class="btn" href="/rapoarte/balanta">Vezi balanța</a>
      <a class="btn secondary" href="/rapoarte/balanta/istoric">Vezi balanțele istorice</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Solduri preluate", active: "/rapoarte", body }));
  });

  // ---- Balanțe istorice (snapshoturi anuale/lunare) ----------------------
  // Balanțele pe anii trecuți NU devin solduri inițiale — sunt sursa
  // indicatorilor bancari reali (capitaluri, îndatorare, lichiditate) și a
  // evoluției multi-an din /rapoarte/indicatori.
  router.get("/rapoarte/balanta/istoric", async (ctx) => {
    const snap = await db
      .prepare(
        "SELECT eticheta, MIN(data_de_la) AS de_la, MIN(data_pana) AS pana, COUNT(*) AS conturi, MIN(fisier) AS fisier, MIN(incarcat_la) AS la FROM balante_snapshot GROUP BY eticheta ORDER BY MIN(data_pana) DESC"
      )
      .all();
    const body = `
      <div class="subnav">
        <a href="/rapoarte" class="subnav-link">Toate rapoartele</a>
        <a href="/rapoarte/balanta" class="subnav-link">Balanță de verificare</a>
        <a href="/rapoarte/balanta/solduri-initiale" class="subnav-link">Solduri inițiale</a>
        <a href="/rapoarte/balanta/istoric" class="subnav-link activ">Balanțe istorice</a>
      </div>
      <div class="detail-box">
        <h2 style="margin-top:0">La ce folosesc</h2>
        <p style="font-size:13px">Balanțele pe anii trecuți (2023, 2024, 2025…) alimentează raportul
        <a href="/rapoarte/indicatori">Indicatori financiari — ochii băncii</a> cu cifre contabile reale: capitaluri proprii,
        grad de îndatorare, lichiditate, profit — și evoluția lor de la an la an. Nu afectează balanța curentă a ERP-ului.</p>
      </div>
      <form method="post" action="/rapoarte/balanta/istoric" enctype="multipart/form-data" class="filtre">
        <input type="file" name="fisier" accept=".xls,.xlsx,.csv" required>
        <button class="btn" type="submit">Încarcă balanța istorică</button>
      </form>
      <h2>Balanțe încărcate</h2>
      ${
        snap.length
          ? table(
              ["Etichetă", "Perioadă", "Conturi", "Fișier", "Încărcată la", ""],
              snap.map((r) => [
                esc(r.eticheta),
                `${esc(r.de_la || "?")} → ${esc(r.pana || "?")}`,
                r.conturi,
                esc(r.fisier || "—"),
                esc((r.la || "").slice(0, 16)),
                `<form method="post" action="/rapoarte/balanta/istoric/sterge" class="inline-form" onsubmit="return confirm('Ștergi balanța ${esc(r.eticheta)}?')"><input type="hidden" name="eticheta" value="${esc(r.eticheta)}"><button class="link-btn danger" type="submit">Șterge</button></form>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Nicio balanță istorică încă. Încarcă balanțele anuale (2023, 2024, 2025) și pe cea a ultimei luni închise.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Balanțe istorice", active: "/rapoarte", body }));
  });

  router.post("/rapoarte/balanta/istoric", async (ctx) => {
    const files = (ctx.body.__files && ctx.body.__files.fisier) || [];
    const file = files[0];
    if (!file) return redirect(ctx.res, "/rapoarte/balanta/istoric");
    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Eroare", active: "/rapoarte", body: `<p>${esc(e.message)}</p><a class="btn" href="/rapoarte/balanta/istoric">Înapoi</a>` }));
    }
    const parsat = parseBalantaConta(rows);
    if (parsat.eroare) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Format nerecunoscut", active: "/rapoarte", body: `<p>${esc(parsat.eroare)}</p><a class="btn" href="/rapoarte/balanta/istoric">Înapoi</a>` }));
    }
    await salveazaSnapshot(etichetaDinPerioada(parsat.deLa, parsat.panaLa), parsat, file.filename);
    redirect(ctx.res, "/rapoarte/balanta/istoric");
  });

  router.post("/rapoarte/balanta/istoric/sterge", async (ctx) => {
    await db.prepare("DELETE FROM balante_snapshot WHERE eticheta = ?").run(String(ctx.body.eticheta || ""));
    redirect(ctx.res, "/rapoarte/balanta/istoric");
  });

  router.post("/rapoarte/balanta/solduri-initiale/sterge", async (ctx) => {
    await db.prepare("DELETE FROM inregistrari_contabile WHERE sursa = 'sold_initial'").run();
    redirect(ctx.res, "/rapoarte/balanta/solduri-initiale");
  });
}

module.exports = { register };
