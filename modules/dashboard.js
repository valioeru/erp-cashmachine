"use strict";
// Dashboard-ul administratorului.
//
// Ordinea e cea cerută de Vali și e și ordinea în care se citește o firmă:
//   1. cât am facturat anul ăsta, față de aceeași perioadă din ultimii 3 ani;
//   2. profit sau pierdere la zi, cu istoricul lunar al anului curent;
//   3. ce am de făcut — task-uri, remindere, ce e programat în calendar;
//   4. ce se întâmplă în jur — știri care contează pentru business.
//
// Comparația se face pe FEREASTRĂ ECHIVALENTĂ: 1 ianuarie → ziua de azi, în
// fiecare an. Altfel ai compara 8 luni din 2026 cu 12 luni din 2025 și ai
// crede în fiecare august că firma s-a prăbușit.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send } = require("../lib/router");

const LUNI = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "nov", "dec"];

const SUB_TOTAL_NET = "(SELECT factura_id, SUM(cantitate * pret_unitar) AS net FROM facturi_linii GROUP BY factura_id)";
const SUB_TOTAL_BRUT =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) AS brut FROM facturi_linii GROUP BY factura_id)";

function azi() {
  return new Date().toISOString().slice(0, 10);
}

// Suma facturată (fără TVA) într-un interval, pe o direcție.
async function facturatIntre(directie, de, la) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(t.net), 0) AS net
         FROM facturi f JOIN ${SUB_TOTAL_NET} t ON t.factura_id = f.id
        WHERE f.directie = ? AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?`
    )
    .get(directie, de, la);
  return Number((r && r.net) || 0);
}

// Vânzări și achiziții pe fiecare lună a unui an — o interogare per direcție.
async function peLuni(directie, an) {
  const r = await db
    .prepare(
      `SELECT SUBSTR(f.data_emiterii, 6, 2) AS luna, COALESCE(SUM(t.net), 0) AS net
         FROM facturi f JOIN ${SUB_TOTAL_NET} t ON t.factura_id = f.id
        WHERE f.directie = ? AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?
        GROUP BY SUBSTR(f.data_emiterii, 6, 2)`
    )
    .all(directie, `${an}-01-01`, `${an}-12-31`);
  const v = new Array(12).fill(0);
  for (const x of r) {
    const i = parseInt(x.luna, 10) - 1;
    if (i >= 0 && i < 12) v[i] = Number(x.net) || 0;
  }
  return v;
}

// Costul cu oamenii, pe lună. Vine din statele de plată dacă există, altfel
// din costurile lunare definite pe utilizatori.
async function salariiPeLuni(an) {
  const v = new Array(12).fill(0);
  try {
    const r = await db
      .prepare("SELECT luna, COALESCE(SUM(salariu_brut * 1.0225), 0) AS c FROM salarii WHERE luna LIKE ? GROUP BY luna")
      .all(`${an}-%`);
    for (const x of r) {
      const i = parseInt(String(x.luna).slice(5, 7), 10) - 1;
      if (i >= 0 && i < 12) v[i] = Number(x.c) || 0;
    }
  } catch (e) {
    /* fără state de plată încă */
  }
  return v;
}

// ------------------------------------------------------------------
// Graficul lunar de profit.
// ------------------------------------------------------------------
// Bare în jurul liniei de zero: lunile pe plus urcă, cele pe minus coboară.
// Semnul se citește din poziție, nu din culoare — culoarea doar întărește.
// O singură serie, deci fără legendă: titlul spune ce e.
function graficProfit(valori, aniLuni) {
  const W = 720;
  const H = 220;
  const stangaAx = 54;
  const jos = 26;
  const sus = 12;
  const latPlot = W - stangaAx - 8;
  const inaltPlot = H - jos - sus;

  const maxAbs = Math.max(1, ...valori.map((v) => Math.abs(v)));
  const scara = (v) => (v / maxAbs) * (inaltPlot / 2);
  const yZero = sus + inaltPlot / 2;
  const latBara = Math.min(40, (latPlot / valori.length) * 0.62);
  const pas = latPlot / valori.length;

  const bare = valori
    .map((v, i) => {
      if (!v) return "";
      const x = stangaAx + pas * i + (pas - latBara) / 2;
      const h = Math.abs(scara(v));
      const y = v >= 0 ? yZero - h : yZero;
      const pozitiv = v >= 0;
      // colț rotunjit doar la capătul dinspre date, capătul de la linia zero rămâne drept
      const r = Math.min(4, h);
      const d = pozitiv
        ? `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + latBara - r},${y} Q${x + latBara},${y} ${x + latBara},${y + r} L${x + latBara},${y + h} Z`
        : `M${x},${y} L${x},${y + h - r} Q${x},${y + h} ${x + r},${y + h} L${x + latBara - r},${y + h} Q${x + latBara},${y + h} ${x + latBara},${y + h - r} L${x + latBara},${y} Z`;
      return `<path d="${d}" fill="${pozitiv ? "var(--viz-plus)" : "var(--viz-minus)"}"><title>${esc(aniLuni[i])}: ${esc(money(v))}</title></path>`;
    })
    .join("");

  // etichete doar pe cea mai bună și cea mai slabă lună — nu un număr pe fiecare bară
  const cuValoare = valori.map((v, i) => ({ v, i })).filter((x) => x.v);
  const marcate = new Set();
  if (cuValoare.length) {
    marcate.add(cuValoare.reduce((a, b) => (b.v > a.v ? b : a)).i);
    marcate.add(cuValoare.reduce((a, b) => (b.v < a.v ? b : a)).i);
  }
  const etichete = [...marcate]
    .map((i) => {
      const v = valori[i];
      const x = stangaAx + pas * i + pas / 2;
      const h = Math.abs(scara(v));
      const y = v >= 0 ? yZero - h - 6 : yZero + h + 14;
      return `<text x="${x}" y="${y}" text-anchor="middle" font-size="11" fill="var(--viz-text-2)">${esc(money(v))}</text>`;
    })
    .join("");

  const axaLuni = valori
    .map((_, i) => `<text x="${stangaAx + pas * i + pas / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--viz-text-2)">${LUNI[i]}</text>`)
    .join("");

  return `
    <div class="viz" style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
           aria-label="Profit lunar în anul curent, în lei, pe luni">
        <line x1="${stangaAx}" y1="${yZero}" x2="${W - 8}" y2="${yZero}" stroke="var(--viz-grid)" stroke-width="1"/>
        <text x="${stangaAx - 8}" y="${yZero + 4}" text-anchor="end" font-size="11" fill="var(--viz-text-2)">0</text>
        <text x="${stangaAx - 8}" y="${sus + 10}" text-anchor="end" font-size="11" fill="var(--viz-text-2)">${esc(scurt(maxAbs))}</text>
        <text x="${stangaAx - 8}" y="${H - jos - 2}" text-anchor="end" font-size="11" fill="var(--viz-text-2)">-${esc(scurt(maxAbs))}</text>
        ${bare}
        ${etichete}
        ${axaLuni}
      </svg>
    </div>`;
}

// Etichetele axei sunt scurte, ca să nu se lovească de eticheta primei bare:
// „1,55 mil." în loc de „1.552.546,40 lei".
function scurt(v) {
  const a = Math.abs(v);
  if (a >= 1000000) return (v / 1000000).toFixed(2).replace(".", ",") + " mil.";
  if (a >= 1000) return Math.round(v / 1000).toLocaleString("ro-RO") + " mii";
  return Math.round(v).toString();
}

function sageata(delta) {
  if (delta > 0) return `<span style="color:var(--success)">▲</span>`;
  if (delta < 0) return `<span style="color:var(--danger)">▼</span>`;
  return "";
}

function register(router) {
  router.get("/", async (ctx) => {
    const aziStr = azi();
    const anCurent = Number(aziStr.slice(0, 4));
    const zileLuna = aziStr.slice(5); // "MM-DD" — fereastra echivalentă în fiecare an

    // ---- 1. Facturat la zi vs aceeași perioadă din ultimii 3 ani ----------
    const ani = [anCurent, anCurent - 1, anCurent - 2, anCurent - 3];
    const facturatPeAn = [];
    for (const an of ani) {
      facturatPeAn.push({ an, valoare: await facturatIntre("vanzare", `${an}-01-01`, `${an}-${zileLuna}`) });
    }
    const acum = facturatPeAn[0].valoare;
    const anteriori = facturatPeAn.slice(1);
    const media3 = anteriori.length ? anteriori.reduce((s, x) => s + x.valoare, 0) / anteriori.length : 0;
    const difAbs = acum - media3;
    const difProc = media3 > 0 ? (difAbs / media3) * 100 : null;

    const maxAn = Math.max(1, ...facturatPeAn.map((x) => x.valoare));
    const randuriAni = facturatPeAn
      .map((x, i) => {
        const lat = (x.valoare / maxAn) * 100;
        const d = i === 0 ? null : acum - x.valoare;
        const p = i === 0 || x.valoare <= 0 ? null : (d / x.valoare) * 100;
        return `
          <div class="an-rand">
            <div class="an-eticheta">${x.an}${i === 0 ? " <span style='color:var(--text-muted);font-weight:400'>(la zi)</span>" : ""}</div>
            <div class="an-bara"><span style="width:${lat.toFixed(1)}%;background:${i === 0 ? "var(--viz-plus)" : "var(--viz-neutru)"}"></span></div>
            <div class="an-val">${money(x.valoare)}</div>
            <div class="an-dif">${d === null ? "" : `${sageata(d)} ${money(Math.abs(d))}${p === null ? "" : ` · ${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`}`}</div>
          </div>`;
      })
      .join("");

    // ---- 2. Profit la zi + istoric lunar ---------------------------------
    const vanzariLuni = await peLuni("vanzare", anCurent);
    const achizitiiLuni = await peLuni("achizitie", anCurent);
    const salariiLuni = await salariiPeLuni(anCurent);
    const profitLuni = vanzariLuni.map((v, i) => v - achizitiiLuni[i] - salariiLuni[i]);
    const lunaAcum = Number(aziStr.slice(5, 7)); // câte luni au început
    const profitLuniPanaAzi = profitLuni.slice(0, lunaAcum);
    const profitLaZi = profitLuniPanaAzi.reduce((s, v) => s + v, 0);
    const vanzariLaZi = vanzariLuni.slice(0, lunaAcum).reduce((s, v) => s + v, 0);
    const achizitiiLaZi = achizitiiLuni.slice(0, lunaAcum).reduce((s, v) => s + v, 0);
    const salariiLaZi = salariiLuni.slice(0, lunaAcum).reduce((s, v) => s + v, 0);
    const marjaProc = vanzariLaZi > 0 ? (profitLaZi / vanzariLaZi) * 100 : null;
    const etichetaLuni = LUNI.map((l) => `${l} ${anCurent}`);

    // ---- 3. Ce am de făcut ----------------------------------------------
    const taskuri = await db
      .prepare(
        `SELECT t.id, t.titlu, t.tip, t.prioritate, t.scadenta, t.status,
                p.nume AS client, p.id AS partener_id, u.nume AS atribuit
           FROM taskuri t
           LEFT JOIN parteneri p ON p.id = t.partener_id
           LEFT JOIN utilizatori u ON u.id = t.atribuit_lui
          WHERE t.status <> 'finalizat'
          ORDER BY CASE WHEN t.scadenta IS NULL OR t.scadenta = '' THEN 1 ELSE 0 END, t.scadenta
          LIMIT 15`
      )
      .all();

    let agenda = [];
    let agendaLa = null;
    try {
      agenda = await db
        .prepare(
          `SELECT sursa, titlu, detalii, incepe_la, link FROM agenda_externa
            WHERE incepe_la IS NULL OR incepe_la >= ?
            ORDER BY CASE WHEN incepe_la IS NULL THEN 1 ELSE 0 END, incepe_la LIMIT 20`
        )
        .all(aziStr);
      const r = await db.prepare("SELECT MAX(actualizat_la) AS d FROM agenda_externa").get();
      agendaLa = r && r.d ? String(r.d).slice(0, 16) : null;
    } catch (e) {
      agenda = [];
    }

    // ---- 4. Știri --------------------------------------------------------
    let stiri = [];
    let stiriLa = null;
    try {
      stiri = await db.prepare("SELECT titlu, sursa, url, rezumat, zona, relevanta, publicat_la FROM stiri ORDER BY id DESC LIMIT 12").all();
      const r = await db.prepare("SELECT MAX(adaugat_la) AS d FROM stiri").get();
      stiriLa = r && r.d ? String(r.d).slice(0, 16) : null;
    } catch (e) {
      stiri = [];
    }

    const stil = `
      <style>
        .viz { --viz-plus:#2f5d9c; --viz-minus:#b3261e; --viz-neutru:#c7ccd4;
               --viz-grid:#d8dce2; --viz-text-2:#667085; }
        .hero { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
                padding:18px 20px; margin-bottom:16px; }
        .hero-nr { font-size:38px; font-weight:650; line-height:1.1; letter-spacing:-0.5px; }
        .hero-sub { color:var(--text-muted); font-size:13px; margin-top:2px; }
        .an-rand { display:grid; grid-template-columns:110px 1fr 130px 190px; gap:10px; align-items:center;
                   padding:5px 0; font-size:13px; }
        .an-eticheta { font-weight:600; }
        .an-bara { background:#eef0f4; border-radius:4px; height:12px; overflow:hidden; }
        .an-bara span { display:block; height:100%; border-radius:4px; }
        .an-val { text-align:right; font-variant-numeric:tabular-nums; }
        .an-dif { font-size:12px; color:var(--text-muted); font-variant-numeric:tabular-nums; }
        .doua { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
        @media (max-width:640px){ .an-rand { grid-template-columns:74px 1fr 100px; } .an-dif { display:none; } }
      </style>`;

    const body = `
      ${stil}

      <div class="hero">
        <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div style="font-size:13px;color:var(--text-muted)">Facturat de la 1 ianuarie până azi (fără TVA)</div>
            <div class="hero-nr">${money(acum)}</div>
            <div class="hero-sub">
              ${
                difProc === null
                  ? "Nu am cu ce compara — nu există facturi în anii anteriori."
                  : `${difAbs >= 0 ? "Cu" : "Sub"} <strong style="color:${difAbs >= 0 ? "var(--success)" : "var(--danger)"}">${money(Math.abs(difAbs))}</strong>
                     (${difAbs >= 0 ? "+" : "−"}${Math.abs(difProc).toFixed(1)}%) față de media aceleiași perioade din ultimii 3 ani.`
              }
            </div>
          </div>
          <a class="btn secondary small" href="/rapoarte">Rapoarte detaliate →</a>
        </div>
        <div class="viz" style="margin-top:14px">
          ${randuriAni}
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:8px">
          Fiecare an e măsurat pe aceeași fereastră: 1 ianuarie → ${esc(zileLuna)}. Facturile anulate și cele între firmele grupului sunt scoase.
        </p>
      </div>

      <div class="hero">
        <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div style="font-size:13px;color:var(--text-muted)">${profitLaZi >= 0 ? "Profit" : "Pierdere"} la zi (${anCurent})</div>
            <div class="hero-nr" style="color:${profitLaZi >= 0 ? "var(--success)" : "var(--danger)"}">${money(profitLaZi)}</div>
            <div class="hero-sub">
              ${money(vanzariLaZi)} vânzări − ${money(achizitiiLaZi)} achiziții${salariiLaZi > 0 ? ` − ${money(salariiLaZi)} cost cu oamenii` : ""}
              ${marjaProc === null ? "" : ` · marjă ${marjaProc.toFixed(1)}%`}
            </div>
          </div>
        </div>
        ${graficProfit(profitLuni, etichetaLuni)}
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
          ${
            salariiLaZi > 0
              ? "Profitul scade vânzările nete cu achizițiile nete și cu costul salarial (brut + CAM)."
              : "Deocamdată e marjă brută: vânzări nete minus achiziții nete. Costul cu oamenii intră în calcul de îndată ce statele de plată sunt în sistem."
          }
        </p>
      </div>

      <div class="doua">
        <div>
          <h2 style="margin-top:0">De făcut${taskuri.length ? ` (${taskuri.length})` : ""}</h2>
          ${
            taskuri.length
              ? table(
                  ["Task", "Client", "Cine", "Scadență"],
                  taskuri.map((t) => [
                    `<a href="/taskuri/${t.id}">${esc(t.titlu)}</a>${t.prioritate === "ridicata" ? ' <span class="badge galben">prioritar</span>' : ""}`,
                    t.partener_id ? `<a href="/parteneri/${t.partener_id}">${esc(t.client)}</a>` : "—",
                    esc(t.atribuit || "—"),
                    t.scadenta ? esc(String(t.scadenta).slice(0, 10)) : "—",
                  ])
                )
              : '<p style="color:var(--text-muted)">Niciun task deschis.</p>'
          }
          <div class="toolbar"><a class="btn secondary small" href="/taskuri">Toate task-urile →</a></div>
        </div>

        <div>
          <h2 style="margin-top:0">Programat</h2>
          ${
            agenda.length
              ? table(
                  ["Când", "Ce", "Sursă"],
                  agenda.map((a) => [
                    a.incepe_la ? esc(String(a.incepe_la).slice(0, 16).replace("T", " ")) : "—",
                    a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.titlu)}</a>` : esc(a.titlu),
                    esc(a.sursa),
                  ])
                )
              : `<p style="color:var(--text-muted)">Nimic sincronizat încă din calendar și din remindere.</p>`
          }
          ${agendaLa ? `<p style="font-size:12px;color:var(--text-muted)">Sincronizat ultima dată: ${esc(agendaLa)}.</p>` : ""}
        </div>
      </div>

      <h2>Ce se întâmplă în jur</h2>
      ${
        stiri.length
          ? ["local", "extern"]
              .map((z) => {
                const ale = stiri.filter((s) => s.zona === z);
                if (!ale.length) return "";
                return `
                  <h3 style="margin-bottom:6px">${z === "local" ? "România" : "Extern"}</h3>
                  <ul style="margin-top:0;padding-left:18px">
                    ${ale
                      .map(
                        (s) => `<li style="margin-bottom:8px">
                          ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.titlu)}</a>` : `<strong>${esc(s.titlu)}</strong>`}
                          ${s.sursa ? `<span style="color:var(--text-muted);font-size:12px"> — ${esc(s.sursa)}${s.publicat_la ? `, ${esc(String(s.publicat_la).slice(0, 10))}` : ""}</span>` : ""}
                          ${s.relevanta ? `<div style="font-size:13px;color:var(--text-muted)">${esc(s.relevanta)}</div>` : ""}
                        </li>`
                      )
                      .join("")}
                  </ul>`;
              })
              .join("")
          : `<p style="color:var(--text-muted)">Nicio știre sincronizată încă.</p>`
      }
      ${stiriLa ? `<p style="font-size:12px;color:var(--text-muted)">Sincronizat ultima dată: ${esc(stiriLa)}.</p>` : ""}
    `;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Dashboard", active: "/", body }));
  });
}

module.exports = { register };
