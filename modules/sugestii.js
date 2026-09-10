"use strict";
// Sugestii de clienți noi — firme găsite pe internet care ar putea consuma
// ambalaje: folie stretch la paletizare, cutii de carton, plicuri de curierat,
// etichete.
//
// Regula cerută de Vali: TOȚI agenții văd ACEEAȘI listă, iar cine se mișcă
// primul ia clientul. De-aia nu împărțim sugestiile pe agenți și nu ascundem
// nimic — competiția e pe viteză, nu pe cine a primit ce.
//
// Preluarea e o cursă reală: doi agenți pot apăsa în aceeași secundă. Nu ne
// bazăm pe ce s-a afișat în pagină, ci pe un UPDATE condiționat de starea
// 'disponibil'. Cine îl execută primul câștigă, al doilea primește un mesaj
// clar, nu un client duplicat.
//
// Datele de contact sunt cele găsite public și pot lipsi — un câmp gol e mai
// bun decât unul ghicit. „Sursa" e linkul de unde a fost luat contactul, ca
// agentul să verifice singur înainte să sune.
const db = require("../lib/db");
const { esc, layout, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Câte sugestii disponibile vrem să existe tot timpul. Sub pragul ăsta,
// pagina o spune pe față, iar rularea de dimineață caută altele noi.
const TINTA_DISPONIBILE = 20;

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function stele(scor) {
  const n = Math.min(5, Math.max(1, Number(scor) || 3));
  return `<span title="${n} din 5 — cât de probabil e să consume ambalaje în volum">${"●".repeat(n)}<span style="color:var(--border)">${"●".repeat(5 - n)}</span></span>`;
}

// Contactele, în ordinea în care le folosește un agent: sună, apoi scrie,
// apoi se uită pe site. Ce lipsește nu se inventează — se spune că lipsește.
function contacte(s) {
  const bucati = [];
  if (s.telefon) bucati.push(`<a href="tel:${esc(String(s.telefon).replace(/\s/g, ""))}">${esc(s.telefon)}</a>`);
  if (s.email) bucati.push(`<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`);
  if (s.site) bucati.push(`<a href="${esc(s.site)}" target="_blank" rel="noopener">site</a>`);
  if (!bucati.length) return `<span style="color:var(--text-muted)">fără contact public — caută pe site</span>`;
  return bucati.join(" · ");
}

function card(s, eDisponibil) {
  const loc = [s.oras, s.judet].filter(Boolean).join(", ");
  return `
    <div class="sug">
      <div class="sug-cap">
        <span class="sug-nume">${esc(s.nume)}</span>
        ${s.domeniu ? `<span class="sug-meta">${esc(s.domeniu)}</span>` : ""}
        ${loc ? `<span class="sug-meta">${esc(loc)}</span>` : ""}
        <span class="sug-scor">${stele(s.scor)}</span>
      </div>
      <div class="sug-contact">${contacte(s)}${s.persoana ? ` · ${esc(s.persoana)}` : ""}${s.cui ? ` · CUI ${esc(s.cui)}` : ""}</div>
      ${s.motiv ? `<p class="sug-motiv">${esc(s.motiv)}</p>` : ""}
      <div class="sug-jos">
        ${s.sursa ? `<a class="sug-sursa" href="${esc(s.sursa)}" target="_blank" rel="noopener">de unde am luat datele</a>` : "<span></span>"}
        ${
          eDisponibil
            ? `<form method="post" action="/crm/sugestii/${Number(s.id)}/ia">
                 <button class="btn" type="submit">Ia clientul</button>
               </form>`
            : `<span class="sug-luat">luat de ${esc(s.luat_nume || "cineva")}${s.luat_la ? ` · ${esc(String(s.luat_la).slice(0, 10))}` : ""}</span>`
        }
      </div>
    </div>`;
}

const STIL = `
  <style>
    .sug-lista { display:flex; flex-direction:column; gap:10px; }
    .sug { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:12px 14px;
           display:flex; flex-direction:column; gap:4px; }
    .sug-cap { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
    .sug-nume { font-weight:600; font-size:1.02rem; }
    .sug-meta { color:var(--text-muted); font-size:13px; }
    .sug-scor { margin-left:auto; color:var(--primary); letter-spacing:1px; font-size:12px; }
    .sug-contact { font-size:13px; }
    .sug-motiv { margin:4px 0 0; font-size:13px; color:var(--text-muted); }
    .sug-jos { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:8px;
               padding-top:8px; border-top:1px dashed var(--border); }
    .sug-sursa { font-size:12px; color:var(--text-muted); }
    .sug-luat { font-size:13px; color:var(--text-muted); }
  </style>`;

function register(router) {
  router.get("/crm/sugestii", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const mesaj = String(ctx.query.m || "");

    const disponibile = await db
      .prepare(
        `SELECT * FROM sugestii_clienti WHERE stare = 'disponibil'
          ORDER BY scor DESC, id LIMIT 60`
      )
      .all();
    const luate = await db
      .prepare(
        `SELECT s.*, u.nume AS luat_nume FROM sugestii_clienti s
           LEFT JOIN utilizatori u ON u.id = s.luat_de
          WHERE s.stare = 'luat' ORDER BY s.luat_la DESC LIMIT 10`
      )
      .all();

    const subTinta = disponibile.length < TINTA_DISPONIBILE;
    const banner =
      mesaj === "luat"
        ? `<div class="detail-box" style="border-color:var(--success)">Clientul e al tău: l-am creat în parteneri și ți l-am alocat 100%.</div>`
        : mesaj === "tarziu"
        ? `<div class="detail-box" style="border-color:var(--warn)">Cineva a luat clientul înaintea ta. Se întâmplă — lista e aceeași pentru toți.</div>`
        : "";

    const body = `
      ${subnavCrm("/crm/sugestii", ctx.user)}
      ${STIL}
      <h1>Sugestii de clienți noi</h1>
      ${banner}
      <p style="max-width:760px;color:var(--text-muted)">
        Firme găsite pe internet care ar putea consuma ambalaje. Lista e aceeași pentru toți agenții:
        <strong>cine apasă primul, ia clientul</strong> — se creează în parteneri și rămâne alocat 100% lui.
        Datele de contact sunt cele publicate de firmă; unde lipsesc, câmpul e gol, nu ghicit.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Disponibile acum</div>
          <div class="value" style="color:${subTinta ? "var(--warn)" : "inherit"}">${disponibile.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">${subTinta ? `sub ținta de ${TINTA_DISPONIBILE} — se completează la următoarea rulare` : `ținta e ${TINTA_DISPONIBILE}`}</div></div>
        <div class="card"><div class="label">Luate până acum</div>
          <div class="value">${(await db.prepare("SELECT COUNT(*) AS n FROM sugestii_clienti WHERE stare = 'luat'").get()).n}</div></div>
      </div>

      ${
        disponibile.length
          ? `<div class="sug-lista">${disponibile.map((s) => card(s, true)).join("")}</div>`
          : `<p style="color:var(--text-muted)">Nicio sugestie disponibilă. Lista se completează automat.</p>`
      }

      ${
        luate.length
          ? `<h2>Luate recent</h2><div class="sug-lista">${luate.map((s) => card(s, false)).join("")}</div>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Sugestii de clienți", active: "/crm/sugestii", body }));
  });

  // Preluarea. Ordinea contează: întâi „prindem" sugestia cu un UPDATE
  // condiționat, abia apoi creăm partenerul. Invers, doi agenți simultani ar
  // crea doi parteneri pentru aceeași firmă și numai unul ar rămâne cu ea.
  router.post("/crm/sugestii/:id/ia", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isFinite(id)) return redirect(ctx.res, "/crm/sugestii");

    const t = acum();
    const prins = await db
      .prepare("UPDATE sugestii_clienti SET stare = 'luat', luat_de = ?, luat_la = ? WHERE id = ? AND stare = 'disponibil'")
      .run(ctx.user.id, t, id);
    if (!prins.changes) return redirect(ctx.res, "/crm/sugestii?m=tarziu");

    const s = await db.prepare("SELECT * FROM sugestii_clienti WHERE id = ?").get(id);

    // Dacă firma există deja în parteneri, nu facem un dublet: legăm sugestia
    // de partenerul existent și lăsăm alocarea lui în pace.
    let existent = null;
    if (s.cui) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(COALESCE(cui,'')) = LOWER(?) AND COALESCE(cui,'') <> ''").get(s.cui);
    if (!existent) existent = await db.prepare("SELECT id FROM parteneri WHERE LOWER(nume) = LOWER(?)").get(s.nume);

    if (existent) {
      await db.prepare("UPDATE sugestii_clienti SET partener_id = ? WHERE id = ?").run(existent.id, id);
      return redirect(ctx.res, `/parteneri/${existent.id}`);
    }

    const ins = await db
      .prepare(
        `INSERT INTO parteneri (tip, nume, cui, email, telefon, persoana_contact, stare, sursa)
         VALUES ('client', ?, ?, ?, ?, ?, 'lead', ?) RETURNING id`
      )
      .run(
        s.nume,
        s.cui || null,
        s.email || null,
        s.telefon || null,
        s.persoana || null,
        `sugestie: ${s.sursa || "căutare web"}`.slice(0, 200)
      );
    const partenerId = ins.lastInsertRowid;

    // Alocare 100% celui care a apăsat, indiferent de rol: aici nu e un
    // client introdus din birou, e unul pe care cineva l-a revendicat.
    await db
      .prepare("INSERT INTO alocari_clienti (partener_id, utilizator_id, procent, observatii) VALUES (?, ?, 100, ?)")
      .run(partenerId, ctx.user.id, "luat din sugestii de clienți");
    await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(ctx.user.id, partenerId);
    await db.prepare("UPDATE sugestii_clienti SET partener_id = ? WHERE id = ?").run(partenerId, id);

    // Motivul pentru care merită sunat nu are rost să se piardă: intră ca
    // primă notă pe client, ca agentul să aibă cu ce începe discuția.
    if (s.motiv) {
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'nota', ?, ?, ?)")
        .run(partenerId, "De ce l-am sugerat", String(s.motiv).slice(0, 1000), ctx.user.id);
    }
    redirect(ctx.res, `/parteneri/${partenerId}`);
  });
}

module.exports = { register, TINTA_DISPONIBILE };
