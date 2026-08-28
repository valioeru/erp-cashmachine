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
const { send, redirect } = require("../lib/router");

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

// ------------------------------------------------------------------
// Cifra de afaceri, care nu e același lucru cu „cât am facturat".
// ------------------------------------------------------------------
// Într-un an intră pe facturi și lucruri care nu sunt cifră de afaceri:
// vânzarea unui mijloc fix, o refacturare de utilități, penalități,
// diferențe de curs. Le scoatem după o listă de tipare pe care Vali o poate
// schimba din pagină — nu ghicim în cod ce e „activ" la firma lui, dar nici
// nu-l punem să bifeze factură cu factură.
const EXCLUDERI_IMPLICITE = [
  "mijloc fix",
  "mijloace fixe",
  "vanzare activ",
  "vânzare activ",
  "casare",
  "autoturism",
  "autovehicul",
  "penalit",
  "dobând",
  "dobanda",
  "diferenta de curs",
  "diferență de curs",
  "refactur",
].join("\n");

const CHEIE_EXCLUDERI = "ca_excluderi";
const cheieManual = (an) => `ca_manual_${an}`;

async function setare(cheie, implicit) {
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(cheie);
    return r && r.valoare !== null && r.valoare !== undefined ? r.valoare : implicit;
  } catch (e) {
    return implicit;
  }
}

async function scrieSetare(cheie, valoare) {
  const t = new Date().toISOString().slice(0, 19).replace("T", " ");
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(valoare, t, cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, valoare, t);
}

function tipare(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// Facturat, minus liniile care se potrivesc cu tiparele de excludere.
// Excluderea se face pe LINIE, nu pe factură: o factură poate avea și marfă,
// și o penalitate — scoatem doar penalitatea.
async function cifraAfaceriIntre(de, la, listaTipare) {
  const linii = await db
    .prepare(
      `SELECT COALESCE(fl.denumire, p.denumire) AS denumire, SUM(fl.cantitate * fl.pret_unitar) AS net
         FROM facturi f
         JOIN facturi_linii fl ON fl.factura_id = f.id
         LEFT JOIN produse p ON p.id = fl.produs_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?
        GROUP BY COALESCE(fl.denumire, p.denumire)`
    )
    .all(de, la);
  let total = 0;
  let scos = 0;
  for (const l of linii) {
    const d = String(l.denumire || "").toLowerCase();
    const net = Number(l.net) || 0;
    if (listaTipare.some((t) => d.includes(t))) scos += net;
    else total += net;
  }
  return { total, scos };
}

// Profitul contabil dintr-o balanță: clasa 7 (venituri) minus clasa 6
// (cheltuieli). Luăm ultima balanță din an care se încheie până la ziua
// echivalentă — dacă nu există una exact pe zi, spunem pe ce dată e cea
// folosită, ca să nu pară o comparație mai exactă decât e.
async function profitContabil(an, panaLa) {
  let sn;
  try {
    sn = await db
      .prepare(
        `SELECT eticheta, MAX(data_pana) AS pana FROM balante_snapshot
          WHERE data_pana >= ? AND data_pana <= ?
          GROUP BY eticheta ORDER BY MAX(data_pana) DESC LIMIT 1`
      )
      .get(`${an}-01-01`, panaLa);
  } catch (e) {
    return null;
  }
  if (!sn || !sn.eticheta) return null;
  const r = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN cont LIKE '7%' THEN (CASE WHEN ts_c <> 0 OR ts_d <> 0 THEN ts_c - ts_d ELSE r_c - r_d END) ELSE 0 END), 0) AS venituri,
         COALESCE(SUM(CASE WHEN cont LIKE '6%' THEN (CASE WHEN ts_c <> 0 OR ts_d <> 0 THEN ts_d - ts_c ELSE r_d - r_c END) ELSE 0 END), 0) AS cheltuieli
       FROM balante_snapshot WHERE eticheta = ? AND LENGTH(cont) <= 4`
    )
    .get(sn.eticheta);
  const venituri = Number((r && r.venituri) || 0);
  const cheltuieli = Number((r && r.cheltuieli) || 0);
  if (!venituri && !cheltuieli) return null;
  return { profit: venituri - cheltuieli, venituri, cheltuieli, pana: sn.pana, eticheta: sn.eticheta };
}

// Un tabel „ca primul": patru ani, aceeași fereastră, bară + valoare + diferență.
function tabelAni(randuri, culoarePrima) {
  const acum = randuri[0] ? randuri[0].valoare : 0;
  const max = Math.max(1, ...randuri.map((x) => Math.abs(x.valoare)));
  return randuri
    .map((x, i) => {
      const lat = (Math.abs(x.valoare) / max) * 100;
      const d = i === 0 ? null : acum - x.valoare;
      const p = i === 0 || x.valoare <= 0 ? null : (d / x.valoare) * 100;
      return `
        <div class="an-rand">
          <div class="an-eticheta">${x.an}${i === 0 ? " <span style='color:var(--text-muted);font-weight:400'>(la zi)</span>" : ""}${
            x.nota ? ` <span style="color:var(--text-muted);font-weight:400;font-size:11px">${esc(x.nota)}</span>` : ""
          }</div>
          <div class="an-bara"><span style="width:${lat.toFixed(1)}%;background:${i === 0 ? culoarePrima : "var(--viz-neutru)"}"></span></div>
          <div class="an-val">${money(x.valoare)}</div>
          <div class="an-dif">${d === null ? "" : `${sageata(d)} ${money(Math.abs(d))}${p === null ? "" : ` · ${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`}`}</div>
        </div>`;
    })
    .join("");
}

// Cine aduce banii și cine s-a răcit — pe aceeași fereastră ca restul
// dashboard-ului, ca să se poată compara cinstit cu anul trecut.
async function topClienti(de, la, deAnTrecut, laAnTrecut) {
  const acum = await db
    .prepare(
      `SELECT f.partener_id, p.nume, COALESCE(SUM(t.net), 0) AS net
         FROM facturi f JOIN ${SUB_TOTAL_NET} t ON t.factura_id = f.id
         JOIN parteneri p ON p.id = f.partener_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?
        GROUP BY f.partener_id, p.nume ORDER BY net DESC LIMIT 12`
    )
    .all(de, la);
  const inainte = await db
    .prepare(
      `SELECT f.partener_id, COALESCE(SUM(t.net), 0) AS net
         FROM facturi f JOIN ${SUB_TOTAL_NET} t ON t.factura_id = f.id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?
        GROUP BY f.partener_id`
    )
    .all(deAnTrecut, laAnTrecut);
  const vechi = new Map(inainte.map((x) => [Number(x.partener_id), Number(x.net) || 0]));
  return acum.map((c) => {
    const v = vechi.get(Number(c.partener_id)) || 0;
    return { ...c, net: Number(c.net) || 0, anul_trecut: v, delta: (Number(c.net) || 0) - v };
  });
}

// Clienți care cumpărau anul trecut în fereastra asta și anul ăsta n-au mai
// cumpărat deloc. Ăștia sunt cei de sunat, nu cei din top.
async function clientiPierduti(de, la, deAnTrecut, laAnTrecut) {
  return await db
    .prepare(
      `SELECT p.id, p.nume, COALESCE(SUM(t.net), 0) AS net_an_trecut
         FROM facturi f JOIN ${SUB_TOTAL_NET} t ON t.factura_id = f.id
         JOIN parteneri p ON p.id = f.partener_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?
          AND NOT EXISTS (
            SELECT 1 FROM facturi f2 WHERE f2.partener_id = f.partener_id AND f2.directie = 'vanzare'
              AND f2.status NOT IN ('anulata','ciorna') AND f2.data_emiterii >= ? AND f2.data_emiterii <= ?
          )
        GROUP BY p.id, p.nume ORDER BY net_an_trecut DESC LIMIT 10`
    )
    .all(deAnTrecut, laAnTrecut, de, la);
}

// Ce s-a vândut, ca produs. Are sens doar cât detaliul pe linii e adus din
// SmartBill — de-aia scriem lângă el pe câte facturi ne bazăm.
async function topProduse(de, la) {
  const randuri = await db
    .prepare(
      `SELECT COALESCE(pr.denumire, fl.denumire) AS denumire,
              COALESCE(SUM(fl.cantitate * fl.pret_unitar), 0) AS net,
              COALESCE(SUM(fl.cantitate), 0) AS cant
         FROM facturi f JOIN facturi_linii fl ON fl.factura_id = f.id
         LEFT JOIN produse pr ON pr.id = fl.produs_id
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND COALESCE(f.intercompany,0) = 0
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?
        GROUP BY COALESCE(pr.denumire, fl.denumire) ORDER BY net DESC LIMIT 12`
    )
    .all(de, la);
  const acoperire = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM facturi_linii fl WHERE fl.factura_id = f.id) THEN 1 ELSE 0 END) AS cu_linii
         FROM facturi f
        WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
          AND f.data_emiterii >= ? AND f.data_emiterii <= ?`
    )
    .get(de, la);
  return { randuri, acoperire };
}

// Banii de luat: cât, din care restant, și de când stă cea mai veche.
async function deIncasat(aziStr) {
  return await db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(x.rest), 0) AS suma,
              COALESCE(SUM(CASE WHEN x.data_scadenta < ? THEN x.rest ELSE 0 END), 0) AS restant,
              MIN(CASE WHEN x.data_scadenta < ? THEN x.data_scadenta END) AS cea_mai_veche
         FROM (
           SELECT f.data_scadenta,
                  COALESCE((SELECT SUM(fl.cantitate * fl.pret_unitar * (1 + COALESCE(fl.cota_tva,0)/100.0)) FROM facturi_linii fl WHERE fl.factura_id = f.id), 0)
                  - COALESCE((SELECT SUM(pl.suma) FROM plati pl WHERE pl.factura_id = f.id), 0) AS rest
             FROM facturi f
            WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna')
         ) x
        WHERE x.rest > 1`
    )
    .get(aziStr, aziStr);
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

    // ---- 1b. Cifra de afaceri (fără vânzări de active și restul) ---------
    const listaTipare = tipare(await setare(CHEIE_EXCLUDERI, EXCLUDERI_IMPLICITE));
    const caPeAn = [];
    let scosTotalAnCurent = 0;
    for (const an of ani) {
      const r = await cifraAfaceriIntre(`${an}-01-01`, `${an}-${zileLuna}`, listaTipare);
      if (an === anCurent) scosTotalAnCurent = r.scos;
      caPeAn.push({ an, valoare: r.total, scos: r.scos });
    }
    // Suma pusă de mână pentru anul curent bate calculul — și tot tabelul se
    // recalculează față de ea, altfel butonul n-ar servi la nimic.
    const manualBrut = await setare(cheieManual(anCurent), null);
    const manual = manualBrut === null || manualBrut === "" ? null : Number(manualBrut);
    const caManualActiv = manual !== null && Number.isFinite(manual);
    const caCalculatAnCurent = caPeAn[0].valoare;
    if (caManualActiv) caPeAn[0].valoare = manual;
    if (caManualActiv) caPeAn[0].nota = "corectat manual";

    // ---- 1c. Profit contabil din balanțe (doar administrator) ------------
    const esteAdminDash = ctx.user && ctx.user.rol === "admin";
    let profitContabilPeAn = [];
    if (esteAdminDash) {
      for (const an of ani) {
        const r = await profitContabil(an, `${an}-${zileLuna}`);
        profitContabilPeAn.push({
          an,
          valoare: r ? r.profit : 0,
          nota: r ? (String(r.pana).slice(0, 10) === `${an}-${zileLuna}` ? null : `balanță la ${String(r.pana).slice(0, 10)}`) : "fără balanță",
          lipsa: !r,
        });
      }
    }

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

    // ---- 2b. Rapoartele de sub grafic ------------------------------------
    const deAnul = `${anCurent}-01-01`;
    const laAzi = `${anCurent}-${zileLuna}`;
    const deAnTrecut = `${anCurent - 1}-01-01`;
    const laAnTrecut = `${anCurent - 1}-${zileLuna}`;
    const clientiTop = await topClienti(deAnul, laAzi, deAnTrecut, laAnTrecut);
    const pierduti = await clientiPierduti(deAnul, laAzi, deAnTrecut, laAnTrecut);
    const produse = await topProduse(deAnul, laAzi);
    const incasat = await deIncasat(aziStr);

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
            <div style="font-size:13px;color:var(--text-muted)">Cifră de afaceri la zi — fără vânzări de active și fără ce nu intră în CA</div>
            <div class="hero-nr">${money(caPeAn[0].valoare)}</div>
            <div class="hero-sub">
              ${
                caManualActiv
                  ? `Sumă pusă de tine. Calculul din facturi dădea ${money(caCalculatAnCurent)}.`
                  : scosTotalAnCurent > 0
                    ? `Din facturat s-au scos ${money(scosTotalAnCurent)} care nu sunt cifră de afaceri.`
                    : "Nimic de scos în anul curent după tiparele de mai jos."
              }
            </div>
          </div>
        </div>
        <div class="viz" style="margin-top:14px">
          ${tabelAni(caPeAn, "var(--viz-plus)")}
        </div>
        ${
          esteAdminDash
            ? `<details style="margin-top:10px">
                 <summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Corectează suma anului curent și lista de excluderi</summary>
                 <form method="post" action="/dashboard/cifra-afaceri" class="form" style="max-width:640px;margin-top:10px">
                   <label class="field"><span>Cifra de afaceri ${anCurent}, pusă de mână (lasă gol ca să revii la calcul)</span>
                     <input type="number" step="0.01" name="manual" value="${caManualActiv ? esc(String(manual)) : ""}" placeholder="${caCalculatAnCurent.toFixed(2)}">
                   </label>
                   <label class="field"><span>Ce se scoate din cifra de afaceri — un tipar pe linie, se caută în denumirea liniei de factură</span>
                     <textarea name="excluderi" rows="6">${esc(tipare(await setare(CHEIE_EXCLUDERI, EXCLUDERI_IMPLICITE)).join("\n"))}</textarea>
                   </label>
                   <div class="form-actions"><button class="btn" type="submit">Salvează și recalculează</button></div>
                 </form>
               </details>`
            : ""
        }
      </div>

      ${
        esteAdminDash
          ? `<div class="hero">
               <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start">
                 <div>
                   <div style="font-size:13px;color:var(--text-muted)">Profit contabil la zi, din balanțele din Conta — doar pentru administrator</div>
                   <div class="hero-nr" style="color:${profitContabilPeAn[0] && profitContabilPeAn[0].valoare >= 0 ? "var(--success)" : "var(--danger)"}">
                     ${profitContabilPeAn[0] && !profitContabilPeAn[0].lipsa ? money(profitContabilPeAn[0].valoare) : "—"}
                   </div>
                   <div class="hero-sub">
                     ${
                       profitContabilPeAn.some((x) => !x.lipsa)
                         ? "Venituri (clasa 7) minus cheltuieli (clasa 6), din ultima balanță încărcată pentru fiecare an."
                         : `Nu e încărcată nicio balanță. <a href="/balanta">Încarcă balanțele din Conta</a> ca să apară aici.`
                     }
                   </div>
                 </div>
                 <a class="btn secondary small" href="/balanta">Balanțe →</a>
               </div>
               ${profitContabilPeAn.some((x) => !x.lipsa) ? `<div class="viz" style="margin-top:14px">${tabelAni(profitContabilPeAn, "var(--viz-plus)")}</div>` : ""}
               <p style="font-size:12px;color:var(--text-muted);margin-top:8px">
                 Balanțele sunt fotografii pe perioade, nu pe zile. Unde nu există una fix pe ${esc(zileLuna)}, scrie lângă an data balanței folosite.
               </p>
             </div>`
          : ""
      }

      <div class="hero">
        <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div style="font-size:13px;color:var(--text-muted)">EBITDA la zi (${anCurent})</div>
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
              ? "EBITDA: vânzări nete − achiziții nete − cost salarial (brut + CAM). Fără amortizare, dobânzi și impozit — de-aia e EBITDA, nu profit contabil."
              : "Deocamdată e marjă brută: vânzări nete minus achiziții nete. Costul cu oamenii intră în calcul de îndată ce statele de plată sunt în sistem."
          }
        </p>
      </div>

      <div class="hero">
        <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div style="font-size:13px;color:var(--text-muted)">De încasat, cu TVA</div>
            <div class="hero-nr">${money(incasat.suma)}</div>
            <div class="hero-sub">
              ${Number(incasat.n || 0)} facturi neîncasate ·
              <strong style="color:${Number(incasat.restant || 0) > 0 ? "var(--danger)" : "var(--success)"}">${money(incasat.restant)}</strong> peste scadență
              ${incasat.cea_mai_veche ? ` · cea mai veche scadentă din ${esc(String(incasat.cea_mai_veche).slice(0, 10))}` : ""}
            </div>
          </div>
          <a class="btn secondary small" href="/scadente">Scadențarul →</a>
        </div>
      </div>

      <div class="doua">
        <div>
          <h2 style="margin-top:0">Clienții care aduc banii, ${esc(String(anCurent))} la zi</h2>
          ${
            clientiTop.length
              ? table(
                  ["Client", "Anul ăsta", "Aceeași perioadă anul trecut", "Diferență"],
                  clientiTop.map((c) => [
                    `<a href="/parteneri/${c.partener_id}">${esc(c.nume)}</a>`,
                    money(c.net),
                    c.anul_trecut ? money(c.anul_trecut) : "—",
                    c.anul_trecut ? `${sageata(c.delta)} ${money(Math.abs(c.delta))}` : '<span class="badge verde">client nou</span>',
                  ])
                )
              : '<p style="color:var(--text-muted)">Nicio factură în perioada asta.</p>'
          }
        </div>
        <div>
          <h2 style="margin-top:0">Cine cumpăra anul trecut și nu mai cumpără</h2>
          ${
            pierduti.length
              ? table(
                  ["Client", "Cumpăra anul trecut", ""],
                  pierduti.map((c) => [
                    `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                    money(c.net_an_trecut),
                    `<a class="link-btn" href="/crm/contact/${c.id}">Contactează</a>`,
                  ])
                )
              : '<p style="color:var(--text-muted)">Niciun client pierdut față de aceeași perioadă de anul trecut. Rar, dar se întâmplă.</p>'
          }
        </div>
      </div>

      <h2>Ce se vinde, ${esc(String(anCurent))} la zi</h2>
      ${
        produse.randuri.length
          ? table(
              ["Produs", "Cantitate", "Valoare"],
              produse.randuri.map((p) => [esc(p.denumire), Number(p.cant).toLocaleString("ro-RO", { maximumFractionDigits: 2 }), money(p.net)])
            ) +
            `<p style="font-size:12px;color:var(--text-muted)">
               Socotit din ${Number(produse.acoperire.cu_linii || 0)} din cele ${Number(produse.acoperire.total || 0)} facturi ale anului —
               atâtea au deocamdată detaliul pe produse adus din SmartBill. Pe măsură ce puntea aduce restul, tabelul se completează singur.
             </p>`
          : '<p style="color:var(--text-muted)">Încă nu e adus detaliul pe produse al facturilor. Se aduce din SmartBill, prin punte.</p>'
      }

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

  // Corectura manuală a cifrei de afaceri și lista de excluderi. Se ține în
  // setari_app, deci se ține minte peste redeploy, iar tabelul se recalculează
  // față de suma pusă de mână.
  router.post("/dashboard/cifra-afaceri", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const b = ctx.body || {};
    const brut = String(b.manual === undefined ? "" : b.manual).trim();
    const anCurent = new Date().toISOString().slice(0, 4);
    if (brut === "") await scrieSetare(cheieManual(anCurent), "");
    else {
      const n = Number(brut.replace(/\s/g, "").replace(",", "."));
      await scrieSetare(cheieManual(anCurent), Number.isFinite(n) ? String(n) : "");
    }
    if (b.excluderi !== undefined) await scrieSetare(CHEIE_EXCLUDERI, String(b.excluderi));
    redirect(ctx.res, "/");
  });
}

module.exports = { register };
