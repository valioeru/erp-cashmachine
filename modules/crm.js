"use strict";
// CRM — trei componente care lucrează împreună:
//   1. Lead-uri: contacte care încă NU sunt clienți. Stau separat de parteneri
//      ca lista de clienți să nu se umple de contacte necalificate; la
//      conversie devin partener (+ opțional oportunitate).
//   2. Oportunități: pipeline-ul de vânzare pe stadii.
//   3. Activitate: task-uri, interacțiuni și emailuri trimise din aplicație.
const db = require("../lib/db");

// Costul unei linii se ia în calcul doar dacă e credibil. O linie cu preț de
// achiziție de peste cinci ori mai mare decât ce s-a încasat pe ea (plus 100
// de lei, ca să nu se agațe de fleacuri) nu e marjă proastă, e o greșeală de
// date: fie prețul produsului e luat în altă unitate, fie cantitatea de pe
// factură a fost importată strâmb — 1.720 bucăți la 1 leu în loc de o rolă la
// 1.720 de lei. Astfel de linii se numără la „fără cost", exact ca cele fără
// produs identificat, iar rapoartele spun pe față că marja e o estimare în
// plus. Praguri identice cu verificarea „cost de marfă aberant" din
// modules/verificari.js, ca cele două să arate aceleași rânduri.
const COST_LINIE =
  "CASE WHEN fl.cantitate * COALESCE(pr.pret_achizitie, 0) > 5 * (fl.cantitate * fl.pret_unitar) + 100 THEN 0 ELSE fl.cantitate * COALESCE(pr.pret_achizitie, 0) END";
const { ALOC, ALOC_FACTURA } = require("./alocari");
const { esc, money, layout, table, subnavCrm } = require("../lib/render");
const { chipuriPerioada } = require("../lib/perioada");
const { send, redirect } = require("../lib/router");
const taskuri = require("./taskuri");

const STADII = [
  { key: "lead", label: "Lead" },
  { key: "calificat", label: "Calificat" },
  { key: "oferta", label: "Ofertă trimisă" },
  { key: "negociere", label: "Negociere" },
  { key: "castigat", label: "Câștigat" },
  { key: "pierdut", label: "Pierdut" },
];
const STADIU_LABEL = Object.fromEntries(STADII.map((s) => [s.key, s.label]));

const STADII_LEAD = [
  ["nou", "Nou", "gri"],
  ["contactat", "Contactat", "galben"],
  ["calificat", "Calificat", "verde"],
  ["necalificat", "Necalificat", "rosu"],
  ["convertit", "Convertit în client", "verde"],
];

const SURSE_LEAD = ["site", "telefon", "email", "recomandare", "târg / expoziție", "LinkedIn", "campanie", "manual", "altele"];

const TIPURI_INTERACTIUNE = [
  ["apel", "Apel telefonic"],
  ["email", "Email"],
  ["intalnire", "Întâlnire"],
  ["nota", "Notiță"],
];

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function badgeLead(stadiu) {
  const g = STADII_LEAD.find((s) => s[0] === stadiu);
  return g ? `<span class="badge ${g[2]}">${esc(g[1])}</span>` : esc(stadiu);
}
function nr(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Pâlnia de vânzări, desenată.
//
// Coloanele de mai jos spun cine e unde, dar nu spun cât se pierde de la un
// pas la altul — asta se vede dintr-o formă, nu dintr-o listă. Lățimea
// fiecărei benzi e proporțională cu numărul de oportunități din stadiul ei,
// iar în bandă scrie chiar ce trebuie: câte, cât fac și cât la sută au trecut
// mai departe față de pasul dinainte.
//
// Culorile sunt o singură familie de albastru, de la deschis la închis: e o
// mărime care scade, nu categorii independente — un curcubeu ar minți despre
// relația dintre benzi. Cerneala de pe fiecare bandă e aleasă după contrast
// (peste 4.5:1 pe toate), nu după gust.
// Culorile: o singură familie de albastru, de la deschis la închis. E o
// mărime care scade de la un pas la altul, nu categorii independente — un
// curcubeu ar minți despre relația dintre benzi. Cerneala fiecărei benzi e
// aleasă după contrast, peste 4.5:1 pe toate.
const CULORI_PALNIE = [
  { fill: "#e3ecf9", ink: "#1a2233" },
  { fill: "#c2d5ef", ink: "#1a2233" },
  { fill: "#93b3e0", ink: "#1a2233" },
  { fill: "#3a6bb0", ink: "#ffffff" },
  { fill: "#22497e", ink: "#ffffff" },
];

// Treptele pâlniei, luate din ce se întâmplă de fapt: lead-uri, oferte,
// comenzi. Dacă cineva ține și oportunități, ele se adaugă peste treapta
// potrivită — dar pâlnia nu mai depinde de ele ca să existe.
async function trepteleP(filtruAgent) {
  // Când te uiți la pâlnia unui om, vezi ce e al lui. Lead-urile fără stăpân
  // apăreau până acum în pâlnia fiecăruia, ceea ce făcea ca toți să aibă
  // aceleași 31 de lead-uri și ca procentul de conversie să nu însemne nimic.
  const undeAgent = filtruAgent ? " AND l.atribuit_lui = ?" : "";
  const argAgent = filtruAgent ? [filtruAgent] : [];

  const leaduri = await db
    .prepare(`SELECT stadiu, COUNT(*) AS n FROM leaduri l WHERE 1=1${undeAgent} GROUP BY stadiu`)
    .all(...argAgent)
    .catch(() => []);
  const peStadiu = new Map((leaduri || []).map((r) => [String(r.stadiu), Number(r.n) || 0]));

  const undeOferte = filtruAgent ? " AND o.agent_id = ?" : "";
  const oferte = await db
    .prepare(
      `SELECT o.status, COUNT(*) AS n,
              COALESCE(SUM((SELECT SUM(ol.cantitate * ol.pret_unitar) FROM oferte_linii ol WHERE ol.oferta_id = o.id)), 0) AS valoare
         FROM oferte o WHERE 1=1${undeOferte} GROUP BY o.status`
    )
    .all(...argAgent)
    .catch(() => []);
  const peOferta = new Map((oferte || []).map((r) => [String(r.status), { n: Number(r.n) || 0, valoare: Number(r.valoare) || 0 }]));
  const of = (k) => peOferta.get(k) || { n: 0, valoare: 0 };

  const undeComenzi = filtruAgent ? " AND c.agent_id = ?" : "";
  const comenzi = await db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id)), 0) AS valoare
         FROM comenzi c WHERE c.status != 'anulata'${undeComenzi}`
    )
    .get(...argAgent)
    .catch(() => ({ n: 0, valoare: 0 }));

  // Comenzile din registrul de producție intră în aceeași treaptă. Sunt
  // comenzi reale de client, doar că se scriu în Producție, nu în CRM — omul
  // de vânzări trebuie să le vadă în pâlnia lui, altfel pâlnia îl minte.
  const undeProd = filtruAgent ? " AND cp.agent_id = ?" : "";
  const comenziProd = await db
    .prepare(`SELECT COUNT(*) AS n FROM comenzi_productie cp WHERE cp.status != 'anulata'${undeProd}`)
    .get(...argAgent)
    .catch(() => ({ n: 0 }));

  const oportunitati = await db
    .prepare(
      `SELECT stadiu, COUNT(*) AS n, COALESCE(SUM(valoare_estimata), 0) AS valoare FROM oportunitati o
        WHERE 1=1${filtruAgent ? " AND o.atribuit_lui = ?" : ""} GROUP BY stadiu`
    )
    .all(...argAgent)
    .catch(() => []);
  const peOp = new Map((oportunitati || []).map((r) => [String(r.stadiu), { n: Number(r.n) || 0, valoare: Number(r.valoare) || 0 }]));
  const op = (k) => peOp.get(k) || { n: 0, valoare: 0 };

  const trepte = [
    { label: "Lead-uri", unitate: "lead-uri", unitate1: "lead", n: (peStadiu.get("nou") || 0) + (peStadiu.get("contactat") || 0) + op("lead").n, valoare: op("lead").valoare },
    { label: "Calificate", unitate: "calificate", unitate1: "calificat", n: (peStadiu.get("calificat") || 0) + op("calificat").n, valoare: op("calificat").valoare },
    { label: "Oferte trimise", unitate: "oferte", unitate1: "ofertă", n: of("trimisa").n + op("oferta").n, valoare: of("trimisa").valoare + op("oferta").valoare },
    { label: "În negociere", unitate: "oferte", unitate1: "ofertă", n: of("negociere").n + op("negociere").n, valoare: of("negociere").valoare + op("negociere").valoare },
    { label: "Comenzi", unitate: "comenzi", unitate1: "comandă", n: (Number(comenzi && comenzi.n) || 0) + op("castigat").n + (Number(comenziProd && comenziProd.n) || 0), valoare: (Number(comenzi && comenzi.valoare) || 0) + op("castigat").valoare },
  ].map((t, i) => ({ ...t, ...CULORI_PALNIE[i] }));

  const pierdute = {
    n: (peStadiu.get("necalificat") || 0) + of("respinsa").n + op("pierdut").n,
    valoare: of("respinsa").valoare + op("pierdut").valoare,
  };

  return { trepte, pierdute };
}

function palnie(trepte, pierdute) {
  const maxN = Math.max(...trepte.map((t) => t.n), 1);
  const total = trepte.reduce((t, x) => t + x.n, 0);
  if (!total && !(pierdute && pierdute.n)) {
    return '<p style="color:var(--text-muted)">Pâlnia se desenează singură când apare primul lead sau prima ofertă.</p>';
  }

  // Pâlnia se desenează ca o singură siluetă, nu ca un teanc de trapeze
  // lipite: conturul (cu colțurile de sus și de jos rotunjite) devine o
  // mască, iar culorile se toarnă în ea. Așa nu mai apar cusături între
  // benzi, iar marginile ies curate la orice lățime.
  const L = 760;
  const H = 82;
  const R = 14; // cât de rotunjite sunt capetele
  const inaltime = trepte.length * H;

  // Lățimea benzii spune cât e treapta, dar are și un minim care se strânge cu
  // fiecare treaptă. Fara asta, o pâlnie cu zerouri sub prima treaptă iese un
  // teanc de dreptunghiuri egale, nu o pâlnie. Cifra scrie oricum pe fiecare
  // bandă, așa că nimeni nu se ia după lățime ca să afle numărul.
  const nrTrepte = Math.max(trepte.length - 1, 1);
  const minimLa = (i) => L * (0.66 - 0.36 * (i / nrTrepte));
  const latime = (n, i) => Math.max(L * (maxN ? n / maxN : 0), minimLa(i));

  // Lățimile la fiecare linie orizontală: n+1 valori pentru n benzi.
  const w = trepte.map((t, i) => latime(t.n, i));
  w.push(latime(trepte[trepte.length - 1].n, trepte.length - 1) * 0.88);
  const st = (k) => (L - w[k]) / 2;
  const dr = (k) => (L + w[k]) / 2;
  const y = (k) => k * H;
  const ultimul = trepte.length;

  // Conturul: coborâm pe dreapta, trecem prin fund, urcăm pe stânga.
  const contur = [
    `M ${st(0) + R} 0`,
    `L ${dr(0) - R} 0`,
    `Q ${dr(0)} 0 ${dr(0)} ${R}`,
    ...trepte.map((_, k) => `L ${dr(k + 1)} ${y(k + 1) - (k + 1 === ultimul ? R : 0)}`),
    `Q ${dr(ultimul)} ${y(ultimul)} ${dr(ultimul) - R} ${y(ultimul)}`,
    `L ${st(ultimul) + R} ${y(ultimul)}`,
    `Q ${st(ultimul)} ${y(ultimul)} ${st(ultimul)} ${y(ultimul) - R}`,
    ...trepte.map((_, k) => `L ${st(ultimul - k - 1)} ${y(ultimul - k - 1) + (ultimul - k - 1 === 0 ? R : 0)}`),
    `Q ${st(0)} 0 ${st(0) + R} 0`,
    "Z",
  ].join(" ");

  const benzi = trepte
    .map((t, i) => {
      const anterior = i > 0 ? trepte[i - 1].n : null;
      const conversie = anterior ? Math.round((t.n / anterior) * 100) : null;
      const c = L / 2;
      const yy = y(i);
      return `
        <g>
          <title>${esc(t.label)}: ${t.n}${t.valoare ? `, ${money(t.valoare)}` : ""}${
            conversie !== null ? `, ${conversie}% din „${esc(trepte[i - 1].label)}"` : ""
          }</title>
          <rect x="0" y="${yy}" width="${L}" height="${H}" fill="${t.fill}" clip-path="url(#palnie-masca)"></rect>
          ${i ? `<line x1="0" y1="${yy}" x2="${L}" y2="${yy}" stroke="#fff" stroke-width="2" opacity="0.85" clip-path="url(#palnie-masca)"></line>` : ""}
          <text x="${c}" y="${yy + 30}" text-anchor="middle" fill="${t.ink}" font-size="15" font-weight="700" letter-spacing="0.2">${esc(t.label)}</text>
          <text x="${c}" y="${yy + 54}" text-anchor="middle" fill="${t.ink}" font-size="19" font-weight="700">${t.n}<tspan font-size="12" font-weight="500" opacity="0.85"> ${esc(
            t.n === 1 ? t.unitate1 || "bucată" : t.unitate || "bucăți"
          )}${t.valoare && Math.min(w[i], w[i + 1]) > 250 ? ` · ${money(t.valoare)}` : ""}</tspan></text>
          ${
            conversie !== null
              ? `<text x="${c}" y="${yy + 72}" text-anchor="middle" fill="${t.ink}" font-size="11" opacity="0.8">${conversie}% din „${esc(
                  trepte[i - 1].label
                )}"</text>`
              : ""
          }
        </g>`;
    })
    .join("");

  const primul = trepte[0].n;
  const ultim = trepte[trepte.length - 1];
  const rataFinala = primul ? Math.round((ultim.n / primul) * 100) : null;

  // Dacă totul de sub prima treaptă e gol, pâlnia n-are ce arăta. Spunem de ce,
  // în loc s-o lăsăm să pară că nu se vinde nimic.
  const subPrimaGol = trepte.slice(1).every((t) => !t.n);

  return `
    <div class="palnie">
      <svg viewBox="-14 -10 ${L + 28} ${inaltime + 20}" class="palnie-desen" role="img" aria-label="Pâlnia de vânzări pe stadii">
        <defs>
          <clipPath id="palnie-masca"><path d="${contur}"></path></clipPath>
          <linearGradient id="palnie-lumina" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fff" stop-opacity="0.16"></stop>
            <stop offset="45%" stop-color="#fff" stop-opacity="0"></stop>
            <stop offset="100%" stop-color="#000" stop-opacity="0.07"></stop>
          </linearGradient>
          <filter id="palnie-umbra" x="-10%" y="-10%" width="120%" height="125%">
            <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#1c2230" flood-opacity="0.16"></feDropShadow>
          </filter>
        </defs>
        <g filter="url(#palnie-umbra)">
          ${benzi}
          <rect x="0" y="0" width="${L}" height="${inaltime}" fill="url(#palnie-lumina)" clip-path="url(#palnie-masca)" pointer-events="none"></rect>
        </g>
      </svg>
      ${
        subPrimaGol && primul
          ? `<div class="detail-box" style="border-left:4px solid #8a6d1f;margin-top:10px">
               Pâlnia se oprește la lead-uri fiindcă <strong>ofertele și comenzile nu se înregistrează încă în ERP</strong> —
               facturile intră direct din SmartBill, fără ofertă și comandă în spate. Prima
               <a href="/oferte/nou">ofertă</a> sau <a href="/comenzi/nou">comandă</a> introdusă aici umple treptele de jos
               și abia atunci pâlnia arată conversia reală.
             </div>`
          : ""
      }
      <div class="palnie-legenda">
        <span><strong style="color:var(--text)">${total}</strong> în pâlnie</span>
        ${rataFinala !== null ? `<span>ajung comenzi <strong style="color:var(--text)">${rataFinala}%</strong> din lead-uri</span>` : ""}
        ${
          pierdute && pierdute.n
            ? `<span style="display:inline-flex;align-items:center;gap:6px">
                 <span style="width:10px;height:10px;border-radius:2px;background:#b3261e;display:inline-block"></span>
                 ${pierdute.n} pierdute${pierdute.valoare ? ` · ${money(pierdute.valoare)}` : ""}
               </span>`
            : ""
        }
      </div>
    </div>`;
}

function register(router) {
  // ================= PIPELINE (oportunități) ==========================
  router.get("/crm", async (ctx) => {
    // Adminul vede pipeline-ul total sau filtrat pe un singur agent; un agent
    // de vânzări își vede DOAR pipeline-ul lui (cerință de business).
    const esteAdmin = ctx.user && ctx.user.rol === "admin";
    let filtruAgent = null;
    if (esteAdmin) {
      const a = parseInt(ctx.query.agent, 10);
      filtruAgent = Number.isFinite(a) && a > 0 ? a : null;
    } else if (ctx.user && ctx.user.rol === "vanzari") {
      filtruAgent = ctx.user.id;
    }
    const agenti = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();

    const oportunitati = await db
      .prepare(
        `SELECT o.*, p.nume AS partener_nume, u.nume AS agent_nume
         FROM oportunitati o JOIN parteneri p ON p.id = o.partener_id
         LEFT JOIN utilizatori u ON u.id = o.atribuit_lui
         ${filtruAgent ? "WHERE o.atribuit_lui = ? OR p.agent_id = ?" : ""}
         ORDER BY o.id DESC`
      )
      .all(...(filtruAgent ? [filtruAgent, filtruAgent] : []));

    const aziStr = azi();
    const deContactat = await db
      .prepare(
        `SELECT i.*, p.nume AS partener_nume, p.id AS partener_id
         FROM interactiuni i JOIN parteneri p ON p.id = i.partener_id
         WHERE i.data_urmatoare_actiune IS NOT NULL AND i.data_urmatoare_actiune != '' AND i.data_urmatoare_actiune <= ?
         ORDER BY i.data_urmatoare_actiune ASC LIMIT 100`
      )
      .all(aziStr);

    const taskuriMele = await db
      .prepare(
        `${taskuri.SELECT_TASK} WHERE t.status IN ('${taskuri.DESCHISE.join("','")}') ${ctx.user ? "AND t.atribuit_lui = ?" : ""}
         ORDER BY (t.scadenta IS NULL), t.scadenta ASC LIMIT 15`
      )
      .all(...(ctx.user ? [ctx.user.id] : []));

    const nrLeaduriNoi = (await db.prepare("SELECT COUNT(*) AS n FROM leaduri WHERE stadiu IN ('nou','contactat')").get()).n;
    const dateP = await trepteleP(filtruAgent);

    const coloane = STADII.map((s) => {
      const items = oportunitati.filter((o) => o.stadiu === s.key);
      const totalValoare = items.reduce((sum, o) => sum + Number(o.valoare_estimata || 0), 0);
      return `<div class="crm-col">
        <div class="crm-col-head">${esc(s.label)} <span class="crm-col-count">${items.length}</span></div>
        <div class="crm-col-total">${money(totalValoare)}</div>
        ${
          items
            .map(
              (o) => `
          <a href="/crm/oportunitati/${o.id}" class="crm-card">
            <div class="crm-card-title">${esc(o.titlu)}</div>
            <div class="crm-card-partener">${esc(o.partener_nume)}</div>
            <div class="crm-card-valoare">${money(o.valoare_estimata)}</div>
            ${o.agent_nume ? `<div class="crm-card-partener">👤 ${esc(o.agent_nume)}</div>` : ""}
          </a>`
            )
            .join("") || `<div class="crm-col-empty">—</div>`
        }
      </div>`;
    }).join("");

    const body = `
      ${subnavCrm("/crm", ctx.user)}
      <div class="toolbar">
        <a href="/crm/oportunitati/noua" class="btn">+ Oportunitate</a>
        <a href="/crm/leaduri/nou" class="btn secondary">+ Lead</a>
        <a href="/taskuri/nou" class="btn secondary">+ Task</a>
        ${nrLeaduriNoi ? `<a href="/crm/leaduri" class="btn secondary">${nrLeaduriNoi} lead-uri de lucrat →</a>` : ""}
        ${
          esteAdmin
            ? `<form method="get" action="/crm" class="inline-form" style="margin-left:auto">
                <select name="agent" onchange="this.form.submit()" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px">
                  <option value="">Pipeline: toți agenții</option>
                  ${agenti.map((a) => `<option value="${a.id}"${filtruAgent === a.id ? " selected" : ""}>doar ${esc(a.nume)}</option>`).join("")}
                </select>
              </form>`
            : filtruAgent
            ? `<span style="margin-left:auto;font-size:13px;color:var(--text-muted)">Pipeline-ul tău</span>`
            : ""
        }
      </div>
      <h2 style="margin-bottom:4px">Pâlnia de vânzări</h2>
      ${palnie(dateP.trepte, dateP.pierdute)}
      ${oportunitati.length ? "<h2>Oportunitățile, una câte una</h2>" : ""}
      ${oportunitati.length ? `<div class="crm-board">${coloane}</div>` : ""}

      <h2>Task-urile mele deschise</h2>
      ${
        taskuriMele.length
          ? table(taskuri.CAPETE, taskuriMele.map((t) => taskuri.randTask(t, aziStr)))
          : '<p style="color:var(--text-muted)">Niciun task deschis. <a href="/taskuri/nou">Creează unul</a>.</p>'
      }

      <h2>De contactat (scadent sau azi)</h2>
      ${
        deContactat.length
          ? table(
              ["Partener", "Subiect", "Data programată", "Acțiune"],
              deContactat.map((i) => [
                `<a href="/parteneri/${i.partener_id}">${esc(i.partener_nume)}</a>`,
                esc(i.subiect) || "—",
                `${esc(i.data_urmatoare_actiune)}${i.data_urmatoare_actiune < aziStr ? ' <span class="badge rosu">întârziat</span>' : ""}`,
                `<a class="link-btn" href="/crm/email/nou?partener_id=${i.partener_id}">Trimite email</a>`,
              ])
            )
          : "<p>Nimic programat pentru azi.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "CRM — pipeline vânzări", active: "/crm", body }));
  });

  router.get("/crm/oportunitati/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 3000").all();
    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const presetPartener = ctx.query.partener_id || "";
    if (parteneri.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user, title: "Oportunitate nouă", active: "/crm", body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">partener</a>.</p>` })
      );
    }
    const body = `<form method="post" action="/crm/oportunitati" class="form">
      <label class="field"><span>Partener</span>
        <select name="partener_id" required>${parteneri
          .map((p) => `<option value="${p.id}" ${String(p.id) === String(presetPartener) ? "selected" : ""}>${esc(p.nume)}</option>`)
          .join("")}</select>
      </label>
      <label class="field"><span>Titlu oportunitate</span><input type="text" name="titlu" required value="${esc(String(ctx.query.titlu || ""))}"></label>
      <label class="field"><span>Valoare estimată (lei)</span><input type="number" step="0.01" name="valoare_estimata"></label>
      <label class="field"><span>Agent responsabil</span>
        <select name="atribuit_lui">
          <option value="">— neatribuit —</option>
          ${useri.map((u) => `<option value="${u.id}"${ctx.user && ctx.user.id === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Stadiu</span>
        <select name="stadiu">${STADII.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Dată estimată închidere</span><input type="date" name="data_estimata_inchidere"></label>
      <label class="field"><span>Observații</span><textarea name="observatii" rows="2"></textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn">Salvează</button>
        <a href="/crm" class="btn secondary">Renunță</a>
      </div>
    </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Oportunitate nouă", active: "/crm", body }));
  });

  router.post("/crm/oportunitati", async (ctx) => {
    const { partener_id, titlu, valoare_estimata, stadiu, data_estimata_inchidere, observatii, atribuit_lui } = ctx.body;
    const info = await db
      .prepare(
        "INSERT INTO oportunitati (partener_id, titlu, valoare_estimata, stadiu, data_estimata_inchidere, observatii, atribuit_lui) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
      )
      .run(partener_id, titlu, Number(valoare_estimata || 0), stadiu || "lead", data_estimata_inchidere || null, observatii || "", nr(atribuit_lui));
    redirect(ctx.res, `/crm/oportunitati/${info.lastInsertRowid}`);
  });

  router.get("/crm/oportunitati/:id", async (ctx) => {
    const o = await db
      .prepare(
        `SELECT o.*, p.nume AS partener_nume, p.email AS partener_email, u.nume AS agent_nume
         FROM oportunitati o JOIN parteneri p ON p.id = o.partener_id
         LEFT JOIN utilizatori u ON u.id = o.atribuit_lui WHERE o.id = ?`
      )
      .get(ctx.params.id);
    if (!o) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/crm", body: "<p>Oportunitate inexistentă.</p>" }));

    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const taskuriLegate = await db.prepare(`${taskuri.SELECT_TASK} WHERE t.oportunitate_id = ? ORDER BY t.id DESC`).all(o.id);
    const emailuri = await db
      .prepare("SELECT e.*, u.nume AS expeditor FROM emailuri e LEFT JOIN utilizatori u ON u.id = e.utilizator_id WHERE e.oportunitate_id = ? ORDER BY e.id DESC")
      .all(o.id);

    const body = `
      ${subnavCrm("/crm", ctx.user)}
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Partener</div><a href="/parteneri/${o.partener_id}">${esc(o.partener_nume)}</a></div>
          <div><div class="k">Valoare estimată</div>${money(o.valoare_estimata)}</div>
          <div><div class="k">Agent</div>${esc(o.agent_nume || "neatribuit")}</div>
          <div><div class="k">Dată estimată închidere</div>${esc(o.data_estimata_inchidere) || "—"}</div>
          <div><div class="k">Observații</div>${esc(o.observatii) || "—"}</div>
        </div>
      </div>

      <div class="toolbar">
        <a class="btn secondary" href="/taskuri/nou?oportunitate_id=${o.id}&partener_id=${o.partener_id}&titlu=${encodeURIComponent("Follow-up: " + o.titlu)}">+ Task</a>
        <a class="btn secondary" href="/crm/email/nou?partener_id=${o.partener_id}&oportunitate_id=${o.id}">✉ Trimite email</a>
      </div>

      <form method="post" action="/crm/oportunitati/${o.id}/stadiu" class="form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Stadiu</span>
            <select name="stadiu">${STADII.map((s) => `<option value="${s.key}" ${s.key === o.stadiu ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
          </label>
          <label class="field"><span>Agent responsabil</span>
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${o.atribuit_lui === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="form-actions"><button type="submit" class="btn small">Actualizează</button></div>
      </form>

      <h2>Task-uri legate</h2>
      ${taskuriLegate.length ? table(taskuri.CAPETE, taskuriLegate.map((t) => taskuri.randTask(t, azi()))) : '<p style="color:var(--text-muted)">Niciun task.</p>'}

      <h2>Emailuri trimise</h2>
      ${
        emailuri.length
          ? table(
              ["Data", "Către", "Subiect", "Expeditor", "Status"],
              emailuri.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                esc(e.catre),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                esc(e.expeditor || "—"),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email trimis din aplicație.</p>'
      }

      <div class="toolbar" style="margin-top:14px">
        <form method="post" action="/crm/oportunitati/${o.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv oportunitatea?')">
          <button type="submit" class="link-btn danger">Șterge oportunitatea</button>
        </form>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Oportunitate: ${o.titlu}`, active: "/crm", body }));
  });

  router.post("/crm/oportunitati/:id/stadiu", async (ctx) => {
    await db.prepare("UPDATE oportunitati SET stadiu = ?, atribuit_lui = ? WHERE id = ?").run(ctx.body.stadiu, nr(ctx.body.atribuit_lui), ctx.params.id);
    redirect(ctx.res, `/crm/oportunitati/${ctx.params.id}`);
  });

  router.post("/crm/oportunitati/:id/sterge", async (ctx) => {
    await db.prepare("DELETE FROM taskuri WHERE oportunitate_id = ?").run(ctx.params.id);
    await db.prepare("DELETE FROM oportunitati WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/crm");
  });


  // ================= BIROUL AGENTULUI =================================
  // Dashboardul personal al fiecărui agent: portofoliul lui de clienți,
  // pipeline-ul lui, calendarul de task-uri pe zile, remindere (întârziate),
  // zilele de naștere ale clienților și sugestii de clienți potențiali.
  // Adminul poate deschide biroul oricărui agent cu ?agent=ID.
  router.get("/crm/birou", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";
    let agentId = ctx.user.id;
    if (esteAdmin) {
      const a = parseInt(ctx.query.agent, 10);
      if (Number.isFinite(a) && a > 0) agentId = a;
    }
    const agent = await db.prepare("SELECT id, nume, comision_procent FROM utilizatori WHERE id = ?").get(agentId);
    if (!agent) return redirect(ctx.res, "/crm");
    const agenti = esteAdmin ? await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 AND rol = 'vanzari' ORDER BY nume").all() : [];

    // ---- Perioada aleasă ---------------------------------------------------
    // Agentul (și adminul) pot alege luna curentă — implicit —, luna trecută,
    // anul curent, anul trecut sau orice interval propriu de date.
    const aziISO = new Date().toISOString().slice(0, 10);
    const lunaCurentaStr = aziISO.slice(0, 7);
    const anCurentNr = Number(aziISO.slice(0, 4));
    const lunaPrecedentaStr = (() => {
      const d = new Date(lunaCurentaStr + "-01T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    const ultimaZiDin = (luna) => {
      const a = Number(luna.slice(0, 4));
      const m = Number(luna.slice(5, 7));
      return `${luna}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
    };
    const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    // Cheile presetarilor sunt cele din lib/perioada („luna_curenta"), dar
    // linkurile vechi cu „luna" trebuie sa mearga mai departe.
    let perioada = String(ctx.query.perioada || "luna");
    if (perioada === "luna_curenta") perioada = "luna";
    let de, la, etichetaPer;
    if (perioada === "luna_trecuta") {
      de = `${lunaPrecedentaStr}-01`; la = ultimaZiDin(lunaPrecedentaStr);
      etichetaPer = `luna trecută (${lunaPrecedentaStr})`;
    } else if (perioada === "an_curent") {
      de = `${anCurentNr}-01-01`; la = aziISO;
      etichetaPer = `anul ${anCurentNr} (1 ian → azi)`;
    } else if (perioada === "an_trecut") {
      de = `${anCurentNr - 1}-01-01`; la = `${anCurentNr - 1}-12-31`;
      etichetaPer = `anul ${anCurentNr - 1}`;
    } else if (perioada === "custom") {
      de = dataOk(ctx.query.de) ? String(ctx.query.de) : `${anCurentNr}-01-01`;
      la = dataOk(ctx.query.la) ? String(ctx.query.la) : aziISO;
      if (la < de) { const t = de; de = la; la = t; }
      etichetaPer = `${de} → ${la}`;
    } else if (/^\d{4}-\d{2}$/.test(perioada)) {
      de = `${perioada}-01`; la = ultimaZiDin(perioada); etichetaPer = perioada;
    } else {
      perioada = "luna"; de = `${lunaCurentaStr}-01`; la = ultimaZiDin(lunaCurentaStr);
      etichetaPer = `luna curentă (${lunaCurentaStr})`;
    }
    // Lunile acoperite de interval — costurile de personal sunt lunare.
    const luniPerioada = [];
    {
      let a = Number(de.slice(0, 4));
      let m = Number(de.slice(5, 7));
      while (`${a}-${String(m).padStart(2, "0")}` <= la.slice(0, 7) && luniPerioada.length < 240) {
        luniPerioada.push(`${a}-${String(m).padStart(2, "0")}`);
        m++; if (m > 12) { m = 1; a++; }
      }
    }
    const qsPer = `perioada=${encodeURIComponent(perioada)}${perioada === "custom" ? `&de=${de}&la=${la}` : ""}`;
    const linkBirou = (id) => `/crm/birou?${id ? `agent=${id}&` : ""}${qsPer}`;

    const SUB_TOTAL =
      "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
    const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)";

    // ---- Comisionul agentului ---------------------------------------------
    // Procent din încasările EFECTIVE ale clienților lui, în perioada aleasă,
    // pe tot grupul (Cash Machine + Warehouse All), fără facturile dintre firme.
    // Agentul vede doar linia lui; adminul poate comuta pe oricare agent.
    const incasariPerioada = await db
      .prepare(
        `SELECT al.utilizator_id AS agent, u.nume AS agent_nume, COALESCE(u.comision_procent,2) AS pct,
                COALESCE(SUM(pl.suma * al.procent / 100.0),0) AS incasat,
                COUNT(DISTINCT f.id) AS nr_facturi, COUNT(DISTINCT p.id) AS nr_clienti
         FROM (SELECT * FROM plati WHERE activ = 1) pl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         JOIN utilizatori u ON u.id = al.utilizator_id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND u.rol = 'vanzari' AND u.activ = 1
           AND pl.data BETWEEN ? AND ?
         GROUP BY al.utilizator_id, u.nume, u.comision_procent
         ORDER BY incasat DESC`
      )
      .all(de, la);

    const alMeu = incasariPerioada.find((r) => r.agent === agentId);
    const pctMeu = alMeu ? Number(alMeu.pct) : Number(agent.comision_procent ?? 2) || 2;
    const incasatMeu = alMeu ? Number(alMeu.incasat) : 0;
    const comisionMeu = (incasatMeu * pctMeu) / 100;

    // Evoluția pe ultimele 12 luni (independentă de perioada aleasă).
    const evolutie = await db
      .prepare(
        `SELECT SUBSTR(pl.data,1,7) AS luna, COALESCE(SUM(pl.suma * al.procent / 100.0),0) AS incasat
         FROM (SELECT * FROM plati WHERE activ = 1) pl JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id=pl.factura_id JOIN parteneri p ON p.id=f.partener_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0 AND al.utilizator_id = ?
         GROUP BY SUBSTR(pl.data,1,7) ORDER BY luna DESC LIMIT 12`
      )
      .all(agentId);
    const evolutieOrd = evolutie.slice().reverse();
    const maxEvo = Math.max(1, ...evolutieOrd.map((e) => Number(e.incasat)));
    const liniiEchipa = incasariPerioada.map((r) => ({ ...r, incasat: Number(r.incasat), comision: (Number(r.incasat) * Number(r.pct)) / 100 }));
    const maxEchipa = Math.max(1, ...liniiEchipa.map((l) => l.incasat));
    const totalEchipa = liniiEchipa.reduce((s, l) => s + l.comision, 0);

    // ---- Clienții alocați, cu ce au fost facturați și ce au plătit ---------
    const incasatPeClient = await db
      .prepare(
        `SELECT p.id, p.nume, COALESCE(SUM(pl.suma * al.procent / 100.0),0) AS incasat,
                MAX(al.procent) AS procent_alocat,
                COUNT(DISTINCT f.id) AS nr_facturi, MAX(pl.data) AS ultima_incasare
         FROM (SELECT * FROM plati WHERE activ = 1) pl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND al.utilizator_id = ? AND pl.data BETWEEN ? AND ?
         GROUP BY p.id, p.nume`
      )
      .all(agentId, de, la);

    const facturatPeClient = await db
      .prepare(
        `SELECT p.id, p.nume, COALESCE(SUM(l.total),0) AS facturat, COUNT(DISTINCT f.id) AS nr_emise
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND al.utilizator_id = ? AND f.data_emiterii BETWEEN ? AND ?
         GROUP BY p.id, p.nume`
      )
      .all(agentId, de, la);

    // Soldul restant al clienților lui, la zi (nu depinde de perioadă).
    const soldPeClient = await db
      .prepare(
        `SELECT p.id, COALESCE(SUM(COALESCE(l.total,0) - COALESCE(pl.platit,0)),0) AS sold
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND al.utilizator_id = ?
         GROUP BY p.id`
      )
      .all(agentId);
    const soldMap = new Map(soldPeClient.map((r) => [r.id, Number(r.sold)]));

    const clientiPerioada = (() => {
      const m = new Map();
      for (const r of facturatPeClient)
        m.set(r.id, { id: r.id, nume: r.nume, facturat: Number(r.facturat), nr_emise: Number(r.nr_emise), incasat: 0, nr_facturi: 0, ultima_incasare: null });
      for (const r of incasatPeClient) {
        const g = m.get(r.id) || { id: r.id, nume: r.nume, facturat: 0, nr_emise: 0, incasat: 0, nr_facturi: 0, ultima_incasare: null };
        g.incasat = Number(r.incasat);
        g.procent = Number(r.procent_alocat ?? 100);
        g.nr_facturi = Number(r.nr_facturi);
        g.ultima_incasare = r.ultima_incasare;
        m.set(r.id, g);
      }
      return [...m.values()]
        .map((g) => ({ ...g, comision: (g.incasat * pctMeu) / 100, sold: soldMap.get(g.id) || 0 }))
        .sort((a, b) => b.incasat - a.incasat || b.facturat - a.facturat);
    })();

    // Facturile efectiv încasate în perioadă — baza de calcul, linie cu linie.
    const facturiIncasate = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.data_emiterii, p.nume AS client,
                COALESCE(SUM(pl.suma * al.procent / 100.0),0) AS incasat, MAX(pl.data) AS data_incasare
         FROM (SELECT * FROM plati WHERE activ = 1) pl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = pl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND al.utilizator_id = ? AND pl.data BETWEEN ? AND ?
         GROUP BY f.id, f.serie, f.numar, f.data_emiterii, p.nume
         ORDER BY data_incasare DESC, incasat DESC
         LIMIT 400`
      )
      .all(agentId, de, la);

    // ---- Marjă, top produse, top clienți -----------------------------------
    // Marja se poate calcula doar acolo unde linia de factură are produs
    // identificat ȘI produsul are preț de achiziție. Facturile importate din
    // SmartBill n-au detaliu pe produse, deci acoperirea e parțială — o
    // spunem explicit, ca cifra să nu fie citită greșit.
    const SUM_VENIT = "SUM(fl.cantitate * fl.pret_unitar)";
    const SUM_COST = `SUM(${COST_LINIE})`;

    const marjaFacturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.data_emiterii, p.nume AS client,
                ${SUM_VENIT} AS venit, ${SUM_COST} AS cost,
                SUM(CASE WHEN pr.id IS NULL OR COALESCE(pr.pret_achizitie,0) = 0 OR fl.cantitate * COALESCE(pr.pret_achizitie, 0) > 5 * (fl.cantitate * fl.pret_unitar) + 100 THEN 1 ELSE 0 END) AS linii_fara_cost,
                COUNT(fl.id) AS linii
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         JOIN facturi_linii fl ON fl.factura_id = f.id
         LEFT JOIN produse pr ON pr.id = fl.produs_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND al.utilizator_id = ? AND f.data_emiterii BETWEEN ? AND ?
         GROUP BY f.id, f.serie, f.numar, f.data_emiterii, p.nume
         ORDER BY venit DESC
         LIMIT 300`
      )
      .all(agentId, de, la);

    const topProdusePerioada = await db
      .prepare(
        `SELECT pr.id, pr.denumire, SUM(fl.cantitate) AS cantitate,
                ${SUM_VENIT} AS venit, ${SUM_COST} AS cost
         FROM facturi_linii fl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
         JOIN produse pr ON pr.id = fl.produs_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND al.utilizator_id = ? AND f.data_emiterii BETWEEN ? AND ?
         GROUP BY pr.id, pr.denumire
         ORDER BY venit DESC
         LIMIT 15`
      )
      .all(agentId, de, la);

    // Marja pe agenți — pentru admin, comparativ; pentru agent, doar linia lui.
    const marjaPeAgenti = await db
      .prepare(
        `SELECT al.utilizator_id AS agent, u.nume AS agent_nume,
                ${SUM_VENIT} AS venit, ${SUM_COST} AS cost
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN facturi_linii fl ON fl.factura_id = f.id
         LEFT JOIN produse pr ON pr.id = fl.produs_id
         JOIN ${ALOC_FACTURA} al ON al.factura_id = f.id
         JOIN utilizatori u ON u.id = al.utilizator_id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND f.data_emiterii BETWEEN ? AND ?
         GROUP BY al.utilizator_id, u.nume
         ORDER BY venit DESC`
      )
      .all(de, la);

    // Vânzările totale ale firmei în perioadă — baza pentru „% din total".
    const vanzariTotale = await db
      .prepare(
        `SELECT COALESCE(SUM(fl.cantitate * fl.pret_unitar), 0) AS venit
         FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN facturi_linii fl ON fl.factura_id = f.id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND f.data_emiterii BETWEEN ? AND ?`
      )
      .get(de, la);
    const totalFirma = Number(vanzariTotale && vanzariTotale.venit) || 0;

    const widgetComision = `
      <section class="comision-box">
        <div class="comision-head">
          <h2 style="margin:0">Comision — ${esc(agent.nume)}</h2>
          <form method="get" action="/crm/birou" class="comision-filtru perioade">
            ${esteAdmin ? `<input type="hidden" name="agent" value="${agentId}">` : ""}
            ${chipuriPerioada(perioada === "luna" ? "luna_curenta" : perioada, { faraTot: true })}
            <span class="perioade-custom">
              <input type="date" name="de" value="${esc(de)}">
              <span class="perioade-sageata">→</span>
              <input type="date" name="la" value="${esc(la)}">
              <button class="chip${perioada === "custom" ? " activ" : ""}" type="submit" name="perioada" value="custom">Aplică</button>
            </span>
          </form>
        </div>
        <div class="comision-grid">
          <div class="comision-mare">
            <div class="label">De încasat ca și comision</div>
            <div class="suma">${money(comisionMeu)}</div>
            <div class="sub">${pctMeu.toFixed(1)}% din ${money(incasatMeu)} încasați în ${esc(etichetaPer)}${alMeu ? ` · ${alMeu.nr_facturi} facturi · ${alMeu.nr_clienti} clienți` : ""}</div>
          </div>
          <div class="comision-evolutie">
            <div class="label">Încasările mele, ultimele 12 luni</div>
            <div class="mini-chart">
              ${
                evolutieOrd.length
                  ? evolutieOrd
                      .map(
                        (e) => `<div class="mini-bar" title="${esc(e.luna)}: ${money(e.incasat)}">
                          <div class="mini-fill" style="height:${Math.max(4, (Number(e.incasat) / maxEvo) * 100)}%"></div>
                          <div class="mini-eticheta">${esc(e.luna.slice(5))}</div>
                        </div>`
                      )
                      .join("")
                  : '<span style="color:rgba(255,255,255,.75);font-size:12px">încă fără încasări înregistrate</span>'
              }
            </div>
          </div>
        </div>
        ${
          esteAdmin && liniiEchipa.length
            ? `<h3 style="font-size:14px;margin:18px 0 8px">Agenții de vânzări în ${esc(etichetaPer)} — total de plată ${money(totalEchipa)}</h3>
               <div class="comision-agenti">
                 ${liniiEchipa
                   .map(
                     (l) => `<div class="agent-rand">
                       <div class="agent-nume"><a href="${linkBirou(l.agent)}" style="color:#fff">${esc(l.agent_nume)}</a></div>
                       <div class="agent-bara"><div class="agent-fill" style="width:${(l.incasat / maxEchipa) * 100}%"></div></div>
                       <div class="agent-cifre"><strong>${money(l.comision)}</strong><span>din ${money(l.incasat)} · ${Number(l.pct).toFixed(1)}%</span></div>
                     </div>`
                   )
                   .join("")}
               </div>`
            : ""
        }
        <p style="font-size:12px;color:rgba(255,255,255,.8);margin-top:10px">
          Se numără banii <strong>efectiv încasați</strong> în perioada aleasă, de la clienții alocați, pe tot grupul.
          Comisionul se plătește la încasare, nu la facturare.
        </p>
      </section>
    `;

    // ---- Clienții asociați + facturile încasate ---------------------------
    const totIncasatCli = clientiPerioada.reduce((s, c) => s + c.incasat, 0);
    const totFacturatCli = clientiPerioada.reduce((s, c) => s + c.facturat, 0);
    const blocClienti = `
      <h2>Clienții mei în ${esc(etichetaPer)}</h2>
      ${
        clientiPerioada.length
          ? table(
              ["Client", "Alocat", "Facturi emise", "Facturat", "Încasat (partea mea)", `Comision ${pctMeu.toFixed(1)}%`, "Ultima încasare", "Sold restant (la zi)"],
              clientiPerioada.map((c) => [
                `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                `${Number(c.procent ?? 100).toFixed(0)}%`,
                String(c.nr_emise || 0),
                money(c.facturat),
                `<strong>${money(c.incasat)}</strong>`,
                money(c.comision),
                c.ultima_incasare ? esc(String(c.ultima_incasare).slice(0, 10)) : "—",
                c.sold > 0.5 ? `<span style="color:var(--danger)">${money(c.sold)}</span>` : "—",
              ]),
              { total: ["TOTAL", "", "", money(totFacturatCli), money(totIncasatCli), money((totIncasatCli * pctMeu) / 100), "", ""] }
            )
          : `<p style="color:var(--text-muted)">Niciun client alocat cu activitate în ${esc(etichetaPer)}.</p>`
      }
      <h2>Facturi încasate în ${esc(etichetaPer)} <span style="font-size:13px;font-weight:400;color:var(--text-muted)">— baza de calcul a comisionului</span></h2>
      ${
        facturiIncasate.length
          ? table(
              ["Factura", "Client", "Emisă", "Încasată la", "Sumă încasată", `Comision ${pctMeu.toFixed(1)}%`],
              facturiIncasate.map((f) => [
                `<a href="/facturi/${f.id}">${esc([f.serie, f.numar].filter(Boolean).join(" "))}</a>`,
                esc(f.client),
                f.data_emiterii ? esc(String(f.data_emiterii).slice(0, 10)) : "—",
                f.data_incasare ? esc(String(f.data_incasare).slice(0, 10)) : "—",
                money(f.incasat),
                money((Number(f.incasat) * pctMeu) / 100),
              ])
            )
          : `<p style="color:var(--text-muted)">Nicio încasare în ${esc(etichetaPer)}.</p>`
      }
    `;
    // ---- Costul agentului --------------------------------------------------
    // Costul nu are meniu propriu: stă aici, lângă comisionul lui, pentru că
    // asta e întrebarea reală — cât aduce omul față de cât costă.
    //
    // Agentul îl VEDE (ca să înțeleagă cum s-a calculat comisionul și ce
    // costă el firma), dar nu-l poate modifica: cifrele vin din statul de
    // plată lunar, din factura mașinii și din alimentările OMV pe cardul lui.
    // Doar administratorul are butoanele de editare.
    let blocCost = "";
    {
      const costuri = require("./costuri");
      // Costurile sunt lunare: le însumăm pe toate lunile din perioada aleasă.
      const sume = { brut: 0, cas: 0, cass: 0, impozit: 0, net: 0, cam: 0, masina: 0, carburant: 0, alte: 0, salarial: 0, total: 0 };
      let c = null;
      let luniCuCost = 0;
      for (const lu of luniPerioada) {
        const cl = await costuri.costPentruLuna(agentId, lu);
        if (!cl) continue;
        c = cl;
        luniCuCost++;
        const s = costuri.totalCost(cl);
        for (const k of Object.keys(sume)) sume[k] += s[k] || 0;
      }
      const marja = incasatMeu - sume.total - comisionMeu;
      blocCost = `
        <div class="detail-box">
          <h2 style="margin-top:0">Cost company — ${esc(agent.nume)}, ${esc(etichetaPer)}</h2>
          ${luniCuCost > 1 ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">Cumulat pe ${luniCuCost} luni.</p>` : ""}
          ${
            sume.total > 0
              ? `<div class="detail-grid">
                   <div><div class="k">Salariu brut</div>${money(sume.brut)}</div>
                   <div><div class="k">Net (în mână)</div>${money(sume.net)}</div>
                   <div><div class="k">CAS + CASS + impozit</div>${money(sume.cas + sume.cass + sume.impozit)}</div>
                   <div><div class="k">CAM (angajator)</div>${money(sume.cam)}</div>
                   <div><div class="k">Mașină</div>${money(sume.masina)}${c && c.masina_detalii ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(c.masina_detalii)}</span>` : ""}</div>
                   <div><div class="k">Carburant</div>${money(sume.carburant)}</div>
                   <div><div class="k">Alte</div>${money(sume.alte)}</div>
                   <div><div class="k">COST TOTAL</div><strong>${money(sume.total)}</strong></div>
                 </div>
                 ${esteAdmin ? `<div class="detail-grid" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
                   <div><div class="k">Încasări aduse</div>${money(incasatMeu)}</div>
                   <div><div class="k">Comision</div>−${money(comisionMeu)}</div>
                   <div><div class="k">Cost</div>−${money(sume.total)}</div>
                   <div><div class="k">Rămâne</div><strong style="color:${marja >= 0 ? "var(--success)" : "var(--danger)"}">${money(marja)}</strong></div>
                 </div>
                 <p style="font-size:12px;color:var(--text-muted);margin-top:10px">
                   „Rămâne" e brut: nu scade costul mărfii vândute, deci nu e profit — e cât rămâne din încasările lui după ce plătești omul.
                 </p>` : ""}`
              : `<p style="color:var(--text-muted)">Costul nu e definit încă pentru ${esc(agent.nume)} în ${esc(etichetaPer)}.</p>`
          }
          <p style="font-size:12px;color:var(--text-muted);margin-top:10px">
            Cifrele nu se introduc de mână: salariul brut vine din statul de plată lunar,
            mașina din factura de leasing, iar carburantul din alimentările OMV pe cardul tău.
          </p>
          ${
            esteAdmin
              ? `<div class="toolbar" style="margin-top:12px">
                   <a class="btn secondary" href="/costuri/nou?utilizator_id=${agentId}">${sume.total > 0 ? "Corectează manual" : "Setează manual"}</a>
                 </div>`
              : ""
          }
        </div>
      `;
    }

    const aziStr = azi();
    const acum12Luni = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

    // Portofoliul: clienții alocați agentului, cu vânzări pe 12 luni și sold.
    const clienti = await db
      .prepare(
        `SELECT p.id, p.nume, p.email, p.telefon, p.data_nastere,
                COALESCE(SUM(CASE WHEN f.data_emiterii >= ? THEN l.total ELSE 0 END), 0) AS vanzari12,
                COALESCE(SUM(COALESCE(l.total,0) - COALESCE(pl.platit,0)), 0) AS sold,
                MAX(f.data_emiterii) AS ultima
         FROM parteneri p
         LEFT JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
         WHERE p.id IN (SELECT f2.partener_id FROM (SELECT * FROM facturi WHERE activ = 1) f2 JOIN ${ALOC_FACTURA} al2 ON al2.factura_id = f2.id WHERE al2.utilizator_id = ?) AND p.tip IN ('client','ambele')
         GROUP BY p.id, p.nume, p.email, p.telefon, p.data_nastere
         ORDER BY vanzari12 DESC`
      )
      .all(acum12Luni, agentId);

    // Pipeline-ul agentului, pe stadii.
    const pipeline = await db
      .prepare(
        `SELECT o.stadiu, COUNT(*) AS nr, COALESCE(SUM(o.valoare_estimata),0) AS valoare
         FROM oportunitati o LEFT JOIN parteneri p ON p.id = o.partener_id
         WHERE o.atribuit_lui = ? OR p.agent_id = ?
         GROUP BY o.stadiu`
      )
      .all(agentId, agentId);
    const pipelineDeschis = pipeline
      .filter((r) => !["castigat", "pierdut"].includes(r.stadiu))
      .reduce((s, r) => s + Number(r.valoare), 0);

    // Calendarul: task-urile pe următoarele 14 zile + cele întârziate.
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const taskuriAgent = await db
      .prepare(
        `${taskuri.SELECT_TASK} WHERE t.atribuit_lui = ? AND t.status IN ('${taskuri.DESCHISE.join("','")}')
         ORDER BY (t.scadenta IS NULL), t.scadenta ASC LIMIT 200`
      )
      .all(agentId);
    const intarziate = taskuriAgent.filter((t) => t.scadenta && t.scadenta < aziStr);
    const peZile = new Map();
    for (const t of taskuriAgent) {
      if (!t.scadenta || t.scadenta < aziStr || t.scadenta > in14) continue;
      if (!peZile.has(t.scadenta)) peZile.set(t.scadenta, []);
      peZile.get(t.scadenta).push(t);
    }
    const faraScadenta = taskuriAgent.filter((t) => !t.scadenta);

    // Zile de naștere: clienții agentului cu ziua în următoarele 30 de zile
    // (comparăm doar luna-ziua, anul nu contează).
    const zileNastere = [];
    for (const c of clienti) {
      if (!c.data_nastere) continue;
      const mz = String(c.data_nastere).slice(5, 10);
      if (!/^\d{2}-\d{2}$/.test(mz)) continue;
      const anCurent = Number(aziStr.slice(0, 4));
      let urmatoarea = `${anCurent}-${mz}`;
      if (urmatoarea < aziStr) urmatoarea = `${anCurent + 1}-${mz}`;
      const inZile = Math.round((Date.parse(urmatoarea) - Date.parse(aziStr)) / 86400000);
      if (inZile <= 30) zileNastere.push({ ...c, urmatoarea, inZile });
    }
    zileNastere.sort((a, b) => a.inZile - b.inZile);

    // Clienții LUI care n-au mai cumpărat de peste 90 de zile — reactivare.
    // Sugestiile de clienți NOI stau sus, în blocul revendicabil din
    // modules/contacte.js: acolo agentul îi poate lua, nu doar citi.
    const acum90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const deReactivat = clienti.filter((c) => c.ultima && c.ultima.slice(0, 10) < acum90 && Number(c.vanzari12) > 0).slice(0, 10);

    // Top produse vândute în portofoliul agentului (doar liniile cu produs
    // identificat — facturile importate din SmartBill n-au detaliu pe produse).
    const topProduse = await db
      .prepare(
        `SELECT pr.id, pr.denumire, SUM(fl.cantitate) AS cantitate, SUM(fl.cantitate * fl.pret_unitar) AS venit
         FROM facturi_linii fl
         JOIN (SELECT * FROM facturi WHERE activ = 1) f ON f.id = fl.factura_id
         JOIN parteneri p ON p.id = f.partener_id
         JOIN produse pr ON pr.id = fl.produs_id
         WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','ciorna') AND f.intercompany = 0 AND f.data_emiterii >= ? AND p.agent_id = ?
         GROUP BY pr.id, pr.denumire ORDER BY venit DESC LIMIT 8`
      )
      .all(acum12Luni, agentId);

    const vanzari12Total = clienti.reduce((s, c) => s + Number(c.vanzari12), 0);
    const soldTotal = clienti.reduce((s, c) => s + Math.max(0, Number(c.sold)), 0);

    // ---- Blocurile de marjă și topuri --------------------------------------
    // Totalurile se iau din agregatul pe agent, NU din lista de facturi:
    // lista e limitată la primele 300 după valoare, iar facturile storno
    // (negative) ar rămâne pe dinafară — totalul ar ieși mai mare decât
    // realitatea. (Bug prins la testare pe datele reale.)
    const randMeu = marjaPeAgenti.find((r) => r.agent === agentId);
    const venitMeu = randMeu ? Number(randMeu.venit) : 0;
    const costMeu = randMeu ? Number(randMeu.cost) : 0;
    const marjaMea = venitMeu - costMeu;
    const acoperire = (() => {
      const linii = marjaFacturi.reduce((s2, f) => s2 + Number(f.linii), 0);
      const fara = marjaFacturi.reduce((s2, f) => s2 + Number(f.linii_fara_cost), 0);
      return linii ? Math.round(((linii - fara) / linii) * 100) : 0;
    })();
    const pct = (x, total) => (total > 0 ? `${((x / total) * 100).toFixed(1)}%` : "—");

    const topProduseTotal = topProdusePerioada.reduce((s2, r) => s2 + Number(r.venit), 0);
    const topClienti = clientiPerioada.slice().sort((a, b) => b.facturat - a.facturat).slice(0, 15);
    const facturatTotalCli = clientiPerioada.reduce((s2, c) => s2 + c.facturat, 0);

    const blocMarja = `
      <h2>Marja mea în ${esc(etichetaPer)}</h2>
      <div class="cards">
        <div class="card"><div class="label">Vânzări (fără TVA)</div><div class="value">${money(venitMeu)}</div></div>
        <div class="card"><div class="label">Cost marfă</div><div class="value">${money(costMeu)}</div></div>
        <div class="card"><div class="label">Marjă netă</div><div class="value" style="color:${marjaMea >= 0 ? "var(--success)" : "var(--danger)"}">${money(marjaMea)}</div></div>
        <div class="card"><div class="label">Marjă %</div><div class="value">${venitMeu > 0 ? ((marjaMea / venitMeu) * 100).toFixed(1) + "%" : "—"}</div></div>
        <div class="card"><div class="label">Din vânzările firmei</div><div class="value">${pct(venitMeu, totalFirma)}</div></div>
      </div>
      ${
        acoperire < 100
          ? `<p style="font-size:12px;color:var(--warn);margin-top:-6px">
               Marja e calculată pe ${acoperire}% din liniile de factură — restul n-au produs identificat sau preț de achiziție.
               Cifra e o estimare în minus a costului, deci marja reală e mai mică sau egală cu cea de mai sus.
             </p>`
          : ""
      }
      ${
        esteAdmin && marjaPeAgenti.length
          ? `<h3 style="font-size:14px;margin:16px 0 8px">Toți agenții în ${esc(etichetaPer)}</h3>
             ${table(
               ["Agent", "Vânzări", "Cost marfă", "Marjă netă", "Marjă %", "% din vânzările firmei"],
               marjaPeAgenti.map((r) => {
                 const v = Number(r.venit), c = Number(r.cost), m = v - c;
                 return [
                   `<a href="${linkBirou(r.agent)}">${esc(r.agent_nume)}</a>`,
                   money(v),
                   money(c),
                   `<strong style="color:${m >= 0 ? "var(--success)" : "var(--danger)"}">${money(m)}</strong>`,
                   v > 0 ? ((m / v) * 100).toFixed(1) + "%" : "—",
                   pct(v, totalFirma),
                 ];
               }),
               {
                 total: [
                   "TOTAL",
                   money(marjaPeAgenti.reduce((s2, r) => s2 + Number(r.venit), 0)),
                   money(marjaPeAgenti.reduce((s2, r) => s2 + Number(r.cost), 0)),
                   money(marjaPeAgenti.reduce((s2, r) => s2 + Number(r.venit) - Number(r.cost), 0)),
                   "",
                   "100%",
                 ],
               }
             )}`
          : ""
      }

      <h2>Top clienți în ${esc(etichetaPer)}</h2>
      ${
        topClienti.length
          ? table(
              ["#", "Client", "Facturat", "% din vânzările mele", "Încasat", "Sold restant"],
              topClienti.map((c, i) => [
                String(i + 1),
                `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                money(c.facturat),
                pct(c.facturat, facturatTotalCli),
                money(c.incasat),
                c.sold > 0.5 ? `<span style="color:var(--danger)">${money(c.sold)}</span>` : "—",
              ])
            )
          : `<p style="color:var(--text-muted)">Fără vânzări în ${esc(etichetaPer)}.</p>`
      }

      <h2>Top produse vândute în ${esc(etichetaPer)}</h2>
      ${
        topProdusePerioada.length
          ? table(
              ["#", "Produs", "Cantitate", "Vânzări", "% din total", "Cost", "Marjă", "Marjă %"],
              topProdusePerioada.map((r, i) => {
                const v = Number(r.venit), c = Number(r.cost), m = v - c;
                return [
                  String(i + 1),
                  `<a href="/produse/${r.id}">${esc(r.denumire)}</a>`,
                  Number(r.cantitate).toLocaleString("ro-RO"),
                  money(v),
                  pct(v, topProduseTotal),
                  money(c),
                  `<strong style="color:${m >= 0 ? "var(--success)" : "var(--danger)"}">${money(m)}</strong>`,
                  v > 0 ? ((m / v) * 100).toFixed(1) + "%" : "—",
                ];
              })
            )
          : `<p style="color:var(--text-muted)">Facturile din perioada asta n-au produse identificate — de-aia nu pot arăta topul. Se rezolvă pe măsură ce facturile se emit din ERP sau se importă cu detaliu pe produse.</p>`
      }

      <h2>Marja pe fiecare vânzare <span style="font-size:13px;font-weight:400;color:var(--text-muted)">— primele 100 după valoare</span></h2>
      ${
        marjaFacturi.length
          ? table(
              ["Factura", "Client", "Data", "Vânzare", "Cost", "Marjă", "Marjă %"],
              marjaFacturi.slice(0, 100).map((f) => {
                const v = Number(f.venit), c = Number(f.cost), m = v - c;
                return [
                  `<a href="/facturi/${f.id}">${esc([f.serie, f.numar].filter(Boolean).join(" "))}</a>`,
                  esc(f.client),
                  f.data_emiterii ? esc(String(f.data_emiterii).slice(0, 10)) : "—",
                  money(v),
                  Number(f.linii_fara_cost) === Number(f.linii) ? `<span style="color:var(--text-muted)">necunoscut</span>` : money(c),
                  Number(f.linii_fara_cost) === Number(f.linii) ? "—" : `<strong style="color:${m >= 0 ? "var(--success)" : "var(--danger)"}">${money(m)}</strong>`,
                  Number(f.linii_fara_cost) === Number(f.linii) || v <= 0 ? "—" : ((m / v) * 100).toFixed(1) + "%",
                ];
              }),
              {
                total: (() => {
                  const afisate = marjaFacturi.slice(0, 100);
                  const v = afisate.reduce((s2, f) => s2 + Number(f.venit), 0);
                  const c = afisate.reduce((s2, f) => s2 + Number(f.cost), 0);
                  return ["TOTAL afișat", "", "", money(v), money(c), money(v - c), v > 0 ? (((v - c) / v) * 100).toFixed(1) + "%" : "—"];
                })(),
              }
            )
          : `<p style="color:var(--text-muted)">Nicio vânzare în ${esc(etichetaPer)}.</p>`
      }
    `;

    // Task-urile de contact se generează la deschiderea biroului: agentul
    // găsește pe masă pe cine n-a mai sunat, fără să ceară nimeni nimic.
    const contacte = require("./contacte");
    let blocContact = "", blocSug = "";
    try {
      await contacte.genereazaTaskuriContact(agentId);
      await contacte.genereazaSugestii();
      blocContact = await contacte.blocTaskuriContact(ctx.user, agentId);
      blocSug = await contacte.blocSugestii(ctx.user);
    } catch (e) {
      blocContact = `<p style="color:var(--danger)">Nu s-au putut genera task-urile de contact: ${esc(e.message)}</p>`;
    }

    // Scadențele stau sus, lângă comision: banii neîncasați sunt treaba
    // agentului, nu doar a contabilității.
    let blocSold = "";
    try {
      blocSold = await require("./scadente").blocScadente(ctx.user, agentId);
    } catch (e) {
      blocSold = `<p style="color:var(--danger)">Nu s-au putut calcula scadențele: ${esc(e.message)}</p>`;
    }

    const body = `
      ${subnavCrm("/crm/birou", ctx.user)}
      ${widgetComision}
      ${blocSold}
      ${blocContact}
      ${blocSug}
      ${blocCost}
      ${blocMarja}
      ${blocClienti}
      ${
        esteAdmin && agenti.length
          ? `<form method="get" action="/crm/birou" class="filtre">
              <input type="hidden" name="perioada" value="${esc(perioada)}">
              ${perioada === "custom" ? `<input type="hidden" name="de" value="${esc(de)}"><input type="hidden" name="la" value="${esc(la)}">` : ""}
              <span style="font-size:13px">Biroul lui:</span>
              <select name="agent" onchange="this.form.submit()">
                ${agenti.map((a) => `<option value="${a.id}"${a.id === agentId ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
              </select>
            </form>`
          : ""
      }
      <div class="cards">
        <div class="card"><div class="label">Clienți în portofoliu</div><div class="value">${clienti.length}</div></div>
        <div class="card"><div class="label">Vânzări portofoliu (12 luni)</div><div class="value">${money(vanzari12Total)}</div></div>
        <div class="card"><div class="label">De încasat din portofoliu</div><div class="value">${money(soldTotal)}</div></div>
        <div class="card"><div class="label">Pipeline deschis</div><div class="value">${money(pipelineDeschis)}</div></div>
        <div class="card"><div class="label">Task-uri întârziate</div><div class="value" style="color:${intarziate.length ? "var(--danger)" : "inherit"}">${intarziate.length}</div></div>
      </div>

      ${
        intarziate.length
          ? `<h2 style="color:var(--danger)">Remindere — task-uri întârziate</h2>${table(taskuri.CAPETE, intarziate.map((t) => taskuri.randTask(t, aziStr)))}`
          : ""
      }

      ${
        zileNastere.length
          ? `<h2>🎂 Zile de naștere (următoarele 30 de zile)</h2>
             ${table(
               ["Client", "Ziua", "Când", "Acțiune"],
               zileNastere.map((c) => [
                 `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                 esc(c.urmatoarea),
                 c.inZile === 0 ? '<span class="badge verde">AZI</span>' : `în ${c.inZile} zile`,
                 c.email
                   ? `<a class="link-btn" href="/crm/email/nou?partener_id=${c.id}&sablon=zi_nastere">Trimite urarea</a>`
                   : '<span style="color:var(--text-muted)">fără email salvat</span>',
               ])
             )}`
          : ""
      }

      <h2>Calendarul următoarelor 14 zile</h2>
      ${
        peZile.size
          ? [...peZile.entries()]
              .map(
                ([zi, lista]) => `
            <div class="zi-bloc">
              <div class="zi-antet"><div class="zi-data">${esc(zi)}${zi === aziStr ? ' <span class="badge galben">azi</span>' : ""}</div><div class="zi-suma">${lista.length} task-uri</div></div>
              ${table(taskuri.CAPETE, lista.map((t) => taskuri.randTask(t, aziStr)))}
            </div>`
              )
              .join("")
          : '<p style="color:var(--text-muted)">Nimic programat în următoarele 14 zile. <a href="/taskuri/nou">Adaugă un task</a>.</p>'
      }
      ${faraScadenta.length ? `<h2>Task-uri fără termen (${faraScadenta.length})</h2>${table(taskuri.CAPETE, faraScadenta.slice(0, 20).map((t) => taskuri.randTask(t, aziStr)))}` : ""}

      ${
        topProduse.length
          ? `<h2>Top produse în portofoliul lui (12 luni)</h2>${table(
              ["Produs", "Cantitate", "Venit net"],
              topProduse.map((tp) => [`<a href="/produse/${tp.id}">${esc(tp.denumire)}</a>`, Number(tp.cantitate).toLocaleString("ro-RO"), money(tp.venit)])
            )}`
          : ""
      }

      <h2>Sugestii — clienți de reactivat (n-au mai cumpărat de peste 90 de zile)</h2>
      ${
        deReactivat.length
          ? table(
              ["Client", "Ultima factură", "Vânzări 12 luni", "Acțiune"],
              deReactivat.map((c) => [
                `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
                `<span class="badge galben">${esc((c.ultima || "").slice(0, 10))}</span>`,
                money(c.vanzari12),
                `<a class="link-btn" href="/taskuri/nou?partener_id=${c.id}&tip=apel&titlu=${encodeURIComponent("Reactivare " + c.nume)}&scadenta=${aziStr}">+ Task de contact</a>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Tot portofoliul e activ — nimeni de reactivat.</p>'
      }

      <h2>Portofoliul complet (${clienti.length} clienți)</h2>
      ${table(
        ["Client", "Vânzări 12 luni", "Sold de încasat", "Ultima factură", "Contact"],
        clienti
          .slice(0, 100)
          .map((c) => [
            `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
            money(c.vanzari12),
            money(Math.max(0, c.sold)),
            esc((c.ultima || "").slice(0, 10)) || "—",
            [c.email && `<a class="link-btn" href="/crm/email/nou?partener_id=${c.id}">email</a>`, c.telefon && esc(c.telefon)].filter(Boolean).join(" · ") || "—",
          ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Biroul lui ${agent.nume}`, active: "/crm", body }));
  });

  // ================= LEAD-URI =========================================
  router.get("/crm/leaduri", async (ctx) => {
    const stadiu = String(ctx.query.stadiu || "");
    const cauta = String(ctx.query.q || "").trim();
    const where = [];
    const args = [];
    if (stadiu) {
      where.push("l.stadiu = ?");
      args.push(stadiu);
    }
    if (cauta) {
      where.push("(l.nume ILIKE ? OR l.companie ILIKE ? OR l.email ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    const clauza = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const leaduri = await db
      .prepare(
        `SELECT l.*, u.nume AS agent_nume FROM leaduri l LEFT JOIN utilizatori u ON u.id = l.atribuit_lui
         ${clauza} ORDER BY l.id DESC LIMIT 300`
      )
      .all(...args);
    const peStadiu = await db.prepare("SELECT stadiu, COUNT(*) AS n FROM leaduri GROUP BY stadiu").all();
    const contor = Object.fromEntries(peStadiu.map((r) => [r.stadiu, r.n]));

    const body = `
      ${subnavCrm("/crm/leaduri", ctx.user)}
      <div class="toolbar"><a href="/crm/leaduri/nou" class="btn">+ Lead nou</a></div>
      <div class="cards">
        ${STADII_LEAD.map(([v, t]) => `<div class="card"><div class="label">${esc(t)}</div><div class="value">${contor[v] || 0}</div></div>`).join("")}
      </div>
      <form class="filtre" method="get" action="/crm/leaduri">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după nume, companie sau email…">
        <select name="stadiu" onchange="this.form.submit()">
          <option value="">Toate stadiile</option>
          ${STADII_LEAD.map(([v, t]) => `<option value="${v}"${stadiu === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <button class="btn small" type="submit">Filtrează</button>
      </form>
      ${
        leaduri.length
          ? table(
              ["Nume", "Companie", "Contact", "Sursă", "Agent", "Stadiu"],
              leaduri.map((l) => [
                `<a href="/crm/leaduri/${l.id}"><strong>${esc(l.nume)}</strong></a>`,
                esc(l.companie || "—"),
                [l.email ? esc(l.email) : "", l.telefon ? esc(l.telefon) : ""].filter(Boolean).join("<br>") || "—",
                esc(l.sursa || "—"),
                esc(l.agent_nume || "neatribuit"),
                badgeLead(l.stadiu),
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun lead încă. <a href="/crm/leaduri/nou">Adaugă primul</a>.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Lead-uri", active: "/crm", body }));
  });

  router.get("/crm/leaduri/nou", async (ctx) => {
    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const body = `
      ${subnavCrm("/crm/leaduri", ctx.user)}
      <form class="form" method="post" action="/crm/leaduri">
        <label class="field">Nume persoană <input name="nume" required placeholder="Ex: Ion Popescu"></label>
        <label class="field">Companie <input name="companie" placeholder="Ex: Alpha Logistics SRL"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Email <input type="email" name="email"></label>
          <label class="field">Telefon <input name="telefon"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Sursă
            <select name="sursa">${SURSE_LEAD.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>
          </label>
          <label class="field">Agent responsabil
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${ctx.user && ctx.user.id === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <label class="field">Observații <textarea name="observatii" rows="3" placeholder="Ce vrea, de unde a venit, ce s-a discutat"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează lead-ul</button> <a class="btn secondary" href="/crm/leaduri">Renunță</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Lead nou", active: "/crm", body }));
  });

  router.post("/crm/leaduri", async (ctx) => {
    const b = ctx.body;
    if (!String(b.nume || "").trim()) return redirect(ctx.res, "/crm/leaduri/nou");
    const info = await db
      .prepare(
        `INSERT INTO leaduri (nume, companie, email, telefon, sursa, stadiu, atribuit_lui, observatii, creat_de, ultima_activitate)
         VALUES (?, ?, ?, ?, ?, 'nou', ?, ?, ?, ?) RETURNING id`
      )
      .run(
        String(b.nume).trim(),
        String(b.companie || "").trim() || null,
        String(b.email || "").trim() || null,
        String(b.telefon || "").trim() || null,
        String(b.sursa || "manual"),
        nr(b.atribuit_lui),
        String(b.observatii || "").trim() || null,
        ctx.user ? ctx.user.id : null,
        azi()
      );
    redirect(ctx.res, `/crm/leaduri/${info.lastInsertRowid}`);
  });

  router.get("/crm/leaduri/:id", async (ctx) => {
    const l = await db
      .prepare("SELECT l.*, u.nume AS agent_nume FROM leaduri l LEFT JOIN utilizatori u ON u.id = l.atribuit_lui WHERE l.id = ?")
      .get(ctx.params.id);
    if (!l) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/crm", body: "<p>Lead inexistent.</p>" }));

    const useri = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const taskuriLegate = await db.prepare(`${taskuri.SELECT_TASK} WHERE t.lead_id = ? ORDER BY t.id DESC`).all(l.id);
    const emailuri = await db
      .prepare("SELECT e.*, u.nume AS expeditor FROM emailuri e LEFT JOIN utilizatori u ON u.id = e.utilizator_id WHERE e.lead_id = ? ORDER BY e.id DESC")
      .all(l.id);
    const activitate = await db
      .prepare("SELECT i.*, u.nume AS autor FROM interactiuni i LEFT JOIN utilizatori u ON u.id = i.utilizator_id WHERE i.lead_id = ? ORDER BY i.id DESC")
      .all(l.id);

    const body = `
      ${subnavCrm("/crm/leaduri", ctx.user)}
      <div class="detail-box">
        <h1 style="margin-top:0">${esc(l.nume)} ${badgeLead(l.stadiu)}</h1>
        <div class="detail-grid">
          <div><div class="k">Companie</div>${esc(l.companie || "—")}</div>
          <div><div class="k">Email</div>${l.email ? `<a href="/crm/email/nou?lead_id=${l.id}">${esc(l.email)}</a>` : "—"}</div>
          <div><div class="k">Telefon</div>${esc(l.telefon || "—")}</div>
          <div><div class="k">Sursă</div>${esc(l.sursa || "—")}</div>
          <div><div class="k">Agent</div>${esc(l.agent_nume || "neatribuit")}</div>
          <div><div class="k">Creat la</div>${esc((l.creat_la || "").slice(0, 10))}</div>
          ${l.partener_id ? `<div><div class="k">Client creat</div><a href="/parteneri/${l.partener_id}">vezi partenerul →</a></div>` : ""}
        </div>
        ${l.observatii ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(l.observatii)}</p>` : ""}
      </div>

      <div class="toolbar">
        <a class="btn secondary" href="/taskuri/nou?lead_id=${l.id}&titlu=${encodeURIComponent("Contactează " + l.nume)}">+ Task</a>
        ${l.email ? `<a class="btn secondary" href="/crm/email/nou?lead_id=${l.id}">✉ Trimite email</a>` : ""}
        ${l.stadiu !== "convertit" ? `<a class="btn" href="/crm/leaduri/${l.id}/converteste">→ Convertește în client</a>` : ""}
      </div>

      <form class="form" method="post" action="/crm/leaduri/${l.id}/actualizeaza">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Stadiu
            <select name="stadiu">${STADII_LEAD.filter(([v]) => v !== "convertit" || l.stadiu === "convertit")
              .map(([v, t]) => `<option value="${v}"${l.stadiu === v ? " selected" : ""}>${esc(t)}</option>`)
              .join("")}</select>
          </label>
          <label class="field">Agent responsabil
            <select name="atribuit_lui">
              <option value="">— neatribuit —</option>
              ${useri.map((u) => `<option value="${u.id}"${l.atribuit_lui === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="form-actions"><button class="btn small" type="submit">Salvează</button></div>
      </form>

      <h2>Adaugă o interacțiune</h2>
      <form class="form" method="post" action="/crm/leaduri/${l.id}/interactiune">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Tip<select name="tip">${TIPURI_INTERACTIUNE.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}</select></label>
          <label class="field">Următorul contact<input type="date" name="data_urmatoare_actiune"></label>
        </div>
        <label class="field">Subiect<input name="subiect" placeholder="Ex: Apel de calificare"></label>
        <label class="field">Ce s-a discutat<textarea name="descriere" rows="3"></textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează interacțiunea</button></div>
      </form>

      <h2>Istoric</h2>
      ${
        activitate.length
          ? activitate
              .map(
                (i) => `<div class="detail-box" style="padding:12px">
                  <div style="font-size:12px;color:var(--text-muted)">${esc(i.tip)} · ${esc((i.data || "").slice(0, 16))} · ${esc(i.autor || "—")}</div>
                  <div style="font-weight:600;margin-top:2px">${esc(i.subiect || "")}</div>
                  <div style="white-space:pre-wrap">${esc(i.descriere || "")}</div>
                </div>`
              )
              .join("")
          : '<p style="color:var(--text-muted)">Nicio interacțiune încă.</p>'
      }

      <h2>Task-uri</h2>
      ${taskuriLegate.length ? table(taskuri.CAPETE, taskuriLegate.map((t) => taskuri.randTask(t, azi()))) : '<p style="color:var(--text-muted)">Niciun task.</p>'}

      <h2>Emailuri</h2>
      ${
        emailuri.length
          ? table(
              ["Data", "Subiect", "Expeditor", "Status"],
              emailuri.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                esc(e.expeditor || "—"),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Lead: ${l.nume}`, active: "/crm", body }));
  });

  router.post("/crm/leaduri/:id/actualizeaza", async (ctx) => {
    await db
      .prepare("UPDATE leaduri SET stadiu = ?, atribuit_lui = ?, ultima_activitate = ? WHERE id = ?")
      .run(String(ctx.body.stadiu || "nou"), nr(ctx.body.atribuit_lui), azi(), ctx.params.id);
    redirect(ctx.res, `/crm/leaduri/${ctx.params.id}`);
  });

  router.post("/crm/leaduri/:id/interactiune", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, lead_id, utilizator_id, tip, subiect, descriere, data_urmatoare_actiune) VALUES (NULL, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        ctx.user ? ctx.user.id : null,
        String(ctx.body.tip || "nota"),
        String(ctx.body.subiect || "").trim() || null,
        String(ctx.body.descriere || "").trim() || null,
        String(ctx.body.data_urmatoare_actiune || "") || null
      );
    await db.prepare("UPDATE leaduri SET ultima_activitate = ?, stadiu = CASE WHEN stadiu = 'nou' THEN 'contactat' ELSE stadiu END WHERE id = ?").run(azi(), id);
    redirect(ctx.res, `/crm/leaduri/${id}`);
  });

  // Conversia lead → partener: creează clientul, leagă lead-ul de el și, dacă
  // se cere, deschide direct o oportunitate în pipeline.
  router.get("/crm/leaduri/:id/converteste", async (ctx) => {
    const l = await db.prepare("SELECT * FROM leaduri WHERE id = ?").get(ctx.params.id);
    if (!l) return redirect(ctx.res, "/crm/leaduri");
    const body = `
      ${subnavCrm("/crm/leaduri", ctx.user)}
      <form class="form" method="post" action="/crm/leaduri/${l.id}/converteste">
        <p>Lead-ul <strong>${esc(l.nume)}</strong>${l.companie ? ` (${esc(l.companie)})` : ""} devine partener în ERP.</p>
        <label class="field">Denumirea clientului<input name="nume_partener" required value="${esc(l.companie || l.nume)}"></label>
        <label class="field">CUI<input name="cui" placeholder="RO12345678"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field">Email<input name="email" value="${esc(l.email || "")}"></label>
          <label class="field">Telefon<input name="telefon" value="${esc(l.telefon || "")}"></label>
        </div>
        <label class="field">Adresă<input name="adresa"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="creeaza_oportunitate" value="1" checked> Creează și o oportunitate în pipeline
        </label>
        <label class="field">Titlul oportunității<input name="titlu_oportunitate" value="${esc("Oportunitate " + (l.companie || l.nume))}"></label>
        <label class="field">Valoare estimată (lei)<input type="number" step="0.01" name="valoare_estimata"></label>
        <div class="form-actions"><button class="btn" type="submit">Convertește</button> <a class="btn secondary" href="/crm/leaduri/${l.id}">Renunță</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Convertește lead-ul", active: "/crm", body }));
  });

  router.post("/crm/leaduri/:id/converteste", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const l = await db.prepare("SELECT * FROM leaduri WHERE id = ?").get(id);
    if (!l) return redirect(ctx.res, "/crm/leaduri");
    const b = ctx.body;
    const nume = String(b.nume_partener || l.companie || l.nume).trim();
    const cui = String(b.cui || "").trim();

    // Dacă firma există deja (după CUI sau nume), o refolosim în loc să creăm
    // un dublet în lista de parteneri.
    let existent = null;
    if (cui) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(cui) = LOWER(?) AND cui <> ''").get(cui);
    if (!existent) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(nume) = LOWER(?)").get(nume);

    let partenerId;
    if (existent) partenerId = existent.id;
    else {
      const ins = await db
        .prepare("INSERT INTO parteneri (tip, nume, cui, email, telefon, adresa, sursa, stare) VALUES ('client', ?, ?, ?, ?, ?, ?, 'client_activ') RETURNING id")
        .run(nume, cui || null, String(b.email || "").trim() || null, String(b.telefon || "").trim() || null, String(b.adresa || "").trim() || null, `lead: ${l.sursa || "manual"}`);
      partenerId = ins.lastInsertRowid;
    }

    await db.prepare("UPDATE leaduri SET stadiu = 'convertit', partener_id = ?, ultima_activitate = ? WHERE id = ?").run(partenerId, azi(), id);
    // Mutăm și task-urile lead-ului pe partenerul nou, ca să nu se piardă.
    await db.prepare("UPDATE taskuri SET partener_id = ? WHERE lead_id = ?").run(partenerId, id);

    if (b.creeaza_oportunitate) {
      await db
        .prepare("INSERT INTO oportunitati (partener_id, titlu, valoare_estimata, stadiu, observatii, atribuit_lui) VALUES (?, ?, ?, 'calificat', ?, ?)")
        .run(partenerId, String(b.titlu_oportunitate || `Oportunitate ${nume}`), Number(b.valoare_estimata || 0), `Convertit din lead #${id}`, l.atribuit_lui || null);
    }
    redirect(ctx.res, `/parteneri/${partenerId}`);
  });

  // ================= ACTIVITATE =======================================
  router.get("/crm/activitate", async (ctx) => {
    const emailuri = await db
      .prepare(
        `SELECT e.*, u.nume AS expeditor, p.nume AS partener_nume, l.nume AS lead_nume
         FROM emailuri e
         LEFT JOIN utilizatori u ON u.id = e.utilizator_id
         LEFT JOIN parteneri p ON p.id = e.partener_id
         LEFT JOIN leaduri l ON l.id = e.lead_id
         ORDER BY e.id DESC LIMIT 100`
      )
      .all();
    const interactiuni = await db
      .prepare(
        `SELECT i.*, p.nume AS partener_nume, l.nume AS lead_nume, u.nume AS autor
         FROM interactiuni i
         LEFT JOIN parteneri p ON p.id = i.partener_id
         LEFT JOIN leaduri l ON l.id = i.lead_id
         LEFT JOIN utilizatori u ON u.id = i.utilizator_id
         ORDER BY i.id DESC LIMIT 100`
      )
      .all();

    const body = `
      ${subnavCrm("/crm/activitate", ctx.user)}
      <div class="toolbar">
        <a class="btn" href="/crm/email/nou">✉ Email nou</a>
        <a class="btn secondary" href="/profil/email">Configurează contul meu de email</a>
      </div>

      <h2>Ultimele emailuri trimise din aplicație</h2>
      ${
        emailuri.length
          ? table(
              ["Data", "Către", "Subiect", "Context", "Expeditor", "Status"],
              emailuri.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                esc(e.catre),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                e.partener_id ? `<a href="/parteneri/${e.partener_id}">${esc(e.partener_nume || "")}</a>` : e.lead_id ? `<a href="/crm/leaduri/${e.lead_id}">${esc(e.lead_nume || "")}</a>` : "—",
                esc(e.expeditor || "—"),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email trimis încă. Configurează-ți contul din <a href="/profil/email">Profilul meu → Email</a> și trimite primul.</p>'
      }

      <h2>Ultimele interacțiuni</h2>
      ${
        interactiuni.length
          ? table(
              ["Data", "Tip", "Cu cine", "Subiect", "Înregistrat de"],
              interactiuni.map((i) => [
                esc((i.data || "").slice(0, 16)),
                esc(i.tip),
                i.partener_id ? `<a href="/parteneri/${i.partener_id}">${esc(i.partener_nume || "")}</a>` : i.lead_id ? `<a href="/crm/leaduri/${i.lead_id}">${esc(i.lead_nume || "")}</a>` : "—",
                esc(i.subiect || "—"),
                esc(i.autor || "—"),
              ])
            )
          : '<p style="color:var(--text-muted)">Nicio interacțiune înregistrată.</p>'
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Activitate CRM", active: "/crm", body }));
  });
}

module.exports = { register, STADII, STADIU_LABEL, STADII_LEAD, subnavCrm };
