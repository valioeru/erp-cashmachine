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

// ------------------------------------------------------------------
// Anuntul de comanda noua
// ------------------------------------------------------------------
// Pe langa fluxul din ERP (comanda intra in lista depozitului), comanda pleaca
// si pe email: la biroul firmei, la Mihai si inapoi la agentul care a plasat-o,
// ca sa aiba dovada scrisa fara sa intre in aplicatie. Adresele stau in
// setari_app, deci se schimba din baza fara sa mai umblam prin cod.
const CATRE_IMPLICIT = "office@cashmachine.ro, mihai.mosneanu@cashmachine.ro";

function adreseDinText(text) {
  return String(text || "")
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}

async function destinatariComandaNoua(agentEmail) {
  let brut = CATRE_IMPLICIT;
  try {
    const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'comanda_noua_catre'").get();
    if (r && String(r.valoare || "").trim()) brut = r.valoare;
  } catch (e) {
    // setarea lipseste: ramanem pe adresele implicite
  }
  const lista = adreseDinText(brut);
  for (const a of adreseDinText(agentEmail)) lista.push(a);
  const vazute = new Set();
  return lista.filter((a) => {
    const k = a.toLowerCase();
    if (vazute.has(k)) return false;
    vazute.add(k);
    return true;
  });
}

async function expeditorEmail(user) {
  const mail = require("../lib/mail");
  const candidati = [];
  if (user && user.id) candidati.push(user.id);
  for (const r of await db
    .prepare("SELECT id FROM utilizatori WHERE activ = 1 AND smtp_host IS NOT NULL ORDER BY CASE WHEN rol = 'admin' THEN 0 ELSE 1 END, id")
    .all())
    candidati.push(r.id);
  for (const id of candidati) {
    const u = await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(id);
    const cfg = u && mail.configUtilizator(u);
    if (cfg) return { user: u, config: cfg };
  }
  return null;
}

async function anuntaComandaNoua(comandaId, user) {
  const mail = require("../lib/mail");
  const c = await db
    .prepare(
      `SELECT c.*, p.nume AS client, p.telefon AS client_telefon, p.email AS client_email, u.nume AS agent, u.email AS agent_email
         FROM comenzi c
         JOIN parteneri p ON p.id = c.partener_id
         LEFT JOIN utilizatori u ON u.id = c.agent_id
        WHERE c.id = ?`
    )
    .get(comandaId);
  if (!c) return { status: "esuat", eroare: "comanda nu a fost gasita" };

  const linii = await db
    .prepare(
      `SELECT cl.cantitate, cl.pret_unitar, pr.denumire, pr.unitate_masura
         FROM comenzi_linii cl JOIN produse pr ON pr.id = cl.produs_id
        WHERE cl.comanda_id = ?`
    )
    .all(comandaId);
  const total = linii.reduce((s, l) => s + Number(l.cantitate) * Number(l.pret_unitar), 0);
  const lei = (v) => Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " lei";

  const subiect = `Comandă nouă ${c.numar ? c.numar + " " : ""}#${c.id} — ${c.client}`;
  const corp = [
    `Comandă nouă în ERP.`,
    ``,
    `Client:   ${c.client}${c.client_telefon ? " · " + c.client_telefon : ""}${c.client_email ? " · " + c.client_email : ""}`,
    `Agent:    ${c.agent || "—"}`,
    `Număr:    ${c.numar || "(fără număr)"} (id ${c.id})`,
    `Livrare cerută: ${c.data_livrare_ceruta || "—"}`,
    ``,
    `Produse:`,
    ...linii.map((l) => `  - ${l.denumire} — ${l.cantitate} ${l.unitate_masura || "buc"} × ${lei(l.pret_unitar)} = ${lei(Number(l.cantitate) * Number(l.pret_unitar))}`),
    ``,
    `Total fără TVA: ${lei(total)}`,
    c.observatii ? `\nObservații: ${c.observatii}` : "",
    ``,
    `Comanda: ${(process.env.ERP_URL || "https://erp-cashmachine-app.onrender.com").replace(/\/$/, "")}/comenzi/${c.id}`,
  ].join("\n");

  const catre = await destinatariComandaNoua(c.agent_email || (user && user.email));
  let status = "trimis";
  let eroare = null;
  if (!catre.length) {
    status = "esuat";
    eroare = "Nu e configurată nicio adresă pentru anunțul de comandă nouă.";
  } else {
    const exp = await expeditorEmail(user);
    if (!exp) {
      status = "esuat";
      eroare = "Niciun utilizator nu are contul de email configurat (Profilul meu → Email).";
    } else {
      try {
        await mail.trimite(exp.config, { catre, subiect, corp });
      } catch (e) {
        status = "esuat";
        eroare = e.message;
      }
    }
  }

  try {
    await db
      .prepare(
        `INSERT INTO emailuri (utilizator_id, partener_id, catre, subiect, corp, status, eroare)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(user && user.id ? user.id : null, c.partener_id, catre.join(", ") || "—", subiect, corp, status, eroare);
  } catch (e) {
    console.error("[comenzi] nu am putut scrie emailul in istoric:", e.message);
  }
  return { status, eroare, catre };
}

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
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <label class="field"><span>Număr comandă (opțional)</span><input type="text" name="numar"></label>
        <label class="field"><span>Termen cerut de client</span><input type="date" name="data_livrare_ceruta"></label>
      </div>
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
      .prepare(
        "INSERT INTO comenzi (partener_id, numar, observatii, agent_id, data_livrare_ceruta) VALUES (?, ?, ?, ?, ?) RETURNING id"
      )
      .run(
        partener_id,
        numar || "",
        observatii || "",
        ctx.user ? ctx.user.id : null,
        String(ctx.body.data_livrare_ceruta || "") || null
      );
    const comandaId = info.lastInsertRowid;

    const insertLinie = db.prepare(
      "INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (?, ?, ?, ?)"
    );
    for (let i = 0; i < produsIds.length; i++) {
      const cant = Number(cantitati[i] || 0);
      if (cant > 0) await insertLinie.run(comandaId, produsIds[i], cant, Number(preturi[i] || 0));
    }

    // Anuntul pe email nu are voie sa strice plasarea comenzii: daca serverul
    // de mail e picat, comanda ramane, iar esecul se vede in istoricul de
    // emailuri, cu motivul scris pe el.
    try {
      await anuntaComandaNoua(comandaId, ctx.user);
    } catch (e) {
      console.error("[comenzi] anunt comanda noua:", e.message);
    }

    // Comanda NU mai pleacă direct în producție. Drumul ei e cel cerut de
    // Vali: intră în lista depozitului („comenzi deschise"), acolo se face
    // potrivirea cu stocul, și abia dacă marfa lipsește depozitul o comandă
    // mai departe — la un terț sau la producție. Vezi modules/warehouse.js.
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
    const facturi = await db
      .prepare("SELECT id, serie, numar, status FROM facturi WHERE comanda_id = ? ORDER BY id")
      .all(comanda.id);
    const factura = facturi[0] || null;

    // Cum stă comanda față de stoc — aceeași socoteală pe care o vede și
    // depozitul, ca agentul să nu întrebe pe telefon „a venit marfa?".
    const warehouse = require("./warehouse");
    let stoc = { linii: [], acoperiteTot: false, acoperitePartial: false };
    try {
      stoc = await warehouse.potrivire(comanda.id);
    } catch (e) {
      console.error("[comenzi] potrivire cu stocul:", e.message);
    }
    const stocPeLinie = new Map(stoc.linii.map((l) => [Number(l.id), l]));
    const rezervareActiva = stoc.linii.find((l) => l.rezervare);
    const aprovizionari = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs FROM aprovizionari a JOIN produse p ON p.id = a.produs_id
         WHERE a.comanda_id = ? ORDER BY a.id DESC`
      )
      .all(comanda.id);

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
        ["Produs", "Cantitate", "UM", "Preț unitar", "Subtotal", "În stoc acum"],
        linii.map((l) => {
          const st = stocPeLinie.get(Number(l.id));
          const stocTxt = !st
            ? "—"
            : st.ramas <= 0.0001
              ? '<span class="badge verde">livrată</span>'
              : st.lipsa <= 0.0001
                ? '<span class="badge verde">tot pe stoc</span>'
                : st.acoperit > 0.0001
                  ? `<span class="badge galben">parțial ${st.acoperit.toLocaleString("ro-RO", { maximumFractionDigits: 3 })}</span>`
                  : '<span class="badge rosu">lipsă</span>';
          return [
            esc(l.denumire),
            l.cantitate,
            esc(l.unitate_masura),
            money(l.pret_unitar),
            money(l.cantitate * l.pret_unitar),
            stocTxt,
          ];
        })
      )}
      <div class="totals"><span class="grand">Total: ${money(total)}</span></div>

      ${
        comanda.verificata_depozit_la
          ? `<div class="detail-box" style="margin-top:12px">
               <strong>Depozitul a verificat comanda</strong> la ${esc(String(comanda.verificata_depozit_la).slice(0, 16))}
               ${comanda.verificata_depozit_de ? " — " + esc(comanda.verificata_depozit_de) : ""}.
               ${stoc.acoperiteTot ? "Toată marfa e disponibilă." : stoc.acoperitePartial ? "O parte din marfă e disponibilă." : "Marfa nu e pe stoc."}
             </div>`
          : `<p style="color:var(--text-muted);font-size:13px;margin-top:12px">Comanda așteaptă verificarea depozitului.</p>`
      }
      ${
        rezervareActiva
          ? `<p class="badge galben">Stoc rezervat până la ${esc(String(rezervareActiva.rezervare.expira_la || "").slice(0, 16))} — după aceea se eliberează singur.</p>`
          : ""
      }
      ${
        aprovizionari.length
          ? `<h2>Aprovizionare cerută</h2>
             ${table(
               ["Produs", "Cantitate", "Sursă", "Termen cerut", "Termen confirmat", "Status"],
               aprovizionari.map((a) => [
                 esc(a.produs),
                 a.cantitate,
                 a.sursa === "productie" ? "producție" : "terț",
                 esc(a.termen_cerut || "—"),
                 esc(a.termen_confirmat || "—"),
                 esc(a.status),
               ])
             )}`
          : ""
      }

      ${
        stoc.acoperitePartial && !comanda.factura_id && comanda.status !== "anulata"
          ? `<h2>Ce faci cu comanda</h2>
             <div class="toolbar" style="flex-wrap:wrap;gap:8px">
               ${
                 stoc.acoperiteTot
                   ? `<form method="post" action="/comenzi/${comanda.id}/factureaza" class="inline-form"><button class="btn" type="submit">Facturează tot</button></form>`
                   : `<form method="post" action="/comenzi/${comanda.id}/factureaza-partial" class="inline-form"><button class="btn" type="submit">Facturează parțial ce e în stoc</button></form>`
               }
               <form method="post" action="/comenzi/${comanda.id}/decizie" class="inline-form">
                 <input type="hidden" name="decizie" value="astept">
                 <button class="btn secondary" type="submit">Aștept comanda completă</button>
               </form>
               <form method="post" action="/depozit/comanda/${comanda.id}/rezerva" class="inline-form">
                 <input type="hidden" name="inapoi" value="crm">
                 <button class="btn secondary" type="submit">Rezervă stocul 24 h</button>
               </form>
               ${
                 rezervareActiva
                   ? `<form method="post" action="/depozit/comanda/${comanda.id}/elibereaza" class="inline-form">
                        <input type="hidden" name="inapoi" value="crm">
                        <button class="link-btn" type="submit">Renunț la rezervare</button>
                      </form>`
                   : ""
               }
             </div>
             ${comanda.decizie_agent === "astept" ? '<p style="color:var(--text-muted);font-size:13px">Ai ales să aștepți comanda completă.</p>' : ""}`
          : ""
      }

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
          facturi.length
            ? facturi
                .map(
                  (f) =>
                    `<a href="/facturi/${f.id}" class="btn secondary">Factura ${esc(f.serie || "")}${esc(String(f.numar || f.id))}${String(f.status) === "ciorna" ? " (ciornă)" : ""}</a>`
                )
                .join(" ")
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

  // Decizia agentului după ce depozitul i-a spus ce are: „aștept comanda
  // completă" nu face nimic în stoc, doar o scrie, ca să nu întrebe nimeni
  // peste trei zile de ce stă comanda.
  router.post("/comenzi/:id/decizie", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const decizie = String((ctx.body || {}).decizie || "").slice(0, 30);
    await db.prepare("UPDATE comenzi SET decizie_agent = ? WHERE id = ?").run(decizie || null, ctx.params.id);
    const c = await db.prepare("SELECT partener_id, numar, id FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (c) {
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
        .run(c.partener_id, `Comanda ${c.numar || "#" + c.id}: ${decizie === "astept" ? "așteaptă comanda completă" : decizie}`, null, ctx.user.id);
    }
    redirect(ctx.res, `/comenzi/${ctx.params.id}`);
  });

  // Facturare parțială: intră pe factură doar cât e acoperit din stoc acum.
  // Restul rămâne pe comandă, cu „cantitate_livrata" mărită, ca a doua oară
  // să se factureze exact ce a mai rămas.
  router.post("/comenzi/:id/factureaza-partial", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const comanda = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(ctx.params.id);
    if (!comanda) return redirect(ctx.res, "/comenzi");
    if (comanda.status === "anulata") return redirect(ctx.res, `/comenzi/${comanda.id}`);

    const { linii: potrivite } = await require("./warehouse").potrivire(comanda.id);
    const deFacturat = potrivite.filter((l) => l.acoperit > 0.0001);
    if (!deFacturat.length) {
      return send(
        ctx.res,
        200,
        layout({
          user: ctx.user,
          title: "Nimic de facturat",
          active: "/comenzi",
          body: `<p style="max-width:620px">Nu e nimic disponibil pe stoc din comanda asta chiar acum.</p>
                 <a class="btn secondary" href="/comenzi/${comanda.id}">Înapoi la comandă</a>`,
        })
      );
    }

    const info = await db
      .prepare(
        "INSERT INTO facturi (partener_id, comanda_id, directie, status, creata_de, agent_id, data_emiterii, observatii) VALUES (?, ?, 'vanzare', 'ciorna', ?, ?, ?, ?) RETURNING id"
      )
      .run(
        comanda.partener_id,
        comanda.id,
        ctx.user.id,
        comanda.agent_id || ctx.user.id,
        new Date().toISOString().slice(0, 10),
        "facturare parțială — restul comenzii rămâne deschis"
      );
    const facturaId = info.lastInsertRowid;
    const insertLinie = db.prepare(
      "INSERT INTO facturi_linii (factura_id, produs_id, denumire, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const l of deFacturat) {
      const cota = await db.prepare("SELECT cota_tva FROM produse WHERE id = ?").get(l.produs_id);
      await insertLinie.run(facturaId, l.produs_id, l.denumire, l.acoperit, l.pret_unitar, cota ? cota.cota_tva : 21);
      await db
        .prepare("UPDATE comenzi_linii SET cantitate_livrata = COALESCE(cantitate_livrata, 0) + ? WHERE id = ?")
        .run(l.acoperit, l.id);
    }
    // Rezervările comenzii se sting: marfa tocmai a plecat pe factură.
    await db.prepare("UPDATE rezervari_stoc SET stare = 'consumata' WHERE comanda_id = ? AND stare = 'activa'").run(comanda.id);

    const rest = await db
      .prepare("SELECT COALESCE(SUM(cantitate - COALESCE(cantitate_livrata, 0)), 0) AS r FROM comenzi_linii WHERE comanda_id = ?")
      .get(comanda.id);
    if (Number(rest.r || 0) <= 0.0001) {
      await db.prepare("UPDATE comenzi SET status = 'facturata', factura_id = ? WHERE id = ?").run(facturaId, comanda.id);
    } else {
      await db.prepare("UPDATE comenzi SET decizie_agent = 'facturat_partial' WHERE id = ?").run(comanda.id);
    }
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
      .run(
        comanda.partener_id,
        `Facturare parțială din comanda ${comanda.numar || "#" + comanda.id}`,
        "Factură ciornă, așteaptă validare. Restul comenzii rămâne deschis.",
        ctx.user.id
      );
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
