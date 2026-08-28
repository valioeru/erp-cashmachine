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
const { esc, layout, table, money, subnavCrm } = require("../lib/render");
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

// Alocarea efectivă pe FACTURĂ. Regula, în ordinea priorității:
//   1. agentul pus explicit pe factură (facturi.agent_id) — 100% lui;
//   2. altfel, alocarea clientului (poate fi împărțită pe procente), luând
//      în calcul de la ce dată e valabilă;
// Facturile fără niciuna dintre ele nu generează comision — dar rutina de
// recalculare le pune pe administrator, ca să nu rămână nimic „orfan".
const ALOC_FACTURA = `(
  SELECT f.id AS factura_id, f.agent_id AS utilizator_id, 100 AS procent
    FROM facturi f
   WHERE f.agent_id IS NOT NULL
  UNION ALL
  SELECT f.id, a.utilizator_id, a.procent
    FROM facturi f
    JOIN alocari_clienti a ON a.partener_id = f.partener_id
   WHERE f.agent_id IS NULL
     AND (a.valabil_de_la IS NULL OR a.valabil_de_la <= f.data_emiterii)
  UNION ALL
  SELECT f.id, p.agent_id, 100
    FROM facturi f
    JOIN parteneri p ON p.id = f.partener_id
   WHERE f.agent_id IS NULL
     AND p.agent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM alocari_clienti a2 WHERE a2.partener_id = p.id)
)`;

// Recalculează agentul fiecărei facturi de vânzare, după regulile lui Vali:
//  - facturile recente poartă numele agentului (îl punem la import);
//  - facturile vechi ale unui client care ACUM are agent primesc același
//    agent, retroactiv;
//  - ce rămâne fără agent merge la administrator.
// Facturile pe care adminul a pus manual un agent (agent_manual = 1) nu se
// ating niciodată.
async function recalculeazaAgentiFacturi() {
  const admin = await db.prepare("SELECT id FROM utilizatori WHERE rol = 'admin' AND activ = 1 ORDER BY id LIMIT 1").get();
  // Curățăm alocările către oameni care nu mai sunt agenți (ex. cineva mutat
  // pe gestiune) — altfel facturile lor n-ar mai genera comision nimănui.
  await db.exec(`
    DELETE FROM alocari_clienti
     WHERE utilizator_id NOT IN (SELECT id FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin'))
  `);
  await db.exec(`
    UPDATE parteneri SET agent_id = NULL
     WHERE agent_id IS NOT NULL
       AND agent_id NOT IN (SELECT id FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin'))
  `);
  await db.exec(`
    UPDATE facturi SET agent_id = NULL, agent_manual = 0
     WHERE agent_id IS NOT NULL
       AND agent_id NOT IN (SELECT id FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin'))
  `);
  // 1. din alocarea clientului, valabilă la data facturii
  await db.exec(`
    UPDATE facturi SET agent_id = (
      SELECT a.utilizator_id FROM alocari_clienti a
       WHERE a.partener_id = facturi.partener_id
         AND (a.valabil_de_la IS NULL OR a.valabil_de_la <= facturi.data_emiterii)
       ORDER BY a.procent DESC, a.valabil_de_la DESC NULLS LAST LIMIT 1)
     WHERE directie = 'vanzare' AND agent_manual = 0
       AND EXISTS (SELECT 1 FROM alocari_clienti a2 WHERE a2.partener_id = facturi.partener_id)
  `);
  // 2. restul, pe administrator
  if (admin) {
    await db.prepare("UPDATE facturi SET agent_id = ? WHERE directie = 'vanzare' AND agent_manual = 0 AND agent_id IS NULL").run(admin.id);
  }
  const n = await db.prepare("SELECT COUNT(*) AS n FROM facturi WHERE directie = 'vanzare' AND agent_id IS NOT NULL").get();
  return n ? Number(n.n) : 0;
}

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


// Numele din Registrul de comenzi sunt denumiri "de gură" (Sameday, Leroy
// Merlin BR, Aquila CT), pe când facturile poartă denumirea legală (Delivery
// Solutions S.A.). Legătura dintre ele se ține în alias_parteneri: o dată
// stabilită de om, potrivirea automată o folosește la fiecare rulare.
function normNume(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(s\.?r\.?l\.?|s\.?a\.?|srl|sa|pfa|ii|impex|company|comp|com)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function gasestePartener(nume, parteneri, aliasuri) {
  const n = normNume(nume);
  if (!n) return null;
  if (aliasuri && aliasuri.has(n)) return parteneri.find((p) => p.id === aliasuri.get(n)) || null;
  return (
    parteneri.find((x) => normNume(x.nume) === n) ||
    parteneri.find((x) => normNume(x.nume).startsWith(n) && n.length >= 4) ||
    parteneri.find((x) => n.startsWith(normNume(x.nume)) && normNume(x.nume).length >= 4) ||
    null
  );
}

async function hartaAliasuri() {
  const r = await db.prepare("SELECT alias, partener_id FROM alias_parteneri").all();
  return new Map(r.map((x) => [normNume(x.alias), x.partener_id]));
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

  // Alocare automată din Registrul de comenzi ------------------------------
  // Registrul de producție are, pe fiecare comandă, codul reprezentantului de
  // vânzări (GT / IR / MM / CG) — inițialele agentului. E singura sursă reală
  // de legătură client–agent din datele existente: în SmartBill toate
  // facturile sunt emise de contul administratorului, deci raportul „Vânzări
  // pe agent" arată un singur om.
  //
  // Ce face: pentru fiecare client din registru, găsește partenerul din ERP
  // (după nume normalizat) și îi pune alocarea 100% pe agentul cu inițialele
  // respective. NU suprascrie alocările făcute manual.
  router.post("/alocari/auto", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");

    const utilizatori = await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin') ORDER BY CASE WHEN rol = 'vanzari' THEN 0 ELSE 1 END, id").all();
    const initiale = (nume) =>
      String(nume || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .split(/\s+/)
        .filter(Boolean)
        .map((c) => c[0].toUpperCase())
        .join("");
    // Un cod se potrivește dacă inițialele agentului îl conțin în orice ordine
    // (ex. „Isabela Radu" → IR; „Radu Isabela" → RI, tot IR ca mulțime).
    const potrivesteCod = (cod) => {
      const c = cod.toUpperCase();
      const sortat = (x) => x.split("").sort().join("");
      return utilizatori.find((u) => {
        const i = initiale(u.nume);
        return i === c || sortat(i) === sortat(c) || i.startsWith(c) || sortat(i).includes(sortat(c));
      });
    };

    const comenzi = await db
      .prepare("SELECT client_text, COALESCE(reprezentant, initiator) AS cod FROM comenzi_productie WHERE COALESCE(reprezentant, initiator) IS NOT NULL AND COALESCE(reprezentant, initiator) <> '' AND client_text IS NOT NULL AND client_text <> ''")
      .all();
    const peClient = new Map();
    for (const c of comenzi) {
      const cod = String(c.cod).trim().toUpperCase();
      if (!/^[A-Z]{2,3}$/.test(cod)) continue;
      const k = String(c.client_text).trim();
      if (!peClient.has(k)) peClient.set(k, {});
      peClient.get(k)[cod] = (peClient.get(k)[cod] || 0) + 1;
    }

    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele')").all();
    const aliasuri = await hartaAliasuri();
    // Alocările făcute tot automat se refac de la zero (ca o corecție de rol
    // sau de nume să se propage); cele puse de om rămân neatinse.
    if (ctx.body && String(ctx.body.reface || "") === "1") {
      await db.exec("DELETE FROM alocari_clienti WHERE observatii LIKE 'alocat automat%'");
    }
    const dejaAlocati = new Set((await db.prepare("SELECT DISTINCT partener_id FROM alocari_clienti").all()).map((r) => r.partener_id));

    let alocate = 0;
    const nepotrivite = [];
    const faraAgent = [];
    for (const [clientText, coduri] of peClient.entries()) {
      const cod = Object.entries(coduri).sort((a, b) => b[1] - a[1])[0][0];
      const agent = potrivesteCod(cod);
      if (!agent) { faraAgent.push(`${clientText} (cod ${cod})`); continue; }
      const p = await gasestePartener(clientText, parteneri, aliasuri);
      if (!p) { nepotrivite.push(`${clientText} (cod ${cod})`); continue; }
      if (dejaAlocati.has(p.id)) continue;
      await db.prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, observatii) VALUES (?, ?, 100, ?)").run(p.id, agent.id, `alocat automat din registrul de comenzi (cod ${cod})`);
      await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(agent.id, p.id);
      dejaAlocati.add(p.id);
      alocate++;
    }

    const body = `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Clienți în registrul de comenzi</div>${peClient.size}</div>
        <div><div class="k">Alocați acum</div><strong>${alocate}</strong></div>
        <div><div class="k">Fără partener potrivit în ERP</div>${nepotrivite.length}</div>
        <div><div class="k">Cod fără agent în ERP</div>${faraAgent.length}</div>
      </div></div>
      ${nepotrivite.length ? `<h2>Clienți din registru pe care nu i-am găsit în ERP</h2><ul>${nepotrivite.slice(0, 40).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${faraAgent.length ? `<h2>Coduri de reprezentant fără utilizator în ERP</h2><ul>${faraAgent.slice(0, 40).map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p style="font-size:13px;color:var(--text-muted)">Creează utilizatorii lipsă (Utilizatori → Adaugă) cu numele complet, apoi rulează din nou alocarea automată.</p>` : ""}
      <div class="toolbar">
        <a class="btn secondary" href="/alocari">Înapoi la alocări</a>
        ${nepotrivite.length ? `<a class="btn" href="/alocari/registru">Leagă numele nepotrivite de clienți</a>` : ""}
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Alocare automată din registrul de comenzi", active: "/alocari", body }));
  });

  // Potrivirea numelor din Registrul de comenzi cu clienții reali ----------
  // Ecranul unde omul leagă „Sameday" de „DELIVERY SOLUTIONS S.A." o singură
  // dată. Legătura se salvează ca alias și e folosită automat la fiecare
  // alocare ulterioară.
  router.get("/alocari/registru", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const comenzi = await db
      .prepare(
        `SELECT client_text, COALESCE(reprezentant, initiator) AS cod, COUNT(*) AS nr
           FROM comenzi_productie
          WHERE client_text IS NOT NULL AND client_text <> ''
          GROUP BY client_text, COALESCE(reprezentant, initiator)
          ORDER BY nr DESC`
      )
      .all();
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume").all();
    const aliasuri = await hartaAliasuri();

    // pentru fiecare nume din registru: partenerul găsit (dacă există)
    const randuri = [];
    const vazut = new Set();
    for (const c of comenzi) {
      const cheie = String(c.client_text).trim();
      if (vazut.has(cheie.toLowerCase())) continue;
      vazut.add(cheie.toLowerCase());
      const p = await gasestePartener(cheie, parteneri, aliasuri);
      const prinAlias = aliasuri.has(normNume(cheie));
      randuri.push({ text: cheie, cod: c.cod || "", nr: c.nr, partener: p, prinAlias });
    }
    randuri.sort((a, b) => (a.partener ? 1 : 0) - (b.partener ? 1 : 0) || b.nr - a.nr);

    const optiuniParteneri = parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("");

    const body = `
      <p style="color:var(--text-muted);font-size:13px;max-width:820px">
        În Registrul de comenzi clienții apar cu nume de zi cu zi („Sameday", „Leroy Merlin BR"),
        iar pe facturi cu denumirea legală („DELIVERY SOLUTIONS S.A."). Leagă-le o singură dată aici —
        pe viitor, alocarea automată pe agenți le potrivește singură.
      </p>
      ${table(
        ["Nume în registru", "Reprezentant", "Comenzi", "Client în ERP", "Leagă de"],
        randuri.map((r) => [
          esc(r.text),
          esc(r.cod || "—"),
          String(r.nr),
          r.partener
            ? `<a href="/parteneri/${r.partener.id}">${esc(r.partener.nume)}</a>${r.prinAlias ? ' <span style="font-size:11px;color:var(--text-muted)">(alias)</span>' : ""}`
            : `<span style="color:var(--danger)">nepotrivit</span>`,
          `<form method="post" action="/alocari/registru/leaga" style="display:flex;gap:6px;align-items:center">
             <input type="hidden" name="alias" value="${esc(r.text)}">
             <input type="hidden" name="cod" value="${esc(r.cod || "")}">
             <select name="partener_id" style="max-width:260px"><option value="">— alege clientul —</option>${optiuniParteneri}</select>
             <button type="submit" class="btn secondary" style="padding:5px 10px">Leagă</button>
           </form>`,
        ])
      )}
      <a class="btn secondary" href="/alocari">Înapoi la alocări</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Nume din Registrul de comenzi", active: "/alocari", body }));
  });

  router.post("/alocari/registru/leaga", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const alias = String(ctx.body.alias || "").trim();
    const partenerId = parseInt(ctx.body.partener_id, 10);
    const cod = String(ctx.body.cod || "").trim().toUpperCase();
    if (!alias || !Number.isFinite(partenerId) || partenerId <= 0) return redirect(ctx.res, "/alocari/registru");

    await db.prepare("DELETE FROM alias_parteneri WHERE LOWER(alias) = LOWER(?)").run(alias);
    await db.prepare("INSERT INTO alias_parteneri (alias, partener_id, sursa) VALUES (?, ?, 'registru comenzi')").run(alias, partenerId);

    // Dacă știm și codul agentului, alocăm pe loc — asta e tot rostul legăturii.
    if (/^[A-Z]{2,3}$/.test(cod)) {
      const utilizatori = await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 AND rol IN ('vanzari','admin') ORDER BY CASE WHEN rol = 'vanzari' THEN 0 ELSE 1 END, id").all();
      const initiale = (nume) =>
        String(nume || "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((c) => c[0].toUpperCase())
          .join("");
      const sortat = (x) => x.split("").sort().join("");
      const agent = utilizatori.find((u) => {
        const i = initiale(u.nume);
        return i === cod || sortat(i) === sortat(cod) || i.startsWith(cod);
      });
      if (agent) {
        const are = await db.prepare("SELECT 1 AS x FROM alocari_clienti WHERE partener_id = ?").get(partenerId);
        if (!are) {
          await db.prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, observatii) VALUES (?, ?, 100, ?)").run(partenerId, agent.id, `legat din registrul de comenzi (${alias}, cod ${cod})`);
          await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(agent.id, partenerId);
        }
      }
    }
    redirect(ctx.res, "/alocari/registru");
  });

  // Schimbarea agentului pe o factură ---------------------------------------
  // Adminul alege domeniul schimbării, exact cum a cerut Vali:
  //   • doar factura asta;
  //   • tot istoricul clientului (toate facturile lui, trecute și viitoare);
  //   • de la o dată încolo (facturile emise începând cu acea dată).
  router.post("/facturi/:id/agent", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, `/facturi/${ctx.params.id}`);
    const facturaId = parseInt(ctx.params.id, 10);
    const agentId = parseInt(ctx.body.agent_id, 10);
    const domeniu = String(ctx.body.domeniu || "factura");
    const deLa = String(ctx.body.de_la || "").trim();
    const f = await db.prepare("SELECT id, partener_id, data_emiterii FROM facturi WHERE id = ?").get(facturaId);
    if (!f) return redirect(ctx.res, "/facturi");
    const agentValid = Number.isFinite(agentId) && agentId > 0 ? agentId : null;

    if (domeniu === "client") {
      // alocarea clientului, de la început: rescriem alocarea și toate facturile
      await db.prepare("DELETE FROM alocari_clienti WHERE partener_id = ?").run(f.partener_id);
      if (agentValid) await db.prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent) VALUES (?, ?, 100)").run(f.partener_id, agentValid);
      await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(agentValid, f.partener_id);
      await db.prepare("UPDATE facturi SET agent_id = ?, agent_manual = 0 WHERE partener_id = ? AND directie = 'vanzare'").run(agentValid, f.partener_id);
    } else if (domeniu === "de_la" && /^\d{4}-\d{2}-\d{2}$/.test(deLa)) {
      // alocare valabilă de la o dată încolo — facturile mai vechi rămân cum sunt
      await db.prepare("DELETE FROM alocari_clienti WHERE partener_id = ? AND valabil_de_la = ?").run(f.partener_id, deLa);
      if (agentValid) await db.prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, valabil_de_la) VALUES (?, ?, 100, ?)").run(f.partener_id, agentValid, deLa);
      await db.prepare("UPDATE facturi SET agent_id = ?, agent_manual = 0 WHERE partener_id = ? AND directie = 'vanzare' AND data_emiterii >= ?").run(agentValid, f.partener_id, deLa);
    } else {
      // doar factura asta — și o marcăm, ca recalculările să n-o mai atingă
      await db.prepare("UPDATE facturi SET agent_id = ?, agent_manual = 1 WHERE id = ?").run(agentValid, facturaId);
    }
    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  // Recalcularea agenților pe toate facturile (buton în pagina de alocări).
  router.post("/alocari/recalculeaza", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const n = await recalculeazaAgentiFacturi();
    const peAgent = await db
      .prepare(
        `SELECT u.nume, COUNT(*) AS nr FROM facturi f JOIN utilizatori u ON u.id = f.agent_id
          WHERE f.directie = 'vanzare' GROUP BY u.nume ORDER BY nr DESC`
      )
      .all();
    const body = `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Facturi cu agent</div><strong>${n}</strong></div>
      </div></div>
      <h2>Repartizarea facturilor pe agenți</h2>
      ${table(["Agent", "Facturi"], peAgent.map((r) => [esc(r.nume), String(r.nr)]))}
      <p style="font-size:13px;color:var(--text-muted);max-width:760px">
        Facturile vechi ale unui client au primit agentul pe care clientul îl are acum.
        Ce a rămas fără agent a mers la administrator. Facturile pe care le-ai schimbat manual
        n-au fost atinse. Poți schimba oricând agentul unei facturi, din pagina facturii.
      </p>
      <a class="btn secondary" href="/alocari">Înapoi la alocări</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Recalculare agenți pe facturi", active: "/alocari", body }));
  });

  // Lista completă de clienți cu alocarea lor — locul unde adminul mută
  // clienți între agenți în masă.
  // Alocarea văzută de agent -----------------------------------------------
  // Agentul își revendică singur clienții, dar O SINGURĂ DATĂ: un client deja
  // alocat (lui sau altcuiva) nu mai poate fi mutat de el. De acolo încolo,
  // numai administratorul schimbă. Așa fiecare își face lista lui la început,
  // fără să se calce în picioare și fără să-și poată lua clienții altuia.
  router.get("/crm/alocare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const cauta = String(ctx.query.q || "").trim();

    const alocari = await db
      .prepare(`SELECT al.partener_id, al.utilizator_id, al.procent, u.nume, u.rol FROM ${ALOC} al JOIN utilizatori u ON u.id = al.utilizator_id`)
      .all();
    const peP = new Map();
    for (const a of alocari) {
      if (!peP.has(a.partener_id)) peP.set(a.partener_id, []);
      peP.get(a.partener_id).push(a);
    }

    const args = [];
    let where = "p.tip IN ('client','ambele')";
    if (cauta) { where += " AND LOWER(p.nume) LIKE ?"; args.push(`%${cauta.toLowerCase()}%`); }
    const clienti = await db
      .prepare(
        `SELECT p.id, p.nume, p.cui, p.agent_id,
                ua.nume AS agent_nume, ua.rol AS agent_rol,
                COALESCE(SUM(l.total), 0) AS vanzari12,
                MAX(f.data_emiterii) AS ultima
           FROM parteneri p
           LEFT JOIN utilizatori ua ON ua.id = p.agent_id
           LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0 AND f.data_emiterii >= ?
           LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
          WHERE ${where}
          GROUP BY p.id, p.nume, p.cui, p.agent_id, ua.nume, ua.rol
          ORDER BY vanzari12 DESC, p.nume
          LIMIT 2000`
      )
      .all(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10), ...args);

    // Din ce firmă a grupului a cumpărat fiecare — ca să se vadă și clienții
    // care vin doar de la Warehouse All, nu doar cei de la Cash Machine.
    const firmePeClient = new Map();
    for (const r of await db
      .prepare(
        `SELECT f.partener_id, fi.nume
           FROM facturi f JOIN firme fi ON fi.id = f.firma_id
          WHERE f.directie = 'vanzare' AND f.status NOT IN ('anulata','necunoscut')
          GROUP BY f.partener_id, fi.nume`
      )
      .all()) {
      if (!firmePeClient.has(r.partener_id)) firmePeClient.set(r.partener_id, []);
      firmePeClient.get(r.partener_id).push(r.nume);
    }

    // Cine ține clientul acum: alocările explicite, iar dacă nu există, agentul
    // scris pe partener (importul îl pune pe administrator când nu știe altul).
    const detinatori = (c) => {
      const l = peP.get(c.id) || [];
      if (l.length) return l;
      if (c.agent_id) return [{ utilizator_id: c.agent_id, procent: 100, nume: c.agent_nume, rol: c.agent_rol }];
      return [];
    };
    // Un client ținut de administrator e de luat: adminul îl ține doar fiindcă
    // importul n-a știut al cui e. De la un alt agent nu se ia — acolo decide
    // administratorul.
    const eLaAdmin = (l) => l.length > 0 && l.every((a) => a.rol === "admin");
    const alMeu = (l) => l.some((a) => a.utilizator_id === ctx.user.id);

    const aiMei = clienti.filter((c) => alMeu(detinatori(c)));
    const liberi = clienti.filter((c) => {
      const l = detinatori(c);
      return !alMeu(l) && (l.length === 0 || eLaAdmin(l));
    });
    const aiAltora = clienti.filter((c) => {
      const l = detinatori(c);
      return l.length && !alMeu(l) && !eLaAdmin(l);
    });

    const randClient = (c, cuBifa) => [
      cuBifa ? `<input type="checkbox" name="client" value="${c.id}">` : "",
      `<a href="/parteneri/${c.id}">${esc(c.nume)}</a>`,
      esc(c.cui || "—"),
      (firmePeClient.get(c.id) || []).map((n) => `<span class="badge gri">${esc(n.replace(/ SRL$/i, ""))}</span>`).join(" ") || "—",
      money(c.vanzari12),
      c.ultima ? esc(String(c.ultima).slice(0, 10)) : "—",
      detinatori(c).map((a) => `${esc(a.nume)}${a.rol === "admin" ? " (administrator)" : ""} ${Number(a.procent).toFixed(0)}%`).join(", ") ||
        `<span style="color:var(--text-muted)">nealocat</span>`,
    ];
    const CAP = ["", "Client", "CUI", "Firma", "Vânzări 12 luni", "Ultima factură", "Alocare"];

    const body = `
      ${subnavCrm("/crm/alocare", ctx.user)}
      <div class="detail-box">
        <p style="margin-top:0">
          Aici îți iei clienții în portofoliu. Din încasările lor ți se calculează comisionul.
        </p>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:0">
          Poți lua clienții <strong>liberi</strong> și pe cei care stau <strong>la administrator</strong> — acolo
          au ajuns la import, fiindcă nu se știa al cui sunt. De la un alt agent nu poți lua: acolo hotărăște
          administratorul. Ce ai luat rămâne al tău până îl mută el, deci ia doar ce chiar lucrezi.
        </p>
      </div>

      <form method="get" action="/crm/alocare" class="filtre">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="caută client">
        <button type="submit" class="btn secondary">Caută</button>
      </form>

      <h2>Clienții mei (${aiMei.length})</h2>
      ${
        aiMei.length
          ? table(CAP, aiMei.map((c) => randClient(c, false)))
          : `<p style="color:var(--text-muted)">Încă n-ai niciun client. Bifează-i mai jos.</p>`
      }

      <h2>Clienți pe care îi poți lua (${liberi.length})</h2>
      ${
        liberi.length
          ? `<form method="post" action="/crm/alocare">
               ${table(["<input type=\"checkbox\" onclick=\"document.querySelectorAll('input[name=client]').forEach(c=>c.checked=this.checked)\">", ...CAP.slice(1)], liberi.map((c) => randClient(c, true)))}
               <button type="submit" class="btn" onclick="return confirm('Îi iei în portofoliu?')">Ia clienții bifați în portofoliul meu</button>
             </form>`
          : `<p style="color:var(--text-muted)">Nu mai e niciun client de luat${cauta ? " pentru căutarea asta" : ""}.</p>`
      }

      <h2>Clienții altora (${aiAltora.length})</h2>
      <p style="font-size:13px;color:var(--text-muted)">Doar informativ — ca să știi cine pe cine lucrează.</p>
      ${
        aiAltora.length
          ? table(CAP, aiAltora.slice(0, 200).map((c) => randClient(c, false)))
          : `<p style="color:var(--text-muted)">—</p>`
      }
      ${eAdmin ? `<div class="toolbar"><a class="btn secondary" href="/alocari">Ecranul de administrare al alocărilor</a></div>` : ""}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Clienții mei", active: "/crm", body }));
  });

  router.post("/crm/alocare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const brut = ctx.body.client;
    const ids = (Array.isArray(brut) ? brut : brut === undefined ? [] : [brut]).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
    let luati = 0, refuzati = 0;
    for (const id of ids) {
      // Verificăm din nou pe server, nu doar în pagină: între afișare și submit
      // se putea aloca. Regula: liber sau ținut de administrator → se poate lua.
      // Ținut de alt agent → nu, acolo hotărăște administratorul.
      const alocari = await db
        .prepare("SELECT al.utilizator_id, u.rol FROM alocari_clienti al JOIN utilizatori u ON u.id = al.utilizator_id WHERE al.partener_id = ?")
        .all(id);
      const p = await db
        .prepare("SELECT p.agent_id, u.rol AS agent_rol FROM parteneri p LEFT JOIN utilizatori u ON u.id = p.agent_id WHERE p.id = ?")
        .get(id);
      const detinatori = alocari.length ? alocari : p && p.agent_id ? [{ utilizator_id: p.agent_id, rol: p.agent_rol }] : [];
      const alMeu = detinatori.some((d) => d.utilizator_id === ctx.user.id);
      const laAdmin = detinatori.length > 0 && detinatori.every((d) => d.rol === "admin");
      if (alMeu || (detinatori.length > 0 && !laAdmin)) { refuzati++; continue; }
      // dacă îl ținea administratorul, alocarea lui se înlocuiește
      await db.prepare("DELETE FROM alocari_clienti WHERE partener_id = ?").run(id);
      await db.prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, observatii) VALUES (?, ?, 100, ?)").run(id, ctx.user.id, "revendicat de agent");
      await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(ctx.user.id, id);
      await db.prepare("UPDATE facturi SET agent_id = ? WHERE partener_id = ? AND directie = 'vanzare' AND agent_manual = 0").run(ctx.user.id, id);
      luati++;
    }
    const body = `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Clienți luați în portofoliu</div><strong>${luati}</strong></div>
        <div><div class="k">Refuzați (sunt la alt agent)</div>${refuzati}</div>
      </div></div>
      <p style="font-size:13px;color:var(--text-muted)">
        Facturile lor — și cele vechi, de la ambele firme — au trecut pe numele tău, deci intră la comision.
        Dacă ai luat pe cineva din greșeală, administratorul îl mută înapoi.
      </p>
      <div class="toolbar">
        <a class="btn" href="/crm/birou">Biroul meu</a>
        <a class="btn secondary" href="/crm/alocare">Înapoi la listă</a>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Clienți adăugați în portofoliu", active: "/crm", body }));
  });

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
      <form method="post" action="/alocari/auto" style="margin:12px 0">
        <button type="submit" class="btn secondary">Alocă automat din Registrul de comenzi</button>
        <label style="font-size:12px;margin-left:8px"><input type="checkbox" name="reface" value="1"> refă alocările automate de la zero</label>
        <a class="btn secondary" href="/alocari/registru" style="margin-left:6px">Potrivește numele din registru</a>
        <span style="font-size:12px;color:var(--text-muted);margin-left:8px">
          Folosește codul reprezentantului (GT / IR / MM / CG) de pe comenzile de producție. Nu suprascrie alocările făcute manual.
        </span>
      </form>
      <form method="post" action="/alocari/recalculeaza" style="margin:0 0 14px">
        <button type="submit" class="btn secondary">Recalculează agentul pe toate facturile</button>
        <span style="font-size:12px;color:var(--text-muted);margin-left:8px">
          Facturile vechi primesc agentul pe care clientul îl are acum; ce rămâne fără agent merge la administrator.
          Facturile schimbate manual nu se ating.
        </span>
      </form>
      ${table(["Client", "CUI", "Încasat 12 luni", "Alocare", "Modifică"], randuri)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Alocarea clienților pe agenți (${lista.length})`, active: "/alocari", body }));
  });
}

module.exports = { register, ALOC, ALOC_FACTURA, recalculeazaAgentiFacturi, alocariPentruPartener, formularAlocare };
