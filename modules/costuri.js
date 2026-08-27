"use strict";
// Costul lunar real al fiecărui om din echipă — ca să se poată pune față în
// față cu ce aduce: încasări generate, comision, contribuție netă.
//
// „Cost company" = tot ce pleacă din firmă pentru omul ăla: salariul net al
// lui, contribuțiile lui (CAS, CASS, impozit — toate cuprinse în brut),
// CAM-ul plătit de firmă peste brut, mașina, carburantul și alte costuri.
//
// Fiecare modificare de salariu/mașină se salvează ca rând NOU, valabil de la
// o dată încolo. Rapoartele pe lunile trecute rămân corecte.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

function azi() {
  return new Date().toISOString().slice(0, 10);
}

const nr = (v) => Number(String(v ?? "").replace(",", ".")) || 0;

// Costul valabil pentru o lună dată (ultimul rând cu valabil_de_la <= finalul lunii).
async function costPentruLuna(utilizatorId, luna) {
  const sfarsitLuna = `${luna}-31`;
  return await db
    .prepare(
      `SELECT * FROM costuri_personal
       WHERE utilizator_id = ? AND valabil_de_la <= ?
       ORDER BY valabil_de_la DESC, id DESC LIMIT 1`
    )
    .get(utilizatorId, sfarsitLuna);
}

// Defalcarea completă a costului pentru companie, pornind de la salariul BRUT.
// Din brut se rețin contribuțiile angajatului (CAS 25%, CASS 10%) și impozitul
// (10% din ce rămâne) — banii ăștia sunt deja în brut, firma îi virează la stat
// în numele angajatului. Peste brut, firma mai plătește CAM (2,25%).
//
// COST COMPANY = brut + CAM + mașină + carburant + alte.
// E costul real, complet: include tot ce pleacă din firmă pentru omul ăla —
// și salariul net, și toate contribuțiile, și taxele lui.
// Calculul e simplificat (fără deduceri personale, fără facilități sectoriale) —
// pentru sumele exacte rămâne statul de plată de la contabil.
const CAS = 25, CASS = 10, IMPOZIT = 10;

function totalCost(c) {
  if (!c) return { brut: 0, cas: 0, cass: 0, impozit: 0, net: 0, cam: 0, masina: 0, carburant: 0, alte: 0, salarial: 0, total: 0 };
  const brut = Number(c.salariu_brut) || 0;
  const cas = (brut * CAS) / 100;
  const cass = (brut * CASS) / 100;
  const bazaImpozit = Math.max(0, brut - cas - cass);
  const impozit = (bazaImpozit * IMPOZIT) / 100;
  const net = Math.max(0, brut - cas - cass - impozit);
  const cam = (brut * (Number(c.cam_procent) || 0)) / 100;
  const masina = Number(c.cost_masina) || 0;
  const carburant = Number(c.cost_carburant) || 0;
  const alte = Number(c.alte_costuri) || 0;
  return { brut, cas, cass, impozit, net, cam, masina, carburant, alte, salarial: brut + cam, total: brut + cam + masina + carburant + alte };
}

// Costul tuturor, pentru o lună — folosit și de raportul de comisioane.
async function costuriPeLuna(luna) {
  const utilizatori = await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
  const rezultat = [];
  for (const u of utilizatori) {
    const c = await costPentruLuna(u.id, luna);
    rezultat.push({ utilizator: u, cost: c, sume: totalCost(c) });
  }
  return rezultat;
}

function register(router) {
  // ---- Listă + total echipă ----------------------------------------------
  router.get("/costuri", async (ctx) => {
    const aziLuna = new Date().toISOString().slice(0, 7);
    const anCurent = Number(aziLuna.slice(0, 4));
    // Perioada: o lună anume, anul curent, anul trecut sau tot istoricul.
    // Costul lunar se însumează pe fiecare lună din interval — așa se vede
    // corect și când cineva a fost angajat la jumătatea perioadei.
    const perioada = String(ctx.query.perioada || "luna");
    let luniInterval = [];
    let etichetaPerioada = "";
    if (perioada === "an_curent" || perioada === "an_trecut") {
      const an = perioada === "an_curent" ? anCurent : anCurent - 1;
      const panaLuna = perioada === "an_curent" ? Number(aziLuna.slice(5, 7)) : 12;
      for (let m = 1; m <= panaLuna; m++) luniInterval.push(`${an}-${String(m).padStart(2, "0")}`);
      etichetaPerioada = perioada === "an_curent" ? `anul ${an} (ian–${aziLuna.slice(5, 7)})` : `anul ${an}`;
    } else if (perioada === "tot") {
      const prima = await db.prepare("SELECT MIN(valabil_de_la) AS d FROM costuri_personal").get();
      const start = prima && prima.d ? String(prima.d).slice(0, 7) : aziLuna;
      let [a, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
      while (`${a}-${String(m).padStart(2, "0")}` <= aziLuna && luniInterval.length < 240) {
        luniInterval.push(`${a}-${String(m).padStart(2, "0")}`);
        m++;
        if (m > 12) { m = 1; a++; }
      }
      etichetaPerioada = `tot istoricul (${luniInterval[0] || aziLuna} → ${aziLuna})`;
    } else {
      luniInterval = [/^\d{4}-\d{2}$/.test(String(ctx.query.luna || "")) ? String(ctx.query.luna) : aziLuna];
      etichetaPerioada = luniInterval[0];
    }
    const luna = luniInterval[luniInterval.length - 1];

    // însumăm costul pe toate lunile din interval
    const acumulat = new Map();
    for (const l of luniInterval) {
      for (const rand of await costuriPeLuna(l)) {
        const cheie = rand.utilizator.id;
        if (!acumulat.has(cheie)) acumulat.set(cheie, { utilizator: rand.utilizator, cost: rand.cost, sume: { brut: 0, cas: 0, cass: 0, impozit: 0, net: 0, cam: 0, masina: 0, carburant: 0, alte: 0, salarial: 0, total: 0 }, luni: 0 });
        const g = acumulat.get(cheie);
        for (const k of Object.keys(g.sume)) g.sume[k] += rand.sume[k] || 0;
        if (rand.sume.total > 0) g.luni++;
        if (rand.cost) g.cost = rand.cost;
      }
    }
    const linii = [...acumulat.values()];
    const totalEchipa = linii.reduce((s, l) => s + l.sume.total, 0);
    const cuCost = linii.filter((l) => l.sume.total > 0);

    // ce aduce fiecare, în aceeași lună (încasări de la clienții lui)
    const incasari = await db
      .prepare(
        `SELECT p.agent_id AS agent, COALESCE(SUM(pl.suma),0) AS s
         FROM plati pl JOIN facturi f ON f.id = pl.factura_id JOIN parteneri p ON p.id = f.partener_id
         WHERE f.directie='vanzare' AND f.status NOT IN ('anulata','necunoscut') AND f.intercompany = 0
           AND SUBSTR(pl.data,1,7) IN (${luniInterval.map(() => "?").join(",")}) AND p.agent_id IS NOT NULL
         GROUP BY p.agent_id`
      )
      .all(...luniInterval);
    const incPeAgent = new Map(incasari.map((r) => [r.agent, Number(r.s)]));

    const luniOptiuni = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - i);
      luniOptiuni.push(d.toISOString().slice(0, 7));
    }

    const body = `
      <div class="toolbar">
        <a href="/costuri/nou" class="btn">+ Adaugă / actualizează cost pentru un om</a>
      </div>
      <form class="filtre" method="get" action="/costuri">
        <select name="perioada" onchange="this.form.submit()">
          <option value="luna"${perioada === "luna" ? " selected" : ""}>o lună anume</option>
          <option value="an_curent"${perioada === "an_curent" ? " selected" : ""}>anul curent</option>
          <option value="an_trecut"${perioada === "an_trecut" ? " selected" : ""}>anul trecut</option>
          <option value="tot"${perioada === "tot" ? " selected" : ""}>toată perioada</option>
        </select>
        ${
          perioada === "luna"
            ? `<select name="luna" onchange="this.form.submit()">${luniOptiuni.map((l) => `<option value="${l}"${l === luna ? " selected" : ""}>${l}</option>`).join("")}</select>`
            : ""
        }
        <span style="font-size:12px;color:var(--text-muted)">${esc(etichetaPerioada)} · ${luniInterval.length} ${luniInterval.length === 1 ? "lună" : "luni"}</span>
      </form>

      <div class="cards">
        <div class="card"><div class="label">COST COMPANY total (${esc(etichetaPerioada)})</div><div class="value">${money(totalEchipa)}</div></div>
        <div class="card"><div class="label">din care salarial (brut + CAM)</div><div class="value">${money(linii.reduce((s, l) => s + l.sume.salarial, 0))}</div></div>
        <div class="card"><div class="label">din care mașini + carburant</div><div class="value">${money(linii.reduce((s, l) => s + l.sume.masina + l.sume.carburant, 0))}</div></div>
        <div class="card"><div class="label">Oameni cu cost definit</div><div class="value">${cuCost.length} / ${linii.length}</div></div>
      </div>

      ${table(
        ["Persoana", "Rol", "Brut", "Net (în mână)", "CAS+CASS+impozit", "CAM", "Mașină", "Carburant", "Alte", "COST COMPANY", "Încasări aduse", "Diferență", ""],
        linii.map((l) => {
          const adus = incPeAgent.get(l.utilizator.id) || 0;
          const dif = adus - l.sume.total;
          const contributii = l.sume.cas + l.sume.cass + l.sume.impozit;
          return [
            esc(l.utilizator.nume),
            esc(l.utilizator.rol),
            l.sume.brut ? money(l.sume.brut) : '<span class="badge gri">nesetat</span>',
            l.sume.net ? money(l.sume.net) : "—",
            contributii ? `<span style="color:var(--text-muted)">${money(contributii)}</span>` : "—",
            l.sume.cam ? money(l.sume.cam) : "—",
            l.sume.masina ? `${money(l.sume.masina)}${l.cost && l.cost.masina_detalii ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(l.cost.masina_detalii)}</span>` : ""}` : "—",
            l.sume.carburant ? money(l.sume.carburant) : "—",
            l.sume.alte ? money(l.sume.alte) : "—",
            `<strong>${money(l.sume.total)}</strong>`,
            adus ? money(adus) : "—",
            l.sume.total > 0 && adus > 0
              ? `<strong style="color:${dif >= 0 ? "var(--success)" : "var(--danger)"}">${money(dif)}</strong>`
              : "—",
            `<a class="link-btn" href="/costuri/nou?utilizator_id=${l.utilizator.id}">actualizează</a>`,
          ];
        })
      )}

      <p style="font-size:12px;color:var(--text-muted)">
        <strong>COST COMPANY = brut + CAM + mașină + carburant + alte</strong> — tot ce pleacă din firmă pentru omul respectiv.
        Coloanele „Net" și „CAS+CASS+impozit" sunt defalcarea brutului (net + contribuții = brut), afișate ca să vezi unde se duc banii;
        nu se adună peste brut, sunt deja în el. Calculul e simplificat (fără deduceri personale sau facilități sectoriale) —
        pentru cifrele exacte rămâne statul de plată de la contabil.
        „Încasări aduse" sunt banii efectiv intrați în luna aleasă de la clienții alocați persoanei, pe tot grupul.
        Coloana „Diferență" e brută: nu scade costul mărfii vândute, deci nu e profit — e cât aduce omul față de cât costă direct.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Costuri echipă — ${luna}`, active: "/costuri", body }));
  });

  // ---- Formular ------------------------------------------------------------
  router.get("/costuri/nou", async (ctx) => {
    const utilizatori = await db.prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const alesId = parseInt(ctx.query.utilizator_id, 10) || null;
    const ultim = alesId ? await costPentruLuna(alesId, new Date().toISOString().slice(0, 7)) : null;

    const body = `
      <form class="form" method="post" action="/costuri" style="max-width:620px">
        <label class="field"><span>Persoana</span>
          <select name="utilizator_id" required>
            ${utilizatori.map((u) => `<option value="${u.id}"${alesId === u.id ? " selected" : ""}>${esc(u.nume)} (${esc(u.rol)})</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Valabil de la</span><input type="date" name="valabil_de_la" value="${esc(azi().slice(0, 8))}01" required></label>
        <div style="display:grid;grid-template-columns:1fr 140px;gap:14px">
          <label class="field"><span>Salariu brut (lei/lună)</span><input type="number" step="0.01" name="salariu_brut" value="${ultim ? Number(ultim.salariu_brut) : ""}" required></label>
          <label class="field"><span>CAM %</span><input type="number" step="0.01" name="cam_procent" value="${ultim ? Number(ultim.cam_procent) : 2.25}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Cost mașină (rată/chirie, lei/lună)</span><input type="number" step="0.01" name="cost_masina" value="${ultim ? Number(ultim.cost_masina) : ""}"></label>
          <label class="field"><span>Ce mașină (opțional)</span><input name="masina_detalii" value="${esc(ultim ? ultim.masina_detalii || "" : "")}" placeholder="Ex: Dacia Jogger B-123-XYZ, leasing BCR"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Carburant (lei/lună)</span><input type="number" step="0.01" name="cost_carburant" value="${ultim ? Number(ultim.cost_carburant) : ""}"></label>
          <label class="field"><span>Alte costuri (telefon, abonamente…)</span><input type="number" step="0.01" name="alte_costuri" value="${ultim ? Number(ultim.alte_costuri) : ""}"></label>
        </div>
        <label class="field"><span>Detalii alte costuri</span><input name="alte_detalii" value="${esc(ultim ? ultim.alte_detalii || "" : "")}"></label>
        <label class="field"><span>Observații</span><textarea name="observatii" rows="2">${esc(ultim ? ultim.observatii || "" : "")}</textarea></label>
        <div class="form-actions"><button class="btn" type="submit">Salvează</button> <a class="btn secondary" href="/costuri">Renunță</a></div>
      </form>
      <p style="font-size:12px;color:var(--text-muted)">
        Fiecare salvare creează o versiune nouă, valabilă de la data aleasă — istoricul lunilor trecute rămâne neatins.
        Pune brutul, nu netul: costul pentru firmă se calculează din brut plus CAM.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cost lunar — adaugă / actualizează", active: "/costuri", body }));
  });

  router.post("/costuri", async (ctx) => {
    const b = ctx.body;
    const uid = parseInt(b.utilizator_id, 10);
    const dataV = /^\d{4}-\d{2}-\d{2}$/.test(String(b.valabil_de_la || "")) ? String(b.valabil_de_la) : azi();
    if (uid) {
      await db
        .prepare(
          `INSERT INTO costuri_personal (utilizator_id, valabil_de_la, salariu_brut, cam_procent, cost_masina, masina_detalii, cost_carburant, alte_costuri, alte_detalii, observatii)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          uid,
          dataV,
          nr(b.salariu_brut),
          nr(b.cam_procent) || 2.25,
          nr(b.cost_masina),
          String(b.masina_detalii || "").trim() || null,
          nr(b.cost_carburant),
          nr(b.alte_costuri),
          String(b.alte_detalii || "").trim() || null,
          String(b.observatii || "").trim() || null
        );
    }
    redirect(ctx.res, "/costuri");
  });
}

module.exports = { register, costuriPeLuna, costPentruLuna, totalCost };
