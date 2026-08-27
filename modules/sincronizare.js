"use strict";
// Agenda (Google Calendar + task-uri programate) și știrile de pe dashboard.
//
// ERP-ul n-are cum să întrebe singur Google-ul sau internetul: n-are nici
// credențialele lui Vali, nici căutare web. Așa că datele astea vin ca două
// fișiere JSON ținute în repo, la `date/agenda.json` și `date/stiri.json`,
// pe care le împrospătează Claude și le încarcă odată cu codul.
//
// De ce fișiere și nu un endpoint: un endpoint de scriere ar fi cerut un
// secret propriu, iar secretul ar fi trebuit plimbat până acolo. Fișierele
// nu cer niciun secret, se văd în istoricul git (deci se poate vedea exact
// ce s-a schimbat și când) și folosesc exact drumul pe care oricum îl
// parcurge codul: commit → deploy.
//
// La fiecare pornire, conținutul fișierelor înlocuiește tabelele. Dacă un
// fișier lipsește sau e stricat, tabelul rămâne cum era — nu golim ecranul
// din cauza unei virgule.
const fs = require("fs");
const path = require("path");
const db = require("../lib/db");
const { esc, layout } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const DIRECTOR = path.join(__dirname, "..", "date");

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function citesteFisier(nume) {
  try {
    const brut = fs.readFileSync(path.join(DIRECTOR, nume), "utf8");
    const obiect = JSON.parse(brut);
    return Array.isArray(obiect) ? obiect : Array.isArray(obiect.randuri) ? obiect.randuri : null;
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`[sincronizare] ${nume}: ${e.message}`);
    return null;
  }
}

async function incarcaAgenda() {
  const randuri = citesteFisier("agenda.json");
  if (!randuri) return 0;
  await db.prepare("DELETE FROM agenda_externa").run();
  const t = acum();
  let n = 0;
  for (const r of randuri.slice(0, 500)) {
    const titlu = String((r && r.titlu) || "").trim();
    if (!titlu) continue;
    await db
      .prepare(
        `INSERT INTO agenda_externa (sursa, titlu, detalii, incepe_la, se_termina_la, link, cheie_externa, actualizat_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(r.sursa || "calendar").slice(0, 40),
        titlu.slice(0, 300),
        r.detalii ? String(r.detalii).slice(0, 1000) : null,
        r.incepe_la ? String(r.incepe_la).slice(0, 25) : null,
        r.se_termina_la ? String(r.se_termina_la).slice(0, 25) : null,
        r.link ? String(r.link).slice(0, 500) : null,
        r.cheie_externa ? String(r.cheie_externa).slice(0, 200) : null,
        t
      );
    n++;
  }
  return n;
}

async function incarcaStiri() {
  const randuri = citesteFisier("stiri.json");
  if (!randuri) return 0;
  await db.prepare("DELETE FROM stiri").run();
  const t = acum();
  let n = 0;
  for (const r of randuri.slice(0, 100)) {
    const titlu = String((r && r.titlu) || "").trim();
    if (!titlu) continue;
    await db
      .prepare(
        `INSERT INTO stiri (titlu, sursa, url, rezumat, zona, relevanta, publicat_la, adaugat_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        titlu.slice(0, 300),
        r.sursa ? String(r.sursa).slice(0, 120) : null,
        r.url ? String(r.url).slice(0, 500) : null,
        r.rezumat ? String(r.rezumat).slice(0, 1000) : null,
        String(r.zona) === "extern" ? "extern" : "local",
        r.relevanta ? String(r.relevanta).slice(0, 500) : null,
        r.publicat_la ? String(r.publicat_la).slice(0, 25) : null,
        t
      );
    n++;
  }
  return n;
}

// Costul lunar al agenților, citit din statele de plată din Drive.
// Spre deosebire de agendă și știri, aici NU ștergem nimic: un cost pus de
// mână din interfață e mai proaspăt decât fișierul, iar dacă rândul există
// deja pentru aceeași persoană și aceeași dată, îl lăsăm în pace.
async function incarcaCosturi() {
  const randuri = citesteFisier("costuri-agenti.json");
  if (!randuri) return 0;
  let n = 0;
  for (const r of randuri.slice(0, 100)) {
    const nume = String((r && r.utilizator) || "").trim();
    const deLa = String((r && r.valabil_de_la) || "").slice(0, 10);
    if (!nume || !/^\d{4}-\d{2}-\d{2}$/.test(deLa)) continue;
    const u = await db.prepare("SELECT id FROM utilizatori WHERE LOWER(nume) = LOWER(?) AND activ = 1").get(nume);
    if (!u) {
      console.error(`[sincronizare] cost pentru „${nume}" — utilizatorul nu există în ERP, sărit`);
      continue;
    }
    const exista = await db
      .prepare("SELECT id FROM costuri_personal WHERE utilizator_id = ? AND valabil_de_la = ?")
      .get(u.id, deLa);
    if (exista) continue;
    await db
      .prepare(
        `INSERT INTO costuri_personal (utilizator_id, valabil_de_la, salariu_brut, cam_procent, cost_masina,
                                       masina_detalii, cost_carburant, alte_costuri, observatii)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        u.id,
        deLa,
        Number(r.salariu_brut) || 0,
        Number(r.cam_procent) || 2.25,
        Number(r.cost_masina) || 0,
        r.masina_detalii ? String(r.masina_detalii).slice(0, 200) : null,
        Number(r.cost_carburant) || 0,
        Number(r.alte_costuri) || 0,
        r.observatii ? String(r.observatii).slice(0, 500) : null
      );
    n++;
  }
  return n;
}

// Chemată o dată la pornire, din server.js.
async function incarcaTot() {
  try {
    const a = await incarcaAgenda();
    const s = await incarcaStiri();
    const c = await incarcaCosturi();
    if (a || s || c) console.log(`[sincronizare] agendă: ${a}, știri: ${s}, costuri noi: ${c}`);
  } catch (e) {
    console.error("[sincronizare] încărcarea a eșuat:", e.message);
  }
}

function register(router) {
  // Reîncărcare la cerere, pentru admin — utilă după un deploy cu date noi.
  router.post("/admin/sincronizare", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    await incarcaTot();
    redirect(ctx.res, "/admin/sincronizare");
  });

  router.get("/admin/sincronizare", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/");
    const a = await db.prepare("SELECT COUNT(*) AS n, MAX(actualizat_la) AS d FROM agenda_externa").get();
    const s = await db.prepare("SELECT COUNT(*) AS n, MAX(adaugat_la) AS d FROM stiri").get();
    const areAgenda = !!citesteFisier("agenda.json");
    const areStiri = !!citesteFisier("stiri.json");
    const body = `
      <h1>Agendă și știri</h1>
      <p style="max-width:720px;color:var(--text-muted)">
        Întâlnirile din calendar, task-urile programate și știrile de pe dashboard nu se pot afla din baza noastră
        de date. Vin din două fișiere ținute în repo — <code>date/agenda.json</code> și <code>date/stiri.json</code> —
        pe care le împrospătează Claude și care se încarcă la fiecare pornire a aplicației.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Agendă în baza de date</div><div class="value">${Number(a.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${a.d ? "încărcat " + esc(String(a.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Știri în baza de date</div><div class="value">${Number(s.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.d ? "încărcat " + esc(String(s.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Fișiere găsite</div>
          <div class="value" style="font-size:16px">
            ${areAgenda ? '<span class="badge verde">agenda.json</span>' : '<span class="badge rosu">agenda.json lipsă</span>'}
            ${areStiri ? '<span class="badge verde">stiri.json</span>' : '<span class="badge rosu">stiri.json lipsă</span>'}
          </div></div>
      </div>
      <form method="post" action="/admin/sincronizare" class="inline-form">
        <button class="btn" type="submit">Reîncarcă din fișiere</button>
      </form>
      <a class="btn secondary" href="/">Înapoi la dashboard</a>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Agendă și știri", active: "/", body }));
  });
}

module.exports = { register, incarcaTot };
