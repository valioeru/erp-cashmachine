"use strict";
// Raport „Comenzi consumabile la zi" — comenzile zilnice ale clienților de
// curierat (azi: Sameday), cu venitul, costul și marja pe zi și pe produs.
//
// De unde vine: un Excel ținut în OneDrive, un rând pe zi lucrătoare, 15
// coloane de produs și un rând de prețuri sus. Aici e același model, cu două
// diferențe care contează:
//
//   1. PREȚUL E ÎNGHEȚAT PE LINIE. În Excel exista un singur rând de prețuri,
//      aplicat la tot. Când prețurile au crescut, pe 03.06.2026, rândurile
//      vechi au rămas valori fixe, iar cele noi au devenit formule — adică
//      jumătate de istoric înghețat și jumătate viu. A doua creștere ar fi
//      rescris retroactiv 2026 și ar fi lăsat 2025 pe loc. Aici fiecare linie
//      își ține prețul zilei ei, deci o schimbare de mâine nu atinge trecutul.
//
//   2. EXISTĂ ȘI COST, deci și marjă. Costul se completează de mână, pe
//      produs, și se îngheață pe linie la fel ca prețul. Unde costul lipsește,
//      marja NU se afișează ca zero — se afișează ca necunoscută, și raportul
//      spune cât din venit n-are cost în spate. Un zero fals e mai rău decât
//      un gol declarat.
//
// Istoricul (182 de zile, 04.11.2025 → 08.10.2026) se importă o singură dată,
// din date/sameday-istoric.json, la prima pornire în care tabelul e gol.
const fs = require("fs");
const path = require("path");
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const rapoarte = require("./rapoarte");

const CLIENT = "Sameday";
const CALE = "/rapoarte/comenzi-la-zi";

const nr = (v) => Number(v || 0);

function azi() {
  return new Date().toISOString().slice(0, 10);
}

// Lunile se calculează pe șiruri, nu pe Date: un `new Date("2026-03-31")` plus
// o lună dă 1 mai, nu 30 aprilie, iar fusul orar mai mută o zi pe deasupra.
function lunaPlus(luna, pas) {
  let an = parseInt(String(luna).slice(0, 4), 10);
  let l = parseInt(String(luna).slice(5, 7), 10) + pas;
  while (l > 12) { l -= 12; an += 1; }
  while (l < 1) { l += 12; an -= 1; }
  return `${an}-${String(l).padStart(2, "0")}`;
}

function ultimaZiDinLuna(luna) {
  const an = parseInt(luna.slice(0, 4), 10);
  const l = parseInt(luna.slice(5, 7), 10);
  const z = new Date(Date.UTC(an, l, 0)).getUTCDate();
  return `${luna}-${String(z).padStart(2, "0")}`;
}

const LUNI = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];
function etichetaLuna(luna) {
  const l = parseInt(String(luna).slice(5, 7), 10);
  return `${LUNI[l - 1] || luna} ${String(luna).slice(0, 4)}`;
}

function dataRo(iso) {
  const s = String(iso || "");
  return s.length >= 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s;
}

function procent(parte, intreg) {
  return nr(intreg) > 0 ? (nr(parte) / nr(intreg)) * 100 : 0;
}

// ---- importul istoricului ---------------------------------------------------
//
// Rulează o singură dată: dacă există deja o zi în bază, nu mai face nimic.
// Nu suprascrie nimic și nu șterge nimic — dacă cineva a pus deja date de
// mână, importul se oprește și le lasă în pace.
async function seed() {
  let fisier;
  try {
    fisier = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sameday-istoric.json"), "utf8"));
  } catch (e) {
    return { produse: 0, zile: 0, motiv: "fără fișier de istoric" };
  }

  let produseNoi = 0;
  for (const p of fisier.produse || []) {
    const r = await db
      .prepare(
        `INSERT INTO consumabile_produse (cod, denumire, pret, ordine)
         VALUES (?,?,?,?) ON CONFLICT (cod) DO NOTHING`
      )
      .run(p.cod, p.denumire, nr(p.pret), nr(p.ordine));
    produseNoi += nr(r.changes);
  }

  const cateZile = nr((await db.prepare("SELECT COUNT(*) AS n FROM consumabile_zile WHERE client = ?").get(CLIENT)).n);
  if (cateZile > 0) return { produse: produseNoi, zile: 0, motiv: "istoricul era deja importat" };

  const produse = await db.prepare("SELECT id, cod, ordine FROM consumabile_produse ORDER BY ordine").all();
  const dupaCod = new Map(produse.map((p) => [p.cod, p.id]));
  const coduri = (fisier.produse || []).map((p) => p.cod);
  const preturi = fisier.preturi || [];

  let zileNoi = 0;
  for (const z of fisier.zile || []) {
    const ins = await db
      .prepare("INSERT INTO consumabile_zile (client, data, sursa) VALUES (?,?,?) RETURNING id")
      .run(CLIENT, z.d, "import Excel");
    const ziId = Number(ins.lastInsertRowid);
    const pret = preturi[z.p] || [];
    for (let i = 0; i < coduri.length; i++) {
      const cant = nr((z.q || [])[i]);
      if (!cant) continue;
      const produsId = dupaCod.get(coduri[i]);
      if (!produsId) continue;
      await db
        .prepare("INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret) VALUES (?,?,?,?)")
        .run(ziId, produsId, cant, nr(pret[i]));
    }
    zileNoi++;
  }
  console.log(`[comenzi-zi] istoric importat: ${zileNoi} zile, ${produseNoi} produse noi`);
  return { produse: produseNoi, zile: zileNoi };
}

// ---- interogările raportului ------------------------------------------------

async function peProdus(deLa, panaLa) {
  return db
    .prepare(
      `SELECT p.id, p.cod, p.denumire, p.um, p.ordine, p.cost AS cost_curent,
              SUM(l.cantitate) AS cantitate,
              SUM(l.cantitate * l.pret) AS venit,
              SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END) AS cost,
              SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END) AS venit_fara_cost
         FROM consumabile_linii l
         JOIN consumabile_zile z ON z.id = l.zi_id
         JOIN consumabile_produse p ON p.id = l.produs_id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?
        GROUP BY p.id, p.cod, p.denumire, p.um, p.ordine, p.cost
        ORDER BY p.ordine`
    )
    .all(CLIENT, deLa, panaLa);
}

async function peZi(deLa, panaLa) {
  return db
    .prepare(
      `SELECT z.data, z.sursa,
              SUM(l.cantitate * l.pret) AS venit,
              SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END) AS cost,
              SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END) AS venit_fara_cost,
              COUNT(*) AS linii
         FROM consumabile_zile z
         JOIN consumabile_linii l ON l.zi_id = z.id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?
        GROUP BY z.data, z.sursa
        ORDER BY z.data DESC`
    )
    .all(CLIENT, deLa, panaLa);
}

async function totalPerioada(deLa, panaLa) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(l.cantitate * l.pret), 0) AS venit,
              COALESCE(SUM(CASE WHEN l.cost IS NULL THEN 0 ELSE l.cantitate * l.cost END), 0) AS cost,
              COALESCE(SUM(CASE WHEN l.cost IS NULL THEN l.cantitate * l.pret ELSE 0 END), 0) AS venit_fara_cost,
              COUNT(DISTINCT z.data) AS zile
         FROM consumabile_zile z
         JOIN consumabile_linii l ON l.zi_id = z.id
        WHERE z.client = ? AND z.data >= ? AND z.data <= ?`
    )
    .get(CLIENT, deLa, panaLa);
  return r || { venit: 0, cost: 0, venit_fara_cost: 0, zile: 0 };
}

// ---- bucăți de pagină -------------------------------------------------------

function cardulLunii(titlu, t) {
  const venit = nr(t.venit);
  const cuCost = venit - nr(t.venit_fara_cost);
  const marja = cuCost - nr(t.cost);
  const pct = procent(marja, cuCost);
  return `<div class="card">
    <div class="label">${esc(titlu)}</div>
    <div class="value">${money(venit)}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
      ${cuCost > 0 ? `marjă ${money(marja)} · ${pct.toFixed(1)}%` : "marjă necunoscută (fără cost)"}
      ${nr(t.zile) ? ` · ${nr(t.zile)} zile` : ""}
    </div>
  </div>`;
}

function tabelProduse(produse, totalMarja) {
  if (!produse.length) return '<p style="color:var(--text-muted)">Nicio comandă în perioada aleasă.</p>';
  const randuri = produse.map((p) => {
    const venit = nr(p.venit);
    const cuCost = venit - nr(p.venit_fara_cost);
    const marja = cuCost - nr(p.cost);
    const areCost = cuCost > 0;
    const sub = areCost && marja < 0;
    return [
      esc(p.denumire) + (sub ? ' <span class="badge rosu">sub cost</span>' : ""),
      nr(p.cantitate).toLocaleString("ro-RO") + " " + esc(p.um || "buc"),
      money(venit),
      areCost ? money(p.cost) : "—",
      areCost ? money(marja) : "—",
      areCost ? procent(marja, cuCost).toFixed(1) + "%" : "—",
      areCost && totalMarja > 0 ? procent(marja, totalMarja).toFixed(1) + "%" : "—",
    ];
  });
  return table(
    ["Produs", "Cantitate", "Venit", "Cost", "Marjă", "Marjă %", "Din marja perioadei"],
    randuri
  );
}

function tabelZile(zile) {
  if (!zile.length) return "";
  return table(
    ["Ziua", "Venit", "Cost", "Marjă", "Marjă %", "Produse", "Sursa"],
    zile.map((z) => {
      const venit = nr(z.venit);
      const cuCost = venit - nr(z.venit_fara_cost);
      const marja = cuCost - nr(z.cost);
      return [
        `<strong>${dataRo(z.data)}</strong>`,
        money(venit),
        cuCost > 0 ? money(z.cost) : "—",
        cuCost > 0 ? money(marja) : "—",
        cuCost > 0 ? procent(marja, cuCost).toFixed(1) + "%" : "—",
        nr(z.linii),
        esc(z.sursa || ""),
      ];
    })
  );
}

function formularZi(produse, zi, cantitati) {
  const campuri = produse
    .map(
      (p) => `<label style="flex:1 1 170px;min-width:150px">
        <span style="display:block;font-size:12px;color:var(--text-muted);line-height:1.25;min-height:30px">${esc(p.denumire)}</span>
        <input name="c_${p.id}" type="number" step="any" min="0" value="${cantitati[p.id] != null ? cantitati[p.id] : ""}" placeholder="0">
      </label>`
    )
    .join("");
  return `<form method="post" action="${CALE}/zi" class="form">
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px">
      <label style="flex:0 1 190px">Ziua <input name="data" type="date" value="${esc(zi)}" required></label>
      <button class="btn" type="submit">Salvează ziua</button>
      <span style="font-size:12px;color:var(--text-muted)">Prețul se ia din lista de mai jos și rămâne înghețat pe liniile zilei.</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${campuri}</div>
  </form>`;
}

function formularCosturi(produse) {
  const randuri = produse.map((p) => [
    esc(p.denumire),
    `<input name="p_${p.id}" type="number" step="0.0001" min="0" value="${nr(p.pret) || ""}" style="width:110px">`,
    `<input name="k_${p.id}" type="number" step="0.0001" min="0" value="${p.cost == null ? "" : nr(p.cost)}" style="width:110px" placeholder="necunoscut">`,
    `<input name="n_${p.id}" value="${esc(p.nota_cost || "")}" placeholder="de unde vine costul" style="width:100%">`,
  ]);
  return `<form method="post" action="${CALE}/costuri" class="form">
    ${table(["Produs", "Preț vânzare (lei)", "Cost (lei)", "Nota — de unde vine costul"], randuri)}
    <button class="btn" type="submit" style="margin-top:10px">Salvează prețurile și costurile</button>
  </form>`;
}

// ---- rutele -----------------------------------------------------------------

function register(router) {
  router.get(CALE, async (ctx) => {
    const lunaAzi = azi().slice(0, 7);
    const luna = /^\d{4}-\d{2}$/.test(String(ctx.query.luna || "")) ? ctx.query.luna : lunaAzi;
    const deLa = `${luna}-01`;
    const panaLa = ultimaZiDinLuna(luna);

    const produse = await db.prepare("SELECT * FROM consumabile_produse WHERE activ = 1 ORDER BY ordine").all();
    const [tLuna, tTot, pProd, zile] = await Promise.all([
      totalPerioada(deLa, panaLa),
      totalPerioada("0000-01-01", "9999-12-31"),
      peProdus(deLa, panaLa),
      peZi(deLa, panaLa),
    ]);

    const ultima = await db
      .prepare("SELECT data FROM consumabile_zile WHERE client = ? ORDER BY data DESC LIMIT 1")
      .get(CLIENT);
    const tUltima = ultima ? await totalPerioada(ultima.data, ultima.data) : { venit: 0, cost: 0, venit_fara_cost: 0, zile: 0 };

    const cuCostLuna = nr(tLuna.venit) - nr(tLuna.venit_fara_cost);
    const marjaLuna = cuCostLuna - nr(tLuna.cost);
    const acoperire = procent(cuCostLuna, nr(tLuna.venit));
    const mediaZi = nr(tLuna.zile) > 0 ? nr(tLuna.venit) / nr(tLuna.zile) : 0;

    // Ziua din formular: cea de azi dacă n-are deja date, altfel tot azi —
    // formularul se completează cu ce există, ca editarea să fie corectură,
    // nu rescriere oarbă.
    const ziForm = String(ctx.query.zi || azi());
    const existente = await db
      .prepare(
        `SELECT l.produs_id, l.cantitate FROM consumabile_linii l
           JOIN consumabile_zile z ON z.id = l.zi_id
          WHERE z.client = ? AND z.data = ?`
      )
      .all(CLIENT, ziForm);
    const cantitati = {};
    for (const e of existente) cantitati[e.produs_id] = nr(e.cantitate);

    const luniSelect = [];
    for (let i = 0; i < 18; i++) luniSelect.push(lunaPlus(lunaAzi, -i));

    const corp = `
      <form class="filtre" method="get" action="${CALE}" style="margin-bottom:14px">
        <label>Luna
          <select name="luna" onchange="this.form.submit()">
            ${luniSelect.map((l) => `<option value="${l}"${l === luna ? " selected" : ""}>${etichetaLuna(l)}</option>`).join("")}
          </select>
        </label>
      </form>

      <div class="cards">
        ${cardulLunii(ultima ? `Ultima zi — ${dataRo(ultima.data)}` : "Ultima zi", tUltima)}
        ${cardulLunii(etichetaLuna(luna), tLuna)}
        ${cardulLunii("Cumulat, tot istoricul", tTot)}
        <div class="card">
          <div class="label">Media pe zi lucrătoare, ${etichetaLuna(luna)}</div>
          <div class="value">${money(mediaZi)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">din ${nr(tLuna.zile)} zile cu comenzi</div>
        </div>
      </div>

      ${
        acoperire < 99.5
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">Doar ${acoperire.toFixed(0)}% din venitul lunii are cost completat în spate. Marja de mai sus e marja produselor cu cost — restul nu e zero, e necunoscut. Completează costurile jos, în „Prețuri și costuri".</div>`
          : ""
      }

      <h2>Pe produs — ${esc(etichetaLuna(luna))}</h2>
      ${tabelProduse(pProd, marjaLuna)}

      <h2>Pe zi</h2>
      ${tabelZile(zile)}

      <h2>Adaugă sau corectează o zi</h2>
      ${formularZi(produse, ziForm, cantitati)}

      <h2>Prețuri și costuri</h2>
      <p style="font-size:12px;color:var(--text-muted);margin:-4px 0 10px">
        Prețul de aici se folosește la zilele pe care le salvezi de acum înainte. Zilele deja salvate își păstrează prețul lor —
        de-aia o creștere de preț nu rescrie istoricul. Costul lasă-l gol dacă nu-l știi: un zero ar face marja să pară 100%.
        Pentru plicul AWB C5 ai calculatorul la <a href="/calculator/awb">/calculator/awb</a>, pentru pungi la
        <a href="/calculator/pungi">/calculator/pungi</a>, pentru cutii la <a href="/calculator/cutii">/calculator/cutii</a>.
      </p>
      ${formularCosturi(produse)}
    `;
    send(ctx.res, 200, rapoarte.pagina(ctx, "Comenzi consumabile la zi", CALE, corp));
  });

  router.post(`${CALE}/zi`, async (ctx) => {
    const b = ctx.body || {};
    const data = String(b.data || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return redirect(ctx.res, CALE);

    const produse = await db.prepare("SELECT id, pret, cost FROM consumabile_produse WHERE activ = 1").all();
    let zi = await db.prepare("SELECT id FROM consumabile_zile WHERE client = ? AND data = ?").get(CLIENT, data);
    if (!zi) {
      const ins = await db
        .prepare("INSERT INTO consumabile_zile (client, data, sursa, creat_de) VALUES (?,?,?,?) RETURNING id")
        .run(CLIENT, data, "manual", ctx.user ? ctx.user.id : null);
      zi = { id: Number(ins.lastInsertRowid) };
    }

    for (const p of produse) {
      const brut = b[`c_${p.id}`];
      const cant = Number(String(brut == null ? "" : brut).replace(",", "."));
      if (!Number.isFinite(cant) || cant <= 0) {
        await db.prepare("DELETE FROM consumabile_linii WHERE zi_id = ? AND produs_id = ?").run(zi.id, p.id);
        continue;
      }
      await db
        .prepare(
          `INSERT INTO consumabile_linii (zi_id, produs_id, cantitate, pret, cost)
           VALUES (?,?,?,?,?)
           ON CONFLICT (zi_id, produs_id) DO UPDATE SET cantitate = EXCLUDED.cantitate`
        )
        .run(zi.id, p.id, cant, nr(p.pret), p.cost == null ? null : nr(p.cost));
    }
    return redirect(ctx.res, `${CALE}?luna=${data.slice(0, 7)}&zi=${data}`);
  });

  router.post(`${CALE}/costuri`, async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const produse = await db.prepare("SELECT id FROM consumabile_produse").all();
    for (const p of produse) {
      const pret = Number(String(b[`p_${p.id}`] || "").replace(",", "."));
      const costBrut = String(b[`k_${p.id}`] == null ? "" : b[`k_${p.id}`]).trim();
      const cost = costBrut === "" ? null : Number(costBrut.replace(",", "."));
      await db
        .prepare("UPDATE consumabile_produse SET pret = ?, cost = ?, nota_cost = ? WHERE id = ?")
        .run(
          Number.isFinite(pret) && pret >= 0 ? pret : 0,
          cost == null || !Number.isFinite(cost) ? null : cost,
          String(b[`n_${p.id}`] || "").slice(0, 200) || null,
          p.id
        );
    }
    return redirect(ctx.res, CALE);
  });
}

module.exports = { register, seed };
