"use strict";
// Trimiterea de emailuri direct din CRM, prin contul fiecărui agent.
// Configurarea contului stă în „Profilul meu → Email”, iar parola e cifrată
// în baza de date (vezi lib/mail.js).
const db = require("../lib/db");
const { esc, layout } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const mail = require("../lib/mail");

function adrese(text) {
  return String(text || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

async function utilizatorComplet(id) {
  if (!id) return null;
  return await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(id);
}

function register(router) {
  // ---- Configurarea contului de email (per utilizator) ------------------
  router.get("/profil/email", async (ctx) => {
    const u = (await utilizatorComplet(ctx.user && ctx.user.id)) || {};
    const preset = mail.presetPentru(u.email_expeditor || u.email);
    const body = `
      <div class="detail-box">
        <p style="margin:0">Emailurile trimise din CRM pleacă de la <strong>adresa ta</strong>, nu de la o adresă comună — așa răspunsul clientului ajunge direct la tine.</p>
      </div>
      ${
        preset && preset.nota
          ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">${esc(preset.nota)}</div>`
          : ""
      }
      <form class="form" method="post" action="/profil/email">
        <label class="field">Adresa de pe care trimiți
          <input type="email" name="email_expeditor" required value="${esc(u.email_expeditor || u.email || "")}" placeholder="nume@cashmachine.ro">
        </label>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          <label class="field">Server SMTP
            <input name="smtp_host" required value="${esc(u.smtp_host || (preset ? preset.host : ""))}" placeholder="smtp.gmail.com">
          </label>
          <label class="field">Port
            <input type="number" name="smtp_port" required value="${esc(String(u.smtp_port || (preset ? preset.port : 587)))}">
          </label>
        </div>
        <label class="field">Criptare
          <select name="smtp_securizare">
            <option value="starttls"${(u.smtp_securizare || "starttls") === "starttls" ? " selected" : ""}>STARTTLS — cazul obișnuit (port 587)</option>
            <option value="tls"${u.smtp_securizare === "tls" ? " selected" : ""}>TLS direct / SSL (port 465)</option>
          </select>
        </label>
        <label class="field">Utilizator (de obicei tot adresa de email)
          <input name="smtp_user" value="${esc(u.smtp_user || u.email_expeditor || u.email || "")}">
        </label>
        <label class="field">Parolă
          <input type="password" name="smtp_parola" placeholder="${u.smtp_parola_cifrata ? "••••••••  (lasă gol ca s-o păstrezi pe cea salvată)" : "parola contului sau parola de aplicație"}">
        </label>
        <label class="field">Semnătură (se adaugă la finalul fiecărui email)
          <textarea name="email_semnatura" rows="4" placeholder="Cu stimă,&#10;${esc(u.nume || "")}&#10;Cash Machine">${esc(u.email_semnatura || "")}</textarea>
        </label>
        <div class="form-actions">
          <button class="btn" type="submit">Salvează</button>
          <button class="btn secondary" type="submit" name="test" value="1">Salvează și trimite un email de test către mine</button>
        </div>
      </form>
      <p style="font-size:12px;color:var(--text-muted)">
        Parola e cifrată (AES-256-GCM) înainte de a fi salvată. Conexiunea către serverul de email se face criptat (STARTTLS sau TLS);
        dacă serverul nu acceptă criptare, trimiterea e refuzată intenționat, ca parola să nu circule în clar.
      </p>
      ${
        ctx.query.rezultat
          ? `<div class="flash"${ctx.query.rezultat === "ok" ? "" : ' style="background:#f8e5e3;border-color:#e8bdb8;color:var(--danger)"'}>${esc(
              ctx.query.rezultat === "ok" ? "Emailul de test a plecat. Verifică-ți inboxul." : String(ctx.query.rezultat)
            )}</div>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Contul meu de email", active: "/crm", body }));
  });

  router.post("/profil/email", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body;
    const parolaNoua = String(b.smtp_parola || "");
    const seturi = ["email_expeditor = ?", "smtp_host = ?", "smtp_port = ?", "smtp_user = ?", "smtp_securizare = ?", "email_semnatura = ?"];
    const args = [
      String(b.email_expeditor || "").trim(),
      String(b.smtp_host || "").trim(),
      parseInt(b.smtp_port, 10) || 587,
      String(b.smtp_user || "").trim() || null,
      b.smtp_securizare === "tls" ? "tls" : "starttls",
      String(b.email_semnatura || "").trim() || null,
    ];
    // Parola goală = „păstrează ce era salvat” (altfel, orice salvare a
    // semnăturii ar șterge parola).
    if (parolaNoua) {
      seturi.push("smtp_parola_cifrata = ?");
      args.push(mail.cifreaza(parolaNoua));
    }
    args.push(ctx.user.id);
    await db.prepare(`UPDATE utilizatori SET ${seturi.join(", ")} WHERE id = ?`).run(...args);

    if (!b.test) return redirect(ctx.res, "/profil/email");

    const u = await utilizatorComplet(ctx.user.id);
    const config = mail.configUtilizator(u);
    if (!config) return redirect(ctx.res, "/profil/email?rezultat=" + encodeURIComponent("Configurația e incompletă."));
    try {
      await mail.trimite(config, {
        catre: [u.email_expeditor],
        subiect: "Test — ERP Cash Machine",
        corp: "Dacă citești acest mesaj, contul tău de email e configurat corect și poți trimite emailuri direct din CRM.",
      });
      redirect(ctx.res, "/profil/email?rezultat=ok");
    } catch (e) {
      redirect(ctx.res, "/profil/email?rezultat=" + encodeURIComponent(e.message));
    }
  });

  // ---- Compunere -------------------------------------------------------
  router.get("/crm/email/nou", async (ctx) => {
    const u = await utilizatorComplet(ctx.user && ctx.user.id);
    const config = mail.configUtilizator(u);

    const partenerId = parseInt(ctx.query.partener_id, 10) || null;
    const leadId = parseInt(ctx.query.lead_id, 10) || null;
    const oportunitateId = parseInt(ctx.query.oportunitate_id, 10) || null;

    let destinatar = "";
    let context = "";
    if (partenerId) {
      const p = await db.prepare("SELECT id, nume, email FROM parteneri WHERE id = ?").get(partenerId);
      if (p) {
        destinatar = p.email || "";
        context = `Către clientul <a href="/parteneri/${p.id}">${esc(p.nume)}</a>${p.email ? "" : " — atenție, partenerul nu are email salvat."}`;
      }
    } else if (leadId) {
      const l = await db.prepare("SELECT id, nume, companie, email FROM leaduri WHERE id = ?").get(leadId);
      if (l) {
        destinatar = l.email || "";
        context = `Către lead-ul <a href="/crm/leaduri/${l.id}">${esc(l.nume)}</a>${l.companie ? ` (${esc(l.companie)})` : ""}`;
      }
    }

    if (!config) {
      const body = `
        <div class="detail-box">
          <h2 style="margin-top:0">Contul tău de email nu e configurat încă</h2>
          <p>Ca să trimiți emailuri direct din CRM, configurează-ți contul o singură dată.</p>
          <a class="btn" href="/profil/email">Configurează acum</a>
        </div>`;
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Email nou", active: "/crm", body }));
    }

    const semnatura = u.email_semnatura ? `\n\n${u.email_semnatura}` : "";

    // Șabloane de email precompletate (deocamdată: urarea de zi de naștere,
    // folosită din Biroul agentului).
    let subiectPrecompletat = "";
    let corpPrecompletat = semnatura;
    if (ctx.query.sablon === "zi_nastere" && partenerId) {
      const p = await db.prepare("SELECT nume, persoana_contact FROM parteneri WHERE id = ?").get(partenerId);
      const catreCine = p && p.persoana_contact ? p.persoana_contact : "dumneavoastră";
      subiectPrecompletat = "La mulți ani! 🎂";
      corpPrecompletat = `Bună ziua,\n\nCu ocazia zilei de naștere, echipa Cash Machine vă urează ${
        catreCine === "dumneavoastră" ? "" : `dumneavoastră, ${catreCine}, `
      }un sincer „La mulți ani!" — multă sănătate, bucurii și reușite.\n\nVă mulțumim pentru colaborare și ne bucurăm să vă avem alături.${semnatura}`;
    }
    const body = `
      ${context ? `<div class="detail-box" style="padding:12px">${context}</div>` : ""}
      <form class="form" method="post" action="/crm/email">
        <input type="hidden" name="partener_id" value="${partenerId || ""}">
        <input type="hidden" name="lead_id" value="${leadId || ""}">
        <input type="hidden" name="oportunitate_id" value="${oportunitateId || ""}">
        <p style="font-size:13px;color:var(--text-muted);margin:0">De la: <strong>${esc(config.expeditor)}</strong> · <a href="/profil/email">schimbă</a></p>
        <label class="field">Către<input name="catre" required value="${esc(destinatar)}" placeholder="client@exemplu.ro"></label>
        <label class="field">Cc (opțional)<input name="cc" placeholder="coleg@cashmachine.ro"></label>
        <label class="field">Subiect<input name="subiect" required value="${esc(subiectPrecompletat)}"></label>
        <label class="field">Mesaj<textarea name="corp" rows="12" required>${esc(corpPrecompletat)}</textarea></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="inregistreaza" value="1" checked> Înregistrează și ca interacțiune în istoricul partenerului
        </label>
        <div class="form-actions"><button class="btn" type="submit">Trimite</button> <a class="btn secondary" href="/crm/activitate">Renunță</a></div>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Email nou", active: "/crm", body }));
  });

  router.post("/crm/email", async (ctx) => {
    const u = await utilizatorComplet(ctx.user && ctx.user.id);
    const config = mail.configUtilizator(u);
    if (!config) return redirect(ctx.res, "/profil/email");

    const b = ctx.body;
    const catre = adrese(b.catre);
    const cc = adrese(b.cc);
    const subiect = String(b.subiect || "").trim();
    const corp = String(b.corp || "");
    const partenerId = parseInt(b.partener_id, 10) || null;
    const leadId = parseInt(b.lead_id, 10) || null;
    const oportunitateId = parseInt(b.oportunitate_id, 10) || null;

    let status = "trimis";
    let eroare = null;
    try {
      if (!catre.length) throw new Error("Adresa destinatarului nu e validă.");
      await mail.trimite(config, { catre, cc, subiect, corp });
    } catch (e) {
      status = "esuat";
      eroare = e.message;
    }

    // Emailul se salvează în istoric și când eșuează — altfel n-ai cum să afli
    // de ce n-a ajuns mesajul la client.
    const ins = await db
      .prepare(
        `INSERT INTO emailuri (utilizator_id, partener_id, lead_id, oportunitate_id, catre, cc, subiect, corp, status, eroare)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(u.id, partenerId, leadId, oportunitateId, catre.join(", "), cc.join(", ") || null, subiect, corp, status, eroare);

    if (status === "trimis" && b.inregistreaza && (partenerId || leadId)) {
      await db
        .prepare("INSERT INTO interactiuni (partener_id, lead_id, utilizator_id, tip, subiect, descriere) VALUES (?, ?, ?, 'email', ?, ?)")
        .run(partenerId, leadId, u.id, subiect, corp);
      if (leadId) {
        await db
          .prepare("UPDATE leaduri SET ultima_activitate = ?, stadiu = CASE WHEN stadiu = 'nou' THEN 'contactat' ELSE stadiu END WHERE id = ?")
          .run(new Date().toISOString().slice(0, 10), leadId);
      }
    }
    redirect(ctx.res, `/crm/email/${ins.lastInsertRowid}`);
  });

  router.get("/crm/email/:id", async (ctx) => {
    const e = await db
      .prepare(
        `SELECT e.*, u.nume AS expeditor, p.nume AS partener_nume, l.nume AS lead_nume
         FROM emailuri e
         LEFT JOIN utilizatori u ON u.id = e.utilizator_id
         LEFT JOIN parteneri p ON p.id = e.partener_id
         LEFT JOIN leaduri l ON l.id = e.lead_id
         WHERE e.id = ?`
      )
      .get(ctx.params.id);
    if (!e) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/crm", body: "<p>Emailul nu există.</p>" }));

    const body = `
      ${
        e.status === "trimis"
          ? '<div class="flash">Emailul a fost trimis.</div>'
          : `<div class="flash" style="background:#f8e5e3;border-color:#e8bdb8;color:var(--danger)">Trimiterea a eșuat: ${esc(e.eroare || "motiv necunoscut")}</div>`
      }
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Către</div>${esc(e.catre)}</div>
          ${e.cc ? `<div><div class="k">Cc</div>${esc(e.cc)}</div>` : ""}
          <div><div class="k">Expeditor</div>${esc(e.expeditor || "—")}</div>
          <div><div class="k">Data</div>${esc((e.trimis_la || "").slice(0, 16))}</div>
          <div><div class="k">Context</div>${
            e.partener_id ? `<a href="/parteneri/${e.partener_id}">${esc(e.partener_nume || "")}</a>` : e.lead_id ? `<a href="/crm/leaduri/${e.lead_id}">${esc(e.lead_nume || "")}</a>` : "—"
          }</div>
        </div>
        <h2>${esc(e.subiect)}</h2>
        <div style="white-space:pre-wrap">${esc(e.corp)}</div>
      </div>
      <div class="toolbar">
        <a class="btn secondary" href="/crm/activitate">Înapoi la activitate</a>
        ${e.status !== "trimis" ? `<a class="btn" href="/crm/email/nou?partener_id=${e.partener_id || ""}&lead_id=${e.lead_id || ""}">Încearcă din nou</a>` : ""}
      </div>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Email", active: "/crm", body }));
  });
}

module.exports = { register };
