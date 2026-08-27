"use strict";
// Oferte, contracte și legătura dintre ele.
//
// Ideea de bază: o ofertă nu se corectează peste ea însăși. Fiecare revizie
// e o versiune nouă, iar cea veche rămâne, marcată „înlocuită". Când clientul
// spune „dar în oferta de săptămâna trecută scria altceva", ai ce să deschizi.
//
// Fluxul sugerat e ofertă → acceptare → contract și/sau comandă, dar nu e
// obligatoriu: din orice pas se poate sări direct la contract sau la comandă.
// Un client care sună și comandă pe loc n-are nevoie de ofertă.
const db = require("../lib/db");
const { esc, layout, table, money } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const STATUS = {
  ciorna: "Ciornă",
  trimisa: "Trimisă",
  acceptata: "Acceptată",
  respinsa: "Respinsă",
  inlocuita: "Înlocuită",
  expirata: "Expirată",
};
const BADGE = {
  ciorna: "gri",
  trimisa: "albastru",
  acceptata: "verde",
  respinsa: "rosu",
  inlocuita: "gri",
  expirata: "galben",
};

const STATUS_CONTRACT = { in_lucru: "În lucru", semnat: "Semnat", expirat: "Expirat", reziliat: "Reziliat" };

function azi() {
  return new Date().toISOString().slice(0, 10);
}

function nrDoc(prefix, id) {
  return `${prefix}${String(id).padStart(5, "0")}`;
}

async function totalOferta(ofertaId) {
  const r = await db
    .prepare("SELECT COALESCE(SUM(cantitate * pret_unitar), 0) AS net, COALESCE(SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)), 0) AS brut FROM oferte_linii WHERE oferta_id = ?")
    .get(ofertaId);
  return { net: Number(r && r.net) || 0, brut: Number(r && r.brut) || 0 };
}

// Agentul care are voie să umble la ofertă: al lui sau al adminului.
function poateEdita(user, oferta) {
  if (!user) return false;
  if (user.rol === "admin") return true;
  return oferta.agent_id === user.id;
}

function subnav(activ) {
  const linkuri = [
    ["/crm", "Pipeline"],
    ["/crm/birou", "Biroul meu"],
    ["/crm/alocare", "Clienții mei"],
    ["/crm/contacte", "Contactări"],
    ["/oferte", "Oferte"],
    ["/contracte", "Contracte"],
    ["/crm/leaduri", "Lead-uri"],
    ["/crm/activitate", "Activitate & emailuri"],
    ["/taskuri", "Task-uri"],
  ];
  return `<div class="subnav">${linkuri.map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`).join("")}</div>`;
}

function register(router) {
  // ---------------- lista de oferte ----------------
  router.get("/oferte", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const doarAleMele = ctx.user.rol !== "admin";
    const args = [];
    let where = "1=1";
    if (doarAleMele) { where += " AND o.agent_id = ?"; args.push(ctx.user.id); }
    const stare = String(ctx.query.status || "").trim();
    if (stare && STATUS[stare]) { where += " AND o.status = ?"; args.push(stare); }
    else if (!stare) where += " AND o.status <> 'inlocuita'";

    const oferte = await db
      .prepare(
        `SELECT o.*, p.nume AS client, u.nume AS agent,
                (SELECT COALESCE(SUM(l.cantitate * l.pret_unitar), 0) FROM oferte_linii l WHERE l.oferta_id = o.id) AS total
           FROM oferte o
           JOIN parteneri p ON p.id = o.partener_id
           LEFT JOIN utilizatori u ON u.id = o.agent_id
          WHERE ${where}
          ORDER BY o.id DESC LIMIT 300`
      )
      .all(...args);

    const body = `
      ${subnav("/oferte")}
      <div class="toolbar">
        <a class="btn" href="/oferte/nou">+ Ofertă nouă</a>
        <a class="btn secondary" href="/oferte">Active</a>
        <a class="btn secondary" href="/oferte?status=acceptata">Acceptate</a>
        <a class="btn secondary" href="/oferte?status=trimisa">Trimise</a>
        <a class="btn secondary" href="/oferte?status=inlocuita">Versiuni vechi</a>
      </div>
      ${table(
        ["Ofertă", "Client", "Titlu", "Valoare", "Valabilă până", "Agent", "Stare"],
        oferte.map((o) => [
          `<a href="/oferte/${o.id}">${esc(o.numar || nrDoc("OF", o.id))}</a>${o.versiune > 1 ? ` <span class="badge gri">v${o.versiune}</span>` : ""}`,
          `<a href="/parteneri/${o.partener_id}">${esc(o.client)}</a>`,
          esc(o.titlu || "—"),
          money(o.total),
          o.valabil_pana ? esc(o.valabil_pana) : "—",
          esc(o.agent || "—"),
          `<span class="badge ${BADGE[o.status] || "gri"}">${esc(STATUS[o.status] || o.status)}</span>`,
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Oferte (${oferte.length})`, active: "/oferte", body }));
  });

  // ---------------- ofertă nouă ----------------
  router.get("/oferte/nou", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume LIMIT 1000").all();
    const presel = parseInt(ctx.query.partener_id, 10);
    const body = `
      ${subnav("/oferte")}
      <form method="post" action="/oferte" class="form" style="max-width:560px">
        <label class="field"><span>Client</span>
          <select name="partener_id" required>
            ${parteneri.map((p) => `<option value="${p.id}"${presel === p.id ? " selected" : ""}>${esc(p.nume)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Titlu</span><input name="titlu" placeholder="ex. Cutii D7 — livrare lunară"></label>
        <label class="field"><span>Valabilă până la</span><input type="date" name="valabil_pana"></label>
        <label class="field"><span>Observații</span><textarea name="observatii" rows="3"></textarea></label>
        <button class="btn" type="submit">Creează oferta</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Ofertă nouă", active: "/oferte", body }));
  });

  router.post("/oferte", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const partenerId = parseInt(ctx.body.partener_id, 10);
    if (!Number.isFinite(partenerId)) return redirect(ctx.res, "/oferte/nou");
    const ins = await db
      .prepare("INSERT INTO oferte (partener_id, agent_id, titlu, valabil_pana, observatii, status) VALUES (?, ?, ?, ?, ?, 'ciorna') RETURNING id")
      .run(partenerId, ctx.user.id, String(ctx.body.titlu || "").trim() || null, String(ctx.body.valabil_pana || "").trim() || null, String(ctx.body.observatii || "").trim() || null);
    const id = ins.lastInsertRowid;
    await db.prepare("UPDATE oferte SET numar = ?, radacina_id = ? WHERE id = ?").run(nrDoc("OF", id), id, id);
    redirect(ctx.res, `/oferte/${id}`);
  });

  // ---------------- detaliul ofertei ----------------
  router.get("/oferte/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db
      .prepare("SELECT o.*, p.nume AS client, p.email AS client_email, u.nume AS agent FROM oferte o JOIN parteneri p ON p.id = o.partener_id LEFT JOIN utilizatori u ON u.id = o.agent_id WHERE o.id = ?")
      .get(ctx.params.id);
    if (!o) return redirect(ctx.res, "/oferte");
    const linii = await db.prepare("SELECT * FROM oferte_linii WHERE oferta_id = ? ORDER BY id").all(o.id);
    const t = await totalOferta(o.id);
    const versiuni = await db
      .prepare("SELECT id, numar, versiune, status, creat_la FROM oferte WHERE radacina_id = ? ORDER BY versiune DESC")
      .all(o.radacina_id || o.id);
    const produse = await db.prepare("SELECT id, denumire, pret_vanzare, cota_tva, unitate_masura FROM produse ORDER BY denumire LIMIT 2000").all();
    const editabil = poateEdita(ctx.user, o) && ["ciorna", "trimisa"].includes(o.status);

    const body = `
      ${subnav("/oferte")}
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Ofertă</div><strong>${esc(o.numar || nrDoc("OF", o.id))}</strong> ${o.versiune > 1 ? `<span class="badge gri">versiunea ${o.versiune}</span>` : ""}</div>
          <div><div class="k">Client</div><a href="/parteneri/${o.partener_id}">${esc(o.client)}</a></div>
          <div><div class="k">Agent</div>${esc(o.agent || "—")}</div>
          <div><div class="k">Stare</div><span class="badge ${BADGE[o.status] || "gri"}">${esc(STATUS[o.status] || o.status)}</span></div>
          <div><div class="k">Valabilă până</div>${esc(o.valabil_pana || "—")}</div>
          <div><div class="k">Valoare</div><strong>${money(t.net)}</strong> <span style="font-size:12px;color:var(--text-muted)">(${money(t.brut)} cu TVA)</span></div>
        </div>
        ${o.observatii ? `<p style="margin:10px 0 0;font-size:13px">${esc(o.observatii)}</p>` : ""}
        ${o.motiv_respingere ? `<p style="margin:10px 0 0;font-size:13px;color:var(--danger)">Respinsă: ${esc(o.motiv_respingere)}</p>` : ""}
      </div>

      <h2>Linii</h2>
      ${table(
        ["Denumire", "U.M.", "Cantitate", "Preț unitar", "TVA %", "Valoare", ...(editabil ? ["Acțiuni"] : [])],
        linii.map((l) => [
          esc(l.denumire),
          esc(l.um || "buc"),
          Number(l.cantitate).toLocaleString("ro-RO"),
          money(l.pret_unitar),
          `${Number(l.cota_tva).toFixed(0)}%`,
          money(l.cantitate * l.pret_unitar),
          ...(editabil
            ? [`<form method="post" action="/oferte/${o.id}/linii/${l.id}/sterge" class="inline-form"><button class="link-btn danger" type="submit">șterge</button></form>`]
            : []),
        ]),
        { total: ["TOTAL", "", "", "", "", money(t.net), ...(editabil ? [""] : [])] }
      )}

      ${
        editabil
          ? `<form method="post" action="/oferte/${o.id}/linii" class="form" style="max-width:820px">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
                <label class="field" style="flex:2;min-width:220px"><span>Produs (sau scrie liber mai jos)</span>
                  <select name="produs_id">
                    <option value="">— fără produs din nomenclator —</option>
                    ${produse.map((p) => `<option value="${p.id}" data-pret="${p.pret_vanzare}">${esc(p.denumire)}</option>`).join("")}
                  </select>
                </label>
                <label class="field" style="flex:2;min-width:180px"><span>Denumire (dacă nu alegi produs)</span><input name="denumire"></label>
                <label class="field" style="width:90px"><span>U.M.</span><input name="um" value="buc"></label>
                <label class="field" style="width:110px"><span>Cantitate</span><input name="cantitate" type="number" step="0.001" value="1" required></label>
                <label class="field" style="width:130px"><span>Preț unitar</span><input name="pret_unitar" type="number" step="0.01" required></label>
                <label class="field" style="width:90px"><span>TVA %</span><input name="cota_tva" type="number" step="0.1" value="21"></label>
                <button class="btn" type="submit">Adaugă linia</button>
              </div>
            </form>`
          : ""
      }

      <h2>Ce facem cu oferta</h2>
      <div class="toolbar" style="flex-wrap:wrap">
        ${
          poateEdita(ctx.user, o) && o.status === "ciorna"
            ? `<form method="post" action="/oferte/${o.id}/stare" class="inline-form"><input type="hidden" name="status" value="trimisa"><button class="btn" type="submit">Marchează trimisă</button></form>`
            : ""
        }
        ${
          poateEdita(ctx.user, o) && ["ciorna", "trimisa"].includes(o.status)
            ? `<form method="post" action="/oferte/${o.id}/accepta" class="inline-form" style="display:flex;gap:6px;align-items:center">
                 <label style="font-size:13px"><input type="checkbox" name="creeaza_contract" value="1" checked> contract</label>
                 <label style="font-size:13px"><input type="checkbox" name="creeaza_comanda" value="1" checked> comandă</label>
                 <button class="btn" type="submit">Client a acceptat</button>
               </form>
               <form method="post" action="/oferte/${o.id}/respinge" class="inline-form" style="display:flex;gap:6px;align-items:center">
                 <input name="motiv" placeholder="motiv" style="padding:5px 8px;max-width:180px">
                 <button class="btn secondary" type="submit">Respinsă</button>
               </form>
               <form method="post" action="/oferte/${o.id}/versiune-noua" class="inline-form"><button class="btn secondary" type="submit">Versiune nouă</button></form>`
            : ""
        }
        ${o.contract_id ? `<a class="btn secondary" href="/contracte/${o.contract_id}">Vezi contractul</a>` : ""}
        ${o.comanda_id ? `<a class="btn secondary" href="/comenzi/${o.comanda_id}">Vezi comanda</a>` : ""}
        ${
          !o.contract_id
            ? `<form method="post" action="/oferte/${o.id}/spre-contract" class="inline-form"><button class="btn secondary" type="submit">Sari direct la contract</button></form>`
            : ""
        }
        ${
          !o.comanda_id
            ? `<form method="post" action="/oferte/${o.id}/spre-comanda" class="inline-form"><button class="btn secondary" type="submit">Sari direct la comandă</button></form>`
            : ""
        }
      </div>
      <p style="font-size:12px;color:var(--text-muted);max-width:760px">
        Fluxul obișnuit e ofertă → acceptare → contract și comandă, dar poți sări direct la oricare
        dintre ele, oricând. La „versiune nouă", oferta asta rămâne ca istoric și se deschide una
        nouă, cu aceleași linii, pe care o modifici.
      </p>

      ${
        versiuni.length > 1
          ? `<h2>Versiuni (${versiuni.length})</h2>
             ${table(
               ["Versiune", "Ofertă", "Stare", "Creată"],
               versiuni.map((v) => [
                 `v${v.versiune}${v.id === o.id ? " (asta)" : ""}`,
                 `<a href="/oferte/${v.id}">${esc(v.numar || nrDoc("OF", v.id))}</a>`,
                 `<span class="badge ${BADGE[v.status] || "gri"}">${esc(STATUS[v.status] || v.status)}</span>`,
                 esc(String(v.creat_la || "").slice(0, 16)),
               ])
             )}`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Ofertă ${o.numar || nrDoc("OF", o.id)}`, active: "/oferte", body }));
  });

  // ---------------- linii ----------------
  router.post("/oferte/:id/linii", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    const produsId = parseInt(ctx.body.produs_id, 10);
    let denumire = String(ctx.body.denumire || "").trim();
    let um = String(ctx.body.um || "buc").trim() || "buc";
    let pret = Number(String(ctx.body.pret_unitar || "0").replace(",", ".")) || 0;
    let tva = Number(String(ctx.body.cota_tva || "21").replace(",", ".")) || 0;
    if (Number.isFinite(produsId) && produsId > 0) {
      const p = await db.prepare("SELECT denumire, pret_vanzare, cota_tva, unitate_masura FROM produse WHERE id = ?").get(produsId);
      if (p) {
        if (!denumire) denumire = p.denumire;
        if (!pret) pret = Number(p.pret_vanzare) || 0;
        if (!ctx.body.um) um = p.unitate_masura || "buc";
      }
    }
    const cant = Number(String(ctx.body.cantitate || "1").replace(",", ".")) || 0;
    if (denumire && cant > 0) {
      await db
        .prepare("INSERT INTO oferte_linii (oferta_id, produs_id, denumire, um, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(o.id, Number.isFinite(produsId) && produsId > 0 ? produsId : null, denumire, um, cant, pret, tva);
    }
    redirect(ctx.res, `/oferte/${o.id}`);
  });

  router.post("/oferte/:id/linii/:lid/sterge", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (o && poateEdita(ctx.user, o)) await db.prepare("DELETE FROM oferte_linii WHERE id = ? AND oferta_id = ?").run(ctx.params.lid, o.id);
    redirect(ctx.res, `/oferte/${ctx.params.id}`);
  });

  // ---------------- stări ----------------
  router.post("/oferte/:id/stare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    const nou = String(ctx.body.status || "");
    if (STATUS[nou]) {
      await db.prepare("UPDATE oferte SET status = ?, trimisa_la = CASE WHEN ? = 'trimisa' THEN ? ELSE trimisa_la END WHERE id = ?").run(nou, nou, azi(), o.id);
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'oferta', ?, ?, ?)")
        .run(o.partener_id, `Ofertă ${o.numar || nrDoc("OF", o.id)} — ${STATUS[nou]}`, o.titlu || null, ctx.user.id);
    }
    redirect(ctx.res, `/oferte/${o.id}`);
  });

  router.post("/oferte/:id/respinge", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    const motiv = String(ctx.body.motiv || "").trim() || null;
    await db.prepare("UPDATE oferte SET status = 'respinsa', motiv_respingere = ? WHERE id = ?").run(motiv, o.id);
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'oferta', ?, ?, ?)")
      .run(o.partener_id, `Ofertă ${o.numar || nrDoc("OF", o.id)} respinsă`, motiv, ctx.user.id);
    redirect(ctx.res, `/oferte/${o.id}`);
  });

  // Versiune nouă: copiem liniile, marcăm vechea „înlocuită".
  router.post("/oferte/:id/versiune-noua", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    const radacina = o.radacina_id || o.id;
    const max = await db.prepare("SELECT COALESCE(MAX(versiune),1) AS v FROM oferte WHERE radacina_id = ?").get(radacina);
    const ins = await db
      .prepare("INSERT INTO oferte (numar, versiune, radacina_id, partener_id, oportunitate_id, agent_id, titlu, status, valabil_pana, observatii) VALUES (?, ?, ?, ?, ?, ?, ?, 'ciorna', ?, ?) RETURNING id")
      .run(o.numar, Number(max.v) + 1, radacina, o.partener_id, o.oportunitate_id, o.agent_id || ctx.user.id, o.titlu, o.valabil_pana, o.observatii);
    const nouId = ins.lastInsertRowid;
    const linii = await db.prepare("SELECT * FROM oferte_linii WHERE oferta_id = ?").all(o.id);
    for (const l of linii) {
      await db
        .prepare("INSERT INTO oferte_linii (oferta_id, produs_id, denumire, um, cantitate, pret_unitar, cota_tva) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(nouId, l.produs_id, l.denumire, l.um, l.cantitate, l.pret_unitar, l.cota_tva);
    }
    await db.prepare("UPDATE oferte SET status = 'inlocuita' WHERE id = ?").run(o.id);
    redirect(ctx.res, `/oferte/${nouId}`);
  });

  // ---------------- acceptare → contract și/sau comandă ----------------
  async function faContract(o, user) {
    const t = await totalOferta(o.id);
    const ins = await db
      .prepare("INSERT INTO contracte (partener_id, oferta_id, agent_id, titlu, valoare, data_start, status) VALUES (?, ?, ?, ?, ?, ?, 'in_lucru') RETURNING id")
      .run(o.partener_id, o.id, o.agent_id || user.id, o.titlu || `Contract din oferta ${o.numar || nrDoc("OF", o.id)}`, t.net, azi());
    const id = ins.lastInsertRowid;
    await db.prepare("UPDATE contracte SET numar = ? WHERE id = ?").run(nrDoc("CTR", id), id);
    await db.prepare("UPDATE oferte SET contract_id = ? WHERE id = ?").run(id, o.id);
    return id;
  }

  async function faComanda(o, user) {
    const ins = await db
      .prepare("INSERT INTO comenzi (partener_id, numar, data, status, observatii, oferta_id, agent_id) VALUES (?, ?, ?, 'noua', ?, ?, ?) RETURNING id")
      .run(o.partener_id, null, azi(), `Din oferta ${o.numar || nrDoc("OF", o.id)}`, o.id, o.agent_id || user.id);
    const id = ins.lastInsertRowid;
    await db.prepare("UPDATE comenzi SET numar = ? WHERE id = ?").run(nrDoc("CMD", id), id);
    const linii = await db.prepare("SELECT * FROM oferte_linii WHERE oferta_id = ?").all(o.id);
    for (const l of linii) {
      if (!l.produs_id) continue; // comenzile cer produs din nomenclator
      await db.prepare("INSERT INTO comenzi_linii (comanda_id, produs_id, cantitate, pret_unitar) VALUES (?, ?, ?, ?)").run(id, l.produs_id, l.cantitate, l.pret_unitar);
    }
    await db.prepare("UPDATE oferte SET comanda_id = ? WHERE id = ?").run(id, o.id);
    return id;
  }

  router.post("/oferte/:id/accepta", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    await db.prepare("UPDATE oferte SET status = 'acceptata', acceptata_la = ? WHERE id = ?").run(azi(), o.id);
    const facute = [];
    if (ctx.body.creeaza_contract && !o.contract_id) { await faContract(o, ctx.user); facute.push("contract"); }
    if (ctx.body.creeaza_comanda && !o.comanda_id) { await faComanda(o, ctx.user); facute.push("comandă"); }
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'oferta', ?, ?, ?)")
      .run(o.partener_id, `Ofertă ${o.numar || nrDoc("OF", o.id)} acceptată`, facute.length ? `S-au creat: ${facute.join(" și ")}` : null, ctx.user.id);
    redirect(ctx.res, `/oferte/${o.id}`);
  });

  router.post("/oferte/:id/spre-contract", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    const id = o.contract_id || (await faContract(o, ctx.user));
    redirect(ctx.res, `/contracte/${id}`);
  });

  router.post("/oferte/:id/spre-comanda", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const o = await db.prepare("SELECT * FROM oferte WHERE id = ?").get(ctx.params.id);
    if (!o || !poateEdita(ctx.user, o)) return redirect(ctx.res, `/oferte/${ctx.params.id}`);
    const id = o.comanda_id || (await faComanda(o, ctx.user));
    redirect(ctx.res, `/comenzi/${id}`);
  });

  // ---------------- contracte ----------------
  router.get("/contracte", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const args = [];
    let where = "1=1";
    if (ctx.user.rol !== "admin") { where += " AND c.agent_id = ?"; args.push(ctx.user.id); }
    const lista = await db
      .prepare(
        `SELECT c.*, p.nume AS client, u.nume AS agent FROM contracte c
           JOIN parteneri p ON p.id = c.partener_id
           LEFT JOIN utilizatori u ON u.id = c.agent_id
          WHERE ${where} ORDER BY c.id DESC LIMIT 300`
      )
      .all(...args);
    const body = `
      ${subnav("/contracte")}
      <div class="toolbar"><a class="btn" href="/contracte/nou">+ Contract nou</a></div>
      ${table(
        ["Contract", "Client", "Titlu", "Valoare", "Început", "Sfârșit", "Agent", "Stare"],
        lista.map((c) => [
          `<a href="/contracte/${c.id}">${esc(c.numar || nrDoc("CTR", c.id))}</a>`,
          `<a href="/parteneri/${c.partener_id}">${esc(c.client)}</a>`,
          esc(c.titlu || "—"),
          money(c.valoare),
          esc(c.data_start || "—"),
          esc(c.data_final || "—"),
          esc(c.agent || "—"),
          esc(STATUS_CONTRACT[c.status] || c.status),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Contracte (${lista.length})`, active: "/contracte", body }));
  });

  router.get("/contracte/nou", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('client','ambele') ORDER BY nume LIMIT 1000").all();
    const presel = parseInt(ctx.query.partener_id, 10);
    const body = `
      ${subnav("/contracte")}
      <form method="post" action="/contracte" class="form" style="max-width:560px">
        <label class="field"><span>Client</span><select name="partener_id" required>${parteneri.map((p) => `<option value="${p.id}"${presel === p.id ? " selected" : ""}>${esc(p.nume)}</option>`).join("")}</select></label>
        <label class="field"><span>Titlu</span><input name="titlu"></label>
        <label class="field"><span>Valoare</span><input name="valoare" type="number" step="0.01" value="0"></label>
        <label class="field"><span>Începe la</span><input type="date" name="data_start" value="${azi()}"></label>
        <label class="field"><span>Se termină la</span><input type="date" name="data_final"></label>
        <label class="field"><span>Observații</span><textarea name="observatii" rows="3"></textarea></label>
        <button class="btn" type="submit">Creează contractul</button>
      </form>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Contract nou", active: "/contracte", body }));
  });

  router.post("/contracte", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const partenerId = parseInt(ctx.body.partener_id, 10);
    if (!Number.isFinite(partenerId)) return redirect(ctx.res, "/contracte/nou");
    const ins = await db
      .prepare("INSERT INTO contracte (partener_id, agent_id, titlu, valoare, data_start, data_final, observatii, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_lucru') RETURNING id")
      .run(
        partenerId,
        ctx.user.id,
        String(ctx.body.titlu || "").trim() || null,
        Number(String(ctx.body.valoare || "0").replace(",", ".")) || 0,
        String(ctx.body.data_start || "").trim() || null,
        String(ctx.body.data_final || "").trim() || null,
        String(ctx.body.observatii || "").trim() || null
      );
    const id = ins.lastInsertRowid;
    await db.prepare("UPDATE contracte SET numar = ? WHERE id = ?").run(nrDoc("CTR", id), id);
    redirect(ctx.res, `/contracte/${id}`);
  });

  router.get("/contracte/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const c = await db
      .prepare("SELECT c.*, p.nume AS client, u.nume AS agent FROM contracte c JOIN parteneri p ON p.id = c.partener_id LEFT JOIN utilizatori u ON u.id = c.agent_id WHERE c.id = ?")
      .get(ctx.params.id);
    if (!c) return redirect(ctx.res, "/contracte");
    const comenzi = await db.prepare("SELECT id, numar, data, status FROM comenzi WHERE contract_id = ? ORDER BY id DESC").all(c.id);
    const body = `
      ${subnav("/contracte")}
      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Contract</div><strong>${esc(c.numar || nrDoc("CTR", c.id))}</strong></div>
        <div><div class="k">Client</div><a href="/parteneri/${c.partener_id}">${esc(c.client)}</a></div>
        <div><div class="k">Valoare</div>${money(c.valoare)}</div>
        <div><div class="k">Perioadă</div>${esc(c.data_start || "—")} → ${esc(c.data_final || "—")}</div>
        <div><div class="k">Agent</div>${esc(c.agent || "—")}</div>
        <div><div class="k">Stare</div>${esc(STATUS_CONTRACT[c.status] || c.status)}</div>
      </div>
      ${c.observatii ? `<p style="margin:10px 0 0;font-size:13px">${esc(c.observatii)}</p>` : ""}
      </div>
      <div class="toolbar">
        ${c.oferta_id ? `<a class="btn secondary" href="/oferte/${c.oferta_id}">Oferta de la care a pornit</a>` : ""}
        <form method="post" action="/contracte/${c.id}/comanda" class="inline-form"><button class="btn" type="submit">Comandă nouă pe contract</button></form>
        <form method="post" action="/contracte/${c.id}/stare" class="inline-form" style="display:flex;gap:6px;align-items:center">
          <select name="status">${Object.entries(STATUS_CONTRACT).map(([k, v]) => `<option value="${k}"${c.status === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>
          <button class="btn secondary" type="submit">Schimbă starea</button>
        </form>
      </div>
      <h2>Comenzi pe acest contract (${comenzi.length})</h2>
      ${table(["Comandă", "Data", "Stare"], comenzi.map((o) => [`<a href="/comenzi/${o.id}">${esc(o.numar || o.id)}</a>`, esc(o.data || "—"), esc(o.status)]))}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Contract ${c.numar || nrDoc("CTR", c.id)}`, active: "/contracte", body }));
  });

  router.post("/contracte/:id/stare", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const nou = String(ctx.body.status || "");
    if (STATUS_CONTRACT[nou]) await db.prepare("UPDATE contracte SET status = ? WHERE id = ?").run(nou, ctx.params.id);
    redirect(ctx.res, `/contracte/${ctx.params.id}`);
  });

  router.post("/contracte/:id/comanda", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const c = await db.prepare("SELECT * FROM contracte WHERE id = ?").get(ctx.params.id);
    if (!c) return redirect(ctx.res, "/contracte");
    const ins = await db
      .prepare("INSERT INTO comenzi (partener_id, data, status, observatii, contract_id, agent_id) VALUES (?, ?, 'noua', ?, ?, ?) RETURNING id")
      .run(c.partener_id, azi(), `Pe contractul ${c.numar || nrDoc("CTR", c.id)}`, c.id, c.agent_id || ctx.user.id);
    const id = ins.lastInsertRowid;
    await db.prepare("UPDATE comenzi SET numar = ? WHERE id = ?").run(nrDoc("CMD", id), id);
    redirect(ctx.res, `/comenzi/${id}`);
  });
}

module.exports = { register, subnav, nrDoc };
