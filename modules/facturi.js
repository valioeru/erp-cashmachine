"use strict";
const db = require("../lib/db");
const { esc, money, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const inbox = require("./inbox");
const { perioadaDin, chipuriPerioada } = require("../lib/perioada");
const { rezumatPeLuni, aduna } = require("../lib/rezumat-zile");
const smartbill = require("../lib/smartbill");
const TP = require("../lib/termen-plata");
const ADR = require("../lib/adresa-client");
const SCAN = require("../lib/scan");
// Cine validează o factură: administratorul, rolul financiar și cine are bifa
// „Facturare” (lib/auth.js, areFacturare).
const { areFacturare, poateAccesa } = require("../lib/auth");

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
  const factura = await db.prepare("SELECT * FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE id = ?").get(facturaId);
  if (!factura || factura.status === "anulata") return;
  const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(facturaId);
  const { total } = calcTotals(linii);
  const platit = (await db.prepare("SELECT COALESCE(SUM(suma),0) AS s FROM (SELECT * FROM plati WHERE activ = 1) plati WHERE factura_id = ?").get(facturaId)).s;
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

// Factura unui client de-al agentului (Vali, 17.11.2026 — vezi RUTA_FACTURA
// din lib/auth.js). Agentul ajunge aici din biroul lui sau de pe fișa
// clientului; are voie să vadă factura de VÂNZARE dacă e agentul de pe ea, are
// clientul alocat (alocari_clienti) sau e agentul scris pe fișa clientului.
// Facturile de achiziție și ale clienților altora rămân închise.
async function eFacturaAgentului(user, factura) {
  if (!user || !factura || factura.directie === "achizitie") return false;
  const id = Number(user.id);
  if (!(id > 0)) return false;
  // …sau a făcut-o el, din comandă (ciorna care așteaptă validarea).
  if (Number(factura.agent_id) === id || Number(factura.creata_de) === id) return true;
  const r = await db
    .prepare(
      `SELECT p.id FROM parteneri p
        WHERE p.id = ? AND (p.agent_id = ?
           OR EXISTS (SELECT 1 FROM alocari_clienti a WHERE a.partener_id = p.id AND a.utilizator_id = ?))`
    )
    .get(factura.partener_id, id, id)
    .catch(() => null);
  return Boolean(r);
}

// Seria și numărul sub care factura există în SmartBill, dacă există: cele
// primite la trimiterea din ERP, sau cele cu care a fost adusă de acolo.
// null = n-are PDF în SmartBill (ciornă, anulată înainte de trimitere, scrisă
// de mână și netrimisă, factură de achiziție).
function pdfDinSmartbill(f) {
  if (!f || f.directie === "achizitie") return null;
  const s = String(f.smartbill_serie || "").trim();
  const n = String(f.smartbill_numar || "").trim();
  if (s && n) return { serie: s, numar: n };
  if (String(f.sursa_import || "").trim() && String(f.serie || "").trim() && f.numar != null && String(f.numar).trim() !== "") {
    return { serie: String(f.serie).trim(), numar: String(f.numar).trim() };
  }
  return null;
}
// Ce serie și ce număr se scriu pe foaia tipărită: cele fiscale, dacă le are.
function numarFiscal(f) {
  const sb = pdfDinSmartbill(f);
  if (sb) return { serie: sb.serie, numar: sb.numar, fiscal: true };
  return { serie: String(f.serie || "").trim() || "—", numar: f.numar == null ? "—" : String(f.numar), fiscal: false };
}

// Cum se numește factura pe pagina ei: cu numărul fiscal din SmartBill, dacă a
// fost trimisă din ERP („CSHM3409 (FCT-4 în ERP)"); altfel cu seria și numărul ei.
function numeFactura(f) {
  const erp = `${f.serie}-${f.numar ?? f.id}`;
  return eTrimisaDinErp(f) ? `${String(f.document_extern).trim()} (${erp} în ERP)` : erp;
}

// Factura făcută în ERP și trimisă în SmartBill, care își poartă numărul fiscal
// ca document. Semnul e numărul primit din SmartBill: doar trimiterea îl scrie.
// (Lipsa sursei de import nu e un semn — și facturile scrise de mână n-au una.)
function eTrimisaDinErp(f) {
  return Boolean(f && String(f.smartbill_numar || "").trim() && String(f.document_extern || "").trim() && f.serie && f.numar != null);
}

// Factura a plecat în SmartBill: se ține minte când și ce număr a primit acolo.
//
// Numărul din SmartBill e numărul ei FISCAL — cel de pe hârtia clientului și
// din e-Factura; „FCT-4" e doar numărul ciornei din ERP. De-aia se scrie și ca
// `document_extern`: după el caută sincronizarea încasărilor, după el se arată
// factura în liste, și după el o recunoaște sincronizarea facturilor, ca să
// n-o aducă a doua oară din SmartBill (modules/punte.js, a treia pază —
// Vali, 17.11.2026: „Fact de la Maia Foods nu trebuie dublată").
// La o retrimitere, numărul nou îl înlocuiește pe cel vechi doar dacă
// documentul era chiar numărul vechi din SmartBill.
async function scrieTrimisa(facturaId, rezultat, cand) {
  const serie = String((rezultat && rezultat.series) || "").trim();
  const numar = String((rezultat && rezultat.number) || "").trim();
  const inainte = await db.prepare("SELECT smartbill_serie, smartbill_numar, document_extern FROM facturi WHERE id = ?").get(facturaId);
  await db
    .prepare("UPDATE facturi SET smartbill_sync_la = ?, smartbill_serie = ?, smartbill_numar = ? WHERE id = ?")
    .run(cand, serie, numar, facturaId);
  if (!serie || !numar) return;
  const vechi = inainte ? `${String(inainte.smartbill_serie || "").trim()}${String(inainte.smartbill_numar || "").trim()}` : "";
  const acum = String((inainte && inainte.document_extern) || "").trim();
  if (!acum || (vechi && acum === vechi)) {
    await db.prepare("UPDATE facturi SET document_extern = ? WHERE id = ?").run(`${serie}${numar}`, facturaId);
  }
}

// ---- facturile scrise de mână, cu prețuri în valută -------------------------
//
// Vali, 17.11.2026: „la orice comandă, preț etc., din orice loc în tot sistemul,
// prețurile se introduc în RON sau EUR; se păstrează cursul introdus sau BNR;
// odată plasat, așa rămâne în istoric". Convenția rămâne: liniile facturii sunt
// în lei. Prețul scris în euro sau dolari se trece în lei la cursul ales (gol =
// BNR-ul zilei), cu patru zecimale, ca la factura făcută din comandă, iar
// observațiile țin minte cursul. Vezi lib/pret-valuta.js.
const valutaFacturii = (corp) => require("../lib/pret-valuta").dinFormular(corp, require("./curs").laZiua);
function pretLinieInLei(scris, valuta) {
  const PV = require("../lib/pret-valuta");
  const p = Number(String(scris == null ? "" : scris).trim().replace(",", ".") || 0);
  if (!Number.isFinite(p)) return 0;
  const lei = PV.inLei(p, valuta, 4);
  return lei === null ? 0 : lei;
}
function cuNotaDeCurs(observatii, valuta) {
  const PV = require("../lib/pret-valuta");
  const nota = PV.eLei(valuta) ? "" : `Prețuri scrise în ${valuta.moneda}, trecute în lei: ${PV.nota(1, valuta)}.`;
  return [String(observatii || "").trim(), nota].filter(Boolean).join(" · ");
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
    // Lista se deschide pe „tot": cine intra in facturi vrea sa le vada, nu sa
    // se intrebe de ce lipsesc. Presetarile sunt la un click.
    const per = perioadaDin(ctx.query, "tot");

    const where = ["f.directie = ?", "f.data_emiterii >= ?", "f.data_emiterii <= ?"];
    const args = [directie, per.de, per.la + " 23:59:59"];
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
      await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN parteneri p ON p.id = f.partener_id WHERE ${clauza}`).get(...args)
    ).n;
    const nrPagini = Math.max(1, Math.ceil(totalRanduri / PE_PAGINA));
    const paginaCurenta = Math.min(pagina, nrPagini);
    const offset = (paginaCurenta - 1) * PE_PAGINA;

    const facturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.data_scadenta, f.status, f.moneda, f.total_valuta, f.smartbill_numar,
                p.nume AS partener_nume,
                COALESCE(l.total, 0) AS total,
                COALESCE(pl.platit, 0) AS platit
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id) pl ON pl.factura_id = f.id
         WHERE ${clauza}
         ORDER BY f.data_emiterii DESC, f.id DESC
         LIMIT ${PE_PAGINA} OFFSET ${offset}`
      )
      .all(...args);

    // Totalul perioadei, pe zile — pentru rândul de total și tabelul pe luni.
    // Numără tot filtrul, nu doar pagina de 50 de pe ecran.
    const peZile = await db
      .prepare(
        `SELECT SUBSTRING(f.data_emiterii, 1, 10) AS data,
                COUNT(*) AS documente,
                COALESCE(SUM(l.total), 0) AS total,
                COALESCE(SUM(pl.platit), 0) AS platit
         FROM (SELECT * FROM facturi WHERE activ = 1) f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id) l ON l.factura_id = f.id
         LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id) pl ON pl.factura_id = f.id
         WHERE ${clauza} AND f.status <> 'anulata'
         GROUP BY SUBSTRING(f.data_emiterii, 1, 10)
         ORDER BY data DESC`
      )
      .all(...args);
    for (const z of peZile) z.rest = Math.max(0, Number(z.total || 0) - Number(z.platit || 0));
    const etIncasat = directie === "achizitie" ? "Plătit" : "Încasat";
    const COLOANE_ZILE = [
      { camp: "documente", eticheta: "Facturi", tip: "nr" },
      { camp: "total", eticheta: "Total", tip: "bani" },
      { camp: "platit", eticheta: etIncasat, tip: "bani" },
      { camp: "rest", eticheta: directie === "achizitie" ? "De plătit" : "De încasat", tip: "bani" },
    ];
    const tPer = aduna(peZile, COLOANE_ZILE);

    // Scadența, cu zilele de întârziere la vedere.
    //
    // Lista aducea deja data_scadenta din bază, dar n-o arăta — și fără ea
    // „emisă / neîncasată" nu spune nimic: nu știi dacă e de ieri sau de acum
    // patru luni. Coloana se colorează doar când factura chiar are bani
    // neîncasați; una plătită cu întârziere nu mai e o problemă.
    const aziISO = new Date().toISOString().slice(0, 10);
    const scadentaCelula = (f) => {
      const s = String(f.data_scadenta || "").slice(0, 10);
      if (!s) return '<span style="color:var(--text-muted)">—</span>';
      const rest = Number(f.total || 0) - Number(f.platit || 0);
      if (s >= aziISO || rest <= 0.5 || f.status === "anulata" || f.status === "platita") return esc(s);
      const zile = Math.max(1, Math.round((Date.parse(aziISO) - Date.parse(s)) / 86400000));
      const culoare = zile > 90 ? "var(--danger)" : zile > 7 ? "var(--warn)" : "var(--text)";
      return `<span style="color:${culoare}">${esc(s)}<br><span style="font-size:11px">${zile} ${
        zile === 1 ? "zi" : "zile"
      } întârziere</span></span>`;
    };

    // Factura făcută în ERP și trimisă în SmartBill se arată cu numărul ei
    // fiscal; cel din ERP rămâne dedesubt, mic, ca s-o găsești și după el.
    const numarErp = (f) =>
      eTrimisaDinErp(f) ? `<br><span style="font-size:11px;color:var(--text-muted)">în ERP: ${esc(`${f.serie}-${f.numar}`)}</span>` : "";
    const rows = facturi.map((f) => [
      `<a href="/facturi/${f.id}">${esc(f.document_extern || `${f.serie}-${f.numar ?? f.id}`)}</a>${numarErp(f)}`,
      esc(f.partener_nume),
      esc((f.data_emiterii || "").slice(0, 10)),
      scadentaCelula(f),
      STATUS_LABEL[f.status] || esc(f.status),
      money(f.total) + (f.moneda && f.moneda !== "RON" ? ` <span class="badge gri">${esc(f.moneda)} ${Number(f.total_valuta || 0).toLocaleString("ro-RO")}</span>` : ""),
      money(f.platit),
      actionLinks([{ href: `/facturi/${f.id}`, label: "Deschide" }]),
    ]);

    const qs = (p) => {
      const u = new URLSearchParams();
      if (cauta) u.set("q", cauta);
      if (status) u.set("status", status);
      u.set("perioada", per.cheie);
      if (per.cheie === "custom") { u.set("de_la", per.de); u.set("pana_la", per.la); }
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

    const optiuniStatus = [["", "Toate statusurile"], ["ciorna", "ciorne — de validat"], ["emisa", "emise / neîncasate"], ["platita_partial", "încasate parțial"], ["platita", "încasate"], ["anulata", "anulate"]]
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
        <span class="perioade" style="margin:0">
          <span class="perioade-titlu">Perioada</span>
          ${chipuriPerioada(per.cheie)}
          <span class="perioade-custom">
            <input type="date" name="de_la" value="${esc(per.de)}">
            <span class="perioade-sageata">→</span>
            <input type="date" name="pana_la" value="${esc(per.la)}">
            <button class="chip${per.cheie === "custom" ? " activ" : ""}" type="submit" name="perioada" value="custom">Aplică</button>
          </span>
        </span>
      </form>
      <div class="cards">
        <div class="card"><div class="label">Facturi — ${esc(per.eticheta)}</div><div class="value">${Number(tPer.documente || 0).toLocaleString("ro-RO")}</div></div>
        <div class="card"><div class="label">Total facturat</div><div class="value">${money(tPer.total)}</div></div>
        <div class="card"><div class="label">${etIncasat}</div><div class="value">${money(tPer.platit)}</div></div>
        <div class="card"><div class="label">${directie === "achizitie" ? "De plătit" : "De încasat"}</div><div class="value" style="color:${tPer.rest > 0.5 ? "var(--warn)" : "inherit"}">${money(tPer.rest)}</div></div>
      </div>
      ${table(
        ["Document", directie === "achizitie" ? "Furnizor" : "Client", "Data", "Scadența", "Status", "Total", directie === "achizitie" ? "Plătit" : "Încasat", "Acțiuni"],
        rows.concat(
          rows.length
            ? [[`<strong>Total ${esc(per.eticheta)}</strong>`, `${Number(tPer.documente || 0).toLocaleString("ro-RO")} facturi`, "", "", "", `<strong>${money(tPer.total)}</strong>`, `<strong>${money(tPer.platit)}</strong>`, ""]]
            : []
        )
      )}
      ${paginare}
      ${rezumatPeLuni(peZile, COLOANE_ZILE, { eticheta: per.eticheta })}
    `,
    };
  }

  // Câte loturi stau neaplicate — ca butonul de actualizare să spună singur
  // că are ceva de făcut, fără să fie nevoie să intri pe el ca să afli.
  async function loturiInAsteptare() {
    try {
      const r = await db.prepare("SELECT COUNT(*) AS n FROM punte_staging WHERE aplicat_la IS NULL").get();
      return Number((r && r.n) || 0);
    } catch (e) {
      return 0;
    }
  }

  router.get("/facturi", async (ctx) => {
    const { body: lista, totalRanduri } = await listaFacturi(ctx, "vanzare");
    const asteptare = await loturiInAsteptare();
    // Ciornele făcute de agenți din comenzi, care așteaptă validarea
    // (Vali, 18.11.2026: „din financiar, înainte de trimitere în SmartBill, se validează").
    const deValidat = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.data_emiterii, f.smartbill_sync_la, f.smartbill_serie, f.smartbill_numar, p.nume AS client, u.nume AS facuta_de, c.numar AS comanda_numar, f.comanda_id,
                COALESCE((SELECT SUM(l.cantitate * l.pret_unitar * (1 + COALESCE(l.cota_tva, 0) / 100.0)) FROM facturi_linii l WHERE l.factura_id = f.id), 0) AS total
           FROM facturi f JOIN parteneri p ON p.id = f.partener_id
           LEFT JOIN utilizatori u ON u.id = f.creata_de LEFT JOIN comenzi c ON c.id = f.comanda_id
          WHERE f.activ = 1 AND f.directie = 'vanzare' AND f.status = 'ciorna'
          ORDER BY f.id DESC LIMIT 50`
      )
      .all()
      .catch(() => []);
    const blocDeValidat = deValidat.length
      ? `<div class="detail-box" data-de-validat style="border-left:4px solid var(--warn);margin-bottom:14px">
           <strong>${deValidat.length} ${deValidat.length === 1 ? "factură ciornă așteaptă" : "facturi ciornă așteaptă"} validarea</strong>
           <span style="font-size:13px;color:var(--text-muted)"> — făcute din comenzi; la validare capătă număr, scad stocul și pleacă în SmartBill.
             Cele deja trimise în SmartBill nu se mai trimit o dată: validarea le dă doar numărul din ERP și scade stocul.</span>
           ${table(
             ["Ciornă", "Client", "Comanda", "Făcută de", "Data", "Total cu TVA", "SmartBill", ""],
             deValidat.map((f) => [
               `<a href="/facturi/${f.id}">${esc(`${f.serie || "FCT"}-${f.numar ?? f.id}`)}</a>`,
               esc(f.client),
               f.comanda_id ? `<a href="/comenzi/${f.comanda_id}">${esc(f.comanda_numar || "#" + f.comanda_id)}</a>` : "—",
               esc(f.facuta_de || "—"),
               esc(String(f.data_emiterii || "").slice(0, 10)),
               money(f.total),
               f.smartbill_sync_la
                 ? `<span class="badge verde" data-deja-trimisa="${f.id}">deja trimisă (${esc([f.smartbill_serie, f.smartbill_numar].filter(Boolean).join("-"))})</span>`
                 : '<span class="badge gri">netrimisă</span>',
               `<a class="btn small" href="/facturi/${f.id}">Deschide și validează</a>`,
             ])
           )}
         </div>`
      : "";
    const body = `
      ${blocDeValidat}
      <div class="toolbar">
        <a href="/facturi/nou" class="btn">+ Factură nouă</a>
        ${
          poateActualiza(ctx.user)
            ? `<a href="/facturi/actualizare" class="btn secondary">⟳ Actualizează din SmartBill${
                asteptare ? ` <span class="badge galben">${asteptare}</span>` : ""
              }</a>`
            : ""
        }
        <a href="/facturi/achizitii" class="btn secondary">Vezi achiziții (facturi de la furnizori)</a>
        <a href="/facturi/stari-din-smartbill" class="btn secondary">Stări aduse din SmartBill</a>
      </div>
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
    // Fără produsele parcate; cele cu cod vechi fără stoc poartă eticheta în denumire (lib/cod-vechi.js).
    const produse = (await require("../lib/cod-vechi").pentruAles(await db.prepare("SELECT id, denumire, pret_achizitie, cota_tva FROM produse WHERE activ = 1 ORDER BY denumire").all())).map((p) => Object.assign(p, { denumire: require("../lib/cod-vechi").cuEticheta(p.denumire, p) }));
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

      ${ctx.query && ctx.query.eroare ? `<div class="flash flash-rosu" role="alert" style="background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(String(ctx.query.eroare))}</div>` : ""}
      <div data-valuta-factura style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        ${require("../lib/pret-valuta").camp(ctx.query || {}, { eticheta: "Prețurile liniilor sunt scrise în" })}
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin-top:-4px">Factura se ține în lei. Prețurile scrise în euro sau dolari se trec în lei la cursul de aici (gol = BNR-ul zilei), iar cursul rămâne scris în observații.</p>

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
    ${lineRowsScript()}
    ${require("../lib/pret-valuta").script(await require("../lib/pret-valuta").bnrAzi(require("./curs").laZiua))}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Achiziție nouă", active: "/facturi/achizitii", body }));
  });

  router.post("/facturi/achizitii", async (ctx) => {
    const { partener_id, serie, numar, data_emiterii, data_scadenta, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const denumiri = asArray(ctx.body["denumire[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);
    const cotele = asArray(ctx.body["cota_tva[]"]);

    // Prețurile se pot scrie și în valută (Vali, 17.11.2026; lib/pret-valuta.js):
    // în factură rămân în lei, la cursul ales, iar observațiile țin minte cursul.
    const valuta = await valutaFacturii(ctx.body);
    if (!valuta.ok) return redirect(ctx.res, `/facturi/achizitii/noua?eroare=${encodeURIComponent(valuta.eroare)}`);

    // Scadența lăsată goală se ia din termenul de plată al furnizorului
    // (Vali, 17.11.2026; lib/termen-plata.js). Cea scrisă de mână rămâne.
    const scadentaAchizitie =
      String(data_scadenta || "").trim() ||
      TP.scadenta(String(data_emiterii || "").trim() || new Date().toISOString().slice(0, 10), await TP.alPartenerului(db, partener_id));
    const info = await db
      .prepare(
        "INSERT INTO facturi (serie, numar, partener_id, directie, data_emiterii, data_scadenta, observatii, status) VALUES (?, ?, ?, 'achizitie', ?, ?, ?, 'emisa') RETURNING id"
      )
      .run(serie || "FAC", parseInt(String(numar).replace(/[^0-9]/g, ""), 10) || 0, partener_id, data_emiterii || "", scadentaAchizitie || "", cuNotaDeCurs(observatii, valuta));
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
      await insertLinie.run(facturaId, pid, numeLinie || "(fără denumire)", cant, pretLinieInLei(preturi[i], valuta), Number(cotele[i] || 0));
    }

    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  router.get("/facturi/nou", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume").all();
    // Fără produsele parcate; cele cu cod vechi fără stoc poartă eticheta în denumire (lib/cod-vechi.js).
    const produse = (await require("../lib/cod-vechi").pentruAles(await db.prepare("SELECT id, denumire, pret_vanzare, cota_tva FROM produse WHERE activ = 1 ORDER BY denumire").all())).map((p) => Object.assign(p, { denumire: require("../lib/cod-vechi").cuEticheta(p.denumire, p) }));
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

      ${ctx.query && ctx.query.eroare ? `<div class="flash flash-rosu" role="alert" style="background:#f8e5e3;border-color:#efc9c4;color:var(--danger)">${esc(String(ctx.query.eroare))}</div>` : ""}
      <div data-valuta-factura style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        ${require("../lib/pret-valuta").camp(ctx.query || {}, { eticheta: "Prețurile liniilor sunt scrise în" })}
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin-top:-4px">Factura se ține în lei. Prețurile scrise în euro sau dolari se trec în lei la cursul de aici (gol = BNR-ul zilei), iar cursul rămâne scris în observații.</p>

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
    ${lineRowsScript()}
    ${require("../lib/pret-valuta").script(await require("../lib/pret-valuta").bnrAzi(require("./curs").laZiua))}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Factură nouă", active: "/facturi", body }));
  });

  router.post("/facturi", async (ctx) => {
    const { partener_id, data_scadenta, observatii } = ctx.body;
    const produsIds = asArray(ctx.body["produs_id[]"]);
    const denumiri = asArray(ctx.body["denumire[]"]);
    const cantitati = asArray(ctx.body["cantitate[]"]);
    const preturi = asArray(ctx.body["pret_unitar[]"]);
    const cotele = asArray(ctx.body["cota_tva[]"]);

    // Prețurile se pot scrie și în valută: în factură rămân în lei (vezi mai sus, la achiziții).
    const valuta = await valutaFacturii(ctx.body);
    if (!valuta.ok) return redirect(ctx.res, `/facturi/nou?eroare=${encodeURIComponent(valuta.eroare)}`);

    const maxNumar = (await db.prepare("SELECT COALESCE(MAX(numar),0) AS m FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'vanzare'").get()).m;

    // Scadența lăsată goală se ia din termenul de plată al clientului (Vali,
    // 17.11.2026; lib/termen-plata.js). Factura se emite azi.
    const scadentaVanzare =
      String(data_scadenta || "").trim() ||
      TP.scadenta(new Date().toISOString().slice(0, 10), await TP.alPartenerului(db, partener_id));
    const info = await db
      .prepare("INSERT INTO facturi (numar, partener_id, directie, data_scadenta, observatii, status) VALUES (?, ?, 'vanzare', ?, ?, 'emisa') RETURNING id")
      .run(maxNumar + 1, partener_id, scadentaVanzare || "", cuNotaDeCurs(observatii, valuta));
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
      await insertLinie.run(facturaId, pid, numeLinie || "(fără denumire)", cant, pretLinieInLei(preturi[i], valuta), Number(cotele[i] || 0));
    }

    redirect(ctx.res, `/facturi/${facturaId}`);
  });

  // ---- Actualizare din SmartBill ----------------------------------------
  //
  // De ce nu e un simplu buton care cheamă SmartBill:
  //
  // API-ul public SmartBill e făcut pentru EMITEREA de documente noi, nu
  // pentru citirea lor. Nu există niciun endpoint care să spună „dă-mi
  // facturile emise între 1 și 30 septembrie". Singurul loc unde datele alea
  // se văd e interfața web, iar aia cere sesiunea lui Vali în browser. De-aia
  // culegerea se face din browser (punte/sincronizare.js) și ajunge aici ca
  // loturi în așteptare.
  //
  // Butonul face deci două lucruri, în ordinea asta:
  //   1. bagă în ERP tot ce a adus deja puntea și n-a fost încă aplicat
  //      (sincronizarea de noapte lasă loturile în așteptare);
  //   2. dacă vrei date proaspete chiar acum, îți dă semnul de carte de
  //      apăsat în fila de SmartBill — ăla e singurul drum care există.
  //
  // Dacă vreodată SmartBill scoate un API de citire, aici se schimbă: pasul 1
  // rămâne, pasul 2 devine un fetch făcut de server.
  const SEMN_DE_CARTE =
    "javascript:(function(){fetch('__ERP__/punte/sincronizare.js')" +
    ".then(function(r){return r.text()}).then(function(t){eval(t);" +
    "return window.__sync.tot(14)}).then(function(){alert('Sincronizare gata. " +
    "Intră în ERP la Facturare → Actualizează din SmartBill și apasă Aplică.')})" +
    ".catch(function(e){alert('N-a mers: '+e.message)})})()";

  async function stareaActualizarii() {
    const inAsteptare = await db
      .prepare("SELECT id, tip, randuri, primit_la, sursa FROM punte_staging WHERE aplicat_la IS NULL ORDER BY id")
      .all()
      .catch(() => []);
    const ultimaRulare = await db
      .prepare("SELECT pornit_la, stare, gasit, importat, nota FROM sync_rulari ORDER BY id DESC LIMIT 1")
      .get()
      .catch(() => null);
    const ultimaFactura = await db
      .prepare(
        "SELECT MAX(data_emiterii) AS d FROM facturi WHERE activ = 1 AND directie = 'vanzare' AND sursa_import IS NOT NULL"
      )
      .get()
      .catch(() => null);
    const ultimaIncasare = await db
      .prepare("SELECT MAX(data) AS d FROM plati WHERE activ = 1")
      .get()
      .catch(() => null);
    return { inAsteptare, ultimaRulare, ultimaFactura, ultimaIncasare };
  }

  // Aplicarea scrie în datele firmei (facturi, încasări), deci nu e pentru
  // oricine are acces la lista de facturi: depozitul intră pe /facturi ca să
  // vadă achizițiile, n-are treabă cu importul.
  const poateActualiza = (u) => u && ["admin", "financiar"].includes(u.rol);

  router.get("/facturi/actualizare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    if (!poateActualiza(ctx.user)) return redirect(ctx.res, "/facturi");
    const { inAsteptare, ultimaRulare, ultimaFactura, ultimaIncasare } = await stareaActualizarii();
    const mesaj = String(ctx.query.mesaj || "");
    const eroare = String(ctx.query.eroare || "");
    const randuriInAsteptare = inAsteptare.reduce((s, l) => s + Number(l.randuri || 0), 0);

    // Semnul de carte primește adresa reală a ERP-ului, luată din cererea
    // curentă — ca să meargă și de pe localhost, la testare.
    const gazda = (ctx.req.headers && ctx.req.headers.host) || "erp-cashmachine-app.onrender.com";
    const schema = /localhost|127\.0\.0\.1/.test(gazda) ? "http" : "https";
    const semn = SEMN_DE_CARTE.replace("__ERP__", `${schema}://${gazda}`);

    let vechime = "";
    if (ultimaRulare && ultimaRulare.pornit_la) {
      const t = Date.parse(String(ultimaRulare.pornit_la).replace(" ", "T") + "Z");
      const ore = isFinite(t) ? (Date.now() - t) / 3600000 : 0;
      vechime =
        ore < 1
          ? "acum mai puțin de o oră"
          : ore < 48
            ? `acum ${Math.round(ore)} ore`
            : `acum ${Math.round(ore / 24)} zile`;
      if (ore > 36) {
        vechime = `<span style="color:var(--danger)">${vechime}</span>`;
      }
    }

    const body = `
      ${mesaj ? `<div class="flash">${esc(mesaj)}</div>` : ""}
      ${eroare ? `<div class="flash warn">${esc(eroare)}</div>` : ""}

      <div class="cards">
        <div class="card"><div class="label">În așteptare, neaplicat</div><div class="value">${inAsteptare.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">${randuriInAsteptare.toLocaleString("ro-RO")} rânduri culese din SmartBill</div></div>
        <div class="card"><div class="label">Ultima culegere</div><div class="value" style="font-size:18px">${vechime || "niciodată"}</div>
          <div style="font-size:12px;color:var(--text-muted)">${
            ultimaRulare ? esc(String(ultimaRulare.stare || "")) + " · " + Number(ultimaRulare.gasit || 0) + " documente găsite" : "nicio rulare raportată"
          }</div></div>
        <div class="card"><div class="label">Cea mai nouă factură din SmartBill</div><div class="value" style="font-size:18px">${esc(
          String((ultimaFactura && ultimaFactura.d) || "—").slice(0, 10)
        )}</div>
          <div style="font-size:12px;color:var(--text-muted)">ultima încasare: ${esc(String((ultimaIncasare && ultimaIncasare.d) || "—").slice(0, 10))}</div></div>
      </div>

      <h2>1. Bagă în ERP ce a venit deja</h2>
      <p class="explic" style="max-width:900px">
        Sincronizarea de noapte lasă documentele aici, în așteptare — nu le bagă singură în datele firmei.
        Butonul ăsta le aplică: facturile noi, încasările, producția. Rândurile care există deja se sar,
        deci îl poți apăsa de câte ori vrei fără să faci dubluri.
      </p>
      ${
        inAsteptare.length
          ? `<form method="post" action="/facturi/actualizare/aplica">
               <button class="btn" type="submit">Aplică tot (${inAsteptare.length} ${
                 inAsteptare.length === 1 ? "lot" : "loturi"
               }, ${randuriInAsteptare.toLocaleString("ro-RO")} rânduri)</button>
             </form>
             <div style="margin-top:10px">${table(
               ["Tip", "Rânduri", "Cules la", "De unde"],
               inAsteptare.map((l) => [
                 esc(String(l.tip)),
                 Number(l.randuri || 0).toLocaleString("ro-RO"),
                 esc(String(l.primit_la || "").slice(0, 16)),
                 `<span class="cel-lung">${esc(String(l.sursa || "—"))}</span>`,
               ])
             )}</div>`
          : `<p style="color:var(--text-muted)">Nimic în așteptare — tot ce a cules puntea e deja în ERP.</p>`
      }

      <h2>2. Culege acum din SmartBill</h2>
      <p class="explic" style="max-width:900px">
        SmartBill nu are un API care să listeze documentele pe o perioadă — API-ul lor e pentru emitere, nu
        pentru citire. Deci serverul nu poate întreba singur: <strong>datele se pot citi doar din fila ta
        de SmartBill, unde ești logat</strong>. Odată, trage linkul de mai jos în bara de favorite. Pe urmă,
        când vrei date proaspete: deschizi <a href="https://cloud.smartbill.ro" target="_blank" rel="noopener">cloud.smartbill.ro</a>,
        apeși favoritul, aștepți mesajul, și te întorci aici la pasul 1.
      </p>
      <p style="margin:10px 0 4px">
        <a href="${esc(semn)}"
           style="display:inline-block;padding:9px 14px;border:1px dashed var(--border);border-radius:8px;background:var(--bg-soft,#f6f6f4);font-weight:600;text-decoration:none"
           onclick="alert('Nu-l apăsa aici — trage-l cu mouse-ul în bara de favorite a browserului, apoi apasă-l în fila de SmartBill.');return false">
          ⟳ Sincronizare SmartBill
        </a>
        <span style="font-size:12px;color:var(--text-muted);margin-left:8px">↖ trage-l în bara de favorite</span>
      </p>
      <p class="mic" style="color:var(--text-muted);max-width:900px">
        Culege ultimele 14 zile. Nu cere parole și nu ține minte nimic: citește rapoartele pe care le vezi
        și tu, logat, și le trimite aici, unde stau până apeși „Aplică".
      </p>

      <h2>3. Ce merge singur</h2>
      <p class="explic" style="max-width:900px">
        Aceeași culegere rulează automat la 02:30, în browserul de pe calculatorul care rămâne pornit.
        Dacă „Ultima culegere" de sus e mai veche de o zi, ori calculatorul a fost închis, ori sesiunea de
        SmartBill a expirat — deschide o dată SmartBill și lasă fila logată.
      </p>

      <div class="toolbar" style="margin-top:18px">
        <a class="btn secondary" href="/facturi">Înapoi la facturi</a>
        ${ctx.user.rol === "admin" ? `<a class="btn secondary" href="/import/punte">Puntea, în detaliu</a>` : ""}
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Actualizare din SmartBill", active: "/facturi", body }));
  });

  router.post("/facturi/actualizare/aplica", async (ctx) => {
    if (!poateActualiza(ctx.user)) return redirect(ctx.res, "/facturi");
    const inapoi = (cheie, text) => `/facturi/actualizare?${cheie}=${encodeURIComponent(text)}`;
    // Cerut aici, nu sus, ca să nu se închidă un cerc între module.
    const { HANDLERE } = require("./punte");
    const aplicare = require("../lib/punte-aplica");
    const { rezultate, statusuri } = await aplicare.aplicaTot(HANDLERE);
    const statusText =
      statusuri.trecute_pe_incasat || statusuri.trecute_pe_partial
        ? ` Statusuri puse la zi: ${statusuri.trecute_pe_incasat} facturi trecute pe „încasată"` +
          (statusuri.trecute_pe_partial ? `, ${statusuri.trecute_pe_partial} pe „încasată parțial"` : "") +
          "."
        : "";
    if (!rezultate.length)
      return redirect(ctx.res, inapoi("mesaj", "N-a fost nimic nou de aplicat." + statusText));
    const { total, peTip } = aplicare.rezumat(rezultate);
    const detalii = [...peTip.entries()]
      .filter(([, v]) => v.noi)
      .map(([tip, v]) => `${tip}: ${v.noi}`)
      .join(" · ");
    const text =
      `Am aplicat ${total.loturi} ${total.loturi === 1 ? "lot" : "loturi"}: ` +
      `${total.noi} rânduri noi, ${total.sarite} sărite (existau deja).` +
      (detalii ? ` — ${detalii}` : "") +
      statusText +
      (total.erori ? ` ATENȚIE: ${total.erori} loturi au dat eroare, vezi /import/punte.` : "");
    redirect(ctx.res, inapoi(total.erori ? "eroare" : "mesaj", text));
  });

  // Ce a schimbat sincronizarea singură, după starea din SmartBill.
  //
  // De când factura își ia starea de încasare din SmartBill (17.11.2026), o
  // factură poate trece pe „plătită" fără nicio încasare în ERP — stornată,
  // compensată, ori încasată cu o chitanță mai veche decât fereastra raportului
  // de încasări. Aici se vede fiecare asemenea schimbare, cu ce era înainte:
  // lista celor de verificat când o cifră de „de încasat" pare prea mică.
  router.get("/facturi/stari-din-smartbill", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const randuri = await db
      .prepare(
        `SELECT s.id, s.factura_id, s.din, s.in_ce, s.motiv, s.la,
                f.serie, f.numar, f.document_extern, f.data_emiterii, f.status, f.activ, p.nume AS partener,
                COALESCE(t.total, 0) AS total, COALESCE(pl.platit, 0) AS platit
           FROM facturi_stare_istoric s
           JOIN facturi f ON f.id = s.factura_id
           LEFT JOIN parteneri p ON p.id = f.partener_id
           LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id) t ON t.factura_id = f.id
           LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id) pl ON pl.factura_id = f.id
          ORDER BY s.id DESC
          LIMIT 1000`
      )
      .all()
      .catch(() => []);
    const numeStare = { emisa: "emisă", platita_partial: "plătită parțial", platita: "plătită", anulata: "anulată" };
    const stinse = randuri.filter((r) => r.in_ce === "platita");
    const faraBani = stinse.filter((r) => Number(r.platit) < Number(r.total) - 0.5 && Number(r.total) > 0);
    const body = `
      <p><a href="/facturi">← Facturi vânzare</a></p>
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Schimbări (ultimele ${randuri.length})</div>${randuri.length}</div>
        <div><div class="k">Trecute pe „plătită”</div>${stinse.length}</div>
        <div><div class="k">…dintre care fără încasare în ERP</div>${faraBani.length} · ${money(faraBani.reduce((a, r) => a + Number(r.total) - Number(r.platit), 0))}</div>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:10px 0 0;max-width:820px">
        Sincronizarea citește din SmartBill și starea de încasare a fiecărei facturi. Când SmartBill o ține stinsă —
        încasată, stornată sau compensată —, factura trece aici pe „plătită” și iese de la restanțe, fără să i se
        nască o plată. Statusul doar urcă: dacă SmartBill o ține neîncasată și ERP-ul plătită, nu se schimbă nimic.
      </p></div>
      ${table(
        ["Când", "Factura", "Client", "Emisă", "Total", "Încasat în ERP", "Era", "A devenit", "De ce"],
        randuri.map((r) => [
          esc(String(r.la || "").slice(0, 16)),
          Number(r.activ) === 1
            ? `<a href="/facturi/${r.factura_id}">${esc(r.document_extern || `${r.serie}-${r.numar ?? r.factura_id}`)}</a>`
            : esc(r.document_extern || `${r.serie}-${r.numar ?? r.factura_id}`) + ' <span class="badge gri">scoasă</span>',
          esc(r.partener || "—"),
          esc(String(r.data_emiterii || "").slice(0, 10)),
          money(r.total),
          money(r.platit),
          esc(numeStare[r.din] || r.din || "—"),
          esc(numeStare[r.in_ce] || r.in_ce),
          esc(r.motiv || ""),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Stări aduse din SmartBill", active: "/facturi", body }));
  });

  router.get("/facturi/:id", async (ctx) => {
    const factura = await db
      .prepare(`SELECT f.*, p.nume AS partener_nume, p.cui, p.adresa FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`)
      .get(ctx.params.id);
    if (!factura) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/facturi", body: "<p>Factură inexistentă.</p>" }));

    // Cine n-are Facturarea sau Financiarul a intrat pe ușa agenților: vede
    // doar facturile clienților lui, și doar le citește.
    const doarCitire = !poateAccesa(ctx.user, "/facturi");
    if (doarCitire && !(await eFacturaAgentului(ctx.user, factura))) {
      return send(
        ctx.res,
        403,
        layout({
          user: ctx.user,
          title: "Factura altui client",
          active: "/crm",
          body: `<h1>Factura nu e a unui client de-al tău</h1>
            <p style="max-width:620px">Poți deschide facturile clienților alocați ție. Pentru celelalte, vorbește cu financiarul sau cu administratorul.</p>
            <a class="btn secondary" href="/crm/birou">Înapoi la biroul meu</a>`,
        })
      );
    }

    const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(factura.id);
    const { subtotal, tva, total } = calcTotals(linii);
    const plati = await db.prepare("SELECT * FROM (SELECT * FROM plati WHERE activ = 1) plati WHERE factura_id = ? ORDER BY id DESC").all(factura.id);
    const platit = plati.reduce((s, p) => s + p.suma, 0);
    // Ultima stare adusă singură din SmartBill (facturi_stare_istoric).
    const stareAdusa = await db
      .prepare("SELECT din, in_ce, la FROM facturi_stare_istoric WHERE factura_id = ? ORDER BY id DESC LIMIT 1")
      .get(factura.id)
      .catch(() => null);
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
      <div class="toolbar">${
        doarCitire
          ? `<a href="/crm/birou" class="btn secondary small">← Biroul meu</a> <a href="/parteneri/${factura.partener_id}" class="btn secondary small">Fișa clientului</a>`
          : `<a href="${listaInapoi}" class="btn secondary small">← ${eVanzare ? "Facturi vânzare" : "Facturi achiziție"}</a>`
      }</div>
      ${
        doarCitire
          ? `<p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">Vezi factura pentru că e a unui client de-al tău. Încasările, anularea și trimiterea în SmartBill rămân la facturare.</p>`
          : ""
      }
      ${
        eVanzare
          ? `<div class="toolbar" data-tipar-factura>
               <a class="btn secondary small" href="/facturi/${factura.id}/tipar" target="_blank">Tipărește / salvează ca PDF</a>
               ${pdfDinSmartbill(factura) ? `<a class="btn secondary small" href="/facturi/${factura.id}/pdf" target="_blank">Descarcă PDF-ul din SmartBill</a>` : ""}
             </div>`
          : ""
      }
      ${ctx.query.mesaj ? `<p style="color:var(--text-muted)">${esc(ctx.query.mesaj)}</p>` : ""}
      ${
        factura.status === "ciorna"
          ? `<div class="detail-box" style="border-left:4px solid var(--warn)">
              <strong>Factură ciornă.</strong>
              <p style="margin:6px 0 10px;max-width:660px;font-size:13px;color:var(--text-muted)">
                ${
                  factura.smartbill_sync_la
                    ? `<span data-ciorna-trimisa>A plecat deja în SmartBill (${esc([factura.smartbill_serie, factura.smartbill_numar].filter(Boolean).join("-"))}), dar în ERP a rămas nevalidată:
                       n-are număr la noi și n-a scăzut stocul. Validarea le face pe acestea două și <strong>nu o mai trimite o dată</strong> în SmartBill.</span>`
                    : `Nu are încă număr, nu a scăzut stocul și nu a plecat în SmartBill. Toate astea se întâmplă
                       la validare — pe care o face cineva cu drepturi pe facturare.`
                }
              </p>
              ${
                areFacturare(ctx.user)
                  ? `<form method="post" action="/facturi/${factura.id}/valideaza" class="inline-form"
                           onsubmit="return confirm('${factura.smartbill_sync_la ? "Validezi factura? Capătă număr în ERP și scade stocul. E deja în SmartBill, deci nu se mai trimite." : "Validezi factura? Se emite, scade stocul și pleacă în SmartBill."}')">
                       <button class="btn" type="submit">Validează și emite factura</button>
                     </form>`
                  : `<span style="font-size:13px;color:var(--text-muted)" data-asteapta-validarea>Nu ai drepturi de validare: factura așteaptă să fie validată de cineva de la facturare. După validare primește număr, pleacă în SmartBill și o poți tipări sau descărca de aici.</span>`
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
                }</div>
                <div data-upa-factura><div class="k">Seria</div>${
                  factura.smartbill_sync_la
                    ? esc(factura.smartbill_serie || "—")
                    : factura.sursa_import
                      ? esc(factura.serie || "—") // adusă din SmartBill: are deja seria ei
                    : Number(factura.upa) === 1
                      ? `<span class="badge albastru">unitate protejată (UPA)</span> <span style="font-size:12px;color:var(--text-muted)">pleacă pe ${esc(require("../lib/upa").serie(factura))}, cu mențiunea UPA</span>`
                      : "serie normală"
                }${
                  !factura.smartbill_sync_la && !factura.sursa_import && !doarCitire
                    ? ` <form method="post" action="/facturi/${factura.id}/upa" class="inline-form"><input type="hidden" name="upa" value="${Number(factura.upa) === 1 ? "0" : "1"}">
                         <button class="link-btn" type="submit">${Number(factura.upa) === 1 ? "treci pe seria normală" : "treci pe unitate protejată (UPA)"}</button></form>`
                    : ""
                }</div>`
              : ""
          }
        </div>
        ${
          // Mențiunile de pe factură — cursul la care o comandă în valută a fost
          // trecută în lei, o îndreptare făcută după emitere — se scriau, dar nu
          // se vedeau nicăieri.
          String(factura.observatii || "").trim()
            ? `<div data-observatii style="margin-top:10px;font-size:13px"><span style="color:var(--text-muted);font-size:12px">Observații</span><br>${esc(String(factura.observatii).trim())}</div>`
            : ""
        }
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
        <div>Încasat: ${money(platit)} · ${
          // „Plătită" fără plăți care s-o acopere: SmartBill o ține stinsă —
          // stornată, compensată, ori încasată cu o chitanță pe care raportul
          // de încasări n-a mai adus-o. Nu e un rest de încasat (lib/solduri.js).
          factura.status === "platita" && restant > 0.5
            ? `<span data-stinsa>Stinsă în SmartBill fără încasare adusă în ERP (stornare, compensare sau o încasare mai veche): nu mai e de încasat.${
                stareAdusa ? ` Starea a venit din SmartBill pe ${esc(String(stareAdusa.la || "").slice(0, 16))}.` : ""
              }</span>`
            : `Restant: ${money(restant)}`
        }</div>
      </div>

      <h2>Plăți</h2>
      ${table(
        ["Data", "Sumă", "Metodă", "Observații"],
        plati.map((p) => [esc(p.data), money(p.suma), esc(p.metoda), esc(p.observatii)])
      )}
      ${
        !doarCitire && factura.status !== "anulata" && restant > 0
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
        eVanzare && !doarCitire
          ? `<h2>Integrare SmartBill</h2>
      ${
        factura.status === "ciorna" && !factura.smartbill_sync_la
          ? `<p style="color:var(--text-muted);font-size:13px" data-smartbill-dupa-validare>Factura pleacă în SmartBill la validare. O ciornă nu se trimite.</p>`
          : smartbill.isConfigured()
          ? `<form method="post" action="/facturi/${factura.id}/smartbill" class="inline-form" id="spre-smartbill"${
              factura.smartbill_sync_la
                ? ` onsubmit="if (!confirm('Factura e deja în SmartBill. Dacă o trimiți din nou, SmartBill emite încă o factură. O trimiți din nou?')) return false; this.querySelector('button').disabled = true;"`
                : ` onsubmit="this.querySelector('button').disabled = true;"`
            }>
              ${factura.smartbill_sync_la ? '<input type="hidden" name="iar" value="1">' : ""}
              <button type="submit" class="btn secondary small">${factura.smartbill_sync_la ? "Retrimite în SmartBill" : "Trimite factura în SmartBill"}</button>
            </form>`
          : `<p style="color:var(--text-muted);font-size:13px">Integrarea SmartBill nu este configurată încă (lipsesc variabilele de mediu SMARTBILL_*). Vezi README.</p>`
      }`
          : ""
      }

      ${
        doarCitire
          ? ""
          : `<div class="toolbar" style="margin-top:14px">
        ${
          factura.status !== "anulata"
            ? `<form method="post" action="/facturi/${factura.id}/anuleaza" class="inline-form" onsubmit="return confirm('Anulezi factura?')"><button type="submit" class="btn secondary">Anulează factura</button></form>`
            : ""
        }
        <form method="post" action="/facturi/${factura.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi definitiv factura?')">
          <button type="submit" class="link-btn danger">Șterge factura</button>
        </form>
      </div>`
      }
    `;
    const emailuri = await inbox.blocEmailuri({ user: ctx.user, facturaId: factura.id });
    send(ctx.res, 200, layout({ user: ctx.user, title: `${eVanzare ? "Factură" : "Achiziție"} ${numeFactura(factura)}`, active: doarCitire ? "/crm" : eVanzare ? "/facturi" : "/facturi/achizitii", body: body + emailuri }));
  });

  // ---- Factura, de tipărit și de descărcat ---------------------------------------
  //
  // Vali, 18.11.2026: „când e gata văd factura emisă și o pot inclusiv downloada
  // sau printa". Două uși, amândouă deschise și agentului facturii:
  //   • /tipar — foaia făcută de ERP (aceeași ca proforma), pentru tipărit sau
  //     „Salvează ca PDF". Merge și pe ciornă, cu CIORNĂ scris peste ea.
  //   • /pdf — PDF-ul făcut de SmartBill, adică documentul fiscal, pentru
  //     facturile care au ajuns acolo. Doar se citește din SmartBill.
  async function facturaDeVazut(ctx) {
    const factura = await db
      .prepare(
        `SELECT f.*, p.nume AS partener_nume, p.cui, p.adresa, p.judet, p.localitate, p.reg_com, p.telefon AS p_telefon, p.email AS p_email, p.persoana_contact
           FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`
      )
      .get(ctx.params.id);
    if (!factura) {
      send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/facturi", body: "<p>Factură inexistentă.</p>" }));
      return null;
    }
    if (!poateAccesa(ctx.user, "/facturi") && !(await eFacturaAgentului(ctx.user, factura))) {
      send(ctx.res, 403, layout({ user: ctx.user, title: "Factura altui client", active: "/crm", body: `<h1>Factura nu e a unui client de-al tău</h1><a class="btn secondary" href="/facturile-mele">Facturile mele</a>` }));
      return null;
    }
    return factura;
  }

  router.get("/facturi/:id/tipar", async (ctx) => {
    const factura = await facturaDeVazut(ctx);
    if (!factura) return;
    const PF = require("../lib/proforma");
    const AV = require("../lib/aviz");
    const linii = await db
      .prepare(
        `SELECT l.*, pr.unitate_masura AS um, COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS cod
           FROM facturi_linii l LEFT JOIN produse pr ON pr.id = l.produs_id WHERE l.factura_id = ? ORDER BY l.id`
      )
      .all(factura.id);
    const comanda = factura.comanda_id ? await db.prepare("SELECT numar FROM comenzi WHERE id = ?").get(factura.comanda_id).catch(() => null) : null;
    const autor = factura.creata_de ? await db.prepare("SELECT nume FROM utilizatori WHERE id = ?").get(factura.creata_de).catch(() => null) : null;
    const nr = numarFiscal(factura);
    // Ciorna deja trimisă în SmartBill e, pentru client, factură emisă: poartă
    // numărul fiscal și nu poartă „CIORNĂ” (a rămas doar nevalidată în ERP).
    const ciorna = factura.status === "ciorna" && !nr.fiscal;
    const anulata = factura.status === "anulata";
    const doc = {
      serie: nr.serie,
      numar: nr.numar,
      data: String(factura.data_emiterii || "").slice(0, 10),
      data_scadenta: String(factura.data_scadenta || "").slice(0, 10) || null,
      client_nume: factura.partener_nume,
      client_cui: factura.cui || null,
      client_regcom: String(factura.reg_com || "").trim() || null,
      client_adresa: AV.adresaClient(factura) || null,
      client_contact: String(factura.persoana_contact || "").trim() || null,
      client_telefon: String(factura.p_telefon || "").trim() || null,
      client_email: String(factura.p_email || "").trim() || null,
      comanda_numar: comanda ? String(comanda.numar || "").trim() || "#" + factura.comanda_id : null,
      moneda: "RON",
      observatii: String(factura.observatii || "").trim() || null,
      mentiune: Number(factura.upa) === 1 ? require("../lib/upa").mentiune(factura.partener_nume) : null,
      creat_de: (autor && autor.nume) || "",
      anulat: anulata ? 1 : 0,
    };
    const subsol = ciorna
      ? "Ciornă: nu e încă factură. Capătă număr și pleacă în SmartBill la validarea făcută de financiar."
      : nr.fiscal
        ? `Copie din ERP a facturii ${nr.serie} ${nr.numar}. Documentul fiscal este cel emis din SmartBill.`
        : "Factură emisă în ERP, netrimisă încă în SmartBill: numărul fiscal îl dă SmartBill.";
    const bara = [
      ctx.query.mesaj ? `<span class="eroare">${esc(ctx.query.mesaj)}</span>` : "",
      `<button onclick="window.print()">Tipărește</button>`,
      `<button onclick="window.print()" title="În fereastra de tipărire alege „Salvează ca PDF”">Descarcă PDF</button>`,
      pdfDinSmartbill(factura) ? `<a href="/facturi/${factura.id}/pdf">PDF-ul din SmartBill</a>` : "",
      `<a href="/facturi/${factura.id}">Înapoi la factură</a>`,
    ]
      .filter(Boolean)
      .join(" ");
    send(ctx.res, 200, PF.pagina(doc, linii, { bara, titlu: "FACTURĂ", numeFisier: "Factura", filigran: ciorna ? "CIORNĂ" : "", subsol }));
  });

  router.get("/facturi/:id/pdf", async (ctx) => {
    const factura = await facturaDeVazut(ctx);
    if (!factura) return;
    const sb = pdfDinSmartbill(factura);
    const inapoi = (t) => redirect(ctx.res, `/facturi/${factura.id}/tipar?mesaj=` + encodeURIComponent(t));
    if (!sb) return inapoi("Factura n-a ajuns încă în SmartBill, deci n-are PDF acolo. Asta e foaia din ERP.");
    try {
      const buf = await smartbill.descarcaPdf(sb.serie, sb.numar);
      ctx.res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": buf.length,
        "Content-Disposition": `inline; filename="Factura-${String(sb.serie).replace(/[^A-Za-z0-9-]/g, "")}-${String(sb.numar).replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
        "Cache-Control": "private, no-store",
      });
      return ctx.res.end(buf);
    } catch (e) {
      console.error("[facturi] PDF din SmartBill:", e.message);
      return inapoi("PDF-ul din SmartBill n-a putut fi adus acum (" + e.message + "). Asta e foaia din ERP.");
    }
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
    if (!areFacturare(ctx.user)) {
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
    const factura = await db.prepare("SELECT * FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE id = ?").get(ctx.params.id);
    if (!factura) return redirect(ctx.res, "/facturi");
    if (factura.status !== "ciorna") return redirect(ctx.res, `/facturi/${factura.id}`);

    const linii = await db.prepare("SELECT * FROM facturi_linii WHERE factura_id = ?").all(factura.id);

    // Scadența, dacă ciorna n-a primit-o (ciornele de dinainte de 17.11.2026,
    // sau o comandă fără termen pe care s-a pus între timp unul pe fișă):
    // data facturii + termenul comenzii. Pleacă în SmartBill ca dueDate.
    // O scadență deja scrisă nu se atinge. Vezi lib/termen-plata.js.
    if (!String(factura.data_scadenta || "").trim()) {
      let termen = null;
      if (factura.comanda_id) {
        const c = await db.prepare("SELECT termen_plata_zile, partener_id FROM comenzi WHERE id = ?").get(factura.comanda_id);
        termen = TP.efectiv(c, { termen_plata_zile: await TP.alPartenerului(db, (c && c.partener_id) || factura.partener_id) });
      } else {
        termen = await TP.alPartenerului(db, factura.partener_id);
      }
      const sc = TP.scadenta(String(factura.data_emiterii || "").slice(0, 10) || new Date().toISOString().slice(0, 10), termen);
      if (sc) {
        await db.prepare("UPDATE facturi SET data_scadenta = ? WHERE id = ?").run(sc, factura.id);
        factura.data_scadenta = sc;
      }
    }

    // Numărul se dă abia acum: o ciornă nu consumă un număr de factură.
    let numar = factura.numar;
    if (!numar) {
      const m = await db
        .prepare("SELECT COALESCE(MAX(numar), 0) AS n FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE directie = 'vanzare' AND COALESCE(serie,'') = ?")
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

    // Marchează comanda ca facturată. Doar înainte pe drum: o comandă deja
    // plecată sau livrată (cu aviz, înaintea facturii) rămâne „în livrare" /
    // „livrată" — factura e legată de ea oricum (05.11.2026, lib/stadiu-comanda.js).
    if (factura.comanda_id) {
      await db
        .prepare("UPDATE comenzi SET status = 'facturata' WHERE id = ? AND status NOT IN ('in_livrare', 'livrata', 'livrata_partial')")
        .run(factura.comanda_id);
    }

    // Trimite în SmartBill, dacă e configurat. Dacă nu, factura rămâne validă
    // la noi și se poate retrimite oricând din pagina ei.
    //
    // O FACTURĂ NU PLEACĂ DE DOUĂ ORI (18.11.2026). Până azi validarea trimitea
    // fără să se uite dacă factura e deja acolo. Pe live erau cinci ciorne
    // trimise deja cu butonul „Trimite factura în SmartBill” (CSHM 3413, 3414,
    // 3416, 3417, 3418): validarea oricăreia ar fi emis-o a doua oară — un al
    // doilea document fiscal. Acum validarea trece prin aceleași două paze ca
    // butonul (deja trimisă / pe drum) și pleacă exact ca de la buton: cu
    // codurile produselor și cu țara, județul și localitatea clientului. Fără
    // ele SmartBill o refuza oricum („țara trebuie specificată”, „nu are codul
    // specificat”), deci validarea nu trimitea de fapt niciodată.
    let mesajSmartbill = "";
    const inSmartbill = await db.prepare("SELECT smartbill_sync_la, smartbill_serie, smartbill_numar FROM facturi WHERE id = ?").get(factura.id);
    if (inSmartbill && inSmartbill.smartbill_sync_la) {
      const care = [inSmartbill.smartbill_serie, inSmartbill.smartbill_numar].filter(Boolean).join("-");
      mesajSmartbill = `Factura era deja în SmartBill${care ? " (" + care + ")" : ""}: n-am trimis-o a doua oară.`;
    } else if (peDrum.has(Number(factura.id))) {
      mesajSmartbill = "Factura se trimite chiar acum în SmartBill: n-am trimis-o a doua oară.";
    } else if (smartbill.isConfigured()) {
      peDrum.add(Number(factura.id));
      try {
        const deTrimis = await facturaPentruSmartBill(factura.id);
        const a = ADR.pentruSmartBill(deTrimis);
        if (!a.sigur) {
          mesajSmartbill = "Factura e validă la noi. N-a plecat în SmartBill: lipsesc țara, județul sau localitatea clientului — apasă „Trimite factura în SmartBill” și completează-le.";
        } else {
          const rezultat = await smartbill.trimiteFactura(deTrimis, await liniiPentruSmartBill(factura.id), a);
          // `series` și `number`: așa le întoarce lib/smartbill.js.
          await scrieTrimisa(factura.id, rezultat, new Date().toISOString().slice(0, 19).replace("T", " "));
          mesajSmartbill = "Trimisă și în SmartBill.";
        }
      } catch (e) {
        mesajSmartbill =
          "Factura e validă la noi, dar nu a plecat în SmartBill: " +
          e.message +
          (eRefuzLimpede(e.message) ? "" : " Nu se știe dacă a ajuns: uită-te în SmartBill înainte să o trimiți din nou.");
      } finally {
        peDrum.delete(Number(factura.id));
      }
    } else {
      mesajSmartbill = "SmartBill nu e configurat, așa că factura a rămas doar la noi.";
    }

    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'factura', ?, ?, ?)")
      .run(factura.partener_id, `Factura ${factura.serie || ""} ${numar} validată`.trim(), [mesajSmartbill, avertismentStoc].filter(Boolean).join(" "), ctx.user.id);

    redirect(ctx.res, `/facturi/${factura.id}?mesaj=${encodeURIComponent([mesajSmartbill, avertismentStoc].filter(Boolean).join(" "))}`);
  });

  // ---- trimiterea în SmartBill --------------------------------------------
  //
  // SmartBill cere țara clientului (și, pentru România, județul și
  // localitatea). Prima trimitere reală, FCT-1 din 29.10.2026, a căzut cu
  // „(400) țara trebuie specificată", fiindcă partenerul avea doar adresa,
  // ca un singur șir de text. Acum:
  //   • dacă fișa clientului are datele, sau adresa lui (importată din
  //     SmartBill) le spune limpede, factura pleacă direct — iar ce s-a citit
  //     din adresă se scrie și în fișă;
  //   • altfel apare un formular scurt, cu ce s-a putut deduce completat.
  //     Omul confirmă, datele rămân în fișa clientului, factura pleacă.
  // Nicio valoare ghicită nu ajunge pe factură fără să fi văzut-o cineva:
  // un județ greșit pleacă la ANAF prin e-Factura.
  async function facturaPentruSmartBill(id) {
    return await db
      .prepare(
        `SELECT f.*, p.nume AS partener_nume, p.cui, p.reg_com, p.adresa, p.email,
                p.tara, p.judet, p.localitate
           FROM (SELECT * FROM facturi WHERE activ = 1) f JOIN parteneri p ON p.id = f.partener_id WHERE f.id = ?`
      )
      .get(id);
  }

  // Liniile, cum pleacă în SmartBill: cu unitatea de măsură a produsului și cu
  // codul lui. Codul e cel arătat peste tot în ERP — `cod`, altfel
  // `cod_generat` — iar produsul fără niciunul pleacă cu P-<id>, ca pe aviz și
  // pe etichete (lib/scan.js). Linia fără produs rămâne fără cod.
  async function liniiPentruSmartBill(facturaId) {
    const linii = await db
      .prepare(
        `SELECT fl.*, p.unitate_masura,
                COALESCE(NULLIF(TRIM(p.cod), ''), NULLIF(TRIM(p.cod_generat), '')) AS produs_cod
           FROM facturi_linii fl
           LEFT JOIN produse p ON p.id = fl.produs_id
          WHERE fl.factura_id = ? ORDER BY fl.id`
      )
      .all(facturaId);
    return linii.map((l) => ({ ...l, cod_smartbill: SCAN.codProdus(l.produs_cod, l.produs_id) }));
  }

  // Ce se spune omului când SmartBill refuză factura din cauza codului de
  // produs: care linii au plecat fără cod și de ce, sau cu ce coduri au plecat.
  // Doar la eroarea despre codul produsului — „codul fiscal" al clientului e
  // altă poveste, cu lămurirea ei mai jos.
  const eDespreCod = (mesaj) => /nu are codul|cod(ul|urile|uri)? (de )?produs/i.test(String(mesaj || ""));

  // Un răspuns 4xx e un refuz: SmartBill n-a emis nimic. Orice altceva — rețea
  // căzută, răspuns 5xx, niciun răspuns — lasă întrebarea deschisă.
  const eRefuzLimpede = (mesaj) => /răspuns cu eroare \(4[0-9][0-9]\)/.test(String(mesaj || ""));

  function lamurireCod(linii) {
    const faraCod = linii.filter((l) => !l.cod_smartbill);
    if (faraCod.length) {
      const una = faraCod.length === 1;
      return `<p>SmartBill cere cod la fiecare produs de pe factură. ${una ? "Linia" : "Liniile"}
        ${faraCod.map((l) => `<strong>${esc(l.denumire)}</strong>`).join(", ")}
        ${una ? "e scrisă" : "sunt scrise"} de mână, fără produs ales din nomenclator, așa că ${una ? "n-are" : "n-au"} cod.
        Factura trebuie făcută din nou, cu produsul ales din listă pe ${una ? "linia aceea" : "liniile acelea"}.</p>`;
    }
    return `<p>Produsele au plecat cu codurile: ${linii
      .map((l) => `${esc(l.denumire)} — <strong>${esc(l.cod_smartbill)}</strong>`)
      .join("; ")}. Dacă SmartBill vrea alt cod la un produs, corectează-l în fișa produsului și trimite din nou.</p>`;
  }

  // O factură trimisă de două ori înseamnă două facturi emise în SmartBill —
  // documente fiscale, care pleacă și în e-Factura. Două paze, amândouă pe
  // server, fiindcă un dublu-clic trimite două cereri oricât ar fi de atent
  // browserul:
  //   • cât o factură e pe drum spre SmartBill, a doua cerere pentru ea nu
  //     mai pleacă (`peDrum`);
  //   • o factură deja trimisă pleacă din nou doar dacă omul a cerut anume
  //     retrimiterea (`iar=1`, pus doar de butonul „Retrimite", după întrebare).
  //     O pagină rămasă deschisă, cu butonul vechi „Trimite", nu mai emite a
  //     doua factură.
  // `peDrum` ține în memoria serverului: ERP-ul rulează într-un singur proces
  // (Render, o instanță). Cu mai multe, paza ar trebui mutată în baza de date.
  const peDrum = new Set();
  const inapoiCuMesaj = (ctx, factura, mesaj) =>
    redirect(ctx.res, `/facturi/${factura.id}?mesaj=${encodeURIComponent(mesaj)}`);

  function ePeDrum(ctx, factura) {
    if (!peDrum.has(Number(factura.id))) return false;
    inapoiCuMesaj(ctx, factura, "Factura se trimite chiar acum în SmartBill. N-am trimis-o a doua oară — reîncarcă pagina peste câteva secunde.");
    return true;
  }

  function eDejaTrimisa(ctx, factura) {
    if (!factura.smartbill_sync_la || String((ctx.body || {}).iar || "") === "1") return false;
    const care = [factura.smartbill_serie, factura.smartbill_numar].filter(Boolean).join("-");
    inapoiCuMesaj(ctx, factura, `Factura e deja în SmartBill${care ? " (" + care + ")" : ""}. N-am trimis-o a doua oară. Dacă chiar trebuie emisă din nou, apasă „Retrimite în SmartBill”.`);
    return true;
  }

  const opritaDeLaADouaTrimitere = (ctx, factura) => ePeDrum(ctx, factura) || eDejaTrimisa(ctx, factura);

  // Ciorna nu pleacă în SmartBill: întâi o validează financiarul (Vali,
  // 18.11.2026: „din financiar, înainte de trimitere în SmartBill, se
  // validează"). Validarea o și trimite; butonul rămâne pentru factura validată
  // care n-a plecat (SmartBill oprit, date de client lipsă) și pentru retrimitere.
  function opritaNevalidata(ctx, factura) {
    if (factura.status !== "ciorna") return false;
    inapoiCuMesaj(
      ctx,
      factura,
      areFacturare(ctx.user)
        ? "Factura e ciornă: n-am trimis-o. Apasă „Validează și emite factura” — validarea o trimite și în SmartBill."
        : "Factura e ciornă: n-am trimis-o. Întâi o validează cineva de la facturare; validarea o trimite și în SmartBill."
    );
    return true;
  }

  async function trimiteInSmartBill(ctx, factura, adresa) {
    if (ePeDrum(ctx, factura)) return;
    peDrum.add(Number(factura.id));
    try {
      // Starea se citește din nou, sub pază: cererea asta putea să fi citit
      // factura înainte ca alta, pornită cu o clipă mai devreme, să o fi trimis.
      const acum = await db.prepare("SELECT smartbill_sync_la, smartbill_serie, smartbill_numar FROM facturi WHERE id = ?").get(factura.id);
      if (eDejaTrimisa(ctx, { ...factura, ...(acum || {}) })) return;
      return await trimiteAcum(ctx, factura, adresa);
    } finally {
      peDrum.delete(Number(factura.id));
    }
  }

  async function trimiteAcum(ctx, factura, adresa) {
    const linii = await liniiPentruSmartBill(factura.id);
    try {
      const rezultat = await smartbill.trimiteFactura(factura, linii, adresa);
      await scrieTrimisa(factura.id, rezultat, new Date().toISOString());
    } catch (err) {
      console.error("Eroare trimitere SmartBill:", err);
      return send(
        ctx.res,
        200,
        layout({ user: ctx.user,
          title: "Eroare integrare SmartBill",
          active: "/facturi",
          body: `<p>Trimiterea către SmartBill a eșuat: ${esc(err.message)}</p>
                 ${eDespreCod(err.message) ? lamurireCod(linii) : ""}
                 ${
                   eRefuzLimpede(err.message)
                     ? ""
                     : `<p><strong>Nu se știe dacă factura a ajuns.</strong> SmartBill n-a dat un răspuns limpede, așa că e posibil să o fi emis totuși.
                        Înainte să trimiți din nou, uită-te în SmartBill dacă factura apare acolo — altfel se emite de două ori.</p>`
                 }
                 <p style="color:var(--text-muted);font-size:13px">Clientul a plecat cu: ${esc(
                   [adresa.localitate, adresa.judet, adresa.tara].filter(Boolean).join(", ") || "fără localitate, județ și țară"
                 )}. Dacă eroarea e despre client, corectează-le în <a href="/parteneri/${esc(String(factura.partener_id))}">fișa clientului</a> și trimite din nou.</p>
                 <a href="/facturi/${factura.id}" class="btn secondary">Înapoi la factură</a>`,
        })
      );
    }
    return redirect(ctx.res, `/facturi/${factura.id}`);
  }

  function formularAdresa(ctx, factura, a, gresite) {
    const v = { tara: a.tara || "", judet: a.judet || "", localitate: a.localitate || "" };
    const ce = [...a.lipsa, ...a.dedus.map((x) => x + " (dedus, de verificat)")];
    const body = `
      <h1>Înainte de SmartBill: unde e clientul?</h1>
      ${gresite && gresite.length ? `<div class="flash warn">${esc(gresite.join(" "))}</div>` : ""}
      <p style="max-width:720px">
        SmartBill nu primește factura fără țara clientului, iar pentru o firmă din România cere și județul și
        localitatea. La <strong>${esc(factura.partener_nume)}</strong> ${ce.length ? `lipsesc: <strong>${esc(ce.join(", "))}</strong>.` : "trebuie confirmate."}
        Le completezi o singură dată — rămân în fișa clientului și data viitoare factura pleacă direct.
      </p>
      ${factura.adresa ? `<p style="font-size:13px;color:var(--text-muted);max-width:720px">Adresa din fișă: ${esc(factura.adresa)}</p>` : ""}
      <form method="post" action="/facturi/${factura.id}/smartbill/client" class="form" style="max-width:560px">
        ${String((ctx.body || {}).iar || "") === "1" ? '<input type="hidden" name="iar" value="1">' : ""}
        <label class="field"><span>Țară</span><input name="tara" value="${esc(v.tara)}" required placeholder="Romania"></label>
        <label class="field"><span>Județ (pentru România)</span>
          <select name="judet">
            <option value="">— (client din afara României)</option>
            ${ADR.JUDETE.map((j) => `<option value="${esc(j)}"${v.judet === j ? " selected" : ""}>${esc(j)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Localitate (la București: sectorul, ex. Sector 2)</span>
          <input name="localitate" value="${esc(v.localitate)}" required></label>
        <div class="form-actions">
          <button type="submit" class="btn">Salvează în fișa clientului și trimite în SmartBill</button>
          <a href="/facturi/${factura.id}" class="btn secondary">Renunță</a>
        </div>
      </form>`;
    return send(ctx.res, 200, layout({ user: ctx.user, title: "Datele clientului pentru SmartBill", active: "/facturi", body }));
  }

  // Seria facturii, cât n-a plecat în SmartBill: unitate protejată (UPA) sau
  // normală. Vine de pe comandă; aici se poate îndrepta înainte de trimitere.
  router.post("/facturi/:id/upa", async (ctx) => {
    const f = await db.prepare("SELECT id, directie, smartbill_sync_la, sursa_import FROM facturi WHERE id = ?").get(ctx.params.id);
    if (!f) return send(ctx.res, 404, "Factura nu există");
    // Nu și pe facturile aduse din SmartBill: acelea au deja seria lor.
    if (f.directie === "vanzare" && !f.smartbill_sync_la && !f.sursa_import) {
      const upa = String((ctx.body || {}).upa || "") === "1" ? 1 : 0;
      await db.prepare("UPDATE facturi SET upa = ? WHERE id = ?").run(upa, f.id);
      console.log(`[facturi] #${f.id}: ${upa ? "pe unitate protejată (UPA)" : "pe seria normală"} (${(ctx.user && ctx.user.nume) || "?"})`);
    }
    redirect(ctx.res, `/facturi/${f.id}`);
  });

  router.post("/facturi/:id/smartbill", async (ctx) => {
    const factura = await facturaPentruSmartBill(ctx.params.id);
    if (!factura) return redirect(ctx.res, "/facturi");
    if (factura.directie === "achizitie") return redirect(ctx.res, `/facturi/${ctx.params.id}`);

    if (opritaDeLaADouaTrimitere(ctx, factura)) return;
    if (opritaNevalidata(ctx, factura)) return;

    const a = ADR.pentruSmartBill(factura);
    if (!a.sigur) return formularAdresa(ctx, factura, a);

    // Ce s-a citit limpede din adresa importată se scrie și în fișă: data
    // viitoare vine de acolo, iar omul vede pe fișa clientului ce a plecat.
    const deScris = Object.entries(a.deScrisInFisa);
    if (deScris.length) {
      for (const [camp, valoare] of deScris) {
        if (!["tara", "judet", "localitate"].includes(camp)) continue;
        await db.prepare(`UPDATE parteneri SET ${camp} = ? WHERE id = ? AND COALESCE(${camp}, '') = ''`).run(valoare, factura.partener_id);
      }
    }
    return await trimiteInSmartBill(ctx, factura, a);
  });

  router.post("/facturi/:id/smartbill/client", async (ctx) => {
    const factura = await facturaPentruSmartBill(ctx.params.id);
    if (!factura) return redirect(ctx.res, "/facturi");
    if (factura.directie === "achizitie") return redirect(ctx.res, `/facturi/${ctx.params.id}`);

    if (opritaDeLaADouaTrimitere(ctx, factura)) return;
    if (opritaNevalidata(ctx, factura)) return;

    const v = ADR.verifica(ctx.body);
    if (!v.ok) {
      const a = ADR.pentruSmartBill(factura);
      return formularAdresa(ctx, factura, { ...a, ...v.date }, v.gresite);
    }
    await db
      .prepare("UPDATE parteneri SET tara = ?, judet = ?, localitate = ? WHERE id = ?")
      .run(v.date.tara, v.date.judet, v.date.localitate, factura.partener_id);
    return await trimiteInSmartBill(ctx, factura, v.date);
  });
}

module.exports = { register, calcTotals, STATUS_LABEL };
