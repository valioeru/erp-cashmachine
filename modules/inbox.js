"use strict";
// Emailul adus în ERP: citire din Gmail, atașamentele în Drive, fiecare mesaj
// legat de partenerul, oferta sau factura lui.
//
// Ce NU face, intenționat:
//   - nu trimite de aici. Citirea are scope-ul gmail.readonly și atât; ce
//     pleacă din ERP pleacă prin CRM, pe un scope separat (gmail.send), care
//     la rândul lui nu poate citi nimic. Cele două nu se pot amesteca.
//   - nu șterge și nu marchează citit. Ce se întâmplă în Gmail rămâne treaba
//     omului; ERP-ul doar se uită.
//   - nu ține arhiva. Corpul se păstrează trunchiat, cât să se citească ce s-a
//     vorbit; pentru textul întreg există link direct în Gmail.
//
// Cine ce vede: fiecare își vede căsuța lui, căsuțele marcate „comune" le vede
// toată lumea cu drept la modul, iar administratorul vede tot. Asta se decide
// la adăugarea căsuței, nu după ce au intrat mesajele — mutarea unei căsuțe
// din personal în comun ar descoperi dintr-odată o mie de mesaje vechi.
const db = require("../lib/db");
const google = require("../lib/google");
const gmail = require("../lib/gmail");
const drive = require("../lib/drive");
const { esc, layout, table, dataRo, subnavCrm } = require("../lib/render");
const { send, redirect } = require("../lib/router");

// Cât din corpul mesajului se păstrează. Peste atât, textul se taie și rămâne
// legătura către Gmail. Zece mii de mesaje × 8 KB = 80 MB, ceea ce o bază mică
// duce fără să clipească; fără limită, prima campanie cu semnături în HTML ar
// umple-o singură.
const MAX_CORP = 8000;
// Un atașament de email nu trece de 25 MB (limita Gmail). Peste, e o eroare de
// citire, nu un document.
const MAX_ATASAMENT = 26 * 1024 * 1024;
const ZILE_INITIAL = 90;
const MAX_INITIAL = 300;
const MINUTE_SINCRONIZARE = 5;

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// --- cine vede ce ----------------------------------------------------------
function undeVedeUtilizatorul(user) {
  if (!user) return { sql: "1 = 0", args: [] };
  if (user.rol === "admin") return { sql: "1 = 1", args: [] };
  const conditii = ["c.tip = 'comun'", "c.utilizator_id = ?"];
  const args = [user.id];
  if (user.email) {
    conditii.push("lower(c.adresa) = lower(?)");
    args.push(user.email);
  }
  return { sql: "(" + conditii.join(" OR ") + ")", args };
}

// --- legarea automată de partener / ofertă / factură -----------------------
//
// Trei încercări, în ordinea în care sunt de încredere:
//   1. adresa exactă a partenerului — nu se poate greși;
//   2. numărul unui document din subiect — „Re: factura CSHM0123" spune singur
//      despre ce e vorba;
//   3. domeniul expeditorului — @acme.ro nimerește partenerul ACME, dar
//      ratează la gmail.com și yahoo.com, unde domeniul nu spune nimic.
// Ce nu se leagă rămâne nelegat și apare în lista „de atribuit". Un email pus
// la partenerul greșit e mai rău decât unul nelegat.
const DOMENII_PUBLICE = new Set([
  "gmail.com", "yahoo.com", "yahoo.ro", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "protonmail.com", "aol.com", "msn.com", "googlemail.com",
]);

function numereDinText(text) {
  const gasite = new Set();
  for (const m of String(text || "").matchAll(/\b([A-Za-zĂÂÎȘȚăâîșț]{2,8})[\s\-\/]?(\d{2,8})\b/g)) {
    gasite.add((m[1] + m[2]).toUpperCase());
  }
  for (const m of String(text || "").matchAll(/\b(\d{4,8})\b/g)) gasite.add(m[1]);
  return [...gasite].slice(0, 8);
}

async function gasestePartener(adrese) {
  for (const a of adrese) {
    if (!a.adresa) continue;
    const p = await db.prepare("SELECT id, nume FROM parteneri WHERE lower(email) = lower(?) ORDER BY id LIMIT 1").get(a.adresa);
    if (p) return { partener: p, cum: "adresa exactă" };
  }
  for (const a of adrese) {
    const d = gmail.domeniu(a.adresa);
    if (!d || DOMENII_PUBLICE.has(d)) continue;
    const p = await db.prepare("SELECT id, nume FROM parteneri WHERE lower(email) LIKE lower(?) ORDER BY id LIMIT 1").get("%@" + d);
    if (p) return { partener: p, cum: "domeniul " + d };
  }
  return { partener: null, cum: "" };
}

async function gasesteDocument(subiect) {
  const candidate = numereDinText(subiect);
  for (const t of candidate) {
    const o = await db.prepare("SELECT id, numar, partener_id FROM oferte WHERE upper(replace(COALESCE(numar,''),' ','')) = ? LIMIT 1").get(t);
    if (o) return { oferta: o, factura: null, cum: "oferta " + (o.numar || o.id) };
  }
  for (const t of candidate) {
    const f = await db
      // numărul facturii e coloană numerică, seria e text: fără CAST, Postgres
      // refuză concatenarea și ar pica la fiecare email, nu doar la cele cu
      // număr în subiect
      .prepare("SELECT id, serie, numar, partener_id FROM facturi WHERE upper(replace(COALESCE(serie,'') || COALESCE(CAST(numar AS TEXT),''),' ','')) = ? AND activ = 1 LIMIT 1")
      .get(t);
    if (f) return { oferta: null, factura: f, cum: "factura " + (f.serie || "") + (f.numar || "") };
  }
  return { oferta: null, factura: null, cum: "" };
}

async function leaga(m) {
  const toate = [...gmail.adrese(m.de_la), ...gmail.adrese(m.catre), ...gmail.adrese(m.cc)];
  const doc = await gasesteDocument(m.subiect);
  const p = await gasestePartener(toate);
  const partenerId = (p.partener && p.partener.id) || (doc.oferta && doc.oferta.partener_id) || (doc.factura && doc.factura.partener_id) || null;
  const motive = [p.cum, doc.cum].filter(Boolean);
  return {
    partener_id: partenerId,
    oferta_id: doc.oferta ? doc.oferta.id : null,
    factura_id: doc.factura ? doc.factura.id : null,
    legat_cum: motive.join(" · ") || null,
  };
}

// --- sincronizarea ---------------------------------------------------------
async function numePartener(id) {
  if (!id) return "Nealocate";
  const p = await db.prepare("SELECT nume FROM parteneri WHERE id = ?").get(id);
  return (p && p.nume) || "Nealocate";
}

async function salveazaAtasamente(cont, mesajId, m, partenerId) {
  const folderRadacina = google.folderDrive();
  const utile = (m.atasamente || []).filter((a) => !a.inline && a.nume);
  let urcate = 0;
  for (const a of utile) {
    let rand = { nume: a.nume, mime: a.mime, marime: a.marime, md5: null, drive_id: null, drive_link: null, duplicat: 0, eroare: null };
    try {
      if (!folderRadacina) throw new Error("GOOGLE_DRIVE_FOLDER nu e setată");
      if (a.marime > MAX_ATASAMENT) throw new Error("atașament prea mare (" + Math.round(a.marime / 1048576) + " MB)");
      const continut = await gmail.atasament(cont.adresa, m.id, a.atasamentId);
      const luna = String(m.data || "").slice(0, 7) || azi().slice(0, 7);
      const folder = await drive.cale([await numePartener(partenerId), luna], folderRadacina);
      const rez = await drive.urca({ nume: a.nume, mime: a.mime, continut, parinte: folder });
      rand = { nume: rez.nume, mime: a.mime, marime: rez.marime, md5: rez.md5, drive_id: rez.id, drive_link: rez.link, duplicat: rez.duplicat ? 1 : 0, eroare: null };
      urcate++;
    } catch (e) {
      // Un atașament care nu se urcă nu are voie să piardă mesajul. Rândul
      // rămâne, cu eroarea scrisă pe el, și se poate reîncerca.
      rand.eroare = mesajul(e).slice(0, 300);
    }
    await db
      .prepare(
        `INSERT INTO email_atasamente (mesaj_id, nume, mime, marime, md5, drive_id, drive_link, duplicat, eroare)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(mesajId, rand.nume, rand.mime, rand.marime, rand.md5, rand.drive_id, rand.drive_link, rand.duplicat, rand.eroare);
  }
  return { total: utile.length, urcate };
}

async function salveazaMesaj(cont, id) {
  const existent = await db.prepare("SELECT id FROM email_mesaje WHERE cont_id = ? AND gmail_id = ?").get(cont.id, id);
  if (existent) return { sarit: true };

  const m = await gmail.mesaj(cont.adresa, id);
  const de = gmail.adresa(m.de_la);
  const legaturi = await leaga(m);
  const directie = de.adresa && de.adresa === String(cont.adresa).toLowerCase() ? "trimis" : "primit";
  const corp = String(m.text || "").slice(0, MAX_CORP);

  const ins = await db
    .prepare(
      `INSERT INTO email_mesaje
         (cont_id, gmail_id, fir_id, data, de_la, de_la_nume, de_la_domeniu, catre, cc, subiect, snippet, corp, directie, etichete, nr_atasamente, partener_id, oferta_id, factura_id, legat_cum)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
    )
    .run(
      cont.id,
      m.id,
      m.firId,
      String(m.data || "").slice(0, 19).replace("T", " "),
      de.adresa,
      de.nume,
      gmail.domeniu(de.adresa),
      String(m.catre || "").slice(0, 500),
      String(m.cc || "").slice(0, 500),
      String(m.subiect || "").slice(0, 500),
      String(m.snippet || "").slice(0, 500),
      corp,
      directie,
      String(m.etichete || "").slice(0, 300),
      (m.atasamente || []).filter((a) => !a.inline && a.nume).length,
      legaturi.partener_id,
      legaturi.oferta_id,
      legaturi.factura_id,
      legaturi.legat_cum
    );
  const mesajId = Number(ins.lastInsertRowid);
  const at = await salveazaAtasamente(cont, mesajId, m, legaturi.partener_id);
  return { sarit: false, id: mesajId, atasamente: at.total, urcate: at.urcate };
}

// Un „throw" nu vine întotdeauna cu un Error: dacă vine un obiect simplu,
// String(el) dă „[object Object]" și mesajul adevărat se pierde. Aici nu se
// pierde — pentru pagina de verificare, mesajul ESTE tot ce are omul.
function mesajul(e) {
  if (!e) return "eroare fără mesaj";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try {
    const t = JSON.stringify(e);
    if (t && t !== "{}") return t;
  } catch (x) { /* obiecte cu cicluri */ }
  return String(e);
}

async function sincronizeazaCont(cont) {
  const rezumat = { adresa: cont.adresa, noi: 0, sarite: 0, atasamente: 0, eroare: null };
  try {
    let iduri = [];
    let historyNou = "";
    if (cont.history_id) {
      const h = await gmail.listeazaDupaIstoric(cont.adresa, cont.history_id);
      if (h.pierdut) {
        // Gmail nu mai ține istoricul de la punctul cerut. Se reia pe felie de
        // timp, altfel s-ar sări peste mesaje fără ca nimeni să afle.
        iduri = await gmail.listeazaDupaCautare(cont.adresa, `newer_than:${ZILE_INITIAL}d`, MAX_INITIAL);
        const p = await gmail.profil(cont.adresa);
        historyNou = p.historyId;
      } else {
        iduri = h.iduri;
        historyNou = h.historyId;
      }
    } else {
      iduri = await gmail.listeazaDupaCautare(cont.adresa, `newer_than:${ZILE_INITIAL}d`, MAX_INITIAL);
      const p = await gmail.profil(cont.adresa);
      historyNou = p.historyId;
    }

    for (const id of iduri) {
      const r = await salveazaMesaj(cont, id);
      if (r.sarit) rezumat.sarite++;
      else {
        rezumat.noi++;
        rezumat.atasamente += r.urcate || 0;
      }
    }

    await db
      .prepare("UPDATE email_conturi SET history_id = ?, ultima_sincronizare = ?, ultima_eroare = NULL, mesaje_aduse = mesaje_aduse + ? WHERE id = ?")
      .run(historyNou || cont.history_id || null, acum(), rezumat.noi, cont.id);
  } catch (e) {
    rezumat.eroare = mesajul(e).slice(0, 500);
    await db.prepare("UPDATE email_conturi SET ultima_sincronizare = ?, ultima_eroare = ? WHERE id = ?").run(acum(), rezumat.eroare, cont.id);
  }
  return rezumat;
}

let ruleaza = false;

async function sincronizeazaTot() {
  if (ruleaza) return [];
  ruleaza = true;
  try {
    const conturi = await db.prepare("SELECT * FROM email_conturi WHERE activ = 1 ORDER BY id").all();
    const rezultate = [];
    for (const c of conturi) rezultate.push(await sincronizeazaCont(c));

    // Cererile și comenzile se prind ACUM, nu la noapte. Un client care scrie
    // luni la 09:00 și al cărui task se naște marți la 02:00 a pierdut 17 din
    // cele 24 de ore de răspuns înainte ca agentul lui să afle că există.
    // Se cere târziu (nu sus, cu celelalte) ca să nu se lege modulele în cerc.
    try {
      const rez = await require("./culegere").clasificaMesaje({ zile: 3 });
      if (rez.taskuri) console.log(`[inbox] din emailuri: ${rez.cereri} cereri, ${rez.comenzi} comenzi, ${rez.taskuri} taskuri`);
    } catch (e) {
      console.error("[inbox] clasificarea a picat:", e.message);
    }
    return rezultate;
  } finally {
    ruleaza = false;
  }
}

function porneste() {
  if (!google.cont().ok) return; // fără cheie nu are ce porni
  setTimeout(() => {
    sincronizeazaTot().catch(() => {});
  }, 30000);
  setInterval(() => {
    sincronizeazaTot().catch(() => {});
  }, MINUTE_SINCRONIZARE * 60 * 1000);
}


// --- emailurile clienților unui agent, în CRM --------------------------------
//
// Agentul nu trebuie să intre în Inbox ca să vadă ce i-au scris clienții lui.
// Pagina asta ia clienții alocați lui — alocarea explicită, iar unde nu e,
// agentul de pe fișa partenerului — și arată ultimele mesaje primite de la
// fiecare. Câte 20 de client, cum a cerut Vali: destul cât să vezi firul
// discuției, nu atât cât să devină un al doilea inbox.
const EMAILURI_PE_CLIENT = 20;

async function paginaEmailuriAgent(ctx) {
  const eAdmin = ctx.user && ctx.user.rol === "admin";
  // Un admin poate privi peste umărul oricui; ceilalți se văd doar pe ei.
  const cerut = parseInt(ctx.query.agent, 10);
  const agentId = eAdmin && Number.isFinite(cerut) && cerut > 0 ? cerut : ctx.user.id;

  const agenti = eAdmin
    ? await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all()
    : [];

  // Clienții lui: alocarea explicită bate agent_id-ul de pe fișă.
  const clienti = await db
    .prepare(
      `SELECT DISTINCT p.id, p.nume
         FROM parteneri p
        WHERE p.id IN (SELECT partener_id FROM alocari_clienti WHERE utilizator_id = ?)
           OR (p.agent_id = ? AND NOT EXISTS (SELECT 1 FROM alocari_clienti a WHERE a.partener_id = p.id))
        ORDER BY p.nume`
    )
    .all(agentId, agentId);

  const cautat = String(ctx.query.q || "").trim().toLowerCase();
  const deAratat = cautat ? clienti.filter((c) => String(c.nume || "").toLowerCase().includes(cautat)) : clienti;

  const blocuri = [];
  let totalMesaje = 0;
  for (const cl of deAratat) {
    const mesaje = await db
      .prepare(
        `SELECT m.id, m.data, m.de_la, m.de_la_nume, m.subiect, m.fel, m.task_id, m.comanda_id,
                (SELECT COUNT(*) FROM email_atasamente a WHERE a.mesaj_id = m.id) AS atasamente
           FROM email_mesaje m
          WHERE m.activ = 1 AND m.directie = 'primit' AND m.partener_id = ?
          ORDER BY m.data DESC
          LIMIT ${EMAILURI_PE_CLIENT}`
      )
      .all(cl.id);
    if (!mesaje.length) continue;
    totalMesaje += mesaje.length;
    blocuri.push(`
      <h2 style="margin-top:22px;font-size:17px">
        <a href="/parteneri/${cl.id}">${esc(cl.nume)}</a>
        <span style="font-weight:400;font-size:13px;color:var(--text-muted)">· ${mesaje.length} ${mesaje.length === 1 ? "mesaj" : "mesaje"}</span>
      </h2>
      ${table(
        ["Data", "De la", "Subiect", "Ce e", "Atașamente"],
        mesaje.map((m) => [
          esc(String(m.data || "").slice(0, 16)),
          esc(m.de_la_nume || m.de_la || "—"),
          `<a href="/email/${m.id}">${esc(m.subiect || "(fără subiect)")}</a>`,
          m.fel === "comanda"
            ? `<span class="badge galben">comandă</span>${m.comanda_id ? ` <a href="/comenzi/${m.comanda_id}">ciorna</a>` : ""}`
            : m.fel === "cerere"
            ? `<span class="badge albastru">cerere</span>${m.task_id ? ` <a href="/taskuri/${m.task_id}">taskul</a>` : ""}`
            : "",
          Number(m.atasamente) ? String(m.atasamente) : "",
        ])
      )}`);
  }

  const body = `
    <p style="color:var(--text-muted);font-size:13px;max-width:820px">
      Ultimele ${EMAILURI_PE_CLIENT} mesaje primite de la fiecare client alocat${eAdmin ? "" : " ție"}.
      Cererile și comenzile sunt marcate, cu legătura către taskul sau ciorna născute din ele.
    </p>

    <form method="get" class="filtre" style="margin-bottom:8px">
      ${
        eAdmin
          ? `<select name="agent" onchange="this.form.submit()">
               ${agenti.map((a) => `<option value="${a.id}"${Number(a.id) === Number(agentId) ? " selected" : ""}>${esc(a.nume)}</option>`).join("")}
             </select>`
          : ""
      }
      <input name="q" value="${esc(ctx.query.q || "")}" placeholder="caută clientul">
      <button class="btn secondary small" type="submit">Caută</button>
    </form>

    <div class="cards">
      <div class="card"><div class="label">Clienți alocați</div><div class="value">${clienti.length}</div></div>
      <div class="card"><div class="label">Clienți care au scris</div><div class="value">${blocuri.length}</div></div>
      <div class="card"><div class="label">Mesaje afișate</div><div class="value">${totalMesaje}</div></div>
    </div>

    ${blocuri.length ? blocuri.join("") : "<p>Niciun email primit de la clienții alocați.</p>"}`;

  send(
    ctx.res,
    200,
    layout({ user: ctx.user, title: "Emailurile clienților mei", active: "/crm", body: subnavCrm("/crm/emailuri", ctx.user) + body })
  );
}

// --- blocul de emailuri pentru fișa unui partener / ofertă / factură -------
async function blocEmailuri(opts) {
  const o = opts || {};
  const unde = [];
  const args = [];
  if (o.partenerId) {
    unde.push("m.partener_id = ?");
    args.push(o.partenerId);
  } else if (o.ofertaId) {
    unde.push("m.oferta_id = ?");
    args.push(o.ofertaId);
  } else if (o.facturaId) {
    unde.push("m.factura_id = ?");
    args.push(o.facturaId);
  } else return "";

  const v = undeVedeUtilizatorul(o.user);
  const randuri = await db
    .prepare(
      `SELECT m.*, c.adresa AS casuta,
              (SELECT COUNT(*) FROM email_atasamente a WHERE a.mesaj_id = m.id) AS atasamente
         FROM email_mesaje m JOIN email_conturi c ON c.id = m.cont_id
        WHERE ${unde.join(" AND ")} AND m.activ = 1 AND ${v.sql}
        ORDER BY m.data DESC LIMIT 25`
    )
    .all(...args, ...v.args);
  if (!randuri.length) return "";

  return `
    <h2>Emailuri (${randuri.length})</h2>
    ${table(
      ["Data", "", "De la / către", "Subiect", "Atașamente", "Căsuța"],
      randuri.map((m) => [
        esc(String(m.data || "").slice(0, 16)),
        m.directie === "trimis" ? '<span class="badge gri">trimis</span>' : '<span class="badge albastru">primit</span>',
        esc(m.directie === "trimis" ? String(m.catre || "").slice(0, 60) : m.de_la_nume || m.de_la),
        `<a href="/email/${m.id}">${esc(m.subiect || "(fără subiect)")}</a>`,
        Number(m.atasamente) ? `<span class="badge verde">${m.atasamente}</span>` : "",
        esc(m.casuta),
      ])
    )}`;
}

// --- pagini ----------------------------------------------------------------
function subnav(activ) {
  const linkuri = [
    ["/email", "Inbox"],
    ["/email/atasamente", "Atașamente"],
    ["/email/conturi", "Căsuțe"],
    ["/email/culegere", "Culegere"],
    ["/configurari/email-google", "Conexiunea Google"],
  ];
  return `<div class="subnav">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

function pagina(ctx, titlu, activ, corp) {
  return layout({ user: ctx.user, title: titlu, active: "/email", body: subnav(activ) + corp });
}

function register(router) {
  // ---- inbox -------------------------------------------------------------
  router.get("/email", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const q = ctx.query || {};
    const v = undeVedeUtilizatorul(ctx.user);
    const unde = ["m.activ = 1", v.sql];
    const args = [...v.args];

    const cauta = String(q.q || "").trim();
    if (cauta) {
      unde.push("(lower(m.subiect) LIKE lower(?) OR lower(m.de_la) LIKE lower(?) OR lower(COALESCE(m.snippet,'')) LIKE lower(?))");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    if (q.directie === "primit" || q.directie === "trimis") {
      unde.push("m.directie = ?");
      args.push(q.directie);
    }
    if (q.cont) {
      unde.push("m.cont_id = ?");
      args.push(Number(q.cont));
    }
    if (q.legat === "nelegate") unde.push("m.partener_id IS NULL");
    if (q.legat === "legate") unde.push("m.partener_id IS NOT NULL");
    if (q.atasamente === "cu") unde.push("m.nr_atasamente > 0");
    if (q.de_la_data) {
      unde.push("m.data >= ?");
      args.push(String(q.de_la_data).slice(0, 10));
    }
    if (q.pana_la_data) {
      unde.push("m.data <= ?");
      args.push(String(q.pana_la_data).slice(0, 10) + " 23:59:59");
    }

    const randuri = await db
      .prepare(
        `SELECT m.*, c.adresa AS casuta, p.nume AS partener,
                (SELECT COUNT(*) FROM email_atasamente a WHERE a.mesaj_id = m.id) AS atasamente
           FROM email_mesaje m
           JOIN email_conturi c ON c.id = m.cont_id
           LEFT JOIN parteneri p ON p.id = m.partener_id
          WHERE ${unde.join(" AND ")}
          ORDER BY m.data DESC LIMIT 300`
      )
      .all(...args);

    const conturi = await db.prepare(`SELECT c.id, c.adresa FROM email_conturi c WHERE c.activ = 1 AND ${v.sql} ORDER BY c.adresa`).all(...v.args);
    const nr = await db
      .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN m.partener_id IS NULL THEN 1 ELSE 0 END) AS nelegate, SUM(m.nr_atasamente) AS atasamente
                  FROM email_mesaje m JOIN email_conturi c ON c.id = m.cont_id WHERE m.activ = 1 AND ${v.sql}`)
      .get(...v.args);

    const corp = `
      <div class="cards">
        <div class="card"><div class="label">Mesaje în ERP</div><div class="value">${Number((nr && nr.total) || 0).toLocaleString("ro-RO")}</div></div>
        <div class="card"><div class="label">Fără partener</div><div class="value">${Number((nr && nr.nelegate) || 0).toLocaleString("ro-RO")}</div></div>
        <div class="card"><div class="label">Atașamente</div><div class="value">${Number((nr && nr.atasamente) || 0).toLocaleString("ro-RO")}</div></div>
        <div class="card"><div class="label">Căsuțe</div><div class="value">${conturi.length}</div></div>
      </div>
      <form class="filtre" method="get" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <label>Caută <input name="q" value="${esc(cauta)}" placeholder="subiect, expeditor, text"></label>
        <label>Căsuța <select name="cont"><option value="">toate</option>${conturi
          .map((c) => `<option value="${c.id}"${String(q.cont || "") === String(c.id) ? " selected" : ""}>${esc(c.adresa)}</option>`)
          .join("")}</select></label>
        <label>Direcție <select name="directie"><option value="">primite și trimise</option><option value="primit"${q.directie === "primit" ? " selected" : ""}>doar primite</option><option value="trimis"${q.directie === "trimis" ? " selected" : ""}>doar trimise</option></select></label>
        <label>Legătură <select name="legat"><option value="">oricum</option><option value="legate"${q.legat === "legate" ? " selected" : ""}>legate de un partener</option><option value="nelegate"${q.legat === "nelegate" ? " selected" : ""}>de atribuit</option></select></label>
        <label>Atașamente <select name="atasamente"><option value="">oricum</option><option value="cu"${q.atasamente === "cu" ? " selected" : ""}>doar cu atașamente</option></select></label>
        <label>De la <input type="date" name="de_la_data" value="${esc(String(q.de_la_data || ""))}"></label>
        <label>Până la <input type="date" name="pana_la_data" value="${esc(String(q.pana_la_data || ""))}"></label>
        <button class="btn" type="submit">Filtrează</button>
        <a class="link-btn" href="/email">Șterge filtrele</a>
      </form>
      <form method="post" action="/email/sincronizeaza" class="inline-form" style="margin-bottom:12px">
        <button class="btn secondary" type="submit">Adu emailurile noi acum</button>
      </form>
      ${table(
        ["Data", "", "De la / către", "Subiect", "Partener", "Atașamente", "Căsuța"],
        randuri.map((m) => [
          esc(String(m.data || "").slice(0, 16)),
          m.directie === "trimis" ? '<span class="badge gri">trimis</span>' : '<span class="badge albastru">primit</span>',
          esc((m.directie === "trimis" ? String(m.catre || "").slice(0, 60) : m.de_la_nume || m.de_la) || ""),
          `<a href="/email/${m.id}">${esc(m.subiect || "(fără subiect)")}</a><br><span style="font-size:12px;color:var(--text-muted)">${esc(String(m.snippet || "").slice(0, 110))}</span>`,
          m.partener ? `<a href="/parteneri/${m.partener_id}">${esc(m.partener)}</a>` : '<span class="badge galben">de atribuit</span>',
          Number(m.atasamente) ? `<span class="badge verde">${m.atasamente}</span>` : "",
          esc(m.casuta),
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted)">Se arată ultimele 300 de mesaje din filtrul ales. Fiecare își vede căsuța lui, căsuțele comune le vede toată lumea, administratorul vede tot.</p>`;
    send(ctx.res, 200, pagina(ctx, "Emailuri", "/email", corp));
  });

  // ---- lista de atașamente ------------------------------------------------
  router.get("/email/atasamente", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const q = ctx.query || {};
    const v = undeVedeUtilizatorul(ctx.user);
    const unde = ["m.activ = 1", v.sql];
    const args = [...v.args];
    const cauta = String(q.q || "").trim();
    if (cauta) {
      unde.push("(lower(a.nume) LIKE lower(?) OR lower(COALESCE(m.subiect,'')) LIKE lower(?) OR lower(COALESCE(p.nume,'')) LIKE lower(?))");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    if (q.stare === "nereusite") unde.push("a.eroare IS NOT NULL");

    const randuri = await db
      .prepare(
        `SELECT a.*, m.subiect, m.data, m.partener_id, p.nume AS partener
           FROM email_atasamente a
           JOIN email_mesaje m ON m.id = a.mesaj_id
           JOIN email_conturi c ON c.id = m.cont_id
           LEFT JOIN parteneri p ON p.id = m.partener_id
          WHERE ${unde.join(" AND ")}
          ORDER BY m.data DESC, a.id DESC LIMIT 400`
      )
      .all(...args);

    const corp = `
      <form class="filtre" method="get" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <label>Caută <input name="q" value="${esc(cauta)}" placeholder="nume fișier, subiect, partener"></label>
        <label>Stare <select name="stare"><option value="">toate</option><option value="nereusite"${q.stare === "nereusite" ? " selected" : ""}>doar cele care n-au urcat</option></select></label>
        <button class="btn" type="submit">Filtrează</button>
        <a class="link-btn" href="/email/atasamente">Șterge filtrele</a>
      </form>
      ${table(
        ["Data", "Fișier", "Mărime", "Partener", "Din emailul", "În Drive"],
        randuri.map((a) => [
          esc(String(a.data || "").slice(0, 16)),
          esc(a.nume),
          a.marime ? (Number(a.marime) / 1024).toLocaleString("ro-RO", { maximumFractionDigits: 0 }) + " KB" : "",
          a.partener ? `<a href="/parteneri/${a.partener_id}">${esc(a.partener)}</a>` : "",
          `<a href="/email/${a.mesaj_id}">${esc(String(a.subiect || "(fără subiect)").slice(0, 70))}</a>`,
          a.drive_link
            ? `<a href="${esc(a.drive_link)}" target="_blank" rel="noopener">deschide</a>${Number(a.duplicat) ? ' <span class="badge gri">deja urcat</span>' : ""}`
            : `<span style="color:var(--danger);font-size:12px">${esc(a.eroare || "n-a urcat")}</span>`,
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted)">Fișierele stau în Drive-ul partajat, în <code>&lt;Partener&gt;/&lt;AAAA-LL&gt;</code>. Același fișier trimis de mai multe ori se urcă o singură dată — se recunoaște după amprenta md5.</p>`;
    send(ctx.res, 200, pagina(ctx, "Atașamente din emailuri", "/email/atasamente", corp));
  });

  // ---- căsuțe -------------------------------------------------------------
  router.get("/crm/emailuri", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    await paginaEmailuriAgent(ctx);
  });

  router.get("/email/conturi", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const eAdmin = ctx.user.rol === "admin";
    const conturi = await db
      .prepare(`SELECT c.*, u.nume AS utilizator, (SELECT COUNT(*) FROM email_mesaje m WHERE m.cont_id = c.id) AS mesaje
                  FROM email_conturi c LEFT JOIN utilizatori u ON u.id = c.utilizator_id ORDER BY c.tip, c.adresa`)
      .all();
    const utilizatori = await db.prepare("SELECT id, nume, email FROM utilizatori WHERE activ = 1 ORDER BY nume").all();

    const corp = `
      ${table(
        ["Adresa", "Tip", "Al cui", "Mesaje în ERP", "Ultima sincronizare", "Stare", ...(eAdmin ? [""] : [])],
        conturi.map((c) => [
          `<strong>${esc(c.adresa)}</strong>${c.eticheta ? `<br><span style="font-size:12px;color:var(--text-muted)">${esc(c.eticheta)}</span>` : ""}`,
          c.tip === "comun" ? '<span class="badge albastru">comună</span>' : '<span class="badge gri">personală</span>',
          esc(c.utilizator || ""),
          Number(c.mesaje).toLocaleString("ro-RO"),
          esc(String(c.ultima_sincronizare || "niciodată")),
          c.ultima_eroare
            ? `<span style="color:var(--danger);font-size:12px">${esc(c.ultima_eroare)}</span>`
            : Number(c.activ)
            ? '<span class="badge verde">activă</span>'
            : '<span class="badge gri">oprită</span>',
          ...(eAdmin
            ? [
                `<form method="post" action="/email/cont/${c.id}/comuta" class="inline-form"><button class="link-btn" type="submit">${Number(c.activ) ? "oprește" : "pornește"}</button></form>`,
              ]
            : []),
        ])
      )}
      ${
        eAdmin
          ? `<h2>Adaugă o căsuță</h2>
      <p style="color:var(--text-muted);font-size:13px;margin:-4px 0 12px">Trebuie să fie o adresă de pe domeniul firmei. O căsuță „comună" o vede toată lumea; una „personală", doar omul ei și tu.</p>
      <form method="post" action="/email/conturi" class="form" style="max-width:820px">
        <div class="rand" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <label style="flex:2 1 260px">Adresa <input name="adresa" type="email" required placeholder="cineva@cashmachine.ro"></label>
          <label style="flex:0 1 150px">Tip <select name="tip"><option value="personal">personală</option><option value="comun">comună</option></select></label>
          <label style="flex:1 1 200px">Al cui <select name="utilizator_id"><option value="">—</option>${utilizatori
            .map((u) => `<option value="${u.id}">${esc(u.nume)}</option>`)
            .join("")}</select></label>
          <label style="flex:2 1 200px">Etichetă <input name="eticheta" placeholder="ex. achiziții"></label>
          <button class="btn" type="submit">Adaugă</button>
        </div>
      </form>`
          : ""
      }`;
    send(ctx.res, 200, pagina(ctx, "Căsuțe de email", "/email/conturi", corp));
  });

  router.post("/email/conturi", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/email/conturi");
    const b = ctx.body || {};
    const adresa = String(b.adresa || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(adresa)) return redirect(ctx.res, "/email/conturi");
    await db
      .prepare(
        `INSERT INTO email_conturi (adresa, eticheta, tip, utilizator_id) VALUES (?,?,?,?)
         ON CONFLICT (adresa) DO UPDATE SET eticheta = EXCLUDED.eticheta, tip = EXCLUDED.tip, utilizator_id = EXCLUDED.utilizator_id, activ = 1`
      )
      .run(adresa, String(b.eticheta || "").slice(0, 100) || null, b.tip === "comun" ? "comun" : "personal", Number(b.utilizator_id) || null);
    return redirect(ctx.res, "/email/conturi");
  });

  router.post("/email/cont/:id/comuta", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/email/conturi");
    await db.prepare("UPDATE email_conturi SET activ = CASE WHEN activ = 1 THEN 0 ELSE 1 END WHERE id = ?").run(Number(ctx.params.id));
    return redirect(ctx.res, "/email/conturi");
  });

  router.post("/email/sincronizeaza", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    await sincronizeazaTot();
    return redirect(ctx.res, "/email");
  });

  // ---- un mesaj -----------------------------------------------------------
  router.get("/email/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const v = undeVedeUtilizatorul(ctx.user);
    const m = await db
      .prepare(
        `SELECT m.*, c.adresa AS casuta, p.nume AS partener
           FROM email_mesaje m JOIN email_conturi c ON c.id = m.cont_id
           LEFT JOIN parteneri p ON p.id = m.partener_id
          WHERE m.id = ? AND ${v.sql}`
      )
      .get(Number(ctx.params.id), ...v.args);
    if (!m) return redirect(ctx.res, "/email");
    const atasamente = await db.prepare("SELECT * FROM email_atasamente WHERE mesaj_id = ? ORDER BY id").all(m.id);
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 3000").all();

    const corp = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Subiect</div><strong>${esc(m.subiect || "(fără subiect)")}</strong></div>
          <div><div class="k">De la</div>${esc(m.de_la_nume ? `${m.de_la_nume} <${m.de_la}>` : m.de_la || "")}</div>
          <div><div class="k">Către</div>${esc(m.catre || "")}</div>
          ${m.cc ? `<div><div class="k">Cc</div>${esc(m.cc)}</div>` : ""}
          <div><div class="k">Data</div>${esc(String(m.data || "").slice(0, 16))}</div>
          <div><div class="k">Căsuța</div>${esc(m.casuta)} · ${m.directie === "trimis" ? "trimis" : "primit"}</div>
          <div><div class="k">Partener</div>${m.partener ? `<a href="/parteneri/${m.partener_id}">${esc(m.partener)}</a>` : "—"}${m.legat_cum ? ` <span style="font-size:12px;color:var(--text-muted)">(${esc(m.legat_cum)})</span>` : ""}</div>
          ${m.oferta_id ? `<div><div class="k">Ofertă</div><a href="/oferte/${m.oferta_id}">deschide oferta</a></div>` : ""}
          ${m.factura_id ? `<div><div class="k">Factură</div><a href="/facturi/${m.factura_id}">deschide factura</a></div>` : ""}
        </div>
      </div>
      <h2>Text</h2>
      <pre style="white-space:pre-wrap;font:inherit;background:var(--bg-subtle,#f6f7f9);padding:14px;border-radius:6px;max-width:900px">${esc(m.corp || m.snippet || "")}</pre>
      ${String(m.corp || "").length >= MAX_CORP ? `<p style="font-size:12px;color:var(--text-muted)">Textul e tăiat la ${MAX_CORP.toLocaleString("ro-RO")} de caractere. Restul se citește în Gmail.</p>` : ""}
      <p><a href="https://mail.google.com/mail/u/0/#all/${esc(m.gmail_id)}" target="_blank" rel="noopener">Deschide în Gmail</a></p>
      ${
        atasamente.length
          ? `<h2>Atașamente (${atasamente.length})</h2>
      ${table(
        ["Fișier", "Mărime", "În Drive"],
        atasamente.map((a) => [
          esc(a.nume),
          a.marime ? (Number(a.marime) / 1024).toLocaleString("ro-RO", { maximumFractionDigits: 0 }) + " KB" : "",
          a.drive_link
            ? `<a href="${esc(a.drive_link)}" target="_blank" rel="noopener">deschide</a>${Number(a.duplicat) ? ' <span class="badge gri">deja urcat</span>' : ""}`
            : `<span style="color:var(--danger);font-size:12px">${esc(a.eroare || "n-a urcat")}</span>`,
        ])
      )}`
          : ""
      }
      <h2>Atribuie</h2>
      <form method="post" action="/email/${m.id}/leaga" class="form" style="max-width:560px">
        <div class="rand" style="display:flex;gap:8px;align-items:flex-end">
          <label style="flex:1">Partener
            <select name="partener_id">
              <option value="">—</option>
              ${parteneri.map((p) => `<option value="${p.id}"${Number(m.partener_id) === Number(p.id) ? " selected" : ""}>${esc(p.nume)}</option>`).join("")}
            </select>
          </label>
          <button class="btn" type="submit">Salvează</button>
        </div>
      </form>`;
    send(ctx.res, 200, pagina(ctx, m.subiect || "Email", "/email", corp));
  });

  router.post("/email/:id/leaga", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const id = Number(ctx.params.id);
    const p = Number((ctx.body || {}).partener_id) || null;
    await db.prepare("UPDATE email_mesaje SET partener_id = ?, legat_cum = ? WHERE id = ?").run(p, p ? "pus de om" : null, id);
    return redirect(ctx.res, "/email/" + id);
  });

  // ---- verificarea conexiunii --------------------------------------------
  router.get("/configurari/email-google", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    send(ctx.res, 200, pagina(ctx, "Conexiunea Google", "/configurari/email-google", await paginaVerificare(null)));
  });

  router.post("/configurari/email-google", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const rezultate = await verifica();
    send(ctx.res, 200, pagina(ctx, "Conexiunea Google", "/configurari/email-google", await paginaVerificare(rezultate)));
  });
}

// --- verificarea, pas cu pas ----------------------------------------------
// Fiecare pas spune la ce punct din ghid se repară. Google răspunde cu
// „unauthorized_client" și atât; omul care a făcut configurarea acum douăzeci
// de minute n-are cum să ghicească ce înseamnă.
async function verifica() {
  const pasi = [];
  const adauga = (nume, ok, detaliu, unde) => pasi.push({ nume, ok, detaliu, unde });

  const c = google.cont();
  adauga("Cheia de service account e citită", c.ok, c.ok ? `${c.email} (proiect ${c.proiect || "necunoscut"})` : c.eroare, "pașii 1 și 4");
  if (!c.ok) return pasi;

  try {
    await google.tokenDrive();
    adauga("Google acceptă cheia", true, "s-a obținut token pentru Drive", "");
  } catch (e) {
    adauga("Google acceptă cheia", false, mesajul(e), "pasul 1");
    return pasi;
  }

  const folder = google.folderDrive();
  if (!folder) {
    adauga("Folderul din Drive", false, "GOOGLE_DRIVE_FOLDER nu e setată în Render", "pasul 4");
  } else {
    let pot = null;
    try {
      const info = await drive.info(folder);
      const cap = info.capabilities || {};
      pot = cap.canAddChildren;
      const unde = info.driveId
        ? `în Drive partajat (${info.driveId})`
        : "în My Drive, NU într-un Drive partajat";
      adauga(
        "Folderul din Drive există și e vizibil",
        true,
        `${info.name || folder} — ${unde}; contul tehnic poate adăuga fișiere: ${pot === undefined ? "nu spune Google" : pot ? "da" : "NU"}`,
        ""
      );
      // Dacă Google spune din capul locului că nu se pot adăuga fișiere, nu mai
      // încercăm urcarea: ne-ar da un 404 care arată ca un id greșit și am
      // trimite omul să caute unde nu trebuie.
      if (pot === false) {
        adauga(
          "Se poate scrie în folder",
          false,
          info.driveId
            ? "Google spune canAddChildren=false: contul tehnic e membru al Drive-ului partajat, dar rolul lui nu-i dă voie să adauge fișiere. Trebuie Content manager sau Manager — Viewer, Commenter și Contributor nu ajung. Dacă rolul e deja Content manager, atunci Drive-ul partajat are bifa „People outside <firma> can access files” stinsă, iar contul tehnic e, pentru Google, din afara domeniului."
            : "Folderul e într-un My Drive, nu într-un Drive partajat. Fișierele urcate acolo ar fi ale contului tehnic, iar un cont tehnic are spațiu zero — Google refuză. Mută folderul într-un Drive partajat.",
          "pasul 3"
        );
      } else {
        const proba = Buffer.from("test ERP " + new Date().toISOString(), "utf8");
        const urcat = await drive.urca({ nume: `erp-test-${Date.now()}.txt`, mime: "text/plain", continut: proba, parinte: folder });
        // Urcarea e ce contează; curățenia de după e treabă separată. Dacă le
        // ținem într-un singur try, un refuz la ștergere apare ca „nu se poate
        // scrie" — ceea ce e fals, și trimite omul să repare ce nu e stricat.
        adauga("Se poate scrie în folder", true, `am urcat un fișier de probă (${urcat.nume})`, "");
        try {
          await drive.sterge(urcat.id);
          adauga("Fișierul de probă s-a curățat", true, "mutat la coș", "");
        } catch (e2) {
          adauga(
            "Fișierul de probă a rămas în folder",
            false,
            `${urcat.nume} — urcarea a mers, doar curățarea nu: ${mesajul(e2)}. Nu blochează nimic, dar șterge-l tu din Drive.`,
            "fără efect asupra atașamentelor"
          );
        }
      }
    } catch (e) {
      adauga(
        "Folderul din Drive",
        false,
        mesajul(e) + (pot === true ? " — deși Google spunea că se poate scrie (canAddChildren=true), deci nu e permisiunea" : ""),
        "pasul 3 — ai dat share pe folder către adresa service account-ului?"
      );
    }
  }

  const conturi = await db.prepare("SELECT * FROM email_conturi WHERE activ = 1 ORDER BY adresa").all();
  if (!conturi.length) adauga("Căsuțe conectate", false, "nu e adăugată nicio căsuță", "adaugă-le la Email → Căsuțe");
  for (const cont of conturi) {
    try {
      const p = await gmail.profil(cont.adresa);
      // Trimiterea se verifică cerând doar tokenul cu scope-ul de trimitere.
      // NU pleacă niciun email de probă: un mesaj de test în inboxul unui
      // client e mai rău decât o verificare incompletă.
      let trimitere = "";
      try {
        await gmail.poateTrimite(cont.adresa);
        trimitere = " · poate și trimite";
      } catch (e2) {
        trimitere = ` · NU poate trimite (${mesajul(e2).slice(0, 120)}) — lipsește scope-ul gmail.send de la pasul 2`;
      }
      adauga(
        `Căsuța ${cont.adresa}`,
        true,
        `${p.mesaje.toLocaleString("ro-RO")} mesaje, ${p.fire.toLocaleString("ro-RO")} fire${trimitere}`,
        ""
      );
    } catch (e) {
      adauga(`Căsuța ${cont.adresa}`, false, mesajul(e), "pasul 2 — delegarea cu scope gmail.readonly");
    }
  }
  return pasi;
}

async function paginaVerificare(rezultate) {
  const c = google.cont();
  const folder = google.folderDrive();
  const intro = `
    <p style="color:var(--text-muted);font-size:13px;max-width:820px">
      Pagina asta verifică pe rând fiecare bucată din configurarea Google și spune, când ceva nu merge,
      la ce pas din ghidul de setare se repară. Nu schimbă nimic — singura scriere e un fișier de probă
      în folderul din Drive, pe care îl șterge imediat.
    </p>
    <div class="cards">
      <div class="card"><div class="label">GOOGLE_SA_JSON</div><div class="value">${c.ok ? "setată" : "lipsește"}</div></div>
      <div class="card"><div class="label">Service account</div><div class="value" style="font-size:14px">${c.ok ? esc(c.email) : "—"}</div></div>
      <div class="card"><div class="label">GOOGLE_DRIVE_FOLDER</div><div class="value">${folder ? "setată" : "lipsește"}</div></div>
    </div>
    <form method="post" action="/configurari/email-google" class="inline-form" style="margin:14px 0">
      <button class="btn" type="submit">Verifică acum</button>
    </form>`;

  if (!rezultate) return intro;

  return (
    intro +
    table(
      ["Pas", "Stare", "Detalii", "Unde se repară"],
      rezultate.map((p) => [
        `<strong>${esc(p.nume)}</strong>`,
        p.ok ? '<span class="badge verde">merge</span>' : '<span class="badge rosu">nu merge</span>',
        `<span style="font-size:12px${p.ok ? "" : ";color:var(--danger)"}">${esc(p.detaliu)}</span>`,
        `<span style="font-size:12px;color:var(--text-muted)">${esc(p.unde || "")}</span>`,
      ])
    ) +
    `<p style="font-size:12px;color:var(--text-muted)">Ghidul cu pașii e în <code>GOOGLE-SETUP.md</code>, în folderul de urcare.</p>`
  );
}

module.exports = {
  register,
  porneste,
  blocEmailuri,
  sincronizeazaTot,
  sincronizeazaCont,
  salveazaMesaj,
  leaga,
  numereDinText,
  undeVedeUtilizatorul,
  verifica,
  MAX_CORP,
};
