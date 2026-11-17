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
//   /productie/etichete/comanda/:id  comanda clientului: liniile ei, fiecare
//                                    cu loturile de etichete de până acum și
//                                    „Etichete →" cu formularul completat
//
// PE COMANDA CLIENTULUI (Vali, 16.11.2026: „să poți genera și etichetele
// pentru o comandă: selectezi comanda și faci etichete pentru ea"). Se intră
// din pagina comenzii (butonul „Etichete produs") sau din lista de aici. Linia
// care are o comandă de producție merge pe ea (lotul fișei de lot, ca până
// acum); celelalte primesc clientul, numărul comenzii și un lot propus. Lotul
// ține minte comanda clientului (etichete_loturi.comanda_id).
//
// DREPTURILE: bifa „Etichete produs (doar generatorul)" sau toată Producția
// (lib/auth.js). Cine are doar bifa nu vede comenzile de producție: numărul
// lor apare fără link, ca să nu ducă la „Nu ai acces".
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
// Numărul comenzii de producție: link doar pentru cine o poate deschide.
const linkProductie = (u, id, numar) =>
  poateAccesa(u, "/productie/" + Number(id)) ? `<a href="/productie/${Number(id)}">${esc(numar)}</a>` : esc(numar);
const nrRo = (v) => Number(v || 0).toLocaleString("ro-RO", { maximumFractionDigits: 3 });
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
// Greutățile au intrat între câmpurile bifate implicit pe 17.11.2026 (Vali:
// căsuța lor să iasă cu numele ei și fără valoare, ca să se scrie la cântar).
// Lista salvată din Setări înainte de ziua aceea nu le are — nu fiindcă le-a
// scos cineva, ci fiindcă atunci nu erau în ea — deci le primește acum, O
// SINGURĂ DATĂ. După aceea contează doar ce se bifează în Setări: cine le
// scoate de acolo, scoase rămân.
const VERSIUNE_IMPLICITE = "2";
async function aduGreutatileInImplicite() {
  if (text(await setare("etichete_campuri_versiune")) === VERSIUNE_IMPLICITE) return;
  const s = json(await setare("etichete_campuri_100x150"), null);
  if (Array.isArray(s)) {
    await scrieSetare("etichete_campuri_100x150", JSON.stringify(E.campuriAlese("100x150", s.concat(["greutate_neta", "greutate_bruta"]))));
  }
  await scrieSetare("etichete_campuri_versiune", VERSIUNE_IMPLICITE);
}

async function setari() {
  await aduGreutatileInImplicite().catch((e) => console.error("[etichete] greutățile implicite:", e.message));
  const f = json(await setare("etichete_firma"), {}) || {};
  const A = AV.FURNIZOR;
  const implicite = {};
  // Câmpurile bifate implicit țin de hârtie: aceleași pe înalt și pe lat.
  for (const fmt of Object.keys(E.FORMATE)) {
    const s = json(await setare("etichete_campuri_" + E.hartia(fmt)), null);
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

// Comanda clientului: clientul, numărul, liniile, comenzile de producție din
// spatele ei și loturile de etichete făcute până acum pentru ea — cele scrise
// pe comandă și cele făcute din comenzile ei de producție.
async function comandaClient(id) {
  const n = parseInt(id, 10) || 0;
  if (!n) return null;
  const c = await db
    .prepare(
      `SELECT co.id, co.numar, co.status, co.data, COALESCE(p.nume, '') AS client
         FROM comenzi co LEFT JOIN parteneri p ON p.id = co.partener_id
        WHERE co.id = ?`
    )
    .get(n)
    .catch(() => null);
  if (!c) return null;
  const linii = await db
    .prepare(
      `SELECT cl.id, cl.produs_id, cl.cantitate, cl.um, p.denumire, p.unitate_masura,
              COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS cod
         FROM comenzi_linii cl LEFT JOIN produse p ON p.id = cl.produs_id
        WHERE cl.comanda_id = ? ORDER BY cl.id`
    )
    .all(n)
    .catch(() => []);
  const productie = await db
    .prepare(
      `SELECT cp.id, cp.numar, cp.status, cp.data_initiere, cp.creat_la, cp.produs_id, a.linie_id
         FROM comenzi_productie cp LEFT JOIN aprovizionari a ON a.id = cp.aprovizionare_id
        WHERE cp.comanda_id = ? AND COALESCE(cp.status, '') <> 'anulata'
        ORDER BY cp.id DESC`
    )
    .all(n)
    .catch(() => []);
  const produseProductie = productie.length
    ? await db
        .prepare(`SELECT comanda_id, produs_id FROM comenzi_productie_linii WHERE comanda_id IN (${productie.map((x) => Number(x.id)).join(",")})`)
        .all()
        .catch(() => [])
    : [];
  const loturi = await db
    .prepare(
      `SELECT l.id, l.lot, l.produs_id, l.tiparite, l.comanda_productie_id
         FROM etichete_loturi l
        WHERE l.comanda_id = ? OR l.comanda_productie_id IN (SELECT id FROM comenzi_productie WHERE comanda_id = ?)
        ORDER BY l.id`
    )
    .all(n, n)
    .catch(() => []);
  return { c, linii, productie, produseProductie, loturi };
}

// Comanda de producție a unei linii din comanda clientului: cea cerută pentru
// linia asta din depozit; altfel una a comenzii, pe același produs.
function productiaLiniei(cc, linie) {
  const produs = Number(linie.produs_id);
  const peProdus = (cp) =>
    Number(cp.produs_id) === produs || cc.produseProductie.some((x) => Number(x.comanda_id) === Number(cp.id) && Number(x.produs_id) === produs);
  return (
    cc.productie.find((cp) => Number(cp.linie_id) === Number(linie.id)) ||
    cc.productie.find((cp) => !cp.linie_id && peProdus(cp)) ||
    null
  );
}

// Câte loturi de etichete are o comandă de client (pentru butonul de pe pagina
// comenzii, modules/comenzi.js).
async function numarLoturiComanda(id) {
  const n = parseInt(id, 10) || 0;
  if (!n) return 0;
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM etichete_loturi l
        WHERE l.comanda_id = ? OR l.comanda_productie_id IN (SELECT id FROM comenzi_productie WHERE comanda_id = ?)`
    )
    .get(n, n)
    .catch(() => null);
  return Number(r && r.n) || 0;
}

async function lotul(id) {
  const n = parseInt(id, 10) || 0;
  if (!n) return null;
  return db
    .prepare(
      `SELECT l.*, p.denumire AS produs_denumire, cp.numar AS productie_numar, co.numar AS comanda_numar
         FROM etichete_loturi l
         LEFT JOIN produse p ON p.id = l.produs_id
         LEFT JOIN comenzi_productie cp ON cp.id = l.comanda_productie_id
         LEFT JOIN comenzi co ON co.id = l.comanda_id
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
  // `format` e hârtia (sau cheia întreagă, la loturile vechi), `orientare` o întoarce.
  const fmt = E.format(b.format, b.orientare);
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

// Cât de mare e cadrul în care se vede eticheta, în pixeli: 4,2 px la milimetru
// (100 mm = 420 px, ca până acum), plus loc pentru margine.
function cadru(fmt) {
  const f = E.FORMATE[E.format(fmt)];
  return { latime: Math.round(f.latime * 4.2), inaltime: Math.round(f.inaltime * 4.2) + 10 };
}
const stilCadru = (fmt) => `width:${cadru(fmt).latime}px;height:${cadru(fmt).inaltime}px;max-width:100%`;

// Hârtia și orientarea, în formular.
function alegeFormat(fmt) {
  const radio = (nume, val, ales, text_) =>
    `<label style="display:inline-flex;gap:6px;align-items:center;margin-right:18px;font-weight:400"><input type="radio" name="${nume}" value="${val}"${ales ? " checked" : ""}> ${esc(text_)}</label>`;
  return `<div class="field"><span>Format (hârtia din imprimantă)</span>
          ${Object.entries(E.HARTII).map(([k, n]) => radio("format", k, k === E.hartia(fmt), n)).join("")}
        </div>
        <div class="field"><span>Orientare</span>
          ${Object.entries(E.ORIENTARI).map(([k, n]) => radio("orientare", k, k === E.orientarea(fmt), n)).join("")}
          <small style="display:block;color:var(--text-muted);font-size:12px;margin-top:3px">Eticheta se reașază singură: pe lat, 100 × 150 are căsuțele în dreapta; pe înalt, 100 × 50 are codul de bare culcat pe latura lungă.</small>
        </div>`;
}

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
    var ori = f.querySelector('input[name="orientare"]:checked');
    var e50 = mic && mic.value === "100x50";
    var portret = !ori || ori.value === "portret";
    f.querySelectorAll("label.et-camp").forEach(function (l) {
      var cb = l.querySelector("input");
      if (cb.hasAttribute("data-mereu")) return;
      if (l.getAttribute("data-doar150") === "1") { cb.disabled = e50; l.style.opacity = e50 ? "0.45" : "1"; }
    });
    // Cadrul ia forma etichetei: 4,2 px la milimetru.
    var lat = e50 ? (portret ? 50 : 100) : (portret ? 100 : 150);
    var inalt = e50 ? (portret ? 100 : 50) : (portret ? 150 : 100);
    fr.style.width = Math.round(lat * 4.2) + "px";
    fr.style.height = (Math.round(inalt * 4.2) + 10) + "px";
  }
  // Altă hârtie: orientarea trece pe cea obișnuită a ei (100 × 150 pe înalt,
  // 100 × 50 pe lat). De acolo omul o întoarce, dacă vrea.
  f.querySelectorAll('input[name="format"]').forEach(function (r) {
    r.addEventListener("change", function () {
      var vrut = r.value === "100x50" ? "peisaj" : "portret";
      var o = f.querySelector('input[name="orientare"][value="' + vrut + '"]');
      if (o) o.checked = true;
    });
  });
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
    const unde = cauta
      ? "WHERE UPPER(l.lot) LIKE ? OR UPPER(COALESCE(p.denumire, '')) LIKE ? OR UPPER(COALESCE(p.cod, '')) LIKE ? OR UPPER(COALESCE(cp.numar, '')) LIKE ? OR UPPER(COALESCE(co.numar, '')) LIKE ?"
      : "";
    const tipar = "%" + cauta.toUpperCase() + "%";
    const loturi = await db
      .prepare(
        `SELECT l.id, l.lot, l.format, l.tiparite, l.creat_la, l.creat_de, l.comanda_productie_id, l.comanda_id,
                p.denumire AS produs_denumire, COALESCE(NULLIF(TRIM(p.cod), ''), p.cod_generat) AS produs_cod, cp.numar AS productie_numar,
                co.numar AS comanda_numar,
                (SELECT t.tiparit_la FROM etichete_tiparite t WHERE t.lot_id = l.id ORDER BY t.id DESC LIMIT 1) AS ultima_la,
                (SELECT t.tiparit_de FROM etichete_tiparite t WHERE t.lot_id = l.id ORDER BY t.id DESC LIMIT 1) AS ultima_de,
                (SELECT COUNT(*) FROM etichete_tiparite t WHERE t.lot_id = l.id) AS tipariri
           FROM etichete_loturi l
           LEFT JOIN produse p ON p.id = l.produs_id
           LEFT JOIN comenzi_productie cp ON cp.id = l.comanda_productie_id
           LEFT JOIN comenzi co ON co.id = l.comanda_id
          ${unde}
          ORDER BY l.id DESC LIMIT 200`
      )
      .all(...(cauta ? [tipar, tipar, tipar, tipar, tipar] : []))
      .catch(() => []);
    // Comenzile clienților din ultimele patru luni, pentru „din comanda
    // clientului”. Cele anulate nu mai primesc etichete.
    const comenziClienti = await db
      .prepare(
        `SELECT co.id, co.numar, COALESCE(p.nume, '') AS client,
                (SELECT COUNT(*) FROM comenzi_linii cl WHERE cl.comanda_id = co.id) AS linii
           FROM comenzi co LEFT JOIN parteneri p ON p.id = co.partener_id
          WHERE COALESCE(co.status, '') <> 'anulata' AND COALESCE(co.data, '') >= ?
          ORDER BY co.id DESC LIMIT 300`
      )
      .all(new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10))
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
      [
        l.comanda_id ? `<a href="${CALE}/comanda/${Number(l.comanda_id)}">${esc(l.comanda_numar || "#" + l.comanda_id)}</a>` : "",
        l.productie_numar ? `<span class="mic">producție ${linkProductie(ctx.user, l.comanda_productie_id, l.productie_numar)}</span>` : "",
      ]
        .filter(Boolean)
        .join("<br>") || '<span style="color:var(--text-muted)">—</span>',
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
        <label class="field"><span>Din comanda clientului (alegi apoi linia: produsul, clientul și numărul comenzii vin completate)</span>
          <select name="comanda_client"><option value="">— fără comandă de client —</option>${comenziClienti
            .map((c) => `<option value="${c.id}">${esc(c.numar || "#" + c.id)} · ${esc(c.client)} · ${Number(c.linii) || 0} ${Number(c.linii) === 1 ? "linie" : "linii"}</option>`)
            .join("")}</select></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="field"><span>…sau din comanda de producție (completează produsul, clientul și lotul)</span>
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
      ${loturi.length ? `<div class="tabel-scroll">${table(["Lot", "Produs", "Comanda", "Format", "Etichete", "Ultima tipărire", ""], randuri)}</div>` : '<p style="color:var(--text-muted)">Niciun lot încă.</p>'}`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Etichete produs", active: CALE, body }));
  });

  // ---- Configurarea etichetei noi --------------------------------------------
  router.get(`${CALE}/noua`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const q = ctx.query || {};
    const cp = await comandaProductie(q.productie);
    // Comanda clientului: din pagina ei (o linie aleasă) sau din lista de aici.
    const cc = text(q.comanda_client) ? await comandaClient(q.comanda_client) : null;
    if (text(q.comanda_client) && !cc) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Comanda clientului nu există.")}`);
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
    const linieClient = cc ? cc.linii.find((l) => Number(l.id) === (parseInt(q.linie, 10) || 0)) || (cc.linii.length === 1 ? cc.linii[0] : null) : null;
    if (!produsId && !cp && linieClient) produsId = Number(linieClient.produs_id);
    // Comanda are mai multe linii și nu s-a ales niciuna: pagina comenzii, cu liniile ei.
    if (!produsId && !cp && cc) return redirect(ctx.res, `${CALE}/comanda/${cc.c.id}`);
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
    const fmt = E.format(q.format, q.orientare);
    const linie = cp ? cp.produse.find((x) => x.produs_id === Number(p.id)) : null;
    // Ce vine propus: din comanda de producție, altfel din fișa produsului. Ce
    // a scris omul (întors după o eroare) are întâietate.
    const caracComanda = cp ? caracteristiciComanda(cp, linie && linie.linie_id) : [];
    // Comanda clientului pe care o ține minte lotul: a comenzii de producție,
    // dacă are una; altfel cea aleasă.
    const comandaId = (cp && Number(cp.c.comanda_id)) || (cc && Number(cc.c.id)) || null;
    const propus = {
      denumire: p.denumire,
      caracteristici: (caracComanda.length ? caracComanda : await caracteristiciProdus(p.id)).join("\n"),
      lot: cp ? FL.codLot(cp.c) : "",
      data_productiei: azi(),
      client: cp ? text(cp.c.partener_nume) || text(cp.c.client_text) : cc ? text(cc.c.client) : "",
      comanda: cp ? text(cp.c.comanda_client_numar) || text(cp.c.numar) : cc ? text(cc.c.numar) || "#" + cc.c.id : "",
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
      <div class="toolbar">${
        comandaId
          ? `<a class="btn secondary" href="${CALE}/comanda/${comandaId}">← Etichetele comenzii</a>`
          : `<a class="btn secondary" href="${CALE}">← Etichete produs</a>`
      }</div>
      <h1 style="margin:6px 0 2px">Etichete: ${esc(p.denumire)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted)">Cod ${esc(codProdus(p) || "—")} · pe codul de bare: <strong>${esc(SCAN.codProdus(codProdus(p), p.id))}</strong>${
        cc ? ` · pentru comanda clientului <a href="/comenzi/${cc.c.id}">${esc(cc.c.numar || "#" + cc.c.id)}</a>` : ""
      }${cp ? ` · din comanda de producție ${linkProductie(ctx.user, cp.c.id, cp.c.numar || "#" + cp.c.id)}` : ""}</p>
      <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
      <form id="et-form" class="form" method="post" action="${CALE}" style="flex:1 1 520px;max-width:720px;margin:0">
        <input type="hidden" name="produs_id" value="${p.id}">
        <input type="hidden" name="comanda_productie_id" value="${cp ? cp.c.id : ""}">
        <input type="hidden" name="comanda_id" value="${comandaId || ""}">
        ${alegeFormat(fmt)}
        <div class="field"><span>Ce apare pe etichetă</span><div>${campuriHtml("100x150", alese)}</div>
          <small style="display:block;color:var(--text-muted);font-size:12px">Un câmp bifat și lăsat gol iese cu numele lui și cu loc de scris de mână — de exemplu greutatea, aflată abia la cântar. Nebifat, căsuța lui rămâne albă.</small></div>
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
        <label class="field"><span>Caracteristici — câte una pe rând (pe 100×150 încap 6; pe 100×50, primul rând pe lat și primele două pe înalt)</span>
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
        <iframe id="et-mostra" title="Previzualizarea etichetei" style="${stilCadru(fmt)};border:1px solid var(--border,#ddd);background:#eceff3"></iframe>
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
      for (const k of ["produs_id", "format", "orientare", "lot", "data_productiei", "cantitate", "greutate_neta", "greutate_bruta", "client", "comanda", "valabilitate", "operator", "observatii", "denumire", "caracteristici", "cate"]) {
        if (text(b[k])) qs.set(k, text(b[k]).slice(0, 1000));
      }
      if (text(b.comanda_productie_id)) qs.set("productie", text(b.comanda_productie_id));
      if (text(b.comanda_id)) qs.set("comanda_client", text(b.comanda_id));
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
    // Comanda clientului a lotului: cea a comenzii de producție, dacă are una;
    // altfel cea trimisă din formular, doar dacă există.
    let comandaId = (cp && Number(cp.c.comanda_id)) || 0;
    if (!comandaId && Number(b.comanda_id) > 0) {
      const co = await db.prepare("SELECT id FROM comenzi WHERE id = ?").get(parseInt(b.comanda_id, 10) || 0).catch(() => null);
      comandaId = co ? Number(co.id) : 0;
    }
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
              `INSERT INTO etichete_loturi (lot, produs_id, comanda_productie_id, comanda_id, format, campuri, continut, tiparite, creat_de_id, creat_de, creat_la)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
            )
            .run(l.lot, p.id, cp ? cp.c.id : null, comandaId || null, d.fmt, JSON.stringify(d.campuri), JSON.stringify(d.continut), n.pana_la, u.id || null, u.nume || "", acum())
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
        <p style="font-size:13px;color:var(--text-muted);margin-top:0">Un câmp bifat și lăsat gol la etichetă iese cu numele lui și cu loc de scris de mână (greutatea netă și brută, de exemplu).</p>
        ${Object.entries(E.HARTII)
          .map(
            ([fmt, numeHartie]) => `<div class="field"><span>${esc(numeHartie)} (pe înalt și pe lat)</span><div>${E.CAMPURI.filter((c) => E.CAMPURI_FORMAT[fmt].includes(c.cheie))
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
        ${Object.entries(E.FORMATE)
          .map(
            ([fmt, f]) => `<div><div style="font-size:12px;color:var(--text-muted);margin-bottom:3px">${esc(f.nume)}</div>
          <iframe title="Exemplu ${esc(f.nume)}" style="${stilCadru(fmt)};border:1px solid var(--border,#ddd)" srcdoc="${esc(E.pagina([exemplu(fmt)], fmt, { sigla: s.sigla }))}"></iframe></div>`
          )
          .join("")}
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
    for (const fmt of Object.keys(E.HARTII)) {
      await scrieSetare("etichete_campuri_" + fmt, JSON.stringify(E.campuriAlese(fmt, lista(b[`implicite_${fmt}[]`]))));
    }
    if (sigla) await scrieSetare("etichete_sigla", sigla);
    else if (text(b.fara_sigla) === "1") await scrieSetare("etichete_sigla", "");
    console.log(`[etichete] ${(ctx.user && ctx.user.nume) || "?"} a schimbat setările etichetelor${sigla ? " (siglă nouă)" : ""}`);
    inapoi("ok", "Salvat. Etichetele de acum încolo au datele astea — și cele tipărite din nou dintr-un lot vechi.");
  });

  // ---- Etichetele unei comenzi de client ---------------------------------------
  // Liniile comenzii, fiecare cu loturile de etichete de până acum și „Etichete →".
  // Linia cu comandă de producție merge pe ea (lotul fișei de lot); celelalte
  // primesc clientul, numărul comenzii și un lot propus.
  router.get(`${CALE}/comanda/:id`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const cc = await comandaClient(ctx.params.id);
    if (!cc) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Comanda clientului nu există.")}`);
    const nr = text(cc.c.numar) || "#" + cc.c.id;
    const randuri = cc.linii.map((l) => {
      const cp = productiaLiniei(cc, l);
      const loturi = cc.loturi.filter((x) => Number(x.produs_id) === Number(l.produs_id));
      const qs = new URLSearchParams({ comanda_client: String(cc.c.id), linie: String(l.id), produs_id: String(l.produs_id) });
      if (cp) qs.set("productie", String(cp.id));
      return [
        `<strong>${esc(l.denumire || "#" + l.produs_id)}</strong>${l.cod ? `<div class="mic" style="color:var(--text-muted)">${esc(l.cod)}</div>` : ""}`,
        esc(`${nrRo(l.cantitate)} ${text(l.um) || text(l.unitate_masura)}`.trim()),
        cp
          ? `${linkProductie(ctx.user, cp.id, cp.numar || "#" + cp.id)}<div class="mic" style="color:var(--text-muted)">lot ${esc(FL.codLot(cp))}</div>`
          : '<span style="color:var(--text-muted)">—</span>',
        loturi.length
          ? loturi
              .map((x) => `<a href="${CALE}/${x.id}"><strong>${esc(x.lot)}</strong></a> <span class="mic" style="color:var(--text-muted)">${Number(x.tiparite) || 0} etichete</span>`)
              .join("<br>")
          : '<span style="color:var(--text-muted)">încă niciunul</span>',
        `<a class="btn small${loturi.length ? " secondary" : ""}" href="${CALE}/noua?${esc(qs.toString())}">${loturi.length ? "Alt lot…" : "Etichete →"}</a>`,
      ];
    });
    const body = `
      <div class="toolbar"><a class="btn secondary" href="${CALE}">← Etichete produs</a> <a class="btn secondary" href="/comenzi/${cc.c.id}">Comanda ${esc(nr)}</a></div>
      <h1 style="margin:6px 0 2px">Etichete pentru comanda ${esc(nr)}</h1>
      <p style="margin:0 0 12px;color:var(--text-muted);max-width:900px">
        ${esc(cc.c.client || "")}. Alegi linia: formularul vine cu produsul, clientul, numărul comenzii și caracteristicile.
        Linia care are comandă de producție ia lotul fișei ei de lot; celelalte primesc un lot nou, propus. Pentru încă un
        palet din același lot, deschizi lotul și tipărești suplimentar.
      </p>
      ${
        randuri.length
          ? `<div class="tabel-scroll">${table(["Produs", "Cantitate", "Comanda de producție", "Loturi de etichete", ""], randuri)}</div>`
          : '<p style="color:var(--text-muted)">Comanda n-are linii.</p>'
      }`;
    send(ctx.res, 200, layout({ user: ctx.user, title: `Etichete · comanda ${nr}`, active: CALE, body }));
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
        ${esc(l.produs_denumire || c.denumire || "")}${
          l.comanda_id ? ` · comanda clientului <a href="${CALE}/comanda/${Number(l.comanda_id)}">${esc(l.comanda_numar || "#" + l.comanda_id)}</a>` : ""
        }${l.productie_numar ? ` · comanda de producție ${linkProductie(ctx.user, l.comanda_productie_id, l.productie_numar)}` : ""}
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
          <iframe title="Eticheta lotului" style="${stilCadru(l.format)};border:1px solid var(--border,#ddd);background:#eceff3" src="${CALE}/${l.id}/mostra"></iframe>
          <form method="post" action="${CALE}/${l.id}/orientare" style="margin-top:8px;font-size:13px">
            <span style="color:var(--text-muted)">Orientare:</span>
            ${Object.entries(E.ORIENTARI)
              .map(([k, n]) => `<label style="display:inline-flex;gap:5px;align-items:center;margin:0 10px 0 6px;font-weight:400"><input type="radio" name="orientare" value="${k}"${k === E.orientarea(l.format) ? " checked" : ""}> ${esc(n)}</label>`)
              .join("")}
            <button class="btn small secondary" type="submit">Întoarce eticheta</button>
            <div style="font-size:12px;color:var(--text-muted);margin-top:3px">Aceeași hârtie, ${esc(E.HARTII[E.hartia(l.format)])}. De aici încolo lotul se tipărește așa, și „din nou”.</div>
          </form>
        </div>
      </div>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "Lot " + l.lot, active: CALE, body }));
  });

  // Întoarce eticheta unui lot: aceeași hârtie, altă orientare (Vali,
  // 17.11.2026). Câmpurile și conținutul rămân; se schimbă doar grafica.
  router.post(`${CALE}/:id/orientare`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/");
    const l = await lotul(ctx.params.id);
    if (!l) return redirect(ctx.res, `${CALE}?eroare=${encodeURIComponent("Lotul nu există.")}`);
    const nou = E.format(l.format, text((ctx.body || {}).orientare));
    if (nou !== E.format(l.format)) {
      await db.prepare("UPDATE etichete_loturi SET format = ? WHERE id = ?").run(nou, l.id);
      console.log(`[etichete] ${(ctx.user && ctx.user.nume) || "?"} a întors lotul ${l.lot}: ${E.FORMATE[nou].nume}`);
    }
    redirect(ctx.res, `${CALE}/${l.id}`);
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

module.exports = { register, lotPentruProductie, setari, siglaTip, numarLoturiComanda };
