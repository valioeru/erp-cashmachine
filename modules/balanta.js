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
    Number((await db.prepare("SELECT COUNT(*) AS n FROM facturi WHERE status <> 'anulata'").get()).n) * 1000000 +
    Number((await db.prepare("SELECT COUNT(*) AS n FROM plati").get()).n) * 1000 +
    Number((await db.prepare("SELECT COUNT(*) AS n FROM salarii").get()).n);
  const ultima = await db.prepare("SELECT documente FROM contabilitate_rulari ORDER BY id DESC LIMIT 1").get();
  const contorFacturi = Number((await db.prepare("SELECT COUNT(*) AS n FROM facturi WHERE status <> 'anulata'").get()).n);
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

    const areAchizitii = Number((await db.prepare("SELECT COUNT(*) AS n FROM facturi WHERE directie = 'achizitie' AND status <> 'anulata'").get()).n) > 0;

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
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.body.data || "")) ? String(ctx.body.data) : null;
    if (!file || !data) return redirect(ctx.res, "/rapoarte/balanta/solduri-initiale");

    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Eroare", active: "/rapoarte", body: `<p>${esc(e.message)}</p><a class="btn" href="/rapoarte/balanta/solduri-initiale">Înapoi</a>` }));
    }

    // Recunoaștem coloanele din exportul de balanță. SmartBill folosește
    // denumiri gen "Simbol cont", "Solduri finale Debit/Credit"; acceptăm și
    // variante.
    const CHEI = {
      cont: ["simbolcont", "simbol", "cont", "contul"],
      sfD: ["soldurifinaledebit", "soldfinaldebit", "sfdebit", "solddebit", "soldfinald", "debit"],
      sfC: ["soldurifinalecredit", "soldfinalcredit", "sfcredit", "soldcredit", "soldfinalc", "credit"],
    };
    let randHeader = -1;
    let idx = {};
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const norm = (rows[i] || []).map(normalizeHeader);
      const gaseste = (chei) => norm.findIndex((h) => chei.some((k) => h.includes(k)));
      const iCont = gaseste(CHEI.cont);
      // debit/credit pot apărea de mai multe ori (inițiale, rulaje, finale) —
      // luăm ULTIMA pereche, care în balanța standard e cea de solduri finale.
      let iD = -1;
      let iC = -1;
      norm.forEach((h, j) => {
        if (CHEI.sfD.some((k) => h.includes(k))) iD = j;
      });
      norm.forEach((h, j) => {
        if (CHEI.sfC.some((k) => h.includes(k))) iC = j;
      });
      if (iCont !== -1 && iD !== -1 && iC !== -1 && iD !== iC) {
        randHeader = i;
        idx = { cont: iCont, sfD: iD, sfC: iC };
        break;
      }
    }
    if (randHeader === -1) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Coloane nerecunoscute",
          active: "/rapoarte",
          body: `<h1>N-am recunoscut coloanele balanței</h1><p>Primele rânduri găsite:</p><pre style="background:var(--surface);padding:12px;border-radius:8px;overflow-x:auto">${esc(
            rows.slice(0, 6).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n")
          )}</pre><a class="btn" href="/rapoarte/balanta/solduri-initiale">Înapoi</a>`,
        })
      );
    }

    if (ctx.body.inlocuieste) {
      await db.prepare("DELETE FROM inregistrari_contabile WHERE sursa = 'sold_initial'").run();
    }

    let preluate = 0;
    let totalD = 0;
    let totalC = 0;
    const linii = [];
    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const cont = String(row[idx.cont] || "").trim().replace(/[^0-9.]/g, "");
      if (!/^\d{3,4}(\.\d+)?$/.test(cont)) continue; // sare titluri, clase, totaluri
      const d = conta.BANI(parseNumar(row[idx.sfD]));
      const c = conta.BANI(parseNumar(row[idx.sfC]));
      if (d === 0 && c === 0) continue;
      linii.push({ cont, d, c });
      totalD += d;
      totalC += c;
      preluate++;
    }

    for (let i = 0; i < linii.length; i += 200) {
      const lot = linii.slice(i, i + 200);
      const ph = lot.map(() => "(?, ?, ?, ?, ?, ?, 'sold_initial')").join(", ");
      const args = [];
      for (const l of lot) args.push(`SI-${l.cont}`, data, l.cont, l.d, l.c, `Sold inițial preluat din balanța SmartBill Conta (${file.filename})`);
      await db.prepare(`INSERT INTO inregistrari_contabile (nota_id, data, cont, debit, credit, explicatie, sursa) VALUES ${ph}`).run(...args);
    }

    // Conturile din balanța contabilului care nu există în planul nostru se
    // adaugă automat (ca simbol + funcțiune bifuncțională), ca fișa să meargă.
    const planExistent = new Set((await db.prepare("SELECT simbol FROM plan_conturi").all()).map((r) => r.simbol));
    const noi = [...new Set(linii.map((l) => l.cont))].filter((c) => !planExistent.has(c));
    for (const c of noi) {
      await db.prepare("INSERT INTO plan_conturi (simbol, denumire, functiune, clasa, grupa) VALUES (?, ?, 'B', ?, ?)").run(c, "(din balanța SmartBill Conta)", c.charAt(0), c.slice(0, 2));
    }

    const dif = conta.BANI(totalD - totalC);
    const body = `
      <h1>Solduri preluate</h1>
      <div class="cards">
        <div class="card"><div class="label">Conturi preluate</div><div class="value">${preluate}</div></div>
        <div class="card"><div class="label">Total debit</div><div class="value">${money(totalD)}</div></div>
        <div class="card"><div class="label">Total credit</div><div class="value">${money(totalC)}</div></div>
        <div class="card"><div class="label">Diferență D-C</div><div class="value" style="color:${Math.abs(dif) <= 0.01 ? "var(--success)" : "var(--danger)"}">${money(dif)}</div></div>
      </div>
      ${
        Math.abs(dif) > 0.01
          ? '<div class="flash" style="background:#f8e5e3;border-color:#e8bdb8;color:var(--danger)">Atenție: soldurile preluate nu se echilibrează — verifică dacă fișierul e balanța completă (toate conturile, nu un filtru).</div>'
          : '<div class="flash">Soldurile se echilibrează (debit = credit) — balanța de pornire e validă.</div>'
      }
      <a class="btn" href="/rapoarte/balanta">Vezi balanța</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Solduri preluate", active: "/rapoarte", body }));
  });

  router.post("/rapoarte/balanta/solduri-initiale/sterge", async (ctx) => {
    await db.prepare("DELETE FROM inregistrari_contabile WHERE sursa = 'sold_initial'").run();
    redirect(ctx.res, "/rapoarte/balanta/solduri-initiale");
  });
}

module.exports = { register };
