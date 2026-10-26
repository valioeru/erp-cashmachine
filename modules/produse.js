"use strict";
const db = require("../lib/db");
const { registerCrud } = require("../lib/crud");
const { esc, money, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const fuziune = require("../lib/produse-fuziune");
const produsRapid = require("../lib/produs-rapid");

// Cine scoate un produs din provizorat. Achizițiile (rolul „depozit") și
// adminul — adică exact cine are de unde să-i ia codul și prețul de achiziție.
const poateConfirma = (u) => Boolean(u && (u.rol === "admin" || u.rol === "depozit"));

const TIPURI = [["text", "text liber"], ["numar", "număr"], ["lista", "listă de valori"]];

// ---------------------------------------------------------------------------
// Prețul de listă
//
// Formula e una singură și e scrisă pe față în pagină, ca să nu existe dubiu:
//
//     preț listă = cost de bază × (1 + adaos/100)
//
// „Adaos", nu „marjă". Cele două se confundă permanent și dau rezultate
// diferite pe aceleași cifre: un adaos de 30% peste un cost de 100 dă 130,
// în timp ce o marjă de 30% din prețul de vânzare dă 142,86. Aici e adaos
// peste cost, iar pagina arată alături și marja rezultată din preț, ca să se
// vadă amândouă și să nu se mai confunde nimeni.
//
// COSTUL DE BAZĂ se ia în trei trepte, în ordinea încrederii:
//   1. rețeta (produse.cost_reteta) — calculată din componente, se reface
//      singură când se schimbă prețul materiilor prime;
//   2. costul de producție scris de mână (pret_productie) — pentru ce facem
//      noi și n-are încă rețetă;
//   3. prețul de achiziție (pret_achizitie) — pentru ce cumpărăm.
// Dacă niciuna nu există, costul e necunoscut și prețul de listă nu se
// calculează. Nu se pune zero: un cost zero ar da un preț de listă egal cu
// adaosul și ar arăta ca o cifră serioasă.
const ADAOS_IMPLICIT = 30;

function costBaza(p) {
  const reteta = Number((p && p.cost_reteta) || 0);
  if (reteta > 0) return { valoare: reteta, sursa: "rețetă" };
  const productie = Number((p && p.pret_productie) || 0);
  if (productie > 0) return { valoare: productie, sursa: "producție" };
  const achizitie = Number((p && p.pret_achizitie) || 0);
  if (achizitie > 0) return { valoare: achizitie, sursa: "achiziție" };
  return { valoare: 0, sursa: null };
}

function adaosProdus(p, implicit) {
  const a = Number((p && p.adaos_lista) != null ? p.adaos_lista : NaN);
  if (Number.isFinite(a) && a >= 0) return { valoare: a, propriu: true };
  return { valoare: Number(implicit) || 0, propriu: false };
}

function pretLista(p, implicit) {
  const c = costBaza(p);
  if (!(c.valoare > 0)) return null;
  const a = adaosProdus(p, implicit);
  return c.valoare * (1 + a.valoare / 100);
}

// Marja rezultată din preț, ca procent din prețul de vânzare. E cealaltă
// citire a aceluiași lucru, pusă alături ca să nu se confunde cu adaosul.
function marjaDinPret(pret, cost) {
  const pv = Number(pret) || 0;
  const c = Number(cost) || 0;
  if (!(pv > 0) || !(c > 0)) return null;
  return ((pv - c) / pv) * 100;
}

async function adaosImplicit() {
  const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = 'adaos_lista_implicit'").get().catch(() => null);
  const v = r ? Number(String(r.valoare).replace(",", ".")) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : ADAOS_IMPLICIT;
}

async function scrieSetare(cheie, valoare) {
  const acum = new Date().toISOString();
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(String(valoare), acum, cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, String(valoare), acum);
}

const lei = (v) => (v == null ? '<span style="color:var(--text-muted)">—</span>' : money(v));

function register(router) {
  // Adaosul implicit se citește o dată per cerere și se ține aici, ca să nu
  // facem o interogare pentru fiecare dintre cele peste patru mii de rânduri.
  let adaosCurent = ADAOS_IMPLICIT;

  registerCrud(router, {
    path: "/produse",
    table: "produse",
    title: "Produse",
    singular: "produs",
    search: ["cod", "denumire"],
    filtre: [
      { name: "categorie", label: "Categorie" },
      { name: "gestiune", label: "Gestiune" },
    ],
    limita: 200,
    ordine: "denumire",
    inainte: async () => { adaosCurent = await adaosImplicit(); },
    banner: async (ctx) => {
      const r = await db.prepare("SELECT COUNT(*) AS n FROM produse WHERE cota_tva = 19").get().catch(() => ({ n: 0 }));
      const n = Number((r && r.n) || 0);
      const tva = n
        ? `<div class="flash" style="background:#fbf0da;border-color:#e6d0a0;color:var(--warn)">
             <strong>${n.toLocaleString("ro-RO")} ${n === 1 ? "produs are" : "produse au"} încă TVA 19%.</strong>
             Cota standard e 21% de la 01.08.2025. Produsele noi intră deja cu 21%; pe cele vechi nu le-am schimbat singur.
             <form method="post" action="/produse/tva" style="display:inline;margin-left:8px">
               <button class="btn small" type="submit">Treci-le pe 21%</button>
             </form>
           </div>`
        : "";
      const setare = `<form method="post" action="/produse/adaos" class="filtre" style="margin-bottom:12px">
          <label>Adaos implicit pentru prețul de listă
            <input name="adaos" type="number" step="0.1" min="0" value="${esc(adaosCurent)}" style="width:90px"> %
          </label>
          <button class="btn small" type="submit">Salvează</button>
          <span style="font-size:12px;color:var(--text-muted)">
            Preț listă = cost × (1 + adaos/100). Se aplică produselor care n-au adaos propriu.
          </span>
        </form>`;
      return tva + setare;
    },
    fields: [
      { name: "cod", label: "Cod produs" },
      { name: "denumire", label: "Denumire", required: true },
      { name: "categorie", label: "Categorie", datalist: true, ajutor: "Scrie una nouă sau alege din cele existente." },
      { name: "gestiune", label: "Gestiune", datalist: true, ajutor: "Gestiunea din contabilitate în care stă produsul." },
      { name: "unitate_masura", label: "Unitate de măsură", default: "buc" },
      { name: "pret_achizitie", label: "Preț achiziție", type: "number", step: "0.01", default: 0, ajutor: "Pentru marfa pe care o cumpărăm." },
      { name: "pret_productie", label: "Cost de producție", type: "number", step: "0.0001", ajutor: "Pentru ce facem noi. Lasă gol dacă produsul are rețetă — atunci costul se ia din ea." },
      {
        name: "_cost",
        label: "Cost de bază folosit",
        type: "calculat",
        calc: (r) => {
          const c = costBaza(r);
          return c.sursa ? `${money(c.valoare)} <span style="font-weight:400;color:var(--text-muted)">(${c.sursa})</span>` : "necunoscut";
        },
      },
      { name: "adaos_lista", label: "Adaos propriu (%)", type: "number", step: "0.1", ajutor: "Lasă gol ca să folosească adaosul implicit al firmei." },
      {
        name: "_lista",
        label: "Preț de listă (calculat)",
        type: "calculat",
        calc: (r) => {
          const pl = pretLista(r, adaosCurent);
          if (pl == null) return 'necunoscut — produsul n-are cost';
          const a = adaosProdus(r, adaosCurent);
          return `${money(pl)} <span style="font-weight:400;color:var(--text-muted)">(adaos ${a.valoare}%${a.propriu ? "" : ", implicit"})</span>`;
        },
      },
      { name: "pret_minim", label: "Preț minim de vânzare", type: "number", step: "0.01", ajutor: "Sub prețul ăsta pagina te avertizează. Lasă gol dacă n-ai o limită." },
      { name: "pret_vanzare", label: "Preț vânzare (fără TVA)", type: "number", step: "0.01", default: 0, ajutor: "Prețul folosit efectiv în oferte și facturi." },
      { name: "cota_tva", label: "Cotă TVA (%)", type: "number", step: "0.01", default: 21 },
      { name: "stoc_minim", label: "Stoc minim (alertă)", type: "number", step: "0.01", default: 0 },
    ],
    listColumns: [
      { key: "cod", label: "Cod" },
      { key: "denumire", label: "Denumire", render: (r) => `<a href="/produse/${r.id}">${esc(r.denumire)}</a>` },
      { key: "categorie", label: "Categorie", render: (r) => esc(r.categorie || "—") },
      { key: "gestiune", label: "Gestiune", render: (r) => esc(r.gestiune || "—") },
      { key: "unitate_masura", label: "UM" },
      {
        key: "_cost",
        label: "Achiziție / producție",
        render: (r) => {
          const c = costBaza(r);
          if (!c.sursa) return '<span style="color:var(--text-muted)">—</span>';
          return `${money(c.valoare)}<br><span style="font-size:11px;color:var(--text-muted)">${c.sursa}</span>`;
        },
      },
      {
        key: "_adaos",
        label: "Adaos",
        render: (r) => {
          const a = adaosProdus(r, adaosCurent);
          return `${a.valoare}%${a.propriu ? "" : '<br><span style="font-size:11px;color:var(--text-muted)">implicit</span>'}`;
        },
      },
      {
        key: "_lista",
        label: "Preț listă",
        render: (r) => {
          const pl = pretLista(r, adaosCurent);
          if (pl == null) return '<span style="color:var(--text-muted)">—</span>';
          const pv = Number(r.pret_vanzare) || 0;
          const sub = pv > 0 && pv < pl * 0.995;
          return `${money(pl)}${sub ? '<br><span class="badge galben" title="prețul de vânzare e sub prețul de listă">sub listă</span>' : ""}`;
        },
      },
      {
        key: "pret_vanzare",
        label: "Preț vânzare",
        render: (r) => {
          const pv = Number(r.pret_vanzare) || 0;
          const pmin = Number(r.pret_minim) || 0;
          const subMinim = pmin > 0 && pv > 0 && pv < pmin;
          const c = costBaza(r);
          const m = marjaDinPret(pv, c.valoare);
          return `${money(pv)}${subMinim ? ' <span class="badge rosu" title="sub prețul minim de vânzare">sub minim</span>' : ""}` +
            (m != null ? `<br><span style="font-size:11px;color:var(--text-muted)">marjă ${m.toFixed(1)}%</span>` : "");
        },
      },
      { key: "pret_minim", label: "Preț minim", render: (r) => lei(Number(r.pret_minim) > 0 ? r.pret_minim : null) },
      { key: "cota_tva", label: "TVA", render: (r) => `${esc(r.cota_tva)}%${Number(r.cota_tva) === 19 ? ' <span class="badge galben">vechi</span>' : ""}` },
    ],
  });

  // Trecerea produselor rămase pe 19% la cota curentă de 21%. Se face numai la
  // apăsarea butonului, de un admin, și atinge EXACT rândurile cu 19 — nu
  // umblă la cotele reduse de 9% sau 5%, care sunt în continuare valabile.
  router.post("/produse/tva", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/produse");
    const r = await db.prepare("UPDATE produse SET cota_tva = 21 WHERE cota_tva = 19").run();
    console.log(`[produse] cota TVA 19 -> 21 pe ${r.changes} produse`);
    return redirect(ctx.res, "/produse");
  });

  router.post("/produse/adaos", async (ctx) => {
    if (!ctx.user || ctx.user.rol !== "admin") return redirect(ctx.res, "/produse");
    const v = Number(String((ctx.body && ctx.body.adaos) || "").replace(",", "."));
    if (Number.isFinite(v) && v >= 0 && v < 1000) await scrieSetare("adaos_lista_implicit", v);
    return redirect(ctx.res, "/produse");
  });

  // ---- produsul scris direct pe comandă ---------------------------------
  //
  // Clientul cere ceva ce nu e în nomenclator. Până acum agentul se oprea
  // aici: lista nu-l conținea, câmpul ascuns rămânea gol, comanda nu se
  // salva. Ruta asta îl creează de pe linia de comandă și întoarce JSON, ca
  // pagina să-l pună pe rând fără reîncărcare.
  //
  // Două lucruri o țin să nu strice nomenclatorul:
  //   • caută întâi un produs existent cu aceeași denumire normalizată și îl
  //     reutilizează. Fără asta, "banda adeziva 48" ar intra a cincea oară.
  //   • ce chiar e nou intră cu provizoriu = 1, deci apare la
  //     /produse/provizorii până îl completează cineva.
  //
  // Înregistrată înaintea lui /produse/:id — altfel "rapid" ar fi citit ca id.
  router.post("/produse/rapid", async (ctx) => {
    const raspunde = (stare, obiect) =>
      send(ctx.res, stare, JSON.stringify(obiect), { "Content-Type": "application/json; charset=utf-8" });
    if (!ctx.user) return raspunde(401, { eroare: "Nu ești autentificat." });

    const v = produsRapid.validare(ctx.body || {});
    if (v.eroare) return raspunde(400, { eroare: v.eroare });

    // Toate produsele în joc, ca să comparăm pe denumirea normalizată. E o
    // citire întreagă, dar se întâmplă doar când omul apasă anume butonul, iar
    // formularul de comandă încarcă oricum aceeași listă la fiecare deschidere.
    const existente = await db
      .prepare("SELECT id, cod, denumire, categorie, unitate_masura, pret_vanzare, activ, fuzionat_in FROM produse")
      .all()
      .catch(() => []);
    const gasit = produsRapid.potrivire(existente, v.cheie);
    if (gasit) {
      return raspunde(200, {
        id: gasit.id,
        cod: gasit.cod || "",
        denumire: gasit.denumire,
        categorie: String(gasit.categorie || "").trim(),
        um: String(gasit.unitate_masura || "").trim(),
        pret: Number(gasit.pret_vanzare || 0),
        reutilizat: true,
      });
    }

    const acum = new Date().toISOString().slice(0, 19).replace("T", " ");
    const ins = await db
      .prepare(
        `INSERT INTO produse (denumire, categorie, unitate_masura, activ, provizoriu, creat_de, creat_la)
         VALUES (?, ?, ?, 1, 1, ?, ?) RETURNING id`
      )
      .run(v.denumire, v.categorie, v.um, ctx.user.id, acum);
    console.log(`[produse] provizoriu nou #${ins.lastInsertRowid} "${v.denumire}" de ${ctx.user.nume || ctx.user.id}`);
    return raspunde(200, {
      id: ins.lastInsertRowid,
      cod: "",
      denumire: v.denumire,
      categorie: v.categorie || "",
      um: v.um,
      pret: 0,
      reutilizat: false,
    });
  });

  // Lista produselor provizorii. E coada de lucru a achizițiilor: fiecare rând
  // de aici e un produs pe care l-a cerut un client și pe care încă nu l-a
  // verificat nimeni. Dacă pagina asta rămâne goală, mecanismul e sănătos.
  router.get("/produse/provizorii", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    const randuri = await db
      .prepare(
        `SELECT p.id, p.denumire, p.categorie, p.unitate_masura, p.creat_la, u.nume AS creat_de_nume,
                (SELECT COUNT(*) FROM comenzi_linii cl WHERE cl.produs_id = p.id) AS pe_comenzi
           FROM produse p LEFT JOIN utilizatori u ON u.id = p.creat_de
          WHERE p.provizoriu = 1 AND COALESCE(p.activ, 1) = 1
          ORDER BY p.id DESC LIMIT 300`
      )
      .all()
      .catch(() => []);

    const body = `
      <p style="max-width:780px;color:var(--text-muted)">
        Produse pe care le-a cerut un client și le-a scris un agent direct pe comandă. Sunt bune de comandat,
        dar n-au cod, preț de achiziție sau unitate verificată. Se completează din fișa produsului, apoi se apasă
        „Confirmă” — atunci ies din lista asta.
        ${
          poateConfirma(ctx.user)
            ? ""
            : `<br><span style="color:var(--text-muted)">Confirmarea o fac achizițiile — tu vezi aici doar ce așteaptă.</span>`
        }
      </p>
      ${
        randuri.length
          ? table(
              ["#", "Denumire", "Categorie", "UM", "Pe comenzi", "Scris de", "Când", ""],
              randuri.map((r) => [
                String(r.id),
                `<a href="/produse/${r.id}">${esc(r.denumire)}</a>`,
                esc(r.categorie || "—"),
                esc(r.unitate_masura || "—"),
                String(Number(r.pe_comenzi || 0)),
                esc(r.creat_de_nume || "—"),
                esc(String(r.creat_la || "").slice(0, 16)),
                poateConfirma(ctx.user)
                  ? `<form method="post" action="/produse/${r.id}/confirma" class="inline-form">
                       <button type="submit" class="btn small">Confirmă</button>
                     </form>`
                  : "",
              ])
            )
          : `<p style="color:var(--text-muted)">Niciun produs provizoriu. Nomenclatorul e curat.</p>`
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Produse de verificat", active: "/produse/provizorii", body }));
  });

  // Scoaterea din provizorat. Nu se face singură la prima completare de câmp:
  // cineva trebuie să se uite la produs și să spună „e în regulă". De-aia e un
  // buton, nu un declanșator pe UPDATE.
  router.post("/produse/:id/confirma", async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, "/login");
    // Lista se vede de oricine lucrează cu produse — e util ca agentul să știe
    // că articolul lui încă n-a fost verificat. Dar APĂSAT nu poate fi de
    // oricine: dacă agentul care a scris produsul în grabă îl poate declara
    // bun tot el, verificarea nu există, există doar un buton în plus.
    if (!poateConfirma(ctx.user)) return redirect(ctx.res, "/produse/provizorii");
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isFinite(id)) return redirect(ctx.res, "/produse/provizorii");
    await db.prepare("UPDATE produse SET provizoriu = 0 WHERE id = ?").run(id);
    console.log(`[produse] provizoriu #${id} confirmat de ${ctx.user.nume || ctx.user.id}`);
    return redirect(ctx.res, "/produse/provizorii");
  });

  // Pagină de detaliu produs: stoc pe depozite + rețetă de fabricație (BOM) —
  // din ce alte produse (componente) e format acest produs, util pentru
  // producție. Înregistrată după registerCrud, ca să nu intre în conflict cu
  // rutele literale /produse/nou, /produse/:id/editare etc.

  // Unificarea codurilor. Înregistrată înaintea lui /produse/:id, altfel
  // "fuziune" ar fi citit ca un id de produs.
  router.get("/produse/fuziune", async (ctx) => {
    const grupe = await fuziune.posibileDuplicate(60);
    const istoric = await db
      .prepare(
        `SELECT f.*, p.denumire AS pastrat_denumire, p.cod AS pastrat_cod
           FROM produse_fuziuni f LEFT JOIN produse p ON p.id = f.pastrat_id
          ORDER BY f.id DESC LIMIT 30`
      )
      .all();

    const grupeHtml = grupe.length
      ? grupe
          .map(
            (g) => `
        <form method="post" action="/produse/fuziune/previzualizare" class="detail-box" style="margin-bottom:10px">
          <div style="font-weight:600;margin-bottom:6px">${esc(g.produse[0].denumire)} — ${g.produse.length} coduri</div>
          ${table(
            ["Păstrez", "Unific", "Cod", "Denumire", "UM"],
            g.produse.map((p, i) => [
              `<input type="radio" name="pastrat_id" value="${p.id}"${i === 0 ? " checked" : ""}>`,
              `<input type="checkbox" name="inghitit_id" value="${p.id}"${i === 0 ? "" : " checked"}>`,
              esc(p.cod) || "—",
              `<a href="/produse/${p.id}">${esc(p.denumire)}</a>`,
              esc(p.unitate_masura),
            ])
          )}
          <button class="btn small" type="submit">Vezi ce se mută</button>
        </form>`
          )
          .join("")
      : "<p>Nu am găsit denumiri care să se repete. Poți unifica și manual, de pe fișa produsului.</p>";

    const body = `
      <h1>Unificare coduri de produs</h1>
      <p style="color:var(--text-muted)">Același articol ajuns sub mai multe coduri face stocul să pară înjumătățit și marja pe produs greșită. Aici alegi codul care rămâne și le aduci pe celelalte la el. <strong>Produsul unificat nu se șterge</strong> — rămâne în bază, dezactivat, legat de cel păstrat.</p>
      <h2>Posibile duplicate, după denumire</h2>
      ${grupeHtml}
      <h2>Unificări făcute</h2>
      ${table(
        ["Când", "Păstrat", "Unificat", "Rânduri mutate"],
        istoric.map((f) => [
          esc(String(f.facut_la || "").slice(0, 16)),
          `<a href="/produse/${f.pastrat_id}">${esc(f.pastrat_denumire || f.pastrat_id)}</a>`,
          `${esc(f.inghitit_cod || "")} ${esc(f.inghitit_denumire || f.inghitit_id)}`,
          (() => { try { const m = JSON.parse(f.mutari || "{}"); return Object.entries(m).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>") || "—"; } catch (e) { return "—"; } })(),
        ])
      )}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Unificare coduri", active: "/produse", body }));
  });

  router.post("/produse/fuziune/previzualizare", async (ctx) => {
    const pastrat = parseInt(ctx.body.pastrat_id, 10) || 0;
    const inghitite = [].concat(ctx.body.inghitit_id || []).map((x) => parseInt(x, 10)).filter((x) => x && x !== pastrat);
    const prev = await fuziune.previzualizeaza(pastrat, inghitite);
    const tinta = await db.prepare("SELECT * FROM produse WHERE id = ?").get(pastrat);
    const surse = inghitite.length
      ? await db.prepare(`SELECT id, cod, denumire FROM produse WHERE id IN (${inghitite.join(",")})`).all()
      : [];

    const body = `
      <h1>Previzualizare unificare</h1>
      ${!tinta || !surse.length ? "<p>Alege un produs de păstrat și cel puțin unul de unificat.</p>" : `
      <div class="detail-box">
        <div><strong>Rămâne:</strong> ${esc(tinta.cod || "")} ${esc(tinta.denumire)} (id ${tinta.id})</div>
        <div style="margin-top:6px"><strong>Se unifică în el:</strong> ${surse.map((p) => `${esc(p.cod || "")} ${esc(p.denumire)} (id ${p.id})`).join(" · ")}</div>
      </div>
      <h2>Ce se mută, tabel cu tabel</h2>
      ${table(
        ["Tabel și coloană", "Rânduri care se mută", "Rânduri blocate"],
        prev.randuri.map((r) => [esc(r.cheie), r.eroare ? `<span style="color:var(--danger)">${esc(r.eroare)}</span>` : String(r.muta), r.blocat ? `<strong>${r.blocat}</strong>` : "—"]),
        { total: ["Total", String(prev.total), prev.blocate ? String(prev.blocate) : "—"] }
      )}
      ${prev.blocate ? `<p style="color:var(--warn)"><strong>${prev.blocate} rânduri nu se pot muta automat</strong>, pentru că în același inventar există deja și produsul păstrat. Ele rămân pe produsul vechi și se rezolvă manual, din inventarul respectiv.</p>` : ""}
      <form method="post" action="/produse/fuziune/aplica" onsubmit="return confirm('Unific definitiv? Produsele unificate rămân în bază, dezactivate.')">
        <input type="hidden" name="pastrat_id" value="${tinta.id}">
        ${surse.map((p) => `<input type="hidden" name="inghitit_id" value="${p.id}">`).join("")}
        <div class="form-actions"><button class="btn" type="submit">Unifică</button> <a class="btn secondary" href="/produse/fuziune">Renunță</a></div>
      </form>`}
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Previzualizare unificare", active: "/produse", body }));
  });

  router.post("/produse/fuziune/aplica", async (ctx) => {
    const pastrat = parseInt(ctx.body.pastrat_id, 10) || 0;
    const inghitite = [].concat(ctx.body.inghitit_id || []).map((x) => parseInt(x, 10)).filter((x) => x && x !== pastrat);
    try {
      await fuziune.fuzioneaza(pastrat, inghitite, ctx.user ? ctx.user.id : null);
    } catch (e) {
      return send(ctx.res, 400, layout({ user: ctx.user, title: "Unificare eșuată", active: "/produse", body: `<p>${esc(e.message)}</p><p><a href="/produse/fuziune">Înapoi</a></p>` }));
    }
    redirect(ctx.res, `/produse/${pastrat}`);
  });

  router.get("/produse/:id", async (ctx) => {
    const produs = await db.prepare("SELECT * FROM produse WHERE id = ?").get(ctx.params.id);
    if (!produs) return send(ctx.res, 404, layout({ user: ctx.user, title: "Negăsit", active: "/produse", body: "<p>Produs inexistent.</p>" }));

    const stocPeDepozite = await db
      .prepare(
        `SELECT d.denumire AS depozit,
                COALESCE(SUM(CASE WHEN m.tip='intrare' THEN m.cantitate ELSE -m.cantitate END), 0) AS stoc
         FROM miscari_stoc m JOIN depozite d ON d.id = m.depozit_id
         WHERE m.produs_id = ? GROUP BY d.id, d.denumire ORDER BY d.denumire`
      )
      .all(produs.id);
    const stocTotal = stocPeDepozite.reduce((s, r) => s + Number(r.stoc || 0), 0);

    const fluxuriProdus = await db.prepare("SELECT id, cod, denumire FROM fluxuri WHERE activ = 1 ORDER BY cod").all();

    const componente = await db
      .prepare(
        `SELECT rc.id, rc.cantitate, c.id AS componenta_id, c.denumire, c.unitate_masura
         FROM retete_componente rc JOIN produse c ON c.id = rc.componenta_id
         WHERE rc.produs_id = ? ORDER BY c.denumire`
      )
      .all(produs.id);

    const toateProdusele = await db.prepare("SELECT id, denumire FROM produse WHERE id != ? AND activ = 1 ORDER BY denumire").all(produs.id);
    const caracteristici = await db
      .prepare("SELECT * FROM produse_caracteristici WHERE produs_id = ? AND activ = 1 ORDER BY ordine, id")
      .all(produs.id);
    const fuzionate = await db.prepare("SELECT id, cod, denumire FROM produse WHERE fuzionat_in = ?").all(produs.id);

    const body = `
      <div class="detail-box">
        <div class="detail-grid">
          <div><div class="k">Cod</div>${esc(produs.cod) || "—"}</div>
          <div><div class="k">Preț vânzare</div>${money(produs.pret_vanzare)}</div>
          <div><div class="k">Preț achiziție</div>${money(produs.pret_achizitie)}</div>
          <div><div class="k">TVA</div>${esc(produs.cota_tva)}%</div>
          <div><div class="k">Stoc minim</div>${esc(produs.stoc_minim)} ${esc(produs.unitate_masura)}</div>
          <div><div class="k">Stoc total curent</div>${esc(stocTotal)} ${esc(produs.unitate_masura)}</div>
        </div>
        <div class="toolbar" style="margin-top:10px"><a href="/produse/${produs.id}/editare" class="btn secondary small">Editează datele</a></div>
      </div>

      <h2>Stoc pe depozite / gestiuni</h2>
      ${table(
        ["Depozit", "Cantitate"],
        stocPeDepozite.map((r) => [esc(r.depozit), r.stoc])
      )}

      <h2>Rețetă de fabricație (componente)</h2>
      <p style="color:var(--text-muted);font-size:13px">Din ce alte produse (materii prime / semifabricate) e format acest produs, și în ce cantitate.</p>
      ${table(
        ["Componentă", "Cantitate necesară", "UM", ""],
        componente.map((c) => [
          esc(c.denumire),
          c.cantitate,
          esc(c.unitate_masura),
          `<form method="post" action="/produse/${produs.id}/reteta/${c.id}/sterge" class="inline-form" onsubmit="return confirm('Ștergi componenta din rețetă?')"><button type="submit" class="link-btn danger">Șterge</button></form>`,
        ])
      )}
      <h2>Flux tehnologic</h2>
      <p style="color:var(--text-muted);font-size:13px;max-width:760px">
        Prin ce utilaje trece produsul, în ce ordine. De aici își iau comenzile operațiile de pe
        <strong>fișa însoțitoare de lot</strong> — hârtia tipărită care merge cu marfa prin hală. Dacă rămâne
        neales, fișa ghicește fluxul după denumirea produsului și o spune pe ea, ca să se vadă că n-a ales nimeni.
      </p>
      <form method="post" action="/produse/${produs.id}/flux" class="form" style="max-width:520px">
        <label class="field"><span>Fluxul produsului</span>
          <select name="flux_id">
            <option value="">— neales, se ghicește după denumire —</option>
            ${fluxuriProdus
              .map((f) => `<option value="${f.id}"${Number(f.id) === Number(produs.flux_id) ? " selected" : ""}>${esc(f.cod)} · ${esc(f.denumire || "")}</option>`)
              .join("")}
          </select>
        </label>
        <button type="submit" class="btn small">Salvează fluxul</button>
        <a class="btn small secondary" href="/fluxuri">Vezi pașii fluxurilor</a>
      </form>

      <h2>Caracteristici cerute la comandă</h2>
      <p style="color:var(--text-muted);font-size:13px">Se definesc una câte una. La o comandă nouă în producție, când se alege acest produs, fiecare caracteristică de mai jos devine un câmp <strong>obligatoriu</strong>. Fără ele nu se poate înregistra comanda.</p>
      ${table(
        ["Caracteristică", "Tip", "Unitate", "Valori permise", "Obligatorie", ""],
        caracteristici.map((c) => [
          esc(c.denumire),
          esc((TIPURI.find((t) => t[0] === c.tip) || ["", c.tip])[1]),
          esc(c.unitate) || "—",
          esc(c.valori) || "—",
          c.obligatoriu ? "da" : "nu",
          `<form method="post" action="/produse/${produs.id}/caracteristica/${c.id}/sterge" class="inline-form" onsubmit="return confirm('Scoți caracteristica? Comenzile vechi își păstrează valorile.')"><button type="submit" class="link-btn danger">Scoate</button></form>`,
        ])
      )}
      <form method="post" action="/produse/${produs.id}/caracteristica" class="form" style="max-width:720px">
        <div style="display:grid;grid-template-columns:1fr 150px 110px;gap:12px">
          <label class="field"><span>Denumire caracteristică</span><input name="denumire" required placeholder="Ex: Grosime, Lățime, Culoare"></label>
          <label class="field"><span>Tip</span><select name="tip">${TIPURI.map((t) => `<option value="${t[0]}">${esc(t[1])}</option>`).join("")}</select></label>
          <label class="field"><span>Unitate</span><input name="unitate" placeholder="µm, mm, kg"></label>
        </div>
        <label class="field"><span>Valori permise (doar pentru tipul „listă”, separate prin bară verticală)</span><input name="valori" placeholder="transparent|negru|alb"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="obligatoriu" value="1" checked> <span>Obligatorie la comandă</span></label>
        <button type="submit" class="btn small">Adaugă caracteristica</button>
      </form>

      ${fuzionate.length ? `<h2>Coduri unificate în acest produs</h2>${table(["Cod", "Denumire"], fuzionate.map((p) => [esc(p.cod) || "—", esc(p.denumire)]))}` : ""}

      ${
        toateProdusele.length
          ? `<form method="post" action="/produse/${produs.id}/reteta" class="form" style="max-width:480px">
              <label class="field"><span>Adaugă componentă</span>
                <select name="componenta_id" required>${toateProdusele.map((p) => `<option value="${p.id}">${esc(p.denumire)}</option>`).join("")}</select>
              </label>
              <label class="field"><span>Cantitate necesară</span><input type="number" step="0.0001" name="cantitate" value="1" required></label>
              <button type="submit" class="btn small">Adaugă în rețetă</button>
            </form>`
          : ""
      }
    `;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Produs: ${produs.denumire}`, active: "/produse", body }));
  });

  // Fluxul tehnologic al produsului. De aici il mostenesc comenzile, si de la
  // comenzi ajunge pe fisa de lot. Gol inseamna „ghiceste dupa denumire", nu
  // „fara operatii" — o fisa fara operatii n-ar ajuta pe nimeni in hala.
  router.post("/produse/:id/flux", async (ctx) => {
    await db
      .prepare("UPDATE produse SET flux_id = ? WHERE id = ?")
      .run(parseInt((ctx.body || {}).flux_id, 10) || null, ctx.params.id);
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/caracteristica", async (ctx) => {
    const b = ctx.body;
    const denumire = String(b.denumire || "").trim();
    if (denumire) {
      const tip = TIPURI.some((t) => t[0] === b.tip) ? b.tip : "text";
      const ultima = await db.prepare("SELECT COALESCE(MAX(ordine), 0) AS n FROM produse_caracteristici WHERE produs_id = ?").get(ctx.params.id);
      await db
        .prepare(
          `INSERT INTO produse_caracteristici (produs_id, denumire, tip, unitate, valori, obligatoriu, ordine)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ctx.params.id,
          denumire,
          tip,
          String(b.unitate || "").trim() || null,
          tip === "lista" ? String(b.valori || "").trim() || null : null,
          b.obligatoriu ? 1 : 0,
          Number(ultima.n) + 10
        );
    }
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/caracteristica/:cid/sterge", async (ctx) => {
    // Nu ștergem rândul: comenzile vechi trimit la el. Îl scoatem din uz.
    await db.prepare("UPDATE produse_caracteristici SET activ = 0 WHERE id = ? AND produs_id = ?").run(ctx.params.cid, ctx.params.id);
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/reteta", async (ctx) => {
    const { componenta_id, cantitate } = ctx.body;
    if (componenta_id && Number(cantitate) > 0) {
      await db
        .prepare("INSERT INTO retete_componente (produs_id, componenta_id, cantitate) VALUES (?, ?, ?)")
        .run(ctx.params.id, componenta_id, Number(cantitate));
    }
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });

  router.post("/produse/:id/reteta/:randId/sterge", async (ctx) => {
    await db.prepare("DELETE FROM retete_componente WHERE id = ? AND produs_id = ?").run(ctx.params.randId, ctx.params.id);
    redirect(ctx.res, `/produse/${ctx.params.id}`);
  });
}

module.exports = { register, poateConfirma };
