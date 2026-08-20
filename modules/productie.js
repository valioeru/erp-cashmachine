"use strict";
// Comenzi de producție ("comenzi în lucru") — fluxul real de la Cash Machine:
// agentul inițiază comanda cu data SOLICITATĂ de client, producția răspunde
// cu data PROPUSĂ și pornește lucrul. Cele două date sunt separate tocmai
// pentru că le stabilesc oameni diferiți — exact ce era ținut până acum în
// Excelul "Comenzi_in_lucru.xlsx".
const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { parseFisier, normalizeHeader, gasesteColoana } = require("../lib/import-utils");

const STATUSURI = [
  ["noua", "Nouă (solicitată)", "gri"],
  ["in_productie", "În producție", "galben"],
  ["finalizata", "Finalizată", "verde"],
  ["facturata", "Facturată", "verde"],
  ["anulata", "Anulată", "rosu"],
];
const DESCHISE = ["noua", "in_productie", "finalizata"];

function badge(status) {
  const g = STATUSURI.find((s) => s[0] === status);
  return g ? `<span class="badge ${g[2]}">${esc(g[1])}</span>` : esc(status);
}
function azi() {
  return new Date().toISOString().slice(0, 10);
}

// Datele din Excelul de comenzi vin în DOUĂ formate amestecate:
//   - cu punct = format românesc (19.09.2025 → 19 septembrie)
//   - cu slash = format american (09/23/2025 → 23 septembrie)
// Regula e dedusă din fișierul real (09/23 nu poate fi decât mm/dd) și se
// aplică consecvent: punct → zi.lună.an, slash → lună/zi/an. Dacă prima
// parte a unui slash-date e >12, e clar dd/mm și o întoarcem.
function parseDataComenzi(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    let luna = parseInt(m[1], 10);
    let zi = parseInt(m[2], 10);
    if (luna > 12 && zi <= 12) [luna, zi] = [zi, luna]; // era de fapt dd/mm
    if (luna > 12) return null; // ambele >12 — dată invalidă
    return `${m[3]}-${String(luna).padStart(2, "0")}-${String(zi).padStart(2, "0")}`;
  }
  return null;
}

// Statusul din Excel "plutește" între coloane (done/facturat/canceled apar
// în coloane diferite de la rând la rând) — de-aia îl căutăm în TOT rândul,
// nu doar în coloana lui. "facturat" bate "done" (e mai avansat în flux).
function statusDinRand(celule) {
  const tot = celule.map((c) => String(c || "").toLowerCase());
  if (tot.some((c) => /cancel|anulat/.test(c))) return "anulata";
  if (tot.some((c) => /facturat/.test(c))) return "facturata";
  if (tot.some((c) => /\bdone\b|finalizat/.test(c))) return "finalizata";
  if (tot.some((c) => /on\s*going|in lucru|productie/.test(c))) return "in_productie";
  return null;
}

async function utilizatorDupaNume(nume, cache) {
  const cheie = String(nume || "").trim().toLowerCase();
  if (!cheie) return null;
  if (cache.has(cheie)) return cache.get(cheie);
  const u = await db.prepare("SELECT id FROM utilizatori WHERE LOWER(nume) = ?").get(cheie);
  cache.set(cheie, u ? u.id : null);
  return u ? u.id : null;
}

async function partenerDupaNume(nume, cache) {
  const cheie = String(nume || "").trim().toLowerCase();
  if (!cheie) return null;
  if (cache.has(cheie)) return cache.get(cheie);
  const p = await db.prepare("SELECT id FROM parteneri WHERE LOWER(nume) = ? OR LOWER(nume) LIKE ?").get(cheie, cheie + " %");
  cache.set(cheie, p ? p.id : null);
  return p ? p.id : null;
}

function register(router) {
  // ---- Listă -------------------------------------------------------------
  router.get("/productie", async (ctx) => {
    const filtru = String(ctx.query.status || "deschise");
    const cauta = String(ctx.query.q || "").trim();
    const where = [];
    const args = [];
    if (filtru === "deschise") where.push(`c.status IN ('${DESCHISE.join("','")}')`);
    else if (filtru !== "toate") {
      where.push("c.status = ?");
      args.push(filtru);
    }
    if (cauta) {
      where.push("(c.client_text ILIKE ? OR c.tip_produs ILIKE ? OR c.initiator ILIKE ? OR c.numar ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    const clauza = where.length ? "WHERE " + where.join(" AND ") : "";

    const comenzi = await db
      .prepare(
        `SELECT c.*, p.nume AS partener_nume FROM comenzi_productie c
         LEFT JOIN parteneri p ON p.id = c.partener_id
         ${clauza}
         ORDER BY (c.data_solicitata IS NULL OR c.data_solicitata = ''), c.data_solicitata ASC, c.id DESC
         LIMIT 400`
      )
      .all(...args);

    const contoare = await db.prepare("SELECT status, COUNT(*) AS n FROM comenzi_productie GROUP BY status").all();
    const cnt = Object.fromEntries(contoare.map((r) => [r.status, Number(r.n)]));
    const aziStr = azi();
    // "Depășit" doar pentru ce e încă de lucrat — o comandă finalizată dar
    // nefacturată nu mai e o problemă de producție, ci de facturare.
    const ACTIVE = ["noua", "in_productie"];
    const intarziate = comenzi.filter((c) => ACTIVE.includes(c.status) && c.data_solicitata && c.data_solicitata < aziStr);

    const body = `
      <div class="toolbar">
        <a href="/productie/noua" class="btn">+ Comandă nouă în producție</a>
        <a href="/import" class="btn secondary">Import din Excel</a>
      </div>
      <div class="cards">
        ${STATUSURI.map(([v, t]) => `<div class="card"><div class="label">${esc(t)}</div><div class="value">${cnt[v] || 0}</div></div>`).join("")}
        <div class="card"><div class="label">Cu termenul depășit</div><div class="value" style="color:${intarziate.length ? "var(--danger)" : "inherit"}">${intarziate.length}</div></div>
      </div>
      <form class="filtre" method="get" action="/productie">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după client, produs, inițiator…">
        <select name="status" onchange="this.form.submit()">
          <option value="deschise"${filtru === "deschise" ? " selected" : ""}>Doar deschise</option>
          <option value="toate"${filtru === "toate" ? " selected" : ""}>Toate</option>
          ${STATUSURI.map(([v, t]) => `<option value="${v}"${filtru === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <button class="btn small" type="submit">Filtrează</button>
      </form>
      ${table(
        ["#", "Client", "Produs", "Cantitate", "Inițiator", "Solicitat (client)", "Propus (producție)", "Status"],
        comenzi.map((c) => [
          `<a href="/productie/${c.id}">${esc(c.numar || c.id)}</a>`,
          c.partener_id ? `<a href="/parteneri/${c.partener_id}">${esc(c.partener_nume || c.client_text)}</a>` : esc(c.client_text || "—"),
          esc(c.tip_produs || "—"),
          esc(c.cantitate || "—"),
          esc(c.initiator || "—"),
          c.data_solicitata
            ? ["noua", "in_productie"].includes(c.status) && c.data_solicitata < aziStr
              ? `<span class="badge rosu">${esc(c.data_solicitata)}</span>`
              : esc(c.data_solicitata)
            : "—",
          esc(c.data_propusa || "—"),
          badge(c.status),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comenzi producție (${comenzi.length})`, active: "/productie", body }));
  });

  // ---- Creare -------------------------------------------------------------
  router.get("/productie/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume LIMIT 3000").all();
    const body = `
      <form class="form" method="post" action="/productie">
        <label class="field">Client
          <select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Tip produs<input name="tip_produs" required placeholder="Ex: Pungi 300x400, Scotch 38 mic"></label>
          <label class="field">Cantitate<input name="cantitate" required placeholder="Ex: 30000 buc / 240 cutii"></label>
        </div>
        <label class="field">Data solicitată de client<input type="date" name="data_solicitata"></label>
        <label class="field">Observații / specificații<textarea name="observatii" rows="3" placeholder="Dimensiuni, personalizare, termen special"></textarea></label>
        <label class="field">Rețetă / consum estimat<textarea name="reteta" rows="2" placeholder="Ex: Folie 364 kg, Bandă 12 role, cutii 30"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Trimite în producție</button> <a class="btn secondary" href="/productie">Renunță</a></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted)">Inițiatorul e contul tău (${esc(ctx.user ? ctx.user.nume : "")}); producția completează data propusă și pornește lucrul.</p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă în producție", active: "/productie", body }));
  });

  router.post("/productie", async (ctx) => {
    const b = ctx.body;
    const partenerId = parseInt(b.partener_id, 10) || null;
    const p = partenerId ? await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(partenerId) : null;
    const nr = (await db.prepare("SELECT COUNT(*) AS n FROM comenzi_productie").get()).n;
    const ins = await db
      .prepare(
        `INSERT INTO comenzi_productie (numar, initiator, initiator_id, partener_id, client_text, tip_produs, cantitate, data_initiere, data_solicitata, status, observatii, reteta, sursa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'noua', ?, ?, 'manual') RETURNING id`
      )
      .run(
        String(Number(nr) + 1),
        ctx.user ? ctx.user.nume : null,
        ctx.user ? ctx.user.id : null,
        partenerId,
        p ? p.nume : null,
        String(b.tip_produs || "").trim(),
        String(b.cantitate || "").trim(),
        azi(),
        String(b.data_solicitata || "") || null,
        String(b.observatii || "").trim() || null,
        String(b.reteta || "").trim() || null
      );
    redirect(ctx.res, `/productie/${ins.lastInsertRowid}`);
  });

  // ---- Detaliu + actualizare ----------------------------------------------
  router.get("/productie/:id", async (ctx) => {
    const c = await db
      .prepare("SELECT c.*, p.nume AS partener_nume FROM comenzi_productie c LEFT JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?")
      .get(ctx.params.id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsită", active: "/productie", body: "<p>Comanda nu există.</p>" }));

    const body = `
      <div class="detail-box">
        <h1 style="margin-top:0">Comanda #${esc(c.numar || c.id)} ${badge(c.status)}</h1>
        <div class="detail-grid">
          <div><div class="k">Client</div>${c.partener_id ? `<a href="/parteneri/${c.partener_id}">${esc(c.partener_nume || c.client_text)}</a>` : esc(c.client_text || "—")}</div>
          <div><div class="k">Produs</div>${esc(c.tip_produs || "—")}</div>
          <div><div class="k">Cantitate</div>${esc(c.cantitate || "—")}</div>
          <div><div class="k">Inițiator</div>${esc(c.initiator || "—")}</div>
          <div><div class="k">Inițiată la</div>${esc(c.data_initiere || "—")}</div>
          <div><div class="k">Solicitat de client</div>${esc(c.data_solicitata || "—")}</div>
          <div><div class="k">Propus de producție</div>${esc(c.data_propusa || "—")}</div>
          <div><div class="k">Start producție</div>${esc(c.start_productie || "—")}</div>
          <div><div class="k">Finalizată la</div>${esc(c.data_finalizare || "—")}</div>
        </div>
        ${c.observatii ? `<p style="margin-top:12px;white-space:pre-wrap"><strong>Observații:</strong> ${esc(c.observatii)}</p>` : ""}
        ${c.reteta ? `<p style="white-space:pre-wrap"><strong>Rețetă / consum:</strong> ${esc(c.reteta)}</p>` : ""}
      </div>

      <form class="form" method="post" action="/productie/${c.id}/actualizeaza">
        <h2 style="margin-top:0">Actualizare (producție / vânzări)</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Status
            <select name="status">${STATUSURI.map(([v, t]) => `<option value="${v}"${c.status === v ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>
          </label>
          <label class="field">Data propusă de producție<input type="date" name="data_propusa" value="${esc(c.data_propusa || "")}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Start producție<input type="date" name="start_productie" value="${esc(c.start_productie || "")}"></label>
          <label class="field">Data solicitată de client<input type="date" name="data_solicitata" value="${esc(c.data_solicitata || "")}"></label>
        </div>
        <label class="field">Observații<textarea name="observatii" rows="3">${esc(c.observatii || "")}</textarea></label>
        <label class="field">Rețetă / consum<textarea name="reteta" rows="2">${esc(c.reteta || "")}</textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button> <a class="btn secondary" href="/productie">Înapoi</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comanda producție #${c.numar || c.id}`, active: "/productie", body }));
  });

  router.post("/productie/:id/actualizeaza", async (ctx) => {
    const b = ctx.body;
    const status = STATUSURI.some((s) => s[0] === b.status) ? b.status : "noua";
    const finalizare = ["finalizata", "facturata"].includes(status) ? azi() : null;
    await db
      .prepare(
        `UPDATE comenzi_productie SET status = ?, data_propusa = ?, start_productie = ?, data_solicitata = ?, observatii = ?, reteta = ?,
         data_finalizare = COALESCE(data_finalizare, ?) WHERE id = ?`
      )
      .run(
        status,
        String(b.data_propusa || "") || null,
        String(b.start_productie || "") || null,
        String(b.data_solicitata || "") || null,
        String(b.observatii || "").trim() || null,
        String(b.reteta || "").trim() || null,
        finalizare,
        ctx.params.id
      );
    redirect(ctx.res, `/productie/${ctx.params.id}`);
  });

  // ---- Import din Excelul "Comenzi_in_lucru" ------------------------------
  router.post("/import/comenzi-productie", async (ctx) => {
    const files = (ctx.body.__files && ctx.body.__files.fisier) || [];
    const file = files[0];
    if (!file) return redirect(ctx.res, "/import");

    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Eroare import", active: "/import", body: `<p>${esc(e.message)}</p><a class="btn" href="/import">Înapoi</a>` }));
    }

    // Header-ul fișierului real: Numar comanda | Initiator | Tip produs |
    // Data initiere | Client | Cantitate | Data estimata de la client... |
    // Data estimata de finalizare | Start Productie | Status | Data
    // finalizare | Info aditionale | REteta.
    const CHEI = {
      numar: ["numarcomanda", "numar", "nr"],
      initiator: ["initiator"],
      tip: ["tipprodus", "produs"],
      dataInit: ["datainitiere"],
      client: ["client"],
      cantitate: ["cantitate"],
      solicitata: ["dataestimatadelaclient", "dataclient", "urgente"],
      propusa: ["dataestimatadefinalizare", "datafinalizareestimata"],
      start: ["startproductie"],
      status: ["status"],
      finalizare: ["datafinalizarecomanda", "datafinalizare"],
      info: ["infoaditionale", "observatii", "info"],
      reteta: ["reteta"],
    };
    let randHeader = -1;
    const idx = {};
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const norm = (rows[i] || []).map(normalizeHeader);
      const iClient = norm.findIndex((h) => CHEI.client.some((k) => h.includes(k)));
      const iTip = norm.findIndex((h) => CHEI.tip.some((k) => h.includes(k)));
      if (iClient !== -1 && iTip !== -1) {
        randHeader = i;
        for (const [cheie, aliasuri] of Object.entries(CHEI)) {
          idx[cheie] = norm.findIndex((h) => h && aliasuri.some((k) => h.includes(k)));
        }
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
          active: "/import",
          body: `<h1>N-am recunoscut coloanele</h1><pre style="background:var(--surface);padding:12px;border-radius:8px;overflow-x:auto">${esc(rows.slice(0, 4).map((r) => r.join(" | ")).join("\n"))}</pre><a class="btn" href="/import">Înapoi</a>`,
        })
      );
    }

    const val = (row, cheie) => (idx[cheie] !== undefined && idx[cheie] !== -1 ? String(row[idx[cheie]] ?? "").trim() : "");

    // Dedup: amprentă din (client + tip produs + cantitate + data inițierii).
    // Numărul de comandă NU e de încredere — în fișierul real se repetă și
    // lipsește pe sute de rânduri.
    const amprenta = (c) =>
      [c.client_text, c.tip_produs, c.cantitate, c.data_initiere].map((x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim()).join("|");
    const existente = new Set(
      (await db.prepare("SELECT client_text, tip_produs, cantitate, data_initiere FROM comenzi_productie").all()).map(amprenta)
    );

    const cacheU = new Map();
    const cacheP = new Map();
    let create = 0;
    let sarite = 0;
    let faraStatus = 0;
    const erori = [];

    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      const client = val(row, "client");
      const tip = val(row, "tip");
      // Rânduri "de completare" (doar o notiță pe rândul următor) — le sărim.
      if (!client && !tip) {
        sarite++;
        continue;
      }
      try {
        const dataInit = parseDataComenzi(val(row, "dataInit"));
        const c = {
          numar: val(row, "numar") || null,
          initiator: val(row, "initiator") || null,
          client_text: client || null,
          tip_produs: tip || null,
          cantitate: val(row, "cantitate") || null,
          data_initiere: dataInit,
          data_solicitata: parseDataComenzi(val(row, "solicitata")),
          data_propusa: parseDataComenzi(val(row, "propusa")),
          start_productie: parseDataComenzi(val(row, "start")),
          data_finalizare: parseDataComenzi(val(row, "finalizare")),
          observatii: [val(row, "solicitata"), val(row, "info")].filter((x) => x && !parseDataComenzi(x)).join(" · ") || null,
          reteta: val(row, "reteta") || null,
        };
        const st = statusDinRand(row);
        // Fără niciun marcaj de status: comenzile vechi (inițiate acum >30 de
        // zile) le considerăm finalizate (Excelul pur și simplu nu era
        // completat), cele recente rămân "în lucru" ca să fie văzute.
        if (st) c.status = st;
        else if (dataInit && dataInit < new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) {
          c.status = "finalizata";
          faraStatus++;
        } else {
          c.status = "in_productie";
          faraStatus++;
        }

        const amp = amprenta(c);
        if (existente.has(amp)) {
          sarite++;
          continue;
        }
        existente.add(amp);

        c.initiator_id = await utilizatorDupaNume(c.initiator, cacheU);
        c.partener_id = await partenerDupaNume(c.client_text, cacheP);

        await db
          .prepare(
            `INSERT INTO comenzi_productie (numar, initiator, initiator_id, partener_id, client_text, tip_produs, cantitate, data_initiere, data_solicitata, data_propusa, start_productie, data_finalizare, status, observatii, reteta, sursa)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import_excel')`
          )
          .run(
            c.numar,
            c.initiator,
            c.initiator_id,
            c.partener_id,
            c.client_text,
            c.tip_produs,
            c.cantitate,
            c.data_initiere,
            c.data_solicitata,
            c.data_propusa,
            c.start_productie,
            c.data_finalizare,
            c.status,
            c.observatii,
            c.reteta
          );
        create++;
      } catch (e) {
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }

    const body = `
      <h1>Import comenzi producție — rezultat</h1>
      <div class="cards">
        <div class="card"><div class="label">Comenzi importate</div><div class="value">${create}</div></div>
        <div class="card"><div class="label">Sărite (dubluri / rânduri goale)</div><div class="value">${sarite}</div></div>
        <div class="card"><div class="label">Fără status în Excel (status dedus)</div><div class="value">${faraStatus}</div></div>
        <div class="card"><div class="label">Erori</div><div class="value">${erori.length}</div></div>
      </div>
      ${erori.length ? `<h2>Erori</h2><ul>${erori.slice(0, 30).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      <p style="font-size:12px;color:var(--text-muted)">Comenzile fără marcaj de status în Excel au fost deduse: cele inițiate acum peste 30 de zile → finalizate; cele recente → în producție (verifică-le în listă). De acum comenzile se introduc direct din <a href="/productie/noua">Producție → Comandă nouă</a>.</p>
      <a class="btn" href="/productie">Vezi comenzile de producție</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Import comenzi producție", active: "/import", body }));
  });
}

module.exports = { register, STATUSURI };
