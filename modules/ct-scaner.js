"use strict";
// Scanerul din CT-Park: paginile pentru terminalul din mână (și pentru orice
// telefon), coada „De tipărit" pentru calculatorul de lângă imprimantă,
// etichetele locurilor de pe rafturi și foaia comenzii clientului.
//
// Regulile și datele sunt în lib/ct-scaner.js (acolo e și ce a cerut Vali, pe
// 10.11.2026). Aici e ce vede omul:
//
//   /stocuri/ct-park/scaner            două butoane mari: INTRARE și IEȘIRE
//   …/scaner/intrare                   de unde vine marfa (producție, furnizor,
//                                      retururi), câmpul de scanat, paleții
//                                      care așteaptă raftul și marfa încă
//                                      nepusă pe paleți
//   …/scaner/intrare/palet/:id         paletul scanat: locul propus, locul
//                                      scanat sau ales, EFECTUEAZĂ
//   …/scaner/intrare/rand/:cheie       marfa fără palet: cantitatea, locul,
//                                      EFECTUEAZĂ — sau doar paleți cu etichete
//   …/scaner/iesire                    scanezi paletul, locul sau produsul
//   …/scaner/iesire/palet/:id          unde pleacă, pe ce comandă, cât,
//                                      EFECTUEAZĂ; apoi avizul și comanda
//                                      clientului merg la tipărit
//   /stocuri/ct-park/tipar             ce are de tipărit depozitul; cu bifa
//                                      pusă, calculatorul le scoate singur
//   /stocuri/ct-park/locuri/etichete   etichetele cu cod de bare ale locurilor
//   /stocuri/ct-park/comanda/:id/foaie comanda clientului, de tipărit (fără
//                                      prețuri, ca avizul)
//   /depozit/receptie/:id/paleti       paleții și etichetele unei recepții
//
// Paginile scanerului nu trec prin layout-ul ERP-ului: pe un ecran de 6",
// meniul de sus ar mânca jumătate din el. Au un cap îngust, butoane mari și
// un singur câmp, mereu pregătit pentru cititor.

const db = require("../lib/db");
const { esc, layout, table, dateleInText } = require("../lib/render");
const { send, redirect } = require("../lib/router");
const { poateAccesa } = require("../lib/auth");
const SC = require("../lib/ct-scaner");
const GP = require("../lib/gata-productie");
const SCAN = require("../lib/scan");
const CPL = require("../lib/ct-palet-linii");
const codbare = require("../lib/codbare");

// „CALE": numele pe care îl caută testele care citesc rutele din sursă.
const CALE = "/stocuri/ct-park/scaner";
const TIPAR = "/stocuri/ct-park/tipar";
const nr = (v) => Number(v) || 0;
const rotunjit = (v) => Math.round(nr(v) * 1000) / 1000;
const poate = (u) => Boolean(u) && poateAccesa(u, "/stocuri/ct-park/intrare");
const cant = (v, um) => `${nr(v).toLocaleString("ro-RO", { maximumFractionDigits: 3 })}${um ? " " + um : ""}`;
const ids = (v) => [...new Set(String(v == null ? "" : v).split(",").map((x) => parseInt(x, 10)).filter((x) => x > 0))];
// Adresa cu parametrii ei, fără cei goi.
function q(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
}
const SURSA_TEXT = {
  productie: "din producție",
  furnizor: "de la furnizor",
  inventar_initial: "stoc inițial",
  retur_tert: "retur de la client",
  retur_fulfilment: "retur din fulfillment",
  alta: "pus de mână",
};
const sursaText = (s) => SURSA_TEXT[s] || String(s || "");
const eSursa = (v) => (SC.SURSE.some(([k]) => k === v) ? String(v) : "toate");

// ---- Pagina de terminal ---------------------------------------------------------
const STIL = `
  body.sc { margin:0; background:#f1f4f7; color:#14181d; }
  .sc-sus { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:8px; padding:8px 10px; background:#1f3a5f; color:#fff; }
  .sc-sus a { color:#fff; text-decoration:none; font-size:15px; padding:8px 10px; border:1px solid rgba(255,255,255,.4); border-radius:8px; white-space:nowrap; }
  .sc-sus strong { flex:1; font-size:17px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sc-corp { max-width:640px; margin:0 auto; padding:10px 12px 48px; }
  .sc-mare { display:block; box-sizing:border-box; width:100%; padding:30px 16px; margin:14px 0; border-radius:16px; font-size:28px; font-weight:800; text-align:center; text-decoration:none; color:#fff; }
  .sc-mare small { display:block; font-size:14px; font-weight:500; margin-top:6px; opacity:.92; }
  .sc-intrare { background:#1f7a4a; } .sc-iesire { background:#b45309; }
  .sc-camp { display:flex; gap:8px; margin:10px 0 4px; }
  .sc-camp input { flex:1; min-width:0; box-sizing:border-box; font-size:22px; padding:12px; border:2px solid #1f3a5f; border-radius:10px; font-family:ui-monospace,Menlo,Consolas,monospace; background:#fff; }
  .sc-camp input::placeholder { font-size:15px; font-family:system-ui,sans-serif; }
  .sc-btn { display:inline-block; box-sizing:border-box; padding:12px 14px; border-radius:10px; border:1px solid #c5cbd3; background:#fff; color:#14181d; font-size:16px; font-weight:600; text-decoration:none; cursor:pointer; }
  .sc-unelte { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 8px; }
  .sc-unelte .sc-btn { font-size:13px; padding:8px 10px; font-weight:500; }
  .sc-ok { display:block; box-sizing:border-box; width:100%; padding:20px 12px; margin-top:14px; border:0; border-radius:14px; background:#1f7a4a; color:#fff; font-size:22px; font-weight:800; cursor:pointer; }
  .sc-ok.iesire { background:#b45309; }
  .sc-ok[disabled] { background:#9aa4af; cursor:not-allowed; }
  .sc-card { background:#fff; border:1px solid #dfe3e8; border-radius:12px; padding:12px 14px; margin:10px 0; }
  .sc-card h2 { margin:0 0 4px; font-size:22px; letter-spacing:.02em; }
  .sc-rand { display:block; background:#fff; border:1px solid #dfe3e8; border-radius:12px; padding:12px 14px; margin:8px 0; color:#14181d; text-decoration:none; }
  .sc-rand strong { font-size:17px; }
  .sc-mic { font-size:13px; color:#5b6570; line-height:1.45; }
  .sc-chip { display:inline-block; padding:9px 13px; margin:4px 6px 4px 0; border-radius:999px; border:1px solid #c5cbd3; background:#fff; color:#14181d; text-decoration:none; font-size:15px; }
  .sc-chip.activ { background:#1f3a5f; color:#fff; border-color:#1f3a5f; }
  .sc-loc { display:inline-flex; align-items:center; gap:10px; padding:10px 12px; margin:4px 6px 4px 0; border-radius:10px; background:#e7f4ec; border:1px solid #9bd3ad; font-size:20px; font-weight:800; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .sc-loc a { color:#b3261e; text-decoration:none; font-size:24px; line-height:1; padding:0 4px; }
  .sc-propus { display:block; box-sizing:border-box; width:100%; text-align:left; padding:12px 14px; margin:6px 0; border-radius:12px; border:2px dashed #1f7a4a; background:#f3faf5; color:#14181d; text-decoration:none; }
  .sc-propus b { font-size:20px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .sc-flash { padding:12px 14px; border-radius:10px; margin:10px 0; font-size:16px; font-weight:600; line-height:1.4; }
  .sc-flash.ok { background:#e7f4ec; border:1px solid #9bd3ad; color:#14532d; }
  .sc-flash.rau { background:#f8e5e3; border:1px solid #efc9c4; color:#8c1d18; }
  .sc-t { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:#5b6570; margin:18px 0 4px; font-weight:700; }
  .sc-dest { display:block; background:#fff; border:2px solid #dfe3e8; border-radius:12px; padding:12px 14px; margin:6px 0; font-size:18px; font-weight:700; }
  .sc-dest input { width:20px; height:20px; margin-right:10px; vertical-align:-3px; }
  .sc-dest:has(input:checked) { border-color:#b45309; background:#fff7ed; }
  .sc-f { display:block; margin:12px 0 4px; font-size:14px; color:#5b6570; }
  .sc-f input, .sc-f select { display:block; box-sizing:border-box; width:100%; margin-top:4px; font-size:18px; padding:11px; border:1px solid #c5cbd3; border-radius:10px; background:#fff; min-height:48px; }
  #sc-video-cutie { margin:8px 0; } #sc-video { width:100%; border-radius:10px; background:#000; }
  [hidden] { display:none !important; }
`;

// Câmpul de scanat: cititorul „tastează" codul și dă Enter, deci formularul
// pleacă singur. Tastatura de pe ecran se poate ascunde (alegerea rămâne pe
// terminalul ăla); unde browserul știe să citească coduri cu camera, apare
// și butonul ei — un telefon obișnuit face atunci treaba cititorului.
const SCRIPT = `
(function () {
  var camp = document.getElementById("sc-cod");
  var form = document.getElementById("sc-form");
  if (!camp || !form) return;
  var CHEIE = "ct-scaner-fara-tastatura", fara = false;
  try { fara = localStorage.getItem(CHEIE) === "1"; } catch (e) {}
  var bt = document.getElementById("sc-tast");
  function aplica() {
    camp.setAttribute("inputmode", fara ? "none" : "text");
    if (bt) bt.textContent = fara ? "Arată tastatura" : "Ascunde tastatura";
  }
  aplica();
  if (bt) bt.addEventListener("click", function () {
    fara = !fara;
    try { localStorage.setItem(CHEIE, fara ? "1" : "0"); } catch (e) {}
    aplica(); camp.blur(); camp.focus();
  });
  camp.focus();
  // Cititorul scrie în câmpul de scanat oriunde ar fi rămas focusul, cât timp
  // omul nu scrie în alt câmp.
  document.addEventListener("keydown", function (ev) {
    var t = ev.target, n = String((t && t.tagName) || "").toUpperCase();
    if (t === camp || n === "INPUT" || n === "TEXTAREA" || n === "SELECT" || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.key && ev.key.length === 1) camp.focus();
  }, true);
  // Ce a scris omul în formularul de jos merge mai departe și la scanare.
  var duse = document.querySelectorAll("[data-tine]");
  form.addEventListener("submit", function () {
    for (var i = 0; i < duse.length; i++) {
      var h = form.querySelector('input[type="hidden"][name="' + duse[i].getAttribute("data-tine") + '"]');
      if (h) h.value = duse[i].value;
    }
  });
  // …și la apăsarea unui loc propus sau a unui „×": linkul pleacă cu ea.
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!a || !duse.length || a.origin !== location.origin || a.pathname !== location.pathname) return;
    try {
      var u = new URL(a.href);
      for (var i = 0; i < duse.length; i++) u.searchParams.set(duse[i].getAttribute("data-tine"), duse[i].value);
      ev.preventDefault();
      location.href = u.toString();
    } catch (e) {}
  });
  var cam = document.getElementById("sc-camera");
  if (!cam || !("BarcodeDetector" in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  if (typeof BarcodeDetector.getSupportedFormats === "function") {
    BarcodeDetector.getSupportedFormats().then(function (f) { if (f && f.indexOf("code_128") !== -1) cam.hidden = false; }).catch(function () {});
  } else cam.hidden = false;
  var cutie = document.getElementById("sc-video-cutie"), video = document.getElementById("sc-video"), flux = null, pornit = false;
  function opreste() { pornit = false; if (flux) flux.getTracks().forEach(function (t) { t.stop(); }); flux = null; cutie.hidden = true; }
  cam.addEventListener("click", function () {
    if (pornit) return opreste();
    var det;
    try { det = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "qr_code", "data_matrix"] }); } catch (e) { det = new BarcodeDetector(); }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (s) { flux = s; video.srcObject = s; cutie.hidden = false; pornit = true; return video.play(); })
      .then(function () {
        (function pas() {
          if (!pornit) return;
          det.detect(video).then(function (coduri) {
            var cod = (coduri || []).map(function (x) { return x && x.rawValue; }).filter(Boolean)[0];
            if (cod) { opreste(); camp.value = cod; if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
            else setTimeout(pas, 150);
          }).catch(function () { setTimeout(pas, 400); });
        })();
      })
      .catch(function (e) { opreste(); alert("Camera nu pornește: " + ((e && e.message) || "fără acces la cameră")); });
  });
})();
`;

function pagina(ctx, { titlu, inapoi, corp }) {
  const qy = ctx.query || {};
  const flash =
    (qy.ok ? `<div class="sc-flash ok" role="status">${esc(String(qy.ok))}</div>` : "") +
    (qy.eroare ? `<div class="sc-flash rau" role="alert">${esc(String(qy.eroare))}</div>` : "");
  const html = `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(titlu)} · Scaner CT-Park</title>
<link rel="stylesheet" href="/style.css">
<style>${STIL}</style>
</head>
<body class="sc">
<header class="sc-sus">
  <a href="${esc(inapoi ? inapoi.href : CALE)}">‹ ${esc(inapoi ? inapoi.text : "Scaner")}</a>
  <strong>${esc(titlu)}</strong>
  <a href="/stocuri/ct-park" title="Înapoi în ERP, la harta depozitului">ERP</a>
</header>
<main class="sc-corp">
${flash}
${corp}
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
  send(ctx.res, 200, dateleInText(html));
}

// Câmpul de scanat, cu ce trebuie ținut minte între scanări în câmpuri ascunse.
function campScan(actiune, ascunse, eticheta) {
  return `
    <form id="sc-form" method="get" action="${esc(actiune)}" autocomplete="off">
      ${Object.entries(ascunse || {})
        .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v == null ? "" : v))}">`)
        .join("")}
      <div class="sc-camp">
        <input id="sc-cod" name="cod" autofocus autocapitalize="characters" spellcheck="false" enterkeyhint="go" aria-label="${esc(eticheta)}" placeholder="${esc(eticheta)}">
        <button class="sc-btn" type="submit">OK</button>
      </div>
    </form>
    <div class="sc-unelte">
      <button class="sc-btn" type="button" id="sc-camera" hidden>Scanează cu camera</button>
      <button class="sc-btn" type="button" id="sc-tast">Ascunde tastatura</button>
    </div>
    <div id="sc-video-cutie" hidden><video id="sc-video" playsinline muted></video></div>`;
}

// Locurile alese (scanate sau din propuneri), fiecare cu „×" lui.
function locuriAlese(alese, adresaFara) {
  if (!alese.length) return "";
  return `<div>${alese.map((l) => `<span class="sc-loc">${esc(l.adresa)} <a href="${esc(adresaFara(Number(l.id)))}" aria-label="Scoate ${esc(l.adresa)}">×</a></span>`).join("")}</div>`;
}

// Un loc scanat, verificat pe loc: omul află acum, nu la „Efectuează", că
// locul nu există, e scos din uz sau are deja marfă.
async function locScanat(cod, paletId) {
  const l = await SC.locDupaAdresa(cod);
  if (!l) return { eroare: `Locul ${SC.curat(cod)} nu există pe hartă.` };
  if (!nr(l.rand_activ) || nr(l.blocat)) return { eroare: `Locul ${l.adresa} e scos din uz.` };
  if (l.ocupat_de && Number(l.ocupat_de) !== Number(paletId || 0)) return { eroare: `Pe ${l.adresa} stă deja alt palet. Alege alt loc.` };
  return { loc: l };
}

async function coduriPaleti(lista) {
  const curate = (lista || []).map((x) => Math.round(nr(x))).filter((x) => x > 0);
  if (!curate.length) return [];
  const r = await db
    .prepare(`SELECT id, cod FROM ct_paleti WHERE id IN (${curate.map(() => "?").join(",")}) ORDER BY id`)
    .all(...curate)
    .catch(() => []);
  return r.map((x) => x.cod);
}

// Ce se propune ca loc pentru o marfă: caracteristicile ei, din nomenclator.
async function tintaPropunere(produsId, categorie) {
  const p = nr(produsId)
    ? await db.prepare("SELECT id, categorie, cod_familie_id FROM produse WHERE id = ?").get(nr(produsId)).catch(() => null)
    : null;
  return { produs_id: nr(produsId) || null, cod_familie_id: p ? p.cod_familie_id : null, produs_categorie: p ? p.categorie : null, categorie: categorie || null };
}

function blocPropuneri(propuneri, adresaCu, aleseIds) {
  if (!propuneri.length) return `<p class="sc-mic">Nu mai e niciun loc liber potrivit. Scanează tu un loc.</p>`;
  const [prima, ...rest] = propuneri;
  const e = (pr) => pr.ids.join(",") === aleseIds.join(",");
  return `
    <a class="sc-propus" href="${esc(adresaCu(prima.ids))}">
      <span class="sc-mic">Loc propus${e(prima) ? " — ales" : ""}</span><br><b>${esc(prima.adresa)}</b><br><span class="sc-mic">${esc(prima.motiv)} · apasă ca să-l alegi</span>
    </a>
    ${rest.length ? `<div class="sc-mic" style="margin-top:6px">Alte locuri libere potrivite:</div><div>${rest.map((pr) => `<a class="sc-chip${e(pr) ? " activ" : ""}" href="${esc(adresaCu(pr.ids))}" title="${esc(pr.motiv)}">${esc(pr.adresa)}</a>`).join("")}</div>` : ""}`;
}

function register(router) {
  // ---- Acasă: două butoane -----------------------------------------------------
  router.get(CALE, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const faraLoc = await SC.faraLoc("toate");
    const deAsezat = await SC.deAsezat("toate");
    const pregatite = await GP.pregatite().catch(() => []);
    const deTiparit = await SC.deTiparit(null, 36);
    const corp = `
      <a class="sc-mare sc-intrare" href="${CALE}/intrare">INTRARE MARFĂ
        <small>${faraLoc.length ? `${faraLoc.length} ${faraLoc.length === 1 ? "palet așteaptă" : "paleți așteaptă"} raftul` : "niciun palet nu așteaptă raftul"}${deAsezat.length ? ` · ${deAsezat.length} ${deAsezat.length === 1 ? "rând" : "rânduri"} fără paleți` : ""}</small></a>
      <a class="sc-mare sc-iesire" href="${CALE}/iesire">IEȘIRE MARFĂ
        <small>${pregatite.length ? `${pregatite.length} ${pregatite.length === 1 ? "palet pregătit" : "paleți pregătiți"} pentru ieșire` : "scanezi paletul sau locul"}</small></a>
      <div class="sc-card sc-mic">
        <strong>Intrare:</strong> scanezi eticheta paletului, scanezi locul de pe raft, apeși Efectuează.<br>
        <strong>Ieșire:</strong> scanezi paletul sau locul, alegi unde pleacă și cât, apeși Efectuează.
      </div>
      <p>
        <a class="sc-btn" href="${TIPAR}">De tipărit${deTiparit.length ? ` (${deTiparit.length})` : ""}</a>
        <a class="sc-btn" href="/stocuri/ct-park/locuri/etichete">Etichete pentru rafturi</a>
      </p>`;
    pagina(ctx, { titlu: "Scaner CT-Park", inapoi: { href: "/stocuri/ct-park", text: "Depozit" }, corp });
  });

  // Un loc scanat din afara scanerului (de oriunde din ERP): cu marfă pe el,
  // duce la paletul lui; liber, îl ține ales pentru următoarea intrare.
  router.get(`${CALE}/loc`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const l = await SC.locDupaAdresa((ctx.query || {}).cod);
    if (!l) return redirect(ctx.res, `${CALE}${q({ eroare: `Locul ${SC.curat((ctx.query || {}).cod)} nu există pe hartă.` })}`);
    if (l.ocupat_de) return redirect(ctx.res, `${CALE}/iesire/palet/${l.ocupat_de}`);
    return redirect(ctx.res, `${CALE}/intrare${q({ cod: l.adresa })}`);
  });

  // ---- Intrare: ce e de pus pe raft ----------------------------------------------
  router.get(`${CALE}/intrare`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const sursa = eSursa(qy.sursa);
    let loc = ids(qy.loc);
    const tine = () => ({ sursa: sursa === "toate" ? "" : sursa, loc: loc.join(",") });
    const aici = (extra) => `${CALE}/intrare${q(Object.assign(tine(), extra))}`;
    const cod = SC.curat(qy.cod);
    let gasite = null;
    if (cod) {
      if (SC.ePalet(cod)) {
        const p = await SC.paletDupaCod(cod);
        if (!p) return redirect(ctx.res, aici({ eroare: `Paletul ${cod} nu există în CT-Park.` }));
        if (p.data_iesire) return redirect(ctx.res, aici({ eroare: `Paletul ${cod} a ieșit din depozit pe ${String(p.data_iesire).slice(0, 10)}.` }));
        return redirect(ctx.res, `${CALE}/intrare/palet/${p.id}${q(tine())}`);
      }
      if (SC.eLoc(cod)) {
        const x = await locScanat(cod, 0);
        if (x.eroare) return redirect(ctx.res, aici({ eroare: x.eroare }));
        loc = [...new Set(loc.concat(Number(x.loc.id)))].slice(-3);
        return redirect(ctx.res, aici({ ok: `Loc ales: ${x.loc.adresa}. Acum scanează paletul sau marfa.` }));
      }
      const { forme } = SCAN.interpreteaza(cod);
      const randuri = (await SC.deAsezat("toate")).filter((r) => SC.potrivesteRand(r, cod, forme));
      const paleti = (await SC.faraLoc("toate")).filter((p) => SC.potrivestePalet(p, cod, forme));
      if (!randuri.length && !paleti.length) return redirect(ctx.res, aici({ eroare: `Nu e nimic de pus pe raft cu codul ${cod}.` }));
      if (paleti.length === 1 && !randuri.length) return redirect(ctx.res, `${CALE}/intrare/palet/${paleti[0].id}${q(tine())}`);
      if (randuri.length === 1 && !paleti.length) return redirect(ctx.res, `${CALE}/intrare/rand/${randuri[0].cheie}${q(tine())}`);
      gasite = { randuri, paleti };
    }

    const paleti = gasite ? gasite.paleti : await SC.faraLoc(sursa);
    const randuri = gasite ? gasite.randuri : await SC.deAsezat(sursa);
    const alese = loc.length ? await SC.locuriDupaId(loc) : [];
    const randPalet = (p) => `
      <a class="sc-rand" href="${CALE}/intrare/palet/${p.id}${q(tine())}">
        <strong>${esc(p.cod)}</strong> · ${esc(p.denumire)}<br>
        <span class="sc-mic">${esc(cant(p.cantitate, p.um))}${p.lot ? " · lot " + esc(p.lot) : ""} · ${esc(sursaText(p.sursa))}${p.receptie_numar ? " · recepția " + esc(p.receptie_numar) : ""}</span>
      </a>`;
    const randMarfa = (r) => `
      <a class="sc-rand" href="${CALE}/intrare/rand/${esc(r.cheie)}${q(tine())}">
        <strong>${esc(r.denumire)}</strong>${r.cod ? ` <span class="sc-mic">${esc(r.cod)}</span>` : ""}<br>
        <span class="sc-mic">de pus <strong>${esc(cant(r.ramas, r.um))}</strong> · ${esc(sursaText(r.sursa))}${r.detaliu ? " · " + esc(r.detaliu) : ""}</span>
      </a>`;
    const corp = `
      <div class="sc-t">De unde vine marfa</div>
      <div>${SC.SURSE.map(([k, t]) => `<a class="sc-chip${k === sursa ? " activ" : ""}" href="${CALE}/intrare${q({ sursa: k === "toate" ? "" : k, loc: loc.join(",") })}">${esc(t)}</a>`).join("")}</div>
      ${campScan(`${CALE}/intrare`, tine(), "Scanează paletul sau marfa")}
      ${alese.length ? `<div class="sc-t">Loc ales</div>${locuriAlese(alese, (id) => `${CALE}/intrare${q({ sursa: tine().sursa, loc: loc.filter((x) => x !== id).join(",") })}`)}` : ""}
      ${gasite ? `<div class="sc-flash ok">Cu codul ${esc(cod)} sunt mai multe. Alege.</div>` : ""}
      <div class="sc-t">Paleți cu etichetă, care așteaptă raftul (${paleti.length})</div>
      ${paleti.length ? paleti.map(randPalet).join("") : `<p class="sc-mic">Niciunul.</p>`}
      <div class="sc-t">Marfă încă nepusă pe paleți (${randuri.length})</div>
      ${randuri.length ? randuri.map(randMarfa).join("") : `<p class="sc-mic">Nimic.</p>`}
      ${gasite ? `<p><a class="sc-btn" href="${esc(aici({}))}">Arată tot</a></p>` : ""}`;
    pagina(ctx, { titlu: "Intrare marfă", corp });
  });

  // ---- Intrare: paletul scanat → locul → Efectuează --------------------------------
  router.get(`${CALE}/intrare/palet/:id`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const sursa = eSursa(qy.sursa);
    const lista = (extra) => `${CALE}/intrare${q(Object.assign({ sursa: sursa === "toate" ? "" : sursa }, extra))}`;
    const p = await SC.palet(ctx.params.id);
    if (!p) return redirect(ctx.res, lista({ eroare: "Paletul nu există." }));
    if (p.data_iesire) return redirect(ctx.res, lista({ eroare: `Paletul ${p.cod} a ieșit din depozit pe ${String(p.data_iesire).slice(0, 10)}.` }));
    const mutare = p.locuri.length > 0;
    let loc = ids(qy.loc).slice(0, mutare ? p.locuri.length : 3);
    // Câte locuri ține: paletul de pe raft, câte ține acum; cel fără loc, câte
    // a spus omul (sau câte a scanat deja).
    const cate = mutare ? p.locuri.length : Math.min(3, Math.max(1, parseInt(qy.lat, 10) || 1, loc.length));
    const aici = (extra) => `${CALE}/intrare/palet/${p.id}${q(Object.assign({ sursa: sursa === "toate" ? "" : sursa, lat: mutare || cate === 1 ? "" : cate, loc: loc.join(",") }, extra))}`;
    const cod = SC.curat(qy.cod);
    if (cod) {
      if (SC.ePalet(cod)) return redirect(ctx.res, cod === String(p.cod).toUpperCase() ? aici({}) : lista({ cod }));
      if (!SC.eLoc(cod)) return redirect(ctx.res, aici({ eroare: `„${cod}” nu e eticheta unui loc. Scanează eticheta de pe raft (ex. R3-05-2-1).` }));
      const x = await locScanat(cod, p.id);
      if (x.eroare) return redirect(ctx.res, aici({ eroare: x.eroare }));
      const id = Number(x.loc.id);
      if (!loc.includes(id)) {
        // Un palet de un loc: ultimul scanat e cel ales. Unul lat le adună.
        if (cate === 1) loc = [id];
        else if (loc.length >= cate) return redirect(ctx.res, aici({ eroare: `Paletul ține ${cate} locuri și ai ales deja ${loc.length}. Scoate unul (×) dacă vrei altul.` }));
        else loc.push(id);
      }
      return redirect(ctx.res, aici({}));
    }
    const gasite = await SC.locuriDupaId(loc);
    const alese = loc.map((id) => gasite.find((l) => Number(l.id) === id)).filter(Boolean);
    const propuneri = await SC.propuneLocuri(
      { produs_id: p.produs_id, cod_familie_id: p.cod_familie_id, produs_categorie: p.produs_categorie, categorie: p.categorie },
      cate,
      6
    );
    const undeAcum = p.locuri.map((l) => l.adresa).join(" + ");
    const corp = `
      <div class="sc-card">
        <h2>${esc(p.cod)}</h2>
        <strong>${esc(p.denumire)}</strong><br>
        <span class="sc-mic">${esc(cant(p.cantitate, p.um))}${p.lot ? " · lot " + esc(p.lot) : ""} · ${esc(sursaText(p.sursa))}</span><br>
        ${mutare ? `<span class="sc-mic">Acum pe <strong>${esc(undeAcum)}</strong>. Alegi alt loc și paletul se <strong>mută</strong> acolo.</span>` : `<span class="sc-mic">Fără loc pe raft.</span>`}
      </div>
      ${campScan(`${CALE}/intrare/palet/${p.id}`, { sursa: sursa === "toate" ? "" : sursa, lat: mutare || cate === 1 ? "" : cate, loc: loc.join(",") }, "Scanează locul de pe raft")}
      ${alese.length ? `<div class="sc-t">${alese.length === 1 ? "Loc ales" : "Locuri alese"}</div>${locuriAlese(alese, (id) => aici({ loc: loc.filter((x) => x !== id).join(",") }))}` : ""}
      <form method="post" action="${CALE}/intrare/palet/${p.id}">
        <input type="hidden" name="locuri" value="${esc(loc.join(","))}">
        <input type="hidden" name="sursa" value="${esc(sursa)}">
        <input type="hidden" name="lat" value="${esc(String(cate))}">
        <button class="sc-ok" type="submit"${alese.length ? "" : " disabled"}>${alese.length ? `EFECTUEAZĂ — ${mutare ? "mută" : "pune"} pe ${esc(alese.map((l) => l.adresa).join(" + "))}` : "Scanează sau alege locul"}</button>
      </form>
      <div class="sc-t">${mutare ? "Unde încape" : "Unde îl pui"}</div>
      ${blocPropuneri(propuneri, (x) => aici({ loc: x.join(",") }), loc)}
      ${
        mutare
          ? ""
          : `<div class="sc-t">Câte locuri ține paletul</div>
             <div>${[1, 2, 3].map((n) => `<a class="sc-chip${n === cate ? " activ" : ""}" href="${esc(aici({ lat: n === 1 ? "" : n, loc: "" }))}">${n} ${n === 1 ? "loc" : "locuri"}</a>`).join("")}</div>`
      }
      <p style="margin-top:16px"><a class="sc-btn" href="${CALE}/iesire/palet/${p.id}">Scoate paletul (ieșire)</a> <a class="sc-btn" href="/stocuri/ct-park/etichete?paleti=${p.id}">Eticheta</a></p>`;
    pagina(ctx, { titlu: mutare ? "Mută paletul" : "Pune pe raft", inapoi: { href: lista({}), text: "Intrare" }, corp });
  });

  router.post(`${CALE}/intrare/palet/:id`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const b = ctx.body || {};
    const sursa = eSursa(b.sursa);
    const tine = { sursa: sursa === "toate" ? "" : sursa };
    const loc = ids(b.locuri);
    const r = await SC.pune(ctx.user, ctx.params.id, loc);
    if (r.eroare) {
      return redirect(ctx.res, `${CALE}/intrare/palet/${parseInt(ctx.params.id, 10) || 0}${q(Object.assign({}, tine, { lat: nr(b.lat) > 1 ? nr(b.lat) : "", loc: loc.join(","), eroare: r.eroare }))}`);
    }
    const mesaj = r.mutare ? `${r.palet.cod} s-a mutat de pe ${r.de_la} pe ${r.unde}.` : `${r.palet.cod} e pe ${r.unde}. Scanează următorul palet.`;
    redirect(ctx.res, `${CALE}/intrare${q(Object.assign({}, tine, { ok: mesaj }))}`);
  });

  // ---- Intrare: marfa fără palet → cantitate → loc → Efectuează -------------------
  router.get(`${CALE}/intrare/rand/:cheie`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const sursa = eSursa(qy.sursa);
    const lista = (extra) => `${CALE}/intrare${q(Object.assign({ sursa: sursa === "toate" ? "" : sursa }, extra))}`;
    const r = await SC.randDeAsezat(ctx.params.cheie);
    if (!r) return redirect(ctx.res, lista({ eroare: "Marfa asta nu mai e de pus: are deja paleți sau a ieșit din listă." }));
    let loc = ids(qy.loc).slice(0, 3);
    const cate = Math.min(3, Math.max(1, parseInt(qy.lat, 10) || 1, loc.length));
    const cantScrisa = qy.cant !== undefined && String(qy.cant).trim() !== "" ? String(qy.cant).slice(0, 80) : String(r.ramas).replace(".", ",");
    const stare = () => ({ sursa: sursa === "toate" ? "" : sursa, lat: cate === 1 ? "" : cate, loc: loc.join(","), cant: qy.cant !== undefined ? cantScrisa : "" });
    const aici = (extra) => `${CALE}/intrare/rand/${r.cheie}${q(Object.assign(stare(), extra))}`;
    const cod = SC.curat(qy.cod);
    if (cod) {
      if (SC.ePalet(cod)) return redirect(ctx.res, lista({ cod }));
      if (!SC.eLoc(cod)) return redirect(ctx.res, aici({ eroare: `„${cod}” nu e eticheta unui loc. Scanează eticheta de pe raft (ex. R3-05-2-1).` }));
      const x = await locScanat(cod, 0);
      if (x.eroare) return redirect(ctx.res, aici({ eroare: x.eroare }));
      const id = Number(x.loc.id);
      if (!loc.includes(id)) {
        if (cate === 1) loc = [id];
        else if (loc.length >= cate) return redirect(ctx.res, aici({ eroare: `Paletul ține ${cate} locuri și ai ales deja ${loc.length}. Scoate unul (×) dacă vrei altul.` }));
        else loc.push(id);
      }
      return redirect(ctx.res, aici({}));
    }
    const gasite = await SC.locuriDupaId(loc);
    const alese = loc.map((id) => gasite.find((l) => Number(l.id) === id)).filter(Boolean);
    const propuneri = await SC.propuneLocuri(await tintaPropunere(r.produs_id, r.sursa === "productie" ? "produse finite" : null), cate, 6);
    const corp = `
      <div class="sc-card">
        <strong style="font-size:18px">${esc(r.denumire)}</strong>${r.cod ? ` <span class="sc-mic">${esc(r.cod)}</span>` : ""}<br>
        <span class="sc-mic">de pus <strong>${esc(cant(r.ramas, r.um))}</strong> · ${esc(sursaText(r.sursa))}${r.detaliu ? " · " + esc(r.detaliu) : ""}</span>
      </div>
      ${campScan(`${CALE}/intrare/rand/${r.cheie}`, Object.assign(stare(), { cant: cantScrisa }), "Scanează locul de pe raft")}
      ${alese.length ? `<div class="sc-t">${alese.length === 1 ? "Loc ales" : "Locuri alese"}</div>${locuriAlese(alese, (id) => aici({ loc: loc.filter((x) => x !== id).join(",") }))}` : ""}
      <form method="post" action="${CALE}/intrare/rand/${esc(r.cheie)}">
        <input type="hidden" name="locuri" value="${esc(loc.join(","))}">
        <input type="hidden" name="sursa" value="${esc(sursa)}">
        <input type="hidden" name="lat" value="${esc(String(cate))}">
        <label class="sc-f">Cât e pe palet${r.um ? " (" + esc(r.um) + ")" : ""}
          <input name="cant" data-tine="cant" inputmode="decimal" value="${esc(cantScrisa)}" autocomplete="off">
        </label>
        <div class="sc-mic">Mai mulți paleți, fără loc deocamdată: scrie cât e pe fiecare, cu plus între ei — „400 + 400 + 200” sau „3 x 400” — și apasă butonul de jos.</div>
        <button class="sc-ok" type="submit" name="actiune" value="loc"${alese.length ? "" : " disabled"}>${alese.length ? `EFECTUEAZĂ — pune pe ${esc(alese.map((l) => l.adresa).join(" + "))}` : "Scanează sau alege locul"}</button>
        <button class="sc-btn" type="submit" name="actiune" value="paleti" style="width:100%;margin-top:10px">Fă doar paleții și etichetele (fără loc)</button>
      </form>
      <div class="sc-t">Unde îl pui</div>
      ${blocPropuneri(propuneri, (x) => aici({ loc: x.join(",") }), loc)}
      <div class="sc-t">Câte locuri ține paletul</div>
      <div>${[1, 2, 3].map((n) => `<a class="sc-chip${n === cate ? " activ" : ""}" href="${esc(aici({ lat: n === 1 ? "" : n, loc: "" }))}">${n} ${n === 1 ? "loc" : "locuri"}</a>`).join("")}</div>`;
    pagina(ctx, { titlu: "Marfă de pus pe raft", inapoi: { href: lista({}), text: "Intrare" }, corp });
  });

  router.post(`${CALE}/intrare/rand/:cheie`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const b = ctx.body || {};
    const cheie = String(ctx.params.cheie || "");
    const sursa = eSursa(b.sursa);
    const tine = { sursa: sursa === "toate" ? "" : sursa };
    const cuLoc = String(b.actiune || "loc") !== "paleti";
    const loc = cuLoc ? ids(b.locuri) : [];
    const inapoi = (eroare) =>
      redirect(ctx.res, `${CALE}/intrare/rand/${encodeURIComponent(cheie)}${q(Object.assign({}, tine, { lat: nr(b.lat) > 1 ? nr(b.lat) : "", loc: ids(b.locuri).join(","), cant: String(b.cant || "").slice(0, 80), eroare }))}`);
    const cantitati = SC.cantitatiDinText(b.cant);
    if (!cantitati.length || cantitati.some((x) => !(x > 0))) return inapoi("Scrie cât e pe palet: un număr mai mare ca zero (sau mai multe, cu plus între ele: 400 + 400 + 200).");
    if (cuLoc && !loc.length) return inapoi("Scanează locul de pe raft sau alege unul din cele propuse.");
    if (cuLoc && cantitati.length > 1) return inapoi("Pe locul ales se pune un singur palet. Scrie o singură cantitate, sau apasă „Fă doar paleții și etichetele”.");
    const r = await SC.faPaleti(ctx.user, cheie, cantitati, loc);
    if (r.eroare) return inapoi(r.eroare);
    const coduri = await coduriPaleti(r.ids);
    await SC.laTipar("etichete", `${coduri.length === 1 ? "Eticheta paletului" : "Etichetele paleților"} ${coduri.join(", ")}`, `/stocuri/ct-park/etichete?paleti=${r.ids.join(",")}`, ctx.user);
    if (cuLoc) {
      const unde = (await SC.locuriDupaId(loc)).map((l) => l.adresa).join(" + ");
      const mesaj = `${coduri[0]} e pe ${unde}. Eticheta lui e la tipărit.`;
      if (r.ramas > SC.EPS) {
        return redirect(ctx.res, `${CALE}/intrare/rand/${encodeURIComponent(cheie)}${q(Object.assign({}, tine, { ok: `${mesaj} Mai sunt de pus ${cant(r.ramas, r.um)}.` }))}`);
      }
      return redirect(ctx.res, `${CALE}/intrare${q(Object.assign({}, tine, { ok: mesaj }))}`);
    }
    redirect(
      ctx.res,
      `${CALE}/intrare${q(Object.assign({}, tine, { ok: `${coduri.length === 1 ? "Un palet făcut" : coduri.length + " paleți făcuți"}: ${coduri.join(", ")}. Etichetele sunt la tipărit; lipește-le, apoi scanează paletul și locul.` }))}`
    );
  });

  registerIesire(router);
  registerTipar(router);
  registerHartii(router);
}

// ---- Ieșire ------------------------------------------------------------------------
function registerIesire(router) {
  router.get(`${CALE}/iesire`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const cod = SC.curat(qy.cod);
    const eroare = (m) => redirect(ctx.res, `${CALE}/iesire${q({ eroare: m })}`);
    let gasiti = null;
    if (cod) {
      const x = await SC.paletiPentruIesire(cod);
      const inDepozit = x.paleti.filter((p) => p && !p.data_iesire);
      if (x.lipsaLoc) return eroare(`Locul ${cod} nu există pe hartă.`);
      if (x.fel === "loc" && !inDepozit.length) return eroare(`Locul ${x.loc.adresa} e gol.`);
      if (x.fel === "palet" && !x.paleti.length) return eroare(`Paletul ${cod} nu există în CT-Park.`);
      if (x.fel === "palet" && !inDepozit.length) return eroare(`Paletul ${cod} a ieșit deja din depozit pe ${String(x.paleti[0].data_iesire).slice(0, 10)}.`);
      if (!inDepozit.length) return eroare(`Nu e niciun palet în depozit cu codul ${cod}.`);
      if (inDepozit.length === 1) return redirect(ctx.res, `${CALE}/iesire/palet/${inDepozit[0].id}`);
      gasiti = inDepozit;
    }
    const pregatite = await GP.pregatite().catch(() => []);
    const randPalet = (p, i) => `
      <a class="sc-rand" href="${CALE}/iesire/palet/${p.id}">
        <strong>${esc(p.cod)}</strong> · ${esc(p.denumire)}${i === 0 ? ' <span class="badge verde">primul la rând</span>' : ""}<br>
        <span class="sc-mic">${esc(cant(p.cantitate, p.um))} · ${p.locuri.length ? "pe " + esc(p.locuri.map((l) => l.adresa).join(" + ")) : "fără loc"} · intrat ${esc(String(p.data_intrare || "").slice(0, 10))}</span>
      </a>`;
    const corp = `
      ${campScan(`${CALE}/iesire`, {}, "Scanează paletul sau locul")}
      <p class="sc-mic">Merge și codul produsului: îți arată paleții lui, cel mai vechi primul.</p>
      ${gasiti ? `<div class="sc-t">Paleții cu ${esc(cod)} (${gasiti.length}) — cel mai vechi primul</div>${gasiti.map(randPalet).join("")}<p><a class="sc-btn" href="${CALE}/iesire">Altă scanare</a></p>` : ""}
      <div class="sc-t">Pregătite pentru ieșire (${pregatite.length})</div>
      ${
        pregatite.length
          ? pregatite
              .map(
                (p) => `
      <a class="sc-rand" href="${CALE}/iesire/palet/${p.id}">
        <strong>${esc(p.cod)}</strong> · ${esc(p.denumire)}<br>
        <span class="sc-mic">${esc(cant(p.cantitate, p.um))} · ${p.destinatie === "comanda" ? `comanda ${esc(p.comanda_numar || "#" + p.comanda_id)}${p.client ? " · " + esc(p.client) : ""}` : esc(p.destinatie)}</span>
      </a>`
              )
              .join("")
          : `<p class="sc-mic">Niciun palet alocat dinainte unui client sau fulfillment-ului.</p>`
      }`;
    pagina(ctx, { titlu: "Ieșire marfă", corp });
  });

  router.get(`${CALE}/iesire/palet/:id`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const p = await SC.palet(ctx.params.id);
    if (!p) return redirect(ctx.res, `${CALE}/iesire${q({ eroare: "Paletul nu există." })}`);
    if (p.data_iesire) return redirect(ctx.res, `${CALE}/iesire${q({ eroare: `Paletul ${p.cod} a ieșit deja din depozit pe ${String(p.data_iesire).slice(0, 10)}.` })}`);
    const CT = require("./ct-park");
    const vechi = await SC.maiVechi(p);
    const comenzi = await SC.comenziPentru(p);
    const oLinie = p.linii.length === 1;
    const total = oLinie ? nr(p.linii[0].cantitate) : nr(p.cantitate);
    const um = (oLinie ? p.linii[0].um : p.um) || "";
    const destAleasa = CT.DESTINATII.some(([k]) => k === qy.destinatie) ? String(qy.destinatie) : p.iesire_plan || "";
    const comandaAleasa = nr(qy.comanda_id) || nr(p.iesire_comanda_id);
    const corp = `
      <div class="sc-card">
        <h2>${esc(p.cod)}</h2>
        <strong>${esc(p.denumire)}</strong><br>
        <span class="sc-mic">${esc(cant(p.cantitate, p.um))}${p.lot ? " · lot " + esc(p.lot) : ""} · ${p.locuri.length ? "pe <strong>" + esc(p.locuri.map((l) => l.adresa).join(" + ")) + "</strong>" : "fără loc"} · intrat ${esc(String(p.data_intrare || "").slice(0, 10))}</span>
        ${p.linii.length > 1 ? `<br><span class="sc-mic">Pe palet: ${p.linii.map((l) => esc(`${cant(l.cantitate, l.um)} ${l.produs_text || ""}`.trim())).join("; ")}</span>` : ""}
      </div>
      <form method="post" action="${CALE}/iesire/palet/${p.id}">
        ${
          vechi.length
            ? `<div class="sc-flash rau" style="font-weight:500">
                 <strong>Nu e primul la rând.</strong> ${vechi.length === 1 ? "E un palet mai vechi" : "Sunt " + vechi.length + " paleți mai vechi"} din aceeași marfă:
                 ${vechi.map((v) => `<a href="${CALE}/iesire/palet/${v.id}">${esc(v.cod)}</a>${v.adrese ? " (" + esc(v.adrese) + ")" : ""}`).join(", ")}.
                 <label class="sc-f" style="color:inherit">De ce îl scoți pe ăsta
                   <input name="peste_rand" required value="${esc(String(qy.peste_rand || ""))}" placeholder="ex. cel vechi e blocat în spate">
                 </label>
               </div>`
            : ""
        }
        <div class="sc-t">Unde pleacă</div>
        ${CT.DESTINATII.map(
          ([k, t, explic]) => `<label class="sc-dest"><input type="radio" name="destinatie" value="${k}" required${destAleasa === k ? " checked" : ""}>${esc(t)}<br><span class="sc-mic" style="font-weight:400">${esc(explic)}</span></label>`
        ).join("")}
        <label class="sc-f" id="sc-comanda">Comanda clientului
          <select name="comanda_id">
            <option value="">— alege comanda —</option>
            ${comenzi
              .map(
                (c) =>
                  `<option value="${c.id}"${comandaAleasa === Number(c.id) ? " selected" : ""}>${c.are_produsul ? "✓ " : ""}${esc(c.numar || "#" + c.id)} · ${esc(c.client)} · ${esc(String(c.data || "").slice(0, 10))}</option>`
              )
              .join("")}
          </select>
          <span class="sc-mic">Cu ✓ sunt comenzile care au produsul ăsta. La ieșire se fac avizul și comanda clientului, de tipărit.</span>
        </label>
        ${
          oLinie
            ? `<label class="sc-f">Cât pleacă${um ? " (" + esc(um) + ")" : ""} — pe palet sunt ${esc(cant(total, um))}
                 <input name="q" inputmode="decimal" autocomplete="off" value="${esc(String(qy.q !== undefined && String(qy.q).trim() !== "" ? qy.q : total).replace(".", ","))}">
                 <span class="sc-mic">Mai puțin decât tot: restul rămâne pe palet, pe locul lui.</span>
               </label>`
            : `<p class="sc-mic">${p.linii.length > 1 ? `Palet cu ${p.linii.length} produse: de aici iese întreg. O parte din el se scoate din <a href="/stocuri/ct-park/palet/${p.id}">fișa paletului</a>.` : "Paletul iese întreg."}</p>`
        }
        <label class="sc-f">Observații (opțional)
          <input name="observatii" value="${esc(String(qy.observatii || ""))}" placeholder="ex. ridicat de curier">
        </label>
        <button class="sc-ok iesire" type="submit">EFECTUEAZĂ IEȘIREA</button>
      </form>
      <p style="margin-top:16px">${p.locuri.length ? `<a class="sc-btn" href="${CALE}/intrare/palet/${p.id}">Mută pe alt loc</a>` : `<a class="sc-btn" href="${CALE}/intrare/palet/${p.id}">Pune pe raft</a>`}</p>
      <script>
      (function () {
        var camp = document.getElementById("sc-comanda"), radio = document.querySelectorAll('input[name="destinatie"]');
        function comuta() {
          var ales = null;
          for (var i = 0; i < radio.length; i++) if (radio[i].checked) ales = radio[i].value;
          camp.hidden = ales !== "comanda";
          camp.querySelector("select").required = ales === "comanda";
        }
        for (var i = 0; i < radio.length; i++) radio[i].addEventListener("change", comuta);
        comuta();
      })();
      </script>`;
    pagina(ctx, { titlu: "Scoate paletul", inapoi: { href: `${CALE}/iesire`, text: "Ieșire" }, corp });
  });

  router.post(`${CALE}/iesire/palet/:id`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const b = ctx.body || {};
    const p = await SC.palet(ctx.params.id);
    if (!p) return redirect(ctx.res, `${CALE}/iesire${q({ eroare: "Paletul nu există." })}`);
    if (p.data_iesire) return redirect(ctx.res, `${CALE}/iesire${q({ eroare: `Paletul ${p.cod} a ieșit deja din depozit.` })}`);
    const CT = require("./ct-park");
    const destinatie = String(b.destinatie || "");
    const text = (v) => String(v == null ? "" : v).trim().slice(0, 300);
    const inapoi = (eroare) =>
      redirect(
        ctx.res,
        `${CALE}/iesire/palet/${p.id}${q({ destinatie, comanda_id: nr(b.comanda_id) || "", q: text(b.q), peste_rand: text(b.peste_rand), observatii: text(b.observatii), eroare })}`
      );
    const oLinie = p.linii.length === 1;
    const total = oLinie ? nr(p.linii[0].cantitate) : nr(p.cantitate);
    const um = (oLinie ? p.linii[0].um : p.um) || "";
    let pleaca = total;
    if (oLinie && text(b.q) !== "") {
      const v = CPL.cifra(b.q);
      if (v === null || !(v > 0)) return inapoi("Scrie cât pleacă: un număr mai mare ca zero.");
      if (v > total + SC.EPS) return inapoi(`Pe palet sunt doar ${cant(total, um)}.`);
      pleaca = v;
    }
    const partial = oLinie && pleaca < total - SC.EPS;
    let r;
    if (partial) {
      const l = p.linii[0];
      r = await CT.iesirePartiala(ctx.user, p.id, {
        destinatie,
        comanda_id: b.comanda_id,
        observatii: [text(b.peste_rand), text(b.observatii)].filter(Boolean).join(" · "),
        ["pleaca_" + l.id]: String(pleaca),
        ["ramane_" + l.id]: String(rotunjit(total - pleaca)),
      });
    } else {
      r = await CT.iesireIntreaga(ctx.user, { paleti: [p.id], destinatie, comanda_id: b.comanda_id, peste_rand: text(b.peste_rand), observatii: text(b.observatii) });
    }
    if (r.eroare) return inapoi(r.eroare);

    const unde =
      destinatie === "comanda"
        ? `comanda ${(r.comanda && (r.comanda.numar || "#" + r.comanda.id)) || "#" + nr(b.comanda_id)}`
        : CT.etichetaDestinatie(destinatie).toLowerCase();
    const mesaj = partial ? r.mesaj : `${p.cod} (${cant(total, um)} ${p.denumire}) a ieșit spre ${unde}.`.replace(/\s+/g, " ");
    // Hârtiile: pe comanda clientului, avizul și comanda; altfel, eticheta de
    // ieșire a paletului plecat întreg. Merg la coada de tipărit, de unde le
    // scoate calculatorul de lângă imprimantă.
    const cid = destinatie === "comanda" ? nr(b.comanda_id) : 0;
    if (r.aviz) {
      await SC.laTipar("a4", `Avizul ${r.aviz.serie || ""} ${r.aviz.numar || "#" + r.aviz.id} — ${unde}`.replace(/\s+/g, " "), `/stocuri/ct-park/aviz/${r.aviz.id}`, ctx.user);
      await SC.laTipar("a4", `Comanda clientului — ${unde}`, `/stocuri/ct-park/comanda/${cid}/foaie`, ctx.user);
    } else if (!partial || r.paletGol) {
      await SC.laTipar("a4", `Eticheta de ieșire ${p.cod} — ${unde}`, `/stocuri/ct-park/etichete?paleti=${p.id}`, ctx.user);
    }
    redirect(
      ctx.res,
      `${CALE}/iesire/gata${q({ palet: p.id, aviz: r.aviz ? r.aviz.id : "", comanda: cid || "", intreg: !partial || r.paletGol ? 1 : "", ok: mesaj, eroare: r.avizEroare ? `Ieșirea s-a făcut, dar avizul nu s-a putut emite: ${r.avizEroare}` : "" })}`
    );
  });

  router.get(`${CALE}/iesire/gata`, async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const aviz = Math.round(nr(qy.aviz));
    const comanda = Math.round(nr(qy.comanda));
    const palet = Math.round(nr(qy.palet));
    const hartii = [
      aviz ? `<a class="sc-btn" href="/stocuri/ct-park/aviz/${aviz}">Avizul</a>` : "",
      comanda ? `<a class="sc-btn" href="/stocuri/ct-park/comanda/${comanda}/foaie">Comanda clientului</a>` : "",
      !aviz && palet && qy.intreg ? `<a class="sc-btn" href="/stocuri/ct-park/etichete?paleti=${palet}">Eticheta de ieșire</a>` : "",
    ].filter(Boolean);
    const corp = `
      ${
        hartii.length
          ? `<div class="sc-card">
               <div class="sc-t" style="margin-top:0">De tipărit</div>
               <p>${hartii.join(" ")}</p>
               <p class="sc-mic">Sunt și în <a href="${TIPAR}">Depozit → De tipărit</a>. Calculatorul de lângă imprimantă, cu pagina aia deschisă și bifa „Printează singur”, le scoate fără să apeși nimic.</p>
             </div>`
          : ""
      }
      <a class="sc-mare sc-iesire" href="${CALE}/iesire">URMĂTORUL PALET</a>
      <p><a class="sc-btn" href="${CALE}">Acasă</a>${palet && !qy.intreg ? ` <a class="sc-btn" href="${CALE}/iesire/palet/${palet}">Mai scoate din același palet</a>` : ""}</p>`;
    pagina(ctx, { titlu: "Ieșire făcută", inapoi: { href: `${CALE}/iesire`, text: "Ieșire" }, corp });
  });
}

// ---- De tipărit ------------------------------------------------------------------------
const FEL_TEXT = { etichete: "etichete de palet (100 × 150)", a4: "document A4" };

function registerTipar(router) {
  router.get("/stocuri/ct-park/tipar", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const de = SC.oraRo(new Date(Date.now() - 72 * 3600 * 1000));
    const randuri = await db
      .prepare("SELECT * FROM ct_tipar WHERE creat_la >= ? ORDER BY (tiparit_la IS NULL) DESC, id DESC LIMIT 200")
      .all(de)
      .catch(() => []);
    const asteapta = randuri.filter((r) => !r.tiparit_la).length;
    const body = `
      ${require("./ct-park").subtabs(TIPAR, ctx.user)}
      ${ctx.query.ok ? `<div class="flash">${esc(String(ctx.query.ok))}</div>` : ""}
      <p class="explic" style="max-width:900px">
        Aici ajunge ce are de tipărit depozitul după o mișcare făcută cu scanerul: etichetele paleților făcuți din terminal,
        iar la ieșirea pe o comandă, avizul și comanda clientului. Lasă pagina deschisă pe calculatorul de lângă imprimantă și
        bifează „Printează singur ce apare”: se uită singură la 20 de secunde și scoate ce e nou.
        Ca să iasă fără fereastra de tipărire, Chrome se pornește cu <code>--kiosk-printing</code> și cu imprimanta aceea ca implicită —
        la fel ca la etichetele AWB. Etichetele de palet merg pe Zebra, documentele pe imprimanta A4: alege mai jos ce scoate calculatorul ăsta.
      </p>
      <div class="detail-box" style="max-width:900px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" id="auto" style="width:18px;height:18px"> <strong>Printează singur ce apare</strong></label>
        <label style="display:flex;gap:8px;align-items:center;margin:0">Calculatorul ăsta scoate
          <select id="ce">
            <option value="a4">documentele A4 (aviz, comandă, etichetă de ieșire)</option>
            <option value="etichete">etichetele de palet (Zebra 100 × 150)</option>
            <option value="tot">și unele, și altele</option>
          </select>
        </label>
        <span id="stare-auto" style="color:var(--text-muted);font-size:13px">${asteapta ? `${asteapta} ${asteapta === 1 ? "document așteaptă" : "documente așteaptă"}.` : "Nu așteaptă nimic."}</span>
      </div>
      ${
        randuri.length
          ? table(
              ["Făcut la", "Ce", "Fel", "De cine", "Stare", ""],
              randuri.map((r) => [
                esc(String(r.creat_la || "").slice(0, 16)),
                `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.titlu)}</a>`,
                esc(FEL_TEXT[r.fel] || r.fel),
                esc(r.creat_de || "—"),
                r.tiparit_la
                  ? `<span class="badge verde">tipărit ${esc(String(r.tiparit_la).slice(0, 16))}</span>`
                  : r.eroare
                    ? `<span class="badge rosu" title="${esc(r.eroare)}">n-a mers</span>`
                    : '<span class="badge galben">așteaptă</span>',
                `<button class="btn small${r.tiparit_la ? " secondary" : ""}" type="button" data-print="${r.id}" data-url="${esc(r.url)}">${r.tiparit_la ? "Tipărește iar" : "Tipărește"}</button>`,
              ])
            )
          : "<p>Nimic de tipărit în ultimele trei zile.</p>"
      }
      <iframe id="tipar" title="tipărire" style="position:fixed;width:0;height:0;border:0;left:-9999px"></iframe>
      <script>
      (function () {
        var sus = document.getElementById("stare-auto"), bifa = document.getElementById("auto"), ce = document.getElementById("ce");
        var cadru = document.getElementById("tipar"), ocupat = false;
        function spune(t) { sus.textContent = t; }
        try { bifa.checked = localStorage.getItem("ct-tipar-auto") === "1"; ce.value = localStorage.getItem("ct-tipar-ce") || "a4"; } catch (e) {}
        if (!ce.value) ce.value = "a4";
        bifa.addEventListener("change", function () {
          try { localStorage.setItem("ct-tipar-auto", bifa.checked ? "1" : "0"); } catch (e) {}
          spune(bifa.checked ? "Pornit. Verific acum…" : "Oprit.");
          if (bifa.checked) verifica();
        });
        ce.addEventListener("change", function () { try { localStorage.setItem("ct-tipar-ce", ce.value); } catch (e) {} if (bifa.checked) verifica(); });
        // Documentul se încarcă în cadrul ascuns, se dă la imprimantă și abia
        // DUPĂ aceea se scrie că a ieșit — invers, o pagină căzută la mijloc
        // ar lăsa un document „tipărit" pe care nu l-a văzut nimeni.
        function printeaza(url) {
          return new Promise(function (gata, rau) {
            var ceas = setTimeout(function () { rau(new Error("documentul nu s-a încărcat")); }, 45000);
            cadru.onload = function () {
              clearTimeout(ceas);
              setTimeout(function () {
                try { cadru.contentWindow.focus(); cadru.contentWindow.print(); gata(); } catch (e) { rau(e); }
              }, 400);
            };
            cadru.src = url;
          });
        }
        function marcheaza(id, eroare) {
          return fetch(${JSON.stringify(TIPAR)} + "/" + id + "/tiparit", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "eroare=" + encodeURIComponent(eroare || ""),
          });
        }
        async function unul(id, url) {
          try { await printeaza(url); await marcheaza(id, ""); return true; }
          catch (e) { await marcheaza(id, String((e && e.message) || e)); return false; }
        }
        document.addEventListener("click", async function (ev) {
          var b = ev.target.closest("[data-print]");
          if (!b || ocupat) return;
          ocupat = true; b.disabled = true; b.textContent = "Se tipărește…";
          var ok = await unul(b.getAttribute("data-print"), b.getAttribute("data-url"));
          ocupat = false;
          b.textContent = ok ? "Trimis la imprimantă" : "N-a mers";
          if (ok) setTimeout(function () { location.reload(); }, 1500); else b.disabled = false;
        });
        async function verifica() {
          if (!bifa.checked || ocupat) return;
          ocupat = true;
          try {
            var r = await fetch(${JSON.stringify(TIPAR)} + "/noi.json?fel=" + encodeURIComponent(ce.value), { credentials: "same-origin", cache: "no-store" });
            var d = await r.json();
            if (!d.documente || !d.documente.length) spune("Nimic nou. Ultima verificare " + new Date().toLocaleTimeString("ro-RO") + ".");
            else {
              spune(d.documente.length + (d.documente.length === 1 ? " document nou, îl scot" : " documente noi, le scot") + " la imprimantă…");
              var n = 0;
              // Unul câte unul: două tipăriri pornite deodată în același cadru s-ar călca.
              for (var i = 0; i < d.documente.length; i++) { if (await unul(d.documente[i].id, d.documente[i].url)) n++; }
              spune("Am tipărit " + n + " din " + d.documente.length + " la " + new Date().toLocaleTimeString("ro-RO") + ".");
              setTimeout(function () { location.reload(); }, 2500);
            }
          } catch (e) { spune("Nu pot verifica: " + ((e && e.message) || e)); }
          ocupat = false;
        }
        setInterval(verifica, 20000);
        if (bifa.checked) setTimeout(verifica, 1500);
      })();
      </script>`;
    send(ctx.res, 200, layout({ user: ctx.user, title: "De tipărit — depozit", active: "/stocuri/ct-park", body }));
  });

  router.get("/stocuri/ct-park/tipar/noi.json", async (ctx) => {
    const json = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (!poate(ctx.user)) return send(ctx.res, 403, "{}", json);
    const fel = String((ctx.query || {}).fel || "");
    const lista = await SC.deTiparit(SC.FELURI_TIPAR.includes(fel) ? fel : null, 36);
    send(ctx.res, 200, JSON.stringify({ documente: lista.map((d) => ({ id: Number(d.id), fel: d.fel, titlu: d.titlu, url: d.url })) }), json);
  });

  router.post("/stocuri/ct-park/tipar/:id/tiparit", async (ctx) => {
    const json = { "Content-Type": "application/json; charset=utf-8" };
    if (!poate(ctx.user)) return send(ctx.res, 403, "{}", json);
    await SC.tiparit(ctx.params.id, ctx.user, (ctx.body || {}).eroare);
    send(ctx.res, 200, '{"ok":true}', json);
  });
}

// ---- Hârtiile: etichetele locurilor, comanda clientului, paleții recepției --------
function registerHartii(router) {
  // Etichetele locurilor. Cititorul de mână citește de aproape, deci
  // etichetele nivelurilor de sus se lipesc jos, pe stâlpul câmpului, la
  // înălțimea ochilor: de-aia nivelul e scris mare, cu săgeată, iar ordinea de
  // tipărire e câmp → poziție → nivelul de sus întâi, cum stau pe stâlp.
  router.get("/stocuri/ct-park/locuri/etichete", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const qy = ctx.query || {};
    const randId = Math.round(nr(qy.rand));
    const randuri = await db
      .prepare("SELECT r.id, r.numar, r.eticheta, (SELECT COUNT(*) FROM ct_locuri l WHERE l.rand_id = r.id) AS locuri FROM ct_randuri r WHERE r.activ = 1 ORDER BY r.numar")
      .all()
      .catch(() => []);
    const rand = randuri.find((r) => Number(r.id) === randId);
    if (!rand) {
      const body = `
        ${require("./ct-park").subtabs("/stocuri/ct-park/scaner", ctx.user)}
        <p class="explic" style="max-width:860px">
          Fiecare loc din CT-Park are adresa lui (de exemplu <code>R3-05-2-1</code>: rândul 3, câmpul 05, nivelul 2, poziția 1). Eticheta are adresa
          scrisă mare și codul ei de bare. Lipește-le pe stâlpul câmpului, <strong>la înălțimea ochilor</strong>, una sub alta, cu nivelul de sus deasupra:
          cititorul de mână citește de aproape, nu de la patru metri. Nivelul e scris mare pe fiecare, cu săgeată în sus pentru cele de deasupra.
        </p>
        ${
          randuri.length
            ? table(
                ["Rând", "Locuri", "Etichete"],
                randuri.map((r) => [
                  `Rândul ${esc(String(r.numar))}${r.eticheta ? " · " + esc(r.eticheta) : ""}`,
                  esc(String(r.locuri)),
                  `<a class="btn small" href="/stocuri/ct-park/locuri/etichete?rand=${r.id}" target="_blank" rel="noopener">A4, de tăiat</a>
                   <a class="btn small secondary" href="/stocuri/ct-park/locuri/etichete?rand=${r.id}&format=zebra" target="_blank" rel="noopener">Zebra 100 × 150</a>`,
                ])
              )
            : "<p>Nu e niciun rând configurat.</p>"
        }
        <p class="mic">Doar un nivel sau un câmp: adaugă la adresă <code>&amp;nivel=2</code> sau <code>&amp;camp=5</code>.</p>`;
      return send(ctx.res, 200, layout({ user: ctx.user, title: "Etichete pentru rafturi", active: "/stocuri/ct-park", body }));
    }
    const zebra = String(qy.format || "") === "zebra";
    const nivel = Math.round(nr(qy.nivel));
    const camp = Math.round(nr(qy.camp));
    const locuri = await db
      .prepare(
        `SELECT id, nivel, camp, pozitie, adresa FROM ct_locuri WHERE rand_id = ?${nivel ? " AND nivel = ?" : ""}${camp ? " AND camp = ?" : ""}
          ORDER BY camp, pozitie, nivel DESC`
      )
      .all(...[rand.id].concat(nivel ? [nivel] : [], camp ? [camp] : []));
    const eticheta = (l) => `
      <div class="le">
        <div class="le-sus">
          <div class="le-adresa">${esc(l.adresa)}<div class="le-unde">rândul ${esc(String(rand.numar))} · câmpul ${esc(String(l.camp).padStart(2, "0"))} · poziția ${esc(String(l.pozitie))}</div></div>
          <div class="le-nivel"><span>NIVEL</span><b>${esc(String(l.nivel))}</b><i>${Number(l.nivel) > 1 ? "▲" : "jos"}</i></div>
        </div>
        <div class="le-cod">${codbare.svg(l.adresa, { modul: zebra ? 0.5 : 0.4, inalt: zebra ? 28 : 11, subtitlu: false, latimeMax: zebra ? 92 : 86 })}</div>
      </div>`;
    const html = `<!doctype html><html lang="ro"><head><meta charset="utf-8">
      <title>Etichete locuri — rândul ${esc(String(rand.numar))}</title>
      <style>
        @page { ${zebra ? "size: 100mm 150mm; margin: 0;" : "size: A4; margin: 8mm;"} }
        body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#000; background:#eee; }
        .bara { text-align:center; padding:10px; background:#fff; border-bottom:1px solid #ccc; font-family:system-ui,sans-serif; }
        .foaie { ${zebra ? "" : "display:grid; grid-template-columns: 1fr 1fr; gap:0; width:194mm; margin:0 auto; background:#fff;"} }
        .le { box-sizing:border-box; background:#fff; break-inside:avoid; page-break-inside:avoid; overflow:hidden;
              ${zebra ? "width:100mm; height:150mm; padding:8mm 4mm; margin:6px auto; page-break-after:always; display:flex; flex-direction:column; justify-content:center; gap:10mm;" : "height:39.5mm; padding:3mm 4mm; border:0.3mm dashed #999;"} }
        .le-sus { display:flex; justify-content:space-between; align-items:center; gap:3mm; }
        .le-adresa { font-size:${zebra ? "34pt" : "21pt"}; font-weight:800; letter-spacing:.02em; line-height:1.05; white-space:nowrap; }
        .le-unde { font-size:${zebra ? "13pt" : "8pt"}; font-weight:400; letter-spacing:0; margin-top:1mm; white-space:normal; }
        .le-nivel { border:0.6mm solid #000; border-radius:2mm; padding:1mm 2.5mm; text-align:center; line-height:1; }
        .le-nivel span { display:block; font-size:${zebra ? "10pt" : "6.5pt"}; font-weight:700; }
        .le-nivel b { display:block; font-size:${zebra ? "44pt" : "22pt"}; }
        .le-nivel i { display:block; font-style:normal; font-size:${zebra ? "14pt" : "8pt"}; }
        .le-cod { text-align:center; margin-top:${zebra ? "0" : "1.5mm"}; }
        .le-cod svg { display:inline-block; max-width:100%; }
        @media print { .bara { display:none; } body { background:#fff; } .le { margin:0; } }
      </style></head><body>
      <div class="bara"><strong>Rândul ${esc(String(rand.numar))}${rand.eticheta ? " · " + esc(rand.eticheta) : ""}: ${locuri.length} ${locuri.length === 1 ? "etichetă" : "etichete"}${zebra ? ", câte una pe 100 × 150" : ", 14 pe foaia A4"}</strong> —
        <button onclick="window.print()">Tipărește</button> <a href="/stocuri/ct-park/locuri/etichete">înapoi</a></div>
      <div class="foaie">${locuri.map(eticheta).join("")}</div>
      </body></html>`;
    send(ctx.res, 200, html);
  });

  // Comanda clientului, de tipărit la ieșirea mărfii: ce a comandat, cât a
  // plecat până acum din depozit (din avize) și cât mai e. Fără prețuri, ca
  // avizul — foaia merge cu marfa.
  router.get("/stocuri/ct-park/comanda/:id/foaie", async (ctx) => {
    if (!poate(ctx.user)) return redirect(ctx.res, "/stocuri/ct-park");
    const id = parseInt(ctx.params.id, 10) || 0;
    const c = await db
      .prepare(
        `SELECT c.*, p.nume AS client, p.cui, p.adresa, p.judet, p.localitate, p.telefon, p.persoana_contact, u.nume AS agent
           FROM comenzi c JOIN parteneri p ON p.id = c.partener_id LEFT JOIN utilizatori u ON u.id = c.agent_id WHERE c.id = ?`
      )
      .get(id)
      .catch(() => null);
    if (!c) return send(ctx.res, 404, layout({ user: ctx.user, title: "Comanda nu există", active: "/stocuri/ct-park", body: "<p>Comanda nu există.</p>" }));
    const linii = await db
      .prepare(
        `SELECT cl.id, cl.produs_id, cl.cantitate, COALESCE(NULLIF(TRIM(cl.um), ''), pr.unitate_masura) AS um, pr.denumire,
                COALESCE(NULLIF(TRIM(pr.cod), ''), pr.cod_generat) AS cod
           FROM comenzi_linii cl JOIN produse pr ON pr.id = cl.produs_id WHERE cl.comanda_id = ? ORDER BY cl.id`
      )
      .all(id);
    const plecat = await db
      .prepare(
        `SELECT al.produs_id, SUM(al.cantitate) AS q FROM avize_linii al JOIN avize a ON a.id = al.aviz_id
          WHERE a.comanda_id = ? AND a.anulat = 0 AND al.produs_id IS NOT NULL GROUP BY al.produs_id`
      )
      .all(id)
      .catch(() => []);
    const avize = await db.prepare("SELECT serie, numar, data FROM avize WHERE comanda_id = ? AND anulat = 0 ORDER BY id").all(id).catch(() => []);
    // Ce a plecat se împarte pe rândurile aceluiași produs în ordinea lor: un
    // produs trecut de două ori pe comandă nu apare plecat de două ori.
    const ramasDeImpartit = new Map(plecat.map((x) => [Number(x.produs_id), nr(x.q)]));
    const randuri = linii.map((l, i) => {
      const disponibil = ramasDeImpartit.get(Number(l.produs_id)) || 0;
      const dus = Math.min(disponibil, nr(l.cantitate));
      const ultimul = !linii.slice(i + 1).some((x) => Number(x.produs_id) === Number(l.produs_id));
      const aici = ultimul ? disponibil : dus;
      ramasDeImpartit.set(Number(l.produs_id), disponibil - aici);
      return Object.assign({}, l, { plecat: rotunjit(aici), ramas: rotunjit(Math.max(0, nr(l.cantitate) - aici)) });
    });
    const adresa = [c.adresa, c.localitate, c.judet ? "jud. " + c.judet : ""].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
    const numar = c.numar || "#" + c.id;
    const html = `<!doctype html><html lang="ro"><head><meta charset="utf-8">
      <title>Comanda ${esc(numar)} — ${esc(c.client)}</title>
      <style>
        @page { size: A4; margin: 10mm; }
        body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#000; background:#eee; font-size:10.5pt; }
        .bara { text-align:center; padding:10px; background:#fff; border-bottom:1px solid #ccc; font-family:system-ui,sans-serif; }
        .foaie { box-sizing:border-box; width:190mm; min-height:277mm; margin:8px auto; background:#fff; padding:6mm; }
        .cap { display:flex; justify-content:space-between; align-items:flex-start; gap:8mm; border-bottom:0.6mm solid #000; padding-bottom:4mm; }
        h1 { margin:0; font-size:19pt; } .sub { font-size:10pt; margin-top:1mm; }
        .doua { display:flex; gap:8mm; margin:5mm 0; } .doua > div { flex:1; }
        .et { font-size:8pt; text-transform:uppercase; letter-spacing:.04em; color:#444; }
        table { width:100%; border-collapse:collapse; margin-top:3mm; }
        th, td { border:0.25mm solid #000; padding:1.6mm 2mm; vertical-align:middle; }
        th { background:#eee; font-size:8.5pt; text-align:left; }
        td.n, th.n { text-align:right; white-space:nowrap; }
        .cod svg { display:block; } .patrat { display:inline-block; width:6mm; height:6mm; border:0.4mm solid #000; }
        .jos { display:flex; gap:12mm; margin-top:14mm; } .jos > div { flex:1; border-top:0.3mm solid #000; padding-top:1.5mm; font-size:9pt; }
        @media print { .bara { display:none; } body { background:#fff; } .foaie { margin:0; width:auto; min-height:0; padding:0; } }
      </style></head><body>
      <div class="bara"><strong>Comanda ${esc(numar)} · ${esc(c.client)}</strong> — <button onclick="window.print()">Tipărește</button> <a href="/comenzi/${c.id}">comanda în ERP</a></div>
      <div class="foaie">
        <div class="cap">
          <div>
            <div class="et">Cash Machine SRL · document de depozit, fără prețuri</div>
            <h1>COMANDĂ CLIENT ${esc(numar)}</h1>
            <div class="sub">din ${esc(String(c.data || "").slice(0, 10))}${c.status ? " · " + esc(c.status) : ""}</div>
          </div>
          <div class="cod">${codbare.svg(SCAN.codComanda(c.id), { modul: 0.33, inalt: 13 })}</div>
        </div>
        <div class="doua">
          <div><div class="et">Client</div><strong style="font-size:13pt">${esc(c.client)}</strong>${c.cui ? "<br>CUI " + esc(c.cui) : ""}${adresa ? "<br>" + esc(adresa) : ""}${
            c.persoana_contact || c.telefon ? "<br>" + esc([c.persoana_contact, c.telefon].filter(Boolean).join(" · ")) : ""
          }</div>
          <div><div class="et">Livrare</div>${c.data_livrare_ceruta ? "cerută pentru <strong>" + esc(String(c.data_livrare_ceruta).slice(0, 10)) + "</strong><br>" : ""}${
            c.livrare_partiala ? "livrare parțială: " + esc(c.livrare_partiala) + "<br>" : ""
          }${c.branding ? "branding: " + esc(c.branding) + "<br>" : ""}${c.agent ? "agent: " + esc(c.agent) + "<br>" : ""}${
            avize.length ? "avize: " + avize.map((a) => esc(`${a.serie} ${a.numar}`)).join(", ") : "încă fără aviz"
          }</div>
        </div>
        ${c.observatii ? `<div><span class="et">Observații</span><br>${esc(c.observatii)}</div>` : ""}
        <table>
          <thead><tr><th style="width:8mm">Nr.</th><th>Produs</th><th style="width:52mm">Cod</th><th style="width:12mm">UM</th><th class="n">Comandat</th><th class="n">Plecat</th><th class="n">Rămas</th><th style="width:16mm">Încărcat</th></tr></thead>
          <tbody>
            ${randuri
              .map(
                (l, i) => `<tr>
              <td class="n">${i + 1}</td>
              <td>${esc(l.denumire)}</td>
              <td class="cod">${codbare.svg(SCAN.codProdus(l.cod, l.produs_id), { modul: 0.25, inalt: 8, latimeMax: 50 })}</td>
              <td>${esc(l.um || "")}</td>
              <td class="n"><strong>${esc(cant(l.cantitate))}</strong></td>
              <td class="n">${l.plecat ? esc(cant(l.plecat)) : "—"}</td>
              <td class="n">${esc(cant(l.ramas))}</td>
              <td style="text-align:center"><span class="patrat"></span></td>
            </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <p style="font-size:8.5pt;margin-top:3mm">„Plecat” e ce a ieșit din depozit cu aviz pe comanda asta, până la ${esc(SC.oraRo().slice(0, 16))}.</p>
        <div class="jos"><div>Predat (depozit) — nume și semnătură</div><div>Primit — nume și semnătură</div></div>
      </div>
      </body></html>`;
    send(ctx.res, 200, dateleInText(html));
  });

  // Paleții unei recepții numărate: omul scrie cât e pe fiecare palet, la
  // fiecare rând, iar ERP-ul face paleții (fără loc) și deschide etichetele
  // lor. Eticheta se lipește pe palet; raftul îl primește apoi din scaner.
  router.post("/depozit/receptie/:id/paleti", async (ctx) => {
    const u = ctx.user;
    if (!u || !["admin", "depozit", "productie"].includes(u.rol)) return redirect(ctx.res, "/depozit/receptie");
    const id = parseInt(ctx.params.id, 10) || 0;
    const inapoi = (k, m) => redirect(ctx.res, `/depozit/receptie/${id}?${k}=${encodeURIComponent(String(m).slice(0, 400))}#ct-park`);
    const b = ctx.body || {};
    const linii = await db.prepare("SELECT id FROM receptii_linii WHERE receptie_id = ? ORDER BY id").all(id).catch(() => []);
    const facute = [];
    const erori = [];
    for (const l of linii) {
      const scris = String(b["paleti_" + l.id] == null ? "" : b["paleti_" + l.id]).trim();
      if (!scris) continue;
      const cantitati = SC.cantitatiDinText(scris);
      if (!cantitati.length || cantitati.some((x) => !(x > 0))) {
        erori.push(`„${scris.slice(0, 40)}” nu e o listă de cantități.`);
        continue;
      }
      const r = await SC.faPaleti(u, "r" + l.id, cantitati, []);
      if (r.eroare) erori.push(r.eroare);
      if (r.ids && r.ids.length) facute.push(...r.ids);
    }
    if (!facute.length) return inapoi("eroare", erori.length ? erori.join(" ") : "Scrie cât e pe fiecare palet, la rândurile pentru care faci paleți.");
    redirect(ctx.res, `/stocuri/ct-park/etichete?paleti=${facute.join(",")}${erori.length ? "&eroare=" + encodeURIComponent(erori.join(" ").slice(0, 400)) : ""}`);
  });
}

module.exports = { register, CALE, TIPAR };
