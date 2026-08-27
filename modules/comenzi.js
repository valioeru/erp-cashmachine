"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Drumul unei comenzi, în ordinea în care se întâmplă de fapt:
// agentul o plasează → producția o preia → marfa ajunge în depozit → abia
// atunci agentul poate cere factura → cineva cu drepturi pe facturare o
// validează și pleacă în SmartBill.
const STATUS_LABEL = {
  noua: '<span class="badge gri">nouă</span>',
  confirmata: '<span class="badge albastru">confirmată</span>',
  in_productie: '<span class="badge galben">în producție</span>',
  in_stoc_depozit: '<span class="badge verde">în stoc depozit</span>',
  facturata: '<span class="badge verde">facturată</span>',
  livrata: '<span class="badge verde">livrată</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};
// Ordinea fluxului — folosită ca să știm ce urmează și de la ce pas se poate factura.
const FLUX = ["noua", "confirmata", "in_productie", "in_stoc_depozit", "facturata", "livrata"];
// De la starea asta încolo agentul poate apăsa „Facturează".
const STARE_FACTURABILA = "in_stoc_depozit";

function poateFactura(comanda) {
  const i = FLUX.indexOf(comanda.status);
  return i >= FLUX.indexOf(STARE_FACTURABILA) && comanda.status !== "anulata";
}

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
    send(ctx.res, 200, layout({ user: ctx.user, title: "Vânzări & CRM — comenzi", active: "/comenzi", body }));
  });

  router.get("/comenzi/nou", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume").all();
    const produse = await db.prepare("SELECT id, denumire, pret_vanzare FROM produse ORDER BY denumire").all();
    if (parteneri.length === 0 || produse.length === 0) {
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user,
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
    send(ctx.res, 200, layout({ user: ctx.user, title: "Comandă nouă", active: "/comenzi", body }));
  });

  router.post("/comenzi", async (ctx) => {
    const { partener_id, numar, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);

    // Client pe roșu = fără comenzi noi de la agent. Adminul poate trece
    // peste, dar conștient — nu din reflex.
    const verdict = await require("./scadente").poateComanda(ctx.user, partener_id);
    if (!verdict.ok) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Comandă blocată",
          active: "/comenzi",
          body: `<h1>Comandă blocată</h1>
            <p style="color:var(--danger);max-width:640px">${esc(verdict.motiv)}</p>
            <p style="max-width:640px;color:var(--text-muted)">Dacă e o situație pe care ai discutat-o deja cu clientul,
              vorbește cu administratorul: el poate plasa comanda sau poate marca restanța ca rezolvată.</p>
            <a class="btn secondary" href="/parteneri/${esc(String(partener_id))}">Vezi clientul</a>
            <a class="btn secondary" href="/scadente">Scadențele mele</a>`,
        })
      );
    }

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

    // Comanda plasată de agent intră imediat în lista Producției — acolo i se
    // dă status. Agentul n-are ce urmări prin telefoane: o vede pe pagina ei.
    try {
      const client = await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(partener_id);
      const rezumat = await db
        .prepare("SELECT p.denumire, cl.cantitate FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?")
        .all(comandaId);
      await db
        .prepare(
          `INSERT INTO comenzi_productie (numar, initiator, initiator_id, partener_id, client_text, tip_produs, cantitate,
                                          data_initiere, data_solicitata, status, sursa, comanda_id, observatii)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'noua', 'comanda_erp', ?, ?)`
        )
        .run(
          numar || "CMD" + String(comandaId).padStart(5, "0"),
          ctx.user ? ctx.user.nume : null,
          ctx.user ? ctx.user.id : null,
          partener_id,
          client ? client.nume : null,
          rezumat.map((r) => r.denumire).join(", ").slice(0, 300) || null,
          rezumat.map((r) => r.cantitate).join(" + ") || null,
          new Date().toISOString().slice(0, 10),
          ctx.body.data_livrare_ceruta || null,
          comandaId,
          observatii || null
        );
    } catch (e) {
      // Dacă producția nu poate prelua comanda, comanda tot există — nu o pierdem.
      console.error("[comenzi] nu am putut crea comanda de producție:", e.message);
    }

    redirect(ctx.res, `/comenzi/${comandaId}`);
  });

  router.get("/comenzi/:id", async (ctx) => {
    const comanda = await db
      .prepare(`SELECT c.*, p.nume AS partener_nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?`)
      .get(ctx.params.id);
    if (!comanda) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/comenzi", body: "<p>Comandă inexistentă.</p>" }));

    const linii = await db
      .prepare(
        `SELECT cl.*, p.denumire, p.unitate_masura FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?`
      )
      .all(comanda.id);
    const total = linii.reduce((s, l) => s + l.cantitate * l.pret_unitar, 0);
    const factura = await db.prepare("SELECT id FROM facturi WHERE comanda_id = ?").get(comanda.id);

    // Statusul îl mișcă producția/depozitul/adminul; agentul doar facturează
    // când marfa e gata. Așa nu-și trece nimeni singur comanda pe „livrată".
    const potiSchimbaStatus = ctx.user && ["admin", "depozit", "financiar"].includes(ctx.user.rol);

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
      ${
        potiSchimbaStatus
          ? `<form method="post" action="/comenzi/${comanda.id}/status" class="form" style="max-width:360px">
              <label class="field"><span>Schimbă status</span>
                <select name="status">
                  ${Object.keys(STATUS_LABEL)
                    .map((s) => `<option value="${s}" ${s === comanda.status ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`)
                    .join("")}
                </select>
              </label>
              <button type="submit" class="btn small">Actualizează status</button>
            </form>`
          : `<p style="color:var(--text-muted);font-size:13px">
               Statusul îl schimbă depozitul sau producția. Tu vei putea factura când comanda ajunge „în stoc depozit".
             </p>`
      }

      <div class="toolbar" style="margin-top:14px">
        ${
          factura
            ? `<a href="/facturi/${factura.id}" class="btn secondary">Vezi factura${String(factura.status) === "ciorna" ? " (ciornă, așteaptă validare)" : ""}</a>`
            : poateFactura(comanda)
              ? `<form method="post" action="/comenzi/${comanda.id}/factureaza" class="inline-form"><button type="submit" class="btn">Facturează</button></form>`
              : `<span style="color:var(--text-muted);font-size:13px">Facturarea se deblochează la statusul „în stoc depozit".</span>`
        }
        ${
          potiSchimbaStatus
            ? `<form method="post" action="/comenzi/${comanda.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv comanda?')">
                 <button type="submit" class="link-btn danger">Șterge comanda</button>
               </form>`
            : ""
        }
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comandă ${comanda.numar || "#" + comanda.id}`, active: "/comenzi", body }));
  });

  router.post("/comenzi/:id/status", async (ctx) => {
    // Doar producția, depozitul, financiarul sau adminul mișcă statusul.
    if (!ctx.user || !["admin", "depozit", "financiar"].includes(ctx.user.rol)) {
      return redirect(ctx.res, `/comenzi/${ctx.params.id}`);
    }
    const nou = String(ctx.body.status || "");
    if (!Object.prototype.hasOwnProperty.call(STATUS_LABEL, nou)) return redirect(ctx.res, `/comenzi/${ctx.params.id}`);
    const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!c) return redirect(ctx.res, "/comenzi");
    await db.prepare("UPDATE comenzi SET status = ? WHERE id = ?").run(nou, c.id);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(c.partener_id, `Comanda ${c.numar || "#" + c.id}: ${nou.replace(/_/g, " ")}`, null, ctx.user.id);
    redirect(ctx.res, `/comenzi/${ctx.params.id}`);
  });

  // „Facturează" — agentul poate apăsa DOAR după ce marfa e în stoc la
  // depozit. Nu emite nimic: naște o factură CIORNĂ, pe care o validează
  // apoi cineva cu drepturi pe facturare. Până la validare nu pleacă nimic
  // în SmartBill și nu se mișcă niciun stoc.
  router.post("/comenzi/:id/factureaza", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const comanda = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!comanda) return redirect(ctx.res, "/comenzi");

    if (comanda.factura_id) return redirect(ctx.res, `/facturi/${comanda.factura_id}`);

    if (!poateFactura(comanda)) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Încă nu se poate factura",
          active: "/comenzi",
          body: `<h1>Încă nu se poate factura</h1>
            <p style="max-width:620px">Comanda e în starea <strong>${esc(comanda.status)}</strong>.
              Factura se poate cere abia când marfa ajunge la starea
              <strong>în stoc depozit</strong> — până atunci n-ai ce livra.</p>
            <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const linii = await db
      .prepare(`SELECT cl.*, p.denumire, p.cota_tva FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id WHERE cl.comanda_id = ?`)
      .all(comanda.id);
    if (!linii.length) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Comandă fără linii",
          active: "/comenzi",
          body: `<h1>Comandă fără linii</h1><p>Nu pot factura o comandă goală.</p>
            <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const info = await db
      .prepare("INSERT INTO facturi (partener_id, comanda_id, directie, status, creata_de, agent_id, data_emiterii) VALUES (?, ?, 'vanzare', 'ciorna', ?, ?, ?) RETURNING id")
      .run(comanda.partener_id, comanda.id, ctx.user.id, comanda.agent_id || ctx.user.id, new Date().toISOString().slice(0, 10));
    const facturaId = info.lastInsertRowid;
    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const l of linii) {
      await insertLinie.run(facturaId, l.produs_id, l.denumire, l.cantitate, l.pret_unitar, l.cota_tva);
    }
    await db.prepare("UPDATE comenzi SET factura_id = ? WHERE id = ?").run(facturaId, comanda.id);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(comanda.partener_id, `Factură ciornă din comanda ${comanda.numar || "#" + comanda.id}`, "Așteaptă validare pe modulul de facturare.", ctx.user.id);

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
          layout({ user: ctx.user,
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
