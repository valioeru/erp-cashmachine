"use strict";
// Comenzi de producție ("comenzi în lucru") — fluxul real de la Cash Machine:
// agentul inițiază comanda cu data SOLICITATĂ de client, producția răspunde
// cu data PROPUSĂ și pornește lucrul. Cele două date sunt separate tocmai
// pentru că le stabilesc oameni diferiți — exact ce era ținut până acum în
// Excelul "Comenzi_in_lucru.xlsx".
const db = require("../lib/db");
const { esc, layout, table, dateleInText } = require("../lib/render");
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

// --- Cine e agentul din spatele codului din registru ----------------------
//
// În registru scrie „IR", „GT", „MM" — inițialele omului. Le traducem o
// singură dată, la intrarea comenzii, și de aici încolo comanda ține id-ul
// utilizatorului, nu două litere. Așa apare numele lui peste tot și comanda
// intră în pâlnia lui.
//
// Codul se ține explicit pe fișa omului (`utilizatori.cod_agent`), fiindcă
// inițialele se ciocnesc: Mihai Moinescu și Mihai Moșneanu dau amândoi „MM".
// Când codul nu e scris pe nimeni, ghicim din nume; dacă ghicitul dă mai
// mulți, câștigă agentul de vânzări. Ce nu se potrivește cu nimeni merge la
// administrator — mai bine la un om anume decât nicăieri.
function initialeNume(nume) {
  return String(nume || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

let _agenti = null;
async function listaAgenti() {
  if (_agenti) return _agenti;
  _agenti = await db.prepare("SELECT id, nume, rol, cod_agent, activ FROM utilizatori ORDER BY id").all();
  return _agenti;
}
function uitaAgentii() {
  _agenti = null;
}

async function agentDinCod(cod) {
  const c = String(cod || "").trim().toUpperCase();
  const toti = await listaAgenti();
  const activi = toti.filter((u) => u.activ === undefined || Number(u.activ) !== 0);
  if (c) {
    const explicit = activi.filter((u) => String(u.cod_agent || "").trim().toUpperCase() === c);
    if (explicit.length === 1) return explicit[0].id;
    const dupaNume = activi.filter((u) => initialeNume(u.nume) === c);
    if (dupaNume.length === 1) return dupaNume[0].id;
    if (dupaNume.length > 1) {
      const vanzatori = dupaNume.filter((u) => u.rol === "vanzari");
      if (vanzatori.length === 1) return vanzatori[0].id;
    }
  }
  const admin = activi.find((u) => u.rol === "admin");
  return admin ? admin.id : (activi[0] ? activi[0].id : null);
}

// Clientul comenzii aparține agentului ei. Dacă n-avea alocare, o primește
// acum — altfel comanda ar intra în pâlnia unui om care nu știe de ea.
async function alocaClientul(partenerId, agentId) {
  if (!partenerId || !agentId) return;
  const are = await db.prepare("SELECT id FROM alocari_clienti WHERE partener_id = ? LIMIT 1").get(partenerId);
  if (!are) {
    await db
      .prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, observatii) VALUES (?, ?, 100, ?)")
      .run(partenerId, agentId, "din registrul de comenzi");
  }
  const p = await db.prepare("SELECT agent_id FROM parteneri WHERE id = ?").get(partenerId);
  if (p && !p.agent_id) await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(agentId, partenerId);
}

// Clientul din registru: dacă îl avem, îl legăm; dacă nu, îl facem. Un client
// nou nu apare din senin — se naște cu un lead deja convertit în spate, ca să
// se vadă de unde a venit și cine l-a adus.
async function partenerSauCreeaza(nume, agentId, cache) {
  const cheie = String(nume || "").trim().toLowerCase();
  if (!cheie) return null;
  if (cache.has(cheie)) return cache.get(cheie);

  let p = await db.prepare("SELECT id FROM parteneri WHERE LOWER(nume) = ? OR LOWER(nume) LIKE ?").get(cheie, cheie + " %");
  if (!p) {
    const creat = await db
      .prepare(
        `INSERT INTO parteneri (tip, nume, sursa, stare, agent_id)
         VALUES ('client', ?, 'registru comenzi', 'client_activ', ?) RETURNING id`
      )
      .run(String(nume).trim(), agentId || null);
    const id = creat.lastInsertRowid;
    await db
      .prepare(
        `INSERT INTO leaduri (nume, companie, sursa, stadiu, atribuit_lui, partener_id, observatii, ultima_activitate)
         VALUES (?, ?, 'manual', 'convertit', ?, ?, ?, ?)`
      )
      .run(
        String(nume).trim(),
        String(nume).trim(),
        agentId || null,
        id,
        "Client apărut direct cu o comandă în registru — lead-ul e trecut convertit, ca istoricul să înceapă de undeva.",
        azi()
      );
    p = { id };
  }
  await alocaClientul(p.id, agentId);
  cache.set(cheie, p.id);
  return p.id;
}

// Excel ține datele ca număr de zile de la 30.12.1899. Când registrul vine
// prin browser (nu ca fișier), celulele de dată sosesc exact așa — un număr.
function dinSerialExcel(v) {
  const n = Number(String(v || "").trim());
  if (!Number.isFinite(n) || n < 20000 || n > 60000) return null;
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

// O dată din registru: fie serial Excel, fie scrisă. Ce nu e nici una, nici
// alta (în registru sunt și celule cu „KCK 1564*572" pe coloana de dată) se
// întoarce ca text, ca să se vadă în listă așa cum e scris — nu-l repar eu.
function dataRegistru(v) {
  const s = String(v || "").trim();
  if (!s) return { data: null, text: null };
  const ser = dinSerialExcel(s);
  if (ser) return { data: ser, text: null };
  const parsat = parseDataComenzi(s);
  if (parsat) return { data: parsat, text: null };
  return { data: null, text: s };
}

// Un rând de registru → o comandă de producție. Stă într-un singur loc
// fiindcă registrul intră pe două căi: încărcat ca fișier din Import, sau
// trimis din browser prin punte (când fișierul e într-un OneDrive la care
// serverul n-are cum să ajungă). Aceleași reguli, același rezultat.
async function scrieRandRegistru(v, cacheP, existente) {
  const numar = String(v.numar || "").trim();
  const client = String(v.client || "").trim();
  if (!client || !/\d/.test(numar)) return "sarit";
  if (existente.has(numar)) return "sarit";
  existente.add(numar);

  const stare = String(v.stare || "").toLowerCase();
  const facturatTxt = String(v.facturat || "").trim();
  const eFacturat = /^da$/i.test(facturatTxt);
  let status;
  if (/anulat/.test(stare)) status = "anulata";
  else if (eFacturat) status = "facturata";
  else if (/finalizat/.test(stare)) status = "finalizata";
  else status = "in_productie"; // stare goală în registru = încă în lucru

  const plasare = dataRegistru(v.plasare);
  const livrare = dataRegistru(v.livrare);
  // Ce nu s-a putut citi ca dată nu se pierde: ajunge în observații, cu
  // eticheta coloanei din care vine.
  const bucati = [String(v.observatii || "").trim()];
  if (plasare.text) bucati.push("Data plasare, scrisă în registru: " + plasare.text);
  if (livrare.text) bucati.push("Data livrare, scrisă în registru: " + livrare.text);
  const observatii = bucati.filter(Boolean).join(" · ") || null;

  const agentId = await agentDinCod(v.reprezentant);
  const partenerId = await partenerSauCreeaza(client, agentId, cacheP);

  await db
    .prepare(
      `INSERT INTO comenzi_productie (numar, reprezentant, agent_id, partener_id, client_text, tip_produs, caracteristici, cantitate, um, tip_ambalare, data_initiere, data_livrare, data_solicitata, data_finalizare, status, doc_emisa, fisa_tehnica, doc_emisa_txt, fisa_tehnica_txt, facturat, observatii, reteta, sursa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import_registru')`
    )
    .run(
      numar,
      String(v.reprezentant || "").trim() || null,
      agentId,
      partenerId,
      client,
      String(v.produs || "").trim() || null,
      String(v.caracteristici || "").trim() || null,
      String(v.cantitate || "").trim() || null,
      String(v.um || "").trim() || "buc",
      String(v.ambalare || "").trim() || null,
      plasare.data,
      livrare.data,
      livrare.data,
      /finalizat/.test(stare) || eFacturat ? livrare.data : null,
      status,
      daNu(v.doc),
      daNu(v.fisa),
      String(v.doc || "").trim() || null,
      String(v.fisa || "").trim() || null,
      facturatTxt || null,
      observatii,
      String(v.reteta || "").trim() || null
    );
  return "creat";
}

// Handlerul de punte: primește rândurile registrului din browser.
async function ingestRegistruComenzi(randuri) {
  const existente = new Set((await db.prepare("SELECT numar FROM comenzi_productie WHERE numar IS NOT NULL").all()).map((r) => String(r.numar)));
  const cacheP = new Map();
  let create = 0;
  let sarite = 0;
  const erori = [];
  for (const v of randuri) {
    try {
      if ((await scrieRandRegistru(v, cacheP, existente)) === "creat") create++;
      else sarite++;
    } catch (e) {
      erori.push(String((e && e.message) || e).slice(0, 160));
    }
  }
  return { comenzi_scrise: create, sarite, erori: erori.slice(0, 10) };
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
        ${ctx.user && ctx.user.rol === "admin"
          ? `<form method="post" action="/productie/leaga-agenti" class="inline-form"><button class="btn secondary" type="submit" title="Pune agentul pe comenzile care n-au unul și creează clienții care lipsesc">Leagă agenții și clienții</button></form>`
          : ""}
      </div>
      ${ctx.query && ctx.query.legat !== undefined
        ? `<div class="flash">Legate de agent: <b>${esc(String(ctx.query.legat))}</b> comenzi. Clienți creați sau legați: <b>${esc(String(ctx.query.clienti || 0))}</b>. Aveau deja agent: ${esc(String(ctx.query.aveau || 0))}.</div>`
        : ""}
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
      <div class="tabel-lat">
      ${table(
        ["<input type=\"checkbox\" onclick=\"document.querySelectorAll('.sel-cmd').forEach(c=>c.checked=this.checked)\">",
         "Nr. comandă", "Client", "Reprezentant", "Produs comandat", "Caracteristici produs",
         "Cantitate", "UM", "Tip ambalare", "Data plasare", "Data livrare", "Stare",
         "DoC", "Fișă tehnică", "Facturat", "Rețetă", "Observații", ""],
        comenzi.map((c) => [
          `<input type="checkbox" class="sel-cmd" name="ids" value="${c.id}">`,
          `<a href="/productie/${c.id}">${esc(c.numar || c.id)}</a>`,
          c.partener_id ? `<a href="/parteneri/${c.partener_id}">${esc(c.partener_nume || c.client_text)}</a>` : esc(c.client_text || "—"),
          esc(c.agent_nume || c.reprezentant || "—"),
          esc(c.tip_produs || "—"),
          `<span class="cel-lung">${esc(c.caracteristici || "")}</span>`,
          esc(c.cantitate || ""),
          esc(c.um || ""),
          esc(c.tip_ambalare || ""),
          esc(c.data_initiere || ""),
          c.data_livrare
            ? ["noua", "in_productie"].includes(c.status) && c.data_livrare < aziStr
              ? `<span class="badge rosu">${esc(c.data_livrare)}</span>`
              : esc(c.data_livrare)
            : "",
          badge(c.status),
          esc(c.doc_emisa_txt || (c.doc_emisa ? "DA" : "")),
          esc(c.fisa_tehnica_txt || (c.fisa_tehnica ? "DA" : "")),
          esc(c.facturat || ""),
          `<span class="cel-lung">${esc(c.reteta || "")}</span>`,
          `<span class="cel-lung">${esc(c.observatii || "")}</span>`,
          `<a class="btn small" href="/productie/${c.id}/pdf" target="_blank" title="Comanda de dat în producție, gata de printat">Comandă PDF</a>`,
        ])
      )}
      </div>
      <div class="toolbar" style="margin-top:10px">
        <button class="btn secondary" type="submit">Șterge selectatele</button>
      </div>
      </form>
      ${sectiuneSpreAlocare(spre)}
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
  // Leagă de agenți comenzile intrate înainte ca legătura să existe, și
  // comenzile ale căror clienți nu erau încă în ERP. Se poate apăsa oricând:
  // atinge doar ce n-are încă legătură, deci a doua oară nu mai face nimic.
  // Util și după ce schimbi codul unui om — comenzile lui vechi rămân la
  // cine erau, dar cele nelegate se prind acum.
  router.post("/productie/leaga-agenti", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/productie");
    uitaAgentii();
    const fara = await db
      .prepare("SELECT id, reprezentant, client_text, partener_id, agent_id FROM comenzi_productie ORDER BY id")
      .all();
    const cache = new Map();
    let agenti = 0;
    let clienti = 0;
    let deja = 0;
    for (const c of fara) {
      let agentId = c.agent_id;
      if (!agentId) {
        agentId = await agentDinCod(c.reprezentant);
        if (agentId) {
          await db.prepare("UPDATE comenzi_productie SET agent_id = ? WHERE id = ?").run(agentId, c.id);
          agenti++;
        }
      } else deja++;
      if (!agentId) continue;
      if (c.partener_id) {
        await alocaClientul(c.partener_id, agentId);
      } else if (c.client_text) {
        const pid = await partenerSauCreeaza(c.client_text, agentId, cache);
        if (pid) {
          await db.prepare("UPDATE comenzi_productie SET partener_id = ? WHERE id = ?").run(pid, c.id);
          clienti++;
        }
      }
    }
    redirect(ctx.res, `/productie?legat=${agenti}&clienti=${clienti}&aveau=${deja}`);
  });

  router.get("/productie/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume LIMIT 3000").all();
    const utilizatori = await db.prepare("SELECT id, nume, cod_agent FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const nrNou = await numarComandaNou();
    const alesImplicit = ctx.user ? ctx.user.id : null;
    const daNuSelect = (nume) =>
      `<select name="${nume}"><option value=""></option><option value="DA">DA</option><option value="NU">NU</option><option value="NA">NA</option></select>`;

    const body = `
      <form class="form" method="post" action="/productie" style="max-width:860px">
        <div style="display:grid;grid-template-columns:200px 1fr;gap:14px">
          <label class="field">Nr. comandă<input name="numar" value="${esc(nrNou)}" required></label>
          <label class="field">Client
            <input name="client_nou" list="lista-clienti" placeholder="Scrie numele clientului" autocomplete="off">
            <datalist id="lista-clienti">${parteneri.map((p) => `<option value="${esc(p.nume)}">`).join("")}</datalist>
          </label>
        </div>
        <p class="ajutor">Dacă clientul nu e încă în ERP, îl scrii aici și se creează singur: partener nou, cu un lead convertit în spate, alocat agentului de mai jos.</p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Reprezentant vânzări
            <select name="agent_id" required>
              ${utilizatori
                .map(
                  (u) =>
                    `<option value="${u.id}"${u.id === alesImplicit ? " selected" : ""}>${esc(u.nume)}${u.cod_agent ? ` (${esc(u.cod_agent)})` : ""}</option>`
                )
                .join("")}
            </select>
          </label>
          <label class="field">Produs comandat<input name="tip_produs" required placeholder="Ex: Folie Stretch, Pungi Curier, Bandă adezivă"></label>
        </div>

        <label class="field">Caracteristici produs (dimensiuni, microni…)<input name="caracteristici" placeholder="Ex: 23 microni reciclat, 1.5 kg net"></label>

        <div style="display:grid;grid-template-columns:1fr 110px 1fr;gap:14px">
          <label class="field">Cantitate comandată<input name="cantitate" required placeholder="Ex: 15000"></label>
          <label class="field">UM<input name="um" value="buc"></label>
          <label class="field">Tip ambalare<input name="tip_ambalare" placeholder="Ex: 6 role/pack, 500/cutie"></label>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
          <label class="field">Data plasare comandă<input type="date" name="data_initiere" value="${esc(azi())}"></label>
          <label class="field">Data livrare comandă<input type="date" name="data_livrare"></label>
          <label class="field">Stare comandă
            <select name="status">${STATUSURI.map(([v, t]) => `<option value="${v}"${v === "noua" ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>
          </label>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
          <label class="field">DoC emisă${daNuSelect("doc")}</label>
          <label class="field">Fișă tehnică emisă${daNuSelect("fisa")}</label>
          <label class="field">Facturat
            <select name="facturat"><option value=""></option><option value="Da">Da</option><option value="Nu">Nu</option></select>
          </label>
        </div>

        <label class="field">Rețetă / consum estimat<textarea name="reteta" rows="2" placeholder="Ex: 190 kg, LDPE-23, LLDPE-80, MB 4, Tape 15 role"></textarea></label>
        <label class="field">Observații<textarea name="observatii" rows="2"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Înregistrează comanda</button> <a class="btn secondary" href="/productie">Renunță</a></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted)">Sunt exact coloanele din registru. Numărul urmează formatul lui: ziua plus un contor.</p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă în producție", active: "/productie", body }));
  });

  router.post("/productie", async (ctx) => {
    const b = ctx.body;
    const agentId = parseInt(b.agent_id, 10) || (ctx.user ? ctx.user.id : null);
    // Clientul: fie ales din listă, fie scris de mână. Dacă e scris și nu-l
    // avem, se creează — cu lead-ul lui, ca să nu apară un partener din senin.
    const numeClient = String(b.client_nou || "").trim();
    const cache = new Map();
    let partenerId = parseInt(b.partener_id, 10) || null;
    if (!partenerId && numeClient) partenerId = await partenerSauCreeaza(numeClient, agentId, cache);
    else if (partenerId) await alocaClientul(partenerId, agentId);

    const p = partenerId ? await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(partenerId) : null;
    const agent = agentId ? await db.prepare("SELECT nume, cod_agent FROM utilizatori WHERE id = ?").get(agentId) : null;
    const numar = String(b.numar || "").trim() || (await numarComandaNou());
    const livrare = String(b.data_livrare || "") || null;
    const stare = String(b.status || "noua").trim() || "noua";

    const ins = await db
      .prepare(
        `INSERT INTO comenzi_productie (numar, initiator, initiator_id, reprezentant, agent_id, partener_id, client_text, tip_produs, caracteristici, cantitate, um, tip_ambalare, data_initiere, data_livrare, data_solicitata, data_finalizare, status, doc_emisa, fisa_tehnica, doc_emisa_txt, fisa_tehnica_txt, facturat, observatii, reteta, sursa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual') RETURNING id`
      )
      .run(
        numar,
        ctx.user ? ctx.user.nume : null,
        ctx.user ? ctx.user.id : null,
        agent ? String(agent.cod_agent || "").trim() || initialeNume(agent.nume) : null,
        agentId,
        partenerId,
        p ? p.nume : numeClient || null,
        String(b.tip_produs || "").trim(),
        String(b.caracteristici || "").trim() || null,
        String(b.cantitate || "").trim(),
        String(b.um || "buc").trim(),
        String(b.tip_ambalare || "").trim() || null,
        String(b.data_initiere || "") || azi(),
        livrare,
        livrare,
        ["finalizata", "facturata"].includes(stare) ? livrare : null,
        stare,
        daNu(b.doc),
        daNu(b.fisa),
        String(b.doc || "").trim() || null,
        String(b.fisa || "").trim() || null,
        String(b.facturat || "").trim() || null,
        String(b.observatii || "").trim() || null,
        String(b.reteta || "").trim() || null
      );
    redirect(ctx.res, `/productie/${ins.lastInsertRowid}`);
  });

  router.get("/productie/:id/pdf", async (ctx) => {
    const c = await db
      .prepare(
        `SELECT c.*, p.nume AS partener_nume, p.cui AS partener_cui, u.nume AS agent_nume
           FROM comenzi_productie c
           LEFT JOIN parteneri p ON p.id = c.partener_id
           LEFT JOIN utilizatori u ON u.id = c.agent_id
          WHERE c.id = ?`
      )
      .get(ctx.params.id);
    if (!c) return send(ctx.res, 404, "Comanda nu există.");

    const aloc = await db
      .prepare(
        `SELECT a.*, u.denumire AS utilaj, u.cod AS utilaj_cod
           FROM alocari_productie a LEFT JOIN utilaje u ON u.id = a.utilaj_id
          WHERE a.comanda_productie_id = ? ORDER BY a.data, a.ora_start`
      )
      .all(c.id);
    const oameni = new Map();
    for (const a of aloc) {
      const r = await db
        .prepare("SELECT r.nume FROM alocari_resurse ar JOIN resurse r ON r.id = ar.resursa_id WHERE ar.alocare_id = ?")
        .all(a.id);
      oameni.set(a.id, r.map((x) => x.nume));
    }

    const ora = (v) => {
      const n = Number(v || 0);
      const h = Math.floor(n);
      const m = Math.round((n - h) * 60);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    };
    const rand = (et, val) => (val ? `<tr><th>${esc(et)}</th><td>${esc(val)}</td></tr>` : "");
    const stareText = (STATUSURI.find(([v]) => v === c.status) || [null, c.status])[1];

    const alocHtml = aloc.length
      ? `<h2>Alocare</h2>
         <table class="cp-tabel">
           <tr><th>Data</th><th>Interval</th><th>Utilaj</th><th>Cantitate</th><th>Oameni</th></tr>
           ${aloc
             .map(
               (a) => `<tr>
                 <td>${esc(a.data || "")}</td>
                 <td>${esc(ora(a.ora_start))}–${esc(ora(Number(a.ora_start) + Number(a.ore || 0)))}</td>
                 <td>${esc([a.utilaj_cod, a.utilaj].filter(Boolean).join(" · ") || "—")}</td>
                 <td>${esc(a.cantitate != null ? String(a.cantitate) : "")}</td>
                 <td>${esc((oameni.get(a.id) || []).join(", "))}</td>
               </tr>`
             )
             .join("")}
         </table>`
      : `<h2>Alocare</h2><p class="cp-gol">Comanda nu e încă alocată pe utilaj. Se alocă din <b>Producție → Planificare</b>, apoi se tipărește din nou.</p>`;

    const corp = `<!doctype html>
<html lang="ro"><head><meta charset="utf-8">
<title>Comanda ${esc(c.numar || c.id)} · producție</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #14314f; margin: 0; background: #eef2f6; }
  .bara { padding: 10px 16px; background: #fff; border-bottom: 1px solid #d7dfe8; font-size: 14px; }
  .bara button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #2f5f92; background: #2f5f92; color: #fff; cursor: pointer; }
  .bara a { color: #2f5f92; margin-left: 12px; }
  .foaie { width: 210mm; min-height: 297mm; margin: 16px auto; padding: 16mm; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
  .cap { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #14314f; padding-bottom: 8px; margin-bottom: 14px; }
  .cap .firma { font-size: 13px; letter-spacing: 1px; font-weight: 700; }
  .cap .tip { font-size: 11px; color: #5b6b7d; letter-spacing: 2px; text-transform: uppercase; }
  .cap .nr { text-align: right; }
  .cap .nr b { font-size: 26px; font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 1px; }
  h1 { font-size: 21px; margin: 0 0 2px; }
  .sub { color: #5b6b7d; font-size: 13px; margin-bottom: 14px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.2px; color: #4a6b8c; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e2e9f0; vertical-align: top; }
  .cp-date th { width: 42mm; color: #5b6b7d; font-weight: 600; }
  .cp-tabel th { background: #f2f6fa; font-size: 11.5px; text-transform: uppercase; letter-spacing: .6px; color: #4a6b8c; }
  .mare { font-size: 19px; font-weight: 700; }
  .cp-gol { color: #7b8794; font-size: 13px; font-style: italic; }
  .semnaturi { display: flex; gap: 18px; margin-top: 26px; }
  .semnaturi div { flex: 1; border-top: 1px solid #98a6b5; padding-top: 5px; font-size: 11.5px; color: #5b6b7d; }
  .obs { border-left: 3px solid #e0a14a; background: #fdf7ee; padding: 8px 12px; font-size: 13px; }
  @media print { .bara { display: none; } body { background: #fff; } .foaie { margin: 0; box-shadow: none; width: auto; min-height: 0; padding: 0; } }
</style></head>
<body>
<div class="bara">
  <button onclick="window.print()">Tipărește / salvează ca PDF</button>
  <a href="/productie">← Înapoi la comenzi</a>
</div>
<div class="foaie">
  <div class="cap">
    <div>
      <div class="firma">CASH MACHINE SRL</div>
      <div class="tip">Comandă de producție</div>
    </div>
    <div class="nr"><b>${esc(c.numar || String(c.id))}</b><br><span class="tip">${esc(stareText || "")}</span></div>
  </div>

  <h1>${esc(c.tip_produs || "Produs")}</h1>
  <div class="sub">${esc(c.caracteristici || "")}</div>

  <h2>Ce se face</h2>
  <table class="cp-date">
    <tr><th>Cantitate</th><td class="mare">${esc([c.cantitate, c.um].filter(Boolean).join(" ") || "—")}</td></tr>
    ${rand("Tip ambalare", c.tip_ambalare)}
    ${rand("Rețetă", c.reteta)}
  </table>

  <h2>Pentru cine și până când</h2>
  <table class="cp-date">
    ${rand("Client", c.partener_nume || c.client_text)}
    ${rand("Reprezentant vânzări", c.agent_nume || c.reprezentant)}
    ${rand("Data plasării", c.data_initiere)}
    ${rand("Data livrării", c.data_livrare)}
    ${rand("DoC emisă", c.doc_emisa_txt || (c.doc_emisa ? "DA" : ""))}
    ${rand("Fișă tehnică emisă", c.fisa_tehnica_txt || (c.fisa_tehnica ? "DA" : ""))}
  </table>

  ${alocHtml}

  ${c.observatii ? `<h2>Observații</h2><div class="obs">${esc(c.observatii)}</div>` : ""}

  <div class="semnaturi">
    <div>Predat de (planificare) — nume, semnătura, data</div>
    <div>Primit de (producție) — nume, semnătura, data</div>
    <div>Cantitate realizată / observații la execuție</div>
  </div>
</div>
</body></html>`;
    send(ctx.res, 200, dateleInText(corp));
  });

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
      try {
        const rez = await scrieRandRegistru(
          {
            numar: val(row, "numar"),
            client: val(row, "client"),
            reprezentant: val(row, "reprezentant"),
            produs: val(row, "produs"),
            caracteristici: val(row, "caracteristici"),
            cantitate: val(row, "cantitate"),
            um: val(row, "um"),
            ambalare: val(row, "ambalare"),
            plasare: val(row, "plasare"),
            livrare: val(row, "livrare"),
            stare: val(row, "stare"),
            doc: val(row, "doc"),
            fisa: val(row, "fisa"),
            facturat: val(row, "facturat"),
            reteta: val(row, "reteta"),
            observatii: val(row, "observatii"),
          },
          cacheP,
          existente
        );
        if (rez === "creat") create++;
        else sarite++;
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

module.exports = { register, STATUSURI, ingestRegistruComenzi };
