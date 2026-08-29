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
const { comenziSpreAlocare, ore } = require("./utilaje");

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

// Numerotarea din registrul oficial: yyyymmdd-nnn (contor pe zi).
async function numarComandaNou() {
  const aziCompact = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = await db.prepare("SELECT COUNT(*) AS n FROM comenzi_productie WHERE numar LIKE ?").get(`${aziCompact}-%`);
  return `${aziCompact}-${String(Number(r.n) + 1).padStart(3, "0")}`;
}

function initiale(nume) {
  return String(nume || "")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase())
    .join("")
    .slice(0, 3);
}

function daNu(v) {
  return /^da$/i.test(String(v || "").trim()) ? 1 : 0;
}

// Tabelul „Comenzi spre alocare". Pentru fiecare comandă deschisă și
// nealocată arată utilajele care o pot face și în câte ore — ca decizia „pe
// ce o punem" să se ia din pagina asta, nu din cap.
function sectiuneSpreAlocare(spre) {
  if (!spre.utilaje) {
    return `<div class="detail-box" style="border-left:4px solid var(--warning,#d99b00)">
      <strong>Nu e definit niciun utilaj.</strong> Până nu știm pe ce mașini se lucrează și cine le poate lucra,
      comenzile nu se pot aloca, iar ERP-ul nu poate spune cât ține o comandă.
      <a href="/productie/utilaje">Adaugă utilajele</a> și apoi <a href="/productie/resurse">oamenii</a>.
    </div>`;
  }
  if (!spre.comenzi.length) {
    return `<div class="detail-box" style="border-left:4px solid var(--success,#1c6b3c)">
      Toate comenzile deschise sunt alocate pe utilaje. <a href="/productie/planificare">Vezi planificarea</a>.
    </div>`;
  }
  const randuri = spre.comenzi.map((c) => {
    const variante = spre.estimari.get(Number(c.id)) || [];
    const prima = variante[0];
    return [
      `<a href="/productie/${c.id}">${esc(c.numar || c.id)}</a>`,
      esc(c.partener_nume || c.client_text || "—"),
      esc(c.tip_produs || "—"),
      esc([c.cantitate, c.um].filter(Boolean).join(" ") || "—"),
      c.data_livrare
        ? c.data_livrare < azi()
          ? `<span class="badge rosu">${esc(c.data_livrare)}</span>`
          : esc(c.data_livrare)
        : "—",
      variante.length
        ? variante
            .slice(0, 3)
            .map((v) => `<a href="/productie/utilaje/${v.utilaj_id}" class="badge gri" style="text-decoration:none">${esc(v.utilaj)}</a>`)
            .join(" ")
        : '<span class="badge rosu">niciun utilaj potrivit</span>',
      prima && prima.estimat ? `<strong>${ore(prima.ore)} h</strong>` : '<span style="color:var(--text-muted)">—</span>',
      prima ? `${prima.operatori_necesari} ${prima.operatori_necesari === 1 ? "om" : "oameni"}` : "—",
      `<a class="btn small" href="/productie/aloca/${c.id}">Alocă</a>`,
    ];
  });
  const totalOre = spre.comenzi.reduce((s, c) => {
    const v = (spre.estimari.get(Number(c.id)) || [])[0];
    return s + (v && v.estimat ? v.ore : 0);
  }, 0);
  return `
    <h2 style="margin-bottom:4px">Comenzi spre alocare (${spre.comenzi.length})</h2>
    <p style="font-size:12px;color:var(--text-muted);margin-top:0">
      Comenzi deschise care încă n-au fost puse pe nicio mașină. Estimarea în ore vine din capacitatea scrisă pe utilaj
      (cantitate pe oră), nu din facturi. Total estimat: <strong>${ore(totalOre)} h</strong> de utilaj,
      ${spre.oameni} ${spre.oameni === 1 ? "om disponibil" : "oameni disponibili"} în producție.
    </p>
    ${table(
      ["#", "Client", "Produs", "Cant.", "Livrare", "Poate fi făcută pe", "Ore est.", "Operatori", ""],
      randuri
    )}
  `;
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

    // „Comenzi spre alocare": ce e deschis și n-a fost încă pus pe o mașină.
    // Stă DEASUPRA comenzilor în lucru fiindcă asta e întrebarea de dimineață
    // — nu „ce lucrăm", ci „ce n-are încă cine și pe ce să lucreze".
    const spre = await comenziSpreAlocare(30);

    const body = `
      <div class="toolbar">
        <a href="/productie/noua" class="btn">+ Comandă nouă în producție</a>
        <a href="/productie/planificare" class="btn secondary">Planificare</a>
        <a href="/import" class="btn secondary">Import din Excel</a>
      </div>
      ${sectiuneSpreAlocare(spre)}
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
      <form method="post" action="/productie/sterge" onsubmit="return confirm('Ștergi comenzile selectate? Nu se pot recupera.')">
      ${table(
        ["<input type=\"checkbox\" onclick=\"document.querySelectorAll('.sel-cmd').forEach(c=>c.checked=this.checked)\">", "#", "Client", "Produs", "Caracteristici", "Cant.", "Rep.", "Livrare", "DoC/FT", "Status"],
        comenzi.map((c) => [
          `<input type="checkbox" class="sel-cmd" name="ids" value="${c.id}">`,
          `<a href="/productie/${c.id}">${esc(c.numar || c.id)}</a>`,
          c.partener_id ? `<a href="/parteneri/${c.partener_id}">${esc(c.partener_nume || c.client_text)}</a>` : esc(c.client_text || "—"),
          esc(c.tip_produs || "—"),
          `<span style="font-size:12px;color:var(--text-muted)">${esc(String(c.caracteristici || "").slice(0, 40))}</span>`,
          esc([c.cantitate, c.um].filter(Boolean).join(" ")),
          esc(c.reprezentant || "—"),
          c.data_livrare
            ? ["noua", "in_productie"].includes(c.status) && c.data_livrare < aziStr
              ? `<span class="badge rosu">${esc(c.data_livrare)}</span>`
              : esc(c.data_livrare)
            : "—",
          `${c.doc_emisa ? '<span class="badge verde">DoC</span>' : ""} ${c.fisa_tehnica ? '<span class="badge verde">FT</span>' : ""}`,
          badge(c.status),
        ])
      )}
      <div class="toolbar" style="margin-top:10px">
        <button class="btn secondary" type="submit">Șterge selectatele</button>
      </div>
      </form>
      <form method="post" action="/productie/sterge-tot" class="inline-form" onsubmit="return confirm('Ștergi TOATE comenzile de producție? Folosește asta doar înainte de un reimport curat.')">
        <button class="link-btn danger" type="submit">Șterge toate comenzile (pentru reimport)</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comenzi producție (${comenzi.length})`, active: "/productie", body }));
  });

  // ---- Ștergere (selectiv sau tot — pentru reimport curat) ----------------
  // ---- Cereri venite din depozit ----------------------------------------
  // Depozitul cere marfă din producție când stocul nu acoperă o comandă.
  // Producția vede termenul cerut de agent și îl confirmă sau nu. La
  // confirmare, comanda de producție se deschide singură — n-o mai scrie
  // nimeni a doua oară.
  router.get("/productie/cereri", async (ctx) => {
    const cereri = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs, p.unitate_masura, c.numar AS comanda_numar, cl.nume AS client
         FROM aprovizionari a
         JOIN produse p ON p.id = a.produs_id
         LEFT JOIN comenzi c ON c.id = a.comanda_id
         LEFT JOIN parteneri cl ON cl.id = c.partener_id
         WHERE a.sursa = 'productie'
         ORDER BY CASE a.status WHEN 'ceruta' THEN 0 WHEN 'confirmata' THEN 1 ELSE 2 END, a.id DESC
         LIMIT 200`
      )
      .all();
    const randuri = cereri.map((a) => {
      const actiuni =
        a.status === "ceruta"
          ? `<form method="post" action="/productie/cereri/${a.id}/confirma" class="inline-form" style="gap:6px">
               <input type="date" name="termen" value="${esc(a.termen_cerut || azi())}">
               <button class="btn small" type="submit">Confirm termenul</button>
             </form>
             <form method="post" action="/productie/cereri/${a.id}/refuza" class="inline-form">
               <button class="link-btn danger" type="submit">Nu pot în termen</button>
             </form>`
          : a.status === "confirmata" && a.productie_id
            ? `<a class="btn small secondary" href="/productie/${a.productie_id}">Vezi comanda de producție</a>`
            : "";
      const stare =
        a.status === "ceruta"
          ? '<span class="badge gri">așteaptă răspunsul producției</span>'
          : a.status === "confirmata"
            ? '<span class="badge albastru">confirmată</span>'
            : a.status === "gata"
              ? '<span class="badge albastru">gata, o preia depozitul</span>'
              : a.status === "refuzata"
                ? '<span class="badge rosu">refuzată</span>'
                : a.status === "primita"
                  ? '<span class="badge verde">intrată în stoc</span>'
                  : esc(a.status);
      return [
        esc(a.produs),
        `${a.cantitate} ${esc(a.unitate_masura || "")}`,
        a.comanda_id ? `${esc(a.comanda_numar || "#" + a.comanda_id)}<br><span style="font-size:12px">${esc(a.client || "")}</span>` : "pentru stoc",
        esc(a.termen_cerut || "—"),
        esc(a.termen_confirmat || "—"),
        stare,
        actiuni,
      ];
    });
    const body = `
      <p style="max-width:760px;color:var(--text-muted)">
        Ce cere depozitul de la producție, cu termenul pe care agentul l-a promis clientului. Dacă termenul se poate ține,
        confirmă-l — comanda de producție se deschide automat. Dacă nu, refuz-o: comanda de vânzare rămâne în listă și
        poate fi anulată de cel care a plasat-o.
      </p>
      ${table(["Produs", "Cantitate", "Pentru comanda", "Termen cerut", "Termen confirmat", "Stare", ""], randuri)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cereri din depozit", active: "/productie/cereri", body }));
  });

  router.post("/productie/cereri/:id/confirma", async (ctx) => {
    if (!ctx.user || !["admin", "productie", "depozit"].includes(ctx.user.rol)) return redirect(ctx.res, "/productie/cereri");
    const id = parseInt(ctx.params.id, 10);
    const a = await db.prepare("SELECT * FROM aprovizionari WHERE id = ?").get(id);
    if (!a || a.status !== "ceruta") return redirect(ctx.res, "/productie/cereri");
    const termen = String((ctx.body || {}).termen || "").slice(0, 10) || a.termen_cerut || null;
    const produs = await db.prepare("SELECT denumire, unitate_masura FROM produse WHERE id = ?").get(a.produs_id);
    const comanda = a.comanda_id
      ? await db
          .prepare("SELECT c.numar, c.partener_id, p.nume AS client FROM comenzi c LEFT JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?")
          .get(a.comanda_id)
      : null;
    const numar = await numarComandaNou();
    const ins = await db
      .prepare(
        `INSERT INTO comenzi_productie (numar, initiator, initiator_id, partener_id, client_text, tip_produs, cantitate, um,
                                        data_initiere, data_solicitata, data_propusa, data_livrare, status, sursa, comanda_id,
                                        aprovizionare_id, produs_id, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'noua', 'depozit', ?, ?, ?, ?) RETURNING id`
      )
      .run(
        numar,
        ctx.user.nume,
        ctx.user.id,
        comanda ? comanda.partener_id : null,
        comanda ? comanda.client : null,
        produs ? produs.denumire : null,
        String(a.cantitate),
        produs ? produs.unitate_masura || "buc" : "buc",
        azi(),
        a.termen_cerut || null,
        termen,
        termen,
        a.comanda_id || null,
        a.id,
        a.produs_id,
        comanda ? `Cerere din depozit pentru comanda ${comanda.numar || "#" + a.comanda_id}` : "Cerere din depozit, pentru stoc"
      );
    await db
      .prepare("UPDATE aprovizionari SET status = 'confirmata', termen_confirmat = ?, productie_id = ?, raspuns = ? WHERE id = ?")
      .run(termen, ins.lastInsertRowid, `confirmat de ${ctx.user.nume}`, id);
    if (a.comanda_id) {
      await db
        .prepare("UPDATE comenzi SET status = 'in_productie' WHERE id = ? AND status NOT IN ('facturata','livrata','anulata')")
        .run(a.comanda_id);
    }
    redirect(ctx.res, `/productie/${ins.lastInsertRowid}`);
  });

  router.post("/productie/cereri/:id/refuza", async (ctx) => {
    if (!ctx.user || !["admin", "productie", "depozit"].includes(ctx.user.rol)) return redirect(ctx.res, "/productie/cereri");
    await db
      .prepare("UPDATE aprovizionari SET status = 'refuzata', raspuns = ? WHERE id = ?")
      .run(`termen refuzat de ${ctx.user.nume}`, parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/productie/cereri");
  });

  // ---- Materie primă cerută de la depozit --------------------------------
  router.get("/productie/materie", async (ctx) => {
    const cereri = await db
      .prepare(
        `SELECT m.*, p.denumire AS produs FROM cereri_materie_prima m LEFT JOIN produse p ON p.id = m.produs_id
         ORDER BY CASE m.status WHEN 'ceruta' THEN 0 WHEN 'confirmata' THEN 1 ELSE 2 END, m.id DESC LIMIT 200`
      )
      .all();
    const produse = await db.prepare("SELECT id, denumire FROM produse ORDER BY denumire LIMIT 3000").all();
    const comenzi = await db
      .prepare("SELECT id, numar FROM comenzi_productie WHERE status IN ('noua','in_productie') ORDER BY id DESC LIMIT 100")
      .all();
    const body = `
      <p style="max-width:760px;color:var(--text-muted)">
        Drumul invers: producția cere materie primă de la depozit. Depozitul validează cererea și dă un termen, la fel
        cum producția confirmă termenele care vin dinspre depozit.
      </p>
      <form method="post" action="/productie/materie" class="form" style="max-width:820px">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
          <label class="field"><span>Produs din nomenclator</span>
            <select name="produs_id"><option value="">— altceva, scriu mai jos —</option>${produse
              .map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`)
              .join("")}</select>
          </label>
          <label class="field"><span>Cantitate</span><input type="number" step="0.001" name="cantitate" required></label>
          <label class="field"><span>UM</span><input name="um" value="kg"></label>
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          <label class="field"><span>Descriere (dacă nu e în nomenclator)</span><input name="descriere"></label>
          <label class="field"><span>Termen cerut</span><input type="date" name="termen_cerut"></label>
        </div>
        <label class="field"><span>Pentru comanda de producție</span>
          <select name="productie_id"><option value="">— fără legătură —</option>${comenzi
            .map((c) => `<option value="${c.id}">${esc(c.numar || "#" + c.id)}</option>`)
            .join("")}</select>
        </label>
        <label class="field"><span>Observații</span><input name="observatii"></label>
        <div class="form-actions"><button class="btn" type="submit">Cer materia primă</button></div>
      </form>
      ${table(
        ["Produs / descriere", "Cantitate", "Termen cerut", "Termen dat de depozit", "Stare", "Observații"],
        cereri.map((m) => [
          esc(m.produs || m.descriere || "—"),
          `${m.cantitate} ${esc(m.um || "")}`,
          esc(m.termen_cerut || "—"),
          esc(m.termen_confirmat || "—"),
          m.status === "ceruta"
            ? '<span class="badge gri">așteaptă depozitul</span>'
            : m.status === "confirmata"
              ? '<span class="badge albastru">confirmată</span>'
              : m.status === "primita"
                ? '<span class="badge verde">primită</span>'
                : m.status === "refuzata"
                  ? '<span class="badge rosu">refuzată</span>'
                  : esc(m.status),
          esc(m.observatii || ""),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Materie primă de la depozit", active: "/productie/materie", body }));
  });

  router.post("/productie/materie", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body || {};
    const cant = Number(b.cantitate) || 0;
    if (cant <= 0) return redirect(ctx.res, "/productie/materie");
    await db
      .prepare(
        `INSERT INTO cereri_materie_prima (produs_id, descriere, cantitate, um, termen_cerut, status, cerut_de, productie_id, creata_la, observatii)
         VALUES (?, ?, ?, ?, ?, 'ceruta', ?, ?, ?, ?)`
      )
      .run(
        parseInt(b.produs_id, 10) || null,
        String(b.descriere || "").trim().slice(0, 300) || null,
        cant,
        String(b.um || "kg").slice(0, 20),
        String(b.termen_cerut || "") || null,
        ctx.user.nume,
        parseInt(b.productie_id, 10) || null,
        new Date().toISOString().slice(0, 19).replace("T", " "),
        String(b.observatii || "").trim().slice(0, 500) || null
      );
    redirect(ctx.res, "/productie/materie");
  });

  router.post("/productie/sterge", async (ctx) => {
    let ids = ctx.body.ids;
    if (!ids) return redirect(ctx.res, "/productie");
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
    if (ids.length) await db.prepare(`DELETE FROM comenzi_productie WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    redirect(ctx.res, "/productie");
  });

  router.post("/productie/sterge-tot", async (ctx) => {
    await db.prepare("DELETE FROM comenzi_productie").run();
    redirect(ctx.res, "/productie");
  });

  // ---- Creare -------------------------------------------------------------
  router.get("/productie/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume LIMIT 3000").all();
    const nrNou = await numarComandaNou();
    const body = `
      <form class="form" method="post" action="/productie" style="max-width:680px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Nr. comandă<input name="numar" value="${esc(nrNou)}" required></label>
          <label class="field">Client
            <select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Produs comandat<input name="tip_produs" required placeholder="Ex: Folie Stretch, Pungi Curier, Bandă adezivă"></label>
          <label class="field">Caracteristici (dimensiuni, microni…)<input name="caracteristici" placeholder="Ex: 23 microni reciclat, 1.5 kg net"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 100px 1fr;gap:14px">
          <label class="field">Cantitate<input name="cantitate" required placeholder="Ex: 15000"></label>
          <label class="field">UM<input name="um" value="buc"></label>
          <label class="field">Tip ambalare<input name="tip_ambalare" placeholder="Ex: 6 role/pack, 500/cutie"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Data livrare promisă<input type="date" name="data_livrare"></label>
          <label class="field">Reprezentant vânzări<input name="reprezentant" value="${esc(ctx.user ? initiale(ctx.user.nume) : "")}" placeholder="Ex: GT, IR, MM"></label>
        </div>
        <label class="field">Rețetă / consum estimat<textarea name="reteta" rows="2" placeholder="Ex: 190 kg, LDPE-23, LLDPE-80, MB 4, Tape 15 role"></textarea></label>
        <label class="field">Observații<textarea name="observatii" rows="2"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Înregistrează comanda</button> <a class="btn secondary" href="/productie">Renunță</a></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted)">Numărul urmează formatul registrului (ziua + contor). DoC, fișa tehnică și facturarea se bifează din pagina comenzii, pe măsură ce se emit.</p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă în producție", active: "/productie", body }));
  });

  router.post("/productie", async (ctx) => {
    const b = ctx.body;
    const partenerId = parseInt(b.partener_id, 10) || null;
    const p = partenerId ? await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(partenerId) : null;
    const numar = String(b.numar || "").trim() || (await numarComandaNou());
    const ins = await db
      .prepare(
        `INSERT INTO comenzi_productie (numar, initiator, initiator_id, reprezentant, partener_id, client_text, tip_produs, caracteristici, cantitate, um, tip_ambalare, data_initiere, data_livrare, data_solicitata, status, observatii, reteta, sursa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'noua', ?, ?, 'manual') RETURNING id`
      )
      .run(
        numar,
        ctx.user ? ctx.user.nume : null,
        ctx.user ? ctx.user.id : null,
        String(b.reprezentant || "").trim() || null,
        partenerId,
        p ? p.nume : null,
        String(b.tip_produs || "").trim(),
        String(b.caracteristici || "").trim() || null,
        String(b.cantitate || "").trim(),
        String(b.um || "buc").trim(),
        String(b.tip_ambalare || "").trim() || null,
        azi(),
        String(b.data_livrare || "") || null,
        String(b.data_livrare || "") || null,
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

    // Alocările: pe ce mașină și cu cine stă comanda asta. Fără ele, pagina
    // spune ce e de făcut, dar nu și cine o face.
    const alocari = await db
      .prepare(
        `SELECT a.*, u.denumire AS utilaj FROM alocari_productie a
           LEFT JOIN utilaje u ON u.id = a.utilaj_id
          WHERE a.comanda_productie_id = ? AND a.status <> 'anulata' ORDER BY a.data, a.ora_start`
      )
      .all(c.id);
    const oameniAlocati = new Map();
    if (alocari.length) {
      const legaturi = await db
        .prepare(
          `SELECT ar.alocare_id, r.nume FROM alocari_resurse ar JOIN resurse r ON r.id = ar.resursa_id
            WHERE ar.alocare_id IN (SELECT id FROM alocari_productie WHERE comanda_productie_id = ?)`
        )
        .all(c.id);
      for (const l of legaturi) {
        const k = Number(l.alocare_id);
        if (!oameniAlocati.has(k)) oameniAlocati.set(k, []);
        oameniAlocati.get(k).push(l.nume);
      }
    }

    const body = `
      <div class="detail-box">
        <h1 style="margin-top:0">Comanda ${esc(c.numar || c.id)} ${badge(c.status)}
          ${c.doc_emisa ? '<span class="badge verde">DoC emisă</span>' : '<span class="badge gri">fără DoC</span>'}
          ${c.fisa_tehnica ? '<span class="badge verde">Fișă tehnică</span>' : '<span class="badge gri">fără FT</span>'}
        </h1>
        <div class="detail-grid">
          <div><div class="k">Client</div>${c.partener_id ? `<a href="/parteneri/${c.partener_id}">${esc(c.partener_nume || c.client_text)}</a>` : esc(c.client_text || "—")}</div>
          <div><div class="k">Produs</div>${esc(c.tip_produs || "—")}</div>
          <div><div class="k">Caracteristici</div>${esc(c.caracteristici || "—")}</div>
          <div><div class="k">Cantitate</div>${esc([c.cantitate, c.um].filter(Boolean).join(" "))}</div>
          <div><div class="k">Ambalare</div>${esc(c.tip_ambalare || "—")}</div>
          <div><div class="k">Reprezentant</div>${esc(c.reprezentant || c.initiator || "—")}</div>
          <div><div class="k">Plasată la</div>${esc(c.data_initiere || "—")}</div>
          <div><div class="k">Livrare promisă</div>${esc(c.data_livrare || c.data_solicitata || "—")}</div>
          <div><div class="k">Finalizată la</div>${esc(c.data_finalizare || "—")}</div>
        </div>
        ${c.observatii ? `<p style="margin-top:12px;white-space:pre-wrap"><strong>Observații:</strong> ${esc(c.observatii)}</p>` : ""}
        ${c.reteta ? `<p style="white-space:pre-wrap"><strong>Rețetă / consum:</strong> ${esc(c.reteta)}</p>` : ""}
      </div>

      <h2 style="margin-bottom:4px">Pe ce se lucrează</h2>
      <div class="toolbar" style="margin-top:0"><a class="btn" href="/productie/aloca/${c.id}">+ Alocă pe un utilaj</a>
        <a class="btn secondary" href="/productie/planificare">Vezi planificarea</a></div>
      ${
        alocari.length
          ? table(
              ["Data", "Ora", "Ore", "Utilaj", "Oameni", "Cant.", "Stare", ""],
              alocari.map((a) => [
                esc(a.data),
                `${esc(String(Number(a.ora_start) || 0))}:00`,
                esc(String(Number(a.ore) || 0)),
                a.utilaj_id ? `<a href="/productie/utilaje/${a.utilaj_id}">${esc(a.utilaj || "—")}</a>` : '<span class="badge gri">fără utilaj</span>',
                (oameniAlocati.get(Number(a.id)) || []).map((n) => esc(n)).join(", ") || '<span class="badge rosu">niciun om</span>',
                a.cantitate ? esc(String(a.cantitate)) : "—",
                esc(a.status),
                `<form method="post" action="/productie/alocari/${a.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi alocarea?')"><button class="link-btn danger" type="submit">Șterge</button></form>`,
              ])
            )
          : `<p style="color:var(--text-muted)">Comanda nu e încă pusă pe nicio mașină.</p>`
      }

      <form class="form" method="post" action="/productie/${c.id}/actualizeaza" style="max-width:680px">
        <h2 style="margin-top:0">Actualizare</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Status
            <select name="status">${STATUSURI.map(([v, t]) => `<option value="${v}"${c.status === v ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>
          </label>
          <label class="field">Data livrare promisă<input type="date" name="data_livrare" value="${esc(c.data_livrare || "")}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="doc_emisa" value="1"${c.doc_emisa ? " checked" : ""}> DoC emisă</label>
          <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="fisa_tehnica" value="1"${c.fisa_tehnica ? " checked" : ""}> Fișă tehnică emisă</label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Caracteristici<input name="caracteristici" value="${esc(c.caracteristici || "")}"></label>
          <label class="field">Tip ambalare<input name="tip_ambalare" value="${esc(c.tip_ambalare || "")}"></label>
        </div>
        <label class="field">Rețetă / consum<textarea name="reteta" rows="2">${esc(c.reteta || "")}</textarea></label>
        <label class="field">Observații<textarea name="observatii" rows="2">${esc(c.observatii || "")}</textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button> <a class="btn secondary" href="/productie">Înapoi</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comanda ${c.numar || c.id}`, active: "/productie", body }));
  });

  router.post("/productie/:id/actualizeaza", async (ctx) => {
    const b = ctx.body;
    const status = STATUSURI.some((s) => s[0] === b.status) ? b.status : "noua";
    const finalizare = ["finalizata", "facturata"].includes(status) ? azi() : null;
    await db
      .prepare(
        `UPDATE comenzi_productie SET status = ?, data_livrare = ?, doc_emisa = ?, fisa_tehnica = ?, caracteristici = ?, tip_ambalare = ?, observatii = ?, reteta = ?,
         data_finalizare = COALESCE(data_finalizare, ?) WHERE id = ?`
      )
      .run(
        status,
        String(b.data_livrare || "") || null,
        b.doc_emisa ? 1 : 0,
        b.fisa_tehnica ? 1 : 0,
        String(b.caracteristici || "").trim() || null,
        String(b.tip_ambalare || "").trim() || null,
        String(b.observatii || "").trim() || null,
        String(b.reteta || "").trim() || null,
        finalizare,
        ctx.params.id
      );

    // Când producția marchează comanda finalizată, comanda de vânzare din
    // spatele ei trece în „în stoc depozit" — momentul în care agentul poate
    // apăsa Facturează. Fără pasul ăsta cineva ar trebui să-i dea telefon.
    try {
      const cp = await db.prepare("SELECT comanda_id, aprovizionare_id FROM comenzi_productie WHERE id = ?").get(ctx.params.id);
      if (cp && cp.comanda_id) {
        const nouStatusVanzare =
          status === "finalizata" ? "in_stoc_depozit" : status === "in_productie" ? "in_productie" : status === "anulata" ? "anulata" : null;
        if (nouStatusVanzare) {
          await db
            .prepare("UPDATE comenzi SET status = ? WHERE id = ? AND status NOT IN ('facturata','livrata')")
            .run(nouStatusVanzare, cp.comanda_id);
        }
      }
      // Dacă a venit dintr-o cerere a depozitului, îi spunem depozitului că
      // marfa e gata — el o bagă efectiv în stoc, cu rețeta lui.
      if (cp && cp.aprovizionare_id && status === "finalizata") {
        await db.prepare("UPDATE aprovizionari SET status = 'gata' WHERE id = ? AND status = 'confirmata'").run(cp.aprovizionare_id);
      }
    } catch (e) {
      console.error("[productie] nu am putut sincroniza comanda de vânzare:", e.message);
    }

    redirect(ctx.res, `/productie/${ctx.params.id}`);
  });

// ---- Import din REGISTRUL oficial de comenzi (modelul bun) ---------------
  // Coloane: Nr. comandă (20260803-001) | Client | Reprezentant vânzări |
  // Produs comandat | Caracteristici | Cantitate | UM | Tip ambalare | Data
  // plasare | Data livrare | Stare comandă | DoC emisa | Fisa tehnica |
  // Facturat | Reteta | Observații. Dedup pe numărul de comandă (aici chiar
  // e unic). Datele vin iar amestecat (08/03/2026 american, 06.08.2026
  // românesc) — aceeași regulă: punct = românesc, slash = american.
  router.post("/import/registru-comenzi", async (ctx) => {
    const files = (ctx.body.__files && ctx.body.__files.fisier) || [];
    const file = files[0];
    if (!file) return redirect(ctx.res, "/import");

    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Eroare import", active: "/import", body: `<p>${esc(e.message)}</p><a class="btn" href="/import">Înapoi</a>` }));
    }

    const CHEI = {
      numar: ["nrcomanda", "numarcomanda"],
      client: ["client"],
      reprezentant: ["reprezentantvanzari", "reprezentant"],
      produs: ["produscomandat", "produs"],
      caracteristici: ["caracteristiciprodus", "caracteristici"],
      cantitate: ["cantitatecomandata", "cantitate"],
      um: ["unitatedemasuraum", "unitatedemasura", "um"],
      ambalare: ["tipambalare", "ambalare"],
      plasare: ["dataplasarecomanda", "dataplasare"],
      livrare: ["datalivrarecomanda", "datalivrare"],
      stare: ["starecomanda", "stare", "status"],
      doc: ["docemisadanu", "docemisa", "doc"],
      fisa: ["fisatehnicaemisadanu", "fisatehnicaemisa", "fisatehnica"],
      facturat: ["facturat"],
      reteta: ["reteta"],
      observatii: ["observatii"],
    };
    let randHeader = -1;
    const idx = {};
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const norm = (rows[i] || []).map(normalizeHeader);
      const iNr = norm.findIndex((h) => CHEI.numar.some((k) => h.includes(k)));
      const iCl = norm.findIndex((h) => CHEI.client.some((k) => h === k));
      if (iNr !== -1 && iCl !== -1) {
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
          body: `<h1>N-am recunoscut registrul de comenzi</h1><pre style="background:var(--surface);padding:12px;border-radius:8px;overflow-x:auto">${esc(rows.slice(0, 5).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n"))}</pre><a class="btn" href="/import">Înapoi</a>`,
        })
      );
    }

    const val = (row, cheie) => (idx[cheie] !== undefined && idx[cheie] !== -1 ? String(row[idx[cheie]] ?? "").trim() : "");
    const existente = new Set((await db.prepare("SELECT numar FROM comenzi_productie WHERE numar IS NOT NULL").all()).map((r) => String(r.numar)));
    const cacheP = new Map();

    let create = 0;
    let sarite = 0;
    const erori = [];
    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      const numar = val(row, "numar");
      const client = val(row, "client");
      // rânduri reziduale (ex: un "l" singur pe rând) sau fără date reale
      if (!client || !/\d/.test(numar)) {
        sarite++;
        continue;
      }
      if (existente.has(numar)) {
        sarite++;
        continue;
      }
      existente.add(numar);
      try {
        const stare = val(row, "stare").toLowerCase();
        const facturat = daNu(val(row, "facturat"));
        let status;
        if (/anulat/.test(stare)) status = "anulata";
        else if (facturat) status = "facturata";
        else if (/finalizat/.test(stare)) status = "finalizata";
        else if (/curs|lucru/.test(stare)) status = "in_productie";
        else status = "in_productie"; // stare goală în registru = încă în lucru
        await db
          .prepare(
            `INSERT INTO comenzi_productie (numar, reprezentant, partener_id, client_text, tip_produs, caracteristici, cantitate, um, tip_ambalare, data_initiere, data_livrare, data_solicitata, data_finalizare, status, doc_emisa, fisa_tehnica, observatii, reteta, sursa)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import_registru')`
          )
          .run(
            numar,
            val(row, "reprezentant") || null,
            await partenerDupaNume(client, cacheP),
            client,
            val(row, "produs") || null,
            val(row, "caracteristici") || null,
            val(row, "cantitate") || null,
            val(row, "um") || "buc",
            val(row, "ambalare") || null,
            parseDataComenzi(val(row, "plasare")),
            parseDataComenzi(val(row, "livrare")),
            parseDataComenzi(val(row, "livrare")),
            /finalizat/.test(stare) || facturat ? parseDataComenzi(val(row, "livrare")) : null,
            status,
            daNu(val(row, "doc")),
            daNu(val(row, "fisa")),
            val(row, "observatii") || null,
            val(row, "reteta") || null
          );
        create++;
      } catch (e) {
        erori.push(`Rând ${r + 1}: ${e.message}`);
      }
    }

    const body = `
      <h1>Import registru comenzi — rezultat</h1>
      <div class="cards">
        <div class="card"><div class="label">Comenzi importate</div><div class="value">${create}</div></div>
        <div class="card"><div class="label">Sărite (dubluri / rânduri goale)</div><div class="value">${sarite}</div></div>
        <div class="card"><div class="label">Erori</div><div class="value">${erori.length}</div></div>
      </div>
      ${erori.length ? `<ul>${erori.slice(0, 20).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      <a class="btn" href="/productie">Vezi comenzile de producție</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Import registru comenzi", active: "/import", body }));
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
