"use strict";
// Depozit · Recepție marfă.
//
// Patru drumuri duc marfă în depozit, și nu sunt același lucru:
//
//   furnizor          — am comandat, a venit. Lipsa e o reclamație.
//   producție         — am făcut-o noi. Lipsa e o pierdere de producție.
//   retur terț        — clientul a trimis marfa înapoi. Poate fi stricată.
//   retur fulfilment  — s-a întors din CT-Park. La fel.
//
// Până acum exista un singur buton, „Intră în stoc", care scria mișcarea și
// gata. Nu se știa cât s-a anunțat față de cât a venit, unde s-a pus marfa,
// sau în ce stare era un retur. Recepția e documentul care ține diferența
// aia — fără el, lipsa de la furnizor nu se vede nicăieri și nu se poate
// reclama.
//
// Regulile de validare NU stau aici, stau în lib/receptie.js, cu teste.
const db = require("../lib/db");
const { esc, money, layout, table, subnavDepozit } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const R = require("../lib/receptie");

const nr = (v) => Number(v || 0);
function azi() {
  return new Date().toISOString().slice(0, 10);
}
function acum() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
function text(v, max) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, max || 200) : null;
}
function poate(user) {
  return Boolean(user && ["admin", "depozit", "productie"].includes(user.rol));
}

const SURSA_ETICHETA = {
  furnizor: '<span class="badge gri">de la furnizor</span>',
  productie: '<span class="badge albastru">din producție</span>',
  retur_tert: '<span class="badge galben">retur de la client</span>',
  retur_fulfilment: '<span class="badge galben">retur din fulfilment</span>',
  inventar_initial: '<span class="badge albastru">stoc inițial</span>',
};
const STARE_ETICHETA = {
  asteptata: '<span class="badge gri">anunțată, neîncepută</span>',
  in_lucru: '<span class="badge galben">în lucru</span>',
  finalizata: '<span class="badge verde">finalizată</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};
const CONDITIE_ETICHETA = {
  bun: '<span class="badge verde">bună</span>',
  deteriorat: '<span class="badge rosu">deteriorată</span>',
  desfacut: '<span class="badge galben">desfăcută</span>',
  lipsa: '<span class="badge rosu">lipsă</span>',
};

async function numarNou() {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM receptii").get();
  return "REC-" + azi().replace(/-/g, "") + "-" + String(Number((r && r.n) || 0) + 1).padStart(3, "0");
}

async function liniile(receptieId) {
  return db
    .prepare(
      `SELECT l.*, p.denumire AS produs_denumire, p.unitate_masura, lo.cod AS loc_cod
         FROM receptii_linii l
         LEFT JOIN produse p ON p.id = l.produs_id
         LEFT JOIN locuri_depozit lo ON lo.id = l.loc_id
        WHERE l.receptie_id = ? ORDER BY l.id`
    )
    .all(receptieId);
}

// Creeaza o receptie. Folosita si din modules/productie.js, cand productia
// trimite marfa in depozit.
async function creeaza(date, linii) {
  const d = date || {};
  const numar = d.numar || (await numarNou());
  const ins = await db
    .prepare(
      `INSERT INTO receptii (numar, sursa, partener_id, depozit_id, aprovizionare_id, comanda_productie_id,
                             comanda_id, iesire_id, document_extern, data, stare, anuntata_de, observatii, creata_la)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'asteptata', ?, ?, ?) RETURNING id`
    )
    .run(
      numar,
      R.SURSE.includes(d.sursa) ? d.sursa : "furnizor",
      d.partener_id || null,
      d.depozit_id || null,
      d.aprovizionare_id || null,
      d.comanda_productie_id || null,
      d.comanda_id || null,
      d.iesire_id || null,
      text(d.document_extern, 120),
      d.data || azi(),
      text(d.anuntata_de, 120),
      text(d.observatii, 500),
      acum()
    );
  const id = ins.lastInsertRowid;
  for (const l of linii || []) {
    await db
      .prepare(
        `INSERT INTO receptii_linii (receptie_id, produs_id, produs_text, cantitate_asteptata, um, pret_unitar, stare)
         VALUES (?, ?, ?, ?, ?, ?, 'de_primit')`
      )
      .run(id, l.produs_id || null, text(l.produs_text, 200), nr(l.cantitate), text(l.um, 20), l.pret_unitar == null ? null : nr(l.pret_unitar));
  }
  return id;
}

// După finalizare: unde se pune marfa. Pentru fiecare rând bun, cât a venit,
// cât e deja în CT-Park (paleții legați de el, cu adresele) și cât mai e de
// pus — cu cele două drumuri: pe raft (Intrare marfă, cu tot completat) sau
// direct la livrare (ieșirea din CT-Park, cu avizul sau eticheta de ieșire).
async function sectiuneCtPark(r, linii) {
  if (r.stare !== "finalizata") return "";
  const bune = linii.filter((l) => l.stare === "primita" && (!l.conditie || l.conditie === "bun") && nr(l.cantitate_primita) > 0);
  if (!bune.length) return "";
  const ids = bune.map((l) => Number(l.id));
  const paleti = await db
    .prepare(
      `SELECT p.id, p.cod, p.cantitate, p.um, p.data_iesire, p.receptie_linie_id,
              (SELECT string_agg(lo.adresa, ' + ' ORDER BY lo.camp, lo.pozitie) FROM ct_ocupari o JOIN ct_locuri lo ON lo.id = o.loc_id WHERE o.palet_id = p.id) AS adrese,
              (SELECT i.destinatie FROM ct_iesiri i WHERE i.palet_id = p.id ORDER BY i.id DESC LIMIT 1) AS plecat_la
         FROM ct_paleti p WHERE p.receptie_linie_id IN (${ids.map(() => "?").join(",")}) ORDER BY p.id`
    )
    .all(...ids)
    .catch(() => []);
  const comenzi = await db
    .prepare(
      `SELECT c.id, c.numar, p.nume AS client FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
        WHERE c.status NOT IN ('anulata', 'livrata') ORDER BY c.id DESC LIMIT 200`
    )
    .all()
    .catch(() => []);
  const fmt = (v) => Number(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
  // Rândurile care n-au încă toată marfa pe paleți: pentru ele se fac paleții
  // și etichetele, mai jos (Vali, 10.11.2026).
  const faraPaleti = [];
  const randuri = bune.map((l) => {
    const ale = paleti.filter((p) => Number(p.receptie_linie_id) === Number(l.id));
    const pus = ale.reduce((s, p) => s + nr(p.cantitate), 0);
    const ramas = Math.round((nr(l.cantitate_primita) - pus) * 1000) / 1000;
    if (ramas > R.EPS && !l.ct_inchis_la) faraPaleti.push({ id: Number(l.id), nume: l.produs_denumire || l.produs_text || "—", ramas, um: l.um || l.unitate_masura || "" });
    const um = esc(l.um || l.unitate_masura || "");
    const unde = ale.length
      ? ale
          .map((p) =>
            `<a href="/stocuri/ct-park/palet/${p.id}">${esc(p.cod)}</a> · ${fmt(nr(p.cantitate))} ${esc(p.um || "")} · ${
              p.data_iesire
                ? `<span class="badge gri">plecat${p.plecat_la ? " la " + esc(p.plecat_la) : ""}</span>`
                : p.adrese
                  ? `<span class="badge albastru">${esc(p.adrese)}</span>`
                  : '<span class="badge galben">fără loc</span>'
            } <a href="/stocuri/ct-park/etichete?paleti=${p.id}" target="_blank" class="mic">etichetă</a>`
          )
          .join("<br>")
      : '<span style="color:var(--text-muted)">încă nimic</span>';
    // Scos din „Gata din producție" de depozit: nu mai e de pus (lib/gata-productie.js).
    const inchis = l.ct_inchis_la
      ? `<span class="badge gri">scos din listă${l.ct_inchis_de ? " de " + esc(l.ct_inchis_de) : ""}: ${esc(l.ct_motiv || "")}</span>`
      : "";
    const actiuni = inchis
      ? inchis
      : ramas > R.EPS
        ? `<a class="btn small" href="/stocuri/ct-park/intrare?receptie_linie=${l.id}">Pune în CT-Park →</a>
           <form method="post" action="/depozit/receptie/${r.id}/linie/${l.id}/livrare" class="inline-form" style="gap:6px;flex-wrap:wrap;margin-top:6px">
             <select name="destinatie" required aria-label="Unde pleacă">
               <option value="">direct la…</option>
               <option value="comanda"${r.comanda_id ? " selected" : ""}>comanda unui client</option>
               <option value="fulfillment">fulfillment</option>
               <option value="productie">producție</option>
             </select>
             <select name="comanda_id" aria-label="Comanda" style="max-width:220px">
               <option value="">— comanda —</option>
               ${comenzi.map((c) => `<option value="${c.id}"${Number(c.id) === Number(r.comanda_id) ? " selected" : ""}>${esc(c.numar || "#" + c.id)} · ${esc(c.client)}</option>`).join("")}
             </select>
             <button class="btn small secondary" type="submit">Direct la livrare →</button>
           </form>`
        : ramas < -R.EPS
          ? `<span class="badge galben">pus cu ${fmt(-ramas)} ${um} mai mult decât a venit</span>`
          : '<span class="badge verde">tot pus</span>';
    return [
      esc(l.produs_denumire || l.produs_text || "—") + (l.lot ? `<br><span class="mic">lot ${esc(l.lot)}</span>` : ""),
      `${fmt(nr(l.cantitate_primita))} ${um}`,
      unde,
      ramas > R.EPS && !inchis ? `<strong>${fmt(ramas)} ${um}</strong>` : "—",
      actiuni,
    ];
  });
  // „La recepție marfă să te asiguri că se generează etichete pentru fiecare
  // palet — se lipește pe palet, apoi se scanează și se pun pe rafturi."
  // Un singur formular pentru toate rândurile: câte un palet cu tot ce a
  // rămas, dacă omul nu scrie altceva.
  const formularPaleti = faraPaleti.length
    ? `<form method="post" action="/depozit/receptie/${r.id}/paleti" class="form" style="max-width:860px;margin:10px 0 16px;border-left:4px solid var(--primary)">
         <strong>Paleți și etichete</strong>
         <p class="explic" style="margin:0">
           Scrie cât e pe fiecare palet, cu plus între ei: <code>400 + 400 + 200</code>, sau <code>3 x 400</code>. Lăsat așa, se face un singur palet cu tot rândul.
           Fiecare palet primește codul lui și o etichetă cu cod de bare. O lipești pe palet, iar pe raft îl pui cu
           <a href="/stocuri/ct-park/scaner">scanerul</a>: scanezi paletul, scanezi locul, Efectuează.
         </p>
         ${faraPaleti
           .map(
             (x) => `<label class="field"><span>${esc(x.nume)} — de pus <strong>${fmt(x.ramas)} ${esc(x.um)}</strong></span>
               <input name="paleti_${x.id}" value="${esc(String(x.ramas).replace(".", ","))}" inputmode="text" autocomplete="off" placeholder="ex. 400 + 400 + 200 sau 3 x 400 — gol = fără paleți acum"></label>`
           )
           .join("")}
         <div class="form-actions"><button class="btn" type="submit">Fă paleții și scoate etichetele →</button></div>
       </form>`
    : "";
  return `
    <h3 style="margin-top:22px" id="ct-park">Unde pui marfa — CT-Park</h3>
    ${formularPaleti}
    <p class="explic" style="max-width:860px">
      Depozitul e unul singur, CT-Park. Pentru fiecare rând spune unde pui marfa: <strong>Pune în CT-Park</strong>
      deschide Intrarea marfă cu produsul, cantitatea, lotul, prețul și furnizorul deja scrise — alegi rândul, nivelul,
      câmpul și poziția, iar la final ies etichetele paleților. <strong>Direct la livrare</strong> nu o mai urcă pe raft:
      deschide ieșirea din CT-Park cu marfa bifată și destinația aleasă (comanda clientului, cu avizul, sau fulfillment).
    </p>
    ${table(["Produs", "A venit", "În CT-Park", "De pus", ""], randuri)}`;
}

function register(router) {
  // ---- Lista -------------------------------------------------------------
  router.get("/depozit/receptie", async (ctx) => {
    const filtru = String(ctx.query.stare || "deschise");
    const unde =
      filtru === "toate" ? "" : filtru === "deschise" ? "WHERE r.stare IN ('asteptata','in_lucru')" : "WHERE r.stare = ?";
    const args = filtru === "toate" || filtru === "deschise" ? [] : [filtru];
    const receptii = await db
      .prepare(
        `SELECT r.*, p.nume AS partener, cp.numar AS comanda_productie_numar,
                (SELECT COUNT(*) FROM receptii_linii l WHERE l.receptie_id = r.id) AS nr_linii,
                (SELECT COUNT(*) FROM receptii_linii l WHERE l.receptie_id = r.id AND l.stare <> 'de_primit') AS nr_gata
           FROM receptii r
           LEFT JOIN parteneri p ON p.id = r.partener_id
           LEFT JOIN comenzi_productie cp ON cp.id = r.comanda_productie_id
           ${unde}
           ORDER BY CASE r.stare WHEN 'asteptata' THEN 0 WHEN 'in_lucru' THEN 1 ELSE 2 END, r.id DESC
           LIMIT 200`
      )
      .all(...args);

    const randuri = receptii.map((r) => {
      const total = Number(r.nr_linii) || 0;
      const gata = Number(r.nr_gata) || 0;
      return [
        `<a href="/depozit/receptie/${r.id}">${esc(r.numar || "#" + r.id)}</a>`,
        SURSA_ETICHETA[r.sursa] || esc(r.sursa),
        esc(r.partener || r.comanda_productie_numar || "—"),
        esc(r.document_extern || "—"),
        esc(r.data || "—"),
        total ? `${gata}/${total} rânduri` : '<span class="badge rosu">fără rânduri</span>',
        STARE_ETICHETA[r.stare] || esc(r.stare),
      ];
    });

    const filtre = [
      ["deschise", "De făcut"],
      ["asteptata", "Anunțate"],
      ["finalizata", "Finalizate"],
      ["toate", "Toate"],
    ]
      .map(([v, et]) => `<a class="btn small ${filtru === v ? "" : "secondary"}" href="/depozit/receptie?stare=${v}">${esc(et)}</a>`)
      .join(" ");

    const body = `
      ${subnavDepozit("/depozit/receptie", ctx.user)}
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block;white-space:normal;max-width:760px;line-height:1.5">${esc(ctx.query.eroare)}</p>` : ""}
      ${ctx.query.ok ? `<p class="badge verde" style="display:inline-block;white-space:normal;max-width:760px;line-height:1.5">${esc(ctx.query.ok)}</p>` : ""}
      <p style="max-width:820px;color:var(--text-muted)">
        Tot ce intră în depozit trece pe aici: marfă de la furnizor, marfă terminată de producție, și ce se întoarce —
        de la client sau din fulfilment. Recepția se face <strong>rând cu rând</strong>: pe fiecare linie scrii cât ai
        primit <em>de fapt</em>. Diferența dintre cât s-a anunțat și cât a venit e exact lucrul pentru care există
        documentul ăsta — la furnizor, pe ea se face reclamația. După finalizare spui unde pui marfa în
        <a href="/stocuri/ct-park">CT-Park</a> (rând, nivel, câmp, poziție) sau o trimiți direct la livrare.
      </p>
      <div style="display:flex;gap:8px;align-items:center;margin:14px 0;flex-wrap:wrap">
        ${filtre}<span style="flex:1"></span>
        <a class="btn small secondary" href="/depozit/receptie/noua">Recepție nouă</a>
        <a class="btn small secondary" href="/stocuri/ct-park">Harta CT-Park</a>
      </div>
      ${table(["Număr", "De unde", "De la cine", "Document", "Data", "Rânduri", "Stare"], randuri)}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Recepție marfă", active: "/depozit/receptie", body }));
  });

  // ---- Recepție nouă, scrisă de mână -------------------------------------
  router.get("/depozit/receptie/noua", async (ctx) => {
    const parteneri = await db.prepare("SELECT id, nume FROM parteneri ORDER BY nume LIMIT 3000").all();
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY id").all();
    const body = `
      ${subnavDepozit("/depozit/receptie", ctx.user)}
      <p style="max-width:780px;color:var(--text-muted)">
        Pentru marfa care vine fără să fi fost anunțată în ERP: o livrare de la furnizor, un retur adus de client,
        ceva întors din fulfilment. Ce vine din producție apare singur aici, când producția apasă
        „Trimit în depozit".
      </p>
      <p style="max-width:780px;color:var(--text-muted)">
        <strong>Stoc inițial</strong> e pentru prima încărcare: marfa care era deja pe rafturi când ați pornit cu
        ERP-ul. Acolo nu se verifică o livrare, se <em>numără</em> — nu există „cât ar fi trebuit să vină", deci nu
        ți se cere să explici nicio diferență. Rămâne însă scris pe document că stocul ăla a venit dintr-o numărătoare,
        nu dintr-o cumpărare, ca să nu-l caute cineva peste un an într-o factură care nu există.
      </p>
      <form method="post" action="/depozit/receptie/noua" class="form" style="max-width:860px">
        <div style="display:grid;grid-template-columns:1.4fr 2fr 1fr;gap:14px">
          <label class="field"><span>De unde vine</span>
            <select name="sursa" required>
              <option value="furnizor">de la furnizor</option>
              <option value="retur_tert">retur de la client</option>
              <option value="retur_fulfilment">retur din fulfilment</option>
              <option value="productie">din producție</option>
              <option value="inventar_initial">stoc inițial (ce era deja pe rafturi)</option>
            </select></label>
          <label class="field"><span>De la cine</span>
            <select name="partener_id"><option value="">—</option>${parteneri.map((p) => `<option value="${p.id}">${esc(p.nume)}</option>`).join("")}</select></label>
          <label class="field"><span>Data</span><input type="date" name="data" value="${azi()}"></label>
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          <label class="field"><span>Document (aviz, factură, AWB)</span><input name="document_extern"></label>
          <label class="field"><span>Depozit</span>
            <select name="depozit_id">${depozite.map((d) => `<option value="${d.id}">${esc(d.denumire)}</option>`).join("")}</select></label>
        </div>
        <label class="field"><span>Observații</span><input name="observatii"></label>
        <button class="btn" type="submit">Deschide recepția</button>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Recepție nouă", active: "/depozit/receptie", body }));
  });

  router.post("/depozit/receptie/noua", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const b = ctx.body || {};
    const id = await creeaza(
      {
        sursa: b.sursa,
        partener_id: parseInt(b.partener_id, 10) || null,
        depozit_id: parseInt(b.depozit_id, 10) || null,
        document_extern: b.document_extern,
        data: text(b.data, 10) || azi(),
        anuntata_de: ctx.user.nume,
        observatii: b.observatii,
      },
      []
    );
    redirect(ctx.res, `/depozit/receptie/${id}`);
  });

  // ---- Fișa recepției: rând cu rând --------------------------------------
  router.get("/depozit/receptie/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const r = await db
      .prepare(
        `SELECT r.*, p.nume AS partener, cp.numar AS comanda_productie_numar, d.denumire AS depozit
           FROM receptii r
           LEFT JOIN parteneri p ON p.id = r.partener_id
           LEFT JOIN comenzi_productie cp ON cp.id = r.comanda_productie_id
           LEFT JOIN depozite d ON d.id = r.depozit_id
          WHERE r.id = ?`
      )
      .get(id);
    if (!r) return redirect(ctx.res, "/depozit/receptie");

    const linii = await liniile(id);
    const z = R.rezumat(linii);
    // Locul nu se mai alege dintr-o listă de coduri: depozitul e unul singur,
    // CT-Park, iar marfa se pune pe hartă după finalizare (secțiunea de jos).
    const produse = await db.prepare("SELECT id, denumire, unitate_masura FROM produse WHERE activ = 1 ORDER BY denumire LIMIT 3000").all();
    const retur = R.esteRetur(r.sursa);
    const inchisa = r.stare === "finalizata" || r.stare === "anulata";

    const randuri = linii.map((l) => {
      const denumire = l.produs_denumire || l.produs_text || "—";
      const asteptata = nr(l.cantitate_asteptata);
      const primita = l.cantitate_primita == null ? null : nr(l.cantitate_primita);
      const lipsa = primita == null ? null : Math.round((asteptata - primita) * 1000) / 1000;
      return [
        esc(denumire) + (l.lot ? `<br><span style="font-size:11px;color:var(--text-muted)">lot ${esc(l.lot)}</span>` : ""),
        `${asteptata} ${esc(l.um || l.unitate_masura || "")}`,
        inchisa
          ? primita == null
            ? "—"
            : `<strong>${primita}</strong>`
          : `<input form="lin-${l.id}" name="cantitate_primita" type="number" step="any" min="0"
                    value="${primita == null ? "" : primita}" style="width:92px" placeholder="cât a venit">`,
        primita == null
          ? "—"
          : lipsa > R.EPS
            ? `<span class="badge rosu">-${lipsa}</span>`
            : lipsa < -R.EPS
              ? `<span class="badge galben">+${Math.abs(lipsa)}</span>`
              : '<span class="badge verde">exact</span>',
        inchisa
          ? CONDITIE_ETICHETA[l.conditie] || esc(l.conditie || "—")
          : `<select form="lin-${l.id}" name="conditie" style="width:120px"${retur ? " required" : ""}>
               ${retur ? '<option value="">— alege —</option>' : ""}
               ${R.CONDITII.map((c) => `<option value="${c}"${String(l.conditie || (retur ? "" : "bun")) === c ? " selected" : ""}>${c}</option>`).join("")}
             </select>`,
        inchisa
          ? esc(l.motiv || "")
          : `<input form="lin-${l.id}" name="lot" value="${esc(l.lot || "")}" placeholder="lot" style="width:90px">
             <input form="lin-${l.id}" name="motiv" value="${esc(l.motiv || "")}" placeholder="dacă lipsește ceva, de ce" style="width:100%;min-width:150px;margin-top:3px">`,
        inchisa
          ? l.stare === "primita"
            ? '<span class="badge verde">primită</span>'
            : l.stare === "respinsa"
              ? '<span class="badge rosu">respinsă</span>'
              : '<span class="badge gri">neatinsă</span>'
          : `<form id="lin-${l.id}" method="post" action="/depozit/receptie/${r.id}/linie/${l.id}">
               <button class="btn small ${l.stare === "de_primit" ? "" : "secondary"}" type="submit">${l.stare === "de_primit" ? "Confirm rândul" : "Schimb"}</button>
             </form>
             <form method="post" action="/depozit/receptie/${r.id}/linie/${l.id}/sterge" class="inline-form">
               <button class="link-btn danger" type="submit" style="font-size:11px">Șterge</button>
             </form>`,
      ];
    });

    const body = `
      ${subnavDepozit("/depozit/receptie", ctx.user)}
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block;white-space:normal;max-width:760px;line-height:1.5">${esc(ctx.query.eroare)}</p>` : ""}
      ${ctx.query.ok ? `<p class="badge verde" style="display:inline-block;white-space:normal;max-width:760px;line-height:1.5">${esc(ctx.query.ok)}</p>` : ""}
      <div class="toolbar"><a class="btn secondary" href="/depozit/receptie">← Toate recepțiile</a></div>
      <h2 style="margin-top:0">${esc(r.numar || "Recepție #" + r.id)} ${SURSA_ETICHETA[r.sursa] || ""} ${STARE_ETICHETA[r.stare] || ""}</h2>
      <p style="color:var(--text-muted);margin-top:-6px">
        ${esc(r.partener || r.comanda_productie_numar || "—")}${r.document_extern ? " · " + esc(r.document_extern) : ""}
        ${r.data ? " · " + esc(r.data) : ""}${r.depozit ? " · " + esc(r.depozit) : ""}
        ${r.primita_de ? "<br>recepționată de " + esc(r.primita_de) + (r.finalizata_la ? " la " + esc(r.finalizata_la) : "") : ""}
      </p>
      ${
        r.sursa === "inventar_initial" && !inchisa
          ? `<p class="badge albastru" style="display:block;max-width:820px;white-space:normal;line-height:1.5">
               Încărcare de stoc inițial: scrie pe fiecare rând <strong>cât ai numărat pe raft</strong>. Coloana
               „anunțat" rămâne 0 — nimeni n-a anunțat nimic, fiindcă marfa era deja acolo.
             </p>`
          : ""
      }
      ${
        retur && !inchisa
          ? `<p class="badge galben" style="display:block;max-width:820px;white-space:normal;line-height:1.5">
               E marfă întoarsă. Pe fiecare rând trebuie spus în ce stare a venit: numai cea bună intră în stocul din
               care se vinde. Un retur necontrolat se vinde a doua oară și se întoarce a doua oară.
             </p>`
          : ""
      }
      ${
        linii.length
          ? `<p style="color:var(--text-muted)">${z.gata} din ${z.total} rânduri făcute${z.cuLipsa ? ` · <strong>${z.cuLipsa}</strong> cu lipsă` : ""}${z.stricate ? ` · <strong>${z.stricate}</strong> cu marfă stricată` : ""}</p>`
          : ""
      }
      ${table(["Produs", "Anunțat", "Primit", "Diferență", "Stare marfă", "Lot / de ce", ""], randuri)}
      ${await sectiuneCtPark(r, linii)}

      ${
        inchisa
          ? ""
          : `<details style="margin-top:14px"><summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Adaugă un rând</summary>
               <form method="post" action="/depozit/receptie/${r.id}/linie" class="form" style="max-width:820px;margin-top:10px">
                 <div style="display:grid;grid-template-columns:3fr 1fr 1fr 1fr;gap:12px">
                   <label class="field" style="margin:0"><span>Produs</span>
                     <select name="produs_id"><option value="">— scriu mai jos —</option>${produse.map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`).join("")}</select></label>
                   <label class="field" style="margin:0"><span>Cantitate anunțată</span><input type="number" step="any" name="cantitate" required></label>
                   <label class="field" style="margin:0"><span>UM</span><input name="um" placeholder="buc"></label>
                   <label class="field" style="margin:0"><span>Preț unitar</span><input type="number" step="0.0001" name="pret_unitar"></label>
                 </div>
                 <label class="field"><span>…sau produs scris liber</span><input name="produs_text"></label>
                 <button class="btn small" type="submit">Adaugă rândul</button>
               </form>
             </details>

             <div class="toolbar" style="margin-top:18px">
               <form method="post" action="/depozit/receptie/${r.id}/finalizeaza" class="inline-form">
                 <button class="btn" type="submit">Finalizează recepția și scrie stocul</button>
               </form>
               <form method="post" action="/depozit/receptie/${r.id}/anuleaza" class="inline-form" onsubmit="return confirm('Anulezi recepția? Nu se scrie nimic pe stoc.')">
                 <button class="link-btn danger" type="submit">Anulează</button>
               </form>
             </div>
             <p style="font-size:12px;color:var(--text-muted);max-width:760px">
               Finalizarea scrie mișcările de stoc. Se face o singură dată: dacă apeși din nou, ERP-ul refuză, fiindcă
               a doua scriere ar dubla marfa pe stoc.
             </p>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: r.numar || "Recepție", active: "/depozit/receptie", body }));
  });

  // ---- Un rând ------------------------------------------------------------
  router.post("/depozit/receptie/:id/linie", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const produsId = parseInt(b.produs_id, 10) || null;
    const liber = text(b.produs_text, 200);
    const cant = R.cifra(b.cantitate);
    if ((!produsId && !liber) || cant == null || cant < 0) return redirect(ctx.res, `/depozit/receptie/${id}`);
    await db
      .prepare(
        `INSERT INTO receptii_linii (receptie_id, produs_id, produs_text, cantitate_asteptata, um, pret_unitar, stare)
         VALUES (?, ?, ?, ?, ?, ?, 'de_primit')`
      )
      .run(id, produsId, liber, cant, text(b.um, 20), R.cifra(b.pret_unitar));
    redirect(ctx.res, `/depozit/receptie/${id}`);
  });

  router.post("/depozit/receptie/:id/linie/:lid", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10);
    const lid = parseInt(ctx.params.lid, 10);
    const r = await db.prepare("SELECT * FROM receptii WHERE id = ?").get(id);
    if (!r) return redirect(ctx.res, "/depozit/receptie");
    if (r.stare === "finalizata" || r.stare === "anulata") {
      return redirect(ctx.res, `/depozit/receptie/${id}?eroare=` + encodeURIComponent("Recepția e închisă; rândurile nu se mai schimbă."));
    }
    const l = await db.prepare("SELECT * FROM receptii_linii WHERE id = ? AND receptie_id = ?").get(lid, id);
    if (!l) return redirect(ctx.res, `/depozit/receptie/${id}`);

    // Locul nu se mai cere pe rând: marfa se pune în CT-Park după
    // finalizare, pe hartă, sau pleacă direct la livrare.
    const v = R.validareLinie(l, ctx.body || {}, { sursa: r.sursa, cereLoc: false });
    if (v.eroare) {
      return redirect(ctx.res, `/depozit/receptie/${id}?eroare=` + encodeURIComponent(v.eroare.slice(0, 220)));
    }
    // Un palet lat sta pe mai multe locuri. Cand receptia a fost deschisa
    // din harta, locurile sunt deja alese si se pun pe fiecare rand — omul
    // le-a aratat cu degetul o data, n-are de ce sa le mai caute in lista.
    const dinHarta = String(r.locuri_alese || "").split(",").map((x) => parseInt(x, 10)).filter(Boolean);
    const locuri = dinHarta.length ? dinHarta : v.loc_id ? [v.loc_id] : [];
    await db
      .prepare(
        `UPDATE receptii_linii SET cantitate_primita = ?, loc_id = ?, lot = ?, conditie = ?, motiv = ?, stare = ?
          WHERE id = ? AND receptie_id = ?`
      )
      .run(v.cantitate_primita, locuri[0] || v.loc_id, v.lot, v.conditie, v.motiv, v.stare, lid, id);
    await db.prepare("DELETE FROM receptii_linii_locuri WHERE linie_id = ?").run(lid).catch(() => {});
    for (const locId of locuri) {
      await db
        .prepare("INSERT INTO receptii_linii_locuri (linie_id, loc_id) VALUES (?, ?)")
        .run(lid, locId)
        .catch(() => {});
    }
    // Prima linie atinsa muta receptia din „anuntata" in „in lucru": altfel
    // nu se vede, pe lista, ca a inceput cineva s-o faca.
    if (r.stare === "asteptata") {
      await db.prepare("UPDATE receptii SET stare = 'in_lucru', primita_de = ? WHERE id = ?").run(ctx.user.nume, id);
    }
    const spune =
      v.lipsa_reala
        ? "Rând salvat: lipsesc " + v.lipsa + "."
        : v.in_plus > R.EPS
          ? "Rând salvat: " + v.in_plus + " în plus față de cât s-a anunțat."
          : "Rând salvat.";
    redirect(ctx.res, `/depozit/receptie/${id}?ok=` + encodeURIComponent(spune));
  });

  router.post("/depozit/receptie/:id/linie/:lid/sterge", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10);
    const r = await db.prepare("SELECT stare FROM receptii WHERE id = ?").get(id);
    if (r && (r.stare === "finalizata" || r.stare === "anulata")) {
      return redirect(ctx.res, `/depozit/receptie/${id}?eroare=` + encodeURIComponent("Recepția e închisă."));
    }
    await db.prepare("DELETE FROM receptii_linii WHERE id = ? AND receptie_id = ?").run(parseInt(ctx.params.lid, 10), id);
    redirect(ctx.res, `/depozit/receptie/${id}`);
  });

  // ---- Finalizarea: aici se scrie stocul ---------------------------------
  router.post("/depozit/receptie/:id/finalizeaza", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10);
    const r = await db.prepare("SELECT id FROM receptii WHERE id = ?").get(id);
    if (!r) return redirect(ctx.res, "/depozit/receptie");
    const f = await finalizeaza(id, ctx.user);
    if (f.eroare) return redirect(ctx.res, `/depozit/receptie/${id}?eroare=` + encodeURIComponent(f.eroare.slice(0, 220)));
    redirect(
      ctx.res,
      `/depozit/receptie/${id}?ok=` +
        encodeURIComponent(f.mesaj + (f.scrise ? " Acum fă, mai jos, paleții și etichetele lor — sau spune direct unde pui marfa în CT-Park, ori trimite-o la livrare." : "")) +
        (f.scrise ? "#ct-park" : "")
    );
  });

  // Direct la livrare: marfa nu urcă pe raft. Se face paletul ei, fără loc,
  // legat de recepție, și se deschide ieșirea din CT-Park cu el bifat și cu
  // destinația aleasă — acolo iese avizul (la comandă) sau eticheta de ieșire.
  router.post("/depozit/receptie/:id/linie/:lid/livrare", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10);
    const lid = parseInt(ctx.params.lid, 10);
    const b = ctx.body || {};
    const x = await livrareDirecta(ctx.user, id, lid, b.destinatie, b.comanda_id);
    if (x.eroare) {
      return redirect(ctx.res, x.faraReceptie ? "/depozit/receptie" : `/depozit/receptie/${id}?eroare=` + encodeURIComponent(x.eroare));
    }
    redirect(ctx.res, x.url);
  });

  router.post("/depozit/receptie/:id/anuleaza", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10);
    const r = await db.prepare("SELECT stare FROM receptii WHERE id = ?").get(id);
    if (r && r.stare === "finalizata") {
      return redirect(
        ctx.res,
        `/depozit/receptie/${id}?eroare=` +
          encodeURIComponent("Recepția e finalizată, stocul e deja scris. Anularea ar lăsa marfa pe stoc fără document.")
      );
    }
    await db.prepare("UPDATE receptii SET stare = 'anulata' WHERE id = ?").run(id);
    // O recepție din producție anulată: comanda de producție nu mai are
    // trimiterea în depozit, deci se poate trimite din nou din fișa ei.
    await db
      .prepare("UPDATE comenzi_productie SET trimisa_depozit_la = NULL, receptie_id = NULL WHERE receptie_id = ?")
      .run(id)
      .catch(() => {});
    redirect(ctx.res, "/depozit/receptie");
  });

  // AICI A FOST o a doua hartă de depozit, pe care am construit-o fiindcă
  // depozitul propriu n-avea rafturi definite. Vali a cerut s-o scot: harta
  // care contează e cea din CT-Park (/stocuri/ct-park), care exista deja,
  // are structura reală a halei — rânduri, niveluri cu înălțimi proprii,
  // câmpuri — și pe care lucrează oamenii. Două hărți care arată același
  // lucru în două feluri sunt mai rele decât una singură: oricare ar fi
  // greșită, cineva s-ar uita la cealaltă.
  //
  // Alegerea locurilor cu degetul, paletul lat pe mai multe locuri lipite și
  // intrarea de marfă direct pe locurile alese stau ACUM în modules/ct-park.js,
  // pe harta rândului. Ce a rămas aici e lista simplă de locuri, folosită de
  // recepție pentru depozitul propriu.

  // ---- Locurile din depozit ------------------------------------------------
  router.get("/depozit/locuri", async (ctx) => {
    const locuri = await db
      .prepare(
        `SELECT l.*, d.denumire AS depozit,
                (SELECT COUNT(*) FROM receptii_linii rl WHERE rl.loc_id = l.id) AS folosit
           FROM locuri_depozit l LEFT JOIN depozite d ON d.id = l.depozit_id
          ORDER BY l.cod LIMIT 1000`
      )
      .all();
    const depozite = await db.prepare("SELECT id, denumire FROM depozite ORDER BY id").all();
    const randuri = locuri.map((l) => [
      esc(l.cod) + (Number(l.blocat) ? ' <span class="badge rosu">blocat</span>' : ""),
      esc(l.zona || "—"),
      esc(l.raft || "—"),
      esc(l.nivel || "—"),
      esc(l.categorie || "—"),
      esc(l.depozit || "—"),
      Number(l.folosit) ? `${l.folosit} recepții` : "—",
      `<form method="post" action="/depozit/locuri/${l.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi locul?')"><button class="link-btn danger" type="submit">Șterge</button></form>`,
    ]);
    const body = `
      ${subnavDepozit("/depozit/receptie", ctx.user)}
      <p style="max-width:820px;color:var(--text-muted)">
        Rafturile din depozitul propriu. Se scriu o dată și de-atunci se aleg dintr-o listă la recepție. CT-Park are
        structura lui separată (rânduri, niveluri, câmpuri) — asta e pentru depozitul nostru, unde până acum
        răspunsul la „unde e marfa" era „pe undeva".
      </p>
      ${table(["Cod", "Zonă", "Raft", "Nivel", "Categorie", "Depozit", "Folosit", ""], randuri)}
      <h3 style="margin-top:24px">Adaugă un loc</h3>
      <form method="post" action="/depozit/locuri" class="form" style="max-width:860px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1.4fr;gap:12px">
          <label class="field" style="margin:0"><span>Cod</span><input name="cod" required placeholder="A-01-2"></label>
          <label class="field" style="margin:0"><span>Zonă</span><input name="zona" placeholder="Hala 1"></label>
          <label class="field" style="margin:0"><span>Raft</span><input name="raft"></label>
          <label class="field" style="margin:0"><span>Nivel</span><input name="nivel"></label>
          <label class="field" style="margin:0"><span>Depozit</span>
            <select name="depozit_id">${depozite.map((d) => `<option value="${d.id}">${esc(d.denumire)}</option>`).join("")}</select></label>
        </div>
        <label class="field"><span>Ce se ține aici</span>
          <select name="categorie">
            <option value="">— orice —</option>
            <option>materie primă</option>
            <option>produs intermediar</option>
            <option>produs finit</option>
            <option>ambalaje</option>
            <option>consumabile</option>
          </select></label>
        <button class="btn" type="submit">Adaugă</button>
      </form>
      <details style="margin-top:18px"><summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Generează mai multe locuri deodată</summary>
        <form method="post" action="/depozit/locuri/serie" class="form" style="max-width:760px;margin-top:10px">
          <p style="font-size:12px;color:var(--text-muted);max-width:620px">
            Scrie zona și câte rânduri, etaje și locuri pe etaj sunt; ies codurile de forma
            <code>A-01-2-3</code> = zona A, rândul 1, etajul 2, al treilea palet pe etaj. Cele care există deja
            se sar, deci se poate rula de două ori fără să facă dubluri. Harta pe care se dă click ca să alegi
            locurile e cea din <a href="/stocuri/ct-park">CT-Park</a>.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1.4fr;gap:12px">
            <label class="field" style="margin:0"><span>Prefix</span><input name="prefix" required value="A"></label>
            <label class="field" style="margin:0"><span>Câte rafturi</span><input type="number" name="rafturi" min="1" max="200" required value="10"></label>
            <label class="field" style="margin:0"><span>Câte etaje</span><input type="number" name="niveluri" min="1" max="20" required value="4"></label>
            <label class="field" style="margin:0"><span>Câți paleți încap pe un etaj</span><input type="number" name="locuri" min="1" max="20" required value="3"></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px">
            <label class="field" style="margin:0"><span>Zonă</span><input name="zona" placeholder="Hala 1"></label>
            <label class="field" style="margin:0"><span>Ce se ține aici</span>
              <select name="categorie">
                <option value="">— orice —</option>
                <option>materie primă</option>
                <option>produs intermediar</option>
                <option>produs finit</option>
                <option>ambalaje</option>
                <option>consumabile</option>
              </select></label>
          </div>
          <button class="btn small" type="submit">Generează</button>
        </form>
      </details>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Locuri în depozit", active: "/depozit/receptie", body }));
  });

  router.post("/depozit/locuri", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/locuri");
    const b = ctx.body || {};
    const cod = text(b.cod, 40);
    if (!cod) return redirect(ctx.res, "/depozit/locuri");
    const e = await db.prepare("SELECT id FROM locuri_depozit WHERE cod = ?").get(cod);
    if (e) return redirect(ctx.res, "/depozit/locuri");
    await db
      .prepare("INSERT INTO locuri_depozit (depozit_id, cod, zona, raft, nivel, categorie, blocat, creat_la) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
      .run(parseInt(b.depozit_id, 10) || null, cod, text(b.zona, 60), text(b.raft, 20), text(b.nivel, 20), text(b.categorie, 80), azi());
    redirect(ctx.res, "/depozit/locuri");
  });

  router.post("/depozit/locuri/serie", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/locuri");
    const b = ctx.body || {};
    const prefix = (text(b.prefix, 10) || "A").toUpperCase();
    const rafturi = Math.min(200, Math.max(1, parseInt(b.rafturi, 10) || 1));
    const niveluri = Math.min(20, Math.max(1, parseInt(b.niveluri, 10) || 1));
    const zona = text(b.zona, 60);
    const depozit = await db.prepare("SELECT id FROM depozite ORDER BY id LIMIT 1").get();
    let puse = 0;
    const locPeEtaj = Math.min(20, Math.max(1, parseInt(b.locuri, 10) || 1));
    for (let rf = 1; rf <= rafturi; rf++) {
      for (let nv = 1; nv <= niveluri; nv++) {
        for (let pz = 1; pz <= locPeEtaj; pz++) {
        const cod = locPeEtaj > 1 ? `${prefix}-${String(rf).padStart(2, "0")}-${nv}-${pz}` : `${prefix}-${String(rf).padStart(2, "0")}-${nv}`;
        const e = await db.prepare("SELECT id FROM locuri_depozit WHERE cod = ?").get(cod);
        if (e) continue;
        await db
          .prepare(
            `INSERT INTO locuri_depozit (depozit_id, cod, zona, raft, nivel, rand_nr, nivel_nr, pozitie_nr, categorie, blocat, creat_la)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
          )
          .run(depozit ? depozit.id : null, cod, zona || prefix, String(rf), String(nv), rf, nv, pz, text(b.categorie, 80), azi());
        puse++;
        }
      }
    }
    redirect(ctx.res, "/depozit/locuri");
  });

  router.post("/depozit/locuri/:id/sterge", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/depozit/locuri");
    const id = parseInt(ctx.params.id, 10);
    // Un loc folosit pe o receptie nu se sterge: randul ala ar ramane fara
    // raspuns la „unde e marfa", ceea ce e exact ce incercam sa evitam.
    const folosit = await db.prepare("SELECT COUNT(*) AS n FROM receptii_linii WHERE loc_id = ?").get(id);
    if (Number((folosit && folosit.n) || 0) > 0) {
      await db.prepare("UPDATE locuri_depozit SET blocat = 1 WHERE id = ?").run(id);
    } else {
      await db.prepare("DELETE FROM locuri_depozit WHERE id = ?").run(id);
    }
    redirect(ctx.res, "/depozit/locuri");
  });
}

// ---- Finalizarea: aici se scrie stocul ---------------------------------
// Funcție, nu doar rută: o cheamă și lista „Gata din producție" din Intrare
// marfă (modules/gata-productie.js), unde depozitul alocă marfa direct.
async function finalizeaza(id, user) {
  const r = await db.prepare("SELECT * FROM receptii WHERE id = ?").get(id);
  if (!r) return { eroare: "Recepția nu există." };
  const linii = await liniile(id);
  const v = R.validareFinalizare(r, linii);
  if (v.eroare) return { eroare: v.eroare };

  let depozitId = r.depozit_id || null;
  if (!depozitId) {
    const d = await db.prepare("SELECT id FROM depozite ORDER BY id LIMIT 1").get();
    depozitId = d ? d.id : null;
  }

  // Starea se muta PRIMA. Daca scrierea miscarilor pica la jumatate, a doua
  // apasare e refuzata si nu dubleaza ce a apucat sa intre — mai bine o
  // receptie de reparat manual decat stoc fantoma.
  await db
    .prepare("UPDATE receptii SET stare = 'finalizata', primita_de = COALESCE(primita_de, ?), finalizata_la = ? WHERE id = ?")
    .run(user.nume, acum(), id);

  let scrise = 0;
  for (const l of v.deIntrat) {
    if (!l.produs_id || !depozitId) continue;
    // Marfa stricata nu intra in stocul din care se vinde. Intra pe
    // document, se vede pe receptie, dar nu se poate vinde din greseala.
    if (l.conditie && l.conditie !== "bun") continue;
    await db
      .prepare(
        `INSERT INTO miscari_stoc (produs_id, depozit_id, tip, cantitate, pret_unitar, document_ref, data, observatii)
         VALUES (?, ?, 'intrare', ?, ?, ?, ?, ?)`
      )
      .run(
        l.produs_id,
        depozitId,
        nr(l.cantitate_primita),
        l.pret_unitar == null ? null : nr(l.pret_unitar),
        r.numar || "REC-" + id,
        acum(),
        [l.loc_cod ? "loc " + l.loc_cod : null, l.lot ? "lot " + l.lot : null, l.motiv].filter(Boolean).join(" · ") || null
      );
    scrise++;

    // Si pe hartă: pana acum singura urma a locului era coloana de pe
    // randul de receptie, deci se stia unde A INTRAT marfa, nu unde ESTE.
    // Un palet lat ocupa mai multe locuri: cantitatea se imparte intre
    // ele, ca harta sa nu arate acelasi palet de trei ori.
    const locuriLinie = await db
      .prepare("SELECT loc_id FROM receptii_linii_locuri WHERE linie_id = ?")
      .all(l.id)
      .catch(() => []);
    const peCare = locuriLinie.length ? locuriLinie.map((x) => Number(x.loc_id)) : l.loc_id ? [Number(l.loc_id)] : [];
    if (peCare.length) {
      const bucata = Math.round((nr(l.cantitate_primita) / peCare.length) * 1000) / 1000;
      for (const locId of peCare) {
        await db
          .prepare(
            `INSERT INTO stoc_locuri (loc_id, produs_id, produs_text, cantitate, um, lot, receptie_id, receptie_linie_id, intrat_la)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(locId, l.produs_id || null, l.produs_text || l.produs_denumire || null, bucata,
               l.um || null, l.lot || null, r.id, l.id, azi())
          .catch(() => {});
      }
    }
  }

  // Daca receptia a venit dintr-o aprovizionare, aceasta se inchide odata
  // cu ea — altfel ar ramane in lista „de aprovizionat" cu marfa deja in
  // depozit, si ar comanda cineva a doua oara.
  if (r.aprovizionare_id) {
    await db
      .prepare("UPDATE aprovizionari SET status = 'primita' WHERE id = ? AND status <> 'primita'")
      .run(r.aprovizionare_id)
      .catch(() => {});
  }

  // Și comanda clientului pentru care a venit marfa: dacă acum stocul o
  // acoperă, trece „în stoc depozit" și agentul o poate factura. Până pe
  // 05.11.2026 recepția scria stocul, dar comanda rămânea unde era — „Intră
  // în stoc" din De aprovizionat o muta, recepția nu.
  let spuneComanda = "";
  if (r.comanda_id) {
    try {
      const m = await require("../lib/stadiu-comanda").dupaIntrareMarfa(r.comanda_id, {
        user,
        motiv: `Recepția ${r.numar || "#" + r.id}${r.sursa === "productie" ? " (din producție)" : ""} a fost finalizată de ${user.nume}.`,
        potrivire: require("./warehouse").potrivire,
      });
      if (m.schimbat) spuneComanda = `Comanda clientului e acum „${require("../lib/comenzi-stari").TEXTE[m.status] || m.status}”.`;
    } catch (e) {
      console.error("[receptie] nu am putut muta comanda clientului:", e.message);
    }
  }

  const parti = [];
  parti.push(scrise + (scrise === 1 ? " rând a intrat pe stoc" : " rânduri au intrat pe stoc"));
  if (v.nevandabile.length) {
    parti.push(
      v.nevandabile.length + (v.nevandabile.length === 1 ? " rând cu marfă stricată NU a intrat pe stocul vandabil" : " rânduri cu marfă stricată NU au intrat pe stocul vandabil")
    );
  }
  if (v.lipsuri.length) parti.push(v.lipsuri.length + " cu lipsă față de cât s-a anunțat");
  if (v.respinse.length) parti.push(v.respinse.length + " respins" + (v.respinse.length === 1 ? "" : "e"));
  return {
    ok: true,
    scrise,
    mesaj: "Recepție finalizată: " + parti.join(" · ") + "." + (spuneComanda ? " " + spuneComanda : ""),
  };
}

// Recepția din producție luată „cum a fost anunțată": fiecare rând încă
// neatins primește cantitatea anunțată, în stare bună. O folosește alocarea
// directă din Intrare marfă — cine vrea să numere altceva deschide recepția.
async function primesteTot(id) {
  await db
    .prepare(
      `UPDATE receptii_linii
          SET stare = 'primita', cantitate_primita = COALESCE(cantitate_primita, cantitate_asteptata), conditie = COALESCE(conditie, 'bun')
        WHERE receptie_id = ? AND COALESCE(stare, 'de_primit') = 'de_primit'`
    )
    .run(id);
}

// Direct la livrare, ca funcție: o folosește și lista „Gata din producție"
// din Intrare marfă. Întoarce adresa ieșirii din CT-Park, cu paletul bifat.
// Fără cantitate pleacă tot ce a rămas; cu cantitate, doar atât — restul
// rămâne de alocat (Vali, 09.11.2026: „o parte la client, o parte în depozit
// și alta în fulfillment… orice combinație").
async function livrareDirecta(user, id, lid, destinatieCeruta, comandaCeruta, cantitateCeruta) {
  const r = await db.prepare("SELECT * FROM receptii WHERE id = ?").get(id);
  if (!r) return { eroare: "Recepția nu există.", faraReceptie: true };
  if (r.stare !== "finalizata") return { eroare: "Întâi finalizează recepția: atunci marfa e pe stoc și poate pleca." };
  const l = (await liniile(id)).find((x) => Number(x.id) === Number(lid));
  if (!l || l.stare !== "primita" || (l.conditie && l.conditie !== "bun")) return { eroare: "Pleacă la livrare doar marfa primită în stare bună." };
  const destinatie = ["comanda", "fulfillment", "productie"].includes(String(destinatieCeruta || "")) ? String(destinatieCeruta) : "";
  if (!destinatie) return { eroare: "Alege unde pleacă marfa: comanda unui client, fulfillment sau producție." };
  const pus = await db
    .prepare("SELECT COALESCE(SUM(cantitate), 0) AS c FROM ct_paleti WHERE receptie_linie_id = ?")
    .get(l.id)
    .catch(() => ({ c: 0 }));
  const ramas = Math.round((nr(l.cantitate_primita) - nr(pus && pus.c)) * 1000) / 1000;
  if (!(ramas > R.EPS)) return { eroare: "Tot ce a venit pe rândul ăsta e deja pus în CT-Park sau plecat." };
  const ceruta = cantitateCeruta == null || cantitateCeruta === "" ? null : Number(String(cantitateCeruta).replace(",", "."));
  if (ceruta != null && !(ceruta > R.EPS)) return { eroare: "Scrie o cantitate mai mare decât zero." };
  if (ceruta != null && ceruta > ramas + R.EPS) {
    const um = l.um || l.unitate_masura || "";
    return { eroare: `Mai sunt doar ${ramas.toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${um ? " " + um : ""} de alocat pe rândul ăsta.` };
  }
  const cantitate = ceruta == null ? ramas : Math.round(ceruta * 1000) / 1000;
  const cidPlan = destinatie === "comanda" ? parseInt(comandaCeruta, 10) || r.comanda_id || null : null;
  const CT = require("./ct-park");
  // De la cine e marfa: furnizorul recepției sau, la marfa din producție,
  // furnizorul ales acolo pentru material (lib/furnizor-comanda.js).
  const fz = await require("../lib/furnizor-comanda").furnizorReceptiei(r);
  const ids = await CT.puneMarfa(
    { user },
    {
      produs_id: l.produs_id || "",
      produs_text: l.produs_id ? "" : l.produs_text || "",
      um: l.um || l.unitate_masura || "",
      lot: l.lot || "",
      pret_unitar: l.pret_unitar == null ? "" : String(l.pret_unitar),
      furnizor_id: fz.furnizor_id || "",
      furnizor_text: fz.furnizor_id ? "" : fz.furnizor_text || "",
      observatii: `Direct la livrare din recepția ${r.numar || "#" + r.id}`,
      receptie_id: r.id,
      receptie_linie_id: l.id,
      iesire_plan: destinatie,
      iesire_comanda_id: cidPlan || "",
    },
    [[]],
    cantitate
  );
  if (!ids.length) return { eroare: "Paletul pentru livrare nu s-a putut face." };
  const cid = cidPlan || "";
  const q = new URLSearchParams({
    palet: String(ids[0]),
    destinatie,
    ...(cid ? { comanda_id: String(cid) } : {}),
    motiv: `livrare directă din recepția ${r.numar || "#" + r.id}`,
  });
  return { ok: true, url: "/stocuri/ct-park/iesire?" + q.toString(), palet: Number(ids[0]), cantitate };
}

module.exports = { register, creeaza, liniile, finalizeaza, primesteTot, livrareDirecta };
