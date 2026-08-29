"use strict";
// Producție · Utilaje și Resurse.
//
// Până acum producția știa CE are de făcut (comenzile) și DIN CE (rețetele),
// dar nu știa PE CE și CU CINE. Asta e partea care lipsea.
//
// Trei idei simple stau la baza modulului:
//
// 1. Capacitatea nu e o proprietate a mașinii, ci a perechii mașină–produs.
//    Aceeași extrudere scoate 400 kg pe oră dintr-o folie și 90 din alta.
//    De-aia „cât scoate" stă în „utilaje_capacitate", nu în „utilaje".
//    Cifra o scrie operatorul — nu o deducem noi din facturi, fiindcă
//    facturile spun ce s-a vândut, nu cât poate mașina.
//
// 2. Un utilaj fără oameni e fier vechi. Fiecare mașină spune de câți
//    operatori are nevoie, fiecare om spune ce mașini știe să lucreze, iar
//    alocarea le pune cap la cap: nu poți pune o comandă pe o mașină fără
//    să pui și oamenii pe ea.
//
// 3. Planificarea se citește pe ore, nu pe bifă. O zi are un număr de ore de
//    utilaj (ore_pe_zi) — dacă alocările depășesc numărul ăla, ziua e
//    supraîncărcată și se vede roșu, nu se descoperă în atelier.
const db = require("../lib/db");
const { esc, layout, table, subnavProductie } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => Number(v || 0);

// Diacriticele și spațiile duble sunt singura diferență dintre „Folie PE" și
// „folie  pe" — pentru potrivirea produsului cu capacitatea, nu contează.
function normalizeaza(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function ziPlus(dataStr, n) {
  const d = new Date(dataStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ZILE_RO = ["Du", "Lu", "Ma", "Mi", "Jo", "Vi", "Sâ"];
function numeZi(dataStr) {
  return ZILE_RO[new Date(dataStr + "T00:00:00Z").getUTCDay()];
}
function eWeekend(dataStr) {
  const z = new Date(dataStr + "T00:00:00Z").getUTCDay();
  return z === 0 || z === 6;
}

function ore(v) {
  const n = nr(v);
  if (!n) return "0";
  return n.toLocaleString("ro-RO", { minimumFractionDigits: n % 1 ? 1 : 0, maximumFractionDigits: 1 });
}

function cant(v) {
  const n = nr(v);
  return n.toLocaleString("ro-RO", { maximumFractionDigits: 2 });
}

// Cantitatea din comenzi e text liber („1.200", „1200 kg", „12,5"). Ce nu se
// poate citi ca număr rămâne necunoscut — mai bine fără estimare decât cu una
// inventată.
function cantitateDin(text) {
  const s = String(text || "").replace(/\s/g, "").replace(/\.(?=\d{3}(?!\d))/g, "").replace(",", ".");
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

const NIVELURI = [
  [1, "învață"],
  [2, "poate"],
  [3, "expert"],
];

// ---------------------------------------------------------------------------
// Estimarea timpului: cât ține o comandă pe fiecare utilaj care o poate face.
// Folosită și de pagina de alocare, și de tabelul „Comenzi spre alocare" din
// /productie — de-aia e exportată.
// ---------------------------------------------------------------------------
async function capacitati() {
  return db
    .prepare(
      `SELECT c.*, u.denumire AS utilaj, u.cod AS utilaj_cod, u.operatori_necesari, u.ore_pe_zi,
              p.denumire AS produs_denumire, p.cod AS produs_cod
         FROM utilaje_capacitate c
         JOIN utilaje u ON u.id = c.utilaj_id AND u.activ = 1
         LEFT JOIN produse p ON p.id = c.produs_id
        ORDER BY u.denumire`
    )
    .all();
}

function potriveste(cap, comanda) {
  if (cap.produs_id && comanda.produs_id && Number(cap.produs_id) === Number(comanda.produs_id)) return true;
  const tinta = normalizeaza(comanda.tip_produs);
  if (!tinta) return false;
  for (const eticheta of [cap.produs_text, cap.produs_denumire, cap.produs_cod]) {
    const e = normalizeaza(eticheta);
    if (!e) continue;
    if (e === tinta || tinta.includes(e) || e.includes(tinta)) return true;
  }
  return false;
}

// Pentru fiecare comandă, lista utilajelor care o pot face și în câte ore.
// Timpul de pregătire se adaugă o singură dată — e reglajul mașinii, nu se
// înmulțește cu bucățile.
function estimeaza(comenzi, caps) {
  const harta = new Map();
  for (const c of comenzi) {
    const q = cantitateDin(c.cantitate);
    const variante = [];
    for (const cap of caps) {
      if (!potriveste(cap, c)) continue;
      const pePiesa = nr(cap.cantitate_ora) > 0 && q > 0 ? q / nr(cap.cantitate_ora) : 0;
      variante.push({
        utilaj_id: cap.utilaj_id,
        utilaj: cap.utilaj,
        operatori_necesari: nr(cap.operatori_necesari) || 1,
        cantitate_ora: nr(cap.cantitate_ora),
        ore: pePiesa + nr(cap.timp_pregatire),
        estimat: pePiesa > 0,
      });
    }
    variante.sort((a, b) => (a.ore || 1e9) - (b.ore || 1e9));
    harta.set(Number(c.id), variante);
  }
  return harta;
}

// Comenzile deschise care n-au nicio alocare pe un utilaj. Tabelul „Comenzi
// spre alocare" de pe /productie se construiește de aici.
async function comenziSpreAlocare(limita = 50) {
  const comenzi = await db
    .prepare(
      `SELECT c.*, p.nume AS partener_nume
         FROM comenzi_productie c
         LEFT JOIN parteneri p ON p.id = c.partener_id
        WHERE c.status IN ('noua','in_productie')
          AND NOT EXISTS (SELECT 1 FROM alocari_productie a WHERE a.comanda_productie_id = c.id AND a.status <> 'anulata')
        ORDER BY (c.data_livrare IS NULL OR c.data_livrare = ''), c.data_livrare ASC, c.id DESC
        LIMIT ?`
    )
    .all(limita);
  if (!comenzi.length) return { comenzi: [], estimari: new Map(), oameni: 0, utilaje: 0 };
  const caps = await capacitati();
  const oameni = nr((await db.prepare("SELECT COUNT(*) AS n FROM resurse WHERE activ = 1").get()).n);
  const utilaje = nr((await db.prepare("SELECT COUNT(*) AS n FROM utilaje WHERE activ = 1").get()).n);
  return { comenzi, estimari: estimeaza(comenzi, caps), oameni, utilaje };
}

// Ore alocate pe utilaj / pe zi, într-o fereastră. Returnează o hartă cu
// cheia „utilajId|data".
async function incarcareUtilaje(deLa, panaLa) {
  const randuri = await db
    .prepare(
      `SELECT utilaj_id, data, SUM(ore) AS ore, COUNT(*) AS n
         FROM alocari_productie
        WHERE status <> 'anulata' AND data >= ? AND data <= ? AND utilaj_id IS NOT NULL
        GROUP BY utilaj_id, data`
    )
    .all(deLa, panaLa);
  const h = new Map();
  for (const r of randuri) h.set(`${r.utilaj_id}|${r.data}`, { ore: nr(r.ore), n: nr(r.n) });
  return h;
}

async function incarcareResurse(deLa, panaLa) {
  const randuri = await db
    .prepare(
      `SELECT ar.resursa_id, a.data, SUM(a.ore) AS ore
         FROM alocari_resurse ar
         JOIN alocari_productie a ON a.id = ar.alocare_id
        WHERE a.status <> 'anulata' AND a.data >= ? AND a.data <= ?
        GROUP BY ar.resursa_id, a.data`
    )
    .all(deLa, panaLa);
  const h = new Map();
  for (const r of randuri) h.set(`${r.resursa_id}|${r.data}`, nr(r.ore));
  return h;
}

function culoareIncarcare(oreAlocate, capacitate) {
  if (!oreAlocate) return "";
  const p = capacitate > 0 ? oreAlocate / capacitate : 1;
  if (p > 1.001) return "background:#fde8e8;color:#a02020;font-weight:600";
  if (p > 0.85) return "background:#fdf3d8;color:#8a6100;font-weight:600";
  return "background:#e6f5ec;color:#1c6b3c;font-weight:600";
}

function register(router) {
  // =========================================================================
  // UTILAJE
  // =========================================================================
  router.get("/productie/utilaje", async (ctx) => {
    const toate = String(ctx.query.toate || "") === "1";
    const utilaje = await db
      .prepare(
        `SELECT u.*,
                (SELECT COUNT(*) FROM utilaje_capacitate c WHERE c.utilaj_id = u.id) AS nr_capacitati,
                (SELECT COUNT(*) FROM resurse_competente rc JOIN resurse r ON r.id = rc.resursa_id AND r.activ = 1
                  WHERE rc.utilaj_id = u.id) AS nr_oameni
           FROM utilaje u
          ${toate ? "" : "WHERE u.activ = 1"}
          ORDER BY u.activ DESC, u.denumire`
      )
      .all();

    const deLa = azi();
    const panaLa = ziPlus(deLa, 6);
    const incarcare = await incarcareUtilaje(deLa, panaLa);
    const oreSaptamana = new Map();
    for (const [cheie, v] of incarcare) {
      const id = Number(cheie.split("|")[0]);
      oreSaptamana.set(id, (oreSaptamana.get(id) || 0) + v.ore);
    }

    const active = utilaje.filter((u) => Number(u.activ) === 1);
    const faraCapacitate = active.filter((u) => !nr(u.nr_capacitati));
    const faraOameni = active.filter((u) => !nr(u.nr_oameni));
    const capacitateSaptamana = active.reduce((s, u) => s + nr(u.ore_pe_zi) * 5, 0);
    const alocateSaptamana = [...oreSaptamana.values()].reduce((s, v) => s + v, 0);

    const body = `
      ${subnavProductie("/productie/utilaje", ctx.user)}
      <div class="cards">
        <div class="card"><div class="label">Utilaje active</div><div class="value">${active.length}</div></div>
        <div class="card"><div class="label">Ore utilaj disponibile / săptămână</div><div class="value">${ore(capacitateSaptamana)}</div>
          <div style="font-size:12px;color:var(--text-muted)">5 zile lucrătoare × ore/zi</div></div>
        <div class="card"><div class="label">Ore deja planificate (7 zile)</div><div class="value">${ore(alocateSaptamana)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${capacitateSaptamana > 0 ? Math.round((alocateSaptamana / capacitateSaptamana) * 100) : 0}% din capacitate</div></div>
        <div class="card"><div class="label">Fără capacitate definită</div><div class="value" style="color:${faraCapacitate.length ? "var(--danger)" : "inherit"}">${faraCapacitate.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">nu pot estima timpii pe ele</div></div>
      </div>

      ${
        faraCapacitate.length
          ? `<div class="detail-box" style="border-left:4px solid var(--danger)">
               <strong>${faraCapacitate.length} utilaj${faraCapacitate.length === 1 ? "" : "e"} fără nicio capacitate scrisă:</strong>
               ${faraCapacitate.map((u) => `<a href="/productie/utilaje/${u.id}">${esc(u.denumire)}</a>`).join(", ")}.
               Cât timp nu scrie nimeni cât scoate mașina pe oră dintr-un produs, ERP-ul nu poate spune cât ține o comandă —
               nici aici, nici în „Comenzi spre alocare".
             </div>`
          : ""
      }

      ${table(
        ["Cod", "Utilaj", "Locație", "Operatori", "Ore/zi", "Produse", "Oameni", "Planificat 7 zile", "Stare", ""],
        utilaje.map((u) => {
          const alocat = oreSaptamana.get(Number(u.id)) || 0;
          const cap = nr(u.ore_pe_zi) * 5;
          return [
            esc(u.cod || "—"),
            `<a href="/productie/utilaje/${u.id}">${esc(u.denumire)}</a>`,
            esc(u.locatie || "—"),
            String(nr(u.operatori_necesari) || 1),
            ore(u.ore_pe_zi),
            nr(u.nr_capacitati) ? String(nr(u.nr_capacitati)) : '<span class="badge gri">—</span>',
            nr(u.nr_oameni) ? String(nr(u.nr_oameni)) : '<span class="badge rosu">niciunul</span>',
            `<span style="${culoareIncarcare(alocat, cap)};padding:2px 6px;border-radius:4px">${ore(alocat)} h</span>`,
            Number(u.activ) === 1 ? '<span class="badge verde">activ</span>' : '<span class="badge gri">scos</span>',
            `<a class="btn small secondary" href="/productie/utilaje/${u.id}">Deschide</a>`,
          ];
        })
      )}

      <p style="font-size:12px;color:var(--text-muted)">
        ${toate ? `<a href="/productie/utilaje">Arată doar utilajele active</a>` : `<a href="/productie/utilaje?toate=1">Arată și utilajele scoase din uz</a>`}
      </p>

      <details class="detail-box" style="margin-top:16px"${utilaje.length ? "" : " open"}>
        <summary style="cursor:pointer;font-weight:600">+ Utilaj nou</summary>
        <form class="form" method="post" action="/productie/utilaje" style="max-width:720px;margin-top:12px">
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
            <label class="field">Cod<input name="cod" placeholder="EXT-1"></label>
            <label class="field">Denumire<input name="denumire" required placeholder="Extruder 1400"></label>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
            <label class="field">Locație<input name="locatie" placeholder="Hala 1"></label>
            <label class="field">Operatori necesari<input type="number" name="operatori_necesari" min="0" step="1" value="1"></label>
            <label class="field">Ore pe zi<input type="number" name="ore_pe_zi" min="0" step="0.5" value="8"></label>
          </div>
          <label class="field">Descriere<textarea name="descriere" rows="2"></textarea></label>
          <div class="form-actions"><button class="btn" type="submit">Adaugă utilajul</button></div>
        </form>
      </details>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Utilaje (${active.length})`, active: "/productie/utilaje", body }));
  });

  router.post("/productie/utilaje", async (ctx) => {
    const b = ctx.body;
    const denumire = String(b.denumire || "").trim();
    if (!denumire) return redirect(ctx.res, "/productie/utilaje");
    const r = await db
      .prepare(
        `INSERT INTO utilaje (cod, denumire, descriere, locatie, operatori_necesari, ore_pe_zi, activ)
         VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`
      )
      .run(
        String(b.cod || "").trim() || null,
        denumire,
        String(b.descriere || "").trim() || null,
        String(b.locatie || "").trim() || null,
        Math.max(0, Math.round(nr(b.operatori_necesari) || 1)),
        nr(b.ore_pe_zi) || 8
      );
    redirect(ctx.res, `/productie/utilaje/${r.lastInsertRowid || ""}`);
  });

  router.get("/productie/utilaje/:id", async (ctx) => {
    const u = await db.prepare("SELECT * FROM utilaje WHERE id = ?").get(ctx.params.id);
    if (!u) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/productie/utilaje", body: "<p>Utilajul nu există.</p>" }));

    const caps = await db
      .prepare(
        `SELECT c.*, p.denumire AS produs_denumire, p.cod AS produs_cod, p.unitate_masura
           FROM utilaje_capacitate c LEFT JOIN produse p ON p.id = c.produs_id
          WHERE c.utilaj_id = ? ORDER BY COALESCE(p.denumire, c.produs_text)`
      )
      .all(u.id);

    const oameni = await db
      .prepare(
        `SELECT r.id, r.nume, r.functie, r.schimb, rc.nivel
           FROM resurse_competente rc JOIN resurse r ON r.id = rc.resursa_id
          WHERE rc.utilaj_id = ? AND r.activ = 1 ORDER BY rc.nivel DESC, r.nume`
      )
      .all(u.id);

    const alocari = await db
      .prepare(
        `SELECT a.*, c.numar, c.tip_produs, c.client_text, p.nume AS partener_nume
           FROM alocari_productie a
           JOIN comenzi_productie c ON c.id = a.comanda_productie_id
           LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE a.utilaj_id = ? AND a.status <> 'anulata' AND a.data >= ?
          ORDER BY a.data, a.ora_start LIMIT 60`
      )
      .all(u.id, ziPlus(azi(), -7));

    const produse = await db
      .prepare(
        `SELECT p.id, p.cod, p.denumire, p.unitate_masura FROM produse p
          WHERE p.id IN (SELECT produs_id FROM retete_componente)
             OR p.id IN (SELECT produs_id FROM comenzi_productie WHERE produs_id IS NOT NULL)
             OR p.id IN (SELECT produs_id FROM utilaje_capacitate WHERE produs_id IS NOT NULL)
          ORDER BY p.denumire LIMIT 500`
      )
      .all();

    const body = `
      ${subnavProductie("/productie/utilaje", ctx.user)}
      <div class="toolbar"><a class="btn secondary" href="/productie/utilaje">← Toate utilajele</a>
        <a class="btn secondary" href="/productie/planificare">Vezi planificarea</a></div>

      <form class="form" method="post" action="/productie/utilaje/${u.id}" style="max-width:760px">
        <h1 style="margin-top:0">${esc(u.denumire)} ${Number(u.activ) === 1 ? '<span class="badge verde">activ</span>' : '<span class="badge gri">scos din uz</span>'}</h1>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
          <label class="field">Cod<input name="cod" value="${esc(u.cod || "")}"></label>
          <label class="field">Denumire<input name="denumire" required value="${esc(u.denumire)}"></label>
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Locație<input name="locatie" value="${esc(u.locatie || "")}"></label>
          <label class="field">Operatori<input type="number" name="operatori_necesari" min="0" step="1" value="${nr(u.operatori_necesari) || 1}"></label>
          <label class="field">Ore pe zi<input type="number" name="ore_pe_zi" min="0" step="0.5" value="${nr(u.ore_pe_zi) || 8}"></label>
          <label class="field">Stare<select name="activ"><option value="1"${Number(u.activ) === 1 ? " selected" : ""}>activ</option><option value="0"${Number(u.activ) === 0 ? " selected" : ""}>scos din uz</option></select></label>
        </div>
        <label class="field">Descriere<textarea name="descriere" rows="2">${esc(u.descriere || "")}</textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button></div>
      </form>

      <h2>Ce scoate pe oră</h2>
      <p style="font-size:12px;color:var(--text-muted);max-width:760px">
        Cifra asta o scrie operatorul, din atelier. Din ea iese estimarea „comanda asta ține N ore",
        pe care o vezi în „Comenzi spre alocare" și în planificare. Timpul de pregătire se adaugă o
        singură dată pe comandă — e reglajul mașinii, nu se înmulțește cu bucățile.
      </p>
      ${table(
        ["Produs", "Cantitate / oră", "UM", "Pregătire (h)", "Observații", ""],
        caps.map((c) => [
          c.produs_id ? `<a href="/produse/${c.produs_id}">${esc(c.produs_denumire || c.produs_text || "—")}</a>` : esc(c.produs_text || "—"),
          cant(c.cantitate_ora),
          esc(c.um || c.unitate_masura || "—"),
          ore(c.timp_pregatire),
          `<span style="font-size:12px;color:var(--text-muted)">${esc(c.observatii || "")}</span>`,
          `<form method="post" action="/productie/utilaje/capacitate/${c.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi capacitatea asta?')"><button class="link-btn danger" type="submit">Șterge</button></form>`,
        ])
      )}
      <form class="form" method="post" action="/productie/utilaje/${u.id}/capacitate" style="max-width:900px;margin-top:10px">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Produs din catalog
            <select name="produs_id">
              <option value="">— scriu eu denumirea mai jos —</option>
              ${produse.map((p) => `<option value="${p.id}">${esc([p.cod, p.denumire].filter(Boolean).join(" · "))}</option>`).join("")}
            </select>
          </label>
          <label class="field">Cantitate / oră<input type="number" name="cantitate_ora" min="0" step="0.01" required></label>
          <label class="field">UM<input name="um" placeholder="kg"></label>
          <label class="field">Pregătire (h)<input type="number" name="timp_pregatire" min="0" step="0.25" value="0"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">…sau produs scris liber<input name="produs_text" placeholder="folie termocontractabilă 100µ"></label>
          <label class="field">Observații<input name="observatii"></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Adaugă capacitatea</button></div>
      </form>

      <h2>Cine o poate lucra</h2>
      ${
        oameni.length
          ? table(
              ["Om", "Funcție", "Schimb", "Nivel"],
              oameni.map((o) => [
                `<a href="/productie/resurse/${o.id}">${esc(o.nume)}</a>`,
                esc(o.functie || "—"),
                esc(o.schimb || "—"),
                esc((NIVELURI.find((n) => n[0] === Number(o.nivel)) || [0, "—"])[1]),
              ])
            )
          : `<div class="detail-box" style="border-left:4px solid var(--danger)">Niciun om marcat că știe utilajul ăsta. Mașina nu poate fi alocată până nu are cel puțin
              ${nr(u.operatori_necesari) || 1} operator${(nr(u.operatori_necesari) || 1) === 1 ? "" : "i"}. Se bifează din <a href="/productie/resurse">Resurse</a>.</div>`
      }

      <h2>Planificat pe utilajul ăsta</h2>
      ${table(
        ["Data", "Ora", "Ore", "Comandă", "Client", "Produs", "Stare", ""],
        alocari.map((a) => [
          `${esc(a.data)} <span style="color:var(--text-muted);font-size:12px">${numeZi(a.data)}</span>`,
          `${ore(a.ora_start)}:00`,
          ore(a.ore),
          `<a href="/productie/${a.comanda_productie_id}">${esc(a.numar || a.comanda_productie_id)}</a>`,
          esc(a.partener_nume || a.client_text || "—"),
          esc(a.tip_produs || "—"),
          esc(a.status),
          `<form method="post" action="/productie/alocari/${a.id}/sterge" class="inline-form" onsubmit="return confirm('Anulezi alocarea?')"><button class="link-btn danger" type="submit">Anulează</button></form>`,
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: esc(u.denumire), active: "/productie/utilaje", body }));
  });

  router.post("/productie/utilaje/:id", async (ctx) => {
    const b = ctx.body;
    await db
      .prepare(
        `UPDATE utilaje SET cod = ?, denumire = ?, descriere = ?, locatie = ?, operatori_necesari = ?, ore_pe_zi = ?, activ = ? WHERE id = ?`
      )
      .run(
        String(b.cod || "").trim() || null,
        String(b.denumire || "").trim() || "Utilaj",
        String(b.descriere || "").trim() || null,
        String(b.locatie || "").trim() || null,
        Math.max(0, Math.round(nr(b.operatori_necesari) || 1)),
        nr(b.ore_pe_zi) || 8,
        String(b.activ) === "0" ? 0 : 1,
        ctx.params.id
      );
    redirect(ctx.res, `/productie/utilaje/${ctx.params.id}`);
  });

  router.post("/productie/utilaje/:id/capacitate", async (ctx) => {
    const b = ctx.body;
    const produsId = nr(b.produs_id) || null;
    const text = String(b.produs_text || "").trim() || null;
    if (!produsId && !text) return redirect(ctx.res, `/productie/utilaje/${ctx.params.id}`);
    await db
      .prepare(
        `INSERT INTO utilaje_capacitate (utilaj_id, produs_id, produs_text, cantitate_ora, um, timp_pregatire, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ctx.params.id,
        produsId,
        text,
        nr(b.cantitate_ora),
        String(b.um || "").trim() || null,
        nr(b.timp_pregatire),
        String(b.observatii || "").trim() || null
      );
    redirect(ctx.res, `/productie/utilaje/${ctx.params.id}`);
  });

  router.post("/productie/utilaje/capacitate/:id/sterge", async (ctx) => {
    const c = await db.prepare("SELECT utilaj_id FROM utilaje_capacitate WHERE id = ?").get(ctx.params.id);
    await db.prepare("DELETE FROM utilaje_capacitate WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, `/productie/utilaje/${c ? c.utilaj_id : ""}`);
  });

  // =========================================================================
  // RESURSE (oamenii)
  // =========================================================================
  router.get("/productie/resurse", async (ctx) => {
    const toate = String(ctx.query.toate || "") === "1";
    const oameni = await db
      .prepare(
        `SELECT r.*, a.functie AS functie_stat, a.nume AS nume_stat,
                (SELECT COUNT(*) FROM resurse_competente rc JOIN utilaje u ON u.id = rc.utilaj_id AND u.activ = 1
                  WHERE rc.resursa_id = r.id) AS nr_utilaje
           FROM resurse r LEFT JOIN angajati a ON a.id = r.angajat_id
          ${toate ? "" : "WHERE r.activ = 1"}
          ORDER BY r.activ DESC, r.nume`
      )
      .all();

    const deLa = azi();
    const panaLa = ziPlus(deLa, 6);
    const incarcare = await incarcareResurse(deLa, panaLa);
    const oreSaptamana = new Map();
    for (const [cheie, v] of incarcare) {
      const id = Number(cheie.split("|")[0]);
      oreSaptamana.set(id, (oreSaptamana.get(id) || 0) + v);
    }

    const competente = await db
      .prepare(
        `SELECT rc.resursa_id, u.id AS utilaj_id, u.denumire FROM resurse_competente rc
           JOIN utilaje u ON u.id = rc.utilaj_id AND u.activ = 1 ORDER BY u.denumire`
      )
      .all();
    const peOm = new Map();
    for (const c of competente) {
      if (!peOm.has(Number(c.resursa_id))) peOm.set(Number(c.resursa_id), []);
      peOm.get(Number(c.resursa_id)).push(c);
    }

    // Angajații care încă nu sunt trecuți ca resursă de producție. Lista de
    // adăugare pornește de la ei, ca numele să nu fie scris a doua oară.
    const candidati = await db
      .prepare(
        `SELECT a.id, a.nume, a.functie FROM angajati a
          WHERE COALESCE(a.activ,1) = 1 AND a.id NOT IN (SELECT COALESCE(angajat_id,0) FROM resurse)
          ORDER BY a.nume`
      )
      .all();

    const active = oameni.filter((o) => Number(o.activ) === 1);
    const faraCompetente = active.filter((o) => !nr(o.nr_utilaje));
    const oreDisponibile = active.reduce((s, o) => s + nr(o.ore_pe_zi) * 5, 0);
    const oreAlocate = [...oreSaptamana.values()].reduce((s, v) => s + v, 0);

    const body = `
      ${subnavProductie("/productie/resurse", ctx.user)}
      <div class="cards">
        <div class="card"><div class="label">Oameni în producție</div><div class="value">${active.length}</div></div>
        <div class="card"><div class="label">Ore-om disponibile / săptămână</div><div class="value">${ore(oreDisponibile)}</div></div>
        <div class="card"><div class="label">Ore-om planificate (7 zile)</div><div class="value">${ore(oreAlocate)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${oreDisponibile > 0 ? Math.round((oreAlocate / oreDisponibile) * 100) : 0}% din disponibil</div></div>
        <div class="card"><div class="label">Fără nicio competență</div><div class="value" style="color:${faraCompetente.length ? "var(--danger)" : "inherit"}">${faraCompetente.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">nu pot fi puși pe nicio mașină</div></div>
      </div>

      ${table(
        ["Nume", "Funcție", "Schimb", "Ore/zi", "Utilaje pe care le lucrează", "Planificat 7 zile", "Stare", ""],
        oameni.map((o) => {
          const alocat = oreSaptamana.get(Number(o.id)) || 0;
          const lista = peOm.get(Number(o.id)) || [];
          return [
            `<a href="/productie/resurse/${o.id}">${esc(o.nume)}</a>`,
            esc(o.functie || o.functie_stat || "—"),
            esc(o.schimb || "—"),
            ore(o.ore_pe_zi),
            lista.length
              ? lista.map((u) => `<a href="/productie/utilaje/${u.utilaj_id}" class="badge gri" style="text-decoration:none">${esc(u.denumire)}</a>`).join(" ")
              : '<span class="badge rosu">niciun utilaj</span>',
            `<span style="${culoareIncarcare(alocat, nr(o.ore_pe_zi) * 5)};padding:2px 6px;border-radius:4px">${ore(alocat)} h</span>`,
            Number(o.activ) === 1 ? '<span class="badge verde">activ</span>' : '<span class="badge gri">inactiv</span>',
            `<a class="btn small secondary" href="/productie/resurse/${o.id}">Deschide</a>`,
          ];
        })
      )}

      <p style="font-size:12px;color:var(--text-muted)">
        ${toate ? `<a href="/productie/resurse">Arată doar oamenii activi</a>` : `<a href="/productie/resurse?toate=1">Arată și oamenii inactivi</a>`}
      </p>

      <details class="detail-box" style="margin-top:16px"${oameni.length ? "" : " open"}>
        <summary style="cursor:pointer;font-weight:600">+ Om în producție</summary>
        <form class="form" method="post" action="/productie/resurse" style="max-width:760px;margin-top:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <label class="field">Din angajați
              <select name="angajat_id">
                <option value="">— scriu eu numele —</option>
                ${candidati.map((a) => `<option value="${a.id}">${esc(a.nume)}${a.functie ? " · " + esc(a.functie) : ""}</option>`).join("")}
              </select>
            </label>
            <label class="field">…sau nume scris liber<input name="nume" placeholder="Ion Popescu"></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
            <label class="field">Funcție<input name="functie" placeholder="operator extruder"></label>
            <label class="field">Schimb<input name="schimb" placeholder="1 / 2 / noapte"></label>
            <label class="field">Ore pe zi<input type="number" name="ore_pe_zi" min="0" step="0.5" value="8"></label>
          </div>
          <div class="form-actions"><button class="btn" type="submit">Adaugă omul</button></div>
        </form>
      </details>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Resurse producție (${active.length})`, active: "/productie/resurse", body }));
  });

  router.post("/productie/resurse", async (ctx) => {
    const b = ctx.body;
    const angajatId = nr(b.angajat_id) || null;
    let nume = String(b.nume || "").trim();
    if (angajatId && !nume) {
      const a = await db.prepare("SELECT nume, functie FROM angajati WHERE id = ?").get(angajatId);
      if (a) nume = a.nume;
    }
    if (!nume) return redirect(ctx.res, "/productie/resurse");
    const r = await db
      .prepare(`INSERT INTO resurse (nume, angajat_id, functie, schimb, ore_pe_zi, activ) VALUES (?, ?, ?, ?, ?, 1) RETURNING id`)
      .run(nume, angajatId, String(b.functie || "").trim() || null, String(b.schimb || "").trim() || null, nr(b.ore_pe_zi) || 8);
    redirect(ctx.res, `/productie/resurse/${r.lastInsertRowid || ""}`);
  });

  router.get("/productie/resurse/:id", async (ctx) => {
    const r = await db
      .prepare("SELECT r.*, a.nume AS nume_stat, a.functie AS functie_stat FROM resurse r LEFT JOIN angajati a ON a.id = r.angajat_id WHERE r.id = ?")
      .get(ctx.params.id);
    if (!r) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/productie/resurse", body: "<p>Omul nu există în listă.</p>" }));

    const utilaje = await db.prepare("SELECT * FROM utilaje WHERE activ = 1 ORDER BY denumire").all();
    const comp = await db.prepare("SELECT utilaj_id, nivel FROM resurse_competente WHERE resursa_id = ?").all(r.id);
    const nivele = new Map(comp.map((c) => [Number(c.utilaj_id), Number(c.nivel)]));

    const alocari = await db
      .prepare(
        `SELECT a.*, u.denumire AS utilaj, c.numar, c.tip_produs
           FROM alocari_resurse ar
           JOIN alocari_productie a ON a.id = ar.alocare_id
           JOIN comenzi_productie c ON c.id = a.comanda_productie_id
           LEFT JOIN utilaje u ON u.id = a.utilaj_id
          WHERE ar.resursa_id = ? AND a.status <> 'anulata' AND a.data >= ?
          ORDER BY a.data, a.ora_start LIMIT 60`
      )
      .all(r.id, ziPlus(azi(), -7));

    const body = `
      ${subnavProductie("/productie/resurse", ctx.user)}
      <div class="toolbar"><a class="btn secondary" href="/productie/resurse">← Toți oamenii</a></div>

      <form class="form" method="post" action="/productie/resurse/${r.id}" style="max-width:900px">
        <h1 style="margin-top:0">${esc(r.nume)} ${Number(r.activ) === 1 ? '<span class="badge verde">activ</span>' : '<span class="badge gri">inactiv</span>'}</h1>
        ${r.angajat_id ? `<p style="font-size:12px;color:var(--text-muted)">Legat de angajatul <a href="/angajati/${r.angajat_id}/editare">${esc(r.nume_stat || r.nume)}</a> din state.</p>` : ""}
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Nume<input name="nume" required value="${esc(r.nume)}"></label>
          <label class="field">Funcție<input name="functie" value="${esc(r.functie || r.functie_stat || "")}"></label>
          <label class="field">Schimb<input name="schimb" value="${esc(r.schimb || "")}"></label>
          <label class="field">Ore pe zi<input type="number" name="ore_pe_zi" min="0" step="0.5" value="${nr(r.ore_pe_zi) || 8}"></label>
          <label class="field">Stare<select name="activ"><option value="1"${Number(r.activ) === 1 ? " selected" : ""}>activ</option><option value="0"${Number(r.activ) === 0 ? " selected" : ""}>inactiv</option></select></label>
        </div>
        <label class="field">Observații<textarea name="observatii" rows="2">${esc(r.observatii || "")}</textarea></label>

        <h2>Ce utilaje știe să lucreze</h2>
        <p style="font-size:12px;color:var(--text-muted)">Bifează utilajul și alege nivelul. Doar oamenii bifați pe un utilaj apar în lista de alocare a lui.</p>
        ${
          utilaje.length
            ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
                ${utilaje
                  .map(
                    (u) => `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;display:flex;align-items:center;gap:10px">
                      <label style="display:flex;align-items:center;gap:8px;flex:1;margin:0">
                        <input type="checkbox" name="utilaj_${u.id}" value="1"${nivele.has(Number(u.id)) ? " checked" : ""}>
                        <span>${esc(u.denumire)}</span>
                      </label>
                      <select name="nivel_${u.id}" style="width:110px">
                        ${NIVELURI.map(([v, t]) => `<option value="${v}"${(nivele.get(Number(u.id)) || 2) === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
                      </select>
                    </div>`
                  )
                  .join("")}
               </div>`
            : `<p>Nu există încă niciun utilaj. <a href="/productie/utilaje">Adaugă unul întâi.</a></p>`
        }
        <div class="form-actions"><button class="btn" type="submit">Salvează</button></div>
      </form>

      <h2>Ce are de lucru</h2>
      ${table(
        ["Data", "Ora", "Ore", "Utilaj", "Comandă", "Produs"],
        alocari.map((a) => [
          `${esc(a.data)} <span style="color:var(--text-muted);font-size:12px">${numeZi(a.data)}</span>`,
          `${ore(a.ora_start)}:00`,
          ore(a.ore),
          a.utilaj_id ? `<a href="/productie/utilaje/${a.utilaj_id}">${esc(a.utilaj || "—")}</a>` : "—",
          `<a href="/productie/${a.comanda_productie_id}">${esc(a.numar || a.comanda_productie_id)}</a>`,
          esc(a.tip_produs || "—"),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: esc(r.nume), active: "/productie/resurse", body }));
  });

  router.post("/productie/resurse/:id", async (ctx) => {
    const b = ctx.body;
    const id = ctx.params.id;
    await db
      .prepare("UPDATE resurse SET nume = ?, functie = ?, schimb = ?, ore_pe_zi = ?, activ = ?, observatii = ? WHERE id = ?")
      .run(
        String(b.nume || "").trim() || "Fără nume",
        String(b.functie || "").trim() || null,
        String(b.schimb || "").trim() || null,
        nr(b.ore_pe_zi) || 8,
        String(b.activ) === "0" ? 0 : 1,
        String(b.observatii || "").trim() || null,
        id
      );

    // Competențele se rescriu în întregime din formular: ce nu e bifat, nu mai
    // e. Mai simplu și mai sigur decât să ghicim ce s-a schimbat.
    const utilaje = await db.prepare("SELECT id FROM utilaje WHERE activ = 1").all();
    for (const u of utilaje) {
      const bifat = !!b[`utilaj_${u.id}`];
      const nivel = Math.min(3, Math.max(1, Math.round(nr(b[`nivel_${u.id}`]) || 2)));
      const existent = await db.prepare("SELECT id FROM resurse_competente WHERE resursa_id = ? AND utilaj_id = ?").get(id, u.id);
      if (bifat && existent) await db.prepare("UPDATE resurse_competente SET nivel = ? WHERE id = ?").run(nivel, existent.id);
      else if (bifat) await db.prepare("INSERT INTO resurse_competente (resursa_id, utilaj_id, nivel) VALUES (?, ?, ?)").run(id, u.id, nivel);
      else if (existent) await db.prepare("DELETE FROM resurse_competente WHERE id = ?").run(existent.id);
    }
    redirect(ctx.res, `/productie/resurse/${id}`);
  });

  // =========================================================================
  // ALOCARE: comanda → utilaj + oameni + zi + ore
  // =========================================================================
  router.get("/productie/aloca/:id", async (ctx) => {
    const c = await db
      .prepare("SELECT c.*, p.nume AS partener_nume FROM comenzi_productie c LEFT JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?")
      .get(ctx.params.id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsită", active: "/productie", body: "<p>Comanda nu există.</p>" }));

    const caps = await capacitati();
    const variante = estimeaza([c], caps).get(Number(c.id)) || [];
    const utilaje = await db.prepare("SELECT * FROM utilaje WHERE activ = 1 ORDER BY denumire").all();
    const oameni = await db
      .prepare(
        `SELECT r.*, (SELECT string_agg(CAST(rc.utilaj_id AS TEXT), ',') FROM resurse_competente rc WHERE rc.resursa_id = r.id) AS utilaje
           FROM resurse r WHERE r.activ = 1 ORDER BY r.nume`
      )
      .all()
      .catch(() => []);

    // Fallback pentru harness-ul local pe SQLite, care n-are string_agg.
    let listaOameni = oameni;
    if (!listaOameni || !listaOameni.length) {
      listaOameni = await db.prepare("SELECT * FROM resurse WHERE activ = 1 ORDER BY nume").all();
      const comp = await db.prepare("SELECT resursa_id, utilaj_id FROM resurse_competente").all();
      const h = new Map();
      for (const x of comp) {
        const k = Number(x.resursa_id);
        h.set(k, (h.get(k) ? h.get(k) + "," : "") + x.utilaj_id);
      }
      listaOameni = listaOameni.map((o) => ({ ...o, utilaje: h.get(Number(o.id)) || "" }));
    }

    const alocariExistente = await db
      .prepare(
        `SELECT a.*, u.denumire AS utilaj FROM alocari_productie a LEFT JOIN utilaje u ON u.id = a.utilaj_id
          WHERE a.comanda_productie_id = ? ORDER BY a.data, a.ora_start`
      )
      .all(c.id);

    const oreImplicit = variante.length && variante[0].ore ? Math.round(variante[0].ore * 10) / 10 : 8;
    const dataImplicit = c.data_livrare && c.data_livrare > azi() ? ziPlus(c.data_livrare, -1) : azi();

    const body = `
      ${subnavProductie("/productie", ctx.user)}
      <div class="toolbar"><a class="btn secondary" href="/productie/${c.id}">← Comanda ${esc(c.numar || c.id)}</a></div>
      <div class="detail-box">
        <h1 style="margin-top:0">Alocă în producție: ${esc(c.numar || c.id)}</h1>
        <div class="detail-grid">
          <div><div class="k">Client</div>${esc(c.partener_nume || c.client_text || "—")}</div>
          <div><div class="k">Produs</div>${esc(c.tip_produs || "—")}</div>
          <div><div class="k">Cantitate</div>${esc([c.cantitate, c.um].filter(Boolean).join(" ") || "—")}</div>
          <div><div class="k">Livrare promisă</div>${esc(c.data_livrare || c.data_solicitata || "—")}</div>
        </div>
      </div>

      ${
        variante.length
          ? `<div class="detail-box"><strong>Utilajele care pot face comanda:</strong>
              <ul style="margin:8px 0 0;padding-left:18px">
                ${variante
                  .map(
                    (v) =>
                      `<li>${esc(v.utilaj)} — ${v.estimat ? `<strong>${ore(v.ore)} h</strong> (${cant(v.cantitate_ora)}/h)` : "capacitate scrisă, dar cantitatea comenzii nu se poate citi ca număr"}, ${v.operatori_necesari} operator${v.operatori_necesari === 1 ? "" : "i"}</li>`
                  )
                  .join("")}
              </ul></div>`
          : `<div class="detail-box" style="border-left:4px solid var(--danger)">
              Niciun utilaj nu are capacitate scrisă pentru „${esc(c.tip_produs || "—")}". Poți aloca oricum, dar orele le pui de mână.
              Ca să apară estimarea, scrie cantitatea pe oră în <a href="/productie/utilaje">Utilaje</a>.</div>`
      }

      <form class="form" method="post" action="/productie/aloca/${c.id}" style="max-width:900px">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:14px">
          <label class="field">Utilaj
            <select name="utilaj_id" id="alocUtilaj" required>
              <option value="">— alege —</option>
              ${utilaje
                .map((u) => {
                  const v = variante.find((x) => Number(x.utilaj_id) === Number(u.id));
                  // Preselectat e doar utilajul cel mai rapid — „selected" pe
                  // mai multe optiuni inseamna, in HTML, ultima, adica una la
                  // intamplare.
                  const celMaiBun = variante.length && Number(variante[0].utilaj_id) === Number(u.id);
                  return `<option value="${u.id}" data-ore="${v && v.ore ? Math.round(v.ore * 10) / 10 : ""}"${celMaiBun ? " selected" : ""}>${esc(u.denumire)}${v && v.estimat ? ` — ~${ore(v.ore)} h` : ""}</option>`;
                })
                .join("")}
            </select>
          </label>
          <label class="field">Data<input type="date" name="data" value="${esc(dataImplicit)}" required></label>
          <label class="field">Ora start<input type="number" name="ora_start" min="0" max="23" step="1" value="8"></label>
          <label class="field">Ore<input type="number" name="ore" id="alocOre" min="0" step="0.5" value="${oreImplicit}" required></label>
          <label class="field">Cantitate<input type="number" name="cantitate" min="0" step="0.01" value="${cantitateDin(c.cantitate) || ""}"></label>
        </div>

        <h2 style="margin-bottom:4px">Cine lucrează</h2>
        <p style="font-size:12px;color:var(--text-muted);margin-top:0">Lista se strânge singură la oamenii care știu utilajul ales.</p>
        <div id="alocOameni" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
          ${listaOameni
            .map(
              (o) => `<label class="om-optiune" data-utilaje="${esc(String(o.utilaje || ""))}" style="display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin:0">
                <input type="checkbox" name="resursa_${o.id}" value="1"> <span>${esc(o.nume)}${o.schimb ? ` <span style="color:var(--text-muted);font-size:12px">· ${esc(o.schimb)}</span>` : ""}</span>
              </label>`
            )
            .join("")}
        </div>
        ${listaOameni.length ? "" : `<p>Nu există încă niciun om în producție. <a href="/productie/resurse">Adaugă oameni.</a></p>`}

        <label class="field" style="margin-top:12px">Observații<input name="observatii"></label>
        <div class="form-actions"><button class="btn" type="submit">Alocă</button> <a class="btn secondary" href="/productie">Renunț</a></div>
      </form>

      <script>
      (function () {
        var sel = document.getElementById("alocUtilaj");
        var oreInput = document.getElementById("alocOre");
        function filtreaza() {
          var id = sel.value;
          document.querySelectorAll(".om-optiune").forEach(function (l) {
            var lista = (l.dataset.utilaje || "").split(",").filter(Boolean);
            var poate = !id || lista.indexOf(id) !== -1;
            l.style.display = poate ? "" : "none";
            if (!poate) { var cb = l.querySelector("input"); if (cb) cb.checked = false; }
          });
          var opt = sel.options[sel.selectedIndex];
          if (opt && opt.dataset.ore) oreInput.value = opt.dataset.ore;
        }
        if (sel) { sel.addEventListener("change", filtreaza); filtreaza(); }
      })();
      </script>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Alocare ${c.numar || c.id}`, active: "/productie", body }));
  });

  router.post("/productie/aloca/:id", async (ctx) => {
    const b = ctx.body;
    const utilajId = nr(b.utilaj_id) || null;
    const data = String(b.data || "").slice(0, 10) || azi();
    const r = await db
      .prepare(
        `INSERT INTO alocari_productie (comanda_productie_id, utilaj_id, data, ora_start, ore, cantitate, status, observatii, creat_de)
         VALUES (?, ?, ?, ?, ?, ?, 'planificata', ?, ?) RETURNING id`
      )
      .run(
        ctx.params.id,
        utilajId,
        data,
        nr(b.ora_start) || 8,
        nr(b.ore),
        nr(b.cantitate) || null,
        String(b.observatii || "").trim() || null,
        ctx.user ? ctx.user.nume : null
      );
    const alocareId = r.lastInsertRowid;
    if (alocareId) {
      const oameni = await db.prepare("SELECT id FROM resurse WHERE activ = 1").all();
      for (const o of oameni) {
        if (b[`resursa_${o.id}`]) await db.prepare("INSERT INTO alocari_resurse (alocare_id, resursa_id) VALUES (?, ?)").run(alocareId, o.id);
      }
    }
    // O comandă alocată nu mai e „nouă" — cineva a pus-o pe o mașină.
    await db.prepare("UPDATE comenzi_productie SET status = 'in_productie' WHERE id = ? AND status = 'noua'").run(ctx.params.id);
    redirect(ctx.res, `/productie/planificare?de_la=${encodeURIComponent(data)}`);
  });

  router.post("/productie/alocari/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM alocari_resurse WHERE alocare_id = ?").run(ctx.params.id);
    await db.prepare("DELETE FROM alocari_productie WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, ctx.req.headers.referer || "/productie/planificare");
  });

  // =========================================================================
  // PLANIFICARE: calendarul de încărcare
  // =========================================================================
  router.get("/productie/planificare", async (ctx) => {
    const zile = [7, 14, 30].includes(Number(ctx.query.zile)) ? Number(ctx.query.zile) : 14;
    const deLa = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.de_la || "")) ? String(ctx.query.de_la) : azi();
    const panaLa = ziPlus(deLa, zile - 1);
    const coloane = [];
    for (let i = 0; i < zile; i++) coloane.push(ziPlus(deLa, i));

    const utilaje = await db.prepare("SELECT * FROM utilaje WHERE activ = 1 ORDER BY denumire").all();
    const resurse = await db.prepare("SELECT * FROM resurse WHERE activ = 1 ORDER BY nume").all();
    const incU = await incarcareUtilaje(deLa, panaLa);
    const incR = await incarcareResurse(deLa, panaLa);

    const alocari = await db
      .prepare(
        `SELECT a.*, u.denumire AS utilaj, c.numar, c.tip_produs, c.client_text, c.data_livrare, p.nume AS partener_nume
           FROM alocari_productie a
           LEFT JOIN utilaje u ON u.id = a.utilaj_id
           JOIN comenzi_productie c ON c.id = a.comanda_productie_id
           LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE a.status <> 'anulata' AND a.data >= ? AND a.data <= ?
          ORDER BY a.data, a.ora_start`
      )
      .all(deLa, panaLa);

    const oameniPeAlocare = new Map();
    if (alocari.length) {
      const legaturi = await db
        .prepare(`SELECT ar.alocare_id, r.nume FROM alocari_resurse ar JOIN resurse r ON r.id = ar.resursa_id`)
        .all();
      for (const l of legaturi) {
        const k = Number(l.alocare_id);
        if (!oameniPeAlocare.has(k)) oameniPeAlocare.set(k, []);
        oameniPeAlocare.get(k).push(l.nume);
      }
    }

    const antet = (eticheta) =>
      `<tr><th style="text-align:left;position:sticky;left:0;background:var(--bg,#fff);z-index:1">${esc(eticheta)}</th>${coloane
        .map(
          (d) =>
            `<th style="font-weight:500;font-size:11px;white-space:nowrap;${eWeekend(d) ? "color:var(--text-muted)" : ""}">${numeZi(d)}<br>${d.slice(8)}.${d.slice(5, 7)}</th>`
        )
        .join("")}</tr>`;

    const gridUtilaje = `
      <table class="table" style="font-size:12px">
        <thead>${antet("Utilaj")}</thead>
        <tbody>
          ${
            utilaje.length
              ? utilaje
                  .map((u) => {
                    const capZi = nr(u.ore_pe_zi) || 8;
                    return `<tr><td style="position:sticky;left:0;background:var(--bg,#fff);white-space:nowrap"><a href="/productie/utilaje/${u.id}">${esc(u.denumire)}</a>
                      <span style="color:var(--text-muted)"> ${ore(capZi)}h/zi</span></td>${coloane
                      .map((d) => {
                        const v = incU.get(`${u.id}|${d}`);
                        const oreZi = v ? v.ore : 0;
                        return `<td style="text-align:center;${oreZi ? culoareIncarcare(oreZi, capZi) : eWeekend(d) ? "background:#fafafa" : ""}">${oreZi ? ore(oreZi) : ""}</td>`;
                      })
                      .join("")}</tr>`;
                  })
                  .join("")
              : `<tr><td colspan="${coloane.length + 1}" class="empty">Niciun utilaj definit încă. <a href="/productie/utilaje">Adaugă utilaje.</a></td></tr>`
          }
        </tbody>
      </table>`;

    const gridResurse = `
      <table class="table" style="font-size:12px">
        <thead>${antet("Om")}</thead>
        <tbody>
          ${
            resurse.length
              ? resurse
                  .map((r) => {
                    const capZi = nr(r.ore_pe_zi) || 8;
                    return `<tr><td style="position:sticky;left:0;background:var(--bg,#fff);white-space:nowrap"><a href="/productie/resurse/${r.id}">${esc(r.nume)}</a></td>${coloane
                      .map((d) => {
                        const oreZi = incR.get(`${r.id}|${d}`) || 0;
                        return `<td style="text-align:center;${oreZi ? culoareIncarcare(oreZi, capZi) : eWeekend(d) ? "background:#fafafa" : ""}">${oreZi ? ore(oreZi) : ""}</td>`;
                      })
                      .join("")}</tr>`;
                  })
                  .join("")
              : `<tr><td colspan="${coloane.length + 1}" class="empty">Niciun om în producție încă. <a href="/productie/resurse">Adaugă oameni.</a></td></tr>`
          }
        </tbody>
      </table>`;

    const body = `
      ${subnavProductie("/productie/planificare", ctx.user)}
      <form class="filtre" method="get" action="/productie/planificare">
        <label class="field" style="margin:0">De la<input type="date" name="de_la" value="${esc(deLa)}"></label>
        <select name="zile" onchange="this.form.submit()">
          ${[7, 14, 30].map((z) => `<option value="${z}"${zile === z ? " selected" : ""}>${z} zile</option>`).join("")}
        </select>
        <button class="btn small" type="submit">Arată</button>
        <a class="btn small secondary" href="/productie/planificare?de_la=${ziPlus(deLa, -zile)}&zile=${zile}">← înapoi</a>
        <a class="btn small secondary" href="/productie/planificare?de_la=${ziPlus(deLa, zile)}&zile=${zile}">înainte →</a>
      </form>

      <p style="font-size:12px;color:var(--text-muted);max-width:820px">
        Cifra din celulă e numărul de ore planificate în ziua aia. Verde = are loc, galben = aproape plin,
        roșu = s-a promis mai mult decât încape. Capacitatea unei zile e „ore pe zi" scris pe utilaj, respectiv pe om.
      </p>

      <h2>Utilaje</h2>
      <div style="overflow-x:auto">${gridUtilaje}</div>

      <h2>Oameni</h2>
      <div style="overflow-x:auto">${gridResurse}</div>

      <h2>Ce e planificat în perioada asta (${alocari.length})</h2>
      ${table(
        ["Data", "Ora", "Ore", "Utilaj", "Oameni", "Comandă", "Client", "Produs", "Livrare", ""],
        alocari.map((a) => [
          `${esc(a.data)} <span style="color:var(--text-muted);font-size:12px">${numeZi(a.data)}</span>`,
          `${ore(a.ora_start)}:00`,
          ore(a.ore),
          a.utilaj_id ? `<a href="/productie/utilaje/${a.utilaj_id}">${esc(a.utilaj || "—")}</a>` : '<span class="badge gri">fără utilaj</span>',
          (oameniPeAlocare.get(Number(a.id)) || []).map((n) => esc(n)).join(", ") || '<span class="badge rosu">niciun om</span>',
          `<a href="/productie/${a.comanda_productie_id}">${esc(a.numar || a.comanda_productie_id)}</a>`,
          esc(a.partener_nume || a.client_text || "—"),
          esc(a.tip_produs || "—"),
          a.data_livrare && a.data_livrare < a.data ? `<span class="badge rosu">${esc(a.data_livrare)}</span>` : esc(a.data_livrare || "—"),
          `<form method="post" action="/productie/alocari/${a.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi alocarea?')"><button class="link-btn danger" type="submit">Șterge</button></form>`,
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Planificare producție", active: "/productie/planificare", body }));
  });
}

module.exports = { register, comenziSpreAlocare, capacitati, estimeaza, cantitateDin, ore, culoareIncarcare };
