"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const STATUS_LABEL = {
  noua: '<span class="badge gri">nouă</span>',
  confirmata: '<span class="badge galben">confirmată</span>',
  livrata: '<span class="badge verde">livrată</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function lineRowsScript() {
  return `<script>
    function comenziAddRow() {
      var tbody = document.getElementById('linii-body');
      var first = tbody.querySelector('tr');
      var clone = first.cloneNode(true);
      clone.querySelectorAll('input').forEach(function (el) { el.value = ''; });
      tbody.appendChild(clone);
    }
    function comenziRemoveRow(btn) {
      var tbody = document.getElementById('linii-body');
      if (tbody.children.length > 1) btn.closest('tr').remove();
    }
    function comenziFillPret(select) {
      var opt = select.options[select.selectedIndex];
      var pret = opt.getAttribute('data-pret');
      var row = select.closest('tr');
      var pretInput = row.querySelector('input[name="pret_unitar[]"]');
      if (pretInput && pret && !pretInput.value) pretInput.value = pret;
    }
  </script>`;
}

function register(router) {
  router.get("/comenzi", async (ctx) => {
    const comenzi = await db
      .prepare(
        `SELECT c.*, p.nume AS partener_nume,
                COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total
         FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
         ORDER BY c.id DESC`
      )
      .all();
    const body = `
      <div class="toolbar"><a href="/comenzi/nou" class="btn">+ Comandă nouă</a></div>
      ${table(
        ["Nr.", "Client", "Data", "Status", "Total", "Acțiuni"],
        comenzi.map((c) => [
          `<a href="/comenzi/${c.id}">${esc(c.numar || "#" + c.id)}</a>`,
          esc(c.partener_nume),
          esc(c.data),
          STATUS_LABEL[c.status] || esc(c.status),
          money(c.total),
          actionLinks([{ href: `/comenzi/${c.id}`, label: "Deschide" }]),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ title: "Vânzări & CRM — comenzi", active: "/comenzi", body }));
  });

  router.get("/comenzi/nou", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume").all();
    const produse = await db.prepare("SELECT id, denumire, pret_vanzare FROM produse ORDER BY denumire").all();
    if (parteneri.length === 0 || produse.length === 0) {
      return send(
        ctx.res,
        200,
        layout({
          title: "Comandă nouă",
          active: "/comenzi",
          body: `<p>Adaugă mai întâi cel puțin un <a href="/parteneri/nou">client</a> și un <a href="/produse/nou">produs</a>.</p>`,
        })
      );
    }
    const produsOptions = produse
      .map((p) => `<option value="${p.id}" data-pret="${p.pret_vanzare}">${esc(p.denumire)}</option>`)
      .join("");

    const body = `<form method="post" action="/comenzi" class="form" style="max-width:820px">
      <label class="field"><span>Client</span>
        <select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select>
      </label>
      <label class="field"><span>Număr comandă (opțional)</span><input type="text" name="numar"></label>
      <label class="field"><span>Observații</span><textarea name="observatii" rows="2"></textarea></label>

      <h2>Produse comandate</h2>
      <table class="table lines-table">
        <thead><tr><th>Produs</th><th>Cantitate</th><th>Preț unitar</th><th></th></tr></thead>
        <tbody id="linii-body">
          <tr>
            <td><select name="produs_id[]" onchange="comenziFillPret(this)">${produsOptions}</select></td>
            <td><input type="number" step="0.01" name="cantitate[]"></td>
            <td><input type="number" step="0.01" name="pret_unitar[]"></td>
            <td><button type="button" class="link-btn danger" onclick="comenziRemoveRow(this)">Șterge</button></td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="btn secondary small" onclick="comenziAddRow()">+ Adaugă linie</button>

      <div class="form-actions">
        <button type="submit" class="btn">Salvează comanda</button>
        <a href="/comenzi" class="btn secondary">Renunță</a>
      </div>
    </form>
    ${lineRowsScript()}`;
    send(ctx.res, 200, layout({ title: "Comandă nouă", active: "/comenzi", body }));
  });

  router.post("/comenzi", async (ctx) => {
    const { partener_id, numar, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);

    const info = await db
      .prepare("INSERT INTO comenzi (partener_id, numar, observatii) VALUES (?, ?, ?) RETURNING id")
      .run(partener_id, numar || "", observatii || "");
    const comandaId = info.lastInsertRowid;

    const insertLinie = db.prepare(
      "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (?, ?, ?, ?)"
    );
    for (let i = 0; i < produsIds.length; i++) {
      const cant = Number(cantitati[i] || 0);
      if (cant > 0) await insertLinie.run(comandaId, produsIds[i], cant, Number(preturi[i] || 0));
    }

    redirect(ctx.res, `/comenzi/${comandaId}`);
  });

  router.get("/comenzi/:id", async (ctx) => {
    const comanda = await db
      .prepare(`SELECT c.*, p.nume AS partener_nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?`)
      .get(ctx.params.id);
    if (!comanda) return send(ctx.res, 404, layout({ title: "Negăsit", active: "/comenzi", body: "<p>Comandă inexistentă.</p>" }));

    const linii = await db
      .prepare(
        `SELECT cl.*, p.denumire, p.unitate_masura FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?`
      )
      .all(comanda.id);
    const total = linii.reduce((s, l) => s + l.cantitate * l.pret_unitar, 0);
    const factura = await db.prepare("SELECT id FROM facturi WHERE comanda_id = ?").get(comanda.id);

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Client</div>${esc(comanda.partener_nume)}</div>
          <div><div class="k">Data</div>${esc(comanda.data)}</div>
          <div><div class="k">Status</div>${STATUS_LABEL[comanda.status] || esc(comanda.status)}</div>
          <div><div class="k">Observații</div>${esc(comanda.observatii) || "—"}</div>
        </div>
      </div>

      ${table(
        ["Produs", "Cantitate", "UM", "Preț unitar", "Subtotal"],
        linii.map((l) => [esc(l.denumire), l.cantitate, esc(l.unitate_masura), money(l.pret_unitar), money(l.cantitate * l.pret_unitar)])
      )}
      <div class="totals"><span class="grand">Total: ${money(total)}</span></div>

      <h2>Acțiuni</h2>
      <form method="post" action="/comenzi/${comanda.id}/status" class="form" style="max-width:320px">
        <label class="field"><span>Schimbă status</span>
          <select name="status">
            ${["noua", "confirmata", "livrata", "anulata"]
              .map((s) => `<option value="${s}" ${s === comanda.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </label>
        <button type="submit" class="btn small">Actualizează status</button>
      </form>

      <div class="toolbar" style="margin-top:14px">
        ${
          factura
            ? `<a href="/facturi/${factura.id}" class="btn secondary">Vezi factura generată</a>`
            : `<form method="post" action="/comenzi/${comanda.id}/factureaza" class="inline-form"><button type="submit" class="btn">Generează factură din comandă</button></form>`
        }
        <form method="post" action="/comenzi/${comanda.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv comanda?')">
          <button type="submit" class="link-btn danger">Șterge comanda</button>
        </form>
      </div>
    `;
    send(ctx.res, 200, layout({ title: `Comandă ${comanda.numar || "#" + comanda.id}`, active: "/comenzi", body }));
  });

  router.post("/comenzi/:id/status", async (ctx) => {
    await db.prepare("UPDATE comenzi SET status = ? WHERE id = ?").run(ctx.body.status, ctx.params.id);
    redirect(ctx.res, `/comenzi/${ctx.params.id}`);
  });

  router.post("/comenzi/:id/factureaza", async (ctx) => {
    const comanda = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    const linii = await db
      .prepare(`SELECT cl.*, p.denumire, p.cota_tva FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?`)
      .all(comanda.id);

    const info = await db
      .prepare("INSERT INTO facturi (partener_id, comanda_id, status) VALUES (?, ?, 'emisa') RETURNING id")
      .run(comanda.partener_id, comanda.id);
    const facturaId = info.lastInsertRowid;
    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const l of linii) {
      await insertLinie.run(facturaId, l.produs_id, l.denumire, l.cantitate, l.pret_unitar, l.cota_tva);
    }

    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  router.post("/comenzi/:id/sterge", async (ctx) => {
    try {
      await db.prepare("DELETE FROM comenzi_linii WHERE comanda_id = ?").run(ctx.params.id);
      await db.prepare("DELETE FROM comenzi WHERE id = ?").run(ctx.params.id);
      redirect(ctx.res, "/comenzi");
    } catch (e) {
      if (e.code === "23503") {
        return send(
          ctx.res,
          409,
          layout({
            title: "Nu se poate șterge",
            active: "/comenzi",
            body: `<p>Această comandă nu poate fi ștearsă pentru că are o factură generată din ea. Șterge mai întâi factura asociată.</p><a href="/comenzi/${ctx.params.id}" class="btn secondary">Înapoi la comandă</a>`,
          })
        );
      }
      throw e;
    }
  });
}

module.exports = { register, STATUS_LABEL };
