"use strict";
// Calendarul agentului: o lună întreagă pe ecran, alegi ziua și pui pe ea ce
// ai de făcut — task, apel, întâlnire, târg, orice.
//
// DE CE EXISTĂ. Task-urile se vedeau până acum doar ca listă, iar în „Biroul
// meu" ca următoarele 14 zile. Lista îți spune CE ai de făcut, nu CÂND ești
// liber. Un agent care primește „ne vedem marți la 10" nu are ce întreba o
// listă; are nevoie să vadă marțea, cu ce e deja pe ea. Târgul de trei zile
// din noiembrie nu încape nicăieri într-o listă de scadențe.
//
// Nu e un calendar nou cu tabele noi: sunt ACELEAȘI task-uri, cu trei câmpuri
// în plus (ora, durata, locul). Un task pus din calendar apare în „Biroul meu"
// și în /taskuri, iar un task făcut în altă parte apare în calendar. Două
// liste de lucruri de făcut ar fi însemnat două locuri de uitat ceva.
//
// Adminul alege din aceeași listă derulantă ca la Biroul meu al cui calendar
// citește, și tot ce apare pe ecran se schimbă cu el.
const db = require("../lib/db");
const { esc, layout, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const taskuri = require("./taskuri");

const ZILE = ["Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă", "Duminică"];
const LUNI = [
  "ianuarie", "februarie", "martie", "aprilie", "mai", "iunie",
  "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie",
];
// Culoarea e pe TIPUL intrării, nu pe prioritate: într-o lună întreagă ochiul
// caută „unde am întâlniri", nu „unde am urgențe".
const CULOARE = {
  intalnire: "#2d6cdf",
  apel: "#1e7a45",
  email: "#6b5bd2",
  oferta: "#b8860b",
  livrare: "#0f766e",
  incasare: "#b02a37",
  depozit: "#555f6d",
  general: "#4a5568",
};
const CATE_PE_ZI = 3; // restul intră în „+N"

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function lunaOk(v) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));
}
function ziOk(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}
function oraOk(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
}

// Luna vecină, fără Date: „2026-01" minus o lună trebuie să dea „2025-12", iar
// aritmetica pe obiecte Date cu fus orar a mai mutat luna cu o zi în trecut.
function lunaPlus(luna, pas) {
  let a = Number(luna.slice(0, 4));
  let m = Number(luna.slice(5, 7)) + pas;
  while (m < 1) { m += 12; a--; }
  while (m > 12) { m -= 12; a++; }
  return `${a}-${String(m).padStart(2, "0")}`;
}

function zileDin(luna) {
  const a = Number(luna.slice(0, 4));
  const m = Number(luna.slice(5, 7));
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

// 0 = luni … 6 = duminică. Săptămâna începe luni, că așa o citește toată lumea
// de aici; getUTCDay() o începe duminica.
function ziSaptamanii(zi) {
  const d = new Date(zi + "T00:00:00Z").getUTCDay();
  return (d + 6) % 7;
}

function dataRo(zi) {
  if (!ziOk(zi)) return "";
  return `${Number(zi.slice(8, 10))} ${LUNI[Number(zi.slice(5, 7)) - 1]} ${zi.slice(0, 4)}`;
}

// Ora de afișat pe cartonaș. Fără oră, intrarea e „toată ziua".
function oraScurta(t) {
  return oraOk(t.ora) ? String(t.ora).slice(0, 5) : "";
}

function register(router) {
  // ---------------- luna pe ecran ----------------
  router.get("/crm/calendar", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const esteAdmin = ctx.user.rol === "admin";

    let agentId = Number(ctx.user.id);
    if (esteAdmin) {
      const a = parseInt(ctx.query.agent, 10);
      if (Number.isFinite(a) && a > 0) agentId = a;
    }
    const agent = await db.prepare("SELECT id, nume FROM utilizatori WHERE id = ?").get(agentId);
    if (!agent) return redirect(ctx.res, "/crm/calendar");
    const agenti = esteAdmin
      ? await db
          .prepare(
            `SELECT id, nume FROM utilizatori
              WHERE activ = 1 AND (rol = 'vanzari' OR id = ?)
              ORDER BY (CASE WHEN id = ? THEN 0 ELSE 1 END), nume`
          )
          .all(ctx.user.id, ctx.user.id)
      : [];
    const altCalendar = esteAdmin && agentId !== Number(ctx.user.id);

    const aziStr = azi();
    const luna = lunaOk(ctx.query.luna) ? String(ctx.query.luna) : aziStr.slice(0, 7);
    const zi = ziOk(ctx.query.zi) ? String(ctx.query.zi) : "";
    const prima = `${luna}-01`;
    const ultima = `${luna}-${String(zileDin(luna)).padStart(2, "0")}`;
    const link = (q) => {
      const p = Object.assign({ luna, agent: altCalendar ? agentId : "", zi }, q || {});
      const bucati = Object.entries(p)
        .filter(([, v]) => v !== "" && v != null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
      return "/crm/calendar" + (bucati.length ? "?" + bucati.join("&") : "");
    };

    // Toate intrările lunii, dintr-o singură interogare. Una pe zi ar fi
    // însemnat 31 de drumuri la bază pentru o pagină care se deschide des.
    const intrari = await db
      .prepare(
        `SELECT t.id, t.titlu, t.tip, t.prioritate, t.status, t.scadenta, t.ora, t.durata_minute,
                t.locatie, t.descriere, t.partener_id, p.nume AS client
           FROM taskuri t
           LEFT JOIN parteneri p ON p.id = t.partener_id
          WHERE t.atribuit_lui = ? AND t.scadenta >= ? AND t.scadenta <= ?
          ORDER BY t.scadenta, (CASE WHEN COALESCE(t.ora,'') = '' THEN 1 ELSE 0 END), t.ora, t.id`
      )
      .all(agentId, prima, ultima);

    const peZi = {};
    for (const t of intrari) {
      const k = String(t.scadenta).slice(0, 10);
      (peZi[k] = peZi[k] || []).push(t);
    }

    // ---- grila ------------------------------------------------------------
    const gol = ziSaptamanii(prima);
    const nrZile = zileDin(luna);
    const celule = [];
    for (let i = 0; i < gol; i++) celule.push(null);
    for (let d = 1; d <= nrZile; d++) celule.push(`${luna}-${String(d).padStart(2, "0")}`);
    while (celule.length % 7) celule.push(null);

    const cartonas = (t) => {
      const c = CULOARE[t.tip] || CULOARE.general;
      const gata = t.status === "finalizat" || t.status === "anulat";
      const ora = oraScurta(t);
      return `<a href="/taskuri/${t.id}" class="cal-intrare" title="${esc(
        [ora, t.titlu, t.client, t.locatie].filter(Boolean).join(" · ")
      )}" style="background:${c}${gata ? ";opacity:.45;text-decoration:line-through" : ""}">${
        ora ? `<strong>${esc(ora)}</strong> ` : ""
      }${esc(t.titlu)}</a>`;
    };

    const randuri = [];
    for (let i = 0; i < celule.length; i += 7) {
      const sapt = celule.slice(i, i + 7);
      randuri.push(
        `<tr>${sapt
          .map((z) => {
            if (!z) return '<td class="cal-zi cal-goala"></td>';
            const ale = peZi[z] || [];
            const vizibile = ale.slice(0, CATE_PE_ZI);
            const rest = ale.length - vizibile.length;
            const clase = [
              "cal-zi",
              z === aziStr ? "cal-azi" : "",
              z === zi ? "cal-aleasa" : "",
              ziSaptamanii(z) >= 5 ? "cal-weekend" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `<td class="${clase}">
              <a class="cal-nr" href="${esc(link({ zi: z }))}#zi">${Number(z.slice(8, 10))}</a>
              ${vizibile.map(cartonas).join("")}
              ${rest > 0 ? `<a class="cal-mai" href="${esc(link({ zi: z }))}#zi">+${rest} ${rest === 1 ? "încă" : "încă"}</a>` : ""}
            </td>`;
          })
          .join("")}</tr>`
      );
    }

    // ---- ziua aleasă ------------------------------------------------------
    const parteneri = await db
      .prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume LIMIT 3000")
      .all()
      .catch(() => []);
    const aleZilei = zi ? peZi[zi] || [] : [];
    const blocZi = !zi
      ? `<p id="zi" style="color:var(--text-muted)">Dă clic pe o zi din calendar și pui pe ea ce ai de făcut — task, apel, întâlnire, târg.</p>`
      : `<h2 id="zi">${esc(ZILE[ziSaptamanii(zi)])}, ${esc(dataRo(zi))}${
          zi === aziStr ? ' <span class="badge verde">azi</span>' : ""
        }</h2>
         ${
           aleZilei.length
             ? `<div class="cal-lista">${aleZilei
                 .map((t) => {
                   const gata = t.status === "finalizat" || t.status === "anulat";
                   return `<div class="detail-box" style="padding:10px 12px;margin-bottom:8px;border-left:4px solid ${
                     CULOARE[t.tip] || CULOARE.general
                   }${gata ? ";opacity:.6" : ""}">
                     <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
                       <strong${gata ? ' style="text-decoration:line-through"' : ""}><a href="/taskuri/${t.id}">${esc(t.titlu)}</a></strong>
                       <span style="font-size:12px;color:var(--text-muted)">
                         ${oraScurta(t) ? esc(oraScurta(t)) : "toată ziua"}${
                     t.durata_minute ? ` · ${Number(t.durata_minute)} min` : ""
                   } · ${esc(eticheta(t.tip))} ${taskuri.badge(taskuri.STATUSURI, t.status)}
                       </span>
                     </div>
                     <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
                       ${t.client ? `<a href="/parteneri/${t.partener_id}">${esc(t.client)}</a>` : ""}${
                     t.locatie ? `${t.client ? " · " : ""}📍 ${esc(t.locatie)}` : ""
                   }${t.descriere ? `${t.client || t.locatie ? " · " : ""}${esc(t.descriere)}` : ""}
                     </div>
                   </div>`;
                 })
                 .join("")}</div>`
             : `<p style="color:var(--text-muted)">Nimic în ziua asta${altCalendar ? ` la ${esc(agent.nume)}` : ""}. Scrie mai jos ce pui pe ea.</p>`
         }
         <form class="form" method="post" action="/crm/calendar" style="max-width:860px">
           <input type="hidden" name="zi" value="${esc(zi)}">
           <input type="hidden" name="agent" value="${altCalendar ? agentId : ""}">
           <input type="hidden" name="luna" value="${esc(luna)}">
           <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
             <label class="field" style="flex:2;min-width:240px"><span>Ce pui pe ${esc(dataRo(zi))}</span>
               <input name="titlu" required placeholder="Întâlnire la Delivery, târg RotaPack, sună-l pe Enrico"></label>
             <label class="field" style="width:150px"><span>Tip</span>
               <select name="tip">${taskuri.optiuni(taskuri.TIPURI, "intalnire")}</select></label>
             <label class="field" style="width:100px"><span>Ora</span><input type="time" name="ora"></label>
             <label class="field" style="width:110px"><span>Durata (min)</span>
               <input type="number" name="durata_minute" min="0" step="15" placeholder="60"></label>
             <label class="field" style="width:130px"><span>Prioritate</span>
               <select name="prioritate">${taskuri.optiuni(taskuri.PRIORITATI, "normala")}</select></label>
           </div>
           <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
             <label class="field" style="flex:1;min-width:220px"><span>Client (opțional)</span>
               <select name="partener_id">
                 <option value="">— fără client —</option>
                 ${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}
               </select></label>
             <label class="field" style="flex:1;min-width:180px"><span>Unde (opțional)</span>
               <input name="locatie" placeholder="la ei, la noi, online, Budapesta"></label>
             <label class="field" style="width:130px"><span>Ține până pe</span>
               <input type="date" name="pana_la" value="${esc(zi)}"></label>
           </div>
           <label class="field" style="margin-top:8px"><span>Detalii (opțional)</span>
             <textarea name="descriere" rows="2" placeholder="Ce se discută, cine mai vine, ce duci cu tine"></textarea></label>
           <div class="form-actions">
             <button class="btn" type="submit">Pune în calendar${altCalendar ? ` la ${esc(agent.nume)}` : ""}</button>
             <a class="btn secondary" href="${esc(link({ zi: "" }))}">Închide ziua</a>
           </div>
           <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">
             „Ține până pe" e pentru lucrurile de mai multe zile — un târg de miercuri până vineri
             intră cu un rând pe fiecare zi, ca să-l vezi acolo unde te uiți. Fără oră, intrarea e
             „toată ziua".
           </p>
         </form>`;

    const body = `
      ${subnavCrm("/crm/calendar", ctx.user)}
      ${
        esteAdmin && agenti.length > 1
          ? `<form method="get" action="/crm/calendar" class="filtre" style="margin-bottom:12px">
               <input type="hidden" name="luna" value="${esc(luna)}">
               ${zi ? `<input type="hidden" name="zi" value="${esc(zi)}">` : ""}
               <span style="font-size:13px">Calendarul lui:</span>
               <select name="agent" onchange="this.form.submit()">
                 ${agenti
                   .map(
                     (a) =>
                       `<option value="${a.id}"${Number(a.id) === agentId ? " selected" : ""}>${esc(a.nume)}${
                         Number(a.id) === Number(ctx.user.id) ? " — calendarul meu" : ""
                       }</option>`
                   )
                   .join("")}
               </select>
               <noscript><button class="btn secondary" type="submit">Deschide</button></noscript>
               ${altCalendar ? `<span class="badge galben">calendarul lui ${esc(agent.nume)}</span>` : ""}
             </form>`
          : ""
      }

      <div class="toolbar" style="justify-content:space-between;align-items:center;flex-wrap:wrap">
        <div style="display:flex;gap:6px;align-items:center">
          <a class="btn secondary small" href="${esc(link({ luna: lunaPlus(luna, -1), zi: "" }))}">← ${esc(
      LUNI[Number(lunaPlus(luna, -1).slice(5, 7)) - 1]
    )}</a>
          <strong style="font-size:17px">${esc(LUNI[Number(luna.slice(5, 7)) - 1])} ${esc(luna.slice(0, 4))}</strong>
          <a class="btn secondary small" href="${esc(link({ luna: lunaPlus(luna, 1), zi: "" }))}">${esc(
      LUNI[Number(lunaPlus(luna, 1).slice(5, 7)) - 1]
    )} →</a>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <a class="btn secondary small" href="${esc(link({ luna: aziStr.slice(0, 7), zi: aziStr }))}#zi">Azi</a>
          <span style="font-size:12px;color:var(--text-muted)">${intrari.length} ${
      intrari.length === 1 ? "intrare" : "intrări"
    } în luna asta</span>
        </div>
      </div>

      <table class="calendar">
        <thead><tr>${ZILE.map((z) => `<th>${esc(z)}</th>`).join("")}</tr></thead>
        <tbody>${randuri.join("")}</tbody>
      </table>

      ${blocZi}
    `;
    send(
      ctx.res,
      200,
      layout({
        user: ctx.user,
        title: `Calendar ${LUNI[Number(luna.slice(5, 7)) - 1]} ${luna.slice(0, 4)}${altCalendar ? " — " + agent.nume : ""}`,
        active: "/crm",
        body,
      })
    );
  });

  // ---------------- o intrare nouă ----------------
  router.post("/crm/calendar", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body;
    const zi = ziOk(b.zi) ? String(b.zi) : azi();
    const luna = lunaOk(b.luna) ? String(b.luna) : zi.slice(0, 7);

    // Cui îi intră în calendar. Un agent scrie numai la el; adminul poate pune
    // și la altcineva, fiindcă el e cel care împarte târgurile și vizitele.
    // Verificarea e pe server: câmpul ascuns din formular nu e o regulă.
    let pentruId = Number(ctx.user.id);
    if (ctx.user.rol === "admin") {
      const cerut = parseInt(b.agent, 10);
      if (Number.isFinite(cerut) && cerut > 0) {
        const alt = await db.prepare("SELECT id FROM utilizatori WHERE id = ? AND activ = 1").get(cerut);
        if (alt) pentruId = Number(alt.id);
      }
    }
    const inapoi = `/crm/calendar?luna=${luna}&zi=${zi}${pentruId !== Number(ctx.user.id) ? `&agent=${pentruId}` : ""}#zi`;

    const titlu = String(b.titlu || "").trim();
    if (!titlu) return redirect(ctx.res, inapoi);

    const tip = taskuri.TIPURI.some(([v]) => v === b.tip) ? String(b.tip) : "general";
    const prioritate = taskuri.PRIORITATI.some(([v]) => v === b.prioritate) ? String(b.prioritate) : "normala";
    const ora = oraOk(b.ora) ? String(b.ora) : null;
    const durata = Number.isFinite(parseInt(b.durata_minute, 10)) ? Math.max(0, parseInt(b.durata_minute, 10)) : null;
    const locatie = String(b.locatie || "").trim() || null;
    const descriere = String(b.descriere || "").trim() || null;
    const partenerId = parseInt(b.partener_id, 10) || null;

    // Un lucru care ține mai multe zile intră cu un rând pe fiecare zi. Altfel
    // târgul de trei zile s-ar vedea doar miercuri, iar joi calendarul ar
    // arăta liber — exact ziua în care cineva ți-ar fi pus altceva.
    //
    // 60 de zile e plafonul: cu o dată tastată greșit („2027" în loc de
    // „2026") s-ar fi scris o mie de rânduri dintr-un clic.
    let pana = ziOk(b.pana_la) && String(b.pana_la) > zi ? String(b.pana_la) : zi;
    const zileDeScris = [];
    for (let d = zi; d <= pana && zileDeScris.length < 60; ) {
      zileDeScris.push(d);
      const x = new Date(d + "T00:00:00Z");
      x.setUTCDate(x.getUTCDate() + 1);
      d = x.toISOString().slice(0, 10);
    }

    for (const d of zileDeScris) {
      await db
        .prepare(
          `INSERT INTO taskuri (titlu, descriere, tip, prioritate, status, scadenta, ora, durata_minute,
                                locatie, atribuit_lui, creat_de, partener_id)
           VALUES (?, ?, ?, ?, 'deschis', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          zileDeScris.length > 1 ? `${titlu} (${zileDeScris.indexOf(d) + 1}/${zileDeScris.length})` : titlu,
          descriere,
          tip,
          prioritate,
          d,
          ora,
          durata,
          locatie,
          pentruId,
          ctx.user.id,
          partenerId
        );
    }

    redirect(ctx.res, inapoi);
  });
}

function eticheta(tip) {
  const g = taskuri.TIPURI.find((x) => x[0] === tip);
  return g ? g[1] : tip;
}

module.exports = { register };
