"use strict";
// Depozitul, ca loc de muncă, nu ca tabel.
//
// Fișierul se numește warehouse.js din motive de istorie — rutele și meniul
// sunt „depozit", în română, ca tot restul aplicației.
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
const { esc, money, layout, table, subnavDepozit } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const T = require("../lib/termene");
const livrare = require("../lib/livrare-partiala");
const stari = require("../lib/comenzi-stari");
const STADIU = require("../lib/stadiu-comanda");

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
  // Producția a terminat; marfa e la ei și așteaptă depozitul. Galben, fiindcă
  // acum e rândul nostru (vezi „De preluat din producție" pe /depozit).
  gata: '<span class="badge galben">de preluat din producție</span>',
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

// Stocul fizic e CT-Park, singurul depozit (Vali, 05.11.2026): liniile
// paleților încă în depozit (paletul vechi, fără linii, cu coloanele lui), plus
// marfa dintr-o recepție finalizată care n-a ajuns încă pe un palet — e în
// depozit, doar că n-are încă raft. Ce s-a pus pe raft sau a plecat direct la
// livrare are palet legat de rândul recepției și nu se mai numără a doua oară.
//
// Până pe 09.11.2026 se citea tabela veche miscari_stoc (stocul adus din
// SmartBill și recepțiile vechi), iar comanda spunea „lipsă" la marfă care
// stătea pe raft în CT-Park. Vali, cu poza comenzii #70: „scrie că are stoc,
// dar apare cu lipsă stoc pe produsul ăla — probabil nu caută în depozitul
// CT-Park, unde e singurul stoc."
async function stocPeProduse() {
  const randuri = await db
    .prepare(
      `SELECT produs_id, SUM(cantitate) AS stoc FROM (
         SELECT pl.produs_id, pl.cantitate
           FROM ct_palet_linii pl JOIN ct_paleti p ON p.id = pl.palet_id
          WHERE p.data_iesire IS NULL AND pl.cantitate > 0
         UNION ALL
         SELECT p.produs_id, p.cantitate
           FROM ct_paleti p
          WHERE p.data_iesire IS NULL AND p.cantitate > 0
            AND NOT EXISTS (SELECT 1 FROM ct_palet_linii x WHERE x.palet_id = p.id)
         UNION ALL
         SELECT rl.produs_id,
                COALESCE(rl.cantitate_primita, 0) - COALESCE((SELECT SUM(pp.cantitate) FROM ct_paleti pp WHERE pp.receptie_linie_id = rl.id), 0)
           FROM receptii_linii rl JOIN receptii r ON r.id = rl.receptie_id
          WHERE r.stare = 'finalizata' AND rl.stare = 'primita' AND COALESCE(rl.conditie, 'bun') = 'bun'
       ) t
       WHERE produs_id IS NOT NULL AND cantitate > 0
       GROUP BY produs_id`
    )
    .all();
  const m = new Map();
  for (const r of randuri) m.set(Number(r.produs_id), Number(r.stoc) || 0);
  return m;
}

// Rezervările agenților din „Stoc la zi" (lib/rezervari-agenti.js) țin marfa
// pentru un anume client: comanda altui client n-o poate lua. Rezervarea
// clientului comenzii e chiar pentru ea, deci nu o oprește.
//   total — produs → tot ce e rezervat; pe — „produs:client" → al clientului
async function rezervariAgenti() {
  try {
    await require("../lib/rezervari-agenti").actualizeaza();
  } catch (e) {
    // Fără tabelă (baza încă nemigrată) sau altă problemă: nu oprește potrivirea.
  }
  const randuri = await db
    .prepare("SELECT produs_id, partener_id, COALESCE(SUM(cantitate), 0) AS cant FROM rezervari_agenti WHERE stare = 'activa' GROUP BY produs_id, partener_id")
    .all()
    .catch(() => []);
  const total = new Map();
  const pe = new Map();
  for (const r of randuri) {
    const q = Number(r.cant) || 0;
    total.set(Number(r.produs_id), (total.get(Number(r.produs_id)) || 0) + q);
    pe.set(Number(r.produs_id) + ":" + Number(r.partener_id), q);
  }
  return { total, pe };
}
const rezervatPentruAltii = (ra, produsId, partenerId) =>
  Math.max(0, (ra.total.get(Number(produsId)) || 0) - (ra.pe.get(Number(produsId) + ":" + Number(partenerId)) || 0));

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
  // Furnizorul liniei (06.11.2026): dacă agentul l-a ales din stoc, depozitul
  // știe de pe ce paleți scoate marfa.
  const linii = await db
    .prepare(
      `SELECT cl.*, p.denumire, p.unitate_masura, f.nume AS furnizor_nume
       FROM comenzi_linii cl JOIN produse p ON p.id = cl.produs_id
       LEFT JOIN parteneri f ON f.id = cl.furnizor_id
       WHERE cl.comanda_id = ? ORDER BY cl.id`
    )
    .all(comandaId);
  const stoc = await stocPeProduse();
  const rez = await rezervatPeProduse(comandaId);
  const ra = await rezervariAgenti();
  const cmd = await db.prepare("SELECT partener_id FROM comenzi WHERE id = ?").get(comandaId).catch(() => null);
  const clientul = cmd ? Number(cmd.partener_id) : 0;
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
    // Blocat = rezervat de alte comenzi + rezervat de agenți pentru alți clienți.
    const blocat = (rez.get(Number(l.produs_id)) || 0) + rezervatPentruAltii(ra, l.produs_id, clientul);
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

// Marfa pe care producția a terminat-o și pe care depozitul încă n-a preluat-o.
//
// Două surse, fiindcă există două drumuri: recepția „din producție" (deschisă
// singură la „Finalizată", din 05.11.2026, sau cu „Trimit marfa în depozit")
// și cererea depozitului ajunsă „gata" fără recepție — comenzile terminate
// înainte de 05.11, sau unde deschiderea recepției a dat greș. Aceeași marfă
// nu apare de două ori: o cerere cu recepție (deschisă sau finalizată) e
// reprezentată de recepția ei.
async function marfaDePreluat() {
  const receptii = await db
    .prepare(
      `SELECT r.id AS receptie_id, r.numar AS receptie_numar, r.stare, r.data, r.anuntata_de, r.comanda_id,
              r.comanda_productie_id, cp.numar AS productie_numar, co.numar AS comanda_numar, pa.nume AS client
         FROM receptii r
         LEFT JOIN comenzi_productie cp ON cp.id = r.comanda_productie_id
         LEFT JOIN comenzi co ON co.id = r.comanda_id
         LEFT JOIN parteneri pa ON pa.id = co.partener_id
        WHERE r.sursa = 'productie' AND r.stare IN ('asteptata', 'in_lucru')
        ORDER BY r.id`
    )
    .all()
    .catch(() => []);
  const linii = receptii.length
    ? await db
        .prepare(
          `SELECT l.receptie_id, COALESCE(p.denumire, l.produs_text) AS produs, l.cantitate_asteptata, l.um
             FROM receptii_linii l LEFT JOIN produse p ON p.id = l.produs_id
            WHERE l.receptie_id IN (${receptii.map(() => "?").join(",")}) ORDER BY l.id`
        )
        .all(...receptii.map((r) => r.receptie_id))
        .catch(() => [])
    : [];
  const ce = new Map();
  for (const l of linii) {
    const k = Number(l.receptie_id);
    ce.set(k, (ce.get(k) ? ce.get(k) + "; " : "") + `${l.produs || "?"} — ${nr(l.cantitate_asteptata)} ${l.um || ""}`.trim());
  }
  const cereri = await db
    .prepare(
      `SELECT a.id AS aprovizionare_id, a.comanda_id, a.cantitate, a.termen_confirmat, p.denumire AS produs, p.unitate_masura,
              cp.id AS comanda_productie_id, cp.numar AS productie_numar, co.numar AS comanda_numar, pa.nume AS client
         FROM aprovizionari a
         JOIN produse p ON p.id = a.produs_id
         LEFT JOIN comenzi_productie cp ON cp.aprovizionare_id = a.id
         LEFT JOIN comenzi co ON co.id = a.comanda_id
         LEFT JOIN parteneri pa ON pa.id = co.partener_id
        WHERE a.status = 'gata'
          AND NOT EXISTS (SELECT 1 FROM receptii r WHERE r.aprovizionare_id = a.id AND r.stare <> 'anulata')
        ORDER BY a.id`
    )
    .all()
    .catch(() => []);
  return receptii
    .map((r) => ({ ...r, ce: ce.get(Number(r.receptie_id)) || "fără rânduri" }))
    .concat(cereri.map((a) => ({ ...a, receptie_id: null, stare: "gata", ce: `${a.produs} — ${nr(a.cantitate)} ${a.unitate_masura || ""}`.trim() })));
}

function tabelDePreluat(lista, user) {
  if (!lista.length) return "";
  return `<h2 id="de-preluat" style="margin-top:6px">De preluat din producție</h2>
    <p style="max-width:760px;color:var(--text-muted)">
      Producția a terminat marfa de mai jos și te așteaptă s-o preiei. Deschide recepția, scrie cât a venit de fapt și
      unde ai pus-o, apoi finalizeaz-o: marfa intră pe stoc, iar comanda clientului trece singură „în stoc depozit”.
    </p>
    ${table(
      ["Din producție", "Pentru comanda", "Ce", "Anunțată", "Stare", ""],
      lista.map((x) => [
        x.comanda_productie_id ? `<a href="/productie/${x.comanda_productie_id}">${esc(x.productie_numar || "#" + x.comanda_productie_id)}</a>` : "—",
        x.comanda_id
          ? `<a href="/depozit/comanda/${x.comanda_id}">${esc(x.comanda_numar || "#" + x.comanda_id)}</a><br><span style="font-size:12px">${esc(x.client || "")}</span>`
          : "pentru stoc",
        esc(x.ce),
        esc(String(x.data || x.termen_confirmat || "").slice(0, 10)) + (x.anuntata_de ? `<br><span style="font-size:12px;color:var(--text-muted)">${esc(x.anuntata_de)}</span>` : ""),
        x.stare === "in_lucru" ? '<span class="badge galben">în lucru</span>' : '<span class="badge galben">de preluat</span>',
        x.receptie_id
          ? `<a class="btn small" href="/depozit/receptie/${x.receptie_id}">${x.stare === "in_lucru" ? "Continuă recepția" : "Preia în depozit"}</a>`
          : poateDepozit(user)
            ? `<a class="btn small secondary" href="/depozit/aprovizionare">Preia din De aprovizionat</a>`
            : "",
      ])
    )}`;
}

function register(router) {
  // Adresele vechi, în engleză, duc la cele noi — cine avea un link salvat
  // nu se lovește de un 404 din cauza unei redenumiri.
  for (const vechi of ["/warehouse", "/warehouse/aprovizionare"]) {
    router.get(vechi, async (ctx) => redirect(ctx.res, vechi.replace("/warehouse", "/depozit")));
  }
  router.get("/warehouse/comanda/:id", async (ctx) => redirect(ctx.res, `/depozit/comanda/${ctx.params.id}`));

  // --- lista de comenzi deschise -----------------------------------------
  router.get("/depozit", async (ctx) => {
    await elibereazaExpirate();
    const comenzi = await db
      .prepare(
        `SELECT c.*, p.nume AS partener_nume,
                COALESCE((SELECT SUM(cl.cantitate * cl.pret_unitar) FROM comenzi_linii cl WHERE cl.comanda_id = c.id), 0) AS total
         FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
         WHERE c.status NOT IN ('facturata', 'in_livrare', 'livrata', 'anulata')
         ORDER BY c.id DESC
         LIMIT 300`
      )
      .all();

    const stoc = await stocPeProduse();
    const rez = await rezervatPeProduse(null);
    const ra = await rezervariAgenti();
    const liniiTot = await db
      .prepare(
        `SELECT cl.comanda_id, cl.produs_id, cl.cantitate, cl.cantitate_livrata, c.partener_id
         FROM comenzi_linii cl JOIN comenzi c ON c.id = cl.comanda_id
         WHERE c.status NOT IN ('facturata', 'in_livrare', 'livrata', 'anulata')`
      )
      .all();
    const perComanda = new Map();
    for (const l of liniiTot) {
      const k = Number(l.comanda_id);
      const ramas = Math.max(0, (Number(l.cantitate) || 0) - (Number(l.cantitate_livrata) || 0));
      const disp = (stoc.get(Number(l.produs_id)) || 0) - (rez.get(Number(l.produs_id)) || 0) - rezervatPentruAltii(ra, l.produs_id, l.partener_id);
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

    const dePreluat = await marfaDePreluat();

    const nrAprov = await db.prepare("SELECT COUNT(*) AS n FROM aprovizionari WHERE status IN ('ceruta','confirmata')").get();
    const nrMaterii = await db.prepare("SELECT COUNT(*) AS n FROM cereri_materie_prima WHERE status = 'ceruta'").get();
    const nrRezervari = await db.prepare("SELECT COUNT(*) AS n FROM rezervari_stoc WHERE stare = 'activa'").get();

    const body = `
      ${subnavDepozit("/depozit", ctx.user)}
      <p style="max-width:760px;color:var(--text-muted)">
        Tot ce a comandat cineva — agent de vânzări sau orice alt utilizator — și încă nu a plecat pe factură.
        Deschide o comandă ca să vezi linie cu linie ce e pe stoc, ce lipsește, și ca să confirmi, să rezervi
        sau să ceri aprovizionare.
      </p>
      <div class="cards">
        <div class="card"><div class="label">De preluat din producție</div><div class="value">${dePreluat.length}</div>
          <div style="font-size:12px">${dePreluat.length ? '<a href="#de-preluat">vezi mai jos</a>' : "nimic de preluat"}</div></div>
        <div class="card"><div class="label">Comenzi deschise</div><div class="value">${comenzi.length}</div></div>
        <div class="card"><div class="label">Aprovizionări în lucru</div><div class="value">${Number(nrAprov.n || 0)}</div>
          <div style="font-size:12px"><a href="/depozit/aprovizionare">vezi lista</a></div></div>
        <div class="card"><div class="label">Cereri materie primă</div><div class="value">${Number(nrMaterii.n || 0)}</div>
          <div style="font-size:12px"><a href="/depozit/aprovizionare#materii">de la producție</a></div></div>
        <div class="card"><div class="label">Rezervări active</div><div class="value">${Number(nrRezervari.n || 0)}</div></div>
      </div>
      ${tabelDePreluat(dePreluat, ctx.user)}
      ${table(
        ["Nr.", "Client", "Cerut pe", "Status", "Acoperire stoc", "Livrare parțială", "Valoare", ""],
        comenzi.map((c) => [
          esc(c.numar || "#" + c.id),
          esc(c.partener_nume),
          esc(c.data_livrare_ceruta || "—"),
          stari.eticheta(c.status),
          stareStoc(c.id),
          livrare.eticheta(c),
          money(c.total),
          `<a class="btn small" href="/depozit/comanda/${c.id}">Deschide</a>`,
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Depozit — comenzi deschise", active: "/depozit", body }));
  });

  // --- potrivirea unei comenzi cu stocul ----------------------------------
  router.get("/depozit/comanda/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await db
      .prepare("SELECT c.*, p.nume AS partener_nume FROM comenzi c JOIN parteneri p ON p.id = c.partener_id WHERE c.id = ?")
      .get(id);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Comanda nu există", active: "/depozit", body: "<p>Comanda nu există.</p>" }));
    const { linii, acoperiteTot, acoperitePartial } = await potrivire(id);
    // Ce are voie depozitul să trimită, după răspunsul luat de agent de la
    // client. Operatorul îl vede, nu îl schimbă.
    const acceptaPartial = livrare.acceptaPartial(c);
    const statusDupa = livrare.statusDupaVerificare({ acoperiteTot, acoperitePartial, comanda: c });
    const furnizori = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 2000").all();
    const aprov = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs, f.nume AS furnizor
         FROM aprovizionari a JOIN produse p ON p.id = a.produs_id
         LEFT JOIN parteneri f ON f.id = a.furnizor_id
         WHERE a.comanda_id = ? ORDER BY a.id DESC`
      )
      .all(id);

    // Marfă din producție pentru comanda asta, care încă stă la ei.
    const dePreluatAici = (await marfaDePreluat()).filter((x) => Number(x.comanda_id) === id);

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
      // Ce s-a comandat deja pentru linia asta. Vali, 05.11.2026, cu poza
      // comenzii Sameday de 13 linii: „după ce apeși Comandă, să se schimbe
      // culoarea butonului”. Toate butoanele arătau la fel, deci după a
      // cincea linie nu se mai știa care a plecat. Acum linia comandată are
      // butonul verde, „✓ Comandat”, scrie dedesubt ce și când, iar o a doua
      // apăsare întreabă înainte — altfel marfa se comandă de două ori.
      const cerute = aprov.filter((a) => Number(a.linie_id) === Number(l.id) && !["anulata", "refuzata"].includes(String(a.status)));
      // nr() de aici e afișare („1.250”), nu număr — suma se face pe numere.
      const dejaCerut = nr(cerute.reduce((s, a) => s + (Number(a.cantitate) || 0), 0));
      const notaCerute = cerute.length
        ? `<div style="font-size:12px;color:var(--success);margin-top:3px">${cerute
            .map(
              (a) =>
                `comandat ${esc(String(nr(a.cantitate)))} ${a.sursa === "productie" ? "din producție" : "de la terț"}${a.furnizor ? " · " + esc(a.furnizor) : ""} · ${esc(String(a.status || ""))}${a.creata_la ? " · " + esc(String(a.creata_la).slice(0, 16)) : ""}${a.cerut_de ? " · " + esc(a.cerut_de) : ""}`
            )
            .join("<br>")}</div>`
        : "";
      const cereForm =
        l.lipsa > 0.0001 && poateDepozit(ctx.user)
          ? `<form method="post" action="/depozit/comanda/${id}/aprovizionare" class="inline-form" style="gap:6px;flex-wrap:wrap"${
              cerute.length
                ? ` onsubmit="return confirm('Pentru linia asta ai comandat deja ${esc(String(dejaCerut))}. Mai comanzi o dată?')"`
                : ""
            }>
               <input type="hidden" name="linie_id" value="${l.id}">
               <input type="number" step="0.001" name="cantitate" value="${l.lipsa.toFixed(3)}" style="width:90px">
               <select name="sursa">
                 <option value="tert">de la terț</option>
                 <option value="productie">din producție</option>
               </select>
               <select name="furnizor_id" class="sel-ingust"><option value="">— furnizor —</option>${furnizori
                 .map((f) => `<option value="${f.id}" title="${esc(f.nume)}">${esc(f.nume)}</option>`)
                 .join("")}</select>
               ${
                 cerute.length
                   ? `<button class="btn small btn-comandat" type="submit" style="background:var(--success);border-color:var(--success);color:#fff" title="Deja comandat — apasă doar dacă mai trebuie o dată">✓ Comandat</button>`
                   : `<button class="btn small" type="submit">Comandă</button>`
               }
             </form>${notaCerute}`
          : notaCerute;
      return [
        esc(l.denumire) + require("../lib/furnizor-comanda").randFurnizor(l),
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

    // „Gata de livrare": depozitul a pregătit marfa (luată de pe raft,
    // ambalată, etichetată). De aici comanda apare în Logistică ca gata de
    // dus. Butonul e doar pe „în stoc depozit" — înainte n-ai ce pregăti.
    const butonGata =
      poateDepozit(ctx.user) && c.status === "in_stoc_depozit"
        ? `<form method="post" action="/depozit/comanda/${id}/gata-livrare" class="inline-form">
             <button class="btn" type="submit" title="Marfa e pregătită și poate pleca: comanda apare în Logistică, la „Gata de livrat”.">Gata de livrare</button>
           </form>`
        : "";
    const actiuni = poateDepozit(ctx.user)
      ? `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
           ${butonGata}
           <form method="post" action="/depozit/comanda/${id}/confirma" class="inline-form">
             <button class="btn" type="submit" title="${esc(
               statusDupa === "in_stoc_depozit"
                 ? acoperiteTot
                   ? "Marfa e pe stoc: comanda pleacă spre livrare."
                   : "Clientul acceptă parțial: pleacă ce e pe stoc, restul rămâne pe comandă."
                 : "Nu pleacă marfă acum. Comanda rămâne aici și așteaptă aprovizionarea sau producția."
             )}">
               ${
                 statusDupa === "in_stoc_depozit"
                   ? acoperiteTot
                     ? "Aprobă — pleacă spre livrare"
                     : "Aprobă parțial — pleacă ce e pe stoc"
                   : "Confirmă verificarea — așteaptă marfă"
               }
             </button>
           </form>
           <form method="post" action="/depozit/comanda/${id}/rezerva" class="inline-form">
             <button class="btn secondary" type="submit">Rezervă stocul ${REZERVARE_ORE} h</button>
           </form>
           <form method="post" action="/depozit/comanda/${id}/elibereaza" class="inline-form">
             <button class="btn secondary" type="submit">Eliberează rezervarea</button>
           </form>
           <a class="btn secondary" href="/comenzi/${id}">Vezi comanda în CRM</a>
           ${
             aprov.some((a) => a.status === "refuzata")
               ? `<form method="post" action="/depozit/comanda/${id}/anuleaza" class="inline-form"
                        onsubmit="return confirm('Anulezi comanda? Rămâne în listă, marcată ca anulată.')">
                    <button class="link-btn danger" type="submit">Anulează comanda (producția a refuzat termenul)</button>
                  </form>`
               : ""
           }
         </div>`
      : `<div class="toolbar"><a class="btn secondary" href="/comenzi/${id}">Vezi comanda în CRM</a></div>`;

    const body = `
      ${subnavDepozit("/depozit", ctx.user)}
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block;white-space:normal;max-width:720px;line-height:1.5">${esc(ctx.query.eroare)}</p>` : ""}
      ${ctx.query.ok ? `<p class="badge verde" style="display:inline-block;white-space:normal;max-width:720px;line-height:1.5">${esc(ctx.query.ok)}</p>` : ""}
      ${stari.bara(c)}
      <p style="color:var(--text-muted)">
        Status: ${stari.eticheta(c.status)} ·
        cerută pe ${esc(c.data_livrare_ceruta || "fără termen")} ·
        ${c.verificata_depozit_la ? "verificată de depozit la " + esc(String(c.verificata_depozit_la).slice(0, 16)) : "neverificată încă"}
        ${c.gata_livrare_la ? " · pregătită la " + esc(String(c.gata_livrare_la).slice(0, 16)) + (c.gata_livrare_de ? " de " + esc(c.gata_livrare_de) : "") : ""}
      </p>
      ${
        dePreluatAici.length
          ? `<div class="detail-box" style="max-width:820px;border-left:4px solid var(--warn,#c07018)">
               <strong>De preluat din producție:</strong>
               ${dePreluatAici
                 .map((x) =>
                   x.receptie_id
                     ? `<a href="/depozit/receptie/${x.receptie_id}">recepția ${esc(x.receptie_numar || "#" + x.receptie_id)}</a> (${esc(x.ce)})`
                     : `<a href="/depozit/aprovizionare">${esc(x.ce)}</a> — din De aprovizionat`
                 )
                 .join(" · ")}
               <div class="mic" style="color:var(--text-muted);margin-top:4px">Producția a terminat. Când o preiei, comanda trece singură „în stoc depozit”.</div>
             </div>`
          : ""
      }
      <div class="detail-box" style="max-width:820px;border-left:4px solid ${
        acceptaPartial ? "var(--verde,#1a7f42)" : "var(--rosu,#b3261e)"
      }">
        <div style="margin-bottom:6px"><strong>Branding:</strong> ${require("../lib/branding").eticheta(c)}</div>
        <strong>Livrare parțială:</strong> ${livrare.eticheta(c)}
        <div class="mic" style="color:var(--text-muted);margin-top:4px">
          ${
            acceptaPartial
              ? "Clientul a spus că primește ce e pe stoc acum, restul mai târziu. Ai voie să trimiți incomplet."
              : livrare.raspuns(c) === "nu"
                ? "Clientul vrea comanda întreagă. Nu trimite nimic până nu e acoperită tot — cere aprovizionare pentru ce lipsește."
                : "Nimeni n-a întrebat clientul. Până răspunde agentul, comanda se tratează ca „doar completă”."
          }
        </div>
      </div>
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
    send(ctx.res, 200, layout({ user: ctx.user, title: `Comanda ${c.numar || "#" + c.id} — ${c.partener_nume}`, active: "/depozit", body }));
  });

  // Confirmarea depozitului: operatorul s-a uitat la stoc și spune încotro
  // pleacă comanda.
  //
  // Până acum butonul scria „confirmata" orice-ar fi fost pe stoc, iar de
  // acolo nu se putea factura: cineva trebuia să mai mute o dată statusul, de
  // mână, pe „în stoc depozit". În practică nu-l muta nimeni, și comenzile cu
  // marfa pe raft stăteau zile întregi așteptând un clic de care nu știa
  // nimeni. Acum butonul duce comanda exact unde îi e locul:
  //
  //   tot pe stoc                   → în stoc depozit, pleacă spre livrare
  //   parțial, clientul acceptă     → în stoc depozit, pleacă cât e
  //   parțial sau nimic, fără accept→ așteaptă marfă, rămâne în lista asta
  //
  // Regula e în lib/livrare-partiala.js, ca să fie una singură și pentru
  // depozit, și pentru agent.
  router.post("/depozit/comanda/:id/confirma", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit");
    const id = parseInt(ctx.params.id, 10);
    const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(id);
    if (!c) return redirect(ctx.res, "/depozit");
    if (c.status === "anulata") return redirect(ctx.res, `/depozit/comanda/${id}`);

    const { acoperiteTot, acoperitePartial } = await potrivire(id);
    let status = livrare.statusDupaVerificare({ acoperiteTot, acoperitePartial, comanda: c });
    // Verificarea nu dă comanda înapoi pe drum (05.11.2026). Una pregătită,
    // plecată sau facturată rămâne unde e; una la care producția încă lucrează
    // sau a terminat, dar marfa n-a fost preluată, nu cade pe „așteaptă marfă"
    // — ar pierde exact informația că marfa vine din producție.
    if (["gata_livrare", "in_livrare", "facturata", "livrata", "livrata_partial"].includes(c.status)) status = c.status;
    else if (status === "asteapta_marfa" && ["in_productie", "productie_finalizata"].includes(c.status)) status = c.status;

    await db
      .prepare("UPDATE comenzi SET status = ?, verificata_depozit_la = ?, verificata_depozit_de = ? WHERE id = ?")
      .run(status, acum(), ctx.user.nume, id);

    // Ce s-a intamplat de fapt, scris o singura data si folosit in doua
    // locuri: in istoricul partenerului (ca sa afle agentul) si pe pagina
    // (ca sa afle omul care tocmai a apasat butonul). Pana acum exista doar
    // primul: apasai „Confirmă", pagina se reincarca, si daca rezultatul era
    // „asteapta marfa" parea ca n-a facut nimic.
    const spune =
      status !== "in_stoc_depozit" && status !== "asteapta_marfa"
        ? `Comanda rămâne „${stari.TEXTE[status] || String(status).replace(/_/g, " ")}”.`
        : status === "in_stoc_depozit"
        ? acoperiteTot
          ? "Toată marfa e pe stoc — comanda pleacă spre livrare."
          : "Marfa e doar parțial pe stoc, iar clientul acceptă livrare parțială — pleacă ce există."
        : acoperitePartial
          ? "Lipsește o parte din marfă, iar clientul vrea comanda completă — așteaptă aprovizionarea."
          : "Nimic nu e pe stoc — comanda așteaptă aprovizionarea sau producția.";

    // Agentul trebuie să afle fără să întrebe pe telefon. Scrierea în istoric
    // nu are voie să rupă confirmarea: marfa e verificată oricum.
    try {
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
        .run(c.partener_id, `Comanda ${c.numar || "#" + c.id}: verificată de depozit`, spune, ctx.user.id);
    } catch (e) {
      console.error("[depozit] nu am putut scrie confirmarea in istoric:", e.message);
    }

    redirect(
      ctx.res,
      `/depozit/comanda/${id}?ok=` +
        encodeURIComponent("Verificat de depozit. " + spune + " Agentul a fost anunțat în istoricul clientului.")
    );
  });

  // Depozitul a pregătit comanda: e gata de livrare (lib/stadiu-comanda.js).
  router.post("/depozit/comanda/:id/gata-livrare", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit");
    const id = parseInt(ctx.params.id, 10);
    const r = await STADIU.gataDeLivrare(id, { user: ctx.user });
    if (!r.ok) return redirect(ctx.res, `/depozit/comanda/${id}?eroare=` + encodeURIComponent(r.motiv || "Nu s-a putut."));
    redirect(
      ctx.res,
      `/depozit/comanda/${id}?ok=` +
        encodeURIComponent("Gata de livrare. Comanda apare în Logistică, la „Gata de livrat”, iar agentul a fost anunțat în istoricul clientului.")
    );
  });

  // Producția n-a putut ține termenul: comanda se anulează, dar rămâne în
  // listă, marcată — ca să se vadă de ce s-a pierdut, nu să dispară.
  router.post("/depozit/comanda/:id/anuleaza", async (ctx) => {
    if (!poateDepozit(ctx.user) && !(ctx.user && ctx.user.rol === "vanzari")) return redirect(ctx.res, "/depozit");
    const id = parseInt(ctx.params.id, 10);
    await db
      .prepare("UPDATE comenzi SET status = 'anulata', motiv_anulare = ? WHERE id = ?")
      .run("termen refuzat de producție", id);
    await db.prepare("UPDATE rezervari_stoc SET stare = 'eliberata' WHERE comanda_id = ? AND stare = 'activa'").run(id);
    await db.prepare("UPDATE aprovizionari SET status = 'anulata' WHERE comanda_id = ? AND status IN ('ceruta','refuzata')").run(id);
    const c = await db.prepare("SELECT partener_id, numar, id FROM comenzi WHERE id = ?").get(id);
    if (c && ctx.user) {
      await db
        .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, utilizator_id) VALUES (?, 'comanda', ?, ?, ?)")
        .run(c.partener_id, `Comanda ${c.numar || "#" + c.id} anulată`, "Producția n-a putut confirma termenul cerut.", ctx.user.id);
    }
    redirect(ctx.res, `/depozit/comanda/${id}`);
  });

  // Rezervare pe termen scurt. Nu mișcă stocul, doar îl scoate din „disponibil".
  router.post("/depozit/comanda/:id/rezerva", async (ctx) => {
    if (!poateDepozit(ctx.user) && !(ctx.user && ["admin", "vanzari", "financiar"].includes(ctx.user.rol))) {
      return redirect(ctx.res, "/depozit");
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
    redirect(ctx.res, ctx.body && ctx.body.inapoi === "crm" ? `/comenzi/${id}` : `/depozit/comanda/${id}`);
  });

  router.post("/depozit/comanda/:id/elibereaza", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    await db.prepare("UPDATE rezervari_stoc SET stare = 'eliberata' WHERE comanda_id = ? AND stare = 'activa'").run(id);
    redirect(ctx.res, ctx.body && ctx.body.inapoi === "crm" ? `/comenzi/${id}` : `/depozit/comanda/${id}`);
  });

  // Cererea de aprovizionare: fie la un terț, fie la producție. Dacă e la
  // producție, termenul cerut e cel pe care l-a promis agentul clientului.
  router.post("/depozit/comanda/:id/aprovizionare", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const linieId = parseInt(b.linie_id, 10) || null;
    const linie = linieId ? await db.prepare("SELECT * FROM comenzi_linii WHERE id = ?").get(linieId) : null;
    if (!linie) return redirect(ctx.res, `/depozit/comanda/${id}`);
    const c = await db.prepare("SELECT * FROM comenzi WHERE id = ?").get(id);
    const cantitate = Number(b.cantitate) || 0;
    if (cantitate <= 0) return redirect(ctx.res, `/depozit/comanda/${id}`);
    const sursa = b.sursa === "productie" ? "productie" : "tert";

    // Termenul cerut e obligatoriu. Pana acum se lua din comanda, iar daca
    // aceasta n-avea data de livrare completata, cererea pleca spre productie
    // sau spre furnizor FARA niciun termen. O cerere fara termen nu e o
    // cerere, e o speranta: nu poate intarzia, deci nu poate fi urmarita,
    // deci nimeni nu afla ca s-a uitat de ea. Se poate scrie si pe formular,
    // daca pe comanda inca nu e trecuta.
    const termen = T.validareTermenCerut(
      String(b.termen_cerut || "").trim() || (c && (c.data_livrare_promisa || c.data_livrare_ceruta)) || "",
      { azi: azi() }
    );
    if (termen.eroare) {
      return redirect(
        ctx.res,
        `/depozit/comanda/${id}?eroare=` +
          encodeURIComponent(
            termen.eroare + " Comanda n-are dată de livrare, deci scrie termenul aici sau completeaz-o pe comandă."
          )
      );
    }
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
        // Furnizorul se pastra DOAR cand sursa era „tert", iar formularul
        // lasa sa alegi „din productie" SI un furnizor — care se arunca in
        // tacere. Operatorul credea ca a comandat de la el.
        sursa === "tert" ? parseInt(b.furnizor_id, 10) || null : null,
        termen.termen,
        ctx.user ? ctx.user.nume : null,
        acum()
      );
    // Marfa comandată la un furnizor anume: linia clientului află de la cine
    // vine, dacă nu avea deja un furnizor (ales din stoc sau de producție).
    const furnizorTert = sursa === "tert" ? parseInt(b.furnizor_id, 10) || null : null;
    if (furnizorTert) {
      await db
        .prepare(
          `UPDATE comenzi_linii SET furnizor_id = ?, furnizor_text = NULL, furnizor_sursa = 'aprovizionare'
            WHERE id = ? AND furnizor_id IS NULL AND COALESCE(TRIM(furnizor_text), '') = ''`
        )
        .run(furnizorTert, linieId)
        .catch((e) => console.error("[depozit] furnizorul liniei:", e.message));
    }
    redirect(ctx.res, `/depozit/comanda/${id}`);
  });

  // --- aprovizionare: lista mare ------------------------------------------
  router.get("/depozit/aprovizionare", async (ctx) => {
    const aprov = await db
      .prepare(
        `SELECT a.*, p.denumire AS produs, p.unitate_masura, f.nume AS furnizor, c.numar AS comanda_numar,
                cl.nume AS client, c.data_livrare_promisa, c.data_livrare_ceruta
         FROM aprovizionari a
         JOIN produse p ON p.id = a.produs_id
         LEFT JOIN parteneri f ON f.id = a.furnizor_id
         LEFT JOIN comenzi c ON c.id = a.comanda_id
         LEFT JOIN parteneri cl ON cl.id = c.partener_id
         ORDER BY a.id DESC
         LIMIT 300`
      )
      .all();
    const materii = await db
      .prepare(
        `SELECT m.*, p.denumire AS produs FROM cereri_materie_prima m
         LEFT JOIN produse p ON p.id = m.produs_id
         ORDER BY m.id DESC
         LIMIT 200`
      )
      .all();
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY id").all();
    const optDep = depozite.map((d) => `<option value="${d.id}">${esc(d.denumire)}</option>`).join("");
    const receptiiDeschise = new Map(
      (
        await db
          .prepare("SELECT id, numar, aprovizionare_id FROM receptii WHERE aprovizionare_id IS NOT NULL AND stare IN ('asteptata', 'in_lucru')")
          .all()
          .catch(() => [])
      ).map((r) => [Number(r.aprovizionare_id), r])
    );

    const randuriA = aprov.map((a) => {
      // Pe fluxul catre FURNIZOR nu exista pana acum niciun pas de
      // confirmare: doar „intra in stoc" si „anuleaza". Adica termenul pe
      // care l-a promis furnizorul la telefon nu se scria nicaieri, iar
      // peste doua saptamani nimeni nu stia daca intarzie sau nu. Cererile
      // catre productie se confirma la ei, in Productie · Cereri din depozit.
      const confirmaTert =
        poateDepozit(ctx.user) && a.sursa === "tert" && a.status === "ceruta"
          ? `<form method="post" action="/depozit/aprovizionare/${a.id}/confirma" class="inline-form" style="gap:6px;flex-wrap:wrap">
               <input type="hidden" name="termen" value="${esc(a.termen_cerut || azi())}">
               <button class="btn small" type="submit">Furnizorul confirmă ${esc(a.termen_cerut || azi())}</button>
             </form>
             <details style="margin-top:6px">
               <summary style="cursor:pointer;color:var(--danger);font-size:12px">Dă alt termen</summary>
               <form method="post" action="/depozit/aprovizionare/${a.id}/confirma" style="margin-top:6px;display:grid;gap:5px;max-width:230px">
                 <input type="date" name="termen" required value="${esc(a.termen_cerut || azi())}">
                 <input name="motiv" required maxlength="200" placeholder="ce a zis furnizorul" style="font-size:12px">
                 <button class="btn small" type="submit">Salvează termenul lui</button>
               </form>
             </details>`
          : "";
      const rec = receptiiDeschise.get(Number(a.id));
      const actiuni = rec
        ? `<a class="btn small" href="/depozit/receptie/${rec.id}">Preia pe recepția ${esc(rec.numar || "#" + rec.id)}</a>`
        : poateDepozit(ctx.user) && ["ceruta", "confirmata", "gata"].includes(a.status)
          ? confirmaTert +
            `<form method="post" action="/depozit/aprovizionare/${a.id}/primita" class="inline-form" style="gap:6px;margin-top:6px">
               <button class="btn small ${a.status === "ceruta" && a.sursa === "tert" ? "secondary" : ""}" type="submit" title="Deschide Intrarea marfă în CT-Park, completată cu produsul și cantitatea">Intră în stoc →</button>
             </form>
             <form method="post" action="/depozit/aprovizionare/${a.id}/anuleaza" class="inline-form">
               <button class="link-btn danger" type="submit">Anulează</button>
             </form>`
          : "";
      // Doua verificari diferite. Prima: cat s-a mutat termenul fata de cat
      // s-a cerut. A doua, si aia care conteaza: daca termenul raspuns trece
      // de data promisa CLIENTULUI — caz in care cineva trebuie sa-l sune
      // azi, chiar daca intern totul arata confirmat.
      const cmp = T.compara(a.termen_cerut, a.termen_confirmat);
      const dataClient = a.data_livrare_promisa || a.data_livrare_ceruta || null;
      const fataClient = a.termen_confirmat ? T.fataDeClient(a.termen_confirmat, dataClient) : null;
      return [
        esc(a.produs),
        `${nr(a.cantitate)} ${esc(a.unitate_masura || "")}`,
        a.sursa === "productie" ? "producție" : "terț",
        esc(a.furnizor || "—"),
        a.comanda_id
          ? `<a href="/depozit/comanda/${a.comanda_id}">${esc(a.comanda_numar || "#" + a.comanda_id)}</a><br><span style="font-size:12px">${esc(a.client || "")}</span>` +
            (dataClient ? `<br><span style="font-size:11px;color:var(--text-muted)">promis clientului: ${esc(dataClient)}</span>` : "")
          : "pentru stoc",
        a.termen_cerut
          ? esc(a.termen_cerut)
          : '<span class="badge rosu">fără termen</span>',
        `${esc(a.termen_confirmat || "—")}` +
          (a.termen_confirmat && cmp.fel !== "confirmat"
            ? `<br><span class="badge ${cmp.culoare}" style="font-size:11px">${esc(cmp.eticheta)}</span>`
            : "") +
          (fataClient && fataClient.fel === "depaseste_clientul"
            ? `<br><span class="badge rosu" style="font-size:11px">${esc(fataClient.eticheta)}</span>`
            : "") +
          (a.raspuns && /motiv:/.test(String(a.raspuns))
            ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(String(a.raspuns).replace(/^.*motiv:\s*/, ""))}</span>`
            : ""),
        STATUS_APROV[a.status] || esc(a.status),
        actiuni,
      ];
    });

    const randuriM = materii.map((m) => {
      const actiuni =
        poateDepozit(ctx.user) && m.status === "ceruta"
          ? `<form method="post" action="/depozit/materie/${m.id}/valideaza" class="inline-form" style="gap:6px">
               <input type="date" name="termen" value="${esc(m.termen_cerut || azi())}">
               <button class="btn small" type="submit">Confirmă termen</button>
             </form>
             <form method="post" action="/depozit/materie/${m.id}/refuza" class="inline-form">
               <button class="link-btn danger" type="submit">Refuză</button>
             </form>`
          : poateDepozit(ctx.user) && m.status === "confirmata"
            ? `<form method="post" action="/depozit/materie/${m.id}/livrata" class="inline-form" style="gap:6px">
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

    const produse = await db.prepare("SELECT id, denumire FROM produse WHERE activ = 1 ORDER BY denumire LIMIT 3000").all();
    const furnizori = await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 2000").all();

    const body = `
      ${subnavDepozit("/depozit/aprovizionare", ctx.user)}
      <p style="max-width:760px;color:var(--text-muted)">
        Ce s-a cerut pentru comenzile care nu se acoperă din stoc. Cererile către producție apar și la ei, cu termenul
        cerut de agent — ei îl confirmă sau nu. Când marfa e gata sau a venit de la furnizor, apeși „Intră în stoc"
        și mișcarea de stoc se scrie singură.
      </p>
      ${
        poateDepozit(ctx.user)
          ? `<details style="margin:10px 0">
               <summary style="cursor:pointer">Comandă pentru stoc (fără o comandă de client în spate)</summary>
               <form method="post" action="/depozit/aprovizionare" class="form" style="max-width:820px;margin-top:10px">
                 <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
                   <label class="field"><span>Produs</span>
                     <select name="produs_id" required>${produse.map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`).join("")}</select>
                   </label>
                   <label class="field"><span>Cantitate</span><input type="number" step="0.001" name="cantitate" required></label>
                   <label class="field"><span>Termen dorit</span><input type="date" name="termen_cerut" required></label>
                 </div>
                 <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
                   <label class="field"><span>De unde</span>
                     <select name="sursa"><option value="tert">de la terț</option><option value="productie">din producție</option></select>
                   </label>
                   <label class="field"><span>Furnizor (dacă e terț)</span>
                     <select name="furnizor_id"><option value="">—</option>${furnizori.map((f) => `<option value="${f.id}">${esc(f.nume)}</option>`).join("")}</select>
                   </label>
                 </div>
                 <label class="field"><span>Observații</span><input name="observatii"></label>
                 <div class="form-actions"><button class="btn" type="submit">Cere aprovizionarea</button></div>
               </form>
             </details>`
          : ""
      }
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block;white-space:normal;max-width:720px;line-height:1.5">${esc(ctx.query.eroare)}</p>` : ""}
      ${ctx.query.ok ? `<p class="badge verde" style="display:inline-block;white-space:normal;max-width:720px;line-height:1.5">${esc(ctx.query.ok)}</p>` : ""}
      ${table(["Produs", "Cantitate", "Sursă", "Furnizor", "Pentru comanda", "Termen cerut", "Răspunsul furnizorului", "Status", ""], randuriA)}
      <h2 id="materii">Materie primă cerută de producție</h2>
      ${table(["Produs / descriere", "Cantitate", "Cerut de", "Termen cerut", "Termen dat", "Status", ""], randuriM)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "De aprovizionat", active: "/depozit", body }));
  });

  // Aprovizionare fără comandă de client: depozitul vede că stocul e mic la un
  // produs și comandă pentru stoc — la terț sau la producție.
  router.post("/depozit/aprovizionare", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
    const b = ctx.body || {};
    const produsId = parseInt(b.produs_id, 10) || null;
    const cantitate = Number(b.cantitate) || 0;
    if (!produsId || cantitate <= 0) return redirect(ctx.res, "/depozit/aprovizionare");
    // Si aici: fara termen, cererea nu se poate urmari.
    const termenStoc = T.validareTermenCerut(b.termen_cerut, { azi: azi() });
    if (termenStoc.eroare) {
      return redirect(ctx.res, "/depozit/aprovizionare?eroare=" + encodeURIComponent(termenStoc.eroare));
    }
    const sursa = b.sursa === "productie" ? "productie" : "tert";
    await db
      .prepare(
        `INSERT INTO aprovizionari (comanda_id, linie_id, produs_id, cantitate, sursa, furnizor_id, termen_cerut, status, cerut_de, creata_la, observatii)
         VALUES (NULL, NULL, ?, ?, ?, ?, ?, 'ceruta', ?, ?, ?)`
      )
      .run(
        produsId,
        cantitate,
        sursa,
        sursa === "tert" ? parseInt(b.furnizor_id, 10) || null : null,
        termenStoc.termen,
        ctx.user.nume,
        acum(),
        String(b.observatii || "").trim().slice(0, 500) || null
      );
    redirect(ctx.res, "/depozit/aprovizionare");
  });

  // Furnizorul a raspuns cu un termen. Pasul asta lipsea cu totul: fluxul
  // spre tert avea doar „intra in stoc" si „anuleaza", deci ce a promis
  // furnizorul la telefon nu se scria nicaieri si nimeni nu putea spune, peste
  // doua saptamani, daca intarzie sau nu. Cererile catre PRODUCTIE se confirma
  // la ei, in Productie · Cereri din depozit — aici e doar jumatatea cealalta.
  router.post("/depozit/aprovizionare/:id/confirma", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
    const id = parseInt(ctx.params.id, 10);
    const a = await db.prepare("SELECT * FROM aprovizionari WHERE id = ?").get(id);
    if (!a || a.status !== "ceruta") return redirect(ctx.res, "/depozit/aprovizionare");

    // Un termen mai tarziu decat cel cerut are nevoie de motiv. Nu ca sa dea
    // cineva socoteala, ci fiindca peste doua saptamani „de ce intarzie" e o
    // intrebare la care trebuie sa existe raspuns scris.
    const raspuns = T.validareRaspuns(ctx.body || {}, a.termen_cerut);
    if (raspuns.eroare) {
      return redirect(ctx.res, "/depozit/aprovizionare?eroare=" + encodeURIComponent(raspuns.eroare.slice(0, 200)));
    }
    await db
      .prepare("UPDATE aprovizionari SET status = 'confirmata', termen_confirmat = ?, raspuns = ? WHERE id = ?")
      .run(
        raspuns.termen,
        raspuns.motiv
          ? `${raspuns.comparatie.eticheta} de furnizor, scris de ${ctx.user.nume} — motiv: ${raspuns.motiv}`
          : `termen confirmat de furnizor, scris de ${ctx.user.nume}`,
        id
      );
    redirect(
      ctx.res,
      "/depozit/aprovizionare?ok=" +
        encodeURIComponent(
          "Termen scris: " + raspuns.termen +
            (raspuns.comparatie.fel === "amanat"
              ? " — " + raspuns.comparatie.eticheta + " față de ce s-a cerut."
              : raspuns.comparatie.fel === "devansat"
                ? " — " + raspuns.comparatie.eticheta + " decât s-a cerut."
                : " — exact cât s-a cerut.")
        )
    );
  });

  // Marfa a intrat: scriem intrarea de stoc și, dacă e cazul, deblocăm comanda.
  router.post("/depozit/aprovizionare/:id/primita", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
    const id = parseInt(ctx.params.id, 10);
    const a = await db.prepare("SELECT * FROM aprovizionari WHERE id = ?").get(id);
    if (!a) return redirect(ctx.res, "/depozit/aprovizionare");
    // Marfa cu recepție deschisă (din producție, de la 05.11.2026, se deschide
    // singură) intră pe recepție, nu de aici: altfel intră de două ori pe stoc,
    // pe două documente, și nimeni nu mai știe care e bun.
    const deschisa = await db
      .prepare("SELECT id, numar FROM receptii WHERE aprovizionare_id = ? AND stare IN ('asteptata', 'in_lucru') ORDER BY id LIMIT 1")
      .get(id)
      .catch(() => null);
    if (deschisa) {
      return redirect(
        ctx.res,
        "/depozit/aprovizionare?eroare=" +
          encodeURIComponent(`Marfa asta are deja recepția ${deschisa.numar || "#" + deschisa.id} deschisă. Preia-o de acolo, altfel intră de două ori pe stoc.`)
      );
    }
    // „Intră în stoc" = marfa primește loc în CT-Park, singurul depozit. Până pe
    // 09.11.2026 butonul scria doar în tabela veche (miscari_stoc), iar marfa
    // rămânea „intrată în stoc" fără palet și fără raft. Vali: „astea intrate
    // în stoc e stoc CT-Park și ar trebui alocate pe rafturi". Acum butonul
    // deschide Intrarea marfă completată; cererea devine „intrată în stoc" și
    // comanda clientului merge mai departe când paletul chiar există
    // (lib/gata-productie.js, dupaPunere).
    return redirect(ctx.res, `/stocuri/ct-park/intrare?aprovizionare=${id}`);
  });

  router.post("/depozit/aprovizionare/:id/anuleaza", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
    await db.prepare("UPDATE aprovizionari SET status = 'anulata' WHERE id = ?").run(parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/depozit/aprovizionare");
  });

  // --- materie primă cerută de producție ----------------------------------
  router.post("/depozit/materie/:id/valideaza", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
    const termen = String((ctx.body || {}).termen || "").slice(0, 10) || null;
    await db
      .prepare("UPDATE cereri_materie_prima SET status = 'confirmata', termen_confirmat = ? WHERE id = ?")
      .run(termen, parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/depozit/aprovizionare#materii");
  });

  router.post("/depozit/materie/:id/refuza", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
    await db
      .prepare("UPDATE cereri_materie_prima SET status = 'refuzata', raspuns = ? WHERE id = ?")
      .run("refuzat de depozit", parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/depozit/aprovizionare#materii");
  });

  router.post("/depozit/materie/:id/livrata", async (ctx) => {
    if (!poateDepozit(ctx.user)) return redirect(ctx.res, "/depozit/aprovizionare");
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
    redirect(ctx.res, "/depozit/aprovizionare#materii");
  });
}

// Curățenia rezervărilor expirate, o dată la un sfert de oră.
function porneste() {
  const tic = async () => {
    try {
      const n = await elibereazaExpirate();
      if (n) console.log(`[depozit] ${n} rezervări expirate, stoc eliberat`);
    } catch (e) {
      console.error("[depozit] eliberare rezervări:", e.message);
    }
  };
  tic();
  const t = setInterval(tic, 15 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { register, porneste, potrivire, stocPeProduse, elibereazaExpirate, marfaDePreluat, REZERVARE_ORE };
