"use strict";
// Modulul Bancă — importă extrasul de cont (CSV exportat din internet
// banking: BT, BCR, ING, BRD, Raiffeisen etc.) și potrivește automat
// tranzacțiile cu facturile din ERP.
//
// De ce import de extras și nu conexiune directă la bancă: accesul
// programatic la conturile bancare (PSD2/open banking) e permis doar
// furnizorilor licențiați AISP — o firmă nu poate apela direct API-ul
// băncii cu user/parolă. Calea directă există prin agregatori licențiați
// (ex. GoCardless Bank Account Data, Smart Fintech), care acoperă băncile
// mari din România, și se poate integra ulterior dacă îți faci cont la unul
// din ei. Până atunci, exportul CSV din internet banking + importul de aici
// dă exact același rezultat, cu 2 minute de efort pe săptămână.
//
// Potrivirea automată (tranzacție ↔ factură) folosește trei semnale:
//   1. suma tranzacției == restul de încasat/plătit al facturii (±1 ban);
//   2. numele partenerului apare în descrierea tranzacției;
//   3. numărul documentului apare în descriere.
// O potrivire se propune automat doar dacă e UNICĂ și are cel puțin
// semnalul de sumă + unul dintre celelalte două; altfel tranzacția rămâne
// „nepotrivită" și se leagă manual, dintr-o listă de candidați. Nimic nu
// devine plată în ERP fără confirmare — banii nu se ghicesc.
const db = require("../lib/db");
const crypto = require("crypto");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { parseFisier, normalizeHeader, parseNumar, parseData } = require("../lib/import-utils");

const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
const SUB_PLATIT = "(SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id)";

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeazaText(s) {
  return String(s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cuvintele "de umplutură" din denumirile de firme — nu contează la potrivire.
const STOPWORDS = new Set(["SRL", "SA", "S", "R", "L", "A", "PFA", "II", "SRLD", "COM", "IMPEX", "PROD", "THE", "RO"]);

function cuvinteCheie(nume) {
  return normalizeazaText(nume)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Deschide facturile cu rest de plată, pregătite pentru potrivire.
async function facturiDeschise() {
  const randuri = await db
    .prepare(
      `SELECT f.id, f.directie, f.serie, f.numar, f.document_extern, f.data_emiterii,
              p.id AS partener_id, p.nume AS partener_nume,
              COALESCE(l.total,0) AS total, COALESCE(pl.platit,0) AS platit,
              COALESCE(l.total,0) - COALESCE(pl.platit,0) AS rest
       FROM facturi f
       JOIN parteneri p ON p.id = f.partener_id
       LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
       LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id
       WHERE f.status NOT IN ('anulata','necunoscut') AND COALESCE(l.total,0) - COALESCE(pl.platit,0) > 0.5`
    )
    .all();
  for (const f of randuri) {
    f.cuvinte = cuvinteCheie(f.partener_nume);
    f.docNorm = normalizeazaText(f.document_extern || `${f.serie}${f.numar}`).replace(/ /g, "");
    f.numarText = String(f.numar);
  }
  return randuri;
}

// Caută candidații pentru o tranzacție. Întoarce {precise, aproximative}.
function candidatiPentru(tranzactie, facturi) {
  const directieCautata = tranzactie.suma >= 0 ? "vanzare" : "achizitie";
  const sumaAbs = Math.abs(tranzactie.suma);
  const descNorm = normalizeazaText(tranzactie.descriere);
  const descFaraSpatii = descNorm.replace(/ /g, "");

  const precise = [];
  const aproximative = [];
  for (const f of facturi) {
    if (f.directie !== directieCautata) continue;
    const sumaOk = Math.abs(Number(f.rest) - sumaAbs) <= 0.01;
    const numeOk = f.cuvinte.length > 0 && f.cuvinte.some((w) => descNorm.includes(w));
    const docOk = (f.docNorm.length >= 4 && descFaraSpatii.includes(f.docNorm)) || (f.numarText.length >= 3 && descNorm.includes(f.numarText));
    if (sumaOk && (numeOk || docOk)) precise.push({ f, motiv: `sumă exactă + ${numeOk ? "nume partener" : "număr document"} în descriere` });
    else if (sumaOk || (numeOk && docOk)) aproximative.push({ f, motiv: sumaOk ? "doar suma se potrivește" : "nume + document în descriere, sumă diferită" });
  }
  return { precise, aproximative };
}

function register(router) {
  // ---- Pagina principală -------------------------------------------------
  router.get("/banca", async (ctx) => {
    const filtru = String(ctx.query.status || "de_lucrat");
    const where =
      filtru === "de_lucrat"
        ? "WHERE t.status IN ('nepotrivita', 'potrivita')"
        : filtru === "toate"
        ? ""
        : `WHERE t.status = '${["nepotrivita", "potrivita", "confirmata", "ignorata"].includes(filtru) ? filtru : "nepotrivita"}'`;

    const tranzactii = await db
      .prepare(
        `SELECT t.*, f.document_extern, f.serie, f.numar, p.nume AS partener_nume
         FROM tranzactii_banca t
         LEFT JOIN facturi f ON f.id = t.factura_id
         LEFT JOIN parteneri p ON p.id = f.partener_id
         ${where}
         ORDER BY t.data DESC, t.id DESC LIMIT 300`
      )
      .all();
    const contoare = await db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(suma),0) AS s FROM tranzactii_banca GROUP BY status").all();
    const cnt = Object.fromEntries(contoare.map((r) => [r.status, r]));
    const v = (st, camp) => Number((cnt[st] || {})[camp] || 0);

    const STATUS_LABEL = {
      nepotrivita: '<span class="badge rosu">nepotrivită</span>',
      potrivita: '<span class="badge galben">potrivire propusă</span>',
      confirmata: '<span class="badge verde">confirmată</span>',
      ignorata: '<span class="badge gri">ignorată</span>',
    };

    const body = `
      <div class="cards">
        <div class="card"><div class="label">Potriviri propuse (de confirmat)</div><div class="value">${v("potrivita", "n")}</div></div>
        <div class="card"><div class="label">Nepotrivite (manual)</div><div class="value" style="color:${v("nepotrivita", "n") ? "var(--warn)" : "inherit"}">${v("nepotrivita", "n")}</div></div>
        <div class="card"><div class="label">Confirmate (devenite plăți)</div><div class="value">${v("confirmata", "n")}</div></div>
        <div class="card"><div class="label">Sold net importat</div><div class="value">${money(v("nepotrivita", "s") + v("potrivita", "s") + v("confirmata", "s"))}</div></div>
      </div>

      <div class="detail-box">
        <h2 style="margin-top:0">Încarcă extrasul de cont</h2>
        <p style="font-size:13px;color:var(--text-muted)">Export CSV din internet banking (BT, BCR, ING, BRD, Raiffeisen…). Coloanele (dată, descriere, debit/credit sau sumă) sunt recunoscute automat. Tranzacțiile deja importate sunt sărite (amprentă pe dată+sumă+descriere), deci poți încărca extrase suprapuse fără grijă.</p>
        <form method="post" action="/banca/import" enctype="multipart/form-data" class="filtre">
          <input type="file" name="fisier" accept=".csv,.xls,.xlsx" required>
          <button class="btn" type="submit">Importă și potrivește automat</button>
        </form>
      </div>

      <form class="filtre" method="get" action="/banca">
        <select name="status" onchange="this.form.submit()">
          <option value="de_lucrat"${filtru === "de_lucrat" ? " selected" : ""}>De lucrat (propuse + nepotrivite)</option>
          <option value="toate"${filtru === "toate" ? " selected" : ""}>Toate</option>
          <option value="confirmata"${filtru === "confirmata" ? " selected" : ""}>Confirmate</option>
          <option value="ignorata"${filtru === "ignorata" ? " selected" : ""}>Ignorate</option>
        </select>
        ${
          v("potrivita", "n") > 0
            ? `<form method="post" action="/banca/confirma-toate" class="inline-form" onsubmit="return confirm('Confirmi toate cele ${v("potrivita", "n")} potriviri propuse? Fiecare devine o plată în ERP.')">
                <button class="btn" type="submit">✓ Confirmă toate potrivirile propuse (${v("potrivita", "n")})</button>
              </form>`
            : ""
        }
      </form>

      ${table(
        ["Data", "Suma", "Descriere", "Factura potrivită", "Motiv", "Status", "Acțiuni"],
        tranzactii.map((t) => [
          esc(t.data),
          `<span style="color:${t.suma >= 0 ? "var(--success)" : "var(--danger)"}">${money(t.suma)}</span>`,
          `<span style="font-size:12px">${esc(String(t.descriere || "").slice(0, 90))}</span>`,
          t.factura_id ? `<a href="/facturi/${t.factura_id}">${esc(t.document_extern || `${t.serie}-${t.numar}`)}</a><br><span style="font-size:12px">${esc(t.partener_nume || "")}</span>` : "—",
          `<span style="font-size:12px;color:var(--text-muted)">${esc(t.potrivire_motiv || "—")}</span>`,
          STATUS_LABEL[t.status] || esc(t.status),
          t.status === "potrivita"
            ? `<form method="post" action="/banca/${t.id}/confirma" class="inline-form"><button class="link-btn" type="submit">✓ Confirmă</button></form>
               <form method="post" action="/banca/${t.id}/desparte" class="inline-form"><button class="link-btn danger" type="submit">✗ Nu e ea</button></form>`
            : t.status === "nepotrivita"
            ? `<a class="link-btn" href="/banca/${t.id}">Leagă manual</a>
               <form method="post" action="/banca/${t.id}/ignora" class="inline-form"><button class="link-btn" type="submit">Ignoră</button></form>`
            : "",
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted)">
        Conectarea directă la bancă (fără export manual) e posibilă doar printr-un agregator licențiat PSD2 (ex. GoCardless Bank
        Account Data, Smart Fintech) — se poate integra ulterior, cu cont la unul dintre ei. Importul de extras de mai sus face
        exact aceeași treabă, cu un export CSV pe săptămână.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Bancă — extras & reconciliere", active: "/banca", body }));
  });

  // ---- Import extras -------------------------------------------------------
  router.post("/banca/import", async (ctx) => {
    const files = (ctx.body.__files && ctx.body.__files.fisier) || [];
    const file = files[0];
    if (!file) return redirect(ctx.res, "/banca");

    let rows;
    try {
      rows = parseFisier(file.filename, file.data);
    } catch (e) {
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Eroare", active: "/banca", body: `<p>${esc(e.message)}</p><a class="btn" href="/banca">Înapoi</a>` }));
    }

    // Recunoaștem coloanele: dată, descriere, apoi fie o coloană de sumă
    // semnată, fie perechea debit/credit (formatul uzual la băncile RO).
    const CHEI = {
      data: ["data", "datatranzactiei", "datavalutei", "dataoperatiunii", "dataprocesarii"],
      descriere: ["descriere", "detalii", "detaliitranzactie", "explicatii", "descrieretranzactie", "beneficiarordonator", "denumire"],
      suma: ["suma", "valoare", "amount"],
      debit: ["debit", "iesiri", "plati", "sumadebit"],
      credit: ["credit", "intrari", "incasari", "sumacredit"],
      referinta: ["referinta", "reference", "nrtranzactie", "idtranzactie"],
    };
    let randHeader = -1;
    const idx = {};
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      const norm = (rows[i] || []).map(normalizeHeader);
      const gaseste = (chei) => norm.findIndex((h) => h && chei.some((k) => h.includes(k)));
      const iData = gaseste(CHEI.data);
      const iDesc = gaseste(CHEI.descriere);
      const iSuma = gaseste(CHEI.suma);
      const iDebit = gaseste(CHEI.debit);
      const iCredit = gaseste(CHEI.credit);
      if (iData !== -1 && iDesc !== -1 && (iSuma !== -1 || (iDebit !== -1 && iCredit !== -1))) {
        randHeader = i;
        Object.assign(idx, { data: iData, descriere: iDesc, suma: iSuma, debit: iDebit, credit: iCredit, referinta: gaseste(CHEI.referinta) });
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
          active: "/banca",
          body: `<h1>N-am recunoscut formatul extrasului</h1><p>Primele rânduri:</p><pre style="background:var(--surface);padding:12px;border-radius:8px;overflow-x:auto">${esc(
            rows.slice(0, 6).map((r, i) => `${i + 1}: ${r.join(" | ")}`).join("\n")
          )}</pre><p>Trimite-mi un extras exemplu și adaug formatul băncii tale.</p><a class="btn" href="/banca">Înapoi</a>`,
        })
      );
    }

    const existente = new Set((await db.prepare("SELECT amprenta FROM tranzactii_banca").all()).map((r) => r.amprenta));
    const facturi = await facturiDeschise();

    let importate = 0;
    let sarite = 0;
    let propuse = 0;
    for (let r = randHeader + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      const data = parseData(row[idx.data]);
      if (!data) continue; // rânduri de subsol/total
      const descriere = String(row[idx.descriere] || "").trim();
      let suma;
      if (idx.suma !== -1 && String(row[idx.suma] || "").trim() !== "") {
        suma = parseNumar(row[idx.suma]);
      } else {
        const debit = idx.debit !== -1 ? Math.abs(parseNumar(row[idx.debit])) : 0;
        const credit = idx.credit !== -1 ? Math.abs(parseNumar(row[idx.credit])) : 0;
        suma = credit - debit;
      }
      if (!suma) continue;

      const amprenta = crypto.createHash("sha1").update(`${data}|${suma.toFixed(2)}|${normalizeazaText(descriere)}`).digest("hex");
      if (existente.has(amprenta)) {
        sarite++;
        continue;
      }
      existente.add(amprenta);

      const t = { data, suma, descriere };
      const { precise } = candidatiPentru(t, facturi);
      let facturaId = null;
      let status = "nepotrivita";
      let motiv = null;
      if (precise.length === 1) {
        facturaId = precise[0].f.id;
        status = "potrivita";
        motiv = precise[0].motiv;
        // factura potrivită iese din lista de candidați pentru restul rulării
        const poz = facturi.indexOf(precise[0].f);
        if (poz !== -1) facturi.splice(poz, 1);
        propuse++;
      } else if (precise.length > 1) {
        motiv = `${precise.length} facturi candidate — alege manual`;
      }

      await db
        .prepare(
          "INSERT INTO tranzactii_banca (data, suma, descriere, referinta, factura_id, status, potrivire_motiv, fisier, amprenta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(data, suma, descriere, idx.referinta !== -1 ? String(row[idx.referinta] || "").trim() || null : null, facturaId, status, motiv, file.filename, amprenta);
      importate++;
    }

    redirect(ctx.res, `/banca?importate=${importate}&propuse=${propuse}&sarite=${sarite}`);
  });

  // ---- Confirmare / respingere --------------------------------------------
  async function confirmaTranzactia(t, userNume) {
    if (!t || t.status !== "potrivita" || !t.factura_id) return false;
    await db
      .prepare("INSERT INTO plati (factura_id, suma, data, metoda, observatii) VALUES (?, ?, ?, 'banca', ?)")
      .run(t.factura_id, Math.abs(t.suma), t.data, `Reconciliere extras bancar (${t.fisier || "import"}) — confirmată de ${userNume}`);
    await db.prepare("UPDATE tranzactii_banca SET status = 'confirmata' WHERE id = ?").run(t.id);
    // actualizăm statusul facturii
    const f = await db
      .prepare(
        `SELECT COALESCE(l.total,0) AS total, COALESCE(pl.platit,0) AS platit FROM facturi f
         LEFT JOIN ${SUB_TOTAL} l ON l.factura_id = f.id
         LEFT JOIN ${SUB_PLATIT} pl ON pl.factura_id = f.id WHERE f.id = ?`
      )
      .get(t.factura_id);
    if (f) {
      const status = Number(f.platit) >= Number(f.total) - 0.01 ? "platita" : "platita_partial";
      await db.prepare("UPDATE facturi SET status = ? WHERE id = ? AND status <> 'anulata'").run(status, t.factura_id);
    }
    return true;
  }

  router.post("/banca/:id/confirma", async (ctx) => {
    const t = await db.prepare("SELECT * FROM tranzactii_banca WHERE id = ?").get(ctx.params.id);
    await confirmaTranzactia(t, ctx.user ? ctx.user.nume : "utilizator");
    redirect(ctx.res, "/banca");
  });

  router.post("/banca/confirma-toate", async (ctx) => {
    const propuse = await db.prepare("SELECT * FROM tranzactii_banca WHERE status = 'potrivita'").all();
    for (const t of propuse) await confirmaTranzactia(t, ctx.user ? ctx.user.nume : "utilizator");
    redirect(ctx.res, "/banca");
  });

  router.post("/banca/:id/desparte", async (ctx) => {
    await db.prepare("UPDATE tranzactii_banca SET status = 'nepotrivita', factura_id = NULL, potrivire_motiv = 'respinsă manual' WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/banca");
  });

  router.post("/banca/:id/ignora", async (ctx) => {
    await db.prepare("UPDATE tranzactii_banca SET status = 'ignorata' WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/banca");
  });

  // ---- Legare manuală ------------------------------------------------------
  router.get("/banca/:id", async (ctx) => {
    const t = await db.prepare("SELECT * FROM tranzactii_banca WHERE id = ?").get(ctx.params.id);
    if (!t) return redirect(ctx.res, "/banca");
    const facturi = await facturiDeschise();
    const { precise, aproximative } = candidatiPentru(t, facturi);
    const candidati = [...precise, ...aproximative].slice(0, 20);
    const directie = t.suma >= 0 ? "vanzare" : "achizitie";
    const toate = facturi.filter((f) => f.directie === directie).sort((a, b) => Math.abs(a.rest - Math.abs(t.suma)) - Math.abs(b.rest - Math.abs(t.suma))).slice(0, 30);

    const rand = (c, motiv) => `<tr>
      <td><a href="/facturi/${c.id}">${esc(c.document_extern || `${c.serie}-${c.numar}`)}</a></td>
      <td>${esc(c.partener_nume)}</td>
      <td>${esc((c.data_emiterii || "").slice(0, 10))}</td>
      <td>${money(c.rest)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${esc(motiv || "")}</td>
      <td><form method="post" action="/banca/${t.id}/leaga" class="inline-form">
        <input type="hidden" name="factura_id" value="${c.id}">
        <button class="btn small" type="submit">Leagă & confirmă</button>
      </form></td>
    </tr>`;

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Data</div>${esc(t.data)}</div>
          <div><div class="k">Suma</div><strong style="color:${t.suma >= 0 ? "var(--success)" : "var(--danger)"}">${money(t.suma)}</strong></div>
          <div><div class="k">Tip</div>${t.suma >= 0 ? "Încasare (caut facturi emise)" : "Plată (caut facturi de furnizor)"}</div>
        </div>
        <p style="margin-top:10px;white-space:pre-wrap;font-size:13px">${esc(t.descriere || "")}</p>
      </div>

      ${candidati.length ? `<h2>Candidați detectați</h2><table class="table"><tr><th>Document</th><th>Partener</th><th>Data</th><th>Rest</th><th>Motiv</th><th></th></tr>${candidati.map((c) => rand(c.f, c.motiv)).join("")}</table>` : ""}

      <h2>Toate facturile deschise (${directie === "vanzare" ? "emise" : "de furnizor"}), cele mai apropiate ca sumă</h2>
      <table class="table"><tr><th>Document</th><th>Partener</th><th>Data</th><th>Rest</th><th></th><th></th></tr>${toate.map((c) => rand(c, "")).join("")}</table>
      <p><a class="btn secondary" href="/banca">← Înapoi la extras</a></p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Leagă tranzacția de o factură", active: "/banca", body }));
  });

  router.post("/banca/:id/leaga", async (ctx) => {
    const facturaId = parseInt(ctx.body.factura_id, 10);
    if (facturaId) {
      await db
        .prepare("UPDATE tranzactii_banca SET factura_id = ?, status = 'potrivita', potrivire_motiv = 'legată manual' WHERE id = ?")
        .run(facturaId, ctx.params.id);
      const t = await db.prepare("SELECT * FROM tranzactii_banca WHERE id = ?").get(ctx.params.id);
      await confirmaTranzactia(t, ctx.user ? ctx.user.nume : "utilizator");
    }
    redirect(ctx.res, "/banca");
  });
}

module.exports = { register };
