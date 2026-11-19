"use strict";
// „Facturile mele": facturile făcute de agent din comenzile lui.
//
// CE A CERUT VALI, 18.11.2026: „Dă-le acces și la facturi, să le facă tot ei,
// iar din financiar, înainte de trimitere în SmartBill, se validează. Iar când
// e gata văd factura emisă și o pot inclusiv downloada sau printa."
//
// CUM MERGE:
//   1. Agentul face factura din comandă („Fă factura", aici sau pe pagina
//      comenzii), când comanda a ajuns „în stoc depozit". Iese o CIORNĂ: fără
//      număr, fără stoc scăzut, netrimisă nicăieri.
//   2. Financiarul o vede în Facturare, la „așteaptă validarea", o deschide și
//      o validează: capătă număr, scade stocul și pleacă în SmartBill.
//   3. Agentul o vede aici ca emisă, cu numărul din SmartBill, și o tipărește
//      sau îi descarcă PDF-ul.
//
// Agentul vede facturile lui și ale clienților lui (aceeași regulă ca la
// proforme și ca în biroul lui); financiarul și administratorul au lista
// întreagă în Facturare.
const db = require("../lib/db");
const { esc, money, layout, table, subnavComenzi } = require("../lib/render");
const { send } = require("../lib/router");
const { poateFactura } = require("../lib/comenzi-stari");
const { SQL_A_LUI, patru } = require("./proforme");

const STARE = {
  ciorna: '<span class="badge galben">ciornă — așteaptă validarea</span>',
  emisa: '<span class="badge verde">emisă</span>',
  platita_partial: '<span class="badge verde">emisă · încasată parțial</span>',
  platita: '<span class="badge verde">emisă · încasată</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};

function register(router) {
  router.get("/facturile-mele", async (ctx) => {
    const id = Number(ctx.user && ctx.user.id) || 0;
    const facturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.data_scadenta, f.status, f.smartbill_serie, f.smartbill_numar, f.sursa_import,
                f.comanda_id, c.numar AS comanda_numar, p.nume AS client,
                COALESCE((SELECT SUM(l.cantitate * l.pret_unitar * (1 + COALESCE(l.cota_tva, 0) / 100.0)) FROM facturi_linii l WHERE l.factura_id = f.id), 0) AS total
           FROM facturi f JOIN parteneri p ON p.id = f.partener_id LEFT JOIN comenzi c ON c.id = f.comanda_id
          WHERE f.activ = 1 AND f.directie = 'vanzare'
            AND (f.agent_id = ? OR f.creata_de = ? OR p.agent_id = ?
                 OR EXISTS (SELECT 1 FROM alocari_clienti ac WHERE ac.partener_id = p.id AND ac.utilizator_id = ?))
          ORDER BY CASE WHEN f.status = 'ciorna' THEN 0 ELSE 1 END, f.data_emiterii DESC, f.id DESC LIMIT 200`
      )
      .all(...patru(id));
    const comenzi = (
      await db
        .prepare(
          `SELECT c.id, c.numar, c.data, c.status, c.moneda, p.nume AS client,
                  COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total
             FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
            WHERE c.status <> 'anulata' AND c.factura_id IS NULL AND ${SQL_A_LUI("c", "p")}
            ORDER BY c.id DESC LIMIT 300`
        )
        .all(...patru(id))
    ).filter((c) => poateFactura(c));

    const nume = (f) => {
      const sb = String(f.smartbill_serie || "").trim() && String(f.smartbill_numar || "").trim();
      if (sb) return `${f.smartbill_serie} ${f.smartbill_numar}`;
      return f.status === "ciorna" ? "ciornă" : String(f.document_extern || "").trim() || `${f.serie || ""}-${f.numar ?? f.id}`;
    };
    const arePdf = (f) => Boolean((String(f.smartbill_serie || "").trim() && String(f.smartbill_numar || "").trim()) || (String(f.sursa_import || "").trim() && f.serie && f.numar != null));
    const inSmartbill = (f) => Boolean(String(f.smartbill_serie || "").trim() && String(f.smartbill_numar || "").trim());
    const ciorne = facturi.filter((f) => f.status === "ciorna" && !inSmartbill(f)).length;

    const body = `
      ${subnavComenzi("/facturile-mele", ctx.user)}
      <h1>Facturile mele</h1>
      <p style="max-width:780px;color:var(--text-muted)">Factura o faci tu, din comandă; iese ciornă și așteaptă validarea de la financiar.
        După validare primește număr, pleacă în SmartBill și o poți tipări sau descărca de aici.</p>

      <h2>Comenzi gata de facturat</h2>
      ${
        comenzi.length
          ? table(
              ["Comanda", "Data", "Client", "Total fără TVA", ""],
              comenzi.map((c) => [
                `<a href="/comenzi/${c.id}"><strong>${esc(c.numar || "#" + c.id)}</strong></a>`,
                esc(String(c.data || "").slice(0, 10)),
                esc(c.client),
                `${esc(Number(c.total || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} ${esc(String(c.moneda || "RON").toUpperCase() === "RON" ? "lei" : String(c.moneda).toUpperCase())}`,
                `<form method="post" action="/comenzi/${c.id}/factureaza" class="inline-form"><button class="btn" type="submit" data-fa-factura="${c.id}">Fă factura</button></form>`,
              ])
            )
          : `<p style="color:var(--text-muted)" data-nimic-de-facturat>Nicio comandă de-a ta nu e gata de facturat. Factura se poate face când comanda ajunge „în stoc depozit”.</p>`
      }

      <h2>Facturi${ciorne ? ` <span class="badge galben">${ciorne} ${ciorne === 1 ? "ciornă așteaptă" : "ciorne așteaptă"} validarea</span>` : ""}</h2>
      ${
        facturi.length
          ? table(
              ["Factura", "Client", "Comanda", "Data", "Scadența", "Total cu TVA", "Stare", ""],
              facturi.map((f) => [
                `<a href="/facturi/${f.id}" data-factura="${f.id}"><strong>${esc(nume(f))}</strong></a>`,
                esc(f.client),
                f.comanda_id ? `<a href="/comenzi/${f.comanda_id}">${esc(f.comanda_numar || "#" + f.comanda_id)}</a>` : "—",
                esc(String(f.data_emiterii || "").slice(0, 10)),
                esc(String(f.data_scadenta || "").slice(0, 10)) || "—",
                money(f.total),
                f.status === "ciorna" && inSmartbill(f) ? '<span class="badge verde">emisă în SmartBill</span> <span class="badge gri">nevalidată în ERP</span>' : STARE[f.status] || esc(f.status),
                `<a class="btn secondary small" href="/facturi/${f.id}/tipar" target="_blank">Tipărește</a>${
                  arePdf(f) && (f.status !== "ciorna" || inSmartbill(f))
                    ? ` <a class="btn secondary small" href="/facturi/${f.id}/pdf" target="_blank" data-pdf="${f.id}">Descarcă PDF</a>`
                    : // Fără PDF în SmartBill (ciornă, factură Warehouse All): foaia din ERP, cu salvarea ca PDF deschisă.
                      ` <a class="btn secondary small" href="/facturi/${f.id}/tipar?pdf=1" target="_blank" data-pdf-erp="${f.id}">Salvează PDF</a>`
                }`,
              ])
            )
          : `<p style="color:var(--text-muted)">Nicio factură încă pe clienții tăi.</p>`
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Facturile mele", active: "/comenzi", body }));
  });
}

module.exports = { register };
