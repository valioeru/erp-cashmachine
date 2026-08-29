"use strict";
const db = require("../lib/db");
const alocari = require("./alocari");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const tsk = require("./taskuri");

const TIP_LABEL = { client: "Client", furnizor: "Furnizor", ambele: "Client & Furnizor" };
const STARE_LABEL = {
  lead: "Lead / prospect",
  client_activ: "Client activ",
  client_inactiv: "Client inactiv",
  furnizor_activ: "Furnizor activ",
};
const STARE_OPTIONS = Object.entries(STARE_LABEL).map(([value, label]) => ({ value, label }));
// Tipurile de interacțiune. Primele patru se aleg manual din formular;
// restul apar doar generate de sistem (task de contact, ofertă, notificare),
// de-aia stau separat — n-are sens să scrii de mână „ofertă acceptată".
const INTERACTIUNE_LABEL = { nota: "Notă", telefon: "Telefon", vizita: "Vizită", email: "Email", whatsapp: "WhatsApp", apel: "Apel telefonic", intalnire: "Întâlnire" };
const INTERACTIUNE_MANUAL = ["nota", "telefon", "vizita", "email", "whatsapp"];
const INTERACTIUNE_AUTO = { oferta: "Ofertă", contract: "Contract", comanda: "Comandă", notificare: "Notificare", factura: "Factură" };

function register(router) {
  // Lista de parteneri, ordonată după cât cântăresc de fapt: rulajul pe
  // ultimele 12 luni, nu alfabetic. Un client de 13 milioane și unul de 200
  // de lei n-au ce căuta unul lângă altul, nediferențiați, în aceeași listă.
  //
  // Se înregistrează ÎNAINTEA CRUD-ului generic, ca să câștige ruta /parteneri.
  router.get("/parteneri", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const tip = ["client", "furnizor", "ambii"].includes(String(ctx.query.tip)) ? String(ctx.query.tip) : "ambii";
    const cauta = String(ctx.query.q || "").trim();

    const args = [];
    let unde = "1 = 1";
    if (tip === "client") unde = "p.tip IN ('client','ambele')";
    else if (tip === "furnizor") unde = "p.tip IN ('furnizor','ambele')";
    if (cauta) {
      unde += " AND (LOWER(p.nume) LIKE ? OR LOWER(COALESCE(p.cui,'')) LIKE ?)";
      args.push("%" + cauta.toLowerCase() + "%", "%" + cauta.toLowerCase() + "%");
    }

    const T = "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
    const P = "(SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)";
    const acum12 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

    // Rulajul, soldul si ultima factura se calculeaza o singura data, grupat pe
    // partener, nu cate trei subinterogari corelate pentru fiecare rand din
    // lista. Varianta veche recitea tot facturi_linii si toate platile pentru
    // fiecare partener in parte — pagina statea 25 de secunde la 1.000 de
    // parteneri. Conditiile raman exact aceleasi, doar ca s-au mutat din WHERE
    // in CASE-urile de mai jos: „ultima" nu tine cont de intercompany, iar
    // rulajul si soldul da.
    const randuri = await db
      .prepare(
        `WITH agregat AS (
           SELECT f.partener_id,
                  COALESCE(SUM(CASE WHEN COALESCE(f.intercompany,0) = 0 AND f.data_emiterii >= ?
                                    THEN COALESCE(t.total,0) ELSE 0 END), 0) AS rulaj,
                  COALESCE(SUM(CASE WHEN COALESCE(f.intercompany,0) = 0 AND f.directie = 'vanzare'
                                     AND COALESCE(t.total,0) - COALESCE(pl.platit,0) > 0.5
                                    THEN COALESCE(t.total,0) - COALESCE(pl.platit,0) ELSE 0 END), 0) AS sold,
                  MAX(f.data_emiterii) AS ultima
             FROM (SELECT * FROM facturi WHERE activ = 1) f
             LEFT JOIN ${T} t ON t.factura_id = f.id
             LEFT JOIN ${P} pl ON pl.factura_id = f.id
            WHERE f.status NOT IN ('anulata','ciorna')
            GROUP BY f.partener_id
         )
         SELECT p.id, p.nume, p.tip, p.stare, p.cui, p.email, p.telefon,
                u.nume AS agent,
                COALESCE(a.rulaj, 0) AS rulaj,
                COALESCE(a.sold, 0) AS sold,
                a.ultima AS ultima
           FROM parteneri p
           LEFT JOIN utilizatori u ON u.id = p.agent_id
           LEFT JOIN agregat a ON a.partener_id = p.id
          WHERE ${unde}
          ORDER BY rulaj DESC, sold DESC, p.nume`
      )
      .all(acum12, ...args);

    const qs = cauta ? "&q=" + encodeURIComponent(cauta) : "";
    const buton = (v, eticheta) =>
      `<a class="btn ${tip === v ? "" : "secondary"}" href="/parteneri?tip=${v}${qs}">${esc(eticheta)}</a>`;

    const body = `
      <div class="toolbar">
        <a class="btn" href="/parteneri/nou">+ Partener nou</a>
        ${buton("ambii", "Toți")}
        ${buton("client", "Clienți")}
        ${buton("furnizor", "Furnizori")}
      </div>
      <form method="get" action="/parteneri" class="filtre">
        <input type="hidden" name="tip" value="${esc(tip)}">
        <input name="q" placeholder="caută după nume sau CUI" value="${esc(cauta)}" style="min-width:240px">
        <button class="btn secondary small" type="submit">Caută</button>
        ${cauta ? `<a class="btn secondary small" href="/parteneri?tip=${tip}">renunță</a>` : ""}
      </form>
      <p style="font-size:13px;color:var(--text-muted)">
        ${randuri.length} parteneri, ordonați după rulajul din ultimele 12 luni.
      </p>
      ${table(
        ["#", "Nume", "Tip", "Agent", "Rulaj 12 luni", "De încasat", "Ultima factură", "Stare"],
        randuri.slice(0, 300).map((r, i) => [
          String(i + 1),
          `<a href="/parteneri/${r.id}">${esc(r.nume)}</a>`,
          esc(TIP_LABEL[r.tip] || r.tip),
          esc(r.agent || "—"),
          money(r.rulaj),
          Number(r.sold) > 0.5 ? `<strong style="color:var(--danger)">${money(r.sold)}</strong>` : "—",
          r.ultima ? esc(String(r.ultima).slice(0, 10)) : "—",
          esc(STARE_LABEL[r.stare] || r.stare || "—"),
        ])
      )}
      ${randuri.length > 300 ? `<p style="color:var(--text-muted);font-size:13px">Se afișează primii 300. Folosește căutarea pentru restul.</p>` : ""}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Parteneri", active: "/parteneri", body }));
  });

  registerCrud(router, {
    path: "/parteneri",
    table: "parteneri",
    title: "Parteneri (clienți & furnizori)",
    singular: "partener",
    fields: [
      {
        name: "tip",
        label: "Tip",
        type: "select",
        required: true,
        default: "client",
        options: [
          { value: "client", label: "Client" },
          { value: "furnizor", label: "Furnizor" },
          { value: "ambele", label: "Client & Furnizor" },
        ],
      },
      { name: "nume", label: "Nume / denumire firmă", required: true },
      { name: "cui", label: "CUI / CIF" },
      { name: "email", label: "Email", type: "email" },
      { name: "telefon", label: "Telefon" },
      { name: "persoana_contact", label: "Persoană de contact" },
      { name: "stare", label: "Stare", type: "select", default: "client_activ", options: STARE_OPTIONS },
      { name: "sursa", label: "Sursă (de unde a venit)" },
      { name: "data_nastere", label: "Zi de naștere persoană de contact (pentru urări)", type: "date" },
      { name: "adresa", label: "Adresă", type: "textarea" },
    ],
    listColumns: [
      { key: "nume", label: "Nume", render: (r) => `<a href="/parteneri/${r.id}">${esc(r.nume)}</a>` },
      { key: "tip", label: "Tip", render: (r) => esc(TIP_LABEL[r.tip] || r.tip) },
      { key: "stare", label: "Stare", render: (r) => esc(STARE_LABEL[r.stare] || r.stare || "—") },
      { key: "cui", label: "CUI" },
      { key: "email", label: "Email" },
      { key: "telefon", label: "Telefon" },
    ],
  });

  // Schimbarea agentului responsabil — permisă doar administratorului.
  router.post("/parteneri/:id/agent", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, `/parteneri/${ctx.params.id}`);
    const agentId = parseInt(ctx.body.agent_id, 10);
    await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(Number.isFinite(agentId) && agentId > 0 ? agentId : null, ctx.params.id);
    redirect(ctx.res, `/parteneri/${ctx.params.id}`);
  });

  // Pagină de detaliu — istoricul complet al unui partener: comenzi, facturi
  // (vânzare & achiziție), oportunități CRM și interacțiuni/follow-up-uri.
  // Înregistrată după registerCrud, ca să nu intre în conflict cu rutele
  // literale /parteneri/nou, /parteneri/:id/editare etc.
  router.get("/parteneri/:id", async (ctx) => {
    const partener = await db
      .prepare("SELECT p.*, u.nume AS agent_nume FROM parteneri p LEFT JOIN utilizatori u ON u.id = p.agent_id WHERE p.id = ?")
      .get(ctx.params.id);
    if (!partener) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/parteneri", body: "<p>Partener inexistent.</p>" }));

    const comenzi = await db.prepare("SELECT id, numar, status, data FROM comenzi WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const facturi = await db.prepare("SELECT id, serie, numar, directie, status, data_emiterii FROM (SELECT * FROM facturi WHERE activ = 1) facturi WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const oportunitati = await db.prepare("SELECT * FROM oportunitati WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const taskuriPartener = await db.prepare(`${tsk.SELECT_TASK} WHERE t.partener_id = ? ORDER BY t.id DESC LIMIT 50`).all(partener.id);
    const emailuriPartener = await db.prepare("SELECT id, subiect, catre, status, trimis_la FROM emailuri WHERE partener_id = ? ORDER BY id DESC LIMIT 50").all(partener.id);
    const utilizatoriActivi = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const interactiuni = await db
      .prepare("SELECT i.*, u.nume AS agent FROM interactiuni i LEFT JOIN utilizatori u ON u.id = i.utilizator_id WHERE i.partener_id = ? ORDER BY i.data DESC, i.id DESC")
      .all(partener.id);

    const alocare = await alocari.alocariPentruPartener(partener.id);
    const alocareLinii = alocare.linii;
    const alocareExplicita = alocare.explicite;
    const utilizatoriAlocabili = await db
      .prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 AND rol IN ('admin','vanzari') ORDER BY rol DESC, nume")
      .all();

    // Semaforul de încasări al clientului, cu comanda adminului de a tăia
    // notificările pe el (client în insolvență, înțelegere separată etc).
    let blocSemafor = "";
    try {
      const st = await require("./scadente").stareClient(partener.id);
      const eticheta = { verde: "la zi", galben: "întârziere mică", rosu: "restanță" }[st.stare];
      blocSemafor = `
        <div style="margin-top:12px;font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span>Încasări:</span>
          <span class="badge ${st.stare}">${esc(eticheta)}</span>
          ${st.sold > 0.5 ? `<span>sold restant <strong>${money(st.sold)}</strong>${st.zileMax > 0 ? `, cea mai veche factură de ${st.zileMax} zile` : ""}</span>` : "<span>fără sold restant</span>"}
          ${st.stare === "rosu" ? `<span style="color:var(--danger)">agenții nu pot plasa comenzi pentru el</span>` : ""}
          ${
            ctx.user && ctx.user.rol === "admin"
              ? `<form method="post" action="/parteneri/${partener.id}/notificari" class="inline-form">
                   <input type="hidden" name="oprite" value="${Number(partener.notificari_oprite) === 1 ? 0 : 1}">
                   <button class="btn small secondary" type="submit">${Number(partener.notificari_oprite) === 1 ? "reia notificările" : "oprește notificările"}</button>
                 </form>`
              : Number(partener.notificari_oprite) === 1
                ? `<span class="badge gri">notificări oprite de admin</span>`
                : ""
          }
          <a class="btn small secondary" href="/scadente">vezi scadențarul</a>
        </div>`;
    } catch (e) {
      blocSemafor = "";
    }

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Tip</div>${esc(TIP_LABEL[partener.tip] || partener.tip)}</div>
          <div><div class="k">Stare</div>${esc(STARE_LABEL[partener.stare] || partener.stare || "—")}</div>
          <div><div class="k">CUI</div>${esc(partener.cui) || "—"}</div>
          <div><div class="k">Email</div>${esc(partener.email) || "—"}</div>
          <div><div class="k">Telefon</div>${esc(partener.telefon) || "—"}</div>
          <div><div class="k">Persoană de contact</div>${esc(partener.persoana_contact) || "—"}</div>
          <div><div class="k">Sursă</div>${esc(partener.sursa) || "—"}</div>
          <div><div class="k">Adresă</div>${esc(partener.adresa) || "—"}</div>
        </div>
        <div class="toolbar" style="margin-top:10px">
          <a href="/parteneri/${partener.id}/editare" class="btn secondary small">Editează datele</a>
          <a href="/crm/email/nou?partener_id=${partener.id}" class="btn secondary small">✉ Trimite email</a>
          <a href="/taskuri/nou?partener_id=${partener.id}" class="btn secondary small">+ Task</a>
        </div>
        ${blocSemafor}
        <div style="margin-top:12px;font-size:13px">
          <div style="margin-bottom:6px">Alocare pe agenți (din asta se calculează comisionul):
            <strong>${alocareLinii.length ? alocareLinii.map((a) => `${esc(a.nume)} ${Number(a.procent).toFixed(0)}%`).join(" · ") : "nealocat"}</strong>
            ${alocareExplicita ? "" : `<span style="color:var(--text-muted)"> (implicit, din agentul responsabil)</span>`}
          </div>
          ${
            ctx.user && ctx.user.rol === "admin"
              ? `<div style="max-width:420px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-subtle,#f6f7f9)">
                   <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
                     Poți împărți clientul între mai mulți oameni — ex. 70% agentul care l-a adus, 30% administratorul.
                     Suma procentelor nu poate trece de 100%.
                   </div>
                   ${alocari.formularAlocare(partener.id, alocareLinii, utilizatoriAlocabili, true)}
                 </div>`
              : (() => {
                  // Agentul își poate lua singur clientul, exact ca în lista de
                  // alocare: dacă e liber sau dacă îl ține administratorul (acolo
                  // a ajuns la import, fiindcă nu se știa al cui e). De la un alt
                  // agent nu se ia — acolo hotărăște administratorul.
                  const alMeu = alocareLinii.some((a) => a.utilizator_id === ctx.user.id);
                  const laAdmin = alocareLinii.length > 0 && alocareLinii.every((a) => a.rol === "admin");
                  if (alMeu) return `<span style="color:var(--text-muted)">E în portofoliul tău.</span>`;
                  if (alocareLinii.length && !laAdmin)
                    return `<span style="color:var(--text-muted)">E în portofoliul altui agent — doar administratorul îl poate muta.</span>`;
                  return `<form method="post" action="/crm/alocare" style="margin-top:4px">
                            <input type="hidden" name="client" value="${partener.id}">
                            <input type="hidden" name="inapoi" value="/parteneri/${partener.id}">
                            <button type="submit" class="btn" onclick="return confirm('Îl iei în portofoliul tău?')">Ia clientul în portofoliul meu</button>
                            <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
                              ${laAdmin ? "Acum e la administrator, fiindcă la import nu se știa al cui e." : "Clientul nu e alocat nimănui."}
                              Facturile lui — și cele vechi, de la ambele firme — trec pe numele tău și intră la comision.
                            </div>
                          </form>`;
                })()
          }
        </div>
      </div>

      <h2>Comenzi (${comenzi.length})</h2>
      ${table(
        ["Nr.", "Status", "Data"],
        comenzi.map((c) => [`<a href="/comenzi/${c.id}">${esc(c.numar || "#" + c.id)}</a>`, esc(c.status), esc(c.data)])
      )}

      <h2>Facturi (${facturi.length})</h2>
      ${table(
        ["Document", "Direcție", "Status", "Data"],
        facturi.map((f) => [
          `<a href="/facturi/${f.id}">${esc(f.serie)}-${f.numar ?? f.id}</a>`,
          f.directie === "achizitie" ? "Achiziție" : "Vânzare",
          esc(f.status),
          esc(f.data_emiterii),
        ])
      )}

      <h2>Oportunități CRM (${oportunitati.length})</h2>
      ${table(
        ["Titlu", "Stadiu", "Valoare estimată"],
        oportunitati.map((o) => [`<a href="/crm/oportunitati/${o.id}">${esc(o.titlu)}</a>`, esc(o.stadiu), money(o.valoare_estimata)])
      )}
      <div class="toolbar"><a href="/crm/oportunitati/noua?partener_id=${partener.id}" class="btn secondary small">+ Oportunitate nouă</a></div>

      <h2>Task-uri (${taskuriPartener.length})</h2>
      ${
        taskuriPartener.length
          ? table(tsk.CAPETE, taskuriPartener.map((t) => tsk.randTask(t, new Date().toISOString().slice(0, 10))))
          : '<p style="color:var(--text-muted)">Niciun task pentru acest partener.</p>'
      }

      <h2>Emailuri trimise (${emailuriPartener.length})</h2>
      ${
        emailuriPartener.length
          ? table(
              ["Data", "Subiect", "Către", "Status"],
              emailuriPartener.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                esc(e.catre),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email trimis din aplicație.</p>'
      }

      <h2>Interacțiuni / istoric contact</h2>
      <form method="post" action="/parteneri/${partener.id}/interactiuni" class="form" style="max-width:520px">
        <label class="field"><span>Tip</span>
          <select name="tip">${INTERACTIUNE_MANUAL.map((v) => `<option value="${v}">${esc(INTERACTIUNE_LABEL[v])}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Subiect</span><input type="text" name="subiect"></label>
        <label class="field"><span>Descriere</span><textarea name="descriere" rows="2"></textarea></label>
        <label class="field"><span>Următorul contact (opțional)</span><input type="date" name="data_urmatoare_actiune"></label>
        <button type="submit" class="btn small">Adaugă</button>
      </form>
      ${table(
        ["Data", "Tip", "Subiect", "Descriere", "Următorul contact", "Cine"],
        interactiuni.map((i) => [
          esc(i.data),
          esc(INTERACTIUNE_LABEL[i.tip] || INTERACTIUNE_AUTO[i.tip] || i.tip),
          esc(i.subiect),
          esc(i.descriere),
          esc(i.data_urmatoare_actiune) || "—",
          esc(i.agent || "—"),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Partener: ${partener.nume}`, active: "/parteneri", body }));
  });

  router.post("/parteneri/:id/interactiuni", async (ctx) => {
    const { tip, subiect, descriere, data_urmatoare_actiune } = ctx.body;
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, data_urmatoare_actiune, utilizator_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ctx.params.id, tip || "nota", subiect || "", descriere || "", data_urmatoare_actiune || null, ctx.user ? ctx.user.id : null);
    redirect(ctx.res, `/parteneri/${ctx.params.id}`);
  });
}

module.exports = { register, TIP_LABEL, STARE_LABEL };
