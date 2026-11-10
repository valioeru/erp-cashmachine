"use strict";
// „Gata din producție — de alocat": lista din Depozit → Intrare marfă și
// butoanele ei. Datele și regulile sunt în lib/gata-productie.js; aici e ce
// vede depozitul și ce se întâmplă la fiecare buton:
//
//   Pune pe raft     → Intrarea marfă se deschide completată (produs, cât mai
//                      e de pus, UM, furnizorul la marfa de la terți), iar
//                      paletul rămâne legat de recepție sau de cerere.
//   Alocă pe cantități
//                    → Vali, 09.11.2026: „o parte la client, o parte în depozit
//                      și alta în fulfillment… orice combinație, să alegi și
//                      cantitatea, iar dacă mai rămâne să rămână în alocare până
//                      la epuizarea întregii cantități". Pentru client și
//                      fulfillment se face câte un palet fără loc, legat de
//                      recepție sau de cerere; partea de raft deschide Intrarea
//                      cu cantitatea ei. Ce nu se alocă rămâne în listă.
//   Pregătite pentru ieșire
//                    → paleții făcuți pentru client sau fulfillment, cu butonul
//                      care deschide ieșirea din CT-Park (la comandă iese avizul,
//                      ca la orice ieșire) și „Renunță", care îi desface.
//   Nu mai e de alocat (cererile vechi „intrată în stoc" și rândurile deja
//                      numărate ale recepțiilor)
//                    → iese din listă cu motiv, fără să facă stoc; rândul de
//                      recepție nu mai e nici „de pus" în stocul CT-Park.
//
// Recepția din producție încă nenumărată se ia „cum a anunțat-o producția"
// (modules/receptie.js, primesteTot + finalizeaza) — exact ce ar fi făcut
// omul apăsând „Finalizează" fără să schimbe cifrele.
//
// Tot aici, sub lista din producție (Vali, 10.11.2026: „la fel ca și comenzile
// intrate din producție, în lista de sus apar și altele, de la furnizori,
// imediat după ce au fost recepționate, ca să poată fi alocate pe raft"):
//
//   Recepționat de la furnizori — de alocat
//                    → rândurile recepțiilor finalizate de la furnizori (și ale
//                      retururilor) a căror marfă n-are încă palet, cu aceleași
//                      butoane. Recepția de la furnizor nenumărată nu apare:
//                      întâi se numără.
//   Paleți cu etichetă, fără loc pe raft
//                    → paleții făcuți la recepție („Paleți și etichete"), cu
//                      eticheta lipită, care încă n-au loc. Marfa lor are deja
//                      palet, deci n-ar mai apărea în listele de mai sus.

const db = require("../lib/db");
const { esc } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { poateAccesa } = require("../lib/auth");
const GP = require("../lib/gata-productie");

const INTRARE = "/stocuri/ct-park/intrare";
const cant = (v) => (Number(v) || 0).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
const poate = (u) => Boolean(u) && poateAccesa(u, INTRARE);
const inapoi = (ctx, cheie, text) => redirect(ctx.res, `${INTRARE}?${cheie}=${encodeURIComponent(text)}#gata-productie`);

function linkDaca(user, href, text) {
  return poateAccesa(user, href) ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

// Secțiunea de pe Intrare marfă. Goală când nu e nimic de alocat.
async function sectiune(user, query) {
  const lista = await GP.lista().catch(() => []);
  const furnizori = await GP.receptiiFurnizori().catch(() => []);
  // Paleții cu etichetă care așteaptă raftul (lib/ct-scaner.js, faraLoc): cei
  // pregătiți pentru o ieșire directă sunt mai jos, la „Pregătite pentru ieșire".
  const faraLoc = await require("../lib/ct-scaner").faraLoc("toate").catch(() => []);
  const gata = await GP.pregatite().catch(() => []);
  const q = query || {};
  const mesaj =
    (q.gata_ok ? `<div class="detail-box" style="border-left:4px solid var(--success,#15803d);margin:6px 0">${esc(String(q.gata_ok))}</div>` : "") +
    (q.gata_eroare ? `<div class="detail-box" role="alert" style="border-left:4px solid var(--danger,#b91c1c);margin:6px 0"><strong>${esc(String(q.gata_eroare))}</strong></div>` : "");
  if (!lista.length && !furnizori.length && !faraLoc.length && !gata.length) return mesaj;
  const comenzi = await db
    .prepare(
      `SELECT c.id, c.numar, p.nume AS client FROM comenzi c JOIN parteneri p ON p.id = c.partener_id
        WHERE c.status NOT IN ('anulata', 'livrata', 'ciorna') ORDER BY c.id DESC LIMIT 200`
    )
    .all()
    .catch(() => []);
  const optComenzi = (ales) =>
    `<option value="">— comanda —</option>` +
    comenzi
      .map((c) => `<option value="${c.id}"${Number(c.id) === Number(ales) ? " selected" : ""}>${esc(c.numar || "#" + c.id)} · ${esc(c.client)}</option>`)
      .join("");

  const rand = (x) => {
    const baza = `/stocuri/ct-park/gata/${x.fel}/${x.id}`;
    const de = x.fel === "receptie"
      ? `recepția ${linkDaca(user, `/depozit/receptie/${x.receptie_id}`, x.receptie_numar)}${x.productie_numar ? ` · producția ${linkDaca(user, `/productie/${x.productie_id}`, x.productie_numar)}` : ""}${
          x.sursa_text ? ` · ${esc(x.sursa_text)}${x.partener ? " <strong>" + esc(x.partener) + "</strong>" : ""}${x.document ? ` · ${esc(x.document)}` : ""}` : ""
        }`
      : `cererea #${x.id} · ${x.sursa === "productie" ? `producție${x.productie_numar ? " " + linkDaca(user, `/productie/${x.productie_id}`, x.productie_numar) : ""}` : `terț${x.furnizor ? " " + esc(x.furnizor) : ""}`}`;
    const pentru = x.comanda_id
      ? `${linkDaca(user, `/comenzi/${x.comanda_id}`, x.comanda_numar || "#" + x.comanda_id)}${x.client ? " · " + esc(x.client) : ""}`
      : x.client
        ? esc(x.client)
        : '<span style="color:var(--text-muted)">de stoc</span>';
    // Butoanele stau sub produs, în prima coloană: pe telefon, tabelul se
    // derulează în lateral, iar ce ai de apăsat trebuie să se vadă fără asta.
    // „Alocă pe cantități" și „Nu mai e de alocat" se deschid la clic, ca
    // rândul să rămână scurt.
    const actiuni = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;margin-top:6px">
        <form method="post" action="${baza}/raft" class="inline-form" style="margin:0">
          <button class="btn small" type="submit">Pune pe raft →</button>
        </form>
        <details class="gata-aloca">
          <summary class="btn small secondary" style="list-style:none;cursor:pointer;display:inline-flex;align-items:center">Alocă pe cantități…</summary>
          <form method="post" action="${baza}/aloca" style="display:grid;gap:6px;margin-top:6px;min-width:240px;max-width:300px">
            <div class="mic" style="color:var(--text-muted)">Din ${cant(x.ramas)} ${esc(x.um)} de alocat. Ce nu aloci acum rămâne aici.</div>
            <label class="gata-cant" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0;font-size:13px">La client, pe comandă <span><input name="q_client" inputmode="decimal" placeholder="0" style="width:90px;text-align:right" aria-label="Cantitate la client"> ${esc(x.um)}</span></label>
            <select name="comanda_id" aria-label="Comanda clientului">${optComenzi(x.comanda_id)}</select>
            <label class="gata-cant" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0;font-size:13px">În fulfillment <span><input name="q_fulfillment" inputmode="decimal" placeholder="0" style="width:90px;text-align:right" aria-label="Cantitate în fulfillment"> ${esc(x.um)}</span></label>
            <label class="gata-cant" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0;font-size:13px">Pe raft în CT-Park <span><input name="q_raft" inputmode="decimal" placeholder="0" style="width:90px;text-align:right" aria-label="Cantitate pe raft"> ${esc(x.um)}</span></label>
            <label style="display:flex;gap:6px;align-items:flex-start;margin:0;font-size:12px;color:var(--text-muted)">
              <input type="checkbox" name="peste" value="1" style="margin-top:2px"> <span>a venit mai mult decât scrie aici — se salvează cantitatea pe care o scriu</span></label>
            <button class="btn small" type="submit">Alocă →</button>
          </form>
        </details>
        ${
          x.veche || x.numarata
            ? `<details class="gata-inchide">
                 <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding-top:5px">Nu mai e de alocat</summary>
                 <form method="post" action="${baza}/inchide" style="display:grid;gap:6px;margin-top:6px;min-width:220px;max-width:280px">
                   <input name="motiv" required minlength="3" maxlength="300" placeholder="e deja pe raft / a plecat la client…">
                   <button class="btn small secondary" type="submit">Scoate din listă</button>
                 </form></details>`
            : ""
        }
      </div>`;
    return `<tr>
        <td style="min-width:220px"><strong>${esc(x.denumire)}</strong>${x.cod ? ` <span class="mic" style="color:var(--text-muted)">${esc(x.cod)}</span>` : ""}${actiuni}</td>
        <td><strong>${cant(x.ramas)} ${esc(x.um)}</strong>${x.pus > GP.EPS ? `<div class="mic" style="color:var(--text-muted)">din ${cant(x.cantitate)}; alocat deja ${cant(x.pus)}</div>` : ""}</td>
        <td style="white-space:normal;min-width:200px">${de}<div class="mic" style="margin-top:2px">${x.comanda_id || x.client ? "pentru " : ""}${pentru}</div></td>
        <td style="white-space:normal"><span class="badge ${x.veche ? "rosu" : "galben"}">${esc(x.stare)}</span>${x.data ? `<div class="mic" style="color:var(--text-muted)">${esc(x.data.split("-").reverse().join("."))}</div>` : ""}</td>
      </tr>`;
  };

  const randGata = (p) => `<tr>
        <td style="min-width:220px"><strong>${esc(p.denumire)}</strong>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
            <a class="btn small" href="${esc(p.iesire)}">${p.destinatie === "comanda" ? "Scoate la client →" : p.destinatie === "fulfillment" ? "Scoate în fulfillment →" : "Scoate →"}</a>
            <form method="post" action="/stocuri/ct-park/gata/palet/${p.id}/renunta" class="inline-form" style="margin:0"
                  onsubmit="return confirm('Desfaci paletul ${esc(p.cod)}? Cantitatea lui se întoarce în lista de alocat.')">
              <button class="btn small secondary" type="submit">Renunță</button>
            </form>
          </div></td>
        <td><strong>${cant(p.cantitate)} ${esc(p.um)}</strong></td>
        <td style="white-space:normal">${
          p.destinatie === "comanda"
            ? `la client${p.comanda_id ? ": " + linkDaca(user, `/comenzi/${p.comanda_id}`, p.comanda_numar || "#" + p.comanda_id) + (p.client ? " · " + esc(p.client) : "") : ""}`
            : p.destinatie === "fulfillment"
              ? "în fulfillment"
              : p.destinatie === "productie"
                ? "în producție"
                : esc(p.destinatie)
        }<div class="mic" style="color:var(--text-muted)">din ${esc(p.din)}</div></td>
        <td>${linkDaca(user, `/stocuri/ct-park/palet/${p.id}`, p.cod || "#" + p.id)}<div class="mic" style="color:var(--text-muted)">fără loc pe raft</div></td>
      </tr>`;

  // Paletul are deja etichetă; îi lipsește doar locul. Se pune cu pagina de
  // scanare a paletului, care merge și de pe calculator: propune locuri lângă
  // același produs și verifică locul ales.
  const SURSA_PALET = { productie: "din producție", furnizor: "de la furnizor", retur_tert: "retur de la client", retur_fulfilment: "retur din fulfillment", inventar_initial: "stoc inițial" };
  const randFaraLoc = (p) => `<tr>
        <td style="min-width:220px"><strong>${esc(p.denumire)}</strong>${p.produs_cod ? ` <span class="mic" style="color:var(--text-muted)">${esc(p.produs_cod)}</span>` : ""}
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
            <a class="btn small" href="/stocuri/ct-park/scaner/intrare/palet/${p.id}">Pune pe raft →</a>
            <a class="btn small secondary" href="/stocuri/ct-park/etichete?paleti=${p.id}" target="_blank">Eticheta</a>
          </div></td>
        <td><strong>${cant(p.cantitate)} ${esc(p.um || "")}</strong>${p.lot ? `<div class="mic" style="color:var(--text-muted)">lot ${esc(p.lot)}</div>` : ""}</td>
        <td style="white-space:normal">${esc(SURSA_PALET[p.sursa] || "fără recepție")}${
          p.receptie_id ? ` · recepția ${linkDaca(user, `/depozit/receptie/${p.receptie_id}`, p.receptie_numar || "#" + p.receptie_id)}` : p.aprovizionare_id ? ` · cererea #${Number(p.aprovizionare_id)}` : ""
        }</td>
        <td>${linkDaca(user, `/stocuri/ct-park/palet/${p.id}`, p.cod || "#" + p.id)}${
          p.data_intrare ? `<div class="mic" style="color:var(--text-muted)">${esc(String(p.data_intrare).slice(0, 10).split("-").reverse().join("."))}</div>` : ""
        }</td>
      </tr>`;

  // Ce mai e în casetă, sub lista din producție: se vede de sus, ca marfa de
  // la furnizori să nu stea ascunsă sub o listă lungă.
  const maiJos = [
    furnizori.length ? `<a href="#de-la-furnizori">de la furnizori (${furnizori.length})</a>` : "",
    faraLoc.length ? `<a href="#fara-loc">paleți fără loc pe raft (${faraLoc.length})</a>` : "",
    gata.length ? `<a href="#pregatite">pregătite pentru ieșire (${gata.length})</a>` : "",
  ].filter(Boolean);

  return `${mesaj}
    <section class="detail-box" id="gata-productie" style="border-left:4px solid var(--warn,#c07018);margin:0 0 16px">
      <h2 style="margin:0 0 4px;font-size:17px">Gata din producție — de alocat <span class="badge galben">${lista.length}</span></h2>
      <p style="margin:0 0 8px;font-size:13px;color:var(--text-muted);max-width:900px">
        Marfa terminată în producție (comanda de producție pusă pe „Finalizată”) și cererile marcate „intrată în stoc”
        care n-au loc în CT-Park. Pune-o toată pe raft sau împarte-o pe cantități: o parte la client, o parte în
        fulfillment, o parte pe raft — ce nu aloci rămâne aici. Ce vine din producție se ia cu cantitatea anunțată;
        dacă a venit altceva, deschide recepția și numără.
      </p>
      ${maiJos.length ? `<p class="gata-mai-jos" style="margin:0 0 8px;font-size:13px">Tot aici, mai jos: ${maiJos.join(" · ")}.</p>` : ""}
      ${
        lista.length
          ? `<div class="tabel-scroll"><table class="table">
        <thead><tr><th>Produs</th><th>De alocat</th><th>De unde / pentru</th><th>Stare</th></tr></thead>
        <tbody>${lista.map(rand).join("")}</tbody>
      </table></div>`
          : '<p style="margin:0;font-size:13px">Nimic de alocat acum.</p>'
      }
      ${
        furnizori.length
          ? `<h3 id="de-la-furnizori" style="margin:16px 0 4px;font-size:15px">Recepționat de la furnizori — de alocat <span class="badge galben">${furnizori.length}</span></h3>
      <p style="margin:0 0 8px;font-size:13px;color:var(--text-muted);max-width:900px">
        Marfa de la furnizori și retururile apar aici imediat ce recepția lor e finalizată. Se alocă la fel ca marfa din
        producție: toată pe raft sau pe cantități. Un rând iese din listă când toată cantitatea lui are palet.
      </p>
      <div class="tabel-scroll"><table class="table">
        <thead><tr><th>Produs</th><th>De alocat</th><th>De unde / pentru</th><th>Stare</th></tr></thead>
        <tbody>${furnizori.map(rand).join("")}</tbody>
      </table></div>`
          : ""
      }
      ${
        faraLoc.length
          ? `<h3 id="fara-loc" style="margin:16px 0 4px;font-size:15px">Paleți cu etichetă, fără loc pe raft <span class="badge galben">${faraLoc.length}</span></h3>
      <p style="margin:0 0 8px;font-size:13px;color:var(--text-muted);max-width:900px">
        Paleții făcuți la recepție, cu eticheta lipită, care n-au încă loc. „Pune pe raft” deschide paletul cu locurile
        propuse lângă același produs; alegi unul (sau scanezi eticheta locului) și apeși Efectuează.
      </p>
      <div class="tabel-scroll"><table class="table">
        <thead><tr><th>Produs</th><th>Cantitate</th><th>De unde</th><th>Palet</th></tr></thead>
        <tbody>${faraLoc.map(randFaraLoc).join("")}</tbody>
      </table></div>`
          : ""
      }
      ${
        gata.length
          ? `<h3 id="pregatite" style="margin:16px 0 4px;font-size:15px">Pregătite pentru ieșire <span class="badge albastru">${gata.length}</span></h3>
      <p style="margin:0 0 8px;font-size:13px;color:var(--text-muted);max-width:900px">
        Paleții alocați la client sau în fulfillment, încă în depozit. „Scoate” deschide ieșirea din CT-Park cu paletul bifat
        (la client iese și avizul); „Renunță” desface paletul și îi întoarce cantitatea în lista de alocat.
      </p>
      <div class="tabel-scroll"><table class="table">
        <thead><tr><th>Produs</th><th>Cantitate</th><th>Unde pleacă</th><th>Palet</th></tr></thead>
        <tbody>${gata.map(randGata).join("")}</tbody>
      </table></div>`
          : ""
      }
    </section>`;
}

// Recepția din producție, numărată „cum a fost anunțată" dacă nu e încă.
// Recepția de la furnizor (sau un retur) trebuie să fie deja numărată: ce
// scrie pe aviz nu e neapărat ce a venit, deci nu se ia pe cuvânt.
async function receptiaGata(lid, user) {
  const l = await db
    .prepare("SELECT l.id, l.receptie_id, r.stare, r.sursa, r.numar FROM receptii_linii l JOIN receptii r ON r.id = l.receptie_id WHERE l.id = ?")
    .get(Number(lid) || 0);
  if (!l) return { eroare: "Rândul de recepție nu există." };
  if (l.stare === "anulata") return { eroare: "Recepția e anulată." };
  if (l.stare !== "finalizata" && l.sursa !== "productie") {
    return { eroare: `Recepția ${l.numar || "#" + l.receptie_id} nu e încă numărată. Deschide-o, numără marfa și finalizeaz-o; apoi o aloci de aici.` };
  }
  if (l.stare !== "finalizata") {
    const REC = require("./receptie");
    await REC.primesteTot(l.receptie_id);
    const f = await REC.finalizeaza(Number(l.receptie_id), user);
    if (f.eroare) return { eroare: f.eroare };
  }
  return { ok: true, receptie_id: Number(l.receptie_id), linie_id: Number(l.id) };
}

function register(router) {
  router.post("/stocuri/ct-park/gata/receptie/:id/raft", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const x = await receptiaGata(ctx.params.id, ctx.user);
    if (x.eroare) return inapoi(ctx, "gata_eroare", x.eroare);
    redirect(ctx.res, `${INTRARE}?receptie_linie=${x.linie_id}`);
  });

  router.post("/stocuri/ct-park/gata/receptie/:id/livrare", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const b = ctx.body || {};
    if (!["comanda", "fulfillment"].includes(String(b.destinatie || ""))) return inapoi(ctx, "gata_eroare", "Alege unde pleacă marfa: livrare pe comanda clientului sau fulfillment.");
    if (b.destinatie === "comanda" && !(parseInt(b.comanda_id, 10) > 0)) return inapoi(ctx, "gata_eroare", "Alege comanda clientului pe care pleacă marfa.");
    const x = await receptiaGata(ctx.params.id, ctx.user);
    if (x.eroare) return inapoi(ctx, "gata_eroare", x.eroare);
    const l = await require("./receptie").livrareDirecta(ctx.user, x.receptie_id, x.linie_id, b.destinatie, b.comanda_id);
    if (l.eroare) return inapoi(ctx, "gata_eroare", l.eroare);
    redirect(ctx.res, l.url);
  });

  router.post("/stocuri/ct-park/gata/cerere/:id/raft", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const a = await GP.cerere(ctx.params.id);
    if (!a) return inapoi(ctx, "gata_eroare", "Cererea nu există.");
    redirect(ctx.res, `${INTRARE}?aprovizionare=${a.aprovizionare_id}`);
  });

  router.post("/stocuri/ct-park/gata/cerere/:id/livrare", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const b = ctx.body || {};
    const destinatie = String(b.destinatie || "");
    if (!["comanda", "fulfillment"].includes(destinatie)) return inapoi(ctx, "gata_eroare", "Alege unde pleacă marfa: livrare pe comanda clientului sau fulfillment.");
    const cid = destinatie === "comanda" ? parseInt(b.comanda_id, 10) || 0 : 0;
    if (destinatie === "comanda" && !cid) return inapoi(ctx, "gata_eroare", "Alege comanda clientului pe care pleacă marfa.");
    const a = await GP.cerere(ctx.params.id);
    if (!a) return inapoi(ctx, "gata_eroare", "Cererea nu există.");
    if (!(a.ramas > GP.EPS)) return inapoi(ctx, "gata_eroare", "Tot ce era pe cererea asta are deja palet în CT-Park.");
    const ids = await require("./ct-park").puneMarfa(
      { user: ctx.user },
      {
        produs_id: a.produs_id || "",
        um: a.um,
        furnizor_id: a.furnizor_id || "",
        categorie: a.categorie,
        observatii: `Direct ${destinatie === "fulfillment" ? "în fulfillment" : "la livrare"} din ${a.numar}`,
        aprovizionare_id: a.aprovizionare_id,
        iesire_plan: destinatie,
        iesire_comanda_id: cid || "",
      },
      [[]],
      a.ramas
    );
    if (!ids.length) return inapoi(ctx, "gata_eroare", "Paletul pentru livrare nu s-a putut face.");
    const q = new URLSearchParams({
      palet: String(ids[0]),
      destinatie,
      ...(cid ? { comanda_id: String(cid) } : {}),
      motiv: `livrare directă din ${a.numar}`,
    });
    redirect(ctx.res, "/stocuri/ct-park/iesire?" + q.toString());
  });

  // Alocarea pe cantități: la client (pe comandă), în fulfillment, pe raft —
  // orice combinație. Ce nu se alocă rămâne în listă.
  //
  // Peste cât a rămas se poate (Vali, 10.11.2026: „cantitatea recepționată
  // poate fi mai mare decât cea din comandă și se salvează cantitatea din
  // recepție"), dar doar cu bifa „a venit mai mult": fără ea, o cifră scrisă
  // greșit ar umfla recepția fără să observe nimeni.
  router.post("/stocuri/ct-park/gata/:fel/:id/aloca", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const fel = String(ctx.params.fel || "");
    if (fel !== "receptie" && fel !== "cerere") return inapoi(ctx, "gata_eroare", "Rândul nu există.");
    const b = ctx.body || {};
    const citit = (v) => {
      const t = String(v == null ? "" : v).trim();
      if (t === "") return 0;
      const n = Number(t.replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : NaN;
    };
    const parti = { client: citit(b.q_client), fulfillment: citit(b.q_fulfillment), raft: citit(b.q_raft) };
    if (Object.values(parti).some((v) => !Number.isFinite(v) || v < 0)) return inapoi(ctx, "gata_eroare", "Cantitățile se scriu ca numere, de la zero în sus.");
    const total = Math.round((parti.client + parti.fulfillment + parti.raft) * 1000) / 1000;
    if (!(total > GP.EPS)) return inapoi(ctx, "gata_eroare", "Scrie cât pleacă la client, cât în fulfillment sau cât pui pe raft.");
    const cid = parseInt(b.comanda_id, 10) || 0;
    if (parti.client > GP.EPS && !cid) return inapoi(ctx, "gata_eroare", "Alege comanda clientului pe care pleacă partea pentru client.");
    const peste = String(b.peste || "") === "1";

    // Cât e de alocat acum, și de unde se face paletul.
    let ramas = 0;
    let um = "";
    let faPalet = null;
    let intrare = "";
    if (fel === "receptie") {
      const x = await receptiaGata(ctx.params.id, ctx.user);
      if (x.eroare) return inapoi(ctx, "gata_eroare", x.eroare);
      const rand = await GP.randReceptie(x.linie_id);
      ramas = rand ? rand.ramas : 0;
      um = rand ? rand.um : "";
      const REC = require("./receptie");
      faPalet = (dest, q) => REC.livrareDirecta(ctx.user, x.receptie_id, x.linie_id, dest, dest === "comanda" ? cid : "", q, { peste });
      intrare = `${INTRARE}?receptie_linie=${x.linie_id}`;
    } else {
      const a = await GP.cerere(ctx.params.id);
      if (!a) return inapoi(ctx, "gata_eroare", "Cererea nu există.");
      ramas = a.ramas;
      um = a.um;
      faPalet = async (dest, q) => {
        const ids = await require("./ct-park").puneMarfa(
          { user: ctx.user },
          {
            produs_id: a.produs_id || "",
            um: a.um,
            furnizor_id: a.furnizor_id || "",
            categorie: a.categorie,
            observatii: `Direct ${dest === "fulfillment" ? "în fulfillment" : "la client"} din ${a.numar}`,
            aprovizionare_id: a.aprovizionare_id,
            iesire_plan: dest,
            iesire_comanda_id: dest === "comanda" ? cid : "",
          },
          [[]],
          q
        );
        if (!ids.length) return { eroare: "Paletul nu s-a putut face." };
        const qs = new URLSearchParams({ palet: String(ids[0]), destinatie: dest, ...(dest === "comanda" ? { comanda_id: String(cid) } : {}), motiv: `livrare directă din ${a.numar}` });
        return { ok: true, url: "/stocuri/ct-park/iesire?" + qs.toString(), palet: Number(ids[0]) };
      };
      intrare = `${INTRARE}?aprovizionare=${a.aprovizionare_id}`;
    }
    if (!(ramas > GP.EPS)) return inapoi(ctx, "gata_eroare", "Tot ce era de alocat pe rândul ăsta are deja palet.");
    if (total > ramas + GP.EPS && !peste) {
      return inapoi(
        ctx,
        "gata_eroare",
        `Ai împărțit ${cant(total)} ${um}, dar sunt de alocat doar ${cant(ramas)} ${um}. Dacă a venit mai mult, bifează „a venit mai mult” și trimite din nou: se salvează cantitatea scrisă de tine.`.replace(/\s+/g, " ")
      );
    }

    // Întâi paleții pentru ieșire; partea de raft se pune din Intrare.
    const facute = [];
    for (const dest of ["comanda", "fulfillment"]) {
      const q = dest === "comanda" ? parti.client : parti.fulfillment;
      if (!(q > GP.EPS)) continue;
      const r = await faPalet(dest, q);
      if (!r || r.eroare) return inapoi(ctx, "gata_eroare", (r && r.eroare) || "Paletul nu s-a putut face.");
      facute.push({ dest, q, url: r.url });
    }
    if (parti.raft > GP.EPS) return redirect(ctx.res, `${intrare}&cantitate=${encodeURIComponent(String(parti.raft))}${peste ? "&peste=1" : ""}`);
    // O singură ieșire: se deschide direct, ca până acum.
    if (facute.length === 1) return redirect(ctx.res, facute[0].url);
    const spus = facute.map((f) => `${cant(f.q)} ${um} ${f.dest === "comanda" ? "la client" : "în fulfillment"}`.replace(/\s+/g, " "));
    return redirect(
      ctx.res,
      `${INTRARE}?gata_ok=${encodeURIComponent(`Pregătit: ${spus.join(", ")}. Le scoți de jos, din „Pregătite pentru ieșire”.`)}#pregatite`
    );
  });

  router.post("/stocuri/ct-park/gata/palet/:id/renunta", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const x = await GP.renunta(ctx.params.id);
    return inapoi(ctx, x.ok ? "gata_ok" : "gata_eroare", x.ok ? x.mesaj : x.eroare);
  });

  router.post("/stocuri/ct-park/gata/receptie/:id/inchide", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const x = await GP.inchideReceptie(ctx.params.id, (ctx.body || {}).motiv, ctx.user);
    return inapoi(ctx, x.ok ? "gata_ok" : "gata_eroare", x.ok ? x.mesaj : x.eroare);
  });

  router.post("/stocuri/ct-park/gata/cerere/:id/inchide", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const x = await GP.inchide(ctx.params.id, (ctx.body || {}).motiv, ctx.user);
    return inapoi(ctx, x.ok ? "gata_ok" : "gata_eroare", x.ok ? x.mesaj : x.eroare);
  });
}

module.exports = { register, sectiune, receptiaGata };
