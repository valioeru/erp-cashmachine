"use strict";
// Marketing — oamenii din spatele firmelor, și ce le trimitem.
//
// DE CE, în cuvintele lui Vali: „în contacte avem toate contactele de clienți
// și furnizori categorisiți astfel, cu firma de la care fac parte … la fiecare
// persoană avem și câmp opțional cu data nașterii … de ziua lui în dashboard
// apare în fiecare zi contactele născute azi".
//
// Trei idei stau la baza modulului:
//
// 1. CONTACTUL E PERSOANA, partenerul e firma. Partenerul are un singur email,
//    al firmei. Dar la un client vorbești cu trei oameni, fiecare cu adresa
//    lui, iar de ziua unuia nu-i scrii pe adresa de facturare.
//
// 2. ACTIV SAU POTENȚIAL se deduce, nu se bifează. Dacă firma a cumpărat, i-am
//    ofertat sau ne-a ofertat vreodată, oamenii ei sunt activi. Altfel,
//    potențiali. O bifă pusă de mână s-ar învechi în trei luni.
//
// 3. NIMIC NU SE PIERDE. Oricine poate modifica un contact, dar fiecare
//    schimbare se scrie în istoric cu cine și când. Ștergerea e doar a
//    administratorului. La trimitere se folosește valoarea curentă, adică cea
//    mai nouă.
const db = require("../lib/db");
const mail = require("../lib/mail");
const { esc, layout, table, actionLinks } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const nr = (v) => Number(v || 0);
const LUNI = ["ianuarie","februarie","martie","aprilie","mai","iunie","iulie","august","septembrie","octombrie","noiembrie","decembrie"];
const azi = () => new Date().toISOString().slice(0, 10);
const acum = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Ziua și luna din data nașterii, ca „03-14". Data poate veni și fără an
// („--03-14"): de multe ori știi ziua, nu și anul, iar asta n-ar trebui să te
// împiedice s-o scrii.
const ziLuna = (d) => String(d || "").slice(-5);

function varsta(d) {
  const s = String(d || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const a = new Date().getUTCFullYear() - Number(s.slice(0, 4));
  return a > 0 && a < 120 ? a : null;
}

// Firma a făcut vreodată ceva cu noi? Facturi în orice direcție, oferte
// trimise ei, sau oferte primite de la ea în Procurement.
const SUB_ACTIVI = `(
  SELECT DISTINCT x.partener_id FROM (
    SELECT partener_id FROM facturi WHERE activ = 1 AND status NOT IN ('anulata','ciorna') AND partener_id IS NOT NULL
    UNION ALL
    SELECT partener_id FROM oferte WHERE partener_id IS NOT NULL
    UNION ALL
    SELECT furnizor_id AS partener_id FROM ach_oferte WHERE activ = 1 AND furnizor_id IS NOT NULL
  ) x
)`;

const SELECT_CONTACT = `
  SELECT c.*, p.nume AS partener_nume, p.tip AS partener_tip,
         COALESCE(p.nume, c.firma_text, '—') AS firma,
         CASE WHEN c.partener_id IN ${SUB_ACTIVI} THEN 1 ELSE 0 END AS firma_activa,
         u.nume AS adaugat_de
    FROM mk_contacte c
    LEFT JOIN parteneri p ON p.id = c.partener_id
    LEFT JOIN utilizatori u ON u.id = c.creat_de`;

const eAdmin = (u) => Boolean(u && u.rol === "admin");

function badgeStare(c) {
  return nr(c.firma_activa)
    ? '<span class="badge verde">activ</span>'
    : '<span class="badge gri">potențial</span>';
}

function badgeTip(c) {
  const t = String(c.partener_tip || "").toLowerCase();
  if (t === "furnizor") return '<span class="badge galben">furnizor</span>';
  if (t === "ambele") return '<span class="badge galben">client & furnizor</span>';
  if (t) return '<span class="badge albastru">client</span>';
  return '<span class="badge gri">fără firmă în ERP</span>';
}

// Mesajul standard de la mulți ani. Se poate schimba înainte de trimitere —
// e un punct de plecare, nu un șablon bătut în cuie.
function mesajAniversare(contact, semnatura) {
  const prenume = String(contact.nume || "").trim().split(/\s+/)[0] || "";
  return (
    `Bună ziua${prenume ? ", " + prenume : ""},\n\n` +
    `La mulți ani! Vă dorim un an bun, cu sănătate și cu proiectele care vă bucură duse până la capăt.\n\n` +
    `Ne face plăcere să lucrăm împreună și vă mulțumim pentru încredere.\n\n` +
    `Cu drag,\n${semnatura}`
  );
}

function subiectAniversare(contact) {
  const prenume = String(contact.nume || "").trim().split(/\s+/)[0] || "";
  return prenume ? `La mulți ani, ${prenume}!` : "La mulți ani!";
}

// ---- cine are ziua azi ------------------------------------------------------
// Exportat: dashboardul îl folosește ca să arate cardul de aniversări.
async function aniversariAzi() {
  const zl = ziLuna(azi());
  try {
    return await db
      .prepare(
        `${SELECT_CONTACT}
          WHERE c.activ = 1 AND c.data_nastere IS NOT NULL AND c.data_nastere <> ''
            AND RIGHT(c.data_nastere, 5) = ?
          ORDER BY COALESCE(p.nume, c.firma_text), c.nume`
      )
      .all(zl);
  } catch (e) {
    // Tabelele pot lipsi până rulează migrarea — dashboardul nu trebuie să cadă.
    return [];
  }
}

async function trimiseAzi() {
  try {
    const r = await db.prepare("SELECT contact_id FROM mk_aniversari WHERE ziua = ? AND stare = 'trimis'").all(azi());
    return new Set(r.map((x) => Number(x.contact_id)));
  } catch (e) {
    return new Set();
  }
}

// ---- trimiterea propriu-zisă ------------------------------------------------
async function trimiteFelicitare({ contact, expeditor, subiect, mesaj, utilizatorId, automat }) {
  const config = mail.configUtilizator(expeditor);
  let stare = "trimis";
  let eroare = null;
  try {
    if (!config) throw new Error("Contul de email al expeditorului nu e configurat.");
    if (!contact.email) throw new Error("Contactul n-are adresă de email.");
    await mail.trimite(config, { catre: [contact.email], subiect, corp: mesaj });
  } catch (e) {
    stare = "esuat";
    eroare = String(e.message || e).slice(0, 400);
  }
  await db
    .prepare(
      `INSERT INTO mk_aniversari (contact_id, ziua, email, de_la, subiect, mesaj, trimis_la, trimis_de, automat, stare, eroare)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contact.id,
      azi(),
      contact.email || null,
      (expeditor && expeditor.email_expeditor) || null,
      subiect,
      mesaj,
      acum(),
      utilizatorId || null,
      automat ? 1 : 0,
      stare,
      eroare
    );
  return { stare, eroare };
}

// ---- plecarea automată de la ora 13 ----------------------------------------
// Regula lui Vali: „dacă până la ora 13.00 a zilei în curs nu trimite nimeni
// mesaj, pleacă unul automat de la mine ca managing partner".
//
// Două paze, pentru că un email greșit trimis unui client e mai rău decât unul
// netrimis:
//   - pleacă doar către contactele cu data nașterii PUSĂ DE UN OM. Datele
//     culese automat din facturi și leaduri sunt uneori strâmbe, iar o
//     felicitare pe ziua greșită e jenantă. Se confirmă cu un clic, o dată.
//   - nu pleacă de două ori în aceeași zi către același om: se verifică în
//     mk_aniversari, care păstrează și trimiterile de mână.
async function verificaAniversariAutomat(ora) {
  const h = typeof ora === "number" ? ora : new Date().getHours();
  if (h < 13) return { rulat: false, motiv: "încă nu e ora 13" };

  let admin;
  try {
    admin = await db
      .prepare("SELECT * FROM utilizatori WHERE rol = 'admin' AND activ = 1 AND smtp_host IS NOT NULL AND email_expeditor IS NOT NULL ORDER BY id LIMIT 1")
      .get();
  } catch (e) {
    return { rulat: false, motiv: "nu pot citi utilizatorii" };
  }
  if (!admin) return { rulat: false, motiv: "administratorul n-are cont de email configurat" };

  const toti = await aniversariAzi();
  const deja = await trimiseAzi();
  const semnatura = `${admin.nume}\nManaging Partner`;
  let trimise = 0;
  const sarite = [];
  for (const c of toti) {
    if (deja.has(Number(c.id))) continue;
    if (!nr(c.nastere_confirmata)) { sarite.push(c.nume + " (dată neconfirmată)"); continue; }
    if (!c.email) { sarite.push(c.nume + " (fără email)"); continue; }
    const r = await trimiteFelicitare({
      contact: c,
      expeditor: admin,
      subiect: subiectAniversare(c),
      mesaj: mesajAniversare(c, semnatura),
      utilizatorId: admin.id,
      automat: true,
    });
    if (r.stare === "trimis") trimise++;
  }
  return { rulat: true, trimise, sarite };
}

// Verificarea rulează o dată pe oră, dar face ceva doar o dată pe zi: după 13,
// pentru ce n-a plecat încă. Pornită din server.js, ca sincronizarea.
let ultimaZiRulata = null;
function porneste() {
  const bate = async () => {
    try {
      const zi = azi();
      const h = new Date().getHours();
      if (h < 13 || ultimaZiRulata === zi) return;
      ultimaZiRulata = zi;
      const r = await verificaAniversariAutomat(h);
      if (r.rulat && r.trimise) console.log(`[aniversari] trimise automat: ${r.trimise}`);
    } catch (e) {
      console.error("[aniversari] eroare:", e.message);
    }
  };
  setTimeout(bate, 60 * 1000);
  setInterval(bate, 30 * 60 * 1000).unref();
}

// ---- adunarea contactelor din restul ERP-ului ------------------------------
// Sursele reale de oameni din bază: persoana de contact scrisă pe partener și
// leadurile. Facturile n-au persoană, au firmă — de-aia firma apare ca activă,
// dar omul vine de unde chiar există.
async function adunaContacte(utilizatorId) {
  // Un om se recunoaste dupa nume SI firma, nu dupa email: acelasi Ion Popescu
  // poate aparea o data cu adresa firmei si o data cu a lui, iar daca ne-am
  // lua dupa email l-am adauga de doua ori la fiecare rulare.
  const norm = (x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
  const cheie = (partenerId, firma, nume) => `${partenerId || norm(firma)}|${norm(nume)}`;
  const existente = new Set(
    (await db.prepare("SELECT partener_id, COALESCE(firma_text,'') AS firma_text, nume FROM mk_contacte").all()).map((x) =>
      cheie(x.partener_id ? Number(x.partener_id) : null, x.firma_text, x.nume)
    )
  );
  let adaugati = 0;

  const dinParteneri = await db
    .prepare(
      `SELECT id, nume AS firma, persoana_contact, email, telefon, data_nastere, tip
         FROM parteneri
        WHERE COALESCE(persoana_contact,'') <> '' OR COALESCE(email,'') <> ''`
    )
    .all();
  for (const p of dinParteneri) {
    const nume = String(p.persoana_contact || "").trim();
    if (!nume) continue;
    if (existente.has(cheie(p.id, null, nume))) continue;
    existente.add(cheie(p.id, null, nume));
    await db
      .prepare(
        `INSERT INTO mk_contacte (partener_id, nume, email, telefon, data_nastere, sursa, creat_de)
         VALUES (?, ?, ?, ?, ?, 'parteneri', ?)`
      )
      .run(p.id, nume, String(p.email || "").trim() || null, String(p.telefon || "").trim() || null, String(p.data_nastere || "").slice(0, 10) || null, utilizatorId || null);
    adaugati++;
  }

  const dinLeaduri = await db
    .prepare("SELECT id, nume, companie, email, telefon, partener_id FROM leaduri WHERE COALESCE(nume,'') <> ''")
    .all();
  for (const l of dinLeaduri) {
    const nume = String(l.nume || "").trim();
    if (!nume) continue;
    const k = cheie(l.partener_id ? Number(l.partener_id) : null, l.companie, nume);
    if (existente.has(k)) continue;
    existente.add(k);
    await db
      .prepare(
        `INSERT INTO mk_contacte (partener_id, firma_text, nume, email, telefon, sursa, creat_de)
         VALUES (?, ?, ?, ?, ?, 'leaduri', ?)`
      )
      .run(
        l.partener_id || null,
        l.partener_id ? null : String(l.companie || "").trim() || null,
        nume,
        String(l.email || "").trim() || null,
        String(l.telefon || "").trim() || null,
        utilizatorId || null
      );
    adaugati++;
  }
  return adaugati;
}

// ---- scrierea în istoric ----------------------------------------------------
const CAMPURI = [
  ["nume", "Nume"],
  ["functie", "Funcție"],
  ["email", "Email"],
  ["telefon", "Telefon"],
  ["data_nastere", "Data nașterii"],
  ["firma_text", "Firma (text)"],
  ["observatii", "Observații"],
];

async function scrieIstoric(contactId, vechi, nou, utilizatorId) {
  for (const [camp] of CAMPURI) {
    const a = String(vechi[camp] ?? "");
    const b = String(nou[camp] ?? "");
    if (a === b) continue;
    await db
      .prepare(
        "INSERT INTO mk_contacte_istoric (contact_id, camp, valoare_veche, valoare_noua, schimbat_de, schimbat_la) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(contactId, camp, a || null, b || null, utilizatorId || null, acum());
  }
}

function register(router) {
  // ---- lista de contacte --------------------------------------------------
  router.get("/marketing/contacte", async (ctx) => {
    const cauta = String(ctx.query.q || "").trim();
    const tip = ["client", "furnizor", "fara"].includes(ctx.query.tip) ? ctx.query.tip : "";
    const stare = ["activ", "potential"].includes(ctx.query.stare) ? ctx.query.stare : "";
    const doarZile = String(ctx.query.zile || "") === "1";
    const cuEmail = ["cu", "fara"].includes(ctx.query.email) ? ctx.query.email : "";
    const luna = /^(0?[1-9]|1[0-2])$/.test(String(ctx.query.luna || "")) ? String(ctx.query.luna).padStart(2, "0") : "";
    const sursa = ["manual", "parteneri", "leaduri"].includes(ctx.query.sursa) ? ctx.query.sursa : "";
    const sortare = ["firma", "nume", "ziua"].includes(ctx.query.sort) ? ctx.query.sort : "firma";
    const vedere = ctx.query.vedere === "lista" ? "lista" : "firme";

    const unde = ["c.activ = 1"];
    const args = [];
    if (cauta) {
      unde.push("(c.nume ILIKE ? OR c.email ILIKE ? OR COALESCE(p.nume, c.firma_text, '') ILIKE ? OR c.functie ILIKE ?)");
      args.push(`%${cauta}%`, `%${cauta}%`, `%${cauta}%`, `%${cauta}%`);
    }
    if (tip === "client") unde.push("LOWER(COALESCE(p.tip,'')) IN ('client','ambele')");
    if (tip === "furnizor") unde.push("LOWER(COALESCE(p.tip,'')) IN ('furnizor','ambele')");
    if (tip === "fara") unde.push("c.partener_id IS NULL");
    if (stare === "activ") unde.push(`c.partener_id IN ${SUB_ACTIVI}`);
    if (stare === "potential") unde.push(`(c.partener_id IS NULL OR c.partener_id NOT IN ${SUB_ACTIVI})`);
    if (doarZile) unde.push("COALESCE(c.data_nastere,'') <> ''");
    if (cuEmail === "cu") unde.push("COALESCE(c.email,'') <> ''");
    if (cuEmail === "fara") unde.push("COALESCE(c.email,'') = ''");
    // Luna aniversării: data poate fi „1978-03-14" sau „--03-14", deci se taie
    // ultimele cinci caractere și se compară luna din ele.
    if (luna) {
      unde.push("COALESCE(c.data_nastere,'') <> '' AND SUBSTRING(RIGHT(c.data_nastere, 5), 1, 2) = ?");
      args.push(luna);
    }
    if (sursa) {
      unde.push("c.sursa = ?");
      args.push(sursa);
    }

    const ordine =
      sortare === "nume"
        ? "c.nume"
        : sortare === "ziua"
        ? "(CASE WHEN COALESCE(c.data_nastere,'') = '' THEN 1 ELSE 0 END), RIGHT(c.data_nastere, 5), c.nume"
        : "COALESCE(p.nume, c.firma_text, 'zzz'), c.nume";
    const contacte = await db
      .prepare(`${SELECT_CONTACT} WHERE ${unde.join(" AND ")} ORDER BY ${ordine}`)
      .all(...args);

    // Gruparea pe firme: cererea a fost „cu firma de la care fac parte".
    const peFirma = new Map();
    for (const c of contacte) {
      const k = c.firma || "—";
      if (!peFirma.has(k)) peFirma.set(k, []);
      peFirma.get(k).push(c);
    }

    const parteneri = await db.prepare("SELECT id, nume, tip FROM parteneri ORDER BY nume LIMIT 5000").all();
    const nrActivi = contacte.filter((c) => nr(c.firma_activa)).length;
    const nrCuZi = contacte.filter((c) => c.data_nastere).length;

    const blocuri = [...peFirma.entries()]
      .map(([firma, lista]) => {
        const primul = lista[0];
        return `
        <h2 style="margin-top:22px;font-size:17px">${esc(firma)} ${badgeTip(primul)} ${badgeStare(primul)}
          <span style="font-weight:400;font-size:13px;color:var(--text-muted)">· ${lista.length} ${lista.length === 1 ? "persoană" : "persoane"}</span>
        </h2>
        ${table(
          ["Nume", "Funcție", "Email", "Telefon", "Ziua de naștere", ""],
          lista.map((c) => [
            `<a href="/marketing/contact/${c.id}">${esc(c.nume)}</a>`,
            esc(c.functie || ""),
            c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "",
            esc(c.telefon || ""),
            c.data_nastere
              ? `${esc(String(c.data_nastere).replace(/^--/, ""))}${nr(c.nastere_confirmata) ? "" : ' <span class="badge galben" title="culeasă din import, trebuie confirmată">de confirmat</span>'}`
              : "",
            `<a class="link-btn" href="/marketing/contact/${c.id}">Deschide</a>`,
          ])
        )}`;
      })
      .join("");

    const body = `
      <div class="cards">
        <div class="card"><div class="label">Contacte</div><div class="value">${contacte.length}</div></div>
        <div class="card"><div class="label">La firme active</div><div class="value" style="color:var(--success)">${nrActivi}</div></div>
        <div class="card"><div class="label">Cu ziua de naștere</div><div class="value">${nrCuZi}</div></div>
        <div class="card"><div class="label">Firme</div><div class="value">${peFirma.size}</div></div>
      </div>

      <form class="filtre" method="get" action="/marketing/contacte">
        <input type="search" name="q" value="${esc(cauta)}" placeholder="caută om, firmă sau adresă" style="min-width:240px">
        <select name="tip" onchange="this.form.submit()">
          <option value="">clienți și furnizori</option>
          <option value="client"${tip === "client" ? " selected" : ""}>doar clienți</option>
          <option value="furnizor"${tip === "furnizor" ? " selected" : ""}>doar furnizori</option>
          <option value="fara"${tip === "fara" ? " selected" : ""}>fără firmă în ERP</option>
        </select>
        <select name="stare" onchange="this.form.submit()">
          <option value="">activi și potențiali</option>
          <option value="activ"${stare === "activ" ? " selected" : ""}>doar activi</option>
          <option value="potential"${stare === "potential" ? " selected" : ""}>doar potențiali</option>
        </select>
        <select name="email" onchange="this.form.submit()">
          <option value="">cu și fără email</option>
          <option value="cu"${cuEmail === "cu" ? " selected" : ""}>doar cu email</option>
          <option value="fara"${cuEmail === "fara" ? " selected" : ""}>doar fără email</option>
        </select>
        <select name="luna" onchange="this.form.submit()">
          <option value="">orice lună de naștere</option>
          ${LUNI.map((l, i) => `<option value="${String(i + 1).padStart(2, "0")}"${luna === String(i + 1).padStart(2, "0") ? " selected" : ""}>născuți în ${l}</option>`).join("")}
        </select>
        <select name="sursa" onchange="this.form.submit()">
          <option value="">din orice sursă</option>
          <option value="manual"${sursa === "manual" ? " selected" : ""}>adăugați de mână</option>
          <option value="parteneri"${sursa === "parteneri" ? " selected" : ""}>din parteneri</option>
          <option value="leaduri"${sursa === "leaduri" ? " selected" : ""}>din leaduri</option>
        </select>
        <select name="sort" onchange="this.form.submit()">
          <option value="firma"${sortare === "firma" ? " selected" : ""}>ordonat pe firme</option>
          <option value="nume"${sortare === "nume" ? " selected" : ""}>ordonat după nume</option>
          <option value="ziua"${sortare === "ziua" ? " selected" : ""}>ordonat după ziua de naștere</option>
        </select>
        <select name="vedere" onchange="this.form.submit()">
          <option value="firme"${vedere === "firme" ? " selected" : ""}>grupat pe firme</option>
          <option value="lista"${vedere === "lista" ? " selected" : ""}>listă (sortabilă din antet)</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="checkbox" name="zile" value="1"${doarZile ? " checked" : ""} onchange="this.form.submit()"> doar cu zi de naștere
        </label>
        <button class="btn small" type="submit">Caută</button>
      </form>

      <details style="margin:14px 0">
        <summary style="cursor:pointer;font-weight:600">+ Contact nou</summary>
        <form class="form" method="post" action="/marketing/contacte" style="max-width:820px;margin-top:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="field"><span>Nume și prenume</span><input name="nume" required></label>
            <label class="field"><span>Funcția</span><input name="functie" placeholder="ex. director achiziții"></label>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
            <label class="field"><span>Firma din ERP</span>
              <select name="partener_id">
                <option value="">— nu e în ERP, o scriu mai jos —</option>
                ${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}
              </select>
            </label>
            <label class="field"><span>…sau numele firmei</span><input name="firma_text"></label>
          </div>
          <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:12px">
            <label class="field"><span>Email</span><input type="email" name="email"></label>
            <label class="field"><span>Telefon</span><input name="telefon"></label>
            <label class="field"><span>Ziua de naștere (opțional)</span><input type="date" name="data_nastere"></label>
          </div>
          <label class="field"><span>Observații</span><input name="observatii"></label>
          <div class="form-actions"><button class="btn" type="submit">Adaugă contactul</button></div>
        </form>
      </details>

      ${
        eAdmin(ctx.user)
          ? `<form method="post" action="/marketing/contacte/aduna" class="filtre" style="margin-bottom:8px">
               <button class="btn secondary small" type="submit">Adună contactele din ERP</button>
               <span style="font-size:12px;color:var(--text-muted)">Ia persoanele de contact de pe parteneri și din leaduri. Nu adaugă de două ori același om.</span>
             </form>`
          : ""
      }

      ${
        contacte.length === 0
          ? "<p>Niciun contact în filtrul ales.</p>"
          : vedere === "lista"
          ? table(
              ["Nume", "Firma", "Fel", "Stare", "Funcție", "Email", "Telefon", "Ziua"],
              contacte.map((c) => [
                `<a href="/marketing/contact/${c.id}">${esc(c.nume)}</a>`,
                esc(c.firma),
                badgeTip(c),
                badgeStare(c),
                esc(c.functie || ""),
                c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "",
                esc(c.telefon || ""),
                c.data_nastere ? esc(String(c.data_nastere).replace(/^--/, "")) : "",
              ])
            )
          : blocuri
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Contacte", active: "/marketing/contacte", body }));
  });

  router.post("/marketing/contacte", async (ctx) => {
    const b = ctx.body || {};
    const nume = String(b.nume || "").trim();
    if (!nume) return redirect(ctx.res, "/marketing/contacte?eroare=nume");
    const dataN = String(b.data_nastere || "").slice(0, 10) || null;
    const r = await db
      .prepare(
        `INSERT INTO mk_contacte (partener_id, firma_text, nume, functie, email, telefon, data_nastere, nastere_confirmata, sursa, observatii, creat_de)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?) RETURNING id`
      )
      .run(
        parseInt(b.partener_id, 10) || null,
        String(b.firma_text || "").trim() || null,
        nume,
        String(b.functie || "").trim() || null,
        String(b.email || "").trim() || null,
        String(b.telefon || "").trim() || null,
        dataN,
        dataN ? 1 : 0,
        String(b.observatii || "").trim() || null,
        ctx.user ? ctx.user.id : null
      );
    redirect(ctx.res, `/marketing/contact/${r.lastInsertRowid}`);
  });

  router.post("/marketing/contacte/aduna", async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, "/marketing/contacte");
    const n = await adunaContacte(ctx.user ? ctx.user.id : null);
    redirect(ctx.res, `/marketing/contacte?adaugati=${n}`);
  });

  // ---- un contact ---------------------------------------------------------
  router.get("/marketing/contact/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await db.prepare(`${SELECT_CONTACT} WHERE c.id = ?`).get(id);
    if (!c) return redirect(ctx.res, "/marketing/contacte");

    const istoric = await db
      .prepare(
        `SELECT i.*, u.nume AS autor FROM mk_contacte_istoric i
           LEFT JOIN utilizatori u ON u.id = i.schimbat_de
          WHERE i.contact_id = ? ORDER BY i.id DESC`
      )
      .all(id);
    const trimiteri = await db
      .prepare(
        `SELECT a.*, u.nume AS autor FROM mk_aniversari a
           LEFT JOIN utilizatori u ON u.id = a.trimis_de
          WHERE a.contact_id = ? ORDER BY a.id DESC LIMIT 20`
      )
      .all(id);
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 5000").all();
    const etichete = Object.fromEntries(CAMPURI);
    const ani = varsta(c.data_nastere);

    const body = `
      <div class="toolbar">
        <a href="/marketing/contacte" class="btn secondary">← Toate contactele</a>
        ${c.email ? `<a href="mailto:${esc(c.email)}" class="btn secondary">Scrie-i</a>` : ""}
        ${
          eAdmin(ctx.user)
            ? actionLinks([{ href: `/marketing/contact/${c.id}/sterge`, label: "Șterge contactul", method: "post", danger: true, confirm: "Ștergi contactul? Istoricul lui rămâne." }])
            : ""
        }
      </div>

      <p style="margin-top:0;color:var(--text-muted)">
        ${esc(c.firma)} ${badgeTip(c)} ${badgeStare(c)}
        ${c.functie ? " · " + esc(c.functie) : ""}
        ${c.adaugat_de ? ` · adăugat de ${esc(c.adaugat_de)}` : ""} ${c.sursa ? `· sursa: ${esc(c.sursa)}` : ""}
      </p>

      ${
        c.data_nastere && !nr(c.nastere_confirmata)
          ? `<div class="detail-box" style="border-left:4px solid var(--warn,#c07018);max-width:820px">
               Ziua de naștere (${esc(String(c.data_nastere).replace(/^--/, ""))}) a fost culeasă din import, nu pusă de un om.
               Până n-o confirmi, contactul apare pe dashboard, dar felicitarea automată de la ora 13 nu pleacă spre el.
               <form method="post" action="/marketing/contact/${c.id}/confirma-nastere" style="margin-top:8px">
                 <button class="btn small" type="submit">Confirm că data e corectă</button>
               </form>
             </div>`
          : ""
      }

      <form class="form" method="post" action="/marketing/contact/${c.id}" style="max-width:820px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="field"><span>Nume și prenume</span><input name="nume" value="${esc(c.nume)}" required></label>
          <label class="field"><span>Funcția</span><input name="functie" value="${esc(c.functie || "")}"></label>
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
          <label class="field"><span>Firma din ERP</span>
            <select name="partener_id">
              <option value="">— nu e în ERP —</option>
              ${parteneri.map((p) => `<option value="${p.id}"${Number(c.partener_id) === p.id ? " selected" : ""}>${esc(p.nume)}</option>`).join("")}
            </select>
          </label>
          <label class="field"><span>…sau numele firmei</span><input name="firma_text" value="${esc(c.firma_text || "")}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:12px">
          <label class="field"><span>Email</span><input type="email" name="email" value="${esc(c.email || "")}"></label>
          <label class="field"><span>Telefon</span><input name="telefon" value="${esc(c.telefon || "")}"></label>
          <label class="field"><span>Ziua de naștere${ani ? ` (${ani} de ani)` : ""}</span><input type="date" name="data_nastere" value="${esc(String(c.data_nastere || "").slice(0, 10))}"></label>
        </div>
        <label class="field"><span>Observații</span><input name="observatii" value="${esc(c.observatii || "")}"></label>
        <div class="form-actions">
          <button class="btn" type="submit">Salvează</button>
          <span style="font-size:12px;color:var(--text-muted)">Orice schimbare rămâne în istoricul de mai jos, cu cine și când.</span>
        </div>
      </form>

      <h2>Ce s-a schimbat</h2>
      ${
        istoric.length
          ? table(
              ["Când", "Cine", "Ce", "Din", "În"],
              istoric.map((i) => [
                esc(String(i.schimbat_la || "").slice(0, 16)),
                esc(i.autor || "—"),
                esc(etichete[i.camp] || i.camp),
                esc(i.valoare_veche || "—"),
                `<strong>${esc(i.valoare_noua || "—")}</strong>`,
              ])
            )
          : "<p>Nimic încă — contactul e așa cum a fost adăugat.</p>"
      }

      <h2>Felicitări trimise</h2>
      ${
        trimiteri.length
          ? table(
              ["Ziua", "De la", "Cine a trimis", "Stare"],
              trimiteri.map((t) => [
                esc(String(t.ziua).slice(0, 10)),
                esc(t.de_la || ""),
                nr(t.automat) ? "automat" : esc(t.autor || "—"),
                t.stare === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu" title="${esc(t.eroare || "")}">eșuat</span>`,
              ])
            )
          : "<p>Nicio felicitare trimisă încă.</p>"
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: c.nume, active: "/marketing/contacte", body }));
  });

  router.post("/marketing/contact/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const vechi = await db.prepare("SELECT * FROM mk_contacte WHERE id = ?").get(id);
    if (!vechi) return redirect(ctx.res, "/marketing/contacte");
    const b = ctx.body || {};
    const nou = {
      nume: String(b.nume || "").trim() || vechi.nume,
      functie: String(b.functie || "").trim() || null,
      email: String(b.email || "").trim() || null,
      telefon: String(b.telefon || "").trim() || null,
      data_nastere: String(b.data_nastere || "").slice(0, 10) || null,
      firma_text: String(b.firma_text || "").trim() || null,
      observatii: String(b.observatii || "").trim() || null,
    };
    // O dată de naștere scrisă de un om e, prin definiție, confirmată.
    const confirmata =
      nou.data_nastere && nou.data_nastere !== String(vechi.data_nastere || "").slice(0, 10) ? 1 : nr(vechi.nastere_confirmata);
    await db
      .prepare(
        `UPDATE mk_contacte SET partener_id = ?, firma_text = ?, nume = ?, functie = ?, email = ?, telefon = ?,
                                data_nastere = ?, nastere_confirmata = ?, observatii = ? WHERE id = ?`
      )
      .run(
        parseInt(b.partener_id, 10) || null,
        nou.firma_text,
        nou.nume,
        nou.functie,
        nou.email,
        nou.telefon,
        nou.data_nastere,
        confirmata,
        nou.observatii,
        id
      );
    await scrieIstoric(id, vechi, nou, ctx.user ? ctx.user.id : null);
    redirect(ctx.res, `/marketing/contact/${id}`);
  });

  router.post("/marketing/contact/:id/confirma-nastere", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    await db.prepare("UPDATE mk_contacte SET nastere_confirmata = 1 WHERE id = ?").run(id);
    await db
      .prepare("INSERT INTO mk_contacte_istoric (contact_id, camp, valoare_veche, valoare_noua, schimbat_de, schimbat_la) VALUES (?, 'data_nastere', 'neconfirmată', 'confirmată', ?, ?)")
      .run(id, ctx.user ? ctx.user.id : null, acum());
    redirect(ctx.res, `/marketing/contact/${id}`);
  });

  // Ștergerea e doar a administratorului, și nici atunci nu se pierde urma:
  // rândul rămâne, dezactivat, cu istoricul lui intact.
  router.post("/marketing/contact/:id/sterge", async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, `/marketing/contact/${ctx.params.id}`);
    const id = parseInt(ctx.params.id, 10);
    await db.prepare("UPDATE mk_contacte SET activ = 0 WHERE id = ?").run(id);
    await db
      .prepare("INSERT INTO mk_contacte_istoric (contact_id, camp, valoare_veche, valoare_noua, schimbat_de, schimbat_la) VALUES (?, 'sters', 'activ', 'șters', ?, ?)")
      .run(id, ctx.user ? ctx.user.id : null, acum());
    redirect(ctx.res, "/marketing/contacte");
  });

  // ---- aniversări ---------------------------------------------------------
  router.get("/marketing/aniversari", async (ctx) => {
    const toti = await aniversariAzi();
    const deja = await trimiseAzi();
    const expeditori = await db
      .prepare("SELECT id, nume, email_expeditor FROM utilizatori WHERE activ = 1 AND smtp_host IS NOT NULL AND email_expeditor IS NOT NULL ORDER BY nume")
      .all();
    const alesId = parseInt(ctx.query.contact, 10) || (toti.find((c) => !deja.has(Number(c.id))) || toti[0] || {}).id || null;
    const ales = toti.find((c) => Number(c.id) === Number(alesId)) || null;
    const semnatura = ctx.user ? `${ctx.user.nume}\nCash Machine SRL` : "Cash Machine SRL";

    const lista = table(
      ["Cine", "Firma", "Email", "Stare", ""],
      toti.map((c) => [
        `<a href="/marketing/contact/${c.id}">${esc(c.nume)}</a>`,
        esc(c.firma),
        esc(c.email || "—"),
        deja.has(Number(c.id))
          ? '<span class="badge verde">trimis azi</span>'
          : nr(c.nastere_confirmata)
          ? '<span class="badge galben">de trimis</span>'
          : '<span class="badge gri">dată neconfirmată</span>',
        c.email ? `<a class="link-btn" href="/marketing/aniversari?contact=${c.id}">Scrie-i</a>` : "",
      ])
    );

    const body = `
      <div class="cards">
        <div class="card"><div class="label">Aniversări azi</div><div class="value">${toti.length}</div></div>
        <div class="card"><div class="label">Felicitări trimise azi</div><div class="value" style="color:var(--success)">${deja.size}</div></div>
      </div>

      ${toti.length ? lista : "<p>Nimeni nu-și serbează ziua azi.</p>"}

      ${
        ales
          ? `<h2>Mesaj pentru ${esc(ales.nume)}</h2>
             <form class="form" method="post" action="/marketing/aniversari/trimite" style="max-width:820px">
               <input type="hidden" name="contact_id" value="${ales.id}">
               <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:12px">
                 <label class="field"><span>Trimit de pe</span>
                   <select name="expeditor_id" required>
                     ${expeditori.map((e) => `<option value="${e.id}"${ctx.user && ctx.user.id === e.id ? " selected" : ""}>${esc(e.nume)} — ${esc(e.email_expeditor)}</option>`).join("")}
                   </select>
                 </label>
                 <label class="field"><span>Către</span><input value="${esc(ales.email || "")}" disabled></label>
               </div>
               <label class="field"><span>Subiect</span><input name="subiect" value="${esc(subiectAniversare(ales))}" required></label>
               <label class="field"><span>Mesaj</span><textarea name="mesaj" rows="10" required>${esc(mesajAniversare(ales, semnatura))}</textarea></label>
               <div class="form-actions">
                 <button class="btn" type="submit"${ales.email ? "" : " disabled"}>Trimite felicitarea</button>
                 <span style="font-size:12px;color:var(--text-muted)">${
                   ales.email ? "Mesajul e compus automat — schimbă-l cum vrei înainte să pleace." : "Contactul n-are adresă de email."
                 }</span>
               </div>
             </form>
             ${expeditori.length ? "" : '<p style="color:var(--danger)">Niciun utilizator n-are contul de email configurat. Se pune din „Profilul meu”.</p>'}`
          : ""
      }

      <p style="font-size:12px;color:var(--text-muted);margin-top:20px">
        Dacă până la ora 13:00 nu trimite nimeni, pleacă automat o felicitare din partea administratorului, ca managing partner.
        Automat pleacă doar către contactele cu ziua de naștere confirmată de un om — cele culese din import se confirmă cu un clic,
        din pagina contactului.
      </p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Aniversări", active: "/marketing/aniversari", body }));
  });

  router.post("/marketing/aniversari/trimite", async (ctx) => {
    const b = ctx.body || {};
    const id = parseInt(b.contact_id, 10);
    const c = await db.prepare(`${SELECT_CONTACT} WHERE c.id = ?`).get(id);
    if (!c) return redirect(ctx.res, "/marketing/aniversari");
    const expeditor = await db.prepare("SELECT * FROM utilizatori WHERE id = ?").get(parseInt(b.expeditor_id, 10) || 0);
    const r = await trimiteFelicitare({
      contact: c,
      expeditor,
      subiect: String(b.subiect || subiectAniversare(c)),
      mesaj: String(b.mesaj || ""),
      utilizatorId: ctx.user ? ctx.user.id : null,
      automat: false,
    });
    redirect(ctx.res, `/marketing/aniversari?${r.stare === "trimis" ? "trimis=1" : "eroare=" + encodeURIComponent(r.eroare || "")}`);
  });

  // ---- lista de emailuri trimise -----------------------------------------
  router.get("/marketing/emailuri", async (ctx) => {
    const randuri = await db
      .prepare(
        `SELECT a.*, c.nume AS contact, COALESCE(p.nume, c.firma_text, '—') AS firma, u.nume AS autor
           FROM mk_aniversari a
           LEFT JOIN mk_contacte c ON c.id = a.contact_id
           LEFT JOIN parteneri p ON p.id = c.partener_id
           LEFT JOIN utilizatori u ON u.id = a.trimis_de
          ORDER BY a.id DESC LIMIT 300`
      )
      .all();
    const reusite = randuri.filter((x) => x.stare === "trimis").length;

    const body = `
      <div class="cards">
        <div class="card"><div class="label">Trimise</div><div class="value" style="color:var(--success)">${reusite}</div></div>
        <div class="card"><div class="label">Eșuate</div><div class="value" style="color:${randuri.length - reusite ? "var(--danger)" : "inherit"}">${randuri.length - reusite}</div></div>
        <div class="card"><div class="label">Automate</div><div class="value">${randuri.filter((x) => nr(x.automat)).length}</div></div>
      </div>
      ${table(
        ["Când", "Cui", "Firma", "Adresa", "De pe", "Cine", "Subiect", "Stare"],
        randuri.map((x) => [
          esc(String(x.trimis_la || "").slice(0, 16)),
          x.contact_id ? `<a href="/marketing/contact/${x.contact_id}">${esc(x.contact || "—")}</a>` : esc(x.contact || "—"),
          esc(x.firma || ""),
          esc(x.email || ""),
          esc(x.de_la || ""),
          nr(x.automat) ? '<span class="badge gri">automat</span>' : esc(x.autor || "—"),
          esc(x.subiect || ""),
          x.stare === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu" title="${esc(x.eroare || "")}">eșuat</span>`,
        ])
      )}
      <p style="font-size:12px;color:var(--text-muted)">Rămân și cele eșuate — altfel n-ai cum să afli că n-a plecat.</p>
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Emailuri trimise", active: "/marketing/emailuri", body }));
  });
}

module.exports = {
  register,
  porneste,
  aniversariAzi,
  trimiseAzi,
  verificaAniversariAutomat,
  adunaContacte,
  mesajAniversare,
  subiectAniversare,
  ziLuna,
};
