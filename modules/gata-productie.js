"use strict";
// „Gata din producție — de alocat": lista din Depozit → Intrare marfă și
// butoanele ei. Datele și regulile sunt în lib/gata-productie.js; aici e ce
// vede depozitul și ce se întâmplă la fiecare buton:
//
//   Pune pe raft     → Intrarea marfă se deschide completată (produs, cât mai
//                      e de pus, UM, furnizorul la marfa de la terți), iar
//                      paletul rămâne legat de recepție sau de cerere.
//   Direct la livrare / în fulfillment
//                    → se face paletul, fără loc, legat la fel, și se deschide
//                      ieșirea din CT-Park cu el bifat și cu destinația aleasă
//                      (la comandă iese avizul, ca la orice ieșire).
//   Nu mai e de alocat (doar cererile vechi „intrată în stoc")
//                    → iese din listă cu motiv, fără să facă stoc.
//
// Recepția din producție încă nenumărată se ia „cum a anunțat-o producția"
// (modules/receptie.js, primesteTot + finalizeaza) — exact ce ar fi făcut
// omul apăsând „Finalizează" fără să schimbe cifrele.

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
  const q = query || {};
  const mesaj =
    (q.gata_ok ? `<div class="detail-box" style="border-left:4px solid var(--success,#15803d);margin:6px 0">${esc(String(q.gata_ok))}</div>` : "") +
    (q.gata_eroare ? `<div class="detail-box" role="alert" style="border-left:4px solid var(--danger,#b91c1c);margin:6px 0"><strong>${esc(String(q.gata_eroare))}</strong></div>` : "");
  if (!lista.length) return mesaj;
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
      ? `recepția ${linkDaca(user, `/depozit/receptie/${x.receptie_id}`, x.receptie_numar)}${x.productie_numar ? ` · producția ${linkDaca(user, `/productie/${x.productie_id}`, x.productie_numar)}` : ""}`
      : `cererea #${x.id} · ${x.sursa === "productie" ? `producție${x.productie_numar ? " " + linkDaca(user, `/productie/${x.productie_id}`, x.productie_numar) : ""}` : `terț${x.furnizor ? " " + esc(x.furnizor) : ""}`}`;
    const pentru = x.comanda_id
      ? `${linkDaca(user, `/comenzi/${x.comanda_id}`, x.comanda_numar || "#" + x.comanda_id)}${x.client ? " · " + esc(x.client) : ""}`
      : x.client
        ? esc(x.client)
        : '<span style="color:var(--text-muted)">de stoc</span>';
    // Butoanele stau sub produs, în prima coloană: pe telefon, tabelul se
    // derulează în lateral, iar ce ai de apăsat trebuie să se vadă fără asta.
    // „Direct" și „Nu mai e de alocat" se deschid la clic, ca rândul să rămână
    // scurt.
    const actiuni = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;margin-top:6px">
        <form method="post" action="${baza}/raft" class="inline-form" style="margin:0">
          <button class="btn small" type="submit">Pune pe raft →</button>
        </form>
        <details class="gata-direct">
          <summary class="btn small secondary" style="list-style:none;cursor:pointer;display:inline-flex;align-items:center">Direct…</summary>
          <form method="post" action="${baza}/livrare" style="display:grid;gap:6px;margin-top:6px;min-width:220px;max-width:280px">
            <select name="destinatie" aria-label="Unde pleacă" required>
              <option value="">unde pleacă…</option>
              <option value="comanda"${x.comanda_id ? " selected" : ""}>la client, pe comandă (cu aviz)</option>
              <option value="fulfillment">în fulfillment</option>
            </select>
            <select name="comanda_id" aria-label="Comanda clientului">${optComenzi(x.comanda_id)}</select>
            <button class="btn small secondary" type="submit">Deschide ieșirea →</button>
          </form>
        </details>
        ${
          x.veche
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

  return `${mesaj}
    <section class="detail-box" id="gata-productie" style="border-left:4px solid var(--warn,#c07018);margin:0 0 16px">
      <h2 style="margin:0 0 4px;font-size:17px">Gata din producție — de alocat <span class="badge galben">${lista.length}</span></h2>
      <p style="margin:0 0 8px;font-size:13px;color:var(--text-muted);max-width:900px">
        Marfa terminată în producție (comanda de producție pusă pe „Finalizată”) și cererile marcate „intrată în stoc”
        care n-au loc în CT-Park. Pune-o pe raft, trimite-o direct în fulfillment sau direct la livrare pe comanda
        clientului. Ce vine din producție se ia cu cantitatea anunțată; dacă a venit altceva, deschide recepția și numără.
      </p>
      <div class="tabel-scroll"><table class="table">
        <thead><tr><th>Produs</th><th>De alocat</th><th>De unde / pentru</th><th>Stare</th></tr></thead>
        <tbody>${lista.map(rand).join("")}</tbody>
      </table></div>
    </section>`;
}

// Recepția din producție, numărată „cum a fost anunțată" dacă nu e încă.
async function receptiaGata(lid, user) {
  const l = await db
    .prepare("SELECT l.id, l.receptie_id, r.stare, r.sursa FROM receptii_linii l JOIN receptii r ON r.id = l.receptie_id WHERE l.id = ?")
    .get(Number(lid) || 0);
  if (!l || l.sursa !== "productie") return { eroare: "Rândul de recepție nu există." };
  if (l.stare === "anulata") return { eroare: "Recepția e anulată." };
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

  router.post("/stocuri/ct-park/gata/cerere/:id/inchide", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const x = await GP.inchide(ctx.params.id, (ctx.body || {}).motiv, ctx.user);
    return inapoi(ctx, x.ok ? "gata_ok" : "gata_eroare", x.ok ? x.mesaj : x.eroare);
  });
}

module.exports = { register, sectiune, receptiaGata };
