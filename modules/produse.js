"use strict";
const db = require("../lib/db");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const fuziune = require("../lib/produse-fuziune");

const TIPURI = [["text", "text liber"], ["numar", "număr"], ["lista", "listă de valori"]];

function register(router) {
  registerCrud(router, {
    path: "/produse",
    table: "produse",
    title: "Produse",
    singular: "produs",
    fields: [
      { name: "cod", label: "Cod produs" },
      { name: "denumire", label: "Denumire", required: true },
      { name: "unitate_masura", label: "Unitate de măsură", default: "buc" },
      { name: "pret_vanzare", label: "Preț vânzare (fără TVA)", type: "number", step: "0.01", default: 0 },
      { name: "pret_achizitie", label: "Preț achiziție", type: "number", step: "0.01", default: 0 },
      { name: "cota_tva", label: "Cotă TVA (%)", type: "number", step: "0.01", default: 19 },
      { name: "stoc_minim", label: "Stoc minim (alertă)", type: "number", step: "0.01", default: 0 },
    ],
    listColumns: [
      { key: "cod", label: "Cod" },
      { key: "denumire", label: "Denumire", render: (r) => `<a href="/produse/${r.id}">${esc(r.denumire)}</a>` },
      { key: "unitate_masura", label: "UM" },
      { key: "pret_vanzare", label: "Preț vânzare", render: (r) => money(r.pret_vanzare) },
      { key: "cota_tva", label: "TVA", render: (r) => `${esc(r.cota_tva)}%` },
    ],
  });

  // Pagină de detaliu produs: stoc pe depozite + rețetă de fabricație (BOM) —
  // din ce alte produse (componente) e format acest produs, util pentru
  // producție. Înregistrată după registerCrud, ca să nu intre în conflict cu
  // rutele literale /produse/nou, /produse/:id/editare etc.

  // Unificarea codurilor. Înregistrată înaintea lui /produse/:id, altfel
  // "fuziune" ar fi citit ca un id de produs.
  router.get("/produse/fuziune", async (ctx) => {
    const grupe = await fuziune.posibileDuplicate(60);
    const istoric = await db
      .prepare(
        `SELECT f.*, p.denumire AS pastrat_denumire, p.cod AS pastrat_cod
           FROM produse_fuziuni f LEFT JOIN produse p ON p.id = f.pastrat_id
          ORDER BY f.id DESC LIMIT 30`
      )
      .all();

    const grupeHtml = grupe.length
      ? grupe
          .map(
            (g) => `
        <form method="post" action="/produse/fuziune/previzualizare" class="detail-box" style="margin-bottom:10px">
          <div style="font-weight:600;margin-bottom:6px">${esc(g.produse[0].denumire)} — ${g.produse.length} coduri</div>
          ${table(
            ["Păstrez", "Unific", "Cod", "Denumire", "UM"],
            g.produse.map((p, i) => [
              `<input type="radio" name="pastrat_id" value="${p.id}"${i === 0 ? " checked" : ""}>`,
              `<input type="checkbox" name="inghitit_id" value="${p.id}"${i === 0 ? "" : " checked"}>`,
              esc(p.cod) || "—",
              `<a href="/produse/${p.id}">${esc(p.denumire)}</a>`,
              esc(p.unitate_masura),
            ])
          )}
          <button class="btn small" type="submit">Vezi ce se mută</button>
        </form>`
          )
          .join("")
      : "<p>Nu am găsit denumiri care să se repete. Poți unifica și manual, de pe fișa produsului.</p>";

    const body = `
      <h1>Unificare coduri de produs</h1>
      <p style="color:var(--text-muted)">Același articol ajuns sub mai multe coduri face stocul să pară înjumătățit și marja pe produs greșită. Aici alegi codul care rămâne și le aduci pe celelalte la el. <strong>Produsul unificat nu se șterge</strong> — rămâne în bază, dezactivat, legat de cel păstrat.</p>
      <h2>Posibile duplicate, după denumire</h2>
      ${grupeHtml}
      <h2>Unificări făcute</h2>
      ${table(
        ["Când", "Păstrat", "Unificat", "Rânduri mutate"],
        istoric.map((f) => [
          esc(String(f.facut_la || "").slice(0, 16)),
          `<a href="/produse/${f.pastrat_id}">${esc(f.pastrat_denumire || f.pastrat_id)}</a>`,
          `${esc(f.inghitit_cod || "")} ${esc(f.inghitit_denumire || f.inghitit_id)}`,
          (() => { try { const m = JSON.parse(f.mutari || "{}"); return Object.entries(m).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>") || "—"; } catch (e) { return "—"; } })(),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Unificare coduri", active: "/produse", body }));
  });

  router.post("/produse/fuziune/previzualizare", async (ctx) => {
    const pastrat = parseInt(ctx.body.pastrat_id, 10) || 0;
    const inghitite = [].concat(ctx.body.inghitit_id || []).map((x) => parseInt(x, 10)).filter((x) => x && x !== pastrat);
    const prev = await fuziune.previzualizeaza(pastrat, inghitite);
    const tinta = await db.prepare("SELECT * FROM produse WHERE id = ?").get(pastrat);
    const surse = inghitite.length
      ? await db.prepare(`SELECT id, cod, denumire FROM produse WHERE id IN (${inghitite.join(",")})`).all()
      : [];

    const body = `
      <h1>Previzualizare unificare</h1>
      ${!tinta || !surse.length ? "<p>Alege un produs de păstrat și cel puțin unul de unificat.</p>" : `
      <div class="detail-box">
        <div><strong>Rămâne:</strong> ${esc(tinta.cod || "")} ${esc(tinta.denumire)} (id ${tinta.id})</div>
        <div style="margin-top:6px"><strong>Se unifică în el:</strong> ${surse.map((p) => `${esc(p.cod || "")} ${esc(p.denumire)} (id ${p.id})`).join(" · ")}</div>
      </div>
      <h2>Ce se mută, tabel cu tabel</h2>
      ${table(
        ["Tabel și coloană", "Rânduri care se mută", "Rânduri blocate"],
        prev.randuri.map((r) => [esc(r.cheie), r.eroare ? `<span style="color:var(--danger)">${esc(r.eroare)}</span>` : String(r.muta), r.blocat ? `<strong>${r.blocat}</strong>` : "—"]),
        { total: ["Total", String(prev.total), prev.blocate ? String(prev.blocate) : "—"] }
      )}
      ${prev.blocate ? `<p style="color:var(--warn)"><strong>${prev.blocate} rânduri nu se pot muta automat</strong>, pentru că în același inventar există deja și produsul păstrat. Ele rămân pe produsul vechi și se rezolvă manual, din inventarul respectiv.</p>` : ""}
      <form method="post" action="/produse/fuziune/aplica" onsubmit="return confirm('Unific definitiv? Produsele unificate rămân în bază, dezactivate.')">
        <input type="hidden" name="pastrat_id" value="${tinta.id}">
        ${surse.map((p) => `<input type="hidden" name="inghitit_id" value="${p.id}">`).join("")}
        <div class="form-actions"><button class="btn" type="submit">Unifică</button> <a class="btn secondary" href="/produse/fuziune">Renunță</a></div>
      </form>`}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Previzualizare unificare", active: "/produse", body }));
  });

  router.post("/produse/fuziune/aplica", async (ctx) => {
    const pastrat = parseInt(ctx.body.pastrat_id, 10) || 0;
    const inghitite = [].concat(ctx.body.inghitit_id || []).map((x) => parseInt(x, 10)).filter((x) => x && x !== pastrat);
    try {
      await fuziune.fuzioneaza(pastrat, inghitite, ctx.user ? ctx.user.id : null);
    } catch (e) {
      return send(ctx.res, 400, layout({ user: ctx.user, title: "Unificare eșuată", active: "/produse", body: `<p>${esc(e.message)}</p><p><a href="/produse/fuziune">Înapoi</a></p>` }));
    }
    redirect(ctx.res, `/produse/${pastrat}`);
  });

  router.get("/produse/:id", async (ctx) => {
    const produs = await db.prepare("SELECT * FROM produse WHERE id = ?").get(ctx.params.id);
    if (!produs) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/produse", body: "<p>Produs inexistent.</p>" }));

    const stocPeDepozite = await db
      .prepare(
        `SELECT d.denumire AS depozit,
                COALESCE(SUM(CASE WHEN m.tip='intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS stoc
         FROM miscari_stoc m JOIN depozite d ON d.id = m.depozit_id
         WHERE m.produs_id = ? GROUP BY d.id, d.denumire ORDER BY d.denumire`
      )
      .all(produs.id);
    const stocTotal = stocPeDepozite.reduce((s, r) => s + Number(r.stoc || 0), 0);

    const componente = await db
      .prepare(
        `SELECT rc.id, rc.cantitate, c.id AS componenta_id, c.denumire, c.unitate_masura
         FROM retete_componente rc JOIN produse c ON c.id = rc.componenta_id
         WHERE rc.produs_id = ? ORDER BY c.denumire`
      )
      .all(produs.id);

    const toateProdusele = await db.prepare("SELECT id, denumire FROM produse WHERE id != ? AND activ = 1 ORDER BY denumire").all(produs.id);
    const caracteristici = await db
      .prepare("SELECT * FROM produse_caracteristici WHERE produs_id = ? AND activ = 1 ORDER BY ordine, id")
      .all(produs.id);
    const fuzionate = await db.prepare("SELECT id, cod, denumire FROM produse WHERE fuzionat_in = ?").all(produs.id);

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Cod</div>${esc(produs.cod) || "—"}</div>
          <div><div class="k">Preț vânzare</div>${money(produs.pret_vanzare)}</div>
          <div><div class="k">Preț achiziție</div>${money(produs.pret_achizitie)}</div>
          <div><div class="k">TVA</div>${esc(produs.cota_tva)}%</div>
          <div><div class="k">Stoc minim</div>${esc(produs.stoc_minim)} ${esc(produs.unitate_masura)}</div>
          <div><div class="k">Stoc total curent</div>${esc(stocTotal)} ${esc(produs.unitate_masura)}</div>
        </div>
        <div class="toolbar" style="margin-top:10px"><a href="/produse/${produs.id}/editare" class="btn secondary small">Editează datele</a></div>
      </div>

      <h2>Stoc pe depozite / gestiuni</h2>
      ${table(
        ["Depozit", "Cantitate"],
        stocPeDepozite.map((r) => [esc(r.depozit), r.stoc])
      )}

      <h2>Rețetă de fabricație (componente)</h2>
      <p style="color:var(--text-muted);font-size:13px">Din ce alte produse (materii prime / semifabricate) e format acest produs, și în ce cantitate.</p>
      ${table(
        ["Componentă", "Cantitate necesară", "UM", ""],
        componente.map((c) => [
          esc(c.denumire),
          c.cantitate,
          esc(c.unitate_masura),
          `<form method="post" action="/produse/${produs.id}/reteta/${c.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi componenta din rețetă?')"><button type="submit" class="link-btn danger">Șterge</button></form>`,
        ])
      )}
      <h2>Caracteristici cerute la comandă</h2>
      <p style="color:var(--text-muted);font-size:13px">Se definesc una câte una. La o comandă nouă în producție, când se alege acest produs, fiecare caracteristică de mai jos devine un câmp <strong>obligatoriu</strong>. Fără ele nu se poate înregistra comanda.</p>
      ${table(
        ["Caracteristică", "Tip", "Unitate", "Valori permise", "Obligatorie", ""],
        caracteristici.map((c) => [
          esc(c.denumire),
          esc((TIPURI.find((t) => t[0] === c.tip) || ["", c.tip])[1]),
          esc(c.unitate) || "—",
          esc(c.valori) || "—",
          c.obligatoriu ? "da" : "nu",
          `<form method="post" action="/produse/${produs.id}/caracteristica/${c.id}/sterge" class="inline-form" onsubmit="return confirm('Scoți caracteristica? Comenzile vechi își păstrează valorile.')"><button type="submit" class="link-btn danger">Scoate</button></form>`,
        ])
      )}
      <form method="post" action="/produse/${produs.id}/caracteristica" class="form" style="max-width:720px">
        <div style="display:grid;grid-template-columns:1fr 150px 110px;gap:12px">
          <label class="field"><span>Denumire caracteristică</span><input name="denumire" required placeholder="Ex: Grosime, Lățime, Culoare"></label>
          <label class="field"><span>Tip</span><select name="tip">${TIPURI.map((t) => `<option value="${t[0]}">${esc(t[1])}</option>`).join("")}</select></label>
          <label class="field"><span>Unitate</span><input name="unitate" placeholder="µm, mm, kg"></label>
        </div>
        <label class="field"><span>Valori permise (doar pentru tipul „listă”, separate prin bară verticală)</span><input name="valori" placeholder="transparent|negru|alb"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="obligatoriu" value="1" checked> <span>Obligatorie la comandă</span></label>
        <button type="submit" class="btn small">Adaugă caracteristica</button>
      </form>

      ${fuzionate.length ? `<h2>Coduri unificate în acest produs</h2>${table(["Cod", "Denumire"], fuzionate.map((p) => [esc(p.cod) || "—", esc(p.denumire)]))}` : ""}

      ${
        toateProdusele.length
          ? `<form method="post" action="/produse/${produs.id}/reteta" class="form" style="max-width:480px">
              <label class="field"><span>Adaugă componentă</span>
                <select name="componenta_id" required>${toateProdusele.map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`).join("")}</select>
              </label>
              <label class="field"><span>Cantitate necesară</span><input type="number" step="0.0001" name="cantitate" value="1" required></label>
              <button type="submit" class="btn small">Adaugă în rețetă</button>
            </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Produs: ${produs.denumire}`, active: "/produse", body }));
  });

  router.post("/produse/:id/caracteristica", async (ctx) => {
    const b = ctx.body;
    const denumire = String(b.denumire || "").trim();
    if (denumire) {
      const tip = TIPURI.some((t) => t[0] === b.tip) ? b.tip : "text";
      const ultima = await db.prepare("SELECT COALESCE(MAX(ordine), 0) AS n FROM produse_caracteristici WHERE produs_id = ?").get(ctx.params.id);
      await db
        .prepare(
          `INSERT INTO produse_caracteristici (produs_id, denumire, tip, unitate, valori, obligatoriu, ordine)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ctx.params.id,
          denumire,
          tip,
          String(b.unitate || "").trim() || null,
          tip === "lista" ? String(b.valori || "").trim() || null : null,
          b.obligatoriu ? 1 : 0,
          Number(ultima.n) + 10
        );
    }
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/caracteristica/:cid/sterge", async (ctx) => {
    // Nu ștergem rândul: comenzile vechi trimit la el. Îl scoatem din uz.
    await db.prepare("UPDATE produse_caracteristici SET activ = 0 WHERE id = ? AND produs_id = ?").run(ctx.params.cid, ctx.params.id);
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/reteta", async (ctx) => {
    const { componenta_id, cantitate } = ctx.body;
    if (componenta_id && Number(cantitate) > 0) {
      await db
        .prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)")
        .run(ctx.params.id, componenta_id, Number(cantitate));
    }
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/reteta/:randId/sterge", async (ctx) => {
    await db.prepare("DELETE FROM retete_componente WHERE id = ? AND produs_id = ?").run(ctx.params.randId, ctx.params.id);
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });
}

module.exports = { register };
