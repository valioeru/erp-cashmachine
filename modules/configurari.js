"use strict";
// Configurări · Date importate.
//
// Tot ce a intrat în ERP prin import — facturi și încasări — apare aici cu o
// bifă. Dacă bifa e scoasă, rândul rămâne în baza de date, dar dispare din
// toate calculele: rapoarte, dashboard, comisioane, scadențar, balanță.
//
// Cum e făcut: fiecare tabel are o coloană „activ", iar toate interogările
// din aplicație nu mai citesc direct din „facturi" și „plati", ci dintr-o
// subinterogare care păstrează doar rândurile cu activ = 1. Așa nu trebuie
// ținut minte, la fiecare raport nou, că mai există și un filtru de pus.
//
// Pagina asta e singura care se uită la rândurile brute, altfel n-ai mai
// putea vedea — și repune — ce ai scos. De aceea numele tabelelor sunt puse
// în constante: interogările de aici trebuie să rămână nefiltrate.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const T_FACTURI = "facturi";
const T_PLATI = "plati";
const PE_PAGINA = 100;

// Notele cu care importul scria, până acum, plăți născocite din statusul
// facturii. O plată cu una dintre ele nu e o încasare adevărată.
const RECONSTITUITE = [
  "Plată reconstituită automat din statusul din SmartBill",
  "Încasare adusă prin punte din SmartBill",
];

function subnav(activ) {
  const linkuri = [
    ["/configurari/date", "Date importate"],
    ["/configurari/storno", "Facturi stornate"],
  ];
  return `<div class="subnav">${linkuri
    .map(([h, t]) => `<a href="${h}" class="subnav-link${activ === h ? " activ" : ""}">${esc(t)}</a>`)
    .join("")}</div>`;
}

const SUB_TOTAL =
  "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0) / 100.0)) AS total FROM facturi_linii GROUP BY factura_id)";

// dd.mm.yyyy — formatul cu care se lucrează în firmă.
function dataRo(v) {
  const s = String(v || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return esc(v || "");
  return s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4);
}

function numar(v, implicit) {
  const n = Number(v);
  return Number.isFinite(n) ? n : implicit;
}

// Filtrele se traduc în bucăți de WHERE plus parametrii lor. Le construim o
// singură dată și le folosim și la numărat, și la listat, și la bifatul în
// bloc — altfel „selectează tot ce e filtrat" ar putea prinde alte rânduri
// decât cele de pe ecran.
function filtre(tip, q) {
  const unde = [];
  const par = [];
  const an = String(q.an || "").trim();
  const cautare = String(q.q || "").trim();
  const stare = q.stare === "active" || q.stare === "inactive" ? q.stare : "toate";

  if (tip === "facturi") {
    const directie = q.directie === "achizitie" ? "achizitie" : q.directie === "vanzare" ? "vanzare" : "";
    if (directie) {
      unde.push("f.directie = ?");
      par.push(directie);
    }
    if (/^\d{4}$/.test(an)) {
      unde.push("SUBSTR(f.data_emiterii, 1, 4) = ?");
      par.push(an);
    }
    if (cautare) {
      // Omul caută ce vede scris pe factură: „CSHM3161". În bază, seria și
      // numărul stau în două coloane, iar documentul importat din SmartBill
      // are coloana lui. Căutăm în toate, și încă o dată pe seria lipită de
      // număr, cu spațiile scoase — altfel „CSHM3161" n-ar găsi nimic și ar
      // părea că filtrul se uită doar la pagina de pe ecran.
      unde.push(
        "(p.nume ILIKE ? OR f.serie ILIKE ? OR CAST(f.numar AS TEXT) ILIKE ? OR COALESCE(f.document_extern,'') ILIKE ? OR COALESCE(f.observatii,'') ILIKE ? OR REPLACE(COALESCE(f.serie,'') || COALESCE(CAST(f.numar AS TEXT),''), ' ', '') ILIKE ?)"
      );
      const l = "%" + cautare + "%";
      const lipit = "%" + cautare.replace(/[\s-]/g, "") + "%";
      par.push(l, l, l, l, l, lipit);
    }
    if (stare === "active") unde.push("f.activ = 1");
    if (stare === "inactive") unde.push("f.activ = 0");
  } else {
    if (/^\d{4}$/.test(an)) {
      unde.push("SUBSTR(pl.data, 1, 4) = ?");
      par.push(an);
    }
    if (cautare) {
      // Și aici se caută după documentul pe care se vede plata, nu doar după
      // partener: „CSHM3161" trebuie să scoată încasările facturii ăleia.
      unde.push(
        "(p.nume ILIKE ? OR COALESCE(pl.observatii,'') ILIKE ? OR COALESCE(pl.metoda,'') ILIKE ? OR COALESCE(fc.document_extern,'') ILIKE ? OR REPLACE(COALESCE(fc.serie,'') || COALESCE(CAST(fc.numar AS TEXT),''), ' ', '') ILIKE ?)"
      );
      const l = "%" + cautare + "%";
      const lipit = "%" + cautare.replace(/[\s-]/g, "") + "%";
      par.push(l, l, l, l, lipit);
    }
    if (stare === "active") unde.push("pl.activ = 1");
    if (stare === "inactive") unde.push("pl.activ = 0");
  }
  return { where: unde.length ? "WHERE " + unde.join(" AND ") : "", par, stare, an, cautare };
}

async function citesteFacturi(f, offset) {
  return db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.document_extern, f.data_emiterii, f.directie, f.status, f.sursa_import, f.activ,
              p.nume AS partener, COALESCE(t.total, 0) AS total
         FROM ${T_FACTURI} f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
         ${f.where}
        ORDER BY f.data_emiterii DESC, f.id DESC
        LIMIT ${PE_PAGINA} OFFSET ${offset}`
    )
    .all(...f.par);
}

async function citestePlati(f, offset) {
  return db
    .prepare(
      `SELECT pl.id, pl.data, pl.suma, pl.metoda, pl.observatii, pl.activ,
              fc.serie, fc.numar, fc.document_extern, fc.directie, p.nume AS partener
         FROM ${T_PLATI} pl
         JOIN ${T_FACTURI} fc ON fc.id = pl.factura_id
         JOIN parteneri p ON p.id = fc.partener_id
         ${f.where}
        ORDER BY pl.data DESC, pl.id DESC
        LIMIT ${PE_PAGINA} OFFSET ${offset}`
    )
    .all(...f.par);
}

async function numaraFacturi(f) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN f.activ = 0 THEN 1 ELSE 0 END) AS inactive
         FROM ${T_FACTURI} f JOIN parteneri p ON p.id = f.partener_id ${f.where}`
    )
    .get(...f.par);
  return { n: Number(r.n || 0), inactive: Number(r.inactive || 0) };
}

async function numaraPlati(f) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN pl.activ = 0 THEN 1 ELSE 0 END) AS inactive
         FROM ${T_PLATI} pl JOIN ${T_FACTURI} fc ON fc.id = pl.factura_id
         JOIN parteneri p ON p.id = fc.partener_id ${f.where}`
    )
    .get(...f.par);
  return { n: Number(r.n || 0), inactive: Number(r.inactive || 0) };
}

// Câte sunt scoase din calcule în total, indiferent de filtrul curent. E
// primul lucru pe care vrei să-l vezi când deschizi pagina: dacă cifrele nu
// se potrivesc cu contabilitatea, aici scrie de ce.
async function sumarGeneral() {
  const f = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN activ = 0 THEN 1 ELSE 0 END) AS inactive FROM ${T_FACTURI}`).get();
  const p = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN activ = 0 THEN 1 ELSE 0 END) AS inactive FROM ${T_PLATI}`).get();
  return {
    facturi: { n: Number(f.n || 0), inactive: Number(f.inactive || 0) },
    plati: { n: Number(p.n || 0), inactive: Number(p.inactive || 0) },
  };
}

function bifa(id, activ) {
  return `<input type="checkbox" name="activ_${id}" value="1"${Number(activ) ? " checked" : ""} class="bifa-activ">`;
}

function linkPagina(q, pagina) {
  const u = new URLSearchParams();
  for (const k of ["tip", "directie", "an", "q", "stare"]) if (q[k]) u.set(k, q[k]);
  if (pagina > 1) u.set("p", String(pagina));
  return "/configurari/date" + (u.toString() ? "?" + u.toString() : "");
}

function selector(nume, valoare, optiuni) {
  return `<select name="${nume}">${optiuni
    .map(([v, t]) => `<option value="${esc(v)}"${String(valoare || "") === v ? " selected" : ""}>${esc(t)}</option>`)
    .join("")}</select>`;
}

// --- Facturi stornate ------------------------------------------------------
//
// Regula, spusă de Vali: „dacă stornezi o factură cu aceeași valoare, faci
// storno la factura inițială, iar cea inițială apare încasată — de aia nu vezi
// încasarea". Adică SmartBill marchează factura originală ca „platită" fără să
// existe vreun ban în extras. De aceea, după ce am oprit importul din a mai
// născoci plăți din status, facturile astea au rămas fără nicio plată și au
// ieșit la suprafață ca restanțe — deși nu mai are cine să le plătească.
//
// Nu există în SmartBill un câmp care să lege stornoul de factura lui, așa că
// perechile se caută după singurul lucru sigur: același partener, aceeași
// direcție, aceeași valoare cu semn schimbat. O factură inițială e folosită o
// singură dată, iar când sunt mai multe candidate se ia cea mai apropiată în
// timp înaintea stornoului. Ce nu se potrivește exact (storno parțial, factura
// inițială dinaintea perioadei importate) rămâne pe listă separat, de mână.
async function facturiPentruStorno() {
  const semne = RECONSTITUITE.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT f.id, f.serie, f.numar, f.data_emiterii, f.directie, f.partener_id, f.activ, f.status,
              p.nume AS partener,
              COALESCE(t.total, 0) AS total,
              COALESCE(r.reale, 0) AS incasari_reale
         FROM ${T_FACTURI} f
         JOIN parteneri p ON p.id = f.partener_id
         LEFT JOIN ${SUB_TOTAL} t ON t.factura_id = f.id
         LEFT JOIN (SELECT factura_id, COUNT(*) AS reale FROM ${T_PLATI}
                     WHERE observatii IS NULL OR observatii NOT IN (${semne})
                     GROUP BY factura_id) r ON r.factura_id = f.id`
    )
    .all(...RECONSTITUITE);
}

function cheiePereche(f) {
  return `${f.partener_id}|${f.directie}|${Math.abs(Number(f.total)).toFixed(2)}`;
}

function perechiStorno(randuri) {
  const dupaData = (a, b) => String(a.data_emiterii || "").localeCompare(String(b.data_emiterii || ""));
  const negative = randuri.filter((f) => Number(f.total) < -0.5).sort(dupaData);
  const pozitive = new Map();
  for (const f of randuri) {
    if (Number(f.total) <= 0.5) continue;
    const k = cheiePereche(f);
    if (!pozitive.has(k)) pozitive.set(k, []);
    pozitive.get(k).push(f);
  }
  for (const lista of pozitive.values()) lista.sort(dupaData);

  const folosite = new Set();
  const perechi = [];
  const orfane = [];
  for (const s of negative) {
    const lista = pozitive.get(cheiePereche(s)) || [];
    const libere = lista.filter((f) => !folosite.has(f.id));
    // Preferăm factura emisă înaintea stornoului, cea mai apropiată de el.
    const inainte = libere.filter((f) => String(f.data_emiterii || "") <= String(s.data_emiterii || ""));
    const aleasa = inainte.length ? inainte[inainte.length - 1] : libere.length ? libere[0] : null;
    if (aleasa) {
      folosite.add(aleasa.id);
      perechi.push({ storno: s, initiala: aleasa });
    } else {
      orfane.push(s);
    }
  }
  return { perechi, orfane };
}

function register(router) {
  router.get("/configurari", async (ctx) => redirect(ctx.res, "/configurari/date"));

  router.get("/configurari/date", async (ctx) => {
    const q = ctx.query || {};
    const tip = q.tip === "incasari" ? "incasari" : "facturi";
    const pagina = Math.max(1, numar(q.p, 1));
    const f = filtre(tip, q);
    const offset = (pagina - 1) * PE_PAGINA;

    const sumar = await sumarGeneral();
    const total = tip === "facturi" ? await numaraFacturi(f) : await numaraPlati(f);
    const randuri = tip === "facturi" ? await citesteFacturi(f, offset) : await citestePlati(f, offset);
    const pagini = Math.max(1, Math.ceil(total.n / PE_PAGINA));

    const ani = [];
    const anAcum = new Date().getFullYear();
    for (let a = anAcum; a >= 2016; a--) ani.push([String(a), String(a)]);

    const capete =
      tip === "facturi"
        ? ['<input type="checkbox" id="bifa-toate">', "Activ", "Data", "Document", "Partener", "Tip", "Valoare", "Status", "Sursă"]
        : ['<input type="checkbox" id="bifa-toate">', "Activ", "Data", "Sumă", "Metodă", "Factura", "Partener", "Observații"];

    const corp =
      tip === "facturi"
        ? randuri.map((r) => [
            bifa(r.id, r.activ),
            Number(r.activ) ? "" : '<span style="color:var(--danger);font-size:12px">scoasă</span>',
            dataRo(r.data_emiterii),
            esc(r.document_extern || (r.serie || "") + (r.numar == null ? "" : r.numar)),
            esc(r.partener),
            r.directie === "achizitie" ? "achiziție" : "vânzare",
            money(r.total),
            esc(r.status || ""),
            esc(r.sursa_import || "—"),
          ])
        : randuri.map((r) => [
            bifa(r.id, r.activ),
            Number(r.activ) ? "" : '<span style="color:var(--danger);font-size:12px">scoasă</span>',
            dataRo(r.data),
            money(r.suma),
            esc(r.metoda || ""),
            esc(r.document_extern || (r.serie || "") + (r.numar == null ? "" : r.numar)),
            esc(r.partener),
            esc(r.observatii || ""),
          ]);

    const ids = randuri.map((r) => r.id).join(",");
    const intoarcere = linkPagina(q, pagina);

    const body = `
      ${subnav("/configurari/date")}

      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Facturi în baza de date</div>${sumar.facturi.n.toLocaleString("ro-RO")}</div>
        <div><div class="k">Facturi scoase din calcule</div>${
          sumar.facturi.inactive ? `<strong style="color:var(--danger)">${sumar.facturi.inactive}</strong>` : "niciuna"
        }</div>
        <div><div class="k">Încasări/plăți în baza de date</div>${sumar.plati.n.toLocaleString("ro-RO")}</div>
        <div><div class="k">Încasări/plăți scoase din calcule</div>${
          sumar.plati.inactive ? `<strong style="color:var(--danger)">${sumar.plati.inactive}</strong>` : "niciuna"
        }</div>
      </div></div>

      <p style="color:var(--text-muted);font-size:13px;max-width:820px">
        Bifa înseamnă „intră în calcule". Dacă o scoți, rândul rămâne aici, dar dispare din rapoarte,
        dashboard, comisioane, scadențar și balanță — ca și cum n-ar fi fost importat. Îl poți pune
        oricând la loc bifând din nou.
      </p>

      <form method="get" action="/configurari/date" class="inline-form" style="gap:10px;flex-wrap:wrap;margin:14px 0">
        ${selector("tip", tip, [["facturi", "Facturi"], ["incasari", "Încasări și plăți"]])}
        ${tip === "facturi" ? selector("directie", q.directie, [["", "Toate direcțiile"], ["vanzare", "Vânzare"], ["achizitie", "Achiziție"]]) : ""}
        ${selector("an", f.an, [["", "Toți anii"]].concat(ani))}
        ${selector("stare", f.stare, [["toate", "Toate"], ["active", "Doar active"], ["inactive", "Doar scoase din calcule"]])}
        <input type="search" name="q" value="${esc(f.cautare)}" placeholder="Caută după partener sau document (ex. CSHM3161)" style="min-width:280px">
        <button type="submit" class="btn">Filtrează</button>
      </form>

      <form method="post" action="/configurari/date/salveaza">
        <input type="hidden" name="ids" value="${ids}">
        <input type="hidden" name="tip" value="${tip}">
        <input type="hidden" name="intoarcere" value="${esc(intoarcere)}">
        <div class="inline-form" style="gap:12px;flex-wrap:wrap;margin-bottom:10px">
          <button type="submit" class="btn">Salvează bifele de pe pagina asta</button>
          <span style="color:var(--text-muted);font-size:13px">
            ${total.n.toLocaleString("ro-RO")} rânduri filtrate${total.inactive ? `, din care ${total.inactive} scoase` : ""} ·
            pagina ${pagina} din ${pagini}
          </span>
        </div>
        ${table(capete, corp)}
        <div class="inline-form" style="gap:12px;margin-top:10px">
          <button type="submit" class="btn">Salvează bifele de pe pagina asta</button>
        </div>
      </form>

      <form method="post" action="/configurari/date/toate" class="inline-form" style="gap:10px;margin-top:16px;flex-wrap:wrap">
        <input type="hidden" name="tip" value="${tip}">
        <input type="hidden" name="directie" value="${esc(q.directie || "")}">
        <input type="hidden" name="an" value="${esc(f.an)}">
        <input type="hidden" name="q" value="${esc(f.cautare)}">
        <input type="hidden" name="stare" value="${esc(f.stare)}">
        <input type="hidden" name="intoarcere" value="${esc(intoarcere)}">
        <span style="color:var(--text-muted);font-size:13px">Pentru toate cele ${total.n.toLocaleString("ro-RO")} rânduri filtrate, nu doar pagina asta:</span>
        <button type="submit" name="valoare" value="1" class="btn">Pune-le pe toate în calcule</button>
        <button type="submit" name="valoare" value="0" class="link-btn" style="color:var(--danger)">Scoate-le pe toate din calcule</button>
      </form>

      <div style="margin-top:14px">
        ${pagina > 1 ? `<a href="${linkPagina(q, pagina - 1)}" class="btn-secundar">&larr; Pagina anterioară</a>` : ""}
        ${pagina < pagini ? `<a href="${linkPagina(q, pagina + 1)}" class="btn-secundar">Pagina următoare &rarr;</a>` : ""}
      </div>

      <script>
      (function () {
        var toate = document.getElementById("bifa-toate");
        if (!toate) return;
        toate.addEventListener("change", function () {
          var b = document.querySelectorAll(".bifa-activ");
          for (var i = 0; i < b.length; i++) b[i].checked = toate.checked;
        });
      })();
      </script>
    `;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Configurări · Date importate", active: "/configurari/date", body }));
  });

  // Salvarea bifelor de pe pagina curentă. Trimitem lista de id-uri afișate
  // într-un câmp ascuns pentru că un checkbox nebifat nu ajunge deloc în
  // formular — fără lista aia n-am ști dacă un rând a fost scos sau doar nu
  // era pe ecran.
  router.get("/configurari/storno", async (ctx) => {
    const randuri = await facturiPentruStorno();
    const { perechi, orfane } = perechiStorno(randuri);

    const active = perechi.filter((x) => Number(x.storno.activ) || Number(x.initiala.activ));
    const faraIncasare = active.filter((x) => !Number(x.initiala.incasari_reale));
    const cuIncasare = active.filter((x) => Number(x.initiala.incasari_reale));
    const scoase = perechi.length - active.length;
    const valoareFaraIncasare = faraIncasare.reduce((s, x) => s + Number(x.initiala.total), 0);

    const doc = (f) => esc(`${f.serie || ""} ${f.numar == null ? "" : f.numar}`.trim());
    const semn = (f) =>
      Number(f.activ)
        ? ""
        : ' <span style="color:var(--danger);font-size:12px">(scoasă)</span>';

    const rand = (x) => [
      `<input type="checkbox" name="p_${x.storno.id}_${x.initiala.id}" value="1"${
        Number(x.storno.activ) || Number(x.initiala.activ) ? " checked" : ""
      } class="bifa-pereche">`,
      esc(x.initiala.partener),
      x.initiala.directie === "achizitie" ? "achiziție" : "vânzare",
      doc(x.initiala) + " · " + dataRo(x.initiala.data_emiterii) + semn(x.initiala),
      doc(x.storno) + " · " + dataRo(x.storno.data_emiterii) + semn(x.storno),
      money(x.initiala.total),
      Number(x.initiala.incasari_reale)
        ? `<strong style="color:var(--warn)">da (${Number(x.initiala.incasari_reale)})</strong>`
        : "nu",
    ];

    const capete = ['<input type="checkbox" id="bifa-toate">', "Partener", "Direcție", "Factura inițială", "Stornoul ei", "Valoare", "Are încasare reală?"];

    const body = `
      ${subnav("/configurari/storno")}

      <div class="detail-box"><div class="detail-grid">
        <div><div class="k">Facturi de storno găsite</div>${(perechi.length + orfane.length).toLocaleString("ro-RO")}</div>
        <div><div class="k">Perechi identificate</div>${perechi.length.toLocaleString("ro-RO")}</div>
        <div><div class="k">Perechi deja scoase din calcule</div>${scoase ? scoase.toLocaleString("ro-RO") : "niciuna"}</div>
        <div><div class="k">Fără pereche, de verificat de mână</div>${orfane.length.toLocaleString("ro-RO")}</div>
      </div></div>

      <p style="color:var(--text-muted);font-size:13px;max-width:860px">
        Când o factură e stornată cu aceeași valoare, SmartBill marchează factura inițială drept
        „platită" fără să existe vreo încasare în bancă. De când importul nu mai născocește plăți din
        status, facturile astea apar ca restanțe — deși nu mai are cine să le plătească. Scoase din
        calcule, storno și inițială dispar amândouă: facturatul nu se schimbă (oricum se anulau
        reciproc), dar nu mai atârnă la „de încasat" și nu mai intră în comision.
      </p>

      <h2>Perechi fără nicio încasare reală pe factura inițială — ${faraIncasare.length}</h2>
      <p style="color:var(--text-muted);font-size:13px">
        Astea sunt cazul curat: factura a fost stornată și banii n-au intrat niciodată.
        Valoare totală: <strong>${money(valoareFaraIncasare)}</strong>.
      </p>
      <form method="post" action="/configurari/storno/aplica">
        <input type="hidden" name="valoare" value="0">
        <div class="inline-form" style="gap:12px;margin-bottom:10px">
          <button type="submit" class="btn">Scoate din calcule perechile bifate</button>
        </div>
        ${table(capete, faraIncasare.map(rand))}
        <div class="inline-form" style="gap:12px;margin-top:10px">
          <button type="submit" class="btn">Scoate din calcule perechile bifate</button>
        </div>
      </form>

      ${
        cuIncasare.length
          ? `<h2 style="margin-top:26px">Perechi unde factura inițială chiar a fost încasată — ${cuIncasare.length}</h2>
             <p style="color:var(--text-muted);font-size:13px;max-width:860px">
               Aici banii au intrat în bancă și abia apoi s-a emis stornoul. Nu le ating automat:
               poate fi o returnare, o refacturare sau o corecție de dată. Uită-te la ele întâi.
             </p>
             <form method="post" action="/configurari/storno/aplica">
               <input type="hidden" name="valoare" value="0">
               ${table(capete, cuIncasare.map(rand))}
               <div class="inline-form" style="gap:12px;margin-top:10px">
                 <button type="submit" class="link-btn" style="color:var(--danger)">Scoate din calcule perechile bifate</button>
               </div>
             </form>`
          : ""
      }

      ${
        scoase
          ? `<h2 style="margin-top:26px">Perechi scoase deja din calcule — ${scoase}</h2>
             <form method="post" action="/configurari/storno/aplica">
               <input type="hidden" name="valoare" value="1">
               ${table(
                 capete,
                 perechi
                   .filter((x) => !Number(x.storno.activ) && !Number(x.initiala.activ))
                   .map((x) => {
                     const r = rand(x);
                     r[0] = `<input type="checkbox" name="p_${x.storno.id}_${x.initiala.id}" value="1" class="bifa-pereche">`;
                     return r;
                   })
               )}
               <div class="inline-form" style="gap:12px;margin-top:10px">
                 <button type="submit" class="btn">Pune la loc în calcule perechile bifate</button>
               </div>
             </form>`
          : ""
      }

      <h2 style="margin-top:26px">Facturi de storno fără pereche exactă — ${orfane.length}</h2>
      <p style="color:var(--text-muted);font-size:13px;max-width:860px">
        Storno parțial, factura inițială emisă înainte de perioada importată, sau valoarea diferă
        cu câțiva bani. Nu le ating — le lași așa sau le scoți una câte una din „Date importate".
      </p>
      ${table(
        ["Partener", "Direcție", "Document", "Data", "Valoare"],
        orfane.map((f) => [
          esc(f.partener),
          f.directie === "achizitie" ? "achiziție" : "vânzare",
          doc(f) + semn(f),
          dataRo(f.data_emiterii),
          money(f.total),
        ])
      )}

      <script>
      (function () {
        var toate = document.getElementById("bifa-toate");
        if (!toate) return;
        toate.addEventListener("change", function () {
          var b = document.querySelectorAll(".bifa-pereche");
          for (var i = 0; i < b.length; i++) b[i].checked = toate.checked;
        });
      })();
      </script>
    `;

    send(ctx.res, 200, layout({ user: ctx.user, title: "Configurări · Facturi stornate", active: "/configurari/storno", body }));
  });

  // Bifele vin sub forma p_<idStorno>_<idInitiala>, ca să nu fie nevoie de o
  // listă ascunsă cu perechile: fiecare bifă își cară singură ambele id-uri.
  router.post("/configurari/storno/aplica", async (ctx) => {
    const valoare = String(ctx.body.valoare) === "1" ? 1 : 0;
    const ids = new Set();
    for (const cheie of Object.keys(ctx.body || {})) {
      const m = /^p_(\d+)_(\d+)$/.exec(cheie);
      if (!m || !ctx.body[cheie]) continue;
      ids.add(Number(m[1]));
      ids.add(Number(m[2]));
    }
    for (const id of ids) {
      await db.prepare(`UPDATE ${T_FACTURI} SET activ = ? WHERE id = ?`).run(valoare, id);
    }
    redirect(ctx.res, "/configurari/storno");
  });

  router.post("/configurari/date/salveaza", async (ctx) => {
    const tip = ctx.body.tip === "incasari" ? "incasari" : "facturi";
    const tabel = tip === "incasari" ? T_PLATI : T_FACTURI;
    const ids = String(ctx.body.ids || "")
      .split(",")
      .map((x) => parseInt(x, 10))
      .filter((x) => Number.isFinite(x));
    for (const id of ids) {
      const activ = ctx.body["activ_" + id] ? 1 : 0;
      await db.prepare(`UPDATE ${tabel} SET activ = ? WHERE id = ?`).run(activ, id);
    }
    const inapoi = String(ctx.body.intoarcere || "/configurari/date");
    redirect(ctx.res, inapoi.startsWith("/configurari") ? inapoi : "/configurari/date");
  });

  router.post("/configurari/date/toate", async (ctx) => {
    const tip = ctx.body.tip === "incasari" ? "incasari" : "facturi";
    const valoare = String(ctx.body.valoare) === "0" ? 0 : 1;
    const f = filtre(tip, ctx.body);
    if (tip === "facturi") {
      await db
        .prepare(
          `UPDATE ${T_FACTURI} SET activ = ? WHERE id IN (
             SELECT f.id FROM ${T_FACTURI} f JOIN parteneri p ON p.id = f.partener_id ${f.where})`
        )
        .run(valoare, ...f.par);
    } else {
      await db
        .prepare(
          `UPDATE ${T_PLATI} SET activ = ? WHERE id IN (
             SELECT pl.id FROM ${T_PLATI} pl JOIN ${T_FACTURI} fc ON fc.id = pl.factura_id
             JOIN parteneri p ON p.id = fc.partener_id ${f.where})`
        )
        .run(valoare, ...f.par);
    }
    const inapoi = String(ctx.body.intoarcere || "/configurari/date");
    redirect(ctx.res, inapoi.startsWith("/configurari") ? inapoi : "/configurari/date");
  });
}

module.exports = { register };
