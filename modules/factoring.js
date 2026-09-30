"use strict";
// Factoringul: ce clienți sunt cesionați, la ce bancă, cu ce procent.
//
// Ce e factoringul, pe scurt: banca ne dă banii pe factură înainte să
// plătească clientul, iar clientul plătește apoi direct băncii. Ca să fie
// valabil, factura trebuie să poarte pe ea clauza de cesiune cu IBAN-ul
// băncii. Fără clauză, clientul plătește în contul nostru, banca nu-și
// recuperează avansul, și rămânem noi datori. De-aia textul stă aici, la
// vedere, nu îngropat într-un șablon.
//
// Pagina asta e singura sursă de adevăr pentru trei lucruri:
//   1. cine e în factoring (lista de clienți),
//   2. la ce bancă și cu ce procent de finanțare,
//   3. ce text exact se lipește pe factura clientului ăluia.
//
// Restul aplicației (emiterea facturii, comisionul agenților) întreabă de
// aici prin `notaPentruPartener()` și `clientulEInFactoring()`. Așa nu se
// poate întâmpla să scrie o pagină una și alta altceva.
const db = require("../lib/db");
const { deschisa, SUB_TOTAL, SUB_PLATIT } = require("../lib/solduri");
const { esc, money, layout, table, subnavFinanciar } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function nr(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function poateVedea(user) {
  return user && ["admin", "financiar"].includes(user.rol);
}

// ---- textul care ajunge pe factură ---------------------------------------
//
// Se compune din trei bucăți, în ordinea asta:
//   „Contract nr. …" (doar cine are unul) + clauza băncii + observațiile.
// Dacă clientul are notă proprie scrisă de mână, aia bate tot: sunt cazuri
// în care banca cere o formulare anume pentru un anumit client.
function compuneNota(rand) {
  if (rand && String(rand.nota_proprie || "").trim()) return String(rand.nota_proprie).trim();
  const clauza = String((rand && rand.clauza) || "").replace(/\{IBAN\}/g, String((rand && rand.iban) || "").trim());
  const bucati = [String((rand && rand.contract_nr) || "").trim(), clauza.trim()].filter(Boolean);
  return bucati.join(" ");
}

const SELECT_CLIENTI = `
  SELECT fc.id, fc.partener_id, fc.banca_id, fc.procent_finantare, fc.contract_nr,
         fc.nota_proprie, fc.observatii, fc.adaugat_la,
         p.nume AS client, p.cui,
         b.nume AS banca, b.iban, b.clauza
    FROM factoring_clienti fc
    JOIN parteneri p ON p.id = fc.partener_id
    LEFT JOIN factoring_banci b ON b.id = fc.banca_id
   WHERE fc.activ = 1`;

// Soldul deschis al unui client, cu TVA — din el se calculează cât ne
// finanțează banca acum.
const SOLD_PE_CLIENT = `
  SELECT f.partener_id, COUNT(*) AS facturi, COALESCE(SUM(COALESCE(t.total,0) - COALESCE(pl.platit,0)), 0) AS rest
    FROM (SELECT * FROM facturi WHERE activ = 1) f
    LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
    LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
   WHERE f.directie = 'vanzare' AND ${deschisa("f")}
     AND COALESCE(t.total,0) - COALESCE(pl.platit,0) > 1
   GROUP BY f.partener_id`;

async function clientiFactoring() {
  const randuri = await db.prepare(`${SELECT_CLIENTI} ORDER BY p.nume`).all();
  const solduri = await db.prepare(SOLD_PE_CLIENT).all();
  const dupaPartener = new Map(solduri.map((s) => [Number(s.partener_id), s]));
  return randuri.map((r) => {
    const s = dupaPartener.get(Number(r.partener_id)) || {};
    const rest = nr(s.rest);
    return {
      ...r,
      rest,
      facturi_deschise: nr(s.facturi),
      finantabil: (rest * nr(r.procent_finantare)) / 100,
      nota: compuneNota(r),
    };
  });
}

// Întrebat de restul aplicației: clientul ăsta e în factoring, și dacă da,
// ce text trebuie pus pe factură?
async function notaPentruPartener(partenerId) {
  if (!partenerId) return null;
  const r = await db.prepare(`${SELECT_CLIENTI} AND fc.partener_id = ?`).get(partenerId);
  if (!r) return null;
  return {
    banca: r.banca || "",
    procent: nr(r.procent_finantare),
    nota: compuneNota(r),
  };
}

async function clientulEInFactoring(partenerId) {
  return Boolean(await notaPentruPartener(partenerId));
}

function register(router) {
  router.get("/financiar/factoring", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");

    const clienti = await clientiFactoring();
    const banci = await db.prepare("SELECT * FROM factoring_banci WHERE activ = 1 ORDER BY id").all();
    const mesaj = String(ctx.query.mesaj || "");
    const eroare = String(ctx.query.eroare || "");
    const cauta = String(ctx.query.cauta || "").trim();

    // Căutarea clientului de adăugat merge prin adresă, nu prin AJAX — se
    // vede ce ai căutat și poți da refresh fără să pierzi pagina.
    const gasiti =
      cauta.length >= 2
        ? await db
            .prepare(
              `SELECT p.id, p.nume, p.cui, COUNT(f.id) AS facturi
                 FROM parteneri p
                 LEFT JOIN facturi f ON f.partener_id = p.id AND f.directie = 'vanzare' AND f.activ = 1
                WHERE LOWER(p.nume) LIKE LOWER(?)
                  AND NOT EXISTS (SELECT 1 FROM factoring_clienti fc WHERE fc.partener_id = p.id AND fc.activ = 1)
                GROUP BY p.id, p.nume, p.cui
                ORDER BY facturi DESC, p.nume
                LIMIT 15`
            )
            .all(`%${cauta}%`)
        : [];

    const totalRest = clienti.reduce((s, c) => s + c.rest, 0);
    const totalFinantabil = clienti.reduce((s, c) => s + c.finantabil, 0);
    const faraNota = clienti.filter((c) => !c.nota).length;

    const optiuniBanca = (alesId) =>
      banci
        .map((b) => `<option value="${b.id}"${Number(alesId) === Number(b.id) ? " selected" : ""}>${esc(b.nume)}</option>`)
        .join("");

    const randuriClienti = clienti.map((c) => [
      `<a href="/parteneri/${c.partener_id}">${esc(c.client)}</a>${
        c.cui ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(String(c.cui))}</span>` : ""
      }`,
      `<form method="post" action="/financiar/factoring/client/${c.id}" style="display:grid;grid-template-columns:1fr;gap:6px;min-width:520px">
         <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
           <select name="banca" style="padding:5px 7px;border:1px solid var(--border);border-radius:5px">${optiuniBanca(c.banca_id)}</select>
           <label style="font-size:12px;color:var(--text-muted)">finanțare</label>
           <input name="procent" type="number" step="0.01" min="0" max="100" value="${nr(c.procent_finantare)}"
                  style="width:80px;padding:5px 7px;border:1px solid var(--border);border-radius:5px"> %
           <input name="contract" value="${esc(String(c.contract_nr || ""))}" placeholder="Contract nr. … (dacă are)"
                  style="flex:1;min-width:220px;padding:5px 7px;border:1px solid var(--border);border-radius:5px">
         </div>
         <textarea name="nota_proprie" rows="2" placeholder="Lasă gol ca să se folosească clauza băncii de mai jos. Scrie aici doar dacă acest client cere alt text."
                   style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;font-size:12px">${esc(String(c.nota_proprie || ""))}</textarea>
         <div style="display:flex;gap:6px">
           <button class="btn small" type="submit">Salvează</button>
         </div>
       </form>`,
      c.nota
        ? `<div style="max-width:520px;font-size:12px;line-height:1.45;background:var(--bg-soft,#f6f6f4);border:1px solid var(--border);border-radius:6px;padding:8px">${esc(c.nota)}</div>`
        : `<span class="badge rosu">fără text</span>`,
      `${money(c.rest)}<br><span style="font-size:11px;color:var(--text-muted)">${c.facturi_deschise} facturi deschise</span>`,
      `<strong>${money(c.finantabil)}</strong>`,
      `<form method="post" action="/financiar/factoring/client/${c.id}/scoate" class="inline-form"
             onsubmit="return confirm('Scoți ${esc(String(c.client)).replace(/'/g, "")} din factoring? Facturile viitoare nu vor mai purta clauza.')">
         <button class="link-btn danger" type="submit">scoate</button>
       </form>`,
    ]);

    const body = `
      ${subnavFinanciar("/financiar/factoring", ctx.user)}
      ${mesaj ? `<div class="flash">${esc(mesaj)}</div>` : ""}
      ${eroare ? `<div class="flash warn">${esc(eroare)}</div>` : ""}

      <div class="detail-box">
        <p style="margin-top:0;max-width:900px">
          Clientul cesionat plătește direct băncii, nu nouă. Ca să fie valabil, <strong>factura lui trebuie să poarte
          clauza de cesiune cu IBAN-ul băncii</strong> — fără ea, clientul plătește în contul nostru și cesiunea nu se
          stinge. Textul de mai jos e exact ce se lipește pe factură.
        </p>
        <p class="mic" style="margin-bottom:0;color:var(--text-muted)">
          Procentul de finanțare e cât dă banca acum, din totalul cu TVA. Restul intră când plătește clientul.
        </p>
      </div>

      <div class="cards">
        <div class="card"><div class="label">Clienți în factoring</div><div class="value">${clienti.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">${
            faraNota ? `<span style="color:var(--danger)">${faraNota} fără text de inserat</span>` : "toți au text de inserat"
          }</div></div>
        <div class="card"><div class="label">Sold deschis la ei</div><div class="value">${money(totalRest)}</div>
          <div style="font-size:12px;color:var(--text-muted)">cu TVA, facturi neîncasate</div></div>
        <div class="card"><div class="label">Finanțabil acum</div><div class="value">${money(totalFinantabil)}</div>
          <div style="font-size:12px;color:var(--text-muted)">la procentele de mai jos</div></div>
      </div>

      <h2>Clienții cesionați</h2>
      ${
        clienti.length
          ? table(["Client", "Bancă, procent, contract", "Textul care se pune pe factură", "Sold deschis", "Finanțabil", ""], randuriClienti)
          : `<p style="color:var(--text-muted)">Niciun client în factoring încă.</p>`
      }

      <h2>Adaugă un client în factoring</h2>
      <form class="filtre" method="get" action="/financiar/factoring" style="margin-bottom:10px">
        <input name="cauta" value="${esc(cauta)}" placeholder="Numele clientului (ex: emag)"
               style="min-width:280px;padding:7px 10px;border:1px solid var(--border);border-radius:6px">
        <button class="btn secondary" type="submit">Caută</button>
        ${cauta ? `<a class="link-btn" href="/financiar/factoring">renunță</a>` : ""}
      </form>
      ${
        !cauta
          ? ""
          : gasiti.length
            ? table(
                ["Client", "CUI", "Facturi", ""],
                gasiti.map((g) => [
                  esc(String(g.nume)),
                  esc(String(g.cui || "—")),
                  String(nr(g.facturi)),
                  `<form method="post" action="/financiar/factoring/client" style="display:flex;gap:6px;align-items:center">
                     <input type="hidden" name="partener" value="${g.id}">
                     <select name="banca" style="padding:5px 7px;border:1px solid var(--border);border-radius:5px">${optiuniBanca(banci[0] && banci[0].id)}</select>
                     <input name="procent" type="number" step="0.01" min="0" max="100" value="${nr(banci[0] && banci[0].procent_implicit) || 85}"
                            style="width:70px;padding:5px 7px;border:1px solid var(--border);border-radius:5px"> %
                     <input name="contract" placeholder="Contract nr. (opțional)" style="width:190px;padding:5px 7px;border:1px solid var(--border);border-radius:5px">
                     <button class="btn small" type="submit">adaugă</button>
                   </form>`,
                ])
              )
            : `<p class="nota">Niciun client nou pentru „${esc(cauta)}". Ori se scrie altfel, ori e deja în factoring.</p>`
      }

      <h2>Băncile și clauza lor</h2>
      <p class="mic" style="max-width:900px;color:var(--text-muted)">
        Clauza e un șablon: <code>{IBAN}</code> se înlocuiește singur cu IBAN-ul de alături, ca să nu fie scris
        de două ori și să nu poată ieși din sincron. Ce schimbi aici se schimbă pe toate facturile viitoare
        ale tuturor clienților băncii — facturile deja emise rămân cum au fost.
      </p>
      ${banci
        .map(
          (b) => `
        <form method="post" action="/financiar/factoring/banca/${b.id}" class="detail-box" style="margin-bottom:12px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
            <input name="nume" value="${esc(String(b.nume || ""))}" style="flex:1;min-width:260px;padding:7px 10px;border:1px solid var(--border);border-radius:6px">
            <input name="iban" value="${esc(String(b.iban || ""))}" placeholder="IBAN" style="width:280px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-family:monospace">
            <label style="font-size:12px;color:var(--text-muted)">implicit</label>
            <input name="procent" type="number" step="0.01" min="0" max="100" value="${nr(b.procent_implicit)}"
                   style="width:80px;padding:7px 10px;border:1px solid var(--border);border-radius:6px"> %
          </div>
          <textarea name="clauza" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.5">${esc(String(b.clauza || ""))}</textarea>
          <div style="margin-top:8px"><button class="btn small" type="submit">Salvează banca</button></div>
        </form>`
        )
        .join("")}

      <form method="post" action="/financiar/factoring/banca" class="inline-form">
        <button class="btn secondary small" type="submit">+ Adaugă o bancă</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Factoring", active: "/financiar", body }));
  });

  const inapoi = (cheie, text) => `/financiar/factoring?${cheie}=${encodeURIComponent(text)}`;

  router.post("/financiar/factoring/client", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");
    const partenerId = nr(ctx.body.partener);
    if (!partenerId) return redirect(ctx.res, inapoi("eroare", "N-am înțeles ce client să adaug."));
    const p = await db.prepare("SELECT id, nume FROM parteneri WHERE id = ?").get(partenerId);
    if (!p) return redirect(ctx.res, inapoi("eroare", "Clientul nu există."));
    const deja = await db
      .prepare("SELECT id FROM factoring_clienti WHERE partener_id = ? AND activ = 1")
      .get(partenerId);
    if (deja) return redirect(ctx.res, inapoi("eroare", `${p.nume} e deja în factoring.`));

    const procent = Math.min(100, Math.max(0, nr(ctx.body.procent) || 85));
    await db
      .prepare(
        `INSERT INTO factoring_clienti (partener_id, banca_id, procent_finantare, contract_nr, adaugat_de, activ)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(partenerId, nr(ctx.body.banca) || null, procent, String(ctx.body.contract || "").trim() || null, ctx.user.id);
    redirect(ctx.res, inapoi("mesaj", `${p.nume} a intrat în factoring, cu ${procent}% finanțare.`));
  });

  router.post("/financiar/factoring/client/:id/scoate", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");
    const r = await db
      .prepare("SELECT fc.id, p.nume FROM factoring_clienti fc JOIN parteneri p ON p.id = fc.partener_id WHERE fc.id = ?")
      .get(ctx.params.id);
    if (!r) return redirect(ctx.res, inapoi("eroare", "Rândul nu există."));
    await db.prepare("UPDATE factoring_clienti SET activ = 0, actualizat_la = ? WHERE id = ?").run(acum(), r.id);
    redirect(ctx.res, inapoi("mesaj", `${r.nume} a ieșit din factoring. Facturile viitoare nu mai poartă clauza.`));
  });

  router.post("/financiar/factoring/client/:id", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");
    const r = await db
      .prepare("SELECT fc.id, p.nume FROM factoring_clienti fc JOIN parteneri p ON p.id = fc.partener_id WHERE fc.id = ?")
      .get(ctx.params.id);
    if (!r) return redirect(ctx.res, inapoi("eroare", "Rândul nu există."));
    const procent = Math.min(100, Math.max(0, nr(ctx.body.procent)));
    await db
      .prepare(
        `UPDATE factoring_clienti
            SET banca_id = ?, procent_finantare = ?, contract_nr = ?, nota_proprie = ?, actualizat_la = ?
          WHERE id = ?`
      )
      .run(
        nr(ctx.body.banca) || null,
        procent,
        String(ctx.body.contract || "").trim() || null,
        String(ctx.body.nota_proprie || "").trim() || null,
        acum(),
        r.id
      );
    redirect(ctx.res, inapoi("mesaj", `${r.nume}: salvat, ${procent}% finanțare.`));
  });

  router.post("/financiar/factoring/banca/:id", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");
    const b = await db.prepare("SELECT id FROM factoring_banci WHERE id = ?").get(ctx.params.id);
    if (!b) return redirect(ctx.res, inapoi("eroare", "Banca nu există."));
    const nume = String(ctx.body.nume || "").trim();
    if (!nume) return redirect(ctx.res, inapoi("eroare", "Banca are nevoie de un nume."));
    await db
      .prepare("UPDATE factoring_banci SET nume = ?, iban = ?, procent_implicit = ?, clauza = ?, actualizat_la = ? WHERE id = ?")
      .run(
        nume,
        String(ctx.body.iban || "").trim() || null,
        Math.min(100, Math.max(0, nr(ctx.body.procent))),
        String(ctx.body.clauza || "").trim(),
        acum(),
        b.id
      );
    redirect(ctx.res, inapoi("mesaj", `${nume}: salvat. Clauza nouă merge pe facturile de acum înainte.`));
  });

  router.post("/financiar/factoring/banca", async (ctx) => {
    if (!poateVedea(ctx.user)) return redirect(ctx.res, "/");
    await db
      .prepare("INSERT INTO factoring_banci (nume, procent_implicit, clauza, activ) VALUES (?, 85, '', 1)")
      .run("Bancă nouă — completează");
    redirect(ctx.res, inapoi("mesaj", "Am adăugat o bancă goală. Completeaz-o mai jos."));
  });
}

module.exports = { register, notaPentruPartener, clientulEInFactoring, clientiFactoring, compuneNota };
