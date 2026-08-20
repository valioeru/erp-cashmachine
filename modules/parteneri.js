"use strict";
const db = require("../lib/db");
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
const INTERACTIUNE_LABEL = { nota: "Notă", apel: "Apel telefonic", email: "Email", intalnire: "Întâlnire" };

function register(router) {
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

  // Pagină de detaliu — istoricul complet al unui partener: comenzi, facturi
  // (vânzare & achiziție), oportunități CRM și interacțiuni/follow-up-uri.
  // Înregistrată după registerCrud, ca să nu intre în conflict cu rutele
  // literale /parteneri/nou, /parteneri/:id/editare etc.
  router.get("/parteneri/:id", async (ctx) => {
    const partener = await db.prepare("SELECT * FROM parteneri WHERE id = ?").get(ctx.params.id);
    if (!partener) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/parteneri", body: "<p>Partener inexistent.</p>" }));

    const comenzi = await db.prepare("SELECT id, numar, status, data FROM comenzi WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const facturi = await db.prepare("SELECT id, serie, numar, directie, status, data_emiterii FROM facturi WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const oportunitati = await db.prepare("SELECT * FROM oportunitati WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const taskuriPartener = await db.prepare(`${tsk.SELECT_TASK} WHERE t.partener_id = ? ORDER BY t.id DESC LIMIT 50`).all(partener.id);
    const emailuriPartener = await db.prepare("SELECT id, subiect, catre, status, trimis_la FROM emailuri WHERE partener_id = ? ORDER BY id DESC LIMIT 50").all(partener.id);
    const interactiuni = await db.prepare("SELECT * FROM interactiuni WHERE partener_id = ? ORDER BY data DESC, id DESC").all(partener.id);

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
          <select name="tip">${Object.entries(INTERACTIUNE_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Subiect</span><input type="text" name="subiect"></label>
        <label class="field"><span>Descriere</span><textarea name="descriere" rows="2"></textarea></label>
        <label class="field"><span>Următorul contact (opțional)</span><input type="date" name="data_urmatoare_actiune"></label>
        <button type="submit" class="btn small">Adaugă</button>
      </form>
      ${table(
        ["Data", "Tip", "Subiect", "Descriere", "Următorul contact"],
        interactiuni.map((i) => [esc(i.data), esc(INTERACTIUNE_LABEL[i.tip] || i.tip), esc(i.subiect), esc(i.descriere), esc(i.data_urmatoare_actiune) || "—"])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Partener: ${partener.nume}`, active: "/parteneri", body }));
  });

  router.post("/parteneri/:id/interactiuni", async (ctx) => {
    const { tip, subiect, descriere, data_urmatoare_actiune } = ctx.body;
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, data_urmatoare_actiune) VALUES (?, ?, ?, ?, ?)")
      .run(ctx.params.id, tip || "nota", subiect || "", descriere || "", data_urmatoare_actiune || null);
    redirect(ctx.res, `/parteneri/${ctx.params.id}`);
  });
}

module.exports = { register, TIP_LABEL, STARE_LABEL };
