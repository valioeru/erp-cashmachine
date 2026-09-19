"use strict";
// Cereri de dezvoltare — ce vrea echipa să se schimbe în soft.
//
// De ce există: până acum, ca să se schimbe ceva în aplicație trebuia să-i
// spună cineva lui Vali, iar Vali să-și amintească. Omul de la depozit vede
// prima problema din depozit, iar producția pe a ei — dar nici unul n-avea
// unde s-o scrie. Aici o scrie, cu propriile cuvinte, iar cererea nu se mai
// pierde între un telefon și un WhatsApp.
//
// Poarta: o cerere scrisă de oricine e doar o CERERE. Nu intră în lucru până
// n-o aprobă administratorul. De-aia stările sunt separate și de-aia butonul
// de aprobare e singurul lucru din pagină care cere rol de admin.
//
//   nouă → aprobată → în lucru → livrată        (sau respinsă, cu motiv)
//
// Ce poate face fiecare:
//   oricine logat  — scrie o cerere nouă, comentează pe oricare, își vede
//                    cererile proprii cum avansează
//   administrator  — aprobă, respinge, marchează în lucru sau livrată
//
// Pagina „Coada aprobată" e o listă compactă, în ordinea priorității: e ce
// citesc eu la începutul unei sesiuni de lucru, ca să știu ce urmează.

const db = require("../lib/db");
const { esc, layout, table, dateleInText } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Modulele aplicației, ca omul să nu scrie „la producție" în zece feluri.
const MODULE = [
  "Producție",
  "Depozit",
  "CRM & vânzări",
  "Financiar & facturi",
  "Rapoarte",
  "Stocuri",
  "Salarii & HR",
  "Altceva",
];

const PRIORITATI = [
  ["urgenta", "urgentă — stă treaba"],
  ["normala", "normală"],
  ["cand_se_poate", "când se poate"],
];

// Ordinea contează: e ordinea în care se citesc pe pagină și în coadă.
const STARI = [
  ["noua", "nouă", "#c07018"],
  ["aprobata", "aprobată", "#2563eb"],
  ["in_lucru", "în lucru", "#7c3aed"],
  ["livrata", "livrată", "#2f7d4f"],
  ["respinsa", "respinsă", "#8a8f98"],
];
const NUME_STARE = new Map(STARI.map(([k, e]) => [k, e]));
const CULOARE_STARE = new Map(STARI.map(([k, , c]) => [k, c]));
const RANG_PRIORITATE = { urgenta: 0, normala: 1, cand_se_poate: 2 };

const nr = (v) => Number(v || 0);
const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const eAdmin = (u) => Boolean(u && u.rol === "admin");

function pastila(stare) {
  const c = CULOARE_STARE.get(stare) || "#8a8f98";
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:${c}1a;color:${c};border:1px solid ${c}55">${esc(NUME_STARE.get(stare) || stare)}</span>`;
}

function semnPrioritate(p) {
  if (p === "urgenta") return '<span style="color:#b91c1c;font-weight:600">urgentă</span>';
  if (p === "cand_se_poate") return '<span style="color:var(--text-muted)">când se poate</span>';
  return "normală";
}

function subtabs(activ) {
  return `<div class="subnav" style="margin-top:-6px">${[
    ["/dezvoltare", "Toate cererile"],
    ["/dezvoltare/coada", "Coada aprobată"],
  ]
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

// Mesajul de după o salvare. Textul vine din adresa paginii, deci se scapă.
function mesaje(q) {
  const ok = String((q && q.ok) || "");
  const er = String((q && q.eroare) || "");
  return (
    (er ? `<div class="detail-box" style="border-left:4px solid var(--danger);max-width:860px">${esc(er)}</div>` : "") +
    (ok ? `<div class="detail-box" style="border-left:4px solid #2f7d4f;max-width:860px">${esc(ok)}</div>` : "")
  );
}

const SELECT_CERERE = `
  SELECT c.*, u.nume AS autor, d.nume AS decident,
         (SELECT COUNT(*) FROM cereri_dezvoltare_comentarii k WHERE k.cerere_id = c.id) AS comentarii
    FROM cereri_dezvoltare c
    LEFT JOIN utilizatori u ON u.id = c.creat_de
    LEFT JOIN utilizatori d ON d.id = c.decis_de`;

function register(router) {
  // ---- Lista -------------------------------------------------------------
  router.get("/dezvoltare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const q = ctx.query || {};
    const stare = String(q.stare || "").trim();
    const modul = String(q.modul || "").trim();
    const aleMele = String(q.ale_mele || "") === "1";

    const unde = [];
    const args = [];
    if (STARI.some(([k]) => k === stare)) { unde.push("c.stare = ?"); args.push(stare); }
    if (MODULE.includes(modul)) { unde.push("c.modul = ?"); args.push(modul); }
    if (aleMele) { unde.push("c.creat_de = ?"); args.push(ctx.user.id); }

    const cereri = await db
      .prepare(
        `${SELECT_CERERE}
         ${unde.length ? "WHERE " + unde.join(" AND ") : ""}
         ORDER BY CASE c.stare WHEN 'in_lucru' THEN 0 WHEN 'aprobata' THEN 1 WHEN 'noua' THEN 2
                               WHEN 'livrata' THEN 3 ELSE 4 END,
                  CASE c.prioritate WHEN 'urgenta' THEN 0 WHEN 'normala' THEN 1 ELSE 2 END,
                  c.id DESC`
      )
      .all(...args)
      .catch(() => []);

    const numara = (k) => cereri.filter((c) => c.stare === k).length;

    const optiune = (lista, ales) =>
      lista.map(([v, e]) => `<option value="${esc(v)}"${v === ales ? " selected" : ""}>${esc(e)}</option>`).join("");

    const cap = ["#", "Cererea", "Modul", "Prioritate", "Stare", "Cerută de", "Când", ""];
    const randuri = cereri.map((c) => [
      String(c.id),
      `<a href="/dezvoltare/${c.id}"><strong>${esc(c.titlu)}</strong></a>${
        nr(c.comentarii) ? ` <span class="mic" style="color:var(--text-muted)">· ${nr(c.comentarii)} comentarii</span>` : ""
      }`,
      esc(c.modul || "—"),
      semnPrioritate(c.prioritate),
      pastila(c.stare),
      esc(c.autor || "—"),
      esc(String(c.creat_la || "").slice(0, 10)),
      `<a class="btn small secondary" href="/dezvoltare/${c.id}">Deschide</a>`,
    ]);

    const body = `
      ${subtabs("/dezvoltare")}
      ${mesaje(q)}
      <h1 style="margin:6px 0 2px">Cereri de dezvoltare</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:900px">
        Aici se scrie ce ar trebui schimbat în aplicație. Scrie oricine — de la depozit, din producție, din vânzări.
        O cerere scrisă e o <strong>propunere</strong>: intră în lucru abia după ce o aprobă administratorul.
        Dacă ceva nu e clar, întreabă în comentariile cererii, nu pe telefon — așa rămâne scris de ce s-a făcut așa.
      </p>

      <div class="cards">
        ${STARI.filter(([k]) => k !== "respinsa")
          .map(
            ([k, e]) =>
              `<div class="card"><div class="label">${esc(e)}</div><div class="value">${numara(k)}</div></div>`
          )
          .join("")}
      </div>

      <details class="detail-box" style="margin:14px 0"${cereri.length ? "" : " open"}>
        <summary style="cursor:pointer;font-weight:600">+ Scrie o cerere nouă</summary>
        <form class="form" method="post" action="/dezvoltare" style="max-width:860px;margin-top:12px">
          <label class="field">Ce ar trebui schimbat, pe scurt
            <input type="text" name="titlu" maxlength="160" required placeholder="ex. La comanda de producție să se poată trece și numărul de bax-uri">
          </label>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
            <label class="field">Unde
              <select name="modul">${MODULE.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
            </label>
            <label class="field">Cât de repede
              <select name="prioritate">${optiune(PRIORITATI, "normala")}</select>
            </label>
          </div>
          <label class="field">Explică pe larg
            <textarea name="descriere" rows="5" placeholder="Ce faci acum, ce te încurcă, și cum ar trebui să fie. Dă un exemplu concret dacă poți — un număr de comandă, un produs, o zi anume."></textarea>
          </label>
          <div class="form-actions"><button class="btn" type="submit">Trimite cererea</button></div>
        </form>
      </details>

      <form class="filtre" method="get" action="/dezvoltare" style="margin-bottom:10px">
        <select name="stare" onchange="this.form.submit()">
          <option value="">toate stările</option>${optiune(STARI.map(([k, e]) => [k, e]), stare)}
        </select>
        <select name="modul" onchange="this.form.submit()">
          <option value="">toate modulele</option>${MODULE.map((m) => `<option value="${esc(m)}"${m === modul ? " selected" : ""}>${esc(m)}</option>`).join("")}
        </select>
        <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px">
          <input type="checkbox" name="ale_mele" value="1"${aleMele ? " checked" : ""} onchange="this.form.submit()"> doar ale mele
        </label>
      </form>

      ${cereri.length ? `<div class="tabel-scroll">${table(cap, randuri)}</div>` : "<p>Nicio cerere încă.</p>"}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cereri de dezvoltare", active: "/dezvoltare", body }));
  });

  router.post("/dezvoltare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body || {};
    const titlu = String(b.titlu || "").trim().slice(0, 160);
    if (!titlu) return redirect(ctx.res, "/dezvoltare?eroare=" + encodeURIComponent("Scrie măcar un titlu."));
    const modul = MODULE.includes(String(b.modul)) ? String(b.modul) : "Altceva";
    const prioritate = PRIORITATI.some(([k]) => k === String(b.prioritate)) ? String(b.prioritate) : "normala";
    const r = await db
      .prepare(
        `INSERT INTO cereri_dezvoltare (titlu, descriere, modul, prioritate, stare, creat_de, creat_la)
         VALUES (?, ?, ?, ?, 'noua', ?, ?) RETURNING id`
      )
      .run(titlu, String(b.descriere || "").trim() || null, modul, prioritate, ctx.user.id, acum());
    const id = r && r.lastInsertRowid;
    redirect(ctx.res, id ? `/dezvoltare/${id}?ok=` + encodeURIComponent("Cererea a fost trimisă. Rămâne „nouă” până o aprobă administratorul.") : "/dezvoltare");
  });

  // ---- Coada aprobată ----------------------------------------------------
  router.get("/dezvoltare/coada", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const cereri = await db
      .prepare(
        `${SELECT_CERERE}
          WHERE c.stare IN ('aprobata','in_lucru')
          ORDER BY CASE c.stare WHEN 'in_lucru' THEN 0 ELSE 1 END,
                   CASE c.prioritate WHEN 'urgenta' THEN 0 WHEN 'normala' THEN 1 ELSE 2 END,
                   c.decis_la, c.id`
      )
      .all()
      .catch(() => []);

    const body = `
      ${subtabs("/dezvoltare/coada")}
      <h1 style="margin:6px 0 2px">Coada aprobată</h1>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px;max-width:900px">
        Cererile pe care le-ai aprobat, în ordinea în care se lucrează: întâi ce e deja în lucru, apoi urgențele,
        apoi restul, în ordinea aprobării. Asta e lista pe care o citesc la începutul fiecărei sesiuni.
      </p>
      ${
        cereri.length
          ? cereri
              .map(
                (c) => `<div class="detail-box" style="max-width:900px;margin-bottom:10px;border-left:4px solid ${CULOARE_STARE.get(c.stare)}">
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
                    <strong><a href="/dezvoltare/${c.id}">#${c.id} · ${esc(c.titlu)}</a></strong>
                    <span>${pastila(c.stare)}</span>
                  </div>
                  <div style="font-size:12px;color:var(--text-muted);margin:3px 0 6px">
                    ${esc(c.modul || "—")} · ${semnPrioritate(c.prioritate)} · cerută de ${esc(c.autor || "—")}
                    ${c.decis_la ? ` · aprobată ${esc(String(c.decis_la).slice(0, 10))}` : ""}
                  </div>
                  ${c.descriere ? `<div style="font-size:13px;white-space:pre-wrap">${esc(String(c.descriere).slice(0, 600))}</div>` : ""}
                </div>`
              )
              .join("")
          : "<p>Nimic aprobat în acest moment. Cererile noi așteaptă în <a href=\"/dezvoltare?stare=noua\">lista de cereri</a>.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Coada aprobată", active: "/dezvoltare", body }));
  });

  // ---- O cerere ----------------------------------------------------------
  router.get("/dezvoltare/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const c = await db.prepare(`${SELECT_CERERE} WHERE c.id = ?`).get(ctx.params.id).catch(() => null);
    if (!c) return redirect(ctx.res, "/dezvoltare");
    const comentarii = await db
      .prepare(
        `SELECT k.*, u.nume AS autor FROM cereri_dezvoltare_comentarii k
           LEFT JOIN utilizatori u ON u.id = k.utilizator_id
          WHERE k.cerere_id = ? ORDER BY k.id`
      )
      .all(c.id)
      .catch(() => []);

    const admin = eAdmin(ctx.user);
    const buton = (stare, eticheta, clasa) =>
      `<form method="post" action="/dezvoltare/${c.id}/stare" style="display:inline">
        <input type="hidden" name="stare" value="${stare}">
        <button class="btn ${clasa || "secondary"}" type="submit">${esc(eticheta)}</button>
      </form>`;

    const actiuni = !admin
      ? ""
      : `<div class="detail-box" style="max-width:900px">
          <strong>Decizia ta</strong>
          <p style="font-size:13px;color:var(--text-muted);margin:4px 0 10px">
            O cerere intră în lucru abia după ce o aprobi. Până atunci rămâne o propunere.
          </p>
          <div class="form-actions" style="margin:0;flex-wrap:wrap;gap:8px">
            ${c.stare === "noua" ? buton("aprobata", "Aprobă", "") : ""}
            ${c.stare === "aprobata" ? buton("in_lucru", "Marchează în lucru") : ""}
            ${c.stare === "in_lucru" || c.stare === "aprobata" ? buton("livrata", "Marchează livrată") : ""}
            ${c.stare === "livrata" || c.stare === "respinsa" ? buton("noua", "Redeschide") : ""}
          </div>
          ${
            c.stare === "noua" || c.stare === "aprobata"
              ? `<form method="post" action="/dezvoltare/${c.id}/stare" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:end">
                  <input type="hidden" name="stare" value="respinsa">
                  <label class="field" style="flex:1;min-width:280px;margin:0"><span>De ce nu</span>
                    <input type="text" name="motiv" maxlength="300" placeholder="ca să știe omul de ce, nu doar că nu"></label>
                  <button class="btn secondary" type="submit">Respinge</button>
                </form>`
              : ""
          }
        </div>`;

    const body = `
      ${subtabs("/dezvoltare")}
      ${mesaje(ctx.query)}
      <div class="toolbar"><a class="btn secondary" href="/dezvoltare">← Toate cererile</a></div>
      <h1 style="margin:6px 0 4px">#${c.id} · ${esc(c.titlu)}</h1>
      <p style="margin:0 0 14px;font-size:13px;color:var(--text-muted)">
        ${pastila(c.stare)} &nbsp; ${esc(c.modul || "—")} · ${semnPrioritate(c.prioritate)} ·
        cerută de <strong>${esc(c.autor || "—")}</strong> pe ${esc(String(c.creat_la || "").slice(0, 10))}
        ${c.decident ? ` · decisă de ${esc(c.decident)} pe ${esc(String(c.decis_la || "").slice(0, 10))}` : ""}
        ${c.livrat_la ? ` · <span style="color:#2f7d4f">livrată ${esc(String(c.livrat_la).slice(0, 10))}</span>` : ""}
      </p>

      ${c.motiv ? `<div class="detail-box" style="border-left:4px solid var(--danger);max-width:900px"><strong>Respinsă:</strong> ${esc(c.motiv)}</div>` : ""}
      ${c.note_livrare ? `<div class="detail-box" style="border-left:4px solid #2f7d4f;max-width:900px"><strong>Ce s-a făcut:</strong> ${esc(c.note_livrare)}</div>` : ""}

      ${c.descriere ? `<div class="detail-box" style="max-width:900px;white-space:pre-wrap">${esc(c.descriere)}</div>` : ""}

      ${actiuni}

      <h2 style="margin-top:22px">Discuție</h2>
      ${
        comentarii.length
          ? comentarii
              .map(
                (k) => `<div class="detail-box" style="max-width:900px;margin-bottom:8px">
                  <div style="font-size:12px;color:var(--text-muted)">${esc(k.autor || "cineva")} · ${esc(String(k.creat_la || "").slice(0, 16))}</div>
                  <div style="white-space:pre-wrap;margin-top:4px">${esc(k.text)}</div>
                </div>`
              )
              .join("")
          : `<p style="color:var(--text-muted);font-size:13px">Nimeni n-a comentat încă.</p>`
      }
      <form class="form" method="post" action="/dezvoltare/${c.id}/comentariu" style="max-width:900px">
        <label class="field">Adaugă la discuție
          <textarea name="text" rows="3" required placeholder="o lămurire, un exemplu, o întrebare"></textarea>
        </label>
        <div class="form-actions"><button class="btn" type="submit">Trimite</button></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Cererea #${c.id}`, active: "/dezvoltare", body }));
  });

  router.post("/dezvoltare/:id/comentariu", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const text = String((ctx.body || {}).text || "").trim().slice(0, 4000);
    if (text) {
      await db
        .prepare("INSERT INTO cereri_dezvoltare_comentarii (cerere_id, utilizator_id, text, creat_la) VALUES (?, ?, ?, ?)")
        .run(ctx.params.id, ctx.user.id, text, acum());
    }
    redirect(ctx.res, `/dezvoltare/${ctx.params.id}`);
  });

  // Schimbarea stării e singurul lucru rezervat administratorului. Restul
  // paginii e deschis tuturor, fiindcă o cerere scrisă nu strică nimic.
  router.post("/dezvoltare/:id/stare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    if (!eAdmin(ctx.user)) {
      return redirect(
        ctx.res,
        `/dezvoltare/${ctx.params.id}?eroare=` + encodeURIComponent("Doar administratorul poate aproba, respinge sau închide o cerere.")
      );
    }
    const stare = String((ctx.body || {}).stare || "");
    if (!STARI.some(([k]) => k === stare)) return redirect(ctx.res, `/dezvoltare/${ctx.params.id}`);
    const motiv = String((ctx.body || {}).motiv || "").trim().slice(0, 300) || null;
    const n = acum();
    if (stare === "livrata") {
      await db
        .prepare("UPDATE cereri_dezvoltare SET stare = ?, livrat_la = ?, decis_de = ?, decis_la = COALESCE(decis_la, ?) WHERE id = ?")
        .run(stare, n, ctx.user.id, n, ctx.params.id);
    } else if (stare === "noua") {
      await db
        .prepare("UPDATE cereri_dezvoltare SET stare = 'noua', motiv = NULL, livrat_la = NULL, decis_de = NULL, decis_la = NULL WHERE id = ?")
        .run(ctx.params.id);
    } else {
      await db
        .prepare("UPDATE cereri_dezvoltare SET stare = ?, motiv = ?, decis_de = ?, decis_la = ? WHERE id = ?")
        .run(stare, stare === "respinsa" ? motiv : null, ctx.user.id, n, ctx.params.id);
    }
    redirect(
      ctx.res,
      `/dezvoltare/${ctx.params.id}?ok=` + encodeURIComponent("Cererea e acum „" + (NUME_STARE.get(stare) || stare) + "”.")
    );
  });
}

module.exports = { register, MODULE, STARI, PRIORITATI };
