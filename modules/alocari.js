"use strict";
// Alocarea clienților pe agenți de vânzări — cu procent.
//
// Regula de bază: un client "aparține" unui agent, iar comisionul se
// calculează din încasările acelui client. Realitatea e însă mai nuanțată:
// un client poate fi adus de un agent și preluat de altul, sau lucrat în
// doi. De-aia alocarea nu e un simplu agent_id, ci o listă de perechi
// (agent, procent) — 70% Isabela / 30% administrator e o alocare validă.
//
// Compatibilitate: dacă un partener NU are nicio linie în alocari_clienti,
// se folosește vechiul parteneri.agent_id, la 100%. Așa nimic din ce
// exista nu se strică, iar alocările fine se adaugă doar unde chiar
// contează.
const db = require("../lib/db");
const { esc, layout, table, money } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Subinterogare folosită peste tot unde se calculează comisioane: alocarea
// EFECTIVĂ a fiecărui partener (explicită dacă există, altfel agent_id).
const ALOC = `(
  SELECT a.partener_id AS partener_id, a.utilizator_id AS utilizator_id, a.procent AS procent
    FROM alocari_clienti a
  UNION ALL
  SELECT p.id, p.agent_id, 100
    FROM parteneri p
   WHERE p.agent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM alocari_clienti a2 WHERE a2.partener_id = p.id)
)`;

async function alocariPentruPartener(partenerId) {
  const explicite = await db
    .prepare(
      `SELECT a.id, a.utilizator_id, a.procent, u.nume, u.rol
         FROM alocari_clienti a JOIN utilizatori u ON u.id = a.utilizator_id
        WHERE a.partener_id = ? ORDER BY a.procent DESC, u.nume`
    )
    .all(partenerId);
  if (explicite.length) return { explicite: true, linii: explicite };
  const p = await db
    .prepare("SELECT p.agent_id, u.nume, u.rol FROM parteneri p LEFT JOIN utilizatori u ON u.id = p.agent_id WHERE p.id = ?")
    .get(partenerId);
  if (p && p.agent_id) return { explicite: false, linii: [{ id: null, utilizator_id: p.agent_id, procent: 100, nume: p.nume, rol: p.rol }] };
  return { explicite: false, linii: [] };
}

// Formularul de alocare, refolosit și în pagina partenerului și în lista de
// alocări. Admite până la 3 agenți pe client — mai mult n-are sens practic.
function formularAlocare(partenerId, linii, utilizatori, compact) {
  const optiuni = (sel) =>
    `<option value="">— nimeni —</option>` +
    utilizatori.map((u) => `<option value="${u.id}"${Number(sel) === u.id ? " selected" : ""}>${esc(u.nume)}${u.rol === "admin" ? " (administrator)" : ""}</option>`).join("");
  const randuri = [0, 1, 2].map((i) => {
    const l = linii[i] || { utilizator_id: "", procent: i === 0 ? 100 : 0 };
    return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <select name="agent${i}" style="flex:1;min-width:150px">${optiuni(l.utilizator_id)}</select>
      <input type="number" name="procent${i}" value="${Number(l.procent) || 0}" min="0" max="100" step="0.5" style="width:74px" title="procent din încasări">
      <span style="font-size:12px;color:var(--text-muted)">%</span>
    </div>`;
  });
  return `<form method="post" action="/parteneri/${partenerId}/alocari" class="${compact ? "" : "form"}" style="${compact ? "" : "max-width:420px"}">
    ${randuri.join("")}
    <button type="submit" class="btn secondary" style="padding:6px 12px">Salvează alocarea</button>
  </form>`;
}

function register(router) {
  // Salvarea alocării unui client (doar administratorul).
  router.post("/parteneri/:id/alocari", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, `/parteneri/${ctx.params.id}`);
    const partenerId = parseInt(ctx.params.id, 10);
    const perechi = [];
    for (let i = 0; i < 3; i++) {
      const uid = parseInt(ctx.body[`agent${i}`], 10);
      const pct = Number(String(ctx.body[`procent${i}`] ?? "").replace(",", ".")) || 0;
      if (Number.isFinite(uid) && uid > 0 && pct > 0) perechi.push({ uid, pct });
    }
    // Nu lăsăm suma să treacă de 100% — altfel s-ar plăti comision de două ori.
    const suma = perechi.reduce((s, x) => s + x.pct, 0);
    if (suma > 100.001) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Alocare client",
          active: "/parteneri",
          body: `<p style="color:var(--danger)">Procentele însumează ${suma.toFixed(1)}% — maximul e 100%.</p><a class="btn secondary" href="/parteneri/${partenerId}">Înapoi la client</a>`,
        })
      );
    }
    await db.prepare("DELETE FROM alocari_clienti WHERE partener_id = ?").run(partenerId);
    for (const x of perechi) {
      await db.prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (?, ?, ?)").run(partenerId, x.uid, x.pct);
    }
    // Ținem și agent_id sincronizat cu agentul majoritar, ca listele vechi
    // (portofoliu, filtre) să arate în continuare ceva sensibil.
    const majoritar = perechi.slice().sort((a, b) => b.pct - a.pct)[0];
    await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(majoritar ? majoritar.uid : null, partenerId);
    redirect(ctx.res, ctx.body.inapoi === "lista" ? "/alocari" : `/parteneri/${partenerId}`);
  });

  // Lista completă de clienți cu alocarea lor — locul unde adminul mută
  // clienți între agenți în masă.
  router.get("/alocari", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const cauta = String(ctx.query.q || "").trim();
    const doarAgent = parseInt(ctx.query.agent, 10);
    const utilizatori = await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 AND rol IN ('admin','vanzari') ORDER BY rol DESC, nume").all();

    const args = [];
    let where = "p.tip IN ('client','ambele')";
    if (cauta) { where += " AND LOWER(p.nume) LIKE ?"; args.push(`%${cauta.toLowerCase()}%`); }

    const clienti = await db
      .prepare(
        `SELECT p.id, p.nume, p.cui,
                COALESCE(SUM(pl.suma), 0) AS incasat12
           FROM parteneri p
           LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           LEFT JOIN plati pl ON pl.factura_id = f.id AND pl.data >= ?
          WHERE ${where}
          GROUP BY p.id, p.nume, p.cui
          ORDER BY incasat12 DESC, p.nume
          LIMIT 400`
      )
      .all(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10), ...args);

    const toateAlocarile = await db
      .prepare(`SELECT al.partener_id, al.utilizator_id, al.procent, u.nume, u.rol FROM ${ALOC} al JOIN utilizatori u ON u.id = al.utilizator_id`)
      .all();
    const peP = new Map();
    for (const a of toateAlocarile) {
      if (!peP.has(a.partener_id)) peP.set(a.partener_id, []);
      peP.get(a.partener_id).push(a);
    }

    const lista = clienti.filter((c) => {
      if (!Number.isFinite(doarAgent) || doarAgent <= 0) return true;
      return (peP.get(c.id) || []).some((a) => a.utilizator_id === doarAgent);
    });

    const randuri = lista.map((c) => {
      const linii = (peP.get(c.id) || []).slice().sort((a, b) => b.procent - a.procent);
      const rezumat = linii.length
        ? linii.map((a) => `${esc(a.nume)} <strong>${Number(a.procent).toFixed(0)}%</strong>`).join("<br>")
        : `<span style="color:var(--text-muted)">nealocat</span>`;
      return [
        `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
        esc(c.cui || "—"),
        money(c.incasat12),
        rezumat,
        `<details><summary style="cursor:pointer;font-size:12px">schimbă</summary>
           <div style="padding-top:8px">${formularAlocare(c.id, linii, utilizatori, true)}<input type="hidden" name="inapoi" value="lista"></div>
         </details>`,
      ];
    });

    const body = `
      <form method="get" action="/alocari" class="filtre">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="caută client">
        <select name="agent" onchange="this.form.submit()">
          <option value="">toți agenții</option>
          ${utilizatori.map((u) => `<option value="${u.id}"${doarAgent === u.id ? " selected" : ""}>${esc(u.nume)}</option>`).join("")}
        </select>
        <button type="submit" class="btn secondary">Filtrează</button>
      </form>
      <p style="color:var(--text-muted);font-size:13px">
        Comisionul se calculează din încasările clienților alocați, proporțional cu procentul.
        Un client poate fi împărțit între doi–trei oameni (ex. 70% agent / 30% administrator);
        suma procentelor nu poate depăși 100%. Clienții fără alocare nu generează comision.
      </p>
      ${table(["Client", "CUI", "Încasat 12 luni", "Alocare", "Modifică"], randuri)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Alocarea clienților pe agenți (${lista.length})`, active: "/alocari", body }));
  });
}

module.exports = { register, ALOC, alocariPentruPartener, formularAlocare };
