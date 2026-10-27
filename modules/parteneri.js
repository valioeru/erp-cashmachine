"use strict";
const db = require("../lib/db");
const { deschisa } = require("../lib/solduri");
const alocari = require("./alocari");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const inbox = require("./inbox");
const tsk = require("./taskuri");
const XLS = require("../lib/export-xlsx");

const TIP_LABEL = { client: "Client", furnizor: "Furnizor", ambele: "Client & Furnizor" };
const STARE_LABEL = {
  lead: "Lead / prospect",
  client_activ: "Client activ",
  client_inactiv: "Client inactiv",
  furnizor_activ: "Furnizor activ",
};
const STARE_OPTIONS = Object.entries(STARE_LABEL).map(([value, label]) => ({ value, label }));
// Tipurile de interacțiune. Primele patru se aleg manual din formular;
// restul apar doar generate de sistem (task de contact, ofertă, notificare),
// de-aia stau separat — n-are sens să scrii de mână „ofertă acceptată".
const INTERACTIUNE_LABEL = { nota: "Notă", telefon: "Telefon", vizita: "Vizită", email: "Email", whatsapp: "WhatsApp", apel: "Apel telefonic", intalnire: "Întâlnire" };
const INTERACTIUNE_MANUAL = ["nota", "telefon", "vizita", "email", "whatsapp"];
const INTERACTIUNE_AUTO = { oferta: "Ofertă", contract: "Contract", comanda: "Comandă", notificare: "Notificare", factura: "Factură" };

// Exportul listei de parteneri e DOAR al administratorului.
//
// Lista asta e, practic, portofoliul de clienți al firmei: nume, CUI, cât
// cumpără fiecare și cât datorează. Pe ecran o vede cine are dreptul la
// pagină, dar un ecran se închide, iar un fișier descărcat pleacă mai departe
// — la următorul angajator, de pildă. De-aia butonul nu e doar ascuns pentru
// ceilalți: ruta refuză. Un buton ascuns se ghicește din adresă în zece
// secunde, și atunci ascunderea devine o minciună spusă nouă înșine.
function poateExporta(user) {
  return Boolean(user && user.rol === "admin");
}

// Lista de parteneri, cu filtrele ei. Stă într-o funcție fiindcă o citesc
// două rute: pagina și exportul. Dacă ar fi scrisă de două ori, exportul ar
// ajunge, după a treia modificare de filtru, să scoată alte rânduri decât
// cele de pe ecran — iar omul ar semna un fișier crezând că e ce-a văzut.
async function culegeParteneri(q) {
  const tip = ["client", "furnizor", "ambii"].includes(String(q.tip)) ? String(q.tip) : "ambii";
  const cauta = String(q.q || "").trim();

  // Cu care firmă din grup a lucrat partenerul. Nu e un câmp scris pe el și
  // nici nu trebuie să fie: partenerii sunt COMUNI pe tot grupul (vezi
  // lib/grup.js), iar firma emitentă stă pe factură. Deci se deduce, și e
  // mereu adevărat — un client care cumpără de la amândouă apare cu
  // amândouă, fără ca cineva să bifeze ceva.
  const firmeGrup = await db
    .prepare("SELECT id, nume, culoare FROM firme WHERE COALESCE(operationala,1) = 1 ORDER BY implicita DESC, id")
    .all()
    .catch(() => []);
  const firmaCeruta = Number(q.firma) || 0;

  const args = [];
  // Partenerii ignorați nu apar în listă. Sunt firme scoase intenționat din
  // ERP (date de test rămase în SmartBill), iar locul lor e în
  // Configurări → Parteneri ignorați, de unde se pun la loc.
  let unde = "COALESCE(p.ignorat,0) = 0";
  if (tip === "client") unde = "COALESCE(p.ignorat,0) = 0 AND p.tip IN ('client','ambele')";
  else if (tip === "furnizor") unde = "COALESCE(p.ignorat,0) = 0 AND p.tip IN ('furnizor','ambele')";
  if (cauta) {
    unde += " AND (LOWER(p.nume) LIKE ? OR LOWER(COALESCE(p.cui,'')) LIKE ?)";
    args.push("%" + cauta.toLowerCase() + "%", "%" + cauta.toLowerCase() + "%");
  }
  if (firmaCeruta > 0) {
    unde += ` AND EXISTS (SELECT 1 FROM facturi fx WHERE fx.activ = 1 AND fx.partener_id = p.id AND fx.firma_id = ${firmaCeruta})`;
  }

  const T = "(SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) AS total FROM facturi_linii GROUP BY factura_id)";
  const P = "(SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) plati GROUP BY factura_id)";
  const acum12 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  // Rulajul, soldul si ultima factura se calculeaza o singura data, grupat pe
  // partener, nu cate trei subinterogari corelate pentru fiecare rand din
  // lista. Varianta veche recitea tot facturi_linii si toate platile pentru
  // fiecare partener in parte — pagina statea 25 de secunde la 1.000 de
  // parteneri. Conditiile raman exact aceleasi, doar ca s-au mutat din WHERE
  // in CASE-urile de mai jos: „ultima" nu tine cont de intercompany, iar
  // rulajul si soldul da.
  const randuri = await db
    .prepare(
      `WITH agregat AS (
         SELECT f.partener_id,
                COALESCE(SUM(CASE WHEN COALESCE(f.intercompany,0) = 0 AND f.data_emiterii >= ?
                                  THEN COALESCE(t.total,0) ELSE 0 END), 0) AS rulaj,
                COALESCE(SUM(CASE WHEN COALESCE(f.intercompany,0) = 0 AND f.directie = 'vanzare'
                                   AND ${deschisa("f")}
                                   AND COALESCE(t.total,0) - COALESCE(pl.platit,0) > 0.5
                                  THEN COALESCE(t.total,0) - COALESCE(pl.platit,0) ELSE 0 END), 0) AS sold,
                MAX(f.data_emiterii) AS ultima,
                string_agg(DISTINCT CAST(f.firma_id AS TEXT), ',') AS firme
           FROM (SELECT * FROM facturi WHERE activ = 1) f
           LEFT JOIN ${T} t ON t.factura_id = f.id
           LEFT JOIN ${P} pl ON pl.factura_id = f.id
          WHERE f.status NOT IN ('anulata','ciorna')
          GROUP BY f.partener_id
       )
       SELECT p.id, p.nume, p.tip, p.stare, p.cui, p.email, p.telefon,
              u.nume AS agent,
              COALESCE(a.rulaj, 0) AS rulaj,
              COALESCE(a.sold, 0) AS sold,
              a.ultima AS ultima,
              a.firme AS firme
         FROM parteneri p
         LEFT JOIN utilizatori u ON u.id = p.agent_id
         LEFT JOIN agregat a ON a.partener_id = p.id
        WHERE ${unde}
        ORDER BY rulaj DESC, sold DESC, p.nume`
    )
    .all(acum12, ...args);

  return { tip, cauta, firmaCeruta, firmeGrup, randuri };
}


function register(router) {
  // Lista de parteneri, ordonată după cât cântăresc de fapt: rulajul pe
  // ultimele 12 luni, nu alfabetic. Un client de 13 milioane și unul de 200
  // de lei n-au ce căuta unul lângă altul, nediferențiați, în aceeași listă.
  //
  // Se înregistrează ÎNAINTEA CRUD-ului generic, ca să câștige ruta /parteneri.
  router.get("/parteneri", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const { tip, cauta, firmaCeruta, firmeGrup, randuri } = await culegeParteneri(ctx.query);

    const qs = (cauta ? "&q=" + encodeURIComponent(cauta) : "") + (firmaCeruta ? "&firma=" + firmaCeruta : "");
    const buton = (v, eticheta) =>
      `<a class="btn ${tip === v ? "" : "secondary"}" href="/parteneri?tip=${v}${qs}">${esc(eticheta)}</a>`;

    // „Cash Machine SRL" pe o insignă de tabel e zgomot: forma juridică nu
    // deosebește nimic aici, toate firmele grupului sunt SRL.
    const scurtFirma = (x) => String(x || "").replace(/\s*S\.?R\.?L\.?\s*$/i, "").trim();
    const dupaId = new Map(firmeGrup.map((f) => [String(f.id), f]));
    const insigneFirme = (lista) => {
      const ids = String(lista || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!ids.length) return '<span style="color:var(--text-muted)" title="N-are nicio factură în ERP">—</span>';
      const vazute = [];
      for (const id of ids) {
        const f = dupaId.get(id);
        if (f && !vazute.some((x) => x.id === f.id)) vazute.push(f);
      }
      if (!vazute.length) return '<span style="color:var(--text-muted)">—</span>';
      return vazute
        .map(
          (f) =>
            `<span class="badge" style="background:${esc(f.culoare || "#6b7280")};color:#fff">${esc(scurtFirma(f.nume))}</span>`
        )
        .join(" ");
    };

    const qsTip = "tip=" + tip + (cauta ? "&q=" + encodeURIComponent(cauta) : "");
    const butonFirma = (id, eticheta) =>
      `<a class="btn small ${firmaCeruta === id ? "" : "secondary"}" href="/parteneri?${qsTip}${id ? "&firma=" + id : ""}">${esc(eticheta)}</a>`;

    const body = `
      <div class="toolbar">
        <a class="btn" href="/parteneri/nou">+ Partener nou</a>
        ${buton("ambii", "Toți")}
        ${buton("client", "Clienți")}
        ${buton("furnizor", "Furnizori")}
        ${
          poateExporta(ctx.user)
            ? `<a class="btn secondary" style="margin-left:auto"
                  href="/parteneri/export.xlsx?tip=${encodeURIComponent(tip)}${qs}"
                  title="Descarcă în Excel toți cei ${randuri.length} parteneri din filtrul curent, nu doar primii 300 de pe ecran. Doar administratorii văd butonul.">
                 ↓ Export Excel
               </a>`
            : ""
        }
      </div>
      ${
        firmeGrup.length > 1
          ? `<div class="toolbar" style="flex-wrap:wrap;gap:6px">
               <span style="font-size:13px;color:var(--text-muted);align-self:center">Firma cu care a lucrat:</span>
               ${butonFirma(0, "oricare")}
               ${firmeGrup.map((f) => butonFirma(Number(f.id), scurtFirma(f.nume))).join("")}
             </div>`
          : ""
      }
      <form method="get" action="/parteneri" class="filtre">
        <input type="hidden" name="tip" value="${esc(tip)}">
        <input name="q" placeholder="caută după nume sau CUI" value="${esc(cauta)}" style="min-width:240px">
        <button class="btn secondary small" type="submit">Caută</button>
        ${cauta ? `<a class="btn secondary small" href="/parteneri?tip=${tip}">renunță</a>` : ""}
      </form>
      <p style="font-size:13px;color:var(--text-muted)">
        ${randuri.length} parteneri, ordonați după rulajul din ultimele 12 luni.
      </p>
      ${table(
        ["#", "Nume", "Tip", "Firma", "Agent", "Rulaj 12 luni", "De încasat", "Ultima factură", "Stare"],
        randuri.slice(0, 300).map((r, i) => [
          String(i + 1),
          `<a href="/parteneri/${r.id}">${esc(r.nume)}</a>`,
          esc(TIP_LABEL[r.tip] || r.tip),
          insigneFirme(r.firme),
          esc(r.agent || "—"),
          money(r.rulaj),
          Number(r.sold) > 0.5 ? `<strong style="color:var(--danger)">${money(r.sold)}</strong>` : "—",
          r.ultima ? esc(String(r.ultima).slice(0, 10)) : "—",
          esc(STARE_LABEL[r.stare] || r.stare || "—"),
        ])
      )}
      ${randuri.length > 300 ? `<p style="color:var(--text-muted);font-size:13px">Se afișează primii 300. Folosește căutarea pentru restul.</p>` : ""}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Parteneri", active: "/parteneri", body }));
  });

  // Exportul listei, în Excel. Se înregistrează AICI, înaintea lui
  // „/parteneri/:id" și a CRUD-ului generic: rutele se potrivesc în ordinea
  // înregistrării, iar pusă mai jos adresa ar fi fost înghițită de ruta de
  // partener și ar fi căutat un partener cu id-ul „export.xlsx".
  router.get("/parteneri/export.xlsx", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    if (!poateExporta(ctx.user)) {
      // Nu redirectăm spre listă: un fișier care „se descarcă" și iese pagina
      // de parteneri în loc de Excel l-ar face pe om să creadă că s-a stricat
      // exportul. Spunem pe față că n-are voie.
      return send(ctx.res, 403, layout({
        user: ctx.user,
        title: "Export parteneri",
        active: "/parteneri",
        body: `<p>Exportul listei de parteneri e rezervat administratorilor.</p>
               <p style="color:var(--text-muted);max-width:620px">Lista conține portofoliul de clienți al firmei —
               nume, CUI, rulaj și sold pe fiecare. Pe ecran o vezi; descărcată, pleacă mai departe.
               Dacă ai nevoie de ea, cere-i-o unui administrator.</p>
               <p><a class="btn secondary" href="/parteneri">Înapoi la parteneri</a></p>`,
      }));
    }

    const { tip, cauta, firmaCeruta, firmeGrup, randuri } = await culegeParteneri(ctx.query);
    const numeFirma = new Map(firmeGrup.map((f) => [String(f.id), f.nume]));
    const firmeText = (lista) =>
      [...new Set(String(lista || "").split(",").map((s) => s.trim()).filter(Boolean))]
        .map((id) => numeFirma.get(id) || id)
        .join(", ");

    // Exportul duce TOATE rândurile filtrului, nu primele 300 ca ecranul:
    // pe ecran limita e ca să nu stea pagina, într-un fișier ar fi o tăiere
    // tăcută exact a cozii pe care omul voia s-o vadă.
    const foaie = {
      nume: "Parteneri",
      coloane: [
        { titlu: "Nume", cheie: "nume", tip: "text", latime: 42 },
        { titlu: "Tip", cheie: "tip", tip: "text", latime: 16 },
        { titlu: "Stare", cheie: "stare", tip: "text", latime: 16 },
        { titlu: "CUI", cheie: "cui", tip: "text", latime: 14 },
        { titlu: "Email", cheie: "email", tip: "text", latime: 26 },
        { titlu: "Telefon", cheie: "telefon", tip: "text", latime: 16 },
        { titlu: "Agent", cheie: "agent", tip: "text", latime: 20 },
        { titlu: "Firma cu care a lucrat", cheie: "firme", tip: "text", latime: 26 },
        { titlu: "Rulaj 12 luni (lei, cu TVA)", cheie: "rulaj", tip: "bani", latime: 20 },
        { titlu: "De încasat (lei, cu TVA)", cheie: "sold", tip: "bani", latime: 20 },
        { titlu: "Ultima factură", cheie: "ultima", tip: "data", latime: 15 },
      ],
      randuri: randuri.map((r) => ({
        nume: r.nume,
        tip: TIP_LABEL[r.tip] || r.tip,
        stare: STARE_LABEL[r.stare] || r.stare || "",
        cui: r.cui || "",
        email: r.email || "",
        telefon: r.telefon || "",
        agent: r.agent || "",
        firme: firmeText(r.firme),
        rulaj: Number(r.rulaj) || 0,
        sold: Number(r.sold) || 0,
        ultima: r.ultima ? String(r.ultima).slice(0, 10) : "",
      })),
    };

    // A doua foaie spune ce filtru era pus și când. Fără ea, peste o lună
    // nimeni nu mai știe dacă fișierul de pe disc e „toți partenerii" sau
    // „furnizorii Warehouse All" — și se trag concluzii din el oricum.
    const acum = new Date().toISOString().slice(0, 16).replace("T", " ");
    const filtre = {
      nume: "Cum a fost scos",
      coloane: [
        { titlu: "Ce", cheie: "ce", tip: "text", latime: 30 },
        { titlu: "Valoare", cheie: "val", tip: "text", latime: 60 },
      ],
      randuri: [
        { ce: "Scos din", val: "ERP Cash Machine, pagina Parteneri" },
        { ce: "Data și ora", val: acum },
        { ce: "Scos de", val: ctx.user.nume || ctx.user.email || "administrator" },
        { ce: "Filtru tip", val: tip === "client" ? "doar clienți" : tip === "furnizor" ? "doar furnizori" : "toți partenerii" },
        { ce: "Căutare", val: cauta || "(fără)" },
        { ce: "Firma cu care a lucrat", val: firmaCeruta ? numeFirma.get(String(firmaCeruta)) || String(firmaCeruta) : "oricare" },
        { ce: "Parteneri în fișier", val: String(randuri.length) },
        { ce: "Rulaj = ", val: "facturat în ultimele 12 luni, cu TVA, fără facturile dintre firmele grupului" },
        { ce: "De încasat = ", val: "facturi de vânzare emise și neîncasate, cu TVA, la data exportului" },
        { ce: "Nu sunt incluși", val: "partenerii marcați ca ignorați (Configurări → Parteneri ignorați)" },
      ],
    };

    const buf = XLS.carte([foaie, filtre]);
    const eticheta = tip === "client" ? "clienti" : tip === "furnizor" ? "furnizori" : "parteneri";
    send(ctx.res, 200, buf, XLS.antete(`${eticheta}-cash-machine-${acum.slice(0, 10)}`, buf.length));
  });

  registerCrud(router, {
    path: "/parteneri",
    table: "parteneri",
    title: "Parteneri (clienți & furnizori)",
    singular: "partener",
    fields: [
      {
        name: "tip",
        label: "Tip",
        type: "select",
        required: true,
        default: "client",
        options: [
          { value: "client", label: "Client" },
          { value: "furnizor", label: "Furnizor" },
          { value: "ambele", label: "Client & Furnizor" },
        ],
      },
      { name: "nume", label: "Nume / denumire firmă", required: true },
      { name: "cui", label: "CUI / CIF" },
      { name: "email", label: "Email", type: "email" },
      { name: "telefon", label: "Telefon" },
      { name: "persoana_contact", label: "Persoană de contact" },
      { name: "stare", label: "Stare", type: "select", default: "client_activ", options: STARE_OPTIONS },
      { name: "sursa", label: "Sursă (de unde a venit)" },
      { name: "data_nastere", label: "Zi de naștere persoană de contact (pentru urări)", type: "date" },
      { name: "adresa", label: "Adresă", type: "textarea" },
    ],
    listColumns: [
      { key: "nume", label: "Nume", render: (r) => `<a href="/parteneri/${r.id}">${esc(r.nume)}</a>` },
      { key: "tip", label: "Tip", render: (r) => esc(TIP_LABEL[r.tip] || r.tip) },
      { key: "stare", label: "Stare", render: (r) => esc(STARE_LABEL[r.stare] || r.stare || "—") },
      { key: "cui", label: "CUI" },
      { key: "email", label: "Email" },
      { key: "telefon", label: "Telefon" },
    ],
  });

  // ---- clientul scris pe loc, din formularul de comandă -------------------
  //
  // Cererea lui Vali, 27.10.2026: agentul e la client, firma nu e în bază, iar
  // până acum trebuia să plece din comandă, să facă partenerul, să se întoarcă
  // și s-o ia de la capăt.
  //
  // Clientul intră pe numele agentului care îl scrie — tot cererea lui. Fără
  // asta, firma ar rămâne „a nimănui": n-ar apărea în lista lui, iar
  // scadențele ei n-ar avea pe cine să blocheze.
  router.post("/parteneri/rapid", async (ctx) => {
    const raspunde = (stare, obiect) =>
      send(ctx.res, stare, JSON.stringify(obiect), { "Content-Type": "application/json; charset=utf-8" });
    if (!ctx.user) return raspunde(401, { eroare: "Nu ești autentificat." });

    const CN = require("../lib/client-nou");
    const v = CN.verifica(ctx.body || {});
    if (!v.ok) return raspunde(400, { gresite: v.gresite });

    // Căutarea dublurii se face pe TOȚI partenerii, nu doar pe clienți: un
    // furnizor poate deveni și client, iar a doua fișă pe același CUI ar rupe
    // în două soldul firmei.
    const existenti = await db.prepare("SELECT id, nume, cui, tip, agent_id FROM parteneri").all().catch(() => []);
    const gasit = CN.gaseste(existenti, v.date);
    if (gasit) {
      const p = gasit.partener;
      // Un furnizor care începe să cumpere devine „ambele", nu al doilea rând.
      if (String(p.tip) === "furnizor") {
        await db.prepare("UPDATE parteneri SET tip = 'ambele' WHERE id = ?").run(p.id).catch(() => null);
      }
      // Firma fără stăpân se ia de cine o aduce. Dacă are deja un agent, NU
      // i-l luăm: clientul colegului nu se mută dintr-o comandă.
      if (!p.agent_id) {
        await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(ctx.user.id, p.id).catch(() => null);
      }
      return raspunde(200, {
        id: Number(p.id), nume: p.nume, cui: p.cui || "", reutilizat: true, dupa: gasit.dupa,
        alAltuia: Boolean(p.agent_id) && Number(p.agent_id) !== Number(ctx.user.id),
      });
    }

    const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
    const ins = await db
      .prepare(
        `INSERT INTO parteneri (tip, nume, cui, email, telefon, persoana_contact, adresa, stare, sursa, agent_id, creat_la)
         VALUES ('client', ?, ?, ?, ?, ?, ?, 'client_activ', ?, ?, ?) RETURNING id`
      )
      .run(
        v.date.nume,
        v.date.cui || null,
        v.date.email || null,
        v.date.telefon || null,
        v.date.persoana_contact || null,
        v.date.adresa || null,
        "comandă",
        ctx.user.id,
        acum
      )
      .catch(() => null);
    if (!ins) return raspunde(500, { gresite: ["Nu am putut scrie clientul. Încearcă din nou."] });
    console.log(`[parteneri] client nou din comandă: ${v.date.nume} (${v.date.cui || "fără CUI"}) — ${ctx.user.nume || ctx.user.email}`);
    return raspunde(200, { id: Number(ins.lastInsertRowid), nume: v.date.nume, cui: v.date.cui || "", reutilizat: false });
  });

  // Schimbarea agentului responsabil — permisă doar administratorului.
  router.post("/parteneri/:id/agent", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, `/parteneri/${ctx.params.id}`);
    const agentId = parseInt(ctx.body.agent_id, 10);
    await db.prepare("UPDATE parteneri SET agent_id = ? WHERE id = ?").run(Number.isFinite(agentId) && agentId > 0 ? agentId : null, ctx.params.id);
    redirect(ctx.res, `/parteneri/${ctx.params.id}`);
  });

  // Mai multe persoane de contact pe aceeași firmă, scrise dintr-o dată de pe
  // fișa ei. Până acum se putea doar una pe rând, din Marketing → Contacte, cu
  // numele firmei tastat din nou — de unde și contactele rămase nelegate de
  // nicio fișă. Logica (cine e deja acolo, ce se completează) stă în marketing,
  // lângă restul lucrurilor despre oameni; se cere la apel, nu sus, ca cele
  // două module să nu se ceară în cerc.
  router.post("/parteneri/:id/contacte", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const lista = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const nume = lista(b["c_nume[]"]);
    const functii = lista(b["c_functie[]"]);
    const emailuri = lista(b["c_email[]"]);
    const telefoane = lista(b["c_telefon[]"]);
    const randuri = nume.map((_, i) => ({
      nume: nume[i],
      functie: functii[i],
      email: emailuri[i],
      telefon: telefoane[i],
    }));
    const r = await require("./marketing")
      .adaugaContacte({ partenerId: id, randuri, userId: ctx.user ? ctx.user.id : null })
      .catch(() => ({ adaugati: 0, completati: 0 }));
    redirect(ctx.res, `/parteneri/${id}?contacte=${r.adaugati}&completate=${r.completati}`);
  });

  // Pagină de detaliu — istoricul complet al unui partener: comenzi, facturi
  // (vânzare & achiziție), oportunități CRM și interacțiuni/follow-up-uri.
  // Înregistrată după registerCrud, ca să nu intre în conflict cu rutele
  // literale /parteneri/nou, /parteneri/:id/editare etc.
  router.get("/parteneri/:id", async (ctx) => {
    const partener = await db
      .prepare("SELECT p.*, u.nume AS agent_nume FROM parteneri p LEFT JOIN utilizatori u ON u.id = p.agent_id WHERE p.id = ?")
      .get(ctx.params.id);
    if (!partener) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/parteneri", body: "<p>Partener inexistent.</p>" }));

    const comenzi = await db.prepare("SELECT id, numar, status, data FROM comenzi WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    // Scadența și restul de încasat intră în listă: fișa clientului e locul de
    // unde agentul sună, iar „emisă" fără scadență nu-i spune dacă are de ce.
    const facturi = await db
      .prepare(
        `SELECT f.id, f.serie, f.numar, f.document_extern, f.directie, f.status, f.data_emiterii, f.data_scadenta,
                COALESCE(t.total,0) - COALESCE(pl.platit,0) AS rest
           FROM (SELECT * FROM facturi WHERE activ = 1) f
           LEFT JOIN (SELECT factura_id, SUM(cantitate * pret_unitar * (1 + COALESCE(cota_tva,0)/100.0)) AS total
                        FROM facturi_linii GROUP BY factura_id) t ON t.factura_id = f.id
           LEFT JOIN (SELECT factura_id, SUM(suma) AS platit FROM (SELECT * FROM plati WHERE activ = 1) x
                        GROUP BY factura_id) pl ON pl.factura_id = f.id
          WHERE f.partener_id = ?
          ORDER BY f.id DESC`
      )
      .all(partener.id);

    const aziISO = new Date().toISOString().slice(0, 10);
    const eIntarziata = (f) => {
      const s = String(f.data_scadenta || "").slice(0, 10);
      return (
        !!s &&
        s < aziISO &&
        Number(f.rest || 0) > 0.5 &&
        f.status !== "anulata" &&
        f.status !== "platita" &&
        f.status !== "ciorna"
      );
    };
    const intarziateleLui = facturi.filter(eIntarziata);
    const scadentaCelula = (f) => {
      const s = String(f.data_scadenta || "").slice(0, 10);
      if (!s) return '<span style="color:var(--text-muted)">—</span>';
      if (!eIntarziata(f)) return esc(s);
      const zile = Math.max(1, Math.round((Date.parse(aziISO) - Date.parse(s)) / 86400000));
      const culoare = zile > 90 ? "var(--danger)" : zile > 7 ? "var(--warn)" : "var(--text)";
      return `<span style="color:${culoare}">${esc(s)}<br><span style="font-size:11px">${zile} ${
        zile === 1 ? "zi" : "zile"
      } întârziere</span></span>`;
    };
    const oportunitati = await db.prepare("SELECT * FROM oportunitati WHERE partener_id = ? ORDER BY id DESC").all(partener.id);
    const taskuriPartener = await db.prepare(`${tsk.SELECT_TASK} WHERE t.partener_id = ? ORDER BY t.id DESC LIMIT 50`).all(partener.id);
    const emailuriPartener = await db.prepare("SELECT id, subiect, catre, status, trimis_la FROM emailuri WHERE partener_id = ? ORDER BY id DESC LIMIT 50").all(partener.id);
    // Oamenii firmei, cu funcția lor. Se cere târziu, nu sus cu celelalte
    // module, ca să nu se lege marketing.js și parteneri.js în cerc.
    const blocOameni = await require("./marketing")
      .blocContacte({ partenerId: partener.id, numePartener: partener.nume, user: ctx.user })
      .catch(() => "");
    const utilizatoriActivi = await db.prepare("SELECT id, nume FROM utilizatori WHERE activ = 1 ORDER BY nume").all();
    const interactiuni = await db
      .prepare("SELECT i.*, u.nume AS agent FROM interactiuni i LEFT JOIN utilizatori u ON u.id = i.utilizator_id WHERE i.partener_id = ? ORDER BY i.data DESC, i.id DESC")
      .all(partener.id);

    const alocare = await alocari.alocariPentruPartener(partener.id);
    const alocareLinii = alocare.linii;
    const alocareExplicita = alocare.explicite;
    const utilizatoriAlocabili = await db
      .prepare("SELECT id, nume, rol FROM utilizatori WHERE activ = 1 AND rol IN ('admin','vanzari') ORDER BY rol DESC, nume")
      .all();

    // Semaforul de încasări al clientului, cu comanda adminului de a tăia
    // notificările pe el (client în insolvență, înțelegere separată etc).
    let blocSemafor = "";
    try {
      const st = await require("./scadente").stareClient(partener.id);
      const eticheta = { verde: "la zi", galben: "întârziere mică", rosu: "restanță" }[st.stare];
      blocSemafor = `
        <div style="margin-top:12px;font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span>Încasări:</span>
          <span class="badge ${st.stare}">${esc(eticheta)}</span>
          ${st.sold > 0.5 ? `<span>sold restant <strong>${money(st.sold)}</strong>${st.zileMax > 0 ? `, cea mai veche factură de ${st.zileMax} zile` : ""}</span>` : "<span>fără sold restant</span>"}
          ${st.stare === "rosu" ? `<span style="color:var(--danger)">agenții nu pot plasa comenzi pentru el</span>` : ""}
          ${
            ctx.user && ctx.user.rol === "admin"
              ? `<form method="post" action="/parteneri/${partener.id}/notificari" class="inline-form">
                   <input type="hidden" name="oprite" value="${Number(partener.notificari_oprite) === 1 ? 0 : 1}">
                   <button class="btn small secondary" type="submit">${Number(partener.notificari_oprite) === 1 ? "reia notificările" : "oprește notificările"}</button>
                 </form>`
              : Number(partener.notificari_oprite) === 1
                ? `<span class="badge gri">notificări oprite de admin</span>`
                : ""
          }
          <a class="btn small secondary" href="/scadente">vezi scadențarul</a>
        </div>`;
    } catch (e) {
      blocSemafor = "";
    }

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Tip</div>${esc(TIP_LABEL[partener.tip] || partener.tip)}</div>
          <div><div class="k">Stare</div>${esc(STARE_LABEL[partener.stare] || partener.stare || "—")}</div>
          <div><div class="k">CUI</div>${esc(partener.cui) || "—"}</div>
          <div><div class="k">Email</div>${esc(partener.email) || "—"}</div>
          <div><div class="k">Telefon</div>${esc(partener.telefon) || "—"}</div>
          <div><div class="k">Persoană de contact</div>${esc(partener.persoana_contact) || "—"}</div>
          <div><div class="k">Sursă</div>${esc(partener.sursa) || "—"}</div>
          <div><div class="k">Adresă</div>${esc(partener.adresa) || "—"}</div>
        </div>
        <div class="toolbar" style="margin-top:10px">
          <a href="/parteneri/${partener.id}/editare" class="btn secondary small">Editează datele</a>
          <a href="/crm/email/nou?partener_id=${partener.id}" class="btn secondary small">✉ Trimite email</a>
          <a href="/taskuri/nou?partener_id=${partener.id}" class="btn secondary small">+ Task</a>
        </div>
        ${blocSemafor}
        <div style="margin-top:12px;font-size:13px">
          <div style="margin-bottom:6px">Alocare pe agenți (din asta se calculează comisionul):
            <strong>${alocareLinii.length ? alocareLinii.map((a) => `${esc(a.nume)} ${Number(a.procent).toFixed(0)}%`).join(" · ") : "nealocat"}</strong>
            ${alocareExplicita ? "" : `<span style="color:var(--text-muted)"> (implicit, din agentul responsabil)</span>`}
          </div>
          ${
            ctx.user && ctx.user.rol === "admin"
              ? `<div style="max-width:420px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-subtle,#f6f7f9)">
                   <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
                     Poți împărți clientul între mai mulți oameni — ex. 70% agentul care l-a adus, 30% administratorul.
                     Suma procentelor nu poate trece de 100%.
                   </div>
                   ${alocari.formularAlocare(partener.id, alocareLinii, utilizatoriAlocabili, true)}
                 </div>`
              : (() => {
                  // Agentul își poate lua singur clientul, exact ca în lista de
                  // alocare: dacă e liber sau dacă îl ține administratorul (acolo
                  // a ajuns la import, fiindcă nu se știa al cui e). De la un alt
                  // agent nu se ia — acolo hotărăște administratorul.
                  const alMeu = alocareLinii.some((a) => a.utilizator_id === ctx.user.id);
                  const laAdmin = alocareLinii.length > 0 && alocareLinii.every((a) => a.rol === "admin");
                  if (alMeu) return `<span style="color:var(--text-muted)">E în portofoliul tău.</span>`;
                  if (alocareLinii.length && !laAdmin)
                    return `<span style="color:var(--text-muted)">E în portofoliul altui agent — doar administratorul îl poate muta.</span>`;
                  return `<form method="post" action="/crm/alocare" style="margin-top:4px">
                            <input type="hidden" name="client" value="${partener.id}">
                            <input type="hidden" name="inapoi" value="/parteneri/${partener.id}">
                            <button type="submit" class="btn" onclick="return confirm('Îl iei în portofoliul tău?')">Ia clientul în portofoliul meu</button>
                            <div style="font-size:12px;color:var(--text-muted);margin-top:6px">
                              ${laAdmin ? "Acum e la administrator, fiindcă la import nu se știa al cui e." : "Clientul nu e alocat nimănui."}
                              Facturile lui — și cele vechi, de la ambele firme — trec pe numele tău și intră la comision.
                            </div>
                          </form>`;
                })()
          }
        </div>
      </div>

      <h2>Comenzi (${comenzi.length})</h2>
      ${table(
        ["Nr.", "Status", "Data"],
        comenzi.map((c) => [`<a href="/comenzi/${c.id}">${esc(c.numar || "#" + c.id)}</a>`, esc(c.status), esc(c.data)])
      )}

      <h2>Facturi (${facturi.length})${
        intarziateleLui.length
          ? ` <span class="badge rosu">${intarziateleLui.length} întârziate</span> <span style="font-size:14px;font-weight:400;color:var(--danger)">${money(
              intarziateleLui.reduce((s, f) => s + Number(f.rest || 0), 0)
            )}</span>`
          : ""
      }</h2>
      ${table(
        ["Document", "Direcție", "Status", "Data", "Scadența", "Rest"],
        facturi.map((f) => [
          `<a href="/facturi/${f.id}">${esc(f.document_extern || `${f.serie}-${f.numar ?? f.id}`)}</a>`,
          f.directie === "achizitie" ? "Achiziție" : "Vânzare",
          esc(f.status),
          esc(f.data_emiterii),
          scadentaCelula(f),
          Number(f.rest || 0) > 0.5 ? money(f.rest) : '<span style="color:var(--text-muted)">—</span>',
        ])
      )}

      <h2>Oportunități CRM (${oportunitati.length})</h2>
      ${table(
        ["Titlu", "Stadiu", "Valoare estimată"],
        oportunitati.map((o) => [`<a href="/crm/oportunitati/${o.id}">${esc(o.titlu)}</a>`, esc(o.stadiu), money(o.valoare_estimata)])
      )}
      <div class="toolbar"><a href="/crm/oportunitati/noua?partener_id=${partener.id}" class="btn secondary small">+ Oportunitate nouă</a></div>

      <h2>Task-uri (${taskuriPartener.length})</h2>
      ${
        taskuriPartener.length
          ? table(tsk.CAPETE, taskuriPartener.map((t) => tsk.randTask(t, new Date().toISOString().slice(0, 10))))
          : '<p style="color:var(--text-muted)">Niciun task pentru acest partener.</p>'
      }

      ${blocOameni}

      <h2>Emailuri trimise (${emailuriPartener.length})</h2>
      ${
        emailuriPartener.length
          ? table(
              ["Data", "Subiect", "Către", "Status"],
              emailuriPartener.map((e) => [
                esc((e.trimis_la || "").slice(0, 16)),
                `<a href="/crm/email/${e.id}">${esc(e.subiect)}</a>`,
                esc(e.catre),
                e.status === "trimis" ? '<span class="badge verde">trimis</span>' : `<span class="badge rosu">${esc(e.status)}</span>`,
              ])
            )
          : '<p style="color:var(--text-muted)">Niciun email trimis din aplicație.</p>'
      }

      <h2>Interacțiuni / istoric contact</h2>
      <form method="post" action="/parteneri/${partener.id}/interactiuni" class="form" style="max-width:520px">
        <label class="field"><span>Tip</span>
          <select name="tip">${INTERACTIUNE_MANUAL.map((v) => `<option value="${v}">${esc(INTERACTIUNE_LABEL[v])}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Subiect</span><input type="text" name="subiect"></label>
        <label class="field"><span>Descriere</span><textarea name="descriere" rows="2"></textarea></label>
        <label class="field"><span>Următorul contact (opțional)</span><input type="date" name="data_urmatoare_actiune"></label>
        <button type="submit" class="btn small">Adaugă</button>
      </form>
      ${table(
        ["Data", "Tip", "Subiect", "Descriere", "Următorul contact", "Cine"],
        interactiuni.map((i) => [
          esc(i.data),
          esc(INTERACTIUNE_LABEL[i.tip] || INTERACTIUNE_AUTO[i.tip] || i.tip),
          esc(i.subiect),
          esc(i.descriere),
          esc(i.data_urmatoare_actiune) || "—",
          esc(i.agent || "—"),
        ])
      )}
    `;
    // Emailurile schimbate cu partenerul, aduse din Gmail. Blocul se intoarce
    // gol daca nu e nimic sau daca omul n-are drept la casuta din care vin.
    const emailuri = await inbox.blocEmailuri({ user: ctx.user, partenerId: partener.id });
    send(ctx.res, 200, layout({ user: ctx.user, title: `Partener: ${partener.nume}`, active: "/parteneri", body: body + emailuri }));
  });

  router.post("/parteneri/:id/interactiuni", async (ctx) => {
    const { tip, subiect, descriere, data_urmatoare_actiune } = ctx.body;
    await db
      .prepare("INSERT INTO interactiuni (partener_id, tip, subiect, descriere, data_urmatoare_actiune, utilizator_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ctx.params.id, tip || "nota", subiect || "", descriere || "", data_urmatoare_actiune || null, ctx.user ? ctx.user.id : null);
    redirect(ctx.res, `/parteneri/${ctx.params.id}`);
  });
}

module.exports = { register, TIP_LABEL, STARE_LABEL };
