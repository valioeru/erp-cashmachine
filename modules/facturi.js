"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const smartbill = require("../lib/smartbill");

const STATUS_LABEL = {
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
  router.get("/facturi", async (ctx) => {
    const facturi = await db
      .prepare(
        `SELECT f.*, p.nume AS partener_nume FROM facturi f JOIN parteneri p ON p.id = f.partener_id ORDER BY f.id DESC`
      )
      .all();
    const rows = [];
    for (const f of facturi) {
      const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(f.id);
      const { total } = calcTotals(linii);
      const platit = (await db.prepare("SELECT COALESCE(SUM(suma),0) AS s FROM plati WHERE factura_id = ?").get(f.id)).s;
      rows.push([
        `<a href="/facturi/${f.id}">${esc(f.serie)}-${f.numar ?? f.id}</a>`,
        esc(f.partener_nume),
        esc(f.data_emiterii),
        STATUS_LABEL[f.status] || esc(f.status),
        money(total),
        money(platit),
        actionLinks([{ href: `/facturi/${f.id}`, label: "Deschide" }]),
      ]);
    }
    const body = `
      <div class="toolbar"><a href="/facturi/nou" class="btn">+ Factură nouă</a></div>
      ${table(["Nr.", "Client", "Data", "Status", "Total", "Încasat", "Acțiuni"], rows)}
    `;
    send(ctx.res, 200, layout({ title: "Facturare & contabilitate", active: "/facturi", body }));
  });

  router.get("/facturi/nou", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume").all();
    const produse = await db.prepare("SELECT id, denumire, pret_vanzare, cota_tva FROM produse ORDER BY denumire").all();
    if (parteneri.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ title: "Factură nouă", active: "/facturi", body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">client</a>.</p>` })
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
    send(ctx.res, 200, layout({ title: "Factură nouă", active: "/facturi", body }));
  });

  router.post("/facturi", async (ctx) => {
    const { partener_id, data_scadenta, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const denumiri = asArray(ctx.body["denumire[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);
    const cotele = asArray(ctx.body["cota_tva[]"]);

    const maxNumar = (await db.prepare("SELECT COALESCE(MAX(numar),0) AS m FROM facturi").get()).m;

    const info = await db
      .prepare("INSERT INTO facturi (numar, partener_id, data_scadenta, observatii, status) VALUES (?, ?, ?, ?, 'emisa') RETURNING id")
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
    if (!factura) return send(ctx.res, 404, layout({ title: "Negăsit", active: "/facturi", body: "<p>Factură inexistentă.</p>" }));

    const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(factura.id);
    const { subtotal, tva, total } = calcTotals(linii);
    const plati = await db.prepare("SELECT * FROM plati WHERE factura_id = ? ORDER BY id DESC").all(factura.id);
    const platit = plati.reduce((s, p) => s + p.suma, 0);
    const restant = Math.max(0, total - platit);

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Client</div>${esc(factura.partener_nume)}</div>
          <div><div class="k">CUI</div>${esc(factura.cui) || "—"}</div>
          <div><div class="k">Data emiterii</div>${esc(factura.data_emiterii)}</div>
          <div><div class="k">Scadență</div>${esc(factura.data_scadenta) || "—"}</div>
          <div><div class="k">Status</div>${STATUS_LABEL[factura.status] || esc(factura.status)}</div>
          <div><div class="k">SmartBill</div>${
            factura.smartbill_sync_la
              ? `<span class="badge verde">trimisă (${esc(factura.smartbill_serie)}-${esc(factura.smartbill_numar)})</span>`
              : '<span class="badge gri">netrimisă</span>'
          }</div>
        </div>
      </div>

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

      <h2>Integrare SmartBill</h2>
      ${
        smartbill.isConfigured()
          ? `<form method="post" action="/facturi/${factura.id}/smartbill" class="inline-form">
              <button type="submit" class="btn secondary small">${factura.smartbill_sync_la ? "Retrimite în SmartBill" : "Trimite factura în SmartBill"}</button>
            </form>`
          : `<p style="color:var(--text-muted);font-size:13px">Integrarea SmartBill nu este configurată încă (lipsesc variabilele de mediu SMARTBILL_*). Vezi README.</p>`
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
    send(ctx.res, 200, layout({ title: `Factură ${factura.serie}-${factura.numar ?? factura.id}`, active: "/facturi", body }));
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
          layout({
            title: "Nu se poate șterge",
            active: "/facturi",
            body: `<p>Această factură nu poate fi ștearsă din cauza altor înregistrări asociate.</p><a href="/facturi/${ctx.params.id}" class="btn secondary">Înapoi la factură</a>`,
          })
        );
      }
      throw e;
    }
  });

  router.post("/facturi/:id/smartbill", async (ctx) => {
    const factura = await db
      .prepare(`SELECT f.*, p.nume AS partener_nume, p.cui, p.adresa FROM facturi f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`)
      .get(ctx.params.id);
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
        layout({
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
