"use strict";
// Logistică: cine duce marfa, cu cât, și în câte zile.
//
// Fluxul, pe scurt:
//   marfa e gata și iese din depozit sau din CT-Park
//   → se naște o CURSĂ, în starea „de alocat"
//   → pagina cursei pune pe același tabel toți transportatorii care POT s-o
//     facă, cu prețul fiecăruia și cu ziua în care ajunge
//   → se alege unul; dacă nu e cel recomandat, se scrie de ce
//   → clasamentul se îngheață pe cursă, ca peste trei luni să se poată
//     răspunde la întrebarea „de ce am plătit atât"
//
// Regulile de calcul NU stau aici, stau în lib/transport-cost.js, cu teste.
// Aici stau doar paginile și scrisul în bază.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const T = require("../lib/transport-cost");

function azi() {
  return new Date().toISOString().slice(0, 10);
}
function num(v) {
  const x = T.cifra(v);
  return x == null ? null : x;
}
function text(v, max) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, max || 200) : null;
}
// render.money() lipeste singur " lei" la coada, deci money(300) + " lei" da
// „300,00 lei lei", iar intr-o grila de tarife iesea „300,00 lei /palet".
// Aici avem nevoie si de numere curate, fiindca o oferta poate fi in euro.
function suma(v) {
  return Number(v || 0).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function bani(v, moneda) {
  const m = String(moneda || "RON").toUpperCase();
  return suma(v) + (m === "RON" ? " lei" : " " + m);
}
function lei(v) {
  return v == null ? "—" : bani(v, "RON");
}

// „0" e adevărat în JavaScript. Pare o pedanterie până vezi de unde vin
// valorile: un INTEGER citit din Postgres poate ajunge aici ca text, iar
// COUNT(*) ajunge ÎNTOTDEAUNA ca text, fiindcă e bigint și driverul nu-l
// strică la număr. Deci `if (t.oferte)` e adevărat și când sunt zero oferte,
// iar `if (cursa.retur_cu_marfa)` e adevărat și când căsuța e nebifată — adică
// mașina s-ar socoti doar dus, și ar ieși pe jumătate din prețul real. Exact
// bug-ul pe care l-a prins testul: 1.451 lei în loc de 2.472.
function adevarat(v) {
  if (v === null || v === undefined || v === false) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === "" || s === "0" || s === "false" || s === "f" || s === "null");
}
function cate(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}
function poate(user) {
  return Boolean(user && ["admin", "depozit", "productie", "financiar"].includes(user.rol));
}

const STARI = {
  de_alocat: '<span class="badge galben">de alocat</span>',
  alocata: '<span class="badge albastru">alocată</span>',
  in_curs: '<span class="badge albastru">pe drum</span>',
  livrata: '<span class="badge verde">livrată</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};
const stareEticheta = (s) => STARI[String(s || "")] || esc(String(s || "—"));

// --- Citirea transportatorilor în forma pe care o cere lib/transport-cost --

async function optiuniTransport(ziua) {
  const toti = await db.prepare("SELECT * FROM transportatori WHERE activ = 1 ORDER BY fel, nume").all();
  const externi = [];
  const interne = [];
  for (const t of toti) {
    if (t.fel === "intern") {
      const rezervari = await db
        .prepare("SELECT * FROM transport_rezervari WHERE transportator_id = ? AND stare <> 'anulata'")
        .all(t.id);
      interne.push(Object.assign({}, t, { rezervari }));
      continue;
    }
    // Oferta valabilă azi. Dacă n-are niciuna validă, se ia tot cea mai
    // recentă — ca să intre în listă cu motivul „a expirat pe ...", nu să
    // dispară în tăcere de parcă transportatorul n-ar exista.
    let of = await db
      .prepare(
        `SELECT * FROM transport_oferte
          WHERE transportator_id = ?
            AND (valabil_de_la IS NULL OR valabil_de_la <= ?)
            AND (valabil_pana_la IS NULL OR valabil_pana_la >= ?)
          ORDER BY id DESC LIMIT 1`
      )
      .get(t.id, ziua, ziua);
    if (!of) {
      of = await db
        .prepare("SELECT * FROM transport_oferte WHERE transportator_id = ? ORDER BY id DESC LIMIT 1")
        .get(t.id);
    }
    if (!of) {
      externi.push(Object.assign({}, t, { oferta: {}, tarife: [] }));
      continue;
    }
    const tarife = await db.prepare("SELECT * FROM transport_tarife WHERE oferta_id = ? ORDER BY id").all(of.id);
    externi.push(Object.assign({}, t, { oferta: of, tarife }));
  }
  return { externi, interne };
}

// Distanța știută pentru o localitate. Se scrie o dată, de mână, și de-atunci
// se ține minte — fără ea, orice tarif pe km și orice calcul de mașină
// proprie dau „nu știu", nu zero.
async function kmStiuti(localitate) {
  const c = T.cheie(localitate);
  if (!c) return null;
  const r = await db.prepare("SELECT km FROM transport_distante WHERE cheie = ?").get(c);
  return r ? Number(r.km) : null;
}

function register(router) {
  // ---- Coada: ce e de dus -----------------------------------------------
  router.get("/logistica", async (ctx) => {
    const filtru = String(ctx.query.stare || "deschise");
    const unde =
      filtru === "toate" ? "" : filtru === "deschise" ? "WHERE c.stare IN ('de_alocat','alocata','in_curs')" : "WHERE c.stare = ?";
    const args = filtru === "toate" || filtru === "deschise" ? [] : [filtru];
    const curse = await db
      .prepare(
        `SELECT c.*, t.nume AS transportator, t.fel AS transportator_fel, co.numar AS comanda_numar
           FROM transport_curse c
           LEFT JOIN transportatori t ON t.id = c.transportator_id
           LEFT JOIN comenzi co ON co.id = c.comanda_id
           ${unde}
           ORDER BY CASE c.stare WHEN 'de_alocat' THEN 0 WHEN 'alocata' THEN 1 WHEN 'in_curs' THEN 2 ELSE 3 END,
                    c.data_livrare_ceruta NULLS LAST, c.id DESC
           LIMIT 300`
      )
      .all(...args);

    const randuri = curse.map((c) => {
      const intarzie =
        c.data_livrare_ceruta && c.data_livrare_estimata && c.data_livrare_estimata > c.data_livrare_ceruta;
      return [
        `<a href="/logistica/cursa/${c.id}">#${c.id}</a>`,
        esc(c.client || "—") +
          (c.comanda_numar ? `<br><span style="font-size:12px;color:var(--text-muted)">${esc(c.comanda_numar)}</span>` : ""),
        esc(c.localitate || "—") + (c.judet ? `, ${esc(c.judet)}` : "") +
          (c.km ? `<br><span style="font-size:12px;color:var(--text-muted)">${Math.round(c.km)} km</span>` : ""),
        `${c.paleti ? Math.round(c.paleti) + " paleți" : ""}${c.paleti && c.greutate_kg ? " · " : ""}${c.greutate_kg ? Math.round(c.greutate_kg) + " kg" : ""}` || "—",
        esc(c.data_livrare_ceruta || "—") +
          (c.data_livrare_estimata
            ? `<br><span class="badge ${intarzie ? "rosu" : "verde"}" style="font-size:11px">ajunge ${esc(c.data_livrare_estimata)}</span>`
            : ""),
        c.transportator
          ? esc(c.transportator) + (c.transportator_fel === "intern" ? ' <span class="badge gri" style="font-size:10px">mașina noastră</span>' : "")
          : "—",
        c.cost_estimat == null ? "—" : lei(c.cost_estimat),
        stareEticheta(c.stare),
      ];
    });

    // Comenzile gata de livrat care n-au încă nicio cursă. Fără rândul ăsta,
    // coada de transport s-ar umple doar cu ce scrie cineva de mână, adică
    // s-ar umple pe jumătate.
    const gata = await db
      .prepare(
        `SELECT co.id, co.numar, co.status, co.data_livrare_promisa, co.data_livrare_ceruta, p.nume AS client, p.adresa
           FROM comenzi co
           JOIN parteneri p ON p.id = co.partener_id
          WHERE co.status IN ('in_stoc_depozit','facturata')
            AND NOT EXISTS (SELECT 1 FROM transport_curse c WHERE c.comanda_id = co.id AND c.stare <> 'anulata')
          ORDER BY co.id DESC LIMIT 50`
      )
      .all();

    const randuriGata = gata.map((g) => [
      esc(g.numar || "#" + g.id),
      esc(g.client || ""),
      esc(g.adresa || "—"),
      esc(g.data_livrare_promisa || g.data_livrare_ceruta || "—"),
      `<form method="post" action="/logistica/cursa/din-comanda/${g.id}" class="inline-form">
         <button class="btn small" type="submit">Deschide cursă</button>
       </form>`,
    ]);

    const filtre = [
      ["deschise", "În lucru"],
      ["de_alocat", "De alocat"],
      ["livrata", "Livrate"],
      ["toate", "Toate"],
    ]
      .map(
        ([v, et]) =>
          `<a class="btn small ${filtru === v ? "" : "secondary"}" href="/logistica?stare=${v}">${esc(et)}</a>`
      )
      .join(" ");

    const body = `
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block">${esc(ctx.query.eroare)}</p>` : ""}
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
        ${filtre}
        <span style="flex:1"></span>
        <a class="btn small secondary" href="/logistica/cursa/noua">Cursă scrisă de mână</a>
      </div>
      ${table(["Cursa", "Client", "Unde", "Cât", "Termen", "Cu cine", "Cost", "Stare"], randuri)}
      ${
        randuriGata.length
          ? `<h3 style="margin-top:28px">Gata de livrat, fără cursă deschisă</h3>
             <p style="max-width:720px;color:var(--text-muted)">
               Comenzi care au marfa în depozit sau sunt deja facturate și n-au transport alocat. Butonul deschide cursa
               cu ce știe ERP-ul — clientul, adresa și termenul — iar tu completezi câți paleți sunt.
             </p>
             ${table(["Comanda", "Client", "Adresă", "Termen", ""], randuriGata)}`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Curse de transport", active: "/logistica", body }));
  });

  // ---- Cursă nouă din comandă -------------------------------------------
  router.post("/logistica/cursa/din-comanda/:id", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica");
    const id = parseInt(ctx.params.id, 10);
    const co = await db
      .prepare(
        `SELECT co.*, p.nume AS client, p.adresa FROM comenzi co JOIN parteneri p ON p.id = co.partener_id WHERE co.id = ?`
      )
      .get(id);
    if (!co) return redirect(ctx.res, "/logistica");
    const ins = await db
      .prepare(
        `INSERT INTO transport_curse (sursa, comanda_id, client, adresa, data_livrare_ceruta, stare, creata_la)
         VALUES ('depozit', ?, ?, ?, ?, 'de_alocat', ?) RETURNING id`
      )
      .run(id, co.client, co.adresa || null, co.data_livrare_promisa || co.data_livrare_ceruta || null, azi());
    redirect(ctx.res, `/logistica/cursa/${ins.lastInsertRowid}`);
  });

  router.get("/logistica/cursa/noua", async (ctx) => {
    const body = `
      <form method="post" action="/logistica/cursa/noua" class="form" style="max-width:720px">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          <label class="field"><span>Client</span><input name="client" required></label>
          <label class="field"><span>Termen de livrare</span><input type="date" name="data_livrare_ceruta"></label>
        </div>
        <label class="field"><span>Adresă</span><input name="adresa"></label>
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:14px">
          <label class="field"><span>Localitate</span><input name="localitate" required></label>
          <label class="field"><span>Județ</span><input name="judet"></label>
          <label class="field"><span>Paleți</span><input type="number" step="1" name="paleti"></label>
          <label class="field"><span>Greutate (kg)</span><input type="number" step="0.1" name="greutate_kg"></label>
        </div>
        <button class="btn" type="submit">Deschide cursa</button>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cursă nouă", active: "/logistica", body }));
  });

  router.post("/logistica/cursa/noua", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica");
    const b = ctx.body || {};
    const localitate = text(b.localitate, 120);
    if (!localitate) return redirect(ctx.res, "/logistica/cursa/noua");
    const km = await kmStiuti(localitate);
    const ins = await db
      .prepare(
        `INSERT INTO transport_curse (sursa, client, adresa, localitate, judet, km, paleti, greutate_kg,
                                      data_livrare_ceruta, stare, creata_la)
         VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, 'de_alocat', ?) RETURNING id`
      )
      .run(
        text(b.client, 160),
        text(b.adresa, 300),
        localitate,
        text(b.judet, 60),
        km,
        num(b.paleti),
        num(b.greutate_kg),
        text(b.data_livrare_ceruta, 10),
        azi()
      );
    redirect(ctx.res, `/logistica/cursa/${ins.lastInsertRowid}`);
  });

  // ---- Pagina cursei: clasamentul ---------------------------------------
  router.get("/logistica/cursa/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const c = await db
      .prepare(
        `SELECT c.*, t.nume AS transportator, t.fel AS transportator_fel, co.numar AS comanda_numar
           FROM transport_curse c
           LEFT JOIN transportatori t ON t.id = c.transportator_id
           LEFT JOIN comenzi co ON co.id = c.comanda_id
          WHERE c.id = ?`
      )
      .get(id);
    if (!c) return redirect(ctx.res, "/logistica");

    const ziua = azi();
    const exp = {
      judet: c.judet,
      localitate: c.localitate,
      km: c.km,
      greutate_kg: c.greutate_kg,
      paleti: c.paleti,
      data_ridicare: c.data_ridicare || ziua,
      data_livrare_ceruta: c.data_livrare_ceruta,
    };
    const optiuni = await optiuniTransport(ziua);
    const r = T.clasament(optiuni, exp, { azi: ziua, retur_cu_marfa: adevarat(c.retur_cu_marfa) });

    const alocata = c.stare !== "de_alocat" && c.transportator_id;

    const randuri = r.variante.map((v, i) => {
      const recomandat = r.recomandat && r.recomandat.transportator_id === v.transportator_id && r.recomandat.fel === v.fel;
      const esteAsta = alocata && c.transportator_id === v.transportator_id;
      return [
        `${i + 1}.` +
          (recomandat ? ' <span class="badge verde" style="font-size:10px">recomandat</span>' : "") +
          (esteAsta ? ' <span class="badge albastru" style="font-size:10px">ales</span>' : ""),
        esc(v.nume) + (v.fel === "intern" ? ' <span class="badge gri" style="font-size:10px">mașina noastră</span>' : ""),
        `<strong>${esc(bani(v.cost, v.moneda))}</strong>` +
          (v.moneda !== "RON" && v.cost_lei != null ? `<br><span style="font-size:12px">≈ ${esc(bani(v.cost_lei, "RON"))}</span>` : "") +
          (v.cost_lei == null ? '<br><span class="badge rosu" style="font-size:10px">fără curs valutar</span>' : ""),
        `<span style="font-size:12px;color:var(--text-muted)">${esc(v.eticheta_tarif || "")}</span>`,
        v.zile == null
          ? "—"
          : `${v.zile} ${v.zile === 1 ? "zi" : "zile"}` +
            (v.data_estimata ? `<br><span style="font-size:12px">${esc(v.data_estimata)}</span>` : ""),
        v.in_termen === false
          ? `<span class="badge rosu">întârzie ${v.intarziere} ${v.intarziere === 1 ? "zi" : "zile"}</span>`
          : v.in_termen === true
            ? '<span class="badge verde">în termen</span>'
            : '<span class="badge gri">fără termen</span>',
        alocata
          ? ""
          : `<form method="post" action="/logistica/cursa/${c.id}/aloca" style="display:grid;gap:4px;min-width:170px">
               <input type="hidden" name="transportator_id" value="${v.transportator_id}">
               <input type="hidden" name="oferta_id" value="${v.oferta_id || ""}">
               <input type="hidden" name="tarif_id" value="${v.tarif_id || ""}">
               <input type="hidden" name="cost" value="${v.cost}">
               <input type="hidden" name="moneda" value="${esc(v.moneda)}">
               <input type="hidden" name="zile" value="${v.zile == null ? "" : v.zile}">
               <input type="hidden" name="recomandat" value="${recomandat ? "1" : "0"}">
               ${recomandat ? "" : `<input name="motiv" placeholder="de ce nu cel recomandat" maxlength="200" required style="font-size:12px">`}
               <button class="btn small ${recomandat ? "" : "secondary"}" type="submit">Alocă</button>
             </form>`,
      ];
    });

    const randuriExcluse = r.excluse.map((e) => [
      esc(e.nume) + (e.fel === "intern" ? ' <span class="badge gri" style="font-size:10px">mașina noastră</span>' : ""),
      esc(e.motiv),
    ]);

    const detaliuAles = (() => {
      if (!alocata) return "";
      const v = r.variante.find((x) => x.transportator_id === c.transportator_id);
      const d = v && v.detaliu;
      if (!d) return "";
      return Object.entries(d)
        .filter(([k, val]) => val !== 0 && val !== false && val != null && k !== "formula")
        .map(([k, val]) => `${esc(k.replace(/_/g, " "))}: ${typeof val === "number" ? suma(val) : esc(String(val))}`)
        .join(" · ");
    })();

    const lipsesteKm = c.km == null;
    const body = `
      ${ctx.query.eroare ? `<p class="badge rosu" style="display:inline-block">${esc(ctx.query.eroare)}</p>` : ""}
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:320px">
          <h2 style="margin-top:0">Cursa #${c.id} ${stareEticheta(c.stare)}</h2>
          <p style="color:var(--text-muted);margin-top:-6px">
            ${esc(c.client || "—")}${c.comanda_numar ? " · comanda " + esc(c.comanda_numar) : ""}<br>
            ${esc(c.adresa || "")}${c.adresa ? "<br>" : ""}
            ${esc(c.localitate || "—")}${c.judet ? ", " + esc(c.judet) : ""}
            ${c.km ? " · " + Math.round(c.km) + " km dus" : ""}
          </p>
        </div>
        <form method="post" action="/logistica/cursa/${c.id}/detalii" class="form" style="min-width:300px;max-width:360px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label class="field" style="margin:0"><span>Paleți</span><input type="number" step="1" name="paleti" value="${c.paleti == null ? "" : c.paleti}"></label>
            <label class="field" style="margin:0"><span>Greutate (kg)</span><input type="number" step="0.1" name="greutate_kg" value="${c.greutate_kg == null ? "" : c.greutate_kg}"></label>
            <label class="field" style="margin:0"><span>Km dus</span><input type="number" step="1" name="km" value="${c.km == null ? "" : c.km}"></label>
            <label class="field" style="margin:0"><span>Ridicare</span><input type="date" name="data_ridicare" value="${esc(c.data_ridicare || "")}"></label>
            <label class="field" style="margin:0"><span>Termen client</span><input type="date" name="data_livrare_ceruta" value="${esc(c.data_livrare_ceruta || "")}"></label>
            <label class="field" style="margin:0"><span>Localitate</span><input name="localitate" value="${esc(c.localitate || "")}"></label>
          </div>
          <label style="display:flex;gap:8px;align-items:center;margin:10px 0;font-size:13px">
            <input type="checkbox" name="retur_cu_marfa" value="1" ${adevarat(c.retur_cu_marfa) ? "checked" : ""}>
            Mașina se întoarce cu marfă (returul îl plătește altcineva)
          </label>
          <button class="btn small" type="submit">Recalculează</button>
        </form>
      </div>

      ${
        lipsesteKm
          ? `<p class="badge galben" style="display:inline-block;margin:12px 0">
               Nu știm câți kilometri sunt până la ${esc(c.localitate || "destinație")}. Fără ei nu se poate calcula nici
               mașina proprie, nici vreun tarif pe km. Scrie-i o dată mai sus și se țin minte pentru toate cursele
               viitoare spre localitatea asta.
             </p>`
          : ""
      }
      ${r.avertismente.map((a) => `<p class="badge ${/rețeaua de paletizare|sună clientul/.test(a) ? "rosu" : "galben"}" style="display:block;max-width:820px;margin:8px 0;white-space:normal;line-height:1.5">${esc(a)}</p>`).join("")}

      <h3>Cine poate duce marfa</h3>
      ${table(["", "Transportator", "Cost", "Tarif aplicat", "Durată", "Față de termen", ""], randuri)}

      ${
        alocata
          ? `<p style="margin-top:14px">
               Alocată lui <strong>${esc(c.transportator || "")}</strong> pe ${esc(c.alocata_la || "")} de ${esc(c.alocata_de || "")},
               la ${lei(c.cost_estimat)}.
               ${c.motiv_alegere ? `<br>Motivul pentru care nu s-a luat recomandarea: <em>${esc(c.motiv_alegere)}</em>` : ""}
               ${detaliuAles ? `<br><span style="font-size:12px;color:var(--text-muted)">${detaliuAles}</span>` : ""}
             </p>
             <form method="post" action="/logistica/cursa/${c.id}/dezaloca" class="inline-form">
               <button class="link-btn danger" type="submit">Schimbă transportatorul</button>
             </form>`
          : ""
      }

      ${
        randuriExcluse.length
          ? `<h3 style="margin-top:28px">Cine nu poate, și de ce</h3>
             <p style="max-width:720px;color:var(--text-muted)">
               Lista asta e jumătatea importantă a paginii. Un transportator care lipsește fără explicație se uită;
               unul care scrie „oferta a expirat pe 31.12" se sună.
             </p>
             ${table(["Transportator", "De ce nu intră în comparație"], randuriExcluse)}`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Cursa #${c.id}`, active: "/logistica", body }));
  });

  router.post("/logistica/cursa/:id/detalii", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const localitate = text(b.localitate, 120);
    const km = num(b.km);
    await db
      .prepare(
        `UPDATE transport_curse SET paleti = ?, greutate_kg = ?, km = ?, data_ridicare = ?, data_livrare_ceruta = ?,
                                    localitate = COALESCE(?, localitate), retur_cu_marfa = ?
          WHERE id = ?`
      )
      .run(num(b.paleti), num(b.greutate_kg), km, text(b.data_ridicare, 10), text(b.data_livrare_ceruta, 10), localitate, b.retur_cu_marfa ? 1 : 0, id);

    // Kilometrii scriși o dată se țin minte pentru toate cursele viitoare
    // spre localitatea asta. Altfel îi caută fiecare din nou, pe Google, de
    // fiecare dată, și iese alt număr de fiecare dată.
    if (km != null && km > 0 && localitate) {
      const cheie = T.cheie(localitate);
      const exista = await db.prepare("SELECT id FROM transport_distante WHERE cheie = ?").get(cheie);
      if (exista) await db.prepare("UPDATE transport_distante SET km = ?, localitate = ? WHERE id = ?").run(km, localitate, exista.id);
      else
        await db
          .prepare("INSERT INTO transport_distante (cheie, localitate, judet, km, adaugat_de, creat_la) VALUES (?, ?, ?, ?, ?, ?)")
          .run(cheie, localitate, text(b.judet, 60), km, ctx.user ? ctx.user.nume : null, azi());
    }
    redirect(ctx.res, `/logistica/cursa/${id}`);
  });

  router.post("/logistica/cursa/:id/aloca", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const transportatorId = parseInt(b.transportator_id, 10);
    if (!transportatorId) return redirect(ctx.res, `/logistica/cursa/${id}`);

    // Dacă nu se ia recomandarea, motivul e obligatoriu. Nu ca să dea cineva
    // socoteală, ci ca peste trei luni, când se uită cineva la costul de
    // transport pe client, să existe un răspuns scris.
    const recomandat = String(b.recomandat || "") === "1";
    const motiv = text(b.motiv, 200);
    if (!recomandat && !motiv) {
      return redirect(
        ctx.res,
        `/logistica/cursa/${id}?eroare=` +
          encodeURIComponent("N-ai ales varianta recomandată. Scrie de ce — peste trei luni nimeni nu-și mai amintește.")
      );
    }

    const c = await db.prepare("SELECT * FROM transport_curse WHERE id = ?").get(id);
    if (!c) return redirect(ctx.res, "/logistica");

    const zile = num(b.zile);
    const plecare = c.data_ridicare || azi();
    const estimata = zile == null ? null : T.adaugaZile(plecare, zile);

    // Clasamentul se îngheață pe cursă. Tarifele se schimbă; întrebarea „de
    // ce am plătit atât" se pune peste trei luni.
    const ziua = azi();
    const optiuni = await optiuniTransport(ziua);
    const r = T.clasament(
      optiuni,
      {
        judet: c.judet, localitate: c.localitate, km: c.km, greutate_kg: c.greutate_kg, paleti: c.paleti,
        data_ridicare: plecare, data_livrare_ceruta: c.data_livrare_ceruta,
      },
      { azi: ziua, retur_cu_marfa: !!c.retur_cu_marfa }
    );

    await db
      .prepare(
        `UPDATE transport_curse SET transportator_id = ?, oferta_id = ?, tarif_id = ?, cost_estimat = ?, moneda = ?,
                                    data_livrare_estimata = ?, motiv_alegere = ?, clasament_json = ?,
                                    stare = 'alocata', alocata_de = ?, alocata_la = ?
          WHERE id = ?`
      )
      .run(
        transportatorId,
        parseInt(b.oferta_id, 10) || null,
        parseInt(b.tarif_id, 10) || null,
        num(b.cost),
        text(b.moneda, 8) || "RON",
        estimata,
        recomandat ? null : motiv,
        JSON.stringify({ la: ziua, variante: r.variante, excluse: r.excluse }).slice(0, 60000),
        ctx.user ? ctx.user.nume : null,
        ziua,
        id
      );

    // Mașina noastră se rezervă odată cu alocarea. Altfel o alocă altcineva
    // a doua oară pe aceleași zile și află dimineața, în rampă.
    const t = await db.prepare("SELECT fel, nume FROM transportatori WHERE id = ?").get(transportatorId);
    if (t && t.fel === "intern") {
      const pana = T.adaugaZile(plecare, Math.max(0, (zile || 1) - 1));
      await db
        .prepare(
          `INSERT INTO transport_rezervari (transportator_id, cursa_id, de_la, pana_la, ce, stare, creata_de, creata_la)
           VALUES (?, ?, ?, ?, ?, 'activa', ?, ?)`
        )
        .run(transportatorId, id, plecare, pana, `cursa #${id} ${c.client || ""}`.trim(), ctx.user ? ctx.user.nume : null, ziua);
    }
    redirect(ctx.res, `/logistica/cursa/${id}`);
  });

  router.post("/logistica/cursa/:id/dezaloca", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica");
    const id = parseInt(ctx.params.id, 10);
    // Rezervarea mașinii cade odată cu alocarea. Dacă rămâne, mașina apare
    // ocupată pentru o cursă care nu mai e a ei.
    await db.prepare("UPDATE transport_rezervari SET stare = 'anulata' WHERE cursa_id = ?").run(id);
    await db
      .prepare(
        `UPDATE transport_curse SET transportator_id = NULL, oferta_id = NULL, tarif_id = NULL, cost_estimat = NULL,
                                    data_livrare_estimata = NULL, motiv_alegere = NULL, stare = 'de_alocat',
                                    alocata_de = NULL, alocata_la = NULL
          WHERE id = ?`
      )
      .run(id);
    redirect(ctx.res, `/logistica/cursa/${id}`);
  });

  // ---- Transportatori ----------------------------------------------------
  router.get("/logistica/transportatori", async (ctx) => {
    const toti = await db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM transport_oferte o WHERE o.transportator_id = t.id) AS oferte,
                (SELECT MAX(o.valabil_pana_la) FROM transport_oferte o WHERE o.transportator_id = t.id) AS pana_la
           FROM transportatori t ORDER BY t.fel, t.nume`
      )
      .all();
    const ziua = azi();
    const randuri = toti.map((t) => {
      const expirat = t.fel === "extern" && t.pana_la && t.pana_la < ziua;
      const nrOferte = cate(t.oferte);
      return [
        `<a href="/logistica/transportator/${t.id}">${esc(t.nume)}</a>` + (adevarat(t.activ) ? "" : ' <span class="badge gri">inactiv</span>'),
        t.fel === "intern" ? '<span class="badge albastru">mașina noastră</span>' : '<span class="badge gri">extern</span>',
        t.fel === "intern"
          ? esc(t.numar_inmatriculare || "—") + (t.sofer ? `<br><span style="font-size:12px">${esc(t.sofer)}</span>` : "")
          : esc(t.persoana_contact || "—") + (t.email ? `<br><span style="font-size:12px">${esc(t.email)}</span>` : ""),
        t.fel === "intern"
          ? cate(t.consum_l_100km) > 0 && cate(t.pret_carburant) > 0
            ? `${t.consum_l_100km} l/100km · ${suma(t.pret_carburant)} lei/l`
            : '<span class="badge rosu">neconfigurată — nu intră în comparație</span>'
          : nrOferte
            ? `${nrOferte} ${nrOferte === 1 ? "ofertă" : "oferte"}` +
              (expirat ? `<br><span class="badge rosu" style="font-size:10px">expirată ${esc(t.pana_la)}</span>` : "")
            : '<span class="badge rosu">fără ofertă</span>',
        `${t.capacitate_paleti ? Math.round(t.capacitate_paleti) + " paleți" : ""}${t.capacitate_paleti && t.capacitate_kg ? " · " : ""}${t.capacitate_kg ? Math.round(t.capacitate_kg) + " kg" : ""}` || "—",
      ];
    });
    const body = `
      <p style="max-width:780px;color:var(--text-muted)">
        Firmele de transport și mașinile noastre stau în aceeași listă, fiindcă la momentul alegerii sunt două rânduri
        în același clasament. Diferența e că firma vine cu un tarif negociat, iar mașina noastră cu un cost pe care îl
        calculăm noi — și pe care, dacă nu-l completăm, n-avem voie să-l considerăm zero.
      </p>
      ${table(["Nume", "Fel", "Contact", "Tarife / configurare", "Capacitate"], randuri)}
      <h3 style="margin-top:28px">Adaugă</h3>
      <form method="post" action="/logistica/transportatori" class="form" style="max-width:640px">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          <label class="field"><span>Nume</span><input name="nume" required placeholder="ex. Palex, sau Dubita 3,5t"></label>
          <label class="field"><span>Fel</span>
            <select name="fel"><option value="extern">firmă de transport</option><option value="intern">mașina noastră</option></select>
          </label>
        </div>
        <button class="btn" type="submit">Adaugă</button>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Transportatori", active: "/logistica/transportatori", body }));
  });

  router.post("/logistica/transportatori", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    const b = ctx.body || {};
    const nume = text(b.nume, 160);
    if (!nume) return redirect(ctx.res, "/logistica/transportatori");
    const fel = b.fel === "intern" ? "intern" : "extern";
    const ins = await db
      .prepare("INSERT INTO transportatori (nume, fel, activ, creat_la) VALUES (?, ?, 1, ?) RETURNING id")
      .run(nume, fel, azi());
    redirect(ctx.res, `/logistica/transportator/${ins.lastInsertRowid}`);
  });

  router.get("/logistica/transportator/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const t = await db.prepare("SELECT * FROM transportatori WHERE id = ?").get(id);
    if (!t) return redirect(ctx.res, "/logistica/transportatori");
    const intern = t.fel === "intern";

    const oferte = intern
      ? []
      : await db.prepare("SELECT * FROM transport_oferte WHERE transportator_id = ? ORDER BY id DESC").all(id);
    const rezervari = intern
      ? await db
          .prepare("SELECT * FROM transport_rezervari WHERE transportator_id = ? AND stare <> 'anulata' ORDER BY de_la DESC LIMIT 60")
          .all(id)
      : [];

    const ziua = azi();
    const campuriMasina = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
        <label class="field"><span>Număr</span><input name="numar_inmatriculare" value="${esc(t.numar_inmatriculare || "")}"></label>
        <label class="field"><span>Șofer</span><input name="sofer" value="${esc(t.sofer || "")}"></label>
        <label class="field"><span>Viteză medie (km/h)</span><input type="number" step="1" name="viteza_medie_kmh" value="${t.viteza_medie_kmh || 70}"></label>
        <label class="field"><span>Consum (l/100 km)</span><input type="number" step="0.1" name="consum_l_100km" value="${t.consum_l_100km == null ? "" : t.consum_l_100km}" required></label>
        <label class="field"><span>Preț carburant (lei/l)</span><input type="number" step="0.01" name="pret_carburant" value="${t.pret_carburant == null ? "" : t.pret_carburant}" required></label>
        <label class="field"><span>Uzură (lei/km)</span><input type="number" step="0.01" name="cost_km_uzura" value="${t.cost_km_uzura == null ? "" : t.cost_km_uzura}"></label>
        <label class="field"><span>Șofer (lei/oră)</span><input type="number" step="0.1" name="cost_ora_sofer" value="${t.cost_ora_sofer == null ? "" : t.cost_ora_sofer}"></label>
        <label class="field"><span>Diurnă (lei/zi)</span><input type="number" step="1" name="diurna_zi" value="${t.diurna_zi == null ? "" : t.diurna_zi}"></label>
        <label class="field"><span>Taxe drum (lei/cursă)</span><input type="number" step="1" name="taxe_cursa" value="${t.taxe_cursa == null ? "" : t.taxe_cursa}"></label>
        <label class="field"><span>Încărcare+descărcare (ore)</span><input type="number" step="0.5" name="ore_incarcare" value="${t.ore_incarcare == null ? "" : t.ore_incarcare}"></label>
        <label class="field"><span>Ore maxim pe zi</span><input type="number" step="0.5" name="ore_max_zi" value="${t.ore_max_zi == null ? "" : t.ore_max_zi}"></label>
        <span></span>
      </div>
      <p style="max-width:700px;color:var(--text-muted);font-size:13px">
        Toate cursele se socotesc <strong>dus-întors</strong>, cu omul și cu diurna dacă trece de o zi. E singurul fel
        în care numărul iese adevărat: dacă se trece doar dusul, mașina proprie pare ieftină și pierzi bani la fiecare
        livrare. Consumul și prețul carburantului sunt obligatorii — fără ele mașina nu intră deloc în comparație, ca
        să nu câștige la zero lei.
      </p>`;

    const campuriExtern = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
        <label class="field"><span>Persoană de contact</span><input name="persoana_contact" value="${esc(t.persoana_contact || "")}"></label>
        <label class="field"><span>Email</span><input name="email" value="${esc(t.email || "")}"></label>
        <label class="field"><span>Telefon</span><input name="telefon" value="${esc(t.telefon || "")}"></label>
      </div>`;

    const randuriOferte = oferte.map((o) => {
      const valabila = (!o.valabil_de_la || o.valabil_de_la <= ziua) && (!o.valabil_pana_la || o.valabil_pana_la >= ziua);
      return [
        `<a href="/logistica/oferta/${o.id}">${esc(o.nume || "ofertă #" + o.id)}</a>`,
        `${esc(o.valabil_de_la || "—")} → ${esc(o.valabil_pana_la || "—")}`,
        valabila ? '<span class="badge verde">valabilă</span>' : '<span class="badge rosu">în afara perioadei</span>',
        esc(o.moneda || "RON") + (o.suprataxa_combustibil_pct ? ` · +${o.suprataxa_combustibil_pct}% combustibil` : ""),
        o.fisier_nume ? `<a href="/logistica/oferta/${o.id}/fisier">${esc(o.fisier_nume)}</a>` : "—",
      ];
    });

    const randuriRez = rezervari.map((r) => [
      esc(r.de_la) + (r.pana_la && r.pana_la !== r.de_la ? " → " + esc(r.pana_la) : ""),
      esc(r.ce || "—"),
      r.cursa_id ? `<a href="/logistica/cursa/${r.cursa_id}">cursa #${r.cursa_id}</a>` : "scrisă de mână",
      `<form method="post" action="/logistica/rezervare/${r.id}/anuleaza" class="inline-form"><button class="link-btn danger" type="submit">Anulează</button></form>`,
    ]);

    const body = `
      <h2 style="margin-top:0">${esc(t.nume)} ${intern ? '<span class="badge albastru">mașina noastră</span>' : '<span class="badge gri">extern</span>'}</h2>
      <form method="post" action="/logistica/transportator/${t.id}" class="form" style="max-width:880px">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
          <label class="field"><span>Nume</span><input name="nume" value="${esc(t.nume)}" required></label>
          <label class="field"><span>Capacitate (kg)</span><input type="number" step="1" name="capacitate_kg" value="${t.capacitate_kg == null ? "" : t.capacitate_kg}"></label>
          <label class="field"><span>Capacitate (paleți)</span><input type="number" step="1" name="capacitate_paleti" value="${t.capacitate_paleti == null ? "" : t.capacitate_paleti}"></label>
        </div>
        ${intern ? campuriMasina : campuriExtern}
        <label class="field"><span>Observații</span><input name="observatii" value="${esc(t.observatii || "")}"></label>
        <label style="display:flex;gap:8px;align-items:center;margin:10px 0;font-size:13px">
          <input type="checkbox" name="activ" value="1" ${adevarat(t.activ) ? "checked" : ""}> Activ
        </label>
        <button class="btn" type="submit">Salvează</button>
      </form>

      ${
        intern
          ? `<h3 style="margin-top:28px">Rezervări</h3>
             <p style="max-width:720px;color:var(--text-muted)">
               O mașină luată în zilele alea nu e o variantă mai scumpă, e una care nu există: dispare din clasament și
               se scrie pentru ce e luată. Rezervarea se face singură când aloci o cursă pe ea; aici se adaugă restul —
               service, concediu, o livrare pe care n-o ține ERP-ul.
             </p>
             ${table(["Când", "Pentru ce", "Cursa", ""], randuriRez)}
             <form method="post" action="/logistica/rezervare" class="form" style="max-width:640px;margin-top:14px">
               <input type="hidden" name="transportator_id" value="${t.id}">
               <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:14px">
                 <label class="field"><span>De la</span><input type="date" name="de_la" required></label>
                 <label class="field"><span>Până la</span><input type="date" name="pana_la"></label>
                 <label class="field"><span>Pentru ce</span><input name="ce" required placeholder="ex. service, ITP, concediu șofer"></label>
               </div>
               <button class="btn small" type="submit">Rezervă</button>
             </form>`
          : `<h3 style="margin-top:28px">Oferte de tarife</h3>
             ${table(["Ofertă", "Valabilă", "Acum", "Monedă", "Document"], randuriOferte)}
             <form method="post" action="/logistica/oferta" class="form" style="max-width:820px;margin-top:14px" enctype="multipart/form-data">
               <input type="hidden" name="transportator_id" value="${t.id}">
               <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
                 <label class="field"><span>Cum o numim</span><input name="nume" placeholder="ex. Tarif 2026 Q4"></label>
                 <label class="field"><span>Valabilă de la</span><input type="date" name="valabil_de_la"></label>
                 <label class="field"><span>Până la</span><input type="date" name="valabil_pana_la"></label>
               </div>
               <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:14px">
                 <label class="field"><span>Monedă</span>
                   <select name="moneda"><option>RON</option><option>EUR</option></select></label>
                 <label class="field"><span>Suprataxă combustibil (%)</span><input type="number" step="0.1" name="suprataxa_combustibil_pct" value="0"></label>
                 <label class="field"><span>Documentul primit (PDF)</span><input type="file" name="fisier" accept=".pdf,.jpg,.png,.xlsx"></label>
               </div>
               <button class="btn" type="submit">Urcă oferta</button>
             </form>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: t.nume, active: "/logistica/transportatori", body }));
  });

  router.post("/logistica/transportator/:id", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    await db
      .prepare(
        `UPDATE transportatori SET nume = COALESCE(?, nume), persoana_contact = ?, email = ?, telefon = ?,
                                   numar_inmatriculare = ?, sofer = ?, consum_l_100km = ?, pret_carburant = ?,
                                   cost_km_uzura = ?, cost_ora_sofer = ?, diurna_zi = ?, taxe_cursa = ?,
                                   viteza_medie_kmh = ?, ore_incarcare = ?, ore_max_zi = ?,
                                   capacitate_kg = ?, capacitate_paleti = ?, observatii = ?, activ = ?
          WHERE id = ?`
      )
      .run(
        text(b.nume, 160), text(b.persoana_contact, 120), text(b.email, 160), text(b.telefon, 60),
        text(b.numar_inmatriculare, 20), text(b.sofer, 120), num(b.consum_l_100km), num(b.pret_carburant),
        num(b.cost_km_uzura), num(b.cost_ora_sofer), num(b.diurna_zi), num(b.taxe_cursa),
        num(b.viteza_medie_kmh), num(b.ore_incarcare), num(b.ore_max_zi),
        num(b.capacitate_kg), num(b.capacitate_paleti), text(b.observatii, 400), b.activ ? 1 : 0,
        id
      );
    redirect(ctx.res, `/logistica/transportator/${id}`);
  });

  // ---- Oferte și grila de tarife ----------------------------------------
  router.post("/logistica/oferta", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    const b = ctx.body || {};
    const tid = parseInt(b.transportator_id, 10);
    if (!tid) return redirect(ctx.res, "/logistica/transportatori");
    const f = b.__files && b.__files.fisier && b.__files.fisier[0];
    const ins = await db
      .prepare(
        `INSERT INTO transport_oferte (transportator_id, nume, valabil_de_la, valabil_pana_la, moneda,
                                       suprataxa_combustibil_pct, fisier, fisier_nume, fisier_tip, incarcata_de, creata_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(
        tid,
        text(b.nume, 160) || "Tarif " + azi(),
        text(b.valabil_de_la, 10),
        text(b.valabil_pana_la, 10),
        text(b.moneda, 8) || "RON",
        num(b.suprataxa_combustibil_pct) || 0,
        f && f.data && f.data.length ? f.data.toString("base64") : null,
        f && f.filename ? text(f.filename, 200) : null,
        f ? text(f.contentType, 100) : null,
        ctx.user ? ctx.user.nume : null,
        azi()
      );
    redirect(ctx.res, `/logistica/oferta/${ins.lastInsertRowid}`);
  });

  router.get("/logistica/oferta/:id/fisier", async (ctx) => {
    const o = await db
      .prepare("SELECT fisier, fisier_nume, fisier_tip FROM transport_oferte WHERE id = ?")
      .get(parseInt(ctx.params.id, 10));
    if (!o || !o.fisier) return redirect(ctx.res, "/logistica/transportatori");
    const buf = Buffer.from(o.fisier, "base64");
    ctx.res.writeHead(200, {
      "Content-Type": o.fisier_tip || "application/octet-stream",
      "Content-Disposition": `inline; filename="${String(o.fisier_nume || "oferta").replace(/[^\w.\-]/g, "_")}"`,
      "Content-Length": buf.length,
    });
    ctx.res.end(buf);
  });

  router.get("/logistica/oferta/:id", async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    const o = await db
      .prepare("SELECT o.*, t.nume AS transportator FROM transport_oferte o JOIN transportatori t ON t.id = o.transportator_id WHERE o.id = ?")
      .get(id);
    if (!o) return redirect(ctx.res, "/logistica/transportatori");
    const tarife = await db.prepare("SELECT * FROM transport_tarife WHERE oferta_id = ? ORDER BY id").all(id);

    const randuri = tarife.map((t) => [
      esc(t.localitate || t.judet || "orice destinație"),
      esc(t.fel),
      bani(t.pret, o.moneda) + (t.fel === "palet" ? " /palet" : t.fel === "kg" ? " /kg" : t.fel === "km" ? " /km" : " /cursă"),
      cate(t.pret_minim) > 0 ? bani(t.pret_minim, o.moneda) : "—",
      [
        t.greutate_de_la != null || t.greutate_pana_la != null ? `${t.greutate_de_la ?? 0}–${t.greutate_pana_la ?? "∞"} kg` : "",
        t.paleti_de_la != null || t.paleti_pana_la != null ? `${t.paleti_de_la ?? 0}–${t.paleti_pana_la ?? "∞"} pal.` : "",
        t.km_de_la != null || t.km_pana_la != null ? `${t.km_de_la ?? 0}–${t.km_pana_la ?? "∞"} km` : "",
      ].filter(Boolean).join(" · ") || "fără limite",
      t.zile_livrare == null ? "—" : `${t.zile_livrare} ${Number(t.zile_livrare) === 1 ? "zi" : "zile"}`,
      `${t.capacitate_paleti ? Math.round(t.capacitate_paleti) + " pal." : ""}${t.capacitate_paleti && t.capacitate_kg ? " · " : ""}${t.capacitate_kg ? Math.round(t.capacitate_kg) + " kg" : ""}` || "—",
      `<form method="post" action="/logistica/oferta/${id}/tarif/${t.id}/sterge" class="inline-form"><button class="link-btn danger" type="submit">Șterge</button></form>`,
    ]);

    const body = `
      <h2 style="margin-top:0">${esc(o.nume || "Ofertă")} <span style="font-weight:400;color:var(--text-muted)">· ${esc(o.transportator)}</span></h2>
      <p style="color:var(--text-muted);margin-top:-6px">
        Valabilă ${esc(o.valabil_de_la || "—")} → ${esc(o.valabil_pana_la || "—")} · ${esc(o.moneda)}
        ${o.suprataxa_combustibil_pct ? ` · suprataxă combustibil +${o.suprataxa_combustibil_pct}%` : ""}
        ${o.fisier_nume ? ` · <a href="/logistica/oferta/${o.id}/fisier">${esc(o.fisier_nume)}</a>` : ""}
      </p>
      <p style="max-width:800px;color:var(--text-muted)">
        Un rând scris anume pentru o localitate bate rândul general: ăla e prețul negociat, celălalt e lista de preț.
        Prețul minim pe cursă e motivul pentru care un colet de 2 kg la 400 km nu costă 2 lei — scrie-l, altfel
        clasamentul va arăta un preț care nu există.
      </p>
      ${table(["Unde", "Fel", "Preț", "Minim/cursă", "Se aplică la", "Durată", "Cât încape", ""], randuri)}

      <h3 style="margin-top:24px">Adaugă un rând de tarif</h3>
      <form method="post" action="/logistica/oferta/${id}/tarif" class="form" style="max-width:980px">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
          <label class="field"><span>Fel</span>
            <select name="fel">
              <option value="palet">lei / palet</option>
              <option value="kg">lei / kg</option>
              <option value="km">lei / km</option>
              <option value="cursa">preț fix pe cursă</option>
            </select></label>
          <label class="field"><span>Preț</span><input type="number" step="0.01" name="pret" required></label>
          <label class="field"><span>Minim pe cursă</span><input type="number" step="0.01" name="pret_minim"></label>
          <label class="field"><span>Zile până ajunge</span><input type="number" step="1" name="zile_livrare"></label>
          <label class="field"><span>Localitate (gol = oriunde)</span><input name="localitate"></label>
          <label class="field"><span>Județ (gol = oriunde)</span><input name="judet"></label>
          <label class="field"><span>Capacitate kg</span><input type="number" step="1" name="capacitate_kg"></label>
          <label class="field"><span>Capacitate paleți</span><input type="number" step="1" name="capacitate_paleti"></label>
          <label class="field"><span>Greutate de la</span><input type="number" step="0.1" name="greutate_de_la"></label>
          <label class="field"><span>Greutate până la</span><input type="number" step="0.1" name="greutate_pana_la"></label>
          <label class="field"><span>Paleți de la</span><input type="number" step="1" name="paleti_de_la"></label>
          <label class="field"><span>Paleți până la</span><input type="number" step="1" name="paleti_pana_la"></label>
        </div>
        <button class="btn" type="submit">Adaugă rândul</button>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Ofertă transport", active: "/logistica/transportatori", body }));
  });

  router.post("/logistica/oferta/:id/tarif", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.body || {};
    const fel = T.FELURI.includes(String(b.fel)) ? String(b.fel) : "palet";
    await db
      .prepare(
        `INSERT INTO transport_tarife (oferta_id, fel, judet, localitate, km_de_la, km_pana_la, greutate_de_la,
                                       greutate_pana_la, paleti_de_la, paleti_pana_la, pret, pret_minim,
                                       zile_livrare, capacitate_kg, capacitate_paleti)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, fel, text(b.judet, 60), text(b.localitate, 120),
        num(b.km_de_la), num(b.km_pana_la), num(b.greutate_de_la), num(b.greutate_pana_la),
        num(b.paleti_de_la), num(b.paleti_pana_la), num(b.pret) || 0, num(b.pret_minim) || 0,
        num(b.zile_livrare), num(b.capacitate_kg), num(b.capacitate_paleti)
      );
    redirect(ctx.res, `/logistica/oferta/${id}`);
  });

  router.post("/logistica/oferta/:id/tarif/:tid/sterge", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    await db.prepare("DELETE FROM transport_tarife WHERE id = ? AND oferta_id = ?").run(
      parseInt(ctx.params.tid, 10),
      parseInt(ctx.params.id, 10)
    );
    redirect(ctx.res, `/logistica/oferta/${parseInt(ctx.params.id, 10)}`);
  });

  // ---- Rezervări mașini ---------------------------------------------------
  router.post("/logistica/rezervare", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    const b = ctx.body || {};
    const tid = parseInt(b.transportator_id, 10);
    const de_la = text(b.de_la, 10);
    if (!tid || !de_la) return redirect(ctx.res, "/logistica/transportatori");
    await db
      .prepare(
        `INSERT INTO transport_rezervari (transportator_id, de_la, pana_la, ce, stare, creata_de, creata_la)
         VALUES (?, ?, ?, ?, 'activa', ?, ?)`
      )
      .run(tid, de_la, text(b.pana_la, 10) || de_la, text(b.ce, 200), ctx.user ? ctx.user.nume : null, azi());
    redirect(ctx.res, `/logistica/transportator/${tid}`);
  });

  router.post("/logistica/rezervare/:id/anuleaza", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/transportatori");
    const r = await db.prepare("SELECT transportator_id FROM transport_rezervari WHERE id = ?").get(parseInt(ctx.params.id, 10));
    await db.prepare("UPDATE transport_rezervari SET stare = 'anulata' WHERE id = ?").run(parseInt(ctx.params.id, 10));
    redirect(ctx.res, r ? `/logistica/transportator/${r.transportator_id}` : "/logistica/transportatori");
  });

  // ---- Distanțe ----------------------------------------------------------
  router.get("/logistica/distante", async (ctx) => {
    const d = await db.prepare("SELECT * FROM transport_distante ORDER BY localitate LIMIT 500").all();
    const randuri = d.map((x) => [
      esc(x.localitate),
      esc(x.judet || "—"),
      Math.round(x.km) + " km",
      Math.round(x.km * 2) + " km",
      esc(x.adaugat_de || "—"),
      `<form method="post" action="/logistica/distante/${x.id}/sterge" class="inline-form"><button class="link-btn danger" type="submit">Șterge</button></form>`,
    ]);
    const body = `
      <p style="max-width:780px;color:var(--text-muted)">
        Distanțele se scriu o dată și de-atunci se știu. Fără ele, orice tarif pe km și orice calcul de mașină proprie
        dau „nu știu" — niciodată zero. Coloana a doua e ce se socotește de fapt la mașina noastră: dus-întors.
      </p>
      ${table(["Localitate", "Județ", "Dus", "Dus-întors", "Scrisă de", ""], randuri)}
      <h3 style="margin-top:24px">Adaugă</h3>
      <form method="post" action="/logistica/distante" class="form" style="max-width:640px">
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px">
          <label class="field"><span>Localitate</span><input name="localitate" required></label>
          <label class="field"><span>Județ</span><input name="judet"></label>
          <label class="field"><span>Km (dus)</span><input type="number" step="1" name="km" required></label>
        </div>
        <button class="btn" type="submit">Adaugă</button>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Distanțe", active: "/logistica/distante", body }));
  });

  router.post("/logistica/distante", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/distante");
    const b = ctx.body || {};
    const localitate = text(b.localitate, 120);
    const km = num(b.km);
    if (!localitate || km == null || km <= 0) return redirect(ctx.res, "/logistica/distante");
    const cheie = T.cheie(localitate);
    const exista = await db.prepare("SELECT id FROM transport_distante WHERE cheie = ?").get(cheie);
    if (exista) await db.prepare("UPDATE transport_distante SET km = ?, localitate = ?, judet = ? WHERE id = ?").run(km, localitate, text(b.judet, 60), exista.id);
    else
      await db
        .prepare("INSERT INTO transport_distante (cheie, localitate, judet, km, adaugat_de, creat_la) VALUES (?, ?, ?, ?, ?, ?)")
        .run(cheie, localitate, text(b.judet, 60), km, ctx.user ? ctx.user.nume : null, azi());
    redirect(ctx.res, "/logistica/distante");
  });

  router.post("/logistica/distante/:id/sterge", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/logistica/distante");
    await db.prepare("DELETE FROM transport_distante WHERE id = ?").run(parseInt(ctx.params.id, 10));
    redirect(ctx.res, "/logistica/distante");
  });
}

module.exports = { register, optiuniTransport, kmStiuti };
