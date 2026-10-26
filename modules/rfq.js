"use strict";
// Cereri de preț (RFQ): agentul întreabă, achizițiile află, agentul ofertează.
//
// Drumul, pe scurt:
//   agentul scrie ce produs îi cere clientul și până când îi trebuie prețul
//   → cererea intră în lista achizițiilor
//   → cineva de acolo o preia, caută la furnizori și scrie ce a găsit
//   → agentul primește ÎNAPOI doar prețul de ofertare, cu adaos
//   → cererea rămâne în lista de oferte interne, pe categoria ei, ca data
//     viitoare să nu se mai ceară preț la același lucru.
//
// CE NU TREBUIE SĂ AJUNGĂ LA AGENT, niciodată: furnizorul, prețul de
// achiziție, moneda de achiziție și notele interne. Nu e o chestiune de
// încredere — e marja firmei, iar un agent care o știe o va apăra mai prost
// într-o negociere decât unul care nu o știe.
//
// Despărțirea se face într-un SINGUR loc, `pentruOchiiLui`, prin care trece
// tot ce ajunge în pagină. Nu prin „n-am pus câmpul în HTML": așa se scapă.
// O coloană nouă adăugată peste un an e internă până cineva o trece anume pe
// lista celor publice, nu invers.
const db = require("../lib/db");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");

const ADAOS_IMPLICIT = 20;

const STATUS_LABEL = {
  noua: '<span class="badge gri">nouă</span>',
  in_lucru: '<span class="badge albastru">la achiziții</span>',
  ofertata: '<span class="badge verde">are preț</span>',
  refuzata: '<span class="badge rosu">nu se poate</span>',
  anulata: '<span class="badge rosu">anulată</span>',
};
const eticheta = (s) => STATUS_LABEL[String(s || "")] || esc(String(s || "—"));

// „Achiziții" e rolul `depozit` — așa se numește în lib/auth (ROLURI), chiar
// dacă în cod îi zice depozit din motive de istorie.
function esteAchizitii(user) {
  return Boolean(user && (user.rol === "admin" || user.rol === "depozit"));
}
function esteAdmin(user) {
  return Boolean(user && user.rol === "admin");
}

const CAMPURI_INTERNE = [
  "furnizor_id",
  "furnizor_text",
  "furnizor_nume",
  "pret_achizitie",
  "moneda_achizitie",
  "note_interne",
  "preluat_de",
  "preluat_nume",
];

function pentruOchiiLui(user, rand) {
  if (esteAchizitii(user)) return rand;
  const copie = Object.assign({}, rand);
  for (const c of CAMPURI_INTERNE) delete copie[c];
  return copie;
}

async function adaosImplicit() {
  const r = await db
    .prepare("SELECT valoare FROM setari_app WHERE cheie = 'rfq_adaos_implicit'")
    .get()
    .catch(() => null);
  const v = r ? Number(String(r.valoare).replace(",", ".")) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : ADAOS_IMPLICIT;
}

async function scrieSetare(cheie, valoare) {
  const acum = new Date().toISOString();
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(String(valoare), acum, cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, String(valoare), acum);
}

// „Fără adaos scris pe cerere" NU înseamnă adaos zero.
//
// Capcana: coloana e NULL cât timp adminul n-a pus nimic, iar Number(null)
// e 0 — un zero perfect valid, finit și pozitiv, care trece de orice
// verificare. Rezultatul ar fi fost că agentul primește drept preț de
// ofertare exact prețul de achiziție: marja firmei, pusă pe masă, fără ca
// cineva să greșească ceva vizibil. Undefined nu avea problema asta
// (Number(undefined) e NaN), deci se vedea doar pe datele venite din bază.
//
// De-aia golul se verifică înainte de conversie, nu după.
const adaosulCererii = (r, implicit) => {
  const brut = r ? r.adaos : null;
  if (brut === null || brut === undefined || brut === "") return implicit;
  const v = Number(brut);
  return Number.isFinite(v) && v >= 0 ? v : implicit;
};

// Prețul cu care pleacă agentul la client. Se calculează, nu se stochează:
// dacă adaosul se schimbă, un preț scris în bază ar rămâne în urmă și ar
// arăta exact ca unul proaspăt.
function pretOfertare(r, implicit) {
  const cost = Number(r && r.pret_achizitie);
  if (!(cost > 0)) return null;
  return cost * (1 + adaosulCererii(r, implicit) / 100);
}

// Rândul gata de afișat: întâi se calculează prețul de ofertare (are nevoie
// de cost), abia apoi se taie câmpurile interne. Ordinea contează.
function deAfisat(user, r, implicit) {
  const pret = pretOfertare(r, implicit);
  const vazut = pentruOchiiLui(user, r);
  vazut.pret_ofertare = pret;
  vazut.adaos_folosit = adaosulCererii(r, implicit);
  return vazut;
}

const SELECT_RFQ = `
  SELECT r.*, u.nume AS agent_nume, f.nume AS furnizor_nume, pu.nume AS preluat_nume,
         c.nume AS client_nume
    FROM rfq r
    LEFT JOIN utilizatori u ON u.id = r.agent_id
    LEFT JOIN utilizatori pu ON pu.id = r.preluat_de
    LEFT JOIN parteneri f ON f.id = r.furnizor_id
    LEFT JOIN parteneri c ON c.id = r.partener_id`;

async function categoriiCunoscute() {
  const din = await db
    .prepare("SELECT DISTINCT categorie FROM produse WHERE activ = 1 AND categorie IS NOT NULL AND categorie <> ''")
    .all()
    .catch(() => []);
  const dinCereri = await db
    .prepare("SELECT DISTINCT categorie FROM rfq WHERE categorie IS NOT NULL AND categorie <> ''")
    .all()
    .catch(() => []);
  return [...new Set(din.concat(dinCereri).map((x) => String(x.categorie).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ro")
  );
}

function subnavRfq(activ, user) {
  const linkuri = [
    `<a href="/rfq" class="subnav-link${activ === "/rfq" ? " activ" : ""}">Cererile mele</a>`,
    `<a href="/rfq/nou" class="subnav-link${activ === "/rfq/nou" ? " activ" : ""}">Cerere nouă</a>`,
    `<a href="/rfq/oferte" class="subnav-link${activ === "/rfq/oferte" ? " activ" : ""}">Oferte interne</a>`,
  ];
  if (esteAchizitii(user)) {
    linkuri.splice(
      1,
      0,
      `<a href="/rfq?toate=1" class="subnav-link${activ === "/rfq/toate" ? " activ" : ""}">De rezolvat</a>`
    );
  }
  return `<div class="subnav">${linkuri.join("")}</div>`;
}

const zi = (v) => (v ? esc(String(v).slice(0, 10)) : "—");
const nr = (v) => (v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 }));

function register(router) {
  // ---- lista ------------------------------------------------------------
  router.get("/rfq", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const implicit = await adaosImplicit();
    const toate = esteAchizitii(ctx.user) && String(ctx.query.toate || "") === "1";
    const alMeu = !esteAchizitii(ctx.user);
    const cereri = alMeu
      ? await db.prepare(`${SELECT_RFQ} WHERE r.agent_id = ? ORDER BY r.id DESC LIMIT 300`).all(ctx.user.id)
      : toate
        ? await db.prepare(`${SELECT_RFQ} WHERE r.status IN ('noua','in_lucru') ORDER BY r.id DESC LIMIT 300`).all()
        : await db.prepare(`${SELECT_RFQ} ORDER BY r.id DESC LIMIT 300`).all();

    const randuri = cereri.map((x) => deAfisat(ctx.user, x, implicit));
    const deRezolvat = esteAchizitii(ctx.user)
      ? await db.prepare("SELECT COUNT(*) AS n FROM rfq WHERE status IN ('noua','in_lucru')").get()
      : null;

    const body = `
      ${subnavRfq(toate ? "/rfq/toate" : "/rfq", ctx.user)}
      <p style="max-width:780px;color:var(--text-muted)">
        ${
          esteAchizitii(ctx.user)
            ? "Cererile de preț venite de la agenți. Le preiei, cauți la furnizori și scrii ce ai găsit. Furnizorul și prețul de achiziție rămân aici — agentul primește doar prețul cu care poate ofertă."
            : "Produse pe care clienții le cer și noi nu le avem încă în nomenclator. Scrii ce îți trebuie și până când, iar achizițiile îți întorc prețul cu care poți ofertă."
        }
      </p>
      <div class="toolbar" style="gap:8px">
        <a href="/rfq/nou" class="btn">+ Cerere de preț</a>
        ${deRezolvat ? `<span class="badge ${Number(deRezolvat.n) ? "galben" : "gri"}">${Number(deRezolvat.n)} de rezolvat</span>` : ""}
      </div>
      ${
        randuri.length
          ? table(
              esteAchizitii(ctx.user)
                ? ["#", "Produs", "Agent", "Client", "Cantitate", "Țintă", "Termen ofertă", "Status", "Achiziție", "Ofertare", ""]
                : ["#", "Produs", "Cantitate", "Țintă", "Termen ofertă", "Status", "Preț de ofertare", ""],
              randuri.map((r) =>
                esteAchizitii(ctx.user)
                  ? [
                      String(r.id),
                      esc(r.denumire),
                      esc(r.agent_nume || "—"),
                      esc(r.client_nume || "—"),
                      `${nr(r.cantitate)} ${esc(r.um || "")}`,
                      r.pret_tinta ? money(r.pret_tinta) : "—",
                      zi(r.termen_ofertare),
                      eticheta(r.status),
                      r.pret_achizitie ? money(r.pret_achizitie) : "—",
                      r.pret_ofertare ? money(r.pret_ofertare) : "—",
                      `<a class="btn small" href="/rfq/${r.id}">Deschide</a>`,
                    ]
                  : [
                      String(r.id),
                      esc(r.denumire),
                      `${nr(r.cantitate)} ${esc(r.um || "")}`,
                      r.pret_tinta ? money(r.pret_tinta) : "—",
                      zi(r.termen_ofertare),
                      eticheta(r.status),
                      r.pret_ofertare ? `<strong>${money(r.pret_ofertare)}</strong>` : "—",
                      `<a class="btn small" href="/rfq/${r.id}">Deschide</a>`,
                    ]
              )
            )
          : `<p style="color:var(--text-muted)">Nicio cerere încă.</p>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cereri de preț", active: "/rfq", body }));
  });

  // ---- oferte interne ---------------------------------------------------
  //
  // Tot ce are preț, pe categorii. Rostul listei: înainte să ceri preț la
  // ceva, te uiți dacă nu l-a cerut deja altcineva luna trecută.
  router.get("/rfq/oferte", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const implicit = await adaosImplicit();
    const cat = String(ctx.query.categorie || "").trim();
    const cautat = String(ctx.query.q || "").trim().toLowerCase();
    let cereri = await db.prepare(`${SELECT_RFQ} WHERE r.status = 'ofertata' ORDER BY r.raspuns_la DESC NULLS LAST, r.id DESC LIMIT 500`).all();
    if (cat) cereri = cereri.filter((x) => String(x.categorie || "").trim() === cat);
    if (cautat) cereri = cereri.filter((x) => String(x.denumire || "").toLowerCase().includes(cautat));
    const randuri = cereri.map((x) => deAfisat(ctx.user, x, implicit));
    const categorii = await categoriiCunoscute();

    const body = `
      ${subnavRfq("/rfq/oferte", ctx.user)}
      <p style="max-width:780px;color:var(--text-muted)">
        Prețurile obținute până acum, pe categorii. Uită-te aici înainte să ceri preț la ceva —
        poate l-a cerut deja un coleg, iar oferta mai e valabilă.
      </p>
      <form class="filtre" method="get" action="/rfq/oferte" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <label class="field"><span>Categorie</span>
          <select name="categorie">
            <option value="">— toate —</option>
            ${categorii.map((c) => `<option value="${esc(c)}"${c === cat ? " selected" : ""}>${esc(c)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Caută în denumire</span><input type="search" name="q" value="${esc(cautat)}"></label>
        <button class="btn secondary small" type="submit">Filtrează</button>
      </form>
      ${
        randuri.length
          ? table(
              esteAchizitii(ctx.user)
                ? ["Produs", "Categorie", "Cantitate", "Furnizor", "Achiziție", "Ofertare", "Valabil până", "Răspuns"]
                : ["Produs", "Categorie", "Cantitate", "Preț de ofertare", "Termen livrare", "Valabil până"],
              randuri.map((r) =>
                esteAchizitii(ctx.user)
                  ? [
                      `<a href="/rfq/${r.id}">${esc(r.denumire)}</a>`,
                      esc(r.categorie || "—"),
                      `${nr(r.cantitate)} ${esc(r.um || "")}`,
                      esc(r.furnizor_nume || r.furnizor_text || "—"),
                      r.pret_achizitie ? money(r.pret_achizitie) : "—",
                      r.pret_ofertare ? money(r.pret_ofertare) : "—",
                      zi(r.valabil_pana),
                      zi(r.raspuns_la),
                    ]
                  : [
                      `<a href="/rfq/${r.id}">${esc(r.denumire)}</a>`,
                      esc(r.categorie || "—"),
                      `${nr(r.cantitate)} ${esc(r.um || "")}`,
                      r.pret_ofertare ? `<strong>${money(r.pret_ofertare)}</strong>` : "—",
                      esc(r.termen_livrare || "—"),
                      zi(r.valabil_pana),
                    ]
              )
            )
          : `<p style="color:var(--text-muted)">Nicio ofertă aici încă.</p>`
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Oferte interne", active: "/rfq/oferte", body }));
  });

  // ---- cerere nouă ------------------------------------------------------
  async function formular(ctx, { eroare, valori } = {}) {
    const v = valori || {};
    const categorii = await categoriiCunoscute();
    const clienti = await db
      .prepare("SELECT id, nume FROM parteneri WHERE tip != 'furnizor' ORDER BY nume LIMIT 3000")
      .all()
      .catch(() => []);
    const body = `
      ${subnavRfq("/rfq/nou", ctx.user)}
      ${eroare ? `<p style="max-width:820px;color:var(--danger);border:1px solid var(--danger);border-radius:8px;padding:10px 12px">${esc(eroare)}</p>` : ""}
      <form method="post" action="/rfq" class="form" style="max-width:820px">
        <label class="field"><span>Denumirea produsului</span>
          <input type="text" name="denumire" required maxlength="200" value="${esc(v.denumire || "")}"
                 placeholder="cum îi spune clientul, chiar dacă nu e numele din catalog"></label>
        <label class="field"><span>Descriere — dimensiuni, material, marcaj, orice detaliu care schimbă prețul</span>
          <textarea name="descriere" rows="3">${esc(v.descriere || "")}</textarea></label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
          <label class="field"><span>Cantitate</span><input type="number" step="0.001" name="cantitate" value="${esc(v.cantitate || "")}"></label>
          <label class="field"><span>UM</span><input type="text" name="um" maxlength="12" value="${esc(v.um || "buc")}"></label>
          <label class="field"><span>Categorie</span>
            <select name="categorie">
              <option value="">— nealeasă —</option>
              ${categorii.map((c) => `<option value="${esc(c)}"${String(v.categorie || "") === c ? " selected" : ""}>${esc(c)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Preț țintă (opțional) — cât a spus clientul că plătește</span>
            <input type="number" step="0.01" name="pret_tinta" value="${esc(v.pret_tinta || "")}"></label>
          <label class="field"><span>Clientul (opțional)</span>
            <select name="partener_id">
              <option value="">— niciunul anume —</option>
              ${clienti.map((c) => `<option value="${c.id}"${String(v.partener_id || "") === String(c.id) ? " selected" : ""}>${esc(c.nume)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <label class="field"><span>Până când îți trebuie prețul</span>
            <input type="date" name="termen_ofertare" value="${esc(v.termen_ofertare || "")}"></label>
          <label class="field"><span>Când ar veni comanda, dacă vine</span>
            <input type="date" name="termen_comanda" value="${esc(v.termen_comanda || "")}"></label>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Trimite la achiziții</button>
          <a href="/rfq" class="btn secondary">Renunță</a>
        </div>
      </form>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Cerere de preț", active: "/rfq/nou", body }));
  }

  router.get("/rfq/nou", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    await formular(ctx);
  });

  // ---- adaosul implicit, al adminului -----------------------------------
  router.post("/rfq/adaos", async (ctx) => {
    if (!esteAdmin(ctx.user)) return redirect(ctx.res, "/rfq");
    const v = Number(String((ctx.body && ctx.body.adaos) || "").replace(",", "."));
    if (Number.isFinite(v) && v >= 0 && v < 1000) await scrieSetare("rfq_adaos_implicit", v);
    return redirect(ctx.res, "/rfq/oferte");
  });

  router.post("/rfq", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const b = ctx.body || {};
    const valori = {
      denumire: String(b.denumire || "").trim(),
      descriere: String(b.descriere || "").trim(),
      categorie: String(b.categorie || "").trim(),
      cantitate: b.cantitate,
      um: String(b.um || "").trim() || "buc",
      pret_tinta: b.pret_tinta,
      partener_id: b.partener_id,
      termen_ofertare: String(b.termen_ofertare || "").slice(0, 10),
      termen_comanda: String(b.termen_comanda || "").slice(0, 10),
    };
    if (!valori.denumire) return await formular(ctx, { eroare: "Scrie denumirea produsului — fără ea, achizițiile n-au ce căuta.", valori });
    const cant = Number(String(valori.cantitate || "").replace(",", "."));
    if (!(cant > 0)) {
      return await formular(ctx, {
        eroare: "Scrie cantitatea. La un produs nou, prețul depinde de ea mai mult decât de orice altceva.",
        valori,
      });
    }
    const tinta = Number(String(valori.pret_tinta || "").replace(",", "."));

    const ins = await db
      .prepare(
        `INSERT INTO rfq (agent_id, partener_id, denumire, descriere, categorie, cantitate, um, pret_tinta,
                          termen_ofertare, termen_comanda, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'noua') RETURNING id`
      )
      .run(
        ctx.user.id,
        parseInt(valori.partener_id, 10) || null,
        valori.denumire.slice(0, 200),
        valori.descriere || null,
        valori.categorie || null,
        cant,
        valori.um.slice(0, 12),
        Number.isFinite(tinta) && tinta > 0 ? tinta : null,
        valori.termen_ofertare || null,
        valori.termen_comanda || null
      );
    redirect(ctx.res, `/rfq/${ins.lastInsertRowid}`);
  });

  // ---- fișa cererii -----------------------------------------------------
  router.get("/rfq/:id", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const brut = await db.prepare(`${SELECT_RFQ} WHERE r.id = ?`).get(ctx.params.id);
    if (!brut) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/rfq", body: "<p>Cererea nu există.</p>" }));
    const implicit = await adaosImplicit();
    const r = deAfisat(ctx.user, brut, implicit);
    const intern = esteAchizitii(ctx.user);
    const categorii = await categoriiCunoscute();
    const furnizori = intern
      ? await db.prepare("SELECT id, nume FROM parteneri WHERE tip IN ('furnizor','ambele') ORDER BY nume LIMIT 3000").all().catch(() => [])
      : [];

    const body = `
      ${subnavRfq("/rfq", ctx.user)}
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Produs</div><strong>${esc(r.denumire)}</strong></div>
          <div><div class="k">Status</div>${eticheta(r.status)}</div>
          <div><div class="k">Cantitate</div>${nr(r.cantitate)} ${esc(r.um || "")}</div>
          <div><div class="k">Categorie</div>${esc(r.categorie || "—")}</div>
          <div><div class="k">Cerută de</div>${esc(r.agent_nume || "—")}</div>
          <div><div class="k">Client</div>${esc(r.client_nume || "—")}</div>
          <div><div class="k">Preț țintă</div>${r.pret_tinta ? money(r.pret_tinta) : "—"}</div>
          <div><div class="k">Termen ofertă</div>${zi(r.termen_ofertare)}</div>
          <div><div class="k">Comandă estimată</div>${zi(r.termen_comanda)}</div>
        </div>
        ${r.descriere ? `<div style="margin-top:10px"><div class="k">Descriere</div>${esc(r.descriere)}</div>` : ""}
      </div>

      ${
        r.pret_ofertare
          ? `<div class="detail-box" style="margin-top:12px;border-left:4px solid var(--verde,#1a7f42)">
               <div class="k">Preț de ofertare</div>
               <div style="font-size:22px;font-weight:600">${money(r.pret_ofertare)} / ${esc(r.um || "buc")}</div>
               <div class="mic" style="color:var(--text-muted)">adaos ${nr(r.adaos_folosit)}%${
                 r.valabil_pana ? ` · valabil până la ${zi(r.valabil_pana)}` : ""
               }${r.termen_livrare ? ` · livrare ${esc(r.termen_livrare)}` : ""}</div>
             </div>`
          : r.status === "refuzata"
            ? `<div class="detail-box" style="margin-top:12px;border-left:4px solid var(--rosu,#b3261e)">
                 <strong>Achizițiile n-au putut obține un preț.</strong>
                 ${r.motiv_refuz ? `<div class="mic" style="margin-top:4px">${esc(r.motiv_refuz)}</div>` : ""}
               </div>`
            : `<p style="color:var(--text-muted);margin-top:12px">Încă fără preț. ${
                r.status === "in_lucru" ? "Achizițiile lucrează la ea." : "Așteaptă să o preia cineva de la achiziții."
              }</p>`
      }

      ${
        intern
          ? `<h2>Partea de achiziții</h2>
             <div class="detail-box" style="border-left:4px solid var(--accent,#2f5d9c)">
               <div class="detail-grid">
                 <div><div class="k">Furnizor</div>${esc(r.furnizor_nume || r.furnizor_text || "—")}</div>
                 <div><div class="k">Preț de achiziție</div>${r.pret_achizitie ? money(r.pret_achizitie) : "—"}</div>
                 <div><div class="k">Preluată de</div>${esc(r.preluat_nume || "—")}</div>
                 <div><div class="k">Valabil până</div>${zi(r.valabil_pana)}</div>
               </div>
               ${r.note_interne ? `<div style="margin-top:10px"><div class="k">Note interne</div>${esc(r.note_interne)}</div>` : ""}
               <div class="mic" style="color:var(--text-muted);margin-top:8px">
                 Căsuța asta nu se vede la agent. Nici furnizorul, nici prețul de achiziție, nici notele.
               </div>
             </div>

             ${
               r.status === "noua"
                 ? `<form method="post" action="/rfq/${r.id}/preia" class="inline-form" style="margin:10px 0">
                      <button class="btn secondary" type="submit">Preiau eu cererea</button>
                    </form>`
                 : ""
             }

             <h2>Răspunde</h2>
             <form method="post" action="/rfq/${r.id}/raspunde" class="form" style="max-width:820px">
               <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                 <label class="field"><span>Furnizor din listă</span>
                   <select name="furnizor_id">
                     <option value="">— scriu mai jos —</option>
                     ${furnizori.map((f) => `<option value="${f.id}"${String(r.furnizor_id || "") === String(f.id) ? " selected" : ""}>${esc(f.nume)}</option>`).join("")}
                   </select>
                 </label>
                 <label class="field"><span>sau furnizor scris de mână</span>
                   <input type="text" name="furnizor_text" maxlength="160" value="${esc(r.furnizor_text || "")}"></label>
               </div>
               <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
                 <label class="field"><span>Preț de achiziție / ${esc(r.um || "buc")}</span>
                   <input type="number" step="0.0001" name="pret_achizitie" required value="${esc(r.pret_achizitie || "")}"></label>
                 <label class="field"><span>Monedă</span>
                   <input type="text" name="moneda_achizitie" maxlength="6" value="${esc(r.moneda_achizitie || "RON")}"></label>
                 <label class="field"><span>Categorie</span>
                   <select name="categorie">
                     <option value="">— nealeasă —</option>
                     ${categorii.map((c) => `<option value="${esc(c)}"${String(r.categorie || "") === c ? " selected" : ""}>${esc(c)}</option>`).join("")}
                   </select>
                 </label>
               </div>
               <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                 <label class="field"><span>Termen de livrare</span>
                   <input type="text" name="termen_livrare" maxlength="80" value="${esc(r.termen_livrare || "")}" placeholder="ex. 3 săptămâni"></label>
                 <label class="field"><span>Oferta e valabilă până la</span>
                   <input type="date" name="valabil_pana" value="${esc((r.valabil_pana || "").slice(0, 10))}"></label>
               </div>
               <label class="field"><span>Note interne — nu ajung la agent</span>
                 <textarea name="note_interne" rows="2">${esc(r.note_interne || "")}</textarea></label>
               <div class="form-actions">
                 <button type="submit" class="btn">Trimite prețul la agent</button>
               </div>
             </form>

             <form method="post" action="/rfq/${r.id}/refuza" class="form" style="max-width:520px;margin-top:10px">
               <label class="field"><span>Sau: nu se poate obține. De ce?</span>
                 <input type="text" name="motiv" maxlength="200" value="${esc(r.motiv_refuz || "")}"></label>
               <button class="link-btn danger" type="submit">Marchează „nu se poate"</button>
             </form>`
          : ""
      }

      ${
        esteAdmin(ctx.user)
          ? `<h2>Adaos</h2>
             <form method="post" action="/rfq/${r.id}/adaos" class="form" style="max-width:420px">
               <label class="field"><span>Adaos pe cererea asta (%) — gol înseamnă cel implicit, ${nr(implicit)}%</span>
                 <input type="number" step="0.1" name="adaos" value="${esc(r.adaos === null || r.adaos === undefined ? "" : r.adaos)}"></label>
               <button class="btn small" type="submit">Salvează adaosul</button>
             </form>
             <form method="post" action="/rfq/adaos" class="form" style="max-width:420px;margin-top:8px">
               <label class="field"><span>Adaosul implicit, pentru toate cererile (%)</span>
                 <input type="number" step="0.1" name="adaos" value="${esc(implicit)}"></label>
               <button class="btn secondary small" type="submit">Schimbă implicitul</button>
             </form>`
          : ""
      }

      ${
        (Number(r.agent_id) === Number(ctx.user.id) || esteAdmin(ctx.user)) && !["anulata", "ofertata"].includes(r.status)
          ? `<form method="post" action="/rfq/${r.id}/anuleaza" class="inline-form" style="margin-top:14px"
                   onsubmit="return confirm('Anulezi cererea?')">
               <button class="link-btn danger" type="submit">Anulează cererea</button>
             </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Cerere de preț #${r.id}`, active: "/rfq", body }));
  });

  router.post("/rfq/:id/preia", async (ctx) => {
    if (!esteAchizitii(ctx.user)) return redirect(ctx.res, `/rfq/${ctx.params.id}`);
    await db
      .prepare("UPDATE rfq SET status = 'in_lucru', preluat_de = ? WHERE id = ? AND status = 'noua'")
      .run(ctx.user.id, ctx.params.id);
    redirect(ctx.res, `/rfq/${ctx.params.id}`);
  });

  router.post("/rfq/:id/raspunde", async (ctx) => {
    if (!esteAchizitii(ctx.user)) return redirect(ctx.res, `/rfq/${ctx.params.id}`);
    const b = ctx.body || {};
    const pret = Number(String(b.pret_achizitie || "").replace(",", "."));
    if (!(pret > 0)) return redirect(ctx.res, `/rfq/${ctx.params.id}`);
    await db
      .prepare(
        `UPDATE rfq SET furnizor_id = ?, furnizor_text = ?, pret_achizitie = ?, moneda_achizitie = ?,
                        termen_livrare = ?, valabil_pana = ?, note_interne = ?, categorie = ?,
                        status = 'ofertata', raspuns_de = ?, raspuns_la = ?
         WHERE id = ?`
      )
      .run(
        parseInt(b.furnizor_id, 10) || null,
        String(b.furnizor_text || "").trim().slice(0, 160) || null,
        pret,
        String(b.moneda_achizitie || "RON").trim().slice(0, 6),
        String(b.termen_livrare || "").trim().slice(0, 80) || null,
        String(b.valabil_pana || "").slice(0, 10) || null,
        String(b.note_interne || "").trim() || null,
        String(b.categorie || "").trim() || null,
        ctx.user.id,
        new Date().toISOString().slice(0, 19).replace("T", " "),
        ctx.params.id
      );
    redirect(ctx.res, `/rfq/${ctx.params.id}`);
  });

  router.post("/rfq/:id/refuza", async (ctx) => {
    if (!esteAchizitii(ctx.user)) return redirect(ctx.res, `/rfq/${ctx.params.id}`);
    await db
      .prepare("UPDATE rfq SET status = 'refuzata', motiv_refuz = ?, raspuns_de = ?, raspuns_la = ? WHERE id = ?")
      .run(
        String((ctx.body || {}).motiv || "").trim().slice(0, 200) || null,
        ctx.user.id,
        new Date().toISOString().slice(0, 19).replace("T", " "),
        ctx.params.id
      );
    redirect(ctx.res, `/rfq/${ctx.params.id}`);
  });

  router.post("/rfq/:id/adaos", async (ctx) => {
    if (!esteAdmin(ctx.user)) return redirect(ctx.res, `/rfq/${ctx.params.id}`);
    const brut = String((ctx.body || {}).adaos || "").trim();
    if (brut === "") {
      await db.prepare("UPDATE rfq SET adaos = NULL WHERE id = ?").run(ctx.params.id);
    } else {
      const v = Number(brut.replace(",", "."));
      if (Number.isFinite(v) && v >= 0 && v < 1000) await db.prepare("UPDATE rfq SET adaos = ? WHERE id = ?").run(v, ctx.params.id);
    }
    redirect(ctx.res, `/rfq/${ctx.params.id}`);
  });

  router.post("/rfq/:id/anuleaza", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const r = await db.prepare("SELECT agent_id FROM rfq WHERE id = ?").get(ctx.params.id);
    if (!r) return redirect(ctx.res, "/rfq");
    if (!esteAdmin(ctx.user) && Number(r.agent_id) !== Number(ctx.user.id)) return redirect(ctx.res, `/rfq/${ctx.params.id}`);
    await db.prepare("UPDATE rfq SET status = 'anulata' WHERE id = ?").run(ctx.params.id);
    redirect(ctx.res, `/rfq/${ctx.params.id}`);
  });
}

module.exports = { register, pentruOchiiLui, pretOfertare, deAfisat, esteAchizitii, CAMPURI_INTERNE, ADAOS_IMPLICIT };
