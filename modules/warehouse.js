"use strict";
// Depozitul, ca loc de muncă, nu ca tabel.
//
// Fluxul cerut de Vali, pe scurt: comanda pusă de agent aterizează aici ca
// „comandă deschisă". Operatorul o deschide, vede linie cu linie ce e pe
// stoc și ce nu, și de aici pleacă trei drumuri:
//   1. totul e pe stoc  → confirmă, iar comanda se întoarce la agent în CRM,
//      unde el alege: facturez tot / aștept comanda completă / facturez
//      parțial ce e în stoc / rezervă stocul o zi.
//   2. lipsește ceva     → cere aprovizionare, de la un terț sau din producție.
//      Producția vede termenul cerut de agent și îl confirmă sau nu. Dacă îl
//      confirmă, comanda de producție se deschide automat. Dacă nu, comanda
//      poate fi anulată și rămâne în listă ca anulată.
//   3. producția, la rândul ei, cere materie primă de la depozit — același
//      drum, doar că depozitul e cel care validează și dă termen.
//
// Rezervarea are termen de un ceas, nu de o promisiune: `expira_la` e o oră
// concretă, iar `elibereazaExpirate()` rulează periodic și le stinge. Marfa
// rezervată nu dispare din stoc — dispare doar din „disponibil".
const db = require("../lib/db");
const { esc, money, layout, table, subnavWarehouse } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const REZERVARE_ORE = 24;

function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
function peste(ore) {
  return new Date(Date.now() + ore * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}
function azi() {
  return new Date().toISOString().slice(0, 10);
}

const STATUS_APROV = {
  ceruta: '<span class="badge gri">cerută</span>',
  confirmata: '<span class="badge albastru">confirmată</span>',
  gata: '<span class="badge albastru">gata la producție</span>',
  refuzata: '<span class="badge rosu">refuzată</span>',
  primita: '<span class="badge verde">intrată în stoc</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};

// --- stoc disponibil ------------------------------------------------------
// Disponibil = ce e fizic în depozite minus ce e rezervat și încă valabil.
// Rezervările proprii comenzii nu se scad — altfel comanda s-ar bloca singură.
async function elibereazaExpirate() {
  const r = await db
    .prepare("UPDATE rezervari_stoc SET stare = 'expirata' WHERE stare = 'activa' AND expira_la IS NOT NULL AND expira_la < ?")
    .run(acum());
  return r && r.changes ? r.changes : 0;
}

async function stocPeProduse() {
  const randuri = await db
    .prepare(
      `SELECT produs_id, COALESCE(SUM(CASE WHEN tip = 'intrare' THEN cantitate ELSE -cantitate END), 0) AS stoc
       FROM miscari_stoc GROUP BY produs_id`
    )
    .all();
  const m = new Map();
  for (const r of randuri) m.set(Number(r.produs_id), Number(r.stoc) || 0);
  return m;
}

async function rezervatPeProduse(exceptComandaId) {
  const randuri = await db
    .prepare(
      `SELECT produs_id, comanda_id, COALESCE(SUM(cantitate), 0) AS cant
       FROM rezervari_stoc WHERE stare = 'activa' GROUP BY produs_id, comanda_id`
    )
    .all();
  const m = new Map();
  for (const r of randuri) {
    if (exceptComandaId && Number(r.comanda_id) === Number(exceptComandaId)) continue;
    m.set(Number(r.produs_id), (m.get(Number(r.produs_id)) || 0) + (Number(r.cant) || 0));
  }
  return m;
}

// Potrivirea unei comenzi cu stocul: pentru fiecare linie, cât cere, cât e
// disponibil și cât lipsește.
async function potrivire(comandaId) {
  await elibereazaExpirate();
  const linii = await db
    .prepare(
      `SELECT cl.*, p.denumire, p.unitate_masura
       FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id
       WHERE cl.comanda_id = ? ORDER BY cl.id`
    )
    .all(comandaId);
  const stoc = await stocPeProduse();
  const rez = await rezervatPeProduse(comandaId);
  let acoperiteTot = true;
  let acoperitePartial = false;
  const rezervariProprii = await db
    .prepare("SELECT linie_id, produs_id, cantitate, expira_la FROM rezervari_stoc WHERE comanda_id = ? AND stare = 'activa'")
    .all(comandaId);
  const rezMap = new Map();
  for (const r of rezervariProprii) rezMap.set(Number(r.linie_id), r);

  const rezultat = linii.map((l) => {
    const cerut = Number(l.cantitate) || 0;
    const livrat = Number(l.cantitate_livrata) || 0;
    const ramas = Math.max(0, cerut - livrat);
    const fizic = stoc.get(Number(l.produs_id)) || 0;
    const blocat = rez.get(Number(l.produs_id)) || 0;
    const disponibil = fizic - blocat;
    const acoperit = Math.max(0, Math.min(ramas, disponibil));
    const lipsa = Math.max(0, ramas - acoperit);
    if (lipsa > 0.0001) acoperiteTot = false;
    if (acoperit > 0.0001) acoperitePartial = true;
    return { ...l, cerut, livrat, ramas, fizic, blocat, disponibil, acoperit, lipsa, rezervare: rezMap.get(Number(l.id)) || null };
  });
  return { linii: rezultat, acoperiteTot: rezultat.length > 0 && acoperiteTot, acoperitePartial };
}

function nr(v) {
  const n = Number(v || 0);
  return n.toLocaleString("ro-RO", { maximumFractionDigits: 3 });
}

function poateDepozit(user) {
  return user && (user.rol === "admin" || user.rol === "depozit");
}

function register(router) {
  // --- lista de comenzi deschise -----------------------------------------
  router.get("/warehouse", async (ctx) => {
    await elibereazaExpirate();
    const comenzi = await db
      .prepare(
        `SELECT c.*, p.nume AS partener_nume,
                COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total
         FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
         WHERE c.status NOT IN ('facturata', 'livrata', 'anulata')
         ORDER BY COALESCE(c.data_livrare_ceruta, c.data) ASC, c.id DESC
         LIMIT 300`
      )
      .all();

    const stoc = await stocPeProduse();
    const rez = await rezervatPeProduse(null);
    const liniiTot = await db
      .prepare(
        `SELECT cl.comanda_id, cl.produs_id, cl.cantitate, cl.cantitate_livrata
         FROM comenzi_linii cl JOIN comenzi c ON c.id = cl.comanda_id
         WHERE c.status NOT IN ('facturata', 'livrata', 'anulata')`
      )
      .all();
    const perComanda = new Map();
    for (const l of liniiTot) {
      const k = Number(l.comanda_id);
      const ramas = Math.max(0, (Number(l.cantitate) || 0) - (Number(l.cantitate_livrata) || 0));
      const disp = (stoc.get(Number(l.produs_id)) || 0) - (rez.get(Number(l.produs_id)) || 0);
      const cur = perComanda.get(k) || { linii: 0, complete: 0, partiale: 0 };
      cur.linii++;
      if (disp >= ramas - 0.0001) cur.complete++;
      else if (disp > 0.0001) cur.partiale++;
      perComanda.set(k, cur);
    }

    function stareStoc(id) {
      const s = perComanda.get(Number(id));
      if (!s || !s.linii) return '<span class="badge gri">fără linii</span>';
      if (s.complete === s.linii) return '<span class="badge verde">tot pe stoc</span>';
      if (s.complete + s.partiale === 0) return '<span class="badge rosu">nimic pe stoc</span>';
      return `<span class="badge galben">parțial (${s.complete}/${s.linii})</span>`;
    }

    const nrAprov = await db.prepare("SELECT COUNT(*) AS n FROM aprovizionari WHERE status IN ('ceruta','confirmata')").get();
    const nrMaterii = await db.prepare("SELECT COUNT(*) AS n FROM cereri_materie_prima WHERE status = 'ceruta'").get();
    const nrRezervari = await db.prepare("SELECT COUNT(*) AS n FROM rezervari_stoc WHERE stare = 'activa'").get();

    const body = `
      ${subnavWarehouse("/warehouse")}
      <p style="max-width:760px;color:var(--text-muted)">
        Tot ce a comandat cineva — agent de vânzări sau orice alt utilizator — și încă nu a plecat pe factură.
        Deschide o comandă ca să vezi linie cu linie ce e pe stoc, ce lipsește, și ca să confirmi, să rezervi
        sau să ceri aprovizionare.
      </p>
      <div class="cards">
        <div class="card"><div class="label">Comenzi deschise</div><div class="value">${comenzi.length}</div></div>
        <div class="card"><div class="label">Aprovizionări în lucru</div><div class="value">${Number(nrAprov.n || 0)}</div>
          <div style="font-size:12px"><a href="/warehouse/aprovizionare">vezi lista</a></div></div>
        <div class="card"><div class="label">Cereri materie primă</div><div class="value">${Number(nrMaterii.n || 0)}</div>
          <div style="font-size:12px"><a href="/warehouse/aprovizionare#materii">de la producție</a></div></div>
        <div class="card"><div class="label">Rezervări active</div><div class="value">${Number(nrRezervari.n || 0)}</div></div>
      </div>
      ${table(
        ["Nr.", "Client", "Cerut pe", "Status", "Acoperire stoc", "Valoare", ""],
        comenzi.map((c) => [
          esc(c.numar || "#" + c.id),
          esc(c.partener_nume),
          esc(c.data_livrare_ceruta || "—"),
          esc(c.status),
          stareStoc(c.id),
          money(c.total),
          `<a class="btn small" href="/warehouse/comanda/${c.id}">Deschide</a>`,
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Warehouse — comenzi deschise", active: "/warehouse", body }));
  });

  // --- potrivirea unei comenzi cu stocul ----------------------------------
  router.get("/warehouse/comanda/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await db
      .prepare("SELECT c.*, p.nume AS partener_nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?")
      .get(id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Comanda nu există", active: "/warehouse", body: "<p>Comanda nu există.</p>" }));
    const { linii, acoperiteTot } = await potrivire(id);
    const furnizori = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 2000").all();
    const aprov = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs, f.nume AS furnizor
         FROM aprovizionari a JOIN produse p ON p.id = a.produs_id
         LEFT JOIN parteneri f ON f.id = a.furnizor_id
         WHERE a.comanda_id = ? ORDER BY a.id DESC`
      )
      .all(id);

    const randuri = linii.map((l) => {
      const stareLinie =
        l.ramas <= 0.0001
          ? '<span class="badge verde">livrată</span>'
          : l.lipsa <= 0.0001
            ? '<span class="badge verde">pe stoc</span>'
            : l.acoperit > 0.0001
              ? '<span class="badge galben">parțial</span>'
              : '<span class="badge rosu">lipsă</span>';
      const rezervare = l.rezervare
        ? `<div style="font-size:12px;color:var(--text-muted)">rezervat ${nr(l.rezervare.cantitate)} până la ${esc(String(l.rezervare.expira_la || "").slice(0, 16))}</div>`
        : "";
      const cereForm =
        l.lipsa > 0.0001 && poateDepozit(ctx.user)
          ? `<form method="post" action="/warehouse/comanda/${id}/aprovizionare" class="inline-form" style="gap:6px;flex-wrap:wrap">
               <input type="hidden" name="linie_id" value="${l.id}">
               <input type="number" step="0.001" name="cantitate" value="${l.lipsa.toFixed(3)}" style="width:90px">
               <select name="sursa">
                 <option value="tert">de la terț</option>
                 <option value="productie">din producție</option>
               </select>
               <select name="furnizor_id"><option value="">— furnizor —</option>${furnizori
                 .map((f) => `<option value="${f.id}">${esc(f.nume)}</option>`)
                 .join("")}</select>
               <button class="btn small" type="submit">Comandă</button>
             </form>`
          : "";
      return [
        esc(l.denumire),
        `${nr(l.cerut)} ${esc(l.unitate_masura || "")}`,
        nr(l.livrat),
        nr(l.fizic),
        nr(l.blocat),
        `<strong>${nr(l.disponibil)}</strong>`,
        l.lipsa > 0.0001 ? `<span style="color:var(--rosu,#b3261e)">${nr(l.lipsa)}</span>` : "0",
        stareLinie + rezervare,
        cereForm,
      ];
    });

    const actiuni = poateDepozit(ctx.user)
      ? `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
           <form method="post" action="/warehouse/comanda/${id}/confirma" class="inline-form">
             <button class="btn" type="submit" ${acoperiteTot ? "" : 'title="Nu tot e pe stoc — confirmarea trimite doar ce se poate acoperi"'}>
               Confirmă disponibilitatea
             </button>
           </form>
           <form method="post" action="/warehouse/comanda/${id}/rezerva" class="inline-form">
             <button class="btn secondary" type="submit">Rezervă stocul ${REZERVARE_ORE} h</button>
           </form>
           <form method="post" action="/warehouse/comanda/${id}/elibereaza" class="inline-form">
             <button class="btn secondary" type="submit">Eliberează rezervarea</button>
           </form>
           <a class="btn secondary" href="/comenzi/${id}">Vezi comanda în CRM</a>
         </div>`
      : `<div class="toolbar"><a class="btn secondary" href="/comenzi/${id}">Vezi comanda în CRM</a></div>`;

    const body = `
      ${subnavWarehouse("/warehouse")}
      <p style="color:var(--text-muted)">
        Status: <strong>${esc(c.status)}</strong> ·
        cerută pe ${esc(c.data_livrare_ceruta || "fără termen")} ·
        ${c.verificata_depozit_la ? "verificată de depozit la " + esc(String(c.verificata_depozit_la).slice(0, 16)) : "neverificată încă"}
      </p>
      ${actiuni}
      ${table(["Produs", "Cerut", "Livrat", "Stoc fizic", "Rezervat de alții", "Disponibil", "Lipsă", "Stare", "Aprovizionare"], randuri)}
      ${
        aprov.length
          ? `<h2>Aprovizionări cerute pentru comanda asta</h2>
             ${table(
               ["Produs", "Cantitate", "Sursă", "Furnizor", "Termen cerut", "Termen confirmat", "Status"],
               aprov.map((a) => [
                 esc(a.produs),
                 nr(a.cantitate),
                 a.sursa === "productie" ? "producție" : "terț",
                 esc(a.furnizor || "—"),
                 esc(a.termen_cerut || "—"),
                 esc(a.termen_confirmat || "—"),
                 STATUS_APROV[a.status] || esc(a.status),
               ])
             )}`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comanda ${c.numar || "#" + c.id} — ${c.partener_nume}`, active: "/warehouse", body }));
  });

  // Confirmarea depozitului: marfa există, comanda se întoarce la agent.
  router.post("/warehouse/comanda/:id/confirma", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse");
    const id = parseInt(ctx.params.id, 10);
    await db
      .prepare("UPDATE comenzi SET status = 'confirmata', verificata_depozit_la = ?, verificata_depozit_de = ? WHERE id = ?")
      .run(acum(), ctx.user.nume, id);
    redirect(ctx.res, `/warehouse/comanda/${id}`);
  });

  // Rezervare pe termen scurt. Nu mișcă stocul, doar îl scoate din „disponibil".
  router.post("/warehouse/comanda/:id/rezerva", async (ctx) => {
    if (!poateDepozit(ctx.user) && !(ctx.user && ["admin", "vanzari", "financiar"].includes(ctx.user.rol))) {
      return redirect(ctx.res, "/warehouse");
    }
    const id = parseInt(ctx.params.id, 10);
    await db.prepare("UPDATE rezervari_stoc SET stare = 'inlocuita' WHERE comanda_id = ? AND stare = 'activa'").run(id);
    const { linii } = await potrivire(id);
    const expira = peste(REZERVARE_ORE);
    for (const l of linii) {
      if (l.acoperit <= 0.0001) continue;
      await db
        .prepare(
          `INSERT INTO rezervari_stoc (comanda_id, linie_id, produs_id, cantitate, creata_la, expira_la, stare, creata_de)
           VALUES (?, ?, ?, ?, ?, ?, 'activa', ?)`
        )
        .run(id, l.id, l.produs_id, l.acoperit, acum(), expira, ctx.user ? ctx.user.nume : null);
    }
    redirect(ctx.res, ctx.body && ctx.body.inapoi === "crm" ? `/comenzi/${id}` : `/warehouse/comanda/${id}`);
  });

  router.post("/warehouse/comanda/:id/elibereaza", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    await db.prepare("UPDATE rezervari_stoc SET stare = 'eliberata' WHERE comanda_id = ? AND stare = 'activa'").run(id);
    redirect(ctx.res, ctx.body && ctx.body.inapoi === "crm" ? `/comenzi/${id}` : `/warehouse/comanda/${id}`);
  });

  // Cererea de aprovizionare: fie la un terț, fie la producție. Dacă e la
  // producție, termenul cerut e cel pe care l-a promis agentul clientului.
  router.post("/warehouse/comanda/:id/aprovizionare", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const linieId = parseInt(b.linie_id, 10) || null;
    const linie = linieId ? await db.prepare("SELECT * FROM comenzi_linii WHERE id = ?").get(linieId) : null;
    if (!linie) return redirect(ctx.res, `/warehouse/comanda/${id}`);
    const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(id);
    const cantitate = Number(b.cantitate) || 0;
    if (cantitate <= 0) return redirect(ctx.res, `/warehouse/comanda/${id}`);
    const sursa = b.sursa === "productie" ? "productie" : "tert";
    await db
      .prepare(
        `INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, sursa, furnizor_id, termen_cerut, status, cerut_de, creata_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ceruta', ?, ?)`
      )
      .run(
        id,
        linieId,
        linie.produs_id,
        cantitate,
        sursa,
        sursa === "tert" ? parseInt(b.furnizor_id, 10) || null : null,
        (c && c.data_livrare_ceruta) || null,
        ctx.user ? ctx.user.nume : null,
        acum()
      );
    redirect(ctx.res, `/warehouse/comanda/${id}`);
  });

  // --- aprovizionare: lista mare ------------------------------------------
  router.get("/warehouse/aprovizionare", async (ctx) => {
    const aprov = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs, p.unitate_masura, f.nume AS furnizor, c.numar AS comanda_numar,
                cl.nume AS client
         FROM aprovizionari a
         JOIN produse p ON p.id = a.produs_id
         LEFT JOIN parteneri f ON f.id = a.furnizor_id
         LEFT JOIN comenzi c ON c.id = a.comanda_id
         LEFT JOIN parteneri cl ON cl.id = c.partener_id
         ORDER BY CASE a.status WHEN 'ceruta' THEN 0 WHEN 'confirmata' THEN 1 ELSE 2 END, a.id DESC
         LIMIT 300`
      )
      .all();
    const materii = await db
      .prepare(
        `SELECT m.*, p.denumire AS produs FROM cereri_materie_prima m
         LEFT JOIN produse p ON p.id = m.produs_id
         ORDER BY CASE m.status WHEN 'ceruta' THEN 0 WHEN 'confirmata' THEN 1 ELSE 2 END, m.id DESC
         LIMIT 200`
      )
      .all();
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY id").all();
    const optDep = depozite.map((d) => `<option value="${d.id}">${esc(d.denumire)}</option>`).join("");

    const randuriA = aprov.map((a) => {
      const actiuni =
        poateDepozit(ctx.user) && ["ceruta", "confirmata", "gata"].includes(a.status)
          ? `<form method="post" action="/warehouse/aprovizionare/${a.id}/primita" class="inline-form" style="gap:6px">
               <select name="depozit_id" style="width:120px">${optDep}</select>
               <button class="btn small" type="submit">Intră în stoc</button>
             </form>
             <form method="post" action="/warehouse/aprovizionare/${a.id}/anuleaza" class="inline-form">
               <button class="link-btn danger" type="submit">Anulează</button>
             </form>`
          : "";
      return [
        esc(a.produs),
        `${nr(a.cantitate)} ${esc(a.unitate_masura || "")}`,
        a.sursa === "productie" ? "producție" : "terț",
        esc(a.furnizor || "—"),
        a.comanda_id ? `<a href="/warehouse/comanda/${a.comanda_id}">${esc(a.comanda_numar || "#" + a.comanda_id)}</a><br><span style="font-size:12px">${esc(a.client || "")}</span>` : "pentru stoc",
        esc(a.termen_cerut || "—"),
        esc(a.termen_confirmat || "—"),
        STATUS_APROV[a.status] || esc(a.status),
        actiuni,
      ];
    });

    const randuriM = materii.map((m) => {
      const actiuni =
        poateDepozit(ctx.user) && m.status === "ceruta"
          ? `<form method="post" action="/warehouse/materie/${m.id}/valideaza" class="inline-form" style="gap:6px">
               <input type="date" name="termen" value="${esc(m.termen_cerut || azi())}">
               <button class="btn small" type="submit">Confirmă termen</button>
             </form>
             <form method="post" action="/warehouse/materie/${m.id}/refuza" class="inline-form">
               <button class="link-btn danger" type="submit">Refuză</button>
             </form>`
          : poateDepozit(ctx.user) && m.status === "confirmata"
            ? `<form method="post" action="/warehouse/materie/${m.id}/livrata" class="inline-form" style="gap:6px">
                 <select name="depozit_id" style="width:120px">${optDep}</select>
                 <button class="btn small" type="submit">Am dat marfa</button>
               </form>`
            : "";
      return [
        esc(m.produs || m.descriere || "—"),
        `${nr(m.cantitate)} ${esc(m.um || "")}`,
        esc(m.cerut_de || "—"),
        esc(m.termen_cerut || "—"),
        esc(m.termen_confirmat || "—"),
        STATUS_APROV[m.status] || esc(m.status),
        actiuni,
      ];
    });

    const body = `
      ${subnavWarehouse("/warehouse/aprovizionare")}
      <p style="max-width:760px;color:var(--text-muted)">
        Ce s-a cerut pentru comenzile care nu se acoperă din stoc. Cererile către producție apar și la ei, cu termenul
        cerut de agent — ei îl confirmă sau nu. Când marfa e gata sau a venit de la furnizor, apeși „Intră în stoc"
        și mișcarea de stoc se scrie singură.
      </p>
      ${table(["Produs", "Cantitate", "Sursă", "Furnizor", "Pentru comanda", "Termen cerut", "Termen confirmat", "Status", ""], randuriA)}
      <h2 id="materii">Materie primă cerută de producție</h2>
      ${table(["Produs / descriere", "Cantitate", "Cerut de", "Termen cerut", "Termen dat", "Status", ""], randuriM)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "De aprovizionat", active: "/warehouse", body }));
  });

  // Marfa a intrat: scriem intrarea de stoc și, dacă e cazul, deblocăm comanda.
  router.post("/warehouse/aprovizionare/:id/primita", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse/aprovizionare");
    const id = parseInt(ctx.params.id, 10);
    const a = await db.prepare("SELECT * FROM aprovizionari WHERE id = ?").get(id);
    if (!a) return redirect(ctx.res, "/warehouse/aprovizionare");
    let depozitId = parseInt((ctx.body || {}).depozit_id, 10) || null;
    if (!depozitId) {
      const d = await db.prepare("SELECT id FROM depozite ORDER BY id LIMIT 1").get();
      depozitId = d ? d.id : null;
    }
    if (depozitId) {
      const pret = await db.prepare("SELECT pret_achizitie FROM produse WHERE id = ?").get(a.produs_id);
      await db
        .prepare(
          `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, data, observatii)
           VALUES (?, ?, 'intrare', ?, ?, ?, ?, ?)`
        )
        .run(
          a.produs_id,
          depozitId,
          Number(a.cantitate) || 0,
          pret ? Number(pret.pret_achizitie) || 0 : 0,
          `aprovizionare #${id}`,
          acum(),
          a.sursa === "productie" ? "intrare din producție" : "intrare de la furnizor"
        );
    }
    await db.prepare("UPDATE aprovizionari SET status = 'primita' WHERE id = ?").run(id);
    if (a.comanda_id) {
      const c = await db.prepare("SELECT status FROM comenzi WHERE id = ?").get(a.comanda_id);
      if (c && ["noua", "confirmata", "in_productie"].includes(c.status)) {
        const { acoperiteTot } = await potrivire(a.comanda_id);
        if (acoperiteTot) await db.prepare("UPDATE comenzi SET status = 'in_stoc_depozit' WHERE id = ?").run(a.comanda_id);
      }
    }
    redirect(ctx.res, "/warehouse/aprovizionare");
  });

  router.post("/warehouse/aprovizionare/:id/anuleaza", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse/aprovizionare");
    await db.prepare("UPDATE aprovizionari SET status = 'anulata' WHERE id = ?").run(parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/warehouse/aprovizionare");
  });

  // --- materie primă cerută de producție ----------------------------------
  router.post("/warehouse/materie/:id/valideaza", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse/aprovizionare");
    const termen = String((ctx.body || {}).termen || "").slice(0, 10) || null;
    await db
      .prepare("UPDATE cereri_materie_prima SET status = 'confirmata', termen_confirmat = ? WHERE id = ?")
      .run(termen, parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/warehouse/aprovizionare#materii");
  });

  router.post("/warehouse/materie/:id/refuza", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse/aprovizionare");
    await db
      .prepare("UPDATE cereri_materie_prima SET status = 'refuzata', raspuns = ? WHERE id = ?")
      .run("refuzat de depozit", parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/warehouse/aprovizionare#materii");
  });

  router.post("/warehouse/materie/:id/livrata", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/warehouse/aprovizionare");
    const id = parseInt(ctx.params.id, 10);
    const m = await db.prepare("SELECT * FROM cereri_materie_prima WHERE id = ?").get(id);
    if (m && m.produs_id) {
      let depozitId = parseInt((ctx.body || {}).depozit_id, 10) || null;
      if (!depozitId) {
        const d = await db.prepare("SELECT id FROM depozite ORDER BY id LIMIT 1").get();
        depozitId = d ? d.id : null;
      }
      if (depozitId) {
        await db
          .prepare(
            `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, document_ref, data, observatii)
             VALUES (?, ?, 'iesire', ?, ?, ?, 'materie primă dată în producție')`
          )
          .run(m.produs_id, depozitId, Number(m.cantitate) || 0, `materie primă #${id}`, acum());
      }
    }
    await db.prepare("UPDATE cereri_materie_prima SET status = 'primita' WHERE id = ?").run(id);
    redirect(ctx.res, "/warehouse/aprovizionare#materii");
  });
}

// Curățenia rezervărilor expirate, o dată la un sfert de oră.
function porneste() {
  const tic = async () => {
    try {
      const n = await elibereazaExpirate();
      if (n) console.log(`[warehouse] ${n} rezervări expirate, stoc eliberat`);
    } catch (e) {
      console.error("[warehouse] eliberare rezervări:", e.message);
    }
  };
  tic();
  const t = setInterval(tic, 15 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { register, porneste, potrivire, elibereazaExpirate, REZERVARE_ORE };
