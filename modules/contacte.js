"use strict";
// Task-uri de contact client + sugestii de clienți noi.
//
// Două lucruri care par diferite, dar rezolvă aceeași problemă: un agent nu
// trebuie să-și amintească singur pe cine n-a mai sunat de două luni și nici
// să-și caute singur clienți noi. Sistemul îi pune pe masă și una, și alta.
//
// 1. TASK DE CONTACT. Pentru fiecare client alocat unui agent, dacă n-a mai
//    fost nicio discuție de PRAG_ZILE, se generează automat un task
//    „Contactează X". Agentul îl închide alegând dintr-o listă scurtă —
//    telefon / vizită / email / WhatsApp — plus rezultatul și detaliile.
//    Răspunsul se scrie în „interactiuni", deci rămâne pe istoricul clientului
//    lângă emailuri, oferte și tot restul. Asta e și „vizita cu feedback":
//    o vizită e doar un mod de contact, cu rezultat și text liber.
//
// 2. SUGESTII DE CLIENȚI. Aceeași listă pentru toți agenții, primul venit
//    primul servit. Cine ia un client îi poate pune persoana de contact și
//    modul preferat de contact, iar clientul i se alocă (dacă nu e deja al
//    altcuiva) și primește imediat un task de contact.
const db = require("../lib/db");
const { esc, layout, table, money } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Câte zile de tăcere înseamnă „ar cam trebui sunat".
const PRAG_ZILE = 45;
// Câte task-uri de contact deschise ținem simultan pe un agent. Mai multe
// n-ar face decât să transforme lista într-un zid pe care nimeni nu-l citește.
const MAX_DESCHISE = 6;

const MODURI = {
  telefon: "Telefon",
  vizita: "Vizită",
  email: "Email",
  whatsapp: "WhatsApp",
};
const REZULTATE = {
  interesat: "Interesat — cerere de ofertă",
  comanda: "A comandat",
  revenim: "Revenim mai târziu",
  fara_raspuns: "Nu a răspuns",
  nu_acum: "Nu are nevoie acum",
  refuz: "Refuz / lucrează cu altcineva",
};

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function peste(zile) {
  const d = new Date();
  d.setDate(d.getDate() + zile);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
// Generarea task-urilor de contact
// ------------------------------------------------------------------
// Rulează la deschiderea biroului agentului (ieftin: câteva query-uri) și
// nu creează niciodată duplicate — un client cu task deschis e sărit.
async function genereazaTaskuriContact(agentId) {
  const agent = await db.prepare("SELECT id, rol, activ FROM utilizatori WHERE id = ?").get(agentId);
  if (!agent || Number(agent.activ) === 0) return 0;

  const deschise = await db
    .prepare("SELECT COUNT(*) AS n FROM taskuri WHERE tip = 'contact_client' AND status <> 'finalizat' AND atribuit_lui = ?")
    .get(agentId);
  const locuri = MAX_DESCHISE - Number((deschise && deschise.n) || 0);
  if (locuri <= 0) return 0;

  // Clienții agentului, cu data ultimei discuții și cât a facturat clientul
  // în ultimul an — ca să propunem întâi clienții mari care au amuțit.
  const candidati = await db
    .prepare(
      `SELECT p.id, p.nume,
              (SELECT MAX(i.data) FROM interactiuni i WHERE i.partener_id = p.id) AS ultima,
              (SELECT COALESCE(SUM(fl.cantitate * fl.pret_unitar), 0)
                 FROM facturi f JOIN facturi_linii fl ON fl.factura_id = f.id
                WHERE f.partener_id = p.id AND f.directie = 'vanzare'
                  AND f.data_emiterii >= ?) AS cifra
         FROM parteneri p
         JOIN alocari_clienti a ON a.partener_id = p.id
        WHERE a.utilizator_id = ? AND a.procent > 0
          AND p.tip IN ('client','ambele')
          AND NOT EXISTS (
                SELECT 1 FROM taskuri t
                 WHERE t.partener_id = p.id AND t.tip = 'contact_client' AND t.status <> 'finalizat')
        ORDER BY cifra DESC`
    )
    .all(peste(-365), agentId);

  const limita = peste(-PRAG_ZILE);
  let create = 0;
  for (const c of candidati) {
    if (create >= locuri) break;
    const ultima = c.ultima ? String(c.ultima).slice(0, 10) : null;
    if (ultima && ultima > limita) continue; // s-a vorbit recent, îl lăsăm în pace
    const zile = ultima ? Math.round((Date.parse(azi()) - Date.parse(ultima)) / 86400000) : null;
    const motiv = ultima
      ? `Ultima discuție înregistrată: ${ultima} (acum ${zile} zile).`
      : "Nicio discuție înregistrată pe acest client.";
    const cifra = Number(c.cifra) || 0;
    await db
      .prepare(
        `INSERT INTO taskuri (titlu, descriere, tip, prioritate, status, scadenta, atribuit_lui, partener_id)
         VALUES (?, ?, 'contact_client', ?, 'deschis', ?, ?, ?)`
      )
      .run(
        `Contactează ${c.nume}`,
        `${motiv}${cifra > 0 ? ` A facturat ${cifra.toFixed(0)} lei în ultimele 12 luni.` : ""}`,
        cifra > 20000 ? "ridicata" : "normala",
        peste(3),
        agentId,
        c.id
      );
    create++;
  }
  return create;
}

// ------------------------------------------------------------------
// Generarea sugestiilor de clienți
// ------------------------------------------------------------------
// Sugestiile sunt lead-uri cu sursa „sugestie" și fără agent: aceeași listă
// pentru toată lumea. Le scoatem din clienții pe care nu-i lucrează nimeni:
// fie n-au agent deloc, fie n-au mai cumpărat de peste 9 luni.
async function genereazaSugestii() {
  const existente = await db.prepare("SELECT partener_id FROM leaduri WHERE sursa = 'sugestie' AND partener_id IS NOT NULL").all();
  const deja = new Set(existente.map((x) => Number(x.partener_id)));

  const candidati = await db
    .prepare(
      `SELECT p.id, p.nume, p.email, p.telefon,
              (SELECT MAX(f.data_emiterii) FROM facturi f WHERE f.partener_id = p.id AND f.directie = 'vanzare') AS ultima_factura,
              (SELECT COALESCE(SUM(fl.cantitate * fl.pret_unitar), 0)
                 FROM facturi f JOIN facturi_linii fl ON fl.factura_id = f.id
                WHERE f.partener_id = p.id AND f.directie = 'vanzare') AS total_istoric,
              (SELECT COUNT(*) FROM alocari_clienti a WHERE a.partener_id = p.id AND a.procent > 0) AS alocat
         FROM parteneri p
        WHERE p.tip IN ('client','ambele')
        ORDER BY total_istoric DESC
        LIMIT 400`
    )
    .all();

  const prag = peste(-270);
  let create = 0;
  for (const c of candidati) {
    if (create >= 30) break;
    if (deja.has(Number(c.id))) continue;
    const uf = c.ultima_factura ? String(c.ultima_factura).slice(0, 10) : null;
    const faraAgent = Number(c.alocat) === 0;
    const adormit = uf && uf < prag;
    if (!faraAgent && !adormit) continue;
    const motiv = faraAgent
      ? uf
        ? `Client fără agent alocat. Ultima factură: ${uf}.`
        : "Client fără agent alocat și fără facturi."
      : `Nu a mai cumpărat din ${uf} — merită un telefon.`;
    await db
      .prepare(
        `INSERT INTO leaduri (nume, companie, email, telefon, sursa, stadiu, partener_id, motiv_sugestie, observatii)
         VALUES (?, ?, ?, ?, 'sugestie', 'nou', ?, ?, ?)`
      )
      .run(c.nume, c.nume, c.email || null, c.telefon || null, c.id, motiv, null);
    create++;
  }
  return create;
}

// ------------------------------------------------------------------
// Blocuri pentru dashboard-ul agentului (folosite din crm.js)
// ------------------------------------------------------------------
async function blocTaskuriContact(user, agentId) {
  const taskuri = await db
    .prepare(
      `SELECT t.id, t.titlu, t.descriere, t.scadenta, t.prioritate, t.partener_id, p.nume AS client,
              p.telefon, p.email
         FROM taskuri t
         LEFT JOIN parteneri p ON p.id = t.partener_id
        WHERE t.tip = 'contact_client' AND t.status <> 'finalizat' AND t.atribuit_lui = ?
        ORDER BY CASE WHEN t.prioritate = 'ridicata' THEN 0 ELSE 1 END, t.scadenta`
    )
    .all(agentId);

  if (!taskuri.length) {
    return `<h2>Clienți de contactat</h2>
      <p style="color:var(--text-muted)">Nimic de sunat acum — toți clienții alocați au fost contactați în ultimele ${PRAG_ZILE} de zile.</p>`;
  }

  const carduri = taskuri
    .map(
      (t) => `
      <div class="card" style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
          <strong>${t.partener_id ? `<a href="/parteneri/${t.partener_id}">${esc(t.client || t.titlu)}</a>` : esc(t.titlu)}</strong>
          <span style="font-size:12px;color:var(--text-muted)">
            ${t.prioritate === "ridicata" ? `<span class="badge galben">prioritar</span> ` : ""}
            scadent ${esc(String(t.scadenta || "").slice(0, 10))}
          </span>
        </div>
        <div style="font-size:13px;color:var(--text-muted);margin:4px 0 8px">
          ${esc(t.descriere || "")}
          ${t.telefon ? ` · tel. ${esc(t.telefon)}` : ""}${t.email ? ` · ${esc(t.email)}` : ""}
        </div>
        <form method="post" action="/crm/contact/${t.id}" style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">
          <label class="field" style="width:120px"><span>Cum</span>
            <select name="mod">${Object.entries(MODURI).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
          </label>
          <label class="field" style="width:200px"><span>Rezultat</span>
            <select name="rezultat">${Object.entries(REZULTATE).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
          </label>
          <label class="field" style="flex:1;min-width:200px"><span>Detalii</span>
            <input name="detalii" placeholder="ce s-a discutat">
          </label>
          <label class="field" style="width:150px"><span>Revin pe</span>
            <input type="date" name="urmatoarea">
          </label>
          <button class="btn" type="submit">Salvează</button>
        </form>
      </div>`
    )
    .join("");

  return `<h2>Clienți de contactat <span style="font-size:13px;font-weight:400;color:var(--text-muted)">— generate automat, fără discuție de peste ${PRAG_ZILE} de zile</span></h2>${carduri}`;
}

async function blocSugestii(user) {
  const sugestii = await db
    .prepare(
      `SELECT l.id, l.nume, l.companie, l.email, l.telefon, l.motiv_sugestie, l.partener_id
         FROM leaduri l
        WHERE l.sursa = 'sugestie' AND l.atribuit_lui IS NULL AND l.stadiu <> 'pierdut'
        ORDER BY l.id DESC
        LIMIT 12`
    )
    .all();

  const preluate = await db
    .prepare(
      `SELECT l.id, l.nume, l.persoana_contact, l.mod_contact, l.partener_id
         FROM leaduri l
        WHERE l.sursa = 'sugestie' AND l.atribuit_lui = ?
        ORDER BY l.id DESC LIMIT 10`
    )
    .all(user.id);

  const lista = sugestii.length
    ? sugestii
        .map(
          (s) => `
        <div class="card" style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
            <strong>${s.partener_id ? `<a href="/parteneri/${s.partener_id}">${esc(s.nume)}</a>` : esc(s.nume)}</strong>
            <span style="font-size:12px;color:var(--text-muted)">${esc([s.telefon, s.email].filter(Boolean).join(" · "))}</span>
          </div>
          <div style="font-size:13px;color:var(--text-muted);margin:4px 0 8px">${esc(s.motiv_sugestie || "")}</div>
          <form method="post" action="/crm/sugestii/${s.id}/preia" style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">
            <label class="field" style="flex:1;min-width:170px"><span>Persoană de contact</span><input name="persoana_contact" placeholder="opțional"></label>
            <label class="field" style="width:140px"><span>Cum îl contactezi</span>
              <select name="mod_contact">${Object.entries(MODURI).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
            </label>
            <button class="btn" type="submit">Îl iau eu</button>
          </form>
        </div>`
        )
        .join("")
    : `<p style="color:var(--text-muted)">Momentan nu sunt clienți nelucrați de propus.</p>`;

  const alMeu = preluate.length
    ? `<p style="font-size:13px;color:var(--text-muted);margin-top:8px">Luați de tine: ${preluate
        .map((p) => `${p.partener_id ? `<a href="/parteneri/${p.partener_id}">${esc(p.nume)}</a>` : esc(p.nume)}${p.persoana_contact ? ` (${esc(p.persoana_contact)})` : ""}`)
        .join(", ")}</p>`
    : "";

  return `<h2>Clienți sugerați <span style="font-size:13px;font-weight:400;color:var(--text-muted)">— aceeași listă pentru toți agenții, cine îi ia primul</span></h2>${lista}${alMeu}`;
}

// ------------------------------------------------------------------
function register(router) {
  // Răspunsul agentului la un task de contact.
  router.post("/crm/contact/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const t = await db.prepare("SELECT * FROM taskuri WHERE id = ?").get(ctx.params.id);
    if (!t) return redirect(ctx.res, "/crm/birou");
    if (ctx.user.rol !== "admin" && t.atribuit_lui !== ctx.user.id) return redirect(ctx.res, "/crm/birou");

    const mod = MODURI[ctx.body.mod] ? ctx.body.mod : "telefon";
    const rezultat = REZULTATE[ctx.body.rezultat] ? ctx.body.rezultat : "revenim";
    const detalii = String(ctx.body.detalii || "").trim();
    const urmatoarea = String(ctx.body.urmatoarea || "").trim() || null;

    if (t.partener_id) {
      await db
        .prepare(
          `INSERT INTO interactiuni (partener_id, tip, subiect, descriere, data, data_urmatoare_actiune, utilizator_id, task_id, rezultat)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          t.partener_id,
          mod,
          `${MODURI[mod]} — ${REZULTATE[rezultat]}`,
          detalii || null,
          new Date().toISOString().slice(0, 19).replace("T", " "),
          urmatoarea,
          ctx.user.id,
          t.id,
          rezultat
        );
    }

    await db
      .prepare("UPDATE taskuri SET status = 'finalizat', finalizat_la = ? WHERE id = ?")
      .run(new Date().toISOString().slice(0, 19).replace("T", " "), t.id);

    // „Revin pe X" înseamnă un task nou la data aia — altfel promisiunea se
    // pierde și clientul rămâne iar nesunat.
    if (urmatoarea && t.partener_id) {
      await db
        .prepare(
          `INSERT INTO taskuri (titlu, descriere, tip, prioritate, status, scadenta, atribuit_lui, partener_id)
           VALUES (?, ?, 'contact_client', 'normala', 'deschis', ?, ?, ?)`
        )
        .run(t.titlu, `Revenire promisă la ${MODURI[mod].toLowerCase()} din ${azi()}.${detalii ? " " + detalii : ""}`, urmatoarea, t.atribuit_lui, t.partener_id);
    }

    redirect(ctx.res, ctx.body.inapoi ? String(ctx.body.inapoi) : "/crm/birou");
  });

  // Agentul ia un client sugerat.
  router.post("/crm/sugestii/:id/preia", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const l = await db.prepare("SELECT * FROM leaduri WHERE id = ?").get(ctx.params.id);
    if (!l) return redirect(ctx.res, "/crm/birou");
    if (l.atribuit_lui) return redirect(ctx.res, "/crm/birou"); // l-a luat altcineva între timp

    const persoana = String(ctx.body.persoana_contact || "").trim() || null;
    const modContact = MODURI[ctx.body.mod_contact] ? ctx.body.mod_contact : null;

    await db
      .prepare("UPDATE leaduri SET atribuit_lui = ?, stadiu = 'in_lucru', persoana_contact = ?, mod_contact = ?, ultima_activitate = ? WHERE id = ?")
      .run(ctx.user.id, persoana, modContact, azi(), l.id);

    // Dacă sugestia e un client existent nelucrat de nimeni, i-l alocăm.
    // Dacă are deja agent, nu-l furăm — rămâne doar lead-ul lui.
    if (l.partener_id) {
      const are = await db.prepare("SELECT COUNT(*) AS n FROM alocari_clienti WHERE partener_id = ? AND procent > 0").get(l.partener_id);
      if (Number((are && are.n) || 0) === 0) {
        await db
          .prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, valabil_de_la) VALUES (?, ?, 100, ?)")
          .run(l.partener_id, ctx.user.id, azi());
      }
      await db
        .prepare(
          `INSERT INTO taskuri (titlu, descriere, tip, prioritate, status, scadenta, atribuit_lui, partener_id, lead_id)
           VALUES (?, ?, 'contact_client', 'ridicata', 'deschis', ?, ?, ?, ?)`
        )
        .run(
          `Contactează ${l.nume}`,
          `Client luat din sugestii.${persoana ? ` Persoană de contact: ${persoana}.` : ""}${modContact ? ` Preferă ${MODURI[modContact].toLowerCase()}.` : ""}`,
          peste(2),
          ctx.user.id,
          l.partener_id,
          l.id
        );
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'nota', ?, ?, ?)")
        .run(l.partener_id, "Client preluat din sugestii", `Preluat de ${ctx.user.nume}.${persoana ? ` Contact: ${persoana}.` : ""}`, ctx.user.id);
    }

    redirect(ctx.res, ctx.body.inapoi ? String(ctx.body.inapoi) : "/crm/birou");
  });

  // Regenerarea manuală a sugestiilor (admin) — altfel se face la deschiderea
  // biroului, dar uneori vrei să forțezi după un import.
  router.post("/crm/sugestii/regenereaza", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/crm/birou");
    const n = await genereazaSugestii();
    redirect(ctx.res, `/crm/birou?sugestii=${n}`);
  });

  // Pagina cu toate contactările — istoricul, nu doar ce e de făcut.
  router.get("/crm/contacte", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const agentId = eAdmin && ctx.query.agent ? parseInt(ctx.query.agent, 10) : ctx.user.id;

    const agenti = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin') ORDER BY nume").all();

    const istoric = await db
      .prepare(
        `SELECT i.id, i.data, i.tip, i.subiect, i.descriere, i.rezultat, i.data_urmatoare_actiune,
                p.id AS partener_id, p.nume AS client, u.nume AS agent
           FROM interactiuni i
           JOIN parteneri p ON p.id = i.partener_id
           LEFT JOIN utilizatori u ON u.id = i.utilizator_id
          WHERE ${eAdmin && !ctx.query.agent ? "1 = 1" : "i.utilizator_id = ?"}
          ORDER BY i.data DESC, i.id DESC
          LIMIT 300`
      )
      .all(...(eAdmin && !ctx.query.agent ? [] : [agentId]));

    const deFacut = await blocTaskuriContact(ctx.user, agentId);

    const body = `
      ${subnavCrm("/crm/contacte")}
      ${
        eAdmin
          ? `<form method="get" action="/crm/contacte" class="filtre">
              <span style="font-size:13px">Agent:</span>
              <select name="agent" onchange="this.form.submit()">
                <option value="">toți</option>
                ${agenti.map((a) => `<option value="${a.id}"${String(a.id) === String(ctx.query.agent || "") ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
              </select>
            </form>`
          : ""
      }
      ${deFacut}
      <h2>Istoric contactări</h2>
      ${
        istoric.length
          ? table(
              ["Data", "Client", "Mod", "Subiect", "Detalii", "Revenire", "Agent"],
              istoric.map((i) => [
                esc(String(i.data || "").slice(0, 16)),
                `<a href="/parteneri/${i.partener_id}">${esc(i.client)}</a>`,
                esc(MODURI[i.tip] || i.tip || "—"),
                esc(i.subiect || "—"),
                esc((i.descriere || "").slice(0, 120)),
                i.data_urmatoare_actiune ? esc(String(i.data_urmatoare_actiune).slice(0, 10)) : "—",
                esc(i.agent || "—"),
              ])
            )
          : `<p style="color:var(--text-muted)">Nicio contactare înregistrată încă.</p>`
      }
    `;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Contactări", active: "/crm", body }));
  });
}

// Duplicat local, ca să nu creăm o dependență circulară cu crm.js
// (crm.js folosește blocurile de aici, deci nu poate fi cerut de aici).
function subnavCrm(activ) {
  const linkuri = [
    ["/crm", "Pipeline"],
    ["/crm/birou", "Biroul meu"],
    ["/crm/alocare", "Clienții mei"],
    ["/crm/contacte", "Contactări"],
    ["/oferte", "Oferte"],
    ["/contracte", "Contracte"],
    ["/crm/leaduri", "Lead-uri"],
    ["/crm/activitate", "Activitate & emailuri"],
    ["/taskuri", "Task-uri"],
  ];
  return `<div class="subnav">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

module.exports = {
  register,
  genereazaTaskuriContact,
  genereazaSugestii,
  blocTaskuriContact,
  blocSugestii,
  MODURI,
  REZULTATE,
};
