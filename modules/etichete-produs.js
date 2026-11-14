"use strict";
// Producție → Etichete produs: generatorul de etichete pe loturi.
//
// Ce cere Vali și cum arată eticheta: lib/etichete-produs.js. Aici sunt
// paginile:
//
//   /productie/etichete              lista loturilor și „Etichetă nouă"
//   /productie/etichete/noua         produsul ales: câmpurile, formatul,
//                                    lotul, câte — cu eticheta văzută înainte
//   /productie/etichete/:id          un lot: ce scrie pe etichete și fiecare
//                                    tipărire (când, cine, ce numere);
//                                    „Suplimentar" și „Din nou"
//   /productie/etichete/:id/tipar/:t pagina de tipărit a unei tipăriri
//   /productie/etichete/setari       datele firmei, sigla, câmpurile implicite
//                                    (administrator)
//
// ISTORICUL (Vali: „să țină minte fiecare lot de etichete imprimate, data și
// cine le-a imprimat"): fiecare apăsare pe „Tipărește" e un rând în
// etichete_tiparite — numerele etichetelor, cine, când, ce s-a scris altfel la
// tipărirea aceea și de ce. Pagina unei tipăriri vechi se poate deschide, dar
// ca să tipărești din nou treci prin „Din nou": așa rămâne și tipărirea asta în
// istoric.
//
// LOTUL AJUNGE ÎN DEPOZIT: când comanda de producție trimite marfa în depozit
// (lib/stadiu-comanda.js), rândul recepției ia lotul etichetelor ei
// (lotPentruProductie), iar paleții făcuți din el îl poartă mai departe.

const db = require("../lib/db");
const { esc, layout, table } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { poateAccesa } = require("../lib/auth");
const E = require("../lib/etichete-produs");
const SCAN = require("../lib/scan");
const AV = require("../lib/aviz");
const FL = require("../lib/fisa-lot");

const CALE = "/productie/etichete";
const azi = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
const acum = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).replace("T", " ").slice(0, 19);
const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const lista = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const poate = (u) => Boolean(u) && poateAccesa(u, CALE);
const eAdmin = (u) => Boolean(u && u.rol === "admin");
const json = (s, implicit) => {
  try {
    const v = JSON.parse(s);
    return v === null || v === undefined ? implicit : v;
  } catch (_) {
    return implicit;
  }
};
// Cât timp, după o tipărire, pagina ei mai are butonul „Tipărește" (o
// reîncercare dacă imprimanta n-a pornit). După, se tipărește prin „Din nou".
const MINUTE_TIPAR = 10;
// Sigla încărcată: cel mult atât, ca pagina de etichete să rămână ușoară.
const SIGLA_MAX = 300 * 1024;

// ---- Setările ----------------------------------------------------------------
async function setare(cheie) {
  const r = await db.prepare("SELECT valoare FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  return r ? r.valoare : null;
}
async function scrieSetare(cheie, valoare) {
  const exista = await db.prepare("SELECT cheie FROM setari_app WHERE cheie = ?").get(cheie).catch(() => null);
  if (exista) await db.prepare("UPDATE setari_app SET valoare = ?, actualizat_la = ? WHERE cheie = ?").run(valoare, acum(), cheie);
  else await db.prepare("INSERT INTO setari_app (cheie, valoare, actualizat_la) VALUES (?, ?, ?)").run(cheie, valoare, acum());
}

// Datele firmei de pe etichetă: ce s-a scris în Setări. Altfel numele de pe
// aviz, iar adresa, telefonul și emailul din E.FIRMA_IMPLICITA (depozitul din
// CTPark, Vila Ana nr. 6 — nu sediul social; telefonul și emailul de office).
async function setari() {
  const f = json(await setare("etichete_firma"), {}) || {};
  const A = AV.FURNIZOR;
  const implicite = {};
  for (const fmt of Object.keys(E.FORMATE)) {
    const s = json(await setare("etichete_campuri_" + fmt), null);
    implicite[fmt] = E.campuriAlese(fmt, Array.isArray(s) ? s : E.IMPLICITE[fmt]);
  }
  return {
    firma: {
      nume: text(f.nume) || A.nume,
      adresa: text(f.adresa) || E.FIRMA_IMPLICITA.adresa,
      telefon: text(f.telefon) || E.FIRMA_IMPLICITA.telefon,
      email: text(f.email) || E.FIRMA_IMPLICITA.email,
    },
    sigla: text(await setare("etichete_sigla")),
    implicite,
  };
}

// ---- Datele ------------------------------------------------------------------
async function produsul(id) {
  const n = parseInt(id, 10) || 0;
  if (!n) return null;
  return db.prepare("SELECT id, cod, cod_generat, denumire, unitate_masura FROM produse WHERE id = ?").get(n).catch(() => null);
}
const codProdus = (p) => text(p && p.cod) || text(p && p.cod_generat);

// Caracteristicile din fișa produsului (codul configurat: grosime, lățime…).
async function caracteristiciProdus(id) {
  const r = await db
    .prepare(
      `SELECT v.nume, v.valoare, c.um FROM produse_cod_valori v
         LEFT JOIN cod_caracteristici c ON c.id = v.caracteristica_id
        WHERE v.produs_id = ? ORDER BY COALESCE(c.ordine, 0), v.id`
    )
    .all(Number(id) || 0)
    .catch(() => []);
  return r.map((x) => {
    const val = text(x.valoare);
    const um = text(x.um);
    return `${text(x.nume)}: ${val}${um && !val.toLowerCase().endsWith(um.toLowerCase()) ? " " + um : ""}`;
  });
}

// Comanda de producție: clientul, numărul, produsele și caracteristicile ei.
async function comandaProductie(id) {
  const n = parseInt(id, 10) || 0;
  if (!n) return null;
  const c = await db
    .prepare(
      `SELECT c.*, p.nume AS partener_nume, co.numar AS comanda_client_numar
         FROM comenzi_productie c
         LEFT JOIN parteneri p ON p.id = c.partener_id
         LEFT JOIN comenzi co ON co.id = c.comanda_id
        WHERE c.id = ?`
    )
    .get(n)
    .catch(() => null);
  if (!c) return null;
  const linii = await db
    .prepare("SELECT id, produs_id, denumire, cantitate, um FROM comenzi_productie_linii WHERE comanda_id = ? ORDER BY ordine, id")
    .all(n)
    .catch(() => []);
  const carac = await db
    .prepare("SELECT denumire, valoare, unitate, linie_id FROM comenzi_productie_caracteristici WHERE comanda_id = ? ORDER BY id")
    .all(n)
    .catch(() => []);
  const produse = linii.length
    ? linii.filter((l) => l.produs_id).map((l) => ({ produs_id: Number(l.produs_id), linie_id: Number(l.id), denumire: l.denumire }))
    : c.produs_id
      ? [{ produs_id: Number(c.produs_id), linie_id: null, denumire: c.tip_produs }]
      : [];
  return { c, linii, carac, produse };
}

function caracteristiciComanda(cp, linieId) {
  return (cp.carac || [])
    .filter((x) => !x.linie_id || Number(x.linie_id) === Number(linieId))
    .map((x) => {
      const val = text(x.valoare);
      const um = text(x.unitate);
      return val ? `${text(x.denumire)}: ${val}${um && !val.toLowerCase().endsWith(um.toLowerCase()) ? " " + um : ""}` : "";
    })
    .filter(Boolean);
}

async function lotul(id) {
  const n = parseInt(id, 10) || 0;
  if (!n) return null;
  return db
    .prepare(
      `SELECT l.*, p.denumire AS produs_denumire, cp.numar AS productie_numar
         FROM etichete_loturi l
         LEFT JOIN produse p ON p.id = l.produs_id
         LEFT JOIN comenzi_productie cp ON cp.id = l.comanda_productie_id
        WHERE l.id = ?`
    )
    .get(n)
    .catch(() => null);
}

async function tiparirile(lotId) {
  return db.prepare("SELECT * FROM etichete_tiparite WHERE lot_id = ? ORDER BY id DESC").all(Number(lotId)).catch(() => []);
}

// Lotul etichetelor unei comenzi de producție, pentru un produs: îl ia
// rândul recepției când marfa pleacă în depozit (lib/stadiu-comanda.js).
async function lotPentruProductie(cpId, produsId) {
  if (!(Number(cpId) > 0) || !(Number(produsId) > 0)) return null;
  const r = await db
    .prepare("SELECT lot FROM etichete_loturi WHERE comanda_productie_id = ? AND produs_id = ? ORDER BY id DESC LIMIT 1")
    .get(Number(cpId), Number(produsId))
    .catch(() => null);
  return r ? r.lot : null;
}

// ---- Ce scrie pe etichetă -------------------------------------------------------
// Din formular (sau din query, la previzualizare): câmpurile alese, formatul și
// conținutul. Codul produsului și codul de bare vin din nomenclator, nu din
// formular.
function dinFormular(b, p) {
  const fmt = E.format(b.format);
  const campuri = E.campuriAlese(fmt, lista(b["campuri[]"]).concat(lista(b.campuri)));
  const c = E.continut(Object.assign({}, b, { cod: codProdus(p), cod_scan: SCAN.codProdus(codProdus(p), p && p.id) }));
  if (!c.denumire) c.denumire = text(p && p.denumire);
  return { fmt, campuri, continut: c };
}

function etichetele(lot, tiparire, s) {
  const c = Object.assign({}, json(lot.continut, {}), json(tiparire.modificari, {}), { lot: lot.lot });
  const campuri = json(lot.campuri, []);
  const out = [];
  for (let n = Number(tiparire.de_la); n <= Number(tiparire.pana_la); n++) {
    out.push(E.eticheta(c, campuri, lot.format, s.firma, { numar: n, tiparitLa: tiparire.tiparit_la, sigla: s.sigla }));
  }
  return out;
}

const FEL = { nou: "Prima tipărire", suplimentar: "Suplimentar", din_nou: "Din nou" };

// ---- Paginile -------------------------------------------------------------------
function campuriHtml(fmt, alese) {
  const set = new Set(alese);
  return E.CAMPURI.map((c) => {
    const pe = E.CAMPURI_FORMAT[fmt].includes(c.cheie);
    const doar150 = !E.CAMPURI_FORMAT["100x50"].includes(c.cheie);
    return `<label class="et-camp" data-doar150="${doar150 ? 1 : 0}" style="display:inline-flex;gap:5px;align-items:center;margin:0 14px 6px 0;font-size:13px;font-weight:400">
        <input type="checkbox" name="campuri[]" value="${c.cheie}"${set.has(c.cheie) || c.mereu ? " checked" : ""}${c.mereu ? " disabled" : ""}${pe ? "" : " disabled"}> ${esc(c.nume)}${
      c.mereu ? ' <span style="color:var(--text-muted);font-size:11px">(mereu)</span>' : doar150 ? ' <span style="color:var(--text-muted);font-size:11px">(doar 100×150)</span>' : ""
    }</label>`;
  }).join("");
}

// Previzualizarea se reface la fiecare schimbare: aceeași pagină ca la
// tipărit, doar cu eticheta nr. 1. Fără backslash-uri și interpolări: textul
// ajunge ca atare în pagină.
const SCRIPT_PREVIZUALIZARE = `<script>
(function () {
  var f = document.getElementById("et-form");
  var fr = document.getElementById("et-mostra");
  if (!f || !fr) return;
  var t = null;
  function formate() {
    var mic = f.querySelector('input[name="format"]:checked');
    var e50 = mic && mic.value === "100x50";
    f.querySelectorAll("label.et-camp").forEach(function (l) {
      var cb = l.querySelector("input");
      if (cb.hasAttribute("data-mereu")) return;
      if (l.getAttribute("data-doar150") === "1") { cb.disabled = e50; l.style.opacity = e50 ? "0.45" : "1"; }
    });
    fr.style.height = e50 ? "230px" : "640px";
  }
  function reface() {
    var p = new URLSearchParams();
    var campuri = [];
    new FormData(f).forEach(function (v, k) { if (k === "campuri[]") campuri.push(v); else if (k !== "cate") p.append(k, v); });
    f.querySelectorAll('input[name="campuri[]"]:checked:disabled').forEach(function (cb) { campuri.push(cb.value); });
    p.set("campuri", campuri.join(","));
    fr.src = "${CALE}/previzualizare?" + p.toString();
  }
  f.addEventListener("input", function () { clearTimeout(t); t = setTimeout(reface, 450); });
  f.addEventListener("change", function () { formate(); clearTimeout(t); t = setTimeout(reface, 150); });
  f.querySelectorAll('input[name="campuri[]"][disabled]').forEach(function (cb) { if (cb.checked) cb.setAttribute("data-mereu", "1"); });
  formate();
  reface();
})();
</script>`;

function register(router) {
  // ---- Lista loturilor și „Etichetă nouă" ----------------------------------
  router.get(CALE, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const q = ctx.query || {};
    const cauta = text(q.q).slice(0, 60);
    const unde = cauta ? "WHERE UPPER(l.lot) LIKE ? OR UPPER(COALESCE(p.denumire, '')) LIKE ? OR UPPER(COALESCE(p.cod, '')) LIKE ? OR UPPER(COALESCE(cp.numar, '')) LIKE ?" : "";
    const tipar = "%" + cauta.toUpperCase() + "%";
    const loturi = await db
      .prepare(
        `SELECT l.id, l.lot, l.format, l.tiparite, l.creat_la, l.creat_de, l.comanda_productie_id,
                p.denumire AS produs_denumire, COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS produs_cod, cp.numar AS productie_numar,
                (SELECT t.tiparit_la FROM etichete_tiparite t WHERE t.lot_id = l.id ORDER BY t.id DESC LIMIT 1) AS ultima_la,
                (SELECT t.tiparit_de FROM etichete_tiparite t WHERE t.lot_id = l.id ORDER BY t.id DESC LIMIT 1) AS ultima_de,
                (SELECT COUNT(*) FROM etichete_tiparite t WHERE t.lot_id = l.id) AS tipariri
           FROM etichete_loturi l
           LEFT JOIN produse p ON p.id = l.produs_id
           LEFT JOIN comenzi_productie cp ON cp.id = l.comanda_productie_id
          ${unde}
          ORDER BY l.id DESC LIMIT 200`
      )
      .all(...(cauta ? [tipar, tipar, tipar, tipar] : []))
      .catch(() => []);
    const deLa = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const comenzi = await db
      .prepare(
        `SELECT c.id, c.numar, c.tip_produs, c.status, COALESCE(p.nume, c.client_text) AS client
           FROM comenzi_productie c LEFT JOIN parteneri p ON p.id = c.partener_id
          WHERE COALESCE(c.status, '') <> 'anulata' AND COALESCE(c.data_initiere, c.creat_la, '') >= ?
          ORDER BY c.id DESC LIMIT 300`
      )
      .all(deLa)
      .catch(() => []);
    const produse = await db
      .prepare("SELECT id, COALESCE(NULLIF(TRIM(cod), ''), cod_generat) AS cod, denumire FROM produse WHERE COALESCE(activ, 1) = 1 ORDER BY denumire LIMIT 5000")
      .all()
      .catch(() => []);
    const randuri = loturi.map((l) => [
      `<a href="${CALE}/${l.id}"><strong>${esc(l.lot)}</strong></a>`,
      `${esc(l.produs_denumire || "—")}${l.produs_cod ? `<div class="mic" style="color:var(--text-muted)">${esc(l.produs_cod)}</div>` : ""}`,
      l.productie_numar ? `<a href="/productie/${l.comanda_productie_id}">${esc(l.productie_numar)}</a>` : '<span style="color:var(--text-muted)">—</span>',
      esc(E.FORMATE[E.format(l.format)].nume),
      `<strong>${Number(l.tiparite) || 0}</strong> <span class="mic" style="color:var(--text-muted)">în ${Number(l.tipariri) || 0} ${Number(l.tipariri) === 1 ? "tipărire" : "tipăriri"}</span>`,
      l.ultima_la ? `${esc(E.dataRo(String(l.ultima_la).slice(0, 10)))} ${esc(String(l.ultima_la).slice(11, 16))}<div class="mic" style="color:var(--text-muted)">${esc(l.ultima_de || "")}</div>` : "—",
      `<a class="btn small secondary" href="${CALE}/${l.id}">Tipărește…</a>`,
    ]);
    const body = `
      ${q.eroare ? `<div class="flash flash-rosu" role="alert">${esc(q.eroare)}</div>` : ""}
      <div class="toolbar" style="justify-content:space-between;flex-wrap:wrap">
        <h1 style="margin:0">Etichete produs</h1>
        ${eAdmin(ctx.user) ? `<a class="btn secondary" href="${CALE}/setari">Setări: firma, sigla, câmpurile</a>` : ""}
      </div>
      <p style="max-width:900px;color:var(--text-muted);margin-top:4px">
        Etichete pe loturi, cu sigla și datele firmei, denumirea, caracteristicile, lotul și codul de bare al produsului —
        cu el, scanerul din CT-Park găsește marfa când o urci pe raft. Formatul 100×150 sau 100×50, pe Zebra. Fiecare
        tipărire rămâne în istoricul lotului: când, cine, ce numere.
      </p>
      <form class="form" method="get" action="${CALE}/noua" style="max-width:900px">
        <h2 style="margin-top:0;font-size:17px">Etichetă nouă</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="field"><span>Din comanda de producție (completează produsul, clientul și lotul)</span>
            <select name="productie"><option value="">— fără comandă —</option>${comenzi
              .map((c) => `<option value="${c.id}">${esc(c.numar || "#" + c.id)} · ${esc(String(c.tip_produs || "").slice(0, 50))}${c.client ? " · " + esc(c.client) : ""}</option>`)
              .join("")}</select></label>
          <label class="field"><span>…sau produsul, din nomenclator</span>
            <input name="produs" list="et-produse" autocomplete="off" placeholder="scrie codul sau denumirea">
            <datalist id="et-produse">${produse.map((p) => `<option value="#${p.id} ${esc(p.cod || "")} — ${esc(p.denumire)}"></option>`).join("")}</datalist></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Continuă →</button></div>
      </form>
      <h2 style="margin-top:26px;font-size:17px">Loturi de etichete</h2>
      <form method="get" action="${CALE}" class="inline-form" style="margin-bottom:8px">
        <input name="q" value="${esc(cauta)}" placeholder="lot, produs, cod sau comandă" style="min-width:260px">
        <button class="btn small secondary" type="submit">Caută</button>
      </form>
      ${loturi.length ? `<div class="tabel-scroll">${table(["Lot", "Produs", "Comanda de producție", "Format", "Etichete", "Ultima tipărire", ""], randuri)}</div>` : '<p style="color:var(--text-muted)">Niciun lot încă.</p>'}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Etichete produs", active: CALE, body }));
  });

  // ---- Configurarea etichetei noi --------------------------------------------
  router.get(`${CALE}/noua`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const q = ctx.query || {};
    const cp = await comandaProductie(q.productie);
    let produsId = parseInt(String(q.produs_id || q.produs || "").replace(/^#/, ""), 10) || 0;
    // Scris de mână, fără să aleagă din listă: codul exact sau denumirea exactă.
    if (!produsId && text(q.produs)) {
      const scris = text(q.produs).toUpperCase();
      const g = await db
        .prepare(
          `SELECT id FROM produse WHERE COALESCE(activ, 1) = 1
              AND (UPPER(TRIM(COALESCE(cod, ''))) = ? OR UPPER(TRIM(COALESCE(cod_generat, ''))) = ? OR UPPER(TRIM(denumire)) = ?)
            ORDER BY id LIMIT 2`
        )
        .all(scris, scris, scris)
        .catch(() => []);
      if (g.length === 1) produsId = Number(g[0].id);
    }
    if (!produsId && cp && cp.produse.length === 1) produsId = cp.produse[0].produs_id;
    if (!produsId && cp && cp.produse.length > 1) {
      const body = `<h1>Etichete pentru comanda ${esc(cp.c.numar || "#" + cp.c.id)}</h1>
        <p>Comanda are mai multe produse. Pentru care faci etichetele?</p>
        <ul>${cp.produse.map((x) => `<li><a href="${CALE}/noua?productie=${cp.c.id}&amp;produs_id=${x.produs_id}">${esc(x.denumire || "#" + x.produs_id)}</a></li>`).join("")}</ul>`;
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Etichete produs", active: CALE, body }));
    }
    const p = await produsul(produsId);
    if (!p) {
      const mesaj = cp ? "Comanda de producție n-are produs din nomenclator. Alege produsul." : "Alege produsul din listă (sau o comandă de producție).";
      return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent(mesaj)}`);
    }
    const s = await setari();
    const fmt = E.format(q.format);
    const linie = cp ? cp.produse.find((x) => x.produs_id === Number(p.id)) : null;
    // Ce vine propus: din comanda de producție, altfel din fișa produsului. Ce
    // a scris omul (întors după o eroare) are întâietate.
    const caracComanda = cp ? caracteristiciComanda(cp, linie && linie.linie_id) : [];
    const propus = {
      denumire: p.denumire,
      caracteristici: (caracComanda.length ? caracComanda : await caracteristiciProdus(p.id)).join("\n"),
      lot: cp ? FL.codLot(cp.c) : "",
      data_productiei: azi(),
      client: cp ? text(cp.c.partener_nume) || text(cp.c.client_text) : "",
      comanda: cp ? text(cp.c.comanda_client_numar) || text(cp.c.numar) : "",
    };
    if (!propus.lot) {
      const deAzi = await db.prepare("SELECT lot FROM etichete_loturi WHERE lot LIKE ?").all("L" + azi().slice(2).replace(/-/g, "") + "-%").catch(() => []);
      propus.lot = E.lotPropus({ zi: azi(), existente: deAzi.map((x) => x.lot) });
    }
    const v = (k) => (q[k] !== undefined ? text(q[k]) : text(propus[k]));
    const alese = q.campuri !== undefined ? E.campuriAlese(fmt, q.campuri) : s.implicite[fmt];
    const um = text(p.unitate_masura) || "buc";
    const camp = (k, eticheta, attrs) => `<label class="field" style="margin:0"><span>${esc(eticheta)}</span><input name="${k}" value="${esc(v(k))}" ${attrs || ""}></label>`;
    const body = `
      ${q.eroare ? `<div class="flash flash-rosu" role="alert">${esc(q.eroare)}</div>` : ""}
      <div class="toolbar"><a class="btn secondary" href="${CALE}">← Etichete produs</a></div>
      <h1 style="margin:6px 0 2px">Etichete: ${esc(p.denumire)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted)">Cod ${esc(codProdus(p) || "—")} · pe codul de bare: <strong>${esc(SCAN.codProdus(codProdus(p), p.id))}</strong>${
        cp ? ` · din comanda de producție <a href="/productie/${cp.c.id}">${esc(cp.c.numar || "#" + cp.c.id)}</a>` : ""
      }</p>
      <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
      <form id="et-form" class="form" method="post" action="${CALE}" style="flex:1 1 520px;max-width:720px;margin:0">
        <input type="hidden" name="produs_id" value="${p.id}">
        <input type="hidden" name="comanda_productie_id" value="${cp ? cp.c.id : ""}">
        <div class="field"><span>Format</span>
          ${Object.entries(E.FORMATE)
            .map(([k, f]) => `<label style="display:inline-flex;gap:6px;align-items:center;margin-right:18px;font-weight:400"><input type="radio" name="format" value="${k}"${k === fmt ? " checked" : ""}> ${esc(f.nume)}</label>`)
            .join("")}
        </div>
        <div class="field"><span>Ce apare pe etichetă</span><div>${campuriHtml("100x150", alese)}</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          ${camp("lot", "Lot", 'required maxlength="30" style="font-weight:700;text-transform:uppercase"')}
          ${camp("data_productiei", "Data producției", 'type="date"')}
          ${camp("cantitate", `Cantitate pe ambalaj (ex. 36 ${um})`, 'maxlength="40"')}
          ${camp("greutate_neta", "Greutate netă (ex. 16 kg)", 'maxlength="30"')}
          ${camp("greutate_bruta", "Greutate brută", 'maxlength="30"')}
          ${camp("client", "Client", 'maxlength="80"')}
          ${camp("comanda", "Comanda", 'maxlength="60"')}
          ${camp("valabilitate", "Valabil până la", 'type="date"')}
          ${camp("operator", "Operator", 'maxlength="60"')}
          ${camp("observatii", "Observații", 'maxlength="120"')}
        </div>
        <label class="field" style="margin-top:10px"><span>Denumirea de pe etichetă</span><input name="denumire" value="${esc(v("denumire"))}" maxlength="200"></label>
        <label class="field"><span>Caracteristici — câte una pe rând (pe 100×150 încap 6, pe 100×50 primul rând)</span>
          <textarea name="caracteristici" rows="5" maxlength="1000">${esc(v("caracteristici"))}</textarea></label>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:6px">
          <label class="field" style="margin:0"><span>Câte etichete tipărești acum</span>
            <input name="cate" type="number" min="1" max="${E.MAX_TIPAR}" value="${esc(text(q.cate) || "1")}" required style="width:120px"></label>
          <button class="btn" type="submit">Salvează lotul și tipărește →</button>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">
          Etichetele se numerotează de la 1. Mai târziu, din pagina lotului, tipărești suplimentar (numerotarea continuă) sau
          din nou aceleași numere — fiecare tipărire rămâne în istoric, cu data și cine a tipărit.
        </p>
      </form>
      <div style="flex:0 0 auto">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Cum iese eticheta (nr. 1)</div>
        <iframe id="et-mostra" title="Previzualizarea etichetei" style="width:420px;height:640px;border:1px solid var(--border,#ddd);background:#eceff3"></iframe>
      </div>
      </div>
      ${SCRIPT_PREVIZUALIZARE}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Etichetă nouă", active: CALE, body }));
  });

  // Eticheta nr. 1 cu ce e acum în formular — aceeași pagină ca la tipărit.
  router.get(`${CALE}/previzualizare`, async (ctx) => {
    if (!poate(ctx.user)) return send(ctx.res, 403, "Fără acces.");
    const q = ctx.query || {};
    const p = await produsul(q.produs_id);
    if (!p) return send(ctx.res, 404, "Produsul nu există.");
    const s = await setari();
    const d = dinFormular(q, p);
    d.continut.lot = E.curataLot(q.lot).lot || text(q.lot).toUpperCase().slice(0, 30);
    const html = E.pagina([E.eticheta(d.continut, d.campuri, d.fmt, s.firma, { numar: 1, tiparitLa: acum(), sigla: s.sigla })], d.fmt, { titlu: "Previzualizare", sigla: s.sigla });
    send(ctx.res, 200, html);
  });

  // ---- Lotul nou și prima tipărire -------------------------------------------
  router.post(CALE, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const b = ctx.body || {};
    const inapoi = (mesaj) => {
      const qs = new URLSearchParams();
      for (const k of ["produs_id", "format", "lot", "data_productiei", "cantitate", "greutate_neta", "greutate_bruta", "client", "comanda", "valabilitate", "operator", "observatii", "denumire", "caracteristici", "cate"]) {
        if (text(b[k])) qs.set(k, text(b[k]).slice(0, 1000));
      }
      if (text(b.comanda_productie_id)) qs.set("productie", text(b.comanda_productie_id));
      qs.set("campuri", lista(b["campuri[]"]).map(text).join(","));
      qs.set("eroare", mesaj);
      return redirect(ctx.res, `${CALE}/noua?${qs.toString()}`);
    };
    const p = await produsul(b.produs_id);
    if (!p) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Produsul nu mai există. Alege-l din nou.")}`);
    const l = E.curataLot(b.lot);
    if (l.eroare) return inapoi(l.eroare);
    const n = E.interval({ fel: "nou", tiparite: 0, cate: b.cate });
    if (n.eroare) return inapoi(n.eroare);
    const cp = await comandaProductie(b.comanda_productie_id);
    const d = dinFormular(b, p);
    // Același lot pentru același produs e un singur lot: celelalte etichete ale
    // lui se tipăresc din pagina lui, cu numerotarea mai departe.
    const exista = await db.prepare("SELECT id FROM etichete_loturi WHERE UPPER(lot) = ? AND produs_id = ?").get(l.lot, p.id).catch(() => null);
    if (exista) {
      return redirect(ctx.res, `${CALE}/${exista.id}?eroare=${encodeURIComponent(`Lotul ${l.lot} există deja pentru produsul ăsta. Etichetele lui se tipăresc de aici: „Suplimentar” continuă numerotarea, „Din nou” scoate aceleași numere.`)}`);
    }
    const u = ctx.user || {};
    let lotId;
    try {
      lotId = Number(
        (
          await db
            .prepare(
              `INSERT INTO etichete_loturi (lot, produs_id, comanda_productie_id, format, campuri, continut, tiparite, creat_de_id, creat_de, creat_la)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
            )
            .run(l.lot, p.id, cp ? cp.c.id : null, d.fmt, JSON.stringify(d.campuri), JSON.stringify(d.continut), n.pana_la, u.id || null, u.nume || "", acum())
        ).lastInsertRowid
      );
    } catch (e) {
      // Doi oameni, același lot, în aceeași secundă: indexul unic l-a oprit pe al doilea.
      const x = await db.prepare("SELECT id FROM etichete_loturi WHERE UPPER(lot) = ? AND produs_id = ?").get(l.lot, p.id).catch(() => null);
      if (x) return redirect(ctx.res, `${CALE}/${x.id}?eroare=${encodeURIComponent(`Lotul ${l.lot} tocmai a fost făcut de altcineva. Tipărește de aici.`)}`);
      throw e;
    }
    const t = await db
      .prepare(
        `INSERT INTO etichete_tiparite (lot_id, fel, de_la, pana_la, modificari, motiv, tiparit_de_id, tiparit_de, tiparit_la)
         VALUES (?, 'nou', ?, ?, NULL, NULL, ?, ?, ?) RETURNING id`
      )
      .run(lotId, n.de_la, n.pana_la, u.id || null, u.nume || "", acum());
    console.log(`[etichete] ${u.nume || "?"} a făcut lotul ${l.lot} (${p.denumire}): ${n.cate} etichete ${d.fmt}`);
    redirect(ctx.res, `${CALE}/${lotId}/tipar/${t.lastInsertRowid}`);
  });

  // ---- Setările (administrator) ------------------------------------------------
  router.get(`${CALE}/setari`, async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, CALE);
    const s = await setari();
    const q = ctx.query || {};
    const mostra = E.continut({
      denumire: "Folie stretch automată transparentă 23 µm, 16 kg",
      cod: "PROBA",
      cod_scan: "PROBA",
      caracteristici: "Grosime: 23 µm\nLățime: 500 mm\nGreutate rolă: 16 kg",
      data_productiei: azi(),
      cantitate: "1 rolă",
    });
    mostra.lot = "L" + azi().slice(2).replace(/-/g, "") + "-01";
    const exemplu = (fmt) => E.eticheta(mostra, s.implicite[fmt], fmt, s.firma, { numar: 1, tiparitLa: acum(), sigla: s.sigla });
    const body = `
      ${q.ok ? `<div class="flash">${esc(q.ok)}</div>` : ""}
      ${q.eroare ? `<div class="flash flash-rosu" role="alert">${esc(q.eroare)}</div>` : ""}
      <div class="toolbar"><a class="btn secondary" href="${CALE}">← Etichete produs</a></div>
      <h1 style="margin:6px 0">Setările etichetelor</h1>
      <form class="form" method="post" action="${CALE}/setari" enctype="multipart/form-data" style="max-width:820px">
        <h2 style="margin-top:0;font-size:16px">Firma, cum apare pe etichetă</h2>
        <label class="field"><span>Numele</span><input name="nume" value="${esc(s.firma.nume)}" maxlength="80"></label>
        <label class="field"><span>Adresa</span><input name="adresa" value="${esc(s.firma.adresa)}" maxlength="160">
          <small style="color:var(--text-muted)">Implicit e adresa depozitului din CTPark (${esc(E.FIRMA_IMPLICITA.adresa)}), nu sediul social. Golită, revine la ea.</small></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="field"><span>Telefon</span><input name="telefon" value="${esc(s.firma.telefon)}" maxlength="40"></label>
          <label class="field"><span>Email</span><input name="email" value="${esc(s.firma.email)}" maxlength="80"></label>
        </div>
        <h2 style="font-size:16px">Sigla</h2>
        <p style="font-size:13px;color:var(--text-muted);margin-top:0">
          ${s.sigla ? "E încărcată o siglă." : "Acum e sigla implicită „CM”, în negru."} Încarcă sigla firmei ca PNG, JPG sau SVG (cel mult 300 KB).
          Pe imprimanta termică iese în alb-negru: o siglă cu contur clar se vede cel mai bine.
        </p>
        <input type="file" name="sigla" accept="image/png,image/jpeg,image/svg+xml">
        ${s.sigla ? `<label style="display:block;margin-top:6px;font-weight:400"><input type="checkbox" name="fara_sigla" value="1"> scoate sigla încărcată (revine „CM”)</label>` : ""}
        <h2 style="font-size:16px">Câmpurile bifate implicit</h2>
        ${Object.entries(E.FORMATE)
          .map(
            ([fmt, f]) => `<div class="field"><span>${esc(f.nume)}</span><div>${E.CAMPURI.filter((c) => E.CAMPURI_FORMAT[fmt].includes(c.cheie))
              .map(
                (c) =>
                  `<label style="display:inline-flex;gap:5px;align-items:center;margin:0 14px 6px 0;font-size:13px;font-weight:400"><input type="checkbox" name="implicite_${fmt}[]" value="${c.cheie}"${
                    s.implicite[fmt].includes(c.cheie) ? " checked" : ""
                  }${c.mereu ? " disabled" : ""}> ${esc(c.nume)}</label>`
              )
              .join("")}</div></div>`
          )
          .join("")}
        <div class="form-actions"><button class="btn" type="submit">Salvează</button></div>
      </form>
      <h2 style="font-size:16px;margin-top:22px">Cum arată acum</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <iframe title="Exemplu 100×150" style="width:420px;height:620px;border:1px solid var(--border,#ddd)" srcdoc="${esc(E.pagina([exemplu("100x150")], "100x150", { sigla: s.sigla }))}"></iframe>
        <iframe title="Exemplu 100×50" style="width:420px;height:230px;border:1px solid var(--border,#ddd)" srcdoc="${esc(E.pagina([exemplu("100x50")], "100x50", { sigla: s.sigla }))}"></iframe>
      </div>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Setările etichetelor", active: CALE, body }));
  });

  router.post(`${CALE}/setari`, async (ctx) => {
    if (!eAdmin(ctx.user)) return redirect(ctx.res, CALE);
    const b = ctx.body || {};
    const inapoi = (k, m) => redirect(ctx.res, `${CALE}/setari?${k}=${encodeURIComponent(m)}`);
    const fisier = ((b.__files || {}).sigla || [])[0];
    let sigla = null;
    if (fisier && fisier.data && fisier.data.length) {
      if (fisier.data.length > SIGLA_MAX) return inapoi("eroare", "Sigla are mai mult de 300 KB. Micșoreaz-o (o siglă de etichetă nu are nevoie de mai mult de 600 px).");
      const tip = siglaTip(fisier);
      if (!tip) return inapoi("eroare", "Sigla trebuie să fie PNG, JPG sau SVG.");
      sigla = `data:${tip};base64,${fisier.data.toString("base64")}`;
    }
    await scrieSetare(
      "etichete_firma",
      JSON.stringify({ nume: text(b.nume).slice(0, 80), adresa: text(b.adresa).slice(0, 160), telefon: text(b.telefon).slice(0, 40), email: text(b.email).slice(0, 80) })
    );
    for (const fmt of Object.keys(E.FORMATE)) {
      await scrieSetare("etichete_campuri_" + fmt, JSON.stringify(E.campuriAlese(fmt, lista(b[`implicite_${fmt}[]`]))));
    }
    if (sigla) await scrieSetare("etichete_sigla", sigla);
    else if (text(b.fara_sigla) === "1") await scrieSetare("etichete_sigla", "");
    console.log(`[etichete] ${(ctx.user && ctx.user.nume) || "?"} a schimbat setările etichetelor${sigla ? " (siglă nouă)" : ""}`);
    inapoi("ok", "Salvat. Etichetele de acum încolo au datele astea — și cele tipărite din nou dintr-un lot vechi.");
  });

  // ---- Un lot ----------------------------------------------------------------------
  router.get(`${CALE}/:id`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const l = await lotul(ctx.params.id);
    if (!l) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Lotul nu există.")}`);
    const q = ctx.query || {};
    const t = await tiparirile(l.id);
    const c = json(l.continut, {});
    const campuri = json(l.campuri, []);
    const valori = [
      ["Denumire", c.denumire],
      ["Cod produs / pe codul de bare", `${c.cod || "—"} / ${c.cod_scan || "—"}`],
      ["Caracteristici", (c.caracteristici || []).join("; ")],
      ["Data producției", E.dataRo(c.data_productiei)],
      ["Cantitate pe ambalaj", c.cantitate],
      ["Greutate netă / brută", [c.greutate_neta, c.greutate_bruta].filter(Boolean).join(" / ")],
      ["Client", c.client],
      ["Comanda", c.comanda],
      ["Valabil până la", E.dataRo(c.valabilitate)],
      ["Operator", c.operator],
      ["Observații", c.observatii],
    ].filter(([, v]) => text(v));
    const istoric = t.map((x) => {
      const m = json(x.modificari, {});
      const schimbat = Object.entries(m).map(([k, v]) => `${E.NUME_CAMP[k] || k}: ${k === "data_productiei" ? E.dataRo(v) : v}`);
      return [
        `${esc(E.dataRo(String(x.tiparit_la || "").slice(0, 10)))} ${esc(String(x.tiparit_la || "").slice(11, 16))}`,
        esc(x.tiparit_de || "—"),
        esc(FEL[x.fel] || x.fel),
        `${Number(x.de_la)}–${Number(x.pana_la)} <span class="mic" style="color:var(--text-muted)">(${Number(x.pana_la) - Number(x.de_la) + 1})</span>`,
        esc(schimbat.join("; ") || "—"),
        esc(x.motiv || ""),
        `<a href="${CALE}/${l.id}/tipar/${x.id}">vezi</a>`,
      ];
    });
    const mod = (k, et, attrs) => `<label class="field" style="margin:0"><span>${esc(et)}</span><input name="${k}" ${attrs || ""}></label>`;
    const modificabile = `
      <details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Altfel decât pe lot, doar la tipărirea asta (ultima cutie, alt operator…)</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">
          ${mod("cantitate", "Cantitate pe ambalaj", `placeholder="${esc(c.cantitate || "")}" maxlength="40"`)}
          ${mod("data_productiei", "Data producției", 'type="date"')}
          ${mod("greutate_neta", "Greutate netă", `placeholder="${esc(c.greutate_neta || "")}" maxlength="30"`)}
          ${mod("greutate_bruta", "Greutate brută", `placeholder="${esc(c.greutate_bruta || "")}" maxlength="30"`)}
          ${mod("operator", "Operator", `placeholder="${esc(c.operator || "")}" maxlength="60"`)}
          ${mod("observatii", "Observații", `placeholder="${esc(c.observatii || "")}" maxlength="120"`)}
        </div></details>`;
    const body = `
      ${q.eroare ? `<div class="flash flash-rosu" role="alert">${esc(q.eroare)}</div>` : ""}
      <div class="toolbar"><a class="btn secondary" href="${CALE}">← Etichete produs</a></div>
      <h1 style="margin:6px 0 2px">Lot ${esc(l.lot)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted)">
        ${esc(l.produs_denumire || c.denumire || "")}${l.productie_numar ? ` · comanda de producție <a href="/productie/${l.comanda_productie_id}">${esc(l.productie_numar)}</a>` : ""}
        · ${esc(E.FORMATE[E.format(l.format)].nume)} · făcut de ${esc(l.creat_de || "—")} la ${esc(E.dataRo(String(l.creat_la || "").slice(0, 10)))} ${esc(String(l.creat_la || "").slice(11, 16))}
        · <strong>${Number(l.tiparite) || 0} etichete</strong> numerotate
      </p>
      <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1 1 480px;max-width:720px">
          <form class="form" method="post" action="${CALE}/${l.id}/tipareste" style="margin:0 0 12px">
            <input type="hidden" name="fel" value="suplimentar">
            <h2 style="margin-top:0;font-size:16px">Tipărește suplimentar</h2>
            <p style="font-size:13px;color:var(--text-muted);margin:0 0 6px">Etichete noi, de la nr. ${Number(l.tiparite) + 1} încolo.</p>
            <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
              <label class="field" style="margin:0"><span>Câte</span><input name="cate" type="number" min="1" max="${E.MAX_TIPAR}" value="1" required style="width:110px"></label>
              <label class="field" style="margin:0;flex:1"><span>De ce (opțional)</span><input name="motiv" maxlength="200" placeholder="ex. încă un palet din lot"></label>
              <button class="btn" type="submit">Tipărește →</button>
            </div>
            ${modificabile}
          </form>
          <form class="form" method="post" action="${CALE}/${l.id}/tipareste" style="margin:0">
            <input type="hidden" name="fel" value="din_nou">
            <h2 style="margin-top:0;font-size:16px">Tipărește din nou aceleași numere</h2>
            <p style="font-size:13px;color:var(--text-muted);margin:0 0 6px">Pentru etichete rupte sau pierdute — numerele 1–${Number(l.tiparite) || 0}.</p>
            <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
              <label class="field" style="margin:0"><span>De la nr.</span><input name="de" type="number" min="1" max="${Number(l.tiparite) || 1}" required style="width:100px"></label>
              <label class="field" style="margin:0"><span>Până la nr.</span><input name="pana" type="number" min="1" max="${Number(l.tiparite) || 1}" required style="width:100px"></label>
              <label class="field" style="margin:0;flex:1"><span>De ce</span><input name="motiv" maxlength="200" required placeholder="ex. eticheta 7 s-a rupt"></label>
              <button class="btn secondary" type="submit">Tipărește din nou →</button>
            </div>
            ${modificabile}
          </form>
          <h2 style="font-size:16px;margin-top:20px">Istoricul tipăririlor</h2>
          ${t.length ? `<div class="tabel-scroll">${table(["Când", "Cine", "Ce", "Numerele", "Altfel decât pe lot", "De ce", ""], istoric)}</div>` : "<p>Nimic tipărit încă.</p>"}
          <h2 style="font-size:16px;margin-top:20px">Ce scrie pe etichete</h2>
          ${table(["", ""], valori.map(([k, val]) => [esc(k), esc(val)]))}
          <p style="font-size:12px;color:var(--text-muted)">Câmpuri: ${esc(campuri.map((k) => E.NUME_CAMP[k] || k).join(", "))}.</p>
        </div>
        <div style="flex:0 0 auto">
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Eticheta nr. 1</div>
          <iframe title="Eticheta lotului" style="width:420px;height:${E.format(l.format) === "100x50" ? 230 : 640}px;border:1px solid var(--border,#ddd);background:#eceff3" src="${CALE}/${l.id}/mostra"></iframe>
        </div>
      </div>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Lot " + l.lot, active: CALE, body }));
  });

  router.get(`${CALE}/:id/mostra`, async (ctx) => {
    if (!poate(ctx.user)) return send(ctx.res, 403, "Fără acces.");
    const l = await lotul(ctx.params.id);
    if (!l) return send(ctx.res, 404, "Lotul nu există.");
    const s = await setari();
    send(ctx.res, 200, E.pagina(etichetele(l, { de_la: 1, pana_la: 1, tiparit_la: acum() }, s), l.format, { titlu: "Lot " + l.lot, sigla: s.sigla }));
  });

  // ---- O tipărire nouă: suplimentar sau din nou --------------------------------
  router.post(`${CALE}/:id/tipareste`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const l = await lotul(ctx.params.id);
    if (!l) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Lotul nu există.")}`);
    const b = ctx.body || {};
    const inapoi = (m) => redirect(ctx.res, `${CALE}/${l.id}?eroare=${encodeURIComponent(m)}`);
    const fel = text(b.fel) === "din_nou" ? "din_nou" : "suplimentar";
    const motiv = text(b.motiv).slice(0, 200);
    if (fel === "din_nou" && !motiv) return inapoi("Spune de ce tipărești din nou (de exemplu „eticheta 7 s-a rupt”): rămâne în istoric.");
    let n;
    if (fel === "din_nou") {
      n = E.interval({ fel, tiparite: l.tiparite, de: b.de, pana: b.pana });
      if (n.eroare) return inapoi(n.eroare);
    } else {
      const v = E.interval({ fel, tiparite: 0, cate: b.cate });
      if (v.eroare) return inapoi(v.eroare);
      // Numerele se iau dintr-o singură scriere: doi oameni care tipăresc
      // deodată primesc numere diferite.
      const r = await db.prepare("UPDATE etichete_loturi SET tiparite = tiparite + ? WHERE id = ? RETURNING tiparite").get(v.cate, l.id);
      const pana = Number(r && r.tiparite) || 0;
      n = { de_la: pana - v.cate + 1, pana_la: pana, cate: v.cate };
    }
    const m = E.modificari(b);
    const u = ctx.user || {};
    const t = await db
      .prepare(
        `INSERT INTO etichete_tiparite (lot_id, fel, de_la, pana_la, modificari, motiv, tiparit_de_id, tiparit_de, tiparit_la)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(l.id, fel, n.de_la, n.pana_la, Object.keys(m).length ? JSON.stringify(m) : null, motiv || null, u.id || null, u.nume || "", acum());
    console.log(`[etichete] ${u.nume || "?"}: lotul ${l.lot}, ${fel === "din_nou" ? "din nou" : "suplimentar"} ${n.de_la}–${n.pana_la}`);
    redirect(ctx.res, `${CALE}/${l.id}/tipar/${t.lastInsertRowid}`);
  });

  // ---- Pagina de tipărit a unei tipăriri ----------------------------------------
  router.get(`${CALE}/:id/tipar/:tid`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const l = await lotul(ctx.params.id);
    const t = l ? await db.prepare("SELECT * FROM etichete_tiparite WHERE id = ? AND lot_id = ?").get(parseInt(ctx.params.tid, 10) || 0, l.id).catch(() => null) : null;
    if (!l || !t) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Tipărirea nu există.")}`);
    const s = await setari();
    const u = ctx.user || {};
    // Butonul „Tipărește" doar imediat după, pentru omul care a cerut tipărirea.
    // O tipărire veche se vede; ca să iasă din nou pe hârtie, trece prin „Din
    // nou", ca să rămână și ea în istoric.
    const minute = (Date.parse(acum().replace(" ", "T")) - Date.parse(String(t.tiparit_la || "").replace(" ", "T"))) / 60000;
    const proaspata = Number(t.tiparit_de_id) === Number(u.id) && minute >= 0 && minute <= MINUTE_TIPAR;
    const cate = Number(t.pana_la) - Number(t.de_la) + 1;
    const bara = `<strong>Lot ${esc(l.lot)}</strong> · ${esc(l.produs_denumire || "")} · etichetele ${Number(t.de_la)}–${Number(t.pana_la)} (${cate}) · ${esc(FEL[t.fel] || t.fel)}, ${esc(
      t.tiparit_de || ""
    )}, ${esc(E.dataRo(String(t.tiparit_la || "").slice(0, 10)))} ${esc(String(t.tiparit_la || "").slice(11, 16))}<br>
      ${proaspata ? `<button onclick="window.print()">Tipărește</button> · ` : `<em>Doar vizualizare. Pentru încă o tipărire: „Din nou” pe pagina lotului — rămâne în istoric.</em><br>`}
      <a href="${CALE}/${l.id}">înapoi la lot</a>`;
    send(ctx.res, 200, E.pagina(etichetele(l, t, s), l.format, { titlu: `Etichete ${l.lot} ${t.de_la}-${t.pana_la}`, bara, sigla: s.sigla }));
  });
}

// Sigla încărcată: tipul după conținut, nu după ce spune browserul.
function siglaTip(f) {
  const d = f.data;
  if (d.length > 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return "image/png";
  if (d.length > 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return "image/jpeg";
  const inceput = d.slice(0, 2000).toString("utf8").replace(/^﻿/, "").trim();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(inceput)) return "image/svg+xml";
  return null;
}

module.exports = { register, lotPentruProductie, setari, siglaTip };
