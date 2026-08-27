"use strict";
// Partea de rute a punții. Ține separat de logica de ingest (punte.js) doar
// ca fișierul să rămână citibil.
module.exports = function registerRute(router, deps) {
  const { db, esc, layout, table, send, redirect, HANDLERE, acum, MAX_OCTETI, MAX_RANDURI, MAX_LOTURI_PASTRATE } = deps;

  const TIPURI_ETICHETE = {
    produse: "Produse / servicii",
    stoc: "Stoc la zi",
    productie: "Rapoarte de producție (dau rețetele)",
    consum: "Bonuri de consum",
  };

  // Cutia poștală: ce a sosit din browser și așteaptă aprobarea ta.
  router.get("/import/punte", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const loturi = await db
      .prepare("SELECT id, tip, randuri, octeti, sursa, primit_la, aplicat_la, rezultat FROM punte_staging ORDER BY id DESC LIMIT 60")
      .all();

    const inAsteptare = loturi.filter((l) => !l.aplicat_la);
    const randuriTabel = (lista) =>
      lista.map((l) => [
        String(l.id),
        esc(TIPURI_ETICHETE[l.tip] || l.tip),
        Number(l.randuri).toLocaleString("ro-RO"),
        `${Math.round(Number(l.octeti) / 1024)} KB`,
        esc(String(l.primit_la || "").slice(0, 19)),
        l.aplicat_la ? `<span class="badge verde">aplicat</span> ${esc(String(l.rezultat || "").slice(0, 120))}` : `<span class="badge gri">în așteptare</span>`,
        l.aplicat_la
          ? ""
          : `<div class="actions">
               <a class="link-btn" href="/import/punte/${l.id}">vezi</a>
               <form method="post" action="/import/punte/${l.id}/aplica" class="inline-form"><button class="link-btn" type="submit">aplică</button></form>
               <form method="post" action="/import/punte/${l.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi lotul?')"><button class="link-btn danger" type="submit">șterge</button></form>
             </div>`,
      ]);

    const body = `
      <div class="detail-box">
        <p style="margin-top:0">
          O parte din datele SmartBill nu se pot exporta deloc — rețeta unui raport de producție sau
          liniile unui bon de consum se văd doar dacă intri în document. Puntea rezolvă asta:
          browserul citește paginile (are sesiunea ta) și trimite rândurile aici.
        </p>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:0">
          Nimic nu intră în datele firmei singur. Ce sosește stă în lista de mai jos până
          apeși <strong>aplică</strong>. Ce nu recunoști, ștergi.
        </p>
      </div>

      <h2>În așteptare (${inAsteptare.length})</h2>
      ${
        inAsteptare.length
          ? table(["#", "Tip", "Rânduri", "Mărime", "Primit", "Stare", "Acțiuni"], randuriTabel(inAsteptare)) +
            `<form method="post" action="/import/punte/aplica-tot" style="margin-top:10px">
               <button class="btn" type="submit">Aplică toate loturile în așteptare</button>
             </form>`
          : `<p style="color:var(--text-muted)">Nimic în așteptare.</p>`
      }

      <h2>Istoric</h2>
      ${table(["#", "Tip", "Rânduri", "Mărime", "Primit", "Stare", "Acțiuni"], randuriTabel(loturi.filter((l) => l.aplicat_la)))}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Punte de import din browser", active: "/import", body }));
  });

  // Previzualizarea unui lot — ca să vezi ce aplici.
  router.get("/import/punte/:id", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const l = await db.prepare("SELECT * FROM punte_staging WHERE id = ?").get(ctx.params.id);
    if (!l) return redirect(ctx.res, "/import/punte");
    let randuri = [];
    try {
      randuri = JSON.parse(l.continut) || [];
    } catch (e) {
      randuri = [];
    }
    const primele = randuri.slice(0, 25);
    const chei = [...new Set(primele.flatMap((r) => Object.keys(r || {})))].slice(0, 12);
    const body = `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Tip</div>${esc(TIPURI_ETICHETE[l.tip] || l.tip)}</div>
        <div><div class="k">Rânduri</div>${Number(l.randuri).toLocaleString("ro-RO")}</div>
        <div><div class="k">Primit</div>${esc(String(l.primit_la || "").slice(0, 19))}</div>
        <div><div class="k">Stare</div>${l.aplicat_la ? `aplicat la ${esc(String(l.aplicat_la).slice(0, 19))}` : "în așteptare"}</div>
      </div></div>
      <h2>Primele ${primele.length} rânduri</h2>
      ${
        chei.length
          ? table(
              chei,
              primele.map((r) =>
                chei.map((k) => {
                  const v = r ? r[k] : "";
                  if (Array.isArray(v)) return `${v.length} linii`;
                  return esc(String(v === undefined || v === null ? "" : v)).slice(0, 80);
                })
              )
            )
          : `<p style="color:var(--text-muted)">Lot gol sau ilizibil.</p>`
      }
      <div class="toolbar">
        ${
          l.aplicat_la
            ? ""
            : `<form method="post" action="/import/punte/${l.id}/aplica" class="inline-form"><button class="btn" type="submit">Aplică lotul</button></form>
               <form method="post" action="/import/punte/${l.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi lotul?')"><button class="btn secondary" type="submit">Șterge</button></form>`
        }
        <a class="btn secondary" href="/import/punte">Înapoi</a>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Lot #${l.id}`, active: "/import", body }));
  });

  async function aplicaLot(l) {
    const handler = HANDLERE[l.tip];
    if (!handler) return { eroare: `tip necunoscut: ${l.tip}` };
    let randuri = [];
    try {
      randuri = JSON.parse(l.continut) || [];
    } catch (e) {
      return { eroare: "conținut ilizibil" };
    }
    try {
      const rez = await handler(randuri);
      await db.prepare("UPDATE punte_staging SET aplicat_la = ?, rezultat = ? WHERE id = ?").run(acum(), JSON.stringify(rez), l.id);
      return rez;
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      await db.prepare("UPDATE punte_staging SET rezultat = ? WHERE id = ?").run("EROARE: " + msg, l.id);
      return { eroare: msg };
    }
  }

  router.post("/import/punte/:id/aplica", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const l = await db.prepare("SELECT * FROM punte_staging WHERE id = ?").get(ctx.params.id);
    if (!l) return redirect(ctx.res, "/import/punte");
    const rez = await aplicaLot(l);
    const body = `
      <div class="detail-box"><div class="detail-grid">
        ${Object.entries(rez)
          .map(([k, v]) => `<div><div class="k">${esc(k)}</div>${esc(String(v))}</div>`)
          .join("")}
      </div></div>
      <a class="btn secondary" href="/import/punte">Înapoi la punte</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Lot #${l.id} aplicat`, active: "/import", body }));
  });

  router.post("/import/punte/aplica-tot", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    // Ordinea contează: produsele întâi (ca stocul și rețetele să le
    // găsească), apoi stocul, apoi producția, apoi consumurile.
    const ordine = ["produse", "stoc", "productie", "consum"];
    const loturi = await db.prepare("SELECT * FROM punte_staging WHERE aplicat_la IS NULL ORDER BY id").all();
    loturi.sort((a, b) => ordine.indexOf(a.tip) - ordine.indexOf(b.tip) || a.id - b.id);
    const rezultate = [];
    for (const l of loturi) rezultate.push({ id: l.id, tip: l.tip, rez: await aplicaLot(l) });
    const body = `
      <h2>Loturi aplicate: ${rezultate.length}</h2>
      ${table(
        ["#", "Tip", "Rezultat"],
        rezultate.map((r) => [String(r.id), esc(TIPURI_ETICHETE[r.tip] || r.tip), esc(JSON.stringify(r.rez)).slice(0, 200)])
      )}
      <a class="btn secondary" href="/import/punte">Înapoi la punte</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Punte — aplicare", active: "/import", body }));
  });

  router.post("/import/punte/:id/sterge", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    await db.prepare("DELETE FROM punte_staging WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, "/import/punte");
  });

  // Legarea liniilor de factură de produse ----------------------------------
  // Facturile importate din SmartBill au denumirea produsului ca text liber,
  // fără legătură cu nomenclatorul. Atâta timp cât linia n-are produs,
  // ERP-ul nu știe costul mărfii, deci marja iese 100% — fals.
  // Rutina de mai jos potrivește denumirile cu produsele și completează
  // legătura. Nu inventează nimic: ce nu se potrivește rămâne nelegat și
  // apare în raport, ca să știi cât din marjă e încă necunoscut.
  router.post("/import/leaga-produse", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");

    const norm = (v) =>
      String(v || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "");

    // „(cod) Denumire" sau „cod - Denumire" — formele în care SmartBill
    // scrie produsul pe linia de factură.
    const variante = (text) => {
      const t = String(text || "").trim();
      const out = [t];
      const mPar = t.match(/^\(([^)]+)\)\s*(.+)$/);
      if (mPar) { out.push(mPar[2]); out.push(mPar[1]); }
      const mLin = t.match(/^([\w.\-\/]{2,20})\s+-\s+(.+)$/);
      if (mLin) { out.push(mLin[2]); out.push(mLin[1]); }
      return out.filter(Boolean);
    };

    const produse = await db.prepare("SELECT id, cod, denumire FROM produse").all();
    const dupaNume = new Map();
    const dupaCod = new Map();
    for (const p of produse) {
      const n = norm(p.denumire);
      if (n && !dupaNume.has(n)) dupaNume.set(n, p.id);
      const c = norm(p.cod);
      if (c && !dupaCod.has(c)) dupaCod.set(c, p.id);
    }

    const linii = await db.prepare("SELECT id, denumire FROM facturi_linii WHERE produs_id IS NULL").all();
    let legate = 0;
    const nepotrivite = new Map();
    for (const l of linii) {
      let id = null;
      for (const v of variante(l.denumire)) {
        const n = norm(v);
        if (!n) continue;
        id = dupaNume.get(n) || dupaCod.get(n) || null;
        if (id) break;
      }
      if (!id) {
        const cheie = String(l.denumire || "").slice(0, 60);
        nepotrivite.set(cheie, (nepotrivite.get(cheie) || 0) + 1);
        continue;
      }
      await db.prepare("UPDATE facturi_linii SET produs_id = ? WHERE id = ?").run(id, l.id);
      legate++;
    }

    const topNepotrivite = [...nepotrivite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    const total = await db.prepare("SELECT COUNT(*) AS n FROM facturi_linii").get();
    const cuProdus = await db.prepare("SELECT COUNT(*) AS n FROM facturi_linii WHERE produs_id IS NOT NULL").get();
    const cuCost = await db
      .prepare("SELECT COUNT(*) AS n FROM facturi_linii fl JOIN produse p ON p.id = fl.produs_id WHERE COALESCE(p.pret_achizitie,0) > 0")
      .get();

    const body = `
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Linii legate acum</div><strong>${legate}</strong></div>
        <div><div class="k">Linii cu produs</div>${Number(cuProdus.n).toLocaleString("ro-RO")} din ${Number(total.n).toLocaleString("ro-RO")}</div>
        <div><div class="k">Linii cu cost cunoscut</div>${Number(cuCost.n).toLocaleString("ro-RO")}</div>
        <div><div class="k">Denumiri nepotrivite</div>${nepotrivite.size}</div>
      </div></div>
      <p style="font-size:13px;color:var(--text-muted);max-width:820px">
        Marja se calculează doar pe liniile cu produs identificat <em>și</em> preț de achiziție.
        Ce a rămas nelegat mai jos e, de obicei, text scris liber pe factură (servicii, transport,
        denumiri prescurtate). Se rezolvă fie adăugând produsul în nomenclator cu denumirea exactă,
        fie emițând facturile din ERP, unde produsul se alege din listă.
      </p>
      ${
        topNepotrivite.length
          ? `<h2>Cele mai frecvente denumiri nepotrivite</h2>
             ${table(["Denumire pe factură", "Apariții"], topNepotrivite.map(([d, n]) => [esc(d), String(n)]))}`
          : ""
      }
      <a class="btn secondary" href="/import">Înapoi la Import</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Legare linii de factură cu produse", active: "/import", body }));
  });

  // --- ruta de primire ------------------------------------------------------
  router.options("/api/ingest", async (ctx) => {
    ctx.res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
    });
    ctx.res.end();
  });

  router.post("/api/ingest", async (ctx) => {
    const raspunde = (cod, obj) => {
      ctx.res.writeHead(cod, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      ctx.res.end(JSON.stringify(obj));
    };
    const b = ctx.body || {};
    const tip = String(b.tip || "");
    if (!HANDLERE[tip]) return raspunde(400, { ok: false, eroare: `tip necunoscut: ${tip}`, tipuri: Object.keys(HANDLERE) });
    const randuri = Array.isArray(b.randuri) ? b.randuri : [];
    if (!randuri.length) return raspunde(400, { ok: false, eroare: "randuri lipsă" });
    if (randuri.length > MAX_RANDURI) return raspunde(400, { ok: false, eroare: `prea multe rânduri (max ${MAX_RANDURI})` });
    const continut = JSON.stringify(randuri);
    if (continut.length > MAX_OCTETI) return raspunde(400, { ok: false, eroare: "lot prea mare" });

    const ins = await db
      .prepare("INSERT INTO punte_staging (tip, randuri, octeti, continut, sursa) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .run(tip, randuri.length, continut.length, continut, String(b.sursa || "").slice(0, 120) || null);

    // păstrăm cutia poștală mică
    await db
      .prepare(
        `DELETE FROM punte_staging WHERE id NOT IN (SELECT id FROM punte_staging ORDER BY id DESC LIMIT ${MAX_LOTURI_PASTRATE})`
      )
      .run();

    raspunde(200, { ok: true, tip, primite: randuri.length, lot: ins.lastInsertRowid, nota: "în așteptarea aprobării din ERP" });
  });
};
