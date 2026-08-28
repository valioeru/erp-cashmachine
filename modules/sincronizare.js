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

// Radarul de răspunsuri: threaduri din office@ în care ultimul mesaj vine din
// exterior și noi n-am mai scris nimic după el. ERP-ul nu vede emailul, deci
// lista o face agentul de dimineață.
//
// Spre deosebire de agendă și știri, aici NU ștergem tot: dacă un rând a fost
// marcat „rezolvat" din interfață, starea aia e mai proaspătă decât fișierul
// și rămâne. Rândurile care nu mai apar în fișier ies din listă — au primit
// răspuns, altfel agentul le-ar fi găsit din nou.
const SEVERITATI = new Set(["blocaj", "calitate", "comercial", "info"]);
const SECTIUNI_RADAR = new Set(["noi", "asteptam", "verificat"]);

async function incarcaRadar() {
  const randuri = citesteFisier("radar-raspunsuri.json");
  if (!randuri) return 0;
  const t = acum();
  const vazute = [];
  let n = 0;

  for (const r of randuri.slice(0, 200)) {
    const cheie = String((r && r.cheie_thread) || "").trim();
    const cine = String((r && r.cine) || "").trim();
    if (!cheie || !cine) continue;

    const valori = [
      SECTIUNI_RADAR.has(String(r.sectiune)) ? String(r.sectiune) : "noi",
      SEVERITATI.has(String(r.severitate)) ? String(r.severitate) : "info",
      cine.slice(0, 160),
      r.firma ? String(r.firma).slice(0, 160) : null,
      r.subiect ? String(r.subiect).slice(0, 300) : null,
      r.cere ? String(r.cere).slice(0, 1000) : null,
      r.pas_urmator ? String(r.pas_urmator).slice(0, 500) : null,
      r.primit_la ? String(r.primit_la).slice(0, 25) : null,
      r.necitit ? 1 : 0,
      r.a_insistat ? 1 : 0,
      r.link ? String(r.link).slice(0, 500) : null,
      Number.isFinite(Number(r.ordine)) ? Number(r.ordine) : 100,
      t,
    ];

    const existent = await db.prepare("SELECT id FROM radar_raspunsuri WHERE cheie_thread = ?").get(cheie);
    if (existent) {
      // „stare" nu se atinge: e ce am decis noi, nu ce a văzut agentul.
      await db
        .prepare(
          `UPDATE radar_raspunsuri SET sectiune = ?, severitate = ?, cine = ?, firma = ?, subiect = ?, cere = ?,
                                       pas_urmator = ?, primit_la = ?, necitit = ?, a_insistat = ?, link = ?,
                                       ordine = ?, actualizat_la = ?
             WHERE id = ?`
        )
        .run(...valori, existent.id);
    } else {
      await db
        .prepare(
          `INSERT INTO radar_raspunsuri (sectiune, severitate, cine, firma, subiect, cere, pas_urmator, primit_la,
                                         necitit, a_insistat, link, ordine, actualizat_la, cheie_thread)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...valori, cheie);
    }
    vazute.push(cheie);
    n++;
  }

  // Ce nu mai e în fișier a primit răspuns între timp.
  if (vazute.length) {
    const semne = vazute.map(() => "?").join(",");
    await db.prepare(`DELETE FROM radar_raspunsuri WHERE cheie_thread NOT IN (${semne})`).run(...vazute);
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

// Angajații, citiți din statele de plată din Drive (Grup-Oeru).
//
// Ce intră: numele, funcția, salariul brut și net, data contractului, firma.
// Ce NU intră: CNP-ul. E în PDF-uri, dar nu se citește și nu se scrie nicăieri
// — ERP-ul n-are ce face cu el, iar un CNP ținut degeaba e doar risc.
//
// Actualizarea e pe nume + firmă: cine e în fișier se creează sau se
// actualizează, cine nu mai e pe statul firmei ăleia trece pe „inactiv" —
// nu se șterge, ca să rămână istoricul.
async function incarcaAngajati() {
  const randuri = citesteFisier("angajati.json");
  if (!randuri) return 0;
  const firme = await db.prepare("SELECT id, cui FROM firme").all();
  const dupaCui = new Map(firme.map((f) => [String(f.cui || "").replace(/[^0-9]/g, ""), f.id]));
  const t = acum();
  const vazuti = new Map(); // firma_id -> Set de nume
  let n = 0;

  for (const r of randuri.slice(0, 500)) {
    const nume = String((r && r.nume) || "").trim();
    if (!nume) continue;
    const firmaId = dupaCui.get(String(r.firma_cui || "").replace(/[^0-9]/g, "")) || null;
    const existent = await db
      .prepare(
        firmaId
          ? "SELECT id FROM angajati WHERE LOWER(nume) = LOWER(?) AND firma_id = ?"
          : "SELECT id FROM angajati WHERE LOWER(nume) = LOWER(?)"
      )
      .get(...(firmaId ? [nume, firmaId] : [nume]));

    const valori = [
      String(r.functie || "").slice(0, 120) || null,
      r.data_angajarii ? String(r.data_angajarii).slice(0, 10) : null,
      Number(r.salariu_brut) || 0,
      Number(r.salariu_net) || 0,
      r.sediu ? String(r.sediu).slice(0, 120) : null,
      firmaId,
      "state de plată Drive",
      t,
    ];
    if (existent) {
      await db
        .prepare(
          `UPDATE angajati SET functie = ?, data_angajarii = COALESCE(?, data_angajarii), salariu_baza = ?,
                               salariu_net = ?, sediu = ?, firma_id = ?, sursa = ?, actualizat_la = ?, activ = 1
           WHERE id = ?`
        )
        .run(...valori, existent.id);
    } else {
      await db
        .prepare(
          `INSERT INTO angajati (nume, functie, data_angajarii, salariu_baza, salariu_net, sediu, firma_id, sursa, actualizat_la, activ)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(nume, ...valori);
    }
    n++;
    if (firmaId) {
      if (!vazuti.has(firmaId)) vazuti.set(firmaId, new Set());
      vazuti.get(firmaId).add(nume.toLowerCase());
    }
  }

  // Cine nu mai apare pe statul firmei lui trece pe inactiv.
  for (const [firmaId, nume] of vazuti) {
    const aiFirmei = await db.prepare("SELECT id, nume FROM angajati WHERE firma_id = ? AND activ = 1").all(firmaId);
    for (const a of aiFirmei) {
      if (!nume.has(String(a.nume).toLowerCase())) {
        await db.prepare("UPDATE angajati SET activ = 0, actualizat_la = ? WHERE id = ?").run(t, a.id);
      }
    }
  }
  return n;
}

// Chemată o dată la pornire, din server.js.
async function incarcaTot() {
  try {
    const a = await incarcaAgenda();
    const s = await incarcaStiri();
    const c = await incarcaCosturi();
    const g = await incarcaAngajati();
    const r = await incarcaRadar();
    if (a || s || c || g || r)
      console.log(`[sincronizare] agendă: ${a}, știri: ${s}, costuri noi: ${c}, angajați: ${g}, radar: ${r}`);
  } catch (e) {
    console.error("[sincronizare] încărcarea a eșuat:", e.message);
  }
}

function register(router) {
  // Un rând din radar, închis de mână. Nu-l ștergem: dacă partenerul revine
  // pe același thread, agentul îl aduce înapoi cu starea resetată la „nou".
  router.post("/radar/:id/rezolvat", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/");
    const id = Number(ctx.params.id);
    if (Number.isFinite(id)) {
      await db.prepare("UPDATE radar_raspunsuri SET stare = 'rezolvat', actualizat_la = ? WHERE id = ?").run(acum(), id);
    }
    redirect(ctx.res, "/");
  });

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
    const r = await db.prepare("SELECT COUNT(*) AS n, MAX(actualizat_la) AS d FROM radar_raspunsuri").get();
    const areAgenda = !!citesteFisier("agenda.json");
    const areStiri = !!citesteFisier("stiri.json");
    const areRadar = !!citesteFisier("radar-raspunsuri.json");
    const body = `
      <h1>Agendă, știri și radar</h1>
      <p style="max-width:720px;color:var(--text-muted)">
        Întâlnirile din calendar, știrile de pe dashboard și lista de threaduri care așteaptă un răspuns de la noi
        nu se pot afla din baza noastră de date. Vin din trei fișiere ținute în repo — <code>date/agenda.json</code>,
        <code>date/stiri.json</code> și <code>date/radar-raspunsuri.json</code> — pe care le împrospătează Claude
        și care se încarcă la fiecare pornire a aplicației.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Agendă în baza de date</div><div class="value">${Number(a.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${a.d ? "încărcat " + esc(String(a.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Știri în baza de date</div><div class="value">${Number(s.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.d ? "încărcat " + esc(String(s.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Radar răspunsuri</div><div class="value">${Number(r.n || 0)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${r.d ? "încărcat " + esc(String(r.d).slice(0, 16)) : "niciodată"}</div></div>
        <div class="card"><div class="label">Fișiere găsite</div>
          <div class="value" style="font-size:16px">
            ${areAgenda ? '<span class="badge verde">agenda.json</span>' : '<span class="badge rosu">agenda.json lipsă</span>'}
            ${areStiri ? '<span class="badge verde">stiri.json</span>' : '<span class="badge rosu">stiri.json lipsă</span>'}
            ${areRadar ? '<span class="badge verde">radar-raspunsuri.json</span>' : '<span class="badge rosu">radar-raspunsuri.json lipsă</span>'}
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
