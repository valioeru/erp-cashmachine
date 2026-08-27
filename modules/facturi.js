"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const smartbill = require("../lib/smartbill");

const STATUS_LABEL = {
  ciorna: '<span class="badge gri">ciornă</span>',
  emisa: '<span class="badge galben">emisă</span>',
  platita_partial: '<span class="badge galben">plătită parțial</span>',
  platita: '<span class="badge verde">plătită</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function calcTotals(linii) {
  let subtotal = 0;
  let tva = 0;
  for (const l of linii) {
    const s = l.cantitate * l.pret_unitar;
    subtotal += s;
    tva += (s * (l.cota_tva || 0)) / 100;
  }
  return { subtotal, tva, total: subtotal + tva };
}

async function recomputeStatus(facturaId) {
  const factura = await db.prepare("SELECT * FROM facturi WHERE id = ?").get(facturaId);
  if (!factura || factura.status === "anulata") return;
  const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(facturaId);
  const { total } = calcTotals(linii);
  const platit = (await db.prepare("SELECT COALESCE(SUM(suma),0) AS s FROM plati WHERE factura_id = ?").get(facturaId)).s;
  let status = "emisa";
  if (platit >= total && total > 0) status = "platita";
  else if (platit > 0) status = "platita_partial";
  await db.prepare("UPDATE facturi SET status = ? WHERE id = ?").run(status, facturaId);
}

function lineRowsScript() {
  return `<script>
    function facturiAddRow() {
      var tbody = document.getElementById('linii-body');
      var first = tbody.querySelector('tr');
      var clone = first.cloneNode(true);
      clone.querySelectorAll('input').forEach(function (el) { el.value = ''; });
      tbody.appendChild(clone);
    }
    function facturiRemoveRow(btn) {
      var tbody = document.getElementById('linii-body');
      if (tbody.children.length > 1) btn.closest('tr').remove();
    }
    function facturiFillProdus(select) {
      var opt = select.options[select.selectedIndex];
      var row = select.closest('tr');
      var pretInput = row.querySelector('input[name="pret_unitar[]"]');
      var tvaInput = row.querySelector('input[name="cota_tva[]"]');
      var denInput = row.querySelector('input[name="denumire[]"]');
      var pret = opt.getAttribute('data-pret');
      var tva = opt.getAttribute('data-tva');
      if (pretInput && pret && !pretInput.value) pretInput.value = pret;
      if (tvaInput && tva) tvaInput.value = tva;
      if (denInput && !denInput.value) denInput.value = opt.text;
    }
  </script>`;
}

function register(router) {
  // Lista de facturi — o SINGURĂ interogare agregată, cu paginare și căutare.
  //
  // Varianta inițială cerea liniile și plățile fiecărei facturi separat
  // (2 interogări per rând). Cu un istoric real importat din SmartBill
  // (~3.000 de facturi) asta însemna peste 6.000 de dus-întorsuri la baza de
  // date la fiecare încărcare a paginii și o pagină HTML de ~850 KB — practic
  // inutilizabilă. Acum: o interogare pentru pagina curentă, una pentru
  // numărul total.
  const PE_PAGINA = 50;

  async function listaFacturi(ctx, directie) {
    const cauta = String(ctx.query.q || "").trim();
    const status = String(ctx.query.status || "").trim();
    const pagina = Math.max(1, parseInt(ctx.query.p || "1", 10) || 1);

    const where = ["f.directie = ?"];
    const args = [directie];
    if (cauta) {
      where.push("(p.nume ILIKE ? OR f.serie ILIKE ? OR f.document_extern ILIKE ? OR CAST(f.numar AS TEXT) LIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    if (status) {
      where.push("f.status = ?");
      args.push(status);
    }
    const clauza = where.join(" AND ");

    const totalRanduri = (
      await db.prepare(`SELECT COUNT(*) AS n FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE ${clauza}`).get(...args)
    ).n;
    const nrPagini = Math.max(1, Math.ceil(totalRanduri / PE_PAGINA));
    const paginaCurenta = Math.min(pagina, nrPagini);
    const offset = (paginaCurenta - 1) * PE_PAGINA;

    const facturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.data_scadenta, f.status, f.moneda, f.total_valuta,
                p.nume AS partener_nume,
                COALESCE(l.total, 0) AS total,
                COALESCE(pl.platit, 0) AS platit
         FROM facturi f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM plati GROUP BY factura_id) pl ON pl.factura_id = f.id
         WHERE ${clauza}
         ORDER BY f.data_emiterii DESC, f.id DESC
         LIMIT ${PE_PAGINA} OFFSET ${offset}`
      )
      .all(...args);

    const rows = facturi.map((f) => [
      `<a href="/facturi/${f.id}">${esc(f.document_extern || `${f.serie}-${f.numar ?? f.id}`)}</a>`,
      esc(f.partener_nume),
      esc((f.data_emiterii || "").slice(0, 10)),
      STATUS_LABEL[f.status] || esc(f.status),
      money(f.total) + (f.moneda && f.moneda !== "RON" ? ` <span class="badge gri">${esc(f.moneda)} ${Number(f.total_valuta || 0).toLocaleString("ro-RO")}</span>` : ""),
      money(f.platit),
      actionLinks([{ href: `/facturi/${f.id}`, label: "Deschide" }]),
    ]);

    const qs = (p) => {
      const u = new URLSearchParams();
      if (cauta) u.set("q", cauta);
      if (status) u.set("status", status);
      u.set("p", String(p));
      return "?" + u.toString();
    };
    const bazaUrl = directie === "achizitie" ? "/facturi/achizitii" : "/facturi";
    const paginare =
      nrPagini <= 1
        ? ""
        : `<div class="paginare">
             ${paginaCurenta > 1 ? `<a class="btn secondary small" href="${bazaUrl}${qs(paginaCurenta - 1)}">← Anterioare</a>` : ""}
             <span>Pagina ${paginaCurenta} din ${nrPagini} · ${totalRanduri} documente</span>
             ${paginaCurenta < nrPagini ? `<a class="btn secondary small" href="${bazaUrl}${qs(paginaCurenta + 1)}">Următoare →</a>` : ""}
           </div>`;

    const optiuniStatus = [["", "Toate statusurile"], ["emisa", "emise / neîncasate"], ["platita_partial", "încasate parțial"], ["platita", "încasate"], ["anulata", "anulate"]]
      .map(([v, t]) => `<option value="${v}"${status === v ? " selected" : ""}>${t}</option>`)
      .join("");

    return {
      totalRanduri,
      body: `
      <form class="filtre" method="get" action="${bazaUrl}">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="Caută după client sau număr document…">
        <select name="status">${optiuniStatus}</select>
        <button class="btn small" type="submit">Filtrează</button>
        ${cauta || status ? `<a class="btn secondary small" href="${bazaUrl}">Resetează</a>` : ""}
      </form>
      ${table(["Document", directie === "achizitie" ? "Furnizor" : "Client", "Data", "Status", "Total", directie === "achizitie" ? "Plătit" : "Încasat", "Acțiuni"], rows)}
      ${paginare}
    `,
    };
  }

  router.get("/facturi", async (ctx) => {
    const { body: lista, totalRanduri } = await listaFacturi(ctx, "vanzare");
    const body = `
      <div class="toolbar"><a href="/facturi/nou" class="btn">+ Factură nouă</a> <a href="/facturi/achizitii" class="btn secondary">Vezi achiziții (facturi de la furnizori)</a></div>
      ${lista}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Facturare & contabilitate (vânzări) · ${totalRanduri} documente`, active: "/facturi", body }));
  });

  router.get("/facturi/achizitii", async (ctx) => {
    const { body: lista, totalRanduri } = await listaFacturi(ctx, "achizitie");
    const body = `
      <div class="toolbar"><a href="/facturi/achizitii/noua" class="btn">+ Achiziție nouă</a> <a href="/facturi" class="btn secondary">Vezi vânzări</a></div>
      ${lista}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Achiziții (facturi de la furnizori) · ${totalRanduri} documente`, active: "/facturi/achizitii", body }));
  });
  router.get("/facturi/achizitii/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'client' ORDER BY nume").all();
    const produse = await db.prepare("SELECT id, denumire, pret_achizitie, cota_tva FROM produse ORDER BY denumire").all();
    if (parteneri.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user, title: "Achiziție nouă", active: "/facturi/achizitii", body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">furnizor</a>.</p>` })
      );
    }
    const produsOptions =
      `<option value="">— linie liberă —</option>` +
      produse.map((p) => `<option value="${p.id}" data-pret="${p.pret_achizitie}" data-tva="${p.cota_tva}">${esc(p.denumire)}</option>`).join("");

    const body = `<form method="post" action="/facturi/achizitii" class="form" style="max-width:900px">
      <label class="field"><span>Furnizor</span>
        <select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Serie (de pe factura furnizorului)</span><input type="text" name="serie" required></label>
      <label class="field"><span>Număr (de pe factura furnizorului)</span><input type="text" name="numar" required></label>
      <label class="field"><span>Data emiterii</span><input type="date" name="data_emiterii"></label>
      <label class="field"><span>Data scadenței</span><input type="date" name="data_scadenta"></label>
      <label class="field"><span>Observații</span><textarea name="observatii" rows="2"></textarea></label>

      <h2>Linii factură</h2>
      <table class="table lines-table">
        <thead><tr><th>Produs</th><th>Denumire pe factură</th><th>Cantitate</th><th>Preț unitar</th><th>TVA %</th><th></th></tr></thead>
        <tbody id="linii-body">
          <tr>
            <td><select name="produs_id[]" onchange="facturiFillProdus(this)">${produsOptions}</select></td>
            <td><input type="text" name="denumire[]"></td>
            <td><input type="number" step="0.01" name="cantitate[]"></td>
            <td><input type="number" step="0.01" name="pret_unitar[]"></td>
            <td><input type="number" step="0.01" name="cota_tva[]" value="19"></td>
            <td><button type="button" class="link-btn danger" onclick="facturiRemoveRow(this)">Șterge</button></td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="btn secondary small" onclick="facturiAddRow()">+ Adaugă linie</button>

      <div class="form-actions">
        <button type="submit" class="btn">Salvează achiziția</button>
        <a href="/facturi/achizitii" class="btn secondary">Renunță</a>
      </div>
    </form>
    ${lineRowsScript()}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Achiziție nouă", active: "/facturi/achizitii", body }));
  });

  router.post("/facturi/achizitii", async (ctx) => {
    const { partener_id, serie, numar, data_emiterii, data_scadenta, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const denumiri = asArray(ctx.body["denumire[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);
    const cotele = asArray(ctx.body["cota_tva[]"]);

    const info = await db
      .prepare(
        "INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, observatii, status) VALUES (?, ?, ?, 'achizitie', ?, ?, ?, 'emisa') RETURNING id"
      )
      .run(serie || "FAC", parseInt(String(numar).replace(/[^0-9]/g, ""), 10) || 0, partener_id, data_emiterii || "", data_scadenta || "", observatii || "");
    const facturaId = info.lastInsertRowid;

    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const produsCache = {};
    for (let i = 0; i < denumiri.length; i++) {
      const cant = Number(cantitati[i] || 0);
      if (cant <= 0) continue;
      const pid = produsIds[i] || null;
      let numeLinie = denumiri[i];
      if (!numeLinie && pid) {
        if (!(pid in produsCache)) produsCache[pid] = await db.prepare("SELECT denumire FROM produse WHERE id = ?").get(pid);
        numeLinie = produsCache[pid] ? produsCache[pid].denumire : "";
      }
      await insertLinie.run(facturaId, pid, numeLinie || "(fără denumire)", cant, Number(preturi[i] || 0), Number(cotele[i] || 0));
    }

    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  router.get("/facturi/nou", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume").all();
    const produse = await db.prepare("SELECT id, denumire, pret_vanzare, cota_tva FROM produse ORDER BY denumire").all();
    if (parteneri.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user, title: "Factură nouă", active: "/facturi", body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">client</a>.</p>` })
      );
    }
    const produsOptions =
      `<option value="">— linie liberă —</option>` +
      produse.map((p) => `<option value="${p.id}" data-pret="${p.pret_vanzare}" data-tva="${p.cota_tva}">${esc(p.denumire)}</option>`).join("");

    const body = `<form method="post" action="/facturi" class="form" style="max-width:900px">
      <label class="field"><span>Client</span>
        <select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Data scadenței</span><input type="date" name="data_scadenta"></label>
      <label class="field"><span>Observații</span><textarea name="observatii" rows="2"></textarea></label>

      <h2>Linii factură</h2>
      <table class="table lines-table">
        <thead><tr><th>Produs</th><th>Denumire pe factură</th><th>Cantitate</th><th>Preț unitar</th><th>TVA %</th><th></th></tr></thead>
        <tbody id="linii-body">
          <tr>
            <td><select name="produs_id[]" onchange="facturiFillProdus(this)">${produsOptions}</select></td>
            <td><input type="text" name="denumire[]"></td>
            <td><input type="number" step="0.01" name="cantitate[]"></td>
            <td><input type="number" step="0.01" name="pret_unitar[]"></td>
            <td><input type="number" step="0.01" name="cota_tva[]" value="19"></td>
            <td><button type="button" class="link-btn danger" onclick="facturiRemoveRow(this)">Șterge</button></td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="btn secondary small" onclick="facturiAddRow()">+ Adaugă linie</button>

      <div class="form-actions">
        <button type="submit" class="btn">Emite factura</button>
        <a href="/facturi" class="btn secondary">Renunță</a>
      </div>
    </form>
    ${lineRowsScript()}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Factură nouă", active: "/facturi", body }));
  });

  router.post("/facturi", async (ctx) => {
    const { partener_id, data_scadenta, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const denumiri = asArray(ctx.body["denumire[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);
    const cotele = asArray(ctx.body["cota_tva[]"]);

    const maxNumar = (await db.prepare("SELECT COALESCE(MAX(numar),0) AS m FROM facturi WHERE directie = 'vanzare'").get()).m;

    const info = await db
      .prepare("INSERT INTO facturi (numar, partener_id, directie, data_scadenta, observatii, status) VALUES (?, ?, 'vanzare', ?, ?, 'emisa') RETURNING id")
      .run(maxNumar + 1, partener_id, data_scadenta || "", observatii || "");
    const facturaId = info.lastInsertRowid;

    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const produsCache = {};
    for (let i = 0; i < denumiri.length; i++) {
      const cant = Number(cantitati[i] || 0);
      if (cant <= 0) continue;
      const pid = produsIds[i] || null;
      let numeLinie = denumiri[i];
      if (!numeLinie && pid) {
        if (!(pid in produsCache)) produsCache[pid] = await db.prepare("SELECT denumire FROM produse WHERE id = ?").get(pid);
        numeLinie = produsCache[pid] ? produsCache[pid].denumire : "";
      }
      await insertLinie.run(facturaId, pid, numeLinie || "(fără denumire)", cant, Number(preturi[i] || 0), Number(cotele[i] || 0));
    }

    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  router.get("/facturi/:id", async (ctx) => {
    const factura = await db
      .prepare(`SELECT f.*, p.nume AS partener_nume, p.cui, p.adresa FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`)
      .get(ctx.params.id);
    if (!factura) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/facturi", body: "<p>Factură inexistentă.</p>" }));

    const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(factura.id);
    const { subtotal, tva, total } = calcTotals(linii);
    const plati = await db.prepare("SELECT * FROM plati WHERE factura_id = ? ORDER BY id DESC").all(factura.id);
    const platit = plati.reduce((s, p) => s + p.suma, 0);
    const restant = Math.max(0, total - platit);
    const eVanzare = factura.directie !== "achizitie";
    const listaInapoi = eVanzare ? "/facturi" : "/facturi/achizitii";

    // Agentul creditat cu factura asta (contează la comision).
    const agentFactura = factura.agent_id
      ? await db.prepare("SELECT id, nume FROM utilizatori WHERE id = ?").get(factura.agent_id)
      : null;
    const agentiPosibili = eVanzare
      ? await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 AND rol IN ('admin','vanzari') ORDER BY rol DESC, nume").all()
      : [];

    const body = `
      <div class="toolbar"><a href="${listaInapoi}" class="btn secondary small">← ${eVanzare ? "Facturi vânzare" : "Facturi achiziție"}</a></div>
      ${ctx.query.mesaj ? `<p style="color:var(--text-muted)">${esc(ctx.query.mesaj)}</p>` : ""}
      ${
        factura.status === "ciorna"
          ? `<div class="detail-box" style="border-left:4px solid var(--warn)">
              <strong>Factură ciornă.</strong>
              <p style="margin:6px 0 10px;max-width:660px;font-size:13px;color:var(--text-muted)">
                Nu are încă număr, nu a scăzut stocul și nu a plecat în SmartBill. Toate astea se întâmplă
                la validare — pe care o face cineva cu drepturi pe facturare.
              </p>
              ${
                ctx.user && ["admin", "financiar"].includes(ctx.user.rol)
                  ? `<form method="post" action="/facturi/${factura.id}/valideaza" class="inline-form"
                           onsubmit="return confirm('Validezi factura? Se emite, scade stocul și pleacă în SmartBill.')">
                       <button class="btn" type="submit">Validează și emite factura</button>
                     </form>`
                  : `<span style="font-size:13px;color:var(--text-muted)">Nu ai drepturi de validare — anunță pe cineva de la facturare.</span>`
              }
            </div>`
          : ""
      }
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">${eVanzare ? "Client" : "Furnizor"}</div>${esc(factura.partener_nume)}</div>
          <div><div class="k">CUI</div>${esc(factura.cui) || "—"}</div>
          <div><div class="k">Data emiterii</div>${esc(factura.data_emiterii)}</div>
          <div><div class="k">Scadență</div>${esc(factura.data_scadenta) || "—"}</div>
          <div><div class="k">Status</div>${STATUS_LABEL[factura.status] || esc(factura.status)}</div>
          ${
            eVanzare
              ? `<div><div class="k">SmartBill</div>${
                  factura.smartbill_sync_la
                    ? `<span class="badge verde">trimisă (${esc(factura.smartbill_serie)}-${esc(factura.smartbill_numar)})</span>`
                    : '<span class="badge gri">netrimisă</span>'
                }</div>`
              : ""
          }
        </div>
      </div>

      ${
        eVanzare
          ? `<div class="detail-box">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span>Agent pe factură: <strong>${agentFactura ? esc(agentFactura.nume) : "nealocat"}</strong></span>
                ${factura.agent_manual ? '<span class="badge gri">setat manual</span>' : ""}
              </div>
              ${
                ctx.user && ctx.user.rol === "admin"
                  ? `<form method="post" action="/facturi/${factura.id}/agent" style="margin-top:10px;max-width:520px">
                      <label class="field"><span>Schimbă agentul</span>
                        <select name="agent_id">
                          <option value="">— nealocat —</option>
                          ${agentiPosibili.map((u) => `<option value="${u.id}"${factura.agent_id === u.id ? " selected" : ""}>${esc(u.nume)}${u.rol === "admin" ? " (administrator)" : ""}</option>`).join("")}
                        </select>
                      </label>
                      <div style="font-size:13px;margin:8px 0 6px">Pentru ce aplic schimbarea?</div>
                      <label style="display:block;font-size:13px;margin-bottom:4px">
                        <input type="radio" name="domeniu" value="factura" checked> doar factura asta
                      </label>
                      <label style="display:block;font-size:13px;margin-bottom:4px">
                        <input type="radio" name="domeniu" value="client"> tot istoricul clientului
                      </label>
                      <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:8px">
                        <input type="radio" name="domeniu" value="de_la"> de la data
                        <input type="date" name="de_la" value="${esc(String(factura.data_emiterii || "").slice(0, 10))}" style="padding:3px 6px">
                        încolo
                      </label>
                      <button type="submit" class="btn secondary">Aplică</button>
                    </form>`
                  : `<p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">Doar administratorul poate schimba agentul unei facturi.</p>`
              }
            </div>`
          : ""
      }

      ${table(
        ["Denumire", "Cantitate", "Preț unitar", "TVA %", "Subtotal"],
        linii.map((l) => [esc(l.denumire), l.cantitate, money(l.pret_unitar), `${l.cota_tva}%`, money(l.cantitate * l.pret_unitar)])
      )}
      <div class="totals">
        <div>Subtotal: ${money(subtotal)}</div>
        <div>TVA: ${money(tva)}</div>
        <div class="grand">Total: ${money(total)}</div>
        <div>Încasat: ${money(platit)} · Restant: ${money(restant)}</div>
      </div>

      <h2>Plăți</h2>
      ${table(
        ["Data", "Sumă", "Metodă", "Observații"],
        plati.map((p) => [esc(p.data), money(p.suma), esc(p.metoda), esc(p.observatii)])
      )}
      ${
        factura.status !== "anulata" && restant > 0
          ? `<form method="post" action="/facturi/${factura.id}/plata" class="form" style="max-width:420px">
              <label class="field"><span>Sumă încasată</span><input type="number" step="0.01" name="suma" required max="${restant}" value="${restant.toFixed(2)}"></label>
              <label class="field"><span>Metodă</span>
                <select name="metoda"><option>transfer bancar</option><option>numerar</option><option>card</option></select>
              </label>
              <label class="field"><span>Observații</span><input type="text" name="observatii"></label>
              <button type="submit" class="btn small">Înregistrează plata</button>
            </form>`
          : ""
      }

      ${
        eVanzare
          ? `<h2>Integrare SmartBill</h2>
      ${
        smartbill.isConfigured()
          ? `<form method="post" action="/facturi/${factura.id}/smartbill" class="inline-form">
              <button type="submit" class="btn secondary small">${factura.smartbill_sync_la ? "Retrimite în SmartBill" : "Trimite factura în SmartBill"}</button>
            </form>`
          : `<p style="color:var(--text-muted);font-size:13px">Integrarea SmartBill nu este configurată încă (lipsesc variabilele de mediu SMARTBILL_*). Vezi README.</p>`
      }`
          : ""
      }

      <div class="toolbar" style="margin-top:14px">
        ${
          factura.status !== "anulata"
            ? `<form method="post" action="/facturi/${factura.id}/anuleaza" class="inline-form" onsubmit="return confirm('Anulezi factura?')"><button type="submit" class="btn secondary">Anulează factura</button></form>`
            : ""
        }
        <form method="post" action="/facturi/${factura.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv factura?')">
          <button type="submit" class="link-btn danger">Șterge factura</button>
        </form>
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `${eVanzare ? "Factură" : "Achiziție"} ${factura.serie}-${factura.numar ?? factura.id}`, active: eVanzare ? "/facturi" : "/facturi/achizitii", body }));
  });

  router.post("/facturi/:id/plata", async (ctx) => {
    const suma = Number(ctx.body.suma || 0);
    if (suma > 0) {
      await db
        .prepare("INSERT INTO plati (factura_id, suma, metoda, observatii) VALUES (?, ?, ?, ?)")
        .run(ctx.params.id, suma, ctx.body.metoda || "transfer bancar", ctx.body.observatii || "");
      await recomputeStatus(ctx.params.id);
    }
    redirect(ctx.res, `/facturi/${ctx.params.id}`);
  });

  router.post("/facturi/:id/anuleaza", async (ctx) => {
    await db.prepare("UPDATE facturi SET status = 'anulata' WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, `/facturi/${ctx.params.id}`);
  });

  router.post("/facturi/:id/sterge", async (ctx) => {
    try {
      await db.prepare("DELETE FROM plati WHERE factura_id = ?").run(ctx.params.id);
      await db.prepare("DELETE FROM facturi_linii WHERE factura_id = ?").run(ctx.params.id);
      await db.prepare("DELETE FROM facturi WHERE id = ?").run(ctx.params.id);
      redirect(ctx.res, "/facturi");
    } catch (e) {
      if (e.code === "23503") {
        return send(
          ctx.res,
          409,
          layout({ user: ctx.user,
            title: "Nu se poate șterge",
            active: "/facturi",
            body: `<p>Această factură nu poate fi ștearsă din cauza altor înregistrări asociate.</p><a href="/facturi/${ctx.params.id}" class="btn secondary">Înapoi la factură</a>`,
          })
        );
      }
      throw e;
    }
  });

  // Validarea unei facturi ciornă. Aici se întâmplă tot ce e ireversibil:
  // factura devine emisă, scade stocul la noi și pleacă în SmartBill.
  // De-aia o poate apăsa doar cine are drepturi pe facturare.
  router.post("/facturi/:id/valideaza", async (ctx) => {
    if (!ctx.user || !["admin", "financiar"].includes(ctx.user.rol)) {
      return send(
        ctx.res,
        403,
        layout({
          user: ctx.user,
          title: "Fără drepturi",
          active: "/facturi",
          body: `<h1>Fără drepturi de facturare</h1>
            <p>Validarea unei facturi o face cineva cu drepturi pe modulul de facturare.</p>
            <a class="btn secondary" href="/facturi/${ctx.params.id}">Înapoi la factură</a>`,
        })
      );
    }
    const factura = await db.prepare("SELECT * FROM facturi WHERE id = ?").get(ctx.params.id);
    if (!factura) return redirect(ctx.res, "/facturi");
    if (factura.status !== "ciorna") return redirect(ctx.res, `/facturi/${factura.id}`);

    const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(factura.id);

    // Numărul se dă abia acum: o ciornă nu consumă un număr de factură.
    let numar = factura.numar;
    if (!numar) {
      const m = await db
        .prepare("SELECT COALESCE(MAX(numar), 0) AS n FROM facturi WHERE directie = 'vanzare' AND COALESCE(serie,'') = ?")
        .get(factura.serie || "FCT");
      numar = Number((m && m.n) || 0) + 1;
    }

    await db
      .prepare("UPDATE facturi SET status = 'emisa', numar = ?, validata_de = ?, validata_la = ? WHERE id = ?")
      .run(numar, ctx.user.id, new Date().toISOString().slice(0, 19).replace("T", " "), factura.id);

    // Scade stocul la noi, din primul depozit definit.
    let avertismentStoc = "";
    try {
      const dep = await db.prepare("SELECT id FROM depozite ORDER BY id LIMIT 1").get();
      if (dep) {
        for (const l of linii) {
          if (!l.produs_id) continue;
          await db
            .prepare("INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, data) VALUES (?, ?, 'iesire', ?, ?, ?, ?)")
            .run(l.produs_id, dep.id, l.cantitate, l.pret_unitar, `Factura ${factura.serie || ""} ${numar}`.trim(), new Date().toISOString().slice(0, 10));
        }
      } else {
        avertismentStoc = "Nu există niciun depozit definit, așa că stocul nu s-a mișcat la noi.";
      }
    } catch (e) {
      avertismentStoc = "Stocul nu s-a putut actualiza: " + e.message;
    }

    // Marchează comanda ca facturată.
    if (factura.comanda_id) {
      await db.prepare("UPDATE comenzi SET status = 'facturata' WHERE id = ?").run(factura.comanda_id);
    }

    // Trimite în SmartBill, dacă e configurat. Dacă nu, factura rămâne validă
    // la noi și se poate retrimite oricând din pagina ei.
    let mesajSmartbill = "";
    if (smartbill.isConfigured()) {
      try {
        const proaspata = await db.prepare("SELECT * FROM facturi WHERE id = ?").get(factura.id);
        const rezultat = await smartbill.trimiteFactura(proaspata, linii);
        await db
          .prepare("UPDATE facturi SET smartbill_sync_la = ?, smartbill_serie = ?, smartbill_numar = ? WHERE id = ?")
          .run(new Date().toISOString().slice(0, 19).replace("T", " "), rezultat.serie || null, rezultat.numar || null, factura.id);
        mesajSmartbill = "Trimisă și în SmartBill.";
      } catch (e) {
        mesajSmartbill = "Factura e validă la noi, dar nu a plecat în SmartBill: " + e.message;
      }
    } else {
      mesajSmartbill = "SmartBill nu e configurat, așa că factura a rămas doar la noi.";
    }

    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'factura', ?, ?, ?)")
      .run(factura.partener_id, `Factura ${factura.serie || ""} ${numar} validată`.trim(), [mesajSmartbill, avertismentStoc].filter(Boolean).join(" "), ctx.user.id);

    redirect(ctx.res, `/facturi/${factura.id}?mesaj=${encodeURIComponent([mesajSmartbill, avertismentStoc].filter(Boolean).join(" "))}`);
  });

  router.post("/facturi/:id/smartbill", async (ctx) => {
    const factura = await db
      .prepare(`SELECT f.*, p.nume AS partener_nume, p.cui, p.adresa FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`)
      .get(ctx.params.id);
    if (factura.directie === "achizitie") return redirect(ctx.res, `/facturi/${ctx.params.id}`);
    const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(factura.id);
    try {
      const rezultat = await smartbill.trimiteFactura(factura, linii);
      await db
        .prepare("UPDATE facturi SET smartbill_sync_la = ?, smartbill_serie = ?, smartbill_numar = ? WHERE id = ?")
        .run(new Date().toISOString(), rezultat.series || "", String(rezultat.number || ""), factura.id);
    } catch (err) {
      console.error("Eroare trimitere SmartBill:", err);
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user,
          title: "Eroare integrare SmartBill",
          active: "/facturi",
          body: `<p>Trimiterea către SmartBill a eșuat: ${esc(err.message)}</p>
                 <p style="color:var(--text-muted);font-size:13px">Verifică datele de conectare (SMARTBILL_*) și structura cerută de API — vezi comentariile din lib/smartbill.js.</p>
                 <a href="/facturi/${factura.id}" class="btn secondary">Înapoi la factură</a>`,
        })
      );
    }
    redirect(ctx.res, `/facturi/${ctx.params.id}`);
  });
}

module.exports = { register, calcTotals, STATUS_LABEL };
